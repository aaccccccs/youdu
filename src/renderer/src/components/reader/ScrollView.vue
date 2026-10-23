<!--
  滚动阅读视图

  功能：
  - 章节正文按段落显示（\n\n 分段）
  - 正文限宽 pageWidth px 居中（默认 800px，参考微信读书）
  - 字号 fontSize px、行距 lineHeight、字体 fontFamilyCss
  - 主题颜色通过 CSS 变量 --reader-text / --reader-bg 驱动
  - 段落间距 1.5em，首行缩进 2em，行高 1.8（默认）
  - 滚动条美化：宽 6px，半透明，悬停变深
  - 两种拼接模式由 infiniteScroll prop 控制：
    - infiniteScroll=true（scroll 模式）：滚到底部自动加载下一章，拼接到下方
    - infiniteScroll=false（chapter 模式）：一次只显示一章，通过底部工具栏翻章
  - 最多拼接 5 章，超过后自动清理最早章节并调整滚动位置
  - 没有下一章时显示"— 已读完最后一章 —"
  - 滚动位置变化时 debounce 保存进度（基于当前章节内归一化位置；根因①：
    保存/恢复统一"全章段落数"分母坐标系，恢复定位到段落中部与保存语义对称）
  - 章节标题居中显示，20px 加粗，下方有装饰线
  - padding 统一 16px（文档流布局下工具栏/底部导航已占据空间）
  - 暴露 scrollToPosition、scrollToTop、scrollPageDown、scrollPageUp、getCurrentPosition、getVisibleText 方法
  - 触底/触顶检测阈值 600px，suppressScrollSave 窗口 50ms，所有恢复点主动 recheckScroll 补偿检测
-->
<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useReaderStore } from '@renderer/stores';
import { useBookmarkStore } from '@renderer/stores';
import { useInlineImageLightbox } from '@renderer/composables';
import { splitParagraphs, renderParagraphWithHighlights, renderMarkdown, paragraphIndexToPosition, positionToParagraphIndex, computeChapterCharOffset, charOffsetToInParaRatio } from '@renderer/utils';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const store = useReaderStore();
const bookmarkStore = useBookmarkStore();

/**
 * 是否启用无限拼接模式
 * - true（scroll 模式）：滚到底部自动加载下一章拼接到下方
 * - false（chapter 模式）：一次只显示一章，通过底部工具栏翻章
 */
const props = defineProps<{
  infiniteScroll?: boolean;
  /** 是否启用自动滚动 */
  autoScroll?: boolean;
  /** 全部加载模式：一次性加载所有章节到滚动页面 */
  loadAll?: boolean;
}>();

const emit = defineEmits<{
  (e: 'contextmenu', event: MouseEvent): void;
  (e: 'autoScrollToggle', enabled: boolean): void;
}>();

const infiniteScrollEnabled = computed<boolean>(() => props.infiniteScroll ?? true);

/** 滚动容器引用 */
const scrollRef = ref<HTMLDivElement | null>(null);

/* ==================== 图片放大查看（Lightbox） ==================== */

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
  bindInlineImgEvents,
  observeInlineImages
} = useInlineImageLightbox(scrollRef);

/* ==================== A6修复：Lightbox 缩放交互（滚轮缩放 / 双击 1:1 / 拖拽平移） ==================== */

/** 缩放上限与滚轮步长（与 ComicPageMode 的 ZOOM_MAX / ZOOM_STEP 一致） */
const LB_ZOOM_MAX = 4;
const LB_ZOOM_STEP = 0.25;
/** lightbox 图片元素引用（缩放锚点计算用） */
const lightboxImgRef = ref<HTMLImageElement | null>(null);
/** 当前缩放比例（相对原始像素：1 = 1:1 原始像素，lbFitScale = 90vw/90vh 适配态） */
const lbScale = ref(1);
/** 适配比例（缩放下限，复刻原 CSS max-width:90vw / max-height:90vh 的适配效果） */
const lbFitScale = ref(1);
/** 缩放后平移偏移（px），transform 形式与 ComicPageMode 一致：scale(s) translate(x, y) */
const lbOffsetX = ref(0);
const lbOffsetY = ref(0);
/** 图片原始像素尺寸（1:1 布局用，load 后记录） */
const lbNaturalW = ref(0);
const lbNaturalH = ref(0);
/** 是否正在拖拽平移（grab/grabbing 光标切换） */
const lbDragging = ref(false);
/** 最近一次拖拽是否产生位移（超阈值时抑制松手后的遮罩 click 误关闭） */
let lbDragMoved = false;
let lbDragX = 0;
let lbDragY = 0;
let lbDragOX = 0;
let lbDragOY = 0;

/** A6修复：图片 1:1 布局 + 缩放/平移 transform + 可拖拽光标 */
const lightboxImgStyle = computed(() => {
  if (!lbNaturalW.value) return {};
  return {
    width: `${lbNaturalW.value}px`,
    height: `${lbNaturalH.value}px`,
    maxWidth: 'none',
    maxHeight: 'none',
    transform: `scale(${lbScale.value}) translate(${lbOffsetX.value}px, ${lbOffsetY.value}px)`,
    cursor: lbScale.value > lbFitScale.value ? (lbDragging.value ? 'grabbing' : 'grab') : 'zoom-in'
  };
});

/**
 * 图片加载完成：记录原始尺寸并重置为适配态。
 * v-if 重建（重开 lightbox）与 src 切换（换图）都会重新触发 load，
 * 天然满足「关闭/切换图片时重置缩放状态」，无需额外 watch。
 */
function onLightboxImgLoad(e: Event): void {
  const img = e.target as HTMLImageElement;
  if (!img.naturalWidth || !img.naturalHeight) return;
  lbNaturalW.value = img.naturalWidth;
  lbNaturalH.value = img.naturalHeight;
  // 与原 CSS 90vw/90vh 适配语义一致：只缩不放（小图保持原尺寸显示）
  lbFitScale.value = Math.min(
    (window.innerWidth * 0.9) / lbNaturalW.value,
    (window.innerHeight * 0.9) / lbNaturalH.value,
    1
  );
  lbScale.value = lbFitScale.value;
  lbOffsetX.value = 0;
  lbOffsetY.value = 0;
}

/**
 * 设置缩放比例（支持以指定点为中心缩放）。
 * 数学与 ComicPageMode.setZoom 完全一致：以变换后元素 rect 中心为参照，
 * 保持鼠标下的内容点缩放后仍处于鼠标处；差异仅在上下限（下限为适配比例而非 1）。
 */
function setLightboxZoom(newScale: number, mouseX?: number, mouseY?: number): void {
  const oldScale = lbScale.value;
  const clamped = Math.max(lbFitScale.value, Math.min(LB_ZOOM_MAX, newScale));
  let nx = oldScale > 0 ? (lbOffsetX.value * oldScale) / clamped : 0;
  let ny = oldScale > 0 ? (lbOffsetY.value * oldScale) / clamped : 0;
  if (mouseX !== undefined && mouseY !== undefined && oldScale > 0 && lightboxImgRef.value) {
    const rect = lightboxImgRef.value.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    nx = (mouseX - cx) * (1 / clamped - 1 / oldScale) + (lbOffsetX.value * oldScale) / clamped;
    ny = (mouseY - cy) * (1 / clamped - 1 / oldScale) + (lbOffsetY.value * oldScale) / clamped;
  }
  // 缩放回适配态时重置偏移（与 ComicPageMode 一致）
  if (clamped <= lbFitScale.value) {
    nx = 0;
    ny = 0;
  }
  lbScale.value = clamped;
  lbOffsetX.value = nx;
  lbOffsetY.value = ny;
}

/** 滚轮缩放：lightbox 为模态全屏、无滚动语义，纯滚轮即缩放（Ctrl+滚轮同样生效），锚点跟随鼠标 */
function onLightboxWheel(event: WheelEvent): void {
  event.preventDefault();
  const delta = event.deltaY > 0 ? -LB_ZOOM_STEP : LB_ZOOM_STEP;
  setLightboxZoom(lbScale.value + delta, event.clientX, event.clientY);
}

/** 双击切换：适配态 ↔ 1:1 原始像素（已放大/有偏移时回适配，否则以双击位置为锚放大到 1:1） */
function onLightboxDblClick(event: MouseEvent): void {
  if (lbScale.value > lbFitScale.value || lbOffsetX.value !== 0 || lbOffsetY.value !== 0) {
    setLightboxZoom(lbFitScale.value);
  } else {
    setLightboxZoom(1, event.clientX, event.clientY);
  }
}

/** 拖拽开始（仅放大后 scale > 适配比例时可拖动，与 ComicPageMode 一致） */
function onLightboxDragStart(event: MouseEvent): void {
  if (lbScale.value <= lbFitScale.value) return;
  lbDragging.value = true;
  lbDragMoved = false;
  lbDragX = event.clientX;
  lbDragY = event.clientY;
  lbDragOX = lbOffsetX.value;
  lbDragOY = lbOffsetY.value;
  event.preventDefault();
}

/** 拖拽移动：位移超 3px 阈值视为平移拖拽（后续 click 不再触发遮罩关闭，同 ComicPageMode dragMoved） */
function onLightboxDragMove(event: MouseEvent): void {
  if (!lbDragging.value) return;
  const dx = event.clientX - lbDragX;
  const dy = event.clientY - lbDragY;
  if (!lbDragMoved && Math.abs(dx) + Math.abs(dy) > 3) {
    lbDragMoved = true;
  }
  lbOffsetX.value = lbDragOX + dx;
  lbOffsetY.value = lbDragOY + dy;
}

/** 拖拽结束（mouseup 与 mouseleave 共用，后者覆盖鼠标拖出窗口的场景） */
function onLightboxDragEnd(): void {
  lbDragging.value = false;
}

