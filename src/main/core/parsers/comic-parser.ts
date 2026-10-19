/**
 * 漫画解析器
 *
 * 从 file-parser.ts 拆分而来。
 */

import { promises as fsPromises } from 'fs';
import { basename, extname, join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { XMLParser } from 'fast-xml-parser';
import StreamZip from 'node-stream-zip';
import type { ChapterIndex, ParsedBook, FileParser, ComicFormat } from './types';

/* ==================== comic-parser.ts（漫画解析器） ==================== */
/**
 * 漫画解析器（CBZ/CBR/CB7/CBT/ZIP/RAR）
 *
 * 核心设计：漫画文件本质是压缩包内放图片，每张图片作为一个"章节"。
 *
 * 支持格式：
 * - CBZ/ZIP：用 node-stream-zip（已有依赖）解压，提取图片
 * - CBR/RAR：用 node-unrar-js 解压，提取图片
 * - CB7/7z：用 7zip-min（纯JS 7z解压库）解压，提取图片
 * - CBT/Tar：用 tar 库解压，提取图片
 *
 * 漫画检测逻辑：
 * - 压缩包内 >70% 的文件是图片（jpg/png/gif/webp/bmp）→ 判定为漫画
 * - 每张图片按文件名排序后作为一个"章节"
 * - chapter.url 存 ZIP entry name（供 readChapterImages 定位）
 * - isComic = true, contentType = 'image'
 *
 * 导出：
 * - parseComic(filePath, onProgress?): Promise<ParsedBook>
 * - readComicChapterImages(filePath, chapter, imageDir): Promise<string[]>
 * - ComicParser 类（实现 FileParser 接口）
 * - detectComicFormat(filePath): Promise<ComicFormat | null>
 */

/* ==================== 错误定义 ==================== */

export class ComicParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ComicParseError';
  }
}

/**
 * 校验压缩包 entry name 安全性，防止 zip slip / 路径遍历攻击
 *
 * 漫画解压（CBR/CB7/CBT）先把文件解压到 tempDir 再读取，若 entry name 含 `..`
 * 或为绝对路径，解压库会把文件写到 tempDir 之外。本函数在**解压前**校验，
 * 拒绝危险 entry，从源头消除路径遍历。
 *
 * 拒绝以下危险 entry：
 * - 空字符串或含 null byte
 * - 绝对路径（Unix 以 / 开头，Windows 以盘符 `C:\` 开头）
 * - 含 `..` 路径段（可逃逸出目标目录）
 *
 * 来源：2026-10-19-archive-extraction-zip-slip-timing-defect（校验必须在解压前）
 *
 * @param entryName 压缩包内的条目名
 * @throws ComicParseError 如果 entry name 不安全
 */
function assertSafeEntryName(entryName: string): void {
  if (!entryName || entryName.includes('\0')) {
    throw new ComicParseError(`非法 entry name（空或含 null byte）: "${entryName}"`);
  }
  // Windows 盘符绝对路径（如 C:\foo 或 C:/foo）
  if (/^[a-zA-Z]:[\\/]/.test(entryName)) {
    throw new ComicParseError(`非法 entry name（Windows 绝对路径）: "${entryName}"`);
  }
  // Unix 绝对路径或以分隔符开头
  if (entryName.startsWith('/') || entryName.startsWith('\\')) {
    throw new ComicParseError(`非法 entry name（绝对路径）: "${entryName}"`);
  }
  // 检查每个路径段，拒绝 `..`（zip slip 核心防护）
  const segments = entryName.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === '..') {
      throw new ComicParseError(`非法 entry name（含 .. 路径段，zip slip）: "${entryName}"`);
    }
  }
}

/* ==================== 格式定义 ==================== */

/** 支持的图片扩展名 */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

/** 漫画格式 → 扩展名映射 */
const COMIC_EXT_TO_FORMAT: Record<string, ComicFormat> = {
  '.cbz': 'cbz',
  '.cbr': 'cbr',
  '.cb7': 'cb7',
  '.cbt': 'cbt',
  '.zip': 'zip',
  '.rar': 'rar'
};

/* ==================== 格式检测 ==================== */

/**
 * 通过扩展名检测漫画格式
 *
 * @param filePath 文件路径
 * @returns 漫画格式类型，不支持返回 null
 */
export function detectComicFormatByExt(filePath: string): ComicFormat | null {
  const ext = extname(filePath).toLowerCase();
  return COMIC_EXT_TO_FORMAT[ext] ?? null;
}

/**
 * 通过文件头（magic number）检测文件实际格式
 *
 * Magic numbers：
 * - ZIP/CBZ: PK\x03\x04 (0x504B0304)
 * - RAR/CBR: Rar!\x1a\x07 (0x526172211A07)
 * - 7z/CB7: 7z\xbc\xaf\x27\x1c (0x377ABC AF271C)
 * - PDF: %PDF (0x25504446)
 *
 * @param filePath 文件路径
 * @returns 检测到的格式，无法识别返回 null
 */
