<!--
  悬浮缩略图目录面板组件（对标 MangaDex / Kavita / Komga 缩略图导航）

  功能：
  - 从右侧滑入的面板，宽度 340px，占满全高
  - 顶部两个 Tab：
    · "页面" — 显示当前章节所有页面的缩略图网格（3 列）
    · "章节" — 显示章节列表（可点击跳转）
  - 缩略图网格：
    · 每个缩略图显示页面图片 + 页码标签
    · 当前页高亮（边框 + 背景）
    · 点击缩略图跳转到对应页面
    · IntersectionObserver 懒加载（rootMargin '100px' 预加载附近缩略图）
  - 章节列表 Tab：
    · 显示所有章节标题
    · 当前章节高亮
    · 点击跳转章节
  - 半透明深色背景 + backdrop-filter blur
  - 关闭按钮（右上角 X）
  - 面板打开/关闭有 slide 动画

  实现说明：
  - 纯 CSS + Vue 3 Composition API，不依赖 Naive UI（保持轻量）
  - 缩略图用 CSS object-fit: cover + 固定高度 140px
  - 未加载的缩略图显示灰色占位符 + 页码
  - 暗色主题：背景 rgba(20, 20, 20, 0.95)，文字 rgba(255,255,255,0.9)
  - 全高使用 100dvh（动态视口高度，避免移动端地址栏伸缩导致尺寸跳变）
-->
<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { coverPathToUrl } from '@renderer/utils';
import { useSettingsStore } from '@renderer/stores';

/* ==================== Props / Emits ==================== */

const settings = useSettingsStore();
const { t } = useI18n();

/* ==================== 主题配色（根据 readerTheme 动态计算） ==================== */

/** 面板背景色 */
const panelBg = computed<string>(() => {
  switch (settings.readerTheme) {
    case 'night':
      return 'rgba(20, 20, 20, 0.95)';
    case 'day':
      return 'rgba(248, 248, 248, 0.95)';
    case 'eye':
      return 'rgba(245, 236, 215, 0.95)';
    case 'parchment':
      return 'rgba(240, 230, 210, 0.95)';
    default:
      return 'rgba(20, 20, 20, 0.95)';
  }
});

/** 面板文字色 */
const panelText = computed<string>(() => {
  switch (settings.readerTheme) {
    case 'night':
      return 'rgba(255, 255, 255, 0.9)';
    case 'day':
      return 'rgba(0, 0, 0, 0.85)';
    case 'eye':
      return 'rgba(60, 50, 30, 0.9)';
    case 'parchment':
      return 'rgba(60, 45, 25, 0.9)';
    default:
      return 'rgba(255, 255, 255, 0.9)';
  }
});

/** 是否深色主题 */
const isDark = computed<boolean>(() => {
  const theme = settings.readerTheme;
  return theme === 'night' || theme === 'custom';
});

/** 次要文字色（标签、占位符等） */
const panelTextSecondary = computed<string>(() => {
  return isDark.value ? 'rgba(255, 255, 255, 0.55)' : 'rgba(0, 0, 0, 0.5)';
});

/** 边框色 */
const panelBorder = computed<string>(() => {
  return isDark.value ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
});

/** hover 背景色 */
const panelHoverBg = computed<string>(() => {
  return isDark.value ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)';
});

/** 激活背景色 */
const panelActiveBg = computed<string>(() => {
  return isDark.value ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)';
});

/** 缩略图项背景色 */
const thumbItemBg = computed<string>(() => {
  return isDark.value ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.04)';
});

/** 滚动条颜色 */
const scrollbarColor = computed<string>(() => {
  return isDark.value ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)';
});

/** CSS 变量对象（绑定到面板根元素） */
const themeVars = computed<Record<string, string>>(() => ({
  '--panel-bg': panelBg.value,
  '--panel-text': panelText.value,
  '--panel-text-secondary': panelTextSecondary.value,
  '--panel-border': panelBorder.value,
  '--panel-hover-bg': panelHoverBg.value,
  '--panel-active-bg': panelActiveBg.value,
  '--thumb-item-bg': thumbItemBg.value,
  '--scrollbar-color': scrollbarColor.value
}));

