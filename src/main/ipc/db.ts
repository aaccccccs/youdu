/**
 * 数据库 CRUD IPC
 */
import { ipcMain } from 'electron';
import { join } from 'path';
import { unlink, rm } from 'fs/promises';

import { getUserDataRoot } from '../utils';
import { readChapterImages, invalidateReaderSettingsCache, searchInBook } from '../core/chapter-reader';
import * as GroupRepo from '../db/repositories';
import * as BookRepo from '../db/repositories';
import * as ChapterRepo from '../db/repositories';
import * as ProgressRepo from '../db/repositories';
import * as BookmarkRepo from '../db/repositories';
import * as SettingsRepo from '../db/repositories';
import * as ReadingSessionRepo from '../db/repositories';
import * as HighlightRepo from '../db/repositories';
import { setGlobalProxy, type ProxyConfig } from '../core/subscription';
import { setMainLocale } from '../i18n';
import type {
  BookListParams,
  CreateGroupInput,
  UpdateGroupInput,
  CreateBookInput,
  UpdateBookInput,
  SaveProgressInput,
  CreateBookmarkInput,
  UpdateBookmarkInput,
  InsertChapterIndexInput,
  CreateReadingSessionInput,
  CreateHighlightInput,
  UpdateHighlightInput
} from '../db/repositories';

import {
  IPC_CHANNELS,
  wrapHandler,
  isPathSafe,
  assertPositiveInt,
  assertNonEmptyString,
  assertPositiveIntArray
} from './shared';

