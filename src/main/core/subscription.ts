/**
 * 订阅系统合并模块（v11+）
 *
 * 合并自原 subscription/ 目录下的 5 个文件：
 * - folder-watcher.ts（文件夹监控）
 * - http-source.ts（HTTP源）
 * - rss-parser.ts（RSS解析）
 * - source-classifier.ts（源分类器）
 * - subscription-manager.ts（订阅管理器）
 *
 * 所有导出的函数和类型保持不变。
 */

// ═══════════════════════════════════════════════════════════════
// 外部依赖 import（路径已从 ../../ 调整为 ../）
// ═══════════════════════════════════════════════════════════════
import chokidar, { type FSWatcher } from 'chokidar';

/** chokidar watch 选项类型（chokidar 5 移除了 WatchOptions 导出，用内联类型替代） */
type WatchOptions = {
  persistent?: boolean;
  ignoreInitial?: boolean;
  followSymlinks?: boolean;
  awaitWriteFinish?: { stabilityThreshold?: number; pollInterval?: number };
  ignorePermissionErrors?: boolean;
  ignored?: string | RegExp | string[];
  depth?: number;
};
import { extname, basename, join } from 'path';
import { existsSync, type Dirent } from 'fs';
import { readdir, stat, writeFile, mkdir, rm, unlink } from 'fs/promises';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import Parser from 'rss-parser';
import { XMLParser } from 'fast-xml-parser';
import { importFile } from './importer';
import * as SubscriptionRepo from '../db/repositories';
import { tMain } from '../i18n';
import * as BookRepo from '../db/repositories';
import * as ChapterRepo from '../db/repositories';
import * as GroupRepo from '../db/repositories';
import { getDb } from '../db/index';
import { getCoversRoot, getUserDataRoot, getBooksPath, convertSemanticHtmlToMarkers } from '../utils';
import type {
  Subscription,
  CreateSubscriptionInput,
  UpdateSubscriptionInput,
  SubscriptionConfig
} from '../db/repositories';

// ═══════════════════════════════════════════════════════════════
// ══ 1. folder-watcher ══
// ═══════════════════════════════════════════════════════════════

/** chokidar 默认配置 */
const DEFAULT_CHOKIDAR_OPTIONS: WatchOptions = {
  persistent: true,
  ignoreInitial: true,
  followSymlinks: false,
  awaitWriteFinish: {
    stabilityThreshold: 2000,
    pollInterval: 500
  },
  ignorePermissionErrors: true
};

/** watchFolder 的额外选项 */
export interface WatchFolderOptions {
  extensions?: string[];
  recursive?: boolean;
  chokidarOptions?: Partial<WatchOptions>;
}

/** 监控实例记录 */
interface WatchEntry {
  watcher: FSWatcher;
  folderPath: string;
  options: WatchFolderOptions;
}

/** 当前活跃的监控实例（subscriptionId → WatchEntry） */
const watchers = new Map<number, WatchEntry>();

/**
 * 解析订阅配置 JSON（folder-watcher 版本）
 *
 * 容错：config 为 null 或非法 JSON 时返回空对象，不抛错。
 */
function parseConfigWatcher(config: string | null): SubscriptionConfig {
  if (!config) return {};
  try {
    return JSON.parse(config) as SubscriptionConfig;
  } catch {
    console.warn('[folder-watcher] 配置 JSON 解析失败，使用默认配置:', config);
    return {};
  }
}

function shouldWatch(filePath: string, allowedExts: Set<string>): boolean {
  if (allowedExts.size === 0) return true;
  const ext = extname(filePath).toLowerCase();
  return allowedExts.has(ext);
}

const importingFiles = new Map<number, Set<string>>();

async function handleFileAdded(subscriptionId: number, filePath: string, allowedExts: Set<string>): Promise<void> {
  if (!shouldWatch(filePath, allowedExts)) return;
  if (!existsSync(filePath)) return;

  let importing = importingFiles.get(subscriptionId);
  if (!importing) {
    importing = new Set();
    importingFiles.set(subscriptionId, importing);
  }
  if (importing.has(filePath)) return;
  importing.add(filePath);

  try {
    const existing = SubscriptionRepo.getBookBySubscriptionAndPath(subscriptionId, filePath);
    if (existing) {
      if (existing.has_update === 0) {
        SubscriptionRepo.markBookUpdate(existing.id, true);
      }
      return;
    }

    const result = await importFile(filePath);
    if (result.failed) {
      console.warn(`[folder-watcher] 导入失败: ${filePath}`, result.error);
      return;
    }
    if (result.skipped) {
      return;
    }

    if (result.book) {
      BookRepo.updateBook(result.book.id, {
        subscription_id: subscriptionId,
        has_update: 1,
        source_url: filePath
      });
      console.log(`[folder-watcher] 新文件导入成功: ${basename(filePath)} → bookId=${result.book.id}`);
      // 通知渲染进程刷新书架（通过回调，由 index.ts 注册发送 IPC）
      if (onNewItemsCallback) {
        const sub = SubscriptionRepo.getSubscription(subscriptionId);
        try {
          onNewItemsCallback(sub?.name ?? '文件夹监控', 1);
        } catch (cbErr) {
          console.warn('[folder-watcher] 新条目回调执行失败:', cbErr);
        }
      }
    }
  } catch (err) {
    console.error(`[folder-watcher] 处理新文件异常: ${filePath}`, err);
  } finally {
    importing.delete(filePath);
  }
}

function handleFileRemoved(subscriptionId: number, filePath: string): void {
  const book = SubscriptionRepo.getBookBySubscriptionAndPath(subscriptionId, filePath);
  if (book) {
    SubscriptionRepo.markBookUpdate(book.id, false);
    console.log(`[folder-watcher] 文件移除: ${basename(filePath)} → bookId=${book.id} 已标记无更新`);
  }
}

export function watchFolder(subscriptionId: number, folderPath: string, options: WatchFolderOptions = {}): void {
  if (watchers.has(subscriptionId)) {
    unwatchFolder(subscriptionId);
  }

  if (!existsSync(folderPath)) {
    console.warn(`[folder-watcher] 文件夹不存在: ${folderPath}`);
    return;
  }

  const allowedExts = new Set<string>((options.extensions ?? []).map((e) => e.toLowerCase()));

  const chokidarOpts: WatchOptions = {
    ...DEFAULT_CHOKIDAR_OPTIONS,
    ...options.chokidarOptions,
    depth: options.recursive === false ? 0 : undefined
  };

  const watcher = chokidar.watch(folderPath, chokidarOpts);

  watcher.on('add', (path) => {
    handleFileAdded(subscriptionId, path, allowedExts).catch((err) => {
      console.error(`[folder-watcher] add 事件处理异常: ${path}`, err);
    });
  });

  watcher.on('unlink', (path) => {
    handleFileRemoved(subscriptionId, path);
  });

  watcher.on('error', (err) => {
    console.error(`[folder-watcher] 监控异常 (subscriptionId=${subscriptionId}):`, err);
  });

  watchers.set(subscriptionId, { watcher, folderPath, options });
  console.log(`[folder-watcher] 开始监控: subscriptionId=${subscriptionId} path=${folderPath}`);
}

export async function unwatchFolder(subscriptionId: number): Promise<void> {
  const entry = watchers.get(subscriptionId);
  if (!entry) return;

  try {
    await entry.watcher.close();
  } catch (err) {
    console.warn(`[folder-watcher] 关闭监控异常 (subscriptionId=${subscriptionId}):`, err);
  }

  watchers.delete(subscriptionId);
  console.log(`[folder-watcher] 停止监控: subscriptionId=${subscriptionId}`);
}

export async function unwatchAllFolders(): Promise<void> {
  const ids = Array.from(watchers.keys());
  await Promise.all(ids.map((id) => unwatchFolder(id)));
}

export function watchFromSubscription(subscriptionId: number): void {
  const sub = SubscriptionRepo.getSubscription(subscriptionId);
  if (!sub) {
    console.warn(`[folder-watcher] 订阅不存在: id=${subscriptionId}`);
    return;
  }
  if (sub.type !== 'folder') {
    console.warn(`[folder-watcher] 订阅类型非 folder: id=${subscriptionId} type=${sub.type}`);
    return;
  }
  if (sub.enabled !== 1) {
    console.log(`[folder-watcher] 订阅已禁用，跳过监控: id=${subscriptionId}`);
    return;
  }

  const config = parseConfigWatcher(sub.config);
  watchFolder(subscriptionId, sub.url, {
    extensions: config.extensions,
    recursive: config.recursive ?? true
  });
}

export async function scanExistingFiles(
  subscriptionId: number,
  folderPath: string,
  options: WatchFolderOptions = {},
  markAsUpdate = false
): Promise<{ total: number; imported: number; skipped: number; failed: number }> {
  if (!existsSync(folderPath)) {
    console.warn(`[folder-watcher] 扫描失败，文件夹不存在: ${folderPath}`);
    return { total: 0, imported: 0, skipped: 0, failed: 0 };
  }

  const allowedExts = new Set<string>((options.extensions ?? getDefaultExtensions()).map((e) => e.toLowerCase()));
  const recursive = options.recursive ?? true;

  const allFiles: string[] = [];
  async function collectFiles(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`[folder-watcher] 读取目录失败: ${dir}`, err);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dir, entry.name);
      let s;
      try {
        s = await stat(fullPath);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (recursive) {
          await collectFiles(fullPath);
        }
      } else if (s.isFile()) {
        if (shouldWatch(fullPath, allowedExts)) {
          allFiles.push(fullPath);
        }
      }
    }
  }
  await collectFiles(folderPath);

  console.log(`[folder-watcher] 扫描 ${folderPath}: 找到 ${allFiles.length} 个匹配文件`);

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i];
    try {
      const existing = SubscriptionRepo.getBookBySubscriptionAndPath(subscriptionId, filePath);
      if (existing) {
        skipped++;
        continue;
      }

      const result = await importFile(filePath);
      if (result.failed) {
        console.warn(`[folder-watcher] 导入失败: ${basename(filePath)}`, result.error);
        failed++;
        continue;
      }
      if (result.skipped) {
        skipped++;
        continue;
      }

      if (result.book) {
        BookRepo.updateBook(result.book.id, {
          subscription_id: subscriptionId,
          has_update: markAsUpdate ? 1 : 0,
          source_url: filePath
        });
        imported++;
      }
    } catch (err) {
      console.error(`[folder-watcher] 扫描导入异常: ${basename(filePath)}`, err);
      failed++;
    }

    if (i % 5 === 4) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  console.log(`[folder-watcher] 扫描完成: 总计 ${allFiles.length}, 导入 ${imported}, 跳过 ${skipped}, 失败 ${failed}`);
  return { total: allFiles.length, imported, skipped, failed };
}

function getDefaultExtensions(): string[] {
  return [
    '.txt',
    '.epub',
    '.mobi',
    '.azw',
    '.azw3',
    '.pdf',
    '.cbz',
    '.cbr',
    '.cb7',
    '.cbt',
    '.zip',
    '.rar',
    '.7z',
    '.tar'
  ];
}

// ═══════════════════════════════════════════════════════════════
// ══ 2. http-source（已提取到 http-client.ts）══
// ═══════════════════════════════════════════════════════════════

import {
  httpRequest,
  fetchPage,
  setGlobalProxy,
  validateUrl,
  appendNetworkLog,
  DEFAULT_TIMEOUT,
  IMAGE_FETCH_HEADERS,
  type ProxyConfig,
  type FetchPageOptions,
  type FetchPageResult
} from './http-client';
import { getNetworkConfigHeaders } from './network-config';

