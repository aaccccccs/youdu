/**
 * PDF 解析器
 *
 * 从 file-parser.ts 拆分而来。
 */

import { statSync, existsSync, promises as fsPromises } from 'fs';
import { basename, extname, dirname, join } from 'path';
import { pathToFileURL } from 'node:url';
import { PDFParse } from 'pdf-parse';
import {
  classifyDocument,
  computeOutlinePageStyleRatio,
  computeOutlineSemanticRatio,
  computeOutlineSerialRatio,
  extrapolateImageCount,
  scanImageColorStats,
  type DocumentSignals
} from './document-classifier';
import type { OutlineNode } from 'pdf-parse';
import { createRequire } from 'node:module';

import type { ChapterIndex, ParsedBook, FileParser } from './types';
import type { ChapterImage } from '../../../shared';
import { readImageSize } from './image-size';
import { matchChapterTitle, extractChapterTitle, isVolumeLine, extractVolumeTitle } from './chapter-patterns';
import { cleanContent, detectParseMode } from './txt-parser';
import { epubZipCache, closeAllEpubCaches } from './epub-parser';
import { mobiCache, closeAllMobiCaches } from './mobi-parser';
import { comicZipCache, closeAllComicCaches } from './comic-parser';

/**
 * 获取 sharp 实例（v50 统一加载入口）
 *
 * 打包环境必须从 asar.unpacked 的**绝对路径** require：
 * 实测 asar 内的 sharp JS 无论是动态 import 还是 createRequire 均报
 * "Could not load the sharp module using the linux-x64 runtime"——
 * sharp 的平台检测在 asar 虚拟文件系统下失败。
 * 绝对路径 require（Electron 社区对 sharp-asar 的经典解法）让它以真实
 * 文件系统解析自身与 @img 平台包。
 *
 * 历史坑：此前两条图片链路（enrich 内嵌图 / readPdfChapterImages 落盘）的
 * sharp 加载在打包后**长期静默失败**——catch 回退写原始数据（.jpg 后缀实为
 * PNG），浏览器按内容嗅探正常渲染，掩盖了问题。
 */
type SharpFactory = (typeof import('sharp'))['default'];
let _sharpModule: SharpFactory | null = null;

/**
 * PDF 渲染耗时诊断开关（打开扫描版书"很久"类问题的排查用）。
 *
 * 设置环境变量 YOUDU_PDF_PROF=1 后，renderPdfChapterImages 会输出各阶段耗时
 * （骨架组装 / getScreenshot 渲染 / sharp 压缩+落盘 / 列表组装）。默认关闭，
 * 零运行时开销（仅一次 env 读取）与零日志噪声。
 */
const PDF_PROF_ENABLED = process.env.YOUDU_PDF_PROF === '1';
function profLog(msg: string): void {
  // 运行时双重判定：环境变量（生产：YOUDU_PDF_PROF=1）或全局开关（测试/调试注入）
  if (PDF_PROF_ENABLED || (globalThis as { __YOUDU_PDF_PROF?: boolean }).__YOUDU_PDF_PROF === true) {
    process.stdout.write(`[pdf-prof] ${msg}\n`);
  }
}
/**
 * v56 起导出：章节缩略图生成（chapter-reader.getChapterThumbnails）在主进程
 * 复用同一加载入口（sharp resize 180px 的编解码走 libvips 线程池，JS 侧
 * await 期间不阻塞事件循环），保持全项目 sharp 加载路径唯一。
 */
export async function getSharp(): Promise<SharpFactory> {
  if (_sharpModule) return _sharpModule;
  try {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (typeof resourcesPath === 'string') {
      const sharpPath = join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'sharp');
      if (existsSync(sharpPath)) {
        const req = createRequire(import.meta.url);
        const mod = req(sharpPath) as unknown as { default?: SharpFactory };
        _sharpModule = (mod.default ?? (mod as unknown as SharpFactory)) as SharpFactory;
        return _sharpModule;
      }
    }
  } catch {
    // 打包路径加载失败 → 回退普通解析（dev 环境或异常布局）
  }
  const mod = (await import('sharp')) as { default?: SharpFactory };
  _sharpModule = (mod.default ?? (mod as unknown as SharpFactory)) as SharpFactory;
  return _sharpModule;
}

let _pdfWasmUrl: string | undefined | null = null; // null=已尝试但失败，undefined=未尝试
function getPdfWasmUrl(): string | undefined {
  if (_pdfWasmUrl !== null) return _pdfWasmUrl ?? undefined;
  _pdfWasmUrl = undefined; // 标记已尝试
  // 路径 1：模块解析（dev 模式、主进程 ESM 环境）
  try {
    const __req = createRequire(import.meta.url);
    const pdfjsPkgPath = __req.resolve('pdfjs-dist/package.json');
    const wasmDir = join(dirname(pdfjsPkgPath), 'wasm');
    // pathToFileURL 对目录路径不追加尾部斜杠，pdfjs-dist 的 wasmUrl 要求以 / 结尾，
    // 否则报 "Invalid factory url"。手动补斜杠。
    _pdfWasmUrl = pathToFileURL(wasmDir).toString() + '/';
    return _pdfWasmUrl;
  } catch {
    // 继续兜底：pdf-worker.js 经 rolldown 编译为 CJS 后，import.meta.url 可能不可用
  }
  // 路径 2：按打包产物路径定位（worker CJS 环境兜底）
  // 打包后 pdfjs-dist 位于 app.asar.unpacked/node_modules（electron-builder asarUnpack 已配置）
  try {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (typeof resourcesPath === 'string') {
      const candidates = [
        join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'pdfjs-dist', 'wasm'),
        join(resourcesPath, 'app.asar', 'node_modules', 'pdfjs-dist', 'wasm')
      ];
      for (const dir of candidates) {
        if (existsSync(dir)) {
          _pdfWasmUrl = pathToFileURL(dir).toString() + '/';
          return _pdfWasmUrl;
        }
      }
    }
  } catch {
    // 定位失败（dev 或 wasm 目录不存在），不配置 wasmUrl。
    // 后果：JBIG2/JPX 编码的扫描版 PDF 图片会渲染为白图，但不影响普通 PDF。
  }
  return undefined;
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
 * 按行扫描全文文本，用章节正则库分章
 *
 * 流程：
 * 1. 按行切分全文
 * 2. 逐行用 matchChapterTitle 判断是否为章节标题
 * 3. 匹配到标题 → 上一章结束，记录 { index, title, charOffset, charLength }
 * 4. 卷级标记（含带卷名形态，如"第一卷 燎山纪氏"）不作为独立章节：
 *    先结束当前章节（卷标记行不进入任何章节内容），记录卷标题供后续章节关联
 *    （对齐 txt-parser 的卷处理标杆语义，与 mobi splitChaptersByRegex 同构）
 * 5. 无章节标题 → 走分章兜底
 *
 * @param fullText PDF 全文文本
 * @returns 章节索引数组 + 章节正文数组
 */
export function splitChapters(fullText: string): { chapters: ChapterIndex[]; chapterTexts: string[] } {
  const lines = fullText.split('\n');
  const chapters: ChapterIndex[] = [];
  const chapterTexts: string[] = [];

  // 当前章节信息：endLineIdx 为章节结束行（不含）。
  // 卷标记行会提前锁定 endLineIdx，使卷标记行不进入章节内容（对齐 txt 标杆：
  // txt-parser 在卷标记处结束当前章节且 fileLength 排除卷标记行）。
  // volume 记录章节创建时的当前卷（卷标记前的章节属于旧卷）。
  let currentChapter: {
    title: string;
    startLineIdx: number;
    endLineIdx: number | null;
    volume: string | null;
  } | null = null;
  let chapterIndex = 0;

  // 当前卷标题（遇到卷级标记时更新，对齐 txt-parser）
  let currentVolume: string | null = null;

  // 序言起始行：排除文件开头的卷标记行（对齐 txt-parser 的 preambleStart 语义，
  // 卷标记前散落的文字视为封面页丢弃，卷标记后到首个章标题间的内容构成序言）
  let preambleStartLine = 0;

  // 计算每行的字符起始偏移（含换行符）
  // lineOffsets[i] = 第 i 行在 fullText 中的起始字符偏移
  const lineOffsets: number[] = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i] = offset;
    offset += lines[i].length + 1; // +1 for \n
  }

  // 行 idx → 字符偏移（末尾行 idx 返回全文长度）
  const offsetOfLine = (idx: number): number => (idx < lines.length ? lineOffsets[idx] : fullText.length);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineIsEmpty = trimmed === '';

    if (!lineIsEmpty && matchChapterTitle(trimmed)) {
      // 卷级标记（含带卷名形态）：不作为独立章节。
      // 先结束当前章节（endLineIdx = i，卷标记行不进入章节内容），
      // 再更新卷标题供后续章节关联。
      if (isVolumeLine(trimmed)) {
        if (currentChapter) {
          if (currentChapter.endLineIdx === null) currentChapter.endLineIdx = i;
        } else {
          // 尚未遇到任何章节标题：卷标记行从序言中排除
          preambleStartLine = i + 1;
        }
        currentVolume = extractVolumeTitle(trimmed);
        continue;
      }

      // 匹配到章节标题 → 上一章在此行之前结束（若已被卷标记提前锁定则用锁定值）
      if (currentChapter) {
        const endLineIdx = currentChapter.endLineIdx ?? i;
        const chapterStartOffset = lineOffsets[currentChapter.startLineIdx];
        const chapterEndOffset = offsetOfLine(endLineIdx);
        const chapterText = lines.slice(currentChapter.startLineIdx, endLineIdx).join('\n');
        chapters.push({
          index: chapterIndex,
          title: currentChapter.title,
          fileOffset: chapterStartOffset,
          fileLength: chapterEndOffset - chapterStartOffset,
          volume: currentChapter.volume
        });
        chapterTexts.push(chapterText);
        chapterIndex++;
      } else if (i > preambleStartLine) {
        // 第一个章节标题之前有内容（序言/简介），作为「序言」章节保留。
        // 序言 volume = currentVolume（对齐 txt-parser：序言在卷标记之后时归属该卷；
        // 卷标记之前的散落文字已被 preambleStartLine 排除，不构成序言）。
        // 卷标记曾推进过 preambleStartLine 时，要求序言有实际内容
        // （对齐 txt-parser 的九鼎记保护：卷标记与首章间可能只有空行）。
        const preambleText = lines.slice(preambleStartLine, i).join('\n');
        if (preambleStartLine === 0 || preambleText.trim().length > 0) {
          const chapterStartOffset = lineOffsets[preambleStartLine];
          chapters.push({
            index: chapterIndex,
            title: '序言',
            fileOffset: chapterStartOffset,
            fileLength: lineOffsets[i] - chapterStartOffset,
            volume: currentVolume
          });
          chapterTexts.push(preambleText);
          chapterIndex++;
        }
      }

      // 新章从这一行开始（含标题行）
      currentChapter = {
        title: extractChapterTitle(trimmed),
        startLineIdx: i,
        endLineIdx: null,
        volume: currentVolume
      };
    }
  }

  // 最后一章
  if (currentChapter) {
    const endLineIdx = currentChapter.endLineIdx ?? lines.length;
    const chapterStartOffset = lineOffsets[currentChapter.startLineIdx];
    const chapterText = lines.slice(currentChapter.startLineIdx, endLineIdx).join('\n');
    chapters.push({
      index: chapterIndex,
      title: currentChapter.title,
      fileOffset: chapterStartOffset,
      fileLength: offsetOfLine(endLineIdx) - chapterStartOffset,
      volume: currentChapter.volume
    });
    chapterTexts.push(chapterText);
  }

  return { chapters, chapterTexts };
}

