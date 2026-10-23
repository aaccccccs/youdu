/**
 * MOBI 解析器
 *
 * 从 file-parser.ts 拆分而来。
 */

import { statSync, promises as fsPromises } from 'fs';
import { basename, extname, join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'node:url';
import type { Mobi, Kf8, MobiTocItem, Kf8TocItem } from '@lingo-reader/mobi-parser';
import { convertSemanticHtmlToMarkers } from '../../utils';
import type { ChapterIndex, ParsedBook, FileParser } from './types';
import { matchChapterTitle, extractChapterTitle, isVolumeLine, extractVolumeTitle } from './chapter-patterns';
import { cleanContent } from './txt-parser';
import { extractSourceSrcsetUrls } from './epub-parser';

/* ==================== mobi-parser.ts（MOBI解析器） ==================== */
/**
 * MOBI 解析器
 *
 * 核心设计：MOBI 不支持流式按需读取，parse 时一次性提取全文文本并缓存到内存，
 * readChapter 时从内存缓存按章节偏移返回内容。与 PDF 解析器架构一致。
 *
 * 功能模块：
 * 1. 用 @lingo-reader/mobi-parser 提取 MOBI/KF8(AZW3) 全文文本
 *    - .mobi / .azw 用 initMobiFile（旧版 MOBI 格式）
 *    - .azw3 用 initKf8File（KF8 格式，Kindle Format 8）
 * 2. 提取元数据：MOBI EXTH 元数据的 title / author / description
 * 3. 章节结构策略（分层兜底）：
 *    a. 优先用 MOBI 自带 spine + toc 章节结构（出版商定义的章节边界最准确）
 *    b. 若 spine 只有 1 章或章节无标题 → 合并全文后用 chapter-patterns 正则库分章
 *    c. 正则分章也为空 → 按字数均分（每 3000 字一章）
 * 4. 章节正文缓存到内存（LRU，限制 3 本常驻）
 * 5. 内容清洗（复用 TXT 的 cleanContent：合并空行、统一缩进、去广告）
 * 6. HTML 转纯文本（去标签、保留段落换行、解码 HTML 实体）
 *
 * 导出：
 * - parseMobi(filePath, onProgress?): Promise<ParsedBook>
 * - readMobiChapter(filePath, chapter): Promise<string>
 * - MobiParser 类（实现 FileParser 接口）
 * - closeAllMobiCaches(): void（应用退出时清理缓存）
 */

/* ==================== 错误定义 ==================== */

/** MOBI 解析自定义错误（友好提示 + 保留原始 cause） */
export class MobiParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'MobiParseError';
  }
}

/* ==================== 全文缓存（LRU） ==================== */

/**
 * MOBI 全文缓存（LRU）
 *
 * MOBI 不支持按需读取，parse 时需提取全文文本并缓存，readChapter 时从缓存取内容。
 * key: filePath, value: { chapterTexts }
 * - chapterTexts: 章节正文数组（按章节索引，已清洗）
 *
 * LRU 淘汰策略：JS Map 按插入顺序遍历，get 命中时 delete+set 刷新为最近使用，
 * 超过 MOBI_CACHE_MAX 时淘汰最旧的。
 */
interface MobiCacheEntry {
  /** 章节正文数组（按章节索引，已清洗） */
  chapterTexts: string[];
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
}

/** MOBI 全文缓存最大数量（限制同时常驻内存的 MOBI 全文数，覆盖多本切换场景） */
const MOBI_CACHE_MAX = 3;

/** LRU 缓存：filePath → MobiCacheEntry */
export const mobiCache = new Map<string, MobiCacheEntry>();

/**
 * 获取 MOBI 全文缓存（带 LRU 刷新 + P1-12缓存陈旧检测）
 *
 * P1-12修复：对所有类型都检测缓存陈旧（通过文件修改时间和大小比较）
 * 原问题：只对illustrated类型检测旧缓存，text类型有图的书不重新读取
 * 修复：检查文件mtime和size，不匹配则清除缓存返回undefined（触发重新解析）
 *
 * @param filePath MOBI 文件路径
 * @returns 缓存条目，未命中或陈旧返回 undefined
 */
function getMobiCache(filePath: string): MobiCacheEntry | undefined {
  const cached = mobiCache.get(filePath);
  if (cached) {
    // P1-12修复：检测缓存陈旧 — 检查文件修改时间和大小
    try {
      const currentStat = statSync(filePath);
      if (
        cached.mtimeMs !== undefined &&
        cached.fileSize !== undefined &&
        (cached.mtimeMs !== currentStat.mtimeMs || cached.fileSize !== currentStat.size)
      ) {
        // 文件已修改，缓存陈旧，清除并返回undefined触发重新解析
        mobiCache.delete(filePath);
        return undefined;
      }
    } catch {
      // statSync失败（文件可能已被删除），清除缓存
      mobiCache.delete(filePath);
      return undefined;
    }
    // 命中且未陈旧：刷新为最近使用（delete+set 改变 Map 插入顺序）
    mobiCache.delete(filePath);
    mobiCache.set(filePath, cached);
    return cached;
  }
  return undefined;
}

/**
 * 写入 MOBI 全文缓存（带 LRU 淘汰 + P1-12存储文件元信息）
 *
 * P1-12修复：写入缓存时存储文件修改时间和大小，供getMobiCache检测缓存陈旧
 *
 * @param filePath MOBI 文件路径
 * @param entry 缓存条目
 */
function setMobiCache(filePath: string, entry: MobiCacheEntry): void {
  // P1-12修复：存储文件修改时间和大小，用于后续缓存陈旧检测
  try {
    const stat = statSync(filePath);
    entry.mtimeMs = stat.mtimeMs;
    entry.fileSize = stat.size;
  } catch {
    // statSync失败，不存储mtime/fileSize（不影响功能，只是无法检测陈旧）
  }
  mobiCache.set(filePath, entry);
  // 超限淘汰最旧条目（Map 首项 = 最久未使用）
  if (mobiCache.size > MOBI_CACHE_MAX) {
    const oldestKey = mobiCache.keys().next().value;
    if (oldestKey !== undefined) {
      mobiCache.delete(oldestKey);
    }
  }
}

/**
 * 关闭所有缓存的 MOBI 全文（应用退出时调用）
 *
 * MOBI 全文缓存在内存中，无需 close 句柄，只需清空 Map 释放内存引用。
 */
export function closeAllMobiCaches(): void {
  mobiCache.clear();
}

/* ==================== HTML 转纯文本 ==================== */

/**
 * 安全的 String.fromCodePoint 包装函数
 *
 * 防止恶意 MOBI 构造代理区码点(0xD800-0xDFFF)或超出 Unicode 范围(>0x10FFFF)
 * 导致 RangeError 崩溃。无效码点返回空字符串。
 *
 * @param cp Unicode 码点
 * @returns 对应字符，无效码点返回空字符串
 */
function safeFromCodePointMobi(cp: number): string {
  if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return '';
  }
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/**
 * 将 MOBI 章节 HTML 转换为纯文本
 *
 * 处理步骤：
 * 1. 去除 <script> / <style> 标签及内容
 * 2. 块级标签（p/div/h1-h6/li/tr/blockquote）转换为换行
 * 3. <br> 转换为换行
 * 4. 图片标签 → [IMG:src] 占位标记（保留图片信息，供 readMobiChapter 替换为本地路径）
 * 4.5 语义标签 → 富文本标记（CODE/QUOTE/TABLE/H1-H6/LI/加粗/斜体/链接）
 * 5. 去除所有剩余 HTML 标签
 * 6. 解码 HTML 实体（&nbsp; &amp; &lt; &gt; &quot; &apos; &#NNN; &#xHH;）
 * 7. 合并多余空行（连续 3+ 个换行压缩为 2 个）
 *
 * 图片占位标记格式：\n[IMG:src]\n
 * - src 是原始值（相对路径或 data URI）
 * - readMobiChapter 会调用 readMobiChapterImages 提取图片到磁盘，
 *   然后按顺序替换占位标记为 [IMG:file:///本地绝对路径]
 * - 前端渲染时检测 [IMG:...] 标记，替换为 <img> 元素
 *
 * 富文本标记格式（与 [IMG:] 占位标记机制一致，不含尖括号）：
 * - [CODE]代码[/CODE] — 代码块（保留换行和缩进）
 * - [QUOTE]引用[/QUOTE] — 引用块
 * - [TABLE]表格HTML[/TABLE] — 表格（保留原始 HTML）
 * - [H1]标题[/H1] ~ [H6]标题[/H6] — 标题
 * - [LI]列表项[/LI] — 列表项
 * - **加粗** — 加粗文本
 * - *斜体* — 斜体文本
 * - [LINK:url]文本[/LINK] — 链接
 *
 * @param html MOBI 章节的 HTML 内容
 * @returns 转换后的纯文本（可能包含 [IMG:src] 图片占位标记和富文本标记）
 */
