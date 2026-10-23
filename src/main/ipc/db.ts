/**
 * 数据库 CRUD IPC
 */
import { ipcMain } from 'electron';
import { join, resolve, sep } from 'path';
import { unlink, rm } from 'fs/promises';

import { getUserDataRoot } from '../utils';
import { readChapterImages,
  ensureChapterImages, getChapterThumbnails, invalidateReaderSettingsCache, searchInBook } from '../core/chapter-reader';
import * as GroupRepo from '../db/repositories';
import * as BookRepo from '../db/repositories';
import * as ChapterRepo from '../db/repositories';
import * as ProgressRepo from '../db/repositories';
import * as BookmarkRepo from '../db/repositories';
import * as SettingsRepo from '../db/repositories';
import * as ReadingSessionRepo from '../db/repositories';

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
  CreateReadingSessionInput,
  DeleteBookResult
} from '../db/repositories';

import {
  IPC_CHANNELS,
  wrapHandler,
  isPathSafe,
  isValidImportPath,
  assertPositiveInt,
  assertNonEmptyString,
  assertPositiveIntArray
} from './shared';

/* ==================== 删除分流（批次 v54 导入三模式） ==================== */

/** 路径是否位于 userData 目录内（含其本身）——link 删原文件的护栏判定 */
function isInsideUserData(p: string): boolean {
  const resolved = resolve(p);
  const userDataDir = resolve(getUserDataRoot());
  return resolved === userDataDir || resolved.startsWith(userDataDir + sep);
}

/**
 * 删书后的文件清理（copy/move/link 分流，BOOK_DELETE 与 BOOK_BATCH_DELETE 共用）
 *
 * 清理项：
 * - cover：始终清理（应用自管，isPathSafe 校验）
 * - rss-images/<id>：始终清理（现有行为保留）
 * - images/comic/<id> 解析缓存：始终清理（**P1 修复既有遗漏**：此前删书不清此
 *   目录，漫画解析图片残留磁盘持续占用空间）
 * - local_file_path 分流（批次 v54）：
 *   - copy/move：删应用自管的副本（现状行为，deleteSourceFile 参数对其无影响）
 *   - link：**默认完全不碰用户原文件**；仅当 deleteSourceFile===true 且路径合法
 *     （非空/无 null byte，isValidImportPath）且**不在 userData 内**才删除。
 *     注：isPathSafe 仅覆盖应用自管目录（books/covers/userData），对 link 书的
 *     用户外部原路径恒 false 不适用——userData 内护栏（设计文档第四节）用于防
 *     "用户把书存进数据目录"的怪异场景误删应用数据目录内容。
 *     删除失败（EBUSY/U 盘占用等）仅告警不阻断 DB 记录删除（现状行为保留）。
 *
 * @param result 被删书籍信息（含 import_mode）
 * @param deleteSourceFile 用户是否勾选"同时删除引用的原文件"（默认 false）
 */
