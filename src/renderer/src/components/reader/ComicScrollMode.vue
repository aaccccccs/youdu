<!--
  漫画垂直滚动模式组件（精简版）

  功能：
  - 垂直滚动，图片按适配模式显示（fitWidth/fitScreen/fitHeight/original/smartFit/custom），纯黑背景
  - fitScreen/fitHeight 以滚动容器视口高度为基准（v52，修复 maxHeight:'100%' 循环依赖失效）
  - original/custom>100% 时放开横向滚动，超宽图片可滚动查看（v52）
  - smartFit 响应式化（v52）：横图用视口高基准的 fitScreen，竖图用 fitWidth
  - IntersectionObserver 懒加载（观察可视区 ±2 张图片）
  - Ctrl+滚轮临时缩放（松开恢复），缩放中心跟随鼠标（v52）
  - 双击图片全屏原尺寸查看（v56 P0 对标 Calibre：emit view-image →
    ComicViewer 弹 ComicLightbox；页内缩放仍可 Ctrl+滚轮/触屏双指）
  - 滚动时显示页码指示器（底部居中，半透明+blur），停止滚动2秒后自动隐藏
  - 回到顶部按钮（滚动超过3页时显示，右下角圆形按钮）
  - 连续阅读：滚到底部请求下一章（3秒冷却锁），滚到顶部请求上一章
  - v55 章节模式（store.readMode=chapter）：共用滚动渲染但章末停住——不自动拼接，
    章末渲染"下一章"预告卡，点击才进入下一章（安静阅读派）
  - 图片加载占位符：灰色背景+页码文字；加载失败：错误图标+重试按钮
  - 图片 fade-in 动画（0.3s）

  基于13个平台调研结论（腾讯动漫/B站/快看/MANGA Plus/Webtoon/Kavita/Komga 等）
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore, useReaderStore, type ComicScaleType } from '@renderer/stores';
import { coverPathToUrl } from '@renderer/utils';
import { mergeChapterImages } from '../../../../shared';
import type { ChapterImage } from '../../../../shared';

const props = withDefaults(
  defineProps<{
    /** 图片列表（v49 起含真实尺寸，供精确占位） */
    images: ChapterImage[];
    /** 自动滚动开关（对齐文字 ScrollView：速度 settings.autoScrollSpeed px/s） */
    autoScroll?: boolean;
  }>(),
  {
    images: () => [],
    autoScroll: false
  }
);

const emit = defineEmits<{
  /** 滚动进度变化（v54 起为"视口所在章的章内进度"0~1） */
  (e: 'scroll-progress', progress: number): void;
  /** 请求加载下一章（连续阅读：距底 <1.5 屏时提前触发，拼接而非跳章） */
  (e: 'request-next-chapter'): void;
  /** v55 章节模式：末尾"下一章"转场卡点击 → 请求进入下一章（Reader 走手动跳章语义） */
  (e: 'go-next-chapter'): void;
  /**
   * P1-2（导航审计 #2）：滚动模式触顶 → 请求拼接上一章（视口位置保持，对齐
   * 文字模式 prependPrevChapter）。参数为拼接首章的前一章绝对索引（组件按
   * baseChapterIndex 算好，Reader 直接 loadChapter(target, { prepend: true })）。
   * 替代原 request-prev-chapter（暴力跳章：清拼接+单章替换+视口重置，用户只想
   * 回看上文却被重置）。章节模式触顶保持"完全静止"（不 emit）。
   */
  (e: 'request-prepend-prev-chapter', targetChapterIndex: number): void;
  /** 当前页码变化（1-based，拼接列表全局页码） */
  (e: 'page-change', page: number): void;
  /** 视口所在章变化（v54：绝对章索引，滚动跨界时触发，供进度/目录高亮同步） */
  (e: 'current-chapter-change', chapterIndex: number): void;
  /** v56 P0 对标 Calibre：双击图片 → 请求全屏原尺寸查看（ComicViewer 弹 ComicLightbox） */
  (e: 'view-image', image: ChapterImage): void;
}>();

const settings = useSettingsStore();
const readerStore = useReaderStore();
const { t } = useI18n();

/* ==================== v55 章节模式（按章加载，章末停住） ==================== */

/**
 * 章节模式判定（图片型三模式之一，store.readMode === 'chapter'）：
 * 与滚动模式共用滚动渲染（ComicViewer mode='scroll'），差异仅在章末行为——
 * 不自动拼接下一章（checkContinuousReading 跳过），章末渲染"下一章"预告卡，
 * 点击才进入（emit go-next-chapter，Reader 走手动跳章语义）。
 */
const isChapterMode = computed<boolean>(() => readerStore.readMode === 'chapter');

/* ==================== 滚动模式跨章追加（accumulatedImages 无限拼接） ==================== */

/**
 * 累积图片列表：滚动模式跨章追加而非替换。
 * 滚到底部请求下一章后，新章图片追加到尾部，旧章保留，实现连续阅读。
 */
const accumulatedImages = ref<ChapterImage[]>([]);

/** 是否正在追加下一章（用于 watch props.images 时区分追加和重置） */
let isAppendingNextChapter = false;

/**
 * P1-2：是否正在前插上一章（滚动模式触顶拼接，与 isAppendingNextChapter 对称）。
 * watch props.images 前置分支凭该标志区分"前插"与"重置"。
 */
let isPrependingPrevChapter = false;

/**
 * P1-3（导航审计 #3）：单屏章（maxScroll<=0）自动拼接后的门控标志。
 * 置位后须用户先发生交互（滚轮/滚动）才允许再次单屏自动拼接——拼接后列表
 * 仍单屏说明用户还没看新内容，无门控会在一次触发后连环拼接（webtoon 快速
 * 浏览场景由滚轮逐格驱动，每格都是显式交互，不受此门控影响）。
 */
let needsUserScrollAfterAutoAppend = false;

/**
 * 最后拼接章在 accumulatedImages 中的起始槽位（v53 分批渐进加载用）。
 * 续载合并（store 原地更新 comicImages）需要知道"当前章"在拼接列表中的
 * 区间，才能把主进程返回的完整列表同步到正确的槽位段。
 * 单章（未跨章拼接）为 0；追加下一章时记录追加前长度。
 */
let lastChapterStartSlot = 0;

/* ==================== v54 章边界与转场卡（Mihon 式跨章拼接） ==================== */

/** 拼接章边界：各章在 accumulatedImages 中的起始槽位 + 章标题（转场卡显示用） */
interface ChapterBoundary {
  /** 该章首图在拼接列表中的槽位 */
  start: number;
  /** 章标题（目录标题，无标题时回退"第 N 章"） */
  title: string;
  /** A-4修复：该章的绝对章索引（续载按章请求/跨章续载同步按边界定位区间用） */
  chapterIndex: number;
}

/** 章边界列表（首项恒为 { start: 0 }；追加章时 push） */
const chapterBoundaries = ref<ChapterBoundary[]>([{ start: 0, title: '', chapterIndex: 0 }]);

/** 拼接首章的绝对章索引（边界 k 的绝对章号 = baseChapterIndex + k） */
let baseChapterIndex = 0;

/** 已上报的视口章绝对索引（去重，避免高频 emit） */
let lastEmittedChapterIndex = -1;

/**
 * P1-3：列表整体高度是否不足以滚动（scrollHeight <= clientHeight）。
 * 单屏章（一章一图的 PDF per-page 漫画 / 单图短章在默认适配下）既触发不了
 * "距底 1.5 屏"拼接、又没有末尾预告卡（滚动模式原本不加卡）——滚动模式的
 * "无限拼接"在该场景完全失效。此状态驱动：① 末尾"继续阅读"预告卡兜底
 * ② 滚轮翻页拼接触发 ③ checkContinuousReading 的"等效距底 0"分支。
 * 更新时机：onScroll（rAF 内）/ 图片加载 / images 变化 nextTick / resize。
 */
const listUnscrollable = ref<boolean>(false);

/** 读取滚动容器当前高度，刷新 listUnscrollable */
function updateListScrollable(): void {
  const el = scrollRef.value;
  listUnscrollable.value = !!el && el.scrollHeight <= el.clientHeight;
}

/** 渲染条目：图片或章间转场卡（v54：displayImages + 章边界合成） */
interface ComicRenderItem {
  /** image=图片；transition=章间转场卡/末尾提示卡 */
  type: 'image' | 'transition';
  /** image：图片在 displayImages 中的全局槽位；transition：卡所在位置标记 */
  slot: number;
  /** image：图片数据（transition 无此字段） */
  image?: ChapterImage;
  /** transition：下一章标题（null=最后一章提示卡） */
  nextChapterTitle?: string | null;
}

/** 绝对章索引 → 章标题（目录无标题时回退"第 N 章"） */
function chapterTitleOf(absIndex: number): string {
  const ch = readerStore.chapters[absIndex];
  if (ch?.title) return ch.title;
  return t('reader.chapterN', { n: absIndex + 1 });
}

/** 当前显示的图片列表（滚动模式用累积列表，空时回退到 props.images） */
const displayImages = computed<ChapterImage[]>(() => {
  return accumulatedImages.value.length > 0 ? accumulatedImages.value : props.images;
});

