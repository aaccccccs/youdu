<!--
  漫画垂直滚动模式组件（精简版）

  功能：
  - 垂直滚动，图片 width: 100% 居中显示，纯黑背景
  - IntersectionObserver 懒加载（观察可视区 ±2 张图片）
  - Ctrl+滚轮临时缩放（松开恢复）
  - 滚动时显示页码指示器（底部居中，半透明+blur），停止滚动2秒后自动隐藏
  - 回到顶部按钮（滚动超过3页时显示，右下角圆形按钮）
  - 连续阅读：滚到底部请求下一章（3秒冷却锁），滚到顶部请求上一章
  - 图片加载占位符：灰色背景+页码文字；加载失败：错误图标+重试按钮
  - 图片 fade-in 动画（0.3s）

  基于13个平台调研结论（腾讯动漫/B站/快看/MANGA Plus/Webtoon/Kavita/Komga 等）
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore, type ComicScaleType } from '@renderer/stores';
import { coverPathToUrl } from '@renderer/utils';

const props = withDefaults(
  defineProps<{
    /** 图片文件路径列表（来自 IPC 返回的绝对路径） */
    images: string[];
  }>(),
  {
    images: () => []
  }
);

const emit = defineEmits<{
  /** 滚动进度变化（0~1） */
  (e: 'scroll-progress', progress: number): void;
  /** 请求加载下一章（连续阅读：滚到底部时触发） */
  (e: 'request-next-chapter'): void;
  /** 请求加载上一章（连续阅读：滚到顶部时触发） */
  (e: 'request-prev-chapter'): void;
  /** 当前页码变化（1-based） */
  (e: 'page-change', page: number): void;
}>();

const settings = useSettingsStore();
const { t } = useI18n();

/* ==================== 滚动模式跨章追加（accumulatedImages 无限拼接） ==================== */

/**
 * 累积图片列表：滚动模式跨章追加而非替换。
 * 滚到底部请求下一章后，新章图片追加到尾部，旧章保留，实现连续阅读。
 */
const accumulatedImages = ref<string[]>([]);

/** 是否正在追加下一章（用于 watch props.images 时区分追加和重置） */
let isAppendingNextChapter = false;

/** 当前显示的图片列表（滚动模式用累积列表，空时回退到 props.images） */
const displayImages = computed<string[]>(() => {
  return accumulatedImages.value.length > 0 ? accumulatedImages.value : props.images;
});

/* ==================== 滚动容器 & 图片元素引用 ==================== */

const scrollRef = ref<HTMLDivElement | null>(null);
const scrollImageRefs: (HTMLImageElement | null)[] = [];

/* ==================== 图片加载状态 ==================== */

const imageLoadStates = ref<Record<number, 'loading' | 'loaded' | 'error'>>({});
const retryKeys = ref<Record<number, number>>({});

function onImageLoad(index: number): void {
  imageLoadStates.value[index] = 'loaded';
}

/**
 * smartFit 动态调整：图片加载后根据宽高比动态调整显示方式
 * - 宽高比 < 1（竖图）：fitWidth（宽度填满，高度自适应）
 * - 宽高比 >= 1（横图）：fitScreen（整页可见）
 */
function onImageLoadSmartFit(event: Event, index: number): void {
  if (settings.comicScaleType !== 'smartFit') {
    onImageLoad(index);
    return;
  }
  const img = event.target as HTMLImageElement;
  if (!img.naturalWidth || !img.naturalHeight) {
    onImageLoad(index);
    return;
  }
  const ratio = img.naturalWidth / img.naturalHeight;
  if (ratio < 1) {
    // 竖图：fitWidth（宽度填满，高度自适应）
    img.style.width = '100%';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.maxHeight = 'none';
    img.style.objectFit = 'contain';
  } else {
    // 横图：fitScreen（整页可见）
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
    img.style.width = 'auto';
    img.style.height = 'auto';
    img.style.objectFit = 'contain';
  }
  onImageLoad(index);
}

function onImageError(index: number): void {
  imageLoadStates.value[index] = 'error';
}

function retryImage(index: number): void {
  imageLoadStates.value[index] = 'loading';
  retryKeys.value[index] = (retryKeys.value[index] || 0) + 1;
}

/* ==================== IntersectionObserver 懒加载 ==================== */

