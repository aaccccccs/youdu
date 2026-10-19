<!--
  章节目录抽屉

  功能：
  - Naive UI NDrawer 抽屉，从左侧滑出，宽度 380px
  - 章节列表，当前章节高亮（左侧 3px 紫色竖条 + 紫色文字）
  - 卷层级支持：卷标题可折叠/展开，章节在卷下方缩进显示
  - 无卷的章节直接显示，不缩进
  - 卷标题显示章节数量 + 总字数估算（如"第一卷 残酷的家法 (14章 · 3.2万字)"）
  - 正序/倒序排列切换
  - 全部展开/全部折叠按钮
  - 章节项高度 36px，单行显示（标题 + 字数右对齐）
  - 章节字数估算显示（file_length / 2.5）
  - 已读/未读标记（已读章节颜色更淡）
  - 章节序号灰色，标题白色，单行省略
  - 点击章节跳转
  - 顶部搜索框 + 章节总数
  - 底部显示当前阅读进度百分比 + 已读章数
-->
<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { NDrawer, NInput, NIcon, NEmpty, NVirtualList, NButton } from 'naive-ui';
import { Search, ChevronRight, ChevronDown, ArrowUp, ArrowDown, ChevronsUpDown, ChevronsDownUp } from '@lucide/vue';
import { useReaderStore } from '@renderer/stores';
import type { ChapterIndex } from '@renderer/types';

const { t, locale } = useI18n();
const store = useReaderStore();

/** 漫画模式：从 store 获取，用于适配漫画章节命名风格（"第X话"、"Vol.X"） */
const isComicMode = computed<boolean>(() => store.isComic);

/**
 * 章节项高度（px），与 .chapterItem 的 height 保持一致，用于 NVirtualList itemSize。
 * 漫画模式下更紧凑（漫画章节通常较多，如 100+ 话）。
 */
const CHAPTER_ITEM_SIZE = computed<number>(() => (isComicMode.value ? 32 : 36));

/** NVirtualList 实例引用，用于调用 scrollTo 方法 */
const virtualListRef = ref<InstanceType<typeof NVirtualList> | null>(null);

/** 搜索关键词 */
const keyword = ref<string>('');

/** 折叠的卷标题集合 */
const collapsedVolumes = ref<Set<string>>(new Set());

/** 是否倒序排列（最新章节在前） */
const isReversed = ref<boolean>(false);

/** 显示项类型：卷标题 或 章节项 */
interface DisplayItem {
  type: 'volume' | 'chapter';
  key: string;
  volumeTitle?: string;
  volumeCount?: number;
  volumeWordCount?: number;
  chapter?: ChapterIndex;
}

/** 估算字数：file_length / 2.5（GBK和UTF-8的折中值） */
function estimateWordCount(fileLength: number | null | undefined): number {
  if (!fileLength || fileLength <= 0) return 0;
  return Math.round(fileLength / 2.5);
}

/** 格式化字数显示：中文 < 1万 → "X.X千字"，>= 1万 → "X.X万字"；英文统一为 "XK words" */
function formatWordCount(count: number): string {
  if (count <= 0) return '';
  if (locale.value === 'zh-CN') {
    if (count < 10000) {
      return t('readerBars.chapter.wordCount.thousand', { n: (count / 1000).toFixed(1) });
    }
    return t('readerBars.chapter.wordCount.tenThousand', { n: (count / 10000).toFixed(1) });
  }
  if (count < 10000) {
    return t('readerBars.chapter.wordCount.thousand', { n: (count / 1000).toFixed(1) });
  }
  return t('readerBars.chapter.wordCount.tenThousand', { n: (count / 1000).toFixed(0) });
}

/** 章节显示名：无标题时按漫画/小说模式生成"第 X 话/章" */
function chapterDisplayName(ch: ChapterIndex): string {
  const n = ch.chapter_index + 1;
  return (
    ch.title ||
    (isComicMode.value ? t('readerBars.chapter.comicEpisode', { n }) : t('readerBars.chapter.chapterN', { n }))
  );
}

/** 章节项无障碍标签 */
function chapterAriaLabel(ch: ChapterIndex): string {
  return t('readerBars.chapter.chapterAria', {
    index: ch.chapter_index + 1,
    title: chapterDisplayName(ch)
  });
}

