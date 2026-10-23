/**
 * 章节内容按需读取器（M6）
 *
 * 阅读器进入章节时调用，负责把章节正文从原文件读出来并缓存到 DB。
 *
 * 读取流程：
 * 1. 先查 DB 缓存（chapters.content），命中直接返回
 * 2. 未命中则按 file_type 选择解析器，从原文件按字节范围读取
 * 3. 读取成功后回写 DB 缓存，下次直接走 1
 *
 * 这样设计的好处：
 * - 大文件不全量入内存，只读当前章节
 * - 章节正文缓存后再次进入免再读文件
 * - 删缓存（clearChapterContent）可强制重读
 *
 * P0-3 优化：读取时更新 last_accessed，定期触发 LRU 淘汰防止 DB 膨胀。
 * P1-2 优化：读取当前章节后异步预加载下一章，翻页时直接命中缓存。
 */

import { join, dirname, basename } from 'path';
import { existsSync } from 'fs';
import * as BookRepo from '../db/repositories';
import * as ChapterRepo from '../db/repositories';

import * as ReplaceRuleRepo from '../db/repositories';
import * as SettingsRepo from '../db/repositories';
import { getUserDataRoot } from '../utils';
import type { ChapterImage } from '../../shared';
import { readImageSize } from './parsers/image-size';
import {
  readChapter as readTxtChapter,
  readEpubChapterImages,
  readMobiChapterImages,

  readComicChapterImages,
  type ChapterIndex
} from './file-parser';
// v56 缩略图：sharp 统一加载入口（v50）+ PDF 纯缓存状态查询（零渲染）
import { getSharp, listPdfChapterImagesCached } from './file-parser';
import { pdfWorkerPool } from './pdf-worker-pool';

import type { ReplaceRule } from '../db/repositories';
import { toSimplified, toTraditional } from '../utils';
import { smartFormat as smartFormatText } from '../utils';

/** 章节读取自定义错误 */
export class ChapterReaderError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ChapterReaderError';
  }
}

/* ==================== link 书失效拦截（批次 v54 导入三模式） ==================== */

/**
 * link 书原文件失效结构化错误码（编进 message 前缀跨 IPC 传递）
 *
 * wrapHandler 只透传 err.message（不序列化自定义属性），因此结构化信息
 * （bookId/原路径/file_hash）以 JSON 附加在 message 中，渲染端解析：
 *   message.startsWith(FILE_MISSING_PREFIX) → JSON.parse(message.slice(prefix.length))
 */
export const FILE_MISSING_PREFIX = '[FILE_MISSING]';

/**
 * link 书原文件失效错误（批次 v54）
 *
 * 触发：link 模式导入的书籍 local_file_path（=导入时选择的用户原路径）不存在——
 * 文件被移动/重命名/删除，或存储设备（U 盘/移动硬盘）未连接。
 * 前端捕获后弹"重新定位"对话框：选择新文件 → book:relocate 哈希校验 → 静默恢复。
 */
export class FileMissingError extends Error {
  /** 失联书籍 id */
  public readonly bookId: number;
  /** 失联的原文件路径（展示给用户，帮助回忆文件去向） */
  public readonly filePath: string;
  /** 原文件哈希（重新定位时比对校验） */
  public readonly fileHash: string | null;

  constructor(bookId: number, filePath: string, fileHash: string | null) {
    // message 编码：前缀 + JSON payload（跨 IPC 结构化传递，见 FILE_MISSING_PREFIX 注释）
    super(`${FILE_MISSING_PREFIX}${JSON.stringify({ bookId, path: filePath, hash: fileHash })}`);
    this.name = 'FileMissingError';
    this.bookId = bookId;
    this.filePath = filePath;
    this.fileHash = fileHash;
  }
}

/**
 * link 书原文件存在性校验（三入口共用：readChapterContentCore / readChapterImages /
 * ensureChapterImages 查 book 后调用）
 *
 * 仅校验 import_mode='link' 的书——copy/move 的副本在 userData 内由应用自管，
 * 不存在"用户移动原文件"场景，保持原行为（文件丢失走普通解析错误）。
 * 注：章节正文 DB 缓存命中时不触发（用户仍可读缓存正文，属预期降级）；
 * 图片章节/搜索等需读原文件的路径才拦截。
 *
 * @param book 书籍行
 * @throws FileMissingError link 书原文件不存在时
 */
function assertBookFileExists(book: BookRepo.Book): void {
  if (book.import_mode === 'link' && book.local_file_path && !existsSync(book.local_file_path)) {
    throw new FileMissingError(book.id, book.local_file_path, book.file_hash);
  }
}

/* ==================== P1-17：内容替换规则 & 阅读设置内存缓存 ==================== */

/**
 * 章节读取时频繁查询内容替换规则和阅读设置，翻页时产生大量重复 DB 查询。
 * 用模块级内存缓存：首次查询后缓存，后续直接命中，变更时主动失效。
 *
 * 设计要点：
 * - better-sqlite3 查询是同步的 + Node.js 单线程事件循环 → 值缓存即可，
 *   无需 in-flight Promise 防并发重复查询（同步代码块天然互斥）。
 * - 缓存失效由 IPC 层变更入口主动调用（replaceRule 增删改 / reader 设置改）。
 * - 加 TTL 兜底（5 分钟），即使漏调失效也不会长期脏数据。
 */
const READER_CACHE_TTL_MS = 5 * 60 * 1000;

/** 全局替换规则缓存 */
let globalReplaceRulesCache: { value: ReplaceRule[]; ts: number } | null = null;

/** 单本书替换规则缓存：按 bookId 索引 */
let bookReplaceRulesCache: Map<number, { value: ReplaceRule[]; ts: number }> = new Map();

/**
 * 单本书替换规则缓存的最大条目数（LRU 淘汰上限）
 *
 * 防止用户阅读大量不同书籍后 Map 无限增长导致内存泄漏。
 * 淘汰策略：超过上限时删除 ts 最旧（最久未访问）的条目。
 * 100 本书的规则缓存通常 < 1MB，内存占用可忽略。
 */
const BOOK_REPLACE_RULES_CACHE_MAX = 100;

