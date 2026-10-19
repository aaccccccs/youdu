/**
 * PDF 解析器
 *
 * 从 file-parser.ts 拆分而来。
 */

import { statSync, promises as fsPromises } from 'fs';
import { basename, extname, dirname, join } from 'path';
import { pathToFileURL } from 'node:url';
import { PDFParse } from 'pdf-parse';
import type { OutlineNode } from 'pdf-parse';
import { createRequire } from 'node:module';

import type { ChapterIndex, ParsedBook, FileParser } from './types';
import { matchChapterTitle, extractChapterTitle, isVolumeOnlyLine } from './chapter-patterns';
import { cleanContent } from './txt-parser';
import { epubZipCache, closeAllEpubCaches } from './epub-parser';
import { mobiCache, closeAllMobiCaches } from './mobi-parser';
import { comicZipCache, closeAllComicCaches } from './comic-parser';

let _pdfWasmUrl: string | undefined | null = null; // null=已尝试但失败，undefined=未尝试
function getPdfWasmUrl(): string | undefined {
  if (_pdfWasmUrl !== null) return _pdfWasmUrl ?? undefined;
  _pdfWasmUrl = undefined; // 标记已尝试
  try {
    const __req = createRequire(import.meta.url);
    const pdfjsPkgPath = __req.resolve('pdfjs-dist/package.json');
    const wasmDir = join(dirname(pdfjsPkgPath), 'wasm');
    // pathToFileURL 对目录路径不追加尾部斜杠，pdfjs-dist 的 wasmUrl 要求以 / 结尾，
    // 否则报 "Invalid factory url"。手动补斜杠。
    _pdfWasmUrl = pathToFileURL(wasmDir).toString() + '/';
  } catch {
    // 定位失败（wasm 目录不存在等），不配置 wasmUrl。
    // 后果：JBIG2/JPX 编码的扫描版 PDF 图片会渲染为白图，但不影响普通 PDF。
  }
  return _pdfWasmUrl;
}

/** 创建带 wasmUrl 配置的 PDFParse 实例（统一入口，确保 JBIG2/JPX 解码器可用） */
function createPdfParser(data: Uint8Array): PDFParse {
  const wasmUrl = getPdfWasmUrl();
  return new PDFParse({ data, wasmUrl });
}

export class PdfParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'PdfParseError';
  }
}

/* ==================== 全文缓存（LRU） ==================== */

/**
 * PDF 全文缓存（LRU）
 *
 * PDF 不支持按需读取，parse 时需提取全文文本并缓存，readChapter 时从缓存取内容。
 * key: filePath, value: { fullText, chapters }
 * - fullText: PDF 提取的全文文本（UTF-8）
 * - chapters: 章节正文数组（按章节索引，已清洗）
 *
 * LRU 淘汰策略：JS Map 按插入顺序遍历，get 命中时 delete+set 刷新为最近使用，
 * 超过 PDF_CACHE_MAX 时淘汰最旧的。
 */
interface PdfCacheEntry {
  /**
   * PDF 提取的全文文本（UTF-8）
   *
   * 大文件（>PDF_LARGE_FILE_THRESHOLD）不缓存此字段以节省内存。
   * readPdfChapter 只依赖 chapterTexts，不缓存 fullText 不影响功能。
   */
  fullText?: string;
  /** 章节正文数组（按章节索引，已清洗） */
  chapterTexts: string[];
  /** 章节索引数组（含 url 页码范围，供 readPdfChapter 获取最新的 url 格式） */
  chapters?: ChapterIndex[];
  /**
   * PDFParse 解析器实例（P0-6 优化：复用解析器实例，避免 readPdfChapterImages 重新读取整个 PDF）
   *
   * 由 parsePdf 创建并存入缓存，readPdfChapterImages 优先从缓存取复用。
   * 生命周期由 LRU 淘汰和 closeAllPdfCaches 统一 destroy 管理。
   * 注意：parser 持有 PDF 文档对象，常驻内存会增加占用，PDF_CACHE_MAX 限制常驻数量。
   */
  parser?: PDFParse;
  /**
   * P1-12修复：文件修改时间（mtime ms）
   *
   * 用于检测缓存陈旧：当文件修改时间不匹配时，缓存失效，重新解析。
   * 原问题：只对illustrated类型检测旧缓存，text类型有图的书不重新读取
   * 修复：对所有类型都检测缓存陈旧（通过mtime比较）
   */
  mtimeMs?: number;
  /**
   * P1-12修复：文件大小（bytes）
   *
   * 辅助缓存陈旧检测：文件大小变化也意味着缓存失效。
   */
  fileSize?: number;
  /**
   * 每页文本长度数组（0-based 索引，pageTextLengths[i] 对应第 i+1 页的文本字符数）
   *
   * v36性能优化：缓存此数组避免 enrichPdfChapterWithImages 重复调 getText() 提取全文。
   * 仅用于判断纯文字页面（文本量 > 阈值 → 不截图），不需要完整文本内容。
   */
  pageTextLengths?: number[];
}

/** PDF 全文缓存最大数量（限制同时常驻内存的 PDF 全文数，3 本足够覆盖多书切换场景） */
const PDF_CACHE_MAX = 2;

/**
 * PDF 大文件阈值（50MB）
 *
 * 超过此大小的 PDF 不缓存 fullText（全文文本），只缓存 chapterTexts（章节正文数组）。
 * 大 PDF 的 fullText 可能几十 MB，缓存 3 本会占用大量内存。
 * readPdfChapter 只依赖 chapterTexts，不缓存 fullText 不影响功能。
 */
const PDF_LARGE_FILE_THRESHOLD = 50 * 1024 * 1024;

/** LRU 缓存：filePath → PdfCacheEntry */
const pdfCache = new Map<string, PdfCacheEntry>();

/**
 * 获取 PDF 全文缓存（带 LRU 刷新 + P1-12缓存陈旧检测）
 *
 * P1-12修复：对所有类型都检测缓存陈旧（通过文件修改时间和大小比较）
 * 原问题：只对illustrated类型检测旧缓存，text类型有图的书不重新读取
 * 修复：检查文件mtime和size，不匹配则清除缓存返回undefined（触发重新解析）
 *
 * @param filePath PDF 文件路径
 * @returns 缓存条目，未命中或陈旧返回 undefined
 */
function getPdfCache(filePath: string): PdfCacheEntry | undefined {
  const cached = pdfCache.get(filePath);
  if (cached) {
    // P1-12修复：检测缓存陈旧 — 检查文件修改时间和大小
    // 对所有类型（text/illustrated/comic）都检测，不只检测illustrated
    try {
      const currentStat = statSync(filePath);
      if (
        cached.mtimeMs !== undefined &&
        cached.fileSize !== undefined &&
        (cached.mtimeMs !== currentStat.mtimeMs || cached.fileSize !== currentStat.size)
      ) {
        // 文件已修改（mtime或size变化），缓存陈旧，清除并返回undefined触发重新解析
        pdfCache.delete(filePath);
        // 销毁陈旧的parser实例释放资源
        if (cached.parser) {
          try {
            cached.parser.destroy();
          } catch {
            /* 忽略 */
          }
        }
        return undefined;
      }
    } catch {
      // statSync失败（文件可能已被删除），清除缓存
      pdfCache.delete(filePath);
      if (cached.parser) {
        try {
          cached.parser.destroy();
        } catch {
          /* 忽略 */
        }
      }
      return undefined;
    }
    // 命中且未陈旧：刷新为最近使用（delete+set 改变 Map 插入顺序）
    pdfCache.delete(filePath);
    pdfCache.set(filePath, cached);
    return cached;
  }
  return undefined;
}

/**
 * 写入 PDF 全文缓存（带 LRU 淘汰 + P1-12存储文件元信息）
 *
 * P1-12修复：写入缓存时存储文件修改时间和大小，供getPdfCache检测缓存陈旧
 *
 * @param filePath PDF 文件路径
 * @param entry 缓存条目
 */
function setPdfCache(filePath: string, entry: PdfCacheEntry): void {
  // P1-12修复：存储文件修改时间和大小，用于后续缓存陈旧检测
  try {
    const stat = statSync(filePath);
    entry.mtimeMs = stat.mtimeMs;
    entry.fileSize = stat.size;
  } catch {
    // statSync失败，不存储mtime/fileSize（不影响功能，只是无法检测陈旧）
  }
  pdfCache.set(filePath, entry);
  // 超限淘汰最旧条目（Map 首项 = 最久未使用）
  if (pdfCache.size > PDF_CACHE_MAX) {
    const oldestKey = pdfCache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = pdfCache.get(oldestKey);
      pdfCache.delete(oldestKey);
      // P0-6: 淘汰时销毁缓存的 parser 实例释放资源（fire-and-forget，destroy 是异步的）
      if (oldest?.parser) {
        oldest.parser.destroy().catch((e) => console.warn('[cleanup] 操作失败:', e));
      }
    }
  }
}