/**
 * 渲染列表：图片条目 + 章边界处插入转场卡（上一章完 / 下一章：{title}）。
 * 最后一拼接章无后续章时，末尾追加"已是最后一章"提示卡。
 * 图片条目的 slot 保持与 displayImages 全局槽位一致（observer 的
 * data-index、scrollImageRefs、缩放/占位状态等均按槽位索引，语义不变）。
 */
const renderItems = computed<ComicRenderItem[]>(() => {
  const list = displayImages.value;
  const boundaries = chapterBoundaries.value;
  const items: ComicRenderItem[] = [];
  let b = 0;
  for (let i = 0; i < list.length; i++) {
    // 到达下一章边界：先插入转场卡（上一章末尾与新章开头之间）
    if (b + 1 < boundaries.length && i === boundaries[b + 1].start) {
      items.push({ type: 'transition', slot: i, nextChapterTitle: boundaries[b + 1].title });
      b++;
    }
    items.push({ type: 'image', slot: i, image: list[i] });
  }
  // 末尾提示卡：最后拼接章之后无更多章（依据 comicChapterIndex 而非视口章，避免滚动中闪变）
  const lastSplicedIdx = baseChapterIndex + boundaries.length - 1;
  if (list.length > 0 && lastSplicedIdx >= readerStore.chapters.length - 1) {
    items.push({ type: 'transition', slot: list.length, nextChapterTitle: null });
  } else if (list.length > 0 && isChapterMode.value) {
    // v55 章节模式：非最后一章时末尾追加"下一章"预告卡（本模式的主要交互，
    // 点击进入）。滚动模式不加——距底 1.5 屏自动拼接后章间卡自然出现，
    // 加此卡会与拼接卡重复
    items.push({ type: 'transition', slot: list.length, nextChapterTitle: chapterTitleOf(lastSplicedIdx + 1) });
  } else if (list.length > 0 && listUnscrollable.value) {
    // P1-3：滚动模式单屏章兜底——列表不足一屏时"距底 1.5 屏"永远不会触发
    // （maxScroll<=0），末尾加"继续阅读"预告卡（与章节模式同款，点击走自动
    // 拼接）。拼接使列表超过一屏后此卡自然消失（listUnscrollable 响应式更新）
    items.push({ type: 'transition', slot: list.length, nextChapterTitle: chapterTitleOf(lastSplicedIdx + 1) });
  }
  return items;
});

/**
 * v55：转场卡点击：末尾"下一章"预告卡 → 请求进入下一章。
 * - 章节模式：emit go-next-chapter（Reader 走手动跳章语义：markManualJump
 *   清空拼接、loadChapter 单章、回新章顶部）。
 * - 滚动模式单屏卡（P1-3）：点击与触底续读同路径——自动拼接下一章（视口
 *   不动、新章追加下方），点击即显式交互（解锁单屏门控）。
 * 滚动模式的章间卡为纯展示（自动衔接）、最后一章提示卡无可去章，均不响应。
 */
function onTransitionCardClick(item: ComicRenderItem): void {
  if (item.nextChapterTitle == null) return;
  if (isChapterMode.value) {
    emit('go-next-chapter');
    return;
  }
  if (listUnscrollable.value) {
    // P1-3：单屏章末尾卡点击 → 自动拼接（点击=用户交互，解锁门控）
    needsUserScrollAfterAutoAppend = false;
    checkContinuousReading();
  }
}

/** 转场卡是否可点击（章节模式预告卡 + 滚动模式单屏兜底卡） */
function isTransitionCardClickable(item: ComicRenderItem): boolean {
  if (item.nextChapterTitle == null) return false;
  return isChapterMode.value || listUnscrollable.value;
}


/* ==================== 滚动容器 & 图片元素引用 ==================== */

const scrollRef = ref<HTMLDivElement | null>(null);
const scrollImageRefs: (HTMLImageElement | null)[] = [];

/* ==================== 图片加载状态 ==================== */

const imageLoadStates = ref<Record<number, 'loading' | 'loaded' | 'error'>>({});
const retryKeys = ref<Record<number, number>>({});

/**
 * 图片自然宽高比缓存（index → width/height）。
 * v52：smartFit 横竖图判定改为响应式数据驱动（取代原先 onload 时命令式改 img.style
 * 的做法——该做法会被 Vue 重渲染覆盖回 fitWidth，状态不稳定）。
 * 优先使用 ChapterImage 自带的真实尺寸（v49 起落盘时已读取），onload 后用
 * naturalWidth/naturalHeight 兜底补充（CBZ 的 GIF/BMP 等无尺寸数据场景）。
 */
const imageRatios = ref<Record<number, number>>({});

/** 获取图片宽高比（未知返回 undefined） */
function getImageRatio(index: number): number | undefined {
  const cached = imageRatios.value[index];
  if (cached !== undefined) return cached;
  const img = displayImages.value[index];
  if (img && img.width > 0 && img.height > 0) return img.width / img.height;
  return undefined;
}