/** 阅读设置缓存：textConvert + smartFormat */
let readerSettingsCache: {
  value: { textConvert: string; smartFormat: boolean };
  ts: number;
} | null = null;

/**

 * 获取启用的全局替换规则（带缓存）
 *
 * 失效条件：replaceRule 增删改时由 invalidateReplaceRulesCache 主动清除；
 * 兜底 TTL 到期后下次调用自动重新查询。
 */
function getCachedGlobalReplaceRules(): ReplaceRule[] {
  const now = Date.now();
  if (globalReplaceRulesCache && now - globalReplaceRulesCache.ts < READER_CACHE_TTL_MS) {
    return globalReplaceRulesCache.value;
  }
  const rules = ReplaceRuleRepo.listEnabledGlobalReplaceRules();
  globalReplaceRulesCache = { value: rules, ts: now };
  return rules;
}

/**
 * 获取启用的单本书替换规则（带缓存）
 *
 * 失效条件：replaceRule 增删改时由 invalidateReplaceRulesCache 主动清除；
 * 兜底 TTL 到期后下次调用自动重新查询。
 */
function getCachedBookReplaceRules(bookId: number): ReplaceRule[] {
  const now = Date.now();
  const cached = bookReplaceRulesCache.get(bookId);
  if (cached && now - cached.ts < READER_CACHE_TTL_MS) {
    cached.ts = now;
    return cached.value;
  }
  const rules = ReplaceRuleRepo.listEnabledBookReplaceRules(bookId);
  if (bookReplaceRulesCache.size >= BOOK_REPLACE_RULES_CACHE_MAX) {
    let oldestKey: number | null = null;
    let oldestTs = Infinity;
    for (const [key, entry] of bookReplaceRulesCache) {
      if (entry.ts < oldestTs) {
        oldestTs = entry.ts;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) {
      bookReplaceRulesCache.delete(oldestKey);
    }
  }
  bookReplaceRulesCache.set(bookId, { value: rules, ts: now });
  return rules;
}

/**
 * 获取阅读设置（带缓存）
 *
 * 失效条件：reader.textConvert / reader.smartFormat 变更时由
 * invalidateReaderSettingsCache 主动清除；兜底 TTL 到期后自动重新查询。
 */
function getCachedReaderSettings(): {
  textConvert: string;
  smartFormat: boolean;
} {
  const now = Date.now();
  if (readerSettingsCache && now - readerSettingsCache.ts < READER_CACHE_TTL_MS) {
    return readerSettingsCache.value;
  }
  const textConvert = SettingsRepo.getSetting('reader.textConvert') ?? 'off';
  const smartFormat = SettingsRepo.getSetting('reader.smartFormat') === 'true';
  const value = { textConvert, smartFormat };
  readerSettingsCache = { value, ts: now };
  return value;
}

/** 失效替换规则缓存（replaceRule 增删改时调用） */
export function invalidateReplaceRulesCache(): void {
  globalReplaceRulesCache = null;
  bookReplaceRulesCache = new Map();
}

/** 失效阅读设置缓存（reader.textConvert / reader.smartFormat 变更时调用） */
export function invalidateReaderSettingsCache(): void {
  readerSettingsCache = null;
}


/* ==================== 任务取消 & 缓存清理（性能/内存优化） ==================== */

/**
 * 取消指定书籍的所有章节读取任务（pending + queued）。
 *
 * 用于切换书时取消旧书的章节读取任务，避免：
 * 1. 旧任务继续占用 worker CPU，导致新书加载变慢
 * 2. 旧任务完成后覆盖新书的数据（虽然 loadChapterSeq 已防护，但浪费 CPU）
 * 3. 旧任务在后台执行导致内存占用持续增长
 *
 * 通过 book 的 local_file_path 调用 pdfWorkerPool.cancelTasksByFilePath。
 * 注意：已经在 worker 中执行的任务无法直接中断，但结果会被丢弃。
 *
 * @param bookId 书籍 ID
 */
export function cancelChapterReads(bookId: number): void {
  try {
    const book = BookRepo.getBookById(bookId);
    if (book?.local_file_path) {
      pdfWorkerPool.cancelTasksByFilePath(book.local_file_path);
    }
  } catch (err) {
    console.warn('[chapter-reader] 取消章节读取任务失败:', err);
  }
}

/**
 * 清理指定书籍在 worker 中的缓存。
 *
 * Worker 内部会缓存已解析的 PDF/EPUB/MOBI 文档对象，避免重复解析。
 * 但这会导致内存占用持续增长，特别是切换书后旧书的文档对象仍驻留内存。
 *
 * 在书籍关闭/切换时调用，释放 worker 内存。
 *
 * @param bookId 书籍 ID，不传则清理所有 worker 缓存
 */
export function clearBookWorkerCache(bookId?: number): void {
  try {
    if (bookId !== undefined) {
      const book = BookRepo.getBookById(bookId);
      if (book?.local_file_path) {
        pdfWorkerPool.clearWorkerCache(book.local_file_path);
      }
    } else {
      pdfWorkerPool.clearWorkerCache();
    }
  } catch (err) {
    console.warn('[chapter-reader] 清理 worker 缓存失败:', err);
  }
}

/* ==================== P0-3：章节缓存 LRU 淘汰配置 ==================== */

/** 章节缓存总大小上限（500MB，超过则按 LRU 淘汰最久未访问的章节） */
const CHAPTER_CACHE_MAX_BYTES = 500 * 1024 * 1024;

/** 每读取 N 次章节触发一次淘汰检查（避免每次读取都查总大小） */
const EVICT_CHECK_INTERVAL = 100;

/** 读取计数器（达到 EVICT_CHECK_INTERVAL 时归零并触发淘汰检查） */
let readCounter = 0;

/* ==================== 章节读取核心逻辑 ==================== */

/**
 * 章节读取核心逻辑（不含预加载/淘汰，可被预加载复用避免递归）
 *
 * @param bookId 书籍 ID
 * @param chapterIndex 章节序号（从 0 开始）
 * @param textOnly 只取纯文本：跳过图片提取与整页截图（分类采样等轻量场景用，避免 CPU 密集型 enrich）
 * @returns 章节正文（已清洗 + 已应用内容替换规则），失败抛 ChapterReaderError
 */
async function readChapterContentCore(bookId: number, chapterIndex: number, textOnly = false): Promise<string> {
  // 1. 先查 DB 缓存
  const cached = ChapterRepo.getChapterContent(bookId, chapterIndex);
  let content: string;
  // 图文书缓存校验：旧缓存（修复前导入）可能缺少 [IMG: 图片标记
  // 检测到旧缓存时视为缓存未命中，重新读取以补充图片
  // 修复：只对图片章节(content_type='image')检查 [IMG: 标记，
  // 纯文字章节不含 [IMG: 是正常的，不应判定为缓存过期
  let cacheStale = false;
  if (cached && cached.length > 0) {
    const chapterRow = ChapterRepo.getChapter(bookId, chapterIndex);
    if (chapterRow?.content_type === 'image' && !cached.includes('[IMG:')) {
      cacheStale = true;
    }
  }
  if (cached && cached.length > 0 && !cacheStale) {
    // 命中缓存：更新访问时间（P0-3），失败不影响返回
    try {
      ChapterRepo.touchChapterAccess(bookId, chapterIndex);
    } catch {
      // 更新访问时间失败忽略
    }
    content = cached;
  } else {
    // 2. 查 Book 元信息
    const book = BookRepo.getBookById(bookId);
    if (!book) {
      throw new ChapterReaderError(`书籍不存在: id=${bookId}`);
    }

    // 批次 v54：link 书原文件失效拦截（缓存未命中需读原文件时才校验；
    // 缓存命中走上方快路径不触发——用户仍可读缓存正文，属预期降级）
    assertBookFileExists(book);

    // 3. 查 ChapterIndex（拿 file_offset / file_length / url）
    const chapterRow = ChapterRepo.getChapter(bookId, chapterIndex);
    if (!chapterRow) {
      throw new ChapterReaderError(`章节不存在: bookId=${bookId}, chapterIndex=${chapterIndex}`);
    }

    if (!book.local_file_path) {
      // 无本地文件，无法读取
      throw new ChapterReaderError(`书籍缺少本地文件路径: id=${bookId}, chapterIndex=${chapterIndex}`);
    }

    // 本地书籍读取
    const fileType = (book.file_type ?? '').toLowerCase();
    if (
      fileType !== 'txt' &&
      fileType !== 'epub' &&
      fileType !== 'mobi' &&
      fileType !== 'pdf' &&
      fileType !== 'comic'
    ) {
      throw new ChapterReaderError(`不支持的文件类型: ${book.file_type}`);
    }

    if (chapterRow.file_offset === null || chapterRow.file_length === null) {
      throw new ChapterReaderError(
        `章节索引不完整（缺 file_offset/file_length）: bookId=${bookId}, chapterIndex=${chapterIndex}`
      );
    }

    // 组装解析器需要的 ChapterIndex 结构
    const chapter: ChapterIndex = {
      index: chapterIndex,
      title: chapterRow.title ?? '',
      fileOffset: chapterRow.file_offset,
      fileLength: chapterRow.file_length,
      url: chapterRow.url ?? undefined
    };

    // 4. 按文件类型读取
    //    EPUB/MOBI 传入 imageDir 提取图片到磁盘，保留 [IMG:file:///...] 占位标记
    //    图片目录：{userData}/images/chapter/{bookId}/（与漫画模式 images/comic 区分）
    //    textOnly=true 时传 null：解析器跳过图片提取/整页截图，仅返回纯文本（轻量、快）
    const chapterImageDir: string | null = textOnly
      ? null
      : join(getUserDataRoot(), 'images', 'chapter', String(bookId));
    try {
      if (fileType === 'txt') {
        // TXT 需要 encoding（导入时已检测并写入 books.encoding）
        const encoding = book.encoding ?? 'UTF-8';
        content = await readTxtChapter(book.local_file_path, encoding, chapter.fileOffset, chapter.fileLength);
      } else if (fileType === 'mobi') {
        // MOBI 通过 worker 子线程读取（缓存miss时重新解析是CPU密集型，避免阻塞UI）
        content = await pdfWorkerPool.readChapterInWorker('mobi', book.local_file_path, chapter, chapterImageDir);
      } else if (fileType === 'pdf') {
        // PDF 通过 worker 子线程读取（缓存miss时重新解析+图片提取+截图+sharp压缩，全部CPU密集型）
        // 统一阅读器：所有PDF都允许截图回退，确保图片和文字都显示
        const allowScreenshotFallback = true;
        content = await pdfWorkerPool.readChapterInWorker(
          'pdf',
          book.local_file_path,
          chapter,
          chapterImageDir,
          allowScreenshotFallback
        );
      } else if (fileType === 'comic') {
        // 漫画格式没有文本内容，返回空字符串
        content = '';
      } else {
        // EPUB 通过 worker 子线程读取（unzip + HTML parse，避免阻塞UI）
        content = await pdfWorkerPool.readChapterInWorker('epub', book.local_file_path, chapter, chapterImageDir);
      }
    } catch (err) {
      if (err instanceof ChapterReaderError) throw err;
      throw new ChapterReaderError(`读取章节失败: ${(err as Error).message}`, err as Error);
    }

    // 5. 回写 DB 缓存（setChapterContent 同时更新 cached_at 和 last_accessed）
    //    注意：缓存的是文件原始清洗内容（未应用内容替换规则），
    //    读取时统一应用规则，确保规则更新后对已缓存章节也生效。
    //    textOnly（分类采样等轻量路径）**不回写**：该路径跳过了图片提取/整页截图，
    //    若回写会用纯文本覆盖缓存中原有的 [IMG:] 图片标记，导致后续阅读丢图。
    if (!textOnly) {
      try {
        ChapterRepo.setChapterContent(bookId, chapterIndex, content);
      } catch (err) {
        console.warn('[chapter-reader] 缓存章节内容失败:', err);
      }
    }
  }

  // 6. 应用内容替换规则（全局 + 单本书，每次读取都应用）
  //     规则数量通常不多，逐条匹配性能可接受。
  //     P1-17：规则走内存缓存，避免每次翻页都查 DB。
  try {
    const globalRules = getCachedGlobalReplaceRules();
    const bookRules = getCachedBookReplaceRules(bookId);
    const allRules = [...globalRules, ...bookRules];
    if (allRules.length > 0) {
      content = applyReplaceRules(content, allRules);
    }
  } catch (err) {
    // 应用替换规则失败不阻断读取，返回原始内容
    console.warn('[chapter-reader] 应用替换规则失败:', err);
  }

  // 7. 应用繁简转换和智能排版（每次读取都应用，确保设置变更后对已缓存章节也生效）
  //    只在读取时应用，不修改 DB 缓存的原始内容。
  //    应用顺序：内容替换规则 → 繁简转换 → 智能排版
  try {
    content = applyTextConvertAndFormat(content);
  } catch (err) {
    // 转换/排版失败不阻断读取，返回替换规则应用后的内容
    console.warn('[chapter-reader] 应用繁简转换/智能排版失败:', err);
  }

  return content;
}

/**
 * 预编译正则表达式常量（避免在循环/频繁调用路径中重复编译）
 *
 * 说明：String.split / String.replace 内部会重置 lastIndex，复用全局正则安全。
 * RICH_TEXT_BLOCK_RE 无 g flag，test() 不会更新 lastIndex，同样安全。
 */
const PARAGRAPH_SEPARATOR_RE = /\n\s*\n/; // 段落分隔（空行）
const RICH_TEXT_BLOCK_RE = /^\[(CODE|QUOTE|TABLE|H[1-6]|LI)\]/; // 富文本块级标记
const MULTI_NEWLINE_RE = /\n{3,}/g; // 连续 3+ 空行
const LEADING_NEWLINE_RE = /^\n+/; // 行首换行
const TRAILING_NEWLINE_RE = /\n+$/; // 行尾换行

/* ==================== 内容替换规则应用 ==================== */

/**
 * 应用内容替换规则到章节内容（v18 新增）
 *
 * 替换策略：
 * - is_regex=1：用 new RegExp(pattern, 'g') 全局替换。正则编译失败时跳过该规则。
 * - is_regex=0：纯文本替换，用 split(pattern).join(replacement) 全局替换。
 *   相比 while+replace 逐个替换，避免大段落+短规则导致的大量循环，
 *   且 pattern 作为字符串字面量无需转义正则特殊字符。
 *
 * 图片占位标记段落 [IMG:...] 和富文本块级标记段落 [CODE]/[QUOTE]/[TABLE]/[H1-H6]/[LI]
 * 不应用替换规则（避免破坏结构），原样保留。
 *
 * @param content 章节内容（已清洗）
 * @param rules 替换规则列表（已过滤启用的）
 * @returns 应用规则后的内容
 */

/**
 * 展开替换规则中的变量转义符。
 *
 * 用户在输入框中输入的是字面文本，无法直接输入换行符/制表符等不可见字符。
 * 通过变量转义让用户能在 pattern 和 replacement 中表达特殊字符：
 *   \n  → 换行符 (LF, U+000A)
 *   \r  → 回车符 (CR, U+000D)
 *   \t  → 制表符 (Tab, U+0009)
 *   \s  → 空格   (Space, U+0020)
 *   \\  → 反斜杠本身
 * 未知转义（如 \x）保留原样（反斜杠 + x）。
 *
 * @param text 用户输入的原始文本
 * @returns 展开变量后的实际字符串
 */
function expandReplaceVariables(text: string): string {
  if (!text) return text;
  // 快速路径：不含反斜杠时无需展开，直接返回原文本
  // 绝大多数规则文本（纯中文/英文广告词）不含转义符，避免逐字符遍历的开销
  if (text.indexOf('\\') === -1) return text;
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      switch (next) {
        case 'n':
          result += '\n';
          i++;
          break;
        case 'r':
          result += '\r';
          i++;
          break;
        case 't':
          result += '\t';
          i++;
          break;
        case 's':
          result += ' ';
          i++;
          break;
        case '\\':
          result += '\\';
          i++;
          break;
        default:
          result += text[i]; // 未知转义保留反斜杠原样
      }
    } else {
      result += text[i];
    }
  }
  return result;
}