let scrollObserver: IntersectionObserver | null = null;
const preloadedUrls = new Set<string>();

function preloadImage(index: number): void {
  const list = displayImages.value;
  if (index < 0 || index >= list.length) return;
  const url = coverPathToUrl(list[index]);
  if (!url || preloadedUrls.has(url)) return;
  preloadedUrls.add(url);
  const img = new Image();
  img.src = url;
}

function initScrollObserver(): void {
  if (scrollObserver) {
    scrollObserver.disconnect();
  }
  if (!scrollRef.value) return;
  // rootMargin 扩展可视区上下各2屏，提前预加载即将进入的图片
  scrollObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const index = Number((entry.target as HTMLElement).dataset.index);
          if (!Number.isNaN(index)) {
            // 预加载当前图片及相邻 ±2 张
            preloadImage(index);
            preloadImage(index + 1);
            preloadImage(index + 2);
            preloadImage(index - 1);
            preloadImage(index - 2);
          }
        }
      }
    },
    {
      root: scrollRef.value,
      rootMargin: '200% 0px 200% 0px',
      threshold: 0
    }
  );
  nextTick(() => {
    for (const img of scrollImageRefs) {
      if (img && scrollObserver) {
        scrollObserver.observe(img);
      }
    }
  });
}

/* ==================== 页码指示器 ==================== */

const scrollCurrentPage = ref<number>(1);
const scrollIndicatorVisible = ref<boolean>(false);
let scrollIndicatorTimer: ReturnType<typeof setTimeout> | null = null;
const SCROLL_INDICATOR_DELAY = 2000;

function computeScrollCurrentPage(): number {
  const list = displayImages.value;
  if (!scrollRef.value || list.length === 0) return 1;
  const el = scrollRef.value;
  const containerRect = el.getBoundingClientRect();
  // 视口中线偏上位置（容器顶部 40% 处）作为"当前页"判定基准
  const midLine = containerRect.top + containerRect.height * 0.4;
  for (let i = 0; i < scrollImageRefs.length; i++) {
    const img = scrollImageRefs[i];
    if (!img) continue;
    const rect = img.getBoundingClientRect();
    if (midLine >= rect.top && midLine < rect.bottom) {
      return i + 1;
    }
    if (midLine < rect.top) {
      return Math.max(1, i);
    }
  }
  return list.length;
}

function showScrollIndicator(): void {
  scrollIndicatorVisible.value = true;
  if (scrollIndicatorTimer) {
    clearTimeout(scrollIndicatorTimer);
  }
  scrollIndicatorTimer = setTimeout(() => {
    scrollIndicatorVisible.value = false;
    scrollIndicatorTimer = null;
  }, SCROLL_INDICATOR_DELAY);
}

/* ==================== 回到顶部按钮 ==================== */

const backToTopVisible = ref<boolean>(false);
const BACK_TO_TOP_THRESHOLD_PAGES = 3;

/**
 * scrollToTop 跳过 request-prev-chapter 的标志位。
 *
 * 问题：用户点击"回到顶部"按钮后，smooth 滚动会经过 onScroll → checkContinuousReading，
 * 当 scrollTop 到达 0 时会误触发 request-prev-chapter 加载上一章。
 *
 * 修复：scrollToTop 时设置此标志位，checkContinuousReading 检测到则跳过 prev-chapter。
 * 用定时器在 smooth 滚动结束后自动清理，确保标志位不会永久卡死（覆盖所有退出路径）。
 */
let skipPrevChapterByScrollToTop = false;
let skipPrevChapterTimer: ReturnType<typeof setTimeout> | null = null;
/** smooth 滚动最长持续时间（ms），超过此时长强制清理标志位 */
const SCROLL_TO_TOP_GUARD_MS = 800;

