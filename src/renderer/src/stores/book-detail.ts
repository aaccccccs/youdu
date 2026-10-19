import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Book, ReadingStatus, ChapterIndex, Bookmark } from '@renderer/types';
import { i18n } from '@renderer/i18n';
import type {
  ReadingProgress,
  UpdateMetaInput,
  ReparseResult,
  RelatedBook,
  RelatedBookResult,
  BookReadingStats,
  DailyReadingStat
} from './types';
import { TREND_DAYS } from './types';
import { useReaderStore } from './reader';

// ═══════════════════════════════════════════════════════════════════════
// 4. Book Detail Store
// ═══════════════════════════════════════════════════════════════════════

/**
 * 书籍详情页状态管理（Pinia Store）
 *
 * 维护当前书籍、章节目录、书签列表、阅读进度等状态，
 * 通过 window.dbApi 与主进程交互（加载详情、更新元数据、删除书籍、重新分章）。
 */
// P1-9: 跨 Store 同步 — 延迟导入避免循环依赖，在 action 内部动态获取 store 实例

// ────────────────────────── Store 定义 ──────────────────────────

export const useBookDetailStore = defineStore('book-detail', () => {
  // ─── State ───
  const book = ref<Book | null>(null);
  const chapters = ref<ChapterIndex[]>([]);
  const bookmarks = ref<Bookmark[]>([]);
  const progress = ref<ReadingProgress | undefined>(undefined);
  const loading = ref<boolean>(false);
  const actionLoading = ref<boolean>(false);
  const errorMsg = ref<string>('');
  const relatedBooks = ref<RelatedBook[]>([]);
  const readingStats = ref<BookReadingStats | null>(null);
  const dailyStats = ref<DailyReadingStat[]>([]);

  // ─── Actions：数据加载 ───

  /** loadDetail 请求序号，防止快速切换书籍时旧请求覆盖新请求 */
  let loadDetailSeq = 0;

  async function loadDetail(bookId: number): Promise<void> {
    const seq = ++loadDetailSeq;
    loading.value = true;
    errorMsg.value = '';
    try {
      // 改用 Promise.allSettled：部分子请求失败时不影响其他子请求的数据更新（P1-7）
      const [bookInfoR, chapterListR, bookmarkListR, progressInfoR, relatedR, statsR, dailyR] =
        await Promise.allSettled([
          window.dbApi.book.get(bookId),
          window.dbApi.chapter.listIndexes(bookId),
          window.dbApi.bookmark.list(bookId),
          window.dbApi.progress.load(bookId),
          window.dbApi.book.getRelated(bookId, 8),
          window.dbApi.readingSession.stats(bookId),
          window.dbApi.readingSession.daily(bookId, TREND_DAYS)
        ]);

      if (seq !== loadDetailSeq) return;

      // bookInfo 是核心数据，失败则整体失败
      if (bookInfoR.status === 'rejected') {
        errorMsg.value = i18n.global.t('bookDetail.errors.loadFailed', {
          msg: (bookInfoR.reason as Error)?.message ?? String(bookInfoR.reason)
        });
        console.error('[book-detail] loadDetail 失败: book.get rejected', bookInfoR.reason);
        book.value = null;
        return;
      }

      const bookInfo = bookInfoR.value;
      if (!bookInfo) {
        errorMsg.value = i18n.global.t('bookDetail.errors.notFound');
        book.value = null;
        return;
      }

      // 核心数据有效，先赋值，再按各子请求的 fulfilled 状态补充非核心数据
      book.value = bookInfo as Book;
      if (chapterListR.status === 'fulfilled') chapters.value = chapterListR.value as ChapterIndex[];
      if (bookmarkListR.status === 'fulfilled') bookmarks.value = bookmarkListR.value as Bookmark[];
      if (progressInfoR.status === 'fulfilled') progress.value = progressInfoR.value as ReadingProgress | undefined;
      if (relatedR.status === 'fulfilled')
        relatedBooks.value = (relatedR.value as RelatedBookResult).books as RelatedBook[];
      if (statsR.status === 'fulfilled') readingStats.value = statsR.value as BookReadingStats;
      if (dailyR.status === 'fulfilled') dailyStats.value = dailyR.value as DailyReadingStat[];

      // 收集非核心子请求的失败原因，便于诊断但不阻塞展示
      const failures: string[] = [];
      const collectFailure = (r: PromiseSettledResult<unknown>, name: string): void => {
        if (r.status === 'rejected') {
          failures.push(`${name}: ${(r.reason as Error)?.message ?? String(r.reason)}`);
        }
      };
      collectFailure(chapterListR, i18n.global.t('bookDetail.sections.chapterList'));
      collectFailure(bookmarkListR, i18n.global.t('bookDetail.sections.bookmarks'));
      collectFailure(progressInfoR, i18n.global.t('bookDetail.sections.progress'));
      collectFailure(relatedR, i18n.global.t('bookDetail.sections.related'));
      collectFailure(statsR, i18n.global.t('bookDetail.sections.stats'));
      collectFailure(dailyR, i18n.global.t('bookDetail.sections.daily'));
      if (failures.length > 0) {
        errorMsg.value = i18n.global.t('bookDetail.errors.partialFailed', { items: failures.join('; ') });
        console.warn('[book-detail] loadDetail 部分失败:', failures);
      }
    } catch (err) {
      if (seq !== loadDetailSeq) return;
      errorMsg.value = i18n.global.t('bookDetail.errors.loadFailed', { msg: (err as Error).message });
      console.error('[book-detail] loadDetail 失败:', err);
      // catch 中清空 book.value，避免残留旧数据（P1-8）
      book.value = null;
    } finally {
      // P1-13修复：无条件重置 loading，避免快速切换书籍时旧请求 seq 失效导致 loading 卡死
      loading.value = false;
    }
  }

  // ─── Actions：元数据更新 ───

  async function updateBookMeta(id: number, input: UpdateMetaInput): Promise<void> {
    actionLoading.value = true;
    try {
      await window.dbApi.book.update(id, input);
      if (book.value && book.value.id === id) {
        if (input.title !== undefined) book.value.title = input.title;
        if (input.author !== undefined) book.value.author = input.author;
        if (input.intro !== undefined) book.value.intro = input.intro;
      }
      // P1-9: 同步 reader store 的 book 元数据
      try {
        const readerStore = useReaderStore();
        if (readerStore.book?.id === id) {
          if (input.title !== undefined) readerStore.book.title = input.title;
          if (input.author !== undefined) readerStore.book.author = input.author;
          if (input.intro !== undefined) readerStore.book.intro = input.intro;
        }
      } catch {
        /* Pinia 未初始化时忽略 */
      }
    } catch (err) {
      console.error('[book-detail] updateBookMeta 失败:', err);
      throw err;
    } finally {
      actionLoading.value = false;
    }
  }

  async function updateCustomMeta(id: number, meta: string): Promise<void> {
    actionLoading.value = true;
    try {
      await window.dbApi.book.update(id, { custom_meta: meta });
      if (book.value && book.value.id === id) {
        book.value.custom_meta = meta;
      }
    } catch (err) {
      console.error('[book-detail] updateCustomMeta 失败:', err);
      throw err;
    } finally {
      actionLoading.value = false;
    }
  }

  // ─── Actions：阅读状态与评分 ───

  async function updateReadingStatus(id: number, status: ReadingStatus): Promise<void> {
    actionLoading.value = true;
    try {
      await window.dbApi.book.update(id, { reading_status: status });
      if (book.value && book.value.id === id) {
        book.value.reading_status = status;
      }
      // P1-9: 同步 reader store 的 book.reading_status
      try {
        const readerStore = useReaderStore();
        if (readerStore.book?.id === id) {
          readerStore.book.reading_status = status;
        }
      } catch {
        /* Pinia 未初始化时忽略 */
      }
    } catch (err) {
      console.error('[book-detail] updateReadingStatus 失败:', err);
      throw err;
    } finally {
      actionLoading.value = false;
    }
  }

  async function updateRating(id: number, rating: number | null): Promise<void> {
    actionLoading.value = true;
    try {
      await window.dbApi.book.update(id, { rating });
      if (book.value && book.value.id === id) {
        book.value.rating = rating;
      }
      // P1-9: 同步 reader store 的 book.rating
      try {
        const readerStore = useReaderStore();
        if (readerStore.book?.id === id) {
          readerStore.book.rating = rating;
        }
      } catch {
        /* Pinia 未初始化时忽略 */
      }
    } catch (err) {
      console.error('[book-detail] updateRating 失败:', err);
      throw err;
    } finally {
      actionLoading.value = false;
    }
  }

  // ─── Actions：删除书籍 ───

  async function deleteBook(id: number): Promise<void> {
    actionLoading.value = true;
    try {
      await window.dbApi.book.delete(id);
      book.value = null;
      chapters.value = [];
      bookmarks.value = [];
      progress.value = undefined;
    } catch (err) {
      console.error('[book-detail] deleteBook 失败:', err);
      throw err;
    } finally {
      actionLoading.value = false;
    }
  }

  // ─── Actions：封面更新 ───

  async function setCover(
    bookId: number,
    imagePath: string
  ): Promise<{ success: boolean; coverPath?: string; error?: string }> {
    actionLoading.value = true;
    try {
      const result = await window.dbApi.book.setCover(bookId, imagePath);
      if (result.success && result.coverPath && book.value && book.value.id === bookId) {
        book.value.cover = result.coverPath;
      }
      return result;
    } catch (err) {
      console.error('[book-detail] setCover 失败:', err);
      return {
        success: false,
        error: (err as Error).message || String(err)
      };
    } finally {
      actionLoading.value = false;
    }
  }

  // ─── Actions：恢复默认封面 ───

  async function resetCover(bookId: number): Promise<{ success: boolean; error?: string }> {
    actionLoading.value = true;
    try {
      await window.dbApi.book.update(bookId, { cover: null });
      if (book.value && book.value.id === bookId) {
        book.value.cover = null;
      }
      // P1-9: 同步 reader store 的 book.cover
      try {
        const readerStore = useReaderStore();
        if (readerStore.book?.id === bookId) {
          readerStore.book.cover = null;
        }
      } catch {
        /* Pinia 未初始化时忽略 */
      }
      return { success: true };
    } catch (err) {
      console.error('[book-detail] resetCover 失败:', err);
      return {
        success: false,
        error: (err as Error).message || String(err)
      };
    } finally {
      actionLoading.value = false;
    }
  }

  // ─── Actions：重新分章 ───

  async function reparseChapters(bookId: number): Promise<ReparseResult> {
    actionLoading.value = true;
    try {
      const result = await window.dbApi.book.reparse(bookId);
      if (result.success) {
        progress.value = undefined;
        const chapterList = await window.dbApi.chapter.listIndexes(bookId);
        chapters.value = chapterList as ChapterIndex[];
        if (book.value && book.value.id === bookId) {
          book.value.total_chapters = result.chapterCount;
        }
      }
      return result;
    } catch (err) {
      console.error('[book-detail] reparseChapters 失败:', err);
      return {
        success: false,
        chapterCount: 0,
        error: (err as Error).message || String(err)
      };
    } finally {
      actionLoading.value = false;
    }
  }

  // ─── Actions：重置 ───

  function reset(): void {
    book.value = null;
    chapters.value = [];
    bookmarks.value = [];
    progress.value = undefined;
    relatedBooks.value = [];
    readingStats.value = null;
    dailyStats.value = [];
    loading.value = false;
    actionLoading.value = false;
    errorMsg.value = '';
  }

  return {
    // state
    book,
    chapters,
    bookmarks,
    progress,
    relatedBooks,
    readingStats,
    dailyStats,
    loading,
    actionLoading,
    errorMsg,
    // actions
    loadDetail,
    updateBookMeta,
    updateCustomMeta,
    updateReadingStatus,
    updateRating,
    setCover,
    resetCover,
    deleteBook,
    reparseChapters,
    reset
  };
});