/** 判断章节是否已读（章节索引 < 当前章节索引） */
function isChapterRead(chapterIndex: number): boolean {
  return chapterIndex < store.currentChapterIndex;
}

/** 过滤后的章节列表 */
const filteredChapters = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  let list = store.chapters;
  if (kw) {
    list = list.filter((ch) => {
      const title = (ch.title ?? '').toLowerCase();
      return title.includes(kw);
    });
  }
  if (isReversed.value) {
    list = [...list].reverse();
  }
  return list;
});

/** 是否有任何章节带有卷信息 */
const hasVolumes = computed(() => {
  return filteredChapters.value.some((ch) => ch.volume != null);
});

/** 卷 → 章节数量映射 */
const volumeCounts = computed<Map<string, number>>(() => {
  const map = new Map<string, number>();
  for (const ch of filteredChapters.value) {
    if (ch.volume) {
      map.set(ch.volume, (map.get(ch.volume) ?? 0) + 1);
    }
  }
  return map;
});

/** 卷 → 总字数估算映射 */
const volumeWordCounts = computed<Map<string, number>>(() => {
  const map = new Map<string, number>();
  for (const ch of filteredChapters.value) {
    if (ch.volume) {
      const current = map.get(ch.volume) ?? 0;
      map.set(ch.volume, current + estimateWordCount(ch.file_length));
    }
  }
  return map;
});

/** 构建显示项列表：卷标题 + 章节项交替排列 */
const displayItems = computed<DisplayItem[]>(() => {
  if (!hasVolumes.value) {
    return filteredChapters.value.map((ch) => ({
      type: 'chapter' as const,
      key: `ch-${ch.chapter_index}`,
      chapter: ch
    }));
  }

  const items: DisplayItem[] = [];
  const seenVolumes = new Set<string>();

  for (const ch of filteredChapters.value) {
    const vol = ch.volume;
    if (vol && !seenVolumes.has(vol)) {
      seenVolumes.add(vol);
      items.push({
        type: 'volume',
        key: `vol-${vol}`,
        volumeTitle: vol,
        volumeCount: volumeCounts.value.get(vol) ?? 0,
        volumeWordCount: volumeWordCounts.value.get(vol) ?? 0
      });
    }
    // 折叠的卷下的章节不显示
    if (vol && collapsedVolumes.value.has(vol)) {
      continue;
    }
    items.push({
      type: 'chapter',
      key: `ch-${ch.chapter_index}`,
      chapter: ch
    });
  }

  return items;
});

/** 当前章节在显示项列表中的索引（用于 NVirtualList.scrollTo） */
const currentChapterDisplayIndex = computed<number>(() => {
  return displayItems.value.findIndex(
    (item) => item.type === 'chapter' && item.chapter?.chapter_index === store.currentChapterIndex
  );
});

/** 点击章节项 */
async function handleChapterClick(index: number): Promise<void> {
  await store.jumpToChapter(index);
}

/** 键盘激活章节项（Enter / Space） */
async function handleChapterKeyActivate(index: number): Promise<void> {
  await store.jumpToChapter(index);
}

/** 点击卷标题：切换折叠/展开 */
function toggleVolume(volumeTitle: string): void {
  const newSet = new Set(collapsedVolumes.value);
  if (newSet.has(volumeTitle)) {
    newSet.delete(volumeTitle);
  } else {
    newSet.add(volumeTitle);
  }
  collapsedVolumes.value = newSet;
}

/** 全部展开 */
function expandAllVolumes(): void {
  collapsedVolumes.value = new Set();
}

/** 全部折叠 */
function collapseAllVolumes(): void {
  const allVols = new Set<string>();
  for (const ch of filteredChapters.value) {
    if (ch.volume) {
      allVols.add(ch.volume);
    }
  }
  // 但要确保当前章节所在的卷不被折叠
  const currentCh = store.chapters.find((ch) => ch.chapter_index === store.currentChapterIndex);
  if (currentCh?.volume) {
    allVols.delete(currentCh.volume);
  }
  collapsedVolumes.value = allVols;
}

/** 切换正序/倒序 */
function toggleReverse(): void {
  isReversed.value = !isReversed.value;
}

