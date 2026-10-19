import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Highlight, AddHighlightInput, UpdateHighlightInput } from '@renderer/types';

// ────────────────────────── 高亮/划线 Store ──────────────────────────

/**
 * 高亮/划线状态管理（Pinia Store）
 *
 * 维护当前书籍的高亮列表，通过 window.dbApi.highlight 与主进程交互。
 * 支持4种颜色：yellow / green / blue / pink。
 */
export const useHighlightStore = defineStore('highlight', () => {
  // ─── State ───
  const highlights = ref<Highlight[]>([]);
  const loading = ref<boolean>(false);
  const currentBookId = ref<number | null>(null);

  // ─── Getters ───
  const total = computed<number>(() => highlights.value.length);

  // ─── Actions ───

  async function loadHighlights(bookId: number): Promise<void> {
    loading.value = true;
    currentBookId.value = bookId;
    try {
      highlights.value = (await window.dbApi.highlight.list(bookId)) as Highlight[];
    } catch (err) {
      console.error('[highlight] 加载高亮失败:', err);
      highlights.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function addHighlight(input: AddHighlightInput): Promise<Highlight | null> {
    try {
      const created = await window.dbApi.highlight.add(input);
      if (currentBookId.value !== null) {
        await loadHighlights(currentBookId.value);
      }
      return created as Highlight;
    } catch (err) {
      console.error('[highlight] 添加高亮失败:', err);
      return null;
    }
  }

  async function updateHighlight(id: number, input: UpdateHighlightInput): Promise<boolean> {
    try {
      await window.dbApi.highlight.update(id, input);
      if (currentBookId.value !== null) {
        await loadHighlights(currentBookId.value);
      }
      return true;
    } catch (err) {
      console.error('[highlight] 更新高亮失败:', err);
      return false;
    }
  }

  async function removeHighlight(id: number): Promise<boolean> {
    try {
      await window.dbApi.highlight.remove(id);
      highlights.value = highlights.value.filter((h) => h.id !== id);
      return true;
    } catch (err) {
      console.error('[highlight] 删除高亮失败:', err);
      return false;
    }
  }

  function getHighlightsByChapter(chapterIndex: number): Highlight[] {
    return highlights.value.filter((h) => h.chapter_index === chapterIndex);
  }

  function reset(): void {
    highlights.value = [];
    loading.value = false;
    currentBookId.value = null;
  }

  return {
    highlights,
    loading,
    currentBookId,
    total,

    loadHighlights,
    addHighlight,
    updateHighlight,
    removeHighlight,
    getHighlightsByChapter,
    reset
  };
});
