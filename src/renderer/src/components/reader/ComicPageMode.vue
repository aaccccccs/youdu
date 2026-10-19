<!--
  漫画翻页模式组件（精简版）

  功能：
  - 单页/双页显示，object-fit: contain 保持比例，纯黑背景
  - 双页展开模式：宽屏(>=800px)时左右两页同时显示，窄屏自动切单页，封面单独显示
  - 点击分区 25/50/25：左25%上一页，右25%下一页，中间50% emit('toggle-toolbar')
  - RTL 模式：左25%下一页，右25%上一页
  - 键盘 ←/→ 翻页（RTL时反向），Space 下一页
  - 翻页动画 slide/fade/none（从 settings 读取），时长可配置
  - Ctrl+滚轮缩放、双击放大/复位、触屏双指缩放(Pinch-to-Zoom)
  - 放大后鼠标拖拽平移、触屏单指拖动平移
  - 单击零延迟响应（用浏览器原生 dblclick 检测双击）
  - 页码指示器（底部居中，半透明+blur，显示 "3 / 30" 或双页 "3-4 / 30"）
  - 图片加载占位符：灰色背景+页码文字；加载失败：错误图标+重试按钮
  - 图片 fade-in 动画
  - 跨章翻页：翻到头/尾时 emit 请求上/下一章

  基于13个平台调研结论（MANGA Plus/Kavita/Komga/Tachiyomi 等）
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore, type ComicScaleType, type ComicPageTurnAnimationType } from '@renderer/stores';
import { coverPathToUrl } from '@renderer/utils';

const props = withDefaults(
  defineProps<{
    /** 图片文件路径列表 */
    images: string[];
    /** 阅读方向，默认 'ltr' */
    readDirection?: 'ltr' | 'rtl';
  }>(),
  {
    images: () => [],
    readDirection: 'ltr'
  }
);

const emit = defineEmits<{
  /** 当前页码变化（1-based） */
  (e: 'page-change', page: number): void;
  /** 翻到最后一页再往后翻 */
  (e: 'request-next-chapter'): void;
  /** 翻到第一页再往前翻 */
  (e: 'request-prev-chapter'): void;
  /** 中间50%区域点击时触发 */
  (e: 'toggle-toolbar'): void;
}>();

const settings = useSettingsStore();
const { t } = useI18n();

/* ==================== 翻页状态 ==================== */

/** 当前页码（0-based） */
const currentPage = ref<number>(0);
/** 翻页动画方向，用于触发翻页动画 */
const turnDirection = ref<'next' | 'prev' | null>(null);
let isTurningPage = false;
let pageTurnTimer: ReturnType<typeof setTimeout> | null = null;

/** 跨章翻页方向，用于 watch images 变化时设置正确的起始页 */
const crossChapterDirection = ref<'next' | 'prev' | null>(null);

const isRtl = computed<boolean>(() => props.readDirection === 'rtl');
const totalPages = computed<number>(() => props.images.length || 1);

/* ==================== 双页展开模式 ==================== */

/** 容器宽度（px），通过 ResizeObserver 实时更新 */
const containerWidth = ref<number>(0);
/** 容器宽度监听器 */
let resizeObserver: ResizeObserver | null = null;
/** 双页模式启用宽度阈值（px），宽屏(>=800px)时才启用双页 */
const DOUBLE_PAGE_MIN_WIDTH = 800;

/** 是否为宽屏 */
const isWideScreen = computed<boolean>(() => containerWidth.value >= DOUBLE_PAGE_MIN_WIDTH);

/**
 * 实际是否启用双页模式
 * - 用户开启双页模式（settings.comicDoublePage）
 * - 宽屏（>=800px）
 * - 非封面页（第0页单独显示，不与其他页并排）
 */
const effectiveDoublePage = computed<boolean>(() => {
  if (!settings.comicDoublePage) return false;
  if (!isWideScreen.value) return false;
  // 封面（第0页）单独显示
  if (currentPage.value === 0) return false;
  return true;
});

