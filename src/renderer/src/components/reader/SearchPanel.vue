<!--
  搜索面板组件（P1，对标 Kindle/Apple Books 全文搜索）

  功能：
  - 输入关键词，逐章搜索书籍内容
  - 搜索结果显示：章节名 + 匹配片段（关键词前后各30字）+ 匹配位置
  - 关键词在结果中高亮显示
  - 结果列表用虚拟滚动优化（大量结果时）
  - 点击结果 emit 'jump-to' 事件通知父组件跳转

  实现说明：
  - 因 preload 限制，通过 window.dbApi.book.readChapter 逐章读取搜索
  - 大小写不敏感匹配（中文无大小写问题，英文统一转小写）
  - 每章最多 50 条命中，避免单章爆炸
  - 搜索时显示进度（已搜索 X/Y 章）
  - 支持 Enter 键触发搜索
-->
<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { NInput, NButton, NIcon, NVirtualList, NEmpty, NSpin } from 'naive-ui';
import { Search, X, ChevronRight } from '@lucide/vue';
import type { ChapterIndex } from '@renderer/types';

const { t } = useI18n();

/** 搜索结果条目 */
interface SearchHit {
  /** 章节序号 */
  chapterIndex: number;
  /** 章节标题 */
  chapterTitle: string;
  /** 匹配片段（关键词前后各30字） */
  snippet: string;
  /** 关键词在章节正文中的字符偏移 */
  position: number;
  /** 章节正文总长度（用于计算归一化跳转位置） */
  chapterLength: number;
}

const props = defineProps<{
  /** 书籍 ID */
  bookId: number;
  /** 章节索引列表 */
  chapters: ChapterIndex[];
}>();

const emit = defineEmits<{
  /** 跳转到指定章节和位置 */
  (e: 'jump-to', payload: { chapterIndex: number; position: number }): void;
}>();

/** 搜索关键词 */
const keyword = ref<string>('');
/** 搜索结果列表 */
const results = ref<SearchHit[]>([]);
/** 是否正在搜索 */
const searching = ref<boolean>(false);
/** 已搜索章节数 */
const searchedCount = ref<number>(0);
/** 总章节数（待搜索） */
const totalToSearch = ref<number>(0);

/** 搜索片段上下文半径 */
const SNIPPET_RADIUS = 30;
/** 每章最多命中数 */
const MAX_HITS_PER_CHAPTER = 50;
/** debounce 延迟 */
const DEBOUNCE_MS = 300;

/** 当前搜索的取消标志（每次新搜索创建新标志，旧搜索检测到 abort 后停止） */
let searchAbortFlag: { aborted: boolean } | null = null;
/** debounce 定时器 */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** 搜索进度文本 */
const progressText = computed<string>(() => {
  if (!searching.value) return '';
  return t('readerBars.search.progress', {
    done: searchedCount.value,
    total: totalToSearch.value,
    count: results.value.length
  });
});

/** 是否显示空状态（搜索完成且无结果） */
const showEmpty = computed<boolean>(() => {
  return !searching.value && keyword.value.trim() !== '' && results.value.length === 0;
});

/**
 * 高亮 snippet 中的关键词（转义 HTML 后用 <mark> 标记关键词）
 *
 * @param snippet 原始片段文本
 * @param kw 关键词
 * @returns 安全的 HTML 字符串（已转义非关键词部分）
 */
function highlightSnippet(snippet: string, kw: string): string {
  // 转义 HTML 特殊字符，防止 XSS
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const kwLower = kw.toLowerCase();
  const snippetLower = snippet.toLowerCase();
  let result = '';
  let lastIdx = 0;
  let fromIndex = 0;

  while (true) {
    const foundIdx = snippetLower.indexOf(kwLower, fromIndex);
    if (foundIdx === -1) {
      result += escapeHtml(snippet.slice(lastIdx));
      break;
    }
    // 添加关键词前的普通文本
    result += escapeHtml(snippet.slice(lastIdx, foundIdx));
    // 添加高亮的关键词
    result += '<mark>' + escapeHtml(snippet.slice(foundIdx, foundIdx + kw.length)) + '</mark>';
    lastIdx = foundIdx + kw.length;
    fromIndex = lastIdx;
  }
  return result;
}