/**
 * 关闭所有缓存的 PDF 全文（应用退出时调用）
 *
 * PDF 全文缓存在内存中，无需 close 句柄，只需清空 Map 释放内存引用。
 */
export function closeAllPdfCaches(): void {
  // P0-6: 清空缓存时销毁所有 parser 实例释放资源（fire-and-forget，destroy 是异步的）
  for (const entry of pdfCache.values()) {
    if (entry.parser) {
      entry.parser.destroy().catch((e) => console.warn('[cleanup] 操作失败:', e));
    }
  }
  pdfCache.clear();
}

/**
 * 清理 PDF 缓存（用于 worker 收到 clearCache 消息时调用）
 *
 * - 指定 filePath：只清理该文件的缓存，销毁其 parser 实例
 * - 不指定 filePath：清理所有缓存（等同 closeAllPdfCaches）
 *
 * @param filePath 可选，指定清理哪个文件的缓存
 */
export function clearPdfCache(filePath?: string): void {
  if (filePath) {
    const entry = pdfCache.get(filePath);
    if (entry) {
      if (entry.parser) {
        entry.parser.destroy().catch((e) => console.warn('[cleanup] 操作失败:', e));
      }
      pdfCache.delete(filePath);
    }
  } else {
    closeAllPdfCaches();
  }
}

/**
 * 清理所有 worker 内部缓存（EPUB/MOBI/PDF/Comic）
 *
 * 用于 worker 收到 clearCache 消息时统一清理所有格式的缓存。
 * - 指定 filePath：只清理该文件对应的缓存
 * - 不指定 filePath：清理所有缓存
 *
 * @param filePath 可选，指定清理哪个文件的缓存
 */
export function clearAllWorkerCaches(filePath?: string): void {
  if (filePath) {
    // PDF 缓存
    clearPdfCache(filePath);
    // EPUB 缓存
    const epubZip = epubZipCache.get(filePath);
    if (epubZip) {
      try {
        epubZip.close();
      } catch {
        /* ignore */
      }
      epubZipCache.delete(filePath);
    }
    // MOBI 缓存
    mobiCache.delete(filePath);
    // Comic 缓存
    const comicZip = comicZipCache.get(filePath);
    if (comicZip) {
      try {
        comicZip.close();
      } catch {
        /* ignore */
      }
      comicZipCache.delete(filePath);
    }
  } else {
    closeAllEpubCaches();
    closeAllMobiCaches();
    closeAllPdfCaches();
    closeAllComicCaches();
  }
}

/* ==================== 元数据提取 ==================== */

/**
 * 从文件名解析书名（兜底用）
 *
 * 覆盖格式：
 * - 《书名》...           → 书名
 * - 书名 - 作者 / 书名 — 作者 / 书名_作者 → 书名
 * - 无分隔符             → 返回去扩展名文件名
 *
 * @param fileName 文件名（含扩展名）
 */
function parsePdfFileNameTitle(fileName: string): string {
  const nameWithoutExt = fileName
    .replace(/\.[a-zA-Z]{1,5}$/, '')
    .replace(/\.[a-zA-Z]{1,5}$/, '')
    .trim();
  if (!nameWithoutExt) return fileName;

  // 《书名》格式
  const m1 = nameWithoutExt.match(/《(.+?)》/);
  if (m1) return m1[1].trim();

  // 分隔符切分："书名 - 作者" / "书名 — 作者" / "书名_作者"
  const m2 = nameWithoutExt.match(/^(.+?)\s*[-—_]\s*(.+)$/);
  if (m2) return m2[1].trim();

  return nameWithoutExt;
}

/**
 * 从 PDF Info 字典和文件名提取书名、作者、简介
 *
 * 优先级：
 * 1. PDF Info 字典的 Title / Author / Subject
 * 2. 文件名兜底（去扩展名）
 *
 * @param info PDF Info 字典（pdf-parse 的 InfoResult.info）
 * @param fileName 文件名（含扩展名）
 */
function extractPdfMeta(
  info: Record<string, unknown> | undefined,
  fileName: string
): { title: string; author: string; description: string } {
  // 书名：优先用 Info.Title，兜底用文件名
  let title = '';
  if (info) {
    const rawTitle = info.Title;
    if (typeof rawTitle === 'string' && rawTitle.trim()) {
      title = rawTitle.trim();
    }
  }
  if (!title) {
    title = parsePdfFileNameTitle(fileName);
  }

  // 作者：优先用 Info.Author，兜底"未知"
  let author = '';
  if (info) {
    const rawAuthor = info.Author;
    if (typeof rawAuthor === 'string' && rawAuthor.trim()) {
      author = rawAuthor.trim();
    }
  }
  if (!author) {
    author = '未知';
  }

  // 简介：用 Info.Subject（可选）
  let description = '';
  if (info) {
    const rawSubject = info.Subject;
    if (typeof rawSubject === 'string' && rawSubject.trim()) {
      description = rawSubject.trim();
      // 清理 HTML 标签和实体（与 EPUB extractDescription 保持一致）
      description = description
        .replace(/<[^>]+>/g, '')
        .replace(/&[a-zA-Z]+;/g, ' ')
        .replace(/&#\d+;/g, ' ')
        .trim();
    }
  }

  return { title, author, description };
}

/* ==================== 分章逻辑 ==================== */

/**
 * 判断一行是否为纯卷级标记（复用 chapter-patterns 的 isVolumeOnlyLine）
 *
 * 纯卷级标记（如"第一卷""卷一""上卷"）不作为独立章节，跳过。
 */
function isPdfVolumeOnly(line: string): boolean {
  return isVolumeOnlyLine(line);
}

/**
 * 按行扫描全文文本，用章节正则库分章
 *
 * 流程：
 * 1. 按行切分全文
 * 2. 逐行用 matchChapterTitle 判断是否为章节标题
 * 3. 匹配到标题 → 上一章结束，记录 { index, title, charOffset, charLength }
 * 4. 纯卷级标记跳过（不作为独立章节）
 * 5. 无章节标题 → 走分章兜底
 *
 * @param fullText PDF 全文文本
 * @returns 章节索引数组 + 章节正文数组
 */
function splitChapters(fullText: string): { chapters: ChapterIndex[]; chapterTexts: string[] } {
  const lines = fullText.split('\n');
  const chapters: ChapterIndex[] = [];
  const chapterTexts: string[] = [];

  // 当前章节信息：{ title, startLineIdx }
  let currentChapter: { title: string; startLineIdx: number } | null = null;
  let chapterIndex = 0;

  // 计算每行的字符起始偏移（含换行符）
  // lineOffsets[i] = 第 i 行在 fullText 中的起始字符偏移
  const lineOffsets: number[] = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i] = offset;
    offset += lines[i].length + 1; // +1 for \n
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineIsEmpty = trimmed === '';

    if (!lineIsEmpty && matchChapterTitle(trimmed)) {
      // 纯卷级标记跳过
      if (isPdfVolumeOnly(trimmed)) {
        continue;
      }

      // 匹配到章节标题 → 上一章在此行之前结束
      if (currentChapter) {
        const chapterStartOffset = lineOffsets[currentChapter.startLineIdx];
        const chapterEndOffset = lineOffsets[i]; // 当前章节标题行之前
        const chapterText = lines.slice(currentChapter.startLineIdx, i).join('\n');
        chapters.push({
          index: chapterIndex,
          title: currentChapter.title,
          fileOffset: chapterStartOffset,
          fileLength: chapterEndOffset - chapterStartOffset
        });
        chapterTexts.push(chapterText);
        chapterIndex++;
      } else if (lineOffsets[i] > 0) {
        // 第一个章节标题之前有内容（序言/简介），作为「序言」章节保留
        const chapterText = lines.slice(0, i).join('\n');
        chapters.push({
          index: chapterIndex,
          title: '序言',
          fileOffset: 0,
          fileLength: lineOffsets[i]
        });
        chapterTexts.push(chapterText);
        chapterIndex++;
      }

      // 新章从这一行开始（含标题行）
      currentChapter = {
        title: extractChapterTitle(trimmed),
        startLineIdx: i
      };
    }
  }

  // 最后一章
  if (currentChapter) {
    const chapterStartOffset = lineOffsets[currentChapter.startLineIdx];
    const chapterText = lines.slice(currentChapter.startLineIdx).join('\n');
    chapters.push({
      index: chapterIndex,
      title: currentChapter.title,
      fileOffset: chapterStartOffset,
      fileLength: fullText.length - chapterStartOffset
    });
    chapterTexts.push(chapterText);
  }

  return { chapters, chapterTexts };
}

/**
 * 分章兜底：无章节标题的 PDF 按字数均分
 *
 * - 每 avgChars 字切为一章，标题"第1节""第2节"…
 * - 在行边界切分（不会把一行切成两半）
 *
 * @param fullText PDF 全文文本
 * @param avgChars 每章平均字数（默认 3000）
 * @returns 章节索引数组 + 章节正文数组
 */