/**
 * 双页模式下的左右页图片索引
 * - ltr：左页=当前，右页=当前+1
 * - rtl：右页=当前（奇数页在右），左页=当前+1
 * @returns { left, right } 图片索引，null 表示该侧无图片
 */
const doublePageIndices = computed<{ left: number | null; right: number | null }>(() => {
  if (!effectiveDoublePage.value) {
    return { left: null, right: null };
  }
  const base = currentPage.value;
  if (isRtl.value) {
    // 右到左：右页=base，左页=base+1
    return {
      right: base >= 0 && base < totalPages.value ? base : null,
      left: base + 1 >= 0 && base + 1 < totalPages.value ? base + 1 : null
    };
  }
  // 左到右：左页=base，右页=base+1
  return {
    left: base >= 0 && base < totalPages.value ? base : null,
    right: base + 1 >= 0 && base + 1 < totalPages.value ? base + 1 : null
  };
});

/** 页码指示器文本，双页模式显示 "3-4 / 30"，单页显示 "3 / 30" */
const pageIndicatorText = computed<string>(() => {
  if (effectiveDoublePage.value) {
    const { left, right } = doublePageIndices.value;
    if (left !== null && right !== null) {
      // rtl 阅读顺序从右到左：右页（较小页码）在前，左页（较大页码）在后
      // ltr 阅读顺序从左到右：左页（较小页码）在前，右页（较大页码）在后
      if (isRtl.value) {
        return `${right + 1}-${left + 1} / ${totalPages.value}`;
      }
      return `${left + 1}-${right + 1} / ${totalPages.value}`;
    }
    const shown = left ?? right;
    if (shown !== null) return `${shown + 1} / ${totalPages.value}`;
  }
  return `${currentPage.value + 1} / ${totalPages.value}`;
});

/* ==================== 图片加载状态 ==================== */

const imageLoadStates = ref<Record<number, 'loading' | 'loaded' | 'error'>>({});
const retryKeys = ref<Record<number, number>>({});

function onImageLoad(index: number): void {
  imageLoadStates.value[index] = 'loaded';
}

function onImageError(index: number): void {
  imageLoadStates.value[index] = 'error';
}

function retryImage(index: number): void {
  imageLoadStates.value[index] = 'loading';
  retryKeys.value[index] = (retryKeys.value[index] || 0) + 1;
}

/* ==================== 图片预加载 ==================== */

const preloadedUrls = new Set<string>();

function preloadImage(index: number): void {
  if (index < 0 || index >= props.images.length) return;
  const url = coverPathToUrl(props.images[index]);
  if (!url || preloadedUrls.has(url)) return;
  preloadedUrls.add(url);
  const img = new Image();
  img.src = url;
}

function preloadAdjacentPages(): void {
  const base = currentPage.value;
  // 预加载当前页 ±2 页
  for (let i = 1; i <= 2; i++) {
    preloadImage(base + i);
    preloadImage(base - i);
  }
}

/* ==================== 翻页操作 ==================== */

/** 翻页动画时长（ms），从 settings 读取 */
const pageTurnDuration = computed<number>(() => settings.comicPageTurnDuration || 200);

function nextPage(): void {
  if (isTurningPage) return;
  if (currentPage.value < totalPages.value - 1) {
    isTurningPage = true;
    turnDirection.value = 'next';
    // 双页模式步长为2，单页步长为1
    const step = effectiveDoublePage.value ? 2 : 1;
    currentPage.value = Math.min(totalPages.value - 1, currentPage.value + step);
    if (pageTurnTimer) clearTimeout(pageTurnTimer);
    pageTurnTimer = setTimeout(() => {
      turnDirection.value = null;
      isTurningPage = false;
      pageTurnTimer = null;
    }, pageTurnDuration.value);
  } else {
    // 翻到最后一页再往后翻：请求下一章
    crossChapterDirection.value = 'next';
    emit('request-next-chapter');
  }
}

