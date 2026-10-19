<!--
  翻页阅读视图

  功能：
  - 章节正文按页分割（按段落实际高度累加）
  - 字号 fontSize px、行距 lineHeight、字体 fontFamilyCss
  - 主题颜色通过 CSS 变量 --reader-text / --reader-bg 驱动
  - 段落间距 1.5em，首行缩进 2em，行高 1.8（默认）
  - 翻页动画：左右滑动过渡 0.3s ease
  - 页面内容从顶部开始排列，超出时可滚动
  - 翻页提示：左右两侧半透明箭头区域（悬停显示）
  - 左右键 / 点击翻页
  - 翻到最后一页再右键 → 下一章
  - 翻到第一页再左键 → 上一章
  - 底部页码指示（"第 3/12 页"）
  - 暴露翻页方法供父组件快捷键调用
-->
<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useReaderStore } from '@renderer/stores';
import { useSettingsStore } from '@renderer/stores';
import { useBookmarkStore } from '@renderer/stores';
import { useInlineImageLightbox } from '@renderer/composables';
import { splitParagraphs, renderParagraphWithHighlights } from '@renderer/utils';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const store = useReaderStore();
const settings = useSettingsStore();
const bookmarkStore = useBookmarkStore();

const emit = defineEmits<{
  (e: 'contextmenu', event: MouseEvent): void;
}>();

/** 测量容器（隐藏，用于计算段落高度） */
const measureRef = ref<HTMLDivElement | null>(null);

/** 当前页码（0-based） */
const currentPage = ref<number>(0);
/** 每页段落范围数组：pages[i] = [startIdx, endIdx]（含两端） */
const pages = ref<Array<[number, number]>>([]);
/** 超长段落索引集合：单段落高度超过 pageHeight 时记录，用于给该页开启 overflow:auto */
const oversizedParagraphIndexes = ref<Set<number>>(new Set());

/** 翻页动画方向：next=向左滑出/进入，prev=向右滑出/进入 */
const turnDirection = ref<'next' | 'prev'>('next');
/** 翻页动画 key（每次翻页 +1，触发 transition） */
const pageKey = ref<number>(0);
/** 翻页动画进行中标志（防止动画期间重复触发翻页） */
const isAnimating = ref<boolean>(false);
/** 翻页动画定时器（组件卸载时需清理，避免写入已卸载的 ref） */
let animatingTimer: ReturnType<typeof setTimeout> | null = null;

/** 待清理的 requestAnimationFrame ID 列表，组件卸载时统一 cancel */
const pendingRAFs: number[] = [];

/** 组件是否已卸载（防止 async 操作完成后写入已卸载的组件状态） */
let isUnmounted = false;

/** 待恢复的归一化位置（0~1），分页计算完成后自动恢复 */
const pendingRestorePosition = ref<number | null>(null);

/** 翻页动画 transition name（根据 pageTurnAnimation 设置和翻页方向动态计算） */
const turnTransitionName = computed<string>(() => {
  const anim = settings.pageTurnAnimation;
  if (anim === 'none') return '';
  const dir = turnDirection.value;
  return `${anim}-${dir}`;
});

/** 翻页动画时长（ms），根据动画类型动态计算 */
const animationDuration = computed<number>(() => {
  const anim = settings.pageTurnAnimation;
  if (anim === 'none') return 0;
  if (anim === 'flip') return 400;
  if (anim === 'fade') return 300;
  if (anim === 'curl') return 500;
  return 300; // slide
});

/** 是否为 3D 类动画（flip 仿真翻页 / curl 页面卷曲都需要父容器 perspective） */
const is3dAnimation = computed<boolean>(
  () => settings.pageTurnAnimation === 'curl' || settings.pageTurnAnimation === 'flip'
);

/** 段落数据（使用共享的多维度兼容分割函数） */
const paragraphs = computed<string[]>(() => {
  const raw = store.chapterContent;
  if (!raw) return [];
  return splitParagraphs(raw);
});

/** 总页数 */
const totalPages = computed<number>(() => pages.value.length || 1);

/* ==================== 高亮可视化 ==================== */

/** 获取当前章节中所有有高亮颜色的笔记 */
const currentChapterHighlightNotes = computed<Array<{ content: string; color: string }>>(() => {
  const result: Array<{ content: string; color: string }> = [];
  for (const bm of bookmarkStore.bookmarks) {
    if (bm.highlight_color && bm.content && bm.chapter_index === store.currentChapterIndex) {
      result.push({ content: bm.content, color: bm.highlight_color });
    }
  }
  return result;
});

/**
 * 内容区域 padding：统一内边距，不再为工具栏/底部导航预留空间
 *
 * Reader.vue 使用 flex column 布局，工具栏（56px）和底部导航（64px）作为 flex 子项
 * 已占据文档流空间，内容区通过 flex:1 自动填充剩余空间。
 * 若此处再为工具栏预留 padding，会导致内容区被双重压缩，分页计算基于错误高度。
 *
 * 水平边距（--reader-margin）放在内层 .page-inner 上而非 .page-display：
 * 若加在外层，配合 .page-inner 的 maxWidth 居中，宽屏下外边距在数学上被居中
 * 空白抵消，导致"边距滑杆无效"。放入内层（border-box）后边距始终收窄正文宽度。
 */