/**
 * 策略 b 文本分章入口（含 txt 标杆质量守卫，任务13）
 *
 * 对齐 txt-parser 的 detectParseMode 前置守卫：novel 模式才走正则分章；
 * plain 模式整书单章——防止正文行被宽松正则误判为章节标题产生垃圾分章。
 * 实证：《八宝门功法大全》(id=279, text, 33章) 的章节标题全是正文句子
 * （"揉摩：在练习排打腹部之前…"/"罗汉抱肚：身正直…"），matchChapterTitle
 * 裸正则无上下文验证，把正文行误判成了章节标题；txt 流程因有本守卫无此问题。
 *
 * markdown 模式不拦截（保持既有 splitChapters 行为）：PDF 分类决策链
 * （document-classifier 三分类 text/illustrated/comic）无 markdown 分支，
 * md 转 pdf 场景罕见，守卫仅解决实证的 plain 误判问题（最小变更）。
 *
 * 单章正文过大的兜底由调用方处理：parsePdf 的 P1-22 逻辑对"1 章 且 >20 页"
 * 按页均分（pageChunk），与 txt plain 模式大文件 fallbackChunk 语义对齐。
 * 导出供单元测试验证守卫行为。
 *
 * @param fullText PDF 全文文本
 * @returns 章节索引数组 + 章节正文数组
 */
export function splitChaptersByTextMode(fullText: string): { chapters: ChapterIndex[]; chapterTexts: string[] } {
  const parseMode = detectParseMode(fullText);
  if (parseMode === 'plain') {
    // plain 模式：整书单章，标题用"全文"（url 由调用方估算逻辑补全；
    // >20 页时调用方走 pageChunk 按页均分兜底）
    return {
      chapters: [{ index: 0, title: '全文', fileOffset: 0, fileLength: fullText.length, volume: null }],
      chapterTexts: [fullText]
    };
  }
  return splitChapters(fullText);
}

/* ==================== outline 分章（PDF 目录/书签） ==================== */

/**
 * 扁平化的 outline 节点（递归展开子节点）
 *
 * PDF outline 是树形结构，每个节点可能有 items 子节点数组。
 * 扁平化后按深度优先顺序排列，用于按目录分章。
 * 导出供单元测试构造（任务13：卷标题页跳过判定）。
 */
export interface FlatOutlineNode {
  /** 章节标题（来自 PDF 书签） */
  title: string;
  /** PDF.js 的 dest 引用（命名目标字符串或显式目标数组） */
  dest: string | Array<unknown> | null;
  /** 解析后的 0-based 页码，null 表示未解析成功 */
  pageNumber: number | null;
  /** outline 层级深度（顶层 0，子节点逐层 +1），用于识别卷/章层级 */
  depth: number;
  /** 原 outline 树中是否有子节点（items 非空）。
   *  多层 outline 时，有子节点的顶层节点（depth=0）是"卷父节点"——其书签指向
   *  卷分隔页（通常整页只有卷名一行字），本身不是章节；无子节点的顶层节点是
   *  真章节（孤叶）。供 splitChaptersByOutline 的卷标题页跳过判定使用。 */
  hasChildren: boolean;
  /** A4修复：dest 页内偏移比例（0=页顶、1=页底）。XYZ 型 dest 的 top 坐标归一化值，
   *  指向该节点的书签可定位到页内位置而非仅页首；Fit 型/插值节点无此字段 */
  destTop?: number;
}

/**
 * 递归扁平化 PDF outline 树
 *
 * 深度优先遍历，保留父子顺序（父章节在前，子章节紧随其后）。
 * 跳过标题为空或 url 外链的节点（外链不是章节）。
 * 记录每个节点的层级深度（depth），供分章时区分卷/章层级。
 *
 * @param outline PDF outline 节点数组
 * @param result 累积结果数组（递归传递）
 * @param depth 当前层级深度（顶层 0，递归传递时 +1）
 * @returns 扁平化后的 outline 节点数组
 */
function flattenOutline(outline: OutlineNode[], result: FlatOutlineNode[] = [], depth = 0): FlatOutlineNode[] {
  for (const node of outline) {
    // 跳过空标题和外链节点
    if (!node.title || node.url) continue;
    const childItems = Array.isArray(node.items) ? (node.items as OutlineNode[]) : [];
    result.push({
      title: node.title.trim(),
      dest: node.dest,
      pageNumber: null,
      depth,
      // 记录是否有子节点：供 splitChaptersByOutline 区分"卷父节点"与"孤叶真章节"
      hasChildren: childItems.length > 0
    });
    // 递归处理子节点（层级 +1）
    if (childItems.length > 0) {
      flattenOutline(childItems, result, depth + 1);
    }
  }
  return result;
}

/**
 * 复用 pdf-parse document 解析书签所需的最小接口（pdfjs PDFDocumentProxy 子集）。
 *
 * 用最小结构化类型（而非 import pdfjs-dist 类型包）以降低编译期耦合：
 * 这里只需要 getDestination / getPageIndex / getPage 三个无渲染方法。
 */
interface OutlineDocumentProxy {
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
  getPage(pageNumber: number): Promise<{ view: number[] }>;
}

/**
 * 解析 outline 节点的页码 + dest 页内偏移
 *
 * 【关键性能修复（打开扫描版书"很久"的根因）】
 * 曾改用 `import('pdfjs-dist/legacy/build/pdf.mjs')` 独立 getDocument 加载文档来
 * 绕开 pdf-parse 的 `parser.doc`（PDFParse.d.ts 声明 private，属版本兼容隐患）。
 * 但 Node 环境下 pdfjs-dist 的 getDocument 使用**进程级共享**的 fake worker /
 * 模块状态：同一进程内先经外部 pdfjs-dist getDocument 加载文档后（即使 await
 * doc.destroy()），pdf-parse 后续的 getScreenshot 会被永久拖慢——实测 780 页
 * 扫描书单页渲染由 ~80ms 恶化到 >90s（1000+ 倍），表现为"打开扫描版 PDF 要等
 * 很久""一次读取很多图片很卡"。
 *
 * 现改为**复用 pdf-parse 已加载的 `parser.doc`**（运行时为普通实例属性，压缩产物
 * 中即 `class PDFParse { doc; ... }`）：不产生第二次文档加载，彻底规避上述污染。
 * doc 生命周期归 parser 管理（parsePdf 缓存 parser，由 LRU / closeAllPdfCaches
 * 统一销毁），此处不 destroy。doc 不可用时告警并让页码保持 null（由
 * splitChaptersByOutline 插值兜底），保证功能可用且不静默。
 *
 * A4修复：XYZ 型 dest [page, /XYZ, left, top, zoom] 的第 4 项 top（用户空间 y
 * 坐标，页顶 = 页高，向下递减）归一化为 0-1 页内偏移存入 node.destTop（0=页顶、
 * 1=页底），供前端切章时滚动定位——原实现只取 pageNumber 丢弃坐标，点击小节
 * 书签只能到章首。Fit 型 dest（无坐标项）与 top 为 null 的 XYZ 不设置。
 *
 * 解析失败的节点保持 pageNumber=null，后续由 splitChaptersByOutline 插值补全。
 *
 * @param parser 已加载文档的 pdf-parse 实例（复用其 doc）
 * @param flatOutline 扁平化后的 outline 节点数组
 * @param totalPages 总页数（B5修复：整数页码形态 dest 的 clamp 上界）
 */
async function resolveOutlinePageNumbers(
  parser: PDFParse,
  flatOutline: FlatOutlineNode[],
  totalPages: number
): Promise<void> {
  const doc = (parser as unknown as { doc?: OutlineDocumentProxy }).doc;
  if (!doc) {
    console.warn('[pdf-parser] outline 页码解析降级：pdf-parse 未暴露 doc，书签页码将走插值兜底');
    return;
  }

  // 页码 → userSpace 纵向边界 [y1, y2] 缓存（同页多书签共享，避免重复 getPage 往返）
  const pageYBounds = new Map<number, [number, number]>();
  try {
    for (const node of flatOutline) {
      try {
        let explicitDest: Array<unknown> | null = null;
        if (Array.isArray(node.dest)) {
          // 显式目标数组：dest[0] 是页面引用
          explicitDest = node.dest;
        } else if (typeof node.dest === 'string') {
          // 命名目标字符串：需要先解析为显式目标
          explicitDest = await doc.getDestination(node.dest);
        }
        if (explicitDest && explicitDest[0] != null) {
          if (typeof explicitDest[0] === 'number') {
            // B5修复：PDF 规范允许 dest 数组首项为 0-based 整数页码（部分生成器如早期 ReportLab 产出），
            // 直接取值并 clamp 到有效页范围——原实现一律走 getPageIndex 会抛 TypeError → catch → 插值兜底，
            // 造成此类书的章节边界系统性错位
            node.pageNumber = Math.max(0, Math.min(Math.floor(explicitDest[0]), totalPages - 1));
          } else {
            // getPageIndex 将页面引用（ref 对象等）转换为 0-based 页码
            // （explicitDest 类型为 unknown[]，断言为 pdfjs RefProxy 形态——
            //  非 ref 形态运行时抛 TypeError，由下方 catch 兜底插值）
            node.pageNumber = await doc.getPageIndex(explicitDest[0] as { num: number; gen: number });
          }
          // A4修复：XYZ 型 dest 的 top 坐标（dest[3]）归一化为页内偏移比例。
          // typeof 过滤天然排除 Fit/FitH 等无 top 项的形态与 top 为 null 的 XYZ。
          if (node.pageNumber !== null && typeof explicitDest[3] === 'number') {
            let bounds = pageYBounds.get(node.pageNumber);
            if (!bounds) {
              // page.view = [x1, y1, x2, y2]（scale 1 userSpace），页高 = y2 - y1
              const page = await doc.getPage(node.pageNumber + 1);
              bounds = [page.view[1], page.view[3]];
              pageYBounds.set(node.pageNumber, bounds);
            }
            const height = bounds[1] - bounds[0];
            if (height > 0) {
              // top 是用户空间 y（页顶最大）：偏移比例 = (y2 - top) / 页高，clamp 到 [0, 1]
              node.destTop = Math.max(0, Math.min((bounds[1] - explicitDest[3]) / height, 1));
            }
          }
        }
      } catch {
        // 解析失败保持 null（页码由 splitChaptersByOutline 插值补全），输出警告便于排查
        console.warn('[pdf-parser] outline 页码解析失败:', node.title);
      }
    }
  } finally {
    // 注意：此处**不销毁** doc。doc 归 pdf-parse 的 parser 生命周期管理
    // （parsePdf 缓存 parser，由 LRU / closeAllPdfCaches 统一销毁）；
    // 复用同一 doc 正是为了规避 pdfjs-dist 二次 getDocument 的渲染性能污染。
  }
}

