/**
 * 渲染进程工具函数
 *
 * 分类组织：
 *   1. 时间格式化 — formatRelativeTime, formatDate, formatDateTime, formatDuration
 *   2. 颜色工具 — hexToRgb, rgbToHex, hexToRgba, isDarkBg, adjustBg, lighten, darken, clamp
 *   3. 封面生成器 — generateCoverDataUrl, coverPathToUrl（含 LRU 缓存）
 *   4. HTML 转义工具 — escapeHtml, escapeHtmlAttr
 *   5. Emoji 映射与解析 — emojiMap, parseEmojis
 *   6. 段落分割 — splitParagraphs
 *   7. 富文本渲染 — renderRichTextBlock, renderRichTextInline
 *   8. 段落渲染 — renderImagePlaceholder, extractImageSrc, renderParagraphWithHighlights
 */

import { HIGHLIGHT_COLOR_CLASS } from '../../shared';
import MarkdownIt from 'markdown-it';
import type { MarkdownIt as MarkdownItInstance } from 'markdown-it';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import { i18n } from './i18n';

/* ==================== 1. 时间格式化 ==================== */

/**
 * 将时间戳（毫秒）格式化为相对时间字符串
 *
 * @param ts 毫秒时间戳；null 返回未读文案
 * @returns 如「刚刚」「3 分钟前」「2 小时前」「5 天前」「2024-01-01」
 */
export function formatRelativeTime(ts: number | null): string {
  const t = i18n.global.t;
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return t('common.time.unread');

  const now: number = Date.now();
  const diff: number = now - ts;

  if (diff < 0) return formatDate(ts);

  const seconds: number = Math.floor(diff / 1000);
  const minutes: number = Math.floor(seconds / 60);
  const hours: number = Math.floor(minutes / 60);
  const days: number = Math.floor(hours / 24);

  if (seconds < 60) return t('common.time.justNow');
  if (minutes < 60) return t('common.time.minutesAgo', { n: minutes });
  if (hours < 24) return t('common.time.hoursAgo', { n: hours });
  if (days < 7) return t('common.time.daysAgo', { n: days });
  if (days < 30) return t('common.time.weeksAgo', { n: Math.floor(days / 7) });
  if (days < 365) return t('common.time.monthsAgo', { n: Math.floor(days / 30) });

  return formatDate(ts);
}

/**
 * 格式化为 YYYY-MM-DD
 *
 * @param ts 毫秒时间戳
 */
export function formatDate(ts: number): string {
  const d: Date = new Date(ts);
  const y: number = d.getFullYear();
  const m: string = String(d.getMonth() + 1).padStart(2, '0');
  const day: string = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 格式化为 YYYY-MM-DD HH:mm
 *
 * @param ts 毫秒时间戳
 */
export function formatDateTime(ts: number): string {
  const d: Date = new Date(ts);
  const date: string = formatDate(ts);
  const h: string = String(d.getHours()).padStart(2, '0');
  const min: string = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${h}:${min}`;
}

/**
 * 将毫秒时长格式化为可读时长字符串
 *
 * 规则：
 *   - < 1 分钟：「x 秒」
 *   - < 1 小时：「x 分钟」
 *   - < 24 小时：「x 小时 x 分钟」
 *   - >= 24 小时：「x 天 x 小时」
 *
 * @param ms 毫秒时长；null/undefined/0 返回 '未阅读'
 * @returns 如「30 秒」「15 分钟」「2 小时 30 分钟」「3 天 5 小时」
 */
export function formatDuration(ms: number | null | undefined): string {
  const t = i18n.global.t;
  if (ms === null || ms === undefined || ms <= 0) return t('common.duration.unread');

  const seconds: number = Math.floor(ms / 1000);
  const minutes: number = Math.floor(seconds / 60);
  const hours: number = Math.floor(minutes / 60);
  const days: number = Math.floor(hours / 24);

  if (seconds < 60) return t('common.duration.seconds', { n: seconds });
  if (minutes < 60) return t('common.duration.minutes', { n: minutes });
  if (hours < 24) {
    const remainMinutes: number = minutes % 60;
    return remainMinutes > 0
      ? t('common.duration.hoursMinutes', { h: hours, m: remainMinutes })
      : t('common.duration.hours', { n: hours });
  }
  const remainHours: number = hours % 24;
  return remainHours > 0
    ? t('common.duration.daysHours', { d: days, h: remainHours })
    : t('common.duration.days', { n: days });
}

/* ==================== 2. 颜色工具 ==================== */

/** RGB 分量结构 */
interface RgbComponents {
  r: number;
  g: number;
  b: number;
}

/**
 * 将 hex 颜色转为 RGB 分量
 *
 * @param hex 支持 #RGB 或 #RRGGBB 格式
 * @returns RGB 分量对象；无效格式返回 null
 */
export function hexToRgb(hex: string): RgbComponents | null {
  const m: RegExpMatchArray | null = hex.replace('#', '').match(/^([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  let h: string = m[1];
  if (h.length === 3) {
    h = h
      .split('')
      .map((c: string): string => c + c)
      .join('');
  }
  const n: number = parseInt(h, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/**
 * 将 RGB 分量转为 hex 字符串
 *
 * @param r 红色分量 (0-255)
 * @param g 绿色分量 (0-255)
 * @param b 蓝色分量 (0-255)
 * @returns 如 '#1a2b3c'
 */
export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((c: number): string => c.toString(16).padStart(2, '0')).join('');
}

/**
 * 将 hex 颜色转为 rgba 字符串
 *
 * @param hex 支持 #RGB 或 #RRGGBB 格式
 * @param alpha 透明度 (0-1)
 * @returns 如 'rgba(26, 43, 60, 0.5)'；无效 hex 原样返回
 */
export function hexToRgba(hex: string, alpha: number): string {
  const rgb: RgbComponents | null = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/**
 * 判断背景色是否为暗色（基于 RGB 亮度计算）
 *
 * @param hex 支持 #RGB 或 #RRGGBB 格式
 * @returns 暗色返回 true；无效格式默认返回 true
 */
export function isDarkBg(hex: string): boolean {
  const rgb: RgbComponents | null = hexToRgb(hex);
  if (!rgb) return true;
  const luma: number = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  return luma < 128;
}

/**
 * 调整背景色亮度
 *
 * @param hex 支持 #RGB 或 #RRGGBB 格式
 * @param amount 调整量：> 0 变亮，< 0 变暗（范围 -1 ~ 1）
 * @returns 调整后的 hex 字符串；无效 hex 原样返回
 */
export function adjustBg(hex: string, amount: number): string {
  const rgb: RgbComponents | null = hexToRgb(hex);
  if (!rgb) return hex;
  const r: number = clamp(Math.round(rgb.r + 255 * amount));
  const g: number = clamp(Math.round(rgb.g + 255 * amount));
  const b: number = clamp(Math.round(rgb.b + 255 * amount));
  return rgbToHex(r, g, b);
}

/**
 * 提亮颜色（adjustBg 的语义化别名）
 *
 * @param hex 支持 #RGB 或 #RRGGBB 格式
 * @param amount 提亮量 (0-1)
 */
export function lighten(hex: string, amount: number): string {
  return adjustBg(hex, amount);
}

/**
 * 压暗颜色（adjustBg 的语义化别名）
 *
 * @param hex 支持 #RGB 或 #RRGGBB 格式
 * @param amount 压暗量 (0-1)
 */
export function darken(hex: string, amount: number): string {
  return adjustBg(hex, -amount);
}

/**
 * 数值约束到 0~255 范围
 *
 * @param n 输入数值
 * @returns 0-255 之间的整数
 */
export function clamp(n: number): number {
  return Math.max(0, Math.min(255, n));
}

/* ==================== 3. 封面生成器 ==================== */

/** 封面宽度（与高度 3:4 比例） */
const COVER_WIDTH: number = 300;
/** 封面高度 */
const COVER_HEIGHT: number = 400;
/** LRU 缓存上限：200 个不同封面足以覆盖常见书架规模 */
const COVER_CACHE_MAX: number = 200;

/* ─── LRU 缓存 ─── */

/**
 * 封面 data URL 缓存（LRU Map）
 *
 * key = `${title}:${author ?? ''}`，value = 已生成的 data URL。
 * 利用 Map 按插入顺序迭代的特性实现 LRU：
 *   - 命中时 delete + set 刷新为最近使用
 *   - 容量超限时删除 keys().next().value（最久未使用）
 */
const coverCache: Map<string, string> = new Map();

/** 从缓存读取并刷新为最近使用（LRU） */
function getCachedCover(key: string): string | undefined {
  const v: string | undefined = coverCache.get(key);
  if (v !== undefined) {
    coverCache.delete(key);
    coverCache.set(key, v);
  }
  return v;
}

/** 写入缓存，超限时淘汰最久未使用的条目 */
function setCachedCover(key: string, value: string): void {
  if (coverCache.size >= COVER_CACHE_MAX) {
    const oldest: string | undefined = coverCache.keys().next().value;
    if (oldest !== undefined) {
      coverCache.delete(oldest);
    }
  }
  coverCache.set(key, value);
}

/* ─── 内部辅助函数 ─── */

/**
 * 简单字符串哈希（djb2 变体）
 *
 * @param str 输入字符串
 * @returns 32 位无符号整数
 */
function hashString(str: string): number {
  let hash: number = 5381;
  for (let i: number = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * HSL 转 Hex 颜色
 *
 * @param h 色相 (0-360)
 * @param s 饱和度 (0-100)
 * @param l 亮度 (0-100)
 * @returns 如 '#1a2b3c'
 */
function hslToHex(h: number, s: number, l: number): string {
  const sNorm: number = s / 100;
  const lNorm: number = l / 100;
  const c: number = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x: number = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m: number = lNorm - c / 2;
  let r: number = 0;
  let g: number = 0;
  let b: number = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const toHex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * 根据哈希值生成一对协调的渐变色（HSL 色彩空间）
 *
 * @param hash 32 位无符号整数哈希值
 * @returns [起始色, 结束色] 的 hex 字符串对
 */
function gradientColorsFromHash(hash: number): [string, string] {
  const hue1: number = hash % 360;
  const hue2: number = (hue1 + 40 + ((hash >> 8) % 60)) % 360;
  const sat: number = 35;
  const light1: number = 42;
  const light2: number = 32;
  return [hslToHex(hue1, sat, light1), hslToHex(hue2, sat, light2)];
}

/**
 * 取书名首字（支持中英文，过滤空白和标点）
 *
 * @param title 书名
 * @returns 书名首字；空标题返回 '书'
 */
function firstCharOfTitle(title: string): string {
  const fallback = i18n.global.t('common.words.bookFallbackChar');
  if (!title) return fallback;
  const trimmed: string = title.trim();
  if (trimmed.length === 0) return fallback;
  const ch: string = trimmed.charAt(0);
  if (/[【《「『\[（(]/.test(ch)) {
    return trimmed.charAt(1) || fallback;
  }
  return ch;
}

/**
 * 转义 SVG/XML 文本中的特殊字符
 *
 * @param text 原始文本
 * @returns 转义后的安全文本
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ─── 公开 API ─── */

/**
 * 生成默认封面 SVG data URL
 *
 * 带 LRU 缓存：相同 title + author 直接返回已生成的 data URL，
 * 避免重复拼接 SVG 字符串与 encodeURIComponent（书架列表渲染时
 * 同一封面可能被请求数十次，缓存命中后为 O(1) Map 查询）。
 *
 * @param title 书名
 * @param author 作者（可选）
 * @returns data URL 字符串，可直接作为 <img src>
 */
export function generateCoverDataUrl(title: string, author?: string | null): string {
  const cacheKey: string = `${title ?? ''}:${author ?? ''}`;

  const cached: string | undefined = getCachedCover(cacheKey);
  if (cached !== undefined) return cached;

  const hash: number = hashString(title || '未知');
  const [color1, color2]: [string, string] = gradientColorsFromHash(hash);
  const char: string = firstCharOfTitle(title);
  const safeChar: string = escapeXml(char);
  const safeTitle: string = escapeXml(title || i18n.global.t('common.words.unknownBook'));
  const safeAuthor: string = author ? escapeXml(author) : '';
  const gradId: string = `grad-${hash.toString(36)}`;

  const svg: string = `<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_WIDTH}" height="${COVER_HEIGHT}" viewBox="0 0 ${COVER_WIDTH} ${COVER_HEIGHT}">
  <defs>
    <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${color1}" />
      <stop offset="100%" stop-color="${color2}" />
    </linearGradient>
  </defs>
  <rect width="${COVER_WIDTH}" height="${COVER_HEIGHT}" fill="url(#${gradId})" />
  <text x="50%" y="42%" text-anchor="middle" dominant-baseline="central"
    font-family="'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif"
    font-size="120" font-weight="700" fill="rgba(255,255,255,0.92)">${safeChar}</text>
  <text x="50%" y="82%" text-anchor="middle"
    font-family="'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif"
    font-size="18" font-weight="500" fill="rgba(255,255,255,0.85)">${safeTitle}</text>
  ${safeAuthor ? `<text x="50%" y="90%" text-anchor="middle" font-family="'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="13" fill="rgba(255,255,255,0.6)">${safeAuthor}</text>` : ''}
</svg>`;

  const dataUrl: string = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  setCachedCover(cacheKey, dataUrl);
  return dataUrl;
}

/**
 * 将本地文件路径转为可在 <img src> 中使用的 URL
 *
 * - 绝对路径转 file:// URL
 * - 已是 http/data/blob 协议的直接返回
 * - null/空返回 null
 * - 对 # 和 ? 额外编码（encodeURI 不编码这两个保留字符，会被浏览器解析为
 *   fragment/query 导致图片加载失败，合并自 ComicView.vue 的 toFileUrl）
 *
 * 函数重载：传入 string 时返回 string（非空输入必返回非空 URL），
 * 传入 string | null 时返回 string | null。供 ComicView 等已知非空场景
 * 获得更精确的类型，避免在模板中额外处理 null。
 *
 * @param cover 文件路径或 URL
 * @returns 可用于 <img src> 的 URL；空值返回 null
 */
export function coverPathToUrl(cover: string): string;
export function coverPathToUrl(cover: string | null): string | null;
export function coverPathToUrl(cover: string | null): string | null {
  if (!cover) return null;
  if (/^(https?:|file:|data:|blob:)/i.test(cover)) return cover;
  const normalized: string = cover.replace(/\\/g, '/');
  // encodeURI 不编码 # 和 ?，需额外编码避免被解析为 fragment/query
  const encoded: string = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
  if (normalized.startsWith('//')) {
    return `file:${encoded}`;
  }
  const trimmed = encoded.startsWith('/') ? encoded.slice(1) : encoded;
  return `file:///${trimmed}`;
}