export async function detectComicFormatByMagicNumber(filePath: string): Promise<string | null> {
  let fd: fsPromises.FileHandle | null = null;
  try {
    fd = await fsPromises.open(filePath, 'r');
    const buf = Buffer.alloc(16);
    await fd.read(buf, 0, 16, 0);

    // ZIP/CBZ: PK
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      return 'zip';
    }
    // RAR/CBR: Rar!
    if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) {
      return 'rar';
    }
    // 7z/CB7: 7z\xbc\xaf\x27\x1c
    if (
      buf[0] === 0x37 &&
      buf[1] === 0x7a &&
      buf[2] === 0xbc &&
      buf[3] === 0xaf &&
      buf[4] === 0x27 &&
      buf[5] === 0x1c
    ) {
      return '7z';
    }
    // PDF: %PDF
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
      return 'pdf';
    }
    // Tar: 在偏移257处有 "ustar"
    if (buf.length >= 8) {
      const tarBuf = Buffer.alloc(8);
      await fd.read(tarBuf, 0, 8, 257);
      if (tarBuf.toString('ascii', 0, 5) === 'ustar') {
        return 'tar';
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    if (fd) await fd.close();
  }
}

/**
 * 从图片文件名中提取排序序号
 *
 * 漫画图片通常按文件名中的数字排序：
 * - 001.jpg, 002.jpg → 1, 2
 * - page_01.png, page_02.png → 1, 2
 * - 1.jpg, 2.jpg → 1, 2
 * - cover.jpg → 0（封面排在最前）
 *
 * @param fileName 文件名
 * @returns 排序序号（用于自然排序）
 */
function extractImageSortKey(fileName: string): number {
  const nameWithoutExt = fileName.replace(/\.[^.]+$/, '');
  // 尝试提取文件名中的数字
  const match = nameWithoutExt.match(/(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  // 无数字的文件（如 cover.jpg）排在最前
  return 0;
}

/* ==================== CBZ/ZIP 解析 ==================== */

/** ZIP 句柄封装（复用 epub-parser 的模式） */
interface ComicZip {
  entryString(name: string): Promise<string>;
  entryBuffer(name: string): Promise<Buffer>;
  extract(name: string, dest: string): Promise<number | undefined>;
  entries(): Record<string, { name: string; size: number; compressedSize: number }>;
  close(): void;
}

/** 打开 ZIP 文件 */
async function openComicZip(filePath: string): Promise<ComicZip> {
  return new Promise<ComicZip>((resolve, reject) => {
    const zip = new StreamZip.async({ file: filePath });
    zip
      .entries()
      .then((entries: Record<string, { name: string; size: number; compressedSize: number }>) => {
        resolve({
          entryString: (name: string) => zip.entryData(name).then((b: Buffer) => b.toString('utf-8')),
          entryBuffer: (name: string) => zip.entryData(name),
          extract: (name: string, dest: string) => zip.extract(name, dest),
          entries: () => entries,
          close: () => {
            zip.close().catch((e) => console.warn('[cleanup] 操作失败:', e));
          }
        });
      })
      .catch((err: Error) => reject(new ComicParseError(`打开 ZIP 失败: ${err.message}`, err)));
  });
}

/* ==================== 漫画 ZIP 句柄 LRU 缓存 ==================== */

/**
 * 漫画 ZIP 句柄 LRU 缓存
 *
 * 问题：readCbzChapterImages 每次都 openComicZip + close，翻页时反复打开/关闭同一个 CBZ，开销大。
 *
 * 方案：用 LRU Map 缓存 {filePath → ComicZip} 句柄，限制 COMIC_ZIP_CACHE_MAX 本常驻。
 *       - JS Map 按插入顺序遍历，最旧在首位
 *       - get 命中时 delete+set 刷新为最近使用
 *       - 超限时 delete 最旧的并 close()
 *       - readCbzChapterImages 不再每次 close，由 LRU 淘汰时 close
 *       - parseCbz 解析完立即 closeComicZip 移出缓存（只需列文件列表，无需常驻）
 */

/** ZIP 句柄缓存最大数量（限制同时常驻的漫画 ZIP 句柄数，1 本足够覆盖单 worker 场景） */
const COMIC_ZIP_CACHE_MAX = 3;

/** LRU 缓存：filePath → ComicZip（JS Map 按插入顺序遍历，最旧在首位） */
export const comicZipCache = new Map<string, ComicZip>();

/**
 * 获取漫画 ZIP 句柄（带 LRU 缓存）
 *
 * 翻页时复用已打开的 ZIP 句柄，避免反复 open/close。
 * 调用方不要 close 返回的句柄，由 LRU 淘汰、closeComicZip 或 closeAllComicCaches 统一 close。
 *
 * @param filePath 漫画 ZIP 文件路径
 * @returns ComicZip 句柄
 */
async function getComicZip(filePath: string): Promise<ComicZip> {
  const cached = comicZipCache.get(filePath);
  if (cached) {
    // 命中：刷新为最近使用（delete+set 改变 Map 插入顺序）
    comicZipCache.delete(filePath);
    comicZipCache.set(filePath, cached);
    return cached;
  }

  // 未命中：打开并存入缓存
  const zip = await openComicZip(filePath);
  comicZipCache.set(filePath, zip);

  // 超限淘汰最旧句柄（Map 首项 = 最久未使用）
  if (comicZipCache.size > COMIC_ZIP_CACHE_MAX) {
    const oldestKey = comicZipCache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = comicZipCache.get(oldestKey);
      comicZipCache.delete(oldestKey);
      try {
        oldest?.close();
      } catch {
        // close 失败忽略，句柄已移出缓存
      }
    }
  }

  return zip;
}

/**
 * 关闭并移除指定漫画 ZIP 句柄
 *
 * parseCbz 解析完只需列文件列表，无需常驻缓存，调用此函数立即释放。
 *
 * @param filePath 漫画 ZIP 文件路径
 */
function closeComicZip(filePath: string): void {
  const zip = comicZipCache.get(filePath);
  if (zip) {
    comicZipCache.delete(filePath);
    try {
      zip.close();
    } catch {
      // close 失败忽略
    }
  }
}

/**
 * 关闭所有缓存的漫画 ZIP 句柄
 *
 * 应用退出时调用，释放所有常驻 ZIP 文件句柄。
 */
export function closeAllComicCaches(): void {
  for (const zip of comicZipCache.values()) {
    try {
      zip.close();
    } catch {
      // close 失败忽略
    }
  }
  comicZipCache.clear();
}

/* ==================== ComicInfo.xml 元数据解析 ==================== */

/**
 * ComicInfo.xml 解析器配置
 *
 * ComicInfo.xml 是 AnansiProject 制定的漫画元数据 XML 标准。
 * 结构示例：
 * <ComicInfo>
 *   <Title>Issue Title</Title>
 *   <Series>Series Name</Series>
 *   <Number>1</Number>
 *   <Volume>1</Volume>
 *   <Summary>Summary text</Summary>
 *   <Writer>Writer Name</Writer>
 *   <Penciller>Penciller Name</Penciller>
 *   <Comments>Comments</Comments>
 * </ComicInfo>
 */
const comicInfoXmlParser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  parseTagValue: true
});