/** A6修复：遮罩点击关闭包装——拖拽位移后的 click 不触发关闭（mouseup 与 click 时序冲突抑制） */
function onLightboxMaskClick(e: MouseEvent): void {
  if (lbDragMoved) {
    lbDragMoved = false;
    return;
  }
  handleLightboxClick(e);
}

/** 滚动容器 click 事件委托：点击 .inline-illustration 图片时打开 lightbox */
function handleScrollClickDelegation(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (target && target.classList.contains('inline-illustration')) {
    const img = target as HTMLImageElement;
    // 加载失败的图片：点击重试加载
    if (img.getAttribute('data-error') === 'true') {
      retryInlineImageLoad(img);
      return;
    }
    // 使用原始 src（未转义的）作为 lightbox 源，浏览器会自动处理
    openImageViewer(img.src);
  }
}

/**
 * 重试加载失败的图片：重置加载状态，重新触发 src 加载。
 * 通过先清空 src 再设回，强制浏览器重新发起请求。
 */
function retryInlineImageLoad(img: HTMLImageElement): void {
  img.removeAttribute('data-error');
  img.setAttribute('data-loading', 'true');
  img.classList.remove('inline-illustration-loaded');
  img.removeAttribute('data-bound');
  // 先保存原始 src，清空后重新赋值以触发重新加载
  const src = img.src;
  img.src = '';
  img.src = src;
  bindInlineImgEvents(img);
}

/** 是否正在监听滚动（避免恢复进度时触发保存） */
let suppressScrollSave = false;

/** 最大拼接章节数（超过后清理最早的章节） */
const MAX_CHAPTERS = 5;

/** 触底/触顶自动加载的距离阈值（px） — 提前加载，避免用户等到边界 */
const LOAD_THRESHOLD = 600;

/** 已加载的章节内容列表 */
interface LoadedChapter {
  index: number;
  title: string;
  paragraphs: string[];
  contentType: string | null;
  markdownHtml: string;
  /** 已渲染段落数（分批渲染：先渲染前 BATCH_SIZE 个，滚动到底部追加） */
  renderedCount: number;
}

/** 分批渲染的批次大小：先渲染前 30 个段落，滚动接近底部时追加 30 个 */
const RENDER_BATCH_SIZE = 30;
const loadedChapters = ref<LoadedChapter[]>([]);

/** 是否正在加载下一章 */
const isLoadingNext = ref<boolean>(false);

/** 是否正在加载上一章 */
const isLoadingPrev = ref<boolean>(false);

/** 是否正在全部加载 */
const isLoadingAll = ref<boolean>(false);

/* ==================== 加载动画延迟显示（防闪烁） ==================== */

/** 本地 SQLite 读取常小于 50ms，加载动画立即显示会一闪而过反而干扰阅读；
 * 仅当加载超过 300ms 仍进行中才显示动画，实现"快速加载全程无感"。 */
const LOADING_SHOW_DELAY_MS = 300;

/** 是否显示"正在加载下一章"动画（isLoadingNext 置 true 满 300ms 后才置 true） */
const showLoadingNext = ref<boolean>(false);

/** 是否显示"正在加载上一章"动画（isLoadingPrev 置 true 满 300ms 后才置 true） */
const showLoadingPrev = ref<boolean>(false);

/** 延迟显示"加载下一章"动画的定时器（一次性 setTimeout 也需保存 ID 并纳入生命周期清理） */
let loadingNextDelayTimer: ReturnType<typeof setTimeout> | null = null;

/** 延迟显示"加载上一章"动画的定时器 */
let loadingPrevDelayTimer: ReturnType<typeof setTimeout> | null = null;

/** 启动"加载下一章"动画的延迟显示计时：超时仍在加载才真正显示 */
function scheduleShowLoadingNext(): void {
  clearShowLoadingNext();
  loadingNextDelayTimer = setTimeout(() => {
    loadingNextDelayTimer = null;
    if (isLoadingNext.value) showLoadingNext.value = true;
  }, LOADING_SHOW_DELAY_MS);
}

/** 停止延迟显示计时并复位动画显示状态（加载完成/中断/组件卸载时调用） */
function clearShowLoadingNext(): void {
  if (loadingNextDelayTimer !== null) {
    clearTimeout(loadingNextDelayTimer);
    loadingNextDelayTimer = null;
  }
  showLoadingNext.value = false;
}

/** 启动"加载上一章"动画的延迟显示计时：超时仍在加载才真正显示 */
function scheduleShowLoadingPrev(): void {
  clearShowLoadingPrev();
  loadingPrevDelayTimer = setTimeout(() => {
    loadingPrevDelayTimer = null;
    if (isLoadingPrev.value) showLoadingPrev.value = true;
  }, LOADING_SHOW_DELAY_MS);
}

/** 停止延迟显示计时并复位动画显示状态（加载完成/中断/组件卸载时调用） */
function clearShowLoadingPrev(): void {
  if (loadingPrevDelayTimer !== null) {
    clearTimeout(loadingPrevDelayTimer);
    loadingPrevDelayTimer = null;
  }
  showLoadingPrev.value = false;
}

/** 全文模式的原始文本流（像记事本一样，不分章、不格式化） */
const rawFullText = ref<string>('');

/** 组件是否已卸载（防止 async 操作完成后写入已卸载的组件状态） */
let isUnmounted = false;

/** 是否还有更多章节可加载（向下） */
const hasMoreChapters = computed<boolean>(() => {
  if (loadedChapters.value.length === 0) return false;
  const lastIdx = loadedChapters.value[loadedChapters.value.length - 1].index;
  return lastIdx < store.chapters.length - 1;
});

/** 是否还有上一章可加载（向上） */
const hasPrevChapters = computed<boolean>(() => {
  if (loadedChapters.value.length === 0) return false;
  const firstIdx = loadedChapters.value[0].index;
  return firstIdx > 0;
});

/* ==================== 工具函数 ==================== */

/** 获取章节标题 */
function getChapterTitle(idx: number): string {
  return store.chapters[idx]?.title ?? t('readerViews.chapterFallback', { n: idx + 1 });
}

/* ==================== 高亮可视化 ==================== */

/** 获取当前已加载章节中所有有高亮颜色的笔记（按章节索引分组） */
const highlightNotesByChapter = computed<Map<number, Array<{ content: string; color: string }>>>(() => {
  const map = new Map<number, Array<{ content: string; color: string }>>();
  for (const bm of bookmarkStore.bookmarks) {
    if (bm.highlight_color && bm.content) {
      const list = map.get(bm.chapter_index) ?? [];
      list.push({ content: bm.content, color: bm.highlight_color });
      map.set(bm.chapter_index, list);
    }
  }
  return map;
});

/* ==================== 初始化 ==================== */

/** 初始化已加载章节列表（只加载当前章节） */
function initLoadedChapters(): void {
  const idx = store.currentChapterIndex;
  const contentType = store.chapters[idx]?.content_type ?? 'text';
  if (contentType === 'markdown') {
    const markdownHtml = renderMarkdown(store.chapterContent);
    loadedChapters.value = [
      { index: idx, title: getChapterTitle(idx), paragraphs: [], contentType, markdownHtml, renderedCount: 0 }
    ];
  } else {
    const paragraphs = splitParagraphs(store.chapterContent);
    const renderedCount = Math.min(paragraphs.length, RENDER_BATCH_SIZE);
    loadedChapters.value = [
      { index: idx, title: getChapterTitle(idx), paragraphs, contentType, markdownHtml: '', renderedCount }
    ];
  }
}

/* ==================== 全文渐进渲染（无感化） ==================== */

/** 全文模式渐进渲染批次参数：首屏先渲染 3 章立即可读，剩余章节空闲时每批 3 章静默拼接 */
const FULL_TEXT_FIRST_BATCH = 3;
const FULL_TEXT_CHUNK_BATCH = 3;

/** 渲染环境是否支持 requestIdleCallback（Chromium 支持，否则退化为 setTimeout 0） */
const supportsIdleCallback = typeof requestIdleCallback === 'function';

/** 全文渐进拼接的空闲任务句柄（requestIdleCallback / setTimeout 的 ID，需纳入生命周期清理） */
let fullTextIdleHandle: number | null = null;

/** 全文渐进拼接是否已全部完成（完成前 scrollHeight 不完整，归一化定位会失真） */
let fullTextComplete = true;

/** 全文渐进拼接完成前暂存的目标恢复位置（拼接完成后重放精确定位） */
let pendingFullTextPosition: number | null = null;

/** 调度全文渐进拼接批次：优先 requestIdleCallback（浏览器空闲时机），不支持时退化为 setTimeout 0 */
function scheduleFullTextIdle(callback: () => void): void {
  if (supportsIdleCallback) {
    fullTextIdleHandle = requestIdleCallback(() => {
      fullTextIdleHandle = null;
      callback();
    });
  } else {
    fullTextIdleHandle = window.setTimeout(() => {
      fullTextIdleHandle = null;
      callback();
    }, 0);
  }
}

/** 取消全文渐进拼接任务（组件卸载/重新加载时调用），并复位暂存的恢复位置 */
function cancelFullTextLoad(): void {
  if (fullTextIdleHandle !== null) {
    if (supportsIdleCallback) cancelIdleCallback(fullTextIdleHandle);
    else clearTimeout(fullTextIdleHandle);
    fullTextIdleHandle = null;
  }
  fullTextComplete = true;
  pendingFullTextPosition = null;
}

/** 全文渐进拼接完成后重放暂存的恢复位置
 *
 * scrollToPosition 可能在全文尚未拼接完成时被调用（组件挂载后 1~2 帧内），
 * 归一化定位基于不完整的 scrollHeight 会失真（原一次性加载在此时序下
 * scrollHeight 尚为 0，恢复实际失效）。暂存目标位置，待全部章节拼接
 * 完成后再精确定位一次。
 */
function replayPendingFullTextPosition(): void {
  if (pendingFullTextPosition === null || isUnmounted) return;
  const pos = pendingFullTextPosition;
  pendingFullTextPosition = null;
  void scrollToPosition(pos).catch((e) => console.error('scrollToPosition 重放失败:', e));
}