/* ==================== 4. HTML 转义工具 ==================== */

/**
 * HTML 特殊字符转义（用于插入到 HTML 文本节点中）
 *
 * 转义 `&` `<` `>` `"` `'`，防止 XSS 注入。
 * 单引号转义为 `&#39;`（数字实体，兼容 XML/HTML）。
 *
 * @param text 原始文本
 * @returns 转义后的安全文本
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML 属性值转义：用于插入到 `<img src="...">` 等属性中。
 *
 * 仅转义会破坏属性边界或引入标签的字符：`"` `>` `<`，以及 `&`（避免与实体冲突）。
 * 与 escapeHtml 的区别：不转义 `'`（因为属性用双引号包裹），语义更聚焦。
 *
 * @param text 原始文本
 * @returns 转义后的安全属性值
 */
export function escapeHtmlAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* ==================== 5. Emoji 映射与解析 ==================== */

/**
 * 表情代码到 Unicode emoji 的映射表
 *
 * 支持4种表情代码格式共用此映射表：
 * - 贴吧格式 `#/xxx#/`  如 `#/滑稽#/` → 🤣
 * - 论坛格式 `[xxx]`    如 `[滑稽]` → 🤣
 * - Discord格式 `:xxx:` 如 `:smile:` → 😄
 * - 括号格式 `(xxx)`    如 `(滑稽)` → 🤣
 *
 * key 为表情名称（中文或英文），value 为对应的 Unicode emoji 字符
 */