export function fallbackPdfChunk(
  fullText: string,
  avgChars = 3000
): { chapters: ChapterIndex[]; chapterTexts: string[] } {
  const lines = fullText.split('\n');
  if (lines.length === 0) return { chapters: [], chapterTexts: [] };

  const chapters: ChapterIndex[] = [];
  const chapterTexts: string[] = [];
  let currentChapterStart = 0; // 行索引
  let currentCharStart = 0; // 字符偏移
  let charCount = 0;
  let chapterIndex = 0;

  // 计算每行的字符起始偏移
  const lineOffsets: number[] = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i] = offset;
    offset += lines[i].length + 1;
  }

  for (let i = 0; i < lines.length; i++) {
    charCount += lines[i].length + 1;
    if (charCount >= avgChars && i < lines.length - 1) {
      const chapterText = lines.slice(currentChapterStart, i + 1).join('\n');
      const nextCharStart = lineOffsets[i + 1];
      chapters.push({
        index: chapterIndex,
        title: `第${chapterIndex + 1}节`,
        fileOffset: currentCharStart,
        fileLength: nextCharStart - currentCharStart
      });
      chapterTexts.push(chapterText);
      chapterIndex++;
      currentChapterStart = i + 1;
      currentCharStart = nextCharStart;
      charCount = 0;
    }
  }

  // 最后一章
  if (currentChapterStart < lines.length) {
    const chapterText = lines.slice(currentChapterStart).join('\n');
    chapters.push({
      index: chapterIndex,
      title: `第${chapterIndex + 1}节`,
      fileOffset: currentCharStart,
      fileLength: fullText.length - currentCharStart
    });
    chapterTexts.push(chapterText);
  }

  return { chapters, chapterTexts };
}

/* ==================== outline 分章（PDF 目录/书签） ==================== */

/**
 * 扁平化的 outline 节点（递归展开子节点）
 *
 * PDF outline 是树形结构，每个节点可能有 items 子节点数组。
 * 扁平化后按深度优先顺序排列，用于按目录分章。
 */
interface FlatOutlineNode {
  /** 章节标题（来自 PDF 书签） */
  title: string;
  /** PDF.js 的 dest 引用（命名目标字符串或显式目标数组） */
  dest: string | Array<unknown> | null;
  /** 解析后的 0-based 页码，null 表示未解析成功 */
  pageNumber: number | null;
}

/**
 * 递归扁平化 PDF outline 树
 *
 * 深度优先遍历，保留父子顺序（父章节在前，子章节紧随其后）。
 * 跳过标题为空或 url 外链的节点（外链不是章节）。
 *
 * @param outline PDF outline 节点数组
 * @param result 累积结果数组（递归传递）
 * @returns 扁平化后的 outline 节点数组
 */
function flattenOutline(outline: OutlineNode[], result: FlatOutlineNode[] = []): FlatOutlineNode[] {
  for (const node of outline) {
    // 跳过空标题和外链节点
    if (!node.title || node.url) continue;
    result.push({
      title: node.title.trim(),
      dest: node.dest,
      pageNumber: null
    });
    // 递归处理子节点
    if (Array.isArray(node.items) && node.items.length > 0) {
      flattenOutline(node.items as OutlineNode[], result);
    }
  }
  return result;
}

/**
 * 解析 outline 节点的页码
 *
 * 访问 pdf-parse 内部的 PDFDocumentProxy（parser.doc）来将 dest 引用转换为页码。
 * 这是非公开 API，可能因 pdf-parse 版本变化而失效，因此全程 try-catch，
 * 解析失败的节点保持 pageNumber=null，后续按顺序均分页面兜底。
 *
 * @param parser PDFParse 实例
 * @param flatOutline 扁平化后的 outline 节点数组
 */
async function resolveOutlinePageNumbers(parser: PDFParse, flatOutline: FlatOutlineNode[]): Promise<void> {
  // 访问内部 doc（PDFDocumentProxy），非公开 API
  const doc = (
    parser as unknown as {
      doc?: {
        getPageIndex?: (ref: unknown) => Promise<number>;
        getDestination?: (dest: string) => Promise<Array<unknown> | null>;
      };
    }
  ).doc;
  if (!doc || typeof doc.getPageIndex !== 'function') return;

  for (const node of flatOutline) {
    try {
      let explicitDest: Array<unknown> | null = null;
      if (Array.isArray(node.dest)) {
        // 显式目标数组：dest[0] 是页面引用
        explicitDest = node.dest;
      } else if (typeof node.dest === 'string' && typeof doc.getDestination === 'function') {
        // 命名目标字符串：需要先解析为显式目标
        explicitDest = await doc.getDestination(node.dest);
      }
      if (explicitDest && explicitDest[0] != null) {
        // getPageIndex 将页面引用转换为 0-based 页码
        node.pageNumber = await doc.getPageIndex(explicitDest[0]);
      }
    } catch {
      // 解析失败保持 null
    }
  }
}

/**
 * 按 PDF outline（书签/目录）分章
 *
 * 流程：
 * 1. 用 resolveOutlinePageNumbers 解析每个 outline 节点的页码
 * 2. 如果有有效页码，按页码切分每页文本
 * 3. 如果没有有效页码，按 outline 顺序均分总页数
 * 4. 每章包含从该 outline 页码到下一个 outline 页码之间的所有页面文本
 *
 * @param flatOutline 扁平化后的 outline 节点数组（已解析页码）
 * @param pageTexts 每页文本数组（0-based 索引）
 * @param totalPages 总页数
 * @returns 章节索引数组 + 章节正文数组
 */
function splitChaptersByOutline(
  flatOutline: FlatOutlineNode[],
  pageTexts: string[],
  totalPages: number
): { chapters: ChapterIndex[]; chapterTexts: string[] } {
  const n = flatOutline.length;
  if (n === 0) return { chapters: [], chapterTexts: [] };

  const chapters: ChapterIndex[] = [];
  const chapterTexts: string[] = [];
  let charOffset = 0;

  // 检查是否有任何有效页码
  const hasValidPageNumbers = flatOutline.some((node) => node.pageNumber !== null);

  for (let i = 0; i < n; i++) {
    let startPage: number;
    let endPage: number;

    if (hasValidPageNumbers) {
      // 用解析的页码，null 时用均分兜底
      startPage = flatOutline[i].pageNumber ?? Math.floor((totalPages / n) * i);
      if (i + 1 < n) {
        endPage = flatOutline[i + 1].pageNumber ?? Math.ceil((totalPages / n) * (i + 1));
      } else {
        endPage = totalPages;
      }
    } else {
      // 无有效页码，按 outline 顺序均分
      startPage = Math.floor((totalPages / n) * i);
      endPage = i + 1 < n ? Math.floor((totalPages / n) * (i + 1)) : totalPages;
    }

    // 钳制到有效范围，确保每章至少 1 页
    startPage = Math.max(0, Math.min(startPage, totalPages - 1));
    endPage = Math.max(startPage + 1, Math.min(endPage, totalPages));

    const texts = pageTexts.slice(startPage, endPage);
    const chapterText = texts.join('\n\n');
    const chapterLength = chapterText.length;

    chapters.push({
      index: i,
      title: flatOutline[i].title,
      fileOffset: charOffset,
      fileLength: chapterLength,
      // 存储页码范围（1-based，"起始页-结束页"）供 readPdfChapter 按需渲染截图
      // startPage 为 0-based，endPage 为 0-based exclusive，转 1-based：起始=startPage+1，结束=endPage
      url: `${startPage + 1}-${endPage}`
    });
    chapterTexts.push(chapterText);

    charOffset += chapterLength + 2; // +2 for \n\n
  }

  return { chapters, chapterTexts };
}

/* ==================== 按页数均分（兜底） ==================== */

/**
 * 按页数均分分章（无 outline 且无章节标题时的兜底）
 *
 * 每 pagesPerChapter 页切为一章，标题"第X-Y页"。
 * 比按字数均分更适合 PDF（PDF 页面边界清晰，字数均分可能跨页切割）。
 *
 * @param pageTexts 每页文本数组（0-based 索引）
 * @param pagesPerChapter 每章页数（默认 20）
 * @returns 章节索引数组 + 章节正文数组
 */