const props = defineProps<{
  /** 是否显示面板 */
  visible: boolean;
  /** 当前章节的图片路径列表（用于缩略图） */
  images: string[];
  /** 当前页码（1-based） */
  currentPage: number;
  /** 章节列表 */
  chapters: { title: string | null; index: number }[];
  /** 当前章节序号（0-based） */
  currentChapter: number;
}>();

const emit = defineEmits<{
  /** 关闭面板（v-model:visible） */
  (e: 'update:visible', visible: boolean): void;
  /** 跳转到指定页面（1-based） */
  (e: 'jump-to-page', page: number): void;
  /** 跳转到指定章节（0-based index） */
  (e: 'jump-to-chapter', index: number): void;
}>();

/* ==================== Tab 切换 ==================== */

type TabKey = 'pages' | 'chapters';
const activeTab = ref<TabKey>('chapters');

/* ==================== 缩略图懒加载 ==================== */

/**
 * 已加载的缩略图索引集合。
 * IntersectionObserver 触发后加入此集合，模板据此决定显示真实图片还是占位符。
 */
const loadedSet = ref<Set<number>>(new Set());

/** 缩略图网格容器引用（作为 IntersectionObserver 的 root） */
const gridRef = ref<HTMLElement | null>(null);
/** 所有缩略图项元素引用（template ref 数组） */
const thumbItemRefs = ref<HTMLElement[]>([]);

let thumbObserver: IntersectionObserver | null = null;

/**
 * 初始化缩略图懒加载观察器。
 *
 * 使用 rootMargin '100px' 扩展可视区，提前预加载即将进入视口的缩略图，
 * 避免快速滚动时出现大片空白。threshold 0 表示只要有 1px 进入即触发。
 */
function initThumbObserver(): void {
  disconnectThumbObserver();
  if (!gridRef.value) return;

  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const index = Number((entry.target as HTMLElement).dataset.index);
          if (!Number.isNaN(index) && !loadedSet.value.has(index)) {
            // 标记为已加载，触发模板渲染真实图片
            const next = new Set(loadedSet.value);
            next.add(index);
            loadedSet.value = next;
          }
        }
      }
    },
    {
      root: gridRef.value,
      rootMargin: '100px 0px 100px 0px',
      threshold: 0
    }
  );

  // 观察所有缩略图项
  nextTick(() => {
    for (const el of thumbItemRefs.value) {
      if (el && thumbObserver) {
        thumbObserver.observe(el);
      }
    }
  });
}

/** 断开缩略图观察器 */
function disconnectThumbObserver(): void {
  if (thumbObserver) {
    thumbObserver.disconnect();
    thumbObserver = null;
  }
}

/**
 * 设置缩略图项的 ref（供模板 :ref 回调使用）。
 * 使用函数式 ref 以便在 v-for 中正确收集元素。
 * 参数类型兼容 Vue 模板 ref 回调签名 (Element | ComponentPublicInstance | null)。
 */
function setThumbItemRef(el: unknown, index: number): void {
  if (el instanceof HTMLElement) {
    thumbItemRefs.value[index] = el;
  }
}

/* ==================== 章节列表滚动到当前章节 ==================== */

/** 章节列表容器引用 */
const chapterListRef = ref<HTMLElement | null>(null);
/** 当前章节项引用 */
const currentChapterItemRef = ref<HTMLElement | null>(null);

/**
 * 将当前章节项滚动到列表可视区中央。
 * 切节 Tab 激活或当前章节变化时调用。
 */
function scrollCurrentChapterIntoView(): void {
  nextTick(() => {
    if (!currentChapterItemRef.value || !chapterListRef.value) return;
    const item = currentChapterItemRef.value;
    const container = chapterListRef.value;
    const itemTop = item.offsetTop;
    const itemHeight = item.offsetHeight;
    const containerHeight = container.clientHeight;
    // 让当前章节居中显示
    container.scrollTo({
      top: itemTop - containerHeight / 2 + itemHeight / 2,
      behavior: 'smooth'
    });
  });
}

/* ==================== 当前页缩略图滚动到可视区 ==================== */

/**
 * 将当前页缩略图滚动到网格可视区中央。
 * 面板打开或当前页变化时调用。
 */