export const emojiMap: Record<string, string> = {
  // ===== 中文表情名称（贴吧常见） =====
  滑稽: '🤣',
  不高兴: '😠',
  乖: '😊',
  汗: '💦',
  吃惊: '😲',
  吐舌: '😜',
  笑眼: '😄',
  阴险: '😏',
  鬼脸: '🤪',
  闪光: '✨',
  大笑: '😂',
  哭: '😢',
  怒: '😡',
  鄙视: '😤',
  困: '😴',
  害羞: '😳',
  鼓掌: '👏',
  赞: '👍',
  踩: '👎',
  抱拳: '🤝',
  玫瑰: '🌹',
  心: '❤️',
  爱心: '💕',
  太阳: '☀️',
  月亮: '🌙',
  星星: '⭐',
  火: '🔥',
  雷: '⚡',
  西瓜: '🍉',
  咖啡: '☕',
  啤酒: '🍺',
  蛋糕: '🍰',
  礼物: '🎁',
  钞票: '💰',
  炸弹: '💣',
  刀: '🔪',
  手枪: '🔫',
  胜利: '✌️',
  OK: '👌',
  拳头: '👊',
  合十: '🙏',
  强: '💪',
  弱: '🤦',
  喷: '🤮',
  晕: '😵',
  疑问: '❓',
  感叹: '❗',
  勾: '✅',
  叉: '❌',
  狗: '🐶',
  猫: '🐱',
  猪: '🐷',
  猴: '🐵',
  鸡: '🐔',
  鱼: '🐟',
  蜘蛛: '🕷️',
  蛇: '🐍',
  龙: '🐲',
  花: '🌸',
  树: '🌳',
  果: '🍎',
  药: '💊',
  车: '🚗',
  飞机: '✈️',
  火车: '🚂',
  船: '⛵',
  房: '🏠',
  城堡: '🏰',
  书: '📖',
  笔: '✏️',
  电话: '📞',
  电脑: '💻',
  手机: '📱',
  电视: '📺',
  音乐: '🎵',
  游戏: '🎮',
  足球: '⚽',
  篮球: '🏀',
  乒乓球: '🏓',
  网球: '🎾',
  奖杯: '🏆',
  金牌: '🥇',
  银牌: '🥈',
  铜牌: '🥉',
  酷: '😎',
  书呆: '🤓',
  恶魔: '😈',
  天使: '😇',
  幽灵: '👻',
  骷髅: '💀',
  外星人: '👽',
  机器人: '🤖',
  大便: '💩',
  小丑: '🤡',
  喷水: '💦',
  思考: '🤔',
  翻白眼: '🙄',
  闭嘴: '🤐',
  睡着: '😴',
  流口水: '🤤',
  害怕: '😱',
  疑惑: '🤨',
  得意: '🤩',
  无语: '😑',
  微笑: '😊',
  伤心: '😞',
  偷笑: '🤭',
  调皮: '😝',
  呆: '🤓',
  羡慕: '🤩',
  哼: '😤',
  悲伤: '😭',
  抓狂: '🤯',
  沮丧: '😔',
  惊恐: '😨',
  尴尬: '😅',
  可爱: '🥰',
  飞吻: '😘',
  嘲笑: '🤭',
  挑逗: '😏',
  傲慢: '😤',
  无奈: '🤷',
  摊手: '🤷',
  捂脸: '🤦',
  捂嘴: '🤭',
  眨眼: '😉',
  惊讶: '😮',
  恍然大悟: '💡',
  加油: '💪',
  拥抱: '🤗',
  击掌: '🙌',
  挥手: '👋',
  指路: '👉',
  指左: '👈',
  指上: '👆',
  指下: '👇',
  OK手势: '👌',
  举手: '🙋',
  双手合十: '🙏',
  拳击: '🥊',
  拍手: '👏',
  鞠躬: '🙇',
  生日快乐: '🎂',
  庆祝: '🎉',
  派对: '🥳',
  烟花: '🎆',
  彩带: '🎊',
  雪人: '⛄',
  圣诞树: '🎄',
  南瓜: '🎃',
  糖果: '🍬',
  苹果: '🍎',
  香蕉: '🍌',
  葡萄: '🍇',
  樱桃: '🍒',
  草莓: '🍓',
  桃子: '🍑',
  菠萝: '🍍',
  玉米: '🌽',
  蘑菇: '🍄',
  面包: '🍞',
  奶酪: '🧀',
  米饭: '🍚',
  面条: '🍜',
  寿司: '🍣',
  冰淇淋: '🍦',
  巧克力: '🍫',
  饼干: '🍪',
  甜甜圈: '🍩',
  糕点: '🧁',
  热饮: '☕',
  茶杯: '🍵',
  酒杯: '🍷',
  香槟: '🍾',
  水滴: '💧',
  海浪: '🌊',
  闪电: '⚡',
  彩虹: '🌈',
  云: '☁️',
  雪: '❄️',
  风: '💨',
  雾: '🌫️',
  地球: '🌍',
  月球: '🌙',
  彗星: '☄️',
  四叶草: '🍀',
  向日葵: '🌻',
  仙人掌: '🌵',
  棕榈树: '🌴',
  落叶: '🍂',
  樱花: '🌸',
  红玫瑰: '🌹',
  白花: '🌼',
  红心: '❤️',
  橙心: '🧡',
  黄心: '💛',
  绿心: '💚',
  蓝心: '💙',
  紫心: '💜',
  黑心: '🖤',
  白心: '🤍',
  破心: '💔',
  双心: '💕',
  闪烁心: '💖',
  心动: '💗',
  心跳: '💓',
  成长心: '💞',
  旋转心: '💞',
  戒指: '💍',
  钻石: '💎',
  皇冠: '👑',
  眼镜: '👓',
  领带: '👔',
  裙子: '👗',
  牛仔裤: '👖',
  鞋: '👟',
  帽子: '🎩',
  口红: '💄',
  指甲油: '💅',
  钱袋: '💰',
  信用卡: '💳',
  钞票眼: '🤑',
  邮件: '📧',
  信封: '✉️',
  收件箱: '📥',
  发件箱: '📤',
  日历: '📅',
  时钟: '⏰',
  闹钟: '⏰',
  秒表: '⏱️',
  沙漏: '⌛',
  锁: '🔒',
  开锁: '🔓',
  钥匙: '🔑',
  锤子: '🔨',
  螺丝刀: '🔧',
  扳手: '🔧',
  齿轮: '⚙️',
  链条: '🔗',
  磁铁: '🧲',
  灯泡: '💡',
  手电筒: '🔦',
  蜡烛: '🕯️',
  相机: '📷',
  视频: '📹',
  电影: '🎬',
  麦克风: '🎤',
  耳机: '🎧',
  喇叭: '📢',
  铃铛: '🔔',
  音符: '🎵',
  吉他: '🎸',
  钢琴: '🎹',
  小号: '🎺',
  小提琴: '🎻',
  鼓: '🥁',
  旗帜: '🚩',
  白旗: '🏳️',
  红旗: '🔴',
  黑旗: '🏴',
  彩虹旗: '🌈',
  棋盘: '🏁',
  目标: '🎯',
  滑板: '🛹',
  自行车: '🚲',
  摩托车: '🏍️',
  公交车: '🚌',
  跑车: '🏎️',
  救护车: '🚑',
  警车: '🚓',
  消防车: '🚒',
  卡车: '🚚',
  拖拉机: '🚜',
  直升机: '🚁',
  火箭: '🚀',
  卫星: '🛰️',
  轮椅: '🦽',
  红绿灯: '🚦',
  停车: '🅿️',
  加油站: '⛽',
  施工: '🚧',
  建筑物: '🏢',
  医院: '🏥',
  银行: '🏦',
  学校: '🏫',
  教堂: '⛪',
  清真寺: '🕌',
  寺庙: '⛩️',
  灯塔: '🗼',
  喷泉: '⛲',
  帐篷: '⛺',
  桥: '🌉',
  火山: '🌋',
  山: '⛰️',
  峰: '🏔️',
  田径: '🏃',
  游泳: '🏊',
  冲浪: '🏄',
  滑雪: '⛷️',
  骑马: '🏇',
  瑜伽: '🧘',
  拳击手套: '🥊',
  美式足球: '🏈',
  棒球: '⚾',
  排球: '🏐',
  橄榄球: '🏉',
  羽毛球: '🏸',
  冰球: '🏒',
  飞镖: '🎯',
  保龄球: '🎳',
  钓鱼: '🎣',
  滑冰: '⛸️',
  射箭: '🏹',
  击剑: '🤺',
  跳水: '🤽',
  赛艇: '🚣',
  爬山: '🧗',
  武术: '🥋',
  跑步: '🏃',
  走路: '🚶',
  跳舞: '💃',
  唱歌: '🎤',
  画画: '🎨',
  写字: '✍️',
  阅读: '📖',
  学习: '📚',
  工作: '💼',
  睡觉: '😴',
  吃饭: '🍽️',
  喝水: '🥤',
  洗澡: '🛁',
  游乐园: '🎢',
  摩天轮: '🎡',
  过山车: '🎢',
  旋转木马: '🎠',
  气球: '🎈',
  风筝: '🪁',
  魔法: '🪄',
  水晶球: '🔮',
  钥匙符号: '🗝️',
  卷轴: '📜',
  书签: '🔖',
  标签: '🏷️',
  条形码: '📦',
  剪刀: '✂️',
  回形针: '📎',
  图钉: '📌',
  尺子: '📏',
  三角尺: '📐',
  文件夹: '📁',
  打开文件夹: '📂',
  文件: '📄',
  页面: '📃',
  记事本: '📝',
  日记: '📔',
  笔记本: '📓',
  分类账: '📒',
  卷尺: '🧵',
  毛线: '🧶',
  纽扣: '🔘',
  链接符号: '🔗',
  回收: '♻️',
  节能: '🌱',
  无限: '♾️',
  百分号: '💯',
  数字符号: '#️⃣',
  星号: '*️⃣',
  向上箭头: '⬆️',
  向下箭头: '⬇️',
  向左箭头: '⬅️',
  向右箭头: '➡️',
  双向上箭头: '⏫',
  双向下箭头: '⏬',
  弯曲箭头: '↪️',
  循环箭头: '🔄',
  背后箭头: '🔙',
  结束箭头: '🔚',
  开头箭头: '🔛',
  向上箭头2: '🔝',
  圆圈箭头: '➰',
  双圆圈箭头: '➿',
  对勾圆圈: '✔️',
  叉号圆圈: '❌',
  禁止符号: '🚫',
  叹号圆圈: '❗',
  问号圆圈: '❓',
  信息源: 'ℹ️',
  AT符号: '🅰️',
  AB符号: '🆎',
  CL符号: '🆑',
  COOL符号: '🆒',
  FREE符号: '🆓',
  ID符号: '🆔',
  NEW符号: '🆕',
  NG符号: '🆖',
  OK符号: '🆗',
  SOS符号: '🆘',
  UP符号: '🆙',
  VS符号: '🆚',
  和平符号: '☮️',
  红十字: '✝️',
  星月: '☪️',
  大卫星: '✡️',
  阴阳: '☯️',
  正字: '✅',
  叉字: '❎',
  勾号: '✓',
  叉号: '✗',
  音符2: '🎶',
  重音符: '🎵',
  音符3: '🎼',
  高音谱号: '🎼',
  低音谱号: '🎼',

  // ===== 英文表情名称（Discord常见） =====
  smile: '😄',
  laugh: '😂',
  cry: '😢',
  angry: '😡',
  sad: '😞',
  happy: '😊',
  wink: '😉',
  tongue: '😜',
  shock: '😲',
  sweat: '💦',
  sleep: '😴',
  love: '❤️',
  heart: '💕',
  fire: '🔥',
  star: '⭐',
  sun: '☀️',
  moon: '🌙',
  thumbsup: '👍',
  thumbsdown: '👎',
  ok: '👌',
  clap: '👏',
  pray: '🙏',
  muscle: '💪',
  facepalm: '🤦',
  rose: '🌹',
  bomb: '💣',
  knife: '🔪',
  gun: '🔫',
  victory: '✌️',
  coffee: '☕',
  beer: '🍺',
  cake: '🍰',
  gift: '🎁',
  money: '💰',
  book: '📖',
  phone: '📞',
  computer: '💻',
  music: '🎵',
  game: '🎮',
  soccer: '⚽',
  basketball: '🏀',
  trophy: '🏆',
  dog: '🐶',
  cat: '🐱',
  pig: '🐷',
  monkey: '🐵',
  fish: '🐟',
  flower: '🌸',
  car: '🚗',
  plane: '✈️',
  train: '🚂',
  ship: '⛵',
  house: '🏠',
  castle: '🏰',
  pill: '💊',
  pen: '✏️',
  tv: '📺',
  mobile: '📱',
  question: '❓',
  exclamation: '❗',
  check: '✅',
  cross: '❌',
  cool: '😎',
  nerd: '🤓',
  devil: '😈',
  angel: '😇',
  ghost: '👻',
  skull: '💀',
  alien: '👽',
  robot: '🤖',
  poop: '💩',
  clown: '🤡',
  wave: '👋',
  point_right: '👉',
  point_left: '👈',
  point_up: '👆',
  point_down: '👇',
  raised_hands: '🙌',
  fist: '👊',
  handshake: '🤝',
  hug: '🤗',
  bow: '🙇',
  dancing: '💃',
  running: '🏃',
  walking: '🚶',
  sleeping: '😴',
  thinking: '🤔',
  rolling_eyes: '🙄',
  zipper_mouth: '🤐',
  drooling: '🤤',
  screaming: '😱',
  zany: '🤪',
  shushing: '🤫',
  nauseated: '🤮',
  dizzy: '😵',
  exploding_head: '🤯',
  partying: '🥳',
  smiling_devil: '😈',
  upside_down: '🙃',
  squinting: '😬',
  sweating_smile: '😅',
  woozy: '🤪',
  pleading: '🥺',
  partying_face: '🥳',
  hot: '🥵',
  cold: '🥶',
  ninja: '🥷',
  disguised: '🥸',
  melting: '🫠',
  saluting: '🫡',
  tender: '🥰',
  bandaged: '🤕',
  monacle: '🧐',
  superhero: '🦸',
  supervillain: '🦹',
  detectiv: '🕵️',
  guard: '💂',
  construction_worker: '👷',
  farmer: '🧑‍🌾',
  cook: '🧑‍🍳',
  scientist: '🧑‍🔬',
  astronaut: '🧑‍🚀',
  firefighter: '🧑‍🚒',
  prince: '🤴',
  princess: '👸',
  baby: '👶',
  boy: '👦',
  girl: '👧',
  man: '👨',
  woman: '👩',
  older_man: '👴',
  older_woman: '👵',
  bride: '👰',
  pregnant: '🤰',
  breast_feeding: '🤱',
  watermelon: '🍉',
  cherry: '🍒',
  strawberry: '🍓',
  peach: '🍑',
  pineapple: '🍍',
  banana: '🍌',
  apple: '🍎',
  green_apple: '🍏',
  grapes: '🍇',
  corn: '🌽',
  mushroom: '🍄',
  bread: '🍞',
  cheese: '🧀',
  rice: '🍚',
  noodles: '🍜',
  sushi: '🍣',
  icecream: '🍦',
  chocolate: '🍫',
  cookie: '🍪',
  donut: '🍩',
  cupcake: '🧁',
  tea: '🍵',
  wine: '🍷',
  champagne: '🍾',
  beer2: '🍺',
  droplet: '💧',
  ocean: '🌊',
  rainbow: '🌈',
  cloud: '☁️',
  snowflake: '❄️',
  wind: '💨',
  fog: '🌫️',
  earth: '🌍',
  comet: '☄️',
  clover: '🍀',
  sunflower: '🌻',
  cactus: '🌵',
  palm: '🌴',
  fallen_leaf: '🍂',
  blossom: '🌸',
  tulip: '🌷',
  tree: '🌳',
  evergreen: '🌲',
  red_heart: '❤️',
  orange_heart: '🧡',
  yellow_heart: '💛',
  green_heart: '💚',
  blue_heart: '💙',
  purple_heart: '💜',
  black_heart: '🖤',
  white_heart: '🤍',
  broken_heart: '💔',
  two_hearts: '💕',
  sparkle_heart: '💖',
  heartbeat: '💓',
  growing_heart: '💞',
  ring: '💍',
  diamond: '💎',
  crown: '👑',
  glasses: '👓',
  lipstick: '💄',
  nail_polish: '💅',
  moneybag: '💰',
  credit_card: '💳',
  email: '📧',
  envelope: '✉️',
  inbox: '📥',
  outbox: '📤',
  calendar: '📅',
  clock: '⏰',
  alarm: '⏰',
  stopwatch: '⏱️',
  hourglass: '⌛',
  lock: '🔒',
  unlock: '🔓',
  key: '🔑',
  hammer: '🔨',
  wrench: '🔧',
  gear: '⚙️',
  link: '🔗',
  magnet: '🧲',
  bulb: '💡',
  flashlight: '🔦',
  candle: '🕯️',
  camera: '📷',
  video_camera: '📹',
  movie: '🎬',
  microphone: '🎤',
  headphones: '🎧',
  megaphone: '📢',
  bell: '🔔',
  guitar: '🎸',
  piano: '🎹',
  trumpet: '🎺',
  violin: '🎻',
  drum: '🥁',
  flag: '🚩',
  target: '🎯',
  bicycle: '🚲',
  motorcycle: '🏍️',
  bus: '🚌',
  racecar: '🏎️',
  ambulance: '🚑',
  police_car: '🚓',
  fire_engine: '🚒',
  truck: '🚚',
  helicopter: '🚁',
  rocket: '🚀',
  satellite: '🛰️',
  traffic_light: '🚦',
  fuel: '⛽',
  construction: '🚧',
  office: '🏢',
  hospital: '🏥',
  bank: '🏦',
  school: '🏫',
  church: '⛪',
  mosque: '🕌',
  temple: '⛩️',
  lighthouse: '🗼',
  fountain: '⛲',
  tent: '⛺',
  bridge: '🌉',
  volcano: '🌋',
  mountain: '⛰️',
  running_shirt: '🏃',
  swimming: '🏊',
  surfing: '🏄',
  skiing: '⛷️',
  horse_riding: '🏇',
  yoga: '🧘',
  football: '🏈',
  baseball: '⚾',
  volleyball: '🏐',
  rugby: '🏉',
  badminton: '🏸',
  ice_hockey: '🏒',
  ping_pong: '🏓',
  tennis: '🎾',
  bowling: '🎳',
  fishing: '🎣',
  archery: '🏹',
  fencing: '🤺',
  rowing: '🚣',
  climbing: '🧗',
  martial_arts: '🥋',
  medal: '🏅',
  gold: '🥇',
  silver: '🥈',
  bronze: '🥉',
  birthday: '🎂',
  celebration: '🎉',
  party: '🥳',
  fireworks: '🎆',
  confetti: '🎊',
  snowman: '⛄',
  christmas_tree: '🎄',
  pumpkin: '🎃',
  candy: '🍬',
  balloon: '🎈',
  kite: '🪁',
  magic: '🪄',
  crystal_ball: '🔮',
  scroll: '📜',
  bookmark: '🔖',
  label: '🏷️',
  scissors: '✂️',
  paperclip: '📎',
  pushpin: '📌',
  ruler: '📏',
  folder: '📁',
  open_folder: '📂',
  file: '📄',
  memo: '📝',
  notebook: '📓',
  recycle: '♻️',
  infinity: '♾️',
  hundred: '💯',
  up_arrow: '⬆️',
  down_arrow: '⬇️',
  left_arrow: '⬅️',
  right_arrow: '➡️',
  no_entry: '🚫',
  info: 'ℹ️',
  peace: '☮️',
  warning: '⚠️',
  radioactive: '☢️',
  biohazard: '☣️',
  arrow_up_small: '🔼',
  arrow_down_small: '🔽',
  arrow_double_up: '⏫',
  arrow_double_down: '⏬',
  rewind: '⏪',
  fast_forward: '⏩',
  play_pause: '⏯️',
  stop: '⏹️',
  record: '⏺️',
  eject: '⏏️',
  shuffle: '🔀',
  repeat: '🔁',
  repeat_one: '🔂',
  previous_track: '⏮️',
  next_track: '⏭️',
  m: 'Ⓜ️',
  wc: '🚾',
  parking: '🅿️',
  wheelchair: '🦽',
  baby_symbol: '🚼',
  restroom: '🚻',
  put_litter: '🚮',
  passport_control: '🛂',
  customs: '🛃',
  baggage_claim: '🛄',
  left_luggage: '🛅',
  mens: '🚹',
  womens: '🚺',
  baby_change: '🚼',
  water_closet: '🚾',
  potable_water: '🚰',
  non_potable_water: '🚱',
  no_pedestrians: '🚷',
  no_mobile_phones: '📵',
  underage: '🔞',
  no_entry2: '⛔',
  angry_face: '😠',
  astonished: '😮',
  blush: '😊',
  broken_heart2: '💔',
  confused: '😕',
  disappointed: '😞',
  disappointed_relieved: '😥',
  dizzy_face: '😵',
  expressionless: '😑',
  frowning: '😦',
  grimacing: '😬',
  grinning: '😀',
  grinning_face_with_smiling_eyes: '😄',
  heart_eyes: '😍',
  kissing: '😗',
  kissing_heart: '😘',
  kissing_smiling_eyes: '😙',
  laughing: '😆',
  neutral_face: '😐',
  open_mouth: '😮',
  pensive: '😔',
  persevere: '😣',
  relaxed: '☺️',
  relieved: '😌',
  scream: '😱',
  sleeping2: '😴',
  sleepless: '😫',
  smiling_imp: '😈',
  smirk: '😏',
  stuck_out_tongue: '😛',
  stuck_out_tongue_closed_eyes: '😝',
  stuck_out_tongue_winking_eye: '😜',
  sunglasses: '😎',
  sweat_drops: '💦',
  sweat_smile: '😅',
  tired_face: '😫',
  unamused: '😒',
  weary: '😩',
  worried: '😟',
  yum: '😋',
  zip: '🤐',
  rage: '😡',
  rage2: '🤬',
  symbols: '🔣',
  abc: '🔤',
  abcd: '🔡',
  capital_abcd: '🔠',
  one: '1️⃣',
  two: '2️⃣',
  three: '3️⃣',
  four: '4️⃣',
  five: '5️⃣',
  six: '6️⃣',
  seven: '7️⃣',
  eight: '8️⃣',
  nine: '9️⃣',
  zero: '0️⃣',
  keycap_ten: '🔟',
  hash: '#️⃣',
  asterisk: '*️⃣',
  arrow_heading_up: '⤴️',
  arrow_heading_down: '⤵️',
  arrows_clockwise: '🔄',
  arrows_counterclockwise: '🔄',
  back: '🔙',
  end: '🔚',
  on: '🔛',
  soon: '🔜',
  top: '🔝',
  heavy_dollar_sign: '💲',
  currency_exchange: '💱',
  heavy_dollar: '💲',
  registered: '®️',
  trademark: '™️',
  copyright: '©️',
  bangbang: '‼️',
  interrobang: '⁉️',
  o: '⭕',
  heavy_large_circle: '⭕',
  white_circle: '⚪',
  black_circle: '⚫',
  red_circle: '🔴',
  large_blue_circle: '🔵',
  small_red_triangle: '🔺',
  small_red_triangle_down: '🔻',
  small_orange_diamond: '🔸',
  small_blue_diamond: '🔹',
  large_orange_diamond: '🔶',
  large_blue_diamond: '🔷',
  black_small_square: '▪️',
  white_small_square: '▫️',
  black_large_square: '⬛',
  white_large_square: '⬜',
  black_medium_square: '◼️',
  white_medium_square: '◻️',
  black_medium_small_square: '◾',
  white_medium_small_square: '◽',
  black_square_button: '🔲',
  white_square_button: '🔳',
  clock1: '🕐',
  clock2: '🕑',
  clock3: '🕒',
  clock4: '🕓',
  clock5: '🕔',
  clock6: '🕕',
  clock7: '🕖',
  clock8: '🕗',
  clock9: '🕘',
  clock10: '🕙',
  clock11: '🕚',
  clock12: '🕛',
  clock130: '🕜',
  clock230: '🕝',
  clock330: '🕞',
  clock430: '🕟',
  clock530: '🕠',
  clock630: '🕡',
  clock730: '🕢',
  clock830: '🕣',
  clock930: '🕤',
  clock1030: '🕥',
  clock1130: '🕦',
  clock1230: '🕧',
  eye: '👁️',
  eye_in_speech_bubble: '👁️‍🗨️',
  brain: '🧠',
  anatomical_heart: '🫀',
  lungs: '🫁',
  tooth: '🦷',
  bone: '🦴',
  foot: '🦶',
  leg: '🦵',
  hand: '✋',
  ear: '👂',
  nose: '👃',
  mouth: '👄',
  tongue2: '👅',
  fingerprint: '🫂',
  dna: '🧬',
  red_haired: '🧑‍🦰',
  curly_haired: '🧑‍🦱',
  bald: '🧑‍🦲',
  white_haired: '🧑‍🦳',
  bearded: '🧔',
  monocle: '🧐',
  scarfed: '🧕',
  veiled: '🧕',
  tuxedo: '🤵',
  sari: '🥻',
  kimono: '👘',
  swim_cap: '🤿',
  goggles: '🥽',
  lab_coat: '🥼',
  safety_vest: '🦺',
  hiking_boot: '🥾',
  womans_boot: '👢',
  flat_shoe: '🥿',
  ballet_shoes: '🩰',
  mans_shoe: '👞',
  running_shoe: '👟',
  high_heel: '👠',
  womans_sandal: '👡',
  womans_flat_shoe: '🥿',
  thong_sandal: '🩴',
  backpack: '🎒',
  clutch_bag: '👛',
  purse: '👛',
  handbag: '👜',
  briefcase: '💼',
  school_satchel: '🎒',
  luggage: '🧳',
  shopping_bags: '🛍️',
  stethoscope: '🩺',
  x_ray: '🩻',
  bandage: '🩹',
  plaster: '🩹',
  crutch: '🦼',
  prosthesis: '🦿',
  wheelchair2: '🦽',
  mechanical_arm: '🦾',
  mechanical_leg: '🦿',
  hearing_aid: '🦻',
  deaf_person: '🧏',
  accessibility: '♿',
  service_dog: '🦮',
  guide_dog: '🦮',
  probing_cane: '🦯',
  white_cane: '🦯',
  mirror: '🪞',
  window: '🪟',
  plunger: '🪠',
  mouse_trap: '🪤',
  teddy_bear: '🧸',
  nesting_dolls: '🪆',
  thread: '🧵',
  yarn: '🧶',
  sewing_needle: '🪡',
  knot: '🪢',
  basket: '🧺',
  roller_skate: '🛼',
  skateboard: '🛹',
  sled: '🛷',
  flying_disc: '🥏',
  boomerang: '🪃',
  pinata: '🪅',
  magic_wand: '🪄',
  piñata: '🪅',
  parachute: '🪂',
  new_moon: '🌑',
  waxing_crescent: '🌒',
  first_quarter: '🌓',
  waxing_gibbous: '🌔',
  full_moon: '🌕',
  waning_gibbous: '🌖',
  last_quarter: '🌗',
  waning_crescent: '🌘',
  crescent_moon: '🌙',
  new_moon_face: '🌚',
  first_quarter_moon_face: '🌛',
  last_quarter_moon_face: '🌜',
  full_moon_face: '🌝',
  sun_with_face: '🌞',
  star2: '🌟',
  star3: '⭐',
  glowing_star: '🌟',
  dizzy_star: '💫',
  sparkles2: '✨',
  collision: '💥',
  explosion: '💥',
  sweat_drops2: '💦',
  dash: '💨',
  tornado: '🌪️',
  fog2: '🌫️',
  open_umbrella: '☂️',
  umbrella: '☔',
  closed_umbrella: '🌂',
  snowman2: '⛄',
  snowman_without_snow: '⛄',
  comet2: '☄️',
  fire2: '🔥',
  droplet2: '💧',
  ocean2: '🌊',
  jack_o_lantern: '🎃',
  christmas_tree2: '🎄',
  fireworks3: '🎆',
  sparkler2: '🎇',
  tanabata_tree2: '🎋',
  bamboo2: '🎍',
  rice_scene2: '🎑',
  wrapped_gift2: '🎁',
  balloon4: '🎈',
  flags3: '🎏',
  ribbon2: '🎀',
  confetti2: '🎊',
  party_popper: '🎉',
  gift_heart2: '💝',
  heart_decoration: '💟',
  heart_exclamation: '❣️',
  broken_heart3: '💔',
  two_hearts2: '💕',
  revolving_hearts: '💞',
  heartbeat2: '💓',
  growing_heart2: '💗',
  sparkling_heart: '💖',
  heart_pulse: '💗',
  yellow_heart2: '💛',
  green_heart2: '💚',
  blue_heart2: '💙',
  purple_heart2: '💜',
  black_heart2: '🖤',
  white_heart2: '🤍',
  brown_heart: '🤎',
  orange_heart2: '🧡',
  100: '💯',
  anger: '💢',
  bomb2: '💣',
  sweat_drops3: '💦',
  dash2: '💨',
  dizzy2: '💫',
  explosion2: '💥',
  muscle2: '💪',
  dizzy_symbol: '💫',
  speech_balloon: '💬',
  thought_balloon: '💭',
  anger_symbol: '💢',
  sleeping_symbol: '💤',
  boom: '💥',
  collision_symbol: '💥',
  sweat_symbol: '💦',
  dash_symbol: '💨',
  dizzy_symbol2: '💫',
  zzz: '💤',
  anger_bubble: '🗯️',
  right_anger_bubble: '🗯️',
  speech: '💬',
  thought: '💭',
  eye_speech: '👁️‍🗨️',
  left_speech: '🗨️',
  right_speech: '🗨️',
  anger_right: '🗯️',
  anger_left: '🗯️',
  zzz2: '💤',
  hole: '🕳️',
  dark_sunglasses: '🕶️',
  goggles2: '🥽',
  lab_coat2: '🥼',
  safety_vest2: '🦺',
  necktie: '👔',
  shirt: '👕',
  jeans2: '👖',
  dress: '👗',
  kimono2: '👘',
  bikini: '👙',
  womans_clothes: '👚',
  purse2: '👛',
  handbag2: '👜',
  briefcase2: '💼',
  school_satchel2: '🎒',
  shopping_bags2: '🛍️',
  backpack2: '🎒',
  mans_shoe2: '👞',
  athletic_shoe: '👟',
  high_heel2: '👠',
  sandal: '👡',
  boot: '👢',
  crown2: '👑',
  womans_hat: '👒',
  tophat: '🎩',
  mortar_board: '🎓',
  helmet: '⛑️',
  prayer_beads: '📿',
  lipstick2: '💄',
  ring2: '💍',
  gem: '💎',
  monkey_face: '🐵',
  monkey2: '🐒',
  gorilla: '🦍',
  orangutan: '🦧',
  dog_face: '🐶',
  dog2: '🐕',
  poodle: '🐩',
  wolf: '🐺',
  fox: '🦊',
  raccoon: '🦝',
  cat_face: '🐱',
  cat2: '🐈',
  lion: '🦁',
  tiger_face: '🐯',
  tiger2: '🐅',
  leopard: '🐆',
  horse_face: '🐴',
  horse2: '🐎',
  unicorn: '🦄',
  zebra: '🦓',
  deer: '🦌',
  cow_face: '🐮',
  ox: '🐂',
  water_buffalo: '🐃',
  cow2: '🐄',
  pig_face: '🐷',
  pig2: '🐖',
  boar: '🐗',
  pig_nose: '🐽',
  ram: '🐏',
  sheep: '🐑',
  ewe: '🐑',
  goat: '🐐',
  camel: '🐪',
  two_hump_camel: '🐫',
  llama: '🦙',
  giraffe: '🦒',
  elephant: '🐘',
  rhinoceros: '🦏',
  hippopotamus: '🦛',
  mouse_face: '🐭',
  mouse2: '🐁',
  rat: '🐀',
  hamster: '🐹',
  rabbit_face: '🐰',
  rabbit2: '🐇',
  chipmunk: '🐿️',
  hedgehog: '🦔',
  bat: '🦇',
  bear: '🐻',
  koala: '🐨',
  polar_bear: '🐻‍❄️',
  sloth: '🦥',
  otter: '🦦',
  skunk: '🦨',
  kangaroo: '🦘',
  badger: '🦡',
  paw_prints: '🐾',
  turkey: '🦃',
  chicken: '🐔',
  rooster: '🐓',
  hatching_chick: '🐣',
  baby_chick: '🐤',
  front_facing_baby_chick: '🐥',
  bird: '🐦',
  penguin: '🐧',
  dove: '🕊️',
  eagle: '🦅',
  duck: '🦆',
  owl: '🦉',
  parrot: '🦜',
  frog: '🐸',
  crocodile: '🐊',
  turtle: '🐢',
  lizard: '🦎',
  snake2: '🐍',
  dragon_face: '🐲',
  dragon2: '🐉',
  sauropod: '🦕',
  t_rex: '🦖',
  spouting_whale: '🐳',
  whale2: '🐋',
  dolphin: '🐬',
  fish2: '🐟',
  tropical_fish: '🐠',
  blowfish: '🐡',
  shark: '🦈',
  octopus: '🐙',
  shell: '🐚',
  snail: '🐌',
  butterfly: '🦋',
  bug: '🐛',
  ant: '🐜',
  honeybee: '🐝',
  bee: '🐝',
  beetle: '🪲',
  lady_beetle: '🐞',
  cricket: '🦗',
  cockroach: '🪳',
  spider: '🕷️',
  spider_web: '🕸️',
  scorpion: '🦂',
  mosquito: '🦟',
  fly: '🪰',
  worm: '🪱',
  microbe: '🦠',
  bouquet: '💐',
  cherry_blossom: '🌸',
  white_flower: '🌼',
  rosette: '🌹',
  rose2: '🌹',
  wilted_flower: '🥀',
  hibiscus: '🌺',
  sunflower2: '🌻',
  blossom2: '🌼',
  tulip2: '🌷',
  seedling: '🌱',
  evergreen_tree: '🌲',
  deciduous_tree: '🌳',
  palm_tree: '🌴',
  cactus2: '🌵',
  sheaf_of_rice: '🌾',
  herb: '🌿',
  shamrock: '☘️',
  four_leaf_clover: '🍀',
  maple_leaf: '🍁',
  fallen_leaf2: '🍂',
  leaf_fluttering_in_wind: '🍃',
  mushroom2: '🍄',
  chestnut: '🌰',
  crab: '🦀',
  lobster: '🦞',
  shrimp: '🦐',
  squid: '🦑',
  oyster: '🦪',
  ice: '🧊',
  ice_cube: '🧊',
  coal: '🪨',
  rock: '🪨',
  wood: '🪵',
  log: '🪵',
  feather: '🪶',
  broom: '🧹',
  basket2: '🧺',
  soap: '🧼',
  sponge: '🧽',
  squeeze: '🧽',
  thread2: '🧵',
  yarn2: '🧶',
  needle: '🪡',
  safety_pin: '🧷',
  zipper: '🤐',
  zipper_face: '🤐',
  a: '🅰️',
  b: '🅱️',
  ab: '🆎',
  cl: '🆑',
  o2: '🆗',
  sos: '🆘',
  up: '🆙',
  vs: '🆚',
  id: '🆔',
  new: '🆕',
  ng: '🆖',
  free: '🆓',
  cool2: '🆒'
};