function onImageLoad(event: Event, index: number): void {
  imageLoadStates.value[index] = 'loaded';
  // v52：记录自然宽高比（ChapterImage 无尺寸数据时的兜底数据源，供 smartFit 横竖判定）
  const img = event.target as HTMLImageElement | null;
  if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
    imageRatios.value[index] = img.naturalWidth / img.naturalHeight;
  }
  // P1-3：图片加载后列表高度可能变化（无尺寸数据的占位从 100vh 回退到真实
  // 高度），刷新单屏判定（预告卡显隐 / 滚轮拼接兜底）
  updateListScrollable();
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
  const url = coverPathToUrl(list[index].path);
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
            // v46：预加载当前图片及相邻 ±4 张（原 ±2）。
            // 图片按需生成较慢（readPdfChapterImages 渲染整章），±2 张在快速滚动/
            // 自动滚动时来不及生成 → 用户看到灰色占位（"没有预加载/无感设计"反馈）。
            for (let d = -4; d <= 4; d++) {
              preloadImage(index + d);
            }
            // v53 分批渐进加载：预载范围内仍未渲染的 pending 占位页，收集起来
            // 请求主进程续载（store 内 200ms 去抖合并，观察器高频回调不放大 IPC）
            scheduleEnsurePendingAround(index);
          }
        }
      }
    },
      {
      root: scrollRef.value,
      // v46：可视区上下各 6 屏提前预加载（v39 为 4 屏），配合 ±4 张预加载，
      // 快速滚动/自动滚动时图片更早就绪，几乎看不到灰色占位（无感）
      rootMargin: '600% 0px 600% 0px',
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

/* ==================== v53 分批渐进加载：pending 续载 ==================== */

/**
 * 收集预载范围（±4）内的 pending 占位页并请求主进程续载。
 *
 * A-4修复：按槽位反查所属章（boundaries 中最后一个 start ≤ i 的条目），对
 * 各章分别收集 pending 页（章内页码 1-based）并按章发起续载（store
 * ensureImages 支持章参数）。原实现仅处理"最后拼接章"区间
 * （lastChapterStartSlot 起）——再拼接下一章后 loadChapter 作废在途续载
 * （ensureSeq++），被跳过章的 pending 页 `page < 1` 被过滤 → 永久无法加载
 * （用户回滚看到灰色转圈占位，内容不可达）。续载后由
 * watch(comicImagesRevision) 同步拼接列表（数据源章走原地合并，旧章走
 * comicChapterImageUpdates 跨章通道）。
 */
function scheduleEnsurePendingAround(index: number): void {
  const list = displayImages.value;
  const boundaries = chapterBoundaries.value;
  // 章（绝对章索引）→ 该章 pending 页码列表（1-based 章内页码）
  const pendingByChapter = new Map<number, number[]>();
  for (let d = -4; d <= 4; d++) {
    const i = index + d;
    if (i < 0 || i >= list.length) continue;
    if (!list[i].pending) continue;
    // 槽位 i → 所属章边界（boundaries 升序，最后一个 start ≤ i 的条目）
    let b = 0;
    for (let k = 0; k < boundaries.length; k++) {
      if (boundaries[k].start <= i) b = k;
      else break;
    }
    // 拼接列表槽位 → 章内相对槽位（1-based，与该章 comicImages 下标一致）
    const pageInChapter = i - boundaries[b].start + 1;
    if (pageInChapter < 1) continue;
    const chapterIndex = boundaries[b].chapterIndex;
    const pages = pendingByChapter.get(chapterIndex);
    if (pages) pages.push(pageInChapter);
    else pendingByChapter.set(chapterIndex, [pageInChapter]);
  }
  for (const [chapterIndex, pages] of pendingByChapter) {
    readerStore.ensureImages(pages, chapterIndex);
  }
}

/**
 * 同步 store 当前章列表到拼接列表的当前章区间（watch revision 触发）。
 * splice 保持 accumulatedImages 数组引用不换源（displayImages 响应式依赖
 * 不失效，也不会触发组件的 watch(props.images) 重置分支）。
 */
function syncCurrentChapterImages(): void {
  const start = lastChapterStartSlot;
  if (start < 0 || start > accumulatedImages.value.length) return;
  if (readerStore.comicImages.length === 0) return;
  accumulatedImages.value.splice(
    start,
    accumulatedImages.value.length - start,
    ...readerStore.comicImages
  );
}

/**
 * A-4修复：跨章续载同步——store 返回的旧章（拼接列表中非数据源章）完整列表，
 * 按章边界定位区间，复用 mergeChapterImages 的 pending 队列对齐算法合并进
 * accumulatedImages；区间长度变化（续载发现近空白页被过滤）时平移后续章
 * 边界与 lastChapterStartSlot，保持边界与槽位索引一致。
 * 按章号升序处理（前面的章区间变化后，后续章边界已平移，定位仍正确）。
 */
function syncExtraChapterImages(): void {
  const updates = readerStore.comicChapterImageUpdates;
  if (updates.size === 0) return;
  const boundaries = chapterBoundaries.value;
  const sorted = Array.from(updates.entries()).sort((a, b) => a[0] - b[0]);
  for (const [chapterIndex, updated] of sorted) {
    const k = chapterIndex - baseChapterIndex;
    // 该章不在当前拼接区间（已被重置/手动跳章）→ 丢弃（loadChapter 的
    // ensureSeq++ 已作废过期的跨章请求，此处为响应到达后的兜底）
    if (k < 0 || k >= boundaries.length) continue;
    const start = boundaries[k].start;
    const end = k + 1 < boundaries.length ? boundaries[k + 1].start : accumulatedImages.value.length;
    if (end <= start) continue;
    const current = accumulatedImages.value.slice(start, end);
    const merged = mergeChapterImages(current, updated);
    accumulatedImages.value.splice(start, current.length, ...merged);
    const delta = merged.length - current.length;
    if (delta !== 0) {
      // 区间长度变化 → 后续章边界与数据源章起始槽位整体平移
      for (let j = k + 1; j < boundaries.length; j++) {
        boundaries[j] = { ...boundaries[j], start: boundaries[j].start + delta };
      }
      if (lastChapterStartSlot >= end) lastChapterStartSlot += delta;
    }
  }
  readerStore.consumeComicChapterImageUpdates();
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
 * scrollToTop / 程序化定位跳过 request-prev-chapter 的标志位。
 *
 * 问题：用户点击"回到顶部"按钮后，smooth 滚动会经过 onScroll → checkContinuousReading，
 * 当 scrollTop 到达 0 时会误触发 request-prev-chapter 加载上一章。
 *
 * 修复：scrollToTop 时设置此标志位，checkContinuousReading 检测到则跳过 prev-chapter。
 * 用定时器在 smooth 滚动结束后自动清理，确保标志位不会永久卡死（覆盖所有退出路径）。
 *
 * A-12修复：goToPage/goToPosition/scrollToAnchor 等程序化定位路径复用同一机制——
 * smooth/瞬时滚动到列表顶部区域（页码小、scrollTop ≤ 阈值且未过半）时同样会
 * 误触发 request-prev-chapter（点书签跳章内靠前位置 → 整本书跳到上一章开头，
 * 拼接上下文全丢）。所有程序化滚动前置位，800ms 超时自动清除。
 */
let skipPrevChapterByScrollToTop = false;
let skipPrevChapterTimer: ReturnType<typeof setTimeout> | null = null;
/** smooth 滚动最长持续时间（ms），超过此时长强制清理标志位 */
const SCROLL_TO_TOP_GUARD_MS = 800;

/** 程序化滚动前置位 skip 标志（smooth 滚动期间禁止误触发 request-prev-chapter） */
function armSkipPrevChapterGuard(): void {
  skipPrevChapterByScrollToTop = true;
  if (skipPrevChapterTimer) clearTimeout(skipPrevChapterTimer);
  skipPrevChapterTimer = setTimeout(() => {
    skipPrevChapterByScrollToTop = false;
    skipPrevChapterTimer = null;
  }, SCROLL_TO_TOP_GUARD_MS);
}

function scrollToTop(): void {
  if (!scrollRef.value) return;
  // 设置跳过标志位，防止 smooth 滚动到顶部时误触发 request-prev-chapter
  armSkipPrevChapterGuard();
  scrollRef.value.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ==================== 连续阅读 ==================== */

let continuousReadingLock = false;
let continuousReadingUnlockTimer: ReturnType<typeof setTimeout> | null = null;
let userHasScrolled = false;
const CONTINUOUS_READ_THRESHOLD = 50;

/** v54：提前拼接下一章的"距底绝对距离"阈值（单位：视口高度倍数）。
 *  v46 用 85% 比例阈值（scrollTop ≥ maxScroll×0.85）：单章列表下成立，但
 *  无限拼接后列表越来越长（maxScroll 数万 px），85% 意味着距底还剩十几屏
 *  就触发 → 预取风暴；且拼接瞬间 maxScroll 增大，比例分母突变。
 *  改为绝对距离"距底 < 1.5 屏"：语义稳定（用户离章末约 1.5 屏时后台拼接，
 *  结合 store 端首批 5 页 + 磁盘缓存预取，滚到章末时新章已就绪），与列表
 *  总长度无关，单章/拼接列表行为一致。 */
const APPEND_TRIGGER_VIEWPORTS = 1.5;

function checkContinuousReading(): void {
  if (!scrollRef.value) return;
  if (continuousReadingLock) return;

  const el = scrollRef.value;
  const maxScroll = el.scrollHeight - el.clientHeight;

  // v55 章节模式：章末停住——不 emit request-next-chapter（不自动拼接下一章），
  // 滚回顶部也不拼接上一章（章间完全静止，跨章仅用户主动操作：末尾"下一章"
  // 卡点击 / 底部章节按钮 / 目录跳转）。距底 <1.5 屏时仅预热下一章首批
  // （prefetchNextChapterImages 幂等：已预取章集合 + 在途标志双重去重，
  // 高频 onScroll 调用无副作用），点击转场卡进入时磁盘缓存已热、近乎即时。
  // P1-3：单屏章（maxScroll<=0）同样完全静止（转场卡是唯一继续入口）
  if (isChapterMode.value) {
    if (maxScroll > 0 && maxScroll - el.scrollTop < el.clientHeight * APPEND_TRIGGER_VIEWPORTS) {
      void readerStore.prefetchNextChapterImages();
    }
    return;
  }

  // P1-3（导航审计 #3）：滚动模式单屏章（maxScroll<=0，一章一图 PDF 漫画 /
  // 单图短章默认适配）改走"等效距底 0 屏"分支——触发自动拼接下一章（原直接
  // return 是死锁根因：既无拼接触发又无预告卡反馈，滚轮毫无响应）。防连环：
  // 拼接后列表仍单屏时须用户先交互（needsUserScrollAfterAutoAppend 门控，
  // 滚轮/滚动解锁），否则一次触发会连环拼接用户未看的内容
  const atBottom = maxScroll <= 0 || maxScroll - el.scrollTop < el.clientHeight * APPEND_TRIGGER_VIEWPORTS;
  if (atBottom && !needsUserScrollAfterAutoAppend) {
    triggerScrollModeAppend();
  }

  // 滚到顶部：仅当用户确实从下方滚回顶部时才触发（避免初始加载误触发）
  // 跳过 scrollToTop 引发的滚动（用户点击回到顶部按钮，不应拼接上一章）
  // v46：条件从"scrollTop===0"放宽为"<=阈值且未过半"，用户滚回顶部时更易触发拼接
  // P1-2（导航审计 #2）：emit 由 request-prev-chapter（暴力跳章：清拼接+单章
  // 替换+视口重置）改为 request-prepend-prev-chapter（拼接上一章到顶部 +
  // scrollTop 补偿视口保持，对齐文字模式 prependPrevChapter 的"回看上文"语义）；
  // 拼接首章已是全书第一章（baseChapterIndex<=0）时不 emit，静默停住
  if (
    userHasScrolled &&
    maxScroll > 0 &&
    el.scrollTop <= CONTINUOUS_READ_THRESHOLD &&
    el.scrollTop < maxScroll * 0.5 &&
    !skipPrevChapterByScrollToTop &&
    baseChapterIndex > 0
  ) {
    triggerScrollModePrepend();
  }
}

/**
 * 滚动模式触发自动拼接下一章（触底 / 单屏 / 末尾预告卡点击共用入口）：
 * 置追加意图（watch props.images 据此走追加分支，视口不动、新章拼接下方）+
 * emit + 3 秒冷却锁（防快速滚动/高频滚轮重复触发；Reader 侧另有
 * isAppendingComicChapter 防重入兜底，双层守卫对齐多入口异步防重入经验）。
 */
function triggerScrollModeAppend(): void {
  if (continuousReadingLock) return;
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

/**
 * P1-2：滚动模式触发前插上一章（触顶入口）：置前插意图（watch props.images
 * 走前置分支：边界整体后移 + scrollTop 补偿视口保持）+ emit 目标章号 +
 * 3 秒冷却锁（与 append 触发共用一把锁，防触顶/触底交错抖动）。
 */
function triggerScrollModePrepend(): void {
  if (continuousReadingLock) return;
  continuousReadingLock = true;
  isPrependingPrevChapter = true;
  emit('request-prepend-prev-chapter', baseChapterIndex - 1);
  if (continuousReadingUnlockTimer) clearTimeout(continuousReadingUnlockTimer);
  continuousReadingUnlockTimer = setTimeout(() => {
    continuousReadingLock = false;
    continuousReadingUnlockTimer = null;
  }, 3000);
}

/* ==================== 滚动事件 ==================== */

let scrollRafId: number | null = null;

/**
 * v54：视口所在章的章内进度（0~1）。
 * 依据当前全局页码在 chapterBoundaries 中定位所属章，以章内槽位区间归一化。
 * scroll-progress 事件与 expose 的 getCurrentPosition 共用本函数（语义一致：
 * 进度保存的章号=视口章，位置=该章章内位置，恢复时精确还原）。
 */
function currentChapterLocalProgress(): number {
  const boundaries = chapterBoundaries.value;
  const globalSlot = scrollCurrentPage.value - 1;
  // 定位所属边界（boundaries 升序且 start ≤ globalSlot 的最后一项）
  let b = 0;
  for (let k = 0; k < boundaries.length; k++) {
    if (boundaries[k].start <= globalSlot) b = k;
    else break;
  }
  const startSlot = boundaries[b].start;
  const endSlot = b + 1 < boundaries.length ? boundaries[b + 1].start : displayImages.value.length;
  return endSlot > startSlot ? Math.max(0, Math.min(1, (globalSlot - startSlot) / (endSlot - startSlot))) : 0;
}

/**
 * v54：上报视口所在章的章内进度（0~1）+ 视口章变化事件。
 * 视口跨过章边界时 emit current-chapter-change（Reader 同步
 * store.currentChapterIndex，目录高亮/进度条/进度保存的章基准跟随）。
 */
function emitChapterProgress(): void {
  emit('scroll-progress', currentChapterLocalProgress());
  // 视口章变化 → 通知 Reader 同步
  const boundaries = chapterBoundaries.value;
  const globalSlot = scrollCurrentPage.value - 1;
  let b = 0;
  for (let k = 0; k < boundaries.length; k++) {
    if (boundaries[k].start <= globalSlot) b = k;
    else break;
  }
  const absChapterIndex = baseChapterIndex + b;
  if (absChapterIndex !== lastEmittedChapterIndex) {
    lastEmittedChapterIndex = absChapterIndex;
    emit('current-chapter-change', absChapterIndex);
  }
}

function onScroll(): void {
  if (scrollRafId !== null) return;
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    if (!scrollRef.value) return;
    const el = scrollRef.value;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (el.scrollTop > 0) {
      userHasScrolled = true;
    }
    if (maxScroll <= 0) {
      emit('scroll-progress', 0);
      // P1-3：滚动事件发生说明用户有滚动交互（或列表刚从多屏收缩为单屏），
      // 解锁单屏拼接门控并走连续阅读检查（单屏章触发自动拼接）
      needsUserScrollAfterAutoAppend = false;
      updateListScrollable();
      checkContinuousReading();
      return;
    }
    checkContinuousReading();
    const newPage = computeScrollCurrentPage();
    if (newPage !== scrollCurrentPage.value) {
      scrollCurrentPage.value = newPage;
      emit('page-change', newPage);
    }
    // v54：章内归一进度 + 视口章同步（取代全局 scrollTop/maxScroll 进度）
    emitChapterProgress();
    showScrollIndicator();
    backToTopVisible.value = scrollCurrentPage.value > BACK_TO_TOP_THRESHOLD_PAGES;
  });
}

/* ==================== Ctrl+滚轮临时缩放（全局路径，跟随鼠标锚定） ==================== */

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const zoomScale = ref<number>(1);
/** 全局缩放的平移偏移 X/Y（px，v52：Ctrl+滚轮跟随鼠标锚定产生，配 scale() translate() 使用） */
const globalZoomOffsetX = ref<number>(0);
const globalZoomOffsetY = ref<number>(0);
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

/**
 * 设置全局缩放（v52：支持以鼠标位置为锚定点）。
 * 数学与 ComicPageMode.setZoom 保持一致：以鼠标所在图片 wrapper 为锚定元素
 * （取当前变换后的 getBoundingClientRect 中心），换算保持鼠标指向内容点
 * 视觉不动所需的 translate 偏移；缩放回 1x 时重置偏移。
 */
function setGlobalZoom(newScale: number, event?: WheelEvent): void {
  const oldScale = zoomScale.value;
  // 默认以图片中心缩放：按新旧比例折算既有偏移
  let newOffsetX = oldScale > 0 ? (globalZoomOffsetX.value * oldScale) / newScale : 0;
  let newOffsetY = oldScale > 0 ? (globalZoomOffsetY.value * oldScale) / newScale : 0;
  if (event) {
    const anchor = (event.target as HTMLElement | null)?.closest('.comic-image-wrapper') as HTMLElement | null;
    if (anchor && oldScale > 0) {
      const rect = anchor.getBoundingClientRect();
      // 锚定元素当前（变换后）中心屏幕坐标
      const cxScreen = rect.left + rect.width / 2;
      const cyScreen = rect.top + rect.height / 2;
      // 保持鼠标位置不动的新偏移（translate 在 scale 之后应用）
      newOffsetX =
        (event.clientX - cxScreen) * (1 / newScale - 1 / oldScale) + (globalZoomOffsetX.value * oldScale) / newScale;
      newOffsetY =
        (event.clientY - cyScreen) * (1 / newScale - 1 / oldScale) + (globalZoomOffsetY.value * oldScale) / newScale;
    }
  }
  // 缩放回 1x 时重置偏移
  if (newScale === ZOOM_MIN) {
    newOffsetX = 0;
    newOffsetY = 0;
  }
  globalZoomOffsetX.value = newOffsetX;
  globalZoomOffsetY.value = newOffsetY;
  zoomScale.value = newScale;
}

function onWheel(event: WheelEvent): void {
  if (event.ctrlKey) {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomScale.value + delta));
    setGlobalZoom(newScale, event);
    zoomIndicatorScale.value = zoomScale.value;
    showZoomIndicator();
    return;
  }
  // P1-3 单屏章兜底：容器不可滚动（maxScroll<=0）时 scroll 事件永不触发——
  // 这是单图章滚动模式"死锁"的根因（滚轮无任何反馈）。向下滚轮即用户"继续
  // 阅读"意图：解锁单屏门控（滚轮=显式交互）并走连续阅读检查（触发自动拼接
  // 下一章，拼接后列表超一屏即恢复原生滚动）。章节模式不拼接（转场卡承担，
  // 卡片可点击进下一章）；向上滚轮单屏时无动作（已在顶部，无从回看）。
  if (
    !isChapterMode.value &&
    event.deltaY > 0 &&
    scrollRef.value &&
    scrollRef.value.scrollHeight - scrollRef.value.clientHeight <= 0
  ) {
    needsUserScrollAfterAutoAppend = false;
    checkContinuousReading();
  }
}

