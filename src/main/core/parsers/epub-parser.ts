/**
 * EPUB 解析器
 *
 * 从 file-parser.ts 拆分而来。
 */

import { promises as fsPromises, existsSync, writeFileSync } from 'fs';
import { basename, extname, dirname, join } from 'path';
import { pathToFileURL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import StreamZip from 'node-stream-zip';
import { convertSemanticHtmlToMarkers } from '../../utils';
import type { ChapterIndex, FileParser, EpubParsedBook, HtmlToPlainTextOptions } from './types';
import { cleanContent, detectParseMode } from './txt-parser';
import { splitChaptersByRegex } from './mobi-parser';

/* ==================== 错误定义 ==================== */

/** EPUB 解析自定义错误（友好提示 + 保留原始 cause） */
export class EpubParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'EpubParseError';
  }
}

/* ==================== XML 解析 ==================== */

/**
 * fast-xml-parser 配置：
 * - ignoreAttributes: false（OPF/NCX 大量使用属性，如 idref/href）
 * - attributeNamePrefix: '@_'（属性名加前缀，避免与子元素名冲突）
 * - removeNSPrefix: true（去掉命名空间前缀，如 dc: → dc、opf: → opf）
 *   注意：removeNSPrefix 只去掉前缀不保留，所以 dc:title → title
 */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (tagName: string): boolean => {
    // 这些标签在 OPF/NCX/nav 中可能多次出现，强制为数组
    const arrayTags = new Set([
      'item', // OPF manifest item
      'itemref', // OPF spine itemref
      'navPoint', // NCX navPoint
      'meta', // OPF metadata meta
      'navLabel', // NCX navLabel
      'navTarget', // NCX navTarget
      'a', // nav.xhtml 锚点
      'li' // nav.xhtml 列表项
    ]);
    return arrayTags.has(tagName);
  }
});

/** 解析 XML 字符串为 JSON 对象 */
function parseXml(xml: string): Record<string, unknown> {
  return xmlParser.parse(xml) as Record<string, unknown>;
}

/** 将值规范为数组（fast-xml-parser 单元素时不返回数组） */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** 安全取对象字段 */
function getField<T = unknown>(obj: unknown, key: string): T | undefined {
  if (obj && typeof obj === 'object') {
    return (obj as Record<string, T>)[key];
  }
  return undefined;
}

/* ==================== EPUB ZIP 操作封装 ==================== */

/** EPUB ZIP 句柄封装，提供同步 entry 读取 */
interface EpubZip {
  /** 读取指定 entry 为字符串（UTF-8） */
  entryString(entryName: string): Promise<string>;
  /** 读取指定 entry 为 Buffer */
  entryBuffer(entryName: string): Promise<Buffer>;
  /** 解压指定 entry 到文件 */
  extract(entryName: string, destPath: string): Promise<number | undefined>;
  /** 列出所有 entry */
  entries(): Record<string, { name: string; size: number; compressedSize: number }>;
  /** 关闭 ZIP */
  close(): void;
}

/** 打开 EPUB ZIP 文件 */
async function openEpub(filePath: string): Promise<EpubZip> {
  return new Promise<EpubZip>((resolve, reject) => {
    // StreamZip.async 是异步 API 类（node-stream-zip 静态属性）
    const zip = new StreamZip.async({ file: filePath });
    // node-stream-zip 的 entries() 可确认文件有效
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
      .catch((err: Error) => reject(new EpubParseError(`打开 EPUB 失败: ${err.message}`, err)));
  });
}

/* ==================== EPUB ZIP 句柄 LRU 缓存 ==================== */

/**
 * P0-2 优化：EPUB ZIP 句柄 LRU 缓存
 *
 * 问题：readEpubChapter 每次都 openEpub → new StreamZip，读完 close()。
 *       翻页时反复打开/关闭同一个 EPUB，开销大。
 *
 * 方案：用 LRU Map 缓存 {filePath → EpubZip} 句柄，限制 EPUB_ZIP_CACHE_MAX 本常驻。
 *       - JS Map 按插入顺序遍历，最旧在首位
 *       - get 命中时 delete+set 刷新为最近使用
 *       - 超限时 delete 最旧的并 close()
 *       - readEpubChapter 不再每次 close，由 LRU 淘汰时 close
 */

/** ZIP 句柄缓存最大数量（限制同时常驻的 EPUB 句柄数，覆盖用户在多本书间快速切换场景） */
const EPUB_ZIP_CACHE_MAX = 3;

/** LRU 缓存：filePath → EpubZip（JS Map 按插入顺序遍历，最旧在首位） */
export const epubZipCache = new Map<string, EpubZip>();

/**
 * 获取 EPUB ZIP 句柄（带 LRU 缓存）
 *
 * 翻页时复用已打开的 ZIP 句柄，避免反复 open/close。
 * 调用方不要 close 返回的句柄，由 LRU 淘汰或 closeAllEpubCaches 统一 close。
 *
 * @param filePath EPUB 文件路径
 * @returns EpubZip 句柄
 */
async function getEpubZip(filePath: string): Promise<EpubZip> {
  const cached = epubZipCache.get(filePath);
  if (cached) {
    // 命中：刷新为最近使用（delete+set 改变 Map 插入顺序）
    epubZipCache.delete(filePath);
    epubZipCache.set(filePath, cached);
    return cached;
  }

  // 未命中：打开并存入缓存
  const zip = await openEpub(filePath);
  epubZipCache.set(filePath, zip);

  // 超限淘汰最旧句柄（Map 首项 = 最久未使用）
  if (epubZipCache.size > EPUB_ZIP_CACHE_MAX) {
    const oldestKey = epubZipCache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = epubZipCache.get(oldestKey);
      epubZipCache.delete(oldestKey);
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
 * 关闭所有缓存的 EPUB ZIP 句柄
 *
 * 应用退出时调用，释放所有常驻 ZIP 文件句柄。
 */
export function closeAllEpubCaches(): void {
  for (const zip of epubZipCache.values()) {
    try {
      zip.close();
    } catch {
      // close 失败忽略
    }
  }
  epubZipCache.clear();
}

/* ==================== OPF 解析 ==================== */

/** OPF manifest item */
interface OpfItem {
  id: string;
  href: string;
  mediaType: string;
  /** EPUB3 properties（如 cover-image） */
  properties?: string;
}

/** OPF 解析结果 */
interface OpfResult {
  /** 书名 */
  title: string;
  /** 作者 */
  author: string;
  /** 简介（dc:description） */
  description: string;
  /** manifest items（id → item） */
  manifest: Map<string, OpfItem>;
  /** spine itemref idref 顺序 */
  spine: string[];
  /** NCX 文件 href（EPUB2） */
  ncxHref: string | null;
  /** nav 文件 href（EPUB3） */
  navHref: string | null;
  /** 封面图片 href（来自 metadata properties 或 meta name="cover"） */
  coverHref: string | null;
  /** guide 中 type="cover" 的 href（可能是封面页 HTML，需进一步解析 <img>） */
  guideCoverHref: string | null;
  /** OPF 文件所在目录（用于解析相对路径） */
  opfDir: string;
  /** 是否声明为漫画（OPF meta name="comic" content="true" 或 primary-writing-mode） */
  isComicDeclared: boolean;
  /** 是否为固定布局 EPUB（rendition:layout=pre-paginated 或 fixed-layout=true） */
  isFixedLayout: boolean;
}

/**
 * 解析 OPF 文件
 *
 * @param zip EPUB ZIP 句柄
 * @param opfPath OPF 文件在 ZIP 中的 entry name
 */
async function parseOpf(zip: EpubZip, opfPath: string): Promise<OpfResult> {
  const opfXml = await zip.entryString(opfPath);
  const opf = parseXml(opfXml);

  // OPF XML 根元素是 <package>，fast-xml-parser 会将其解析为 { package: { ... } }
  // 需要先获取 package 子对象，再从中提取 metadata/manifest/spine
  const pkg = getField<Record<string, unknown>>(opf, 'package') ?? opf;

  const opfDir = dirname(opfPath);

  // === metadata ===
  const metadata = getField(pkg, 'metadata') ?? {};
  // dc:title 可能是字符串或数组
  const titleRaw = getField<string | string[]>(metadata, 'title');
  const title = (Array.isArray(titleRaw) ? titleRaw[0] : titleRaw) ?? '';
  // dc:creator 可能是字符串、数组或带属性的对象
  const creatorRaw = getField<string | string[] | Record<string, unknown> | Record<string, unknown>[]>(
    metadata,
    'creator'
  );
  const author = extractCreator(creatorRaw);
  // dc:description 可能是字符串或带属性的对象
  const descriptionRaw = getField<string | Record<string, unknown>>(metadata, 'description');
  const description = extractDescription(descriptionRaw);

  // === manifest ===
  const manifestEl = getField(pkg, 'manifest') ?? {};
  const items = toArray<Record<string, unknown>>(getField(manifestEl, 'item'));
  const manifest = new Map<string, OpfItem>();
  for (const item of items) {
    const id = getField<string>(item, '@_id');
    const href = getField<string>(item, '@_href');
    const mediaType = getField<string>(item, '@_media-type') ?? '';
    const properties = getField<string>(item, '@_properties');
    if (id && href) {
      manifest.set(id, { id, href, mediaType, properties });
    }
  }

  // === spine ===
  const spineEl = getField(pkg, 'spine') ?? {};
  const itemrefs = toArray<Record<string, unknown>>(getField(spineEl, 'itemref'));
  const spine: string[] = [];
  for (const itemref of itemrefs) {
    const idref = getField<string>(itemref, '@_idref');
    if (idref) spine.push(idref);
  }

  // === 找 NCX（EPUB2）和 nav（EPUB3）===
  let ncxHref: string | null = null;
  let navHref: string | null = null;
  for (const item of manifest.values()) {
    if (item.mediaType === 'application/x-dtbncx+xml') {
      ncxHref = item.href;
    }
    if (item.properties && item.properties.includes('nav')) {
      navHref = item.href;
    }
  }

  // === 找封面 ===
  let coverHref: string | null = null;
  // 方式1：EPUB3 properties="cover-image"
  for (const item of manifest.values()) {
    if (item.properties && item.properties.includes('cover-image')) {
      coverHref = item.href;
      break;
    }
  }
  // 方式2：EPUB2 meta name="cover" content="cover-id"
  if (!coverHref) {
    const metas = toArray<Record<string, unknown>>(getField(metadata, 'meta'));
    for (const meta of metas) {
      const name = getField<string>(meta, '@_name');
      const content = getField<string>(meta, '@_content');
      if (name === 'cover' && content) {
        const coverItem = manifest.get(content);
        if (coverItem) {
          coverHref = coverItem.href;
          break;
        }
      }
    }
  }

  // === 找 guide 封面页（EPUB2 <guide><reference type="cover" href="..."/></guide>）===
  // guide reference 的 href 通常是封面页 HTML（不是图片），需后续读 HTML 找 <img>
  let guideCoverHref: string | null = null;
  const guideEl = getField(pkg, 'guide');
  if (guideEl) {
    const references = toArray<Record<string, unknown>>(getField(guideEl, 'reference'));
    for (const ref of references) {
      const type = getField<string>(ref, '@_type');
      const href = getField<string>(ref, '@_href');
      if (type && href && (type === 'cover' || type.includes('cover'))) {
        guideCoverHref = href;
        break;
      }
    }
  }

  // === 检测 OPF 中的漫画标记 ===
  // 导出 EPUB 漫画时写入 <meta name="comic" content="true"/>，
  // 导入时即使图片检测失败也能通过此标记识别漫画
  let isComicDeclared = false;
  const metasForComic = toArray<Record<string, unknown>>(getField(metadata, 'meta'));
  for (const meta of metasForComic) {
    const name = getField<string>(meta, '@_name');
    const content = getField<string>(meta, '@_content');
    if (name === 'comic' && content === 'true') {
      isComicDeclared = true;
      break;
    }
    // 部分漫画 EPUB 用 primary-writing-mode 标记
    if (name === 'primary-writing-mode' && content) {
      // horizontal/vertical 都可能是漫画，但不完全可靠，只作辅助
      // 不直接设 isComicDeclared，留给图片检测
    }
  }

  // === 检测固定布局 EPUB（对标 Apple Books）===
  // 固定布局 EPUB（绘本/画册）每页是固定尺寸的图片，需保留原始 HTML 排版。
  // 检测方式（按优先级）：
  // 1. <meta name="fixed-layout" content="true"/>（Apple Books/KEP 约定）
  // 2. <meta property="rendition:layout">pre-paginated</meta>（EPUB3 标准）
  // 3. <meta property="rendition:layout">rendition:layout-pre-paginated</meta>（部分工具变体）
  let isFixedLayout = false;
  for (const meta of metasForComic) {
    const name = getField<string>(meta, '@_name');
    const content = getField<string>(meta, '@_content');
    const property = getField<string>(meta, '@_property');
    // 方式1：<meta name="fixed-layout" content="true"/>
    if (name === 'fixed-layout' && content === 'true') {
      isFixedLayout = true;
      break;
    }
    // 方式2/3：<meta property="rendition:layout">pre-paginated</meta>
    if (property === 'rendition:layout') {
      const value = getField<string>(meta, '#text');
      if (value === 'pre-paginated' || value === 'rendition:layout-pre-paginated') {
        isFixedLayout = true;
        break;
      }
    }
  }

  return {
    title: title || '',
    author: author || '未知',
    description: description || '',
    manifest,
    spine,
    ncxHref,
    navHref,
    coverHref,
    guideCoverHref,
    opfDir,
    isComicDeclared,
    isFixedLayout
  };
}

/** 从 dc:creator 提取作者名 */
function extractCreator(
  raw: string | string[] | Record<string, unknown> | Record<string, unknown>[] | undefined
): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    // 取第一个非空
    for (const item of raw) {
      const name = typeof item === 'string' ? item : extractCreatorFromObject(item);
      if (name) return name;
    }
    return '';
  }
  return extractCreatorFromObject(raw);
}