/**
 * 表情代码解析替换函数
 *
 * 支持4种表情代码格式：
 * 1. 贴吧格式 `#/xxx`    - 正则: #\/([\u4e00-\u9fa5a-zA-Z0-9_]+)  （只匹配中文/英文/数字/下划线，避免吞入标点符号）
 * 2. 论坛格式 `[xxx]`    - 正则: \[([^\]]+)\]
 * 3. Discord格式 `:xxx:` - 正则: :([a-zA-Z0-9_]+):
 * 4. 括号格式 `(xxx)`    - 正则: \(([^()]+)\)
 *
 * 每种格式查找匹配内容，在 emojiMap 中查找对应 emoji，找到则替换，找不到保留原文。
 * `[xxx]` 和 `(xxx)` 格式仅在内容存在于 emojiMap 中时才替换，避免误替换正常括号内容。
 * `:xxx:` 格式只匹配英文/数字/下划线，避免误替换时间格式如 `12:30`。
 */

/**
 * 将文本中的表情代码替换为对应的 Unicode emoji 字符
 *
 * @param text - 包含表情代码的原始文本
 * @returns 替换了表情代码后的文本
 */
export function parseEmojis(text: string): string {
  if (!text || text.length === 0) {
    return text;
  }

  // 图片占位标记保护：[IMG:file:///...] 或 [IMG:data:image/...] 不做表情解析
  // 避免被下面的 Discord 格式 `:xxx:` 正则误匹配（如 [IMG:file:///x] 中的 :file:
  // 会被匹配为 emoji "file" → 📄，破坏图片占位标记）
  // 方案：提取所有 [IMG:...] 标记为占位符，表情解析后还原
  const imgMarkers: string[] = [];
  const protectedText = text.replace(/\[IMG:[^\]]+\]/g, (match) => {
    const idx = imgMarkers.length;
    imgMarkers.push(match);
    return `\x00IMG${idx}\x00`;
  });

  // 整段都是 [IMG:...] 标记时，无需表情解析
  if (imgMarkers.length > 0 && protectedText.replace(/\x00IMG\d+\x00/g, '').trim().length === 0) {
    return text;
  }

  let result: string = protectedText;

  // 1. 替换贴吧格式 `#/xxx`（只匹配中文/英文/数字/下划线，避免吞入后面的标点符号）
  result = result.replace(/#\/([\u4e00-\u9fa5a-zA-Z0-9_]+)/g, (match: string, name: string): string => {
    const emoji: string | undefined = emojiMap[name];
    return emoji !== undefined ? emoji : match;
  });

  // 2. 替换论坛格式 `[xxx]` - 仅当括号内容在 emojiMap 中存在时才替换
  result = result.replace(/\[([^\]]+)\]/g, (match: string, name: string): string => {
    const emoji: string | undefined = emojiMap[name];
    return emoji !== undefined ? emoji : match;
  });

  // 3. 替换 Discord格式 `:xxx:` - 只匹配英文/数字/下划线，避免误替换时间格式
  result = result.replace(/:([a-zA-Z0-9_]+):/g, (match: string, name: string): string => {
    const emoji: string | undefined = emojiMap[name];
    return emoji !== undefined ? emoji : match;
  });

  // 4. 替换括号格式 `(xxx)` - 仅当括号内容在 emojiMap 中存在时才替换
  result = result.replace(/\(([^()]+)\)/g, (match: string, name: string): string => {
    const emoji: string | undefined = emojiMap[name];
    return emoji !== undefined ? emoji : match;
  });

  // 还原 [IMG:...] 标记
  if (imgMarkers.length > 0) {
    result = result.replace(/\x00IMG(\d+)\x00/g, (_, idx) => imgMarkers[Number(idx)] || '');
  }

  return result;
}

