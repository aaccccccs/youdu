/**
 * 批量重新分类内核（任务40：应用内"批量重新分类"入口）
 *
 * 用户诉求："重新检测不能全部检测的吗？"——此前全库重判只能跑
 * scripts/reclassify-books.mjs 命令行脚本，应用内无入口。本模块把脚本
 * 的核心流程（逐本重采信号 → 决策树重判 → 更新标签）搬进主进程，
 * 供 IPC（BOOK_RECLASSIFY_ALL）调用，带进度回调与取消支持。
 *
 * 设计要点
 * --------
 * 1. **信号与生产同源**：采集走 pdf-parser 导出的 extractPdfDocumentSignals
 *    （内部与 parsePdf 共用 buildDocumentSignalsFromPdf），判定走
 *    document-classifier 的 classifyDocument——重检结果严格等于
 *    "该文件若重新导入会被分成的类型"。脚本时代"内联复刻决策树"的
 *    漂移风险（脚本常量与生产不同步）就此消除。
 * 2. **绝不重新分章**：只改 books.content_type / is_comic 标签 +
 *    custom_meta.classify_signals 特征向量。chapters/阅读进度/缓存一律不动
 *    （那是 BOOK_REPARSE"重新解析"的职责）。用户对漫画模式章节结构不匹配的
 *    书可再手动触发"重新解析"。
 * 3. **反馈闭环一致（任务41 k-NN 样本池激活）**：所有成功判定的书
 *    upsertClassifyFeedback 记录最新特征向量与判定形态（不只变更的——
 *    样本池随重检全量滚动，导入时 k-NN 有充足样本参考；source=
 *    'auto-reclassify' 标记，用户手动修正样本投票权重 ×3）。
 * 4. **失败不中断**：文件缺失/加密/损坏/单本超时 → 跳过计入 failed，
 *    继续下一本（与脚本行为一致）。
 * 5. **串行执行**：约 115ms/本（实测 243 本 ≈ 30s），刻意不并发——
 *    避免与阅读中的 pdf worker 池抢 CPU/内存；逐本采集完立即销毁解析器。
 * 6. **Producer 先验快照（任务41 循环依赖防护）**：先验基于**重检前**的
 *    标签快照（loadReclassifyTargets 读出的行）计算——重检自身会改标签，
 *    若边检边算会让前面的判定结果污染后面的先验（自我强化）。
 */
import { existsSync } from 'fs';

import { getDb } from '../db/index';
import { updateBook, updateBookContentType, upsertClassifyFeedback } from '../db/repositories';
import { extractPdfDocumentSignals } from './parsers/pdf-parser';
import { classifyDocument, type DocumentSignals } from './parsers/document-classifier';
import { computeProducerPriors, type ProducerPrior, type ProducerStatRow } from './parsers/classify-producer-stats';

/** 反馈样本来源标记：批量重检自动写入（k-NN 投票权重 ×1，user 样本 ×3） */
const FEEDBACK_SOURCE_AUTO = 'auto-reclassify';

/* ==================== 类型定义 ==================== */

/** 待重检书的行集（books 表查询列子集，避免整行加载 cover 等大字段） */
export interface ReclassifyTargetRow {
  id: number;
  title: string;
  content_type: string | null;
  is_comic: number;
  local_file_path: string | null;
  custom_meta: string | null;
  /** 该书的反馈样本 signals（LEFT JOIN classification_feedback；null=无样本）。
   *  任务41：判定该书的 Producer 统计行是否为用户修正样本（权重 ×2） */
  feedback_signals?: string | null;
}

/** 单本判定决策（进度事件构造与写库依据，纯函数 decideReclassify 的输出） */
export interface ReclassifyDecision {
  /** 标签或 is_comic 任一不一致 → 需要写库更新 */
  changed: boolean;
  /** 重检前标签（'text'|'illustrated'|'comic'；null 归一为 'unknown'） */
  from: string;
  /** 重检后标签 */
  to: string;
}

/** 进度事件载荷（BOOK_RECLASSIFY_PROGRESS 通道，每本完成后推送） */
export interface ReclassifyProgressPayload {
  /** 已处理本数（含 skipped/failed，1-based 当前本） */
  current: number;
  total: number;
  bookId: number;
  title: string;
  from: string;
  to: string;
  changed: boolean;
  /** 本本处置状态：ok=已判定（含未变更）/ skipped=未处理 / failed=判定或写库失败 */
  status: 'ok' | 'skipped' | 'failed';
  /** skipped/failed 的原因（日志与 UI 展示） */
  reason?: string;
}