function scrollCurrentThumbIntoView(): void {
  nextTick(() => {
    if (!gridRef.value) return;
    const currentEl = gridRef.value.querySelector<HTMLElement>(`[data-index="${props.currentPage - 1}"]`);
    if (!currentEl) return;
    const container = gridRef.value;
    const itemTop = currentEl.offsetTop;
    const itemHeight = currentEl.offsetHeight;
    const containerHeight = container.clientHeight;
    container.scrollTo({
      top: itemTop - containerHeight / 2 + itemHeight / 2,
      behavior: 'smooth'
    });
  });
}

/* ==================== 事件处理 ==================== */

/** 关闭面板 */
function handleClose(): void {
  emit('update:visible', false);
}

/** 点击缩略图，跳转到对应页面（1-based） */
function handleThumbClick(page: number): void {
  emit('jump-to-page', page);
}

/** 点击章节项，跳转到对应章节（0-based index） */
function handleChapterClick(index: number): void {
  emit('jump-to-chapter', index);
}

/** 切换 Tab */
function switchTab(tab: TabKey): void {
  if (activeTab.value === tab) return;
  activeTab.value = tab;
}

/* ==================== 章节标题显示 ==================== */

/**
 * 获取章节显示标题：无标题时显示"第 N 章"占位。
 *
 * @param chapter 章节对象
 * @returns 用于显示的章节标题
 */
function getChapterTitle(chapter: { title: string | null; index: number }): string {
  if (chapter.title && chapter.title.trim()) return chapter.title;
  return t('comic.thumbnail.chapterFallback', { n: chapter.index + 1 });
}

/* ==================== 响应式监听 ==================== */

/**
 * 面板打开时：
 * 1. 重置懒加载状态（重新观察所有缩略图）
 * 2. 初始化 IntersectionObserver
 * 3. 滚动当前页/章节到可视区
 *
 * 面板关闭时断开观察器释放资源。
 */
watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      // 重置懒加载集合，重新观察
      loadedSet.value = new Set();
      thumbItemRefs.value = [];
      nextTick(() => {
        initThumbObserver();
        scrollCurrentThumbIntoView();
        if (activeTab.value === 'chapters') {
          scrollCurrentChapterIntoView();
        }
      });
    } else {
      disconnectThumbObserver();
    }
  }
);

/** 图片列表变化时（切换章节），重置懒加载并重新观察 */
watch(
  () => props.images,
  () => {
    if (!props.visible) return;
    loadedSet.value = new Set();
    thumbItemRefs.value = [];
    nextTick(() => {
      initThumbObserver();
      scrollCurrentThumbIntoView();
    });
  }
);

/** 当前页变化时，滚动到对应缩略图 */
watch(
  () => props.currentPage,
  () => {
    if (props.visible && activeTab.value === 'pages') {
      scrollCurrentThumbIntoView();
    }
  }
);

/** 当前章节变化时，滚动到对应章节项 */
watch(
  () => props.currentChapter,
  () => {
    if (props.visible && activeTab.value === 'chapters') {
      scrollCurrentChapterIntoView();
    }
  }
);

/** Tab 切换到章节时，滚动当前章节到可视区 */
watch(activeTab, (tab) => {
  if (tab === 'chapters' && props.visible) {
    scrollCurrentChapterIntoView();
  } else if (tab === 'pages' && props.visible) {
    scrollCurrentThumbIntoView();
  }
});

/** 组件卸载时清理观察器 */
onBeforeUnmount(() => {
  disconnectThumbObserver();
});

/* ==================== 缩略图 URL 预计算 ==================== */

/**
 * 缩略图 URL 列表（computed）。
 * 对每张图片路径调用 coverPathToUrl 转换为可用 URL。
 * null 表示路径无效。
 */
const thumbUrls = computed<(string | null)[]>(() => {
  return props.images.map((img) => coverPathToUrl(img));
});
</script>