export function applyReplaceRules(content: string, rules: ReplaceRule[]): string {
  if (!content || rules.length === 0) return content;

  // 按段落切分内容，对非结构段落逐条应用替换规则
  const paragraphs = content.split(PARAGRAPH_SEPARATOR_RE);
  const processedParas: string[] = [];

  for (const para of paragraphs) {
    let trimmed = para.trim();
    if (!trimmed) continue; // 丢弃空段落

    // 图片占位标记段落保护：[IMG:file:///...] 或 [IMG:data:image/...] 独占一段，
    // 不应用替换规则（避免破坏图片标记），原样保留供前端替换为 <img>
    if (trimmed.startsWith('[IMG:')) {
      processedParas.push(trimmed);
      continue;
    }

    // 富文本块级标记段落保护：[CODE]/[QUOTE]/[TABLE]/[H1-H6]/[LI] 独占一段，
    // 不应用替换规则（避免破坏结构），原样保留供前端渲染
    if (RICH_TEXT_BLOCK_RE.test(trimmed)) {
      processedParas.push(trimmed);
      continue;
    }

    // 逐条应用替换规则
    for (const rule of rules) {
      if (!rule.pattern) continue; // 空模式跳过
      if (rule.is_regex) {
        // 正则表达式模式：pattern 作为正则语法自身已支持 \n 等转义，不展开变量；
        // 只对 replacement 展开变量（让用户能在替换结果中插入换行符等）
        //
        // ReDoS 防护：用户自定义正则可能触发灾难性回溯（如 (a+)+$）卡死主进程。
        // 限制 pattern 长度（≤1000）和单段落长度（≤100000），超限跳过正则替换。
        // 纯文本替换（split-join）无回溯风险，不受此限制。
        if (rule.pattern.length <= 1000 && trimmed.length <= 100_000) {
          const expandedReplacement = expandReplaceVariables(rule.replacement);
          try {
            const re = new RegExp(rule.pattern, 'g');
            trimmed = trimmed.replace(re, expandedReplacement);
          } catch (err) {
            // 正则编译失败跳过该规则
            console.warn('[chapter-reader] 正则替换失败，跳过规则:', rule.pattern, err);
          }
        } else if (rule.pattern.length > 1000) {
          console.warn('[chapter-reader] 正则 pattern 过长，跳过规则:', rule.pattern.length);
        }
      } else {
        // 纯文本模式：pattern 和 replacement 都展开变量
        const expandedPattern = expandReplaceVariables(rule.pattern);
        const expandedReplacement = expandReplaceVariables(rule.replacement);
        trimmed = trimmed.split(expandedPattern).join(expandedReplacement);
      }
    }

    if (trimmed) processedParas.push(trimmed);
  }

  let result = processedParas.join('\n\n');
  // 清理多余空行
  result = result.replace(MULTI_NEWLINE_RE, '\n\n').replace(LEADING_NEWLINE_RE, '').replace(TRAILING_NEWLINE_RE, '');
  return result;
}