/** 重检汇总（invoke 返回值） */
export interface ReclassifySummary {
  /** 成功完成信号采集与判定的本数 */
  processed: number;
  /** 其中标签/is_comic 发生变更的本数 */
  changed: number;
  /** 未处理跳过（非 PDF 路径/文件缺失） */
  skipped: number;
  /** 判定或写库失败（解析失败/加密/超时/DB 异常） */
  failed: number;
  /** 用户取消（true 时 processed < 可处理总数） */
  cancelled: boolean;
}

/* ==================== 纯函数（供单测） ==================== */

/** 标签归一：null/空 → 'unknown'（DB 列可空，进度事件需要非空字符串） */
export function normalizeContentTypeLabel(value: string | null | undefined): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

/**
 * 判定单本书是否需要更新标签（纯函数）
 *
 * 变更口径与 scripts/reclassify-books.mjs 一致：content_type 不同，
 * 或 is_comic 与判定形态的兼容位不一致（二者应同生同死，
 * updateBookContentType 保证一起更新，故正常数据只需比 contentType，
 * 防御性双比修复旧库中 is_comic 与 content_type 脱节的行）。
 */
export function decideReclassify(
  book: Pick<ReclassifyTargetRow, 'content_type' | 'is_comic'>,
  verdict: Pick<{ contentType: string; isComic: boolean }, 'contentType' | 'isComic'>
): ReclassifyDecision {
  const from = normalizeContentTypeLabel(book.content_type);
  const to = verdict.contentType;
  const comicBitMatches = (verdict.isComic ? 1 : 0) === book.is_comic;
  return { changed: from !== to || !comicBitMatches, from, to };
}

/**
 * 把最新特征向量合并进 custom_meta JSON（纯函数）
 *
 * 只替换 classify_signals 键，其余键（file_hash / file_size /
 * original_filename / comic_info 等）原样保留——custom_meta 是 importer
 * buildCustomMeta 写入的多用途元数据包，重检不得破坏其余字段。
 * 旧 JSON 损坏时降级为仅含 classify_signals 的新对象（与
 * BOOK_SET_CONTENT_TYPE 的容错读法一致：损坏不致命，重写自愈）。
 */