/** 全文渐进加载：先同步读取首屏章节立即渲染，剩余章节在浏览器空闲时机分批静默拼接
 *
 * 无感化目标：打开全文模式即刻可读，后台拼接过程不显示任何进度提示
 * （内容在视口下方增长，不影响当前阅读位置）。
 *
 * 与 scroll 模式的分章拼接明确区分：
 * - 不调用 splitParagraphs 分段
 * - 不添加章节标题
 * - 不填充 loadedChapters（保持为空，hasMoreChapters 返回 false，不触发拼接加载）
 * - 结果存入 rawFullText，模板用 white-space: pre-wrap 原样显示
 */
async function loadAllChapters(): Promise<void> {
  if (!store.book || store.chapters.length === 0) return;
  // 防御：取消可能仍在进行的旧拼接任务，避免双写
  cancelFullTextLoad();
  fullTextComplete = false;
  const total = store.chapters.length;
  let nextChapter = 0;
  isLoadingAll.value = true;
  suppressScrollSave = true;
  let firstBatchFailed = false;
  try {
    // 首屏：先读取前几章立即渲染，用户马上可以开始阅读
    const firstEnd = Math.min(FULL_TEXT_FIRST_BATCH, total);
    const parts: string[] = [];
    for (; nextChapter < firstEnd; nextChapter++) {
      if (isUnmounted) return;
      const content = await window.dbApi.book.readChapter(store.book.id, nextChapter);
      if (isUnmounted) return;
      parts.push(content);
    }
    if (isUnmounted) return;
    rawFullText.value = parts.join('\n');
  } catch (err) {
    firstBatchFailed = true;
    console.error('[ScrollView] 全文加载失败:', err);
  } finally {
    // 首屏就绪即解除加载态：用户已可阅读，剩余拼接静默进行（不显示任何进度提示）
    isLoadingAll.value = false;
    setTimeout(() => {
      suppressScrollSave = false;
    }, 50);
  }
  if (firstBatchFailed || nextChapter >= total) {
    fullTextComplete = true;
    return;
  }

  /** 读取下一批章节并静默追加到文档末尾，直至全部拼接完成 */
  const appendChunk = async (): Promise<void> => {
    if (isUnmounted || !store.book) return;
    const end = Math.min(nextChapter + FULL_TEXT_CHUNK_BATCH, total);
    const parts: string[] = [];
    for (let i = nextChapter; i < end; i++) {
      const content = await window.dbApi.book.readChapter(store.book.id, i);
      if (isUnmounted) return;
      parts.push(content);
    }
    nextChapter = end;
    // 静默追加到文档末尾：内容在视口下方增长，不影响当前阅读位置
    rawFullText.value += '\n' + parts.join('\n');
    if (nextChapter < total) {
      if (isUnmounted) return;
      scheduleFullTextIdle(() => {
        void appendChunk().catch((e) => {
          console.error('[ScrollView] 全文渐进拼接失败:', e);
          fullTextComplete = true;
        });
      });
    } else {
      // 全部拼接完成：重放渐进期间暂存的恢复位置，实现精确定位
      fullTextComplete = true;
      replayPendingFullTextPosition();
    }
  };
  scheduleFullTextIdle(() => {
    void appendChunk().catch((e) => {
      console.error('[ScrollView] 全文渐进拼接失败:', e);
      fullTextComplete = true;
    });
  });
}

/* ==================== 滚动事件 ==================== */

/** 滚动事件处理：触底加载 + 更新章节索引 + 保存进度（requestAnimationFrame 节流） */
let scrollRafId: number | null = null;

/** 滚动结束后最终检测的 timer（补偿 suppressScrollSave 窗口期间被跳过的触底/触顶检测） */
let scrollEndTimer: number | null = null;

/** scrollToPosition/scrollToTop 恢复 suppressScrollSave 的定时器 */
let scrollRestoreTimer: ReturnType<typeof setTimeout> | null = null;

/** 重新检测滚动位置，补偿 suppressScrollSave 窗口期间被跳过的检测 */
function recheckScroll(): void {
  if (!scrollRef.value || suppressScrollSave) return;
  void doHandleScroll().catch((e) => console.error('doHandleScroll 失败:', e));
}

async function handleScroll(): Promise<void> {
  if (scrollRafId !== null) return;
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    void doHandleScroll().catch((e) => console.error('doHandleScroll 失败:', e));
  });
  // 滚动结束后做一次最终检测（补偿 suppressScrollSave 窗口期间被跳过的检测）
  if (scrollEndTimer !== null) clearTimeout(scrollEndTimer);
  scrollEndTimer = window.setTimeout(() => {
    scrollEndTimer = null;
    recheckScroll();
  }, 150);
}

/** 分批渲染检测：接近底部时追加渲染更多段落（避免一次性渲染几百个段落/图片） */
function checkBatchRender(): void {
  if (!scrollRef.value) return;
  const el = scrollRef.value;
  const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  // 距离底部 2000px 以内时（约两屏提前量）追加渲染：提前量远大于正常滚动速度，
  // 用户滚动永远"追不上"渲染追加，分批渲染全程无感
  if (distanceToBottom > 2000) return;
  let changed = false;
  for (const ch of loadedChapters.value) {
    if (ch.renderedCount < ch.paragraphs.length) {
      ch.renderedCount = Math.min(ch.renderedCount + RENDER_BATCH_SIZE, ch.paragraphs.length);
      changed = true;
    }
  }
  if (changed) {
    // 触发响应式更新
    loadedChapters.value = [...loadedChapters.value];
    // 分批渲染后新段落中的图片需要纳入 IntersectionObserver 观察
    // （watch 只监听 loadedChapters.length 变化，不监听 renderedCount，所以这里手动调用）
    nextTick(() => observeInlineImages());
  }
}

async function doHandleScroll(): Promise<void> {
  if (!scrollRef.value) return;
  const el = scrollRef.value;

  // suppressScrollSave 期间（trimOldChapters/trimNewChapters 调整 scrollTop、恢复进度等），
  // 跳过所有副作用：不加载新章节、不更新章节索引、不保存进度。
  // 否则程序性滚动调整会触发错误的章节检测和连锁加载。
  if (suppressScrollSave) return;

  // 分批渲染：接近底部时追加渲染更多段落
  checkBatchRender();

  // 检测是否接近顶部，触发自动加载上一章（仅无限拼接模式）
  if (infiniteScrollEnabled.value && el.scrollTop < LOAD_THRESHOLD && hasPrevChapters.value && !isLoadingPrev.value) {
    void prependPrevChapter().catch((e) => console.error('prependPrevChapter 失败:', e));
  }

  // 检测是否接近底部，触发自动加载下一章（仅无限拼接模式）
  const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (
    infiniteScrollEnabled.value &&
    distanceToBottom < LOAD_THRESHOLD &&
    hasMoreChapters.value &&
    !isLoadingNext.value
  ) {
    void appendNextChapter().catch((e) => console.error('appendNextChapter 失败:', e));
  }

  // 更新当前章节索引（用于进度追踪和 UI 显示）
  updateCurrentChapterFromScroll();

  // 实时更新滚动位置（不受 debounce 影响，用于进度条显示）
  // 使用段落索引归一化（与 scrollToPosition 的坐标系一致），确保保存/加载位置一致
  // 根因⑤：全文渐进拼接未完成时 getCurrentPosition 返回 null——实时位置与
  // debounce 保存一并跳过（分母失真时不写错误值，拼接完成后恢复上报）
  const progress = getCurrentPosition();
  if (progress !== null) {
    store.setLiveScrollPosition(progress);
    // 保存进度（基于当前章节内归一化位置）
    // 任务25：文本模式 chapter_offset = 章内字符偏移（内容锚点，免疫排版变化）。
    // liveChapterCharOffset 已在上方 getCurrentPosition 内同步更新；
    // markdown/全文模式锚点为 0（恢复走比例路径，向后兼容）
    store.scheduleProgressSave(progress, store.liveChapterCharOffset);
  }
}

/** 从滚动位置推断当前章节，更新 store.currentChapterIndex
 *
 * 使用相邻章节的 offsetTop 作为边界，而非 offsetTop + offsetHeight。
 * 因为 offsetHeight 不包含 margin-bottom（.chapter-section 有 margin-bottom: var(--spacing-lg)），
 * 直接用 offsetTop + offsetHeight 会导致章节间的 margin 区域不属于任何章节，
 * scrollTop 落在 margin 缝隙中时无法匹配任何章节，可能误判为上一章或无匹配。
 * 用下一个章节的 offsetTop 作为当前章节的下边界，自然包含 margin 间距。
 */
function updateCurrentChapterFromScroll(): void {
  if (!scrollRef.value) return;
  const el = scrollRef.value;
  const scrollTop = el.scrollTop;

  const sectionEls = el.querySelectorAll<HTMLElement>('.chapter-section');
  for (let i = 0; i < sectionEls.length; i++) {
    const section = sectionEls[i];
    const top = section.offsetTop;
    // 下边界 = 下一个章节的 offsetTop（包含当前章节的 margin-bottom）；
    // 最后一个章节的下边界 = 容器 scrollHeight
    const bottom = i + 1 < sectionEls.length ? sectionEls[i + 1].offsetTop : el.scrollHeight;
    // 视口顶部落在某个章节范围内
    if (scrollTop >= top && scrollTop < bottom) {
      const ch = loadedChapters.value[i];
      if (ch && ch.index !== store.currentChapterIndex) {
        // 先保存旧章节的最终进度（接近 1.0），防止 debounce 未触发时丢失
        // getCurrentPosition() 在 setCurrentChapterIndex 之前调用，查询的是旧章节的段落
        // 根因⑤：拼接中返回 null 时跳过保存（不写错误值）
        // 任务25：保存链顺带章内字符偏移（getCurrentPosition 内已同步更新
        // liveChapterCharOffset——旧章的锚点值）
        const oldProgress = getCurrentPosition();
        if (oldProgress !== null) {
          void store
            .saveProgressImmediate(oldProgress, store.liveChapterCharOffset)
            .catch((e) => console.error('store.saveProgressImmediate 失败:', e));
        }
        // 通过 action 更新 store 的章节索引，让 UI（标题、进度条等）同步
        store.setCurrentChapterIndex(ch.index);
        // 保存新章节的初始进度（接近 0）
        // 使用段落索引归一化（与 scrollToPosition 的坐标系一致）
        const newProgress = getCurrentPosition();
        if (newProgress !== null) {
          void store
            .saveProgressImmediate(newProgress, store.liveChapterCharOffset)
            .catch((e) => console.error('store.saveProgressImmediate 失败:', e));
        }
      }
      break;
    }
  }
}