/* ==================== 繁简转换 + 智能排版 ==================== */

/**
 * 应用繁简转换和智能排版到章节内容
 *
 * 从 settings 表读取用户设置：
 * - reader.textConvert：'off' | 's2t' | 't2s'，默认 'off'
 * - reader.smartFormat：'true' | 'false'，默认 'false'
 *
 * 应用顺序：繁简转换 → 智能排版
 * - 先转换文字再排版，避免排版规则受繁简字形差异影响
 *
 * @param content 章节内容（已应用内容替换规则）
 * @returns 转换/排版后的内容
 */
function applyTextConvertAndFormat(content: string): string {
  if (!content) return content;

  // 读取繁简转换 + 智能排版设置（带缓存，P1-17，避免每次翻页都查 DB）
  const { textConvert, smartFormat: smartFormatEnabled } = getCachedReaderSettings();

  // 快速路径：未启用繁简转换也未启用智能排版时直接返回，避免无谓的字符串处理
  if (textConvert === 'off' && !smartFormatEnabled) return content;

  let result = content;

  // 繁简转换
  if (textConvert === 't2s') {
    result = toSimplified(result);
  } else if (textConvert === 's2t') {
    result = toTraditional(result);
  }

  // 智能排版
  if (smartFormatEnabled) {
    result = smartFormatText(result);
  }

  return result;
}