/**
 * 执行搜索：逐章读取内容并匹配关键词
 *
 * @param kw 搜索关键词（已 trim 且非空）
 */
async function executeSearch(kw: string): Promise<void> {
  // 创建本次搜索的取消标志
  const myFlag = { aborted: false };
  searchAbortFlag = myFlag;

  searching.value = true;
  results.value = [];
  searchedCount.value = 0;

  // 过滤可搜索章节（跳过图片章节）
  const searchableChapters = props.chapters.filter((ch) => ch.content_type !== 'image');
  totalToSearch.value = searchableChapters.length;

  if (searchableChapters.length === 0) {
    searching.value = false;
    return;
  }

  const kwLower = kw.toLowerCase();
  const allHits: SearchHit[] = [];

  for (const ch of searchableChapters) {
    // 检查是否已被取消（新搜索开始）
    if (myFlag.aborted) return;

    let content: string;
    try {
      content = await window.dbApi.book.readChapter(props.bookId, ch.chapter_index);
    } catch (err) {
      console.warn('[SearchPanel] 读取章节失败:', ch.chapter_index, err);
      searchedCount.value++;
      continue;
    }

    if (myFlag.aborted) return;

    searchedCount.value++;

    if (!content) continue;

    const contentLower = content.toLowerCase();
    let fromIndex = 0;
    let hitCountInChapter = 0;

    while (hitCountInChapter < MAX_HITS_PER_CHAPTER) {
      const foundIdx = contentLower.indexOf(kwLower, fromIndex);
      if (foundIdx === -1) break;

      const snippetStart = Math.max(0, foundIdx - SNIPPET_RADIUS);
      const snippetEnd = Math.min(content.length, foundIdx + kw.length + SNIPPET_RADIUS);
      let snippet = content.slice(snippetStart, snippetEnd);
      if (snippetStart > 0) snippet = '…' + snippet;
      if (snippetEnd < content.length) snippet = snippet + '…';

      allHits.push({
        chapterIndex: ch.chapter_index,
        chapterTitle: ch.title ?? t('readerBars.chapter.chapterN', { n: ch.chapter_index + 1 }),
        snippet,
        position: foundIdx,
        chapterLength: content.length
      });

      fromIndex = foundIdx + kw.length;
      hitCountInChapter++;
    }

    // 增量更新结果（让用户看到搜索进度）
    results.value = [...allHits];
  }

  searching.value = false;
}

/** 触发搜索（带 debounce） */
function triggerSearch(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const kw = keyword.value.trim();
    if (!kw) {
      results.value = [];
      return;
    }
    void executeSearch(kw).catch((e) => console.error('executeSearch 失败:', e));
  }, DEBOUNCE_MS);
}

/** 立即搜索（Enter 键触发，跳过 debounce） */
function searchImmediately(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const kw = keyword.value.trim();
  if (!kw) {
    results.value = [];
    return;
  }
  void executeSearch(kw).catch((e) => console.error('executeSearch 失败:', e));
}

/** 清空搜索 */
function clearSearch(): void {
  keyword.value = '';
  results.value = [];
  searching.value = false;
  if (searchAbortFlag) searchAbortFlag.aborted = true;
}

/** 点击搜索结果，跳转到对应章节和位置 */
function handleResultClick(hit: SearchHit): void {
  // 将字符偏移转换为归一化位置（0~1）
  const normalizedPosition = hit.chapterLength > 0 ? Math.min(1, hit.position / hit.chapterLength) : 0;
  emit('jump-to', {
    chapterIndex: hit.chapterIndex,
    position: normalizedPosition
  });
}

/** 监听关键词变化，自动触发搜索 */
watch(keyword, () => {
  triggerSearch();
});