<template>
  <!-- 面板根容器：visible 控制滑入/滑出 -->
  <div class="thumbnail-panel" :class="{ 'thumbnail-panel--open': visible }" :style="themeVars" :aria-hidden="!visible">
    <!-- 面板内容（仅在 visible 时渲染交互，但始终保留 DOM 以支持 slide 动画） -->
    <div class="thumbnail-panel__inner">
      <!-- 顶部标题栏 + 关闭按钮 -->
      <div class="thumbnail-panel__header">
        <div class="thumbnail-panel__tabs">
          <button
            class="thumbnail-panel__tab"
            :class="{ 'thumbnail-panel__tab--active': activeTab === 'chapters' }"
            type="button"
            @click="switchTab('chapters')"
          >
            {{ t('comic.thumbnail.tabs.chapters') }}
          </button>
          <button
            class="thumbnail-panel__tab"
            :class="{ 'thumbnail-panel__tab--active': activeTab === 'pages' }"
            type="button"
            @click="switchTab('pages')"
          >
            {{ t('comic.thumbnail.tabs.pages') }}
          </button>
        </div>
        <button
          class="thumbnail-panel__close"
          type="button"
          :title="t('common.actions.close')"
          :aria-label="t('comic.thumbnail.closePanel')"
          @click="handleClose"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <!-- Tab 内容区 -->
      <div class="thumbnail-panel__body">
        <!-- 页面缩略图网格 -->
        <div v-show="activeTab === 'pages'" ref="gridRef" class="thumbnail-grid">
          <div
            v-for="(url, index) in thumbUrls"
            :key="index"
            :ref="(el) => setThumbItemRef(el, index)"
            :data-index="index"
            class="thumbnail-item"
            :class="{
              'thumbnail-item--current': index + 1 === currentPage,
              'thumbnail-item--loaded': loadedSet.has(index)
            }"
            :title="t('comic.page.short', { n: index + 1 })"
            @click="handleThumbClick(index + 1)"
          >
            <!-- 已加载：显示真实图片 -->
            <img
              v-if="loadedSet.has(index) && url"
              class="thumbnail-item__img"
              :src="url"
              :alt="t('comic.page.short', { n: index + 1 })"
              loading="lazy"
              draggable="false"
            />
            <!-- 未加载或 URL 无效：灰色占位符 -->
            <div v-else class="thumbnail-item__placeholder">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </div>
            <!-- 页码标签 -->
            <span class="thumbnail-item__label">{{ index + 1 }}</span>
          </div>

          <!-- 空状态：无图片 -->
          <div v-if="images.length === 0" class="thumbnail-grid__empty">
            <span>{{ t('comic.thumbnail.noPages') }}</span>
          </div>
        </div>

        <!-- 章节列表 -->
        <div v-show="activeTab === 'chapters'" ref="chapterListRef" class="chapter-list">
          <div
            v-for="chapter in chapters"
            :key="chapter.index"
            :ref="
              (el) => {
                if (chapter.index === currentChapter) currentChapterItemRef = el as HTMLElement | null;
              }
            "
            class="chapter-item"
            :class="{ 'chapter-item--current': chapter.index === currentChapter }"
            :title="getChapterTitle(chapter)"
            @click="handleChapterClick(chapter.index)"
          >
            <span class="chapter-item__index">{{ chapter.index + 1 }}</span>
            <span class="chapter-item__title">{{ getChapterTitle(chapter) }}</span>
          </div>

          <!-- 空状态：无章节 -->
          <div v-if="chapters.length === 0" class="chapter-list__empty">
            <span>{{ t('comic.thumbnail.noChapters') }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ==================== 面板根容器 ==================== */

.thumbnail-panel {
  position: fixed;
  top: 0;
  right: 0;
  /* 100dvh：动态视口高度，避免移动端地址栏伸缩导致面板高度跳变 */
  height: 100dvh;
  width: 340px;
  z-index: 1000;

  /* slide 动画：默认滑出到屏幕右侧外 */
  transform: translateX(100%);
  transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}

.thumbnail-panel--open {
  transform: translateX(0);
  pointer-events: auto;
}

/* ==================== 面板内层（背景 + blur） ==================== */

.thumbnail-panel__inner {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  box-sizing: border-box;

  /* 主题化背景 + backdrop-filter blur */
  background: var(--panel-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: var(--panel-text);

  /* 左侧分隔线 */
  border-left: 1px solid var(--panel-border);
}

/* ==================== 顶部标题栏 ==================== */

.thumbnail-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--panel-border);
}

.thumbnail-panel__tabs {
  display: flex;
  gap: 4px;
}