/** 显示层外边距：只保留垂直内边距，水平边距交给内层 */
const displayPadding = computed<string>(() => 'var(--spacing-md) 0 var(--spacing-md)');
/** 测量层内边距：需与 .page-inner 的水平边距完全一致，保证分页换行计算与显示一致 */
const contentPadding = computed<string>(
  () => 'var(--spacing-md) var(--reader-margin, var(--spacing-lg)) var(--spacing-md)'
);
/** 内层水平边距：用户设置的阅读边距在此生效 */
const innerPadding = computed<string>(() => '0 var(--reader-margin, var(--spacing-lg))');

/** 当前页应显示的段落 */
const visibleParagraphs = computed<{ text: string; index: number }[]>(() => {
  if (pages.value.length === 0) {
    return paragraphs.value.map((text, index) => ({ text, index }));
  }
  const [start, end] = pages.value[currentPage.value] ?? [0, paragraphs.value.length - 1];
  const result: { text: string; index: number }[] = [];
  for (let i = start; i <= end && i < paragraphs.value.length; i++) {
    result.push({ text: paragraphs.value[i], index: i });
  }
  return result;
});

/**
 * 当前页是否为超长段落独占页（单段落高度超过 pageHeight）。
 * 超长页需要开启 overflow:auto，让用户能滚动查看完整内容，而非被截断。
 */
const isCurrentPageOversized = computed<boolean>(() => {
  if (pages.value.length === 0) return false;
  const range = pages.value[currentPage.value];
  if (!range) return false;
  const [start, end] = range;
  // 超长页只有一个段落
  if (start !== end) return false;
  return oversizedParagraphIndexes.value.has(start);
});

/* ==================== 分页计算 ==================== */

/** 重新计算分页（容器尺寸或内容变化时调用） */
function recomputePages(): void {
  if (!measureRef.value || paragraphs.value.length === 0) {
    pages.value = [];
    // 清理 pendingRestorePosition，避免空内容章节中永远不被消费
    pendingRestorePosition.value = null;
    return;
  }
  const container = measureRef.value;
  // 扣除容器 padding：clientHeight 含 padding，但段落高度累加不含 padding，
  // 若不扣除，每页会多塞 paddingTop+paddingBottom 像素内容被截断
  const containerStyle = getComputedStyle(container);
  const paddingTop = parseFloat(containerStyle.paddingTop);
  const paddingBottom = parseFloat(containerStyle.paddingBottom);
  const pageHeight = container.clientHeight - paddingTop - paddingBottom;
  if (pageHeight <= 0) {
    pages.value = [];
    // 清理 pendingRestorePosition，避免容器未布局时永久挂起
    pendingRestorePosition.value = null;
    return;
  }

  // 获取章节标题元素的高度（第一页包含标题）
  const titleEl = container.querySelector<HTMLElement>('.chapter-title');
  const dividerEl = container.querySelector<HTMLElement>('.chapter-divider');
  const titleStyle = titleEl ? getComputedStyle(titleEl) : null;
  const dividerStyle = dividerEl ? getComputedStyle(dividerEl) : null;
  const titleHeight =
    (titleEl?.offsetHeight ?? 0) +
    parseFloat(titleStyle?.marginBottom ?? '0') +
    (dividerEl?.offsetHeight ?? 0) +
    parseFloat(dividerStyle?.marginBottom ?? '0');

  const newPages: Array<[number, number]> = [];
  // 记录本轮分页中超长段落索引，便于给独占页开启 overflow:auto
  const newOversized = new Set<number>();
  let pageStart = 0;
  let usedHeight = titleHeight; // 第一页包含标题高度

  // 直接从 DOM 获取段落元素，不依赖 paragraphRefs 和 :ref 回调。
  // 原因：paragraphRefs.value = [] 清空后，v-for 的 :key="i" 使用索引作为 key，
  // Vue 复用已有 DOM 元素而非重新创建，:ref 回调不会被重新调用，
  // 导致 paragraphRefs.value 保持为空 []，分页循环不执行。
  const paragraphEls = container.querySelectorAll<HTMLElement>('.paragraph');

  for (let i = 0; i < paragraphEls.length; i++) {
    const el = paragraphEls[i];
    const style = getComputedStyle(el);
    const elHeight = el.offsetHeight + parseFloat(style.marginBottom);
    // 段落加进当前页
    if (usedHeight + elHeight > pageHeight && i > pageStart) {
      // 当前页满了，封页
      newPages.push([pageStart, i - 1]);
      pageStart = i;
      usedHeight = elHeight;
    } else if (usedHeight + elHeight > pageHeight && i === pageStart) {
      // 单段落超过一页高度，允许该段落独占一页（不跳过），
      // 后续段落会触发 i > pageStart 封页，使超长段落单独成页。
      // 同时记录为超长段落，给该页开启 overflow:auto 让用户能滚动看完整内容。
      newOversized.add(i);
      usedHeight += elHeight;
    } else {
      usedHeight += elHeight;
    }
  }
  // 最后一页
  if (pageStart < paragraphs.value.length) {
    newPages.push([pageStart, paragraphs.value.length - 1]);
  }

  pages.value = newPages;
  oversizedParagraphIndexes.value = newOversized;
  // 修正当前页码
  if (currentPage.value >= newPages.length) {
    currentPage.value = Math.max(0, newPages.length - 1);
  }
  // 分页计算完成后，恢复暂存的进度位置（基于段落索引）
  if (pendingRestorePosition.value !== null) {
    const pos = pendingRestorePosition.value;
    pendingRestorePosition.value = null;
    // 基于段落索引定位：找到包含目标段落的页
    const totalParas = paragraphs.value.length;
    if (totalParas > 1 && newPages.length > 0) {
      const targetParaIdx = Math.round(pos * (totalParas - 1));
      let found = false;
      for (let i = 0; i < newPages.length; i++) {
        const [start, end] = newPages[i];
        if (targetParaIdx >= start && targetParaIdx <= end) {
          currentPage.value = i;
          found = true;
          break;
        }
      }
      if (!found) {
        currentPage.value = Math.max(0, Math.min(newPages.length - 1, Math.round(pos * (newPages.length - 1))));
      }
    } else if (newPages.length > 1) {
      currentPage.value = Math.max(0, Math.min(newPages.length - 1, Math.round(pos * (newPages.length - 1))));
    }
    pageKey.value++;
    // 恢复位置后同步进度到 store，让底部导航进度条立即正确显示
    store.setLiveScrollPosition(normalizedPosition());
  }
}