function scrollToTop(): void {
  if (!scrollRef.value) return;
  // 设置跳过标志位，防止 smooth 滚动到顶部时误触发 request-prev-chapter
  skipPrevChapterByScrollToTop = true;
  if (skipPrevChapterTimer) clearTimeout(skipPrevChapterTimer);
  skipPrevChapterTimer = setTimeout(() => {
    skipPrevChapterByScrollToTop = false;
    skipPrevChapterTimer = null;
  }, SCROLL_TO_TOP_GUARD_MS);
  scrollRef.value.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ==================== 连续阅读 ==================== */

let continuousReadingLock = false;
let continuousReadingUnlockTimer: ReturnType<typeof setTimeout> | null = null;
let userHasScrolled = false;
const CONTINUOUS_READ_THRESHOLD = 50;

function checkContinuousReading(): void {
  if (!scrollRef.value) return;
  if (continuousReadingLock) return;

  const el = scrollRef.value;
  const maxScroll = el.scrollHeight - el.clientHeight;
  if (maxScroll <= 0) return;

  // 滚到底部：请求下一章
  if (el.scrollTop >= maxScroll - CONTINUOUS_READ_THRESHOLD) {
    continuousReadingLock = true;
    // 标记正在追加下一章，watch props.images 时将新章追加而非重置
    isAppendingNextChapter = true;
    emit('request-next-chapter');
    if (continuousReadingUnlockTimer) clearTimeout(continuousReadingUnlockTimer);
    continuousReadingUnlockTimer = setTimeout(() => {
      continuousReadingLock = false;
      continuousReadingUnlockTimer = null;
    }, 3000);
  }
  // 滚到顶部：仅当用户确实从下方滚回顶部时才触发（避免初始加载误触发）
  // 跳过 scrollToTop 引发的滚动（用户点击回到顶部按钮，不应加载上一章）
  if (userHasScrolled && el.scrollTop === 0 && !skipPrevChapterByScrollToTop) {
    continuousReadingLock = true;
    emit('request-prev-chapter');
    if (continuousReadingUnlockTimer) clearTimeout(continuousReadingUnlockTimer);
    continuousReadingUnlockTimer = setTimeout(() => {
      continuousReadingLock = false;
      continuousReadingUnlockTimer = null;
    }, 3000);
  }
}

/* ==================== 滚动事件 ==================== */

let scrollRafId: number | null = null;

function onScroll(): void {
  if (scrollRafId !== null) return;
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    if (!scrollRef.value) return;
    const el = scrollRef.value;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 0) {
      emit('scroll-progress', 0);
      return;
    }
    if (el.scrollTop > 0) {
      userHasScrolled = true;
    }
    const progress = Math.max(0, Math.min(1, el.scrollTop / maxScroll));
    emit('scroll-progress', progress);
    checkContinuousReading();
    const newPage = computeScrollCurrentPage();
    if (newPage !== scrollCurrentPage.value) {
      scrollCurrentPage.value = newPage;
      emit('page-change', newPage);
    }
    showScrollIndicator();
    backToTopVisible.value = scrollCurrentPage.value > BACK_TO_TOP_THRESHOLD_PAGES;
  });
}

/* ==================== Ctrl+滚轮临时缩放 ==================== */

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const zoomScale = ref<number>(1);
const zoomIndicatorVisible = ref<boolean>(false);
const zoomIndicatorScale = ref<number>(1);
let zoomIndicatorTimer: ReturnType<typeof setTimeout> | null = null;
const ZOOM_INDICATOR_DELAY = 2000;

function showZoomIndicator(): void {
  zoomIndicatorVisible.value = true;
  if (zoomIndicatorTimer) {
    clearTimeout(zoomIndicatorTimer);
  }
  zoomIndicatorTimer = setTimeout(() => {
    zoomIndicatorVisible.value = false;
    zoomIndicatorTimer = null;
  }, ZOOM_INDICATOR_DELAY);
}

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return;
  event.preventDefault();
  const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
  const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomScale.value + delta));
  zoomScale.value = newScale;
  zoomIndicatorScale.value = newScale;
  showZoomIndicator();
}

/* ==================== 按图片索引的缩放状态（双指/双击/拖拽） ==================== */
/*
 * 设计说明（避免性能反模式）：
 * - 不用 translate3d 逐图合成（会导致 GPU 内存爆炸），用 transform: scale() translate() 即可
 * - scrollImageStyle computed 只依赖 settings.comicScaleType，不依赖 scrollPosition（避免每帧重算）
 * - 缩放状态按图片索引存储，只有被操作的图片才有状态，不对所有图片同时应用缩放
 * - 与全局 Ctrl+滚轮缩放（zoomScale）共存：独立缩放优先，否则回退到全局缩放
 */