/**
 * 按 PDF outline（书签/目录）分章
 *
 * 流程：
 * 1. 补全页码序列：null 页码节点以有效页码为锚点线性插值（P1修复：原均分
 *    兜底与有效页码混用时章节边界系统性错位）；全部无效时按 outline 顺序
 *    均分总页数（最后兜底，此时无任何锚点）
 * 2. 单调化校验（处理乱序 outline 节点）+ 同页相邻节点合并
 *    （避免同一页内容在相邻两章重复出现）
 * 3. 多层 outline 时按 depth 填充章节所属卷（volume）：
 *    顶层节点是"卷标题"本身（volume 不填），子章节归属最近的顶层卷
 * 4. 按补全后的页码切分：每章包含从该节点页码到下一节点页码之间的所有页面文本
 * 5. 卷标题页跳过（任务13）：多层 outline 时，有子节点且未被同页合并的顶层节点
 *    （卷父节点）不作为独立章节——对齐 txt 标杆"卷标记不入章"语义
 *
 * 导出供单元测试验证卷标题页跳过边界（孤叶/同页合并/单层 outline）。
 *
 * @param flatOutline 扁平化后的 outline 节点数组（已解析页码，含 depth/hasChildren）
 * @param pageTexts 每页文本数组（0-based 索引）
 * @param totalPages 总页数
 * @returns 章节索引数组 + 章节正文数组
 */
export function splitChaptersByOutline(
  flatOutline: FlatOutlineNode[],
  pageTexts: string[],
  totalPages: number
): { chapters: ChapterIndex[]; chapterTexts: string[] } {
  const n = flatOutline.length;
  if (n === 0) return { chapters: [], chapterTexts: [] };

  /* ---- P1修复：补全页码序列（单调插值替代逐节点均分兜底）----
   * 原逻辑：null 页码节点用 Math.floor((totalPages/n)*i) 均分，与有效页码
   * 混用时章节边界系统性错位（如锚点 0/90 之间的 null 节点被均分到 30/60）。
   * 修复：以有效页码为锚点线性插值，天然保证锚点之间的页码单调，
   * 消除 null 混合场景的乱序交叉。 */
  const pages: number[] = flatOutline.map((node) => node.pageNumber ?? -1);
  const hasValidPageNumbers = pages.some((p) => p >= 0);

  if (hasValidPageNumbers) {
    // 扫描锚点区间：头部 null 用第一个有效页码（不低于 0）；
    // 中间 null 在前后有效锚点之间线性插值
    let prevIdx = -1; // 最近一个有效锚点索引
    let prevPage = 0; // 该锚点的页码
    for (let i = 0; i < n; i++) {
      if (pages[i] < 0) continue;
      if (prevIdx < 0) {
        // 头部 null：用第一个有效页码
        for (let j = 0; j < i; j++) pages[j] = Math.max(0, pages[i]);
      } else {
        // 中间 null：pages[j] = prevPage + (nextPage - prevPage) * (j - prevIdx) / (i - prevIdx)
        for (let j = prevIdx + 1; j < i; j++) {
          pages[j] = Math.round(prevPage + ((pages[i] - prevPage) * (j - prevIdx)) / (i - prevIdx));
        }
      }
      prevIdx = i;
      prevPage = pages[i];
    }
    // 尾部 null（无后锚）：从 prevPage 起按剩余节点数线性分摊到 totalPages-1
    if (prevIdx >= 0 && prevIdx < n - 1) {
      const remaining = n - 1 - prevIdx;
      const lastTarget = totalPages - 1;
      for (let j = prevIdx + 1; j < n; j++) {
        pages[j] = Math.round(prevPage + ((lastTarget - prevPage) * (j - prevIdx)) / remaining);
      }
    }
  } else {
    // 全部 null：无任何锚点，保留原均分逻辑（最后兜底）
    for (let j = 0; j < n; j++) {
      pages[j] = Math.floor((totalPages / n) * j);
    }
  }

  /* ---- P1修复：切分单调性校验 + 同页合并 ---- */
  // 1. 单调化：pages[i] = max(pages[i], pages[i-1])，处理乱序 outline 节点
  for (let j = 1; j < n; j++) {
    pages[j] = Math.max(pages[j], pages[j - 1]);
  }

  // 2. 同页相邻节点合并：若 pages[i] === pages[i+1]，两节点合并为一章
  //    （标题取信息量更大的：更长的标题；保留前者的 depth/volume 语义）
  //    合并后从列表移除被并节点，避免同一页内容在相邻两章重复出现
  //    volumeSource：合并组内首个 depth===0 顶层节点的原 title。
  //    顶层卷标题常与首个子章同页（小说常见排版），合并后 title 取更长的
  //    子章标题会覆盖卷名——volumeSource 保留被吞掉的顶层原卷名供卷归属使用，
  //    仅作中间量，不进 ChapterIndex。
  // A4修复：destTop 随节点保留（同页合并不覆盖——章节起点即首个书签的页内位置）
  // 任务13：hasChildren（组内任一原始节点有子节点）/ mergedIntoGroup（组经历过
  // 同页合并）随节点保留，供主循环的卷标题页跳过判定使用
  const merged: Array<{
    title: string;
    depth: number;
    startPage: number;
    destTop?: number;
    volumeSource?: string;
    hasChildren: boolean;
    mergedIntoGroup: boolean;
  }> = [];
  for (let i = 0; i < n; i++) {
    const last = merged[merged.length - 1];
    if (last && last.startPage === pages[i]) {
      // 同页合并：后者标题信息量更大（更长）时采用后者
      if (flatOutline[i].title.length > last.title.length) {
        last.title = flatOutline[i].title;
      }
      // 卷语义来源：被并入的顶层节点（depth===0）记其原 title；前者已记录则不覆盖
      if (flatOutline[i].depth === 0 && last.volumeSource === undefined) {
        last.volumeSource = flatOutline[i].title;
      }
      // 组内任一原始节点有子节点则置 true：卷父节点被并入意味着组是
      // "卷头+首章"混合，组已承载首章内容页（跳过判定须排除此类组）
      if (flatOutline[i].hasChildren) last.hasChildren = true;
      // 标记组经历过同页合并：混合组不适用"卷标题页跳过"（防误删首章内容）
      last.mergedIntoGroup = true;
      continue;
    }
    merged.push({
      title: flatOutline[i].title,
      depth: flatOutline[i].depth,
      startPage: pages[i],
      // A4修复：真实解析出的 dest 页内偏移（插值节点为 undefined，不编码进 url）
      destTop: flatOutline[i].destTop,
      // 顶层节点记自身原 title 为卷语义来源（title 被同页合并覆盖后仍可溯源）
      volumeSource: flatOutline[i].depth === 0 ? flatOutline[i].title : undefined,
      hasChildren: flatOutline[i].hasChildren,
      mergedIntoGroup: false
    });
  }

  // ---- P1修复：多层 outline 填充卷（volume）信息 ----
  // outline 是否有多层（存在 depth > 0 的节点）；
  // 单层（全是 depth 0）时不填 volume，保持平级，避免每章都成"卷"
  const hasDepth = flatOutline.some((node) => node.depth > 0);
  // 当前卷标题：最近一个 depth===0 顶层节点的原 title（volumeSource，防同页合并覆盖）
  let currentVolume: string | undefined;

  const chapters: ChapterIndex[] = [];
  const chapterTexts: string[] = [];
  let charOffset = 0;
  // 任务13：独立章计数器。卷标题页跳过后 merged 下标会出现空洞，index 若沿用
  // 循环下标 i 将不连续——readPdfChapter 用 chapter.index 直接索引
  // cached.chapterTexts，必须保证 0..n-1 连续无空洞
  let chapterIdx = 0;

  for (let i = 0; i < merged.length; i++) {
    const node = merged[i];
    // 3. 切分：endPage 为下一节点起始页（0-based exclusive），最后一章到 totalPages
    //    插值 + 单调化后天然满足 endPage > startPage（除最后一章）
    const startPage = node.startPage;
    const endPage = i + 1 < merged.length ? merged[i + 1].startPage : totalPages;

    // 钳制到有效范围，确保每章至少 1 页（保留作兜底：乱序/越界页码）
    const clampedStart = Math.max(0, Math.min(startPage, totalPages - 1));
    const clampedEnd = Math.max(clampedStart + 1, Math.min(endPage, totalPages));

    const texts = pageTexts.slice(clampedStart, clampedEnd);
    const chapterText = texts.join('\n\n');
    const chapterLength = chapterText.length;

    // 卷信息：多层 outline 时，depth===0 顶层节点是"卷标题"本身（volume 不填），
    // depth>0 的章节归属最近的顶层卷；单层 outline 不填 volume（保持平级）
    if (node.depth === 0) {
      // 卷语义更新优先用 volumeSource（保留被同页合并吞掉的顶层原标题）
      currentVolume = node.volumeSource ?? node.title;
    }

    // 任务13：卷标题页跳过——多层 outline 时，有子节点的顶层节点（卷父节点）
    // 的书签指向卷分隔页（通常整页只有卷名一行字），不作为独立章节，对齐
    // txt 标杆语义"卷标记不入章"（卷语义已由 volume 字段消费）。
    // 实证：《0day安全》idx=5"第1篇 漏洞利用原理（初级）"卷扉页成了一章。
    // 三个边界（跳过条件缺一不跳）：
    // - 单层 outline（hasDepth=false）不跳——全是 depth=0 平级书签，跳了就删光
    // - 孤叶顶层节点（hasChildren=false）不跳——无子节点的 depth=0 是真章节
    // - 同页合并组（mergedIntoGroup=true）不跳——卷头与首章同页的混合组
    //   已承载首章内容页（跳过会丢内容），卷名走 volumeSource 溯源
    // 全卷保护：hasDepth=true 数学上保证存在 depth>0 节点（跳过条件要求
    // depth===0，depth>0 节点永不满足），chapters 不可能被清空
    if (hasDepth && node.depth === 0 && node.hasChildren && !node.mergedIntoGroup) {
      continue;
    }

    const volume = hasDepth && node.depth > 0 ? currentVolume : undefined;

    chapters.push({
      index: chapterIdx++,
      title: node.title,
      fileOffset: charOffset,
      fileLength: chapterLength,
      // 卷层级：归属的顶层卷标题（ChapterIndex.volume，前端 ChapterBar 卷折叠 UI 消费，
      // 入库链路 importer.ts 透传 ch.volume ?? null，DB schema v14 已支持）
      volume,
      // 存储页码范围（1-based，"起始页-结束页"）供 readPdfChapter 按需渲染截图
      // startPage 为 0-based，endPage 为 0-based exclusive，转 1-based：起始=startPage+1，结束=endPage
      // A4修复：dest 页内偏移编码进 url 尾部（"11-30@0.62"），前端切章时据此滚动定位到
      // 页内位置（点小节书签直达小节而非章首）。选 url 编码而非 chapters 表加列：加列需
      // migration + repo/类型全链改动（约 30 行，超 A4 预算），url 已是 TEXT 列零迁移成本；
      // 主进程渲染路径 split('-') + parseInt 对 "@ratio" 尾缀天然兼容（parseInt 停在非数字字符）。
      // 仅偏移 > 0.005 时编码（页首即默认行为，避免无意义后缀扩大兼容面）
      url:
        node.destTop !== undefined && node.destTop > 0.005
          ? `${clampedStart + 1}-${clampedEnd}@${node.destTop.toFixed(2)}`
          : `${clampedStart + 1}-${clampedEnd}`
    });
    chapterTexts.push(chapterText);

    charOffset += chapterLength + 2; // +2 for \n\n
  }

  return { chapters, chapterTexts };
}