/** 监听容器尺寸变化 */
let resizeObserver: ResizeObserver | null = null;
/** resize debounce 定时器：连续 resize（如窗口拖动）时避免频繁触发 recomputePages */
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function setupResizeObserver(): void {
  if (!measureRef.value) return;
  // 加 150ms debounce：窗口连续 resize 时只在停顿后重算一次分页
  const debouncedRecompute = (): void => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => recomputePages(), 150);
  };
  resizeObserver = new ResizeObserver(debouncedRecompute);
  resizeObserver.observe(measureRef.value);
}

/* ==================== 翻页操作 ==================== */

/** 翻页动画时长（ms），与 CSS transition 时长一致，根据动画类型动态变化 */

/**
 * 翻页后同步进度到 store。
 *
 * 同时更新 liveScrollPosition（实时位置，用于底部导航进度条立即刷新）
 * 和 scheduleProgressSave（debounce 持久化到 DB）。
 *
 * 仅在文字阅读器（小说模式）下调用，漫画模式由 ComicView 自行处理。
 */
function syncProgressAfterTurn(): void {
  const pos = normalizedPosition();
  store.setLiveScrollPosition(pos);
  store.scheduleProgressSave(pos);
}

/** 翻到下一页（或下一章） */
async function nextPage(): Promise<void> {
  if (isAnimating.value) return;
  if (currentPage.value < totalPages.value - 1) {
    isAnimating.value = true;
    turnDirection.value = 'next';
    currentPage.value++;
    pageKey.value++;
    syncProgressAfterTurn();
    animatingTimer = setTimeout(() => {
      isAnimating.value = false;
    }, animationDuration.value);
  } else {
    if (store.hasNextChapter) {
      isAnimating.value = true;
      turnDirection.value = 'next';
      await store.nextChapter();
      if (isUnmounted) return;
      currentPage.value = 0;
      store.setLiveScrollPosition(0);
      animatingTimer = setTimeout(() => {
        isAnimating.value = false;
      }, animationDuration.value);
    }
  }
}

/** 翻到上一页（或上一章） */
async function prevPage(): Promise<void> {
  if (isAnimating.value) return;
  if (currentPage.value > 0) {
    isAnimating.value = true;
    turnDirection.value = 'prev';
    currentPage.value--;
    pageKey.value++;
    syncProgressAfterTurn();
    animatingTimer = setTimeout(() => {
      isAnimating.value = false;
    }, animationDuration.value);
  } else {
    if (store.hasPrevChapter) {
      isAnimating.value = true;
      turnDirection.value = 'prev';
      pendingRestorePosition.value = 1.0;
      await store.prevChapter();
      if (isUnmounted) return;
      currentPage.value = 0;
      store.setLiveScrollPosition(1.0);
      animatingTimer = setTimeout(() => {
        isAnimating.value = false;
      }, animationDuration.value);
    }
  }
}

/** 跳转到指定页（恢复进度用） */
function goToPage(page: number): void {
  if (isAnimating.value) return;
  currentPage.value = Math.max(0, Math.min(totalPages.value - 1, page));
  pageKey.value++;
  // 跳转后同步进度，确保底部导航进度条正确
  store.setLiveScrollPosition(normalizedPosition());
}