function splitChaptersByPageChunk(
  pageTexts: string[],
  pagesPerChapter = 20
): { chapters: ChapterIndex[]; chapterTexts: string[] } {
  const totalPages = pageTexts.length;
  if (totalPages === 0) return { chapters: [], chapterTexts: [] };

  const chapters: ChapterIndex[] = [];
  const chapterTexts: string[] = [];
  let chapterIndex = 0;
  let charOffset = 0;

  for (let start = 0; start < totalPages; start += pagesPerChapter) {
    const end = Math.min(start + pagesPerChapter, totalPages);
    const texts = pageTexts.slice(start, end);
    const chapterText = texts.join('\n\n');
    const chapterLength = chapterText.length;

    chapters.push({
      index: chapterIndex,
      title: `第${start + 1}-${end}页`,
      fileOffset: charOffset,
      fileLength: chapterLength,
      // 存储页码范围（1-based，"起始页-结束页"）供 readPdfChapter 按需渲染截图
      // start 为 0-based，end 为 0-based exclusive，转 1-based：起始=start+1，结束=end
      url: `${start + 1}-${end}`
    });
    chapterTexts.push(chapterText);

    charOffset += chapterLength + 2;
    chapterIndex++;
  }

  return { chapters, chapterTexts };
}

/* ==================== 章节去重 ==================== */

/**
 * 章节去重 + 过滤过短章节 + 合并相邻同名章节
 *
 * 复用 TXT 解析器的去重逻辑：
 * - 用 Set 记录已见标题（trim().toLowerCase() 作为 key）
 * - 相邻同名章节合并：扩展前一个章节的 fileLength 到后一个章节的末尾
 * - 非相邻同名章节：自动加序号后缀（如「楔子（2）」）保留
 * - 跳过内容过短章节（fileLength < 50 字符，只有标题无正文），但保留至少一个章节
 *
 * @param chapters 章节索引数组
 * @param chapterTexts 章节正文数组
 * @returns 去重后的章节索引数组 + 章节正文数组
 */
function deduplicatePdfChapters(
  chapters: ChapterIndex[],
  chapterTexts: string[]
): { chapters: ChapterIndex[]; chapterTexts: string[] } {
  const resultChapters: ChapterIndex[] = [];
  const resultTexts: string[] = [];
  const seenTitles = new Set<string>();

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const text = chapterTexts[i];
    const titleKey = ch.title.trim().toLowerCase();

    // 不跳过任何章节——图文的一切内容都需要显示，包括扫描版PDF的空章节
    // （enrichPdfChapterWithImages 会渲染页面截图补充内容）
    // 只处理重复标题合并

    // 处理重复标题
    if (seenTitles.has(titleKey)) {
      // 如果是相邻的同名章节，合并到上一个
      const last = resultChapters[resultChapters.length - 1];
      if (last && last.title.trim().toLowerCase() === titleKey) {
        // 合并：扩展前一个章节的长度和正文
        last.fileLength = ch.fileOffset + ch.fileLength - last.fileOffset;
        resultTexts[resultTexts.length - 1] = resultTexts[resultTexts.length - 1] + '\n' + text;
        continue;
      }
      // 非相邻同名章节：加序号后缀保留
      let suffix = 2;
      let newTitle = `${ch.title}（${suffix}）`;
      while (seenTitles.has(newTitle.trim().toLowerCase())) {
        suffix++;
        newTitle = `${ch.title}（${suffix}）`;
      }
      seenTitles.add(newTitle.trim().toLowerCase());
      resultChapters.push({ ...ch, title: newTitle });
      resultTexts.push(text);
      continue;
    }

    seenTitles.add(titleKey);
    resultChapters.push({ ...ch });
    resultTexts.push(text);
  }

  // 重新编号 index
  resultChapters.forEach((ch, i) => {
    ch.index = i;
  });

  // 确保至少有一个章节（避免全部过滤后为空）
  if (resultChapters.length === 0 && chapters.length > 0) {
    resultChapters.push({ ...chapters[0], index: 0 });
    resultTexts.push(chapterTexts[0]);
  }

  return { chapters: resultChapters, chapterTexts: resultTexts };
}

/* ==================== 核心解析 ==================== */

/**
 * 在Buffer上计数模式出现次数（避免buffer.toString导致大文件OOM）
 * v30: 替代bufferStr.match(pattern).length，直接在二进制上搜索
 */
function countInBuffer(buf: Buffer, pattern: string): number {
  let count = 0;
  let pos = 0;
  const patternBuf = Buffer.from(pattern, 'latin1');
  while (true) {
    pos = buf.indexOf(patternBuf, pos);
    if (pos === -1) break;
    count++;
    pos += patternBuf.length;
  }
  return count;
}

/**
 * PDF 标题关键词检测：辅助区分漫画 / 技术书 / 健康书
/**
 * 解析 PDF 文件，建立章节索引并缓存全文到内存
 *
 * 流程：
 * 1. 校验文件存在 + 非空
 * 2. 读取 PDF 文件为 Buffer
 * 3. 用 pdf-parse（PDFParse）提取全文文本（含每页文本）和元数据（含 outline）
 * 4. 漫画检测（平均每页文本 < 50 字符 → 漫画）
 * 5. 分章（三级策略，按优先级）：
 *    a. PDF outline（书签/目录）分章 —— 最精确
 *    b. 按行扫描全文，正则匹配章节标题 —— 复用 TXT 分章逻辑
 *    c. 按页数均分（每 20 页一章）—— 兜底
 * 6. 章节正文缓存到内存（PDF 不支持按需读取）
 *
 * 内存优化（方案B）：
 * - PDF 需要随机访问，pdf-parse 的 data 方式需要完整文件内容，无法避免全量读取
 * - 大文件（>50MB）不缓存 fullText，只缓存 chapterTexts + parser，省一份全文文本内存
 * - 小文件（≤50MB）缓存 fullText + chapterTexts + parser（性能更好）
 * - readPdfChapter 只依赖 chapterTexts，不缓存 fullText 不影响功能
 *
 * @param filePath 文件绝对路径
 * @param onProgress 解析进度回调（0~1，供 UI 显示加载动画）
 * @param originalFileName 原始文件名（用于元数据提取，可选）
 * @returns { encoding, title, author, chapters }
 * @throws PdfParseError 文件不存在/为空/解析失败
 */
