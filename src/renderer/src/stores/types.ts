import type { Book } from '@renderer/types';

import type { ThemeType, ThemeColors } from '../../../shared';
export type { ThemeType, ThemeColors };

export type FontFamilyType = 'system' | 'serif' | 'kai' | 'hei' | 'custom';

export type TextConvertType = 'off' | 's2t' | 't2s';

export type PageTurnAnimationType = 'slide' | 'flip' | 'fade' | 'curl' | 'none';

/** 漫画阅读方向：ltr=左到右（欧美/韩漫），rtl=右到左（日漫） */
export type ComicReadDirection = 'ltr' | 'rtl';

/**
 * 翻页方向（文字阅读器）
 * - left-to-right：左到右翻页（下一页在右）
 * - right-to-left：右到左翻页（下一页在左，适用于传统中文/日文漫画）
 */
export type PageTurnDirectionType = 'left-to-right' | 'right-to-left';

/**
 * 点击翻页区域
 * - left-right：左右两侧点击翻页（中间区域不触发）
 * - bottom：底部区域点击翻页
 * - full：整个页面点击翻页
 */
export type TapTurnZoneType = 'left-right' | 'bottom' | 'full';

/**
 * 快捷键映射：key=动作名，value=按键组合（如 'Ctrl+ArrowRight'）
 * 动作名：nextPage / prevPage / nextChapter / prevChapter /
 *         toggleBookmark / toggleSearch / toggleFullscreen / toggleTTS / closeReader
 */
export type KeyboardShortcuts = Record<string, string>;

/**
 * 漫画翻页动画类型
 * - slide：左右滑动（默认，对标 Tachiyomi）
 * - fade：淡入淡出
 * - none：无动画（直接切换）
 * 注：漫画不使用仿真翻页 flip 与页面卷曲 curl，因整页图片难以做仿生变形。
 */
export type ComicPageTurnAnimationType = 'slide' | 'fade' | 'none';

/** 漫画图片间距（px）：0=无缝，2=紧凑，4=宽松 */
export type ComicImageGap = 0 | 2 | 4;

/**
 * 漫画图片分割类型
 * - fitScreen：适应屏幕（默认）
 * - rtl：右到左分割（日漫双页）
 * - ltr：左到右分割（欧美/韩漫双页）
 * - none：不分割
 */
export type ComicImageSplitType = 'fitScreen' | 'rtl' | 'ltr' | 'none';

/**
 * 漫画阅读器背景色（v57：原固定 #000 黑底不可换）
 * - dark：深黑（默认，保持竞品 SumatraPDF/Mihon 黑底范式，白页边界清晰）
 * - light：浅白（白底扫描页与背景融合更整体；页边界可能模糊）
 * - theme：跟随阅读主题（var(--reader-bg)，与文字阅读器观感统一）
 */
export type ComicBackgroundType = 'dark' | 'light' | 'theme';

/**
 * 漫画页面缩放类型（对标 Mihon/Tachiyomi）
 * - fitScreen：适应屏幕（contain，整页可见，可能有黑边）
 * - fitWidth：适应宽度（宽度填满，高度溢出可滚动，条漫首选）
 * - fitHeight：适应高度（高度撑满一屏，宽度按比例）
 * - original：原始尺寸（1:1 显示，可滚动查看大图）
 * - smartFit：智能适应（宽高比<1用fitWidth，>=1用fitScreen）
 * - custom：自定义百分比（宽度按容器宽的百分比显示，25-400%）
 */
export type ComicScaleType = 'fitScreen' | 'fitWidth' | 'fitHeight' | 'original' | 'smartFit' | 'custom';

/**
 * 图片适配模式 → i18n label key 映射（文案复用 readSettings.comicScale.*，由视图层 t() 解析）。
 * P2 修复：作为图片适配模式的单一数据源——ReadSettings 下拉与阅读器右键"图片适配"子菜单
 * 均从 COMIC_SCALE_TYPES 动态生成选项；新增适配模式时在 ComicScaleType union 与此 Record
 * 同步追加（Record 的穷尽性检查会强制补齐），所有 UI 自动包含新模式。
 * custom 的 label 为静态文案，视图层需要展示具体百分比时自行拼接。
 */
export const COMIC_SCALE_LABEL_KEYS: Record<ComicScaleType, string> = {
  fitWidth: 'readSettings.comicScale.fitWidth',
  fitHeight: 'readSettings.comicScale.fitHeight',
  fitScreen: 'readSettings.comicScale.fitScreen',
  original: 'readSettings.comicScale.original',
  smartFit: 'readSettings.comicScale.smartFit',
  custom: 'readSettings.comicScale.custom'
};

/** 图片适配模式运行时枚举（顺序即菜单展示顺序），从 label key 映射派生，保证单一数据源。
 * 断言安全：Record<ComicScaleType, string> 的键在运行时必然是合法的 ComicScaleType */
export const COMIC_SCALE_TYPES: readonly ComicScaleType[] = Object.keys(
  COMIC_SCALE_LABEL_KEYS
) as ComicScaleType[];

/** 自定义主题只需3个基础值，其他语义令牌自动派生 */
export type CustomThemeColors = Pick<ThemeColors, 'bg' | 'text' | 'primary'>;

// ────────────────────────── 常量定义 ──────────────────────────