export function mergeClassifySignalsIntoCustomMeta(customMetaJson: string | null, signals: DocumentSignals): string {
  let meta: Record<string, unknown> = {};
  if (typeof customMetaJson === 'string' && customMetaJson.length > 0) {
    try {
      const parsed = JSON.parse(customMetaJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // 损坏的 custom_meta：丢弃旧内容重建（其余字段已不可信，自愈重写）
    }
  }
  meta.classify_signals = signals;
  return JSON.stringify(meta);
}

/**
 * 构造"未产生变更"的进度事件载荷（纯函数，任务40）
 *
 * skipped（文件缺失）/ failed（采集或写库失败）时 to 保持原标签、
 * changed=false——进度明细 UI 只对 changed=true 显示 from→to 箭头，
 * 跳过/失败的书显示书名+原因。写库失败时可传 fromOverride 用判定前
 * 标签（判定已发生但未落库，展示判定前状态最直观）。
 */
export function buildUnchangedProgressPayload(
  current: number,
  total: number,
  book: ReclassifyTargetRow,
  status: 'skipped' | 'failed',
  reason: string,
  fromOverride?: string
): ReclassifyProgressPayload {
  const from = fromOverride ?? normalizeContentTypeLabel(book.content_type);
  return {
    current,
    total,
    bookId: book.id,
    title: book.title,
    from,
    to: from,
    changed: false,
    status,
    reason
  };
}

/* ==================== 批量重检主流程 ==================== */

/** 单本超时（ms）：实测 115ms/本，60s 对极端损坏/挂起文件是充分宽裕的兜底 */
const PER_BOOK_TIMEOUT_MS = 60_000;

/** 运行互斥标志（BOOK_RECLASSIFY_ALL 重入保护） */
let reclassifyRunning = false;

/** 取消标志（BOOK_RECLASSIFY_CANCEL 设置；循环在每本书开始前检查） */
let reclassifyCancelled = false;

/**
 * 请求取消正在进行的批量重检
 *
 * @returns true=已对运行中的任务置取消标志；false=当前无任务在跑（幂等无操作）
 */
export function cancelReclassify(): boolean {
  if (!reclassifyRunning) return false;
  reclassifyCancelled = true;
  return true;
}

/**
 * 从重检目标行提取 Producer 统计行（纯函数，任务41）
 *
 * Producer 先验的数据源：重检**前**快照（targets 行在判定开始前一次性读出），
 * 这是循环依赖防护——重检自身会改标签，若边检边算会让前面的判定结果
 * 污染后面的先验（自我强化）。用户修正过的书（feedback 有样本且
 * source='user'/旧样本缺省）权重 ×2。
 */
export function producerStatRowsFromTargets(rows: readonly ReclassifyTargetRow[]): ProducerStatRow[] {
  const out: ProducerStatRow[] = [];
  for (const row of rows) {
    let producer: unknown;
    try {
      const meta = JSON.parse(row.custom_meta ?? '{}') as { classify_signals?: { producer?: unknown } };
      producer = meta.classify_signals?.producer;
    } catch {
      continue; // custom_meta 损坏：不可信，跳过
    }
    if (typeof producer !== 'string' || producer.length === 0) continue;

    let isUserFeedback = false;
    if (typeof row.feedback_signals === 'string' && row.feedback_signals.length > 0) {
      try {
        const source = (JSON.parse(row.feedback_signals) as { source?: unknown }).source;
        isUserFeedback = source === undefined || source === 'user';
      } catch {
        isUserFeedback = true; // 损坏样本保守视为用户反馈
      }
    }
    out.push({ producer, contentType: row.content_type ?? '', isUserFeedback });
  }
  return out;
}

/** 查询全部 PDF 书（与脚本 loadBooks --scope all 同口径：file_type 或扩展名二选一命中） */
function loadReclassifyTargets(): ReclassifyTargetRow[] {
  return getDb()
    .prepare(
      `SELECT b.id, b.title, b.content_type, b.is_comic, b.local_file_path, b.custom_meta, f.signals AS feedback_signals
       FROM books b
       LEFT JOIN classification_feedback f ON f.book_id = b.id
       WHERE b.file_type = 'pdf'
          OR (b.local_file_path IS NOT NULL AND lower(b.local_file_path) LIKE '%.pdf')
       ORDER BY b.id`
    )
    .all() as ReclassifyTargetRow[];
}

/**
 * Promise 超时兜底（race 语义）
 *
 * 超时后原 promise 继续在后台运行（pdfjs 无法强制中断），其 finally 中的
 * parser.destroy 会在完成/失败时释放资源；调用方需对原 promise 挂空 catch
 * 防止超时后再 reject 触发 unhandledRejection。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（超过 ${Math.round(ms / 1000)} 秒）`)), ms);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 批量重新分类全部 PDF 书（任务40 主流程）
 *
 * 逐本：extractPdfDocumentSignals 重采信号（115ms/本量级，串行）→
 * classifyDocument 重判 → 变更则 updateBookContentType +
 * upsertClassifyFeedback（反馈闭环）→ 刷新 custom_meta.classify_signals
 * （未变更的书也刷新：特征向量升级到当前采集口径，供后续手动修正时
 * 记录高质量反馈样本）→ 每本推送进度。绝不重建 chapters。
 *
 * @param onProgress 每本完成后的进度回调（渲染端经 BOOK_RECLASSIFY_PROGRESS 消费）
 * @returns 处理统计
 * @throws Error 已有重检任务在跑（互斥）
 */
export async function reclassifyAllBooks(
  onProgress: (payload: ReclassifyProgressPayload) => void
): Promise<ReclassifySummary> {
  if (reclassifyRunning) {
    throw new Error('批量重新分类已在进行中，请等待完成或先取消');
  }
  reclassifyRunning = true;
  reclassifyCancelled = false;

  const summary: ReclassifySummary = { processed: 0, changed: 0, skipped: 0, failed: 0, cancelled: false };

  try {
    const targets = loadReclassifyTargets();
    const total = targets.length;

    // 任务41：Producer 统计先验——基于重检前的标签快照计算（循环依赖防护：
    // 重检自身会改标签，边检边算会让前面的判定结果污染后面的先验）。
    // 先验是数据驱动主判据（替代硬编码正则组），先验缺失的书回退正则兜底。
    const producerPriors: Map<string, ProducerPrior> = computeProducerPriors(
      producerStatRowsFromTargets(targets)
    );

    for (let i = 0; i < targets.length; i++) {
      const book = targets[i];
      const current = i + 1;

      // 取消检查点：当前书尚未开始，直接收尾（已完成的保持已写库状态）
      if (reclassifyCancelled) {
        summary.cancelled = true;
        break;
      }

      // ── 前置校验：本地文件存在且可判定 ──
      const filePath = book.local_file_path;
      if (!filePath || !existsSync(filePath)) {
        summary.skipped++;
        onProgress(
          buildUnchangedProgressPayload(
            current,
            total,
            book,
            'skipped',
            !filePath ? '无本地文件路径' : '文件不存在（可能已被移动或删除）'
          )
        );
        continue;
      }

      // ── 重采信号（与 parsePdf 同源；超时/加密/损坏 → failed 不中断） ──
      let signals: DocumentSignals;
      const extraction = extractPdfDocumentSignals(filePath);
      // 超时兜底：race 输给计时器后 extraction 仍可能 reject，挂空 catch 防 unhandled
      void extraction.catch(() => undefined);
      try {
        signals = await withTimeout(extraction, PER_BOOK_TIMEOUT_MS, `《${book.title}》信号采集`);
      } catch (err) {
        summary.failed++;
        onProgress(
          buildUnchangedProgressPayload(
            current,
            total,
            book,
            'failed',
            err instanceof Error ? err.message : String(err)
          )
        );
        continue;
      }

      // ── 决策树重判（与 importer 导入判定同一函数；任务41：传 Producer 先验） ──
      const verdict = classifyDocument(signals, producerPriors);
      const decision = decideReclassify(book, verdict);

      // ── 写库（单本失败 → failed 不中断） ──
      try {
        if (decision.changed) {
          // 标签 + is_comic（updateBookContentType 内部同事务语义一起更新）
          updateBookContentType(book.id, verdict.contentType);
          console.log(
            `[reclassify] #${book.id} 《${book.title}》 ${decision.from} → ${decision.to} | ${verdict.reason}`
          );
        }
        // 任务41（k-NN 样本池激活）：所有成功判定的书都写反馈样本（不只变更的）——
        // 样本池随重检全量滚动，后续导入 k-NN 有充足样本；source 标记 auto，
        // k-NN 投票权重 ×1（用户手动修正样本 ×3）。signals JSON 内嵌 source
        // 字段区分（不加 DB 列，避免 schema 迁移）。
        upsertClassifyFeedback(
          book.id,
          verdict.shape,
          JSON.stringify({ ...signals, source: FEEDBACK_SOURCE_AUTO })
        );
        // 变更与否都刷新特征向量存档（custom_meta 其余键保留）
        updateBook(book.id, {
          custom_meta: mergeClassifySignalsIntoCustomMeta(book.custom_meta, signals)
        });
      } catch (err) {
        summary.failed++;
        onProgress(
          buildUnchangedProgressPayload(
            current,
            total,
            book,
            'failed',
            `写库失败: ${err instanceof Error ? err.message : String(err)}`,
            // 写库失败时判定已发生但未落库：展示判定前标签
            decision.from
          )
        );
        continue;
      }

      summary.processed++;
      if (decision.changed) summary.changed++;
      onProgress({
        current,
        total,
        bookId: book.id,
        title: book.title,
        from: decision.from,
        to: decision.to,
        changed: decision.changed,
        status: 'ok'
      });
    }

    if (reclassifyCancelled) summary.cancelled = true;
    console.log(
      `[reclassify] 完成: 处理 ${summary.processed} 本，变更 ${summary.changed} 本，` +
        `跳过 ${summary.skipped} 本，失败 ${summary.failed} 本${summary.cancelled ? '（用户取消）' : ''}`
    );
    return summary;
  } finally {
    reclassifyRunning = false;
    reclassifyCancelled = false;
  }
}
