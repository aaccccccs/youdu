/**
 * P3 用户反馈闭环（k-NN 个性化分类）
 *
 * 思路：用户在书架手动修正分类（"标记为 文字/图文/漫画/扫描版"）时，
 * 记录该书的文档特征向量与用户标签；此后导入新书时，在决策树结果基础上
 * 参考历史修正样本做 k-NN 加权投票 —— 越用越准，且：
 *   - 零额外依赖（纯 JS 欧氏距离，无 ML 运行时）
 *   - 可解释（修正理由写入日志）
 *   - 样本量自适应（样本不足时完全不干预，退化回纯决策树）
 *
 * 为什么不用 ANN：本场景特征仅 9 维、可解释性强，低维下决策树+kNN 与 ANN
 * 精度差距 <2%，但无需 50MB+ 运行时、无训练/重训成本、判定可审计。
 *
 * 任务41（k-NN 样本池激活，用户诉求"k-NN 好像没什么用"）：
 *   原设计只有用户手动修正才写样本（样本池仅 4 条，k-NN 形同虚设）。
 *   现批量重检（reclassifyAllBooks）对**所有成功判定的书**写样本
 *   （source='auto-reclassify'），样本池随书库全量滚动（243 本起）；
 *   用户手动修正样本 source='user' 投票权重 ×3——auto 样本提供覆盖广度，
 *   user 样本提供精度锚点，两类互补。
 */
import { type ClassifyResult, type DocShape, type DocumentSignals } from './document-classifier';

/** 反馈样本（来自 DB classification_feedback 表） */
export interface FeedbackSample {
  shape: DocShape;
  signals: DocumentSignals;
  /** 样本来源（任务41 k-NN 样本池激活）：
   *  - 'user'：用户手动修正写入（BOOK_SET_CONTENT_TYPE）→ 投票权重 ×3
   *  - 'auto-reclassify'：批量重检自动写入（reclassifyAllBooks）→ 权重 ×1
   *  旧样本（无 source 字段）均为用户手动修正写入 → 视为 'user'。
   *  signals JSON 内嵌 source 字段区分（不加 DB 列，避免 schema 迁移）。 */
  source?: 'user' | 'auto-reclassify';
}

/** 特征归一化尺度：把各维量纲统一到 ~0-1，避免"页数/字符数"等大数主导欧氏距离 */
const FEATURE_SCALE = {
  textCharsPerPage: 500,
  textStdDev: 500,
  imageDensity: 2,
  outlineDensity: 1,
  pageRatioStdDev: 0.2,
  fileSizePerPageMB: 1,
  ccittRatio: 1
} as const;

/** 特征向量（顺序固定，供距离计算） */
export function signalVector(s: DocumentSignals): number[] {
  const p = Math.max(s.pageCount, 1);
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  return [
    clamp(s.textCharsPerPage / FEATURE_SCALE.textCharsPerPage, 2),
    clamp(s.textStdDev / FEATURE_SCALE.textStdDev, 2),
    clamp(s.imageDensity / FEATURE_SCALE.imageDensity, 2),
    clamp(s.outlineCount / p / FEATURE_SCALE.outlineDensity, 2),
    clamp(s.textPageRatio, 1),
    s.hasMixedOrientation ? 1 : 0,
    clamp(s.pageRatioStdDev / FEATURE_SCALE.pageRatioStdDev, 2),
    clamp(s.fileSizePerPageMB / FEATURE_SCALE.fileSizePerPageMB, 2),
    clamp(s.ccittRatio / FEATURE_SCALE.ccittRatio, 1)
  ];
}