/** 计算当前章节内的归一化进度（0~1），用于进度保存和恢复
 *
 * 与 updateCurrentChapterFromScroll 同理，使用相邻章节 offsetTop 作为边界，
 * 确保 margin 间距被正确包含在章节范围内。
 */
function getCurrentChapterProgress(): number {
  if (!scrollRef.value) return 0;
  const el = scrollRef.value;
  // 全文模式：简单的 scrollTop 归一化（纯文本流，无章节结构）
  if (props.loadAll) {
    const max = el.scrollHeight - el.clientHeight;
    return max > 0 ? Math.max(0, Math.min(1, el.scrollTop / max)) : 0;
  }
  const scrollTop = el.scrollTop;

  const sectionEls = el.querySelectorAll<HTMLElement>('.chapter-section');
  // 先尝试精确匹配（scrollTop 落在某个 section 范围内）
  for (let i = 0; i < sectionEls.length; i++) {
    const section = sectionEls[i];
    const top = section.offsetTop;
    const bottom = i + 1 < sectionEls.length ? sectionEls[i + 1].offsetTop : el.scrollHeight;
    if (scrollTop >= top && scrollTop < bottom) {
      const chapterScroll = scrollTop - top;
      const chapterHeight = bottom - top;
      const chapterMax = Math.max(1, chapterHeight - el.clientHeight);
      return Math.max(0, Math.min(1, chapterScroll / chapterMax));
    }
  }

  // 章节缝隙 fallback：scrollTop 在所有 section 之外（如顶部 padding 或底部）
  // 找最近的 section 并返回边界值
  if (sectionEls.length > 0) {
    const firstTop = sectionEls[0].offsetTop;
    if (scrollTop < firstTop) {
      // 在第一个 section 上方（padding 区域），进度为 0
      return 0;
    }
    // 在最后一个 section 下方，进度为 1（已读完）
    return 1;
  }

  return 0;
}

/* ==================== 无限拼接加载 ==================== */

/** 自动加载下一章并拼接到底部 */
async function appendNextChapter(): Promise<void> {
  if (isLoadingNext.value || !store.book) return;

  const lastChapter = loadedChapters.value[loadedChapters.value.length - 1];
  if (!lastChapter) return;

  const nextIdx = lastChapter.index + 1;
  if (nextIdx >= store.chapters.length) return;

  isLoadingNext.value = true;
  scheduleShowLoadingNext();
  try {
    const content = await window.dbApi.book.readChapter(store.book.id, nextIdx);
    if (isUnmounted) return;
    const contentType = store.chapters[nextIdx]?.content_type ?? 'text';
    let paragraphs: string[] = [];
    let markdownHtml = '';
    if (contentType === 'markdown') {
      markdownHtml = renderMarkdown(content);
    } else {
      paragraphs = splitParagraphs(content);
    }
    loadedChapters.value.push({
      index: nextIdx,
      title: getChapterTitle(nextIdx),
      paragraphs,
      contentType,
      markdownHtml,
      renderedCount: Math.min(paragraphs.length, RENDER_BATCH_SIZE)
    });

    // 清理过多章节，保持内存可控
    await trimOldChapters();

    // 加载完成后重新检测：如果仍接近底部（如新章节很短或用户滚动很快），继续加载下一章
    recheckScroll();
  } catch (err) {
    console.error('[ScrollView] 加载下一章失败:', err);
  } finally {
    isLoadingNext.value = false;
    // 快速加载（<300ms）时清除延迟定时器，动画全程不显示（无感）
    clearShowLoadingNext();
  }
}

/** 自动加载上一章并拼接到顶部
 *
 * 加载上一章后，新章节在 DOM 最上方，会把当前内容向下推。
 * 需要 scrollTop += 新章节高度，保持用户当前阅读位置不变。
 */
async function prependPrevChapter(): Promise<void> {
  if (isLoadingPrev.value || !store.book) return;

  const firstChapter = loadedChapters.value[0];
  if (!firstChapter) return;

  const prevIdx = firstChapter.index - 1;
  if (prevIdx < 0) return;

  isLoadingPrev.value = true;
  suppressScrollSave = true;
  scheduleShowLoadingPrev();

  try {
    const content = await window.dbApi.book.readChapter(store.book.id, prevIdx);
    if (isUnmounted) return;
    const contentType = store.chapters[prevIdx]?.content_type ?? 'text';
    let paragraphs: string[] = [];
    let markdownHtml = '';
    if (contentType === 'markdown') {
      markdownHtml = renderMarkdown(content);
    } else {
      paragraphs = splitParagraphs(content);
    }

    const oldScrollTop = scrollRef.value?.scrollTop ?? 0;

    // 插入到开头
    loadedChapters.value.unshift({
      index: prevIdx,
      title: getChapterTitle(prevIdx),
      paragraphs,
      contentType,
      markdownHtml,
      renderedCount: Math.min(paragraphs.length, RENDER_BATCH_SIZE)
    });

    await nextTick();

    // 测量新加载章节占据的空间（使用相邻 offsetTop 差值，包含 margin）
    if (scrollRef.value) {
      const sectionEls = scrollRef.value.querySelectorAll<HTMLElement>('.chapter-section');
      if (sectionEls.length >= 2) {
        const newChapterSpace = sectionEls[1].offsetTop - sectionEls[0].offsetTop;
        scrollRef.value.scrollTop = oldScrollTop + newChapterSpace;
      }
    }

    // 清理过多章节，保持内存可控
    await trimNewChapters();
  } catch (err) {
    console.error('[ScrollView] 加载上一章失败:', err);
  } finally {
    isLoadingPrev.value = false;
    // 快速加载（<300ms）时清除延迟定时器，动画全程不显示（无感）
    clearShowLoadingPrev();
    setTimeout(() => {
      suppressScrollSave = false;
      // 补偿被跳过的触底/触顶检测
      recheckScroll();
    }, 50);
  }
}

/** 清理最早的章节，保持最多 MAX_CHAPTERS 章
 *
 * 关键：在 shift() 之前就设置 suppressScrollSave = true，
 * 因为 shift() 触发的 Vue 响应式更新 → DOM 变化 → scroll 事件可能在
 * suppressScrollSave 设置之前就触发了，导致错误的章节检测和连锁加载。
 */
async function trimOldChapters(): Promise<void> {
  if (props.loadAll) return;
  if (loadedChapters.value.length <= MAX_CHAPTERS) return;
  if (!scrollRef.value) return;

  const el = scrollRef.value;
  const sectionEls = el.querySelectorAll<HTMLElement>('.chapter-section');
  if (sectionEls.length < 2) return;

  // 使用相邻章节的 offsetTop 差值计算被移除章节占据的空间（包含 margin-bottom）
  const removedHeight = sectionEls[1].offsetTop - sectionEls[0].offsetTop;
  const oldScrollTop = el.scrollTop;

  // 在移除之前设置 suppressScrollSave，防止 DOM 更新触发的滚动事件
  suppressScrollSave = true;

  // 移除最早的章节
  loadedChapters.value.shift();

  await nextTick();

  // 调整滚动位置，保持用户当前阅读位置不变
  if (scrollRef.value) {
    scrollRef.value.scrollTop = oldScrollTop - removedHeight;
  }

  setTimeout(() => {
    suppressScrollSave = false;
    // 补偿被跳过的触底/触顶检测
    recheckScroll();
  }, 50);
}

/** 清理最晚的章节，保持最多 MAX_CHAPTERS 章
 *
 * 向上加载后清理最晚的章节（下方内容），不需要调整 scrollTop，
 * 因为清理的是用户视线之外的下端内容。
 */
async function trimNewChapters(): Promise<void> {
  if (props.loadAll) return;
  if (loadedChapters.value.length <= MAX_CHAPTERS) return;

  loadedChapters.value.pop();
  await nextTick();
}

/* ==================== 自动滚动 ==================== */

/** 自动滚动是否激活 */
const autoScrollActive = computed<boolean>(() => props.autoScroll ?? false);

/** 自动滚动是否暂停（用户点击屏幕后暂停） */
const autoScrollPaused = ref<boolean>(false);

/** 自动滚动动画帧 ID */
let autoScrollRafId: number | null = null;

/** 自动滚动上次帧时间戳（用于计算 delta） */
let autoScrollLastTime = 0;

/** 自动滚动速度（px/s），从 settings.autoScrollSpeed 映射（10-200 → 10-200 px/s） */
const autoScrollPxPerSecond = computed<number>(() => {
  return store.autoScrollSpeed;
});