/** ComicInfo.xml 提取的元数据 */
interface ComicInfoMetadata {
  title?: string;
  author?: string;
  series?: string;
  number?: string;
  summary?: string;
}

/**
 * 从 ComicInfo.xml 内容解析元数据
 *
 * 提取规则：
 * - Title → 标题
 * - Penciller 优先，否则 Writer → 作者
 * - Series → 系列
 * - Number → 卷号
 * - Summary 优先，否则 Comments → 简介
 *
 * @param xmlContent ComicInfo.xml 文本内容
 * @returns 元数据对象（字段可能为 undefined）
 */
function parseComicInfoXml(xmlContent: string): ComicInfoMetadata {
  try {
    const parsed = comicInfoXmlParser.parse(xmlContent) as Record<string, unknown>;
    const info = parsed['ComicInfo'];
    if (!info || typeof info !== 'object') {
      return {};
    }
    const root = info as Record<string, unknown>;

    // 提取字符串字段（fast-xml-parser parseTagValue: true 时文本直接为字符串）
    const title = typeof root['Title'] === 'string' ? (root['Title'] as string).trim() : undefined;
    const series = typeof root['Series'] === 'string' ? (root['Series'] as string).trim() : undefined;
    const number = typeof root['Number'] === 'string' ? (root['Number'] as string).trim() : undefined;
    const summary = typeof root['Summary'] === 'string' ? (root['Summary'] as string).trim() : undefined;
    const comments = typeof root['Comments'] === 'string' ? (root['Comments'] as string).trim() : undefined;
    const penciller = typeof root['Penciller'] === 'string' ? (root['Penciller'] as string).trim() : undefined;
    const writer = typeof root['Writer'] === 'string' ? (root['Writer'] as string).trim() : undefined;

    // 作者：Penciller 优先，否则 Writer
    const author = penciller || writer;

    // 简介：Summary 优先，否则 Comments
    const finalSummary = summary || comments;

    return {
      title: title || undefined,
      author: author || undefined,
      series: series || undefined,
      number: number || undefined,
      summary: finalSummary || undefined
    };
  } catch {
    // XML 解析失败返回空元数据，不影响漫画解析
    return {};
  }
}