// re-export 以保持外部导入兼容（index.ts / ipc.ts 等从 subscription 导入这些符号）
export { fetchPage, setGlobalProxy, validateUrl, type ProxyConfig, type FetchPageOptions, type FetchPageResult };

export async function fetchFullArticle(url: string): Promise<string | null> {
  try {
    const result = await fetchPage(url, { timeout: 15000, headers: getNetworkConfigHeaders() });
    if (result.status !== 200) return null;

    let html = result.body;

    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '');

    const articleMatch = html.match(/<article[\s\S]*?<\/article>/i);
    if (articleMatch) return articleMatch[0];

    const mainMatch = html.match(/<main[\s\S]*?<\/main>/i);
    if (mainMatch) return mainMatch[0];

    // 常见博客平台正文容器（用贪婪匹配 + 长度校验，避免非贪婪遇到嵌套</div>截断）
    const specificContainers = [
      /id=["']?cnblogs_post_body["']?[^>]*>([\s\S]*?)<\/div>\s*<(?:div|section)\s/i,
      /class=["'][^"']*blogpost-body[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<(?:div|section)\s/i,
      /id=["']?article[-_]?content["']?[^>]*>([\s\S]*?)<\/div>\s*<(?:div|section)\s/i,
      /class=["'][^"']*(?:post|entry|article)[-_]?content[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<(?:div|section)\s/i,
      /id=["']?post[-_]?body["']?[^>]*>([\s\S]*?)<\/div>\s*<(?:div|section)\s/i
    ];
    for (const re of specificContainers) {
      const m = html.match(re);
      if (m && m[1].length > 200) return m[1];
    }

    // 通用容器匹配（非贪婪，但要求足够长度）
    const containerRegex =
      /<div[^>]*(?:class|id)=["'][^"']*(?:content|article|post|entry|body|text)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
    const containerMatch = html.match(containerRegex);
    if (containerMatch && containerMatch[1].length > 500) {
      return containerMatch[0];
    }

    // Fallback：按出现顺序合并所有 <p> 和 <img> 标签（保留图片）
    const pAndImgRegex = /<(?:p[\s\S]*?<\/p|img[^>]*>)>/gi;
    const tags = html.match(pAndImgRegex);
    if (tags && tags.length > 0) {
      const combined = tags.join('\n\n');
      if (combined.length > 200) return combined;
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[http-source] 全文抓取失败: ${url}`, err);
    appendNetworkLog(`[ARTICLE-FAIL] 全文抓取失败: ${url} err=${msg}`);
    return null;
  }
}

function inferImageExt(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  return 'jpg';
}

export async function downloadCoverImage(url: string): Promise<string> {
  if (!url || !/^https?:\/\//i.test(url)) {
    return url;
  }

  try {
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return undefined;
      }
    })();

    // 复用统一 HTTP 客户端，获得重试、代理、超时、SSRF 防护支持
    const response = await httpRequest(url, {
      timeout: DEFAULT_TIMEOUT,
      headers: {
        ...IMAGE_FETCH_HEADERS,
        ...getNetworkConfigHeaders(),
        ...(origin ? { Referer: origin } : {})
      },
      responseType: 'buffer'
    });

    if (response.status < 200 || response.status >= 300) {
      const msg = `[http-source] 封面下载失败: HTTP ${response.status} url=${url}`;
      console.warn(msg);
      appendNetworkLog(`[COVER-FAIL] ${msg}`);
      return '';
    }

    const contentType = response.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) {
      const msg = `[http-source] 封面不是图片类型: ${contentType} url=${url}`;
      console.warn(msg);
      appendNetworkLog(`[COVER-FAIL] ${msg}`);
      return '';
    }

    const ext = inferImageExt(contentType);
    const buffer = response.data as Buffer;

    if (buffer.length < 1024) {
      const msg = `[http-source] 封面数据太小: ${buffer.length} bytes url=${url}`;
      console.warn(msg);
      appendNetworkLog(`[COVER-FAIL] ${msg}`);
      return '';
    }

    const hash = createHash('md5').update(url).digest('hex').slice(0, 16);
    const coversDir = getCoversRoot();
    const destPath = join(coversDir, `${hash}.${ext}`);

    await mkdir(coversDir, { recursive: true });
    await writeFile(destPath, buffer);

    return pathToFileURL(destPath).toString();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[http-source] 封面下载异常: ${url}`, err);
    appendNetworkLog(`[COVER-FAIL] 封面下载异常: ${url} err=${msg}`);
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════
// ══ 3. rss-parser ══
// ═══════════════════════════════════════════════════════════════

export interface FeedItem {
  title: string;
  link: string;
  pubDate: number | null;
  content: string;
  guid: string;
  author: string | null;
}

export interface FeedResult {
  title: string;
  description: string;
  link: string;
  items: FeedItem[];
}

let parserInstance: Parser | null = null;

function getParser(): Parser {
  if (!parserInstance) {
    // 注意：parseFeed 使用 fetchPage 先抓取内容再调用 parser.parseString，
    // parser 自身的 HTTP 头从不被使用，因此不设置自定义 headers 以避免误导。
    parserInstance = new Parser({
      timeout: 30000,
      maxRedirects: 5,
      headers: {}
    });
  }
  return parserInstance;
}

function parseDate(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const ts = Date.parse(dateStr);
  return Number.isNaN(ts) ? null : ts;
}

function extractAuthorFromContent(content: string): string | null {
  if (!content) return null;
  const match = content.match(/作者[：:]\s*(?:<span[^>]*>)?([^<\n，。、\s]+)(?:<\/span>)?/i);
  return match?.[1]?.trim() || null;
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function cleanAuthorName(raw: string): string {
  let trimmed = raw.trim();
  trimmed = trimmed.replace(/^作者[：:]\s*/i, '');
  const emailNameMatch = trimmed.match(/^[\w.+-]+@[\w.-]+\s*\((.+)\)$/i);
  if (emailNameMatch) return emailNameMatch[1].trim();
  if (/^[\w.+-]+@[\w.-]+$/.test(trimmed)) {
    return trimmed.split('@')[0];
  }
  return trimmed;
}

export async function parseFeed(url: string): Promise<FeedResult> {
  const parser = getParser();
  const result = await fetchPage(url, { timeout: 30000, headers: getNetworkConfigHeaders() });
  if (result.status !== 200) {
    throw new Error(`[rss-parser] HTTP ${result.status}: ${url}`);
  }
  const feed = await parser.parseString(result.body);

  const items: FeedItem[] = (feed.items ?? []).map((item) => {
    const rawItem = item as Record<string, unknown>;

    const content =
      (item.content as string) ??
      (item.summary as string) ??
      (rawItem['content:encoded'] as string) ??
      (rawItem.description as string) ??
      '';

    const rawAuthor = (rawItem.author as string | null) ?? (rawItem.creator as string | null);
    const author = rawAuthor ? cleanAuthorName(rawAuthor) : extractAuthorFromContent(content);

    return {
      title: cleanTitle(item.title ?? tMain('article.untitled')),
      link: item.link ?? '',
      pubDate: parseDate(item.isoDate ?? item.pubDate),
      content,
      guid: item.guid ?? item.link ?? '',
      author
    };
  });

  items.sort((a, b) => {
    if (a.pubDate === null && b.pubDate === null) return 0;
    if (a.pubDate === null) return 1;
    if (b.pubDate === null) return -1;
    return b.pubDate - a.pubDate;
  });

  return {
    title: feed.title ?? '',
    description: feed.description ?? '',
    link: feed.link ?? '',
    items
  };
}

export function filterNewItems(items: FeedItem[], lastGuid?: string, lastCheckAt?: number): FeedItem[] {
  if (!lastGuid && lastCheckAt === undefined) {
    return items;
  }

  let guidNewItems: FeedItem[] = [];
  if (lastGuid) {
    const idx = items.findIndex((it) => it.guid === lastGuid);
    if (idx === -1) {
      // lastGuid 不在当前 feed 中（可能已被新文章挤出列表），
      // 不能返回所有条目（会导致重复导入），改用时间过滤
      if (lastCheckAt !== undefined) {
        guidNewItems = items.filter((it) => it.pubDate !== null && it.pubDate > lastCheckAt);
      } else {
        // 没有时间参考，返回空（依赖后续 URL/guid 去重检查）
        guidNewItems = [];
      }
    } else if (idx > 0) {
      guidNewItems = items.slice(0, idx);
    }
  }

  let timeNewItems: FeedItem[] = [];
  if (lastCheckAt !== undefined) {
    timeNewItems = items.filter((it) => it.pubDate !== null && it.pubDate > lastCheckAt);
  }

  if (lastGuid && lastCheckAt !== undefined) {
    const seen = new Set<string>();
    const merged: FeedItem[] = [];
    for (const it of [...guidNewItems, ...timeNewItems]) {
      const key = it.guid || it.link;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(it);
      }
    }
    merged.sort((a, b) => {
      if (a.pubDate === null && b.pubDate === null) return 0;
      if (a.pubDate === null) return 1;
      if (b.pubDate === null) return -1;
      return b.pubDate - a.pubDate;
    });
    return merged;
  }

  return lastGuid ? guidNewItems : timeNewItems;
}

export async function checkRssUpdate(url: string, lastGuid?: string, lastCheckAt?: number): Promise<FeedItem[]> {
  try {
    const feed = await parseFeed(url);
    return filterNewItems(feed.items, lastGuid, lastCheckAt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[rss-parser] 解析 feed 失败: ${url}`, err);
    appendNetworkLog(`[RSS-FAIL] 解析 feed 失败: ${url} err=${msg}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// ══ 4. source-classifier ══
// ═══════════════════════════════════════════════════════════════

export type SourceKind = 'rssContent' | 'htmlContent' | 'opdsFeed' | 'unknown';

export type HtmlContentType = 'comic' | 'novel' | 'book';

export interface ClassifyResult {
  kind: SourceKind;
  body: string;
  contentType?: HtmlContentType;
  warning?: string;
}

/**
 * 检测文本是否为 XML feed（RSS/Atom/OPDS 1.x 通用，不区分具体类型）。
 * 仅判断根标签是否为 XML feed 候选，具体类型由 isOpdsFeed / classifySource 进一步区分。
 */
function isXmlFeed(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('<?xml') ||
    trimmed.startsWith('<rss') ||
    trimmed.startsWith('<feed') ||
    trimmed.startsWith('<RDF')
  );
}

/**
 * 检测 XML feed 文本是否为 OPDS 1.x（Atom XML 扩展）。
 * 判据：包含 OPDS acquisition link rel、opds 命名空间前缀，或 opds:f/opds:group 元素。
 * 参考：https://specs.opds.io/opds-1.2
 */
function isOpdsFeed(text: string): boolean {
  return (
    text.includes('http://opds-spec.org/acquisition') ||
    text.includes('xmlns:opds') ||
    text.includes('opds:f') ||
    text.includes('opds:group')
  );
}

function detectHtmlContentType(html: string): HtmlContentType | null {
  const lower = html.toLowerCase();

  if (lower.includes('property="og:type" content="book"')) return 'book';
  if (lower.includes('og:novel:')) return 'novel';
  if (lower.includes('property="og:type" content="comic"') || lower.includes('og:comic:')) return 'comic';

  const titleMatch = lower.match(/<title[^>]*>(.*?)<\/title>/);
  const title = titleMatch ? titleMatch[1] : '';
  const keywordsMatch = lower.match(/<meta\s+name="keywords"\s+content="([^"]*)"/);
  const keywords = keywordsMatch ? keywordsMatch[1] : '';

  if (title.match(/漫画|manga|comic|manhua|manhwa|webtoon/) || keywords.match(/漫画|manga|comic/)) {
    return 'comic';
  }
  if (title.match(/小说|novel|fiction|玄幻|都市|言情|穿越|修仙/) || keywords.match(/小说|novel|章节/)) {
    return 'novel';
  }

  const imgCount = (lower.match(/<img\s/g) || []).length;
  if (imgCount > 10) return 'comic';

  const chapterLinks = (lower.match(/章[节回]/g) || []).length;
  if (chapterLinks >= 3) return 'novel';

  if (lower.includes('intro') && lower.includes('cover') && lower.includes('chapter')) {
    return 'book';
  }

  return null;
}

export async function classifySource(url: string): Promise<ClassifyResult> {
  let body: string;
  try {
    const result = await fetchPage(url, { timeout: 30000, headers: getNetworkConfigHeaders() });
    if (result.status !== 200) {
      return {
        kind: 'unknown',
        body: '',
        warning: `HTTP ${result.status}`
      };
    }
    body = result.body;
  } catch (err) {
    return {
      kind: 'unknown',
      body: '',
      warning: err instanceof Error ? err.message : String(err)
    };
  }

  // 先检测 OPDS 2.0（JSON 格式）
  if (isOpds2Json(body)) {
    return { kind: 'opdsFeed', body };
  }

  // 再检测 XML feed（RSS/Atom/OPDS 1.x）
  if (isXmlFeed(body)) {
    // 区分 OPDS 1.x 和 RSS/Atom
    if (isOpdsFeed(body)) {
      return { kind: 'opdsFeed', body };
    }
    return { kind: 'rssContent', body };
  }

  // HTML 内容检测
  const htmlType = detectHtmlContentType(body);
  if (htmlType) {
    return {
      kind: 'htmlContent',
      body,
      contentType: htmlType,
      warning: `检测到 ${htmlType === 'comic' ? '漫画' : htmlType === 'novel' ? '小说' : '书籍'} 网页内容`
    };
  }

  return {
    kind: 'unknown',
    body,
    warning: '无法识别的格式（非 RSS/Atom XML，也非 OPDS，也非已知 HTML 内容）'
  };
}

// ═══════════════════════════════════════════════════════════════
// ══ 5. subscription-manager ══
// ═══════════════════════════════════════════════════════════════

const TIMER_INTERVAL = 60_000;
const CHECK_UPDATE_TIMEOUT = 300_000;

let timerHandle: NodeJS.Timeout | null = null;
let initialized = false;
// P1-16修复：定时器积压保护标志位
// setInterval 60秒触发 checkAllUpdates，但如果上次执行超过60秒，
// 多个实例会并发运行导致重复请求和资源浪费。用此标志位跳过重叠触发。
let isChecking = false;

/**
 * 新条目发现回调（用于 RSS 更新通知集成）
 *
 * 在 checkAllUpdates 中发现新内容时调用。由 index.ts 通过 setOnNewItemsCallback 注册，
 * 避免 subscription.ts 直接依赖 electron Notification API（解耦）。
 * 回调签名：(subscriptionName: string, newCount: number) => void
 */
let onNewItemsCallback: ((subscriptionName: string, newCount: number) => void) | null = null;

/**
 * 注册新条目发现回调
 *
 * @param cb 回调函数，传 null 可取消注册
 */
export function setOnNewItemsCallback(cb: ((subscriptionName: string, newCount: number) => void) | null): void {
  onNewItemsCallback = cb;
}

export interface UpdateResult {
  subscriptionId: number;
  subscriptionName: string;
  type: string;
  success: boolean;
  newCount: number;
  newItems?: FeedItem[];
  error?: string;
}

/**
 * 解析订阅配置 JSON（subscription-manager 版本）
 *
 * 容错：config 为 null 或非法 JSON 时返回空对象。
 */
function parseConfig(config: string | null): SubscriptionConfig {
  if (!config) return {};
  try {
    return JSON.parse(config) as SubscriptionConfig;
  } catch {
    return {};
  }
}

export async function addSubscription(input: CreateSubscriptionInput): Promise<number> {
  const sub = SubscriptionRepo.createSubscription(input);

  if (sub.type === 'rss' || sub.type === 'http') {
    let groupName = sub.name;

    if (sub.type === 'rss') {
      try {
        const feed = await parseFeed(sub.url);
        if (feed.title && feed.title.trim()) {
          groupName = feed.title.trim();
          if (!sub.name || sub.name.trim() === '') {
            SubscriptionRepo.updateSubscription(sub.id, { name: groupName });
          }
        }
      } catch (err) {
        console.warn(`[subscription] 解析 feed title 失败，使用用户输入名称: ${sub.url}`, err);
      }
    }

    try {
      const group = GroupRepo.createGroup({ name: groupName });
      const config = parseConfig(sub.config);
      config.groupId = group.id;
      SubscriptionRepo.updateSubscription(sub.id, { config: JSON.stringify(config) });
    } catch (err) {
      console.warn(`[subscription] 创建分组失败: ${groupName}`, err);
    }
  }

  if (sub.type === 'folder' && sub.enabled === 1) {
    const config = parseConfig(sub.config);
    const watchOpts = {
      extensions: config.extensions,
      recursive: config.recursive ?? true
    };
    watchFolder(sub.id, sub.url, watchOpts);

    scanExistingFiles(sub.id, sub.url, watchOpts, false)
      .then((result) => {
        if (result.imported > 0) {
          console.log(`[subscription] 初始扫描完成: 导入 ${result.imported} 本新书`);
        }
      })
      .catch((err) => {
        console.error(`[subscription] 初始扫描失败: id=${sub.id}`, err);
      });
  }

  return sub.id;
}

export async function removeSubscription(id: number): Promise<void> {
  const sub = SubscriptionRepo.getSubscription(id);
  if (!sub) return;

  if (sub.type === 'folder') {
    await unwatchFolder(id);
  }

  const books = SubscriptionRepo.getBooksBySubscription(id);
  const bookIds = books.map((b) => b.id);

  const config = parseConfig(sub.config);
  const groupId = config.groupId;

  const db = getDb();
  db.transaction(() => {
    if (bookIds.length > 0) {
      BookRepo.deleteBooks(bookIds);
      console.log(`[subscription] 删除订阅 ${sub.name}: 已删除 ${bookIds.length} 本关联书籍`);
    }

    if (groupId) {
      try {
        GroupRepo.deleteGroup(groupId);
        console.log(`[subscription] 删除订阅 ${sub.name}: 已删除分组 groupId=${groupId}`);
      } catch (err) {
        console.warn(`[subscription] 删除分组失败（可能已不存在）: groupId=${groupId}`, err);
      }
    }

    SubscriptionRepo.deleteSubscription(id);
  })();

  // 异步清理 RSS 图片缓存目录
  for (const bookId of bookIds) {
    rm(join(getUserDataRoot(), 'rss-images', String(bookId)), { recursive: true, force: true }).catch((e) =>
      console.warn('[cleanup] 操作失败:', e)
    );
  }

  console.log(`[subscription] 订阅 "${sub.name}" 已删除（含 ${bookIds.length} 本书籍 + 分组）`);
}

export function listSubscriptions(): Subscription[] {
  return SubscriptionRepo.listSubscriptions();
}

export function getSubscription(id: number): Subscription | undefined {
  return SubscriptionRepo.getSubscription(id);
}

export async function updateSubscription(id: number, input: UpdateSubscriptionInput): Promise<void> {
  const existing = SubscriptionRepo.getSubscription(id);
  if (!existing) {
    throw new Error(`[subscription] 订阅不存在: id=${id}`);
  }

  SubscriptionRepo.updateSubscription(id, input);

  if (existing.type === 'folder') {
    const urlChanged = input.url !== undefined && input.url !== existing.url;
    const enabledChanged = input.enabled !== undefined && input.enabled !== existing.enabled;
    if (urlChanged || enabledChanged) {
      await unwatchFolder(id);
      const updated = SubscriptionRepo.getSubscription(id);
      if (updated && updated.enabled === 1) {
        const config = parseConfig(updated.config);
        watchFolder(id, updated.url, {
          extensions: config.extensions,
          recursive: config.recursive ?? true
        });
      }
    }
  }
}

export async function checkUpdate(id: number): Promise<UpdateResult> {
  const sub = SubscriptionRepo.getSubscription(id);
  if (!sub) {
    return {
      subscriptionId: id,
      subscriptionName: '',
      type: 'folder',
      success: false,
      newCount: 0,
      error: '订阅不存在'
    };
  }

  const now = Date.now();
  const config = parseConfig(sub.config);

  let timeoutTimer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<UpdateResult>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error('检查更新超时')), CHECK_UPDATE_TIMEOUT);
  });

  try {
    const workPromise = doCheckUpdate(sub, config);
    const result = await Promise.race([workPromise, timeoutPromise]);

    SubscriptionRepo.updateLastCheckAt(id, now);

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[subscription] 检查更新失败: id=${id}`, err);
    appendNetworkLog(`[SUB-FAIL] 检查更新失败: id=${id} name="${sub.name}" err=${message}`);
    SubscriptionRepo.updateLastCheckAt(id, now);
    return {
      subscriptionId: id,
      subscriptionName: sub.name,
      type: sub.type,
      success: false,
      newCount: 0,
      error: message
    };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

async function doCheckUpdate(sub: Subscription, config: SubscriptionConfig): Promise<UpdateResult> {
  switch (sub.type) {
    case 'folder':
      return checkFolderUpdate(sub, config);

    case 'rss':
      return checkRssSourceUpdate(sub, config);

    default:
      return {
        subscriptionId: sub.id,
        subscriptionName: sub.name,
        type: sub.type,
        success: false,
        newCount: 0,
        error: `不支持的订阅类型: ${sub.type}`
      };
  }
}

async function checkFolderUpdate(sub: Subscription, config: SubscriptionConfig): Promise<UpdateResult> {
  const scanResult = await scanExistingFiles(
    sub.id,
    sub.url,
    {
      extensions: config.extensions,
      recursive: config.recursive ?? true
    },
    true
  );

  const updatedBooks = SubscriptionRepo.getUpdatedBooksBySubscription(sub.id);

  return {
    subscriptionId: sub.id,
    subscriptionName: sub.name,
    type: 'folder',
    success: true,
    newCount: scanResult.imported + updatedBooks.length
  };
}

async function checkRssSourceUpdate(sub: Subscription, config: SubscriptionConfig): Promise<UpdateResult> {
  const newItems = await checkRssUpdate(sub.url, config.lastGuid, sub.last_check_at ?? undefined);

  let importedCount = 0;
  for (const item of newItems) {
    // 去重：用 link 或 guid 检查是否已导入过（防止重复载入）
    const dedupKey = item.link || item.guid;
    if (dedupKey) {
      const existing = SubscriptionRepo.getBookBySubscriptionAndUrl(sub.id, dedupKey);
      if (existing) {
        // 已存在，跳过不重复导入
        continue;
      }
    }

    try {
      await importRssItemAsBook(sub.id, item, config.groupId);
      importedCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[subscription] RSS 条目导入失败: ${item.title}`, err);
      appendNetworkLog(`[SUB-FAIL] RSS 条目导入失败: subId=${sub.id} title="${item.title}" err=${msg}`);
    }
  }

  if (newItems.length > 0 && newItems[0].guid) {
    const newConfig: SubscriptionConfig = { ...config, lastGuid: newItems[0].guid };
    SubscriptionRepo.updateSubscription(sub.id, { config: JSON.stringify(newConfig) });
  }

  return {
    subscriptionId: sub.id,
    subscriptionName: sub.name,
    type: 'rss',
    success: true,
    newCount: importedCount, // R4修复：返回实际导入数而非newItems.length（部分可能被去重跳过）
    newItems
  };
}

async function importRssItemAsBook(subscriptionId: number, item: FeedItem, groupId?: number): Promise<void> {
  // 去重防线：导入前再检查一次，避免并发或 filterNewItems 漏判导致重复
  const dedupKey = item.link || item.guid;
  if (dedupKey) {
    const existing = SubscriptionRepo.getBookBySubscriptionAndUrl(subscriptionId, dedupKey);
    if (existing) {
      console.log(`[subscription] RSS 条目已存在，跳过: "${item.title}"`);
      return;
    }
  }

  let rawHtml = item.content || item.title || '(无内容)';

  if (item.link) {
    rawHtml = resolveRelativeUrls(rawHtml, item.link);
  }

  // P2-14 修复：RSS 内容解析后调用 convertSemanticHtmlToMarkers 处理语义 HTML 标签
  // 将 <table>/<pre>/<blockquote>/<h1>~<h6>/<li> 等转为 [TABLE][/TABLE]、[CODE][/CODE]、
  // [QUOTE][/QUOTE]、[H1][/H1] 等富文本标记，与 EPUB/MOBI 正文处理流程保持一致。
  // 若不调用，渲染器无法识别 RSS 正文中的表格/代码块/引用等语义结构，仅显示纯文本。
  rawHtml = convertSemanticHtmlToMarkers(rawHtml);

  const imgCount =
    (rawHtml.match(/<img[^>]+src=/gi) ?? []).length + (rawHtml.match(/<image[^>]+(?:href|xlink:href)=/gi) ?? []).length;

  const plainTextInitial = rssHtmlToPlainText(rawHtml);
  const coverRemote = extractFirstImageFromHtml(rawHtml);

  let coverLocal: string | undefined;
  if (coverRemote) {
    try {
      coverLocal = await downloadCoverImage(coverRemote);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[subscription] RSS 封面下载失败: ${coverRemote}`, err);
      appendNetworkLog(`[COVER-FAIL] RSS 封面下载失败: ${coverRemote} err=${msg}`);
    }
  }

  const book = getDb().transaction(() => {
    const created = BookRepo.createBook({
      title: item.title,
      author: item.author ?? undefined,
      file_type: 'rss',
      total_chapters: 1,
      subscription_id: subscriptionId,
      source_url: item.link || item.guid,
      group_id: groupId ?? null,
      intro:
        plainTextInitial
          .replace(/\[IMG:[^\]]+\]/g, '')
          .trim()
          .slice(0, 200) || undefined,
      cover: coverLocal || coverRemote || undefined
    });

    ChapterRepo.batchInsertChapterIndexes([
      {
        book_id: created.id,
        chapter_index: 0,
        title: item.title,
        content_type: imgCount > 1 ? 'illustrated' : 'text'
      }
    ]);
    ChapterRepo.setChapterContent(created.id, 0, rawHtml);
    SubscriptionRepo.markBookUpdate(created.id, true);
    return created;
  })();

  console.log(`[subscription] RSS 条目导入: "${item.title}" → bookId=${book.id}（全文/图片后台抓取中）`);

  fetchFullContentAndUpdateBook(book.id, rawHtml, item.link).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[subscription] 后台抓取失败: bookId=${book.id}`, err);
    appendNetworkLog(`[SUB-FAIL] 后台抓取失败: bookId=${book.id} title="${item.title}" err=${msg}`);
  });
}

async function fetchFullContentAndUpdateBook(bookId: number, rawHtml: string, articleUrl?: string): Promise<void> {
  let finalHtml = rawHtml;

  // 总是尝试抓取全文（RSS摘要通常缺少图片和完整内容）
  if (articleUrl) {
    try {
      const fullArticle = await fetchFullArticle(articleUrl);
      if (fullArticle && fullArticle.length > rawHtml.length) {
        console.log(`[subscription] 全文抓取成功: bookId=${bookId}（${rawHtml.length} → ${fullArticle.length}字符）`);
        finalHtml = fullArticle;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[subscription] 全文抓取失败，使用摘要: bookId=${bookId}`, err);
      appendNetworkLog(`[ARTICLE-FAIL] 全文抓取失败使用摘要: bookId=${bookId} url=${articleUrl} err=${msg}`);
    }
  }

  if (articleUrl) {
    finalHtml = resolveRelativeUrls(finalHtml, articleUrl);
  }

  const imageDir = join(getUserDataRoot(), 'rss-images', String(bookId));
  const localHtml = await downloadImagesToLocal(finalHtml, imageDir, articleUrl);

  // P2-14 修复：全文抓取并下载图片后，同样调用 convertSemanticHtmlToMarkers
  // 处理全文中可能新增的语义 HTML 标签（全文比摘要更可能含表格/代码块等结构）。
  // 注意：此处必须在 downloadImagesToLocal 之后调用，否则 <img> 标签已转为 [IMG:] 标记，
  // convertSemanticHtmlToMarkers 不会处理 [IMG:]，但会处理剩余的 <table>/<pre> 等。
  const localHtmlWithMarkers = convertSemanticHtmlToMarkers(localHtml);

  ChapterRepo.setChapterContent(bookId, 0, localHtmlWithMarkers);

  // 全文抓取后更新 content_type（摘要0图→text，但全文可能有图→illustrated）
  const finalImgCount = (localHtmlWithMarkers.match(/<img[^>]+src=/gi) ?? []).length;
  if (finalImgCount > 1) {
    try {
      getDb()
        .prepare('UPDATE chapters SET content_type = ? WHERE book_id = ? AND chapter_index = 0')
        .run('illustrated', bookId);
    } catch {
      /* 非致命 */
    }
  }

  // 仅在书籍无本地封面时才尝试从全文提取封面（避免重复下载）
  const existingBook = BookRepo.getBookById(bookId);
  const hasLocalCover = existingBook?.cover?.startsWith('file:');
  if (!hasLocalCover) {
    const localCover = extractFirstImageFromHtml(localHtmlWithMarkers);
    if (localCover) {
      if (localCover.startsWith('file:')) {
        BookRepo.updateBook(bookId, { cover: localCover });
      } else {
        try {
          const downloadedCover = await downloadCoverImage(localCover);
          if (downloadedCover) {
            BookRepo.updateBook(bookId, { cover: downloadedCover });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[subscription] 后台封面下载失败: ${localCover}`, err);
          appendNetworkLog(`[COVER-FAIL] 后台封面下载失败: ${localCover} bookId=${bookId} err=${msg}`);
        }
      }
    }
  }

  console.log(`[subscription] 后台抓取完成: bookId=${bookId}`);
}