function cleanupBookFiles(result: DeleteBookResult, deleteSourceFile: boolean): void {
  // 封面（userData/covers 内）
  if (result.cover && isPathSafe(result.cover)) {
    unlink(result.cover).catch((e) => console.warn('[db] 清理封面文件失败:', e));
  }
  // RSS 图片缓存（现有行为）
  rm(join(getUserDataRoot(), 'rss-images', String(result.id)), { recursive: true, force: true }).catch((e) =>
    console.warn('[cleanup] 操作失败:', e)
  );
  // 漫画/图片章节解析缓存（P1 修复既有遗漏：删书不清 images/comic/<id>）
  rm(join(getUserDataRoot(), 'images', 'comic', String(result.id)), { recursive: true, force: true }).catch((e) =>
    console.warn('[cleanup] 操作失败:', e)
  );

  if (!result.local_file_path) return;

  if (result.import_mode !== 'link') {
    // copy/move：删应用自管副本（现状行为；deleteSourceFile 对其无影响）
    if (isPathSafe(result.local_file_path)) {
      unlink(result.local_file_path).catch((e) => console.warn('[db] 清理书籍文件失败:', e));
    }
    return;
  }

  // link：默认不碰用户原文件；仅勾选 + 路径合法 + 不在 userData 内才删
  if (!deleteSourceFile) return;
  if (!isValidImportPath(result.local_file_path)) {
    console.warn('[db] 拒绝删除非法路径的引用原文件:', result.local_file_path);
    return;
  }
  if (isInsideUserData(result.local_file_path)) {
    console.warn('[db] 拒绝删除 userData 内的引用原文件（护栏）:', result.local_file_path);
    return;
  }
  unlink(result.local_file_path).catch((e) => console.warn('[db] 清理引用原文件失败:', e));
}

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
    wrapHandler((_e, orders: { id: number; sort_order: number }[]) => {
      if (!Array.isArray(orders) || orders.length === 0 || orders.length > 10_000) {
        throw new Error('无效的分组排序输入：orders 必须为非空数组');
      }
      for (const o of orders) {
        if (!o || !Number.isInteger(o.id) || o.id <= 0 || !Number.isInteger(o.sort_order)) {
          throw new Error('无效的分组排序项：id 须为正整数，sort_order 须为整数');
        }
      }
      return GroupRepo.reorderGroups(orders);
    })
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
    // 批次 v54：deleteSourceFile 可选参数（默认 false）——link 书删除时是否
    // 同时删除用户原文件（须用户在确认对话框主动勾选）；copy/move 书不受此参数影响
    wrapHandler((_e, id: number, deleteSourceFile?: boolean) => {
      assertPositiveInt(id, 'id');
      const result = BookRepo.deleteBook(id);
      if (result) {
        cleanupBookFiles(result, deleteSourceFile === true);
      }
      return result;
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.BOOK_BATCH_DELETE,
    // 批次 v54：批量删除同 deleteSourceFile 分流（勾选=删所有 link 书的原文件，
    // 逐本走 isInsideUserData 护栏校验）
    wrapHandler((_e, ids: number[], deleteSourceFile?: boolean) => {
      assertPositiveIntArray(ids, 'ids');
      const results = BookRepo.deleteBooks(ids);
      for (const r of results) {
        cleanupBookFiles(r, deleteSourceFile === true);
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

    IPC_CHANNELS.CHAPTER_GET_CONTENT,
    wrapHandler((_e, bookId: number, chapterIndex: number) => {
      assertPositiveInt(bookId, 'bookId');
      if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw new Error('无效的 chapterIndex');
      return ChapterRepo.getChapterContent(bookId, chapterIndex);
    })
  );

  ipcMain.handle(

    IPC_CHANNELS.CHAPTER_READ_IMAGES,
    wrapHandler((_e, bookId: number, chapterIndex: number, initialPages?: number, desiredWidth?: number) => {
      assertPositiveInt(bookId, 'bookId');
      if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw new Error('无效的 chapterIndex');
      // v53 分批渐进加载：首批渲染页数（可选；缺省全量渲染保持向后兼容）
      if (initialPages !== undefined && (!Number.isInteger(initialPages) || initialPages <= 0)) {
        throw new Error('无效的 initialPages');
      }
      // A3修复：目标渲染像素宽（可选，前端上报容器宽×DPR）。上限 4096 与渲染端
      // clamp 一致（防恶意超大值）；缺省不传走 scale 2 兜底，保持向后兼容
      if (desiredWidth !== undefined && (!Number.isInteger(desiredWidth) || desiredWidth < 1 || desiredWidth > 4096)) {
        throw new Error('无效的 desiredWidth');
      }
      return readChapterImages(bookId, chapterIndex, initialPages, desiredWidth);
    })
  );

  // v53 分批渐进加载：续载章节图片（幂等）——渲染请求槽位中仍缺失的页
  ipcMain.handle(
    IPC_CHANNELS.CHAPTER_ENSURE_IMAGES,
    wrapHandler((_e, bookId: number, chapterIndex: number, pages: number[], desiredWidth?: number) => {
      assertPositiveInt(bookId, 'bookId');
      if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw new Error('无效的 chapterIndex');
      if (!Array.isArray(pages) || pages.length === 0) throw new Error('无效的 pages：必须为非空数组');
      if (pages.length > 100) throw new Error('pages 过多（单次最多 100 个槽位）');
      for (const p of pages) {
        if (!Number.isInteger(p) || p < 1) throw new Error(`无效的槽位: ${p}`);
      }
      // A3修复：目标渲染像素宽（可选，校验口径与 readImages 一致）
      if (desiredWidth !== undefined && (!Number.isInteger(desiredWidth) || desiredWidth < 1 || desiredWidth > 4096)) {
        throw new Error('无效的 desiredWidth');
      }
      return ensureChapterImages(bookId, chapterIndex, pages, desiredWidth);
    })
  );

  // v56 P0 竞品对标：获取章节缩略图列表（缩略图面板数据源）——
  // 已渲染页懒生成 thumb_180 小图（幂等缓存），未渲染页 pending 占位（零渲染）
  // 参数：(bookId: number, chapterIndex: number)
  // 返回：ChapterImage[]（path=thumb 路径；pending=true 表示该页尚未渲染）
  ipcMain.handle(
    IPC_CHANNELS.CHAPTER_THUMBNAILS,
    wrapHandler((_e, bookId: number, chapterIndex: number) => {
      assertPositiveInt(bookId, 'bookId');
      if (!Number.isInteger(chapterIndex) || chapterIndex < 0) throw new Error('无效的 chapterIndex');
      return getChapterThumbnails(bookId, chapterIndex);
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

    IPC_CHANNELS.BOOKMARK_UPDATE,
    wrapHandler((_e, id: number, input: UpdateBookmarkInput) => {
      assertPositiveInt(id, 'id');
      if (!input || typeof input !== 'object') {
        throw new Error('无效的书签更新输入：必须为对象');
      }
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

}