export async function parsePdf(
  filePath: string,
  onProgress?: (p: number) => void,
  originalFileName?: string
): Promise<ParsedBook> {
  // 校验文件存在
  let stat;
  try {
    stat = statSync(filePath);
  } catch (err) {
    throw new PdfParseError(`文件不存在或无法访问: ${filePath}`, err as Error);
  }

  if (stat.size === 0) {
    throw new PdfParseError('文件为空');
  }

  // 大文件内存警告：PDF 需全量读入内存，>200MB 可能导致 32 位 Electron OOM
  if (stat.size > 200 * 1024 * 1024) {
    console.warn(`[pdf] 文件较大（${(stat.size / 1024 / 1024).toFixed(1)}MB），全量读入内存可能影响性能`);
  }

  // 报告进度：开始读取
  if (onProgress) onProgress(0);

  // 1. 读取 PDF 文件为 Buffer
  let buffer: Buffer;
  try {
    buffer = await fsPromises.readFile(filePath);
  } catch (err) {
    throw new PdfParseError(`读取 PDF 文件失败: ${(err as Error).message}`, err as Error);
  }

  // 报告进度：文件已读取，开始解析
  if (onProgress) onProgress(0.2);

  // 2. 用 pdf-parse 提取全文文本（含每页文本）、元数据和 outline
  //    PDFParse 构造函数接收 LoadParameters，data 字段传 Buffer（会自动转 Uint8Array）
  let fullText = '';
  let pageTexts: string[] = [];
  let info: Record<string, unknown> | undefined;
  let flatOutline: FlatOutlineNode[] = [];
  let pdfPageCount = 1;

  let pdfParser: PDFParse | null = null;
  try {
    // 创建 PDFParse 实例，data 传 Uint8Array（从 Buffer 转换）
    pdfParser = createPdfParser(new Uint8Array(buffer));

    // 提取全文文本和每页文本
    const textResult = await pdfParser.getText();
    fullText = textResult.text;
    pdfPageCount = textResult.total || 1;
    // 提取每页文本（0-based 索引，按页码排序）
    pageTexts = textResult.pages.sort((a, b) => a.num - b.num).map((p) => p.text);

    // 报告进度：文本已提取，开始提取元数据
    if (onProgress) onProgress(0.5);

    // 提取元数据（Info 字典）和 outline（PDF 书签/目录）
    try {
      const infoResult = await pdfParser.getInfo();
      info = infoResult.info as Record<string, unknown> | undefined;
      const outline = infoResult.outline ?? null;

      // 如果有 outline，扁平化并解析每个节点的页码
      if (outline && outline.length > 0) {
        flatOutline = flattenOutline(outline);
        if (flatOutline.length > 0) {
          await resolveOutlinePageNumbers(pdfParser, flatOutline);
        }
      }
    } catch {
      // 元数据提取失败不致命，用文件名兜底
      info = undefined;
      flatOutline = [];
    }

    // P0-6: 不销毁 parser，存入缓存供 readPdfChapterImages 复用（由 LRU 淘汰 / closeAllPdfCaches 统一 destroy）
  } catch (err) {
    // 解析失败时销毁 parser 释放资源
    if (pdfParser) {
      try {
        await pdfParser.destroy();
      } catch {
        /* 忽略销毁错误 */
      }
    }
    throw new PdfParseError(`PDF 解析失败: ${(err as Error).message}`, err as Error);
  }

  // 报告进度：文本和元数据已提取，开始分章
  if (onProgress) onProgress(0.8);

  // 3. 提取元数据
  const fileName = originalFileName || basename(filePath);
  const { title, author, description } = extractPdfMeta(info, fileName);

  // 多维度PDF分类（v30：10维度综合评分算法）
  // v28: 6维度（ratioRange+图密度+有字页+文字标准差+文件大小+目录）
  // v29新增4维度：页面比例标准差+混排方向+CCITT压缩+页面宽高比
  // v30修复: 不再用buffer.toString('latin1')转整个buffer（大文件OOM导致导入失败）
  //         改用Buffer原生方法直接在二进制上搜索，MediaBox只扫前2MB
  const avgCharsPerPage = fullText.length / Math.max(pdfPageCount, 1);

  // 大文件二进制搜索限制范围：PDF 对象定义（xref/Image/Filter）通常在文件前部
  // 扫描前 20MB 足以覆盖绝大多数 PDF 的对象定义，避免对 500MB+ 文件全量扫描
  const BINARY_SCAN_LIMIT = 20 * 1024 * 1024;
  const binaryScanBuf = buffer.length > BINARY_SCAN_LIMIT ? buffer.subarray(0, BINARY_SCAN_LIMIT) : buffer;

  // v30: 直接在Buffer上搜索，不创建大字符串

  // P1-22修复: imageCount精确计数 — 原代码只计/Subtype /Image，遗漏其他图片子类型
  // 原问题: imageCount用简单字符串搜索低估实际图片数量
  //   - 只匹配/Subtype /Image和/Subtype/Image，遗漏/ImageB(灰度)/ImageC(彩色)/ImageI(索引)
  //   - 遗漏内联图片(Inline Images)和使用CCITT/DCT滤镜的图片
  // 修复: 补充所有PDF图片子类型的计数，取最大值避免重复计数
  //   /Subtype /Image 是最通用的标记，/ImageB/C/I是子类型
  //   CCITT/DCT/Flate滤镜计数作为辅助验证（这些滤镜通常用于图片编码）
  // P1-2修复：/Subtype /Image 会前缀匹配 /ImageB/C/I，导致重复计数
  // countInBuffer(buffer, '/Subtype /Image') 匹配所有以 /Subtype /Image 开头的字符串，
  // 包括 /Subtype /ImageB、/Subtype /ImageC、/Subtype /ImageI（前缀匹配）。
  // 因此 imageCountSubtype 已包含全部4种子类型（/Image + /ImageB + /ImageC + /ImageI），
  // 无需再单独累加 ImageB/C/I 的计数，否则会导致 B/C/I 被重复计数。
  // 正确的 imageCount = imageCountSubtype（已覆盖所有图片子类型）
  const imageCount = countInBuffer(binaryScanBuf, '/Subtype /Image') + countInBuffer(binaryScanBuf, '/Subtype/Image');
  const imageDensity = imageCount / Math.max(pdfPageCount, 1);
  const fileSizePerPage = buffer.length / Math.max(pdfPageCount, 1) / (1024 * 1024);
  const outlineCount = flatOutline.length;

  // 维度: 有字页比例（有显著文字>50字的页面占比）
  const pageTextLengths = pageTexts.map((p) => (p || '').length);
  const pagesWithSignificantText = pageTextLengths.filter((l) => l > 50).length;
  const textPagesRatio = pagesWithSignificantText / Math.max(pdfPageCount, 1);

  // 维度: 文字分布标准差（漫画文字少且均匀，图文文字多且分布不均）
  const meanTextPerPage = avgCharsPerPage;
  const textVariance =
    pageTextLengths.length > 0
      ? pageTextLengths.reduce((sum, len) => sum + Math.pow(len - meanTextPerPage, 2), 0) / pageTextLengths.length
      : 0;
  const textStdDev = Math.sqrt(textVariance);

  // v36性能优化：移除 getImage() 调用（导入时解码前5页图片像素+canvas操作，极其耗时）
  // imageRatioRange 维度用 pageRatioStdDev + hasMixedOrientation（已从 MediaBox 提取）补偿
  // 这两个维度已能区分漫画跨页（比例变化大）和图文书（比例稳定）

  // v29新维度：从PDF二进制提取页面/压缩/颜色特征
  // 维度7: 页面宽高比 + 标准差（漫画有跨页→比例变化大）
  let pageRatioMean = 0;
  let pageRatioStdDev = 0;
  let hasMixedOrientation = false;
  {
    // v30: 只扫描前2MB提取MediaBox（页面对象通常在文件前部，避免大文件OOM）
    const scanSize = Math.min(buffer.length, 2 * 1024 * 1024);
    const scanStr = buffer.subarray(0, scanSize).toString('latin1');
    const mediaBoxRegex = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g;
    const ratios: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = mediaBoxRegex.exec(scanStr)) !== null) {
      const w = Math.abs(parseFloat(m[3]) - parseFloat(m[1]));
      const h = Math.abs(parseFloat(m[4]) - parseFloat(m[2]));
      if (w > 0 && h > 0) ratios.push(w / h);
    }
    if (ratios.length > 0) {
      pageRatioMean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      pageRatioStdDev =
        ratios.length > 1
          ? Math.sqrt(ratios.reduce((s, r) => s + Math.pow(r - pageRatioMean, 2), 0) / ratios.length)
          : 0;
      // 检查是否有横竖混排（漫画跨页特征）
      const orientations = new Set(ratios.map((r) => (r > 1 ? 'L' : 'P')));
      hasMixedOrientation = orientations.size > 1;
    }
  }

  // 维度8: CCITT压缩占比（黑白传真编码，只有漫画使用）
  // v30: 用countInBuffer替代bufferStr.match，避免toString整个buffer
  const ccittCount = countInBuffer(binaryScanBuf, '/CCITTFaxDecode');
  const dctCount = countInBuffer(binaryScanBuf, '/DCTDecode');
  const flateCount = countInBuffer(binaryScanBuf, '/FlateDecode');
  const totalFilters = ccittCount + dctCount + flateCount;
  const ccittRatio = totalFilters > 0 ? ccittCount / totalFilters : 0;

  let contentType: 'text' | 'illustrated' | 'comic';

  if (avgCharsPerPage >= 100) {
    // 大量文字 → 有足够图则illustrated，无图或少图则text
    // v35: imageCount > 2 — 至少3张图就判illustrated
    //      用户反馈：最强大脑训练课(168K文字/265页/3张图)是图文书不是纯文字
    //      1-2张图通常是封面/装饰 → text；3+张图是内容插图 → illustrated
    //      imageCount 是PDF中 /Subtype /Image 的总出现次数
    contentType = imageCount > 2 ? 'illustrated' : 'text';
  } else if (textStdDev > 40) {
    // v32: 文字分布标准差>40 → 图文书（强信号）
    // 图文书有些页有文字有些没有→标准差大；漫画文字极少且均匀→标准差<25
    contentType = 'illustrated';
  } else {
    // 少量文字且文字分布均匀，综合评分区分漫画和图文
    let comicScore = 0;
    let illustratedScore = 0;

    // 维度1: 图密度（权重1）
    if (imageDensity > 5) comicScore += 2;
    else if (imageDensity >= 0.8 && imageDensity <= 1.2) comicScore += 1;
    else if (imageDensity >= 0.1 && imageDensity < 0.8) illustratedScore += 2;

    // 维度2: 有字页比例（权重1）
    if (textPagesRatio < 0.05) comicScore += 1;
    else illustratedScore += 2;

    // 维度3: 文字标准差（权重1）
    if (textStdDev < 25) comicScore += 1;
    else illustratedScore += 1;

    // 维度4: 每页文件大小（权重2）
    // 漫画0.15-0.5MB/页；>0.5MB可能是高分辨率扫描图文书；<0.15MB是图文书
    if (fileSizePerPage > 0.5) {
      /* 不加分 */
    } else if (fileSizePerPage > 0.15) comicScore += 2;
    else illustratedScore += 2;

    // 维度5: 目录数量（权重3，强信号）
    // 漫画通常无目录；图文书可能有目录
    if (outlineCount === 0) comicScore += 1;
    else illustratedScore += 3;

    // 维度6: 页面比例标准差（权重2，原维度7提权补偿移除的 imageRatioRange）
    // 漫画跨页→比例变化大；图文书比例稳定
    if (pageRatioStdDev > 0.02) comicScore += 2;

    // 维度7: 混排方向（权重2）
    if (hasMixedOrientation) comicScore += 2;

    // 维度8: CCITT压缩（权重2）
    if (ccittRatio > 0) comicScore += 2;

    // 维度9: 页面宽高比（权重1）
    if (pageRatioMean > 0.95) comicScore += 1;
    else if (pageRatioMean < 0.85) illustratedScore += 1;

    contentType = comicScore > illustratedScore ? 'comic' : 'illustrated';
  }
  // v23: 移除旧的兜底逻辑（会把扫描版技术书误判comic）
  // 上面的多维度判断已经足够区分漫画和扫描版技术书
  const isComicFinal = contentType === 'comic';

  let chapters: ChapterIndex[];
  let chapterTexts: string[];

  if (isComicFinal) {
    // 漫画模式：每页作为一个"章节"，url 存页码（1-based），content_type='image'
    chapters = [];
    chapterTexts = [];
    for (let i = 0; i < pdfPageCount; i++) {
      chapters.push({
        index: i,
        title: `第${i + 1}页`,
        fileOffset: 0,
        fileLength: 0,
        url: String(i + 1),
        contentType: 'image'
      });
      chapterTexts.push('');
    }
  } else {
    // 文本/图文模式：三级分章策略
    let result: { chapters: ChapterIndex[]; chapterTexts: string[] };

    if (flatOutline.length > 0) {
      // 策略 a：按 PDF outline（书签/目录）分章
      result = splitChaptersByOutline(flatOutline, pageTexts, pdfPageCount);
    } else {
      // 策略 b：按行扫描全文，正则匹配章节标题
      result = splitChapters(fullText);

      // P1-22修复: splitChapters返回1章时也走pageChunk兜底
      // 原问题: splitChapters返回1章（整本书变成一个巨章节）时不走pageChunk兜底
      //   原逻辑: 只有chapters.length===0才走pageChunk，1章时不走
      //   问题: 1章意味着正则只匹配到1个章节标题或全书无标题被合并为1章，
      //         这种情况下用户看到的是一个巨大章节，阅读体验差
      //   修复: splitChapters返回0章或1章时都走pageChunk兜底（按页数均分）
      //         但只有当pdfPageCount>20时才兜底（<20页的书1章是合理的）
      if (result.chapters.length === 0 || (result.chapters.length === 1 && pdfPageCount > 20)) {
        // 策略 c：按页数均分（每 20 页一章）
        result = splitChaptersByPageChunk(pageTexts, 20);
      } else {
        // splitChapters 不设置 url（为TXT设计），需要根据 fileOffset 估算页码范围，
        // 供 enrichPdfChapterWithImages 按需渲染截图
        const avgCharsPerPage = fullText.length / Math.max(pdfPageCount, 1);
        for (let i = 0; i < result.chapters.length; i++) {
          const ch = result.chapters[i];
          const startPage = Math.max(1, Math.floor(ch.fileOffset / Math.max(avgCharsPerPage, 1)) + 1);
          const nextOffset = i + 1 < result.chapters.length ? result.chapters[i + 1].fileOffset : fullText.length;
          const endPage = Math.min(pdfPageCount, Math.floor(nextOffset / Math.max(avgCharsPerPage, 1)) + 1);
          ch.url = `${startPage}-${Math.max(endPage, startPage)}`;
        }
      }
    }

    // 章节去重 + 过滤过短章节 + 合并相邻同名章节
    const deduplicated = deduplicatePdfChapters(result.chapters, result.chapterTexts);
    chapters = deduplicated.chapters;
    chapterTexts = deduplicated.chapterTexts;

    // 清洗章节正文（复用 TXT 的 cleanContent：合并空行、统一缩进、去广告）
    const cleanedTexts = chapterTexts.map((text) => cleanContent(text));
    chapterTexts = cleanedTexts;
  }

  // 缓存章节正文和 parser 实例到内存（供 readChapter / readPdfChapterImages 复用）
  // 内存优化：大文件（>50MB）不缓存 fullText，避免全文文本常驻内存（fullText 可能几十 MB）
  // readPdfChapter 只依赖 chapterTexts，不缓存 fullText 不影响功能
  const isLargeFile = stat.size > PDF_LARGE_FILE_THRESHOLD;
  // 大文件（>100MB）不缓存 parser：parser 内部持有整个 PDF 的 Uint8Array，
  // 缓存会导致数百 MB 内存常驻。readPdfChapterImages 无缓存时会重新读文件创建 parser。
  const isVeryLargeFile = stat.size > 100 * 1024 * 1024;
  setPdfCache(filePath, {
    fullText: isLargeFile ? undefined : fullText,
    chapterTexts,
    chapters,
    pageTextLengths,
    parser: isVeryLargeFile ? undefined : (pdfParser ?? undefined)
  });
  // 大文件 destroy parser 释放 buffer 内存（parser 持有整个 PDF 的 Uint8Array）
  if (isVeryLargeFile && pdfParser) {
    try {
      await pdfParser.destroy();
    } catch {
      // destroy 失败忽略
    }
  }

  // 报告进度：完成
  if (onProgress) onProgress(1);

  // P0-11修复：PDF totalTextLength 为 0 时输出警告（可能是扫描版 PDF 或文本提取失败）
  // 避免静默返回 totalTextLength=0 导致 content_features 表全为 0
  if (fullText.length === 0) {
    console.warn(`[pdf] totalTextLength=0（${pdfPageCount} 页），可能是扫描版PDF或文本提取失败`);
  }

  // PDF 提取的文本固定为 UTF-8
  return {
    encoding: 'UTF-8',
    title,
    author,
    description,
    chapters,
    isComic: isComicFinal,
    contentType,
    contentFeatures: { totalTextLength: fullText.length, pageCount: pdfPageCount, imageCount }
  };
}