/** 从带属性的 creator 对象提取文本（fast-xml-parser 把 #text 存为属性） */
function extractCreatorFromObject(obj: Record<string, unknown>): string {
  // fast-xml-parser 的 parseTagValue: false 时，文本内容在 '#text' 字段
  const text = getField<string>(obj, '#text');
  if (text) return text;
  // 兜底：遍历找字符串值
  for (const value of Object.values(obj)) {
    if (typeof value === 'string') return value;
  }
  return '';
}

/**
 * 从 dc:description 提取简介文本
 *
 * dc:description 可能是：
 * - 字符串：直接返回
 * - 带 #text 属性的对象（fast-xml-parser parseTagValue: false 时）
 * - 数组：取第一个非空
 *
 * 同时清理 HTML 标签（部分 EPUB 的 description 含 <p> <br> 等标签）
 */
function extractDescription(raw: string | string[] | Record<string, unknown> | undefined): string {
  if (raw === undefined || raw === null) return '';
  let text = '';
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        text = item;
        break;
      }
      if (item && typeof item === 'object') {
        const t = getField<string>(item, '#text');
        if (t) {
          text = t;
          break;
        }
      }
    }
  } else if (typeof raw === 'object') {
    text = getField<string>(raw, '#text') ?? '';
  }
  // 清理 HTML 标签（description 可能含 <p> <br> 等）
  text = text
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-zA-Z]+;/g, ' ')
    .trim();
  return text;
}

/* ==================== 章节标题提取 ==================== */

/**
 * 解析 NCX 文件提取章节标题
 *
 * NCX 结构：
 * <navMap>
 *   <navPoint>
 *     <navLabel><text>章节标题</text></navLabel>
 *     <content src="chapter1.xhtml"/>
 *     <navPoint>...</navPoint>  <!-- 嵌套子章节 -->
 *   </navPoint>
 * </navMap>
 *
 * @returns Map<contentSrc, title>（contentSrc 是相对 OPF 目录的 href）
 */
async function parseNcx(zip: EpubZip, ncxPath: string): Promise<Map<string, string>> {
  const ncxXml = await zip.entryString(ncxPath);
  const ncx = parseXml(ncxXml);

  const result = new Map<string, string>();

  // 递归遍历 navPoint
  function walkNavPoints(navPoints: Record<string, unknown>[]): void {
    for (const navPoint of navPoints) {
      // navLabel > text
      const navLabels = toArray<Record<string, unknown>>(getField(navPoint, 'navLabel'));
      let title = '';
      for (const navLabel of navLabels) {
        const text = getField<string>(navLabel, 'text');
        if (text) {
          title = text;
          break;
        }
      }
      // content src
      const content = getField<Record<string, unknown>>(navPoint, 'content');
      const src = getField<string>(content, '@_src');
      if (src && title) {
        // src 可能带锚点（chapter1.xhtml#section1），取文件部分
        const filePart = src.split('#')[0];
        // 多个 navPoint 可能指向同一文件（如同一 HTML 内多个锚点），
        // 保留第一个（最外层/最先遍历的）标题，避免被内层标题覆盖
        if (filePart && !result.has(filePart)) {
          result.set(filePart, title);
        }
      }
      // 递归子 navPoint
      const children = toArray<Record<string, unknown>>(getField(navPoint, 'navPoint'));
      if (children.length > 0) {
        walkNavPoints(children);
      }
    }
  }

  const toc = getField(ncx, 'ncx') ?? ncx;
  const navMap = getField(toc, 'navMap') ?? {};
  const topNavPoints = toArray<Record<string, unknown>>(getField(navMap, 'navPoint'));
  walkNavPoints(topNavPoints);

  return result;
}

/**
 * 解析 nav.xhtml（EPUB3）提取章节标题
 *
 * nav.xhtml 结构：
 * <nav epub:type="toc">
 *   <ol>
 *     <li><a href="chapter1.xhtml">章节标题</a>
 *       <ol><li>...</li></ol>
 *     </li>
 *   </ol>
 * </nav>
 *
 * @returns Map<contentSrc, title>
 */
async function parseNav(zip: EpubZip, navPath: string): Promise<Map<string, string>> {
  let navXml: string;
  try {
    navXml = await zip.entryString(navPath);
  } catch {
    return new Map();
  }
  const nav = parseXml(navXml);

  const result = new Map<string, string>();

  // 递归遍历 ol > li > a
  function walkList(ol: Record<string, unknown> | undefined): void {
    if (!ol) return;
    const lis = toArray<Record<string, unknown>>(getField(ol, 'li'));
    for (const li of lis) {
      // a 标签
      const a = getField<Record<string, unknown>>(li, 'a');
      if (a) {
        const href = getField<string>(a, '@_href');
        // 文本内容在 '#text'
        const text = getField<string>(a, '#text');
        if (href && text) {
          const filePart = href.split('#')[0];
          if (filePart && !result.has(filePart)) {
            result.set(filePart, text);
          }
        }
      }
      // 递子列表
      const childOl = getField<Record<string, unknown>>(li, 'ol');
      if (childOl) walkList(childOl);
    }
  }

  // nav.xhtml 的根可能是 html > body > nav > ol
  const html = getField(nav, 'html') ?? nav;
  const body = getField(html, 'body') ?? {};
  const navs = toArray<Record<string, unknown>>(getField(body, 'nav'));
  for (const navEl of navs) {
    const ol = getField<Record<string, unknown>>(navEl, 'ol');
    walkList(ol);
  }

  return result;
}

/* ==================== 路径工具 ==================== */

/**
 * 解析 EPUB 内部相对路径为 ZIP entry name
 *
 * EPUB 内部 href 是相对 OPF 文件目录的路径，需要拼成 ZIP 内的绝对路径。
 * 例：opfDir="OEBPS"，href="chapter1.xhtml" → "OEBPS/chapter1.xhtml"
 * 例：opfDir="OEBPS"，href="../images/cover.jpg" → "images/cover.jpg"
 *
 * @param opfDir OPF 文件所在目录（ZIP 内路径）
 * @param href 相对 OPF 的 href
 * @returns ZIP entry name（正斜杠分隔）
 */