/* ==================== 按图片索引的缩放状态（双指/双击/拖拽） ==================== */
/*
 * 设计说明（避免性能反模式）：
 * - 不用 translate3d 逐图合成（会导致 GPU 内存爆炸），用 transform: scale() translate() 即可
 * - 图片样式函数 getImageStyle 只在渲染期按图调用，不依赖 scrollPosition（避免每帧重算）
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
 * v52：全局缩放路径带鼠标锚定偏移（Ctrl+滚轮跟随鼠标）。
 */
function getImageTransform(index: number): string {
  const state = getImageZoomState(index);
  if (state.scale > 1) {
    return `scale(${state.scale}) translate(${state.offsetX}px, ${state.offsetY}px)`;
  }
  if (zoomScale.value > 1) {
    return `scale(${zoomScale.value}) translate(${globalZoomOffsetX.value}px, ${globalZoomOffsetY.value}px)`;
  }
  return 'none';
}

/* ==================== 双击全屏查看（v56 P0 对标 Calibre） ==================== */

/**
 * 双击图片 → emit view-image，请求 ComicViewer 弹出全屏原尺寸查看（ComicLightbox）。
 *
 * v56 前此处为 1x↔2x 页内放大；页内缩放能力保留 Ctrl+滚轮（全局鼠标锚定）
 * 与触屏双指缩放两条路径不变，"双击看大图"升级为 Calibre 式独立查看层
 * （原始尺寸 + 拖拽平移 + Ctrl+滚轮缩放 + 尺寸信息，体验更完整且不挤占阅读区）。
 */
