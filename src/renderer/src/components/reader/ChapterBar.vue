<!--
  章节目录抽屉

  功能：
  - Naive UI NDrawer 抽屉，从左侧滑出，宽度 320px
  - 章节列表，当前章节高亮（左侧 3px 紫色竖条 + 紫色文字）
  - 图片型阅读（漫画/PDF 图文/扫描版）："章节 | 页"双视图——页视图为当前章
    页面缩略图网格（v57 整合：原独立缩略图面板并入目录抽屉，入口唯一化。
    thumb_180 小图缓存 + 面板打开时懒生成 + 当前页描边高亮 + 点击跳页；
    未渲染页灰块占位同样可点击，跳页后阅读区自然续载渲染）
  - 卷层级支持：卷标题可折叠/展开，章节在卷下方缩进显示
  - 无卷的章节直接显示，不缩进
  - 卷标题显示章节数量 + 总字数估算（如"第一卷 残酷的家法 (14章 · 3.2万字)"）
  - 正序/倒序排列切换
  - 全部展开/全部折叠按钮
  - 章节项高度 36px，单行显示（标题 + 右侧信息右对齐）
  - 章节项右侧信息：PDF 显示页码范围 "P11-30"（url 为 "起始页-结束页"），
    有文字层时附带字数 "P11-30 · 3.2 万字"（PDF 的 fileLength 是字符数直接显示）；
    TXT/EPUB 显示字数估算（file_length / 2.5，fileLength 为字节数）；
    扫描版空章节、漫画 CBZ/EPUB 无页码概念 → 留空
  - 已读/未读标记（已读章节颜色更淡）
  - 章节序号灰色，标题白色，单行省略
  - 点击章节跳转
  - 顶部搜索框 + 章节总数（章节视图专属）
  - 底部显示当前阅读进度百分比 + 已读章数
-->
<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { NDrawer, NInput, NIcon, NEmpty, NVirtualList, NButton, NSpin } from 'naive-ui';
import { Search, ChevronRight, ChevronDown, ArrowUp, ArrowDown, ChevronsUpDown, ChevronsDownUp } from '@lucide/vue';
import { useReaderStore } from '@renderer/stores';
import { coverPathToUrl } from '@renderer/utils';
import type { ChapterIndex } from '@renderer/types';
import type { ChapterImage } from '../../../../shared';

const { t, locale } = useI18n();
const store = useReaderStore();

const props = withDefaults(
  defineProps<{
    /**
     * v57 页缩略图视图：高亮的"当前页"（当前数据源章的章内页码，1-based）。
     * 图片型阅读时由 Reader 维护（抽屉打开/跳页时从 ComicViewer 拉取），
     * 拼接滚动状态下章内页码 ≠ 拼接列表全局槽位。
     */
    comicCurrentPage?: number;
  }>(),
  {
    comicCurrentPage: 1
  }
);

// A4修复：目录跳转携带目标章节页内偏移（0~1），Reader 据此在切章后滚动定位到
// 小节书签的实际页内位置（pdf-parser 已把 outline dest top 编码进 url "@ratio" 尾缀）
// v57：jump-to-page 为页缩略图跳页（章内页码 1-based，Reader 转 ComicViewer.goToChapterPage）
const emit = defineEmits<{
  (e: 'chapter-locate', ratio: number): void;
  (e: 'jump-to-page', page: number): void;
}>();

/** 漫画模式：从 store 获取，用于适配漫画章节命名风格（"第X话"、"Vol.X"） */
const isComicMode = computed<boolean>(() => store.isComic);

/* ==================== v57 图片型"页"视图（缩略图整合进目录抽屉，入口唯一化） ==================== */

/** 图片型阅读（漫画/PDF 图文/扫描版，统一走 ComicViewer）：目录抽屉提供"章节|页"双视图 */
const isImageReader = computed<boolean>(() => store.renderAsImages);

/** 当前视图：chapters=章节列表（默认），pages=当前章页面缩略图网格 */
const activeView = ref<'chapters' | 'pages'>('chapters');

/** 章节列表视图是否可见（非图片型恒为 true，视图切换行不渲染） */
const showChapterListView = computed<boolean>(() => !isImageReader.value || activeView.value === 'chapters');

/** 页视图是否可见：抽屉打开 && 图片型 && pages 激活（懒生成：仅此时调 thumbnails IPC） */
const pagesViewVisible = computed<boolean>(
  () => store.showChapterBar && isImageReader.value && activeView.value === 'pages'
);