/** 检查间隔预设值（毫秒） */
export const CHECK_INTERVALS = {
  /** 每小时 */
  HOUR: 3600000,
  /** 每 6 小时 */
  SIX_HOURS: 21600000,
  /** 每天 */
  DAY: 86400000,
  /** 每周 */
  WEEK: 604800000
} as const;

/** 检查间隔选项值（毫秒，升序）；下拉文案由视图层 i18n 提供 */
export const CHECK_INTERVAL_VALUES = [
  CHECK_INTERVALS.HOUR,
  CHECK_INTERVALS.SIX_HOURS,
  CHECK_INTERVALS.DAY,
  CHECK_INTERVALS.WEEK
] as const;

/** 订阅统计信息（关联书籍数 + 有更新数） */
export interface SubscriptionStat {
  /** 关联书籍总数 */
  bookCount: number;
  /** 有更新的书籍数 */
  updateCount: number;
}
export interface ReadingProgress {
  book_id: number;
  chapter_index: number;
  chapter_offset: number;
  scroll_position: number;
  read_time: number;
  updated_at: number | null;
}

export interface UpdateMetaInput {
  title?: string;
  author?: string | null;
  intro?: string | null;
}

export interface ReparseResult {
  success: boolean;
  chapterCount: number;
  error?: string;
}

type BookRelation = 'same_author' | 'similar_title' | 'reading_history';

export interface RelatedBook extends Book {
  relation: BookRelation;
  relationLabel: string;
}

export interface RelatedBookResult {
  books: RelatedBook[];
  counts: {
    same_author: number;
    similar_title: number;
    reading_history: number;
  };
}

export interface BookReadingStats {
  total_duration: number;
  total_chars: number;
  total_chapters: number;
  session_count: number;
}

export interface DailyReadingStat {
  date: string;
  duration: number;
  chars_read: number;
  chapters_read: number;
}

// ────────────────────────── 常量 ──────────────────────────

/**
 * 阅读趋势统计的天数（最近 N 天的每日阅读统计）。
 * P2-8: 导出供 BookDetail.vue 等消费者复用，避免重复定义。
 */
export const TREND_DAYS = 7;
/**
 * 按内容类型计算可用的导出格式（防御性 UI：不展示会产出空壳/乱码/报错的操作）。
 * P2 修复（审计问题 4/5/6）：Bookshelf 右键菜单与 BookDetail"更多"菜单统一走此函数，
 * 替代此前 CBZ 单点条件渲染、TXT/EPUB 无条件渲染的分散判断。
 *
 * 口径与主进程导出能力对齐（main/ipc/export.ts）：
 * - 漫画（content_type='comic' 或 is_comic=1）：
 *   - TXT 隐藏（图片章节 content=''，导出只有章节标题的空壳文件）
 *   - EPUB 保留（generateEpub 对图片章节嵌 <img> 有效，且加漫画 OPF 标记）
 *   - CBZ 保留（图片原样打包，主进程 is_comic===1 校验通过）
 * - 扫描版（content_type='scan'，或 file_type='pdf' 且 content_type='illustrated'
 *   的粗粒度扫描式判定——scan 无存储字段，归 illustrated 标签）：
 *   - TXT/EPUB 隐藏（readChapterContent 读出的是 OCR 乱码文字层）
 *   - CBZ 隐藏（主进程仅对 is_comic=1 放行，扫描版点击必报错）
 *   - 真图文 PDF 会被粗判误伤，可接受（文字层可靠的书导出文本需求低）
 * - 文本型（text/illustrated 其余情形）：TXT + EPUB 可用；CBZ 仅漫画显示（P2 项保持）
 *
 * @param book 仅依赖 content_type / is_comic / file_type 三个类型字段（可空，兼容旧数据）
 */
export function availableExportFormats(book: {
  content_type?: string | null;
  is_comic?: number | null;
  file_type?: string | null;
}): { txt: boolean; epub: boolean; cbz: boolean } {
  // 漫画判断：content_type 优先，is_comic 兜底（双字段同步由主进程 updateBookContentType 保证）
  const isComic = book.content_type === 'comic' || book.is_comic === 1;
  // 扫描版判断：显式 scan 标签（兼容手动 SQL/旧数据），或 PDF+illustrated 粗粒度扫描式判定
  const isScanLike =
    book.content_type === 'scan' || (book.file_type === 'pdf' && book.content_type === 'illustrated');
  return {
    txt: !isComic && !isScanLike,
    epub: !isScanLike,
    cbz: isComic
  };
}
/**
 * 图片型导出守卫结果类型（主进程 EXPORT_BOOK_TXT / EXPORT_BOOK_EPUB 的拦截返回）。
 *
 * 主进程对图片型书籍（is_comic=1 或 content_type='comic'）不生成空壳文件，
 * 而是返回 { error: 'IMAGE_BOOK' }，前端据此弹提示引导用户改用「导出源文件」或 CBZ。
 */
interface ImageBookExportGuard {
  error: 'IMAGE_BOOK';
}

/**
 * 判断导出 IPC 的返回值是否为图片型守卫拦截（类型收窄守卫函数）。
 *
 * 与用户取消（null）、成功（保存路径 string）区分开：
 * null → 静默；string → 成功提示；guard → 弹「建议导出源文件/CBZ」警告。
 */
export function isImageBookGuard(result: unknown): result is ImageBookExportGuard {
  return (
    typeof result === 'object' && result !== null && (result as { error?: unknown }).error === 'IMAGE_BOOK'
  );
}