/* ==================== 6. 段落分割 ==================== */

/**
 * 段落分割函数 — 多维度兼容 TXT 小说的各种段落格式
 *
 * 兼容的段落分隔格式（按优先级递降尝试）：
 *   1. 空行分隔（\n\n）        — 网络小说标准格式，最常见
 *   2. 单换行分隔（\n）         — 每段占一行，段间无空行
 *   3. 全角缩进分隔（　　）     — 中文小说常见，每段开头两个全角空格
 *   4. 半角缩进分隔（  ）       — 每段开头两个半角空格
 *   5. 标点符号分隔             — 连续无换行无缩进，按句末标点分段
 *
 * 同时兼容 Windows 换行符（\r\n）和旧 Mac 换行符（\r）。
 */

/**
 * 将章节正文切分为段落，兼容多种 TXT 段落格式。
 *
 * @param raw 章节原始正文文本
 * @returns 段落文本数组（已应用表情解析）
 */
export function splitParagraphs(raw: string): string[] {
  if (!raw) return [];

  // 1. 统一换行符：\r\n → \n，\r → \n
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 1.5 保护多行块级标记（[TABLE]/[CODE]/[QUOTE]/[OL]/[UL]/[DL]）不被空行分割
  // 这些标记内部可能包含空行（如 [TABLE] 内的 [IMG:...] 占位标记间有空行，
  // [OL]/[UL]/[DL] 内的 [LI]/[DT]/[DD] 项间有空行），
  // splitParagraphs 的空行分割会破坏其完整性，导致 renderRichTextBlock 的
  // ^\[TABLE\]...\[/TABLE\]$ 正则无法匹配，标记作为纯文本显示。
  // 方案：提取块级标记为占位符，分段后还原
  const blockMarkers: string[] = [];
  const BLOCK_RE = /\[(TABLE|CODE|QUOTE|OL|UL|DL)\]([\s\S]*?)\[\/\1\]/g;
  const protectedText = normalized.replace(BLOCK_RE, (match) => {
    const idx = blockMarkers.length;
    blockMarkers.push(match);
    return `\n\x00BLK${idx}\x00\n`;
  });
  const restoreBlocks = (parts: string[]): string[] => {
    if (blockMarkers.length === 0) return parts;
    return parts.map((p) => p.replace(/\x00BLK(\d+)\x00/g, (_, idx) => blockMarkers[Number(idx)] || ''));
  };

  // 1.6 二次处理：将混合了文字和 [IMG:...] 标记的段落拆分到独立段落
  //   renderImagePlaceholder 只处理整段都是 [IMG:...] 的段落（或多个 [IMG:...] 用空格分隔），
  //   若一段文字中混合了文字和 [IMG:...] 标记（如 "文字[IMG:file:///xxx]继续"），
  //   图片不会渲染。方案：对每个段落，若包含 [IMG: 标记且去除所有 [IMG:...] 标记后
  //   还有其他文字，用正则将每个 [IMG:...] 拆分到独立段落。
  const splitMixedImageMarkers = (paras: string[]): string[] => {
    const result: string[] = [];
    for (const para of paras) {
      if (para.includes('[IMG:')) {
        // 去除所有 [IMG:...] 标记和空白后若还有内容，说明是混合段落
        const stripped = para.replace(/\[IMG:[^\]]+\]/g, '').trim();
        if (stripped.length > 0) {
          // 用捕获组拆分，保留 [IMG:...] 标记
          const subParts = para
            .split(/(\[IMG:[^\]]+\])/g)
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
          for (const subPart of subParts) {
            result.push(subPart);
          }
          continue;
        }
      }
      result.push(para);
    }
    return result;
  };

  // 统一返回处理：还原块级标记 → 表情解析 → 拆分混合图片标记
  const finalize = (parts: string[]): string[] =>
    splitMixedImageMarkers(restoreBlocks(parts.map((p) => parseEmojis(p))));

  // 2. 先尝试空行分割（\n\s*\n）— 最可靠的段落分隔方式
  let parts = protectedText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length > 1) {
    return finalize(parts);
  }

  // 3. 空行分割只得到1段，但原文包含换行符 → 改用单换行分割
  if (protectedText.includes('\n')) {
    parts = protectedText
      .split(/\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (parts.length > 1) {
      return finalize(parts);
    }
  }

  // 4. 无换行或单换行分割仍只有1段 → 尝试全角缩进分割（　　）
  //    中文小说常见格式：每段开头有两个全角空格，段落间无空行
  if (protectedText.includes('\u3000\u3000')) {
    parts = protectedText
      .split(/(?=\u3000\u3000)/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (parts.length > 1) {
      return finalize(parts);
    }
  }

  // 5. 尝试半角缩进分割（行首2+空格）
  //    部分英文文献/格式化文本：每段开头有缩进空格
  if (/^ {2,}/m.test(protectedText)) {
    parts = protectedText
      .split(/(?=^ {2,})/m)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (parts.length > 1) {
      return finalize(parts);
    }
  }

  // 6. 所有方法都只有1段 → 按句末标点强制分段
  //    连续无换行无缩进的文本，按句号/感叹号/问号分段
  //    每3-5句合并为一段，避免段落过短
  if (parts.length <= 1 && protectedText.length > 200) {
    parts = splitByPunctuation(protectedText);
    if (parts.length > 1) {
      return finalize(parts);
    }
  }

  // 7. 最终回退：返回整段文本
  return splitMixedImageMarkers(restoreBlocks([parseEmojis(protectedText.trim())].filter((p) => p.length > 0)));
}

/**
 * 按句末标点强制分段，每3-5句合并为一段。
 *
 * 句末标点：。！？；…（中文）.!?;...（英文）
 * 每 SENTENCES_PER_PARAGRAPH 句合并为一段。
 */
const SENTENCES_PER_PARAGRAPH = 3;

function splitByPunctuation(text: string): string[] {
  // 按句末标点切分，保留标点
  const sentences = text
    .split(/(?<=[。！？；…\.!?;])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length <= 1) return [text.trim()];

  // 每 N 句合并为一段
  const result: string[] = [];
  for (let i = 0; i < sentences.length; i += SENTENCES_PER_PARAGRAPH) {
    const chunk = sentences
      .slice(i, i + SENTENCES_PER_PARAGRAPH)
      .join('')
      .trim();
    if (chunk.length > 0) {
      result.push(chunk);
    }
  }

  return result;
}

/* ==================== 7. 富文本渲染 ==================== */

/**
 * 富文本标记渲染器
 *
 * 将解析器产生的富文本标记转为 HTML，用于阅读器段落渲染。
 * 与 [IMG:] 占位标记机制一致，在 renderParagraphWithHighlights 中调用。
 *
 * 标记格式（由 html-semantic.ts 的 convertSemanticHtmlToMarkers 产生）：
 * - [CODE]代码[/CODE] — 代码块
 * - [QUOTE]引用[/QUOTE] — 引用块
 * - [TABLE]表格HTML[/TABLE] — 表格
 * - [H1]标题[/H1] ~ [H6]标题[/H6] — 标题
 * - [LI]列表项[/LI] — 列表项
 * - **加粗** — 加粗文本
 * - *斜体* — 斜体文本
 * - [LINK:url]文本[/LINK] — 链接
 *
 * XSS 安全：
 * - [CODE]/[QUOTE]/[H1-H6]/[LI] 内容用 escapeHtml 转义
 * - [TABLE] 内容已经是安全的 HTML（来自 EPUB/MOBI，已过滤 script/iframe 等）
 * - [LINK] URL 只允许 http:// / https:// 协议
 */

/**
 * 渲染富文本块级标记。
 *
 * 检测段落是否为富文本块级标记行（CODE/QUOTE/TABLE/H1-H6/LI），
 * 如果是，返回对应的 HTML；如果不是，返回 null。
 *
 * 块级标记独占段落（由 convertSemanticHtmlToMarkers 用 \n 包围），
 * 不会与文字混合，因此可以整段匹配。
 *
 * @param para 段落文本（已 trim，兼容 smartFormat 缩进前缀）
 * @returns 渲染后的 HTML（如果是块级标记），或 null（不是块级标记）
 */
export function renderRichTextBlock(para: string): string | null {
  // 兼容 smartFormat 可能加的缩进前缀（全角空格/半角空格），用 trim 后匹配
  const trimmed = para.trim();

  // [CODE]代码[/CODE] → <pre class="rich-code">代码</pre>
  // 代码块保留换行和缩进，用 escapeHtml 转义
  const codeMatch = trimmed.match(/^\[CODE\]([\s\S]*?)\[\/CODE\]$/);
  if (codeMatch) {
    return `<pre class="rich-code">${escapeHtml(codeMatch[1])}</pre>`;
  }

  // [QUOTE]引用[/QUOTE] → <blockquote class="rich-quote">引用</blockquote>
  // 引用块保留换行，用 escapeHtml 转义
  const quoteMatch = trimmed.match(/^\[QUOTE\]([\s\S]*?)\[\/QUOTE\]$/);
  if (quoteMatch) {
    // 引用内容可能包含多行，用 <br> 连接
    const quoteContent = escapeHtml(quoteMatch[1]).replace(/\n/g, '<br>');
    return `<blockquote class="rich-quote">${quoteContent}</blockquote>`;
  }

  // [TABLE]表格HTML[/TABLE] → <div class="rich-table">表格HTML</div>
  // 表格内容已经是安全的 HTML（来自 EPUB/MOBI，已过滤 script/iframe 等）
  // 直接用 v-html 渲染，不需要转义
  // 但内容可能包含 [IMG:src] 和 [图片说明：文字] 标记（<img> 在 <table> 之前被转换），
  // 需要递归处理为 HTML 元素
  const tableMatch = trimmed.match(/^\[TABLE\]([\s\S]*?)\[\/TABLE\]$/);
  if (tableMatch) {
    let tableContent = tableMatch[1];
    // [IMG:src] → <img>（表格内的图片占位标记）
    tableContent = tableContent.replace(
      /\[IMG:([^\]]+)\]/g,
      '<img src="$1" alt="" loading="lazy" decoding="async" style="max-width:100%;height:auto;border-radius:4px">'
    );
    // [图片说明：文字] → <figcaption>文字</figcaption>
    tableContent = tableContent.replace(
      /\[图片说明：([^\]]+)\]/g,
      '<figcaption style="font-size:0.9em;color:var(--text-tertiary);text-align:center">$1</figcaption>'
    );
    // P1-14修复：用 DOMPurify.sanitize 消毒 TABLE 内容，防止 XSS 注入
    // 原实现直接拼接 tableContent 到 v-html，若表格内容含 <script>/onerror 等恶意载荷会执行。
    // 此处限制允许的标签为表格相关元素 + img/figcaption，允许的属性为安全属性。
    tableContent = DOMPurify.sanitize(tableContent, {
      ALLOWED_TAGS: [
        'table',
        'thead',
        'tbody',
        'tfoot',
        'tr',
        'th',
        'td',
        'caption',
        'colgroup',
        'col',
        'img',
        'figcaption'
      ],
      ALLOWED_ATTR: [
        'src',
        'alt',
        'loading',
        'decoding',
        'style',
        'colspan',
        'rowspan',
        'scope',
        'headers',
        'align',
        'valign',
        'width',
        'height'
      ]
    });
    return `<div class="rich-table">${tableContent}</div>`;
  }

  // [H1]~[/H1] ~ [H6]~[/H6] → <h1>~</h1> ~ <h6>~</h6>
  // 标题内容用 escapeHtml 转义
  for (let level = 1; level <= 6; level++) {
    const headingMatch = trimmed.match(new RegExp(`^\\[H${level}\\]([\\s\\S]*?)\\[\\/H${level}\\]$`));
    if (headingMatch) {
      return `<h${level} class="rich-heading rich-h${level}">${escapeHtml(headingMatch[1])}</h${level}>`;
    }
  }

  // [LI]列表项[/LI] → <li class="rich-list-item">列表项</li>
  // 列表项内容用 escapeHtml 转义
  const liMatch = trimmed.match(/^\[LI\]([\s\S]*?)\[\/LI\]$/);
  if (liMatch) {
    return `<li class="rich-list-item">${escapeHtml(liMatch[1])}</li>`;
  }

  // [HR] → <hr class="rich-hr">（水平线）
  if (trimmed === '[HR]') {
    return `<hr class="rich-hr">`;
  }

  // [OL]...[/OL] → <ol class="rich-ol">...</ol>
  // 内容包含 [LI] 标记，渲染为 <li> 元素
  const olMatch = trimmed.match(/^\[OL\]([\s\S]*?)\[\/OL\]$/);
  if (olMatch) {
    const items = olMatch[1].replace(
      /\[LI\]([\s\S]*?)\[\/LI\]/g,
      (_m, c: string) => `<li class="rich-list-item">${escapeHtml(c)}</li>`
    );
    return `<ol class="rich-ol">${items}</ol>`;
  }

  // [UL]...[/UL] → <ul class="rich-ul">...</ul>
  // 内容包含 [LI] 标记，渲染为 <li> 元素
  const ulMatch = trimmed.match(/^\[UL\]([\s\S]*?)\[\/UL\]$/);
  if (ulMatch) {
    const items = ulMatch[1].replace(
      /\[LI\]([\s\S]*?)\[\/LI\]/g,
      (_m, c: string) => `<li class="rich-list-item">${escapeHtml(c)}</li>`
    );
    return `<ul class="rich-ul">${items}</ul>`;
  }

  // [DL]...[/DL] → <dl class="rich-dl">...</dl>
  // 内容包含 [DT]/[DD] 标记，渲染为 <dt>/<dd> 元素
  const dlMatch = trimmed.match(/^\[DL\]([\s\S]*?)\[\/DL\]$/);
  if (dlMatch) {
    const items = dlMatch[1]
      .replace(/\[DT\]([\s\S]*?)\[\/DT\]/g, (_m, c: string) => `<dt class="rich-dt">${escapeHtml(c)}</dt>`)
      .replace(/\[DD\]([\s\S]*?)\[\/DD\]/g, (_m, c: string) => `<dd class="rich-dd">${escapeHtml(c)}</dd>`);
    return `<dl class="rich-dl">${items}</dl>`;
  }

  // [DT]术语[/DT] → <dt class="rich-dt">术语</dt>（定义术语，独占段落时）
  const dtMatch = trimmed.match(/^\[DT\]([\s\S]*?)\[\/DT\]$/);
  if (dtMatch) {
    return `<dt class="rich-dt">${escapeHtml(dtMatch[1])}</dt>`;
  }

  // [DD]描述[/DD] → <dd class="rich-dd">描述</dd>（定义描述，独占段落时）
  const ddMatch = trimmed.match(/^\[DD\]([\s\S]*?)\[\/DD\]$/);
  if (ddMatch) {
    return `<dd class="rich-dd">${escapeHtml(ddMatch[1])}</dd>`;
  }

  // 不是块级标记
  return null;
}