/**
 * 从原文件按需读取章节正文（带 DB 缓存）
 *
 * 公开接口：读取当前章节后，异步预加载下一章（P1-2）+ 定期触发淘汰检查（P0-3）。
 *
 * @param bookId 书籍 ID
 * @param chapterIndex 章节序号（从 0 开始）
 * @returns 章节正文（已清洗），失败抛 ChapterReaderError
 */
export async function readChapterContent(
  bookId: number,
  chapterIndex: number,
  opts?: { textOnly?: boolean }
): Promise<string> {
  // 读取当前章节（textOnly：只取纯文本，跳过图片提取/整页截图——供分类采样等轻量场景）
  const content = await readChapterContentCore(bookId, chapterIndex, opts?.textOnly === true);

  // P1-2：异步预加载下一章（fire-and-forget，不阻塞当前返回）
  preloadNextChapter(bookId, chapterIndex).catch((e) => console.warn('[preload] 预加载失败:', e));

  // P0-3：定期触发淘汰检查
  triggerEvictCheck();

  return content;
}

/* ==================== P1-2：章节预加载 ==================== */

/**
 * 异步预加载下一章（fire-and-forget）
 *
 * 读取当前章节后预加载下一章（chapterIndex + 1）写入 DB 缓存，
 * 翻到下一章时直接命中缓存，避免用户可感知的文件读取延迟。
 *
 * - 下一章已缓存则跳过
 * - 下一章索引不存在则跳过
 * - 预加载失败静默忽略，不影响当前章节
 *
 * 注意：内部调用 readChapterContentCore 而非 readChapterContent，
 *       避免递归预加载（只预加载一层，不会连锁预加载整本书）。
 *
 * @param bookId 书籍 ID
 * @param chapterIndex 当前章节序号（预加载 chapterIndex + 1）
 */
export async function preloadNextChapter(bookId: number, chapterIndex: number): Promise<void> {
  const nextIndex = chapterIndex + 1;

  // 下一章已缓存则跳过
  const cached = ChapterRepo.getChapterContent(bookId, nextIndex);
  if (cached && cached.length > 0) return;

  // 下一章索引不存在则跳过（快速判断，避免无谓的文件读取）
  const nextChapter = ChapterRepo.getChapter(bookId, nextIndex);
  if (!nextChapter) return;

  try {
    // 用 core 读取并回写缓存，不触发递归预加载
    await readChapterContentCore(bookId, nextIndex);
  } catch {
    // 预加载失败静默忽略
  }
}

/* ==================== P0-3：定期淘汰检查 ==================== */

/**
 * 触发淘汰检查
 *
 * 每读取 EVICT_CHECK_INTERVAL 次章节检查一次缓存总大小，
 * 超过 CHAPTER_CACHE_MAX_BYTES 则按 LRU 淘汰最久未访问的章节。
 * 用计数器限流，避免每次读取都查 sum(length(content))。
 */
function triggerEvictCheck(): void {
  readCounter++;
  if (readCounter < EVICT_CHECK_INTERVAL) return;

  readCounter = 0;
  try {
    const evicted = ChapterRepo.evictChapterCache(CHAPTER_CACHE_MAX_BYTES);
    if (evicted > 0) {
      console.debug(`[chapter-reader] LRU 淘汰 ${evicted} 章缓存`);
    }
  } catch (err) {
    console.warn('[chapter-reader] 章节缓存淘汰失败:', err);
  }
}
/* ==================== 漫画模式：图片章节读取 ==================== */

/**
 * 读取章节图片（漫画模式）
 *
 * 漫画章节的 content_type 为 'image'，需要从原文件中提取图片到本地目录，
 * 返回图片文件路径列表供渲染进程显示。
 *
 * 图片存储目录：{userData}/images/comic/{bookId}/
 * - 同一本书的图片集中在一个目录，便于管理和清理
 * - 目录持久化，二次阅读时直接复用已提取的图片
 *
 * @param bookId 书籍 ID
 * @param chapterIndex 章节序号
 * @param initialPages v53 分批渐进加载：首批渲染页数（仅 PDF 有效；缺省全量渲染）
 * @param desiredWidth A3修复：目标渲染像素宽（前端上报容器宽×DPR，仅 PDF 有效；
 *        透传 worker → pdf-parse 换算 scale 根治 HiDPI 模糊；缺省 scale 2 兜底）
 * @returns 图片文件路径列表（绝对路径），失败抛 ChapterReaderError
 */