/* ==================== 超长章节分段（D-1 数据完整性） ==================== */

/**
 * 超长章节分段切分（D-1修复，数据完整性）
 *
 * 背景：resolvePdfChapterPageRange 的 PDF_CHAPTER_MAX_PAGES=50 运行时截断使
 * 单章页数超限时后续页**永久不可读**（技术书大 Part 级书签、正则分章估算出
 * 的大区间章），截断只有 console.warn 用户不可见，章末转场卡照常出现 →
 * 用户读完 50 页以为本章结束（实际丢了 51+ 页内容）。
 *
 * 解析期把超限章展开为多段章：
 * - 主章保留前 50 页，后续每 50 页一段，标题加"（2/N）""（3/N）"后缀（N=总段数）
 * - volume 继承原章；fileOffset = 原章偏移 + 前段累计长度，fileLength = 段文本长度
 * - url 保持 "start-end"（1-based）；主章保留原 url 的 "@ratio" 页内偏移尾缀
 *   （首书签页内位置仅对主章有意义）
 * - 章节文本切分：整章文本与"该章页区间按页拼接"一致（outline 路径的
 *   chapterTexts 由 pageTexts.slice().join('\n\n') 生成）时按页精确切段；
 *   否则（splitChapters 正则路径的 url 为估算页码）按段页数占比切分
 * - 展开后统一重排 index（章数变化使后续章序号偏移）
 *
 * 调用时机：分章完成后、deduplicatePdfChapters 之前（续章标题带后缀不会被
 * 同名合并误并；deduplicate 不跳过任何章节，分段续章不会误删）。
 * 漫画 per-page 路径每章 1 页，不经过本函数。
 *
 * @param chapters 分章结果（url 含 1-based 页码区间）
 * @param chapterTexts 与 chapters 对齐的章节正文
 * @param pageTexts 每页文本数组（0-based 索引）
 */
function splitOversizedPdfChapters(
  chapters: ChapterIndex[],
  chapterTexts: string[],
  pageTexts: string[]
): { chapters: ChapterIndex[]; chapterTexts: string[] } {
  // 快速路径：无超长章时原样返回（零拷贝零开销）
  const hasOversized = chapters.some((ch) => {
    const range = parsePdfChapterPageRange(ch.url);
    return range !== null && range.end - range.start + 1 > PDF_CHAPTER_MAX_PAGES;
  });
  if (!hasOversized) return { chapters, chapterTexts };

  const outChapters: ChapterIndex[] = [];
  const outTexts: string[] = [];

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const range = parsePdfChapterPageRange(ch.url);
    const totalPages = range !== null ? range.end - range.start + 1 : 0;
    if (range === null || totalPages <= PDF_CHAPTER_MAX_PAGES) {
      outChapters.push(ch);
      outTexts.push(chapterTexts[i] ?? '');
      continue;
    }

    const text = chapterTexts[i] ?? '';
    // 精确切段判定：整章文本与该章页区间按页拼接一致（outline 路径成立）
    // → 段边界按页对齐；否则按段页数占比切分（正则路径 url 为估算值）
    const rebuilt = pageTexts.slice(Math.max(0, range.start - 1), Math.min(pageTexts.length, range.end)).join('\n\n');
    const precise = rebuilt === text;

    const segments = Math.ceil(totalPages / PDF_CHAPTER_MAX_PAGES);
    // 主章 url 的 "@ratio" 尾缀（页内偏移，仅对主章有意义）
    const ratioSuffix = extractUrlRatioSuffix(ch.url);
    let segOffset = ch.fileOffset;
    let prevCut = 0; // 比例切分模式的段文本起点（字符偏移）

    for (let s = 0; s < segments; s++) {
      const segStart = range.start + s * PDF_CHAPTER_MAX_PAGES;
      const segEnd = Math.min(range.end, segStart + PDF_CHAPTER_MAX_PAGES - 1);
      let segText: string;
      if (precise) {
        segText = pageTexts.slice(segStart - 1, segEnd).join('\n\n');
      } else if (s === segments - 1) {
        segText = text.slice(prevCut); // 末段取剩余全部（避免取整误差丢尾）
        prevCut = text.length;
      } else {
        const cut = Math.floor((text.length * (s + 1) * PDF_CHAPTER_MAX_PAGES) / totalPages);
        segText = text.slice(prevCut, cut);
        prevCut = cut;
      }

      outChapters.push({
        index: 0, // 占位，展开完成后统一重排
        title: s === 0 ? ch.title : `${ch.title}（${s + 1}/${segments}）`,
        fileOffset: segOffset,
        fileLength: segText.length,
        volume: ch.volume,
        contentType: ch.contentType,
        url: s === 0 ? `${segStart}-${segEnd}${ratioSuffix}` : `${segStart}-${segEnd}`
      });
      outTexts.push(segText);
      segOffset += segText.length + 2; // +2 对齐 charOffset 的 '\n\n' 分隔约定
    }
  }

  // 展开导致章数变化 → 统一重排 index
  outChapters.forEach((c, idx) => {
    c.index = idx;
  });
  return { chapters: outChapters, chapterTexts: outTexts };
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
 * 解析 PDF 章节 url 的页码范围（1-based 闭区间）
 *
 * 兼容三种格式（与 readPdfChapterImages / enrichPdfChapterWithImages 的 url 消费端对齐）：
 * - 区间格式 "11-30"（图文/扫描版章节）
 * - 区间带页内偏移 "11-30@0.62"（A4 修复：outline dest 页内位置编码进 url 尾部）
 * - 单页格式 "5"（漫画每页一章 / DB 旧格式数据）
 *
 * B1修复配套：deduplicatePdfChapters 同名合并时计算两章页码范围的并集。
 *
 * @returns 解析成功返回 { start, end }（单页格式 start === end）；url 缺失或非 PDF 页码格式返回 null
 */
function parsePdfChapterPageRange(url: string | null | undefined): { start: number; end: number } | null {
  if (typeof url !== 'string') return null;
  // A4修复：url 尾部可能带 "@ratio" 页内偏移编码，页码计算忽略该后缀
  const rangeMatch = url.match(/^(\d+)-(\d+)(?:@[\d.]+)?$/);
  if (rangeMatch) return { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]) };
  // B1补全：单页格式 "N"（漫画逐页章 / 旧格式 DB 数据），start === end
  const singleMatch = url.match(/^(\d+)(?:@[\d.]+)?$/);
  if (singleMatch) {
    const page = Number(singleMatch[1]);
    return { start: page, end: page };
  }
  return null;
}

/** 提取 url 尾部的 "@ratio" 页内偏移后缀（无则返回空串），合并 url 时透传给新起点章 */
function extractUrlRatioSuffix(url: string | null | undefined): string {
  if (typeof url !== 'string') return '';
  const match = url.match(/(@[\d.]+)$/);
  return match ? match[1] : '';
}