/** 注册数据库相关 IPC handler */
export function registerDbIpc(): void {
  // ─── 分组 ───
  ipcMain.handle(
    IPC_CHANNELS.GROUP_LIST,
    wrapHandler(() => GroupRepo.listGroups())
  );

  ipcMain.handle(
    IPC_CHANNELS.GROUP_CREATE,
    wrapHandler((_e, input: CreateGroupInput) => {
      if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !input.name.trim()) {
        throw new Error('无效的分组输入：name 必须为非空字符串');
      }
      return GroupRepo.createGroup(input);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.GROUP_UPDATE,
    wrapHandler((_e, id: number, input: UpdateGroupInput) => {
      assertPositiveInt(id, 'id');
      return GroupRepo.updateGroup(id, input);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.GROUP_DELETE,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      return GroupRepo.deleteGroup(id);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.GROUP_REORDER,
    wrapHandler((_e, orders: { id: number; sort_order: number }[]) => GroupRepo.reorderGroups(orders))
  );

  // ─── 书籍 ───
  ipcMain.handle(
    IPC_CHANNELS.BOOK_LIST,
    wrapHandler((_e, params?: BookListParams) => BookRepo.listBooks(params ?? {}))
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOK_GET,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      return BookRepo.getBookById(id);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOK_CREATE,
    wrapHandler((_e, input: CreateBookInput) => {
      // P2 修复：数据库写入操作输入校验，防止异常输入导致崩溃
      if (!input || typeof input !== 'object') throw new Error('无效的书籍输入');
      assertNonEmptyString(input.title, 'title', 500);
      return BookRepo.createBook(input);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOK_UPDATE,
    wrapHandler((_e, id: number, input: UpdateBookInput) => {
      assertPositiveInt(id, 'id');
      // P2 修复：数据库写入操作输入校验
      if (!input || typeof input !== 'object') throw new Error('无效的更新输入');
      if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 500)) {
        throw new Error('无效的 title：必须为不超过 500 字的字符串');
      }
      return BookRepo.updateBook(id, input);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOK_DELETE,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      const result = BookRepo.deleteBook(id);
      if (result) {
        if (result.local_file_path && isPathSafe(result.local_file_path)) {
          unlink(result.local_file_path).catch((e) => console.warn('[db] 清理书籍文件失败:', e));
        }
        if (result.cover && isPathSafe(result.cover)) {
          unlink(result.cover).catch((e) => console.warn('[db] 清理封面文件失败:', e));
        }
        rm(join(getUserDataRoot(), 'rss-images', String(id)), { recursive: true, force: true }).catch((e) =>
          console.warn('[cleanup] 操作失败:', e)
        );
      }
      return result;
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOK_BATCH_DELETE,
    wrapHandler((_e, ids: number[]) => {
      assertPositiveIntArray(ids, 'ids');
      const results = BookRepo.deleteBooks(ids);
      for (const r of results) {
        if (r.local_file_path && isPathSafe(r.local_file_path)) {
          unlink(r.local_file_path).catch((e) => console.warn('[db] 清理书籍文件失败:', e));
        }
        if (r.cover && isPathSafe(r.cover)) {
          unlink(r.cover).catch((e) => console.warn('[db] 清理封面文件失败:', e));
        }
        rm(join(getUserDataRoot(), 'rss-images', String(r.id)), { recursive: true, force: true }).catch((e) =>
          console.warn('[cleanup] 操作失败:', e)
        );
      }
      return results;
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOK_BATCH_MOVE,
    wrapHandler((_e, ids: number[], groupId: number | null) => {
      assertPositiveIntArray(ids, 'ids');
      if (groupId !== null) assertPositiveInt(groupId, 'groupId');
      return BookRepo.moveBooksToGroup(ids, groupId);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOK_TOUCH_READ,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      return BookRepo.touchLastReadAt(id);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOK_GET_RELATED,
    wrapHandler((_e, bookId: number, limit?: number) => {
      assertPositiveInt(bookId, 'bookId');
      if (limit !== undefined) assertPositiveInt(limit, 'limit');
      return BookRepo.getRelatedBooks(bookId, limit);
    })
  );

  // 全文搜索（P1，对标 Kindle/Apple Books）
  ipcMain.handle(
    IPC_CHANNELS.BOOK_SEARCH,
    wrapHandler((_e, bookId: number, keyword: string) => {
      assertPositiveInt(bookId, 'bookId');
      assertNonEmptyString(keyword, 'keyword', 500);
      return searchInBook(bookId, keyword);
    })
  );

  // ─── 章节 ───
  ipcMain.handle(
    IPC_CHANNELS.CHAPTER_LIST_INDEXES,
    wrapHandler((_e, bookId: number) => {
      assertPositiveInt(bookId, 'bookId');
      return ChapterRepo.listChapterIndexes(bookId);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAPTER_GET,
    wrapHandler((_e, bookId: number, chapterIndex: number) => {
      assertPositiveInt(bookId, 'bookId');
      if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw new Error('无效的 chapterIndex');
      return ChapterRepo.getChapter(bookId, chapterIndex);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAPTER_GET_CONTENT,
    wrapHandler((_e, bookId: number, chapterIndex: number) => {
      assertPositiveInt(bookId, 'bookId');
      if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw new Error('无效的 chapterIndex');
      return ChapterRepo.getChapterContent(bookId, chapterIndex);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAPTER_SET_CONTENT,
    wrapHandler((_e, bookId: number, chapterIndex: number, content: string) => {
      if (!Number.isInteger(bookId) || bookId <= 0) throw new Error('无效的 bookId');
      if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw new Error('无效的 chapterIndex');
      if (typeof content !== 'string') throw new Error('无效的 content');
      return ChapterRepo.setChapterContent(bookId, chapterIndex, content);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAPTER_BATCH_INSERT_INDEXES,
    wrapHandler((_e, input: InsertChapterIndexInput[]) => {
      // P2 修复：数据库批量写入操作输入校验
      if (!Array.isArray(input)) throw new Error('无效的章节索引输入：必须为数组');
      if (input.length === 0) return 0;
      if (input.length > 10000) throw new Error('章节索引过多（超过 10000）');
      for (const item of input) {
        if (!item || typeof item !== 'object') throw new Error('无效的章节索引项');
        if (!Number.isInteger(item.book_id) || item.book_id <= 0) throw new Error('无效的 book_id');
        if (!Number.isInteger(item.chapter_index) || item.chapter_index < 0) throw new Error('无效的 chapter_index');
      }
      return ChapterRepo.batchInsertChapterIndexes(input);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAPTER_READ_IMAGES,
    wrapHandler((_e, bookId: number, chapterIndex: number) => {
      assertPositiveInt(bookId, 'bookId');
      if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw new Error('无效的 chapterIndex');
      return readChapterImages(bookId, chapterIndex);
    })
  );

  // ─── 阅读进度 ───
  ipcMain.handle(
    IPC_CHANNELS.PROGRESS_SAVE,
    wrapHandler((_e, input: SaveProgressInput) => {
      if (!input || typeof input !== 'object' || !Number.isInteger(input.book_id) || input.book_id <= 0) {
        throw new Error('无效的进度输入：book_id 必须为正整数');
      }
      return ProgressRepo.saveProgress(input);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.PROGRESS_LOAD,
    wrapHandler((_e, bookId: number) => {
      assertPositiveInt(bookId, 'bookId');
      return ProgressRepo.getProgress(bookId);
    })
  );

  // ─── 书签 ───
  ipcMain.handle(
    IPC_CHANNELS.BOOKMARK_ADD,
    wrapHandler((_e, input: CreateBookmarkInput) => {
      // P2 修复：数据库写入操作输入校验
      if (!input || typeof input !== 'object') throw new Error('无效的书签输入');
      if (!Number.isInteger(input.book_id) || input.book_id <= 0) throw new Error('无效的 book_id');
      if (!Number.isInteger(input.chapter_index) || input.chapter_index < 0) throw new Error('无效的 chapter_index');
      return BookmarkRepo.createBookmark(input);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOKMARK_LIST,
    wrapHandler((_e, bookId: number) => {
      assertPositiveInt(bookId, 'bookId');
      return BookmarkRepo.listBookmarksByBookId(bookId);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOKMARK_GET,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      return BookmarkRepo.getBookmarkById(id);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOKMARK_UPDATE,
    wrapHandler((_e, id: number, input: UpdateBookmarkInput) => {
      assertPositiveInt(id, 'id');
      return BookmarkRepo.updateBookmark(id, input);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOKMARK_REMOVE,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      return BookmarkRepo.deleteBookmark(id);
    })
  );

  // ─── 设置 ───
  ipcMain.handle(
    IPC_CHANNELS.SETTING_GET,
    wrapHandler((_e, key: string) => {
      assertNonEmptyString(key, 'key', 200);
      return SettingsRepo.getSetting(key);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTING_SET,
    wrapHandler((_e, key: string, value: string) => {
      assertNonEmptyString(key, 'key', 200);
      if (typeof value !== 'string') throw new Error('无效的 value：必须为字符串');
      SettingsRepo.setSetting(key, value);
      // 界面语言切换即时同步到主进程（菜单/通知/对话框）
      if (key === 'app.locale') {
        setMainLocale(value);
      }
      // P1-17：阅读相关设置变更时失效章节读取的设置缓存
      if (key === 'reader.textConvert' || key === 'reader.smartFormat') {
        invalidateReaderSettingsCache();
      }
      // P2: 代理配置变更时实时更新全局代理
      if (key === 'http_proxy') {
        try {
          if (value) {
            const proxyConfig = JSON.parse(value) as ProxyConfig;
            if (proxyConfig.host && proxyConfig.port) {
              setGlobalProxy(proxyConfig);
            } else {
              setGlobalProxy(null);
            }
          } else {
            setGlobalProxy(null);
          }
        } catch {
          setGlobalProxy(null);
        }
      }
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTING_GET_ALL,
    wrapHandler(() => SettingsRepo.listSettings())
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTING_DELETE,
    wrapHandler((_e, key: string) => {
      assertNonEmptyString(key, 'key', 200);
      SettingsRepo.deleteSetting(key);
      // P1-17：阅读相关设置变更时失效章节读取的设置缓存
      if (key === 'reader.textConvert' || key === 'reader.smartFormat') {
        invalidateReaderSettingsCache();
      }
    })
  );

  // ─── 阅读会话（阅读统计分析） ───
  ipcMain.handle(
    IPC_CHANNELS.READING_SESSION_CREATE,
    wrapHandler((_e, input: CreateReadingSessionInput) => {
      // P2 修复：数据库写入操作输入校验
      if (!input || typeof input !== 'object') throw new Error('无效的阅读会话输入');
      if (!Number.isInteger(input.book_id) || input.book_id <= 0) throw new Error('无效的 book_id');
      if (typeof input.start_time !== 'number' || !Number.isFinite(input.start_time))
        throw new Error('无效的 start_time');
      if (typeof input.end_time !== 'number' || !Number.isFinite(input.end_time)) throw new Error('无效的 end_time');
      if (typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration < 0) {
        throw new Error('无效的 duration');
      }
      return ReadingSessionRepo.createSession(input);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.READING_SESSION_STATS,
    wrapHandler((_e, bookId: number) => {
      assertPositiveInt(bookId, 'bookId');
      return ReadingSessionRepo.getStatsByBookId(bookId);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.READING_SESSION_DAILY,
    wrapHandler((_e, bookId: number, days: number) => {
      assertPositiveInt(bookId, 'bookId');
      assertPositiveInt(days, 'days');
      return ReadingSessionRepo.getDailyStatsByBookId(bookId, days);
    })
  );

  // ─── 阅读统计仪表盘（全局统计，跨书籍聚合） ───
  ipcMain.handle(
    IPC_CHANNELS.READING_STATS_GLOBAL,
    wrapHandler(() => ReadingSessionRepo.getGlobalStats())
  );

  ipcMain.handle(
    IPC_CHANNELS.READING_STATS_TODAY,
    wrapHandler(() => ReadingSessionRepo.getTodayStats())
  );

  ipcMain.handle(
    IPC_CHANNELS.READING_STATS_RANGE,
    wrapHandler((_e, days: number) => {
      assertPositiveInt(days, 'days');
      return ReadingSessionRepo.getRangeStats(days);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.READING_STATS_DAILY,
    wrapHandler((_e, days: number) => {
      assertPositiveInt(days, 'days');
      return ReadingSessionRepo.getDailyStatsAllBooks(days);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.READING_STATS_STREAK,
    wrapHandler(() => ReadingSessionRepo.getStreakDays())
  );

  ipcMain.handle(
    IPC_CHANNELS.READING_STATS_TOP_BOOKS,
    wrapHandler((_e, limit: number) => {
      assertPositiveInt(limit, 'limit');
      return ReadingSessionRepo.getTopBooks(limit);
    })
  );

  // ─── 高亮/划线 ───
  ipcMain.handle(
    IPC_CHANNELS.HIGHLIGHT_ADD,
    wrapHandler((_e, input: CreateHighlightInput) => {
      // P2 修复：数据库写入操作输入校验
      if (!input || typeof input !== 'object') throw new Error('无效的高亮输入');
      if (!Number.isInteger(input.book_id) || input.book_id <= 0) throw new Error('无效的 book_id');
      if (!Number.isInteger(input.chapter_index) || input.chapter_index < 0) throw new Error('无效的 chapter_index');
      if (!Number.isInteger(input.start_offset) || input.start_offset < 0) throw new Error('无效的 start_offset');
      if (!Number.isInteger(input.end_offset) || input.end_offset < 0) throw new Error('无效的 end_offset');
      return HighlightRepo.createHighlight(input);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.HIGHLIGHT_LIST,
    wrapHandler((_e, bookId: number) => {
      assertPositiveInt(bookId, 'bookId');
      return HighlightRepo.listHighlights(bookId);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.HIGHLIGHT_LIST_BY_CHAPTER,
    wrapHandler((_e, bookId: number, chapterIndex: number) => {
      assertPositiveInt(bookId, 'bookId');
      if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw new Error('无效的 chapterIndex');
      return HighlightRepo.listHighlightsByChapter(bookId, chapterIndex);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.HIGHLIGHT_UPDATE,
    wrapHandler((_e, id: number, input: UpdateHighlightInput) => {
      assertPositiveInt(id, 'id');
      return HighlightRepo.updateHighlight(id, input);
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.HIGHLIGHT_DELETE,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      return HighlightRepo.deleteHighlight(id);
    })
  );
}