/**
 * 按需读取章节正文
 *
 * PDF 不支持按需读取，从内存缓存中按章节索引返回内容。
 * 若缓存未命中（如应用重启后），重新解析整个 PDF 并缓存。
 *
 * @param filePath 文件路径
 * @param chapter 章节索引（含 fileOffset + fileLength）
 * @param imageDir 图片提取目录（可选，传入时提取章节内图片为 [IMG:] 占位标记）
 * @returns 清洗后的章节正文
 * @throws PdfParseError 缓存未命中且重新解析失败
 */
export async function readPdfChapter(
  filePath: string,
  chapter: ChapterIndex,
  imageDir?: string,
  allowScreenshotFallback?: boolean
): Promise<string> {
  // 1. 检查缓存
  const cached = getPdfCache(filePath);
  if (cached) {
    // 从章节正文数组按索引返回
    if (chapter.index >= 0 && chapter.index < cached.chapterTexts.length) {
      const text = cached.chapterTexts[chapter.index];
      // 图文阅读模式（imageDir 存在）：按需渲染当前章节页面的截图补充图片
      // 使用缓存的 chapter url（新格式 "1-20"），回退到 DB chapter url（旧格式 "1"）
      if (imageDir) {
        const cachedChapter = cached.chapters?.[chapter.index];
        const effectiveChapter = cachedChapter ? { ...chapter, url: cachedChapter.url } : chapter;
        return enrichPdfChapterWithImages(filePath, effectiveChapter, text, imageDir, allowScreenshotFallback);
      }
      return text;
    }
    // P1-23修复: 索引越界时输出警告而非静默返回空字符串
    // 原问题: 解析器在错误时静默返回空字符串，难以排查
    console.warn(
      `[readPdfChapter] 章节索引越界: index=${chapter.index}, chapterTexts.length=${cached.chapterTexts.length}`
    );
    return '';
  }

  // 2. 缓存未命中，重新解析整个 PDF
  //    PDF 格式固有限制：不支持按需读取，必须重新提取全文
  try {
    await parsePdf(filePath);
  } catch (err) {
    throw new PdfParseError(`缓存未命中且重新解析失败: ${(err as Error).message}`, err as Error);
  }

  // 3. 重新解析后缓存已写入，再次取缓存
  const recached = getPdfCache(filePath);
  if (recached) {
    if (chapter.index >= 0 && chapter.index < recached.chapterTexts.length) {
      const text = recached.chapterTexts[chapter.index];
      // 图文阅读模式（imageDir 存在）：按需渲染当前章节页面的截图补充图片
      if (imageDir) {
        const cachedChapter = recached.chapters?.[chapter.index];
        const effectiveChapter = cachedChapter ? { ...chapter, url: cachedChapter.url } : chapter;
        return enrichPdfChapterWithImages(filePath, effectiveChapter, text, imageDir, allowScreenshotFallback);
      }
      return text;
    }
  }

  // P1-23修复: 重新解析后章节索引仍越界，输出警告而非静默返回空字符串
  console.warn(`[readPdfChapter] 重新解析后章节仍越界: index=${chapter.index}, filePath=${filePath}`);
  return '';
}

/**
 * 为 PDF 章节文本补充图片占位标记。
 *
 * PDF 文本/图文书章节已有提取的纯文本，但缺少图片。
 * 此函数检查章节对应页面是否有图片标记，如果有，渲染页面截图作为图片补充。
 * 注意：这是简化方案（整页截图），不是提取内嵌图片。
 * 仅当章节文本不含 [IMG: 占位标记时才补充，避免重复。
 */