export async function readChapterImages(
  bookId: number,
  chapterIndex: number,
  initialPages?: number,
  desiredWidth?: number
): Promise<ChapterImage[]> {
  // 1. 查 Book 元信息
  const book = BookRepo.getBookById(bookId);
  if (!book) {
    throw new ChapterReaderError(`书籍不存在: id=${bookId}`);
  }
  if (!book.local_file_path) {
    throw new ChapterReaderError(`书籍缺少本地文件路径: id=${bookId}`);
  }
  // 批次 v54：link 书原文件失效拦截（图片章节必须读原文件，缓存命中与否无关）
  assertBookFileExists(book);
  const fileType = (book.file_type ?? '').toLowerCase();
  if (fileType !== 'epub' && fileType !== 'mobi' && fileType !== 'pdf' && fileType !== 'comic') {
    throw new ChapterReaderError(`漫画模式不支持文件类型: ${book.file_type}`);
  }

  // 2. 查 ChapterIndex（拿 url 用于定位图片）
  const chapterRow = ChapterRepo.getChapter(bookId, chapterIndex);
  if (!chapterRow) {
    throw new ChapterReaderError(`章节不存在: bookId=${bookId}, chapterIndex=${chapterIndex}`);
  }

  // 3. 构造图片目录路径
  // 使用 getUserDataRoot()（exe目录/data/）而非 app.getPath('userData')（C盘AppData）
  // 所有数据必须在 exe 旁边，便携式存储
  const imageDir = join(getUserDataRoot(), 'images', 'comic', String(bookId));

  // 4. 组装解析器需要的 ChapterIndex 结构
  //    漫画章节只需要 url 字段（EPUB 的 ZIP entry name 或 MOBI 的 spine id），
  //    fileOffset/fileLength 对漫画图片提取无意义，用 0 作为默认值。
  const chapter: ChapterIndex = {
    index: chapterIndex,
    title: chapterRow.title ?? '',
    fileOffset: chapterRow.file_offset ?? 0,
    fileLength: chapterRow.file_length ?? 0,
    url: chapterRow.url ?? undefined
  };

  // 5. 按文件类型选择解析器读取图片
  //    v49：统一在分发层读取每张图片的真实尺寸（PNG/JPEG 文件头解析，不解码像素），
  //    返回 ChapterImage[] 供前端做精确占位（aspect-ratio）—— 对齐主流阅读器
  //    （PDF.js/Preview/Mihon）的"几何先于像素"：滚动条稳定、进度准确、懒加载
  //    预判可靠。此前前端占位固定 min-height:100vh，真实页高约 2 倍于估计，
  //    图片加载后高度突变导致滚动跳动。
  try {
    let paths: string[];
    if (fileType === 'epub') {
      paths = await readEpubChapterImages(book.local_file_path, chapter, imageDir);
    } else if (fileType === 'mobi') {
      paths = await readMobiChapterImages(book.local_file_path, chapter, imageDir);
    } else if (fileType === 'pdf') {
      // v53：PDF 每页渲染为图片（WebP），直接返回 ChapterImage[]（含 pending 占位）。
      // initialPages 分批渐进加载：首批只渲染前 N 个缺失页，其余 pending（前端按需续载）；
      // 未传时全量渲染（全部命中磁盘缓存的页直接复用，无渲染成本）。
      // A1修复：scale 2.0 渲染 + sharp WebP 压缩是 CPU 密集操作，改走 worker 池
      // （与 readChapter 同构的分发/取消/超时机制），不再阻塞主进程事件循环。
      // A3修复：desiredWidth 一并透传 worker → pdf-parse（HiDPI 按物理像素渲染）
      return await pdfWorkerPool.readImagesInWorker(
        book.local_file_path,
        chapter,
        imageDir,
        initialPages,
        desiredWidth
      );
    } else {
      // 漫画格式（CBZ/CBR/ZIP/RAR）
      paths = await readComicChapterImages(book.local_file_path, chapter, imageDir);
    }
    // 文件头解析尺寸（每张一次小 IO，~ms 级；失败为 0 → 前端回退估计占位）
    return paths.map((p) => {
      const size = readImageSize(p);
      return { path: p, width: size?.width ?? 0, height: size?.height ?? 0 };
    });
  } catch (err) {
    if (err instanceof ChapterReaderError) throw err;
    throw new ChapterReaderError(`读取章节图片失败: ${(err as Error).message}`, err as Error);
  }
}
/**
 * 续载章节图片（幂等，v53 分批渐进加载）
 *
 * 渲染请求槽位中仍缺失（pending/无缓存）的页，返回更新后的完整列表。
 * 已渲染页直接复用磁盘缓存，不重渲染 —— 多次调用同一槽位无副作用。
 *
 * 分发规则：仅 PDF 有"渲染"概念（getScreenshot + WebP 落盘），走
 * ensurePdfChapterImages；EPUB/MOBI/CBZ 图片是原文件解压提取（无分批意义），
 * 退化为全量读取（幂等，结果与 readChapterImages 一致）。前端仅对 PDF 产生
 * 的 pending 条目发起续载，非 PDF 分支实际不会被触发，仅作兜底。
 *
 * @param bookId 书籍 ID
 * @param chapterIndex 章节序号
 * @param pages 请求续载的槽位列表（1-based，章节内相对槽位，前端数组下标 + 1）
 * @param desiredWidth A3修复：目标渲染像素宽（前端上报容器宽×DPR，透传 worker，
 *        续载页与首批渲染分辨率口径一致；缺省 scale 2 兜底）
 * @returns 更新后的完整 ChapterImage 列表，失败抛 ChapterReaderError
 */