/**
 * 章节去重 + 过滤过短章节 + 合并相邻同名章节
 *
 * 复用 TXT 解析器的去重逻辑：
 * - 用 Set 记录已见标题（trim().toLowerCase() 作为 key）
 * - 相邻同名章节合并：扩展前一个章节的 fileLength 到后一个章节的末尾，并同步合并
 *   页码范围 url（B1修复：取并集——图片渲染按 url 截取页面截图，不合并会导致被并入
 *   章节的后段页面不渲染，图文/扫描版图片内容丢失）
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
        // B1修复：正文连接由 '\n' 改 '\n\n' 对齐 charOffset 约定——章节间在原拼接中以 \n\n 分隔
        // （fileLength 按偏移差计算含 2 字符间隔），'\n' 连接会使合并后文本长度与 fileLength 脱节
        resultTexts[resultTexts.length - 1] = resultTexts[resultTexts.length - 1] + '\n\n' + text;
        // P1修复：合并时保留 volume（优先前者，前者缺失时取被并章节的，保证合并后字段完整）
        if (last.volume == null && ch.volume != null) {
          last.volume = ch.volume;
        }
        // B1修复：同步合并页码范围 url（取并集）——图片渲染按 url 截取页面截图，
        // 保持旧 url 会导致被并入章节的后段页面不渲染（图文/扫描版丢页）。
        // 兼容单页格式 "N"（B1补全）：单页 url 解析为 { start: N, end: N } 参与并集，
        // 避免旧实现解析失败回退时丢弃 last 或 ch 一方的页码。
        const lastRange = parsePdfChapterPageRange(last.url);
        const chRange = parsePdfChapterPageRange(ch.url);
        if (lastRange && chRange) {
          const mergedStart = Math.min(lastRange.start, chRange.start);
          const mergedEnd = Math.max(lastRange.end, chRange.end);
          if (mergedStart === mergedEnd) {
            // 同页合并：url 保持不变（含可能的 "@ratio" 后缀与原格式）
          } else {
            // 区间合并：保留 last 的 "@ratio" 页内偏移（章节起点仍是原起点，页内定位仍有效）
            last.url = `${mergedStart}-${mergedEnd}${extractUrlRatioSuffix(last.url)}`;
          }
        } else if (chRange) {
          last.url = chRange.start + '-' + chRange.end;
        }
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

/* ==================== 文档信号采集（任务40：parsePdf 与批量重检共用） ==================== */

/** buildDocumentSignalsFromPdf 的输入（pdf-parse 提取的原始文本/元数据 + 文件字节） */
export interface PdfSignalsSource {
  /** 完整文件字节（二进制扫描图片对象/滤镜/MediaBox 用） */
  buffer: Buffer;
  /** 全文文本（pdf-parse getText().text） */
  fullText: string;
  /** 每页文本（按页码升序，0-based 索引对应第 i+1 页） */
  pageTexts: string[];
  /** Info 字典（getInfo().info；undefined=提取失败，producer 不采集，判定不干预） */
  info: Record<string, unknown> | undefined;
  /** 扁平化书签节点（flattenOutline 输出；书签标题占比只消费 title/depth） */
  flatOutline: FlatOutlineNode[];
  /** 页数 */
  pageCount: number;
}

/**
 * 从 PDF 原始提取结果构造 DocumentSignals（纯函数，parsePdf 与批量重检共用）
 *
 * 任务40 抽取：原逻辑内联在 parsePdf 中（v28-v40 各维度 + 任务39 多维特征），
 * 批量重检（reclassifier）需要与导入时**完全同源**的信号口径（否则重检结果
 * ≠ "该文件若重新导入会被分成的类型"），故提取为唯一实现，两处调用零漂移。
 *
 * 采集维度（与原实现逐行一致）：
 *   - 文本层：textCharsPerPage / textStdDev / textPageRatio（有显著文字>50字的页占比）
 *   - 图片计数：二进制扫描 /Subtype /Image + extrapolateImageCount 覆盖率外推
 *   - 书签：outlineCount + 标题三类占比（page/serial/semantic，document-classifier）
 *   - Producer：Info 字典（对象流压缩，二进制不可见，只能经 pdf-parse getInfo 提取）
 *   - 图片颜色模式：scanImageColorStats 窗口法查 ColorSpace（document-classifier）
 *   - 页面几何：MediaBox 扫前 2MB → pageRatioStdDev / hasMixedOrientation
 *   - 压缩滤镜：ccittRatio
 */
export function buildDocumentSignalsFromPdf(src: PdfSignalsSource): DocumentSignals {
  const { buffer, fullText, pageTexts, info, flatOutline } = src;
  const pdfPageCount = Math.max(src.pageCount, 1);

  const avgCharsPerPage = fullText.length / pdfPageCount;

  // 大文件二进制搜索限制范围：PDF 对象定义（xref/Image/Filter）通常在文件前部
  // 扫描前 20MB 足以覆盖绝大多数 PDF 的对象定义，避免对 500MB+ 文件全量扫描
  const BINARY_SCAN_LIMIT = 20 * 1024 * 1024;
  const binaryScanBuf = buffer.length > BINARY_SCAN_LIMIT ? buffer.subarray(0, BINARY_SCAN_LIMIT) : buffer;

  // P1-22/P1-2/v40（历史修复说明见 parsePdf 内原注释）：/Subtype /Image 前缀
  // 匹配已覆盖 ImageB/C/I 全部子类型，按扫描覆盖率外推修复大文件图计数失真。
  const rawImageCount =
    countInBuffer(binaryScanBuf, '/Subtype /Image') + countInBuffer(binaryScanBuf, '/Subtype/Image');
  const imageCount = extrapolateImageCount(rawImageCount, binaryScanBuf.length, buffer.length, pdfPageCount);
  const imageDensity = imageCount / pdfPageCount;
  const fileSizePerPage = buffer.length / pdfPageCount / (1024 * 1024);
  const outlineCount = flatOutline.length;

  // 维度: 有字页比例（有显著文字>50字的页面占比）
  const pageTextLengths = pageTexts.map((p) => (p || '').length);
  const pagesWithSignificantText = pageTextLengths.filter((l) => l > 50).length;
  const textPagesRatio = pagesWithSignificantText / pdfPageCount;

  // 维度: 文字分布标准差（漫画文字少且均匀，图文文字多且分布不均）
  const meanTextPerPage = avgCharsPerPage;
  const textVariance =
    pageTextLengths.length > 0
      ? pageTextLengths.reduce((sum, len) => sum + Math.pow(len - meanTextPerPage, 2), 0) / pageTextLengths.length
      : 0;
  const textStdDev = Math.sqrt(textVariance);

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

  // 任务39 维度A: PDF 元数据 Producer（Info 字典，getInfo 已返回——零成本采集）。
  // 全库 240 本实测交叉表：iTextSharp/PDFdo/AnnasArchive/Acrobat图片转换 → 强漫画；
  // Ghostscript/zlib → 强扫描书；FreePic2Pdf → 中性。Info 字典经对象流压缩，
  // 二进制搜不到明文，只能经 pdfjs（pdf-parse 的 getInfo 同源）提取。
  // getInfo 失败时 info=undefined → producer 不采集，判定不干预（兼容旧信号）。
  let producer: string | undefined;
  if (info) {
    const rawProducer = info.Producer;
    if (typeof rawProducer === 'string' && rawProducer.trim()) {
      producer = rawProducer.trim();
    }
  }

  // 任务39 维度B: 图片颜色模式占比（gray/index vs rgb/cmyk）+ DjVu 编码特征。
  // 复用 extrapolateImageCount 同款二进制扫描扩展点：对每个 /Subtype /Image 命中点
  // 取前后 300 字节窗口查 ColorSpace 标记。与 pdfimages -list color 列实测高一致。
  // （刻意不用 getImage/渲染采样：v36 已证明解码像素极耗时——分类阶段只读对象字典。）
  const colorStats = scanImageColorStats(buffer);

  return {
    pageCount: pdfPageCount,
    totalTextChars: fullText.replace(/\s/g, '').length,
    textCharsPerPage: avgCharsPerPage,
    textStdDev,
    textPageRatio: textPagesRatio,
    imageCount,
    imageDensity,
    outlineCount,
    // P2-4修复：页码式书签标题占比（逐页书签误判漫画的复核特征）。
    outlinePageStyleRatio: computeOutlinePageStyleRatio(flatOutline),
    // 任务37：高密度逐页书签（3a-1）的标题语义三分法复核信号 ——
    // 语义式占比 > 0.5 → 扫描版技术书；序号式占比 < 0.5（纯页码式/混杂）→ 扫描版。
    outlineSemanticRatio: computeOutlineSemanticRatio(flatOutline),
    outlineSerialRatio: computeOutlineSerialRatio(flatOutline),
    // 任务39：多维特征信号——Producer（元数据工具链指纹）+ 图片颜色模式占比 +
    // DjVu 编码特征。均 optional：getInfo 失败/无图片对象时 undefined，不干预判定。
    producer,
    grayOrIndexImageRatio: colorStats.grayOrIndexImageRatio,
    djvuEncoded: colorStats.djvuEncoded,
    hasMixedOrientation,
    pageRatioStdDev,
    fileSizePerPageMB: fileSizePerPage,
    ccittRatio
  };
}

/**
 * 轻量采集单本 PDF 的 DocumentSignals（任务40 批量重检入口）
 *
 * 与 parsePdf 的信号口径完全同源（共用 buildDocumentSignalsFromPdf），
 * 但不分章、不进 LRU 缓存、不渲染——采集完立即销毁解析器。
 * 判定结果等价于"该文件若重新导入会被分成的类型"。
 *
 * 与 parsePdf 的两点刻意差异（均不影响信号值）：
 *   1. 不调用 resolveOutlinePageNumbers（书签页码解析只为分章服务，
 *      signals 只消费书签 title/depth，跳过省去逐书签 getDestination 往返）
 *   2. 解析器用后即毁（批量重检串行扫全库，常驻缓存只会挤占
 *      正在阅读书籍的 pdfCache 槽位）
 *
 * @param filePath PDF 文件绝对路径
 * @throws PdfParseError 文件不存在/为空/读取或解析失败（调用方跳过该书记 failed）
 */
