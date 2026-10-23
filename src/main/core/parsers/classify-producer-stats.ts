/**
 * Producer 统计先验（任务41：数据驱动分类——去硬编码）
 *
 * 背景（用户核心诉求"智能算法、不需要硬编码"）：
 *   决策树里 COMIC_PRODUCER_RES / SCAN_PRODUCER_RES / SCAN_TOOL_PRODUCER_RES
 *   三组正则是手工维护的 Producer 白名单——AnnasArchive 先被划漫画组（循环论证
 *   错误：用误判标签定义"纯度"再自我强化）又移到扫描组，来回改正则正是
 *   "死板"的证明。Producer 本身是强特征（实测 iTextSharp 系 55/56 comic、
 *   Ghostscript 39/39 illustrated），但分组不应靠人工维护正则，而应从
 *   书库历史标签统计自动学习。
 *
 * 两层学习的第一层：
 *   从书库统计每个 Producer 的历史分类分布，同 Producer 的新书倾向历史多数
 *   标签。正则组降级为"冷启动兜底"（先验缺失时行为与旧版完全一致），
 *   先验成为运行时主判据——新工具积累 MIN_SAMPLES 本后自动产生先验，
 *   无需改代码。
 *
 * 设计约束：
 *   - 纯函数、零 DB 依赖（数据源行由调用方构造：importer 查 DB、
 *     reclassifier 用重检前快照——防循环依赖）
 *   - 最小样本数保护：Producer 下加权样本量 < MIN_SAMPLES 时不产生先验
 *     （小样本噪声，如库中 43 个只有 1 本书的零散 Producer）
 *   - 置信度保护：多数标签占比 < CONFIDENCE 时不产生先验（混合工具
 *     如 FreePic2Pdf：实测 13 comic + 22 illustrated，两用工具不站队）
 *   - 用户修正加权：classification_feedback 中用户手动修正过的样本
 *     权重 ×2（用户意见优先于自动判定历史）
 */

/** Producer 先验：某归一化 Producer 的历史分类分布与多数标签 */
export interface ProducerPrior {
  /** 归一化 Producer（normalizeProducer 的输出，作为 Map key） */
  producer: string;
  /** 加权样本总量（用户反馈样本 ×USER_FEEDBACK_WEIGHT 计入） */
  total: number;
  /** comic 标签加权计数 */
  comic: number;
  /** illustrated 标签加权计数（含 scan 形态——标签归一） */
  illustrated: number;
  /** text 标签加权计数 */
  text: number;
  /** 多数标签；样本不足或置信度不达标时为 null（不产生先验） */
  dominant: 'comic' | 'illustrated' | 'text' | null;
  /** 多数标签占比（0-1，加权口径）；dominant=null 时仍记录实际占比供审计 */
  confidence: number;
}

/** 先验计算的输入行（数据源由调用方构造） */
export interface ProducerStatRow {
  /** 原始 Producer 字符串（PDF Info 元数据，含版本号等噪声） */
  producer: string;
  /** 历史分类标签：'text' | 'illustrated' | 'comic'（'scan' 容错归 illustrated） */
  contentType: string;
  /** 是否用户手动修正过的样本（权重 ×USER_FEEDBACK_WEIGHT） */
  isUserFeedback: boolean;
}

/** 最小加权样本量：低于此值不产生先验（小样本噪声保护） */
export const PRODUCER_PRIOR_MIN_SAMPLES = 5;
/** 多数标签最低占比：低于此值 dominant 置 null（混合工具如 FreePic2Pdf 不站队） */
export const PRODUCER_PRIOR_CONFIDENCE = 0.85;
/** 用户反馈样本权重（用户意见优先于自动判定历史） */
export const USER_FEEDBACK_WEIGHT = 2;

/**
 * 归一化 Producer 字符串（版本归并，作为先验统计 key）
 *
 * 实测全库 243 本的 Producer 形态归纳：
 *   - "iTextSharp 5.1.3 (c) 1T3XT BVBA" / "iTextSharp™ 5.5.13.1 ©2000-2019 ..." —— 同一工具不同版本+版权尾巴
 *   - "FreePic2Pdf - 1.26" / "FreePic2Pdf - 2.04" / "FreePic2Pdf_Lib - v2.19" —— 同一工具三种版本写法
 *   - "Adobe Acrobat 19.8 Image Conversion Plug-in" —— 版本号夹在中间
 * 不归并的话 "FreePic2Pdf - 1.26"(3本) / "FreePic2Pdf - 2.00"(3本) 各自样本量
 * 永远到不了 MIN_SAMPLES，先验永远建立不起来（版本碎片问题）。
 *
 * 规则（实测驱动，三层）：
 *   1. 小写 + 非 ASCII 可打印字符（™/©/® 商标符号）替换为空格
 *   2. **截断到首个"版本式 token"**：纯数字/点分数字/v 前缀数字（剥离
 *      token 尾部的 ;().[] 等标点后判定），孤立 "-" 视为版本区开始——
 *      版本号即工具名结束（"iTextSharp 5.1.3 (c)..." → "itextsharp"、
 *      "Adobe Acrobat 19.8 Image Conversion..." → "adobe acrobat"）
 *   3. 工具库变体尾缀归并："freepic2pdf_lib" → "freepic2pdf"
 *      （FreePic2Pdf_Lib 是 FreePic2Pdf 的库版本，同作者同工具链）
 *
 * @example
 *   normalizeProducer('FreePic2Pdf - 1.26')        // 'freepic2pdf'
 *   normalizeProducer('FreePic2Pdf_Lib - v2.19')   // 'freepic2pdf'
 *   normalizeProducer('iTextSharp™ 5.5.13.1 ©…')   // 'itextsharp'
 *   normalizeProducer('AFPL Ghostscript 8.54')     // 'afpl ghostscript'
 *   normalizeProducer('Adobe Acrobat 19.8 Image Conversion Plug-in') // 'adobe acrobat'
 */