function prevPage(): void {
  if (isTurningPage) return;
  if (currentPage.value > 0) {
    isTurningPage = true;
    turnDirection.value = 'prev';
    // 双页模式步长为2，单页步长为1
    const step = effectiveDoublePage.value ? 2 : 1;
    currentPage.value = Math.max(0, currentPage.value - step);
    if (pageTurnTimer) clearTimeout(pageTurnTimer);
    pageTurnTimer = setTimeout(() => {
      turnDirection.value = null;
      isTurningPage = false;
      pageTurnTimer = null;
    }, pageTurnDuration.value);
  } else {
    // 翻到第一页再往前翻：请求上一章
    crossChapterDirection.value = 'prev';
    emit('request-prev-chapter');
  }
}

function goToPage(page: number): void {
  currentPage.value = Math.max(0, Math.min(totalPages.value - 1, page));
}

/* ==================== 点击分区翻页 ==================== */

/**
 * 单击翻页：200ms 延迟区分双击
 * - 左25% / 右25%：翻页（放大状态下不翻页）
 * - 中间50%：切换工具栏
 * 双击时第二次 click 取消单击，dblclick 触发缩放，不会误翻页
 */
let clickTimer: ReturnType<typeof setTimeout> | null = null;
const CLICK_DELAY = 200;

function onPageClick(event: MouseEvent): void {
  // 第二次点击（双击的第二次）：取消单击，让 dblclick 处理缩放
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    return;
  }

  const target = event.currentTarget as HTMLDivElement;
  const rect = target.getBoundingClientRect();
  const x = event.clientX - rect.left;
  // 三区域手势翻页：左25% / 中50% / 右25%
  const isLeftZone = x < rect.width * 0.25;
  const isRightZone = x > rect.width * 0.75;

  clickTimer = setTimeout(() => {
    clickTimer = null;
    // 中间50% 区域：切换工具栏显示/隐藏
    if (!isLeftZone && !isRightZone) {
      emit('toggle-toolbar');
      return;
    }
    // 放大状态下不翻页（拖拽平移由 mousedown 处理）
    if (zoomScale.value > 1) return;
    if (isRtl.value) {
      // 右到左：左25% 下一页，右25% 上一页
      if (isLeftZone) nextPage();
      else prevPage();
    } else {
      // 左到右：左25% 上一页，右25% 下一页
      if (isLeftZone) prevPage();
      else nextPage();
    }
  }, CLICK_DELAY);
}

/* ==================== Ctrl+滚轮缩放 & 双击放大 & 拖拽平移 & 触屏缩放 ==================== */

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const zoomScale = ref<number>(1);
/** 缩放后平移偏移 X（px） */
const zoomOffsetX = ref<number>(0);
/** 缩放后平移偏移 Y（px） */
const zoomOffsetY = ref<number>(0);
const zoomIndicatorVisible = ref<boolean>(false);
const zoomIndicatorScale = ref<number>(1);
let zoomIndicatorTimer: ReturnType<typeof setTimeout> | null = null;
const ZOOM_INDICATOR_DELAY = 2000;

/** 是否正在鼠标拖拽平移 */
const isDragging = ref<boolean>(false);
let dragStartX = 0;
let dragStartY = 0;
let dragStartOffsetX = 0;
let dragStartOffsetY = 0;

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

/**
 * 设置缩放比例（支持以指定点为中心缩放）
 * @param newScale 目标缩放比例
 * @param mouseX 缩放中心 X（屏幕坐标），可选
 * @param mouseY 缩放中心 Y（屏幕坐标），可选
 */