export async function extractPdfDocumentSignals(filePath: string): Promise<DocumentSignals> {
  // 校验文件存在（与 parsePdf 同前置校验）
  let stat;
  try {
    stat = statSync(filePath);
  } catch (err) {
    throw new PdfParseError(`文件不存在或无法访问: ${filePath}`, err as Error);
  }
  if (stat.size === 0) {
    throw new PdfParseError('文件为空');
  }

  let buffer: Buffer;
  try {
    buffer = await fsPromises.readFile(filePath);
  } catch (err) {
    throw new PdfParseError(`读取 PDF 文件失败: ${(err as Error).message}`, err as Error);
  }

  let parser: PDFParse | null = null;
  try {
    parser = createPdfParser(new Uint8Array(buffer));
    const textResult = await parser.getText();
    const fullText = textResult.text;
    const pdfPageCount = textResult.total || 1;
    // 提取每页文本（0-based 索引，按页码排序，与 parsePdf 同口径）
    const pageTexts = textResult.pages.sort((a, b) => a.num - b.num).map((p) => p.text);

    let info: Record<string, unknown> | undefined;
    let flatOutline: FlatOutlineNode[] = [];
    try {
      const infoResult = await parser.getInfo();
      info = infoResult.info as Record<string, unknown> | undefined;
      const outline = infoResult.outline ?? null;
      if (outline && outline.length > 0) {
        flatOutline = flattenOutline(outline);
      }
    } catch (err) {
      // 与 parsePdf 同语义（B3修复）：加密/损坏 PDF 的元数据提取失败不致命——
      // producer 不采集（判定不干预），书签按空处理；留 warn 便于归因
      console.warn('[pdf-parser] 重检 getInfo/outline 提取失败，按无书签/无 Producer 继续:', err);
      info = undefined;
      flatOutline = [];
    }

    return buildDocumentSignalsFromPdf({
      buffer,
      fullText,
      pageTexts,
      info,
      flatOutline,
      pageCount: pdfPageCount
    });
  } catch (err) {
    throw new PdfParseError(`PDF 解析失败: ${(err as Error).message}`, err as Error);
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch {
        /* 忽略销毁错误 */
      }
    }
  }
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
          // 复用当前已加载文档的 parser.doc 解析书签页码（避免 pdfjs-dist 二次
          // getDocument 污染 pdf-parse 后续渲染性能，见 resolveOutlinePageNumbers 注释）
          await resolveOutlinePageNumbers(pdfParser, flatOutline, pdfPageCount);
        }
      }
    } catch (err) {
      // B3修复：元数据/outline 提取失败不再静默——加密 PDF/损坏文件退回兜底分章时
      // 用户无法区分"书签解析失败"与"书本来没书签"，留 warn 便于归因
      console.warn('[pdf-parser] getInfo/outline 提取失败，退回兜底分章:', err);
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

  // v40：统一分类内核（P1+P2）——替换原 9 维加权评分。
  // 用与格式无关的 DocumentSignals + 多级决策树（document-classifier.ts），
  // 与 EPUB/MOBI 共用同一判据；同时输出"分章方式"实现分类与分章解耦。
  // 原加权评分的问题：权重靠调参、维度间互相抵消（如漫画的逐页书签被当"有目录"扣分）、
  // 大文件图计数失真（20MB 扫描上限）。决策树按"文本层 → 图片型 → 漫画/扫描版"
  // 逐级判定，每步都有实测数据支撑，且输出可读理由便于排查。
  //
  // 任务40：信号采集统一提取为 buildDocumentSignalsFromPdf（与批量重检共用，
  // 保证导入判定与全库重判定 100% 同源）。各维度历史修复说明
  // （v28-v40 + 任务39 多维特征）见该函数注释。
  const signals: DocumentSignals = buildDocumentSignalsFromPdf({
    buffer,
    fullText,
    pageTexts,
    info,
    flatOutline,
    pageCount: pdfPageCount
  });
  const classifyResult = classifyDocument(signals);
  const contentType = classifyResult.contentType;
  console.log(
    `[pdf] 分类: ${classifyResult.shape} → ${contentType} (分章:${classifyResult.chapterMode}) | ${classifyResult.reason}`
  );
  const isComicFinal = contentType === 'comic';

  let chapters: ChapterIndex[];
  let chapterTexts: string[];

  if (isComicFinal) {
    // 漫画模式：每页作为一个"章节"，url 存页码（1-based），content_type='image'
    // P2-4修复：若该书有 outline 且第 i 页有页码匹配的书签节点，title 用原书签
    // 标题而非硬编码"第X页"——真漫画逐页书签的标题即页码式命名（"670"/"第670页"），
    // 保留原命名尊重原始目录；无书签或该页无匹配节点才用"第X页"兜底。
    // 同页多节点取 depth 最小的（深度优先序中平级取首个）；pageNumber 为 0-based。
    const pageTitleByPage = new Map<number, { title: string; depth: number }>();
    for (const node of flatOutline) {
      if (node.pageNumber == null) continue;
      const existing = pageTitleByPage.get(node.pageNumber);
      if (existing === undefined || node.depth < existing.depth) {
        pageTitleByPage.set(node.pageNumber, { title: node.title, depth: node.depth });
      }
    }
    // E-2修复：多层书签（目录式漫画：卷 → 页码式书签）时按"最近的 depth=0 卷"
    // 归属卷（复用 outline 分章的 currentVolume 语义）——原实现 chapters.push
    // 不含 volume 字段，漫画书几百章全平级，ChapterBar 卷折叠 UI 无效，
    // 卷归属仅残留于卷首页标题。
    // 单层书签（全 depth=0）不填 volume（保持平级，与 outline 分章语义一致）；
    // 卷首页自身归属该卷（漫画卷的封面页即卷内容的起点）
    const hasDepthOutline = flatOutline.some((node) => node.depth > 0);
    /** depth=0 卷书签所在页（0-based）→ 卷标题（同页多卷书签取深度优先序首个） */
    const volumeStartByPage = new Map<number, string>();
    if (hasDepthOutline) {
      for (const node of flatOutline) {
        if (node.pageNumber == null || node.depth !== 0) continue;
        if (!volumeStartByPage.has(node.pageNumber)) {
          volumeStartByPage.set(node.pageNumber, node.title);
        }
      }
    }
    let currentVolume: string | undefined;
    chapters = [];
    chapterTexts = [];
    for (let i = 0; i < pdfPageCount; i++) {
      if (hasDepthOutline) {
        // 遇到卷起点页时更新当前卷（此后各页均归属该卷）
        const volStart = volumeStartByPage.get(i);
        if (volStart !== undefined) {
          currentVolume = volStart;
        }
      }
      chapters.push({
        index: i,
        // 有书签的页沿用原书签标题，无书签页用"第X页"
        title: pageTitleByPage.get(i)?.title ?? `第${i + 1}页`,
        fileOffset: 0,
        fileLength: 0,
        // E-2：归属的顶层卷标题（ChapterBar 卷折叠 UI 消费，入库链路 importer
        // 透传 ch.volume ?? null）
        volume: hasDepthOutline ? currentVolume : undefined,
        // url 固定为单页格式 "i+1"（readPdfChapterImages 按此解析），勿改成区间格式
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
      // 任务13：前置 detectParseMode 质量守卫（对齐 txt 标杆）——novel 模式才
      // 分章，plain 模式整书单章，防正文行被裸正则误判为章节标题（八宝门功法教训）
      result = splitChaptersByTextMode(fullText);

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

    // D-1修复：超长章节分段切分（数据完整性）——单章页数 > PDF_CHAPTER_MAX_PAGES
    // 时展开为多段章（主章前 50 页 + 续段，标题"（2/N）"后缀），消除运行时
    // 截断导致的"51+ 页内容永久不可读"。在 deduplicate 之前处理（续章标题带
    // 后缀不会被同名合并误并）；段文本按页精确切（outline 路径）/按占比切（正则路径）
    const segmented = splitOversizedPdfChapters(result.chapters, result.chapterTexts, pageTexts);
    result = segmented;

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
    // 任务40提取：pageTextLengths 原为 signals 采集的中间变量，提取后此处直接重算
    // （纯数组 map，无 IO；语义与提取前一致：每页文本长度，0-based 索引）
    pageTextLengths: pageTexts.map((p) => (p || '').length),
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
    classifySignals: signals,
    contentFeatures: { totalTextLength: fullText.length, pageCount: pdfPageCount, imageCount: signals.imageCount }
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
  imageDir?: string | null,
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
 * 构建带尺寸的 [IMG:] 占位标记（P2修复：图文插图 aspect-ratio 占位）
 *
 * 标记格式："[IMG:file:///...|宽x高]"（如 [IMG:file:///tmp/a.webp|800x600]）。
 * 尺寸从落盘文件头解析（readImageSize 零依赖只读头部，PNG/JPEG/WebP），
 * 供前端 buildImgHtml 输出 <img width/height> 属性——Chromium 据此在图片
 * 加载前预留精确宽高比盒子（CLS 标准做法），消除加载完成后撑开导致的滚动跳动。
 *
 * 兼容性：
 * - 尺寸解析失败（罕见格式/sharp 回退原始数据的非标准图片）→ 输出旧格式
 *   "[IMG:url]"，前端回退 min-height 近似占位，行为与修复前一致
 * - URL 经 pathToFileURL 生成，"|" 已被 percent-encode 为 %7C，裸 "|" 是
 *   尺寸分隔符的专属信号，与 URL 本体无歧义
 * - 主进程消费点（chapter-reader.ts / utils.ts 的 startsWith('[IMG:')）
 *   只判前缀不解析 src，新后缀零影响；DB 旧缓存无后缀同样兼容
 *
 * @param imgPath 落盘的图片文件绝对路径
 * @param fileUrl 图片的 file:// URL（pathToFileURL 产物）
 * @returns [IMG:url|WxH] 或 [IMG:url]（无尺寸回退）
 */
function buildImgMark(imgPath: string, fileUrl: string): string {
  const size = readImageSize(imgPath);
  return size ? `[IMG:${fileUrl}|${size.width}x${size.height}]` : `[IMG:${fileUrl}]`;
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

            // P1修复：嵌入图压缩上限 1200px/JPEG → 2000px/WebP（对齐漫画路径 v50 的 WebP 决策）。
            // 原参数把原图不可逆压到 1200px + 有损 JPEG，放大查看永远糊；
            // WebP q85 同体积质量更高，2000px 上限保留放大查看所需清晰度。
            // [IMG:file://...] 标记是 URL 透传，前端 buildImgHtml 只校验协议不校验扩展名。
            // sharp 失败回退原始数据时保持 .jpg 扩展名（原始嵌入图多为 JPEG/PNG）。
            let fileName = `chapter_${chapter.index}_page_${page.pageNumber}_img_${img.name}.jpg`;
            let destPath = join(imageDir, fileName);
            try {
              const sharp = await getSharp();
              const compressed = await sharp(img.data)
                .resize({ width: 2000, withoutEnlargement: true })
                .webp({ quality: 85 })
                .toBuffer();
              fileName = `chapter_${chapter.index}_page_${page.pageNumber}_img_${img.name}.webp`;
              destPath = join(imageDir, fileName);
              await fsPromises.writeFile(destPath, compressed);
            } catch {
              // sharp处理失败（可能不是标准图片格式），直接写入原始数据
              await fsPromises.writeFile(destPath, img.data);
            }
            // P0-1修复：改用 pathToFileURL 自动编码特殊字符（中文/空格等），避免手动拼接
            const fileUrl = pathToFileURL(destPath).toString();
            imageMarks.push(buildImgMark(destPath, fileUrl));
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
        // P1修复：scale 1.0→2.0，对齐漫画路径 readPdfChapterImages 的 144DPI 渲染。
        // scale 1.0 时 A4 页仅 595×842px（72DPI），前端拉伸后严重模糊；
        // scale 2 渲染 1190px 宽，后续 resize(width:1200) 因 1190<1200 为 no-op，无害。
        scale: 2.0
      });

      if (screenshotResult.pages.length > 0) {
        const sortedPages = screenshotResult.pages.sort((a, b) => a.pageNumber - b.pageNumber);
        for (const page of sortedPages) {
          const fileName = `chapter_${chapter.index}_page_${page.pageNumber}.jpg`;
          const destPath = join(imageDir, fileName);
          // 用sharp压缩截图：PNG→JPEG，最大宽度1200px，质量80%
          try {
            const sharp = await getSharp();
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
          screenshotMarks.push(buildImgMark(destPath, fileUrl));
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

/** v53：单章最多渲染页数（安全上限，从 1000 收紧）。现实扫描版一章 5-20 页，
 *  超 50 页的"章节"基本是切章失败兜底场景，截断并警告便于发现切章问题。 */
const PDF_CHAPTER_MAX_PAGES = 50;

/** v39：近空白页判定阈值 —— 2x 渲染整页 PNG 压缩后 < 8KB 视为空白（内容页实测 ≥100KB） */
const PNG_NEAR_BLANK_BYTES = 8 * 1024;

/**
 * 读取 PDF 章节图片（漫画模式，v53 分批渐进加载）
 *
 * PDF 的"章节"由 chapter.url 指定页区间（"start-end" 1-based 或单页 "N"）。
 * 使用 pdf-parse 的 getScreenshot() 将页面渲染为图片并落盘（v50 起 WebP）。
 *
 * v53 分批：扫描版 PDF 一章 5-20 页，整章预渲染（scale2 + WebP，每页数百 ms）
 * 导致点击章节后白屏等待数秒。新增 initialPages 参数：首批只渲染前 N 个
 * 缺失页，其余页返回 pending 占位条目（{path:'', width:0, height:0, pending:true}），
 * 前端数组长度仍等于总页数，滚动/翻页接近时通过 ensureChapterImages 幂等续载。
 * 磁盘已落盘的页（缓存命中，含 v50 旧缓存）不算 initialPages 配额，免费复用。
 *
 * @param filePath PDF 文件路径
 * @param chapter 章节索引（url 字段存页码或页区间）
 * @param imageDir 图片保存目录（绝对路径）
 * @param initialPages 首批渲染页数（可选；缺省 = 全量渲染，向后兼容旧调用方）
 * @param desiredWidth 目标渲染像素宽（可选，A3修复：前端上报容器宽×DPR，pdf-parse
 *        以其自动换算 scale 且优先于 scale 参数，根治 HiDPI 屏漫画页上采样模糊；
 *        缺省保持 scale 2 向后兼容。缓存取舍：磁盘缓存文件名不含 desiredWidth，
 *        已落盘页永远复用旧分辨率——desiredWidth 只影响新渲染页，不破坏 v53 复用）
 * @returns 完整 ChapterImage 列表（含 pending 占位条目）
 * @throws PdfParseError 渲染失败或 chapter.url 无效
 */
export async function readPdfChapterImages(
  filePath: string,
  chapter: ChapterIndex,
  imageDir: string,
  initialPages?: number,
  desiredWidth?: number
): Promise<ChapterImage[]> {
  return renderPdfChapterImages(filePath, chapter, imageDir, null, initialPages, desiredWidth);
}

/**
 * 续载 PDF 章节图片（幂等，v53 分批渐进加载）
 *
 * 渲染请求槽位中仍缺失（pending/无缓存）的页，返回更新后的完整 ChapterImage
 * 列表（组装规则与 readPdfChapterImages 一致）。已渲染页直接复用磁盘缓存，
 * 不重渲染 —— 多次调用同一槽位无副作用。
 *
 * 槽位语义：pages 为 1-based 列表下标（与前端 comicImages 数组下标一致），
 * 而非 PDF 绝对页码 —— 近空白页过滤（page_N.blank）不占槽位，前端无从得知
 * 空白分布，页码与槽位天然错位；主进程按自身组装的列表把槽位映射回页码。
 *
 * @param filePath PDF 文件路径
 * @param chapter 章节索引（url 字段存页码或页区间）
 * @param imageDir 图片保存目录（绝对路径）
 * @param pages 请求续载的槽位列表（1-based，前端 comicImages 下标 + 1）
 * @param desiredWidth 目标渲染像素宽（可选，A3修复：与首批渲染同源传入，保证同章内
 *        新渲染页分辨率口径一致；已落盘页不受影响）
 * @returns 更新后的完整 ChapterImage 列表
 * @throws PdfParseError 渲染失败或 chapter.url 无效
 */
export async function ensurePdfChapterImages(
  filePath: string,
  chapter: ChapterIndex,
  imageDir: string,
  pages: number[],
  desiredWidth?: number
): Promise<ChapterImage[]> {
  // 去重排序，保证渲染集稳定（幂等：缓存命中页自动跳过）
  const slots = Array.from(new Set(pages)).sort((a, b) => a - b);
  return renderPdfChapterImages(filePath, chapter, imageDir, slots, undefined, desiredWidth);
}

/**
 * 计算首批渲染页集（纯函数，供探针/单测）
 *
 * initialPages 只限制需要新渲染的页数：已缓存页不算配额（缓存命中免费）。
 * 未提供 initialPages（或 ≤0，或缺失页数本就不多）时全量渲染。
 */
export function computeInitialRenderPages(missingPages: number[], initialPages?: number): number[] {
  if (initialPages === undefined || initialPages <= 0 || missingPages.length <= initialPages) {
    return [...missingPages];
  }
  return missingPages.slice(0, initialPages);
}

/**
 * 计算续载渲染页集（纯函数，供探针/单测）
 *
 * 槽位（1-based）→ 组装列表槽对应的页码，跳过已渲染页（幂等）与重复项。
 * 越界槽位忽略（前端旧列表长度变化时的陈旧槽位请求）。
 */
export function computeEnsureRenderPages(slotPages: number[], slots: number[], renderedPages: Set<number>): number[] {
  const result: number[] = [];
  for (const slot of slots) {
    const idx = slot - 1;
    if (idx < 0 || idx >= slotPages.length) continue;
    const p = slotPages[idx];
    if (p === undefined || renderedPages.has(p) || result.includes(p)) continue;
    result.push(p);
  }
  return result;
}

/**
 * 组装完整 ChapterImage 列表（纯函数，供探针/单测）
 *
 * 每个非空白槽一个条目：已渲染 → 真实条目；未渲染 → pending 占位。
 */
export function assembleChapterImages(slotPages: number[], entries: Map<number, ChapterImage>): ChapterImage[] {
  return slotPages.map((p) => entries.get(p) ?? { path: '', width: 0, height: 0, pending: true });
}

/** 渲染后判定为近空白页的标记文件路径（空内容文件，前缀 page_N） */
function pdfBlankMarkPath(imageDir: string, pageNumber: number): string {
  return join(imageDir, `page_${pageNumber}.blank`);
}

/**
 * 判断 PDF 页的磁盘缓存状态。
 * - 'rendered'：WebP/PNG 已落盘（v50 起优先 WebP；sharp 失败回退 PNG）
 * - 'blank'：渲染时判定近空白页（page_N.blank 标记，无图片内容，不占槽位）
 * - 'missing'：未渲染
 *
 * 同一本书所有章共用 imageDir，文件名用 PDF 绝对页码（page_N）天然不冲突，
 * 因此跨章/跨会话缓存天然复用（v53：此前每次进入章节都全量重渲染，二读
 * 也要重付整章渲染成本 —— 这是"白屏数秒"的第二成因）。
 */
function getPdfPageCacheState(imageDir: string, pageNumber: number): 'rendered' | 'blank' | 'missing' {
  if (existsSync(pdfBlankMarkPath(imageDir, pageNumber))) return 'blank';
  if (existsSync(join(imageDir, `page_${pageNumber}.webp`))) return 'rendered';
  if (existsSync(join(imageDir, `page_${pageNumber}.png`))) return 'rendered';
  return 'missing';
}

/** 已落盘页 → ChapterImage 条目（文件头解析尺寸，失败为 0 由前端回退估计占位） */
function buildRenderedImageEntry(imageDir: string, pageNumber: number): ChapterImage {
  const webpPath = join(imageDir, `page_${pageNumber}.webp`);
  const imgPath = existsSync(webpPath) ? webpPath : join(imageDir, `page_${pageNumber}.png`);
  const size = readImageSize(imgPath);
  return { path: imgPath, width: size?.width ?? 0, height: size?.height ?? 0 };
}

/**
 * 列出章节图片的**纯磁盘缓存状态**（v56 缩略图面板用，同步、零渲染）。
 *
 * 与 renderPdfChapterImages 的骨架组装规则一致（已渲染页真实条目、空白页不
 * 占槽、缺失页 pending 占位），但**不渲染任何缺失页**——缩略图面板按
 * "已渲染页生成 thumb、未渲染页灰块占位"的语义工作（竞品范式），避免打开
 * 面板触发整章 scale2 渲染（CPU 密集）拖慢首屏。纯 existsSync 检查
 * （每章 ≤50 页 × 2-3 次），主进程毫秒级，无需进 worker。
 *
 * @param filePath PDF 文件路径（仅用于错误信息）
 * @param chapter 章节索引（url 存页码区间）
 * @param imageDir 图片缓存目录（images/comic/{bookId}）
 * @returns ChapterImage 列表（缺失页为 pending 占位条目）
 */
export function listPdfChapterImagesCached(filePath: string, chapter: ChapterIndex, imageDir: string): ChapterImage[] {
  const { startPage, endPage } = resolvePdfChapterPageRange(filePath, chapter);
  const slotPages: number[] = [];
  const entries = new Map<number, ChapterImage>();
  for (let p = startPage; p <= endPage; p++) {
    const state = getPdfPageCacheState(imageDir, p);
    if (state === 'blank') continue;
    slotPages.push(p);
    if (state === 'rendered') {
      entries.set(p, buildRenderedImageEntry(imageDir, p));
    }
  }
  return assembleChapterImages(slotPages, entries);
}

/**
 * 解析 chapter.url 页区间（"start-end" 或单页）+ MAX_PAGES 截断。
 * @throws PdfParseError url 为空或页码无效
 */
function resolvePdfChapterPageRange(filePath: string, chapter: ChapterIndex): { startPage: number; endPage: number } {
  if (!chapter.url) {
    throw new PdfParseError('章节缺少页码（chapter.url 为空）');
  }
  // 解析 url：支持 "startPage"（单页/漫画模式）与 "startPage-endPage"（页范围/图文扫描版）
  let startPage: number;
  let endPage: number;
  if (chapter.url.includes('-')) {
    const parts = chapter.url.split('-');
    startPage = parseInt(parts[0], 10);
    endPage = parseInt(parts[1], 10);
  } else {
    startPage = parseInt(chapter.url, 10);
    endPage = startPage;
  }
  if (isNaN(startPage) || startPage < 1) {
    throw new PdfParseError(`无效的页码: ${chapter.url}`);
  }
  if (isNaN(endPage) || endPage < startPage) endPage = startPage;
  // v53 安全上限收紧：1000 → 50。原值过宽无实际保护意义；现实扫描版一章
  // 5-20 页，超 50 页的"章节"基本是切章失败兜底场景，截断并警告便于发现。
  if (endPage - startPage + 1 > PDF_CHAPTER_MAX_PAGES) {
    console.warn(
      `[readPdfChapterImages] 页数超上限被截断: filePath=${filePath}, ` +
        `请求 ${startPage}-${endPage}（共 ${endPage - startPage + 1} 页），` +
        `截断为 ${startPage}-${startPage + PDF_CHAPTER_MAX_PAGES - 1}（最多 ${PDF_CHAPTER_MAX_PAGES} 页）`
    );
    endPage = startPage + PDF_CHAPTER_MAX_PAGES - 1;
  }
  return { startPage, endPage };
}

/**
 * PDF 章节图片渲染核心（readPdfChapterImages / ensurePdfChapterImages 共享）
 *
 * 组装规则（两入口共享，保证多次调用间列表结构兼容）：
 * 对页区间内每页（1-based PDF 绝对页码）：
 * - 已落盘（rendered）→ 真实条目 { path, width, height }
 * - 空白标记（blank）→ 不生成条目（与 v39 起近空白页过滤语义一致：不显示、不占槽位）
 * - 未渲染（missing）→ pending 占位条目
 *
 * 渲染集选取（两入口仅此处不同）：
 * - initialPages（readImages）：缺失页按页序取前 N 个（缓存命中免费）
 * - renderSlots（ensureImages）：请求槽位映射到的缺失页
 */
async function renderPdfChapterImages(
  filePath: string,
  chapter: ChapterIndex,
  imageDir: string,
  renderSlots: number[] | null,
  initialPages?: number,
  desiredWidth?: number
): Promise<ChapterImage[]> {
  const { startPage, endPage } = resolvePdfChapterPageRange(filePath, chapter);
  const allPages: number[] = [];
  for (let p = startPage; p <= endPage; p++) allPages.push(p);

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
    const tProfStart = Date.now();
    // ── 1. 渲染前骨架：缓存状态 + 槽位→页码映射（blank 页不占槽） ──
    const slotPages: number[] = [];
    const entries = new Map<number, ChapterImage>();
    const missingPages: number[] = [];
    for (const p of allPages) {
      const state = getPdfPageCacheState(imageDir, p);
      if (state === 'blank') continue;
      slotPages.push(p);
      if (state === 'rendered') {
        entries.set(p, buildRenderedImageEntry(imageDir, p));
      } else {
        missingPages.push(p);
      }
    }
    profLog(
      `ch${chapter.index} url=${chapter.url} pages=${allPages.length} 骨架组装 ${Date.now() - tProfStart}ms（已缓存 ${entries.size}，缺失 ${missingPages.length}）`
    );

    // ── 2. 计算渲染集 ──
    const pagesToRender: number[] =
      renderSlots !== null
        ? computeEnsureRenderPages(slotPages, renderSlots, new Set(entries.keys()))
        : computeInitialRenderPages(missingPages, initialPages);

    // ── 3. 渲染缺失页（v39 空白过滤 + v50 WebP 落盘，与整章渲染逻辑一致） ──
    if (pagesToRender.length > 0) {
      // A3修复：desiredWidth（前端上报的容器宽×DPR）优先——pdf-parse 内部以其
      // 换算 scale（desiredWidth / 页面原始宽）且优先于 scale 参数，HiDPI 屏按物理
      // 像素渲染根治上采样模糊；未传时保持 scale 2（144DPI）向后兼容。
      // clamp 到 [1200, 4096]：下限对齐 scale 2 的 A4 等效宽（~1190px），防极小窗口
      // 下位图密度低于现状；上限防 8K 级渲染浪费内存/磁盘（已覆盖 4K 屏 DPR2）。
      const clampedDesiredWidth =
        desiredWidth !== undefined && desiredWidth > 0
          ? Math.max(1200, Math.min(Math.round(desiredWidth), 4096))
          : undefined;
      profLog(
        `ch${chapter.index} 渲染集 ${pagesToRender.length} 页 [${pagesToRender.join(',')}]（计算 ${Date.now() - tProfStart}ms）`
      );
      const tShot = Date.now();
      const screenshotResult = await parser.getScreenshot({
        partial: pagesToRender,
        imageBuffer: true,
        imageDataUrl: false,
        scale: 2, // 兜底清晰度（desiredWidth 未传时生效，144DPI）
        desiredWidth: clampedDesiredWidth
      });
      const shotMs = Date.now() - tShot;
      profLog(`ch${chapter.index} getScreenshot ${pagesToRender.length} 页 ${shotMs}ms`);
      let sharpMs = 0;
      let blankCount = 0;
      for (const page of screenshotResult.pages) {
        // v39：跳过近空白页。扫描版 PDF 常有空白衬页/版权页（整页无内容），
        // 保留它们会在阅读器里显示为"空白页"。2x 渲染的整页 PNG 至少上百万像素，
        // 纯白页压缩后仅数 KB；有实际内容的页实测 ≥100KB，阈值 8KB 有 >10 倍安全余量。
        // 用压缩后体积做代理指标，无需解码像素，零额外开销。
        // v53：写 page_N.blank 标记 —— 后续缓存判断据此跳过（幂等：空白页不会
        // 反复重渲染，也不占列表槽位，与整章渲染的过滤语义一致）。
        if (!page.data || page.data.length === 0 || page.data.length < PNG_NEAR_BLANK_BYTES) {
          blankCount++;
          try {
            await fsPromises.writeFile(pdfBlankMarkPath(imageDir, page.pageNumber), '');
          } catch {
            // 标记写失败：最坏情况该页下次重渲染一次（幂等无害），不阻断
          }
          continue;
        }
        // v50：落盘格式 PNG → WebP（quality 85）。
        // 实测对比（同一渲染页）：PNG 无损 877KB vs WebP q85 100KB（11%）——
        // 扫描页是"照片性质"内容，无损 PNG 完全是错误选择；20 页/章缓存从 ~26MB
        // 降至 ~2MB，磁盘 IO 与前端解码同步降 ~9 倍。视觉质量 q85 无肉眼差异。
        // sharp 失败时回退原始 PNG，保证可用性。
        const tSharpOne = Date.now();
        let fileName = `page_${page.pageNumber}.png`;
        let destPath = join(imageDir, fileName);
        try {
          const sharp = await getSharp();
          // effort 2（默认 4）：webp 编码质量由 quality 决定，effort 仅控制压缩
          // 搜索力度——扫描页实测 effort4→2 编码耗时降约 40%、体积几乎不变
          // （25710B→25600B），视觉无差异。首屏批量落盘时收益可观。
          const compressed = await sharp(page.data).webp({ quality: 85, effort: 2 }).toBuffer();
          fileName = `page_${page.pageNumber}.webp`;
          destPath = join(imageDir, fileName);
          await fsPromises.writeFile(destPath, compressed);
        } catch (sharpErr) {
          console.warn('[pdf] WebP 压缩失败，回退 PNG:', (sharpErr as Error).message);
          await fsPromises.writeFile(destPath, page.data);
        }
        sharpMs += Date.now() - tSharpOne;
        entries.set(page.pageNumber, buildRenderedImageEntry(imageDir, page.pageNumber));
      }
      profLog(
        `ch${chapter.index} sharp压缩+落盘 ${screenshotResult.pages.length - blankCount} 页 ${sharpMs}ms（跳过空白 ${blankCount}）`
      );
      // getScreenshot 未返回的页（如页码越界）：保持 pending，前端续载时重试
      // —— 幂等性不受影响（未落盘即 missing）
    }

    // ── 4. 组装完整列表（长度 = 总页数 - 空白页数；pending 槽与真实槽按页序交错） ──
    // 注意：渲染过程中新发现的空白页已写 blank 标记，但 slotPages 是渲染前骨架
    // （含这些页的槽）——组装前需按最新缓存状态重新过滤，否则空白页会以 pending
    // 占位出现在列表里（下次 ensure 才消失，首次列表语义不一致）。
    // 步骤 2 的槽位映射仍用渲染前 slotPages（前端旧列表视角），不受此影响。
    const finalSlotPages = slotPages.filter((p) => getPdfPageCacheState(imageDir, p) !== 'blank');
    const result = assembleChapterImages(finalSlotPages, entries);
    profLog(
      `ch${chapter.index} 完成 共 ${Date.now() - tProfStart}ms（返回 ${result.length} 槽，pending ${result.filter((r) => r.pending).length}）`
    );
    return result;
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
    // v53 兼容适配：底层返回 ChapterImage[]（含 pending 占位），FileParser 接口仍约定
    // string[]（导入器取首图作封面用）。全量渲染 + 过滤 pending，语义与旧版一致。
    const images = await readPdfChapterImages(filePath, chapter, imageDir);
    return images.filter((img) => !img.pending).map((img) => img.path);
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