/** 组件卸载时取消搜索 */
onBeforeUnmount(() => {
  if (searchAbortFlag) searchAbortFlag.aborted = true;
  if (debounceTimer) clearTimeout(debounceTimer);
});

/** 虚拟列表项高度 */
const ITEM_HEIGHT = 88;
</script>

<template>
  <div class="search-panel">
    <!-- 搜索框 -->
    <div class="search-header">
      <n-input
        v-model:value="keyword"
        :placeholder="t('readerBars.search.placeholder')"
        clearable
        :autofocus="true"
        @keyup.enter="searchImmediately"
        @clear="clearSearch"
      >
        <template #prefix>
          <n-icon :component="Search" :size="16" />
        </template>
      </n-input>
      <n-button
        v-if="keyword"
        quaternary
        circle
        size="small"
        :title="t('readerBars.search.clear')"
        @click="clearSearch"
      >
        <template #icon>
          <n-icon :component="X" :size="16" />
        </template>
      </n-button>
    </div>

    <!-- 搜索进度 -->
    <div v-if="searching" class="search-progress">
      <n-spin size="small" />
      <span class="search-progress-text">{{ progressText }}</span>
    </div>

    <!-- 搜索结果统计 -->
    <div v-if="!searching && keyword.trim() && results.length > 0" class="search-summary">
      {{ t('readerBars.search.summary', { count: results.length }) }}
    </div>

    <!-- 搜索结果列表（虚拟滚动） -->
    <div v-if="results.length > 0" class="search-results">
      <n-virtual-list :items="results" :item-size="ITEM_HEIGHT" style="height: 100%">
        <template #default="{ item }">
          <div class="search-result-item" @click="handleResultClick(item as SearchHit)">
            <div class="result-header">
              <span class="result-chapter-title">{{ (item as SearchHit).chapterTitle }}</span>
              <n-icon :component="ChevronRight" :size="14" class="result-arrow" />
            </div>
            <div class="result-snippet" v-html="highlightSnippet((item as SearchHit).snippet, keyword.trim())"></div>
          </div>
        </template>
      </n-virtual-list>
    </div>

    <!-- 空状态 -->
    <div v-if="showEmpty" class="search-empty">
      <n-empty :description="t('readerBars.search.noResult')" />
    </div>

    <!-- 初始状态（未输入关键词） -->
    <div v-if="!keyword.trim() && !searching" class="search-hint">
      <n-icon :component="Search" :size="32" class="search-hint-icon" />
      <span class="search-hint-text">{{ t('readerBars.search.hint') }}</span>
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  padding: var(--spacing-sm-md);
  box-sizing: border-box;
  gap: var(--spacing-sm);
}

.search-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex-shrink: 0;
}

.search-progress {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-sm);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  flex-shrink: 0;
}

.search-progress-text {
  white-space: nowrap;
}

.search-summary {
  padding: var(--spacing-xs) var(--spacing-sm);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  flex-shrink: 0;
}

.search-results {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.search-result-item {
  padding: var(--spacing-sm) var(--spacing-sm-md);
  cursor: pointer;
  border-radius: var(--border-radius-sm);
  transition: background 0.15s ease;
  border-bottom: 1px solid var(--border-color-light);
  box-sizing: border-box;
}

.search-result-item:hover {
  background: var(--bg-hover);
}

.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-xs);
  margin-bottom: var(--spacing-xs);
}

.result-chapter-title {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--reader-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.result-arrow {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.result-snippet {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}

/* 关键词高亮样式 */
.result-snippet :deep(mark) {
  background: color-mix(in srgb, var(--reader-primary) 30%, transparent);
  color: var(--reader-text);
  padding: 0 2px;
  border-radius: var(--border-radius-xs);
  font-weight: 500;
}

.search-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.search-hint {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  color: var(--text-tertiary);
}

.search-hint-icon {
  opacity: 0.4;
}

.search-hint-text {
  font-size: var(--font-size-sm);
}
</style>