function setZoom(newScale: number, mouseX?: number, mouseY?: number): void {
  const oldScale = zoomScale.value;
  const clampedScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newScale));

  let newOffsetX: number;
  let newOffsetY: number;

  if (mouseX !== undefined && mouseY !== undefined && oldScale > 0) {
    // 以鼠标位置为中心缩放
    const element = document.querySelector(
      '.comic-page-image-wrapper, .comic-double-page-wrapper'
    ) as HTMLElement | null;
    if (element) {
      const rect = element.getBoundingClientRect();
      // 变换后元素中心屏幕坐标
      const cxScreen = rect.left + rect.width / 2;
      const cyScreen = rect.top + rect.height / 2;
      // 保持鼠标位置不变的新偏移
      newOffsetX =
        (mouseX - cxScreen) * (1 / clampedScale - 1 / oldScale) + (zoomOffsetX.value * oldScale) / clampedScale;
      newOffsetY =
        (mouseY - cyScreen) * (1 / clampedScale - 1 / oldScale) + (zoomOffsetY.value * oldScale) / clampedScale;
    } else {
      newOffsetX = (zoomOffsetX.value * oldScale) / clampedScale;
      newOffsetY = (zoomOffsetY.value * oldScale) / clampedScale;
    }
  } else {
    // 以图片中心缩放
    newOffsetX = oldScale > 0 ? (zoomOffsetX.value * oldScale) / clampedScale : 0;
    newOffsetY = oldScale > 0 ? (zoomOffsetY.value * oldScale) / clampedScale : 0;
  }

  // 缩放回 1x 时重置偏移
  if (clampedScale === 1) {
    newOffsetX = 0;
    newOffsetY = 0;
  }

  zoomScale.value = clampedScale;
  zoomOffsetX.value = newOffsetX;
  zoomOffsetY.value = newOffsetY;
}

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return;
  event.preventDefault();
  const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
  const newScale = zoomScale.value + delta;
  setZoom(newScale, event.clientX, event.clientY);
  zoomIndicatorScale.value = zoomScale.value;
  showZoomIndicator();
}

function onImageDoubleClick(event: MouseEvent): void {
  // 清除单击定时器，避免双击后还触发单击翻页
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
  const DOUBLE_CLICK_SCALE = 2;
  if (zoomScale.value > 1) {
    // 当前已放大，复位到 1x
    setZoom(1);
  } else {
    // 当前 1x，放大到 2x（以双击位置为中心）
    setZoom(DOUBLE_CLICK_SCALE, event.clientX, event.clientY);
    zoomIndicatorScale.value = DOUBLE_CLICK_SCALE;
    showZoomIndicator();
  }
}

/* ==================== 鼠标拖拽平移（放大后可拖动） ==================== */

function onDragStart(event: MouseEvent): void {
  // 仅放大后可拖动
  if (zoomScale.value <= 1) return;
  isDragging.value = true;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  dragStartOffsetX = zoomOffsetX.value;
  dragStartOffsetY = zoomOffsetY.value;
  event.preventDefault();
}

function onDragMove(event: MouseEvent): void {
  if (!isDragging.value) return;
  const dx = event.clientX - dragStartX;
  const dy = event.clientY - dragStartY;
  zoomOffsetX.value = dragStartOffsetX + dx;
  zoomOffsetY.value = dragStartOffsetY + dy;
}

function onDragEnd(): void {
  isDragging.value = false;
}

/* ==================== 触屏双指缩放 (Pinch-to-Zoom) & 单指拖动 ==================== */

interface TouchPinchState {
  /** 初始两指距离（px） */
  initialDistance: number;
  /** 初始缩放比例 */
  initialScale: number;
  /** 缩放中心点（屏幕坐标，两指中点） */
  centerX: number;
  centerY: number;
}

/** 当前 pinch 状态，null 表示未进行双指缩放 */
let pinchState: TouchPinchState | null = null;