/** 缩略图加载中（主进程懒生成 thumb_180 期间 loading 态） */
const thumbLoading = ref<boolean>(false);
/** 缩略图条目列表（与 readImages 槽位一一对应；pending 页灰块占位） */
const thumbs = ref<ChapterImage[]>([]);
/** 请求序号：切书/切章后旧响应丢弃（防竞争错章渲染） */
let thumbSeq = 0;
/** 续载刷新去抖定时器（revision 高频递增，500ms 合并一次刷新） */
let revisionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const REVISION_REFRESH_DEBOUNCE_MS = 500;

/**
 * 加载当前章缩略图（页视图可见时调用）。
 * 主进程按缓存状态返回：已渲染页 thumb 路径（幂等懒生成 thumb_180.webp）、未渲染页 pending。
 */
async function loadThumbs(): Promise<void> {
  const book = store.book;
  if (!book) return;
  const bookId = book.id;
  const chapterIndex = store.comicChapterIndex;
  thumbLoading.value = true;
  const seq = ++thumbSeq;
  try {
    const list = await window.dbApi.chapter.thumbnails(bookId, chapterIndex);
    // 竞争检查：请求期间切书/切章 → 丢弃旧响应（loading 由新请求收尾）
    if (seq !== thumbSeq) return;
    thumbs.value = list ?? [];
  } catch (err) {
    console.error('[ChapterBar] 加载缩略图失败:', err);
    if (seq === thumbSeq) thumbs.value = [];
  } finally {
    if (seq === thumbSeq) thumbLoading.value = false;
  }
}

// 页视图变为可见（抽屉打开 / 切到 pages tab）→ 拉取（平时不生成，避免浪费）
watch(pagesViewVisible, (visible) => {
  if (visible) void loadThumbs();
});

// 打开状态下切书 → 清空旧数据（新书拉取由 pagesViewVisible/章变化 watch 触发）
// P3-13（导航审计 #13）：折叠状态一并清空——卷名相同的两本书（如都有"第一卷"）
// 会共享残留折叠状态，且切书时 currentChapterIndex 可能不变、自动展开卷的
// watch 不触发 → 新书当前卷被旧折叠状态藏住
watch(
  () => store.book?.id,
  () => {
    thumbs.value = [];
    collapsedVolumes.value = new Set();
    if (pagesViewVisible.value) void loadThumbs();
  }
);

// 打开状态下当前章变化（跳章/跨章滚动）→ 拉取新章缩略图
watch(
  () => store.comicChapterIndex,
  () => {
    if (pagesViewVisible.value) void loadThumbs();
  }
);

// 打开状态下续载完成（pending 页渲染落盘）→ 去抖刷新（新渲染页 thumb 增量生成，已存在零成本）
watch(
  () => store.comicImagesRevision,
  () => {
    if (!pagesViewVisible.value) return;
    if (revisionRefreshTimer !== null) return;
    revisionRefreshTimer = setTimeout(() => {
      revisionRefreshTimer = null;
      void loadThumbs();
    }, REVISION_REFRESH_DEBOUNCE_MS);
  }
);

/** 点击缩略图/pending 灰块 → 跳页（灰块跳页后阅读区自然续载渲染） */
function onThumbClick(page: number): void {
  emit('jump-to-page', page);
}

/** 缩略图 img 的 URL（pending/空路径不渲染） */
function thumbUrl(img: ChapterImage): string {
  return img.path ? coverPathToUrl(img.path) : '';
}

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

/** 估算字数：file_length / 2.5（GBK和UTF-8的折中值）。
 *  仅适用于 TXT/EPUB——它们的 fileLength 是字节数；PDF 的 fileLength 是字符数，不做此估算 */
function estimateWordCount(fileLength: number | null | undefined): number {
  if (!fileLength || fileLength <= 0) return 0;
  return Math.round(fileLength / 2.5);
}

/**
 * 解析 PDF 章节的页码范围：url 为 "起始页-结束页"（1-based，如 "11-30"）；
 * 漫画 PDF 每章一页，url 为单数字页码（如 "5"，视为 start = end）。
 * A4修复：url 尾部可能带 "@ratio" 页内偏移编码（如 "11-30@0.62"，供切章滚动
 * 定位），页码显示计算忽略该后缀。
 * TXT 章节无 url（null）、EPUB/CBZ 的 url 为 ZIP entry 路径（含扩展名），均不匹配返回 null。
 */