/** 自动滚动动画循环 */
function autoScrollLoop(timestamp: number): void {
  if (!autoScrollActive.value || autoScrollPaused.value) {
    autoScrollRafId = null;
    return;
  }
  if (!scrollRef.value) {
    autoScrollRafId = null;
    return;
  }

  if (autoScrollLastTime === 0) {
    autoScrollLastTime = timestamp;
  }
  const delta = timestamp - autoScrollLastTime;
  autoScrollLastTime = timestamp;

  // 计算本次帧应滚动的像素数
  const pixelsToScroll = (autoScrollPxPerSecond.value * delta) / 1000;
  const el = scrollRef.value;

  // 检查是否已滚动到底部
  const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distanceToBottom <= 0) {
    // 修复：到底部时不要直接停止，而是尝试加载下一章继续滚动
    // 在无限拼接模式下，主动触发下一章加载
    if (infiniteScrollEnabled.value && hasMoreChapters.value && !isLoadingNext.value) {
      void appendNextChapter()
        .then(() => {
          // 下一章加载完成后，如果自动滚动仍然激活，继续滚动
          if (autoScrollActive.value && !autoScrollPaused.value && !isUnmounted) {
            autoScrollLastTime = 0;
            autoScrollRafId = requestAnimationFrame(autoScrollLoop);
          }
        })
        .catch((e) => console.error('appendNextChapter 失败:', e));
      // 等待章节加载期间暂停滚动，避免空转
      autoScrollRafId = null;
      return;
    }
    // 没有更多章节了，停止自动滚动
    autoScrollPaused.value = true;
    autoScrollRafId = null;
    return;
  }

  // 使用 suppressScrollSave 避免自动滚动触发进度保存和章节加载
  suppressScrollSave = true;
  el.scrollTop += pixelsToScroll;
  // 短暂延迟后恢复 scrollSave，让正常滚动事件处理
  setTimeout(() => {
    suppressScrollSave = false;
  }, 0);

  // 修复：自动滚动时也检测是否接近底部，主动加载下一章（因为 suppressScrollSave 阻止了 doHandleScroll 的检测）
  if (
    infiniteScrollEnabled.value &&
    distanceToBottom < LOAD_THRESHOLD &&
    hasMoreChapters.value &&
    !isLoadingNext.value
  ) {
    void appendNextChapter().catch((e) => console.error('appendNextChapter 失败:', e));
  }

  autoScrollRafId = requestAnimationFrame(autoScrollLoop);
}

/** 启动自动滚动动画 */
function startAutoScrollLoop(): void {
  if (autoScrollRafId !== null) return;
  autoScrollLastTime = 0;
  autoScrollPaused.value = false;
  autoScrollRafId = requestAnimationFrame(autoScrollLoop);
}

/** 停止自动滚动动画 */
function stopAutoScrollLoop(): void {
  if (autoScrollRafId !== null) {
    cancelAnimationFrame(autoScrollRafId);
    autoScrollRafId = null;
  }
  autoScrollPaused.value = false;
  // 确保恢复 suppressScrollSave，避免停止后用户滚动事件被忽略
  suppressScrollSave = false;
}

/** 暂停自动滚动（用户点击屏幕） */
function pauseAutoScroll(): void {
  autoScrollPaused.value = true;
  stopAutoScrollLoop();
}

/** 继续自动滚动 */
function resumeAutoScroll(): void {
  if (!autoScrollActive.value) return;
  autoScrollPaused.value = false;
  startAutoScrollLoop();
}

/** 点击正文区域暂停/继续自动滚动 */
function handleAutoScrollClick(): void {
  if (!autoScrollActive.value) return;
  if (autoScrollPaused.value) {
    resumeAutoScroll();
  } else {
    pauseAutoScroll();
  }
}

/* ==================== 暴露方法 ==================== */

/** 是否正在恢复阅读进度（防止 watch chapterContent 的 scrollToTop 覆盖位置恢复） */
let isPositionRestoring = false;

/** prepareRestore 安全超时定时器：如果 scrollToPosition 从未被调用（如 initReader 被取消），自动重置标志位 */
let prepareRestoreTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 在 loadChapter 之前调用，提前设置标志位。
 * 时序：loadChapter → watch chapterContent → nextTick(scrollToTop) → waitForComponentReady → scrollToPosition
 * scrollToTop 在 scrollToPosition 之前执行，所以必须在 loadChapter 之前就设置标志位。
 */
function prepareRestore(): void {
  isPositionRestoring = true;
  // 安全超时：5 秒后自动重置，防止 scrollToPosition 从未被调用时标志位永久卡住
  if (prepareRestoreTimer) clearTimeout(prepareRestoreTimer);
  prepareRestoreTimer = setTimeout(() => {
    prepareRestoreTimer = null;
    isPositionRestoring = false;
  }, 5000);
}

/**
 * 滚动到指定位置（0~1 归一化，基于段落索引，不受渲染尺寸影响）。
 *
 * @param position 章内归一化位置（段落级坐标系，根因①统一分母）
 * @param charOffset 可选章内字符偏移（任务27）：携带保存时的**真实段内位置**，
 *   恢复定位用它反推段内比例（charOffsetToInParaRatio），往返偏差从任务23
 *   固定 0.5 的 0.5×段高（半行一行）降到像素级。不传（旧调用/图片模式/
 *   无锚点数据）时保持段中部 0.5 的既有行为，完全向后兼容。
 */