interface ImageZoomState {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** 按图片索引存储的缩放状态（双指缩放/双击放大/拖拽平移产生） */
const imageZoomStates = ref<Record<number, ImageZoomState>>({});

/** 获取指定图片的缩放状态（未设置则返回默认 1x） */
function getImageZoomState(index: number): ImageZoomState {
  return imageZoomStates.value[index] || { scale: 1, offsetX: 0, offsetY: 0 };
}

/** 设置图片缩放（带可选中心点，用于双指/双击缩放） */
function setZoom(index: number, scale: number, centerX?: number, centerY?: number): void {
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
  const prev = imageZoomStates.value[index] || { scale: 1, offsetX: 0, offsetY: 0 };
  // 以中心点缩放时，按比例调整偏移以保持视觉中心大致不动
  let offsetX = prev.offsetX;
  let offsetY = prev.offsetY;
  if (centerX !== undefined && centerY !== undefined && prev.scale > 0) {
    const ratio = clamped / prev.scale;
    offsetX = prev.offsetX * ratio;
    offsetY = prev.offsetY * ratio;
  }
  imageZoomStates.value[index] = { scale: clamped, offsetX, offsetY };
  zoomIndicatorScale.value = clamped;
  showZoomIndicator();
}

/**
 * 获取图片 wrapper 的 transform 样式。
 * 优先级：独立缩放（双指/双击）> 全局 Ctrl+滚轮缩放 > 无变换。
 * 注意：用 translate() 而非 translate3d()，避免逐图 GPU 合成层内存爆炸。
 */
function getImageTransform(index: number): string {
  const state = getImageZoomState(index);
  if (state.scale > 1) {
    return `scale(${state.scale}) translate(${state.offsetX}px, ${state.offsetY}px)`;
  }
  if (zoomScale.value > 1) {
    return `scale(${zoomScale.value})`;
  }
  return 'none';
}

/* ==================== 双击放大 ==================== */

/** 双击在 1x ↔ 2x 之间切换 */
function onImageDoubleClick(event: MouseEvent, index: number): void {
  const DOUBLE_CLICK_SCALE = 2;
  const state = getImageZoomState(index);
  if (state.scale > 1) {
    // 当前已放大，复位到 1x
    imageZoomStates.value[index] = { scale: 1, offsetX: 0, offsetY: 0 };
    zoomIndicatorScale.value = 1;
  } else {
    // 当前 1x，放大到 2x（以双击位置为中心）
    setZoom(index, DOUBLE_CLICK_SCALE, event.clientX, event.clientY);
  }
}

/* ==================== 触屏双指缩放 (Pinch-to-Zoom) ==================== */

interface TouchPinchState {
  /** 初始两指距离（px） */
  initialDistance: number;
  /** 初始缩放比例 */
  initialScale: number;
  /** 缩放中心点（屏幕坐标，两指中点） */
  centerX: number;
  centerY: number;
  /** 关联的图片索引 */
  imageIndex: number;
}

/** 单指拖动状态（触屏，放大后单指拖动平移） */
interface TouchDragState {
  startX: number;
  startY: number;
  startOffsetX: number;
  startOffsetY: number;
  imageIndex: number;
}

/** 当前 pinch 状态，null 表示未进行双指缩放 */
let pinchState: TouchPinchState | null = null;
/** 当前单指拖动状态，null 表示未拖动 */
let touchDragState: TouchDragState | null = null;

/** 计算两点间距离 */
function touchDistance(t1: Touch, t2: Touch): number {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 计算两点中点 */
function touchMidpoint(t1: Touch, t2: Touch): { x: number; y: number } {
  return {
    x: (t1.clientX + t2.clientX) / 2,
    y: (t1.clientY + t2.clientY) / 2
  };
}

/**
 * 触摸开始
 * - 双指：初始化 pinch-to-zoom
 * - 单指（已放大）：初始化拖动平移
 */
function onTouchStart(event: TouchEvent, index: number): void {
  if (event.touches.length === 2) {
    const t1 = event.touches[0];
    const t2 = event.touches[1];
    const dist = touchDistance(t1, t2);
    if (dist < 10) return;
    const mid = touchMidpoint(t1, t2);
    pinchState = {
      initialDistance: dist,
      initialScale: getImageZoomState(index).scale,
      centerX: mid.x,
      centerY: mid.y,
      imageIndex: index
    };
    touchDragState = null;
    event.preventDefault();
  } else if (event.touches.length === 1) {
    const state = getImageZoomState(index);
    if (state.scale > 1) {
      const t = event.touches[0];
      touchDragState = {
        startX: t.clientX,
        startY: t.clientY,
        startOffsetX: state.offsetX,
        startOffsetY: state.offsetY,
        imageIndex: index
      };
    }
  }
}

/** 触摸移动：双指缩放或单指拖动平移 */
function onTouchMove(event: TouchEvent, _index: number): void {
  if (pinchState && event.touches.length === 2) {
    const t1 = event.touches[0];
    const t2 = event.touches[1];
    const dist = touchDistance(t1, t2);
    if (dist < 10 || pinchState.initialDistance < 10) return;
    const ratio = dist / pinchState.initialDistance;
    const newScale = pinchState.initialScale * ratio;
    const mid = touchMidpoint(t1, t2);
    pinchState.centerX = mid.x;
    pinchState.centerY = mid.y;
    setZoom(pinchState.imageIndex, newScale, mid.x, mid.y);
    event.preventDefault();
  } else if (touchDragState && event.touches.length === 1) {
    const t = event.touches[0];
    const dx = t.clientX - touchDragState.startX;
    const dy = t.clientY - touchDragState.startY;
    const idx = touchDragState.imageIndex;
    const state = imageZoomStates.value[idx] || { scale: 1, offsetX: 0, offsetY: 0 };
    imageZoomStates.value[idx] = {
      scale: state.scale,
      offsetX: touchDragState.startOffsetX + dx,
      offsetY: touchDragState.startOffsetY + dy
    };
    event.preventDefault();
  }
}

/** 触摸结束：清理 pinch/drag 状态 */
function onTouchEnd(event: TouchEvent): void {
  if (event.touches.length < 2) {
    pinchState = null;
  }
  if (event.touches.length === 0) {
    touchDragState = null;
  }
}

/* ==================== 放大后拖拽平移（鼠标） ==================== */

const isDragging = ref<boolean>(false);
let draggingImageIndex = -1;
let dragStartX = 0;
let dragStartY = 0;
let dragStartOffsetX = 0;
let dragStartOffsetY = 0;

/** 拖动开始（仅放大后可拖动） */
function onDragStart(event: MouseEvent, index: number): void {
  const state = getImageZoomState(index);
  if (state.scale <= 1) return;
  isDragging.value = true;
  draggingImageIndex = index;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  dragStartOffsetX = state.offsetX;
  dragStartOffsetY = state.offsetY;
  event.preventDefault();
}

/** 拖动中：更新平移偏移 */
function onDragMove(event: MouseEvent): void {
  if (!isDragging.value) return;
  const dx = event.clientX - dragStartX;
  const dy = event.clientY - dragStartY;
  const state = imageZoomStates.value[draggingImageIndex] || { scale: 1, offsetX: 0, offsetY: 0 };
  imageZoomStates.value[draggingImageIndex] = {
    scale: state.scale,
    offsetX: dragStartOffsetX + dx,
    offsetY: dragStartOffsetY + dy
  };
}

/** 拖动结束 */
function onDragEnd(): void {
  isDragging.value = false;
  draggingImageIndex = -1;
}

/* ==================== 图片样式（按缩放类型） ==================== */

const scrollImageStyle = computed<Record<string, string>>(() => {
  const type = settings.comicScaleType as ComicScaleType;
  switch (type) {
    case 'fitWidth':
      return { width: '100%', maxWidth: '100%', height: 'auto', maxHeight: 'none', objectFit: 'contain' };
    case 'fitScreen':
      return { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' };
    case 'original':
      return { width: 'auto', height: 'auto', maxWidth: 'none', maxHeight: 'none', objectFit: 'none' };
    case 'smartFit':
      return { width: '100%', maxWidth: '100%', height: 'auto', maxHeight: 'none', objectFit: 'contain' };
    default:
      return { width: '100%', maxWidth: '100%', height: 'auto', maxHeight: 'none', objectFit: 'contain' };
  }
});

/* ==================== 监听图片列表变化 ==================== */

watch(
  () => props.images,
  () => {
    // 滚动模式跨章追加：将新章图片追加到累积列表，不重置已有状态
    if (isAppendingNextChapter && props.images.length > 0) {
      isAppendingNextChapter = false;
      accumulatedImages.value = [...accumulatedImages.value, ...props.images];
      // 重新初始化 Observer 以观察新追加的图片
      nextTick(() => initScrollObserver());
      return;
    }

    // 非追加场景（切书/跳章）：重置累积列表和所有状态
    isAppendingNextChapter = false;
    accumulatedImages.value = [...props.images];
    imageLoadStates.value = {};
    retryKeys.value = {};
    imageZoomStates.value = {};
    userHasScrolled = false;
    preloadedUrls.clear();
    scrollImageRefs.length = 0;
    scrollCurrentPage.value = 1;
    pinchState = null;
    touchDragState = null;
    nextTick(() => initScrollObserver());
  }
);

/* ==================== 生命周期 ==================== */

onMounted(() => {
  // 初始化累积图片列表，使 displayImages 立即生效
  accumulatedImages.value = [...props.images];
  nextTick(() => initScrollObserver());
});

onBeforeUnmount(() => {
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
  if (scrollIndicatorTimer) {
    clearTimeout(scrollIndicatorTimer);
    scrollIndicatorTimer = null;
  }
  if (zoomIndicatorTimer) {
    clearTimeout(zoomIndicatorTimer);
    zoomIndicatorTimer = null;
  }
  if (continuousReadingUnlockTimer) {
    clearTimeout(continuousReadingUnlockTimer);
    continuousReadingUnlockTimer = null;
  }
  if (skipPrevChapterTimer) {
    clearTimeout(skipPrevChapterTimer);
    skipPrevChapterTimer = null;
  }
  scrollImageRefs.length = 0;
  if (scrollRafId !== null) {
    cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  }
});

/* ==================== 暴露方法 ==================== */

defineExpose({
  /** 滚动到指定页（1-based） */
  goToPage(page: number): void {
    if (!scrollRef.value) return;
    const target = scrollImageRefs[page - 1];
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  },
  /** 获取当前归一化滚动进度（0~1） */
  getCurrentPosition(): number {
    if (!scrollRef.value) return 0;
    const el = scrollRef.value;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 0) return 0;
    return Math.max(0, Math.min(1, el.scrollTop / maxScroll));
  },
  /** 获取当前页码（1-based） */
  getCurrentPage(): number {
    return scrollCurrentPage.value;
  }
});
</script>

<template>
  <div class="comic-scroll-container">
    <!-- 滚动区 -->
    <div
      ref="scrollRef"
      class="comic-scroll"
      @scroll="onScroll"
      @wheel="onWheel"
      @mousemove="onDragMove"
      @mouseup="onDragEnd"
      @mouseleave="onDragEnd"
    >
      <div
        v-for="(img, i) in displayImages"
        :key="`${i}-${retryKeys[i] || 0}`"
        class="comic-image-wrapper"
        :class="{ dragging: isDragging && draggingImageIndex === i }"
        :data-index="i"
        :style="{
          '--comic-image-gap': `${settings.comicImageGap || 0}px`,
          transform: getImageTransform(i),
          cursor: getImageZoomState(i).scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default'
        }"
      >
        <!-- 加载中占位符：灰色背景+页码文字 -->
        <div v-if="!imageLoadStates[i] || imageLoadStates[i] === 'loading'" class="comic-placeholder-loading">
          <span class="comic-placeholder-page">{{
            t('comic.page.ofTotal', { current: i + 1, total: displayImages.length })
          }}</span>
        </div>
        <!-- 加载失败：错误图标+重试按钮 -->
        <div v-if="imageLoadStates[i] === 'error'" class="comic-placeholder-error">
          <span class="comic-error-icon">⚠</span>
          <span class="comic-placeholder-text">{{ t('comic.imageLoadError') }}</span>
          <span class="comic-placeholder-page">{{
            t('comic.page.ofTotal', { current: i + 1, total: displayImages.length })
          }}</span>
          <button class="comic-retry-btn" @click="retryImage(i)">{{ t('common.actions.retry') }}</button>
        </div>
        <img
          :ref="
            (el) => {
              if (el) scrollImageRefs[i] = el as HTMLImageElement;
            }
          "
          :src="coverPathToUrl(img)"
          :alt="t('comic.page.short', { n: i + 1 })"
          loading="lazy"
          :data-index="i"
          :style="scrollImageStyle"
          :class="{ loaded: imageLoadStates[i] === 'loaded' }"
          @load="settings.comicScaleType === 'smartFit' ? onImageLoadSmartFit($event, i) : onImageLoad(i)"
          @error="onImageError(i)"
          @dblclick.stop="onImageDoubleClick($event, i)"
          @touchstart="onTouchStart($event, i)"
          @touchmove="onTouchMove($event, i)"
          @touchend.passive="onTouchEnd($event)"
          @mousedown="onDragStart($event, i)"
        />
      </div>
    </div>

