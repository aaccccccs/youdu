<!--
  漫画翻页模式组件（精简版）

  功能：
  - 单页/双页显示，object-fit: contain 保持比例，纯黑背景
  - 双页展开模式：宽屏(>=800px)时左右两页同时显示，窄屏自动切单页，封面单独显示
  - 双页宽幅跨页图检测（v52）：宽高比>1.2 的跨页图单独整屏显示，不被压缩到半屏
  - 适配模式（v52）：fitScreen/fitWidth/fitHeight/original/smartFit/custom（自定义百分比）
  - original/custom 放大时 1x 状态下也开放拖拽平移（v52），溢出部分可拖动查看
  - 点击分区 25/50/25：左25%上一页，右25%下一页，中间50% emit('toggle-toolbar')
  - RTL 模式：左25%下一页，右25%上一页
  - 键盘翻页统一走 Reader 快捷键系统（v58 删 ←/→、P2-5 删 Space 硬编码监听，
    全部经 ComicViewer.nextPage/prevPage，RTL 反转与用户自定义键位天然生效）
  - 滚轮翻页（P2-7）：无 Ctrl 时 deltaY>0 下一页、<0 上一页；Ctrl+滚轮为页内缩放
  - 翻页动画 slide/fade/none（从 settings 读取），时长可配置
  - Ctrl+滚轮缩放、触屏双指缩放(Pinch-to-Zoom)
  - 双击图片全屏原尺寸查看（v56 P0 对标 Calibre：emit view-image → ComicViewer
    弹 ComicLightbox；已放大时双击先复位页内缩放，1x 双击才全屏查看）
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
import { useSettingsStore, useReaderStore, type ComicScaleType, type ComicPageTurnAnimationType } from '@renderer/stores';
import { coverPathToUrl } from '@renderer/utils';
import type { ChapterImage } from '../../../../shared';