function onImageViewRequest(item: ComicRenderItem): void {
  if (!item.image || item.image.pending) return;
  emit('view-image', item.image);
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

/* ==================== 视口高度与横向滚动（v52） ==================== */

/**
 * 滚动容器视口高度（px）。
 * v52：滚动模式下 wrapper 高度由内容决定，fitScreen 用 maxHeight:'100%' 是循环
 * 依赖（百分比约束解析为内容高度本身，约束无效，表现≈fitWidth）。改为在挂载/resize
 * 时读取 scrollRef.clientHeight 作为高度基准。
 */
const viewportHeight = ref<number>(0);

/** 读取滚动容器视口高度 */
function updateViewportHeight(): void {
  viewportHeight.value = scrollRef.value?.clientHeight ?? 0;
  // P1-3：视口尺寸变化影响单屏判定（缩放窗口后单屏↔多屏切换）
  updateListScrollable();
}

/**
 * 是否放开横向滚动：original（自然大图超宽）或 custom 放大（>100%）时图片可能
 * 超出容器宽度，放开 overflow-x 让横向滚动条可见（v52，修复溢出被裁剪不可查看）。
 */
const horizontalScrollable = computed<boolean>(() => {
  const type = settings.comicScaleType as ComicScaleType;
  return type === 'original' || (type === 'custom' && settings.comicCustomScale > 100);
});

/* ==================== 图片样式（按缩放类型） ==================== */

/*
 * 设计说明（避免性能反模式）：
 * - 不用 translate3d 逐图合成（会导致 GPU 内存爆炸），用 transform: scale() translate() 即可
 * - 图片样式函数在渲染期按图调用，依赖 settings.comicScaleType/comicCustomScale/
 *   viewportHeight/imageRatios，不依赖 scrollPosition（避免每帧重算）
 * - 缩放状态按图片索引存储，只有被操作的图片才有状态，不对所有图片同时应用缩放
 * - 与全局 Ctrl+滚轮缩放（zoomScale）共存：独立缩放优先，否则回退到全局缩放
 */

/**
 * 获取指定图片的显示样式（按当前缩放类型 + 图片自身宽高比）。
 * v52：
 * - fitScreen：滚动模式以视口高度为基准（maxHeight=viewportHeight），小图不放大
 * - fitHeight：高度锚定视口高（强制撑满一屏），宽度按比例且不超容器宽
 * - custom：宽度按容器宽的 comicCustomScale% 显示（100%=适应宽度）
 * - smartFit：响应式化——竖图（ratio<1）用 fitWidth，横图用 fitScreen（视口高基准）
 */
function getImageStyle(index: number): Record<string, string> {
  const type = settings.comicScaleType as ComicScaleType;
  switch (type) {
    case 'fitWidth':
      return { width: '100%', maxWidth: '100%', height: 'auto', maxHeight: 'none', objectFit: 'contain' };
    case 'fitScreen': {
      // v52：视口高度基准（修复 maxHeight:'100%' 循环依赖导致的失效）
      const h = viewportHeight.value;
      return h > 0
        ? { maxHeight: `${h}px`, width: 'auto', maxWidth: '100%', height: 'auto', objectFit: 'contain' }
        : { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' };
    }
    case 'fitHeight': {
      // v52：适应高度——高度锚定视口高（强制撑满一屏），宽度按比例且不超容器宽
      const h = viewportHeight.value;
      return h > 0
        ? { height: `${h}px`, width: 'auto', maxWidth: '100%', maxHeight: 'none', objectFit: 'contain' }
        : { height: '100%', width: 'auto', maxWidth: '100%', maxHeight: 'none', objectFit: 'contain' };
    }
    case 'original':
      return { width: 'auto', height: 'auto', maxWidth: 'none', maxHeight: 'none', objectFit: 'none' };
    case 'smartFit': {
      // v52：响应式化——竖图（宽高比<1）用 fitWidth；横图用 fitScreen（视口高基准）。
      // 尺寸已知时加载前即可正确显示（ChapterImage 尺寸优先，onload naturalWidth 兜底）
      const ratio = getImageRatio(index);
      if (ratio !== undefined && ratio >= 1) {
        const h = viewportHeight.value;
        if (h > 0) {
          return { maxHeight: `${h}px`, width: 'auto', maxWidth: '100%', height: 'auto', objectFit: 'contain' };
        }
        return { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' };
      }
      return { width: '100%', maxWidth: '100%', height: 'auto', maxHeight: 'none', objectFit: 'contain' };
    }
    case 'custom':
      // v52：自定义百分比——宽度按容器宽的百分比显示，超宽部分配合横向滚动查看
      return {
        width: `${settings.comicCustomScale}%`,
        maxWidth: 'none',
        height: 'auto',
        maxHeight: 'none',
        objectFit: 'contain'
      };
    default:
      return { width: '100%', maxWidth: '100%', height: 'auto', maxHeight: 'none', objectFit: 'contain' };
  }
}

/**
 * 获取图片 wrapper 的占位样式（v52）：
 * - fitScreen/fitHeight：显示高度恒为视口高，占位高度直接锚定视口高（避免加载后跳变）
 * - smartFit 已知横图：同上锚定视口高
 * - 其余：沿用 v49 真实宽高比精确占位（aspect-ratio），无尺寸时不设置（回退 CSS 的 100vh）
 */
function getWrapperPlaceholderStyle(index: number): Record<string, string> {
  const type = settings.comicScaleType as ComicScaleType;
  if (type === 'fitScreen' || type === 'fitHeight') {
    const h = viewportHeight.value;
    if (h > 0) return { height: `${h}px`, minHeight: 'auto' };
  }
  const ratio = getImageRatio(index);
  if (ratio !== undefined) {
    if (type === 'smartFit' && ratio >= 1) {
      const h = viewportHeight.value;
      if (h > 0) return { height: `${h}px`, minHeight: 'auto' };
    }
    const img = displayImages.value[index];
    if (img && img.width > 0 && img.height > 0) {
      return { aspectRatio: `${img.width} / ${img.height}`, minHeight: 'auto' };
    }
  }
  return {};
}

/* ==================== 自动滚动（对齐文字 ScrollView 体验） ==================== */

/** 自动滚动动画帧 ID */
let autoScrollRafId: number | null = null;
/** 自动滚动上次帧时间戳（计算 delta） */
let autoScrollLastTime = 0;
/** 组件是否已卸载 */
let isUnmounted = false;

/** 自动滚动速度（px/s），与文字阅读器共用 settings.autoScrollSpeed（10-200 px/s） */
const autoScrollPxPerSecond = computed<number>(() => settings.autoScrollSpeed);

/** 自动滚动动画循环：rAF 平滑滚动；触底依赖 onScroll→checkContinuousReading
 *  自动请求下一章（无限拼接后 scrollHeight 增大，继续滚动）；最后一章则自动停止 */
function autoScrollLoop(timestamp: number): void {
  if (!props.autoScroll || !scrollRef.value) {
    autoScrollRafId = null;
    autoScrollLastTime = 0;
    return;
  }
  if (autoScrollLastTime === 0) autoScrollLastTime = timestamp;
  const delta = timestamp - autoScrollLastTime;
  autoScrollLastTime = timestamp;

  const el = scrollRef.value;
  const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distanceToBottom > 0) {
    el.scrollTop += Math.min((autoScrollPxPerSecond.value * delta) / 1000, distanceToBottom);
  }
  // 触底时：checkContinuousReading（由 scroll 事件触发）已 emit request-next-chapter，
  // 拼接期间 scrollHeight 会增大；若 3s 锁内无新内容（最后一章），停止避免空转；
  // v55 章节模式章末停住（无自动拼接），触底同样停止——等用户点击"下一章"卡
  if (distanceToBottom <= 0 && (continuousReadingLock || isChapterMode.value)) {
    autoScrollRafId = null;
    autoScrollLastTime = 0;
    setTimeout(() => {
      if (props.autoScroll && !isUnmounted && scrollRef.value) {
        const still = scrollRef.value.scrollHeight - scrollRef.value.scrollTop - scrollRef.value.clientHeight;
        if (still > 0) {
          autoScrollLastTime = 0;
          autoScrollRafId = requestAnimationFrame(autoScrollLoop);
        }
      }
    }, 1000);
    return;
  }
  autoScrollRafId = requestAnimationFrame(autoScrollLoop);
}

watch(
  () => props.autoScroll,
  (on) => {
    if (on) {
      isUnmounted = false;
      autoScrollLastTime = 0;
      if (autoScrollRafId === null) autoScrollRafId = requestAnimationFrame(autoScrollLoop);
    } else {
      if (autoScrollRafId !== null) {
        cancelAnimationFrame(autoScrollRafId);
        autoScrollRafId = null;
      }
      autoScrollLastTime = 0;
    }
  }
);

/* ==================== 手动跳章标记（v48） ==================== */

/**
 * 手动跳章（点击底部"上一章/下一章"按钮）时由 Reader 调用：
 * 取消自动拼接意图 → watch 走重置分支（清空旧章、只显示新章、回顶部）。
 * 与自动拼接（滚到 85% 预取，视口不动、新章追加下方）区分开。
 */
let pendingManualJump = false;

function markManualJump(): void {
  pendingManualJump = true;
  isAppendingNextChapter = false;
  // P1-2：手动跳章同样取消前插意图（重置分支兜底会清，此处显式置位防时序窗口）
  isPrependingPrevChapter = false;
}

/** P1-2：按槽位索引的 Record 状态整体平移（旧槽位 + offset → 新槽位）。前插后旧图全部后移 */
function shiftSlotRecord<T>(record: Record<number, T>, offset: number): Record<number, T> {
  const shifted: Record<number, T> = {};
  for (const key of Object.keys(record)) {
    shifted[Number(key) + offset] = record[Number(key)];
  }
  return shifted;
}

/* ==================== 监听图片列表变化 ==================== */

watch(
  () => props.images,
  () => {
    // 滚动模式跨章追加：将新章图片追加到累积列表，不重置已有状态。
    // v48：手动跳章（pendingManualJump）优先走重置分支
    // A-5修复：追加分支加章号校验——新数据必须是"最后拼接章的下一章"
    // （comicChapterIndex === baseChapterIndex + boundaries.length）才走追加，
    // 否则一律按重置处理。从根上防御所有无 markManualJump 的重载路径
    // （ReadSettings 改 textConvert/smartFormat 触发 loadChapter(视口章)、
    // relocate 恢复重试等）在 isAppendingNextChapter 挂起（典型：最后一章
    // 滚到底触发拼接 emit 但 Reader 无下一章可拼早退）时被误判为追加——
    // 误判会导致当前章内容在拼接列表里重复显示一遍
    if (
      !pendingManualJump &&
      isAppendingNextChapter &&
      props.images.length > 0 &&
      readerStore.comicChapterIndex === baseChapterIndex + chapterBoundaries.value.length
    ) {
      isAppendingNextChapter = false;
      // v53：记录新章起始槽位（续载合并同步区间）
      lastChapterStartSlot = accumulatedImages.value.length;
      // v54：登记新章边界（转场卡渲染 + 视口章判定用）。
      // comicChapterIndex 在 store.loadChapter 内先于 comicImages 赋值，
      // 此刻即新拼接章的绝对章号；chapterIndex 供 A-4 续载按章请求用
      chapterBoundaries.value = [
        ...chapterBoundaries.value,
        {
          start: lastChapterStartSlot,
          title: chapterTitleOf(readerStore.comicChapterIndex),
          chapterIndex: readerStore.comicChapterIndex
        }
      ];
      accumulatedImages.value = [...accumulatedImages.value, ...props.images];
      // 重新初始化 Observer 以观察新追加的图片
      nextTick(() => {
        initScrollObserver();
        // P1-3：拼接后若列表仍单屏（新章也是单图章）→ 置门控，等用户交互
        // （滚轮/滚动）再续拼，防一次触发连环拼接用户未看的内容
        updateListScrollable();
        if (listUnscrollable.value) {
          needsUserScrollAfterAutoAppend = true;
        }
      });
      return;
    }

    // P1-2（导航审计 #2）：滚动模式触顶前插上一章——新章图片插到拼接列表头部，
    // 视口位置保持（scrollTop 补偿新章渲染高度），对齐文字模式 prependPrevChapter。
    // 章号校验（对称于追加分支 A-5）：新数据必须是"拼接首章的前一章"
    // （comicChapterIndex === baseChapterIndex - 1）才走前插，否则一律按重置处理。
    //
    // ── 前插不变量（与追加分支共享的坐标系公式：边界 k 的绝对章号 =
    //    baseChapterIndex + k）──
    // 前插完成后：baseChapterIndex 前移至新首章（comicChapterIndex 同步前移，
    // 数据源章=新首章）；新边界 { start: 0 } 占首，全部旧边界 start += 新章长度
    // （整体后移一位）；数据源章起始槽位 lastChapterStartSlot = 0（syncCurrentChapterImages
    // 的同步区间即 [0, 新章长度)）。此后追加分支校验式
    // comicChapterIndex === baseChapterIndex + boundaries.length 在新坐标系下
    // 依然成立（两端同时基于前移后的 baseChapterIndex 计算，公式自洽）；
    // syncExtraChapterImages 的 k = chapterIndex - baseChapterIndex 对新旧章
    // 同样成立（旧章章号未变、baseChapterIndex 前移后 k 相应 +1，与新边界序一致）。
    if (
      !pendingManualJump &&
      isPrependingPrevChapter &&
      props.images.length > 0 &&
      readerStore.comicChapterIndex === baseChapterIndex - 1
    ) {
      isPrependingPrevChapter = false;
      const prevLen = props.images.length;
      chapterBoundaries.value = [
        {
          start: 0,
          title: chapterTitleOf(readerStore.comicChapterIndex),
          chapterIndex: readerStore.comicChapterIndex
        },
        ...chapterBoundaries.value.map((b) => ({ ...b, start: b.start + prevLen }))
      ];
      baseChapterIndex = readerStore.comicChapterIndex;
      // 数据源章前移至新首章 → 续载原地合并区间归零
      lastChapterStartSlot = 0;
      // 按槽位索引的状态整体平移（旧图槽位全部 +prevLen，加载态/占位比/缩放不错位）
      imageLoadStates.value = shiftSlotRecord(imageLoadStates.value, prevLen);
      retryKeys.value = shiftSlotRecord(retryKeys.value, prevLen);
      imageRatios.value = shiftSlotRecord(imageRatios.value, prevLen);
      imageZoomStates.value = shiftSlotRecord(imageZoomStates.value, prevLen);
      // 视口位置保持：记录插入前 scrollHeight/scrollTop，DOM 更新（nextTick）后
      // 按差值补偿 scrollTop。v49 真实宽高比占位使新章渲染高度在 nextTick 即
      // 基本稳定；无尺寸数据时 100vh 占位与实际高度的渐进差属既有行为，与本
      // 补偿正交。补偿后 scrollTop 位于列表中部（新章高度 ≥ 视口），不会再次
      // 触发触顶拼接；连续回看由用户的下一次滚动驱动（3 秒冷却锁防抖）
      const el = scrollRef.value;
      const oldScrollHeight = el ? el.scrollHeight : 0;
      const oldScrollTop = el ? el.scrollTop : 0;
      accumulatedImages.value = [...props.images, ...accumulatedImages.value];
      nextTick(() => {
        initScrollObserver();
        if (el) {
          el.scrollTop = oldScrollTop + (el.scrollHeight - oldScrollHeight);
        }
        updateListScrollable();
      });
      return;
    }

    // 非追加场景（切书/手动跳章/章号不匹配的意外重载）：重置累积列表和所有状态
    pendingManualJump = false;
    isAppendingNextChapter = false;
    isPrependingPrevChapter = false;
    // P1-3：重置后单屏拼接门控复位（新章从头开始，无"未看新内容"一说）
    needsUserScrollAfterAutoAppend = false;
    lastChapterStartSlot = 0; // v53：单章显示，续载同步区间归零
    // v54：重置章边界与基章索引（comicChapterIndex 已是新章，单章显示）
    baseChapterIndex = readerStore.comicChapterIndex;
    lastEmittedChapterIndex = baseChapterIndex;
    chapterBoundaries.value = [
      { start: 0, title: chapterTitleOf(baseChapterIndex), chapterIndex: baseChapterIndex }
    ];
    accumulatedImages.value = [...props.images];
    imageLoadStates.value = {};
    retryKeys.value = {};
    imageRatios.value = {};
    imageZoomStates.value = {};
    userHasScrolled = false;
    preloadedUrls.clear();
    scrollImageRefs.length = 0;
    scrollCurrentPage.value = 1;
    pinchState = null;
    touchDragState = null;
    nextTick(() => {
      initScrollObserver();
      // P1-3：重置后刷新单屏判定（单屏章立即显示末尾"继续阅读"预告卡）
      updateListScrollable();
      // v46：跳章/切书后必须重置滚动位置。
      // 原实现不重置 → 累积多章时 scrollTop 停在 8000px，切到新章（仅 20 张图，
      // scrollHeight 变小）后 scrollTop 未复位 → 目录点章节定位错乱（用户实测"定位不准"）。
      // 注意：恢复阅读进度的场景，Reader 会在 loadChapter 之后另调 goToPosition，
      // 那时序在本 nextTick 之后，不受影响。
      if (scrollRef.value) {
        scrollRef.value.scrollTop = 0;
      }
    });
  }
);

/*
 * v53：续载合并信号 —— store 原地更新 comicImages（splice 保持数组引用，
 * watch(props.images) 不触发）后，同步拼接列表的当前章区间。
 * A-4：先同步旧章（comicChapterImageUpdates 跨章通道，可能平移边界），
 * 再同步数据源章区间（基于平移后的 lastChapterStartSlot）。
 */
watch(
  () => readerStore.comicImagesRevision,
  () => {
    syncExtraChapterImages();
    syncCurrentChapterImages();
  }
);

/* ==================== 生命周期 ==================== */

onMounted(() => {
  // 初始化累积图片列表，使 displayImages 立即生效
  lastChapterStartSlot = 0; // v53：初始单章
  // v54：初始化章边界（挂载时 watch(props.images) 不触发，需自行登记）
  baseChapterIndex = readerStore.comicChapterIndex;
  lastEmittedChapterIndex = baseChapterIndex;
  chapterBoundaries.value = [
    { start: 0, title: chapterTitleOf(baseChapterIndex), chapterIndex: baseChapterIndex }
  ];
  accumulatedImages.value = [...props.images];
  nextTick(() => {
    initScrollObserver();
    // v52：读取滚动视口高度（fitScreen/fitHeight/smartFit-横图的高度基准）
    updateViewportHeight();
    // P1-3：初始单屏判定（单图章开书即显示末尾"继续阅读"预告卡）
    updateListScrollable();
  });
  // v52：监听窗口尺寸变化，保持视口高度基准与缩放锚定及时更新
  window.addEventListener('resize', updateViewportHeight);
});

onBeforeUnmount(() => {
  isUnmounted = true;
  // v52：移除窗口尺寸监听
  window.removeEventListener('resize', updateViewportHeight);
  if (autoScrollRafId !== null) {
    cancelAnimationFrame(autoScrollRafId);
    autoScrollRafId = null;
  }
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

/**
 * 滚动到指定页（1-based，拼接列表全局槽位）。
 * 独立函数（v56）：expose 的 goToPage 与 goToChapterPage（章内页码按边界换算后）
 * 共用同一实现；首图 DOM 已挂载时精确定位，否则按页比例估算兜底。
 * A-12：程序化定位前置位 skipPrevChapterByScrollToTop——smooth/瞬时滚动
 * 途经列表顶部区域时 checkContinuousReading 会误触发 request-prev-chapter。
 */
function scrollToPage(page: number): void {
  if (!scrollRef.value) return;
  armSkipPrevChapterGuard();
  const target = scrollImageRefs[page - 1];
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  // v46 兜底：图片 DOM 尚未渲染（跳章/首次加载时 scrollImageRefs 为空）→
  // 原实现直接不滚动，导致目录定位失效。改为按页比例估算滚动位置。
  const el = scrollRef.value;
  const total = displayImages.value.length;
  const maxScroll = el.scrollHeight - el.clientHeight;
  if (maxScroll <= 0 || total <= 1) return;
  const ratio = Math.max(0, Math.min(1, (page - 1) / (total - 1)));
  el.scrollTop = ratio * maxScroll;
}

/**
 * A-2修复：按 chapterBoundaries 把"当前数据源章（comicChapterIndex）的章内
 * 页码（1-based）"换算为拼接列表全局槽位后定位。
 *
 * 拼接态下 props.images（=store.comicImages）是最后拼接章的单章列表，
 * 由它换算出的页码是章内页码而非全局槽位；原 goToPage 把章内页码当全局
 * 槽位 → 同章书签跳转错两章（探针复现：拼接 [Ch3(10),Ch4(10),Ch5(20)] 时
 * 点 Ch5 章内 0.25 书签 → goToPage(5) 落在 Ch3 第 5 页）。
 * 换算：找到当前数据源章的边界 start（0-based 槽位），全局 0-based 槽位 =
 * start + page - 1，scrollToPage 参数（1-based 全局页码）= start + page。
 * 单章（boundaries 只有一项 start=0）时退化为 goToPage 原语义 ✓；
 * 数据源章不在拼接区间（重置态/异常）时回退全局页码语义。
 */
function goToChapterLocalPage(page: number): void {
  const k = readerStore.comicChapterIndex - baseChapterIndex;
  const boundaries = chapterBoundaries.value;
  if (k < 0 || k >= boundaries.length) {
    scrollToPage(page);
    return;
  }
  scrollToPage(boundaries[k].start + Math.max(1, page));
}

defineExpose({
  /** v48：手动跳章标记 —— 下次 images 变化走重置分支（清空拼接、回新章顶部） */
  markManualJump,
  /**
   * A-5修复：清除"正在追加下一章"意图（Reader 侧拼接早退路径调用）。
   * 最后一章滚到底触发拼接 emit 后 Reader 无下一章可拼直接 return，组件
   * isAppendingNextChapter 永久挂起 → 此后无 mark 的重载（textConvert 变化等）
   * 被误判为追加（重复拼接）；本方法供 Reader 在早退前显式复位。
   */
  resetAppendIntent(): void {
    isAppendingNextChapter = false;
  },
  /**
   * P1-2：清除"正在前插上一章"意图（对称于 resetAppendIntent）。Reader 侧
   * prepend 早退路径（防重入拦截/章边界防御）调用——触顶 emit 后 Reader
   * 未实际发起 loadChapter 时组件 isPrependingPrevChapter 会永久挂起，
   * 此后被无 mark 的重载误判为前插（章号校验虽兜底，显式复位防时序窗口）。
   */
  resetPrependIntent(): void {
    isPrependingPrevChapter = false;
  },
  /**
   * A4修复：滚动到章节首页的页内偏移（0~1）
   *
   * 目录点击小节书签时定位到书签在页内的实际位置（pdf outline dest top 归一化值）。
   * 首图 DOM 已挂载时精确计算（offsetTop + 图高 × ratio）；未挂载（懒渲染/
   * pending 占位）按「单页高度比例」兜底估算——ratio 语义是页内偏移而非全章
   * 偏移，除以总页数会严重欠定位，故兜底只取首屏高度内偏移。
   */
  scrollToAnchor(ratio: number): void {
    const el = scrollRef.value;
    if (!el) return;
    // A-12：程序化定位（目录小节书签）同样置位 skip 标志——定位目标常在章顶
    // 区域（ratio 小），瞬时滚动后 checkContinuousReading 会误触发上一章
    armSkipPrevChapterGuard();
    const first = scrollImageRefs[0];
    if (first) {
      el.scrollTo({ top: first.offsetTop + first.offsetHeight * ratio, behavior: 'auto' });
      return;
    }
    // 兜底：首图未渲染时按可视高度内偏移估算（比不滚动好——至少离开章顶）
    el.scrollTo({ top: el.clientHeight * ratio, behavior: 'auto' });
  },
  /** 滚动到指定页（1-based） */
  goToPage(page: number): void {
    scrollToPage(page);
  },
  /**
   * A-2修复：按章边界换算"当前数据源章章内页码 → 拼接列表全局槽位"定位。
   * 供 ComicViewer.goToPosition（同章书签/进度恢复跳转）在拼接态下调用，
   * 详见上方函数注释。
   */
  goToChapterLocalPage,
  /**
   * v56 缩略图面板跳页：当前数据源章（comicChapterIndex）的章内页码 →
   * 拼接列表全局槽位定位（跨章拼接后 thumb 面板页码与拼接槽位错位问题的
   * 精确解：按章边界换算，与 goToPage(全局槽位) 语义区分开）。
   * 换算逻辑与 A-2 的 goToChapterLocalPage 同源，委托统一实现。
   */
  goToChapterPage(page: number): void {
    goToChapterLocalPage(page);
  },
  /**
   * v56 缩略图面板：当前数据源章（comicChapterIndex）的章内页码（1-based，
   * 未滚动=1）。面板高亮"当前页"用（全局槽位页码在拼接状态下与章内页码错位）。
   */
  getCurrentChapterLocalPage(): number {
    const k = readerStore.comicChapterIndex - baseChapterIndex;
    const boundaries = chapterBoundaries.value;
    if (k < 0 || k >= boundaries.length) return scrollCurrentPage.value;
    return Math.max(1, scrollCurrentPage.value - boundaries[k].start);
  },
  /**
   * 根因④（进度 chapter_offset 持久化）：视口所在章的章内页码（1-based）。
   * 与 getCurrentChapterLocalPage（数据源章语义，缩略图面板用）区分：拼接滚动
   * 模式下视口章（= store.currentChapterIndex，进度保存的章号）可能与数据源章
   * 不同（滚回旧章时），进度链的页码必须与章号同源（视口章），否则恢复时
   * 页码被解释到错误的章。边界定位与 currentChapterLocalProgress 同源。
   */
  getViewportChapterLocalPage(): number {
    const boundaries = chapterBoundaries.value;
    const globalSlot = scrollCurrentPage.value - 1;
    let b = 0;
    for (let k = 0; k < boundaries.length; k++) {
      if (boundaries[k].start <= globalSlot) b = k;
      else break;
    }
    return Math.max(1, globalSlot - boundaries[b].start + 1);
  },
  /**
   * 获取当前归一化进度（0~1）。
   * v54：改为"视口所在章的章内进度"（与 scroll-progress 事件同语义）——
   * 拼接状态下 Reader 的进度保存（章号=视口章 + 位置）与恢复精确对齐；
   * 原全局 scrollTop/maxScroll 进度会与视口章错位（保存章 A + 全局位置，
   * 恢复到单章 A 后位置越界/错位）。未滚动时 scrollCurrentPage=1 → 0。
   */
  getCurrentPosition(): number {
    return currentChapterLocalProgress();
  },
  /** 获取当前页码（1-based） */
  getCurrentPage(): number {
    return scrollCurrentPage.value;
  },
  /**
   * v57 修复：向下滚动一屏（滚动模式下箭头键"下一屏"，语义对齐文本 ScrollView
   * 的 scrollPageDown——0.9 屏平滑滚动；滚到接近底部自然触发续读拼接/转场逻辑）。
   * 此前滚动模式下 nextPage 无效（仅翻页模式实现），按 ←/→ 毫无反应。
   */
  scrollPageDown(): void {
    const el = scrollRef.value;
    if (!el) return;
    el.scrollBy({ top: el.clientHeight * 0.9, behavior: 'smooth' });
  },
  /**
   * v57 修复：向上滚动一屏（滚动模式下箭头键"上一屏"）。
   * 与用户手动滚轮等价：滚回拼接章顶部区域时按连续阅读规则自然衔接上一章。
   */
  scrollPageUp(): void {
    const el = scrollRef.value;
    if (!el) return;
    el.scrollBy({ top: -el.clientHeight * 0.9, behavior: 'smooth' });
  }
});
</script>

<template>
  <div class="comic-scroll-container">
    <!-- 滚动区（v52：original/自定义放大模式放开横向滚动，超宽图片可滚动查看左右部分） -->
    <div
      ref="scrollRef"
      class="comic-scroll"
      :class="{ 'allow-horizontal-scroll': horizontalScrollable }"
      @scroll="onScroll"
      @wheel="onWheel"
      @mousemove="onDragMove"
      @mouseup="onDragEnd"
      @mouseleave="onDragEnd"
    >
      <!-- v49：真实宽高比精确占位（对齐 PDF.js/Preview 的"几何先于像素"）：
           加载前占位高度即准确 → 滚动条稳定、进度准确、懒加载预判可靠，
           消除"图片加载后高度突变导致的滚动跳动"。无尺寸时回退 min-height:100vh。
           v54：渲染列表为 renderItems（图片 + 章间转场卡）；图片条目的 slot 与
           displayImages 全局槽位一致（observer/refs/缩放状态索引语义不变）。 -->
      <template v-for="item in renderItems" :key="item.type === 'image' ? `img-${item.slot}-${retryKeys[item.slot] || 0}` : `trans-${item.slot}`">
        <!-- 章间转场卡（Mihon 式）：上一章完 / 下一章标题；末尾卡为"已是最后一章"。
             v55 章节模式：末尾"下一章"预告卡可点击进入（hover 高亮 + 键盘可达），
             其余场景（滚动模式自动衔接 / 最后一章提示）纯展示；
             P1-3：滚动模式单屏章末尾"继续阅读"兜底卡同样可点击（走自动拼接） -->
        <div
          v-if="item.type === 'transition'"
          class="comic-chapter-transition"
          :class="{ clickable: isTransitionCardClickable(item) }"
          :data-slot="item.slot"
          :role="isTransitionCardClickable(item) ? 'button' : undefined"
          :tabindex="isTransitionCardClickable(item) ? 0 : undefined"
          @click="onTransitionCardClick(item)"
          @keydown.enter.prevent="onTransitionCardClick(item)"
        >
          <span class="transition-rule" aria-hidden="true"></span>
          <span class="transition-label">{{ t('comic.transition.chapterEnd') }}</span>
          <span class="transition-next">{{
            item.nextChapterTitle === null
              ? t('comic.transition.lastChapter')
              : t('comic.transition.nextChapter', { title: item.nextChapterTitle })
          }}</span>
          <span v-if="item.nextChapterTitle !== null" class="transition-hint">{{
            isChapterMode ? t('comic.transition.tapToNext') : t('comic.transition.keepReading')
          }}</span>
          <span class="transition-rule" aria-hidden="true"></span>
        </div>
        <!-- 图片条目（slot=全局槽位，等价旧 v-for 的 i） -->
        <div
          v-else
          class="comic-image-wrapper"
          :class="{ dragging: isDragging && draggingImageIndex === item.slot }"
          :data-index="item.slot"
          :style="{
            '--comic-image-gap': `${settings.comicImageGap || 0}px`,
            transform: getImageTransform(item.slot),
            cursor: getImageZoomState(item.slot).scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
            ...getWrapperPlaceholderStyle(item.slot)
          }"
        >
          <!-- 加载中占位符：灰色背景+页码文字；v53 pending 页（尚未渲染）附转圈图标 -->
          <div
            v-if="!imageLoadStates[item.slot] || imageLoadStates[item.slot] === 'loading'"
            class="comic-placeholder-loading"
            :class="{ pending: item.image?.pending }"
          >
            <span v-if="item.image?.pending" class="comic-pending-spinner" aria-hidden="true"></span>
            <span class="comic-placeholder-page">{{
              t('comic.page.ofTotal', { current: item.slot + 1, total: displayImages.length })
            }}</span>
          </div>
          <!-- 加载失败：错误图标+重试按钮 -->
          <div v-if="imageLoadStates[item.slot] === 'error'" class="comic-placeholder-error">
            <span class="comic-error-icon">⚠</span>
            <span class="comic-placeholder-text">{{ t('comic.imageLoadError') }}</span>
            <span class="comic-placeholder-page">{{
              t('comic.page.ofTotal', { current: item.slot + 1, total: displayImages.length })
            }}</span>
            <button class="comic-retry-btn" @click="retryImage(item.slot)">{{ t('common.actions.retry') }}</button>
          </div>
          <img
            :ref="
              (el) => {
                if (el) scrollImageRefs[item.slot] = el as HTMLImageElement;
              }
            "
            :src="coverPathToUrl(item.image?.path ?? '')"
            :alt="t('comic.page.short', { n: item.slot + 1 })"
            loading="lazy"
            :data-index="item.slot"
            :data-image-path="item.image?.path || ''"
            :style="getImageStyle(item.slot)"
            :class="{ loaded: imageLoadStates[item.slot] === 'loaded' }"
            @load="onImageLoad($event, item.slot)"
            @error="onImageError(item.slot)"
            @dblclick.stop="onImageViewRequest(item)"
            @touchstart="onTouchStart($event, item.slot)"
            @touchmove="onTouchMove($event, item.slot)"
            @touchend.passive="onTouchEnd($event)"
            @mousedown="onDragStart($event, item.slot)"
          />
        </div>
      </template>
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
  /* v57：背景透明化，由外壳 ComicViewer 按漫画背景色设置统一透出
   * （原固定 #000 与 A5 修复注释见 ComicViewer；背景职责收敛到外壳单一数据源） */
  background: transparent;
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

/* v57 滚动条黑边修复：按漫画背景自适应（thumb 颜色由外壳 ComicViewer 按背景
 * 模式提供 --comic-scrollbar-thumb 变量，CSS 变量继承穿透 scoped）。
 * 此前沿用全局黑色半透明 thumb——纯黑背景上不可见，6px 占位条在图片居中
 * 布局下呈现为一条死黑边。黑底→白色半透明可见 thumb，浅底→黑色半透明。 */
.comic-scroll::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.comic-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.comic-scroll::-webkit-scrollbar-thumb {
  background: var(--comic-scrollbar-thumb, rgba(255, 255, 255, 0.22));
  border-radius: var(--border-radius-sm, 3px);
}

.comic-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--comic-scrollbar-thumb-hover, rgba(255, 255, 255, 0.4));
}

/* v52：original/自定义放大模式放开横向滚动，超宽图片可拖动滚动条查看左右部分。
   注意：居中 flex 内超宽子元素会产生负向（左侧）溢出，scrollLeft 无法到达，
   因此该模式下 wrapper 改为由图片内容撑开（min-width 保底占满），消除负向溢出。 */
.comic-scroll.allow-horizontal-scroll {
  overflow-x: auto;
}

.comic-scroll.allow-horizontal-scroll .comic-image-wrapper {
  width: auto;
  min-width: 100%;
  justify-content: flex-start;
}

.comic-image-wrapper {
  width: 100%;
  /* 预设占位高度：图片加载前包裹层需占位，否则高度为 0 会让所有图片都落在视口内，
     导致 loading="lazy" 全部一次性加载（PDF 扫描版/漫画一次性加载 20 张卡顿）。
     预设为约一屏高，滚动时逐张加载（一次仅视口附近 2-3 张）。 */
  min-height: 100vh;
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

/* v54 章间转场卡（Mihon 式）：拼接处 ~30vh 的纯展示分隔卡（无交互，
   滚动模式自动衔接），深色半透明与占位符风格协调。
   v58：颜色统一改用 --comic-text 变量（ComicViewer 按漫画背景注入），
   浅色漫画背景下自动转为黑字，黑底下与原 rgba(255,255,255,x) 视觉一致。 */
.comic-chapter-transition {
  width: 100%;
  min-height: 30vh;
  padding: 24px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 3%, transparent);
  /* 图片间距变量对齐（与 wrapper 的 margin-bottom 一致视觉节奏） */
  margin-bottom: var(--comic-image-gap, 0px);
  user-select: none;
}

.comic-chapter-transition:last-child {
  margin-bottom: 0;
}

/* 卡片上下细分割线（半透明，弱化存在感） */
.transition-rule {
  width: 38%;
  height: 1px;
  background: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 12%, transparent);
}