export async function ensureChapterImages(
  bookId: number,
  chapterIndex: number,
  pages: number[],
  desiredWidth?: number
): Promise<ChapterImage[]> {
  // 1. 查 Book 元信息（与 readChapterImages 同构的校验）
  const book = BookRepo.getBookById(bookId);
  if (!book) {
    throw new ChapterReaderError(`书籍不存在: id=${bookId}`);
  }
  if (!book.local_file_path) {
    throw new ChapterReaderError(`书籍缺少本地文件路径: id=${bookId}`);
  }
  // 批次 v54：link 书原文件失效拦截（与 readChapterImages 同口径）
  assertBookFileExists(book);
  const fileType = (book.file_type ?? '').toLowerCase();
  if (fileType !== 'epub' && fileType !== 'mobi' && fileType !== 'pdf' && fileType !== 'comic') {
    throw new ChapterReaderError(`漫画模式不支持文件类型: ${book.file_type}`);
  }

  // 2. 查 ChapterIndex（拿 url 用于定位图片）
  const chapterRow = ChapterRepo.getChapter(bookId, chapterIndex);
  if (!chapterRow) {
    throw new ChapterReaderError(`章节不存在: bookId=${bookId}, chapterIndex=${chapterIndex}`);
  }

  // 3. 构造图片目录路径（与 readChapterImages 一致：images/comic/{bookId}）
  const imageDir = join(getUserDataRoot(), 'images', 'comic', String(bookId));

  // 4. 组装解析器需要的 ChapterIndex 结构
  const chapter: ChapterIndex = {
    index: chapterIndex,
    title: chapterRow.title ?? '',
    fileOffset: chapterRow.file_offset ?? 0,
    fileLength: chapterRow.file_length ?? 0,
    url: chapterRow.url ?? undefined
  };

  // 5. PDF 走幂等续载；其余格式无渲染概念，退化为全量读取（幂等兜底）
  //    A1修复：续载与首次读取共用 renderPdfChapterImages 渲染链路（CPU 密集），
  //    同样改走 worker 池，避免渐进加载后续批次仍在主线程渲染卡住滚动。
  try {
    if (fileType === 'pdf') {
      // A3修复：desiredWidth 透传（与首批渲染同源，保证续载页分辨率一致）
      return await pdfWorkerPool.ensureImagesInWorker(book.local_file_path, chapter, imageDir, pages, desiredWidth);
    }
    return await readChapterImages(bookId, chapterIndex);
  } catch (err) {
    if (err instanceof ChapterReaderError) throw err;
    throw new ChapterReaderError(`续载章节图片失败: ${(err as Error).message}`, err as Error);
  }
}

/* ==================== 章节缩略图（v56 P0 竞品对标：缩略图面板 thumb_180 小图缓存） ==================== */

/**
 * 缩略图宽度（px）。竞品（SumatraPDF/Acrobat/Mihon）缩略图面板均使用小尺寸
 * 缓存图而非原图渲染——180px 宽足以辨识页面内容，解码内存约为原图的 1/40
 * （PDF 渲染页宽 ≥1200px），面板一次展示整章（≤50 页）不再有解码风暴。
 */
const CHAPTER_THUMB_WIDTH = 180;

/** getChapterThumbnails 在途去重（key=`${bookId}:${chapterIndex}`），防面板快速开关并发生成 */
const thumbnailInflight = new Map<string, Promise<ChapterImage[]>>();

/**
 * 生成单张缩略图（幂等）：与原图同目录 `thumb_{原文件名}.webp`，已存在直接返回。
 *
 * - sharp resize 仅缩不放（withoutEnlargement）：小于 180px 的原图保持原尺寸
 * - sharp 加载/处理失败时返回原路径（面板退化为显示原图，可用性优先）
 * - 编解码在 libvips 线程池执行，JS 侧 await 期间事件循环不被阻塞
 */