/** 单指拖动状态（触屏，放大后单指拖动平移） */
interface TouchDragState {
  /** 起始触摸 X（px） */
  startX: number;
  /** 起始触摸 Y（px） */
  startY: number;
  /** 起始偏移 X */
  startOffsetX: number;
  /** 起始偏移 Y */
  startOffsetY: number;
}

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
function onTouchStart(event: TouchEvent): void {
  if (event.touches.length === 2) {
    const t1 = event.touches[0];
    const t2 = event.touches[1];
    const dist = touchDistance(t1, t2);
    if (dist < 10) return;
    const mid = touchMidpoint(t1, t2);
    pinchState = {
      initialDistance: dist,
      initialScale: zoomScale.value,
      centerX: mid.x,
      centerY: mid.y
    };
    touchDragState = null;
    event.preventDefault();
  } else if (event.touches.length === 1) {
    // 单指：放大状态下初始化拖动平移
    if (zoomScale.value > 1) {
      const t = event.touches[0];
      touchDragState = {
        startX: t.clientX,
        startY: t.clientY,
        startOffsetX: zoomOffsetX.value,
        startOffsetY: zoomOffsetY.value
      };
    }
  }
}

/** 触摸移动 */
function onTouchMove(event: TouchEvent): void {
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
    setZoom(newScale, mid.x, mid.y);
    event.preventDefault();
  } else if (touchDragState && event.touches.length === 1) {
    const t = event.touches[0];
    const dx = t.clientX - touchDragState.startX;
    const dy = t.clientY - touchDragState.startY;
    zoomOffsetX.value = touchDragState.startOffsetX + dx;
    zoomOffsetY.value = touchDragState.startOffsetY + dy;
    event.preventDefault();
  }
}

/** 触摸结束 */
function onTouchEnd(event: TouchEvent): void {
  if (event.touches.length < 2) {
    pinchState = null;
  }
  if (event.touches.length === 0) {
    touchDragState = null;
  }
}

/* ==================== 键盘事件 ==================== */

function onKeyDown(event: KeyboardEvent): void {
  // 焦点在输入框/文本域/可编辑元素时，不拦截快捷键，避免影响用户输入
  const target = event.target as HTMLElement;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    // 右到左时 ← 是下一页
    if (isRtl.value) nextPage();
    else prevPage();
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    // 右到左时 → 是上一页
    if (isRtl.value) prevPage();
    else nextPage();
  } else if (event.key === ' ') {
    event.preventDefault();
    nextPage();
  }
}

/* ==================== 图片样式 ==================== */

const pageImageStyle = computed<Record<string, string>>(() => {
  const type = settings.comicScaleType as ComicScaleType;
  switch (type) {
    case 'fitScreen':
      return { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' };
    case 'fitWidth':
      return { width: '100%', maxWidth: '100%', height: 'auto', maxHeight: 'none', objectFit: 'contain' };
    case 'original':
      return { width: 'auto', height: 'auto', maxWidth: 'none', maxHeight: 'none', objectFit: 'none' };
    case 'smartFit':
      return { width: '100%', maxWidth: '100%', height: 'auto', maxHeight: 'none', objectFit: 'contain' };
    default:
      return { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' };
  }
});

/* ==================== 翻页动画类名 ==================== */

/**
 * 翻页动画 CSS 类名（根据动画类型和方向动态生成）
 * - slide：turn-next / turn-prev（左右滑动动画）
 * - fade：turn-fade-next / turn-fade-prev（淡入淡出动画）
 * - none：无类名（直接切换，无动画）
 */
const pageTurnAnimationClass = computed<string>(() => {
  const type = settings.comicPageTurnAnimation as ComicPageTurnAnimationType;
  if (type === 'none') return '';
  if (type === 'fade') {
    if (turnDirection.value === 'next') return 'turn-fade-next';
    if (turnDirection.value === 'prev') return 'turn-fade-prev';
    return '';
  }
  // slide（默认）
  if (turnDirection.value === 'next') return 'turn-next';
  if (turnDirection.value === 'prev') return 'turn-prev';
  return '';
});

/* ==================== 监听变化 ==================== */

watch(
  () => props.images,
  () => {
    // 跨章翻页：根据方向设置正确的起始页
    if (crossChapterDirection.value === 'prev' && totalPages.value > 1) {
      currentPage.value = totalPages.value - 1;
    } else {
      currentPage.value = 0;
    }
    crossChapterDirection.value = null;
    // 重置缩放状态
    zoomScale.value = 1;
    zoomOffsetX.value = 0;
    zoomOffsetY.value = 0;
    imageLoadStates.value = {};
    retryKeys.value = {};
    preloadedUrls.clear();
    nextTick(() => preloadAdjacentPages());
  }
);

watch(currentPage, (newPage) => {
  emit('page-change', newPage + 1);
  preloadAdjacentPages();
});

/* ==================== 生命周期 ==================== */

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
  // 全局鼠标拖拽事件（放大后拖拽平移）
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
  // 初始化容器宽度监听（用于双页模式判断宽屏）
  nextTick(() => {
    const target = document.querySelector('.comic-page') as HTMLElement | null;
    if (target) {
      containerWidth.value = target.clientWidth;
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          containerWidth.value = entry.contentRect.width;
        }
      });
      resizeObserver.observe(target);
    }
    preloadAdjacentPages();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
  if (pageTurnTimer) {
    clearTimeout(pageTurnTimer);
    pageTurnTimer = null;
  }
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
  if (zoomIndicatorTimer) {
    clearTimeout(zoomIndicatorTimer);
    zoomIndicatorTimer = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});