async function scrollToPosition(position: number, charOffset?: number): Promise<void> {
  isPositionRestoring = true;
  await nextTick();
  if (!scrollRef.value) {
    isPositionRestoring = false;
    return;
  }
  suppressScrollSave = true;
  const el = scrollRef.value;

  // 全文模式：简单的 scrollTop 定位（纯文本流，无段落/章节结构）
  if (props.loadAll) {
    // 渐进拼接未完成时 scrollHeight 不完整，归一化定位会失真：
    // 先基于当前已有内容尽力定位，同时暂存目标位置，待拼接完成后重放精确定位
    if (!fullTextComplete && position > 0) {
      pendingFullTextPosition = position;
    }
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = position * max;
    if (prepareRestoreTimer) {
      clearTimeout(prepareRestoreTimer);
      prepareRestoreTimer = null;
    }
    if (scrollRestoreTimer) clearTimeout(scrollRestoreTimer);
    scrollRestoreTimer = setTimeout(() => {
      scrollRestoreTimer = null;
      suppressScrollSave = false;
      isPositionRestoring = false;
      recheckScroll();
    }, 50);
    return;
  }

  // 只查当前章节内的段落（scroll/all 模式下 loadedChapters 含多章节，不能用全局段落索引）
  const getSectionParas = (): NodeListOf<HTMLElement> => {
    const section = getCurrentSectionEl();
    if (section) return section.querySelectorAll<HTMLElement>('.paragraph');
    return el.querySelectorAll<HTMLElement>('.paragraph');
  };

  // 等待段落渲染完成（重试最多 10 帧，解决段落多/渲染慢时@querySelectorAll 返回空的问题）
  let paraEls: NodeListOf<HTMLElement> = getSectionParas();
  for (let attempt = 0; attempt < 10 && paraEls.length === 0; attempt++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await nextTick();
    if (!scrollRef.value) {
      isPositionRestoring = false;
      return;
    }
    paraEls = getSectionParas();
  }

  // 分批渲染：如果目标段落超出已渲染范围，先扩展 renderedCount
  // 根因①：目标段落换算统一用全章段落数（与 getCurrentPosition 完全对称）
  const currentCh = loadedChapters.value.find((ch) => ch.index === store.currentChapterIndex);
  /** 全章段落数（数据侧真值；currentCh 缺失（异常态）时回退 DOM 查询数） */
  const totalParagraphs = currentCh?.paragraphs.length ?? 0;
  if (currentCh && totalParagraphs > 0) {
    const targetIdx = positionToParagraphIndex(position, totalParagraphs);
    if (targetIdx >= currentCh.renderedCount) {
      // 扩展到目标段落 + 一屏的余量
      currentCh.renderedCount = Math.min(targetIdx + RENDER_BATCH_SIZE, currentCh.paragraphs.length);
      loadedChapters.value = [...loadedChapters.value];
      await nextTick();
      // 扩展渲染后新图片需要纳入观察
      observeInlineImages();
    }
  }

  /**
   * 用段落索引定位到目标段落（二次校正时重新查询，因为图片加载可能改变段落位置）。
   *
   * 根因①（坐标语义对齐）：保存语义是"段落底过视口顶"（视口顶位于段落 i 内部，
   * getCurrentPosition 返回 i/(N-1)），恢复定位把视口顶放到目标段落内。
   *
   * 任务27（段内精度）：任务23 固定定位到段中部 0.5——用户实际读到段内
   * 0.7~0.9 处时恢复到 0.5 向上偏 0.2~0.4×段高（半行一行）。现传入 charOffset
   * 反推**真实段内比例**（保存侧 getCurrentPosition 已携带像素位置），
   * 往返偏差降到像素级；无 charOffset 时回退 0.5（旧调用兼容）。
   *
   * 定位实现用手动设置 scrollTop 而非 scrollIntoView：
   * - scrollIntoView({block:'start'}) 是"段顶贴视口顶"，比保存语义偏前半个到一个段落
   * - getBoundingClientRect 差值换算不依赖 offsetParent 定位上下文（paragraph 的
   *   offsetTop 相对的定位祖先可能不是滚动容器），坐标系更稳
   * - 直接赋值 scrollTop 无平滑滚动动画，瞬时精确定位
   * 二次校正（300ms/1000ms）共用本闭包，charOffset 捕获同样生效。
   */
  const scrollToParagraph = () => {
    if (!scrollRef.value) return;
    const paras = getSectionParas();
    const total = totalParagraphs > 1 ? totalParagraphs : paras.length;
    if (paras.length > 1 && total > 1) {
      const targetIdx = positionToParagraphIndex(position, total);
      const clampedIdx = Math.max(0, Math.min(paras.length - 1, targetIdx));
      const p = paras[clampedIdx];
      const elRect = scrollRef.value.getBoundingClientRect();
      const pRect = p.getBoundingClientRect();
      // 任务27：段内比例 = charOffset 反推（clampedIdx 与 DOM/源文本数组同序——
      // 分批渲染 slice(0, renderedCount) 保证 paras[k] ↔ paragraphs[k]）
      const inParaRatio =
        charOffset !== undefined && currentCh && currentCh.paragraphs.length > 0
          ? charOffsetToInParaRatio(currentCh.paragraphs, clampedIdx, charOffset)
          : 0.5;
      // 视口顶移到目标段落的真实段内位置：段落顶相对视口顶的偏移 + 段高×比例
      scrollRef.value.scrollTop += pRect.top - elRect.top + pRect.height * inParaRatio;
    }
  };

  if (paraEls.length > 1) {
    // 首次定位
    scrollToParagraph();
    // 二次校正：图片加载后段落位置变化，延迟重新定位
    // 300ms 覆盖小图片加载，1000ms 覆盖大图片加载
    setTimeout(scrollToParagraph, 300);
    setTimeout(scrollToParagraph, 1000);
  } else {
    // fallback：无段落或仅1段时用像素归一化（纯图片章节等）
    const sectionEls = el.querySelectorAll<HTMLElement>('.chapter-section');
    if (sectionEls.length > 0) {
      let targetSection: HTMLElement | null = null;
      for (let i = 0; i < sectionEls.length; i++) {
        const ch = loadedChapters.value[i];
        if (ch && ch.index === store.currentChapterIndex) {
          targetSection = sectionEls[i];
          break;
        }
      }
      if (!targetSection) {
        targetSection = sectionEls[0];
      }
      const sectionTop = targetSection.offsetTop;
      const sectionIdx = Array.from(sectionEls).indexOf(targetSection);
      const sectionBottom = sectionIdx + 1 < sectionEls.length ? sectionEls[sectionIdx + 1].offsetTop : el.scrollHeight;
      const sectionHeight = sectionBottom - sectionTop;
      const sectionMax = Math.max(1, sectionHeight - el.clientHeight);
      el.scrollTop = sectionTop + Math.max(0, Math.min(sectionMax, position * sectionMax));
      // 图片章节也做二次校正（图片加载后高度变化）
      setTimeout(() => {
        if (!scrollRef.value) return;
        const sEls = scrollRef.value.querySelectorAll<HTMLElement>('.chapter-section');
        let ts: HTMLElement | null = null;
        for (let i = 0; i < sEls.length; i++) {
          const ch = loadedChapters.value[i];
          if (ch && ch.index === store.currentChapterIndex) {
            ts = sEls[i];
            break;
          }
        }
        if (!ts && sEls.length > 0) ts = sEls[0];
        if (ts) {
          const sTop = ts.offsetTop;
          const sIdx = Array.from(sEls).indexOf(ts);
          const sBottom = sIdx + 1 < sEls.length ? sEls[sIdx + 1].offsetTop : scrollRef.value.scrollHeight;
          const sHeight = sBottom - sTop;
          const sMax = Math.max(1, sHeight - scrollRef.value.clientHeight);
          scrollRef.value.scrollTop = sTop + Math.max(0, Math.min(sMax, position * sMax));
        }
      }, 1000);
    } else {
      const max = Math.max(1, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.max(0, Math.min(max, position * max));
    }
  }

  // 延长 suppressScrollSave 恢复时间到 1200ms，覆盖二次校正期间不触发滚动保存
  if (prepareRestoreTimer) {
    clearTimeout(prepareRestoreTimer);
    prepareRestoreTimer = null;
  }
  if (scrollRestoreTimer) clearTimeout(scrollRestoreTimer);
  scrollRestoreTimer = setTimeout(() => {
    scrollRestoreTimer = null;
    suppressScrollSave = false;
    isPositionRestoring = false; // 位置恢复完成，允许后续 scrollToTop
    // 补偿被跳过的触底/触顶检测
    recheckScroll();
  }, 1200);
}

/** 滚动到顶部 */
async function scrollToTop(): Promise<void> {
  // 位置恢复期间跳过，防止 watch chapterContent 的 scrollToTop 覆盖 scrollToPosition
  if (isPositionRestoring) return;
  await nextTick();
  if (!scrollRef.value) return;
  suppressScrollSave = true;
  scrollRef.value.scrollTop = 0;
  if (scrollRestoreTimer) clearTimeout(scrollRestoreTimer);
  scrollRestoreTimer = setTimeout(() => {
    scrollRestoreTimer = null;
    suppressScrollSave = false;
    // 补偿被跳过的触底/触顶检测
    recheckScroll();
  }, 100);
}

/** 滚动到当前章节（全部加载模式下，点击目录章节时定位而非重置） */
async function scrollToCurrentChapter(): Promise<void> {
  // 位置恢复期间跳过，防止 watch chapterContent 的 scrollToCurrentChapter 覆盖 scrollToPosition
  if (isPositionRestoring) return;
  if (!scrollRef.value) return;
  const sectionEls = scrollRef.value.querySelectorAll<HTMLElement>('.chapter-section');
  for (let i = 0; i < sectionEls.length; i++) {
    const ch = loadedChapters.value[i];
    if (ch && ch.index === store.currentChapterIndex) {
      suppressScrollSave = true;
      scrollRef.value.scrollTo({ top: sectionEls[i].offsetTop, behavior: 'smooth' });
      if (scrollRestoreTimer) clearTimeout(scrollRestoreTimer);
      scrollRestoreTimer = setTimeout(() => {
        scrollRestoreTimer = null;
        suppressScrollSave = false;
        recheckScroll();
      }, 300);
      return;
    }
  }
}

/** 向下滚动一屏（Space / PageDown） */
function scrollPageDown(): void {
  if (!scrollRef.value) return;
  scrollRef.value.scrollBy({ top: scrollRef.value.clientHeight * 0.9, behavior: 'smooth' });
}

/** 向上滚动一屏（PageUp） */
function scrollPageUp(): void {
  if (!scrollRef.value) return;
  scrollRef.value.scrollBy({ top: -scrollRef.value.clientHeight * 0.9, behavior: 'smooth' });
}

/** 获取当前章节的 DOM section 元素（scroll/all 模式下多个章节中定位当前章节） */
function getCurrentSectionEl(): HTMLElement | null {
  if (!scrollRef.value) return null;
  const sectionEls = scrollRef.value.querySelectorAll<HTMLElement>('.chapter-section');
  for (let i = 0; i < sectionEls.length; i++) {
    const ch = loadedChapters.value[i];
    if (ch && ch.index === store.currentChapterIndex) {
      return sectionEls[i];
    }
  }
  return sectionEls.length > 0 ? sectionEls[0] : null;
}

/**
 * 获取当前归一化滚动位置（0~1），基于当前章节内段落索引，不受渲染尺寸影响。
 *
 * 根因①（坐标系统一，实测 81.8%→65.6% 偏移）：分母统一为**全章段落数**
 * （数据侧 loadedChapters 的 paragraphs.length），不再用"已渲染段落数"——
 * 分批渲染的 renderedCount 随滚动动态增长（30→34→66…），同一像素位置在
 * 渲染前后会算出不同 position，保存与恢复（scrollToPosition 用全章分母）
 * 坐标系错位，位置越深偏移越大。
 *
 * 返回 null 的场景（根因⑤，F-9）：全文模式渐进拼接未完成时
 * scrollHeight 只是"已拼接部分"，归一化会系统性失真（真实 10% 在拼接到
 * 50% 时被算成 0.2）——返回 null 让上报链（scheduleProgressSave）跳过保存，
 * 待拼接完成后恢复保存（丢失秒级保存但不写错误值）。
 */
function getCurrentPosition(): number | null {
  if (!scrollRef.value) return 0;
  const el = scrollRef.value;
  // 全文模式：简单的 scrollTop 归一化（纯文本流，无段落/章节结构）
  if (props.loadAll) {
    // 任务25：全文模式无可靠章内锚点（跨章文本流），字符偏移清零走比例路径
    store.setLiveChapterCharOffset(0);
    if (!fullTextComplete) return null;
    const max = el.scrollHeight - el.clientHeight;
    return max > 0 ? Math.max(0, Math.min(1, el.scrollTop / max)) : 0;
  }
  // 只查当前章节内的段落（scroll/all 模式下 loadedChapters 含多章节，不能用全局段落索引）
  const sectionEl = getCurrentSectionEl();
  if (!sectionEl) {
    store.setLiveChapterCharOffset(0);
    return getCurrentChapterProgress();
  }
  const paraEls = sectionEl.querySelectorAll<HTMLElement>('.paragraph');
  // 根因①：分母 = 全章段落数（数据侧），与 scrollToPosition 的恢复换算完全对称
  const currentCh = loadedChapters.value.find((ch) => ch.index === store.currentChapterIndex);
  const totalCount = currentCh?.paragraphs.length ?? paraEls.length;
  if (paraEls.length > 0 && totalCount > 1) {
    const viewportTop = el.scrollTop;
    // 任务28修正：坐标系统一为 rect 差值系——offsetTop 相对的 offsetParent
    // 可能不是滚动容器（实测存在 16px 结构偏差：保存侧 offsetTop 系 vs 恢复侧
    // scrollToParagraph 的 rect 系），16px ÷ 段高 97px ≈ 0.165 即用户实测的
    // "半行偏移"。保存/恢复两侧坐标系严格同源（同 scrollToParagraph 的换算）：
    // pTopInScroll = pRect.top - elRect.top + el.scrollTop
    const elRect = el.getBoundingClientRect();
    for (let i = 0; i < paraEls.length; i++) {
      const p = paraEls[i];
      const pRect = p.getBoundingClientRect();
      const pTopInScroll = pRect.top - elRect.top + el.scrollTop;
      // 第一个底部超过视口顶部的段落就是可见的第一个段落（rect 系，
      // 含段落间 margin 间隙：视口落在间隙时命中下一段、比例 clamp 至 0）
      if (pTopInScroll + pRect.height > viewportTop) {
        // 任务25：内容锚点——视口顶段落的章内字符偏移（源文本累加），免疫
        // 字号/行距等排版变化；与 position 同步维护，保存链随
        // scheduleProgressSave 一并落库（文本模式 chapter_offset 语义）
        // 任务27：段内比例用**真实像素位置**（视口顶在段内何处），替代固定
        // 0.5——保存携带真实位置，恢复侧 charOffsetToInParaRatio 反推还原，
        // 往返偏差从 0.5×段高（半行一行）降到像素级
        if (currentCh && currentCh.paragraphs.length > 0) {
          const inParaRatio =
            pRect.height > 0
              ? Math.max(0, Math.min(1, (viewportTop - pTopInScroll) / pRect.height))
              : 0.5;
          store.setLiveChapterCharOffset(
            computeChapterCharOffset(currentCh.paragraphs, i, inParaRatio)
          );
        }
        return paragraphIndexToPosition(i, totalCount);
      }
    }
    // 滚动到末尾：锚点 = 末段全文末尾（inParaRatio=1）
    if (currentCh && currentCh.paragraphs.length > 0) {
      store.setLiveChapterCharOffset(
        computeChapterCharOffset(currentCh.paragraphs, currentCh.paragraphs.length - 1, 1)
      );
    }
    return 1; // 滚动到末尾
  }
  // fallback：无段落时用像素归一化（纯图片章节/markdown 等无可靠字符锚点 → 0）
  store.setLiveChapterCharOffset(0);
  return getCurrentChapterProgress();
}

/** 获取当前可见区域的文本摘要（用于添加书签时自动填充 content） */
function getVisibleText(maxLength = 100): string {
  if (!scrollRef.value) return '';
  const el = scrollRef.value;
  const viewportTop = el.scrollTop;
  const viewportBottom = el.scrollTop + el.clientHeight;
  const paraEls = el.querySelectorAll<HTMLElement>('.paragraph');
  const visibleTexts: string[] = [];
  for (let i = 0; i < paraEls.length; i++) {
    const p = paraEls[i];
    const top = p.offsetTop;
    const bottom = top + p.offsetHeight;
    if (bottom >= viewportTop && top <= viewportBottom) {
      const text = (p.textContent ?? '').trim();
      if (text) visibleTexts.push(text);
    }
    if (top > viewportBottom) break;
  }
  const joined = visibleTexts.join(' ').replace(/\s+/g, ' ');
  return joined.length > maxLength ? joined.slice(0, maxLength) + '…' : joined;
}

defineExpose({
  scrollToPosition,
  scrollToTop,
  prepareRestore,
  scrollPageDown,
  scrollPageUp,
  getCurrentPosition,
  getVisibleText,
  pauseAutoScroll,
  resumeAutoScroll
});

/* ==================== 章节切换重置 ==================== */

/**
 * 监听 store.chapterContent 变化：外部加载新章节时（目录跳转、上一章/下一章按钮），
 * 重置已加载章节列表，只保留当前章节。
 * 无限拼接内部加载不修改 store.chapterContent，所以不会触发此 watch。
 */
watch(
  () => store.chapterContent,
  () => {
    if (props.loadAll) {
      void nextTick(() => scrollToCurrentChapter());
      return;
    }
    initLoadedChapters();
    void nextTick(() => scrollToTop());
  }
);

/* ==================== 自动滚动监听 ==================== */

/** 监听 autoScroll prop 变化，启动或停止自动滚动 */
watch(
  () => autoScrollActive.value,
  (active: boolean) => {
    if (active) {
      startAutoScrollLoop();
    } else {
      stopAutoScrollLoop();
    }
  }
);

/** 监听自动滚动速度变化，重启动画循环以应用新速度 */
watch(
  () => autoScrollPxPerSecond.value,
  () => {
    if (autoScrollActive.value && !autoScrollPaused.value) {
      stopAutoScrollLoop();
      startAutoScrollLoop();
    }
  }
);

/* ==================== 内联图片扫描 ==================== */

/**
 * 监听已加载章节变化：新章节拼接后扫描其中的内联图片，纳入 IntersectionObserver。
 * 使用 nextTick 确保 DOM 更新完成后再查询。
 */
watch(
  () => loadedChapters.value.length,
  () => {
    nextTick(() => observeInlineImages());
  }
);

/* ==================== 生命周期 ==================== */

onMounted(() => {
  if (props.loadAll) {
    void loadAllChapters().catch((e) => console.error('loadAllChapters 失败:', e));
  } else {
    initLoadedChapters();
  }
  void scrollToTop().catch((e) => console.error('scrollToTop 失败:', e));

  // 添加 click 事件委托：点击 .inline-illustration 图片时打开 lightbox
  // （IntersectionObserver 初始化与 Esc 键监听由 useInlineImageLightbox composable 自动管理）
  scrollRef.value?.addEventListener('click', handleScrollClickDelegation);

  // 初次扫描图片
  nextTick(() => observeInlineImages());
});

onBeforeUnmount(() => {
  isUnmounted = true;
  // 清理 pending requestAnimationFrame，避免组件卸载后仍执行 doHandleScroll 访问已卸载的 DOM
  if (scrollRafId !== null) {
    cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  }
  // 清理 scroll-end timer
  if (scrollEndTimer !== null) {
    clearTimeout(scrollEndTimer);
    scrollEndTimer = null;
  }
  // 清理 scrollToPosition/scrollToTop 恢复定时器
  if (scrollRestoreTimer) {
    clearTimeout(scrollRestoreTimer);
    scrollRestoreTimer = null;
  }
  // 清理 prepareRestore 安全超时定时器
  if (prepareRestoreTimer) {
    clearTimeout(prepareRestoreTimer);
    prepareRestoreTimer = null;
  }
  // 清理加载动画延迟显示定时器（防止组件卸载后回调仍写入响应式状态）
  clearShowLoadingNext();
  clearShowLoadingPrev();
  // 取消全文渐进拼接任务（清 idle 句柄，防止卸载后回调继续写响应式状态）
  cancelFullTextLoad();
  // 清理自动滚动动画帧
  stopAutoScrollLoop();
  // 退出前保存一次进度（基于当前章节内位置）
  // 注意：此处不 await saveProgressImmediate，因为 onBeforeUnmount 不支持 async。
  // 父组件 Reader.vue 的 onBeforeUnmount 会通过 flushCurrentProgress 统一保存，
  // 此处的保存作为子组件单独卸载（如阅读模式切换）时的 fallback。
  // 根因⑤：全文渐进拼接未完成时 getCurrentPosition 返回 null，跳过保存
  //（父组件 flushCurrentProgress 同样判 null，DB 保持既有正确值）
  const progress = getCurrentPosition();
  if (progress !== null) {
    // 任务25：顺带章内字符偏移（内容锚点；getCurrentPosition 内已同步 liveChapterCharOffset）
    void store
      .saveProgressImmediate(progress, store.liveChapterCharOffset)
      .catch((e) => console.error('store.saveProgressImmediate 失败:', e));
  }

  // 移除 click 事件委托
  // （IntersectionObserver 清理与 Esc 键监听移除由 useInlineImageLightbox composable 自动管理）
  scrollRef.value?.removeEventListener('click', handleScrollClickDelegation);
});
</script>

<template>
  <div
    ref="scrollRef"
    class="scroll-view"
    :style="{
      '--reader-margin': `${store.margin}px`,
      '--reader-paragraph-spacing': store.paragraphSpacing
    }"
    @scroll="handleScroll"
    @contextmenu="(e: MouseEvent) => emit('contextmenu', e)"
    @click="handleAutoScrollClick"
  >
    <div class="scroll-inner" :style="{ maxWidth: `${store.pageWidth}px` }">
      <!-- 正在全部加载提示 -->
      <div v-if="isLoadingAll" class="loading-prev">
        <span class="loading-next-dot"></span>
        <span class="loading-next-dot"></span>
        <span class="loading-next-dot"></span>
        <span class="loading-next-text">{{ t('readerViews.scroll.loadingAll') }}</span>
      </div>

      <!-- 正在加载上一章提示（300ms 延迟显示，防止快速加载时闪烁） -->
      <div v-if="showLoadingPrev" class="loading-prev">
        <span class="loading-next-dot"></span>
        <span class="loading-next-dot"></span>
        <span class="loading-next-dot"></span>
        <span class="loading-next-text">{{ t('readerViews.scroll.loadingPrev') }}</span>
      </div>

      <!-- 全文模式：原始文本流（像记事本一样，不分章、不格式化） -->
      <div
        v-if="props.loadAll && rawFullText"
        class="raw-full-text"
        :style="{
          fontSize: `${store.fontSize}px`,
          lineHeight: store.lineHeight,
          fontFamily: store.fontFamilyCss
        }"
      >{{ rawFullText }}</div>

      <!-- 遍历已加载的章节（无限拼接，仅非全文模式渲染） -->
      <template v-if="!props.loadAll">
        <div v-for="(ch, chIdx) in loadedChapters" :key="ch.index" class="chapter-section">
          <!-- 章节标题（居中 + 装饰线）：第一章用 h1，后续拼接章节用 h2 保持文档大纲层级 -->
          <h1 v-if="chIdx === 0" class="chapter-title">{{ ch.title }}</h1>
          <h2 v-else class="chapter-title chapter-title-secondary">{{ ch.title }}</h2>
          <div class="chapter-divider" aria-hidden="true"></div>

          <!-- 段落正文（带高亮标记） -->
          <div
            v-if="ch.contentType === 'markdown'"
            class="markdown-content"
            :style="{
              fontSize: `${store.fontSize}px`,
              lineHeight: store.lineHeight,
              fontFamily: store.fontFamilyCss
            }"
            v-html="ch.markdownHtml"
          ></div>
          <template v-else>
            <p
              v-for="(para, i) in ch.paragraphs.slice(0, ch.renderedCount)"
              :key="i"
              class="paragraph"
              :style="{
                fontSize: `${store.fontSize}px`,
                lineHeight: store.lineHeight,
                fontFamily: store.fontFamilyCss
              }"
              v-html="renderParagraphWithHighlights(para, highlightNotesByChapter.get(ch.index) ?? [])"
            ></p>

          </template>
        </div>
      </template>

      <!-- 正在加载下一章提示（300ms 延迟显示，防止快速加载时闪烁） -->
      <div v-if="showLoadingNext" class="loading-next">
        <span class="loading-next-dot"></span>
        <span class="loading-next-dot"></span>
        <span class="loading-next-dot"></span>
        <span class="loading-next-text">{{ t('readerViews.scroll.loadingNext') }}</span>
      </div>

      <!-- 已读完最后一章提示 -->
      <div v-if="!hasMoreChapters && !isLoadingNext" class="chapter-end">
        {{ t('readerViews.finishedLastChapter') }}
      </div>
    </div>

    <!-- 图片放大查看（Lightbox）：全屏遮罩 + 居中图片 + 关闭按钮 -->
    <!-- A6修复：滚轮缩放（锚点跟随鼠标）/ 双击适配↔1:1 切换 / 放大后拖拽平移 -->
    <div
      v-if="showImageViewer"
      class="image-lightbox"
      @click="onLightboxMaskClick"
      @wheel="onLightboxWheel"
      @mousemove="onLightboxDragMove"
      @mouseup="onLightboxDragEnd"
      @mouseleave="onLightboxDragEnd"
    >
      <img
        ref="lightboxImgRef"
        :src="imageViewerSrc"
        class="image-lightbox-img"
        :alt="t('readerViews.lightbox.zoomAlt')"
        :style="lightboxImgStyle"
        @click.stop
        @dblclick="onLightboxDblClick"
        @load="onLightboxImgLoad"
        @mousedown="onLightboxDragStart"
      />
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
.scroll-view {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  /* 仅保留垂直内边距：水平边距放在 .scroll-inner 上，否则宽屏下水平 padding
     与 maxWidth 居中产生的空白相互抵消，用户调节边距看不到效果 */
  padding: var(--spacing-md) 0;

  /* 不使用 CSS scroll-behavior: smooth — 它会让 scrollTop -= removedHeight
     触发平滑滚动动画，动画期间 scroll 事件持续触发，导致连锁加载和章节误判。
     翻页操作通过 scrollBy({behavior:'smooth'}) 显式指定平滑滚动，不依赖 CSS。 */
  /* 禁用浏览器 scroll anchoring：trimOldChapters 移除章节时，
     浏览器会自动调整 scrollTop 保持可见内容稳定，
     与代码中的手动 scrollTop -= removedHeight 形成双重补偿，
     导致阅读位置向上跳变。禁用后由代码完全控制 scrollTop。 */
  overflow-anchor: none;
}

