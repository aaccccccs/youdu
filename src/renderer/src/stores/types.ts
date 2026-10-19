import type { Book } from '@renderer/types';
import { THEME_COLORS } from '../../../shared';
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
 * 漫画页面缩放类型（对标 Mihon/Tachiyomi）
 * - fitScreen：适应屏幕（contain，整页可见，可能有黑边）
 * - fitWidth：适应宽度（宽度填满，高度溢出可滚动，条漫首选）
 * - original：原始尺寸（1:1 显示，可滚动查看大图）
 * - smartFit：智能适应（宽高比<1用fitWidth，>=1用fitScreen）
 */
export type ComicScaleType = 'fitScreen' | 'fitWidth' | 'original' | 'smartFit';

/** 自定义主题只需3个基础值，其他语义令牌自动派生 */
export type CustomThemeColors = Pick<ThemeColors, 'bg' | 'text' | 'primary'>;

// ────────────────────────── 常量定义 ──────────────────────────

export { THEME_COLORS };
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

export type BookRelation = 'same_author' | 'similar_title' | 'reading_history';

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