function resolveEpubPath(opfDir: string, href: string): string {
  // 统一用正斜杠
  const dir = opfDir.replace(/\\/g, '/');
  const ref = href.replace(/\\/g, '/');

  // P0-6修复：EPUB绝对路径解析错误
  // 以 '/' 开头的路径是 EPUB 绝对路径（相对于 EPUB 根目录/ZIP 根），
  // 不应拼接 opfDir/htmlDir，而应直接去掉前导斜杠作为 ZIP 内路径
  // 原代码将 "/images/cover.jpg" 拼接为 "OEBPS//images/cover.jpg"，导致找不到 entry
  if (ref.startsWith('/')) {
    return ref.slice(1);
  }

  if (dir === '' || dir === '.') {
    return ref;
  }

  // 拼接后规范化（处理 ../）
  const combined = `${dir}/${ref}`;
  const parts = combined.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) continue;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

/**
 * 将 HTML 内容转为纯文本
 *
 * 处理步骤：
 * 1. 去 <head>...</head>、<script>...</script>、<style>...</style>
 * 2. <br> / <br/> → 换行
 * 3. </p>、</div>、</h1>~</h6>、</li> → 段落换行
 * 4. 图片标签 → 占位标记（如果提供 replaceImage 回调）
 * 4.5 <figcaption> → 图片说明标记
 * 4.6 语义标签 → 富文本标记（CODE/QUOTE/TABLE/H1-H6/LI/加粗/斜体/链接）
 * 5. 去所有 HTML 标签
 * 6. 解码 HTML 实体（&amp; &lt; &gt; &nbsp; &#xxxx;）
 * 7. 合并连续空行（最多保留 1 个）
 * 8. 段落首行缩进（两个全角空格，图片/富文本块级标记行不缩进）
 * 9. 去首尾空行
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
 * @param html HTML 内容
 * @param options 选项（可选）：replaceImage 图片替换回调
 */
export function htmlToPlainText(html: string, options?: HtmlToPlainTextOptions): string {
  let text = html;

  // 0. 先去 HTML 注释和 CDATA，避免注释中的标签/实体干扰后续正则
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');

  // 1. 去非正文部分
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  // P0-5修复：CSS背景图完全丢失问题
  // 原代码直接删除 <style> 标签，导致 background-image:url(...) 中的图片引用丢失
  // 修复：在删除 <style> 标签前，先提取其中所有 url(...) 引用，
  //       通过 replaceImage 回调转换为本地路径，保留为 [IMG:file:///...] 占位标记
  const styleImageMarks: string[] = [];
  text = text.replace(/<style[\s\S]*?<\/style>/gi, (styleMatch) => {
    // 提取所有 url(...) 引用（background-image、list-style-image 等 CSS 图片引用）
    const urlRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
    let urlMatch: RegExpExecArray | null;
    while ((urlMatch = urlRegex.exec(styleMatch)) !== null) {
      const imgUrl = urlMatch[1];
      // 跳过 data: URL（内联 base64 图片，无需提取为文件）
      if (imgUrl.startsWith('data:')) continue;
      if (options?.replaceImage) {
        const localPath = options.replaceImage(imgUrl);
        if (localPath) {
          // P0-1修复：改用 pathToFileURL 自动编码特殊字符
          const fileUrl = pathToFileURL(localPath).toString();
          styleImageMarks.push(`\n\n[IMG:${fileUrl}]\n\n`);
        }
      } else {
        // 无 replaceImage 回调，保留原始 URL 为占位标记（避免图片完全丢失）
        styleImageMarks.push(`\n\n[IMG:${imgUrl}]\n\n`);
      }
    }
    return ''; // 删除 style 标签内容（URL 已提取为占位标记）
  });
  // 将提取的 CSS 背景图占位标记追加到文本（确保图片不丢失）
  if (styleImageMarks.length > 0) {
    text += styleImageMarks.join('');
  }

  // 2. <br> → 换行
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // 3. 块级元素闭合标签 → 换行
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n');
  // 块级元素开标签 → 换行（避免与上一行粘连）
  text = text.replace(/<(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n');

  // 4. 图片标签 → 占位标记（在去所有 HTML 标签前处理）
  //    用 \n 包围占位标记，确保图片独占一行，便于段落分割
  //    同时提取 <img alt="..."> 属性作为图片说明（对标 Apple Books）
  if (options?.replaceImage) {
    const replaceFn = options.replaceImage;
    // <img src="..."> — 同时提取 alt 属性作为图片说明
    text = text.replace(/<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi, (match, src: string) => {
      const localPath = replaceFn(src);
      if (localPath) {
        // P0-1修复：改用 pathToFileURL 自动编码特殊字符（中文/空格等），避免手动拼接
        const fileUrl = pathToFileURL(localPath).toString();
        // 提取 alt 属性作为图片说明（对标 Apple Books）
        const altMatch = match.match(/alt=["']([^"']*)["']/i);
        const alt = altMatch ? altMatch[1].trim() : '';
        if (alt) {
          return `\n\n[IMG:${fileUrl}]\n[图片说明：${alt}]\n\n`;
        }
        return `\n\n[IMG:${fileUrl}]\n\n`;
      }
      return '';
    });
    // SVG <image xlink:href="..."> 或 <image href="...">
    text = text.replace(/<image\s[^>]*(?:xlink:href|href)=["']([^"']+)["'][^>]*>/gi, (_match, src: string) => {
      const localPath = replaceFn(src);
      if (localPath) {
        // P0-1修复：改用 pathToFileURL 自动编码特殊字符（中文/空格等），避免手动拼接
        const fileUrl = pathToFileURL(localPath).toString();
        return `\n\n[IMG:${fileUrl}]\n\n`;
      }
      return '';
    });
    // P2-1修复：<picture><source srcset="..."> 响应式图片处理
    // 原代码未处理 <picture>/<source> 标签，导致 WebP/AVIF 等现代格式的响应式图片丢失。
    // 提取 <source srcset> 中的 URL，通过 replaceImage 回调转换为本地路径。
    // 策略：取 srcset 中第一个 URL（通常是基础分辨率，足够阅读）。
    text = text.replace(/<source\b[^>]*\ssrcset=["']([^"']+)["'][^>]*>/gi, (_match, srcset: string) => {
      const urls = extractUrlsFromSrcset(srcset);
      if (urls.length === 0) return '';
      // 取第一个 URL 作为代表（srcset 通常按分辨率升序排列，第一个足够阅读）
      const src = urls[0];
      const localPath = replaceFn(src);
      if (localPath) {
        const fileUrl = pathToFileURL(localPath).toString();
        return `\n\n[IMG:${fileUrl}]\n\n`;
      }
      return '';
    });
  }

  // P1-2修复：内联 SVG 矢量图形保留
  // 问题：<svg><path d="..."/></svg> 等内联矢量图形在去 HTML 标签时被丢弃
  // 修复：提取不含 <image> 子标签的内联 <svg>，通过回调保存为 .svg 文件或保留为 HTML
  //   - 含 <image> 子标签的 SVG 已在上面处理（引用外部图片）
  //   - 不含 <image> 的纯矢量 SVG（path/circle/rect/polygon 等）在此处理
  if (options?.replaceInlineSvg) {
    const replaceSvgFn = options.replaceInlineSvg;
    let svgIdx = 0;
    // 匹配所有 <svg>...</svg> 标签（非贪婪匹配，处理嵌套）
    text = text.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, (svgMatch) => {
      // 跳过含 <image> 子标签的 SVG（已由上面的 replaceImage 处理）
      if (/<image\s/i.test(svgMatch)) return svgMatch;
      // 调用回调保存内联 SVG
      const localPath = replaceSvgFn(svgMatch, svgIdx++);
      if (localPath) {
        // P0-1修复：改用 pathToFileURL 自动编码特殊字符
        const fileUrl = pathToFileURL(localPath).toString();
        return `\n\n[IMG:${fileUrl}]\n\n`;
      }
      // 回调返回 null：保留 SVG 原始 HTML（不丢失矢量图形信息）
      return svgMatch;
    });
  }

  // 4.5 <figcaption> → 图片说明标记（对标 Apple Books）
  //     <figure><img src="..."/><figcaption>说明文字</figcaption></figure>
  //     将 figcaption 文本转为 [图片说明：文字] 标记，在去所有 HTML 标签前处理
  //     无论是否提供 replaceImage，都保留 figcaption 文本（它是图片说明语义）
  text = text.replace(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi, (_match, content: string) => {
    // 先去除 figcaption 内嵌的 HTML 标签（如 <em> <strong> <br>）
    const figText = content.replace(/<[^>]+>/g, '').trim();
    if (figText) {
      return `\n[图片说明：${figText}]\n`;
    }
    return '';
  });

  // 4.6 语义标签 → 富文本标记（在去所有 HTML 标签前处理）
  //     保留代码块/引用/表格/加粗/斜体/链接/标题/列表等语义结构，
  //     转为不含尖括号的特殊标记，不受后续 text.replace(/<[^>]+>/g, '') 影响。
  //     标记格式与 [IMG:] 占位标记一致，用 \n 包围确保独占段落。
  text = convertSemanticHtmlToMarkers(text);

  // 4.7 保护 [TABLE]...[/TABLE] 内容中的 HTML 不被步骤5移除
  // convertSemanticHtmlToMarkers 把 <table> 转为 [TABLE]<table>...</table>[/TABLE]，
  // 但步骤5 text.replace(/<[^>]+>/g, '') 会移除 [TABLE] 内的 <table>/<tr>/<td> 等，
  // 导致表格结构丢失，只剩 [IMG:...] 等占位标记。提取为占位符，步骤5后还原。
  const tableContents: string[] = [];
  text = text.replace(/\[TABLE\]([\s\S]*?)\[\/TABLE\]/g, (_m, content: string) => {
    const idx = tableContents.length;
    tableContents.push(content);
    return `[TABLE]\x00TC${idx}\x00[/TABLE]`;
  });

  // 5. 去所有剩余 HTML 标签
  text = text.replace(/<[^>]+>/g, '');

  // 5.1 还原 [TABLE] 内容（恢复 <table>/<tr>/<td> 等 HTML 结构）
  text = text.replace(
    /\[TABLE\]\x00TC(\d+)\x00\[\/TABLE\]/g,
    (_m, idx: string) => `[TABLE]${tableContents[Number(idx)]}[/TABLE]`
  );

  // 6. 解码 HTML 实体
  text = decodeHtmlEntities(text);

  // 7. 统一换行符
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 8. 按行处理
  const lines = text.split('\n');
  const trimmedLines = lines.map((line) => line.trim());

  // 9. 合并连续空行
  const mergedLines: string[] = [];
  for (const line of trimmedLines) {
    if (line === '') {
      if (mergedLines.length === 0 || mergedLines[mergedLines.length - 1] !== '') {
        mergedLines.push(line);
      }
    } else {
      mergedLines.push(line);
    }
  }

  // 10. 段落首行缩进（已有缩进的不再加，图片占位标记行不缩进）
  const indentedLines = mergedLines.map((line) => {
    if (line === '') return line;
    if (line.startsWith('[IMG:')) return line; // 图片占位标记不缩进
    if (line.startsWith('[图片说明：')) return line; // 图片说明标记不缩进
    // 富文本块级标记行不缩进（CODE/QUOTE/TABLE/H1-H6/LI）
    if (/^\[(CODE|QUOTE|TABLE|H[1-6]|LI)\]/.test(line)) return line;
    if (line.startsWith('　　') || line.startsWith('    ')) return line;
    return '　　' + line;
  });

  // 11. 去首尾空行
  let result = indentedLines.join('\n');
  result = result.replace(/^\n+/, '').replace(/\n+$/, '');

  return result;
}

/**
 * 安全的 String.fromCodePoint（P0-7 修复：防止恶意实体导致解析器崩溃）
 *
 * 问题：String.fromCodePoint 对无效码点抛 RangeError：
 * - 代理区 0xD800-0xDFFF（单独使用非法，必须成对 surrogate）
 * - 超过 Unicode 上限 > 0x10FFFF
 * - 0 或负数
 *
 * 恶意 EPUB 可构造 &#xD800; 等实体使 String.fromCodePoint 抛 RangeError，
 * 导致整个解析流程崩溃。本函数对无效码点返回替代字符 \uFFFD
 * （Unicode REPLACEMENT CHARACTER），保证解析器不中断。
 *
 * @param cp Unicode 码点
 * @returns 对应字符；无效码点返回替代字符 \uFFFD
 */
function safeFromCodePoint(cp: number): string {
  // 有效码点范围：1 ~ 0x10FFFF，排除代理区 0xD800-0xDFFF
  if (cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return '\uFFFD';
  }
  return String.fromCodePoint(cp);
}

/** 解码常见 HTML 实体 */
function decodeHtmlEntities(text: string): string {
  const entityMap: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&nbsp;': ' ',
    '&ldquo;': '\u201C',
    '&rdquo;': '\u201D',
    '&lsquo;': '\u2018',
    '&rsquo;': '\u2019',
    '&mdash;': '\u2014',
    '&ndash;': '\u2013',
    '&hellip;': '\u2026',
    '&middot;': '\u00B7',
    '&emsp;': '\u3000',
    '&ensp;': '\u2002',
    '&thinsp;': '\u2009'
  };

  // 命名实体
  let result = text.replace(/&[a-zA-Z]+;/g, (match) => {
    return entityMap[match] ?? match;
  });

  // 数字实体（十进制 &#1234; 和十六进制 &#xABCD;）
  // P0-7: 用 safeFromCodePoint 校验码点有效性，无效码点（代理区 0xD800-0xDFFF / 超 0x10FFFF / ≤0）
  //       返回替代字符 \uFFFD，避免 String.fromCodePoint 抛 RangeError 导致解析器崩溃
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)));
  result = result.replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)));

  return result;
}