async function ensureThumb(sourcePath: string): Promise<string> {
  const thumbPath = join(dirname(sourcePath), `thumb_${basename(sourcePath)}.webp`);
  if (existsSync(thumbPath)) return thumbPath;
  try {
    const sharp = await getSharp();
    await sharp(sourcePath)
      .resize({ width: CHAPTER_THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(thumbPath);
    return thumbPath;
  } catch (err) {
    console.warn('[chapter-reader] 缩略图生成失败，回退原图:', basename(sourcePath), (err as Error).message);
    return sourcePath;
  }
}

/**
 * 获取章节缩略图列表（v56 P0：缩略图面板数据源）
 *
 * 语义（对齐竞品"面板打开时才懒生成"）：
 * - PDF：listPdfChapterImagesCached 纯磁盘缓存查询（同步、零渲染）——已渲染页
 *   返回真实条目（再生成 thumb），未渲染页返回 pending 占位（**不触发渲染**，
 *   前端灰块显示；用户点灰块跳页后阅读区自然续载，面板经 revision 信号刷新）
 * - EPUB/MOBI/CBZ：readChapterImages 全量提取（原文件解压，无渲染概念），
 *   幂等——图片已在磁盘直接复用
 * - 每个非 pending 条目生成 thumb_180 小图（幂等缓存，同目录存续期与页缓存一致）
 *
 * 返回条目与 readChapterImages 列表按槽位一一对应（path=thumb 路径，
 * width/height=原图尺寸供 tooltip 展示，pending 同步透传）。
 *
 * @param bookId 书籍 ID
 * @param chapterIndex 章节序号
 * @returns 缩略图条目列表（未渲染页为 pending 占位），失败抛 ChapterReaderError
 */
export async function getChapterThumbnails(bookId: number, chapterIndex: number): Promise<ChapterImage[]> {
  // 在途去重：面板快速开关/多信号触发时复用同一 Promise
  const key = `${bookId}:${chapterIndex}`;
  const inflight = thumbnailInflight.get(key);
  if (inflight) return inflight;

  const task = getChapterThumbnailsInner(bookId, chapterIndex).finally(() => {
    thumbnailInflight.delete(key);
  });
  thumbnailInflight.set(key, task);
  return task;
}

/** getChapterThumbnails 实现主体（校验 + 数据源选择 + thumb 懒生成） */
async function getChapterThumbnailsInner(bookId: number, chapterIndex: number): Promise<ChapterImage[]> {
  // 1. 查 Book 元信息（与 readChapterImages 同构的校验）
  const book = BookRepo.getBookById(bookId);
  if (!book) {
    throw new ChapterReaderError(`书籍不存在: id=${bookId}`);
  }
  if (!book.local_file_path) {
    throw new ChapterReaderError(`书籍缺少本地文件路径: id=${bookId}`);
  }
  // link 书原文件失效拦截（与 readChapterImages 同口径）
  assertBookFileExists(book);
  const fileType = (book.file_type ?? '').toLowerCase();
  if (fileType !== 'epub' && fileType !== 'mobi' && fileType !== 'pdf' && fileType !== 'comic') {
    throw new ChapterReaderError(`缩略图不支持文件类型: ${book.file_type}`);
  }

  // 2. 查 ChapterIndex（拿 url 用于定位图片）
  const chapterRow = ChapterRepo.getChapter(bookId, chapterIndex);
  if (!chapterRow) {
    throw new ChapterReaderError(`章节不存在: bookId=${bookId}, chapterIndex=${chapterIndex}`);
  }

  // 3. 组装解析器需要的 ChapterIndex 结构（与 readChapterImages 一致）
  const chapter: ChapterIndex = {
    index: chapterIndex,
    title: chapterRow.title ?? '',
    fileOffset: chapterRow.file_offset ?? 0,
    fileLength: chapterRow.file_length ?? 0,
    url: chapterRow.url ?? undefined
  };

  try {
    // 4. 取"当前缓存状态"图片列表：PDF 纯缓存查询（零渲染）；其余全量提取（幂等）
    let images: ChapterImage[];
    if (fileType === 'pdf') {
      images = listPdfChapterImagesCached(book.local_file_path, chapter, join(getUserDataRoot(), 'images', 'comic', String(bookId)));
    } else {
      images = await readChapterImages(bookId, chapterIndex);
    }

    // 5. 非 pending 条目逐张生成 thumb（串行 await：每张让出事件循环；已存在零成本）
    const result: ChapterImage[] = [];
    for (const img of images) {
      if (img.pending || !img.path) {
        result.push({ path: '', width: 0, height: 0, pending: true });
        continue;
      }
      const thumbPath = await ensureThumb(img.path);
      result.push({ path: thumbPath, width: img.width, height: img.height });
    }
    return result;
  } catch (err) {
    if (err instanceof ChapterReaderError) throw err;
    throw new ChapterReaderError(`获取章节缩略图失败: ${(err as Error).message}`, err as Error);
  }
}

/* ==================== 全文搜索（P1，对标 Kindle/Apple Books） ==================== */

/** 单条搜索结果 */
export interface SearchHit {
  /** 章节序号（从 0 开始） */
  chapterIndex: number;
  /** 章节标题 */
  chapterTitle: string;
  /** 匹配片段（关键词前后各 30 字） */
  snippet: string;
  /** 关键词在章节正文中的字符偏移（用于跳转定位） */
  position: number;
}

/** 搜索片段上下文半径（关键词前后各保留的字符数） */
const SEARCH_SNIPPET_RADIUS = 30;

/** 每章最多返回的匹配数（避免单章大量命中导致结果爆炸） */
const SEARCH_MAX_HITS_PER_CHAPTER = 50;

/**
 * 全文搜索：在书籍所有章节内容中搜索关键词
 *
 * 实现要点：
 * - 逐章读取内容（复用 readChapterContentCore，命中 DB 缓存免读文件）
 * - 大小写不敏感匹配（中文无大小写问题，英文统一转小写比较）
 * - 每章最多返回 SEARCH_MAX_HITS_PER_CHAPTER 条命中，避免单章爆炸
 * - 片段截取关键词前后各 30 字，保留上下文便于用户识别
 * - position 为字符偏移，前端可据此估算滚动位置（position / content.length）
 *
 * @param bookId 书籍 ID
 * @param keyword 搜索关键词（非空，前后空白会被 trim）
 * @returns 搜索结果列表（按章节顺序排列），失败抛 ChapterReaderError
 */
export async function searchInBook(bookId: number, keyword: string): Promise<SearchHit[]> {
  const kw = keyword.trim();
  if (!kw) return [];

  // 1. 获取所有章节索引
  const chapters = ChapterRepo.listChapterIndexes(bookId);
  if (chapters.length === 0) return [];

  // 2. 大小写不敏感匹配：统一转小写
  const kwLower = kw.toLowerCase();
  const results: SearchHit[] = [];

  // 3. 逐章读取并搜索
  for (const ch of chapters) {
    // 跳过图片章节（无文本内容）
    if (ch.content_type === 'image') continue;

    let content: string;
    try {
      content = await readChapterContentCore(bookId, ch.chapter_index);
    } catch (err) {
      // 单章读取失败不阻断整体搜索，记录警告后继续
      console.warn(`[chapter-reader] 搜索时读取章节失败: bookId=${bookId}, chapterIndex=${ch.chapter_index}`, err);
      continue;
    }

    if (!content) continue;

    // 大小写不敏感搜索
    const contentLower = content.toLowerCase();
    let fromIndex = 0;
    let hitCountInChapter = 0;

    while (hitCountInChapter < SEARCH_MAX_HITS_PER_CHAPTER) {
      const foundIdx = contentLower.indexOf(kwLower, fromIndex);
      if (foundIdx === -1) break;

      // 截取片段：关键词前后各 SEARCH_SNIPPET_RADIUS 字
      const snippetStart = Math.max(0, foundIdx - SEARCH_SNIPPET_RADIUS);
      const snippetEnd = Math.min(content.length, foundIdx + kw.length + SEARCH_SNIPPET_RADIUS);
      let snippet = content.slice(snippetStart, snippetEnd);
      // 标记截断
      if (snippetStart > 0) snippet = '…' + snippet;
      if (snippetEnd < content.length) snippet = snippet + '…';

      results.push({
        chapterIndex: ch.chapter_index,
        chapterTitle: ch.title ?? `第 ${ch.chapter_index + 1} 章`,
        snippet,
        position: foundIdx
      });

      // 移动搜索起点：跳过当前匹配，避免空关键词死循环
      fromIndex = foundIdx + kw.length;
      hitCountInChapter++;
    }
  }

  return results;
}