.transition-label {
  font-size: 13px;
  color: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 45%, transparent);
  letter-spacing: 2px;
}

.transition-next {
  font-size: 17px;
  font-weight: 600;
  color: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 85%, transparent);
  text-align: center;
  /* 长标题最多两行，超出省略 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  max-width: 80%;
}

.transition-hint {
  font-size: 12px;
  color: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 35%, transparent);
  letter-spacing: 1px;
}

/* v55 章节模式：末尾"下一章"预告卡可点击（hover/focus 高亮引导点击进入） */
.comic-chapter-transition.clickable {
  cursor: pointer;
  background: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 5%, transparent);
  transition: background 0.2s ease;
}

.comic-chapter-transition.clickable:hover,
.comic-chapter-transition.clickable:focus-visible {
  background: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 10%, transparent);
}

.comic-chapter-transition.clickable:hover .transition-next,
.comic-chapter-transition.clickable:focus-visible .transition-next {
  color: var(--comic-text, #fff);
}

.comic-chapter-transition.clickable:hover .transition-hint,
.comic-chapter-transition.clickable:focus-visible .transition-hint {
  color: color-mix(in srgb, var(--comic-text, rgba(255, 255, 255, 1)) 60%, transparent);
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

/* 页码指示器 */
.scroll-page-indicator {
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

/* 回到顶部按钮 */
.back-to-top-btn {
  position: absolute;
  bottom: 24px;
  right: 24px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--overlay-surface);
  color: var(--overlay-text);
  border: 1px solid var(--overlay-border-strong);
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
  background: var(--overlay-surface-hover);
  color: var(--overlay-text-strong);
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