async function enrichPdfChapterWithImages(
  filePath: string,
  chapter: ChapterIndex,
  text: string,
  imageDir: string,
  allowScreenshotFallback?: boolean
): Promise<string> {
  // 需要章节有 url 字段（存页码或页码范围）才能渲染截图
  if (!chapter.url) return text;

  // 解析 url 字段：支持 "startPage" (旧格式/漫画) 和 "startPage-endPage" (新格式/图文)
  let startPage: number;
  let endPage: number;
  if (chapter.url.includes('-')) {
    const parts = chapter.url.split('-');
    startPage = parseInt(parts[0], 10);
    endPage = parseInt(parts[1], 10);
  } else {
    startPage = parseInt(chapter.url, 10);
    endPage = startPage; // 只渲染1页（向后兼容）
  }
  if (isNaN(startPage) || startPage < 1) return text;
  if (isNaN(endPage) || endPage < startPage) endPage = startPage;

  // 限制最多渲染1000页截图（安全上限，覆盖几乎所有现实场景）
  const MAX_PAGES = 1000;
  if (endPage - startPage + 1 > MAX_PAGES) {
    endPage = startPage + MAX_PAGES - 1;
  }

  // 确保图片目录存在
  await fsPromises.mkdir(imageDir, { recursive: true });

  // 复用缓存的 PDF parser
  const cached = getPdfCache(filePath);
  let parser: PDFParse;
  let parserBorrowed = false;
  if (cached?.parser) {
    parser = cached.parser;
    parserBorrowed = true;
  } else {
    const buffer = await fsPromises.readFile(filePath);
    parser = createPdfParser(new Uint8Array(buffer));
  }

  try {
    const pagesToRender: number[] = [];
    for (let p = startPage; p <= endPage; p++) {
      pagesToRender.push(p);
    }

    // 策略1：优先用 getImage 提取嵌入图片（只提取图片对象，不含文字）
    // 记录每个页面是否有嵌入图片，供策略2按需截图回退
    // 用 Set 去重：PDF xref 可能重复引用同一图片对象（如 img_p0_1 出现2次）
    const imageMarks: string[] = [];
    const pagesWithEmbedImage = new Set<number>();
    const seenImageKeys = new Set<string>(); // 去重：page+name+size
    try {
      const imageResult = await parser.getImage({
        partial: pagesToRender,
        imageBuffer: true,
        imageDataUrl: false,
        imageThreshold: 0
      });
      for (const page of imageResult.pages) {
        for (const img of page.images) {
          // P2-2修复：降低小图片忽略阈值（1000→100），保留更多图片
          // 原阈值 1000 字节（1KB）会丢弃小图标、分隔线、小插图等有效内容。
          // 新阈值 100 字节（0.1KB）仅过滤明显无效的空图片/损坏图片。
          // 来源：经验库 2026-09-24-pdf-image-count-sampling-range-too-small
          if (img.data && img.data.length > 100) {
            // 忽略过小的图片（<100B，可能是空对象或损坏数据）
            // 去重：同一页面+同名+同大小视为重复图片
            const imgKey = `${page.pageNumber}_${img.name}_${img.data.length}`;
            if (seenImageKeys.has(imgKey)) continue;
            seenImageKeys.add(imgKey);

            const fileName = `chapter_${chapter.index}_page_${page.pageNumber}_img_${img.name}.jpg`;
            const destPath = join(imageDir, fileName);
            // 用sharp压缩图片：PNG→JPEG，最大宽度1200px，质量80%
            // 原始PNG可能2-3MB，压缩后200-500KB，大幅减少加载卡顿
            try {
              const sharp = (await import('sharp')).default;
              const compressed = await sharp(img.data)
                .resize({ width: 1200, withoutEnlargement: true })
                .jpeg({ quality: 80, mozjpeg: true })
                .toBuffer();
              await fsPromises.writeFile(destPath, compressed);
            } catch {
              // sharp处理失败（可能不是标准图片格式），直接写入原始数据
              await fsPromises.writeFile(destPath, img.data);
            }
            // P0-1修复：改用 pathToFileURL 自动编码特殊字符（中文/空格等），避免手动拼接
            const fileUrl = pathToFileURL(destPath).toString();
            imageMarks.push(`[IMG:${fileUrl}]`);
            pagesWithEmbedImage.add(page.pageNumber);
          }
        }
      }
    } catch {
      // getImage 失败（非标准PDF），回退到 getScreenshot
    }

    // 策略2：对没有嵌入图片的页面用 getScreenshot 渲染页面截图
    // P1-1修复：纯文字页面不截图，避免纯文字PDF每页生成截图浪费资源
    //   原逻辑：对所有无嵌入图片的页面都截图，导致纯文字PDF每页生成截图
    //   修复：在截图前检测页面文本量，文本量超过阈值（500字符）的纯文字页面不截图
    //     - 有嵌入图片的页面 → 显示嵌入图片，不截图（已有图片）
    //     - 无嵌入图片且文本量 > 阈值 → 纯文字页面，不截图（文字已足够表达内容）
    //     - 无嵌入图片且文本量 ≤ 阈值 → 可能是图文混排/扫描版，截图（防止图片丢失）
    // 来源：经验库 2026-09-24-epub-illustrated-misclassify-as-text-threshold-issue
    const PURE_TEXT_THRESHOLD = 500; // 纯文字页面文本量阈值（字符数）
    // v36性能优化：优先从缓存取 pageTextLengths，避免重复调 getText() 提取全文
    let pageTextLengths: number[] = cached?.pageTextLengths ?? [];
    if (pageTextLengths.length === 0) {
      try {
        const textResult = await parser.getText();
        // 按 num 排序后映射为文本长度数组（0-based 索引，pageTextLengths[i] 对应第 i+1 页）
        pageTextLengths = textResult.pages.sort((a, b) => a.num - b.num).map((p) => (p.text || '').length);
      } catch {
        // getText 失败，无法判断文本量，保守起见保留原逻辑（全部截图）
      }
    }
    const screenshotPages =
      allowScreenshotFallback !== false
        ? pagesToRender.filter((p) => {
            if (pagesWithEmbedImage.has(p)) return false; // 已有嵌入图片，不需要截图
            // P1-1修复：检测页面文本量，纯文字页面（文本量超过阈值）不截图
            // p 是 1-based 页码，pageTextLengths 是 0-based 数组，用 p-1 索引
            if (pageTextLengths.length > 0) {
              const textLen = pageTextLengths[p - 1] ?? 0;
              if (textLen > PURE_TEXT_THRESHOLD) return false; // 纯文字页面，不截图
            }
            return true; // 文本量小或无法判断 → 需要截图（图文混排/扫描版回退）
          })
        : [];
    const screenshotMarks: string[] = [];
    if (screenshotPages.length > 0) {
      const screenshotResult = await parser.getScreenshot({
        partial: screenshotPages,
        imageBuffer: true,
        imageDataUrl: false,
        scale: 1.0 // 降低scale从1.5到1.0，减少图片大小
      });

      if (screenshotResult.pages.length > 0) {
        const sortedPages = screenshotResult.pages.sort((a, b) => a.pageNumber - b.pageNumber);
        for (const page of sortedPages) {
          const fileName = `chapter_${chapter.index}_page_${page.pageNumber}.jpg`;
          const destPath = join(imageDir, fileName);
          // 用sharp压缩截图：PNG→JPEG，最大宽度1200px，质量80%
          try {
            const sharp = (await import('sharp')).default;
            const compressed = await sharp(page.data)
              .resize({ width: 1200, withoutEnlargement: true })
              .jpeg({ quality: 80, mozjpeg: true })
              .toBuffer();
            await fsPromises.writeFile(destPath, compressed);
          } catch {
            // sharp处理失败，直接写入原始数据
            await fsPromises.writeFile(destPath, page.data);
          }
          // P0-1修复：改用 pathToFileURL 自动编码特殊字符（中文/空格等），避免手动拼接
          const fileUrl = pathToFileURL(destPath).toString();
          screenshotMarks.push(`[IMG:${fileUrl}]`);
        }
      }
    }

    // 合并结果：嵌入图片 + 截图回退 + 文字
    // 全部内容都提取——图片和文字都要显示，宁可重复也不遗漏
    // 用 \n\n（空行）分隔每个 [IMG: 标记，确保 splitParagraphs 能正确分割：
    // splitParagraphs 优先按空行分割，若 [IMG: 标记间只有单 \n，
    // 当文字部分含空行时，所有 [IMG: 标记会和第一段文字合并为同一段落，
    // 导致 renderImagePlaceholder 无法匹配（要求整段都是 [IMG:xxx]），
    // [IMG: 标记显示为文字而非图片
    if (imageMarks.length > 0 || screenshotMarks.length > 0) {
      const parts: string[] = [];
      if (imageMarks.length > 0) parts.push(imageMarks.join('\n\n'));
      if (screenshotMarks.length > 0) parts.push(screenshotMarks.join('\n\n'));
      // 始终保留text（即使有截图回退）
      // 截图页面的文字可能在截图中已包含，但嵌入图片页面的文字需要text补充
      // 对于扫描版PDF（text只有广告），cleanContent已过滤，text为空不会重复
      if (text && text.trim().length > 0) parts.push(text);
      return parts.join('\n\n');
    }
  } catch (err) {
    // 渲染失败不影响文本返回，但记录日志便于排查
    console.warn('[enrichPdfChapterWithImages] 渲染页面截图失败:', err);
  } finally {
    if (!parserBorrowed) {
      try {
        await parser.destroy();
      } catch {
        /* 忽略 */
      }
    }
  }

  return text;
}