/* ==================== 封面提取 ==================== */

/** media-type → 图片扩展名 */
function coverMediaTypeToExt(mediaType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/webp': '.webp'
  };
  return map[mediaType] ?? '';
}

/** 判断 href 或 mediaType 是否为图片 */
function isImageResource(href: string, mediaType?: string): boolean {
  if (mediaType && mediaType.startsWith('image/')) return true;
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff?|avif)$/i.test(href);
}

/**
 * 将图片 entry 解压到目标路径
 *
 * @returns 成功返回最终目标路径，失败返回 null
 */
async function extractImageEntryTo(
  zip: EpubZip,
  entryName: string,
  destPath: string,
  fallbackExt = '.jpg'
): Promise<string | null> {
  // 根据扩展名调整 destPath
  const ext = extname(entryName).toLowerCase() || fallbackExt;
  const finalDest = destPath.replace(/\.[^.]+$/, ext);

  try {
    await zip.extract(entryName, finalDest);
    return finalDest;
  } catch {
    // extract 失败时尝试用 entryBuffer + writeFile
    try {
      const buf = await zip.entryBuffer(entryName);
      await fsPromises.writeFile(finalDest, buf);
      return finalDest;
    } catch {
      return null;
    }
  }
}

/**
 * 从 srcset 属性中提取所有图片 URL
 *
 * srcset 格式：
 * - 单个 URL：`srcset="image.webp"`
 * - 像素密度描述符：`srcset="image-1x.webp 1x, image-2x.webp 2x"`
 * - 宽度描述符：`srcset="image-480w.webp 480w, image-720w.webp 720w"`
 *
 * P2-1修复：原代码未处理 <picture>/<source> 标签，导致响应式图片丢失。
 * 此函数提取 srcset 中的所有 URL，供图片收集逻辑使用。
 *
 * @param srcset srcset 属性值
 * @returns URL 数组（按 srcset 中的顺序）
 */
function extractUrlsFromSrcset(srcset: string): string[] {
  const urls: string[] = [];
  // srcset 用逗号分隔多个候选，每个候选格式为 "URL descriptor"（descriptor 可选）
  const candidates = srcset
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    // 取第一个空格前的部分作为 URL（空格后是描述符 1x/2x/480w 等）
    // 注意：URL 可能不含空格，此时整个 candidate 就是 URL
    const spaceIdx = candidate.indexOf(' ');
    const url = spaceIdx >= 0 ? candidate.substring(0, spaceIdx).trim() : candidate.trim();
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * 从 HTML 内容中提取所有 <source srcset="..."> 标签的图片 URL
 *
 * P2-1修复：<picture> 标签内的 <source> 提供 WebP/AVIF 等现代格式的响应式图片，
 * 原代码仅处理 <img>，导致 <picture> 中的 source 图片完全丢失。
 *
 * @param html HTML 内容
 * @returns 所有 <source srcset> 中的 URL 列表
 */
export function extractSourceSrcsetUrls(html: string): string[] {
  const urls: string[] = [];
  // 匹配所有 <source srcset="..."> 标签（不要求 source 后有空白，兼容 <source/>）
  const sourceRegex = /<source\b[^>]*\ssrcset=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = sourceRegex.exec(html)) !== null) {
    const srcset = match[1];
    urls.push(...extractUrlsFromSrcset(srcset));
  }
  return urls;
}

/**
 * 从 HTML 内容中找第一个 <img src> 或 SVG <image href>，返回 src
 *
 * P2-1修复：增加对 <picture>/<source srcset> 的支持，
 * 当 <img> 和 <image> 都未找到时，回退查找 <source srcset>。
 *
 * @param html HTML 内容
 * @returns 第一个图片 src，或 null
 */
function findFirstImageSrcInHtml(html: string): string | null {
  // <img src="...">
  const imgMatch = html.match(/<img\s[^>]*src=["']([^"']+)["'][^>]*>/i);
  if (imgMatch && imgMatch[1] && !imgMatch[1].startsWith('data:')) {
    return imgMatch[1];
  }
  // SVG <image xlink:href="..."> 或 <image href="...">
  const svgMatch = html.match(/<image\s[^>]*(?:xlink:href|href)=["']([^"']+)["'][^>]*>/i);
  if (svgMatch && svgMatch[1] && !svgMatch[1].startsWith('data:')) {
    return svgMatch[1];
  }
  // P2-1修复：<picture><source srcset="..."> 回退
  const sourceUrls = extractSourceSrcsetUrls(html);
  if (sourceUrls.length > 0) {
    // 取第一个非 data: URL
    const externalUrl = sourceUrls.find((u) => !u.startsWith('data:'));
    if (externalUrl) return externalUrl;
  }
  return null;
}

/**
 * 提取 EPUB 封面图片并保存到指定路径
 *
 * 多级兜底策略（按优先级）：
 * 1. OPF metadata properties="cover-image"（EPUB3）→ 直接是图片
 * 2. OPF meta name="cover" content="cover-id"（EPUB2）→ manifest 中找 cover-id 对应的图片
 * 3. OPF guide reference type="cover" href → 可能是封面页 HTML，读 HTML 找 <img>
 * 4. manifest 中第一个 image/* item → 直接是图片
 * 5. 扫描 spine 章节HTML 找第一张 <img> → 提取该图片
 *
 * 对于 href 指向 HTML 的情况（方式3、方式5），会读取 HTML 内容，
 * 找到第一个 <img src="...">，再将 src 解析为 ZIP entry name 提取图片。
 *
 * @param filePath EPUB 文件路径
 * @param destPath 封面保存目标路径（含扩展名，扩展名会被实际图片格式覆盖）
 * @returns 成功返回最终保存路径，无封面或失败返回 null
 */