/** 跳转到归一化位置（0~1），基于段落索引，不受分页变化影响 */
function goToPosition(position: number): void {
  if (pages.value.length === 0) {
    // 分页尚未计算完成，暂存位置待 recomputePages 后恢复
    pendingRestorePosition.value = position;
    // 即使分页未完成，也先同步位置给 store，让进度条尽早反映正确位置
    store.setLiveScrollPosition(position);
    return;
  }

  /** 用段落索引定位到目标页 */
  const locateByParagraph = (): boolean => {
    const totalParas = paragraphs.value.length;
    if (totalParas > 1) {
      const targetParaIdx = Math.round(position * (totalParas - 1));
      for (let i = 0; i < pages.value.length; i++) {
        const [start, end] = pages.value[i];
        if (targetParaIdx >= start && targetParaIdx <= end) {
          goToPage(i);
          return true;
        }
      }
    }
    return false;
  };

  // 首次定位
  if (!locateByParagraph()) {
    // fallback：用页码归一化
    goToPage(Math.round(position * (totalPages.value - 1)));
  }

  // 二次校正：图片加载后 recomputePages 重新分页，延迟重新定位到正确页
  setTimeout(() => {
    if (pages.value.length === 0) return;
    if (!locateByParagraph()) {
      goToPage(Math.round(position * (totalPages.value - 1)));
    }
  }, 1000);
}

/**
 * 获取当前归一化位置（0~1），基于段落索引，不受分页变化影响。
 * 用当前页起始段落索引 / (总段落数-1) 表示归一化位置。
 */
function getCurrentPosition(): number {
  if (totalPages.value <= 1) return 0;
  const totalParas = paragraphs.value.length;
  if (totalParas <= 1) return 0;
  // 当前页的起始段落索引
  const [startIdx] = pages.value[currentPage.value] ?? [0, 0];
  return startIdx / Math.max(1, totalParas - 1);
}

/** 归一化位置辅助函数，供进度保存使用 */
function normalizedPosition(): number {
  return getCurrentPosition();
}

/**
 * 获取当前可见页的文本摘要（用于添加书签时自动填充 content）。
 * 取当前页所有段落文本拼接后截断。
 */
function getVisibleText(maxLength = 100): string {
  const texts = visibleParagraphs.value.map((p) => p.text.trim()).filter((t) => t.length > 0);
  const joined = texts.join(' ').replace(/\s+/g, ' ');
  return joined.length > maxLength ? joined.slice(0, maxLength) + '…' : joined;
}

defineExpose({
  nextPage,
  prevPage,
  goToPage,
  goToPosition,
  getCurrentPosition,
  getVisibleText
});

/* ==================== 图片放大查看（Lightbox） ==================== */

/** 显示层容器引用（用于绑定 click 事件委托 + IntersectionObserver root） */
const displayRef = ref<HTMLDivElement | null>(null);

/**
 * 内联图片 Lightbox 放大查看 — 复用 useInlineImageLightbox composable。
 * composable 自动管理：imageViewerSrc/Visible 状态、open/close 函数、
 * 遮罩点击/Esc 键关闭、IntersectionObserver 初始化与清理、Esc 键监听。
 */
const {
  imageViewerSrc,
  imageViewerVisible: showImageViewer,
  openImageViewer,
  closeImageViewer,
  handleLightboxClick,

  observeInlineImages
} = useInlineImageLightbox(displayRef);

/** 显示层 click 事件委托：点击 .inline-illustration 图片时打开 lightbox */
function handleDisplayClickDelegation(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (target && target.classList.contains('inline-illustration')) {
    // 加载失败的图片不打开 lightbox
    if (target.getAttribute('data-error') === 'true') return;
    const img = target as HTMLImageElement;
    // 使用原始 src（未转义的）作为 lightbox 源，浏览器会自动处理
    openImageViewer(img.src);
  }
}

/* ==================== 点击翻页 ==================== */

/** 点击正文区：左 30% 上一页，右 30% 下一页，中间 40% 留给文本选择/笔记 */
async function handleClick(event: MouseEvent): Promise<void> {
  // 事件委托优先处理图片点击放大（点击 .inline-illustration 时打开 lightbox，不触发翻页）
  const target = event.target as HTMLElement;
  if (target && target.classList.contains('inline-illustration')) {
    handleDisplayClickDelegation(event);
    return;
  }
  const currentTarget = event.currentTarget as HTMLDivElement;
  const rect = currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  if (x < rect.width * 0.3) {
    await prevPage();
  } else if (x > rect.width * 0.7) {
    await nextPage();
  }
  // 中间 40% 区域不响应翻页（留给文本选择、右键笔记、工具栏切换）
}

/* ==================== 监听章节切换 ==================== */

watch(
  () => store.currentChapterIndex,
  () => {
    currentPage.value = 0;
    pageKey.value++;
    // 章节切换后重置实时进度位置为 0，让底部导航进度条立即正确显示
    store.setLiveScrollPosition(0);
    // 使用 requestAnimationFrame 确保 DOM 完成布局后再计算分页
    pendingRAFs.push(requestAnimationFrame(() => recomputePages()));
  }
);

watch(
  () => store.chapterContent,
  () => {
    // 章节内容变化时重置页码（但不清除 pendingRestorePosition，
    // 因为 recomputePages 会在分页计算完成后自动恢复暂存的进度位置）
    currentPage.value = 0;
    pageKey.value++;
    // 内容变化（如去广告规则刷新）后重置实时进度位置
    store.setLiveScrollPosition(0);
    pendingRAFs.push(requestAnimationFrame(() => recomputePages()));
  }
);