/**
 * 根据元数据和文件名生成书名
 *
 * 优先级：
 * 1. Series + Number → "Series Vol.Number"（系列管理更友好）
 * 2. Title → Title
 * 3. 文件名（去扩展名）
 *
 * @param meta ComicInfo 元数据
 * @param filePath 文件路径（兜底用文件名）
 * @returns 书名
 */
function resolveComicTitle(meta: ComicInfoMetadata, filePath: string): string {
  if (meta.series && meta.number) {
    return `${meta.series} Vol.${meta.number}`.trim();
  }
  if (meta.title) {
    return meta.title;
  }
  const fileName = basename(filePath);
  return fileName.replace(/\.[^.]+$/, '').trim();
}

/**
 * 解析 CBZ/ZIP 漫画文件
 *
 * 流程：
 * 1. 打开 ZIP
 * 2. 列出所有 entry，筛选图片文件
 * 3. 按文件名自然排序
 * 4. 每张图片作为一个"章节"
 * 5. isComic = true
 *
 * @param filePath CBZ/ZIP 文件路径
 * @param onProgress 解析进度回调
 * @returns 解析结果（元数据 + 章节索引）
 */
async function parseCbz(filePath: string, onProgress?: (p: number) => void): Promise<ParsedBook> {
  try {
    if (onProgress) onProgress(0.1);

    const zip = await getComicZip(filePath);
    const entries = zip.entries();

    if (onProgress) onProgress(0.3);

    // 筛选图片文件并排序
    const imageEntries = Object.keys(entries)
      .filter((name) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
      .sort((a, b) => {
        const keyA = extractImageSortKey(a);
        const keyB = extractImageSortKey(b);
        if (keyA !== keyB) return keyA - keyB;
        return a.localeCompare(b);
      });

    if (imageEntries.length === 0) {
      throw new ComicParseError('ZIP 中未找到任何图片文件');
    }

    if (onProgress) onProgress(0.6);

    // 解析 ComicInfo.xml 元数据（CBZ 常包含此文件）
    let meta: ComicInfoMetadata = {};
    const comicInfoEntry = Object.keys(entries).find((name) => basename(name).toLowerCase() === 'comicinfo.xml');
    if (comicInfoEntry) {
      try {
        const xmlContent = await zip.entryString(comicInfoEntry);
        meta = parseComicInfoXml(xmlContent);
      } catch {
        // 读取 ComicInfo.xml 失败忽略，用文件名兜底
      }
    }

    if (onProgress) onProgress(0.8);

    // 每张图片作为一个章节
    const chapters: ChapterIndex[] = [];
    for (let i = 0; i < imageEntries.length; i++) {
      const entryName = imageEntries[i];
      const entryInfo = entries[entryName];
      chapters.push({
        index: i,
        title: `第${i + 1}页`,
        fileOffset: 0,
        fileLength: entryInfo ? entryInfo.size : 0,
        url: entryName,
        contentType: 'image'
      });
    }

    if (onProgress) onProgress(0.9);

    // 书名：优先用 ComicInfo.xml 元数据，兜底用文件名
    const title = resolveComicTitle(meta, filePath);
    const author = meta.author || '未知';
    const description = meta.summary || '';

    return {
      encoding: 'UTF-8',
      title,
      author,
      description,
      chapters,
      isComic: true,
      contentType: 'comic' as const
    };
  } catch (err) {
    if (err instanceof ComicParseError) throw err;
    throw new ComicParseError(`解析 CBZ/ZIP 失败: ${(err as Error).message}`, err as Error);
  } finally {
    // parseCbz 只需列文件列表，无需常驻缓存，立即释放
    closeComicZip(filePath);
  }
}

/**
 * 读取 CBZ/ZIP 漫画章节图片
 *
 * @param filePath CBZ/ZIP 文件路径
 * @param chapter 章节索引（url 字段存 ZIP entry name）
 * @param imageDir 图片保存目录
 * @returns 图片文件路径列表
 */
async function readCbzChapterImages(filePath: string, chapter: ChapterIndex, imageDir: string): Promise<string[]> {
  if (!chapter.url) {
    throw new ComicParseError('漫画章节缺少 url 字段（ZIP entry name）');
  }

  let zip: ComicZip | null = null;
  try {
    // 使用 LRU 缓存句柄，翻页时复用，不再每次 open/close
    zip = await getComicZip(filePath);
    await fsPromises.mkdir(imageDir, { recursive: true });

    // 读取图片 Buffer
    const buf = await zip.entryBuffer(chapter.url);
    const originalName = basename(chapter.url);
    const fileName = `${chapter.index}_${originalName}`;
    const destPath = join(imageDir, fileName);
    await fsPromises.writeFile(destPath, buf);

    return [destPath];
  } catch (err) {
    // 异常路径：从缓存移除并关闭可能损坏的 ZIP 句柄
    if (zip) {
      comicZipCache.delete(filePath);
      try {
        zip.close();
      } catch {
        /* close 失败忽略 */
      }
    }
    if (err instanceof ComicParseError) throw err;
    throw new ComicParseError(`读取 CBZ 图片失败: ${(err as Error).message}`, err as Error);
  }
}

/* ==================== CBR/RAR 解析 ==================== */

/**
 * 解析 CBR/RAR 漫画文件
 *
 * 使用 node-unrar-js 解压 RAR 文件。
 * node-unrar-js 是纯 JS 实现，不需要外部命令行工具。
 *
 * 内存优化：用 createExtractorFromFile 代替 createExtractorFromData，
 * 通过文件句柄按需读取 RAR 内容，不全量加载到内存（大 CBR 不再 OOM）。
 *
 * @param filePath CBR/RAR 文件路径
 * @param onProgress 解析进度回调
 * @returns 解析结果（元数据 + 章节索引）
 */
async function parseCbr(filePath: string, onProgress?: (p: number) => void): Promise<ParsedBook> {
  try {
    if (onProgress) onProgress(0.1);

    // 动态导入 node-unrar-js（CJS 模块，同时提供 createExtractorFromFile 和 createExtractorFromData）
    const { createExtractorFromFile } = await import('node-unrar-js');

    // 按需读取：createExtractorFromFile 通过 fs.openSync + fs.readSync 按需读取，
    // 不需要全量加载 RAR 到内存（createExtractorFromData 需要完整 ArrayBuffer）
    const extractor = await createExtractorFromFile({ filepath: filePath });

    if (onProgress) onProgress(0.3);

    // 列出所有文件（fileHeaders 是 Generator，需要 Array.from 转换）
    const fileList = extractor.getFileList();
    const allFiles: string[] = Array.from(fileList.fileHeaders).map((f: { name: string }) => f.name);

    if (onProgress) onProgress(0.5);

    // 筛选图片文件并排序
    const imageFiles = allFiles
      .filter((name: string) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
      .sort((a: string, b: string) => {
        const keyA = extractImageSortKey(a);
        const keyB = extractImageSortKey(b);
        if (keyA !== keyB) return keyA - keyB;
        return a.localeCompare(b);
      });

    if (imageFiles.length === 0) {
      throw new ComicParseError('RAR 中未找到任何图片文件');
    }

    if (onProgress) onProgress(0.8);

    // 每张图片作为一个章节
    const chapters: ChapterIndex[] = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const entryName = imageFiles[i];
      chapters.push({
        index: i,
        title: `第${i + 1}页`,
        fileOffset: 0,
        fileLength: 0,
        url: entryName,
        contentType: 'image'
      });
    }

    if (onProgress) onProgress(1);

    const fileName = basename(filePath);
    const title = fileName.replace(/\.[^.]+$/, '').trim();

    return {
      encoding: 'UTF-8',
      title,
      author: '未知',
      description: '',
      chapters,
      isComic: true,
      contentType: 'comic' as const
    };
  } catch (err) {
    if (err instanceof ComicParseError) throw err;
    throw new ComicParseError(`解析 CBR/RAR 失败: ${(err as Error).message}`, err as Error);
  }
}

/**
 * 读取 CBR/RAR 漫画章节图片
 *
 * 内存优化：用 createExtractorFromFile 代替 createExtractorFromData，
 * 通过文件句柄按需读取 RAR 内容，不全量加载到内存。
 * 解压指定文件到临时目录，再复制到 imageDir（与 CB7/CBT 模式一致）。
 *
 * @param filePath CBR/RAR 文件路径
 * @param chapter 章节索引（url 字段存 RAR entry name）
 * @param imageDir 图片保存目录
 * @returns 图片文件路径列表
 */
async function readCbrChapterImages(filePath: string, chapter: ChapterIndex, imageDir: string): Promise<string[]> {
  if (!chapter.url) {
    throw new ComicParseError('漫画章节缺少 url 字段（RAR entry name）');
  }

  // zip slip 防护：解压前校验 entry name，拒绝含 `..`/绝对路径的恶意条目
  // 来源：2026-10-19-archive-extraction-zip-slip-timing-defect（校验必须在解压前）
  assertSafeEntryName(chapter.url);

  let tempDir: string | null = null;
  try {
    await fsPromises.mkdir(imageDir, { recursive: true });

    // 动态导入 node-unrar-js
    const { createExtractorFromFile } = await import('node-unrar-js');

    // 创建临时目录用于解压指定文件
    tempDir = await fsPromises.mkdtemp(join(tmpdir(), 'comic-cbr-'));

    // 按需读取：createExtractorFromFile 通过文件句柄按需读取，不全量加载 RAR 到内存
    // targetPath 指定解压输出目录，extract 会将文件写入此目录
    const extractor = await createExtractorFromFile({
      filepath: filePath,
      targetPath: tempDir
    });

    // 解压指定文件到临时目录
    extractor.extract({ files: [chapter.url] });

    // 从临时目录读取解压出的图片（保持 archive 内路径结构）
    const tempImagePath = join(tempDir, chapter.url);
    // 路径遍历防护（深度防御）：确保解压后的路径仍在 tempDir 内
    const resolvedTemp = resolve(tempImagePath);
    const resolvedDir = resolve(tempDir);
    if (!resolvedTemp.startsWith(resolvedDir + sep) && resolvedTemp !== resolvedDir) {
      throw new ComicParseError(`路径遍历攻击检测：entry "${chapter.url}" 逃逸出临时目录`);
    }
    const buf = await fsPromises.readFile(resolvedTemp);

    // 写入目标时只取 basename，进一步消除路径遍历风险
    const originalName = basename(chapter.url);
    const fileName = `${chapter.index}_${originalName}`;
    const destPath = join(imageDir, fileName);
    await fsPromises.writeFile(destPath, buf);

    return [destPath];
  } catch (err) {
    if (err instanceof ComicParseError) throw err;
    throw new ComicParseError(`读取 CBR 图片失败: ${(err as Error).message}`, err as Error);
  } finally {
    // 清理临时目录
    if (tempDir) {
      try {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // 清理失败忽略
      }
    }
  }
}

/* ==================== CB7/7z 解析 ==================== */

/**
 * 解析 CB7/7z 漫画文件
 *
 * 使用 7zip-min（纯JS 7z解压库）列出 7z 文件内容。
 * 7zip-min 内部打包了 7za 二进制，无需外部依赖。
 *
 * @param filePath CB7/7z 文件路径
 * @param onProgress 解析进度回调
 * @returns 解析结果（元数据 + 章节索引）
 */
async function parseCb7(filePath: string, onProgress?: (p: number) => void): Promise<ParsedBook> {
  try {
    if (onProgress) onProgress(0.1);

    // 动态导入 7zip-min（ESM 兼容）
    const sevenZip = await import('7zip-min');

    if (onProgress) onProgress(0.3);

    // 列出 7z 文件内容
    const items = await sevenZip.list(filePath);
    const allFiles = items.map((item: { name: string }) => item.name);

    if (onProgress) onProgress(0.5);

    // 筛选图片文件并排序
    const imageFiles = allFiles
      .filter((name: string) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
      .sort((a: string, b: string) => {
        const keyA = extractImageSortKey(a);
        const keyB = extractImageSortKey(b);
        if (keyA !== keyB) return keyA - keyB;
        return a.localeCompare(b);
      });

    if (imageFiles.length === 0) {
      throw new ComicParseError('7z 中未找到任何图片文件');
    }

    if (onProgress) onProgress(0.9);

    // 每张图片作为一个章节
    const chapters: ChapterIndex[] = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const entryName = imageFiles[i];
      chapters.push({
        index: i,
        title: `第${i + 1}页`,
        fileOffset: 0,
        fileLength: 0,
        url: entryName,
        contentType: 'image'
      });
    }

    if (onProgress) onProgress(1);

    const fileName = basename(filePath);
    const title = fileName.replace(/\.[^.]+$/, '').trim();

    return {
      encoding: 'UTF-8',
      title,
      author: '未知',
      description: '',
      chapters,
      isComic: true,
      contentType: 'comic' as const
    };
  } catch (err) {
    if (err instanceof ComicParseError) throw err;
    throw new ComicParseError(`解析 CB7/7z 失败: ${(err as Error).message}`, err as Error);
  }
}

/**
 * 读取 CB7/7z 漫画章节图片
 *
 * 用 7zip-min 的 unpackSome 解压指定文件到临时目录，再复制到 imageDir。
 *
 * @param filePath CB7/7z 文件路径
 * @param chapter 章节索引（url 字段存 7z entry name）
 * @param imageDir 图片保存目录
 * @returns 图片文件路径列表
 */
async function readCb7ChapterImages(filePath: string, chapter: ChapterIndex, imageDir: string): Promise<string[]> {
  if (!chapter.url) {
    throw new ComicParseError('漫画章节缺少 url 字段（7z entry name）');
  }

  // zip slip 防护：解压前校验 entry name，拒绝含 `..`/绝对路径的恶意条目
  // 来源：2026-10-19-archive-extraction-zip-slip-timing-defect（校验必须在解压前）
  assertSafeEntryName(chapter.url);

  let tempDir: string | null = null;
  try {
    await fsPromises.mkdir(imageDir, { recursive: true });

    // 动态导入 7zip-min
    const sevenZip = await import('7zip-min');

    // 创建临时目录解压指定文件
    tempDir = await fsPromises.mkdtemp(join(tmpdir(), 'comic-cb7-'));
    await sevenZip.unpackSome(filePath, [chapter.url], tempDir);

    // 在临时目录中查找解压出的图片（保持 archive 内路径结构）
    const tempImagePath = join(tempDir, chapter.url);
    // 路径遍历防护（深度防御）：确保解压后的路径仍在 tempDir 内
    const resolvedTemp = resolve(tempImagePath);
    const resolvedDir = resolve(tempDir);
    if (!resolvedTemp.startsWith(resolvedDir + sep) && resolvedTemp !== resolvedDir) {
      throw new ComicParseError(`路径遍历攻击检测：entry "${chapter.url}" 逃逸出临时目录`);
    }
    const buf = await fsPromises.readFile(resolvedTemp);

    // 写入目标时只取 basename，进一步消除路径遍历风险
    const originalName = basename(chapter.url);
    const fileName = `${chapter.index}_${originalName}`;
    const destPath = join(imageDir, fileName);
    await fsPromises.writeFile(destPath, buf);

    return [destPath];
  } catch (err) {
    if (err instanceof ComicParseError) throw err;
    throw new ComicParseError(`读取 CB7 图片失败: ${(err as Error).message}`, err as Error);
  } finally {
    // 清理临时目录
    if (tempDir) {
      try {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // 清理失败忽略
      }
    }
  }
}

/* ==================== CBT/Tar 解析 ==================== */

/**
 * 解析 CBT/Tar 漫画文件
 *
 * 使用 tar 库列出 tar 文件内容，筛选图片生成章节索引。
 *
 * @param filePath CBT/Tar 文件路径
 * @param onProgress 解析进度回调
 * @returns 解析结果（元数据 + 章节索引）
 */
async function parseCbt(filePath: string, onProgress?: (p: number) => void): Promise<ParsedBook> {
  try {
    if (onProgress) onProgress(0.1);

    // 动态导入 tar（ESM 兼容）
    const tar = await import('tar');

    if (onProgress) onProgress(0.3);

    // 列出 tar 文件内容（通过 onentry 回调收集文件名）
    const allFiles: string[] = [];
    await tar.t({
      file: filePath,
      onentry: (entry: { path: string }) => {
        allFiles.push(entry.path);
      }
    });

    if (onProgress) onProgress(0.5);

    // 筛选图片文件并排序
    const imageFiles = allFiles
      .filter((name: string) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
      .sort((a: string, b: string) => {
        const keyA = extractImageSortKey(a);
        const keyB = extractImageSortKey(b);
        if (keyA !== keyB) return keyA - keyB;
        return a.localeCompare(b);
      });

    if (imageFiles.length === 0) {
      throw new ComicParseError('Tar 中未找到任何图片文件');
    }

    if (onProgress) onProgress(0.9);

    // 每张图片作为一个章节
    const chapters: ChapterIndex[] = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const entryName = imageFiles[i];
      chapters.push({
        index: i,
        title: `第${i + 1}页`,
        fileOffset: 0,
        fileLength: 0,
        url: entryName,
        contentType: 'image'
      });
    }

    if (onProgress) onProgress(1);

    const fileName = basename(filePath);
    const title = fileName.replace(/\.[^.]+$/, '').trim();

    return {
      encoding: 'UTF-8',
      title,
      author: '未知',
      description: '',
      chapters,
      isComic: true,
      contentType: 'comic' as const
    };
  } catch (err) {
    if (err instanceof ComicParseError) throw err;
    throw new ComicParseError(`解析 CBT/Tar 失败: ${(err as Error).message}`, err as Error);
  }
}

/**
 * 读取 CBT/Tar 漫画章节图片
 *
 * 用 tar.x 解压指定文件到临时目录，再复制到 imageDir。
 *
 * @param filePath CBT/Tar 文件路径
 * @param chapter 章节索引（url 字段存 tar entry name）
 * @param imageDir 图片保存目录
 * @returns 图片文件路径列表
 */
async function readCbtChapterImages(filePath: string, chapter: ChapterIndex, imageDir: string): Promise<string[]> {
  if (!chapter.url) {
    throw new ComicParseError('漫画章节缺少 url 字段（tar entry name）');
  }

  // zip slip 防护：解压前校验 entry name，拒绝含 `..`/绝对路径的恶意条目
  // 来源：2026-10-19-archive-extraction-zip-slip-timing-defect（校验必须在解压前）
  assertSafeEntryName(chapter.url);

  let tempDir: string | null = null;
  try {
    await fsPromises.mkdir(imageDir, { recursive: true });

    // 动态导入 tar
    const tar = await import('tar');

    // 创建临时目录解压指定文件
    tempDir = await fsPromises.mkdtemp(join(tmpdir(), 'comic-cbt-'));
    await tar.x(
      {
        file: filePath,
        cwd: tempDir
      },
      [chapter.url]
    );

    // 在临时目录中查找解压出的图片（保持 archive 内路径结构）
    const tempImagePath = join(tempDir, chapter.url);
    // 路径遍历防护（深度防御）：确保解压后的路径仍在 tempDir 内
    const resolvedTemp = resolve(tempImagePath);
    const resolvedDir = resolve(tempDir);
    if (!resolvedTemp.startsWith(resolvedDir + sep) && resolvedTemp !== resolvedDir) {
      throw new ComicParseError(`路径遍历攻击检测：entry "${chapter.url}" 逃逸出临时目录`);
    }
    const buf = await fsPromises.readFile(resolvedTemp);

    // 写入目标时只取 basename，进一步消除路径遍历风险
    const originalName = basename(chapter.url);
    const fileName = `${chapter.index}_${originalName}`;
    const destPath = join(imageDir, fileName);
    await fsPromises.writeFile(destPath, buf);

    return [destPath];
  } catch (err) {
    if (err instanceof ComicParseError) throw err;
    throw new ComicParseError(`读取 CBT 图片失败: ${(err as Error).message}`, err as Error);
  } finally {
    // 清理临时目录
    if (tempDir) {
      try {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // 清理失败忽略
      }
    }
  }
}

/* ==================== 统一入口 ==================== */

/**
 * 解析漫画文件（万能入口）
 *
 * 根据扩展名选择对应解析器：
 * - .cbz / .zip → CBZ/ZIP 解析
 * - .cbr / .rar → CBR/RAR 解析
 * - .cb7 / .7z → CB7/7z 解析
 * - .cbt / .tar → CBT/Tar 解析
 *
 * @param filePath 漫画文件路径
 * @param onProgress 解析进度回调
 * @returns 解析结果
 */
export async function parseComic(filePath: string, onProgress?: (p: number) => void): Promise<ParsedBook> {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.cbz' || ext === '.zip') {
    return parseCbz(filePath, onProgress);
  }

  if (ext === '.cbr' || ext === '.rar') {
    return parseCbr(filePath, onProgress);
  }

  if (ext === '.cb7' || ext === '.7z') {
    return parseCb7(filePath, onProgress);
  }

  if (ext === '.cbt' || ext === '.tar') {
    return parseCbt(filePath, onProgress);
  }

  // 兜底：检测 magic number
  const format = await detectComicFormatByMagicNumber(filePath);
  if (format === 'zip') {
    return parseCbz(filePath, onProgress);
  }
  if (format === 'rar') {
    return parseCbr(filePath, onProgress);
  }
  if (format === '7z') {
    return parseCb7(filePath, onProgress);
  }
  if (format === 'tar') {
    return parseCbt(filePath, onProgress);
  }

  throw new ComicParseError(`不支持的漫画格式: ${ext}`);
}