export async function extractEpubCover(filePath: string, destPath: string): Promise<string | null> {
  let zip: EpubZip | null = null;
  try {
    zip = await openEpub(filePath);

    // 1. 读 container.xml 找 OPF 路径
    const containerXml = await zip.entryString('META-INF/container.xml');
    const container = parseXml(containerXml);
    const rootfiles = toArray<Record<string, unknown>>(
      getField(getField(container, 'container') ?? {}, 'rootfiles') ?? {}
    );
    let opfPath = '';
    for (const rootfile of rootfiles) {
      const rfs = toArray<Record<string, unknown>>(getField(rootfile, 'rootfile'));
      for (const rf of rfs) {
        const fullPath = getField<string>(rf, '@_full-path');
        const mediaType = getField<string>(rf, '@_media-type');
        if (fullPath && mediaType === 'application/oebps-package+xml') {
          opfPath = fullPath;
          break;
        }
      }
      if (opfPath) break;
    }
    if (!opfPath) return null;

    // 2. 解析 OPF
    const opf = await parseOpf(zip, opfPath);
    const entries = zip.entries();

    // 3. 尝试方式1/2：opf.coverHref（metadata 声明的封面图片）
    if (opf.coverHref) {
      const entryName = resolveEpubPath(opf.opfDir, opf.coverHref);
      if (entries[entryName]) {
        // 找到对应 manifest item 获取 mediaType
        let mediaType = '';
        for (const item of opf.manifest.values()) {
          if (item.href === opf.coverHref) {
            mediaType = item.mediaType;
            break;
          }
        }
        const fallbackExt = coverMediaTypeToExt(mediaType) || '.jpg';
        const result = await extractImageEntryTo(zip, entryName, destPath, fallbackExt);
        if (result) return result;
      }
    }

    // 4. 尝试方式3：guide reference type="cover" href（可能是封面页 HTML）
    if (opf.guideCoverHref) {
      const entryName = resolveEpubPath(opf.opfDir, opf.guideCoverHref);
      if (entries[entryName]) {
        // 如果是图片，直接提取
        if (isImageResource(opf.guideCoverHref)) {
          const result = await extractImageEntryTo(zip, entryName, destPath);
          if (result) return result;
        }
        // 如果是 HTML，读内容找 <img>
        try {
          const html = await zip.entryString(entryName);
          const imgSrc = findFirstImageSrcInHtml(html);
          if (imgSrc) {
            const htmlDir = dirname(entryName);
            const imgEntryName = resolveEpubPath(htmlDir, imgSrc);
            if (entries[imgEntryName]) {
              const result = await extractImageEntryTo(zip, imgEntryName, destPath);
              if (result) return result;
            }
          }
        } catch {
          // 读 HTML 失败，继续下一个兜底
        }
      }
    }

    // 5. 尝试方式4：manifest 中第一个 image/* item
    for (const item of opf.manifest.values()) {
      if (item.mediaType.startsWith('image/')) {
        const entryName = resolveEpubPath(opf.opfDir, item.href);
        if (entries[entryName]) {
          const fallbackExt = coverMediaTypeToExt(item.mediaType) || '.jpg';
          const result = await extractImageEntryTo(zip, entryName, destPath, fallbackExt);
          if (result) return result;
        }
        break; // 只尝试第一个 image item
      }
    }

    // 6. 尝试方式5：扫描 spine 章节HTML 找第一张 <img>
    //    限制扫描前 5 章，避免大书扫描过久
    const scanLimit = Math.min(opf.spine.length, 5);
    for (let i = 0; i < scanLimit; i++) {
      const idref = opf.spine[i];
      const item = opf.manifest.get(idref);
      if (!item) continue;
      // 跳过 nav 文件
      if (item.properties && item.properties.includes('nav')) continue;
      // 只处理 HTML
      if (
        item.mediaType !== 'application/xhtml+xml' &&
        item.mediaType !== 'text/html' &&
        !item.href.endsWith('.html') &&
        !item.href.endsWith('.xhtml')
      ) {
        continue;
      }

      const entryName = resolveEpubPath(opf.opfDir, item.href);
      if (!entries[entryName]) continue;

      try {
        const html = await zip.entryString(entryName);
        const imgSrc = findFirstImageSrcInHtml(html);
        if (imgSrc) {
          const htmlDir = dirname(entryName);
          const imgEntryName = resolveEpubPath(htmlDir, imgSrc);
          if (entries[imgEntryName]) {
            const result = await extractImageEntryTo(zip, imgEntryName, destPath);
            if (result) return result;
          }
        }
      } catch {
        // 读章节失败，继续下一章
      }
    }

    // 7. 所有方式都失败，返回 null
    return null;
  } catch (err) {
    console.error('[epub] 提取封面失败:', err);
    return null;
  } finally {
    zip?.close();
  }
}

/* ==================== 漫画检测 ==================== */

/**
 * 检测 EPUB 内容三分类，并返回每章 content_type
 *
 * v21 三分类判定规则（逐章）：
 * - 文字>200字符 + 图片=0 → 'text'（文本章节）
 * - 文字>200字符 + 图片=1 → 'text'（单张装饰图/封面）
 * - 文字>200字符 + 图片≥2 → 'illustrated'（图文章节，文字为主+插图）
 * - 文字<200字符 + 图片≥1 → 'image'（图片章节，漫画）
 *
 * 全书判定：
 * - 图片章节 >50% → 'comic'
 * - 图文章节 >30% → 'illustrated'
 * - 否则 → 'text'
 *
 * 文字量判定：用 CJK 字符数（≥5 个中文）或总字符 >200 确认有实质文字内容，
 * 避免将 alt 文本/标题误判为正文。
 *
 * @param zip EPUB ZIP 句柄
 * @param chapters 章节索引列表
 * @param isFixedLayout 是否为固定布局 EPUB（固定布局通常就是漫画/绘本）
 * @returns { contentType: 全书类型, isComic: 是否漫画(兼容), chapterContentTypes: Map<chapter.index, 'text'|'illustrated'|'image'> }
 */