/* 字号/行距/字体/页宽/边距/段落间距变化时重新分页，否则内容溢出/页码错位 */
watch(
  [
    () => store.fontSize,
    () => store.lineHeight,
    () => store.fontFamilyCss,
    () => store.pageWidth,
    () => store.margin,
    () => store.paragraphSpacing
  ],
  () => {
    pageKey.value++;
    pendingRAFs.push(requestAnimationFrame(() => recomputePages()));
  }
);

/* 翻页后（pageKey 变化）重新扫描内联图片，让新进入视口的图片纳入懒加载监听 */
watch(pageKey, () => {
  void nextTick(() => {
    // 重新扫描图片纳入懒加载监听
    observeInlineImages();
    // 翻页动画优化：给当前页已加载完成的图片重新触发淡入效果
    // 移除 .inline-illustration-loaded 类后强制重排，再重新添加，触发 transition
    if (displayRef.value) {
      const loadedImgs = displayRef.value.querySelectorAll<HTMLImageElement>(
        '.inline-illustration.inline-illustration-loaded'
      );
      loadedImgs.forEach((img) => {
        img.classList.remove('inline-illustration-loaded');
        // 强制重排，确保 transition 重新触发
        void img.offsetWidth;
        img.classList.add('inline-illustration-loaded');
      });
    }
  });
});

/* ==================== 生命周期 ==================== */

onMounted(() => {
  void nextTick(() => {
    recomputePages();
    setupResizeObserver();
  });

  // 初次扫描图片（nextTick 确保 DOM 渲染完成）
  // （IntersectionObserver 初始化与 Esc 键监听由 useInlineImageLightbox composable 自动管理）
  void nextTick(() => observeInlineImages());
});

onBeforeUnmount(() => {
  isUnmounted = true;
  resizeObserver?.disconnect();
  resizeObserver = null;
  // 清理 debounce 定时器，避免组件卸载后仍触发 recomputePages
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  // 清理翻页动画定时器，避免写入已卸载的 ref
  if (animatingTimer) {
    clearTimeout(animatingTimer);
    animatingTimer = null;
  }
  // 清理未执行的 requestAnimationFrame，避免组件卸载后仍触发 recomputePages
  pendingRAFs.forEach((id) => cancelAnimationFrame(id));
  pendingRAFs.length = 0;
  // （IntersectionObserver 清理与 Esc 键监听移除由 useInlineImageLightbox composable 自动管理）
  // 进度保存由 Reader.vue 的 flushCurrentProgress 统一处理，此处不再保存
});
</script>

<template>
  <div
    class="page-view"
    :style="{
      '--reader-margin': `${store.margin}px`,
      '--reader-paragraph-spacing': store.paragraphSpacing
    }"
    @contextmenu="(e: MouseEvent) => emit('contextmenu', e)"
  >
    <!-- 测量层（隐藏，用于计算段落高度） -->
    <div ref="measureRef" class="measure-layer" :style="{ maxWidth: `${store.pageWidth}px`, padding: contentPadding }">
      <h1 class="chapter-title">{{ store.currentChapterTitle }}</h1>
      <div class="chapter-divider" aria-hidden="true"></div>
      <p
        v-for="(para, i) in paragraphs"
        :key="i"
        class="paragraph"
        :style="{
          fontSize: `${store.fontSize}px`,
          lineHeight: store.lineHeight,
          fontFamily: store.fontFamilyCss
        }"
        v-html="renderParagraphWithHighlights(para, currentChapterHighlightNotes)"
      ></p>
    </div>

    <!-- 显示层（当前页段落，带翻页动画） -->
    <div
      ref="displayRef"
      class="page-display"
      :class="{ 'page-display-animating': isAnimating, 'page-display-3d': is3dAnimation }"
      :style="{ padding: displayPadding, overflowY: isCurrentPageOversized ? 'auto' : 'hidden' }"
      @click="handleClick"
    >
      <!-- 有动画时使用 transition 组件，无动画时直接渲染避免闪烁 -->
      <transition v-if="turnTransitionName" :name="turnTransitionName">
        <div :key="pageKey" class="page-inner" :style="{ maxWidth: `${store.pageWidth}px`, padding: innerPadding }">
          <h1 v-if="currentPage === 0" class="chapter-title">{{ store.currentChapterTitle }}</h1>
          <div v-if="currentPage === 0" class="chapter-divider" aria-hidden="true"></div>
          <p
            v-for="item in visibleParagraphs"
            :key="item.index"
            class="paragraph"
            :style="{
              fontSize: `${store.fontSize}px`,
              lineHeight: store.lineHeight,
              fontFamily: store.fontFamilyCss
            }"
            v-html="renderParagraphWithHighlights(item.text, currentChapterHighlightNotes)"
          ></p>
          <div v-if="currentPage === totalPages - 1 && !store.hasNextChapter" class="chapter-end">
            {{ t('readerViews.finishedLastChapter') }}
          </div>
        </div>
      </transition>
      <div
        v-else
        :key="pageKey"
        class="page-inner"
        :style="{ maxWidth: `${store.pageWidth}px`, padding: innerPadding }"
      >
        <h1 v-if="currentPage === 0" class="chapter-title">{{ store.currentChapterTitle }}</h1>
        <div v-if="currentPage === 0" class="chapter-divider" aria-hidden="true"></div>
        <p
          v-for="item in visibleParagraphs"
          :key="item.index"
          class="paragraph"
          :style="{
            fontSize: `${store.fontSize}px`,
            lineHeight: store.lineHeight,
            fontFamily: store.fontFamilyCss
          }"
          v-html="renderParagraphWithHighlights(item.text, currentChapterHighlightNotes)"
        ></p>
        <div v-if="currentPage === totalPages - 1 && !store.hasNextChapter" class="chapter-end">
          {{ t('readerViews.finishedLastChapter') }}
        </div>
      </div>
    </div>

    <!-- 左侧翻页提示（悬停显示） -->
    <div class="page-arrow page-arrow-left" @click="prevPage">
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="15 18 9 12 15 6"></polyline>
      </svg>
    </div>

    <!-- 右侧翻页提示（悬停显示） -->
    <div class="page-arrow page-arrow-right" @click="nextPage">
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="9 18 15 12 9 6"></polyline>
      </svg>
    </div>

    <!-- 页码指示（独立状态栏：半透明背景 + 模糊，跟随主题色） -->
    <div v-if="totalPages > 1" class="page-indicator">
      <span class="page-indicator-current">{{ currentPage + 1 }}</span>
      <span class="page-indicator-sep">/</span>
      <span class="page-indicator-total">{{ totalPages }}</span>
      <span class="page-indicator-label">{{ t('readerViews.page.indicatorLabel') }}</span>
    </div>

    <!-- 图片放大查看（Lightbox）：全屏遮罩 + 居中图片 + 关闭按钮 -->
    <div v-if="showImageViewer" class="image-lightbox" @click="handleLightboxClick">
      <img :src="imageViewerSrc" class="image-lightbox-img" :alt="t('readerViews.lightbox.zoomAlt')" @click.stop />
      <button
        class="image-lightbox-close"
        type="button"
        :aria-label="t('common.actions.close')"
        @click="closeImageViewer"
      >
        ×
      </button>
    </div>
  </div>