/**
 * 渲染富文本行内标记。
 *
 * 处理段落中的行内标记：加粗/斜体/链接。
 * 在高亮标记处理之前调用，将标记转为 HTML 标签。
 *
 * 注意：此函数不处理块级标记（CODE/QUOTE/TABLE/H1-H6/LI），
 * 块级标记由 renderRichTextBlock 处理。
 *
 * @param text 段落文本（可能含行内标记）
 * @returns 渲染后的 HTML（行内标记已转为 HTML 标签，其他文本已转义）
 */
export function renderRichTextInline(text: string): string {
  // 先转义整个文本，然后处理标记
  // 但是标记中的 ** 和 * 不是 HTML 特殊字符，不会被转义
  // 所以先转义，再处理标记是安全的

  let result = escapeHtml(text);

  // [LINK:url]文本[/LINK] → <a href="url" target="_blank">文本</a>
  // 注意：escapeHtml 会转义 [ ] : / 等字符吗？不会，只转义 & < > " '
  // 所以 [LINK:url]文本[/LINK] 在转义后仍然完整
  // 但是 URL 中的 & 会被转义为 &amp;，需要还原
  result = result.replace(/\[LINK:([^\]]+)\]([\s\S]*?)\[\/LINK\]/g, (_match: string, url: string, content: string) => {
    // 还原 URL 中的 &amp; → &（escapeHtml 转义的）
    const decodedUrl = url.replace(/&amp;/g, '&');
    // 安全检查：只允许 http:// 和 https:// 协议
    if (!/^https?:\/\//i.test(decodedUrl)) {
      // 非安全协议，只保留链接文本
      return content;
    }
    const safeUrl = escapeHtmlAttr(decodedUrl);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="rich-link">${content}</a>`;
  });

  // **文本** → <strong>文本</strong>
  // 注意：先处理 ** 再处理 *，避免 * 误匹配 ** 的第一个 *
  result = result.replace(/\*\*([\s\S]+?)\*\*/g, (_match: string, content: string) => {
    return `<strong>${content}</strong>`;
  });

  // *文本* → <em>文本</em>
  result = result.replace(/\*([\s\S]+?)\*/g, (_match: string, content: string) => {
    return `<em>${content}</em>`;
  });

  // 行内语义标记 → HTML 标签（与 convertSemanticHtmlToMarkers / convertInlineHtmlToRichText 对应）
  // escapeHtml 只转义 & < > " '，不转义 [ ]，所以标记在转义后仍然完整
  result = result.replace(/\[SUB\]([\s\S]*?)\[\/SUB\]/g, (_m, c) => `<sub>${c}</sub>`);
  result = result.replace(/\[SUP\]([\s\S]*?)\[\/SUP\]/g, (_m, c) => `<sup>${c}</sup>`);
  result = result.replace(/\[U\]([\s\S]*?)\[\/U\]/g, (_m, c) => `<u class="rich-underline">${c}</u>`);
  result = result.replace(/\[DEL\]([\s\S]*?)\[\/DEL\]/g, (_m, c) => `<del>${c}</del>`);
  result = result.replace(/\[MARK\]([\s\S]*?)\[\/MARK\]/g, (_m, c) => `<mark class="rich-mark">${c}</mark>`);
  result = result.replace(/\[ICODE\]([\s\S]*?)\[\/ICODE\]/g, (_m, c) => `<code class="rich-inline-code">${c}</code>`);
  result = result.replace(/\[Q\]([\s\S]*?)\[\/Q\]/g, (_m, c) => `<q>${c}</q>`);
  result = result.replace(/\[KBD\]([\s\S]*?)\[\/KBD\]/g, (_m, c) => `<kbd class="rich-kbd">${c}</kbd>`);
  result = result.replace(/\[CITE\]([\s\S]*?)\[\/CITE\]/g, (_m, c) => `<cite class="rich-cite">${c}</cite>`);

  // 补充行内语义标记 → HTML 标签
  result = result.replace(/\[ABBR\]([\s\S]*?)\[\/ABBR\]/g, (_m, c) => `<abbr>${c}</abbr>`);
  result = result.replace(/\[DFN\]([\s\S]*?)\[\/DFN\]/g, (_m, c) => `<dfn>${c}</dfn>`);
  result = result.replace(/\[SAMP\]([\s\S]*?)\[\/SAMP\]/g, (_m, c) => `<samp>${c}</samp>`);
  result = result.replace(/\[VAR\]([\s\S]*?)\[\/VAR\]/g, (_m, c) => `<var>${c}</var>`);

  return result;
}

/* ==================== 8. 段落渲染 ==================== */

/**
 * 段落渲染共享工具
 *
 * 提取自 ScrollView.vue 和 PageView.vue 的 renderParagraphWithHighlights 函数，
 * 消除代码重复。同时提取 [IMG:src] 占位标记解析逻辑，供 ComicView.vue 共用。
 */

/** 高亮笔记数据结构（最小接口） */
export interface HighlightNoteData {
  content: string;
  color: string;
}

/**
 * 检测并渲染 [IMG:src] 图片占位标记
 *
 * - 检测 [IMG:file:///...] 和 [IMG:file://...] 两种格式
 * - 兼容 smartFormat 可能加的缩进前缀（全角空格/半角空格），用 trim 后匹配
 * - 安全检查：只允许 file:///、data:image/、http://、https:// 协议
 * - file:// 格式（非标准，少一个斜杠）自动修复为 file:///
 *
 * @returns 如果是图片占位标记，返回 <img> HTML；否则返回 null
 */
export function renderImagePlaceholder(para: string): string | null {
  // 兼容全角空格 \u3000（smartFormat 可能加缩进）和普通空格
  const trimmed = para.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');

  // [图片说明：文字] → 图片说明文字（figcaption 样式）
  //   见于EPUB/MOBI图片后的说明文字，如 [图片说明：book]、[图片说明：qm]
  //   在表格上下文中已处理（行2039），此处处理普通段落中的 [图片说明：xxx]
  const captionMatch = trimmed.match(/^\[图片说明：(.+?)\]$/);
  if (captionMatch) {
    return `<figcaption class="img-caption">${escapeHtml(captionMatch[1])}</figcaption>`;
  }

  // 单个 [IMG:src] 占位标记（整段都是）
  const singleMatch = trimmed.match(/^\[IMG:(.+)\]$/);
  if (singleMatch) {
    const html = buildImgHtml(singleMatch[1]);
    return html; // '' 表示不支持的协议，null 表示不是占位标记
  }

  // 多个 [IMG:src] 占位标记在同一行（用空格分隔）
  // 例如：[IMG:file:///.../a.png]   [IMG:file:///.../b.jpg]
  // 用全局正则提取所有 [IMG:...] 标记，如果整段都是 [IMG:...] 标记（允许空格分隔），渲染为多个 <img>
  if (trimmed.includes('[IMG:')) {
    const allImgMatches = [...trimmed.matchAll(/\[IMG:([^\]]+)\]/g)];
    if (allImgMatches.length > 1) {
      // 检查整段是否只由 [IMG:...] 标记和空格组成（不含其他文字）
      const reconstructed = allImgMatches.map((m) => m[0]).join('');
      const stripped = trimmed.replace(/\s+/g, '');
      if (stripped === reconstructed) {
        // 全部是图片占位标记，渲染为多个 <img>
        const imgs = allImgMatches.map((m) => buildImgHtml(m[1])).filter((h) => h);
        if (imgs.length > 0) return imgs.join(' ');
      }
    }
  }

  return null;
}

/**
 * 内联替换段落中的 [IMG:src] 标记为 <img> HTML
 *
 * 用于处理文字与图片混合的段落，例如：
 *   "这是插图：[IMG:file:///.../fig.png] 如上图所示"
 * renderImagePlaceholder 只处理纯图片段落（整段都是 [IMG:...]），
 * 混合段落由此函数处理：将每个 [IMG:src] 替换为 <img>，保留 surrounding 文字。
 *
 * @param para 包含 [IMG:src] 标记的段落文本
 * @returns 替换后的 HTML 字符串；如果不含 [IMG:src] 或所有 src 都不支持，返回原文本
 */
function replaceInlineImages(para: string): string {
  // P0-2修复：分段处理，对非[IMG:...]文字调用 escapeHtml 防止 XSS 注入
  // 原实现使用 String.replace 仅替换 [IMG:...] 部分，surrounding 文字未转义，
  // 若段落含 <script> 等恶意标签会原样保留导致 XSS。
  let result = '';
  let lastIdx = 0;
  const regex = /\[IMG:([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(para)) !== null) {
    // 先转义 [IMG:...] 之前的纯文本部分
    result += escapeHtml(para.slice(lastIdx, match.index));
    // 替换 [IMG:src] 为 <img> HTML；若 src 不支持则保留原始标记文本（已转义）
    const imgHtml = buildImgHtml(match[1]);
    result += imgHtml || escapeHtml(match[0]);
    lastIdx = match.index + match[0].length;
  }
  // 转义最后一段尾部文本
  result += escapeHtml(para.slice(lastIdx));
  return result;
}

/**
 * 将 file URL 的路径部分归一化为 percent-encoded 形式（幂等）
 *
 * 背景：主进程用 node:url 的 pathToFileURL() 生成 [IMG:...] URL，生成时已对
 * 中文/空格等做过 percent-encoding（如 "幽" → %E5%B9%BD）。渲染层若再无条件
 * encodeURI，会把 "%" 编成 "%25" 造成双重编码（%E5 → %25E5），浏览器只解码一次，
 * 最终去查找字面名为 "%E5%B9%BD..." 的目录 → ERR_FILE_NOT_FOUND。
 * 含中文的安装目录（旧版 Linux 的 /opt/幽读本地版、Windows 的 ...\幽读本地版）必现；
 * 纯英文路径因没有 % 字符而恰好不触发，这就是"Windows 正常、Linux 看不到图"的原因。
 *
 * 采用 decodeURI → encodeURI 归一化，对"已编码"和"裸路径"两种输入结果一致。
 * encodeURI 不编码 # 和 ?（会被浏览器当作 fragment/query），额外编码为 %23/%3F。
 */
function normalizeFileUrlPath(pathPart: string): string {
  let decoded: string;
  try {
    decoded = decodeURI(pathPart);
  } catch {
    // 含非法 % 转义序列（畸形输入）：保持原样再编码，避免 decodeURI 抛错吞掉整段
    decoded = pathPart;
  }
  return encodeURI(decoded).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/**
 * 根据图片 src 构建 <img> HTML 字符串
 *
 * 安全检查 + 格式规范化：允许 file:///、data:image/、http://、https:// 协议
 * file:// 格式（非标准，少一个斜杠）自动修复为 file:///
 *
 * @returns <img> HTML 字符串；不支持的协议返回空字符串
 */
function buildImgHtml(rawSrc: string): string {
  let src = rawSrc;
  if (
    src.startsWith('file:///') ||
    src.startsWith('data:image/') ||
    src.startsWith('http://') ||
    src.startsWith('https://')
  ) {
    // file:/// 路径可能是主进程 pathToFileURL 已编码的 URL，也可能是裸路径，
    // 必须幂等归一化，不能直接 encodeURI（否则双重编码，见 normalizeFileUrlPath）
    if (src.startsWith('file:///')) {
      src = 'file:///' + normalizeFileUrlPath(src.slice(8));
    }
    // 对 src 进行 HTML 属性转义，防止路径中含 " > < 导致 HTML 注入
    const safeSrc = escapeHtmlAttr(src);
    // class 由 CSS 控制样式；loading="lazy" 浏览器原生懒加载
    // decoding="async" 让浏览器异步解码图片，不阻塞渲染线程（大量图片同时加载时尤其有效）
    // 不设 data-loading——之前设 data-loading="true" + CSS min-height/shimmer 做骨架屏，
    // 但分批渲染后新图片未被 IntersectionObserver 观察，data-loading 永远不移除，导致图片被灰色 shimmer 遮挡
    return `<img src="${safeSrc}" class="inline-illustration" loading="lazy" decoding="async" alt="${i18n.global.t('common.words.illustration')}" />`;
  }
  // 兼容 file:// 格式（非标准，少一个斜杠），修复为 file:///
  if (src.startsWith('file://')) {
    const path = src.slice(7); // 去掉 'file://'
    // 同样做幂等归一化 + 属性转义
    const safeSrc = escapeHtmlAttr('file:///' + normalizeFileUrlPath(path));
    return `<img src="${safeSrc}" class="inline-illustration" loading="lazy" decoding="async" alt="${i18n.global.t('common.words.illustration')}" />`;
  }
  // 不支持的协议：返回空字符串（不显示占位标记原文）
  return '';
}

/**
 * 提取 [IMG:src] 占位标记中的图片 src（已规范化）
 *
 * 与 renderImagePlaceholder 不同，此函数返回原始 src 值（而非 HTML），
 * 供 ComicView.vue 等需要直接使用 src 的场景调用。
 *
 * @returns 如果是图片占位标记，返回规范化后的 src；否则返回 null
 */
export function extractImageSrc(para: string): string | null {
  const imgMatch = para.match(/^\s*\[IMG:(.+)\]\s*$/);
  if (!imgMatch) return null;

  const src = imgMatch[1];
  // 安全检查 + 格式规范化：允许 file:///、data:image/、http://、https:// 协议
  if (
    src.startsWith('file:///') ||
    src.startsWith('data:image/') ||
    src.startsWith('http://') ||
    src.startsWith('https://')
  ) {
    return src;
  }
  // 兼容 file:// 格式（非标准，少一个斜杠），修复为 file:///
  if (src.startsWith('file://')) {
    const path = src.slice(7); // 去掉 'file://'
    return `file:///${path}`;
  }
  // 不支持的协议：返回 null（不显示占位标记原文）
  return null;
}

