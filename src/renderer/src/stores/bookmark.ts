import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Bookmark, AddBookmarkInput, UpdateBookmarkInput } from '@renderer/types';
import { useBookDetailStore } from './book-detail';

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ 涔︾绗旇 Store 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * 涔︾绗旇鐘舵€佺鐞嗭紙Pinia Store锛?
 *
 * 缁存姢褰撳墠涔︾睄鐨勪功绛?绗旇鍒楄〃锛岄€氳繃 window.dbApi.bookmark 涓庝富杩涚▼浜や簰銆?
 * 鍖哄垎涔︾锛坣ote 涓虹┖锛変笌绗旇锛坣ote 鏈夊€硷級銆?
 */
export const useBookmarkStore = defineStore('bookmark', () => {
  // 鈹€鈹€鈹€ State 鈹€鈹€鈹€
  const bookmarks = ref<Bookmark[]>([]);
  const loading = ref<boolean>(false);
  const currentBookId = ref<number | null>(null);

  // 鈹€鈹€鈹€ Getters 鈹€鈹€鈹€
  const bookmarkOnly = computed<Bookmark[]>(() => bookmarks.value.filter((b) => !b.note || b.note.trim().length === 0));

  const noteOnly = computed<Bookmark[]>(() => bookmarks.value.filter((b) => b.note && b.note.trim().length > 0));

  const total = computed<number>(() => bookmarks.value.length);

  // 鈹€鈹€鈹€ Actions 鈹€鈹€鈹€

  async function loadBookmarks(bookId: number): Promise<void> {
    loading.value = true;
    currentBookId.value = bookId;
    try {
      bookmarks.value = (await window.dbApi.bookmark.list(bookId)) as Bookmark[];
    } catch (err) {
      console.error('[bookmark] 鍔犺浇涔︾澶辫触:', err);
      bookmarks.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function addBookmark(input: AddBookmarkInput): Promise<Bookmark | null> {
    try {
      const created = await window.dbApi.bookmark.add(input);
      if (currentBookId.value !== null) {
        await loadBookmarks(currentBookId.value);
      }
      // P1-9: 鍚屾 book-detail store 鐨?bookmarks锛堣嫢璇︽儏椤靛凡鍔犺浇鍚屼竴鏈功锛?
      try {
        const detailStore = useBookDetailStore();
        if (detailStore.book?.id === currentBookId.value) {
          detailStore.bookmarks = [...bookmarks.value];
        }
      } catch {
        /* Pinia 鏈垵濮嬪寲鏃跺拷鐣?*/
      }
      return created as Bookmark;
    } catch (err) {
      console.error('[bookmark] 娣诲姞涔︾澶辫触:', err);
      return null;
    }
  }

  async function updateBookmark(id: number, input: UpdateBookmarkInput): Promise<boolean> {
    try {
      await window.dbApi.bookmark.update(id, input);
      if (currentBookId.value !== null) {
        await loadBookmarks(currentBookId.value);
      }
      // P1-9: 鍚屾 book-detail store 鐨?bookmarks
      try {
        const detailStore = useBookDetailStore();
        if (detailStore.book?.id === currentBookId.value) {
          detailStore.bookmarks = [...bookmarks.value];
        }
      } catch {
        /* Pinia 鏈垵濮嬪寲鏃跺拷鐣?*/
      }
      return true;
    } catch (err) {
      console.error('[bookmark] 鏇存柊涔︾澶辫触:', err);
      return false;
    }
  }

  async function removeBookmark(id: number): Promise<boolean> {
    try {
      await window.dbApi.bookmark.remove(id);
      // 涓?addBookmark/updateBookmark 涓€鑷达細浠?DB 閲嶆柊鍔犺浇浠ョ‘淇濇暟鎹悓姝?
      if (currentBookId.value !== null) {
        await loadBookmarks(currentBookId.value);
      } else {
        bookmarks.value = bookmarks.value.filter((b) => b.id !== id);
      }
      // P1-9: 鍚屾 book-detail store 鐨?bookmarks
      try {
        const detailStore = useBookDetailStore();
        if (detailStore.book?.id === currentBookId.value) {
          detailStore.bookmarks = [...bookmarks.value];
        }
      } catch {
        /* Pinia 鏈垵濮嬪寲鏃跺拷鐣?*/
      }
      return true;
    } catch (err) {
      console.error('[bookmark] 鍒犻櫎涔︾澶辫触:', err);
      return false;
    }
  }

  function getBookmarksByChapter(chapterIndex: number): Bookmark[] {
    return bookmarks.value.filter((b) => b.chapter_index === chapterIndex);
  }

  function reset(): void {
    bookmarks.value = [];
    loading.value = false;
    currentBookId.value = null;
  }

  return {
    bookmarks,
    loading,
    currentBookId,
    bookmarkOnly,
    noteOnly,
    total,
    loadBookmarks,
    addBookmark,
    updateBookmark,
    removeBookmark,
    getBookmarksByChapter,
    reset
  };
});