.scroll-inner {
  margin: 0 auto;
  width: 100%;
  /* border-box 下水平 padding 始终收窄正文宽度，边距调节即时可见 */
  padding: 0 var(--reader-margin, var(--spacing-lg));
}

/* ==================== 章节区域 ==================== */
.chapter-section {
  margin-bottom: var(--spacing-lg);
  /* 隔离每个章节的布局/样式/绘制，滚动加载新章节或段落变化时
     不触发其他章节重排，提升无限滚动性能。
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

/* 后续拼接章节用 h2，字号稍小，上方留出更多间距区分章节边界 */
.chapter-title-secondary {
  font-size: var(--font-size-lg);
  margin-top: var(--spacing-xl);
}

/* 章节标题下方装饰线：居中短横线 */
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

/* ==================== Markdown 渲染 ==================== */
.markdown-content {
  color: var(--reader-text);
  user-select: text;
  word-break: break-word;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  color: var(--reader-text);
  font-weight: 700;
  margin: 1.2em 0 0.6em;
}

.markdown-content :deep(h1) {
  font-size: 1.6em;
}
.markdown-content :deep(h2) {
  font-size: 1.4em;
}
.markdown-content :deep(h3) {
  font-size: 1.2em;
}
.markdown-content :deep(h4) {
  font-size: 1.1em;
}

.markdown-content :deep(p) {
  margin-bottom: 0.8em;
  text-indent: 0;
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 0.5em 0 0.8em;
  padding-left: 2em;
}

.markdown-content :deep(li) {
  margin-bottom: 0.3em;
}

.markdown-content :deep(blockquote) {
  margin: 0.8em 0;
  padding: 0.5em 1em;
  border-left: 3px solid var(--reader-primary);
  background: rgba(128, 128, 128, 0.06);
  border-radius: 0 4px 4px 0;
}

.markdown-content :deep(blockquote p) {
  margin-bottom: 0;
}

.markdown-content :deep(code) {
  background: rgba(128, 128, 128, 0.1);
  padding: 0.15em 0.4em;
  border-radius: 3px;
  font-size: 0.9em;
  font-family: var(--font-mono);
}

.markdown-content :deep(pre.hljs) {
  margin: 0.8em 0;
  padding: 1em;
  background: var(--reader-code-bg);
  border-radius: 6px;
  overflow-x: auto;
}

.markdown-content :deep(pre.hljs code) {
  background: none;
  padding: 0;
  font-size: 0.9em;
  line-height: 1.5;
}

.markdown-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.8em 0;
  font-size: 0.95em;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid rgba(128, 128, 128, 0.3);
  padding: 0.5em 0.8em;
  text-align: left;
}