/* ==================== 暴露方法 ==================== */

defineExpose({
  nextPage,
  prevPage,
  goToPage,
  /** 获取当前页码（1-based） */
  getCurrentPage(): number {
    return currentPage.value + 1;
  }
});
</script>

<template>
  <div
    class="comic-page"
    :class="{ rtl: isRtl, 'double-page': effectiveDoublePage, zoomed: zoomScale > 1 }"
    @click="onPageClick"
    @wheel="onWheel"
  >
    <!-- 双页模式：左右两页同时显示 -->
    <div
      v-if="effectiveDoublePage"
      class="comic-double-page-wrapper"
      :class="{
        [pageTurnAnimationClass]: pageTurnAnimationClass !== '',
        zooming: zoomScale > 1,
        dragging: isDragging
      }"
      :style="{
        '--turn-duration': `${pageTurnDuration}ms`,
        transform: zoomScale > 1 ? `scale(${zoomScale}) translate(${zoomOffsetX}px, ${zoomOffsetY}px)` : 'none',
        cursor: zoomScale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'pointer'
      }"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend.passive="onTouchEnd"
      @touchcancel.passive="onTouchEnd"
    >
      <!-- 左页（ltr 时是当前页，rtl 时是下一页） -->
      <div class="comic-page-half comic-page-left">
        <template v-if="doublePageIndices.left !== null">
          <!-- 加载中占位符 -->
          <div
            v-if="!imageLoadStates[doublePageIndices.left] || imageLoadStates[doublePageIndices.left] === 'loading'"
            class="comic-placeholder-loading"
          >
            <span class="comic-placeholder-page">{{
              t('comic.page.short', { n: (doublePageIndices.left ?? 0) + 1 })
            }}</span>
          </div>
          <!-- 加载失败 -->
          <div v-if="imageLoadStates[doublePageIndices.left] === 'error'" class="comic-placeholder-error">
            <span class="comic-error-icon">⚠</span>
            <span class="comic-placeholder-text">{{ t('comic.imageLoadError') }}</span>
            <span class="comic-placeholder-page">{{
              t('comic.page.short', { n: (doublePageIndices.left ?? 0) + 1 })
            }}</span>
            <button class="comic-retry-btn" @click.stop="retryImage(doublePageIndices.left ?? 0)">
              {{ t('common.actions.retry') }}
            </button>
          </div>
          <img
            :key="`l-${doublePageIndices.left}-${retryKeys[doublePageIndices.left ?? 0] || 0}`"
            :src="coverPathToUrl(images[doublePageIndices.left ?? 0])"
            :alt="t('comic.page.short', { n: (doublePageIndices.left ?? 0) + 1 })"
            :style="pageImageStyle"
            :class="{ loaded: imageLoadStates[doublePageIndices.left ?? 0] === 'loaded' }"
            @load="onImageLoad(doublePageIndices.left ?? 0)"
            @error="onImageError(doublePageIndices.left ?? 0)"
            @dblclick.stop="onImageDoubleClick($event)"
            @mousedown="onDragStart"
          />
        </template>
      </div>
      <!-- 右页 -->
      <div class="comic-page-half comic-page-right">
        <template v-if="doublePageIndices.right !== null">
          <!-- 加载中占位符 -->
          <div
            v-if="!imageLoadStates[doublePageIndices.right] || imageLoadStates[doublePageIndices.right] === 'loading'"
            class="comic-placeholder-loading"
          >
            <span class="comic-placeholder-page">{{
              t('comic.page.short', { n: (doublePageIndices.right ?? 0) + 1 })
            }}</span>
          </div>
          <!-- 加载失败 -->
          <div v-if="imageLoadStates[doublePageIndices.right] === 'error'" class="comic-placeholder-error">
            <span class="comic-error-icon">⚠</span>
            <span class="comic-placeholder-text">{{ t('comic.imageLoadError') }}</span>
            <span class="comic-placeholder-page">{{
              t('comic.page.short', { n: (doublePageIndices.right ?? 0) + 1 })
            }}</span>
            <button class="comic-retry-btn" @click.stop="retryImage(doublePageIndices.right ?? 0)">
              {{ t('common.actions.retry') }}
            </button>
          </div>
          <img
            :key="`r-${doublePageIndices.right}-${retryKeys[doublePageIndices.right ?? 0] || 0}`"
            :src="coverPathToUrl(images[doublePageIndices.right ?? 0])"
            :alt="t('comic.page.short', { n: (doublePageIndices.right ?? 0) + 1 })"
            :style="pageImageStyle"
            :class="{ loaded: imageLoadStates[doublePageIndices.right ?? 0] === 'loaded' }"
            @load="onImageLoad(doublePageIndices.right ?? 0)"
            @error="onImageError(doublePageIndices.right ?? 0)"
            @dblclick.stop="onImageDoubleClick($event)"
            @mousedown="onDragStart"
          />
        </template>
      </div>
    </div>

    <!-- 单页图片 -->
    <div
      v-else-if="images.length > 0 && currentPage >= 0 && currentPage < images.length"
      class="comic-page-image-wrapper"
      :class="{
        [pageTurnAnimationClass]: pageTurnAnimationClass !== '',
        zooming: zoomScale > 1,
        dragging: isDragging
      }"
      :style="{
        '--turn-duration': `${pageTurnDuration}ms`,
        transform: zoomScale > 1 ? `scale(${zoomScale}) translate(${zoomOffsetX}px, ${zoomOffsetY}px)` : 'none',
        cursor: zoomScale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'pointer'
      }"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend.passive="onTouchEnd"
      @touchcancel.passive="onTouchEnd"
    >
      <!-- 加载中占位符 -->
      <div
        v-if="!imageLoadStates[currentPage] || imageLoadStates[currentPage] === 'loading'"
        class="comic-placeholder-loading"
      >
        <span class="comic-placeholder-page">{{
          t('comic.page.ofTotal', { current: currentPage + 1, total: images.length })
        }}</span>
      </div>
      <!-- 加载失败 -->
      <div v-if="imageLoadStates[currentPage] === 'error'" class="comic-placeholder-error">
        <span class="comic-error-icon">⚠</span>
        <span class="comic-placeholder-text">{{ t('comic.imageLoadError') }}</span>
        <span class="comic-placeholder-page">{{
          t('comic.page.ofTotal', { current: currentPage + 1, total: images.length })
        }}</span>
        <button class="comic-retry-btn" @click.stop="retryImage(currentPage)">
          {{ t('common.actions.retry') }}
        </button>
      </div>
      <img
        :key="`p-${currentPage}-${retryKeys[currentPage] || 0}`"
        :src="coverPathToUrl(images[currentPage])"
        :alt="t('comic.page.short', { n: currentPage + 1 })"
        :style="pageImageStyle"
        :class="{ loaded: imageLoadStates[currentPage] === 'loaded' }"
        @load="onImageLoad(currentPage)"
        @error="onImageError(currentPage)"
        @dblclick.stop="onImageDoubleClick($event)"
        @mousedown="onDragStart"
      />
    </div>
    <!-- 空内容提示 -->
    <div v-else class="comic-empty">
      <span class="comic-placeholder-text">{{ t('comic.noContent') }}</span>
    </div>

    <!-- 页码指示器 -->
    <div v-if="totalPages > 1" class="page-indicator">
      {{ pageIndicatorText }}
    </div>

    <!-- 缩放比例指示器 -->
    <Transition name="indicator-fade">
      <div v-if="zoomIndicatorVisible && zoomIndicatorScale > 1" class="zoom-indicator">
        {{ Math.round(zoomIndicatorScale * 100) }}%
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.comic-page {
  flex: 1;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--reader-bg, #000);
  cursor: pointer;
  overflow: hidden;
  position: relative;
}