function parsePageRange(url?: string | null): { start: number; end: number } | null {
  if (!url) return null;
  const m = /^(\d+)(?:-(\d+))?(?:@[\d.]+)?$/.exec(url.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  return end >= start ? { start, end } : null;
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

/**
 * 章节项右侧信息（按优先级）：
 * - PDF（url 为页码范围格式）→ "P11-30"；有文字层且非漫画模式时附带字数 "P11-30 · 3.2 万字"
 *   （PDF 的 fileLength 是字符数，直接当字数显示，不做 /2.5 估算）
 * - TXT/EPUB（无页码范围）→ 字数估算（fileLength 为字节数，走 estimateWordCount）
 * - 扫描版空章节 / 漫画 CBZ、EPUB（无页码概念）→ 空串，右侧留白
 */
function chapterSideInfo(ch: ChapterIndex): string {
  const range = parsePageRange(ch.url);
  if (range) {
    const pageText = range.start === range.end ? `P${range.start}` : `P${range.start}-${range.end}`;
    // 页码文本较短时才附带字数，避免挤占标题空间（大页码书只显示页码）；漫画每章一页不显示字数
    if (!isComicMode.value && pageText.length <= 8) {
      const words = formatWordCount(ch.file_length ?? 0);
      if (words) return `${pageText} · ${words}`;
    }
    return pageText;
  }
  if (isComicMode.value) return '';
  const count = estimateWordCount(ch.file_length);
  return count > 0 ? formatWordCount(count) : '';
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

/** 卷 → 总字数估算映射（PDF 的 fileLength 是字符数直接累加；TXT/EPUB 为字节数走 /2.5 估算） */
const volumeWordCounts = computed<Map<string, number>>(() => {
  const map = new Map<string, number>();
  for (const ch of filteredChapters.value) {
    if (ch.volume) {
      const current = map.get(ch.volume) ?? 0;
      const words = parsePageRange(ch.url) ? (ch.file_length ?? 0) : estimateWordCount(ch.file_length);
      map.set(ch.volume, current + words);
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

  // P2-8（导航审计 #8）：搜索中忽略卷折叠——命中章所在卷强制显示（否则命中
  // 章藏在折叠卷里，只见卷头不见章，用户误判"无结果"）。清除搜索后 collapsedVolumes
  // 未被改动，computed 响应式天然恢复原折叠状态，无需保存/恢复逻辑
  const searching = keyword.value.trim() !== '';

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
        // 搜索中卷头章数=命中章数（filteredChapters 已按关键词过滤，天然联动）
        volumeCount: volumeCounts.value.get(vol) ?? 0,
        volumeWordCount: volumeWordCounts.value.get(vol) ?? 0
      });
    }
    // 折叠的卷下的章节不显示（搜索中全部展开显示命中章）
    if (vol && !searching && collapsedVolumes.value.has(vol)) {
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
  // A4修复：目录跳转前解析 url 的 "@ratio" 页内偏移（如 "11-30@0.62"）通知 Reader
  // 做滚动定位——点击小节书签直达小节在页内的位置而非仅章首（无编码则 ratio=0=章顶）
  emitChapterLocate(index);
  await store.jumpToChapter(index);
}

/** 键盘激活章节项（Enter / Space） */
async function handleChapterKeyActivate(index: number): Promise<void> {
  emitChapterLocate(index);
  await store.jumpToChapter(index);
}

/** A4修复：向 Reader 上报目标章节的页内偏移（url 尾部 @ratio，无编码为 0） */
function emitChapterLocate(index: number): void {
  const url = store.chapters.find((ch) => ch.chapter_index === index)?.url;
  const m = /@([\d.]+)$/.exec(url ?? '');
  emit('chapter-locate', m ? Math.max(0, Math.min(Number(m[1]), 1)) : 0);
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

/**
 * P3-12（用户质疑项，导航审计 #12）：唯一卷数（filteredChapters 中带卷章的唯一卷名数）。
 * 单卷书（≤1 卷）点"全部折叠"后唯一卷仍被特意保持展开（保留当前章定位），
 * 列表视觉零变化——按钮看起来失灵。折叠按钮对这类书禁用 + tooltip 说明。
 */
const volumeCount = computed<number>(() => volumeCounts.value.size);

/** P3-12：卷数 ≤1 时"全部折叠"禁用（折叠无效果，防"按钮失灵"观感） */
const collapseAllDisabled = computed<boolean>(() => volumeCount.value <= 1);

/** 全部折叠（保留当前章所在卷展开以定位阅读位置） */
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
  // P3-12：折叠结果为空集（全部卷均为当前卷，典型：单卷书）→ 列表视觉零
  // 变化，不写状态（按钮层已禁用，此处函数级防御兜底键盘/程序调用路径）
  if (allVols.size === 0) return;
  collapsedVolumes.value = allVols;
}

/** 切换正序/倒序 */
function toggleReverse(): void {
  isReversed.value = !isReversed.value;
}

/** P2-9：滚动跟随 debounce 定时器（跨章快速滚动合并为一次定位） */
let chapterFollowScrollTimer: ReturnType<typeof setTimeout> | null = null;
const CHAPTER_FOLLOW_SCROLL_DEBOUNCE_MS = 300;

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

    // P2-9（导航审计 #9）：抽屉开着且章节视图激活时，虚拟列表滚动跟随当前章——
    // 跨章拼接阅读（目录常开对照章节）时当前章高亮会滚出视野，需手动找。
    // debounce 300ms 防快速跨章滚动时列表抖动；NVirtualList 无可视区间查询
    // API，采用无条件 scrollTo（平滑定位到目标索引，已可见时位移极小）。
    // 页视图不跟随（不打断缩略图浏览）。
    if (store.showChapterBar && showChapterListView.value) {
      if (chapterFollowScrollTimer !== null) {
        clearTimeout(chapterFollowScrollTimer);
      }
      chapterFollowScrollTimer = setTimeout(() => {
        chapterFollowScrollTimer = null;
        const i = currentChapterDisplayIndex.value;
        if (i >= 0) {
          virtualListRef.value?.scrollTo({ index: i });
        }
      }, CHAPTER_FOLLOW_SCROLL_DEBOUNCE_MS);
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

/**
 * v57：从页视图切回章节视图时重新定位当前章。
 * 页视图期间章节列表（NVirtualList）被卸载，切回后重挂载滚动位置复位，
 * 复用与"抽屉打开"相同的定位逻辑。
 */
watch(activeView, async (view) => {
  if (view === 'chapters' && isImageReader.value && store.showChapterBar) {
    await nextTick();
    const idx = currentChapterDisplayIndex.value;
    if (idx >= 0) {
      virtualListRef.value?.scrollTo({ index: idx });
    }
  }
});

// P2-9：卸载清理滚动跟随定时器（阅读器关闭时 pending 的 debounce 不再触发）
onBeforeUnmount(() => {
  if (chapterFollowScrollTimer !== null) {
    clearTimeout(chapterFollowScrollTimer);
    chapterFollowScrollTimer = null;
  }
});
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
        <!-- v57 图片型：章节|页 视图切换（缩略图整合入口，与正序/倒序按钮同风格） -->
        <div v-if="isImageReader" class="viewTabs">
          <n-button
            size="tiny"
            quaternary
            :type="activeView === 'chapters' ? 'primary' : 'default'"
            @click="activeView = 'chapters'"
          >
            {{ t('comic.thumbnail.tabChapters') }}
          </n-button>
          <n-button
            size="tiny"
            quaternary
            :type="activeView === 'pages' ? 'primary' : 'default'"
            @click="activeView = 'pages'"
          >
            {{ t('comic.thumbnail.tabPages') }}
          </n-button>
        </div>
        <!-- 搜索框（章节视图专属：页视图无章节标题可搜） -->
        <div v-if="showChapterListView" class="searchWrap">
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
        <!-- 工具栏：正序/倒序 + 展开/折叠（章节视图专属） -->
        <div v-if="showChapterListView" class="toolbar">
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
            <!-- P3-12：单卷书折叠后唯一卷仍保持展开（定位当前章），视觉零变化——
                 禁用按钮并用 title 说明（全部展开在任何场景无害，保持可用） -->
            <n-button
              size="tiny"
              quaternary
              :disabled="collapseAllDisabled"
              :title="collapseAllDisabled ? t('readerBars.chapter.collapseDisabledHint') : undefined"
              @click="collapseAllVolumes"
            >
              <template #icon>
                <n-icon :component="ChevronsDownUp" size="14" />
              </template>
              {{ t('readerBars.chapter.collapseAll') }}
            </n-button>
          </template>
        </div>
      </div>

      <!-- 章节列表（虚拟滚动；章节视图——切页视图时卸载，切回经 watch 重新定位当前章） -->
      <n-empty
        v-if="showChapterListView && displayItems.length === 0"
        :description="t('readerBars.chapter.noMatch')"
        class="emptyState"
      />
      <n-virtual-list
        v-else-if="showChapterListView"
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
            <!-- 单行：标题 + 右侧信息（PDF 页码范围 / TXT、EPUB 字数）右对齐 -->
            <div class="chapterMainRow">
              <span class="chapterTitleText">{{ chapterDisplayName(item.chapter!) }}</span>
              <span v-if="chapterSideInfo(item.chapter!)" class="chapterWordCount">
                {{ chapterSideInfo(item.chapter!) }}
              </span>
            </div>
          </div>
        </template>
      </n-virtual-list>

      <!-- v57 图片型"页"视图：当前章页面缩略图网格（thumb_180 小图缓存，懒生成） -->
      <div v-if="isImageReader && activeView === 'pages'" class="thumbView">
        <n-spin :show="thumbLoading" size="small">
          <!-- 首次加载中提示（无旧数据可显示时） -->
          <div v-if="thumbLoading && thumbs.length === 0" class="thumbStatus">
            {{ t('comic.thumbnail.generating') }}
          </div>
          <!-- 空态：无页面（章节无图片数据） -->
          <div v-else-if="thumbs.length === 0" class="thumbStatus">
            {{ t('comic.thumbnail.noPages') }}
          </div>
          <!-- 缩略图网格（2 列；pending 页灰块占位） -->
          <div v-else class="thumbGrid">
            <button
              v-for="(img, i) in thumbs"
              :key="i"
              type="button"
              class="thumbCell"
              :class="{ current: i + 1 === comicCurrentPage, pending: img.pending }"
              :title="
                img.pending
                  ? t('comic.thumbnail.pendingPage')
                  : `${t('comic.page.short', { n: i + 1 })}${img.width > 0 && img.height > 0 ? ` · ${img.width}×${img.height}` : ''}`
              "
              :aria-label="t('comic.page.short', { n: i + 1 })"
              @click="onThumbClick(i + 1)"
            >
              <img
                v-if="!img.pending && thumbUrl(img)"
                :src="thumbUrl(img)"
                :alt="t('comic.page.short', { n: i + 1 })"
                loading="lazy"
                draggable="false"
              />
              <span v-else class="thumbPendingMark">{{ i + 1 }}</span>
              <span class="thumbPageNum">{{ i + 1 }}</span>
            </button>
          </div>
        </n-spin>
      </div>

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

/* ==================== v57 图片型视图切换（章节|页） ==================== */
.viewTabs {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  margin-bottom: var(--spacing-sm);
}

/* ==================== v57 页缩略图视图 ==================== */
/* 页视图主体（内部滚动，与章节列表 flex:1 布局对齐） */
.thumbView {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-sm) var(--spacing-md-lg);
}

/* 生成中/空态提示（主题变量：跟随抽屉主题而非固定灰） */
.thumbStatus {
  padding: var(--spacing-3xl) 0;
  text-align: center;
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
}

/* 缩略图网格：2 列（抽屉 320px - 两侧 padding 32px ≈ 288px 内容宽，每格约 140px） */
.thumbGrid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--spacing-sm);
}

/* 缩略图格子（button 复位 + hover 引导点击；主题变量适配浅/深色主题） */
.thumbCell {
  position: relative;
  border: 2px solid transparent;
  border-radius: 4px;
  background: var(--bg-elevated);
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.15s ease, background 0.15s ease;
  display: block;
  width: 100%;
}

.thumbCell:hover {
  background: var(--bg-hover);
}

/* 当前页：描边高亮（竞品通用范式——SumatraPDF 蓝框跟随） */
.thumbCell.current {
  border-color: var(--primary);
}

.thumbCell img {
  display: block;
  width: 100%;
  height: auto;
  /* 未知尺寸时给最小高度，避免 img 高 0 塌陷；占位底色用主题变量
   * （v57 修复：原固定 #000 黑底在浅色主题下黑块突兀；图片内容本身不做 tint） */
  min-height: 60px;
  object-fit: contain;
  background: var(--bg-elevated);
  user-select: none;
  -webkit-user-drag: none;
}

/* pending 灰块：该页尚未渲染（主进程未落盘），显示页码占位 */
.thumbCell.pending .thumbPendingMark {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 90px;
  font-size: 15px;
  color: var(--text-tertiary);
  letter-spacing: 1px;
}

/* 页码角标（右下，半透明胶囊——叠加在图片上，跨主题可用） */
.thumbPageNum {
  position: absolute;
  right: 3px;
  bottom: 3px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--overlay-surface);
  color: var(--overlay-text);
  font-size: 11px;
  line-height: 1.4;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
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

/* 单行：标题 + 右侧信息（页码范围/字数）右对齐 */
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