/**
 * 检测段落是否包含 HTML 标签或实体。
 *
 * 用于在线书籍正文：如果正文直接包含 HTML 标签（未经 convertSemanticHtmlToMarkers 转换），
 * 需要先解析转换为可读文本/富文本标记，否则会被 escapeHtml 转义为纯文本显示。
 *
 * 检测范围：
 * - 任意 HTML 标签（开标签或自闭合标签，如 <p>, <br/>, <span class="x">）
 * - 常见 HTML 实体（&nbsp;, &amp;, &lt;, &gt;, &quot;, &apos;, &#NNN;, &#xNNN;）
 *
 * @param text 段落文本
 * @returns 是否包含 HTML 标签或实体
 */
function containsInlineHtml(text: string): boolean {
  // 检测 HTML 标签：<字母 + 可能的属性 + >
  if (/<[a-z][^>]*>/i.test(text)) return true;
  // 检测 HTML 实体（命名实体或数字实体）
  if (/&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/i.test(text)) return true;
  return false;
}

/**
 * 将段落中的 HTML 标签和实体转换为可读文本/富文本标记。
 *
 * 处理顺序（与 convertSemanticHtmlToMarkers 一致，但针对单个段落优化）：
 * 1. 块级元素：<pre>→[CODE], <blockquote>→[QUOTE], <table>→[TABLE],
 *    <h1>~<h6>→[H1]~[H6], <li>→[LI]
 * 2. 段落/块级分隔：<p>...</p>, <div>...</div> → 内容 + 换行
 * 3. 换行：<br>, <br/> → \n（CSS white-space:pre-wrap 会渲染为换行）
 * 4. 行内元素：<strong>/<b>→**...**, <em>/<i>→*...*, <a href>→[LINK:url]...[/LINK]
 * 5. 其他标签 → 去除标签保留内容
 * 6. HTML 实体 → 对应字符（最后处理，避免 &lt;→< 被误识别为标签）
 *
 * XSS 安全：
 * - [TABLE] 内容过滤 script/iframe/object/embed/on* 事件属性
 * - [LINK] URL 只允许 http:// / https:// 协议
 * - 其他标签内容保留文本，由后续 escapeHtml 转义
 *
 * @param text 包含 HTML 的段落文本
 * @returns 转换后的文本（含富文本标记或纯文本，不含原始 HTML 标签）
 */