.comic-page.rtl {
  direction: rtl;
}

.comic-page-image-wrapper {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: transform var(--turn-duration, 200ms) ease-out;
}

/* 缩放状态：平滑过渡 + 提升层级 */
.comic-page-image-wrapper.zooming {
  transition: transform 0.15s ease;
  z-index: 10;
}

/* 拖动中：禁用过渡 */
.comic-page-image-wrapper.dragging {
  transition: none;
  z-index: 10;
}

.comic-page.zoomed .comic-page-image-wrapper {
  z-index: 10;
}

.comic-page-image-wrapper img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  user-select: none;
  -webkit-user-drag: none;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.comic-page-image-wrapper img.loaded {
  opacity: 1;
}

/* ═══════════════ 双页展开模式 ═══════════════ */
.comic-double-page-wrapper {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  transition: transform var(--turn-duration, 200ms) ease-out;
}

/* 双页模式缩放状态 */
.comic-double-page-wrapper.zooming {
  transition: transform 0.15s ease;
  z-index: 10;
}

/* 双页模式拖动中：禁用过渡 */
.comic-double-page-wrapper.dragging {
  transition: none;
  z-index: 10;
}

.comic-page-half {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

/* 双页模式图片 */
.comic-page-half img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  user-select: none;
  -webkit-user-drag: none;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.comic-page-half img.loaded {
  opacity: 1;
}

/* 右到左时双页顺序反转 */
.comic-page.rtl .comic-double-page-wrapper {
  flex-direction: row-reverse;
}

/* ═══════════════ 翻页动画：slide（左右滑动） ═══════════════ */
/* 下一页：从右侧滑入 */
.turn-next {
  animation: comic-slide-next var(--turn-duration, 200ms) ease-out;
}

/* 上一页：从左侧滑入 */
.turn-prev {
  animation: comic-slide-prev var(--turn-duration, 200ms) ease-out;
}

@keyframes comic-slide-next {
  from {
    transform: translateX(30px);
    opacity: 0.6;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes comic-slide-prev {
  from {
    transform: translateX(-30px);
    opacity: 0.6;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

/* ═══════════════ 翻页动画：fade（淡入淡出） ═══════════════ */
.turn-fade-next,
.turn-fade-prev {
  animation: comic-fade var(--turn-duration, 200ms) ease-out;
}

@keyframes comic-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* 页码指示器 */
.page-indicator {
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

/* 加载占位符 */
.comic-placeholder-loading {
  position: absolute;
  inset: 0;
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

.comic-placeholder-error {
  position: absolute;
  inset: 0;
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

.comic-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.5);
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