</template>

<style scoped>
.page-view {
  position: relative;
  height: 100%;
  overflow: hidden;
  /* 显式声明背景色跟随阅读器主题，避免依赖继承导致主题切换时背景色不对 */
  background: var(--reader-bg);
  transition: background-color 0.3s ease;
}

/* 测量层：不可见但保留布局尺寸 */
.measure-layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  visibility: hidden;
  pointer-events: none;
  overflow: hidden;
}

.page-display {
  height: 100%;
  cursor: pointer;
  display: block;
  overflow: hidden;
  position: relative;
  /* 显式声明背景色，确保翻页动画期间背景色一致，不透出底层 measure-layer */
  background: var(--reader-bg);
}

/* 动画期间禁用点击，防止重复触发翻页 */
.page-display-animating {
  pointer-events: none;
}

/* 翻页动画期间提升 .page-inner 为合成层，让 transform 动画走 GPU 合成线程。
   只在 isAnimating=true 时生效，动画结束后移除 will-change，避免静态时占用 GPU 内存。
   注意：不在静态 .page-inner 上加 will-change，否则会常驻 GPU 内存。 */
.page-display-animating .page-inner {
  will-change: transform;
}

/* 3D 动画（flip 仿真翻页 / curl 页面卷曲）：为子元素 3D 翻转提供透视空间。
   旧实现只在 curl 时加 perspective，导致 flip 的 rotateY 没有透视纵深，效果扁平怪异 */
.page-display-3d {
  perspective: 1600px;
}

.page-inner {
  margin: 0 auto;
  width: 100%;
  text-align: left;
  /* 隔离章节内容的布局/样式/绘制，避免段落变化触发父元素重排，提升翻页和滚动性能。
     contain: content 等价于 contain: layout style paint。
     Electron 44 使用 Chromium 130+，完全支持。 */
  contain: content;
}

/* ==================== 章节标题 ==================== */
.chapter-title {
  font-size: var(--font-size-xl);
  font-weight: 700;
  color: var(--reader-text);
  text-align: center;
  margin: 0 0 var(--spacing-sm-md);
  letter-spacing: 1px;
}

.chapter-divider {
  width: 40px;
  height: 2px;
  margin: 0 auto var(--spacing-xl);
  background: linear-gradient(to right, transparent, var(--reader-primary) 50%, transparent);
  border-radius: 1px;
  opacity: 0.7;
}

/* ==================== 段落正文 ==================== */
.paragraph {
  color: var(--reader-text);
  text-indent: 2em;
  margin-bottom: calc(1.5em * var(--reader-paragraph-spacing, 1));
  user-select: text;
  word-break: break-word;
  white-space: pre-wrap;
}

/* ==================== 内联插图 ==================== */
/*
 * 设计要点（与 ScrollView 的 .inline-illustration 风格一致）：
 * - max-width:100% 自适应容器宽度，居中显示
 * - margin:16px auto 上下留白，与文字段落区分
 * - border-radius:8px 圆角，box-shadow 轻微投影增加层次感
 * - cursor:zoom-in 提示可点击放大
 * - data-loading="true" 时显示骨架屏背景（渐变 + 闪烁动画）
 * - .inline-illustration-loaded 类触发淡入动画（图片加载完成后由 JS 添加）
 * - data-error="true" 时显示加载失败样式（半透明 + 红色边框）
 */