async function detectEpubComic(
  zip: EpubZip,
  chapters: ChapterIndex[],
  isFixedLayout?: boolean
): Promise<{
  contentType: 'text' | 'illustrated' | 'comic';
  isComic: boolean;
  chapterContentTypes: Map<number, 'text' | 'illustrated' | 'image'>;
  totalTextLength: number;
  totalImages: number;
}> {
  const chapterContentTypes = new Map<number, 'text' | 'illustrated' | 'image'>();
  if (chapters.length === 0)
    return { contentType: 'text', isComic: false, chapterContentTypes, totalTextLength: 0, totalImages: 0 };

  // 固定布局 EPUB（绘本/画册）通常就是漫画：每页是固定尺寸的图片
  // 直接判定为漫画，所有章节设为 image 类型，跳过逐章图片检测
  if (isFixedLayout) {
    for (const chapter of chapters) {
      chapterContentTypes.set(chapter.index, 'image');
    }
    return { contentType: 'comic', isComic: true, chapterContentTypes, totalTextLength: 0, totalImages: 0 };
  }

  const entries = zip.entries();
  // SVG <image> 标签正则：匹配 <image xlink:href="..."> 或 <image href="...">
  const svgImageRegex = /<image\s[^>]*(?:xlink:href|href)=["']([^"']+)["'][^>]*>/gi;
  let imageChapterCount = 0; // 图片章节（漫画）
  let illustratedChapterCount = 0; // 图文章节
  // 全书总文字量统计（用于内容级漫画判定，而非仅看章节比例）
  let totalCjkChars = 0; // 全书总CJK字符数
  let totalTextLength = 0; // 全书总文字长度（含英文）
  let totalImages = 0; // 全书总图片数（改进：增加图片密度判断）

  // v25: 记录章节遍历索引，用于装饰图检测（第一个章节的图片通常是封面/装饰图）
  for (let chapterIdx = 0; chapterIdx < chapters.length; chapterIdx++) {
    const chapter = chapters[chapterIdx];
    if (!chapter.url) {
      chapterContentTypes.set(chapter.index, 'text');
      continue;
    }
    try {
      const html = await zip.entryString(chapter.url);
      // 图片 src 是相对于 HTML 文件的路径，不是相对于 OPF 目录
      // 用 HTML 文件所在目录来解析图片路径
      const htmlDir = dirname(chapter.url);

      const imgMatches = html.match(/<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi);
      const svgImgMatches = html.match(svgImageRegex);

      // 统计真实存在的图片数量（用于区分装饰图 vs 插图 vs 漫画）
      let validImageCount = 0;
      if (imgMatches) {
        for (const imgTag of imgMatches) {
          const srcMatch = imgTag.match(/src=["']([^"']+)["']/i);
          if (srcMatch && !srcMatch[1].startsWith('data:')) {
            const entryName = resolveEpubPath(htmlDir, srcMatch[1]);
            if (entries[entryName]) {
              validImageCount++;
            }
          }
        }
      }
      if (svgImgMatches) {
        for (const imgTag of svgImgMatches) {
          const hrefMatch = imgTag.match(/(?:xlink:href|href)=["']([^"']+)["']/i);
          if (hrefMatch && !hrefMatch[1].startsWith('data:')) {
            const entryName = resolveEpubPath(htmlDir, hrefMatch[1]);
            if (entries[entryName]) {
              validImageCount++;
            }
          }
        }
      }

      // 提取纯文本内容（用于文字量统计和章节分类）
      const textContent = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .trim();
      const cjkCharCount = (textContent.match(/[\u4e00-\u9fff]/g) || []).length;

      // 累计全书总文字量（无论本章有无图片，都计入全书文字量）
      totalCjkChars += cjkCharCount;
      totalTextLength += textContent.length;
      totalImages += validImageCount; // 累计全书总图片数

      if (validImageCount > 0) {
        // v25: 改进装饰图检测
        // 问题1: OPDS下载的文本书籍（唐诗三百首等）因有封面装饰图被误判漫画
        // 改进: 第一个章节的图片通常是封面/装饰图，降低其权重
        //   - 第一章 + 单图 → 视为装饰图，按文字量判定（不因图片而判image）
        // 问题2: 漫画对话气泡"今天天气真好"=6字，CJK>=5就算有文字，可能误判
        // 改进: 单图章节 CJK>=10 才算有文字（从5提高到10，排除短对话气泡）
        //   - 多图章节保持 CJK>=50（排除漫画对话气泡）
        const isFirstChapter = chapterIdx === 0;
        // v25: 单图章节文字阈值从5提高到10，排除短对话气泡
        // 多图章节保持50不变
        const textThreshold =
          validImageCount >= 2
            ? cjkCharCount >= 50 || textContent.length > 500
            : cjkCharCount >= 15 || textContent.length > 200;
        let hasSubstantialText = textThreshold;

        // P1-21修复: 装饰图检测 — 补充3个遗漏分支
        // 分支1: 非第一章装饰图检测（原代码只检测第一章）
        //   非第一章也可能有装饰图（章节末尾分隔线、章节开头小图标等）
        // 分支2: alt属性检测 — alt含"封面""分隔""logo""divider""separator"的是装饰图
        // 分支3: 图片位置/尺寸检测 — 位于<body>开头/结尾的图或小尺寸图是装饰
        // 来源：经验库 2026-09-24-epub-illustrated-misclassify-as-text-threshold-issue

        // P1-21分支2+3: 检测alt属性、图片位置、图片尺寸判断是否装饰图
        let isDecorativeImage = false;
        if (imgMatches) {
          for (const imgTag of imgMatches) {
            // 分支2: alt属性检测
            const altMatch = imgTag.match(/alt=["']([^"']*)["']/i);
            if (altMatch) {
              const alt = altMatch[1].toLowerCase().trim();
              if (/(封面|分隔|分割|logo|divider|separator|装饰|ornament|bullet|arrow|star|line)/i.test(alt)) {
                isDecorativeImage = true;
                break;
              }
            }
            // 分支3: 图片位置检测 — body开头/结尾的图是装饰
            const bodyStart = html.search(/<body[^>]*>/i);
            const bodyEnd = html.search(/<\/body>/i);
            if (bodyStart >= 0 && bodyEnd > bodyStart) {
              const bodyContent = html.substring(bodyStart, bodyEnd);
              const imgPosInBody = bodyContent.indexOf(imgTag);
              if (imgPosInBody >= 0 && (imgPosInBody < 100 || imgPosInBody > bodyContent.length - 100)) {
                isDecorativeImage = true;
                break;
              }
            }
            // 分支3: 图片尺寸检测 — 小图片（<50px）是图标/分隔线
            const widthMatch = imgTag.match(/width=["']?(\d+)["']?/i);
            const heightMatch = imgTag.match(/height=["']?(\d+)["']?/i);
            if ((widthMatch && parseInt(widthMatch[1]) < 50) || (heightMatch && parseInt(heightMatch[1]) < 50)) {
              isDecorativeImage = true;
              break;
            }
          }
        }

        // v25: 装饰图检测 — 第一章单图视为装饰图
        // 如果是第一章 + 单图 + 有一定文字（CJK>=10），强制视为有文字的文本章节
        // 避免OPDS书籍的封面装饰图导致误判
        if (isFirstChapter && validImageCount === 1 && cjkCharCount >= 10) {
          hasSubstantialText = true;
        }

        // P1-21分支1: 非第一章装饰图检测
        // 非第一章 + 单图 + 装饰图特征(alt/位置/尺寸) + 有文字 → 视为文本章节
        if (!isFirstChapter && validImageCount === 1 && isDecorativeImage && cjkCharCount >= 15) {
          hasSubstantialText = true;
        }

        if (hasSubstantialText) {
          // 有实质文字内容
          // v33: 单张配图章节不再一律判text
          //   - 第一章单图 → 装饰图/封面 → text
          //   - 非第一章单图 → 插图 → illustrated（修复图文书每章1张配图被判text→全书text）
          if (validImageCount >= 2) {
            chapterContentTypes.set(chapter.index, 'illustrated');
            illustratedChapterCount++;
          } else if (isFirstChapter) {
            // 第一章单张装饰图/封面 → 文本章节
            chapterContentTypes.set(chapter.index, 'text');
          } else {
            // 非第一章单张配图 → 图文章节（插图）
            chapterContentTypes.set(chapter.index, 'illustrated');
            illustratedChapterCount++;
          }
        } else {
          // 图片为主、文字极少 → 图片章节（漫画/绘本）
          chapterContentTypes.set(chapter.index, 'image');
          imageChapterCount++;
        }
      } else {
        chapterContentTypes.set(chapter.index, 'text');
      }
    } catch (err) {
      // P0-11修复：读取失败时输出警告而非静默跳过，避免 totalTextLength 静默为 0
      // 原代码静默 catch，导致章节读取失败时 totalTextLength 不增加但无任何日志
      console.warn(
        `[epub] detectEpubComic: 章节 ${chapter.index} (url=${chapter.url}) 读取失败，totalTextLength 可能不准确:`,
        err
      );
      chapterContentTypes.set(chapter.index, 'text');
    }
  }

  // v25 全书三分类判定（基于内容特征，非仅章节比例）：
  // 核心原则：漫画是"以图为主、几乎没有文字"的书籍
  // 如果全书有大量文字（>500 CJK字符 或 >2000总字符），无论图片章节占比多少，都不是漫画
  // v26改进：
  //   1. 增加全书图片总量判断：totalImages>=10 + 有文字 → illustrated
  //     （修复"有趣得让人睡不着的数学故事"误判text：每章1张插图+大量文字，
  //      单张图片被判装饰图→text，但全书有大量图片应是illustrated）
  //   2. 降低图文章节占比阈值（30% → 10%），增加图片密度判断
  // 来源：经验库 2026-09-24-epub-illustrated-misclassify-as-text-threshold-issue

  // 计算关键指标
  const imageRatio = imageChapterCount / chapters.length;
  const illustratedRatio = illustratedChapterCount / chapters.length;
  const imageDensity = totalImages / chapters.length; // 平均每章图片数
  // v25: 全书平均每章字符数，用于识别高文字小说
  const avgCharsPerChapter = totalTextLength / Math.max(chapters.length, 1);

  let contentType: 'text' | 'illustrated' | 'comic';
  // v33: 修复图文书被误判text的问题
  //   旧逻辑: avgCharsPerChapter>2000 + totalImages<10 → text
  //   问题: 图文书每章2000+字+全书5张插图 → 被判text
  //   修复: 如果有图文章节(illustratedChapterCount>0)，即使图片<10也判illustrated
  if (avgCharsPerChapter > 2000 && totalImages < 10 && illustratedChapterCount === 0) {
    // 每章平均>2000字符 + 全书图片<10 + 无图文章节 → 纯文本小说（可能有封面装饰图）
    contentType = 'text';
  } else if (totalCjkChars > 500 || totalTextLength > 2000) {
    // 全书有大量文字 → 不可能是漫画
    // v26: 全书有10+张图片 + 有文字 → 图文书（覆盖每章1张插图的情况）
    if (totalImages >= 10) {
      contentType = 'illustrated';
    } else if (illustratedRatio >= 0.1 || imageDensity >= 2) {
      contentType = 'illustrated';
    } else {
      contentType = 'text';
    }
  } else if (imageRatio > 0.5 && totalCjkChars < 200) {
    // v25: 全书文字极少(totalCjkChars<200) + 图片章节占比高 → 漫画
    // 加入totalCjkChars<200约束，避免有文字的书被误判comic
    contentType = 'comic';
  } else if (imageRatio > 0.5) {
    // 全书文字稍多但图片章节占比高 → 漫画（保留原逻辑兜底）
    contentType = 'comic';
  } else if (illustratedRatio >= 0.1 || imageDensity >= 2) {
    // 图文混合（改进：降低阈值到10%）
    contentType = 'illustrated';
  } else {
    contentType = 'text';
  }
  // P0-11修复：totalTextLength 为 0 但不是纯漫画/图片文件时，输出警告
  // 避免多路径静默失败导致 content_features.totalTextLength 全为 0
  if (totalTextLength === 0 && contentType !== 'comic' && chapters.length > 0) {
    console.warn(
      `[epub] detectEpubComic: totalTextLength=0 但 contentType=${contentType}（${chapters.length} 章），可能存在文本提取静默失败`
    );
  }
  const isComic = contentType === 'comic';
  return { contentType, isComic, chapterContentTypes, totalTextLength, totalImages };
}

/* ==================== parse 主流程 ==================== */

/**
 * 解析 EPUB 文件，建立章节索引（不加载正文）
 *
 * 流程：
 * 1. 打开 EPUB ZIP
 * 2. 读 META-INF/container.xml → 找 OPF 路径
 * 3. 解析 OPF：metadata + manifest + spine + NCX/nav
 * 4. 解析 NCX 或 nav 提取章节标题
 * 5. 按 spine 顺序建立章节索引（每章对应一个 HTML entry）
 * 6. 返回 ParsedBook（encoding 固定 'UTF-8'）
 *
 * @param filePath EPUB 文件绝对路径
 * @param onProgress 解析进度回调（0~1）
 * @param originalFileName 原始文件名（用于元数据兜底，可选）
 * @returns 解析结果（元数据 + 章节索引 + isFixedLayout 固定布局标记）
 * @throws EpubParseError 文件不存在/非 EPUB/解析失败
 */
export async function parseEpub(
  filePath: string,
  onProgress?: (p: number) => void,
  originalFileName?: string
): Promise<EpubParsedBook> {
  // 校验文件存在
  if (!existsSync(filePath)) {
    throw new EpubParseError(`文件不存在: ${filePath}`);
  }

  // 校验扩展名
  const ext = extname(filePath).toLowerCase();
  if (ext !== '.epub') {
    throw new EpubParseError(`不是 EPUB 文件: ${filePath}`);
  }

  let zip: EpubZip | null = null;
  try {
    if (onProgress) onProgress(0.05);

    // 1. 打开 ZIP
    zip = await openEpub(filePath);

    if (onProgress) onProgress(0.15);

    // 2. 读 container.xml 找 OPF 路径
    let opfPath: string;
    try {
      const containerXml = await zip.entryString('META-INF/container.xml');
      const container = parseXml(containerXml);
      const rootfiles = toArray<Record<string, unknown>>(
        getField(getField(container, 'container') ?? {}, 'rootfiles') ?? {}
      );
      opfPath = '';
      for (const rootfile of rootfiles) {
        const rfs = toArray<Record<string, unknown>>(getField(rootfile, 'rootfile'));
        for (const rf of rfs) {
          const fullPath = getField<string>(rf, '@_full-path');
          const mediaType = getField<string>(rf, '@_media-type');
          if (fullPath && mediaType === 'application/oebps-package+xml') {
            opfPath = fullPath;
            break;
          }
        }
        if (opfPath) break;
      }
    } catch (err) {
      throw new EpubParseError(`读取 container.xml 失败（可能不是有效 EPUB）: ${(err as Error).message}`, err as Error);
    }
    if (!opfPath) {
      throw new EpubParseError('container.xml 中未找到 OPF 文件路径');
    }

    if (onProgress) onProgress(0.3);

    // 3. 解析 OPF
    const opf = await parseOpf(zip, opfPath);

    if (onProgress) onProgress(0.45);

    // 4. 解析章节标题（NCX 优先，nav 次之）
    let titleMap = new Map<string, string>();
    if (opf.ncxHref) {
      try {
        const ncxPath = resolveEpubPath(opf.opfDir, opf.ncxHref);
        titleMap = await parseNcx(zip, ncxPath);
      } catch (err) {
        console.warn('[epub] 解析 NCX 失败，将尝试 nav:', err);
      }
    }
    if (titleMap.size === 0 && opf.navHref) {
      try {
        const navPath = resolveEpubPath(opf.opfDir, opf.navHref);
        titleMap = await parseNav(zip, navPath);
      } catch (err) {
        console.warn('[epub] 解析 nav.xhtml 失败:', err);
      }
    }

    if (onProgress) onProgress(0.65);

    // 5. 按 spine 顺序建立章节索引
    const chapters: ChapterIndex[] = [];
    let chapterIndex = 0;
    for (const idref of opf.spine) {
      const item = opf.manifest.get(idref);
      if (!item) continue;
      // 跳过 nav 文件（EPUB3 目录页），它不是内容章节
      if (item.properties && item.properties.includes('nav')) continue;
      // 只处理 HTML 类型的 item
      if (
        item.mediaType !== 'application/xhtml+xml' &&
        item.mediaType !== 'text/html' &&
        !item.href.endsWith('.html') &&
        !item.href.endsWith('.xhtml')
      ) {
        continue;
      }

      // 解析 entry name
      const entryName = resolveEpubPath(opf.opfDir, item.href);

      // 获取 entry 大小
      const entries = zip.entries();
      const entryInfo = entries[entryName];
      const fileSize = entryInfo ? entryInfo.size : 0;

      // 标题：优先从 NCX/nav 提取，兜底用文件名或"第N章"
      let title = titleMap.get(item.href) ?? titleMap.get(entryName) ?? '';
      if (!title) {
        // 尝试只取文件名部分匹配
        const fileName = item.href.split('/').pop() ?? '';
        title = titleMap.get(fileName) ?? '';
      }
      if (!title) {
        title = `第${chapterIndex + 1}章`;
      }

      chapters.push({
        index: chapterIndex,
        title,
        fileOffset: chapterIndex,
        fileLength: fileSize,
        url: entryName
      });
      chapterIndex++;
    }

    if (onProgress) onProgress(0.9);

    // 6. 兜底：spine 为空时
    if (chapters.length === 0) {
      throw new EpubParseError('EPUB 中未找到任何章节（spine 为空）');
    }

    // 6.5 兜底：spine 只有 1-2 个章节时，尝试内容级正则分章
    //    对标 MOBI 的兜底逻辑（splitChaptersByRegex）。
    //    场景：OPDS书库下载的古籍/诗集EPUB常把全书塞进单个 spine item，
    //    导致整本书变成一个巨章节。此处读取 HTML 转纯文本后用 chapter-patterns 正则库分章。
    if (chapters.length <= 2) {
      try {
        // 收集所有 spine entry 的纯文本（多 entry 时拼接）
        const fullParts: string[] = [];
        const sourceEntryNames: string[] = []; // 每个 part 对应的 entry name
        for (const ch of chapters) {
          if (!ch.url) continue;
          try {
            const htmlContent = await zip.entryString(ch.url);
            fullParts.push(htmlToPlainText(htmlContent));
            sourceEntryNames.push(ch.url);
          } catch (err) {
            // P0-11修复：输出警告而非静默跳过，避免 totalTextLength 静默为 0
            console.warn(`[epub] 单spine兜底: entry ${ch.url} 读取失败:`, err);
          }
        }
        const fullText = fullParts.join('\n\n');

        // P0-11修复：如果全文为空但章节不为空，输出警告（可能所有 entry 读取都失败了）
        if (fullText.length === 0 && chapters.length > 0) {
          console.warn(`[epub] 单spine兜底: 全文为空（${chapters.length} 个章节全部读取失败），totalTextLength 将为 0`);
        }

        // 用 detectParseMode 判定是否为小说模式（含章节标题）
        if (fullText.length > 0) {
          const parseMode = detectParseMode(fullText);
          if (parseMode === 'novel') {
            // 复用 MOBI 的正则分章函数
            const regexResult = splitChaptersByRegex(fullText);
            // 分出 3+ 个章节才替换（避免比原来更差）
            if (regexResult.chapters.length >= 3) {
              // 记录每个分章来自哪个 entry name
              // splitChaptersByRegex 的 fileOffset 是全文字符偏移
              // 由于多 entry 拼接时用 \n\n 连接，需要建立字符偏移→entry name 映射
              const entryBoundaries: { offset: number; entryName: string }[] = [];
              let cumOffset = 0;
              for (let i = 0; i < fullParts.length; i++) {
                entryBoundaries.push({ offset: cumOffset, entryName: sourceEntryNames[i] });
                cumOffset += fullParts[i].length + 2; // +2 for '\n\n'
              }
              // 辅助函数：根据字符偏移找到对应的 entry name
              const findEntryName = (offset: number): string => {
                let result = sourceEntryNames[0] ?? '';
                for (const b of entryBoundaries) {
                  if (b.offset <= offset) result = b.entryName;
                  else break;
                }
                return result;
              };

              // 替换 chapters 数组
              chapters.length = 0;
              for (let i = 0; i < regexResult.chapters.length; i++) {
                const rc = regexResult.chapters[i];
                chapters.push({
                  index: i,
                  title: rc.title,
                  fileOffset: rc.fileOffset,
                  fileLength: rc.fileLength,
                  url: findEntryName(rc.fileOffset),
                  isCharOffset: true
                });
              }
            }
          }
        }
      } catch (err) {
        // 兜底分章失败不影响原有逻辑，保留原 chapters
        console.warn('[epub] 单spine回退正则分章失败，保留原分章:', err);
      }
    }

    // 7. 漫画/图文检测（v21 三分类）
    //    固定布局 EPUB 传入 isFixedLayout，detectEpubComic 会直接判定为漫画
    const comicResult = await detectEpubComic(zip, chapters, opf.isFixedLayout);
    // OPF 漫画标记兜底：如果 OPF 声明了漫画（meta name="comic" content="true"），
    // 但图片检测未识别为漫画（可能图片路径解析失败），用 OPF 标记强制判定为漫画
    // 固定布局 EPUB 也强制判定为漫画（绘本/画册）
    const opfForceComic = opf.isComicDeclared || opf.isFixedLayout;
    const isComic = comicResult.isComic || opfForceComic;
    // v21：全书 contentType。OPF/固定布局强制漫画时覆盖为 comic
    const contentType: 'text' | 'illustrated' | 'comic' = opfForceComic ? 'comic' : comicResult.contentType;
    if (isComic) {
      chapters.forEach((ch) => {
        // 如果图片检测已有结果，保留；否则用 OPF 标记兜底设为 image
        if (comicResult.isComic) {
          ch.contentType = comicResult.chapterContentTypes.get(ch.index) ?? 'text';
        } else {
          // OPF 标记兜底：所有章节默认设为 image（漫画书）
          if (!ch.contentType) ch.contentType = 'image';
        }
      });
    } else {
      // 非漫画：逐章设置 content_type（text/illustrated/image）
      chapters.forEach((ch) => {
        ch.contentType = comicResult.chapterContentTypes.get(ch.index) ?? 'text';
      });
    }

    if (onProgress) onProgress(1);

    // 标题兜底：OPF 无 title 时用原始文件名（去扩展名），再兜底 basename
    const fallbackTitle = originalFileName
      ? originalFileName.replace(/\.[^.]+$/, '').trim() || basename(filePath, '.epub')
      : basename(filePath, '.epub');

    // P0-11修复：EPUB totalTextLength 为 0 但非漫画时，输出警告（detectEpubComic 内部已有警告，此处为最终确认）
    if (comicResult.totalTextLength === 0 && !isComic && chapters.length > 0) {
      console.warn(
        `[epub] parseEpub: 最终 totalTextLength=0 但非漫画（${chapters.length} 章），content_features 可能不准确`
      );
    }

    return {
      encoding: 'UTF-8',
      title: opf.title || fallbackTitle,
      author: opf.author || '未知',
      description: opf.description || '',
      chapters,
      isComic,
      contentType,
      isFixedLayout: opf.isFixedLayout,
      contentFeatures: {
        totalTextLength: comicResult.totalTextLength,
        pageCount: chapters.length,
        imageCount: comicResult.totalImages
      }
    };
  } catch (err) {
    if (err instanceof EpubParseError) throw err;
    throw new EpubParseError(`解析 EPUB 失败: ${(err as Error).message}`, err as Error);
  } finally {
    zip?.close();
  }
}

/* ==================== readChapter 按需读取 ==================== */

/**
 * 按需读取 EPUB 章节正文
 *
 * 用 node-stream-zip 的 entry() 方法读取单个 HTML entry，转为纯文本。
 * 不全量解压、不全量入内存，仅读取当前章节。
 *
 * P0-2 优化：通过 LRU 缓存复用 ZIP 句柄，不再每次 open/close。
 *
 * 图片保留：如果传入 imageDir，会提取章节中的图片到该目录，
 * 并在纯文本中用 `[IMG:file:///绝对路径]` 占位标记替换 `<img>` 标签，
 * 供前端渲染时替换为 `<img>` 元素显示。
 *
 * @param filePath EPUB 文件路径
 * @param chapter 章节索引（url 字段存 ZIP entry name）
 * @param imageDir 图片保存目录（绝对路径，可选）。传入则提取图片并保留占位标记
 * @param isFixedLayout 是否为固定布局 EPUB（可选）。true 时保留原始 HTML，不做段落重排
 * @returns 清洗后的章节正文（可能包含 [IMG:file:///...] 占位标记；
 *          固定布局时返回 [FIXED_LAYOUT]\n + 原始 HTML）
 * @throws EpubParseError 读取失败
 */
export async function readEpubChapter(
  filePath: string,
  chapter: ChapterIndex,
  imageDir?: string,
  isFixedLayout?: boolean
): Promise<string> {
  if (!chapter.url) {
    throw new EpubParseError(`章节缺少 url 字段（ZIP entry name）: index=${chapter.index}`);
  }

  let zip: EpubZip | null = null;
  try {
    // 使用 LRU 缓存句柄，不再每次 open/close
    zip = await getEpubZip(filePath);
    const html = await zip.entryString(chapter.url);

    // 字符偏移分章（EPUB单spine兜底正则分章）：读取整个entry转纯文本后按字符偏移截取
    if (chapter.isCharOffset) {
      const fullText = htmlToPlainText(html);
      const start = chapter.fileOffset;
      const len = chapter.fileLength;
      const end = start + len;
      const sliced = fullText.substring(start, end);
      // 清洗截取的章节文本
      return cleanContent(sliced);
    }

    // 固定布局 EPUB（绘本/画册）：保留原始 HTML 排版，不做段落重排
    // 章节内容用 [FIXED_LAYOUT] 标记开头，渲染时用 iframe 或保留原始 HTML 显示
    // 对标 Apple Books 对固定布局 EPUB 的处理方式
    if (isFixedLayout) {
      return `[FIXED_LAYOUT]\n${html}`;
    }

    // 无 imageDir 或无图片：走原逻辑（纯文本，不保留图片）
    if (!imageDir) {
      return htmlToPlainText(html);
    }

    // 有 imageDir：提取图片到磁盘，用占位标记替换 <img> 标签
    // 确保 imageDir 目录存在
    await fsPromises.mkdir(imageDir, { recursive: true });

    // 图片 src 是相对于 HTML 文件的路径，用 HTML 文件所在目录来解析
    const htmlDir = dirname(chapter.url);
    const entries = zip.entries();

    // 收集所有图片 src（<img> + SVG <image>）
    // P2-1修复：增加 <picture>/<source srcset> 收集，避免响应式图片丢失
    const imgSrcRegex = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
    const svgImageRegex = /<image\s[^>]*(?:xlink:href|href)=["']([^"']+)["'][^>]*>/gi;
    const srcs: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = imgSrcRegex.exec(html)) !== null) {
      srcs.push(match[1]);
    }
    while ((match = svgImageRegex.exec(html)) !== null) {
      srcs.push(match[1]);
    }
    // P2-1修复：收集 <source srcset> 中的所有 URL
    srcs.push(...extractSourceSrcsetUrls(html));

    // 无图片：走原逻辑
    if (srcs.length === 0) {
      return htmlToPlainText(html);
    }

    // 异步提取所有图片到磁盘，建立 src → 本地绝对路径 映射
    const srcToPath = new Map<string, string>();
    for (let i = 0; i < srcs.length; i++) {
      const src = srcs[i];
      // 跳过 data URI（前端可直接加载，无需提取）
      if (src.startsWith('data:')) {
        srcToPath.set(src, src); // 用 data URI 本身作为"路径"
        continue;
      }
      // P2-4修复：CDN/远程 URL（http/https）保留为占位标记，前端可直接加载
      // 原代码仅处理 ZIP 内本地路径，导致 CDN 图片（如 https://cdn.example.com/...）被丢弃。
      if (/^https?:\/\//i.test(src)) {
        srcToPath.set(src, src); // 保留远程 URL，前端直接加载
        continue;
      }
      // 解析相对路径为 ZIP entry name
      const entryName = resolveEpubPath(htmlDir, src);
      // 检查 ZIP 中是否存在该 entry
      if (!entries[entryName]) continue;
      try {
        const buf = await zip.entryBuffer(entryName);
        // 文件名：{序号}_{原始文件名}
        const originalName = basename(entryName);
        const fileName = `${i}_${originalName}`;
        const destPath = join(imageDir, fileName);
        await fsPromises.writeFile(destPath, buf);
        srcToPath.set(src, destPath);
      } catch {
        // 读取或写入失败时跳过该图片
      }
    }

    // 用 htmlToPlainText 处理，replaceImage 回调返回本地路径
    // P1-2修复：添加 replaceInlineSvg 回调，将内联 SVG 保存为 .svg 文件
    return htmlToPlainText(html, {
      replaceImage: (src: string): string | null => {
        return srcToPath.get(src) ?? null;
      },
      replaceInlineSvg: (svgContent: string, index: number): string | null => {
        // 将内联 SVG 矢量图形保存为 .svg 文件，避免被去标签时丢弃
        // P0-1修复：使用同步写入 writeFileSync 替代异步 fsPromises.writeFile，
        // 因为 replaceInlineSvg 是同步签名回调，异步写入未 await 会导致 SVG 文件
        // 可能尚未写入完成就返回路径，造成读取空文件或竞态条件
        try {
          const fileName = `chapter_${chapter.index}_inline_svg_${index}.svg`;
          const destPath = join(imageDir, fileName);
          // 同步写入 SVG 内容（UTF-8 编码），确保返回路径前文件已落盘
          writeFileSync(destPath, svgContent, 'utf-8');
          return destPath;
        } catch {
          // 保存失败返回 null，htmlToPlainText 会保留 SVG 原始 HTML
          return null;
        }
      }
    });
  } catch (err) {
    // 异常路径：从缓存移除并关闭可能损坏的 ZIP 句柄，防止后续调用复用损坏句柄
    if (zip) {
      epubZipCache.delete(filePath);
      try {
        zip.close();
      } catch {
        /* close 失败忽略 */
      }
    }
    if (err instanceof EpubParseError) throw err;
    throw new EpubParseError(`读取 EPUB 章节失败: ${(err as Error).message}`, err as Error);
  }
}

/* ==================== readChapterImages 图片章节读取 ==================== */

/**
 * 读取 EPUB 图片章节，提取图片到指定目录
 *
 * @param filePath EPUB 文件路径
 * @param chapter 章节索引（url 字段存 ZIP entry name）
 * @param imageDir 图片保存目录（绝对路径）
 * @returns 图片文件路径列表（绝对路径）
 */
export async function readEpubChapterImages(
  filePath: string,
  chapter: ChapterIndex,
  imageDir: string
): Promise<string[]> {
  if (!chapter.url) {
    throw new EpubParseError(`章节缺少 url 字段（ZIP entry name）: index=${chapter.index}`);
  }

  let zip: EpubZip | null = null;
  try {
    // 使用 LRU 缓存句柄
    zip = await getEpubZip(filePath);

    // 确保 imageDir 目录存在
    await fsPromises.mkdir(imageDir, { recursive: true });

    // 读取章节 HTML entry
    const html = await zip.entryString(chapter.url);

    // 关键修复：图片 src 是相对于 HTML 文件的路径，不是相对于 OPF 目录
    // 用 HTML 文件所在目录来解析图片路径，不再需要重新读取 container.xml 获取 opfDir
    const htmlDir = dirname(chapter.url);

    // 收集所有图片 src（<img> + SVG <image>）
    // P2-1修复：增加 <picture>/<source srcset> 收集，避免响应式图片丢失
    const imgSrcRegex = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
    const svgImageRegex = /<image\s[^>]*(?:xlink:href|href)=["']([^"']+)["'][^>]*>/gi;
    const srcs: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = imgSrcRegex.exec(html)) !== null) {
      srcs.push(match[1]);
    }
    while ((match = svgImageRegex.exec(html)) !== null) {
      srcs.push(match[1]);
    }
    // P2-1修复：收集 <source srcset> 中的所有 URL
    srcs.push(...extractSourceSrcsetUrls(html));

    if (srcs.length === 0) return [];

    // 获取 ZIP entries 列表（用于检查 entry 是否存在）
    const entries = zip.entries();

    const imagePaths: string[] = [];

    for (let i = 0; i < srcs.length; i++) {
      const src = srcs[i];

      // P1-4修复：统一 data URI 处理为保留占位标记（与 readEpubChapter 一致）
      // 原代码解码 data URI 并写入文件，与 readEpubChapter 的处理方式不一致：
      //   - readEpubChapter：保留 data URI 本身作为"路径"（前端可直接加载）
      //   - readEpubChapterImages：解码 base64 并写入文件
      // 统一为保留 data URI 本身作为路径，更简单安全：
      //   1. 避免解码 base64 和文件 I/O 开销
      //   2. 避免写入失败导致图片丢失
      //   3. 前端可直接渲染 data URI，无需本地文件
      if (src.startsWith('data:')) {
        imagePaths.push(src); // 保留 data URI 本身作为"路径"
        continue;
      }

      // P2-4修复：CDN/远程 URL（http/https）保留为占位标记，前端可直接加载
      // 原代码仅处理 ZIP 内本地路径，导致 CDN 图片被丢弃。
      if (/^https?:\/\//i.test(src)) {
        imagePaths.push(src); // 保留远程 URL
        continue;
      }

      // 解析相对路径为 ZIP entry name（用 htmlDir，不是 opfDir）
      const entryName = resolveEpubPath(htmlDir, src);

      // 检查 ZIP 中是否存在该 entry
      if (!entries[entryName]) continue;

      // 读取图片 Buffer
      try {
        const buf = await zip.entryBuffer(entryName);
        // 文件名：{序号}_{原始文件名}
        const originalName = basename(entryName);
        const fileName = `${i}_${originalName}`;
        const destPath = join(imageDir, fileName);
        await fsPromises.writeFile(destPath, buf);
        imagePaths.push(destPath);
      } catch {
        // 读取或写入失败时跳过该图片
        continue;
      }
    }

    return imagePaths;
  } catch (err) {
    // 异常路径：从缓存移除并关闭可能损坏的 ZIP 句柄
    if (zip) {
      epubZipCache.delete(filePath);
      try {
        zip.close();
      } catch {
        /* close 失败忽略 */
      }
    }
    if (err instanceof EpubParseError) throw err;
    throw new EpubParseError(`读取 EPUB 图片章节失败: ${(err as Error).message}`, err as Error);
  }
}

/* ==================== EpubParser 类（实现 FileParser 接口） ==================== */

/**
 * EPUB 解析器类，实现 FileParser 接口
 *
 * 上层通过 FileParser 接口统一调用，无需关心具体格式。
 */
export class EpubParser implements FileParser {
  async parse(filePath: string, onProgress?: (p: number) => void, originalFileName?: string): Promise<EpubParsedBook> {
    return parseEpub(filePath, onProgress, originalFileName);
  }

  async readChapter(
    filePath: string,
    chapter: ChapterIndex,
    imageDir?: string,
    isFixedLayout?: boolean
  ): Promise<string> {
    return readEpubChapter(filePath, chapter, imageDir, isFixedLayout);
  }

  async readChapterImages(filePath: string, chapter: ChapterIndex, imageDir: string): Promise<string[]> {
    return readEpubChapterImages(filePath, chapter, imageDir);
  }
}