    <!-- 页码指示器（底部居中，半透明+blur） -->
    <Transition name="indicator-fade">
      <div v-if="scrollIndicatorVisible && displayImages.length > 0" class="scroll-page-indicator">
        {{ scrollCurrentPage }} / {{ displayImages.length }}
      </div>
    </Transition>

    <!-- 回到顶部按钮（右下角圆形） -->
    <Transition name="indicator-fade">
      <button v-if="backToTopVisible" class="back-to-top-btn" :title="t('comic.backToTop')" @click="scrollToTop">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M12 5l-7 7h4v7h6v-7h4z" fill="currentColor" />
        </svg>
      </button>
    </Transition>

    <!-- 缩放比例指示器 -->
    <Transition name="indicator-fade">
      <div v-if="zoomIndicatorVisible && zoomIndicatorScale > 1" class="zoom-indicator">
        {{ Math.round(zoomIndicatorScale * 100) }}%
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.comic-scroll-container {
  width: 100%;
  height: 100%;
  background: var(--reader-bg, #000);
  position: relative;
  overflow: hidden;
}

.comic-scroll {
  flex: 1;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.comic-image-wrapper {
  width: 100%;
  display: flex;
  justify-content: center;
  position: relative;
  transform-origin: center center;
  transition: transform 0.15s ease;
  /* 图片间距：通过 CSS 变量由 settings.comicImageGap 控制（0/2/4px） */
  margin-bottom: var(--comic-image-gap, 0px);
}

/* 最后一张图片不需要底部间距 */
.comic-image-wrapper:last-child {
  margin-bottom: 0;
}

/* 拖拽中禁用过渡，保证平移跟手 */
.comic-image-wrapper.dragging {
  transition: none;
}

.comic-image-wrapper img {
  display: block;
  max-width: 100%;
  height: auto;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.comic-image-wrapper img.loaded {
  opacity: 1;
}

/* 加载占位符：灰色背景+页码文字 */
.comic-placeholder-loading {
  position: absolute;
  inset: 0;
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(128, 128, 128, 0.1);
  z-index: 1;
}

.comic-placeholder-page {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.55);
  letter-spacing: 0.5px;
}

/* 加载失败占位符 */
.comic-placeholder-error {
  position: absolute;
  inset: 0;
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(128, 128, 128, 0.1);
  color: rgba(255, 255, 255, 0.5);
  z-index: 2;
  gap: 8px;
}

.comic-error-icon {
  font-size: 28px;
  margin-bottom: 4px;
}

.comic-placeholder-text {
  font-size: 14px;
}

.comic-retry-btn {
  margin-top: 8px;
  padding: 6px 16px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.comic-retry-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.5);
}

/* 页码指示器 */
.scroll-page-indicator {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 5px 14px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: rgba(255, 255, 255, 0.9);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.5px;
  pointer-events: none;
  user-select: none;
  z-index: 20;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

/* 回到顶部按钮 */
.back-to-top-btn {
  position: absolute;
  bottom: 24px;
  right: 24px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: rgba(255, 255, 255, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 20;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: all 0.2s ease;
  padding: 0;
}

.back-to-top-btn:hover {
  background: rgba(0, 0, 0, 0.7);
  color: rgba(255, 255, 255, 1);
  transform: scale(1.05);
}

.back-to-top-btn:active {
  transform: scale(0.95);
}

/* 缩放比例指示器 */
.zoom-indicator {
  position: absolute;
  bottom: 16px;
  right: 16px;
  padding: 5px 14px;
  background: rgba(0, 0, 0, 0.6);
  color: rgba(255, 255, 255, 0.9);
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.5px;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: 30;
  pointer-events: none;
  user-select: none;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

/* fade-in/out 动画 */
.indicator-fade-enter-active,
.indicator-fade-leave-active {
  transition: opacity 0.25s ease;
}

.indicator-fade-enter-from,
.indicator-fade-leave-to {
  opacity: 0;
}
</style>