/* :deep() 必须——v-html 生成的 <img> 不带 scoped data 属性，
   不用 :deep() 则样式不生效，图片无 max-width/margin 等样式 */
:deep(.inline-illustration) {
  max-width: 100%;
  /* P1-13修复：原 max-height:70vh 过严，高图被过度压缩。
     放宽至 90vh，让图片在翻页模式下尽可能自然显示，同时仍保留
     少量边距给标题/文字。object-fit:contain 保持宽高比。 */
  max-height: 90vh;
  object-fit: contain;
  display: block;
  margin: var(--spacing-md) auto;
  border-radius: var(--border-radius);
  box-shadow: var(--shadow-elevated);
  cursor: zoom-in;
  /* 立即可见，不依赖 JS 添加 class */
  opacity: 1;
}

/* 加载占位：仅淡色背景（不设 data-loading 时自然显示图片，此规则仅用于重试场景） */
:deep(.inline-illustration[data-loading='true']) {
  background-color: rgba(128, 128, 128, 0.08);
}

/* shimmer 动画已移除——不再使用 data-loading 骨架屏 */

/* 加载完成淡入：JS 在 img load 事件中添加 .inline-illustration-loaded 类 */
:deep(.inline-illustration.inline-illustration-loaded) {
  opacity: 1;
}

/* 加载失败样式：data-error="true" 时降低透明度 + 红色边框提示 */
:deep(.inline-illustration[data-error='true']) {
  opacity: 0.4;
  border: 2px solid color-mix(in srgb, var(--color-danger) 60%, transparent);
  cursor: not-allowed;
  min-height: 120px;
}

/* 图片说明文字（[图片说明：xxx] → <figcaption>） */
:deep(.img-caption) {
  text-align: center;
  font-size: 0.85em;
  color: var(--text-tertiary);
  margin: -4px auto var(--spacing-md);
  padding: 0 16px;
  line-height: 1.4;
}

/* ==================== 图片放大查看（Lightbox） ==================== */
/*
 * 全屏遮罩 + 居中图片 + 关闭按钮：
 * - 固定定位覆盖整个视口，半透明黑色背景
 * - 图片 max-width/max-height 90% 自适应，居中显示
 * - 关闭按钮右上角，悬停放大
 * - 点击遮罩背景关闭，点击图片本身不关闭（@click.stop）
 * - Esc 键关闭（由 useInlineImageLightbox composable 内部处理）
 */
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  /* 淡入动画 */
  animation: image-lightbox-fade-in 0.2s ease;
}

@keyframes image-lightbox-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.image-lightbox-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  /* 图片淡入 + 轻微放大动画 */
  animation: image-lightbox-img-in 0.25s ease;
}