.thumbnail-panel__tab {
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 500;
  color: var(--panel-text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease;
  outline: none;
}

.thumbnail-panel__tab:hover {
  color: var(--panel-text);
  background: var(--panel-hover-bg);
}

.thumbnail-panel__tab--active {
  color: var(--panel-text);
  background: var(--panel-active-bg);
}

.thumbnail-panel__tab--active:hover {
  color: var(--panel-text);
  background: var(--panel-active-bg);
}

/* ==================== 关闭按钮 ==================== */

.thumbnail-panel__close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  color: var(--panel-text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease;
  outline: none;
  flex-shrink: 0;
}

.thumbnail-panel__close:hover {
  color: var(--panel-text);
  background: var(--panel-hover-bg);
}

.thumbnail-panel__close:active {
  background: var(--panel-active-bg);
}

/* ==================== Tab 内容区 ==================== */

.thumbnail-panel__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

/* ==================== 缩略图网格 ==================== */

.thumbnail-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 12px;
  height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
  align-content: start;
}

/* 自定义滚动条 */
.thumbnail-grid::-webkit-scrollbar {
  width: 6px;
}

.thumbnail-grid::-webkit-scrollbar-track {
  background: transparent;
}

.thumbnail-grid::-webkit-scrollbar-thumb {
  background: var(--scrollbar-color);
  border-radius: 3px;
}

.thumbnail-grid::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-color);
}

/* ==================== 缩略图项 ==================== */

.thumbnail-item {
  position: relative;
  height: 140px;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  background: var(--thumb-item-bg);
  border: 2px solid transparent;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    transform 0.1s ease;
}

.thumbnail-item:hover {
  background: var(--panel-hover-bg);
  transform: translateY(-1px);
}

.thumbnail-item:active {
  transform: translateY(0);
}

/* 当前页高亮：边框 + 背景 */
.thumbnail-item--current {
  border-color: rgba(100, 160, 255, 0.9);
  background: rgba(100, 160, 255, 0.12);
}

.thumbnail-item--current:hover {
  background: rgba(100, 160, 255, 0.18);
}

/* 缩略图图片：object-fit cover 填充固定高度 */
.thumbnail-item__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
  user-select: none;
}

/* 未加载占位符 */
.thumbnail-item__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--panel-text-secondary);
  pointer-events: none;
}

/* 页码标签 */
.thumbnail-item__label {
  position: absolute;
  bottom: 4px;
  right: 4px;
  min-width: 20px;
  height: 18px;
  padding: 0 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--panel-text);
  background: rgba(0, 0, 0, 0.65);
  border-radius: 4px;
  pointer-events: none;
  line-height: 1;
}

/* 网格空状态 */
.thumbnail-grid__empty {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 16px;
  color: var(--panel-text-secondary);
  font-size: 14px;
}

/* ==================== 章节列表 ==================== */

.chapter-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
}

/* 自定义滚动条 */
.chapter-list::-webkit-scrollbar {
  width: 6px;
}

.chapter-list::-webkit-scrollbar-track {
  background: transparent;
}

.chapter-list::-webkit-scrollbar-thumb {
  background: var(--scrollbar-color);
  border-radius: 3px;
}

.chapter-list::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-color);
}

/* ==================== 章节项 ==================== */

.chapter-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
  border-left: 3px solid transparent;
  box-sizing: border-box;
}

.chapter-item:hover {
  background: var(--panel-hover-bg);
}

/* 当前章节高亮 */
.chapter-item--current {
  background: rgba(100, 160, 255, 0.12);
  border-left-color: rgba(100, 160, 255, 0.9);
}

.chapter-item--current:hover {
  background: rgba(100, 160, 255, 0.18);
}

/* 章节序号 */
.chapter-item__index {
  flex-shrink: 0;
  min-width: 28px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--panel-text-secondary);
  background: var(--panel-hover-bg);
  border-radius: 4px;
  line-height: 1;
}

.chapter-item--current .chapter-item__index {
  color: var(--panel-text);
  background: rgba(100, 160, 255, 0.25);
}

/* 章节标题 */
.chapter-item__title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--panel-text);
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.chapter-item--current .chapter-item__title {
  color: var(--panel-text);
  opacity: 1;
  font-weight: 500;
}

/* 章节列表空状态 */
.chapter-list__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 16px;
  color: var(--panel-text-secondary);
  font-size: 14px;
}
</style>
