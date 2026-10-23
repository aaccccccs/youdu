/**
 * 渲染进程共享类型定义
 *
 * 分类组织：
 *   1. 阅读器类型 — ReadMode, ChapterIndex
 *   2. 书签类型 — Bookmark, AddBookmarkInput, UpdateBookmarkInput
 *   3. 书架类型 — Book, Group, ViewMode, SortField, SortOrder, GroupFilter
 *   4. 持久化设置键 — SETTING_KEYS
 *   5. 阅读状态 — ReadingStatus
 *   6. 订阅源类型 — Subscription 等
 *
 * 注意：数据库映射接口（ChapterIndex, Bookmark, Book, Group）的字段名
 * 保持 snake_case，与 DB 表行结构一致。
 *
 * 核心实体类型（Book、Bookmark、ChapterIndex）已提升到 src/shared.ts 统一定义，
 * 本文件通过 re-export 向外暴露，避免各模块逐个从 shared.ts 导入。
 */

import type { Book, Bookmark, ChapterIndex } from '../../shared';

// re-export 核心实体类型，保持现有 `from './types'` 引用兼容
export type { Book, Bookmark, ChapterIndex };

/* ==================== 1. 阅读器类型 ==================== */

/** 阅读模式：chapter 章节滚动 / scroll 连续滚动 / page 翻页 / all 全部加载 */
export type ReadMode = 'chapter' | 'scroll' | 'page' | 'all';

/* ==================== 2. 书签类型 ==================== */

/** 添加书签输入参数 */
export interface AddBookmarkInput {
  book_id: number;
  chapter_index: number;
  position?: number | null;
  content?: string | null;
  note?: string | null;
  highlight_color?: string | null;
}

/** 更新书签输入参数（部分字段可选） */
export interface UpdateBookmarkInput {
  position?: number | null;
  content?: string | null;
  note?: string | null;
  highlight_color?: string | null;
}

/* ==================== 3. 书架类型 ==================== */

/** 分组记录（与 DB groups 表行结构一致） */
export interface Group {
  id: number;
  name: string;
  sort_order: number;
  created_at: number | null;
}

/** 视图模式：grid 九宫格 / list 列表 */
export type ViewMode = 'grid' | 'list';

/** 排序字段 */
export type SortField = 'last_read_at' | 'updated_at' | 'title' | 'created_at' | 'sort_order' | 'author';

/** 排序方向 */
export type SortOrder = 'asc' | 'desc';

/** 分组过滤选项：
 *  - null 表示「全部书籍」
 *  - 'text'/'illustrated'/'comic' 表示智能分组（按书籍类型自动分类）
 *  - 数字表示指定分组 id
 *  注：'ungrouped' 已移除，未分类书籍在「全部书籍」中显示
 *  v21：'mixed' 改为 'illustrated'（图文），对齐 content_type 三分类
 */
export type GroupFilter = number | 'text' | 'illustrated' | 'comic' | null;

/**
 * 书籍类型筛选（v21 起基于 books.content_type 三分类）：
 *  - text（文本）：content_type='text'，纯文字小说
 *  - illustrated（图文）：content_type='illustrated'，图文混合
 *  - comic（漫画）：content_type='comic'，图片为主的书籍
 *  - null 表示不筛选（全部类型）
 */
export type BookTypeFilter = 'text' | 'illustrated' | 'comic' | null;

/* ==================== 4. 持久化设置键 ==================== */

/** 书架持久化设置键名常量 */
export const SETTING_KEYS = {
  VIEW: 'bookshelf.view',
  SORT_FIELD: 'bookshelf.sortField',
  SORT_ORDER: 'bookshelf.sortOrder',
  GROUP_ID: 'bookshelf.groupId',
  READING_STATUS: 'bookshelf.readingStatus',
  BOOK_TYPE: 'bookshelf.bookType'
} as const;

/* ==================== 5. 阅读状态 ==================== */

/** 阅读状态类型：reading(在读)/completed(已读)/want_to_read(想读)/dropped(弃读) */
export type ReadingStatus = 'reading' | 'completed' | 'want_to_read' | 'dropped' | null;

/* ==================== 6. 订阅源类型（v11 新增） ==================== */

/** 订阅类型：folder=本地文件夹, rss=RSS/Atom, http=HTTP网页源 */
export type SubscriptionType = 'folder' | 'rss' | 'http';

/** subscriptions 表行类型（与 DB subscriptions 表行结构一致） */
export interface Subscription {
  id: number;
  name: string;
  type: SubscriptionType;
  url: string;
  /** JSON 配置字符串（过滤规则、扩展名等） */
  config: string | null;
  last_check_at: number | null;
  /** 检查间隔（毫秒，默认 1 小时） */
  check_interval: number;
  /** 是否启用（0=禁用, 1=启用） */
  enabled: number;
  /** 是否自动导入新文件（0=否, 1=是） */
  auto_import: number;
  created_at: number | null;
}

/** 检查更新返回结果 */
export interface CheckUpdateResult {
  subscriptionId: number;
  subscriptionName: string;
  type: string;
  success: boolean;
  newCount: number;
  newItems?: Array<{
    title: string;
    link: string;
    pubDate: number | null;
    content: string;
    guid: string;
  }>;
  error?: string;
}