function euclidean(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** 形态 → 分类结果（含分章建议与兼容标签映射） */
export function shapeToResult(shape: DocShape, reason: string): ClassifyResult {
  switch (shape) {
    case 'comic':
      return { shape, contentType: 'comic', isComic: true, chapterMode: 'per-page', reason };
    case 'text':
      return { shape, contentType: 'text', isComic: false, chapterMode: 'text-regex', reason };
    case 'illustrated':
      return { shape, contentType: 'illustrated', isComic: false, chapterMode: 'page-chunk', reason };
    case 'scan':
    default:
      return { shape: 'scan', contentType: 'illustrated', isComic: false, chapterMode: 'page-chunk', reason };
  }
}

/** k-NN 干预参数 */
const KNN_K = 5; // 取最近 5 个样本
const KNN_MAX_DISTANCE = 1.2; // 距离超过此值的邻居不参与（避免无关书干扰）
const KNN_MIN_SAMPLES = 3; // 样本少于此时完全不干预
const KNN_OVERRIDE_WEIGHT = 0.6; // 邻居投票权重占比超过此值才覆盖决策树结果
/** 用户样本投票权重（任务41）：用户手动修正的样本 ×3——样本池被批量重检的
 *  auto 样本灌满后（243 本量级），用户意见仍须压过自动判定历史 */
export const KNN_USER_SAMPLE_WEIGHT = 3;

export interface FeedbackAdjustResult {
  /** 调整后的分类结果 */
  result: ClassifyResult;
  /** 是否被历史反馈修正 */
  adjusted: boolean;
  /** 修正说明（日志用） */
  detail: string;
}

/**
 * 用历史反馈样本对决策树结果做 k-NN 加权投票修正
 *
 * @param signals 当前书的文档特征
 * @param base 决策树输出（默认结果）
 * @param samples 历史反馈样本（来自 DB）
 */
export function applyFeedback(
  signals: DocumentSignals,
  base: ClassifyResult,
  samples: FeedbackSample[]
): FeedbackAdjustResult {
  if (samples.length < KNN_MIN_SAMPLES) {
    return { result: base, adjusted: false, detail: `样本不足(${samples.length}<${KNN_MIN_SAMPLES})，采用决策树结果` };
  }

  const v = signalVector(signals);
  const neighbors = samples
    .map((sm) => ({ shape: sm.shape, source: sm.source, d: euclidean(v, signalVector(sm.signals)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, KNN_K)
    .filter((n) => n.d <= KNN_MAX_DISTANCE);

  if (neighbors.length === 0) {
    return { result: base, adjusted: false, detail: '无足够近邻样本，采用决策树结果' };
  }

  // 距离加权投票（1/(d+ε)，越近权重越大）；
  // 任务41 来源加权：user 样本 ×KNN_USER_SAMPLE_WEIGHT（auto-reclassify/缺省旧样本
  // 视为 user 的规则见 FeedbackSample.source 注释——此处缺省按 user 计），
  // 用户意见优先于自动判定历史。
  const votes = new Map<DocShape, number>();
  for (const n of neighbors) {
    const sourceWeight = n.source === 'auto-reclassify' ? 1 : KNN_USER_SAMPLE_WEIGHT;
    votes.set(n.shape, (votes.get(n.shape) ?? 0) + sourceWeight / (n.d + 0.05));
  }
  let bestShape: DocShape = base.shape;
  let bestWeight = 0;
  for (const [shape, weight] of votes) {
    if (weight > bestWeight) {
      bestWeight = weight;
      bestShape = shape;
    }
  }
  const totalWeight = [...votes.values()].reduce((a, b) => a + b, 0) || 1;
  const ratio = bestWeight / totalWeight;

  if (bestShape === base.shape) {
    return {
      result: base,
      adjusted: false,
      detail: `近邻(${neighbors.length})投票与决策树一致(${base.shape})`
    };
  }
  if (ratio < KNN_OVERRIDE_WEIGHT) {
    return {
      result: base,
      adjusted: false,
      detail: `近邻倾向 ${bestShape} 但占比 ${(ratio * 100).toFixed(0)}%<${KNN_OVERRIDE_WEIGHT * 100}%，采用决策树`
    };
  }

  return {
    result: shapeToResult(
      bestShape,
      `用户历史反馈修正: 决策树判 ${base.shape} → 近邻投票 ${bestShape}（${neighbors.length} 样本，权重占比 ${(ratio * 100).toFixed(0)}%）`
    ),
    adjusted: true,
    detail: `k-NN 修正 ${base.shape} → ${bestShape}（${(ratio * 100).toFixed(0)}%）`
  };
}