/** 自动展开当前章节所在的卷（如果被折叠了） */
watch(
  () => store.currentChapterIndex,
  (idx) => {
    if (idx >= 0 && hasVolumes.value) {
      const currentCh = store.chapters.find((ch) => ch.chapter_index === idx);
      if (currentCh?.volume && collapsedVolumes.value.has(currentCh.volume)) {
        const newSet = new Set(collapsedVolumes.value);
        newSet.delete(currentCh.volume);
        collapsedVolumes.value = newSet;
      }
    }
  }
);

/** 自动滚动到当前章节（适配 NVirtualList 的 scrollTo 方法） */
watch(
  () => store.showChapterBar,
  async (visible) => {
    if (visible) {
      await nextTick();
      const idx = currentChapterDisplayIndex.value;
      if (idx >= 0) {
        virtualListRef.value?.scrollTo({ index: idx });
      }
    }
  }
);
</script>

<template>
  <n-drawer
    :show="store.showChapterBar"
    :width="320"
    placement="left"
    display-directive="show"
    @update:show="(v: boolean) => (store.showChapterBar = v)"
  >
    <div class="chapterBar">
      <!-- 头部：标题 + 章节总数 + 工具栏 -->
      <div class="barHeader">
        <div class="headerRow">
          <span class="barTitle">{{ t('readerBars.chapter.title') }}</span>
          <span class="barCount">{{ t('readerBars.chapter.totalChapters', { n: store.chapters.length }) }}</span>
        </div>
        <!-- 搜索框 -->
        <div class="searchWrap">
          <n-input
            v-model:value="keyword"
            :placeholder="t('readerBars.chapter.searchPlaceholder')"
            clearable
            size="small"
          >
            <template #prefix>
              <n-icon :component="Search" />
            </template>
          </n-input>
        </div>
        <!-- 工具栏：正序/倒序 + 展开/折叠 -->
        <div class="toolbar">
          <n-button size="tiny" quaternary :type="isReversed ? 'primary' : 'default'" @click="toggleReverse">
            <template #icon>
              <n-icon :component="isReversed ? ArrowUp : ArrowDown" size="14" />
            </template>
            {{ isReversed ? t('readerBars.chapter.reverseOrder') : t('readerBars.chapter.normalOrder') }}
          </n-button>
          <template v-if="hasVolumes">
            <n-button size="tiny" quaternary @click="expandAllVolumes">
              <template #icon>
                <n-icon :component="ChevronsUpDown" size="14" />
              </template>
              {{ t('readerBars.chapter.expandAll') }}
            </n-button>
            <n-button size="tiny" quaternary @click="collapseAllVolumes">
              <template #icon>
                <n-icon :component="ChevronsDownUp" size="14" />
              </template>
              {{ t('readerBars.chapter.collapseAll') }}
            </n-button>
          </template>
        </div>
      </div>

      <!-- 章节列表（虚拟滚动） -->
      <n-empty v-if="displayItems.length === 0" :description="t('readerBars.chapter.noMatch')" class="emptyState" />
      <n-virtual-list
        v-else
        ref="virtualListRef"
        :items="displayItems"
        :item-size="CHAPTER_ITEM_SIZE"
        class="chapterList"
      >
        <template #default="{ item }">
          <!-- 卷标题项 -->
          <div
            v-if="item.type === 'volume'"
            class="volumeItem"
            :style="{ height: CHAPTER_ITEM_SIZE + 'px' }"
            role="button"
            tabindex="0"
            :aria-label="t('readerBars.chapter.volumeAria', { title: item.volumeTitle })"
            @click="toggleVolume(item.volumeTitle!)"
            @keydown.enter="toggleVolume(item.volumeTitle!)"
          >
            <n-icon
              :component="collapsedVolumes.has(item.volumeTitle!) ? ChevronRight : ChevronDown"
              size="14"
              class="volumeArrow"
            />
            <span class="volumeTitleText">{{ item.volumeTitle }}</span>
            <span class="volumeCount">
              {{ t('readerBars.chapter.chapterCount', { n: item.volumeCount }) }}
              <template v-if="!isComicMode && item.volumeWordCount && item.volumeWordCount > 0">
                · {{ formatWordCount(item.volumeWordCount) }}
              </template>
            </span>
          </div>

          <!-- 章节项 -->
          <div
            v-else
            :style="{ height: CHAPTER_ITEM_SIZE + 'px' }"
            class="chapterItem"
            :class="{
              active: item.chapter!.chapter_index === store.currentChapterIndex,
              read: isChapterRead(item.chapter!.chapter_index),
              indented: item.chapter!.volume != null
            }"
            role="button"
            tabindex="0"
            :aria-label="chapterAriaLabel(item.chapter!)"
            @click="handleChapterClick(item.chapter!.chapter_index)"
            @keydown.enter="handleChapterKeyActivate(item.chapter!.chapter_index)"
            @keydown.space.prevent="handleChapterKeyActivate(item.chapter!.chapter_index)"
          >
            <!-- 单行：标题 + 字数右对齐（漫画模式下隐藏字数） -->
            <div class="chapterMainRow">
              <span class="chapterTitleText">{{ chapterDisplayName(item.chapter!) }}</span>
              <span v-if="!isComicMode && estimateWordCount(item.chapter!.file_length) > 0" class="chapterWordCount">
                {{ formatWordCount(estimateWordCount(item.chapter!.file_length)) }}
              </span>
            </div>
          </div>
        </template>
      </n-virtual-list>

      <!-- 底部状态栏：阅读进度 -->
      <div class="barFooter">
        <span class="footerProgress">
          {{
            t('readerBars.chapter.footerProgress', {
              current: store.currentChapterIndex + 1,
              total: store.chapters.length
            })
          }}
        </span>
        <span class="footerPercent">
          {{
            store.chapters.length > 0 ? Math.round(((store.currentChapterIndex + 1) / store.chapters.length) * 100) : 0
          }}%
        </span>
      </div>
    </div>
  </n-drawer>