const props = withDefaults(
  defineProps<{
    /** 图片文件路径列表 */
    images: ChapterImage[];
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
  /** v56 P0 对标 Calibre：双击图片 → 请求全屏原尺寸查看（ComicViewer 弹 ComicLightbox） */
  (e: 'view-image', image: ChapterImage): void;
}>();

const settings = useSettingsStore();
const readerStore = useReaderStore();
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


/* ==================== 双页分组（v52：宽幅跨页图检测） ==================== */

/** 宽幅跨页图判定阈值（宽高比 > 1.2 视为跨页图，1.2 容差避免普通近方形页误判） */
const WIDE_SPREAD_RATIO = 1.2;

/**
 * 判断图片是否为宽幅跨页图（宽高比 > 1.2）。
 * ChapterImage 无尺寸数据（width/height 为 0，如 CBZ 的 GIF/BMP）时返回 false，
 * 回退到原有的奇偶配对逻辑。
 */
function isWideSpreadImage(index: number): boolean {
  const img = props.images[index];
  if (!img || !img.width || !img.height) return false;
  return img.width / img.height > WIDE_SPREAD_RATIO;
}

/** 双页分组项：wide=true 的组单独整屏显示（封面/跨页图/末尾孤页），否则左右两页并排 */
interface DoublePageGroup {
  /** 组起始页索引 */
  start: number;
  /** 是否单显组（单独占满一屏） */
  wide: boolean;
}

/**
 * 双页分组表（v52）：从第 0 页起扫描生成显示分组。
 * - 第 0 页为封面，单独成组（对齐原"封面单显"先例）
 * - 宽幅跨页图（宽高比>1.2）单独成组，避免与相邻页并排被压缩到半屏
 * - 宽图的相邻普通页也单独成组（否则会与宽图错位并排）
 * - 其余页两两配对；末尾孤页单独成组
 * 无尺寸数据的图片回退普通奇偶配对。
 */
const doublePageGroups = computed<DoublePageGroup[]>(() => {
  const n = props.images.length;
  const groups: DoublePageGroup[] = [];
  if (n === 0) return groups;
  // 封面（第0页）单独成组
  groups.push({ start: 0, wide: true });
  let i = 1;
  while (i < n) {
    if (isWideSpreadImage(i)) {
      // 当前页是宽幅跨页图：单独成组
      groups.push({ start: i, wide: true });
      i += 1;
    } else if (i + 1 < n && isWideSpreadImage(i + 1)) {
      // 下一页是宽幅跨页图：当前普通页单独成组（避免与宽图并排错位）
      groups.push({ start: i, wide: true });
      i += 1;
    } else if (i + 1 < n) {
      // 普通页两两配对
      groups.push({ start: i, wide: false });
      i += 2;
    } else {
      // 末尾孤页：单独成组
      groups.push({ start: i, wide: true });
      i += 1;
    }
  }
  return groups;
});

/** 查找页码所属分组的索引（普通组覆盖 [start, start+1]，单显组覆盖 [start]），未找到返回 -1 */
function groupIndexOf(page: number): number {
  const groups = doublePageGroups.value;
  for (let g = 0; g < groups.length; g++) {
    const { start, wide } = groups[g];
    const end = wide ? start : start + 1;
    if (page >= start && page <= end) return g;
  }
  return -1;
}

/** 当前页所属分组（未找到返回 null） */
const currentGroup = computed<DoublePageGroup | null>(() => {
  const groups = doublePageGroups.value;
  const g = groupIndexOf(currentPage.value);
  return g >= 0 ? groups[g] : null;
});

/** 将页码对齐到其所属分组的起始页（目录跳页/跨章定位时保证分组显示一致） */
function alignToGroupStart(page: number): number {
  const groups = doublePageGroups.value;
  const g = groupIndexOf(page);
  return g >= 0 ? groups[g].start : page;
}

/**
 * 计算下一个显示位置：双页模式按分组跳转（宽幅跨页图组单独一屏，不跳页），
 * 单页模式逐页前进。无下一位置（已在最后）返回 null（由调用方触发跨章）。
 */
function getNextDisplayPosition(): number | null {
  if (!settings.comicDoublePage || !isWideScreen.value) {
    return currentPage.value + 1 < totalPages.value ? currentPage.value + 1 : null;
  }
  const groups = doublePageGroups.value;
  const g = groupIndexOf(currentPage.value);
  if (g >= 0) {
    return g + 1 < groups.length ? groups[g + 1].start : null;
  }
  // 当前页未对齐到组起点（如双页开关中途切换）：退化为逐页前进
  return currentPage.value + 1 < totalPages.value ? currentPage.value + 1 : null;
}

/** 计算上一个显示位置（对称于 getNextDisplayPosition），已在第一组返回 null（触发跨章） */
function getPrevDisplayPosition(): number | null {
  if (!settings.comicDoublePage || !isWideScreen.value) {
    return currentPage.value > 0 ? currentPage.value - 1 : null;
  }
  const groups = doublePageGroups.value;
  const g = groupIndexOf(currentPage.value);
  if (g > 0) {
    return groups[g - 1].start;
  }
  if (g === 0) return null;
  // 未对齐：退化为逐页后退
  return currentPage.value > 0 ? currentPage.value - 1 : null;
}

/**
 * 实际是否启用双页模式
 * - 用户开启双页模式（settings.comicDoublePage）
 * - 宽屏（>=800px）
 * - 当前分组非单显组（封面/宽幅跨页图/末尾孤页均单独整屏显示，不与其他页并排）
 */
const effectiveDoublePage = computed<boolean>(() => {
  if (!settings.comicDoublePage) return false;
  if (!isWideScreen.value) return false;
  // 封面（第0页）单独显示；v52：宽幅跨页图组同样单独整屏显示（避免被压缩到半屏）
  const group = currentGroup.value;
  if (group && group.wide) return false;
  return true;
});

/**
 * 双页模式下的左右页图片索引（基于当前分组）
 * - ltr：左页=组起点，右页=组起点+1
 * - rtl：右页=组起点（阅读顺序在前），左页=组起点+1
 * @returns { left, right } 图片索引，null 表示该侧无图片
 */
const doublePageIndices = computed<{ left: number | null; right: number | null }>(() => {
  if (!effectiveDoublePage.value) {
    return { left: null, right: null };
  }
  const group = currentGroup.value;
  if (!group) {
    return { left: null, right: null };
  }
  const base = group.start;
  const next = base + 1;
  const hasNext = next < totalPages.value;
  if (isRtl.value) {
    // 右到左：右页=base（阅读顺序在前），左页=base+1
    return {
      right: base,
      left: hasNext ? next : null
    };
  }
  // 左到右：左页=base，右页=base+1
  return {
    left: base,
    right: hasNext ? next : null
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
  const url = coverPathToUrl(props.images[index].path);
  if (!url || preloadedUrls.has(url)) return;
  preloadedUrls.add(url);
  const img = new Image();
  img.src = url;
}

/** v54：章末预取提前量（距最后一张图不足 N 张时预取下一章首批） */
const NEXT_CHAPTER_PREFETCH_PAGES = 3;

function preloadAdjacentPages(): void {
  const base = currentPage.value;
  // v46：预加载当前页 ±4 页（原 ±2），减少翻页时看到未加载占位
  // v53：当前页与 ±4 预载范围内的 pending 占位页（尚未渲染）请求主进程续载
  // （store 内 200ms 去抖合并）。页模式无跨章拼接，props.images 即当前章，
  // 槽位下标 + 1 即续载槽位号；翻页（watch currentPage）与新章加载
  // （watch images → nextTick）都会走到这里，同步触发。
  const pendingPages: number[] = [];
  collectPendingPage(base, pendingPages);
  for (let i = 1; i <= 4; i++) {
    preloadImage(base + i);
    preloadImage(base - i);
    collectPendingPage(base + i, pendingPages);
    collectPendingPage(base - i, pendingPages);
  }
  if (pendingPages.length > 0) {
    readerStore.ensureImages(pendingPages);
  }
  // v54 章末衔接：距章末不足 N 张图时预取下一章首批（主进程提前渲染落盘缓存，
  // 不切屏不换数据）。用户翻到最后一页再 next 触发 request-next-chapter →
  // Reader 切章加载时首批命中磁盘缓存，几乎无等待。
  if (props.images.length > 0 && base + NEXT_CHAPTER_PREFETCH_PAGES >= props.images.length) {
    void readerStore.prefetchNextChapterImages();
  }
}

/** v53：收集 pending 占位页的续载槽位号（1-based） */
function collectPendingPage(index: number, out: number[]): void {
  if (index < 0 || index >= props.images.length) return;
  if (props.images[index].pending) out.push(index + 1);
}

/* ==================== 翻页操作 ==================== */

/** 翻页动画时长（ms），从 settings 读取 */
const pageTurnDuration = computed<number>(() => settings.comicPageTurnDuration || 200);

function nextPage(): void {
  if (isTurningPage) return;
  // v46：图片列表为空（尚未生成/加载失败）时不触发翻章 ——
  // 原实现 totalPages=1 会让"下一页"立即 request-next-chapter，
  // 反复加载导致用户看到"下一页就是上一章"的错乱。
  if (props.images.length === 0) return;
  // v52：双页模式按分组跳转（宽幅跨页图组单独一屏，不会被步长 2 跳过）
  const target = getNextDisplayPosition();
  if (target !== null) {
    isTurningPage = true;
    turnDirection.value = 'next';
    currentPage.value = target;
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
  // v46：同上，图片未生成时不触发翻章
  if (props.images.length === 0) return;
  // v52：双页模式按分组跳转（对称于 nextPage）
  const target = getPrevDisplayPosition();
  if (target !== null) {
    isTurningPage = true;
    turnDirection.value = 'prev';
    currentPage.value = target;
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
  const clamped = Math.max(0, Math.min(totalPages.value - 1, page));
  // v52：对齐到所属分组起点（双页模式下跳到组右半页时显示整组）
  currentPage.value = alignToGroupStart(clamped);
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
    // v52：拖拽平移后松手触发的 click 不翻页（消费位移标记）
    if (dragMoved) {
      dragMoved = false;
      return;
    }
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

/**
 * 1x 状态下是否允许拖拽平移（v52）：
 * original（自然大图溢出视口）或 custom>100%（放大溢出）时，即使未 Ctrl+滚轮缩放
 * 也开放拖拽平移，修复"original 溢出被裁剪且无法拖动查看"的问题。
 */
const canPanAtBaseScale = computed<boolean>(() => {
  const type = settings.comicScaleType as ComicScaleType;
  return type === 'original' || (type === 'custom' && settings.comicCustomScale > 100);
});

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

/**
 * 滚轮事件：
 * - Ctrl+滚轮：页内缩放（锚定鼠标，1~4x，原有行为优先保留）
 * - 普通滚轮（P2-7，导航审计 #7）：翻页——deltaY>0 下一页、<0 上一页
 *   （竞品 Mihon/YACReader/Calibre 的滚轮翻页标配）。防连翻双闸：
 *   ① 与翻页动画共用 isTurningPage 锁（pageTurnDuration 默认 200ms）
 *   ② 150ms 独立节流（动画设为 none 时锁时长为 0，滚轮惯性一格多事件
 *   仍需限频）。preventDefault 防滚动穿透（翻页容器本无可滚内容）。
 */
const WHEEL_TURN_THROTTLE_MS = 150;
let lastWheelTurnAt = 0;

function onWheel(event: WheelEvent): void {
  if (event.ctrlKey) {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const newScale = zoomScale.value + delta;
    setZoom(newScale, event.clientX, event.clientY);
    zoomIndicatorScale.value = zoomScale.value;
    showZoomIndicator();
    return;
  }
  // P2-7：普通滚轮=翻页（RTL 下垂直滚轮与方向无关，deltaY>0 恒为阅读前进）
  if (event.deltaY === 0) return;
  event.preventDefault();
  if (isTurningPage) return;
  const now = performance.now();
  if (now - lastWheelTurnAt < WHEEL_TURN_THROTTLE_MS) return;
  lastWheelTurnAt = now;
  if (event.deltaY > 0) {
    nextPage();
  } else {
    prevPage();
  }
}

/**
 * 双击图片 → emit view-image，请求 ComicViewer 弹出全屏原尺寸查看（v56 P0 对标 Calibre）。
 *
 * v56 前此处为 1x↔2x 页内放大；页内缩放保留 Ctrl+滚轮与触屏双指两条路径，
 * "双击看大图"升级为独立查看层（原始尺寸 + 拖拽 + 缩放 + 尺寸信息）。
 * 双页模式下双击左/右页分别请求对应图片（index 参数区分）。
 */
function onImageViewRequest(_event: MouseEvent, index: number): void {
  // 清除单击定时器，避免双击后还触发单击翻页
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
  // 双击复位页内缩放状态（v52 语义保留：放大/平移后双击回到 1x，再双击才全屏查看）
  if (zoomScale.value > 1 || zoomOffsetX.value !== 0 || zoomOffsetY.value !== 0) {
    setZoom(1);
    return;
  }
  const img = props.images[index];
  if (img && !img.pending) {
    emit('view-image', img);
  }
}

/* ==================== 鼠标拖拽平移（放大后可拖动；v52：original/custom 1x 也可拖动） ==================== */

/** 最近一次拖拽是否产生了实际位移（区分"平移拖拽"与"点击"，防止拖拽松手误触翻页） */
let dragMoved = false;

function onDragStart(event: MouseEvent): void {
  // 仅放大后（或 original/custom 放大溢出时）可拖动
  if (zoomScale.value <= 1 && !canPanAtBaseScale.value) return;
  isDragging.value = true;
  dragMoved = false;
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
  // 位移超过阈值视为平移拖拽（后续 click 不再翻页）
  if (!dragMoved && Math.abs(dx) + Math.abs(dy) > 3) {
    dragMoved = true;
  }
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
    // 单指：放大状态下（或 original/custom 1x 溢出时，v52）初始化拖拽平移
    if (zoomScale.value > 1 || canPanAtBaseScale.value) {
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


/* ==================== 图片样式 ==================== */

const pageImageStyle = computed<Record<string, string>>(() => {
  const type = settings.comicScaleType as ComicScaleType;
  switch (type) {
    case 'fitScreen':
      return { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' };
    case 'fitWidth':
      return { width: '100%', maxWidth: '100%', height: 'auto', maxHeight: 'none', objectFit: 'contain' };
    case 'fitHeight':
      // v52：适应高度——高度撑满视口（翻页容器有固定高度），宽度按比例且不超容器宽，保持比例不变形
      return { height: '100%', width: 'auto', maxWidth: '100%', maxHeight: 'none', objectFit: 'contain' };
    case 'original':
      return { width: 'auto', height: 'auto', maxWidth: 'none', maxHeight: 'none', objectFit: 'none' };
    case 'smartFit':
      return { width: '100%', maxWidth: '100%', height: 'auto', maxHeight: 'none', objectFit: 'contain' };
    case 'custom':
      // v52：自定义百分比——宽度按容器宽的百分比显示（CSS 优先方案，与滚动模式行为一致，
      // 不打扰 Ctrl+滚轮临时缩放状态机）；超宽部分通过拖拽平移查看
      return {
        width: `${settings.comicCustomScale}%`,
        maxWidth: 'none',
        height: 'auto',
        maxHeight: 'none',
        objectFit: 'contain'
      };
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
      // v52：对齐到最后一组的起点（双页分组语义下最后一页可能是组右半）
      currentPage.value = alignToGroupStart(totalPages.value - 1);
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
  // P2-5：window keydown 监听已整体移除（原硬编码 Space 翻页——v58 删 ←/→ 后
  // 唯一残留硬编码，绕过自定义键位系统；现 Space 走 Reader.handleKeydown →
  // ComicViewer.nextPage 统一链路，RTL 反转/用户自定义天然生效，防双触发）
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
      v-if="effectiveDoublePage && images.length > 0"
      class="comic-double-page-wrapper"
      :class="{
        [pageTurnAnimationClass]: pageTurnAnimationClass !== '',
        zooming: zoomScale > 1,
        dragging: isDragging
      }"
      :style="{
        '--turn-duration': `${pageTurnDuration}ms`,
        transform:
          zoomScale > 1 || zoomOffsetX !== 0 || zoomOffsetY !== 0
            ? `scale(${zoomScale}) translate(${zoomOffsetX}px, ${zoomOffsetY}px)`
            : 'none',
        cursor: zoomScale > 1 || canPanAtBaseScale ? (isDragging ? 'grabbing' : 'grab') : 'pointer'
      }"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend.passive="onTouchEnd"
      @touchcancel.passive="onTouchEnd"
    >
      <!-- 左页（ltr 时是当前页，rtl 时是下一页） -->
      <div class="comic-page-half comic-page-left">
        <template v-if="doublePageIndices.left !== null">
          <!-- 加载中占位符；v53 pending 页（尚未渲染）附转圈图标 -->
          <div
            v-if="!imageLoadStates[doublePageIndices.left] || imageLoadStates[doublePageIndices.left] === 'loading'"
            class="comic-placeholder-loading"
            :class="{ pending: images[doublePageIndices.left ?? 0]?.pending }"
          >
            <span
              v-if="images[doublePageIndices.left ?? 0]?.pending"
              class="comic-pending-spinner"
              aria-hidden="true"
            ></span>
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
            :src="coverPathToUrl(images[doublePageIndices.left ?? 0].path)"
            :alt="t('comic.page.short', { n: (doublePageIndices.left ?? 0) + 1 })"
            :data-image-path="images[doublePageIndices.left ?? 0].path || ''"
            :style="pageImageStyle"
            :class="{ loaded: imageLoadStates[doublePageIndices.left ?? 0] === 'loaded' }"
            @load="onImageLoad(doublePageIndices.left ?? 0)"
            @error="onImageError(doublePageIndices.left ?? 0)"
            @dblclick.stop="onImageViewRequest($event, doublePageIndices.left ?? 0)"
            @mousedown="onDragStart"
          />
        </template>
      </div>
      <!-- 右页 -->
      <div class="comic-page-half comic-page-right">
        <template v-if="doublePageIndices.right !== null">
          <!-- 加载中占位符；v53 pending 页（尚未渲染）附转圈图标 -->
          <div
            v-if="!imageLoadStates[doublePageIndices.right] || imageLoadStates[doublePageIndices.right] === 'loading'"
            class="comic-placeholder-loading"
            :class="{ pending: images[doublePageIndices.right ?? 0]?.pending }"
          >
            <span
              v-if="images[doublePageIndices.right ?? 0]?.pending"
              class="comic-pending-spinner"
              aria-hidden="true"
            ></span>
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
            :src="coverPathToUrl(images[doublePageIndices.right ?? 0].path)"
            :alt="t('comic.page.short', { n: (doublePageIndices.right ?? 0) + 1 })"
            :data-image-path="images[doublePageIndices.right ?? 0].path || ''"
            :style="pageImageStyle"
            :class="{ loaded: imageLoadStates[doublePageIndices.right ?? 0] === 'loaded' }"
            @load="onImageLoad(doublePageIndices.right ?? 0)"
            @error="onImageError(doublePageIndices.right ?? 0)"
            @dblclick.stop="onImageViewRequest($event, doublePageIndices.right ?? 0)"
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
        transform:
          zoomScale > 1 || zoomOffsetX !== 0 || zoomOffsetY !== 0
            ? `scale(${zoomScale}) translate(${zoomOffsetX}px, ${zoomOffsetY}px)`
            : 'none',
        cursor: zoomScale > 1 || canPanAtBaseScale ? (isDragging ? 'grabbing' : 'grab') : 'pointer'
      }"
      @touchstart="onTouchStart"
      @touchmove="onTouchMove"
      @touchend.passive="onTouchEnd"
      @touchcancel.passive="onTouchEnd"
    >
      <!-- 加载中占位符；v53 pending 页（尚未渲染）附转圈图标 -->
      <div
        v-if="!imageLoadStates[currentPage] || imageLoadStates[currentPage] === 'loading'"
        class="comic-placeholder-loading"
        :class="{ pending: images[currentPage]?.pending }"
      >
        <span v-if="images[currentPage]?.pending" class="comic-pending-spinner" aria-hidden="true"></span>
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
        :src="coverPathToUrl(images[currentPage].path)"
        :alt="t('comic.page.short', { n: currentPage + 1 })"
        :data-image-path="images[currentPage].path || ''"
        :style="pageImageStyle"
        :class="{ loaded: imageLoadStates[currentPage] === 'loaded' }"
        @load="onImageLoad(currentPage)"
        @error="onImageError(currentPage)"
        @dblclick.stop="onImageViewRequest($event, currentPage)"
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
  /* v57：背景透明化，由外壳 ComicViewer 按漫画背景色设置统一透出（原固定 #000） */
  background: transparent;
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
  background: var(--overlay-surface);
  color: var(--overlay-text);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.5px;
  pointer-events: none;
  user-select: none;
  z-index: 20;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--overlay-border);
}

/* 缩放比例指示器 */
.zoom-indicator {
  position: absolute;
  bottom: 16px;
  right: 16px;
  padding: 5px 14px;
  background: var(--overlay-surface);
  color: var(--overlay-text);
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.5px;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: 30;
  pointer-events: none;
  user-select: none;
  border: 1px solid var(--overlay-border);
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

/* v53：pending 占位（该页尚未渲染，等待主进程续载）：纵向排列 + 转圈图标 */
.comic-placeholder-loading.pending {
  flex-direction: column;
  gap: 12px;
}

.comic-pending-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 15%, transparent);
  border-top-color: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 60%, transparent);
  border-radius: 50%;
  animation: comic-pending-spin 0.9s linear infinite;
}

@keyframes comic-pending-spin {
  to {
    transform: rotate(360deg);
  }
}

.comic-placeholder-page {
  font-size: 14px;
  color: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 55%, transparent);
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
  color: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 50%, transparent);
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
  border: 1px solid color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 30%, transparent);
  border-radius: 4px;
  background: transparent;
  color: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 85%, transparent);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.comic-retry-btn:hover {
  background: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 10%, transparent);
  border-color: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 50%, transparent);
}

.comic-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 50%, transparent);
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
