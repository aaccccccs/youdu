/**
 * 合并后的 Stores（Pinia）— Barrel Re-export
 *
 * 本文件为 barrel 导出，实际实现拆分到 ./stores/ 子目录：
 * - stores/types.ts：类型定义与常量
 * - stores/theme.ts：主题工具函数
 * - stores/settings.ts：useSettingsStore 设置状态管理
 * - stores/bookshelf.ts：useBookshelfStore 书架状态管理
 * - stores/subscription.ts：useSubscriptionStore 订阅状态管理
 * - stores/book-detail.ts：useBookDetailStore 书籍详情页状态管理
 * - stores/reader.ts：useReaderStore 阅读器状态管理
 * - stores/bookmark.ts：useBookmarkStore 书签笔记状态管理
 * - stores/highlight.ts：useHighlightStore 高亮/划线状态管理
 */

export * from './stores/types';
export * from './stores/theme';
export * from './stores/settings';
export * from './stores/bookshelf';
export * from './stores/subscription';
export * from './stores/book-detail';
export * from './stores/reader';
export * from './stores/bookmark';
export * from './stores/highlight';