</template>

<style scoped>
.chapterBar {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ==================== 头部 ==================== */
.barHeader {
  flex-shrink: 0;
  padding: var(--spacing-md-lg) var(--spacing-md-lg) var(--spacing-md);
  border-bottom: 1px solid var(--border-color);
}

.headerRow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--spacing-md);
}

.barTitle {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text-primary);
}

.barCount {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

/* ==================== 工具栏 ==================== */
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  margin-top: var(--spacing-sm);
}

/* ==================== 列表 ==================== */
.chapterList {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  width: 100%;
}

.emptyState {
  padding: var(--spacing-3xl) 0;
}

/* ==================== 卷标题项 ==================== */
.volumeItem {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  height: 36px;
  padding: 0 var(--spacing-md-lg);
  cursor: pointer;
  transition: background 0.15s ease;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-color);
  box-sizing: border-box;
}

.volumeItem:hover {
  background: var(--bg-hover);
}

.volumeArrow {
  flex-shrink: 0;
  color: var(--text-tertiary);
  transition: transform 0.2s ease;
}

.volumeTitleText {
  flex: 1;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.volumeCount {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  margin-left: var(--spacing-xs);
}

/* ==================== 章节项 ==================== */
.chapterItem {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 var(--spacing-md-lg);
  cursor: pointer;
  transition: background 0.15s ease;
  border-left: 3px solid transparent;
  box-sizing: border-box;
}

/* 有卷的章节缩进显示 */
.chapterItem.indented {
  padding-left: calc(var(--spacing-md-lg) + 16px);
}

.chapterItem:hover {
  background: var(--bg-hover);
}

/* 当前章节高亮：左侧 3px 紫色竖条 + 紫色背景 */
.chapterItem.active {
  background: var(--bg-active);
  border-left-color: var(--primary);
}

/* 已读章节：整体颜色更淡 */
.chapterItem.read {
  opacity: 0.55;
}

/* 已读章节悬停时恢复一定可见度 */
.chapterItem.read:hover {
  opacity: 0.8;
}

/* 单行：标题 + 字数右对齐 */
.chapterMainRow {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  overflow: hidden;
  width: 100%;
}

.chapterTitleText {
  flex: 1;
  font-size: var(--font-size-sm-plus);
  color: var(--text-secondary);
  line-height: 1.4;
  /* 单行省略 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 当前章节标题：紫色文字加粗 */
.chapterItem.active .chapterTitleText {
  color: var(--primary);
  font-weight: 500;
}

.chapterWordCount {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  line-height: 1.2;
}

/* ==================== 底部状态栏 ==================== */
.barFooter {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm) var(--spacing-md-lg);
  border-top: 1px solid var(--border-color);
  background: var(--bg-card);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.footerProgress {
  font-weight: 500;
}

.footerPercent {
  color: var(--primary);
  font-weight: 600;
}
</style>