/* ==================== PDF 漫画模式：页面渲染为图片 ==================== */

/**
 * 读取 PDF 章节图片（漫画模式）
 *
 * PDF 漫画书的每个"章节"对应一个页面，url 字段存储页码（1-based）。
 * 使用 pdf-parse 的 getScreenshot() 方法将指定页面渲染为 PNG 图片。
 *
 * @param filePath PDF 文件路径
 * @param chapter 章节索引（url 字段存页码）
 * @param imageDir 图片保存目录（绝对路径）
 * @returns 图片文件路径列表（绝对路径）
 * @throws PdfParseError 渲染失败或 chapter.url 无效
 */
export async function readPdfChapterImages(
  filePath: string,
  chapter: ChapterIndex,
  imageDir: string
): Promise<string[]> {
  if (!chapter.url) {
    throw new PdfParseError('漫画章节缺少页码（chapter.url 为空）');
  }

  const pageNum = parseInt(chapter.url, 10);
  if (isNaN(pageNum) || pageNum < 1) {
    throw new PdfParseError(`无效的页码: ${chapter.url}`);
  }

  // 确保 imageDir 目录存在
  await fsPromises.mkdir(imageDir, { recursive: true });

  // P0-6: 优先复用 parsePdf 缓存的 parser 实例，避免重新读取整个 PDF 文件 + 重建解析器
  const cached = getPdfCache(filePath);
  let parser: PDFParse;
  let parserBorrowed = false; // 标记 parser 是否从缓存借用（借用不 destroy，归缓存 LRU 统一管理）

  if (cached?.parser) {
    parser = cached.parser;
    parserBorrowed = true;
  } else {
    // 缓存无 parser，读取 PDF 文件并创建新实例
    let buffer: Buffer;
    try {
      buffer = await fsPromises.readFile(filePath);
    } catch (err) {
      throw new PdfParseError(`读取 PDF 文件失败: ${(err as Error).message}`, err as Error);
    }
    parser = createPdfParser(new Uint8Array(buffer));
  }

  try {
    const screenshotResult = await parser.getScreenshot({
      partial: [pageNum],
      imageBuffer: true,
      imageDataUrl: false,
      scale: 2 // 高清渲染，确保图片清晰
    });

    const imagePaths: string[] = [];
    for (const page of screenshotResult.pages) {
      const fileName = `page_${pageNum}.png`;
      const destPath = join(imageDir, fileName);
      await fsPromises.writeFile(destPath, page.data);
      imagePaths.push(destPath);
    }

    return imagePaths;
  } catch (err) {
    throw new PdfParseError(`渲染 PDF 页面失败: ${(err as Error).message}`, err as Error);
  } finally {
    // 只销毁自己创建的 parser；从缓存借用的归缓存管理（由 LRU 淘汰 / closeAllPdfCaches 统一 destroy）
    if (!parserBorrowed) {
      await parser.destroy();
    }
  }
}

/* ==================== 封面提取（第一页渲染为图片） ==================== */

/**
 * 将 PNG 图片数据保存为指定格式的文件
 *
 * pdf-parse 的 getScreenshot() 返回 PNG 格式的 Uint8Array。
 * 如果 destPath 以 .jpg/.jpeg 结尾，尝试用 sharp 转 JPEG（质量 85）；
 * 如果 sharp 不可用（打包环境），fallback 保存为 PNG 并修改扩展名为 .png。
 *
 * @param pngData PNG 格式的图片数据
 * @param destPath 目标路径（.jpg 或 .png）
 * @returns 实际保存的文件路径
 */
async function saveScreenshotImage(pngData: Uint8Array, destPath: string): Promise<string> {
  const ext = extname(destPath).toLowerCase();

  // 目标是 PNG：直接保存
  if (ext === '.png') {
    await fsPromises.writeFile(destPath, pngData);
    return destPath;
  }

  // 目标是 JPEG：尝试用 sharp 转换
  if (ext === '.jpg' || ext === '.jpeg') {
    try {
      // sharp 是可选依赖（devDependency），动态 import
      // 用 as any 绕过 sharp 的 export = 语法的类型复杂性
      const sharpMod = (await import('sharp')) as unknown as {
        default?: (input: Buffer) => {
          jpeg: (opts: { quality: number; mozjpeg: boolean }) => { toBuffer: () => Promise<Buffer> };
        };
      };
      const sharpFn = sharpMod.default;
      if (!sharpFn) throw new Error('sharp default export not found');
      const jpegBuffer = await sharpFn(Buffer.from(pngData)).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      await fsPromises.writeFile(destPath, jpegBuffer);
      return destPath;
    } catch {
      // sharp 不可用，fallback 保存为 PNG
      const pngDest = destPath.replace(/\.[^.]+$/, '.png');
      await fsPromises.writeFile(pngDest, pngData);
      return pngDest;
    }
  }

  // 其他扩展名：直接保存 PNG 数据
  await fsPromises.writeFile(destPath, pngData);
  return destPath;
}

/**
 * 提取 PDF 封面：将第一页渲染为图片并保存
 *
 * 用 pdf-parse 的 getScreenshot() 方法将第一页渲染为 PNG 图片，
 * 然后根据 destPath 扩展名转为目标格式（JPEG/PNG）。
 *
 * 典型用法：extractPdfCover(filePath, '{userData}/covers/{bookId}.jpg')
 *
 * @param filePath PDF 文件路径
 * @param destPath 封面保存路径（.jpg 或 .png）
 * @returns 实际保存的封面路径，失败返回 null
 */
export async function extractPdfCover(filePath: string, destPath: string): Promise<string | null> {
  let parser: PDFParse | null = null;
  try {
    // 校验文件存在
    const stat = statSync(filePath);
    if (stat.size === 0) return null;

    // 读取 PDF 文件
    const buffer = await fsPromises.readFile(filePath);

    // 确保目标目录存在
    const destDir = join(destPath, '..');
    await fsPromises.mkdir(destDir, { recursive: true });

    // 渲染第一页为 PNG 图片
    parser = createPdfParser(new Uint8Array(buffer));
    const screenshotResult = await parser.getScreenshot({
      partial: [1], // 第一页
      imageBuffer: true,
      imageDataUrl: false,
      scale: 2 // 高清渲染，确保封面清晰
    });

    if (screenshotResult.pages.length === 0) return null;

    const pngData = screenshotResult.pages[0].data;
    const savedPath = await saveScreenshotImage(pngData, destPath);
    return savedPath;
  } catch (err) {
    console.error('[pdf] 提取封面失败:', err);
    return null;
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch {
        // 忽略销毁错误
      }
    }
  }
}

/* ==================== PdfParser 类（实现 FileParser 接口） ==================== */

/**
 * PDF 解析器类，实现 FileParser 接口
 *
 * 上层通过 FileParser 接口统一调用，无需关心具体格式。
 * 内部用静态 Map 缓存 parse 时提取的全文文本，供 readChapter 使用。
 *
 * 注意：PDF 不支持按需读取，parse 时一次性提取全文并缓存到内存。
 * 若应用重启后缓存丢失，readChapter 会重新解析整个 PDF。
 */
export class PdfParser implements FileParser {
  async parse(filePath: string, onProgress?: (p: number) => void, originalFileName?: string): Promise<ParsedBook> {
    return parsePdf(filePath, onProgress, originalFileName);
  }

  async readChapter(filePath: string, chapter: ChapterIndex, _imageDir?: string): Promise<string> {
    return readPdfChapter(filePath, chapter);
  }

  async readChapterImages(filePath: string, chapter: ChapterIndex, imageDir: string): Promise<string[]> {
    return readPdfChapterImages(filePath, chapter, imageDir);
  }

  /**
   * 提取封面：将第一页渲染为图片
   *
   * @param filePath PDF 文件路径
   * @param destPath 封面保存路径（.jpg 或 .png）
   * @returns 实际保存的封面路径，失败返回 null
   */
  async extractCover(filePath: string, destPath: string): Promise<string | null> {
    return extractPdfCover(filePath, destPath);
  }
}