/**
 * 读取漫画章节图片（万能入口）
 *
 * @param filePath 漫画文件路径
 * @param chapter 章节索引
 * @param imageDir 图片保存目录
 * @returns 图片文件路径列表
 */
export async function readComicChapterImages(
  filePath: string,
  chapter: ChapterIndex,
  imageDir: string
): Promise<string[]> {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.cbz' || ext === '.zip') {
    return readCbzChapterImages(filePath, chapter, imageDir);
  }

  if (ext === '.cbr' || ext === '.rar') {
    return readCbrChapterImages(filePath, chapter, imageDir);
  }

  if (ext === '.cb7' || ext === '.7z') {
    return readCb7ChapterImages(filePath, chapter, imageDir);
  }

  if (ext === '.cbt' || ext === '.tar') {
    return readCbtChapterImages(filePath, chapter, imageDir);
  }

  // 兜底：检测 magic number
  const format = await detectComicFormatByMagicNumber(filePath);
  if (format === 'zip') {
    return readCbzChapterImages(filePath, chapter, imageDir);
  }
  if (format === 'rar') {
    return readCbrChapterImages(filePath, chapter, imageDir);
  }
  if (format === '7z') {
    return readCb7ChapterImages(filePath, chapter, imageDir);
  }
  if (format === 'tar') {
    return readCbtChapterImages(filePath, chapter, imageDir);
  }

  throw new ComicParseError(`不支持的漫画格式: ${ext}`);
}

/* ==================== ComicParser 类（实现 FileParser 接口） ==================== */

export class ComicParser implements FileParser {
  async parse(filePath: string, onProgress?: (p: number) => void): Promise<ParsedBook> {
    return parseComic(filePath, onProgress);
  }

  async readChapter(_filePath: string, _chapter: ChapterIndex, _imageDir?: string): Promise<string> {
    // 漫画章节没有文本内容，返回空字符串
    return '';
  }

  async readChapterImages(filePath: string, chapter: ChapterIndex, imageDir: string): Promise<string[]> {
    return readComicChapterImages(filePath, chapter, imageDir);
  }
}