function convertInlineHtmlToRichText(text: string): string {
  let result = text;

  // 1. <pre>...</pre> → [CODE]内容[/CODE]
  //    保留换行和缩进，去掉内嵌的 HTML 标签但保留文本
  result = result.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match: string, content: string) => {
    const codeText = content.replace(/<[^>]+>/g, '');
    if (codeText.trim()) {
      return `\n[CODE]${codeText}[/CODE]\n`;
    }
    return '';
  });

  // 2. <blockquote>...</blockquote> → [QUOTE]内容[/QUOTE]
  //    保留段落结构（换行），去内嵌的块级标签但保留文本
  result = result.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match: string, content: string) => {
    const quoteText = content.replace(/<[^>]+>/g, '');
    if (quoteText.trim()) {
      return `\n[QUOTE]${quoteText}[/QUOTE]\n`;
    }
    return '';
  });

  // 3. <table>...</table> → [TABLE]表格HTML[/TABLE]
  //    保留原始 HTML（table/tr/td/th/thead/tbody），渲染时用 v-html 显示
  //    过滤危险标签：script/iframe/object/embed/on* 事件属性
  result = result.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_match: string, content: string) => {
    let cleanHtml = content
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<object[\s\S]*?<\/object>/gi, '')
      .replace(/<embed[^>]*>/gi, '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, '')
      .replace(/<form[\s\S]*?<\/form>/gi, '')
      .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
      .replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"')
      .replace(/src\s*=\s*["']javascript:[^"']*["']/gi, ''); // 去 on* 事件属性
    cleanHtml = `<table>${cleanHtml}</table>`;
    return `\n[TABLE]${cleanHtml}[/TABLE]\n`;
  });

  // 4. <h1>~<h6> → [H1]~[/H1] ... [H6]~[/H6]
  //    标题可能包含行内标签（<strong> 等），先去标签保留文本
  for (let level = 1; level <= 6; level++) {
    result = result.replace(
      new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, 'gi'),
      (_match: string, content: string) => {
        const headingText = content.replace(/<[^>]+>/g, '').trim();
        if (headingText) {
          return `\n[H${level}]${headingText}[/H${level}]\n`;
        }
        return '';
      }
    );
  }

  // 5. <li>...</li> → [LI]内容[/LI]
  //    列表项可能包含行内标签，先去标签保留文本
  result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match: string, content: string) => {
    const itemText = content.replace(/<[^>]+>/g, '').trim();
    if (itemText) {
      return `\n[LI]${itemText}[/LI]\n`;
    }
    return '';
  });

  // 6. <p>...</p>, <div>...</div> → 内容 + 换行（块级分隔）
  //    保留内嵌内容（可能含行内标签，后续步骤处理）
  result = result.replace(/<(?:p|div)[^>]*>([\s\S]*?)<\/(?:p|div)>/gi, (_match: string, content: string) => {
    if (content.trim()) {
      return `\n${content}\n`;
    }
    return '';
  });

  // 7. <br>, <br/> → 换行（CSS white-space:pre-wrap 会渲染为换行）
  result = result.replace(/<br\s*\/?>/gi, '\n');

  // 8. <strong>...</strong> / <b>...</b> → **内容**
  //    行内标记，不用 \n 包围
  result = result.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_match: string, content: string) => {
    if (content.trim()) {
      return `**${content}**`;
    }
    return '';
  });

  // 9. <em>...</em> / <i>...</i> → *内容*
  //    行内标记，不用 \n 包围
  result = result.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_match: string, content: string) => {
    if (content.trim()) {
      return `*${content}*`;
    }
    return '';
  });

  // 10. <a href="url">文本</a> → [LINK:url]文本[/LINK]
  //     行内标记，不用 \n 包围
  //     只保留 http:// 和 https:// 协议，避免 javascript: 等危险协议
  result = result.replace(
    /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match: string, href: string, content: string) => {
      // 安全检查：只允许 http:// 和 https:// 协议
      if (!/^https?:\/\//i.test(href)) {
        // 非安全协议，只保留链接文本
        return content;
      }
      if (content.trim()) {
        return `[LINK:${href}]${content}[/LINK]`;
      }
      return '';
    }
  );

  // 10.1 行内语义标签 → 标记格式（与后端 convertSemanticHtmlToMarkers 保持一致）
  //      EPUB/MOBI 不止纯文字小说，还有技术文档/学术书籍/杂志等
  result = result.replace(/<sub[^>]*>([\s\S]*?)<\/sub>/gi, (_m, c: string) => (c.trim() ? `[SUB]${c}[/SUB]` : ''));
  result = result.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, (_m, c: string) => (c.trim() ? `[SUP]${c}[/SUP]` : ''));
  result = result.replace(/<u[^>]*>([\s\S]*?)<\/u>/gi, (_m, c: string) => (c.trim() ? `[U]${c}[/U]` : ''));
  result = result.replace(/<(?:del|s|strike)[^>]*>([\s\S]*?)<\/(?:del|s|strike)>/gi, (_m, c: string) =>
    c.trim() ? `[DEL]${c}[/DEL]` : ''
  );
  result = result.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, (_m, c: string) => (c.trim() ? `[MARK]${c}[/MARK]` : ''));
  result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c: string) =>
    c.trim() ? `[ICODE]${c}[/ICODE]` : ''
  );
  result = result.replace(/<q[^>]*>([\s\S]*?)<\/q>/gi, (_m, c: string) => (c.trim() ? `[Q]${c}[/Q]` : ''));
  result = result.replace(/<kbd[^>]*>([\s\S]*?)<\/kbd>/gi, (_m, c: string) => (c.trim() ? `[KBD]${c}[/KBD]` : ''));
  result = result.replace(/<cite[^>]*>([\s\S]*?)<\/cite>/gi, (_m, c: string) => (c.trim() ? `[CITE]${c}[/CITE]` : ''));

  // 10.5. 不闭合的块级开标签 → 换行
  //      步骤6只处理了 <p>...</p> 和 <div>...</div>（有闭合标签的）
  //      劣质HTML常见 <p>第一段<p>第二段（无闭合标签），上面正则不匹配
  //      这里将残留的块级开标签替换为换行，确保段落分隔不丢失
  //      <br> 已在步骤7处理，此处不重复
  //      HTML注释 <!-- ... --> 也在此处去除（可能包含标签名，需先处理）
  result = result.replace(/<!--[\s\S]*?-->/g, '');
  result = result.replace(/<(?:p|div|hr|h[1-6]|pre|blockquote|li|ul|ol|table|tr)\b[^>]*>/gi, '\n');

  // 11. 其他标签（含多余的闭合标签如 </p> 无对应开标签）→ 去除标签保留内容
  //     放在实体处理之前，避免 &lt;tag&gt; 被误识别为标签
  result = result.replace(/<\/?[a-z][^>]*>/gi, '');

  // 12. HTML 实体 → 对应字符
  //     放在最后，避免 &lt;→< 被步骤 11 误识别为标签
  result = result
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/gi, (_m: string, code: string) => {
      try {
        return String.fromCodePoint(parseInt(code, 10));
      } catch {
        return _m;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, code: string) => {
      try {
        return String.fromCodePoint(parseInt(code, 16));
      } catch {
        return _m;
      }
    });

  return result;
}

/**
 * 渲染段落（含高亮笔记、富文本、图片占位）
 *
 * 处理顺序：
 * 1. 图片占位标记 [IMG:src] → <img>
 * 2. HTML 标签检测：如果段落包含原始 HTML 标签（在线书籍正文未预处理），
 *    先转换为富文本标记/纯文本，再走后续流程
 * 3. 富文本块级标记 [CODE]/[QUOTE]/[TABLE]/[H1-H6]/[LI] → 对应 HTML
 * 4. 富文本行内标记 **加粗** / *斜体* / [LINK:url]文本[/LINK]
 * 5. 高亮笔记匹配 → <mark> 包裹
 *
 * @param para 段落文本
 * @param highlightNotes 当前章节的高亮笔记数组（由调用方负责获取）
 * @returns 渲染后的 HTML 字符串
 */
export function renderParagraphWithHighlights(para: string, highlightNotes: HighlightNoteData[]): string {
  // 1. 图片占位标记检测：[IMG:src] → <img>
  // 占位标记独占一段（splitParagraphs 已分割），para 可能就是 "[IMG:file:///...]"
  // 兼容 smartFormat 可能加的缩进前缀（全角空格/半角空格），用 trim 后匹配
  const imgHtml = renderImagePlaceholder(para);
  if (imgHtml !== null) return imgHtml;

  // 1.5 混合内容段落：文字 + [IMG:src] 混在同一段落
  // renderImagePlaceholder 只处理纯图片段落，混合段落返回 null
  // 此处将 [IMG:src] 标记内联替换为 <img>，保留 surrounding 文字
  if (para.includes('[IMG:')) {
    const inlineResult = replaceInlineImages(para);
    if (inlineResult !== para) return inlineResult;
  }

  // 2. HTML 标签检测：如果段落包含原始 HTML 标签或实体（在线书籍正文未预处理），
  //    先转换为富文本标记/纯文本，再走后续富文本/高亮流程
  //    EPUB/MOBI 正文已由 convertSemanticHtmlToMarkers 转换为标记，不会触发此分支
  let processedPara = para;
  if (containsInlineHtml(para)) {
    processedPara = convertInlineHtmlToRichText(para);
  }

  // 3. 富文本块级标记检测：[CODE]/[QUOTE]/[TABLE]/[H1-H6]/[LI] → 对应 HTML
  // 块级标记独占一段（convertSemanticHtmlToMarkers 用 \n 包围），不会与文字混合
  const richBlockHtml = renderRichTextBlock(processedPara);
  if (richBlockHtml) return richBlockHtml;

  // 4. 富文本行内标记检测：**加粗** / *斜体* / [LINK:url]文本[/LINK] / [SUB]/[SUP]/[U]/[DEL]/[MARK]/[ICODE]/[Q]/[KBD]/[CITE]
  const hasRichInline =
    /\*\*[\s\S]+?\*\*/.test(processedPara) ||
    /\*[\s\S]+?\*/.test(processedPara) ||
    /\[LINK:[^\]]+\][\s\S]*?\[\/LINK\]/.test(processedPara) ||
    /\[(?:SUB|SUP|U|DEL|MARK|ICODE|Q|KBD|CITE)\][\s\S]*?\[\/(?:SUB|SUP|U|DEL|MARK|ICODE|Q|KBD|CITE)\]/.test(
      processedPara
    );
  if (hasRichInline) {
    if (highlightNotes.length === 0) {
      return renderRichTextInline(processedPara);
    }
    const hlRanges = computeHighlightRanges(processedPara, highlightNotes);
    if (hlRanges.length === 0) {
      return renderRichTextInline(processedPara);
    }
    let markedText = '';
    let lastEnd = 0;
    for (const range of hlRanges) {
      if (range.start < lastEnd) continue;
      markedText += processedPara.slice(lastEnd, range.start);
      markedText += `\x00S:${range.colorClass}\x00` + processedPara.slice(range.start, range.end) + '\x00E\x00';
      lastEnd = range.end;
    }
    markedText += processedPara.slice(lastEnd);
    let html = renderRichTextInline(markedText);
    html = html.replace(/\x00S:([^\x00]+)\x00/g, '<mark class="$1">');
    html = html.replace(/\x00E\x00/g, '</mark>');
    return html;
  }

  // 5. 高亮笔记匹配
  if (highlightNotes.length === 0) {
    return escapeHtml(processedPara);
  }

  const ranges = computeHighlightRanges(processedPara, highlightNotes);

  if (ranges.length === 0) {
    return escapeHtml(processedPara);
  }

  // 切分文本，拼接 HTML（处理重叠区间：取最先开始的，跳过重叠的）
  let result = '';
  let lastEnd = 0;
  for (const range of ranges) {
    if (range.start < lastEnd) continue;
    result += escapeHtml(processedPara.slice(lastEnd, range.start));
    result += `<mark class="${range.colorClass}">${escapeHtml(processedPara.slice(range.start, range.end))}</mark>`;
    lastEnd = range.end;
  }
  result += escapeHtml(processedPara.slice(lastEnd));

  return result;
}

interface HighlightRange {
  start: number;
  end: number;
  colorClass: string;
}

function computeHighlightRanges(text: string, highlightNotes: HighlightNoteData[]): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  for (const note of highlightNotes) {
    const searchText = note.content.endsWith('…') ? note.content.slice(0, -1) : note.content;
    if (!searchText) continue;
    let searchStart = 0;
    while (searchStart < text.length) {
      const idx = text.indexOf(searchText, searchStart);
      if (idx === -1) break;
      ranges.push({
        start: idx,
        end: idx + searchText.length,
        colorClass: HIGHLIGHT_COLOR_CLASS[note.color] ?? 'highlight-yellow'
      });
      searchStart = idx + searchText.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  return ranges;
}
let _md: MarkdownItInstance | null = null;

function getMarkdownInstance(): MarkdownItInstance {
  if (_md) return _md;
  _md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    highlight(str: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang }).value}</code></pre>`;
        } catch {
          // fallthrough
        }
      }
      return `<pre class="hljs"><code>${_md!.utils.escapeHtml(str)}</code></pre>`;
    }
  });
  return _md;
}

export function renderMarkdown(raw: string): string {
  return getMarkdownInstance().render(raw);
}