function htmlToText(html: string): string {
  // 1-3. 先处理非图片标签
  // P0-5修复：CSS背景图完全丢失问题
  // 原代码直接删除 <style> 标签，导致 background-image:url(...) 中的图片引用丢失
  // 修复：在删除 <style> 标签前，先提取其中所有 url(...) 引用，保留为 [IMG:url] 占位标记
  const mobiStyleImageMarks: string[] = [];
  const textWithoutStyle = html
    // 1. 去除 script 标签及内容
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // 提取 <style> 标签中的 CSS 背景图 URL，然后删除 style 标签
    .replace(/<style[\s\S]*?<\/style>/gi, (styleMatch) => {
      const urlRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = urlRegex.exec(styleMatch)) !== null) {
        const imgUrl = urlMatch[1];
        // 跳过 data: URL（内联 base64 图片）
        if (imgUrl.startsWith('data:')) continue;
        // MOBI 无 replaceImage 回调，保留原始 URL 为占位标记（避免图片完全丢失）
        mobiStyleImageMarks.push(`\n\n[IMG:${imgUrl}]\n\n`);
      }
      return '';
    });
  let text = textWithoutStyle
    // 2. 块级标签转换为换行（开标签和闭标签都转）
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer|ul|ol|dl|dt|dd|hr)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer|ul|ol|dl|dt|dd|hr)[^>]*>/gi, '\n')
    // 3. <br> 转换为换行
    .replace(/<br\s*\/?>/gi, '\n')
    // 3b. <mbp:pagebreak/> 是 MOBI 分页/分章标记，转换为换行（确保章节标题独占一行）
    .replace(/<mbp:pagebreak\s*\/?>/gi, '\n');

  // 4. 图片标签 → 占位标记（在去所有 HTML 标签前处理）
  //    用 \n 包围占位标记，确保图片独占一行，便于段落分割
  //    顺序：先 <img> 后 <image>，与 readMobiChapterImages 保持一致
  text = text
    .replace(/<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi, (_, src: string) => `\n\n[IMG:${src}]\n\n`)
    .replace(/<image\s[^>]*(?:xlink:href|href)=["']([^"']+)["'][^>]*>/gi, (_, src: string) => `\n\n[IMG:${src}]\n\n`);

  // 4.5 语义标签 → 富文本标记（在去所有 HTML 标签前处理）
  //     保留代码块/引用/表格/加粗/斜体/链接/标题/列表等语义结构，
  //     转为不含尖括号的特殊标记，不受后续 .replace(/<[^>]+>/g, '') 影响。
  //     标记格式与 [IMG:] 占位标记一致，用 \n 包围确保独占段落。
  text = convertSemanticHtmlToMarkers(text);

  // P0-5修复：将提取的 CSS 背景图占位标记追加到文本（确保图片不丢失）
  if (mobiStyleImageMarks.length > 0) {
    text += mobiStyleImageMarks.join('');
  }

  return (
    text
      // 5. 去除所有剩余 HTML 标签
      .replace(/<[^>]+>/g, '')
      // 6. 解码 HTML 实体
      //    命名实体（常见中文/排版相关）
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&cent;/g, '\u00a2')
      .replace(/&pound;/g, '\u00a3')
      .replace(/&yen;/g, '\u00a5')
      .replace(/&euro;/g, '\u20ac')
      .replace(/&sect;/g, '\u00a7')
      .replace(/&copy;/g, '\u00a9')
      .replace(/&reg;/g, '\u00ae')
      .replace(/&deg;/g, '\u00b0')
      .replace(/&plusmn;/g, '\u00b1')
      .replace(/&times;/g, '\u00d7')
      .replace(/&divide;/g, '\u00f7')
      .replace(/&hellip;/g, '\u2026')
      .replace(/&mdash;/g, '\u2014')
      .replace(/&ndash;/g, '\u2013')
      .replace(/&lsquo;/g, '\u2018')
      .replace(/&rsquo;/g, '\u2019')
      .replace(/&ldquo;/g, '\u201c')
      .replace(/&rdquo;/g, '\u201d')
      // 数字实体：用 fromCodePoint 替代 fromCharCode，支持 > 0xFFFF 的码点（如 emoji）
      // 使用 safeFromCodePoint 防止恶意代理区码点(0xD800-0xDFFF)或超出范围导致 RangeError
      .replace(/&#(\d+);/g, (_, n: string) => {
        const cp = parseInt(n, 10);
        return cp > 0 ? safeFromCodePointMobi(cp) : '';
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => {
        const cp = parseInt(n, 16);
        return cp > 0 ? safeFromCodePointMobi(cp) : '';
      })
      // 7. 合并多余空行（连续 3+ 个换行压缩为 2 个）
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
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
function parseMobiFileNameTitle(fileName: string): string {
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
 * 从 MOBI 元数据和文件名提取书名、作者、简介
 *
 * 优先级：
 * 1. MOBI EXTH 元数据的 title / author / description
 * 2. 文件名兜底（去扩展名）
 *
 * @param meta MOBI 元数据（getMetadata() 返回值）
 * @param fileName 文件名（含扩展名）
 */
function extractMobiMeta(
  meta: { title?: string; author?: string[] | string; description?: string } | undefined,
  fileName: string
): { title: string; author: string; description: string } {
  // 书名：优先用元数据 title，兜底用文件名
  let title = '';
  if (meta) {
    if (typeof meta.title === 'string' && meta.title.trim()) {
      title = meta.title.trim();
    }
  }
  if (!title) {
    title = parseMobiFileNameTitle(fileName);
  }

  // 作者：优先用元数据 author，兜底"未知"
  let author = '';
  if (meta) {
    if (Array.isArray(meta.author)) {
      author = meta.author
        .filter((a) => typeof a === 'string' && a.trim())
        .join(', ')
        .trim();
    } else if (typeof meta.author === 'string' && meta.author.trim()) {
      author = meta.author.trim();
    }
  }
  if (!author) {
    author = '未知';
  }

  // 简介：用元数据 description（可选）
  let description = '';
  if (meta) {
    if (typeof meta.description === 'string' && meta.description.trim()) {
      description = meta.description.trim();
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

/**
 * 从 MOBI 文件 EXTH 二进制直接提取元数据（兜底）
 *
 * 当 @lingo-reader/mobi-parser 库的 getMetadata() 返回的 description 为空时，
 * 直接从 EXTH 二进制提取 type 100 (creator/author)、503 (title)、103 (description)。
 *
 * EXTH 记录类型：
 * - 100: creator（作者，可能多个）
 * - 103: description（简介）
 * - 503: title（书名，更新版 MOBI 用 503，旧版用 PalmDB name）
 *
 * @param filePath MOBI 文件路径
 * @returns { title, author, description }，提取失败返回空字符串
 */
async function extractMobiExthMeta(filePath: string): Promise<{ title: string; author: string; description: string }> {
  let buf: Buffer;
  try {
    buf = await fsPromises.readFile(filePath);
  } catch {
    return { title: '', author: '', description: '' };
  }

  if (buf.length < 90) return { title: '', author: '', description: '' };

  // PalmDB header
  const numRecords = buf.readUInt16BE(76);
  if (numRecords < 2) return { title: '', author: '', description: '' };

  // record 0 偏移
  const rec0Start = buf.readUInt32BE(78);
  const rec0End = buf.readUInt32BE(86);
  if (rec0End - rec0Start < 132) return { title: '', author: '', description: '' };
  const rec0 = buf.subarray(rec0Start, rec0End);

  // MOBI header 从 offset 16 开始
  if (rec0.subarray(16, 20).toString('latin1') !== 'MOBI') {
    return { title: '', author: '', description: '' };
  }

  const mobiHeaderLength = rec0.readUInt32BE(20);
  const exthFlags = rec0.readUInt32BE(128);
  const hasExth = (exthFlags & 0x40) !== 0;
  if (!hasExth) return { title: '', author: '', description: '' };

  // EXTH
  const exthStart = 16 + mobiHeaderLength;
  if (exthStart + 12 > rec0.length) return { title: '', author: '', description: '' };
  if (rec0.subarray(exthStart, exthStart + 4).toString('latin1') !== 'EXTH') {
    return { title: '', author: '', description: '' };
  }

  const exthHeaderLength = rec0.readUInt32BE(exthStart + 4);
  const exthRecordCount = rec0.readUInt32BE(exthStart + 8);

  let title = '';
  let author = '';
  let description = '';

  let pos = exthStart + 12;
  for (let i = 0; i < exthRecordCount && pos < exthStart + exthHeaderLength; i++) {
    if (pos + 8 > rec0.length) break;
    const recType = rec0.readUInt32BE(pos);
    const recLen = rec0.readUInt32BE(pos + 4);
    if (recLen < 8 || pos + recLen > rec0.length) break;

    // 提取记录内容（UTF-8 编码）
    const content = rec0
      .subarray(pos + 8, pos + recLen)
      .toString('utf8')
      .trim();

    if (recType === 100 && content) {
      // creator（作者）：多个用逗号连接
      author = author ? `${author}, ${content}` : content;
    } else if (recType === 103 && content) {
      // description（简介）
      if (!description) description = content;
    } else if (recType === 503 && content) {
      // title（书名，EXTH 503 优先级高于 PalmDB name）
      if (!title) title = content;
    }

    pos += recLen;
  }

  // 清理 description 中的 HTML 标签和实体（与 EPUB extractDescription 保持一致）
  if (description) {
    description = description
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-zA-Z]+;/g, ' ')
      .replace(/&#\d+;/g, ' ')
      .trim();
  }

  return { title, author, description };
}

/* ==================== TOC 扁平化 ==================== */

/**
 * 扁平化 MOBI/KF8 的树形 TOC，建立 章节id → 标题 映射
 *
 * MOBI 的 TOC 是树形结构（有 children），spine 的每个章节通过 id 关联 TOC 的 href。
 * 扁平化后建立 Map<id, label>，用于从 spine 章节 id 查找对应标题。
 *
 * @param toc TOC 数组（MobiTocItem[] 或 Kf8TocItem[]）
 * @returns Map: 章节id → 标题
 */
function flattenTocToMap(toc: (MobiTocItem | Kf8TocItem)[]): Map<string, string> {
  const map = new Map<string, string>();
  function flatten(items: (MobiTocItem | Kf8TocItem)[]): void {
    for (const item of items) {
      if (item.href && item.label) {
        // href 可能是 "chapter-id" 或 "chapter-id#anchor" 格式，取 # 前部分
        const id = item.href.split('#')[0];
        if (id) {
          map.set(id, item.label.trim());
        }
      }
      if (item.children && item.children.length > 0) {
        flatten(item.children);
      }
    }
  }
  flatten(toc);
  return map;
}

/* ==================== 分章逻辑（正则兜底） ==================== */

/**
 * 按行扫描全文文本，用章节正则库分章
 *
 * 流程：
 * 1. 按行切分全文
 * 2. 逐行用 matchChapterTitle 判断是否为章节标题
 * 3. 匹配到标题 → 上一章结束，记录 { index, title, charOffset, charLength }
 * 4. 卷级标记（含带卷名形态，如"第一卷 燎山纪氏"）不作为独立章节：
 *    先结束当前章节（卷标记行不进入任何章节内容），记录卷标题供后续章节关联
 *    （对齐 txt-parser 的卷处理标杆语义）
 * 5. 无章节标题 → 走分章兜底
 *
 * @param fullText 全文文本
 * @returns 章节索引数组 + 章节正文数组
 */
export function splitChaptersByRegex(fullText: string): { chapters: ChapterIndex[]; chapterTexts: string[] } {
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
 * 分章兜底：无章节标题的 MOBI 按字数均分
 *
 * - 每 avgChars 字切为一章，标题"第1节""第2节"…
 * - 在行边界切分（不会把一行切成两半）
 *
 * @param fullText 全文文本
 * @param avgChars 每章平均字数（默认 3000）
 * @returns 章节索引数组 + 章节正文数组
 */
function fallbackMobiChunk(fullText: string, avgChars = 3000): { chapters: ChapterIndex[]; chapterTexts: string[] } {
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
function deduplicateMobiChapters(
  chapters: ChapterIndex[],
  chapterTexts: string[],
  isComic = false
): { chapters: ChapterIndex[]; chapterTexts: string[] } {
  const resultChapters: ChapterIndex[] = [];
  const resultTexts: string[] = [];
  const seenTitles = new Set<string>();

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const text = chapterTexts[i];
    const titleKey = ch.title.trim().toLowerCase();

    // 跳过过短章节（< 50 字符，只有标题无正文），但保留至少一个章节
    // 漫画/图文模式不跳过：章节文本为空或很短但含图片
    if (
      !isComic &&
      ch.contentType !== 'image' &&
      ch.contentType !== 'illustrated' &&
      ch.fileLength < 50 &&
      resultChapters.length > 0
    ) {
      continue;
    }

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

/* ==================== PalmDOC 解压 + 二进制直接提取 ==================== */

/**
 * PalmDOC 解压算法 (compression=2)
 *
 * PalmDOC LZ77 变长编码解压，对齐 @lingo-reader/mobi-parser 库实现。
 * 字节流按以下规则解码：
 * - 0x00              → 输出 0x00
 * - 0x01-0x08         → 复制后续 1-8 字节（字面量）
 * - 0x09-0x7F         → 直接输出该字节
 * - 0x80-0xBF (2字节) → 双字节 copy：bytes = (c<<8)|c2
 *                       distance = (bytes & 0x3FFF) >> 3   (11 bits, 最大 2047)
 *                       length   = (bytes & 0x07) + 3      (3-10 字节)
 *                       从 output[output.length - distance] 开始复制 length 字节
 * - 0xC0-0xFF         → 输出空格 + (c ^ 0x80)
 *
 * 修复历史 bug（B-88）：
 * - length 原为 (c2 & 7) + 2，少 1，导致漏字节 → 改为 (bytes & 7) + 3
 * - distance 原为 ((c<<8)|c2) >> 3，含 bit14 导致距离过大 → 改为 (bytes & 0x3FFF) >> 3
 * - 越界复制时库直接 push(undefined)→0，这里用 ?? 0 保持一致
 *
 * @param data 压缩数据
 * @returns 解压后的 Buffer
 */
function decompressPalmDOC(data: Uint8Array | Buffer): Uint8Array {
  const output: number[] = [];
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const byte = data[i];
    if (byte === 0) {
      output.push(0);
    } else if (byte <= 8) {
      // 复制后续 byte 字节（字面量）
      for (const x of data.subarray(i + 1, (i += byte) + 1)) {
        output.push(x);
      }
    } else if (byte <= 0x7f) {
      // 直接输出
      output.push(byte);
    } else if (byte <= 0xbf) {
      // 双字节 copy
      const bytes = (byte << 8) | data[i++ + 1];
      const distance = (bytes & 0x3fff) >>> 3;
      const length = (bytes & 0x07) + 3;
      for (let j = 0; j < length; j++) {
        output.push(output[output.length - distance] ?? 0);
      }
    } else {
      // 空格 + 字面量
      output.push(0x20, byte ^ 0x80);
    }
  }
  return Uint8Array.from(output);
}

/**
 * 计算整数中置位数的个数（popcount）
 * 用于 trailingFlags >>> 1 的置位数 = trailing entry 数量
 */
function countBitsSet(x: number): number {
  let count = 0;
  for (; x > 0; x = x >>> 1) {
    if ((x & 1) === 1) count++;
  }
  return count;
}

/**
 * 从数组末尾读取变长整数（trailing entry length）
 *
 * 读末尾 4 字节，每个字节的 bit7 是 reset 标记（遇到则 value 清零），
 * 低 7 位按大端拼接为长度值。
 */
function getVarLenFromEnd(array: Uint8Array): number {
  let value = 0;
  for (const byte of array.subarray(-4)) {
    if (byte & 0x80) value = 0;
    value = (value << 7) | (byte & 0x7f);
  }
  return value;
}

/**
 * 去除 record 末尾的 trailing data（trailing entries + multibyte overlap）
 *
 * MOBI 每个 text record 末尾可能附加：
 * 1. numTrailingEntries 个变长 trailing entry（如 INDX 索引数据）
 * 2. multibyte overlap：record 边界截断的 UTF-8 多字节字符的前几个字节
 *    （这些字节会在下一个 record 开头重复，所以本 record 末尾要去掉）
 *
 * trailingFlags（MOBI header offset 224，rec0 offset 240）：
 * - bit0 = has multibyte overlap
 * - bit1+ 置位数 = numTrailingEntries
 *
 * @param array record 原始数据
 * @param numTrailingEntries trailing entry 数量
 * @param multibyte 是否有 multibyte overlap
 * @returns 去除 trailing 后的数据
 */
function removeTrailingEntries(array: Uint8Array, numTrailingEntries: number, multibyte: boolean): Uint8Array {
  let arr = array;
  for (let i = 0; i < numTrailingEntries; i++) {
    const length = getVarLenFromEnd(arr);
    if (length > 0 && length < arr.length) {
      arr = arr.subarray(0, -length);
    }
  }
  if (multibyte && arr.length > 0) {
    const length = (arr[arr.length - 1] & 0x03) + 1;
    if (length < arr.length) {
      arr = arr.subarray(0, -length);
    }
  }
  return arr;
}

/**
 * 从 MOBI 文件二进制直接提取所有文本 record 的 HTML 内容
 *
 * 当 @lingo-reader/mobi-parser 库解析失败（spine 只有1章、内容过短）时的兜底方案。
 * 直接读取 PalmDB header → record 0 (PalmDOC+MOBI header) → record 1~N (文本内容)。
 *
 * 流程：
 * 1. 读取 PalmDB header (78 bytes) 获取 numRecords
 * 2. 读取 record info array 获取每个 record 的偏移
 * 3. 从 record 0 前 16 bytes 读取 PalmDOC header (compression, textLength, recordCount)
 * 4. 从 record 0 读取 MOBI header 获取 trailingFlags（处理 trailing data）
 * 5. 读取 record 1 ~ recordCount：
 *    a. 先去 trailing data（trailing entries + multibyte overlap）
 *    b. 按 compression 解压（PalmDOC 或无压缩）
 * 6. 用 Buffer.concat 批量合并所有解压后的字节（性能优化）
 * 7. 统一转 UTF-8（MOBI header textEncoding=65001 即 UTF-8）
 *
 * 修复历史 bug（B-88）：
 * - trailingFlags 读取位置错误（原 rec0[204] → rec0[240]）
 * - trailing 处理逻辑错误（原只去末尾1字节 → 正确实现 removeTrailingEntries）
 * - 处理顺序错误（原先解压再去trailing → 先去trailing再解压）
 * - 性能：用 Buffer.concat 替代 number[] 逐字节 push
 *
 * @param filePath MOBI 文件路径
 * @returns 合并后的完整 HTML 文本，失败返回空字符串
 */
async function extractMobiBinaryRecords(filePath: string): Promise<string> {
  let buf: Buffer;
  try {
    buf = await fsPromises.readFile(filePath);
  } catch {
    // P1-23修复: 读取失败时输出警告而非静默返回空字符串
    console.warn(`[extractMobiBinaryRecords] 读取文件失败: ${filePath}`);
    return '';
  }

  // P1-23修复: 以下边界检查静默返回空字符串，添加警告日志
  if (buf.length < 90) {
    console.warn(`[extractMobiBinaryRecords] 文件过小 (${buf.length} bytes): ${filePath}`);
    return '';
  }

  // PalmDB header
  const numRecords = buf.readUInt16BE(76);
  if (numRecords < 2) {
    console.warn(`[extractMobiBinaryRecords] 记录数不足 (${numRecords}): ${filePath}`);
    return '';
  }

  // 读取 record 偏移数组
  const recordOffsets: number[] = [];
  for (let i = 0; i < numRecords; i++) {
    const infoOffset = 78 + i * 8;
    if (infoOffset + 4 > buf.length) break;
    recordOffsets.push(buf.readUInt32BE(infoOffset));
  }
  if (recordOffsets.length < 2) {
    console.warn(`[extractMobiBinaryRecords] 记录偏移数不足 (${recordOffsets.length}): ${filePath}`);
    return '';
  }

  // record 0 = PalmDOC header (16 bytes) + MOBI header
  const rec0Start = recordOffsets[0];
  const rec0End = recordOffsets[1];
  if (rec0End - rec0Start < 132) {
    console.warn(`[extractMobiBinaryRecords] record 0 过小 (${rec0End - rec0Start} bytes): ${filePath}`);
    return '';
  }
  const rec0 = buf.subarray(rec0Start, rec0End);

  // PalmDOC header (前 16 bytes)
  const compression = rec0.readUInt16BE(0);
  const recordCount = rec0.readUInt16BE(8);

  // MOBI header 从 offset 16 开始
  // trailingFlags 在 MOBI header offset 224 (rec0 offset 240)
  // 对齐 @lingo-reader/mobi-parser 库的 mobiHeader 定义：trailingFlags: [240, 4, "uint"]
  // bit0 = multibyte overlap, bit1+ 置位数 = numTrailingEntries
  let multibyte = false;
  let numTrailingEntries = 0;
  if (rec0.length >= 244) {
    try {
      const trailingFlags = rec0.readUInt32BE(240);
      multibyte = (trailingFlags & 0x01) !== 0;
      numTrailingEntries = countBitsSet(trailingFlags >>> 1);
    } catch {
      // 读取失败，不做 trailing 处理
    }
  }

  // 读取 record 1 ~ recordCount，去 trailing → 解压 → 收集
  const maxRec = Math.min(recordCount, recordOffsets.length - 1);
  const chunks: Buffer[] = [];

  for (let i = 1; i <= maxRec; i++) {
    const start = recordOffsets[i];
    const end = i + 1 < recordOffsets.length ? recordOffsets[i + 1] : buf.length;
    if (start >= buf.length || end > buf.length || end <= start) continue;

    let recData: Uint8Array = new Uint8Array(buf.subarray(start, end));

    // 先去 trailing data（trailing entries + multibyte overlap）
    if (numTrailingEntries > 0 || multibyte) {
      recData = removeTrailingEntries(recData, numTrailingEntries, multibyte);
    }

    // PalmDOC 解压
    if (compression === 2) {
      try {
        chunks.push(Buffer.from(decompressPalmDOC(recData)));
      } catch {
        // 解压失败，用原始数据
        chunks.push(Buffer.from(recData));
      }
    } else {
      // 无压缩 (compression=1)，直接使用
      chunks.push(Buffer.from(recData));
    }
  }

  // 批量合并（Buffer.concat 比 number[] 逐字节 push 快很多）
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 快速检测 MOBI 文件是否为 KF8 格式（含 EXTH boundary 标记）
 *
 * KF8 格式的 .mobi 文件在 EXTH 中有 type=121 (boundary) 记录，
 * 指向 KF8 header 所在的 record index。
 * initMobiFile 内部会检测 boundary 并切换到 KF8 模式，但 spine 仍为 MOBI 的（只有1项），
 * 导致 parseMobi 不得不再次 initKf8File，浪费 ~1.7s。
 *
 * 本函数只读 record 0（前几 KB），快速判断是否 KF8，避免无用的 initMobiFile。
 *
 * @param filePath MOBI 文件路径
 * @returns true=KF8 格式（应用 initKf8File），false=旧版 MOBI（用 initMobiFile）
 */
async function isKf8Format(filePath: string): Promise<boolean> {
  let buf: Buffer;
  try {
    buf = await fsPromises.readFile(filePath);
  } catch {
    return false;
  }
  if (buf.length < 90) return false;

  const numRecords = buf.readUInt16BE(76);
  if (numRecords < 2) return false;

  const rec0Start = buf.readUInt32BE(78);
  const rec0End = buf.readUInt32BE(86);
  if (rec0End - rec0Start < 132) return false;
  const rec0 = buf.subarray(rec0Start, rec0End);

  // 检查 MOBI magic
  if (rec0.subarray(16, 20).toString('latin1') !== 'MOBI') return false;

  // MOBI header length + exthFlags
  const mobiHeaderLength = rec0.readUInt32BE(20);
  const exthFlags = rec0.readUInt32BE(128);
  const hasExth = (exthFlags & 0x40) !== 0;
  if (!hasExth) return false;

  // EXTH 中找 type=121 (boundary)
  const exthStart = 16 + mobiHeaderLength;
  if (exthStart + 12 > rec0.length) return false;
  if (rec0.subarray(exthStart, exthStart + 4).toString('latin1') !== 'EXTH') return false;

  const exthHeaderLength = rec0.readUInt32BE(exthStart + 4);
  const exthRecordCount = rec0.readUInt32BE(exthStart + 8);
  let pos = exthStart + 12;
  for (let i = 0; i < exthRecordCount && pos < exthStart + exthHeaderLength; i++) {
    if (pos + 8 > rec0.length) break;
    const recType = rec0.readUInt32BE(pos);
    const recLen = rec0.readUInt32BE(pos + 4);
    if (recLen < 8) break;
    if (recType === 121 && recLen >= 12) {
      // boundary record index
      const boundary = rec0.readUInt32BE(pos + 8);
      // 有效 boundary（< 0xFFFFFFFF）说明是 KF8
      return boundary < 0xffffffff;
    }
    pos += recLen;
  }
  return false;
}

/**
 * 选择最佳解析器（MOBI 或 KF8），避免无用的双重初始化
 *
 * 性能优化（B-88）：
 * - 先用 isKf8Format 快速检测是否 KF8 格式（只读 record 0，~1ms）
 * - KF8 格式直接 initKf8File（跳过无用的 initMobiFile，省 ~1.7s）
 * - 若 initKf8File 失败（如斗破苍穹 KF8 header 损坏），回退到 initMobiFile + 兜底
 * - 旧版 MOBI 用 initMobiFile
 * - .azw3 扩展名直接 initKf8File
 *
 * @param filePath 文件路径
 * @param ext 小写扩展名
 * @param resourceSaveDir 图片保存目录（可选）
 * @returns 解析器实例
 */
async function selectMobiParser(filePath: string, ext: string, resourceSaveDir?: string): Promise<Mobi | Kf8> {
  const { initMobiFile, initKf8File } = await import('@lingo-reader/mobi-parser');

  if (ext === '.azw3') {
    return initKf8File(filePath, resourceSaveDir);
  }

  // .mobi / .azw：快速检测是否 KF8 格式
  if (await isKf8Format(filePath)) {
    try {
      return await initKf8File(filePath, resourceSaveDir);
    } catch {
      // KF8 header 损坏（如斗破苍穹），回退到 initMobiFile
      // parseMobi 会通过 extractMobiBinaryRecords 兜底提取内容
      return await initMobiFile(filePath, resourceSaveDir);
    }
  }

  // 旧版 MOBI 格式
  return await initMobiFile(filePath, resourceSaveDir);
}

/**
 * 从 MOBI 文件提取封面图片
 *
 * 策略：
 * 1. 解析 EXTH 元数据，查找 record type 201 (cover offset)
 * 2. 用 firstImageIndex + coverOffset 定位封面 record
 * 3. 如果 EXTH 无封面，扫描所有 record 找第一张图片 (JPEG/PNG/GIF)
 * 4. 返回封面图片的 Buffer
 *
 * @param filePath MOBI 文件路径
 * @returns 封面图片 Buffer，无封面返回 null
 */
export async function extractMobiCoverBuffer(filePath: string): Promise<Buffer | null> {
  let buf: Buffer;
  try {
    buf = await fsPromises.readFile(filePath);
  } catch {
    return null;
  }

  if (buf.length < 90) return null;

  // PalmDB header
  const numRecords = buf.readUInt16BE(76);
  if (numRecords < 2) return null;

  // 读取 record 偏移数组
  const recordOffsets: number[] = [];
  for (let i = 0; i < numRecords; i++) {
    const infoOffset = 78 + i * 8;
    if (infoOffset + 4 > buf.length) break;
    recordOffsets.push(buf.readUInt32BE(infoOffset));
  }
  if (recordOffsets.length < 2) return null;

  // record 0 = PalmDOC header + MOBI header
  const rec0Start = recordOffsets[0];
  const rec0End = recordOffsets[1];
  if (rec0End - rec0Start < 132) return null;
  const rec0 = buf.slice(rec0Start, rec0End);

  // MOBI header 从 offset 16 开始
  const mobiMagic = rec0.slice(16, 20).toString('latin1');
  if (mobiMagic !== 'MOBI') return null;

  const mobiHeaderLength = rec0.readUInt32BE(20);
  const firstImageIndex = rec0.readUInt32BE(44);
  const exthFlags = rec0.readUInt32BE(128);
  const hasExth = (exthFlags & 0x40) !== 0;

  // 尝试从 EXTH 提取封面
  if (hasExth) {
    const exthStart = 16 + mobiHeaderLength;
    if (exthStart + 12 <= rec0.length) {
      const exthMagic = rec0.slice(exthStart, exthStart + 4).toString('latin1');
      if (exthMagic === 'EXTH') {
        const exthHeaderLength = rec0.readUInt32BE(exthStart + 4);
        const exthRecordCount = rec0.readUInt32BE(exthStart + 8);

        let coverOffset = -1;
        let pos = exthStart + 12;
        for (let i = 0; i < exthRecordCount && pos < exthStart + exthHeaderLength; i++) {
          if (pos + 8 > rec0.length) break;
          const recType = rec0.readUInt32BE(pos);
          const recLen = rec0.readUInt32BE(pos + 4);
          if (recType === 201 && recLen >= 12) {
            coverOffset = rec0.readUInt32BE(pos + 8);
          }
          pos += recLen;
        }

        // 用 coverOffset 定位封面 record
        if (coverOffset >= 0 && firstImageIndex !== 0xffffffff) {
          const coverRecordIndex = firstImageIndex + coverOffset;
          if (coverRecordIndex < recordOffsets.length) {
            const coverStart = recordOffsets[coverRecordIndex];
            const coverEnd =
              coverRecordIndex + 1 < recordOffsets.length ? recordOffsets[coverRecordIndex + 1] : buf.length;
            if (coverEnd > coverStart) {
              const coverBuf = buf.slice(coverStart, coverEnd);
              // 验证是否是有效图片
              if (isValidImageBuffer(coverBuf)) {
                return coverBuf;
              }
            }
          }
        }
      }
    }
  }

  // 兜底：扫描所有 record 找第一张图片
  for (let i = 1; i < recordOffsets.length; i++) {
    const start = recordOffsets[i];
    const end = i + 1 < recordOffsets.length ? recordOffsets[i + 1] : buf.length;
    if (start + 4 > buf.length) continue;
    // 检查图片 magic bytes
    const magic = buf.slice(start, Math.min(start + 4, end));
    if (magic[0] === 0xff && magic[1] === 0xd8) {
      // JPEG
      return buf.slice(start, end);
    }
    if (magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47) {
      // PNG
      return buf.slice(start, end);
    }
    if (magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46) {
      // GIF
      return buf.slice(start, end);
    }
  }

  return null;
}

/**
 * 检查 Buffer 是否是有效的图片数据
 */
function isValidImageBuffer(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  return false;
}

/**
 * 提取 MOBI 封面图片并保存到指定路径
 *
 * @param filePath MOBI 文件路径
 * @param destPath 封面保存目标路径（含扩展名）
 * @returns 成功返回 destPath，无封面或失败返回 null
 */
export async function extractMobiCover(filePath: string, destPath: string): Promise<string | null> {
  const coverBuf = await extractMobiCoverBuffer(filePath);
  if (!coverBuf) return null;

  try {
    await fsPromises.writeFile(destPath, coverBuf);
    return destPath;
  } catch {
    return null;
  }
}

/* ==================== 核心解析 ==================== */

/**
 * 根据 MOBI 自带 spine + toc 结构提取章节
 *
 * 策略：
 * 1. 用 spine 获取章节列表，每章用 loadChapter(id) 获取 HTML 转 text
 * 2. 用 toc 扁平化建立 id→label 映射，获取章节标题
 * 3. 若 spine 有效（多章且有标题）→ 直接用 spine 结构
 * 4. 若 spine 无效（只有 1 章或无标题）→ 返回 null，由调用方走正则分章兜底
 *
 * 性能优化（B-88）+ v21 三分类：在遍历 spine 时同步记录每章 content_type，
 * 供 parseMobi 直接计算全书 contentType，避免重复 loadChapter。
 *
 * @param parser MOBI 或 KF8 解析器实例
 * @returns 章节索引数组 + 章节正文数组 + 每章 content_type，若 spine 无效返回 null
 */
function extractChaptersFromSpine(parser: Mobi | Kf8): {
  chapters: ChapterIndex[];
  chapterTexts: string[];
  isComic?: boolean;
  /** v21：每章 content_type（与 chapters 同序），供 parseMobi 计算全书分类 */
  chapterContentTypes?: ('text' | 'illustrated' | 'image')[];
} | null {
  const spine = parser.getSpine();
  const toc = parser.getToc();
  const tocMap = flattenTocToMap(toc);

  // 扁平化 toc 列表，用于 KF8 顺序匹配兜底
  // KF8 格式的 toc href 是 "kindle:pos:fid:NNNN:off:..." 格式，
  // flattenTocToMap 用 href 作为 key，但 spine 的 id 是数字，key 不匹配
  // 兜底：如果 tocMap 匹配失败，按 toc 顺序匹配
  const flatTocLabels: string[] = [];
  for (const item of toc) {
    if (item.label) {
      flatTocLabels.push(item.label.trim());
    }
  }

  // 提取每章的 id 和标题
  const chapterInfos = spine.map((ch, i) => {
    const id = ch.id;
    // 标题优先从 tocMap 获取（按 href 匹配）
    let title = tocMap.get(id) || '';
    // KF8 兜底：toc href 格式不匹配 spine id，按顺序匹配
    if (!title && flatTocLabels.length === spine.length) {
      title = flatTocLabels[i] || '';
    }
    return { id, title };
  });

  // 判断 spine 结构是否有效：至少 2 章
  if (chapterInfos.length < 2) {
    return null;
  }
  const hasAnyTitle = chapterInfos.some((info) => info.title.length > 0);
  if (!hasAnyTitle) {
    // toc 为空但 spine 有效（如城市猎人 KF8: spine=216, toc=0）
    // 不返回 null，用 "第N頁" 生成默认标题（漫画书每章是一页）
    for (let i = 0; i < chapterInfos.length; i++) {
      const pageNum = String(i + 1).padStart(3, '0');
      chapterInfos[i].title = `第 ${pageNum} 頁`;
    }
  }

  // 合并图片检测正则（性能优化：一次 match 检测所有图片格式）
  // 先 <img src=...>，再 <image href=...>，再 data:image URI
  const chapters: ChapterIndex[] = [];
  const chapterTexts: string[] = [];
  const chapterContentTypes: ('text' | 'illustrated' | 'image')[] = [];
  let charOffset = 0;
  let hasImageChapter = false; // 跟踪是否有图片章节（漫画书）

  for (let i = 0; i < chapterInfos.length; i++) {
    const info = chapterInfos[i];
    let chapterText = '';
    let chapterType: 'text' | 'illustrated' | 'image' = 'text';
    try {
      const result = parser.loadChapter(info.id);
      if (result && result.html) {
        const html = result.html;
        chapterText = htmlToText(html);
        // 统计图片数量（用于三分类判定）
        // 用 indexOf 快速预筛，再用正则精确计数
        let imageCount = 0;
        if (html.indexOf('<img') >= 0) {
          imageCount += (html.match(/<img\s/gi) || []).length;
        }
        if (html.indexOf('<image') >= 0) {
          imageCount += (html.match(/<image\s/gi) || []).length;
        }
        if (html.indexOf('data:image') >= 0) {
          imageCount += (html.match(/data:image/gi) || []).length;
        }

        // v25 三分类判定：
        // - 单图章节：CJK >= 10 即算有文字（v25: 从5提高到10，排除短对话气泡"今天天气真好"=6字）
        // - 多图章节：CJK >= 50 才算有文字（排除漫画对话气泡）
        // - 文字充足 + 图片=0 → text
        // - 文字充足 + 图片=1 → text（装饰图）
        // - 文字充足 + 图片≥2 → illustrated
        // - 文字极少 + 图片≥1 → image
        // 来源：经验库 2026-09-24-epub-illustrated-misclassify-as-text-threshold-issue
        const cjkCharCount = (chapterText.match(/[\u4e00-\u9fff]/g) || []).length;
        const hasSubstantialText =
          imageCount >= 2
            ? cjkCharCount >= 50 || chapterText.length > 500
            : cjkCharCount >= 10 || chapterText.length > 200;

        if (imageCount > 0) {
          if (hasSubstantialText) {
            if (imageCount >= 2) {
              chapterType = 'illustrated';
            } else {
              chapterType = 'text'; // 单张装饰图
            }
          } else {
            chapterType = 'image';
            hasImageChapter = true;
          }
        } else {
          chapterType = 'text';
        }
      }
    } catch {
      // 单章加载失败，跳过（不影响其他章）
      chapterText = '';
    }
    chapterContentTypes.push(chapterType);

    // 章节标题：优先用 toc 标题，兜底"第N章"
    const title = info.title || `第${i + 1}章`;
    const chapterLength = chapterText.length;

    chapters.push({
      index: i,
      title,
      fileOffset: charOffset,
      fileLength: chapterLength,
      url: info.id // 存 spine id，供漫画图片提取时定位章节
    });
    chapterTexts.push(chapterText);

    charOffset += chapterLength + 1; // +1 for 分隔换行
  }

  // 验证：如果所有章节正文都为空且没有图片章节，spine 结构无效
  // 注意：漫画书的章节文本为空（htmlToText 去掉了 <img>），但 HTML 中有图片
  // htmlToText 现在保留 [IMG:src] 占位标记，检查 hasAnyContent 时需排除纯图片占位标记
  const hasAnyContent = chapterTexts.some((text) => text.replace(/\[IMG:[^\]]+\]/g, '').trim().length > 0);
  if (!hasAnyContent && !hasImageChapter) {
    return null;
  }

  // 如果所有章节都没有文本但有图片，判定为漫画
  const isComic = !hasAnyContent && hasImageChapter;

  return { chapters, chapterTexts, isComic, chapterContentTypes };
}

/**
 * 解析 MOBI 文件，建立章节索引并缓存全文到内存
 *
 * 流程：
 * 1. 校验文件存在 + 非空
 * 2. 根据扩展名选择 initMobiFile（.mobi/.azw）或 initKf8File（.azw3）
 * 3. 提取元数据（title/author/description）
 * 4. 章节结构策略（分层兜底）：
 *    a. 优先用 MOBI 自带 spine + toc 章节结构
 *    b. spine 无效 → 合并全文用 chapter-patterns 正则库分章
 *    c. 正则分章也为空 → 按字数均分（每 3000 字一章）
 * 5. 章节去重 + 过滤过短章节 + 合并相邻同名章节
 * 6. 清洗章节正文（复用 TXT 的 cleanContent）
 * 7. 缓存章节正文到内存
 *
 * 注意：MOBI 不支持流式按需读取，parse 时需一次性提取全文并缓存到内存。
 * MOBI 通常不大（单本几十 MB 以内），内存占用可接受。
 *
 * @param filePath 文件绝对路径
 * @param onProgress 解析进度回调（0~1，供 UI 显示加载动画）
 * @param originalFileName 原始文件名（用于元数据提取，可选）
 * @returns { encoding, title, author, chapters }
 * @throws MobiParseError 文件不存在/为空/解析失败
 */
export async function parseMobi(
  filePath: string,
  onProgress?: (p: number) => void,
  originalFileName?: string
): Promise<ParsedBook> {
  // 校验文件存在
  let stat;
  try {
    stat = statSync(filePath);
  } catch (err) {
    throw new MobiParseError(`文件不存在或无法访问: ${filePath}`, err as Error);
  }

  if (stat.size === 0) {
    throw new MobiParseError('文件为空');
  }

  // 报告进度：开始读取
  if (onProgress) onProgress(0);

  const ext = extname(filePath).toLowerCase();
  const fileName = originalFileName || basename(filePath);

  // 1. 选择解析器
  //    .azw3 → KF8 格式（Kindle Format 8）
  //    .mobi / .azw → 用 isKf8Format 快速检测是否 KF8（只读 record 0，~1ms）
  //    性能优化（B-88）：避免无用的 initMobiFile（~1.7s），KF8 文件直接 initKf8File
  let parser: Mobi | Kf8;
  try {
    // parseMobi 不需要提取图片，传入临时目录避免污染工作目录
    const parseImageDir = join(tmpdir(), 'mobi-parse-images');
    parser = await selectMobiParser(filePath, ext, parseImageDir);
  } catch (err) {
    throw new MobiParseError(`MOBI 解析失败: ${(err as Error).message}`, err as Error);
  }

  // 报告进度：解析器已初始化，开始提取元数据
  if (onProgress) onProgress(0.2);

  // 漫画检测标志（默认非漫画）
  let isComic = false;
  // v21：全书 content_type 三分类
  let contentType: 'text' | 'illustrated' | 'comic' = 'text';

  try {
    // 2. 提取元数据
    let meta: { title?: string; author?: string[] | string; description?: string } | undefined;
    try {
      meta = parser.getMetadata();
    } catch {
      // 元数据提取失败不致命，用文件名兜底
      meta = undefined;
    }

    let { title, author, description } = extractMobiMeta(meta, fileName);

    // EXTH 二进制兜底：当库返回的 description 为空时，直接从 EXTH 提取
    // 某些 MOBI 文件的 EXTH 有 description 但库未正确解析
    if (!description) {
      const exthMeta = await extractMobiExthMeta(filePath);
      if (!description && exthMeta.description) description = exthMeta.description;
      // title/author 也兜底（库返回空时）
      if (!title || title === parseMobiFileNameTitle(fileName)) {
        if (exthMeta.title) title = exthMeta.title;
      }
      if (!author || author === '未知') {
        if (exthMeta.author) author = exthMeta.author;
      }
    }

    // 报告进度：元数据已提取，开始提取章节
    if (onProgress) onProgress(0.4);

    // 3. 章节结构策略（分层兜底）
    //    a. 优先用 MOBI 自带 spine + toc 章节结构
    //    b. spine 无效 → 合并全文用正则分章
    //    c. 正则分章也为空 → 按字数均分

    // 先尝试用 spine 结构
    let chapters: ChapterIndex[] = [];
    let chapterTexts: string[] = [];

    // 提取全文文本（用于正则分章兜底和计算偏移）
    let fullText = '';

    const spineResult = extractChaptersFromSpine(parser);
    if (spineResult) {
      chapters = spineResult.chapters;
      chapterTexts = spineResult.chapterTexts;

      // v21 三分类检测（性能优化 B-88）：
      // 优先使用 extractChaptersFromSpine 的检测结果（纯图片章节 → comic），
      // 否则用 chapterContentTypes 按全书规则判定，不再调用 detectMobiComic 重复 loadChapter
      if (spineResult.isComic) {
        isComic = true;
        contentType = 'comic';
        chapters.forEach((ch) => {
          ch.contentType = 'image';
        });
      } else if (spineResult.chapterContentTypes) {
        // v25 多维度三分类判定（基于54维特征分析 + 高文字+少图强制text）
        // 旧方案仅用 imageChapterCount/total > 0.5 单一阈值
        // v22方案：增加 totalTextLength 维度，区分纯漫画/图文/纯文本
        //   - 漫画（火影/城市猎人）：0文字 + 100%图片章 → comic
        //   - 图文（有趣的数学故事）：67K文字 + 36%图文章 → illustrated
        //   - 纯文本（Gutenberg小说）：大量文字 + 0图片 → text
        // v25改进：
        //   问题1: 数学故事书被误判illustrated — acpp=12000, img=4, parser标了illustrated章节
        //   根因: 高文字+少图的书不应该有illustrated章节，但逐章检测时因为有图片就标了illustrated
        //   修复: 高文字+少图强制text（totalTextLength>50000且imageCount<10→text）
        //   修正illustrated章节判定: 全书acpp>3000时，即使章节有图片也标text而非illustrated
        const types = spineResult.chapterContentTypes;
        let imageChapterCount = 0;
        let illustratedChapterCount = 0;
        for (const t of types) {
          if (t === 'image') imageChapterCount++;
          else if (t === 'illustrated') illustratedChapterCount++;
        }
        const total = types.length;
        const imageRatio = imageChapterCount / total;
        const illustratedRatio = illustratedChapterCount / total;
        // 计算总文字量（多维度关键特征，区分漫画与图文）
        const totalTextLength = chapterTexts.reduce((sum, t) => sum + t.length, 0);

        // v25: 修正illustrated章节判定 — 高文字+少图时，强制将illustrated章节改为text
        // v35: 移除该规则 — 问题: 数学故事书(67K文字+4个有图章节)被强制判text，但用户说是图文书
        //      根因: avgCharsPerPage>3000 && totalImageCount<10 → 强制text太粗暴
        //      修复: 让多维度规则自然判定，不强制覆盖illustrated章节

        // 逐章设置 content_type
        chapters.forEach((ch) => {
          ch.contentType = types[ch.index] ?? 'text';
        });
        // v25 多维度全书判定
        // v35: 移除"高文字+少图强制text"规则
        //   问题: 数学故事书(67K文字+4个有图章节)被强制判text，但用户说是图文书
        //   根因: totalTextLength>50000 && totalImageCount<10 → 强制text太粗暴
        //   修复: 让多维度规则自然判定，不强制覆盖
        if (totalTextLength < 1000 && imageRatio > 0.3) {
          // 文字极少 + 图片章节占比高 → comic（漫画书每页1图0文字）
          isComic = true;
          contentType = 'comic';
        } else if (totalTextLength > 5000) {
          // 全书有大量文字 → 不可能是漫画
          if (illustratedRatio >= 0.1 || imageChapterCount > 0) {
            contentType = 'illustrated';
          } else {
            contentType = 'text';
          }
        } else if (imageRatio > 0.5) {
          // 图片章节占比高 → comic
          isComic = true;
          contentType = 'comic';
        } else if (illustratedRatio > 0.3) {
          contentType = 'illustrated';
        } else {
          contentType = 'text';
        }
      }
    } else {
      // spine 无效，合并全文用正则分章
      // 遍历所有 spine 项，合并 HTML 转文本
      const spine = parser.getSpine();
      const parts: string[] = [];
      for (const ch of spine) {
        try {
          const result = parser.loadChapter(ch.id);
          if (result && result.html) {
            parts.push(htmlToText(result.html));
          }
        } catch (err) {
          // P0-11修复：输出警告而非静默跳过，避免 totalTextLength 静默为 0
          console.warn(`[mobi] spine无效兜底: 章节 ${ch.id} 加载失败:`, err);
        }
      }
      fullText = parts.join('\n\n');

      // P0-11修复：如果全文为空但spine不为空，输出警告
      if (fullText.length === 0 && spine.length > 0) {
        console.warn(`[mobi] spine无效兜底: 全文为空（${spine.length} 个spine项全部加载失败），totalTextLength 将为 0`);
      }

      // 二进制直接提取兜底：
      // 当库返回的 spine 内容很短（<500字节）时，说明库未能正确解析
      // （如 KF8 格式的 .mobi 文件，库提示"Please change the file extension to .azw3"）
      // 直接从 MOBI 二进制读取所有 record，用 PalmDOC 解压合并
      if (fullText.length < 500) {
        const binaryHtml = await extractMobiBinaryRecords(filePath);
        if (binaryHtml.length > fullText.length) {
          // 二进制提取成功且内容更长，用二进制结果
          // 先用 htmlToText 清洗 HTML，再作为全文
          fullText = htmlToText(binaryHtml);
        }
      }

      // 报告进度：全文已提取，开始分章
      if (onProgress) onProgress(0.6);

      // b. 用正则分章
      const regexResult = splitChaptersByRegex(fullText);
      if (regexResult.chapters.length > 0) {
        chapters = regexResult.chapters;
        chapterTexts = regexResult.chapterTexts;
      } else {
        // c. 正则分章也为空 → 按字数均分
        const fallback = fallbackMobiChunk(fullText, 3000);
        chapters = fallback.chapters;
        chapterTexts = fallback.chapterTexts;
      }
    }

    // 报告进度：章节已建立，开始去重和清洗
    if (onProgress) onProgress(0.8);

    // 4. 章节去重 + 过滤过短章节 + 合并相邻同名章节
    //    漫画模式跳过"过滤过短章节"逻辑（漫画章节文本为空但含图片）
    const deduplicated = deduplicateMobiChapters(chapters, chapterTexts, isComic);
    chapters = deduplicated.chapters;
    chapterTexts = deduplicated.chapterTexts;

    // 5. 清洗章节正文（复用 TXT 的 cleanContent：合并空行、统一缩进、去广告）
    const cleanedTexts = chapterTexts.map((text) => cleanContent(text));

    // 6. 缓存章节正文到内存（供 readChapter 使用）
    setMobiCache(filePath, { chapterTexts: cleanedTexts });

    // 报告进度：完成
    if (onProgress) onProgress(1);

    // MOBI 提取的文本固定为 UTF-8
    const mobiTotalText = cleanedTexts.reduce((sum, t) => sum + t.length, 0);
    const mobiImageCount = chapters.filter(
      (ch) => ch.contentType === 'image' || ch.contentType === 'illustrated'
    ).length;
    // P0-11修复：MOBI totalTextLength 为 0 但不是纯漫画时，输出警告
    if (mobiTotalText === 0 && !isComic && chapters.length > 0) {
      console.warn(`[mobi] totalTextLength=0 但非漫画（${chapters.length} 章），可能存在文本提取静默失败`);
    }
    return {
      encoding: 'UTF-8',
      title,
      author,
      description,
      chapters,
      isComic,
      contentType,
      contentFeatures: { totalTextLength: mobiTotalText, pageCount: chapters.length, imageCount: mobiImageCount }
    };
  } finally {
    // 释放解析器资源
    try {
      parser.destroy();
    } catch {
      // destroy 失败不致命
    }
  }
}

/**
 * 按需读取章节正文
 *
 * MOBI 不支持按需读取，从内存缓存中按章节索引返回内容。
 * 若缓存未命中（如应用重启后），重新解析整个 MOBI 并缓存。
 *
 * 图片保留：如果传入 imageDir 且章节内容包含 [IMG:...] 占位标记，
 * 会调用 readMobiChapterImages 提取图片到磁盘，
 * 然后按顺序替换占位标记为 [IMG:file:///本地绝对路径]，
 * 供前端渲染时替换为 <img> 元素显示。
 *
 * @param filePath 文件路径
 * @param chapter 章节索引（含 fileOffset + fileLength）
 * @param imageDir 图片保存目录（绝对路径，可选）。传入则提取图片并替换占位标记
 * @returns 章节正文（已清洗，可能包含 [IMG:file:///...] 图片占位标记）
 * @throws MobiParseError 缓存未命中且重新解析失败
 */
export async function readMobiChapter(
  filePath: string,
  chapter: ChapterIndex,
  imageDir?: string | null
): Promise<string> {
  // 1. 检查缓存
  const cached = getMobiCache(filePath);
  let content: string;
  if (cached) {
    // 从章节正文数组按索引返回
    if (chapter.index >= 0 && chapter.index < cached.chapterTexts.length) {
      content = cached.chapterTexts[chapter.index];
    } else {
      // P1-23修复: 索引越界时输出警告而非静默返回空字符串
      console.warn(
        `[readMobiChapter] 章节索引越界: index=${chapter.index}, chapterTexts.length=${cached.chapterTexts.length}`
      );
      return '';
    }
  } else {
    // 2. 缓存未命中，重新解析整个 MOBI
    //    MOBI 格式固有限制：不支持按需读取，必须重新提取全文
    try {
      await parseMobi(filePath);
    } catch (err) {
      throw new MobiParseError(`缓存未命中且重新解析失败: ${(err as Error).message}`, err as Error);
    }

    // 3. 重新解析后缓存已写入，再次取缓存
    const recached = getMobiCache(filePath);
    if (recached) {
      if (chapter.index >= 0 && chapter.index < recached.chapterTexts.length) {
        content = recached.chapterTexts[chapter.index];
      } else {
        // P1-23修复: 重新解析后索引仍越界，输出警告
        console.warn(
          `[readMobiChapter] 重新解析后章节仍越界: index=${chapter.index}, chapterTexts.length=${recached.chapterTexts.length}`
        );
        return '';
      }
    } else {
      // P1-23修复: 重新解析后缓存仍未命中，输出警告
      console.warn(`[readMobiChapter] 重新解析后缓存仍未命中: filePath=${filePath}`);
      return '';
    }
  }

  // 4. 如果有 imageDir 且内容包含图片占位标记，提取图片并替换为本地路径
  if (imageDir && content.includes('[IMG:')) {
    try {
      const imagePaths = await readMobiChapterImages(filePath, chapter, imageDir);
      // 按顺序替换占位标记：[IMG:原始src] → [IMG:file:///本地路径]
      // htmlToText 中图片按先 <img> 后 <image> 顺序保留占位标记，
      // readMobiChapterImages 也按相同顺序返回路径，所以顺序一致
      let imgIdx = 0;
      content = content.replace(/\[IMG:[^\]]+\]/g, () => {
        if (imgIdx < imagePaths.length) {
          const localPath = imagePaths[imgIdx++];
          // P0-1修复：改用 pathToFileURL 自动编码特殊字符（中文/空格等），避免手动拼接
          const fileUrl = pathToFileURL(localPath).toString();
          return `[IMG:${fileUrl}]`;
        }
        return ''; // 路径用完，去掉占位标记
      });
    } catch (err) {
      // 图片提取失败，去掉占位标记（保留纯文字内容）
      console.warn('[mobi] 提取章节图片失败，去掉图片占位标记:', err);
      content = content.replace(/\[IMG:[^\]]+\]/g, '');
    }
  }

  return content;
}

/* ==================== 漫画图片提取 ==================== */

/**
 * 读取 MOBI 图片章节，提取图片到指定目录
 *
 * 流程：
 * 1. 确保 imageDir 目录存在
 * 2. 根据扩展名选择 initMobiFile 或 initKf8File，传入 imageDir 作为 resourceSaveDir
 *    （解析器会把图片资源保存到该目录，HTML 中的 <img src> 替换为本地文件路径）
 * 3. 通过 chapter.url（spine id）调用 loadChapter 获取 HTML
 * 4. 解析 HTML 中所有 <img src="..."> 的 src 属性
 * 5. 本地文件路径直接收集；data URI 解码后写入文件
 * 6. 返回所有图片文件的绝对路径列表
 * 7. 最后调用 parser.destroy() 释放资源
 *
 * @param filePath MOBI 文件路径
 * @param chapter 章节索引（url 字段存的是 spine id）
 * @param imageDir 图片保存目录（绝对路径）
 * @returns 图片文件路径列表（绝对路径）
 * @throws MobiParseError 解析失败或 chapter.url 无效
 */
export async function readMobiChapterImages(
  filePath: string,
  chapter: ChapterIndex,
  imageDir: string
): Promise<string[]> {
  // chapter.url 必须有 spine id
  // 注意：url 可能是数字 0（spine id），不能用 !chapter.url 判断（0 是 falsy）
  if (chapter.url == null || chapter.url === '') {
    throw new MobiParseError('漫画章节缺少 spine id（chapter.url 为空）');
  }

  // 1. 确保 imageDir 目录存在
  await fsPromises.mkdir(imageDir, { recursive: true });

  // 2. 选择解析器，传入 imageDir 作为 resourceSaveDir
  //    性能优化（B-88）：用 selectMobiParser 避免无用的双重初始化
  const ext = extname(filePath).toLowerCase();
  let parser: Mobi | Kf8;
  try {
    parser = await selectMobiParser(filePath, ext, imageDir);
  } catch (err) {
    throw new MobiParseError(`MOBI 图片解析失败: ${(err as Error).message}`, err as Error);
  }

  try {
    // 3. 通过 spine id 调用 loadChapter 获取 HTML
    // 注意：loadChapter 接收 string 类型，chapter.url 从数据库读取可能是数字，需转为 string
    const result = parser.loadChapter(String(chapter.url));
    if (!result || !result.html) {
      return [];
    }

    const html = result.html;

    // 4. 解析所有图片标签的 src 属性
    // 检测多种格式：<img src="...">、<image xlink:href="...">、<image href="...">
    // 不要求 <img 后有空白，兼容 <img/> 和 <img src=...>
    // P2-1修复：增加 <picture>/<source srcset> 收集，避免响应式图片丢失
    const imgRegex = /<img[^>]*src=["']([^"']+)["'][^>]*>/gi;
    const imageRegex = /<image\s[^>]*(?:xlink:href|href)=["']([^"']+)["'][^>]*>/gi;
    const imagePaths: string[] = [];
    let match: RegExpExecArray | null;
    let imgIndex = 0;

    // 收集所有图片 src（合并 <img> 和 <image> 标签的结果）
    const allSrcs: string[] = [];
    while ((match = imgRegex.exec(html)) !== null) {
      allSrcs.push(match[1]);
    }
    while ((match = imageRegex.exec(html)) !== null) {
      allSrcs.push(match[1]);
    }
    // P2-1修复：收集 <source srcset> 中的所有 URL
    allSrcs.push(...extractSourceSrcsetUrls(html));

    for (const src of allSrcs) {
      imgIndex++;

      if (src.startsWith('data:image/')) {
        // 5a. data URI：解码并写入文件
        const dataUriMatch = src.match(/^data:image\/(\w+);base64,(.+)$/);
        if (dataUriMatch) {
          const format = dataUriMatch[1];
          const base64Data = dataUriMatch[2];
          const buffer = Buffer.from(base64Data, 'base64');
          const fileName = `img_${chapter.index}_${imgIndex}.${format}`;
          const fullPath = join(imageDir, fileName);
          await fsPromises.writeFile(fullPath, buffer);
          imagePaths.push(fullPath);
        }
      } else if (/^https?:\/\//i.test(src)) {
        // P2-4修复：CDN/远程 URL 保留为占位标记，前端可直接加载
        // 原代码仅处理本地路径，导致 CDN 图片（如 https://cdn.example.com/...）被丢弃。
        imagePaths.push(src);
      } else {
        // 5b. 本地文件路径（resourceSaveDir 模式下解析器已替换为本地路径）
        // src 可能是相对路径或绝对路径，统一转为绝对路径
        if (src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src)) {
          imagePaths.push(src);
        } else {
          const safePath = join(imageDir, src);
          const resolvedSafe = resolve(safePath);
          const resolvedDir = resolve(imageDir);
          if (resolvedSafe.startsWith(resolvedDir + sep) || resolvedSafe === resolvedDir) {
            imagePaths.push(safePath);
          } else {
            imagePaths.push(join(imageDir, basename(src)));
          }
        }
      }
    }

    return imagePaths;
  } catch (err) {
    throw new MobiParseError(`读取 MOBI 章节图片失败: ${(err as Error).message}`, err as Error);
  }
  // 注意：不调用 parser.destroy()
  // @lingo-reader/mobi-parser 的 destroy() 会删除所有已提取到磁盘的图片文件（resourceCache 中的文件）
  // 如果在这里调用 destroy()，刚提取的图片会被立即删除，前端收到路径但文件已不存在
  // 解析器对象会被 GC 自动回收，图片文件保留在磁盘上供后续加载
}

/* ==================== MobiParser 类（实现 FileParser 接口） ==================== */

/**
 * MOBI 解析器类，实现 FileParser 接口
 *
 * 上层通过 FileParser 接口统一调用，无需关心具体格式。
 * 内部用静态 Map 缓存 parse 时提取的全文文本，供 readChapter 使用。
 *
 * 注意：MOBI 不支持按需读取，parse 时一次性提取全文并缓存到内存。
 * 若应用重启后缓存丢失，readChapter 会重新解析整个 MOBI。
 */
export class MobiParser implements FileParser {
  async parse(filePath: string, onProgress?: (p: number) => void, originalFileName?: string): Promise<ParsedBook> {
    return parseMobi(filePath, onProgress, originalFileName);
  }

  async readChapter(filePath: string, chapter: ChapterIndex, imageDir?: string): Promise<string> {
    return readMobiChapter(filePath, chapter, imageDir);
  }

  /**
   * 读取漫画章节的图片列表
   *
   * 对于漫画（图片为主的书），提取章节中的所有图片到指定目录，
   * 返回图片文件绝对路径列表。
   *
   * @param filePath MOBI 文件路径
   * @param chapter 章节索引（url 字段存的是 spine id）
   * @param imageDir 图片保存目录（绝对路径）
   * @returns 图片文件路径列表（绝对路径）
   */
  async readChapterImages(filePath: string, chapter: ChapterIndex, imageDir: string): Promise<string[]> {
    return readMobiChapterImages(filePath, chapter, imageDir);
  }
}

/* ==================== pdf-parser.ts（PDF解析器） ==================== */
/**
 * PDF 解析器
 *
 * 核心设计：PDF 不支持流式按需读取，parse 时一次性提取全文文本并缓存到内存，
 * readChapter 时从内存缓存按章节偏移返回内容。
 *
 * 功能模块：
 * 1. 用 pdf-parse（基于 pdfjs-dist）提取 PDF 全文文本（含每页文本）
 * 2. 提取元数据：PDF Info 字典的 Title / Author / Subject
 * 3. 分章（三级策略，按优先级）：
 *    a. PDF outline（书签/目录）分章 —— 最精确，章节标题来自 PDF 元数据
 *    b. 按行扫描全文，用 chapter-patterns 正则库分章（复用 TXT 分章逻辑）
 *    c. 按页数均分（每 20 页一章）—— 兜底
 * 4. 章节正文缓存到内存（PDF 通常不大，单本几十 MB 以内）
 * 5. 内容清洗（复用 TXT 的 cleanContent：合并空行、统一缩进、去广告）
 * 6. 漫画检测：平均每页文本 < 50 字符 → 漫画，每页作为一个图片章节
 * 7. 封面提取：用 pdf-parse 的 getScreenshot() 渲染第一页为图片（PNG/JPEG）
 *
 * 导出：
 * - parsePdf(filePath, onProgress?): Promise<ParsedBook>
 * - readPdfChapter(filePath, chapter): Promise<string>
 * - extractPdfCover(filePath, destPath): Promise<string | null>  封面提取
 * - PdfParser 类（实现 FileParser 接口）
 * - closeAllPdfCaches(): void（应用退出时清理缓存）
 */

/* ==================== 错误定义 ==================== */

/** PDF 解析自定义错误（友好提示 + 保留原始 cause） */