@keyframes image-lightbox-img-in {
  from {
    opacity: 0;
    transform: scale(0.92);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.image-lightbox-close {
  position: absolute;
  top: 16px;
  right: 24px;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  color: var(--text-on-primary);
  font-size: var(--font-size-2xl);
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.2s ease,
    transform 0.2s ease;
}

.image-lightbox-close:hover {
  background: rgba(255, 255, 255, 0.3);
  transform: scale(1.1);
}

/* ==================== 章节末尾提示 ==================== */
.chapter-end {
  text-align: center;
  color: var(--reader-text);
  opacity: 0.55;
  font-size: var(--font-size-sm-plus);
  margin-top: var(--spacing-2xl);
  padding: var(--spacing-md) 0;
  letter-spacing: 1px;
}

/* ==================== 翻页动画 ==================== */
/* 同时滑动：当前页滑出的同时新页滑入，无 out-in 模式。
   缓动统一使用 cubic-bezier（比普通 ease 跟手、收尾更自然）；
   所有动画页加 backface-visibility/translateZ 提示，避免 Linux 合成器翻转闪烁。 */

/* 向前翻（下一页）：当前页向左滑出，新页从右侧滑入。
   不做 opacity 过渡：两页都不透明地滑过，避免半透明叠加透出底色产生白闪 */
.slide-next-enter-active,
.slide-next-leave-active {
  transition: transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}
.slide-next-enter-from {
  transform: translate3d(100%, 0, 0);
}
.slide-next-leave-to {
  transform: translate3d(-100%, 0, 0);
}
/* 离开页面绝对定位，与进入页面重叠同时滑动 */
.slide-next-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

/* 向后翻（上一页）：当前页向右滑出，新页从左侧滑入 */
.slide-prev-enter-active,
.slide-prev-leave-active {
  transition: transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}
.slide-prev-enter-from {
  transform: translate3d(-100%, 0, 0);
}
.slide-prev-leave-to {
  transform: translate3d(100%, 0, 0);
}
/* 离开页面绝对定位，与进入页面重叠同时滑动 */
.slide-prev-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

/* ==================== 仿真翻页动画（3D rotateY） ==================== */

.flip-next-enter-active,
.flip-next-leave-active {
  transition:
    transform 0.4s cubic-bezier(0.45, 0, 0.55, 1),
    opacity 0.4s ease;
  transform-style: preserve-3d;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}
.flip-next-enter-from {
  transform: rotateY(90deg);
  opacity: 0;
}
.flip-next-leave-to {
  transform: rotateY(-90deg);
  opacity: 0;
}
.flip-next-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

.flip-prev-enter-active,
.flip-prev-leave-active {
  transition:
    transform 0.4s cubic-bezier(0.45, 0, 0.55, 1),
    opacity 0.4s ease;
  transform-style: preserve-3d;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}
.flip-prev-enter-from {
  transform: rotateY(-90deg);
  opacity: 0;
}
.flip-prev-leave-to {
  transform: rotateY(90deg);
  opacity: 0;
}
.flip-prev-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

/* ==================== 页面卷曲动画（3D 卷曲翻转） ==================== */
/*
 * 当 settings.pageTurnAnimation === 'curl' 时应用。
 * 效果：当前页像书页一样以侧边为轴卷曲翻转 180°，新页淡入。
 * 依赖父容器 .page-display-3d 的 perspective 启用 3D 空间。
 * - transform-style: preserve-3d 保留子元素 3D 层级
 * - backface-visibility: hidden 翻转至背面时隐藏，避免镜像透出
 * - transform-origin 设为侧边中点，模拟书脊翻页轴
 */

/* 向前翻（下一页）：当前页以右边为轴向左卷曲翻转，新页淡入 */
.curl-next-enter-active {
  transition: opacity 0.5s ease;
}
.curl-next-leave-active {
  transition:
    transform 0.5s cubic-bezier(0.45, 0, 0.55, 1),
    opacity 0.5s ease;
  transform-style: preserve-3d;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}
.curl-next-enter-from {
  opacity: 0;
}
.curl-next-leave-to {
  transform: rotateY(-180deg);
  transform-origin: right center;
  opacity: 0;
}

/* 向后翻（上一页）：当前页以左边为轴向右卷曲翻转，新页淡入 */
.curl-prev-enter-active {
  transition: opacity 0.5s ease;
}
.curl-prev-leave-active {
  transition:
    transform 0.5s cubic-bezier(0.45, 0, 0.55, 1),
    opacity 0.5s ease;
  transform-style: preserve-3d;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}
.curl-prev-enter-from {
  opacity: 0;
}
.curl-prev-leave-to {
  transform: rotateY(180deg);
  transform-origin: left center;
  opacity: 0;
}

/* ==================== 淡入淡出动画 ==================== */

.fade-next-enter-active,
.fade-next-leave-active {
  transition: opacity 0.3s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.fade-next-enter-from {
  opacity: 0;
}
.fade-next-leave-to {
  opacity: 0;
}
.fade-next-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

.fade-prev-enter-active,
.fade-prev-leave-active {
  transition: opacity 0.3s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.fade-prev-enter-from {
  opacity: 0;
}
.fade-prev-leave-to {
  opacity: 0;
}
.fade-prev-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

/* ==================== 翻页箭头提示 ==================== */
.page-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 48px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--reader-text);
  opacity: 0.3;
  cursor: pointer;
  transition: opacity 0.25s ease;
  z-index: 10;
  border: none;
}

.page-arrow-left {
  left: 0;
  background: linear-gradient(to right, color-mix(in srgb, var(--reader-bg) 20%, transparent), transparent);
}

.page-arrow-right {
  right: 0;
  background: linear-gradient(to left, color-mix(in srgb, var(--reader-bg) 20%, transparent), transparent);
}

.page-view:hover .page-arrow {
  opacity: 0.55;
}

.page-view .page-arrow:hover {
  opacity: 1;
  color: var(--reader-primary);
}

/* ==================== 页码指示（独立状态栏） ====================
 *
 * 设计要点（对齐 ComicView 的 .page-indicator 风格，但使用主题色变量）：
 * - 半透明背景 + backdrop-filter blur，跟随 --reader-bg 主题色
 * - 药丸样式（padding + border-radius），独立于正文内容
 * - z-index 高于段落和翻页箭头，不被遮挡
 * - 文字颜色用 --reader-text 跟随主题，当前页码用 --reader-primary 强调
 * - 居中定位（left:50% + transform），与 ComicView 一致
 * - 仅在 totalPages > 1 时显示（v-if 控制），单页时不显示状态栏
 */
.page-indicator {
  position: absolute;
  bottom: var(--spacing-md);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm-md);
  border-radius: var(--border-radius-10px);
  /* 半透明背景跟随主题色，深色/浅色主题下都能自然适配 */
  background: color-mix(in srgb, var(--reader-bg) 72%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: var(--reader-text);
  font-size: var(--font-size-sm-plus);
  pointer-events: none;
  user-select: none;
  letter-spacing: 0.5px;
  z-index: 20;
  box-shadow: var(--shadow-card);
  border: 1px solid color-mix(in srgb, var(--reader-text) 8%, transparent);
}

/* 当前页码用主色强调，提升可读性 */
.page-indicator-current {
  color: var(--reader-primary);
  font-weight: 600;
}

.page-indicator-sep {
  color: var(--reader-text);
  opacity: 0.5;
  margin: 0 1px;
}

.page-indicator-total {
  color: var(--reader-text);
  opacity: 0.85;
}

.page-indicator-label {
  color: var(--reader-text);
  opacity: 0.7;
  margin-left: 2px;
}
</style>