.markdown-content :deep(th) {
  background: rgba(128, 128, 128, 0.08);
  font-weight: 700;
}

.markdown-content :deep(tr:nth-child(even)) {
  background: rgba(128, 128, 128, 0.03);
}

.markdown-content :deep(a) {
  color: var(--reader-primary);
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

.markdown-content :deep(hr) {
  border: none;
  border-top: 1px solid rgba(128, 128, 128, 0.3);
  margin: 1.2em 0;
}

.markdown-content :deep(img) {
  max-width: 100%;
  border-radius: 4px;
  margin: 0.8em 0;
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

/* ==================== 全文模式：原始文本流（记事本风格） ==================== */
.raw-full-text {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 16px;
  color: var(--reader-text);
}

/* ==================== 加载下一章提示 ==================== */
.loading-next,
.loading-prev {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-6px);
  padding: var(--spacing-lg) 0 var(--spacing-sm);
  color: var(--reader-primary);
  font-size: var(--font-size-sm-plus);
  letter-spacing: 1px;
}


.loading-next-text {
  margin-left: var(--spacing-xs);
}

/* 三个跳动小点 */
.loading-next-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--reader-primary);
  opacity: 0.7;
  animation: bounce-dot 1.2s infinite ease-in-out;
}
.loading-next-dot:nth-child(2) {
  animation-delay: 0.2s;
}
.loading-next-dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes bounce-dot {
  0%,
  80%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  40% {
    transform: translateY(-5px);
    opacity: 1;
  }
}

/* ==================== 内联图片（图文模式） ==================== */
/* v-html 渲染的图片需要用 :deep() 穿透 scoped 样式边界 */
:deep(.inline-illustration) {
  max-width: 100%;
  display: block;
  margin: var(--spacing-md) auto;
  border-radius: var(--border-radius);
  box-shadow: var(--shadow-elevated);
  cursor: zoom-in;
  /* 立即可见，不依赖 JS 添加 class 才显示 */
  opacity: 1;
  /* 占位背景色，加载前避免高度塌陷 */
  background-color: rgba(128, 128, 128, 0.06);
}

/* 图片基础样式：宽度自适应 + 加载淡入过渡 */
/* P1修复：width:100% 强制所有插图拉满容器宽，小图标/分隔线被放大模糊；
   改为 max-width:100%（与 PageView 对齐）：小图保持原始尺寸，大图不超容器 */
/* P2修复（aspect-ratio 占位）：buildImgHtml 现为带尺寸的 [IMG:...|WxH] 标记输出
   width/height 属性（主进程 buildImgMark 落盘后读文件头编码），Chromium 从属性
   推导 aspect-ratio，配合此处 height:auto 在图片加载前预留精确宽高比盒子，
   消除加载完成后撑开导致的滚动跳动。无尺寸（旧缓存/EPUB/解析失败）回退
   buildImgHtml 内联的 min-height:25vh 近似占位（A2 方案B）。 */
:deep(.inline-illustration) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  transition: opacity 0.3s ease-out;
}

/* 加载占位：仅用淡色背景，不用 min-height/shimmer——
   之前 min-height:200px + shimmer 渐变动画在 data-loading 未移除时
   会遮挡图片（分批渲染后新图片未被 IntersectionObserver 观察，data-loading 永远不移除）。
   现在不设 data-loading（buildImgHtml 已移除），图片自然显示，background-color 充当占位。*/
:deep(.inline-illustration[data-loading='true']) {
  background-color: rgba(128, 128, 128, 0.08);
  box-shadow: none;
}

/* 加载完成：淡入显示 */
:deep(.inline-illustration.inline-illustration-loaded) {
  opacity: 1;
}

/* 加载失败状态：显示破损占位，点击可重试加载 */
:deep(.inline-illustration[data-error='true']) {
  min-height: 120px;
  opacity: 0.5;
  cursor: pointer;
  background: rgba(128, 128, 128, 0.1);
  box-shadow: none;
  animation: none;
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

@keyframes inline-img-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* shimmer 动画已移除——不再使用 data-loading 骨架屏 */

/* ==================== 图片放大查看（Lightbox） ==================== */
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  animation: lightbox-fade-in 0.2s ease;
}

.image-lightbox-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: var(--shadow-lightbox);
  cursor: default;
  user-select: none;
  -webkit-user-drag: none;
}

.image-lightbox-close {
  position: absolute;
  top: 16px;
  right: 24px;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  background: var(--overlay-control);
  color: var(--text-on-primary);
  font-size: var(--font-size-2xl);
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition:
    background 0.2s ease,
    transform 0.2s ease;
}

.image-lightbox-close:hover {
  background: var(--overlay-control-hover);
  transform: scale(1.1);
}

@keyframes lightbox-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>