const MAX_IMAGES_PER_ARTICLE = 50;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;

async function downloadImagesToLocal(html: string, imageDir: string, baseUrl?: string): Promise<string> {
  // 匹配 <img> 标签，同时提取 width/height 属性用于过滤跟踪像素
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  const matches: Array<{ fullMatch: string; url: string; width: number; height: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = imgRegex.exec(html)) !== null) {
    const tag = m[0];
    const url = m[1];
    const w = parseInt(tag.match(/width=["']?(\d+)/i)?.[1] || '0');
    const h = parseInt(tag.match(/height=["']?(\d+)/i)?.[1] || '0');
    matches.push({ fullMatch: tag, url, width: w, height: h });
  }

  if (matches.length === 0) return html;

  // 过滤跟踪像素（width/height <= 1）和明显的装饰图标
  const isDecorative = (url: string, w: number, h: number): boolean => {
    if (w > 0 && w <= 1) return true;
    if (h > 0 && h <= 1) return true;
    const lower = url.toLowerCase();
    if (lower.includes('favicon') || lower.includes('tracker') || lower.includes('pixel')) return true;
    return false;
  };

  const imagesToDownload = matches
    .filter(({ url, width, height }) => !isDecorative(url, width, height))
    .slice(0, MAX_IMAGES_PER_ARTICLE);

  // 被过滤的图片直接从HTML中移除（避免阅读器加载403远程URL）
  const skippedUrls = new Set(
    matches.filter(({ url, width, height }) => isDecorative(url, width, height)).map((m) => m.url)
  );

  await mkdir(imageDir, { recursive: true });

  const CONCURRENCY = 3;
  const urlReplacements = new Map<string, string>();
  const failedUrls = new Set<string>();

  for (let i = 0; i < imagesToDownload.length; i += CONCURRENCY) {
    const batch = imagesToDownload.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async ({ url }) => {
        if (url.startsWith('file:') || url.startsWith('data:')) return;

        let absoluteUrl = url;
        if (baseUrl && !url.startsWith('http://') && !url.startsWith('https://')) {
          try {
            absoluteUrl = new URL(url, baseUrl).href;
          } catch {
            return;
          }
        }

        try {
          // 复用统一 HTTP 客户端，获得重试、代理、超时、SSRF 防护支持
          // 批量图片下载关闭请求间隔限速，避免批量下载过慢
          const response = await httpRequest(absoluteUrl, {
            timeout: IMAGE_DOWNLOAD_TIMEOUT_MS,
            headers: {
              ...IMAGE_FETCH_HEADERS,
              ...getNetworkConfigHeaders(),
              ...(baseUrl ? { Referer: baseUrl } : {})
            },
            responseType: 'buffer',
            applyInterval: false
          });

          if (response.status < 200 || response.status >= 300) {
            console.warn(`[subscription] 图片下载HTTP ${response.status}: ${url.slice(0, 80)}`);
            appendNetworkLog(`[IMG-FAIL] HTTP ${response.status}: ${url.slice(0, 200)}`);
            failedUrls.add(url);
            return;
          }

          const contentLength = response.headers['content-length'];
          if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE_BYTES) {
            console.warn(`[subscription] 图片过大跳过: ${url} (${contentLength} bytes)`);
            appendNetworkLog(`[IMG-FAIL] 图片过大: ${url.slice(0, 200)} (${contentLength} bytes)`);
            failedUrls.add(url);
            return;
          }

          const contentType = response.headers['content-type'] ?? '';
          if (contentType && !contentType.startsWith('image/')) {
            console.warn(`[subscription] 非图片类型跳过: ${contentType} ${url.slice(0, 60)}`);
            appendNetworkLog(`[IMG-FAIL] 非图片类型: ${contentType} ${url.slice(0, 200)}`);
            failedUrls.add(url);
            return;
          }

          const ext = contentType.includes('png')
            ? '.png'
            : contentType.includes('webp')
              ? '.webp'
              : contentType.includes('gif')
                ? '.gif'
                : contentType.includes('svg')
                  ? '.svg'
                  : '.jpg';

          const buffer = response.data as Buffer;
          if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
            console.warn(`[subscription] 图片实际大小超限跳过: ${url} (${buffer.length} bytes)`);
            appendNetworkLog(`[IMG-FAIL] 图片实际大小超限: ${url.slice(0, 200)} (${buffer.length} bytes)`);
            failedUrls.add(url);
            return;
          }

          const hash = createHash('md5').update(url).digest('hex').slice(0, 12);
          const filename = `${hash}${ext}`;
          const localPath = join(imageDir, filename);

          await writeFile(localPath, buffer);

          const fileUrl = pathToFileURL(localPath).toString();
          urlReplacements.set(url, fileUrl);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[subscription] 图片下载失败: ${url.slice(0, 80)}`);
          appendNetworkLog(`[IMG-FAIL] 图片下载失败: ${url.slice(0, 200)} err=${msg}`);
          failedUrls.add(url);
        }
      })
    );
  }

  let result = html;
  // 替换成功下载的图片
  for (const [originalUrl, fileUrl] of urlReplacements) {
    result = result.split(originalUrl).join(fileUrl);
  }
  // P1-20修复：下载失败的图片用占位符文本替换整个img标签，让用户感知加载失败
  // 此前直接将URL替换为空字符串，img标签src变空，用户无法知道图片加载失败
  for (const url of failedUrls) {
    // 转义URL中的正则特殊字符，避免正则注入
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 将包含失败URL的img标签替换为可见的占位符文本
    const imgTagRegex = new RegExp(`<img[^>]*src=["']${escapedUrl}["'][^>]*>`, 'gi');
    result = result.replace(imgTagRegex, '<span style="color:#999;font-style:italic;">[图片加载失败]</span>');
    // 如果URL还出现在其他地方（如srcset、data-src属性），也清理掉避免残留
    result = result.split(url).join('');
  }
  // 装饰性图片（跟踪像素等）仍静默移除，不需要占位符
  for (const url of skippedUrls) {
    result = result.split(url).join('');
  }

  return result;
}

function extractFirstImageFromHtml(html: string): string | null {
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch?.[1]) return imgMatch[1];
  const svgMatch = html.match(/<image[^>]+(?:href|xlink:href)=["']([^"']+)["']/i);
  if (svgMatch?.[1]) return svgMatch[1];
  return null;
}

function resolveRelativeUrls(html: string, baseUrl: string): string {
  return html
    .replace(/(<img[^>]+src=["'])([^"']+)(["'])/gi, (_match, prefix, url, suffix) => {
      return prefix + resolveUrl(url, baseUrl) + suffix;
    })
    .replace(/(<image[^>]+(?:href|xlink:href)=["'])([^"']+)(["'])/gi, (_match, prefix, url, suffix) => {
      return prefix + resolveUrl(url, baseUrl) + suffix;
    });
}

function resolveUrl(url: string, baseUrl: string): string {
  if (/^(https?:|file:|data:|\/\/)/i.test(url)) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function rssHtmlToPlainText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi, (_match, src) => `\n\n[IMG:${src}]\n\n`)
    .replace(/<image[^>]+(?:href|xlink:href)=["']([^"']+)["'][^>]*\/>/gi, (_match, href) => `\n\n[IMG:${href}]\n\n`)
    .replace(/<\/(p|div|br|h[1-6]|li|tr)>/gi, '\n\n')
    .replace(/<(p|div|h[1-6]|li|tr)[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function checkAllUpdates(): Promise<void> {
  // P1-16修复：防止定时器积压——如果上一次检查尚未完成，跳过本次
  // setInterval 不等待 async 回调完成，若 checkAllUpdates 耗时超过 TIMER_INTERVAL，
  // 多次调用会并发执行导致重复请求和资源浪费
  if (isChecking) {
    console.log('[subscription] 上一次检查尚未完成，跳过本次定时检查');
    return;
  }
  isChecking = true;
  try {
    const dueSubs = SubscriptionRepo.getSubscriptionsDue();
    if (dueSubs.length === 0) return;

    console.log(`[subscription] 检查 ${dueSubs.length} 个到期订阅`);

    for (const sub of dueSubs) {
      try {
        const result = await checkUpdate(sub.id);
        if (result.success && result.newCount > 0) {
          console.log(`[subscription] "${result.subscriptionName}" 发现 ${result.newCount} 个新条目`);
          // 通知回调（用于 RSS 更新通知，由 index.ts 注册）
          if (onNewItemsCallback) {
            try {
              onNewItemsCallback(result.subscriptionName, result.newCount);
            } catch (cbErr) {
              console.warn('[subscription] 新条目回调执行失败:', cbErr);
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[subscription] 检查订阅 ${sub.id} 异常:`, err);
        appendNetworkLog(`[SUB-FAIL] 定时检查订阅异常: id=${sub.id} err=${msg}`);
      }
    }
  } finally {
    isChecking = false;
  }
}

export function startTimer(): void {
  if (timerHandle) {
    console.log('[subscription] 定时器已在运行');
    return;
  }

  timerHandle = setInterval(() => {
    // P1-16修复：并发guard已在 checkAllUpdates 内部通过 isChecking 标志位实现，
    // 此处只需调用即可。若上一次检查未完成，checkAllUpdates 会自动跳过。
    checkAllUpdates().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[subscription] 定时检查异常:', err);
      appendNetworkLog(`[SUB-FAIL] 定时检查异常: err=${msg}`);
    });
  }, TIMER_INTERVAL);

  console.log(`[subscription] 定时器已启动，间隔 ${TIMER_INTERVAL}ms`);
}

export function stopTimer(): void {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
    console.log('[subscription] 定时器已停止');
  }
}

export function init(): void {
  if (initialized) {
    console.log('[subscription] 已初始化，跳过');
    return;
  }

  try {
    const fixed = getDb()
      .prepare(
        `UPDATE chapters SET content_type = 'illustrated'
       WHERE content_type = 'image'
         AND book_id IN (SELECT id FROM books WHERE file_type = 'rss')`
      )
      .run();
    if (fixed.changes > 0) {
      console.log(`[subscription] 修复 ${fixed.changes} 个 RSS 章节的 content_type: image → illustrated`);
    }
  } catch (err) {
    console.warn('[subscription] 修复旧 RSS content_type 失败（非致命）:', err);
  }

  const subs = SubscriptionRepo.listEnabledSubscriptions();
  for (const sub of subs) {
    if (sub.type === 'folder') {
      watchFromSubscription(sub.id);

      const config = parseConfig(sub.config);
      scanExistingFiles(
        sub.id,
        sub.url,
        {
          extensions: config.extensions,
          recursive: config.recursive ?? true
        },
        true
      )
        .then((result) => {
          if (result.imported > 0) {
            console.log(`[subscription] 启动扫描: ${sub.name} 导入 ${result.imported} 本新书`);
          }
        })
        .catch((err) => {
          console.error(`[subscription] 启动扫描失败: ${sub.name}`, err);
        });
    }
  }

  startTimer();

  initialized = true;
  console.log(`[subscription] 初始化完成，恢复 ${subs.filter((s) => s.type === 'folder').length} 个文件夹监控`);
}

export async function shutdown(): Promise<void> {
  stopTimer();
  await unwatchAllFolders();
  initialized = false;
  console.log('[subscription] 已关闭');
}

export function getBooksBySubscription(subscriptionId: number) {
  return SubscriptionRepo.getBooksBySubscription(subscriptionId);
}

export function getUpdatedBooksBySubscription(subscriptionId: number) {
  return SubscriptionRepo.getUpdatedBooksBySubscription(subscriptionId);
}

export function listUpdatedBooks() {
  return SubscriptionRepo.listUpdatedBooks();
}

export function markBookUpdate(bookId: number, hasUpdate: boolean): void {
  SubscriptionRepo.markBookUpdate(bookId, hasUpdate);
}

export function clearAllBookUpdates(): void {
  const books = SubscriptionRepo.listUpdatedBooks();
  for (const book of books) {
    SubscriptionRepo.markBookUpdate(book.id, false);
  }
}

export interface AddSmartResult {
  kind: 'subscription' | 'opds';
  subscriptionId?: number;
  subscriptionName?: string;
  contentType?: string;
  warning?: string;
}

export async function addSmartSource(url: string, name?: string): Promise<AddSmartResult> {
  const classification = await classifySource(url);

  // 检测到 OPDS feed：返回 opds 标记，由前端调用 OPDS 添加目录 API
  if (classification.kind === 'opdsFeed') {
    console.log(`[subscription] 智能分类: URL 识别为 OPDS 书库目录`);
    return {
      kind: 'opds',
      subscriptionName: name ?? '',
      warning: classification.warning
    };
  }

  const subType = classification.kind === 'rssContent' ? 'rss' : 'http';
  if (classification.kind === 'rssContent') {
    console.log(`[subscription] 智能分类: URL 识别为 RSS/Atom 内容订阅`);
  } else if (classification.kind === 'htmlContent') {
    console.log(`[subscription] 智能分类: URL 识别为 HTML 内容（${classification.contentType ?? '未知类型'}）`);
  } else {
    console.log(`[subscription] 智能分类: URL 格式未识别，当 HTTP 内容订阅处理: ${classification.warning ?? ''}`);
  }

  const subId = await addSubscription({
    name: name ?? '',
    type: subType,
    url,
    enabled: 1,
    auto_import: 1
  });

  const sub = SubscriptionRepo.getSubscription(subId);

  return {
    kind: 'subscription',
    subscriptionId: subId,
    subscriptionName: sub?.name ?? name ?? '',
    contentType: classification.contentType,
    warning: classification.kind === 'unknown' ? classification.warning : undefined
  };
}

// ═══════════════════════════════════════════════════════════════
// ══ OPDS Parser（合并自 opds-parser.ts） ══
// ═══════════════════════════════════════════════════════════════

/**
 * OPDS (Open Publication Distribution System) Feed 解析器
 *
 * 支持 OPDS 1.x（Atom XML 格式），参考 Readest 和 Foliate 的实现。
 *
 * 功能：
 * 1. 解析 OPDS Feed 的目录结构：导航链接、分类、书籍条目
 * 2. 提取书籍信息：标题、作者、封面、简介、下载链接、格式
 * 3. 支持分页（next 链接）
 * 4. 支持 OpenSearch 模板
 */

/* ==================== 类型定义 ==================== */

/** OPDS 目录配置 */
export interface OpdsCatalog {
  id: number;
  name: string;
  url: string;
  hasAuth?: boolean;
}

/** OPDS 书籍条目 */
export interface OpdsEntry {
  title: string;
  author: string;
  summary: string;
  coverUrl?: string;
  downloadUrl: string;
  format: string; // epub, pdf, txt
  categories: string[];
  /** 条目的唯一标识（用于去重） */
  id?: string;
  /** 所有可用格式（多格式下载时） */
  formats?: Array<{ format: string; url: string }>;
  /** 语言（如 en, zh-CN） */
  language?: string;
  /** 出版社 */
  publisher?: string;
  /** 出版日期 */
  publishedDate?: string;
  /** 付费/借阅/试读标记；free 或未设置表示可免费下载 */
  acquisitionType?: 'free' | 'buy' | 'borrow' | 'sample';
}

/** OPDS 导航链接（分类/子目录） */
export interface OpdsNavigationLink {
  title: string;
  href: string;
  /** rel 类型：subsection, acquisition, etc. */
  rel: string;
  /** 是否为分类导航链接 */
  isNavigation: boolean;
}

/** OPDS Feed 解析结果 */
export interface OpdsFeed {
  title: string;
  /** 导航链接列表（分类/子目录） */
  navigationLinks: OpdsNavigationLink[];
  /** 书籍条目列表 */
  entries: OpdsEntry[];
  /** 下一页链接（分页） */
  nextLink?: string;
  /** 上一页链接 */
  previousLink?: string;
  /** 搜索模板 URL */
  searchUrl?: string;
  /** self 链接（当前 feed 的 URL） */
  selfLink?: string;
  /** Facet 筛选链接（按分组组织） */
  facets?: Array<{ group: string; title: string; href: string; active?: boolean }>;
}

/* ==================== XML 解析工具 ==================== */

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
  cdataPropName: '__cdata',
  textNodeName: '#text',
  isArray: (tagName: string, _jPath: unknown, _isLeafNode: boolean, _isAttribute: boolean): boolean => {
    const localName = tagName.includes(':') ? tagName.substring(tagName.indexOf(':') + 1) : tagName;
    if (localName === 'entry' || localName === 'link' || localName === 'author' || localName === 'category') {
      return true;
    }
    return false;
  }
});

function parseXml(xmlText: string): Record<string, unknown> | null {
  try {
    const result = xmlParser.parse(xmlText);
    if (result && typeof result === 'object') {
      return result as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/* ==================== 命名空间与节点遍历辅助 ==================== */

function getLocalName(name: string): string {
  const colonIndex = name.indexOf(':');
  return colonIndex === -1 ? name : name.substring(colonIndex + 1);
}

function isElementLocalName(key: string, localName: string): boolean {
  if (key.startsWith('@_') || key === '#text' || key === '__cdata') return false;
  return getLocalName(key) === localName;
}

function findChildren(node: unknown, localName: string): unknown[] {
  const result: unknown[] = [];
  if (!node || typeof node !== 'object') return result;

  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!isElementLocalName(key, localName)) continue;
    const value = obj[key];
    if (Array.isArray(value)) {
      result.push(...value);
    } else if (value !== null && value !== undefined) {
      result.push(value);
    }
  }
  return result;
}

function findFirstChild(node: unknown, localName: string): unknown | null {
  const children = findChildren(node, localName);
  return children.length > 0 ? children[0] : null;
}

function getTextContent(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const text = obj['#text'];
    if (typeof text === 'string') return text;
    if (typeof text === 'number' || typeof text === 'boolean') return String(text);
    const cdata = obj['__cdata'];
    if (typeof cdata === 'string') return cdata;
    return '';
  }
  return '';
}

function getAttribute(node: unknown, attrName: string): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  const directKey = `@_${attrName}`;
  const direct = obj[directKey];
  if (typeof direct === 'string') return direct;
  if (typeof direct === 'number' || typeof direct === 'boolean') return String(direct);

  for (const key of Object.keys(obj)) {
    if (!key.startsWith('@_')) continue;
    const attrKey = key.substring(2);
    const colonIndex = attrKey.indexOf(':');
    if (colonIndex !== -1 && attrKey.substring(colonIndex + 1) === attrName) {
      const val = obj[key];
      if (typeof val === 'string') return val;
      if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    }
  }
  return null;
}

function getLinkRel(linkNode: unknown): string {
  return getAttribute(linkNode, 'rel') || '';
}

function getLinkHref(linkNode: unknown): string {
  return getAttribute(linkNode, 'href') || '';
}

function getLinkType(linkNode: unknown): string {
  return getAttribute(linkNode, 'type') || '';
}

/* ==================== OPDS Feed 解析 ==================== */

/**
 * 对 OPDS 条目去重
 *
 * 去重策略（三层）：
 * 1. 有非空 id → 按 id 去重
 * 2. 无 id → 按 title|author 去重
 * 3. 最后按 title|author|downloadUrl 做兜底去重（处理不同 id 但内容完全相同的条目）
 *
 * 这解决了"同一本书显示为两条完全相同记录"的问题：
 * 某些 OPDS feed 会为同一本书发布多个不同 id 的 entry，但 title/author/downloadUrl 完全一致。
 */
function deduplicateOpdsEntries(entries: OpdsEntry[]): OpdsEntry[] {
  const seenIds = new Set<string>();
  const seenTitleAuthor = new Set<string>();
  const seenContentKey = new Set<string>();
  const result: OpdsEntry[] = [];

  for (const entry of entries) {
    // 第一层：按非空 id 去重
    const id = entry.id?.trim();
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }

    // 第二层：按 title|author 去重
    const titleAuthorKey = `${entry.title}|${entry.author}`;
    if (seenTitleAuthor.has(titleAuthorKey)) continue;

    // 第三层：按 title|author|downloadUrl 兜底去重
    const contentKey = `${entry.title}|${entry.author}|${entry.downloadUrl}`;
    if (seenContentKey.has(contentKey)) continue;

    seenTitleAuthor.add(titleAuthorKey);
    seenContentKey.add(contentKey);
    result.push(entry);
  }

  return result;
}

export function parseOpdsFeed(xmlText: string, baseUrl: string): OpdsFeed {
  const root = parseXml(xmlText);
  if (!root) {
    return {
      title: '',
      navigationLinks: [],
      entries: []
    };
  }

  let feedNode: unknown = null;
  for (const key of Object.keys(root)) {
    if (isElementLocalName(key, 'feed')) {
      feedNode = root[key];
      break;
    }
  }
  if (!feedNode) {
    return {
      title: '',
      navigationLinks: [],
      entries: []
    };
  }

  const titleNode = findFirstChild(feedNode, 'title');
  const title = titleNode ? getTextContent(titleNode) : '';

  const linkNodes = findChildren(feedNode, 'link');
  let nextLink: string | undefined;
  let previousLink: string | undefined;
  let searchUrl: string | undefined;
  let selfLink: string | undefined;
  const facets: Array<{ group: string; title: string; href: string; active?: boolean }> = [];

  for (const linkNode of linkNodes) {
    const rel = getLinkRel(linkNode);
    const href = getLinkHref(linkNode);
    if (!href) continue;

    const fullUrl = resolveOpdsUrl(href, baseUrl);

    if (rel === 'next') {
      nextLink = fullUrl;
    } else if (rel === 'previous' || rel === 'prev') {
      previousLink = fullUrl;
    } else if (rel === 'self') {
      selfLink = fullUrl;
    } else if (rel === 'search') {
      searchUrl = fullUrl;
    } else if (rel === 'http://opds-spec.org/facet' || rel.startsWith('facet') || rel.includes('/facet')) {
      // OPDS facet 筛选链接：按 facetGroup 分组，title 为显示名称
      const facetGroup = getAttribute(linkNode, 'facetGroup') || getAttribute(linkNode, 'opds:facetGroup') || '默认';
      const facetTitle = getAttribute(linkNode, 'title') || href;
      // P2 修复：facet active 状态应通过 active 属性判断，而非 rel.includes('active')。
      // OPDS 规范中 active 是 link 元素的布尔属性（active="true"），
      // rel 值为 'http://opds-spec.org/facet'，不包含 'active' 字符串。
      // 原实现 rel.includes('active') 永远为 false，导致当前选中 facet 不高亮。
      // 同时兼容 thr:active 属性（部分源使用该命名空间）。
      const activeAttr = getAttribute(linkNode, 'active') || getAttribute(linkNode, 'thr:active');
      facets.push({
        group: facetGroup,
        title: facetTitle,
        href: fullUrl,
        active: activeAttr === 'true' || activeAttr === '1'
      });
    }
  }

  for (const linkNode of linkNodes) {
    const rel = getLinkRel(linkNode);
    const href = getLinkHref(linkNode);
    if (rel === 'search' && href && href.includes('{searchTerms}')) {
      searchUrl = resolveOpdsUrl(href, baseUrl);
    }
  }

  const navigationLinks: OpdsNavigationLink[] = [];
  const entries: OpdsEntry[] = [];

  const entryNodes = findChildren(feedNode, 'entry');
  for (const entryNode of entryNodes) {
    const entryLinks = findChildren(entryNode, 'link');
    // 判断是否含有 acquisition 链接（包括免费下载和付费/借阅/试读）
    const hasAcquisitionLink = entryLinks.some((link) =>
      getLinkRel(link).startsWith('http://opds-spec.org/acquisition')
    );
    const hasSubsectionLink = entryLinks.some((link) => {
      const rel = getLinkRel(link);
      return (
        rel === 'subsection' ||
        rel === 'http://opds-spec.org/catalog' ||
        rel === 'http://opds-spec.org/sort/popular' ||
        rel === 'http://opds-spec.org/sort/new'
      );
    });

    if (hasAcquisitionLink) {
      const entry = parseOpdsEntry(entryNode, baseUrl);
      if (entry) {
        entries.push(entry);
      }
    } else if (hasSubsectionLink) {
      const navLink = parseNavigationEntry(entryNode, baseUrl);
      if (navLink) {
        navigationLinks.push(navLink);
      }
    }
  }

  const seenHrefs = new Set<string>();
  const dedupedNavLinks: OpdsNavigationLink[] = [];
  for (const navLink of navigationLinks) {
    if (seenHrefs.has(navLink.href)) continue;
    seenHrefs.add(navLink.href);
    dedupedNavLinks.push(navLink);
  }

  return {
    title,
    navigationLinks: dedupedNavLinks,
    entries: deduplicateOpdsEntries(entries),
    nextLink,
    previousLink,
    searchUrl,
    selfLink,
    facets: facets.length > 0 ? facets : undefined
  };
}

function parseNavigationEntry(entryNode: unknown, baseUrl: string): OpdsNavigationLink | null {
  const titleNode = findFirstChild(entryNode, 'title');
  const title = titleNode ? getTextContent(titleNode) : '';

  const linkNodes = findChildren(entryNode, 'link');
  for (const linkNode of linkNodes) {
    const rel = getLinkRel(linkNode);
    const href = getLinkHref(linkNode);
    if (href) {
      return {
        title,
        href: resolveOpdsUrl(href, baseUrl),
        rel,
        isNavigation: true
      };
    }
  }

  return null;
}

function parseOpdsEntry(entryNode: unknown, baseUrl: string): OpdsEntry | null {
  const titleNode = findFirstChild(entryNode, 'title');
  const title = titleNode ? getTextContent(titleNode) : '';

  const authorNode = findFirstChild(entryNode, 'author');
  let author = '';
  if (authorNode) {
    const authorNameNode = findFirstChild(authorNode, 'name');
    author = authorNameNode ? getTextContent(authorNameNode) : getTextContent(authorNode);
  }
  if (!author) {
    const creatorNode = findFirstChild(entryNode, 'creator');
    if (creatorNode) {
      const creatorNameNode = findFirstChild(creatorNode, 'name');
      author = creatorNameNode ? getTextContent(creatorNameNode) : getTextContent(creatorNode);
    }
  }

  const summaryNode = findFirstChild(entryNode, 'summary') || findFirstChild(entryNode, 'content');
  let summary = summaryNode ? getTextContent(summaryNode) : '';
  if (!summary) {
    const descriptionNode = findFirstChild(entryNode, 'description');
    if (descriptionNode) {
      summary = getTextContent(descriptionNode);
    }
  }

  const categories: string[] = [];
  const categoryNodes = findChildren(entryNode, 'category');
  for (const catNode of categoryNodes) {
    const label = getAttribute(catNode, 'label') || getAttribute(catNode, 'term');
    if (label) {
      categories.push(label);
    }
  }
  const subjectNodes = findChildren(entryNode, 'subject');
  for (const subjNode of subjectNodes) {
    const subjText = getTextContent(subjNode);
    if (subjText) {
      categories.push(subjText);
    }
  }
  const uniqueCategories: string[] = [];
  const seenCat = new Set<string>();
  for (const cat of categories) {
    if (!seenCat.has(cat)) {
      seenCat.add(cat);
      uniqueCategories.push(cat);
    }
  }

  const idNode = findFirstChild(entryNode, 'id');
  const id = idNode ? getTextContent(idNode) : undefined;

  const languageNode = findFirstChild(entryNode, 'language');
  const language = languageNode ? getTextContent(languageNode) : undefined;

  const publisherNode = findFirstChild(entryNode, 'publisher');
  const publisher = publisherNode ? getTextContent(publisherNode) : undefined;

  const dateNode = findFirstChild(entryNode, 'date');
  const publishedDate = dateNode ? getTextContent(dateNode) : undefined;

  let coverUrl: string | undefined;
  let downloadUrl = '';
  let format = '';
  let acquisitionType: 'free' | 'buy' | 'borrow' | 'sample' | undefined;
  const allFormats: Array<{ format: string; url: string }> = [];

  const linkNodes = findChildren(entryNode, 'link');
  for (const linkNode of linkNodes) {
    const rel = getLinkRel(linkNode);
    const href = getLinkHref(linkNode);
    const type = getLinkType(linkNode);

    if (!href) continue;

    if (
      rel === 'http://opds-spec.org/image' ||
      rel === 'image' ||
      rel === 'thumbnail' ||
      rel.includes('image') ||
      rel.includes('thumbnail')
    ) {
      if (!coverUrl || rel === 'http://opds-spec.org/image' || rel === 'image') {
        coverUrl = resolveOpdsUrl(href, baseUrl);
      }
    }

    // OPDS acquisition 链接：区分免费下载与付费/借阅/试读
    if (rel.startsWith('http://opds-spec.org/acquisition')) {
      if (rel.includes('/buy')) {
        // 付费购买：不设 downloadUrl，标记为 buy
        if (!acquisitionType) acquisitionType = 'buy';
      } else if (rel.includes('/borrow')) {
        // 借阅：不设 downloadUrl，标记为 borrow
        if (!acquisitionType) acquisitionType = 'borrow';
      } else if (rel.includes('/sample')) {
        // 试读样章：不设 downloadUrl，标记为 sample
        if (!acquisitionType) acquisitionType = 'sample';
      } else {
        // 免费下载：acquisition、acquisition-open-access、acquisition/full、acquisition/partial
        const fullUrl = resolveOpdsUrl(href, baseUrl);
        const inferredFormat = type ? mimeTypeToFormat(type) : '';
        if (inferredFormat) {
          allFormats.push({ format: inferredFormat, url: fullUrl });
        }
        if (!downloadUrl || inferredFormat === 'epub') {
          downloadUrl = fullUrl;
          format = inferredFormat || format;
        }
        if (!acquisitionType) acquisitionType = 'free';
      }
    }

    if (rel === 'alternate' && type && !downloadUrl) {
      const inferredFormat = mimeTypeToFormat(type);
      if (inferredFormat) {
        downloadUrl = resolveOpdsUrl(href, baseUrl);
        format = inferredFormat;
      }
    }
  }

  if (!downloadUrl && linkNodes.length > 0) {
    for (const linkNode of linkNodes) {
      const href = getLinkHref(linkNode);
      const type = getLinkType(linkNode);
      if (href && type) {
        const inferredFormat = mimeTypeToFormat(type);
        if (inferredFormat) {
          downloadUrl = resolveOpdsUrl(href, baseUrl);
          format = inferredFormat;
          break;
        }
      }
    }
  }

  if (!title) return null;

  return {
    title,
    author,
    summary,
    coverUrl,
    downloadUrl,
    format: format || 'unknown',
    categories: uniqueCategories,
    id,
    formats: allFormats.length > 1 ? allFormats : undefined,
    language: language || undefined,
    publisher: publisher || undefined,
    publishedDate: publishedDate || undefined,
    acquisitionType
  };
}

function mimeTypeToFormat(mimeType: string): string {
  const lowerType = mimeType.toLowerCase();
  if (lowerType.includes('epub')) return 'epub';
  if (lowerType.includes('pdf')) return 'pdf';
  if (lowerType.includes('plain') || lowerType.includes('text')) return 'txt';
  if (lowerType.includes('mobi') || lowerType.includes('mobipocket')) return 'mobi';
  if (lowerType.includes('azw') || lowerType.includes('azw3') || lowerType.includes('vnd.amazon')) return 'azw3';
  // P2-12 修复：fb2（FictionBook 2.0）是 XML 格式的电子书，本系统暂无原生 fb2 解析器，
  // 但其结构与 EPUB 类似（含元数据+正文），映射到 epub 让下载流程统一处理，
  // 后续可由转换工具或扩展解析器支持。原映射 'fb2' 会导致 getBooksPath 无法识别目录。
  if (lowerType.includes('fb2') || lowerType.includes('fictionbook')) return 'epub';
  // P2-12 修复：补充常见电子书 MIME 类型映射
  // doc/docx/rtf → txt（纯文本兜底，避免落入未知格式被丢弃）
  if (lowerType.includes('msword') || lowerType.includes('officedocument.wordprocessing')) return 'txt';
  if (lowerType.includes('rtf')) return 'txt';
  // 漫画格式 cbz/cbr/cbt → epub（ZIP/RAR 容器，部分阅读器兼容）
  if (lowerType.includes('comicbook') || lowerType.includes('x-cbz') || lowerType.includes('x-cbr')) return 'epub';
  if (lowerType.includes('html') || lowerType.includes('xhtml')) return 'html';
  // application/octet-stream 等未知二进制类型不猜测格式，返回空字符串让调用方处理
  return '';
}

/**
 * 解析相对 URL 为绝对 URL（OPDS 专用，避免与 subscription 的 resolveUrl 冲突）
 *
 * P2 修复：原实现仅做字符串拼接（basePath + href），不处理 '..' 和 '.' 路径段，
 * 导致形如 href='../page.xml' 的相对链接解析为 '.../a/b/../page.xml'（错误）。
 * 现统一使用 URL 构造函数解析，它能正确处理 '..'、'.'、绝对路径、协议相对 URL 等所有情况。
 */
function resolveOpdsUrl(href: string, baseUrl: string): string {
  if (href.startsWith('http://') || href.startsWith('https://')) {
    return href;
  }

  try {
    // new URL(href, base) 能正确处理 '..' 和 '.' 路径段：
    //   new URL('../page.xml', 'https://x.com/a/b/feed') → 'https://x.com/a/page.xml'
    //   new URL('/abs', 'https://x.com/a/b/feed')       → 'https://x.com/abs'
    //   new URL('rel', 'https://x.com/a/b/feed')        → 'https://x.com/a/b/rel'
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

/**
 * 获取系统语言（BCP 47 标签，如 zh-CN、en-US）
 *
 * P2-16 修复：原 buildSearchUrl 硬编码 {language} 为 zh-CN，对非中文用户不友好。
 * 优先级：
 *   1. 数据库 settings 中的 app.language（用户显式设置）
 *   2. Intl.DateTimeFormat 解析的系统默认 locale
 *   3. 空字符串（让 OPDS 服务器默认处理）
 *
 * 注意：不直接依赖 electron.app.getLocale()，避免在非 Electron 环境（如测试）中崩溃。
 */
function getSystemLanguage(): string {
  // 1. 尝试从数据库读取用户设置
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app.language') as
      { value: string } | undefined;
    if (row?.value && typeof row.value === 'string' && row.value.trim()) {
      return row.value.trim();
    }
  } catch {
    // 数据库未初始化或表不存在，静默降级
  }

  // 2. 使用 Intl 解析系统默认 locale（Node.js 内置，无需依赖 electron）
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale && typeof locale === 'string') {
      return locale;
    }
  } catch {
    // Intl 不可用，静默降级
  }

  // 3. 空字符串，让 OPDS 服务器默认处理
  return '';
}

export function buildSearchUrl(searchTemplate: string, query: string): string {
  // P2-16 修复：{language} 不再硬编码 zh-CN，改为从用户设置或系统语言获取
  const language = getSystemLanguage();
  return searchTemplate
    .replace('{searchTerms}', encodeURIComponent(query))
    .replace(/{count\??}/g, '20') // 默认每页20条
    .replace(/{startIndex\??}/g, '1') // 从第1条开始
    .replace(/{startPage\??}/g, '1') // 从第1页开始
    .replace(/{language\??}/g, language) // 系统语言（空则让服务器默认）
    .replace(/{inputEncoding\??}/g, 'UTF-8')
    .replace(/{outputEncoding\??}/g, 'UTF-8');
}

/* ==================== OPDS 2.0 (JSON) 解析 ==================== */

/**
 * 解析 OPDS 2.0 JSON Feed
 *
 * OPDS 2.0 基于 Readium Web Publication Manifest，使用 JSON 格式。
 * 媒体类型：application/opds+json
 *
 * @param jsonText - JSON 文本
 * @param baseUrl - 基础 URL（用于解析相对链接）
 * @returns OpdsFeed（与 1.x 相同的接口）
 */
export function parseOpds2Feed(jsonText: string, baseUrl: string): OpdsFeed {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { title: '', navigationLinks: [], entries: [] };
  }

  // metadata.title
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  const title = typeof metadata.title === 'string' ? metadata.title : '';

  // links: self/next/previous/first/last/search
  const links = Array.isArray(data.links) ? data.links : [];
  let nextLink: string | undefined;
  let previousLink: string | undefined;
  let selfLink: string | undefined;
  let searchUrl: string | undefined;

  for (const link of links) {
    if (!link || typeof link !== 'object') continue;
    const linkObj = link as Record<string, unknown>;
    const rel = linkObj.rel;
    const href = linkObj.href;
    if (typeof href !== 'string') continue;
    const fullUrl = resolveOpdsUrl(href, baseUrl);

    // rel 可以是字符串或数组
    const rels = Array.isArray(rel) ? rel : [rel];
    for (const r of rels) {
      if (r === 'next') nextLink = fullUrl;
      else if (r === 'previous' || r === 'prev') previousLink = fullUrl;
      else if (r === 'self') selfLink = fullUrl;
      else if (r === 'search') {
        // OPDS 2.0 搜索用 URI Template，需要转换为含 {searchTerms} 的格式
        // search{?query} → 替换 {query} 为 {searchTerms}
        if (href.includes('{?query}')) {
          searchUrl = fullUrl.replace('{?query}', '?query={searchTerms}');
        } else if (href.includes('{query}')) {
          searchUrl = fullUrl.replace('{query}', '{searchTerms}');
        } else {
          searchUrl = fullUrl;
        }
      }
    }
  }

  // navigation collection
  const navigationLinks: OpdsNavigationLink[] = [];
  const navItems = Array.isArray(data.navigation) ? data.navigation : [];
  for (const nav of navItems) {
    if (!nav || typeof nav !== 'object') continue;
    const navObj = nav as Record<string, unknown>;
    const navTitle = typeof navObj.title === 'string' ? navObj.title : '';
    const navHref = navObj.href;
    if (typeof navHref === 'string' && navTitle) {
      navigationLinks.push({
        title: navTitle,
        href: resolveOpdsUrl(navHref, baseUrl),
        rel: typeof navObj.rel === 'string' ? navObj.rel : '',
        isNavigation: true
      });
    }
  }

  // publications collection
  const entries: OpdsEntry[] = [];
  const pubItems = Array.isArray(data.publications) ? data.publications : [];
  for (const pub of pubItems) {
    if (!pub || typeof pub !== 'object') continue;
    const entry = parseOpds2Publication(pub as Record<string, unknown>, baseUrl);
    if (entry) entries.push(entry);
  }

  // groups collection（提取其中的 publications 和 navigation）
  const groups = Array.isArray(data.groups) ? data.groups : [];
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const groupObj = group as Record<string, unknown>;
    // group 中的 publications
    const groupPubs = Array.isArray(groupObj.publications) ? groupObj.publications : [];
    for (const pub of groupPubs) {
      if (!pub || typeof pub !== 'object') continue;
      const entry = parseOpds2Publication(pub as Record<string, unknown>, baseUrl);
      if (entry) entries.push(entry);
    }
    // group 中的 navigation
    const groupNav = Array.isArray(groupObj.navigation) ? groupObj.navigation : [];
    for (const nav of groupNav) {
      if (!nav || typeof nav !== 'object') continue;
      const navObj = nav as Record<string, unknown>;
      const navTitle = typeof navObj.title === 'string' ? navObj.title : '';
      const navHref = navObj.href;
      if (typeof navHref === 'string' && navTitle) {
        navigationLinks.push({
          title: navTitle,
          href: resolveOpdsUrl(navHref, baseUrl),
          rel: typeof navObj.rel === 'string' ? navObj.rel : '',
          isNavigation: true
        });
      }
    }
  }

  // facets collection
  const facets: Array<{ group: string; title: string; href: string; active?: boolean }> = [];
  const facetGroups = Array.isArray(data.facets) ? data.facets : [];
  for (const fg of facetGroups) {
    if (!fg || typeof fg !== 'object') continue;
    const fgObj = fg as Record<string, unknown>;
    const fgMeta = (fgObj.metadata ?? {}) as Record<string, unknown>;
    const fgTitle = typeof fgMeta.title === 'string' ? fgMeta.title : '默认';
    const fgLinks = Array.isArray(fgObj.links) ? fgObj.links : [];
    for (const fl of fgLinks) {
      if (!fl || typeof fl !== 'object') continue;
      const flObj = fl as Record<string, unknown>;
      const flTitle = typeof flObj.title === 'string' ? flObj.title : '';
      const flHref = flObj.href;
      if (typeof flHref === 'string' && flTitle) {
        const flRel = flObj.rel;
        const rels = Array.isArray(flRel) ? flRel : [flRel];
        facets.push({
          group: fgTitle,
          title: flTitle,
          href: resolveOpdsUrl(flHref, baseUrl),
          active: rels.includes('self')
        });
      }
    }
  }

  return {
    title,
    navigationLinks,
    entries: deduplicateOpdsEntries(entries),
    nextLink,
    previousLink,
    searchUrl,
    selfLink,
    facets: facets.length > 0 ? facets : undefined
  };
}

/**
 * 解析 OPDS 2.0 单个 publication
 */
function parseOpds2Publication(pub: Record<string, unknown>, baseUrl: string): OpdsEntry | null {
  const metadata = (pub.metadata ?? {}) as Record<string, unknown>;
  const title = typeof metadata.title === 'string' ? metadata.title : '';
  if (!title) return null;

  // author 可以是字符串或对象
  let author = '';
  const rawAuthor = metadata.author;
  if (typeof rawAuthor === 'string') {
    author = rawAuthor;
  } else if (rawAuthor && typeof rawAuthor === 'object') {
    author = ((rawAuthor as Record<string, unknown>).name as string) ?? '';
  } else if (Array.isArray(rawAuthor) && rawAuthor.length > 0) {
    const first = rawAuthor[0];
    author = typeof first === 'string' ? first : ((first?.name as string) ?? '');
  }

  const summary = typeof metadata.description === 'string' ? metadata.description : '';
  const id = typeof metadata.identifier === 'string' ? metadata.identifier : undefined;
  const language = typeof metadata.language === 'string' ? metadata.language : undefined;
  const publisher = typeof metadata.publisher === 'string' ? metadata.publisher : undefined;
  // P2 修复：OPDS 2.0 中 publishedDate 应优先使用 dc:published（metadata.published），
  // 它表示书籍的首次发布日期。dc:modified（metadata.modified）是最后修改日期，
  // 语义不同。原实现仅用 modified，导致发布日期显示为最后修改时间。
  // 现优先用 published，fallback 到 modified 保证旧数据兼容。
  const publishedDate =
    typeof metadata.published === 'string'
      ? metadata.published
      : typeof metadata.modified === 'string'
        ? metadata.modified
        : undefined;

  // categories from belongsTo
  const categories: string[] = [];
  const belongsTo = metadata.belongsTo as Record<string, unknown> | undefined;
  if (belongsTo) {
    const series = belongsTo.series;
    if (series && typeof series === 'object') {
      const seriesName = (series as Record<string, unknown>).name as string;
      if (seriesName) categories.push(seriesName);
    }
    const collection = belongsTo.collection;
    if (typeof collection === 'string') categories.push(collection);
  }

  // images → coverUrl
  let coverUrl: string | undefined;
  const images = Array.isArray(pub.images) ? pub.images : [];
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const imgObj = img as Record<string, unknown>;
    const imgHref = imgObj.href;
    if (typeof imgHref === 'string') {
      coverUrl = resolveOpdsUrl(imgHref, baseUrl);
      break;
    }
  }

  // links → downloadUrl, format, acquisitionType
  let downloadUrl = '';
  let format = '';
  let acquisitionType: 'free' | 'buy' | 'borrow' | 'sample' | undefined;
  const allFormats: Array<{ format: string; url: string }> = [];

  const pubLinks = Array.isArray(pub.links) ? pub.links : [];
  for (const link of pubLinks) {
    if (!link || typeof link !== 'object') continue;
    const linkObj = link as Record<string, unknown>;
    const rel = linkObj.rel;
    const href = linkObj.href;
    const type = linkObj.type;
    if (typeof href !== 'string') continue;

    const rels = Array.isArray(rel) ? rel : [rel];
    const fullUrl = resolveOpdsUrl(href, baseUrl);
    const inferredFormat = typeof type === 'string' ? mimeTypeToFormat(type) : '';

    for (const r of rels) {
      if (r === 'download' || r === 'http://opds-spec.org/acquisition/open-access') {
        // 免费下载
        if (inferredFormat) allFormats.push({ format: inferredFormat, url: fullUrl });
        if (!downloadUrl || inferredFormat === 'epub') {
          downloadUrl = fullUrl;
          format = inferredFormat || format;
        }
        acquisitionType = 'free';
      } else if (r === 'acquisition' || r === 'http://opds-spec.org/acquisition') {
        // 通用 acquisition，当免费下载处理
        if (inferredFormat) allFormats.push({ format: inferredFormat, url: fullUrl });
        if (!downloadUrl || inferredFormat === 'epub') {
          downloadUrl = fullUrl;
          format = inferredFormat || format;
        }
        if (!acquisitionType) acquisitionType = 'free';
      } else if (r === 'buy' || r === 'http://opds-spec.org/acquisition/buy') {
        acquisitionType = 'buy';
      } else if (r === 'borrow' || r === 'http://opds-spec.org/acquisition/borrow') {
        acquisitionType = 'borrow';
      } else if (r === 'preview' || r === 'http://opds-spec.org/acquisition/sample') {
        acquisitionType = 'sample';
      } else if (r === 'subscribe' || r === 'http://opds-spec.org/acquisition/subscribe') {
        acquisitionType = 'sample'; // subscribe 归类为 sample
      }
    }
  }

  return {
    title,
    author,
    summary,
    coverUrl,
    downloadUrl,
    format: format || 'unknown',
    categories,
    id,
    formats: allFormats.length > 1 ? allFormats : undefined,
    language,
    publisher,
    publishedDate,
    acquisitionType
  };
}

/** 检测 JSON 文本是否为 OPDS 2.0 feed */
export function isOpds2Json(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const data = JSON.parse(text);
    return (
      data &&
      typeof data === 'object' &&
      ('metadata' in data || 'publications' in data || 'navigation' in data || 'groups' in data)
    );
  } catch {
    return false;
  }
}

export const BUILTIN_OPDS_CATALOGS: Array<Omit<OpdsCatalog, 'id'>> = [
  // 中文源
  {
    name: '古腾堡·中文书籍',
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=chinese'
  },
  {
    name: '古腾堡·中国古典',
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=china'
  },
  {
    name: '古腾堡·唐诗宋词',
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=poetry+chinese'
  },
  // 英文源
  {
    name: '古腾堡·全部书籍',
    url: 'https://m.gutenberg.org/ebooks.opds/'
  },
  {
    name: '古腾堡·古典文学',
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=classical'
  },
  {
    name: '古腾堡·哲学著作',
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=philosophy'
  },
  {
    name: '古腾堡·科幻小说',
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=science+fiction'
  },
  {
    name: '古腾堡·历史',
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=history'
  }
];

// ═══════════════════════════════════════════════════════════════
// ══ OPDS 书籍下载（含文件完整性校验）══
// ═══════════════════════════════════════════════════════════════

/**
 * OPDS 下载结果
 */
export interface OpdsDownloadResult {
  /** 下载后的本地文件路径 */
  filePath: string;
  /** 实际文件大小（字节） */
  size: number;
  /** 服务器返回的 Content-Length（若有） */
  contentLength?: number;
  /** 实际下载的 MIME 类型 */
  contentType?: string;
}

/**
 * 下载 OPDS 书籍文件并进行完整性校验
 *
 * P2-11 修复：原 OPDS 下载流程（ipc.ts downloadBookFile）仅校验 HTTP 状态码和大小上限，
 * 缺少下载后的完整性校验：未检查文件大小是否 > 0，也未校验 Content-Length 是否匹配。
 * 本函数在下载完成后增加两层校验：
 *   1. 文件大小必须 > 0（防止空响应/服务端错误返回空体）
 *   2. 若响应头含 Content-Length，校验实际字节数与声明一致（防止传输截断）
 *
 * 校验失败时清理半成品文件并抛错，避免后续 importFile 导入损坏文件。
 *
 * @param downloadUrl  下载 URL（已由调用方做 SSRF 校验）
 * @param filename     安全文件名（不含路径分隔符）
 * @param format       书籍格式（epub/mobi/pdf/txt/azw3/fb2/unknown）
 * @param auth         可选 Basic 认证信息
 * @returns OpdsDownloadResult
 */
export async function downloadOpdsBook(
  downloadUrl: string,
  filename: string,
  format: string,
  auth?: { username: string; password: string }
): Promise<OpdsDownloadResult> {
  // 根据格式选择存储目录；未知格式归入 txt 目录
  const bookType = (format === 'epub' ? 'epub' : format === 'mobi' ? 'mobi' : format === 'pdf' ? 'pdf' : 'txt') as
    'txt' | 'epub' | 'mobi' | 'pdf';
  const booksDir = getBooksPath(bookType);
  await mkdir(booksDir, { recursive: true });

  const safeFilename = filename.replace(/[<>:"/\\|?*]/g, '_');
  const ext = format === 'unknown' ? 'txt' : format;
  const filePath = join(booksDir, `${safeFilename}.${ext}`);

  // 大小限制 200MB
  const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

  // 构建请求头：网络配置 + 认证
  const headers: Record<string, string> = {
    ...getNetworkConfigHeaders()
  };
  if (auth) {
    const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  }

  try {
    // 使用 httpRequest 下载（走代理 + 重试 + 网络配置 + SSRF 防护）
    const response = await httpRequest(downloadUrl, {
      headers,
      timeout: 60000,
      responseType: 'buffer',
      retries: 2,
      validateSsrf: true,
      maxResponseSize: MAX_DOWNLOAD_BYTES
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }

    const buffer = response.data as Buffer;

    // 双保险：再次校验缓冲区大小上限
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      throw new Error('下载文件过大（超过200MB限制）');
    }

    // P2-11 修复 - 完整性校验 1：文件大小必须 > 0
    // 防止服务端返回 200 但 body 为空（常见于 CDN 配置错误、源站 5xx 被代理吞掉等）
    if (buffer.length === 0) {
      throw new Error('下载文件完整性校验失败：文件大小为 0 字节（服务端返回空响应）');
    }

    // P2-11 修复 - 完整性校验 2：Content-Length 匹配校验（可选）
    // 仅当响应头含 Content-Length 时校验，防止传输截断
    const contentLengthHeader = response.headers['content-length'];
    if (contentLengthHeader) {
      const declaredSize = parseInt(contentLengthHeader, 10);
      if (!Number.isNaN(declaredSize) && declaredSize > 0 && buffer.length !== declaredSize) {
        throw new Error(
          `下载文件完整性校验失败：Content-Length 声明 ${declaredSize} 字节，实际收到 ${buffer.length} 字节（传输可能截断）`
        );
      }
    }

    await writeFile(filePath, buffer);

    const contentType = response.headers['content-type'] || undefined;
    console.log(
      `[opds-download] 下载完成: ${basename(filePath)} (${buffer.length} bytes${contentLengthHeader ? `, Content-Length=${contentLengthHeader}` : ''})`
    );

    return {
      filePath,
      size: buffer.length,
      contentLength: contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined,
      contentType
    };
  } catch (err) {
    // 下载失败时清理可能已写入的半成品文件
    await unlink(filePath).catch((e) => console.warn('[cleanup] 操作失败:', e));
    throw err;
  }
}