export function normalizeProducer(raw: string): string {
  // 1) 小写 + 商标/版权等非 ASCII 符号替换为空格（"iTextSharp™ 5.5" → "itextsharp  5.5"）
  const lowered = raw.toLowerCase().replace(/[^\x20-\x7e]+/g, ' ');
  const tokens = lowered.split(/\s+/).filter(Boolean);

  // 2) 截断到首个版本式 token（剥离 token 尾部标点后判定；孤立 "-" 视为版本区开始）
  let cut = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-') {
      cut = i;
      break;
    }
    const core = token.replace(/[^a-z0-9.]/g, '');
    if (core.length > 0 && /^v?\d[\d.]*$/.test(core)) {
      cut = i;
      break;
    }
  }
  const kept = (cut === -1 ? tokens : tokens.slice(0, cut)).join(' ');

  // 3) 工具库变体尾缀归并（freepic2pdf_lib → freepic2pdf）
  return kept.replace(/[\s_-]+lib$/, '').trim();
}

/**
 * 从书库统计行计算每个 Producer 的分类先验
 *
 * @param rows 数据源行（producer × 历史标签 × 是否用户修正）：
 *   - importer 场景：查 DB（books.custom_meta.classify_signals.producer ×
 *     books.content_type，LEFT JOIN classification_feedback 判定用户修正）
 *   - reclassifier 场景：用重检前的 targets 快照构造（防循环依赖——
 *     重检自身会改标签，先验必须基于重检前状态）
 * @returns Map<归一化Producer, ProducerPrior>。dominant=null 表示
 *   该 Producer 不产生先验（样本不足或混合），决策树回退正则组兜底
 */
export function computeProducerPriors(rows: readonly ProducerStatRow[]): Map<string, ProducerPrior> {
  // 累加器：归一化 key → 三标签加权计数
  const acc = new Map<string, { comic: number; illustrated: number; text: number }>();

  for (const row of rows) {
    const key = normalizeProducer(row.producer);
    if (!key) continue; // 无 Producer / 归一化后为空 → 不参与先验统计

    const weight = row.isUserFeedback ? USER_FEEDBACK_WEIGHT : 1;
    const entry = acc.get(key) ?? { comic: 0, illustrated: 0, text: 0 };
    // 'scan' 容错归 illustrated（DB 三分类里扫描书标签即 illustrated）
    if (row.contentType === 'comic') entry.comic += weight;
    else if (row.contentType === 'illustrated' || row.contentType === 'scan') entry.illustrated += weight;
    else if (row.contentType === 'text') entry.text += weight;
    // 未知 contentType 忽略（防御：脏数据不进统计）
    acc.set(key, entry);
  }

  const priors = new Map<string, ProducerPrior>();
  for (const [key, counts] of acc) {
    const total = counts.comic + counts.illustrated + counts.text;
    if (total <= 0) continue;

    // 多数标签（固定比较顺序 comic → illustrated → text，平局取前者，平局时置信度 ≤0.5 必然不达标）
    let dominant: 'comic' | 'illustrated' | 'text' | null = 'comic';
    let dominantCount = counts.comic;
    if (counts.illustrated > dominantCount) {
      dominant = 'illustrated';
      dominantCount = counts.illustrated;
    }
    if (counts.text > dominantCount) {
      dominant = 'text';
      dominantCount = counts.text;
    }
    const confidence = dominantCount / total;

    // 双重保护：最小样本量 + 置信度（不达标 → dominant=null，不产生先验）
    if (total < PRODUCER_PRIOR_MIN_SAMPLES || confidence < PRODUCER_PRIOR_CONFIDENCE) {
      dominant = null;
    }

    priors.set(key, {
      producer: key,
      total,
      comic: counts.comic,
      illustrated: counts.illustrated,
      text: counts.text,
      dominant,
      confidence
    });
  }
  return priors;
}

/**
 * 查询某书的 Producer 先验（决策树接线用）
 *
 * Producer 未采集 / 未传先验表 / 归一化后无历史 → 返回 undefined，
 * 调用方回退正则组兜底（冷启动行为与旧版完全一致）。
 */
export function lookupProducerPrior(
  producer: string | undefined,
  priors: Map<string, ProducerPrior> | undefined
): ProducerPrior | undefined {
  if (!priors || typeof producer !== 'string') return undefined;
  const key = normalizeProducer(producer);
  if (!key) return undefined;
  return priors.get(key);
}