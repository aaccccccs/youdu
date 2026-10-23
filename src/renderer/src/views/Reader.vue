<!--
  阅读器视图（M6 核心 + M7 阅读设置 + M8 书签笔记）

  布局结构（flex column，容器固定跟随窗口）：
  .reader-view (height:100%, overflow:hidden, display:flex, flex-direction:column)
    ├── .toolbar-restore (3px, flex-shrink:0) ← 隐藏工具栏后的恢复入口
    ├── .toolbar (height:56px, flex-shrink:0) ← 顶部工具栏（可隐藏）
    ├── ScrollView/PageView (flex:1, min-height:0) ← 正文区（唯一滚动区）
    └── .bottom-nav (height:64px, flex-shrink:0) ← 底部导航（可隐藏）

  快捷键：
  - ← / → 翻章（或翻页）
  - ↑ / ↓ 滚动
  - Space 向下翻页/滚动
  - Esc 返回书架
  - Ctrl + = / Ctrl + - 放大/缩小字号
  - Ctrl + , 打开阅读设置

  主题：
  - 使用阅读器独立主题 readerTheme，与应用主题分离
  - 通过 CSS 变量 --reader-bg / --reader-text / --reader-primary 传递给子组件
-->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  NButton,
  NDropdown,
  NIcon,
  NTooltip,
  NProgress,
  NModal,
  NInput,
  NSpace,
  NSlider,
  NDrawer,
  NDrawerContent,
  NRadioGroup,
  NRadio,
  NCheckbox,
  useMessage,
  useDialog
} from 'naive-ui';
import type { DropdownOption } from 'naive-ui';
import type { Component } from 'vue';
import {
  TableOfContents,
  ScrollText,
  Book,
  Settings,
  Bookmark as BookmarkIcon,
  BookmarkCheck,
  StickyNote,
  Highlighter,
  Eye,
  EyeOff,
  Layers,
  Rows3,
  Copy,
  Minus,
  Plus,
  ChevronLeft,
  ChevronRight,
  Volume2,
  Square,
  Play,
  Pause,
  Gauge,
  AlertCircle,
  RotateCw,
  Maximize,
  Minimize,
  Search,
  Replace,
  Check,
  Scaling,
  // v56 P0 对标：图片右键菜单（全屏查看/保存当前页）
  Image as ImageIcon,
  Download
} from '@lucide/vue';
import { useReaderStore } from '@renderer/stores';
import { useSettingsStore, matchKeyboardShortcut, overlayLightboxOpen } from '@renderer/stores';
import { useBookmarkStore } from '@renderer/stores';
import { useBookshelfStore } from '@renderer/stores';
import type { ReadMode, Bookmark } from '@renderer/types';
import {
  COMIC_SCALE_TYPES,
  COMIC_SCALE_LABEL_KEYS,
  type ComicScaleType
} from '@renderer/stores';

import { useDropdownIcon, useContextMenu } from '@renderer/composables';
import ScrollView from '@renderer/components/reader/ScrollView.vue';
import PageView from '@renderer/components/reader/PageView.vue';
// 统一阅读器：图片型内容（漫画 + PDF 图文/扫描版）统一走 ComicViewer（一次一页/可视区懒加载）
import ComicViewer from '@renderer/components/reader/ComicViewer.vue';

import ChapterBar from '@renderer/components/reader/ChapterBar.vue';
import BookmarkBar from '@renderer/components/reader/BookmarkBar.vue';
import ReadSettings from '@renderer/components/reader/ReadSettings.vue';
import RelocateDialog from '@renderer/components/common/RelocateDialog.vue';
import SearchPanel from '@renderer/components/reader/SearchPanel.vue';


import { HIGHLIGHT_COLORS } from '../../../shared';
// 根因④：恢复链的章内页码 clamp（持久化页码 → 当章合法页码区间）
// 任务25：文本模式内容锚点（字符偏移 → 段落归一位置换算）
import { clampChapterOffset, splitParagraphs, computeParagraphIndexByCharOffset, paragraphIndexToPosition } from '@renderer/utils';

const route = useRoute();
const router = useRouter();
const store = useReaderStore();

/* ==================== link 书失效重新定位（批次 v54 导入三模式） ==================== */

/** 重新定位对话框开关（reader store 的 fileMissing 非空时自动打开） */
const showRelocate = ref(false);

// watch fileMissing：失效信息出现时打开对话框；清除时同步关闭
watch(
  () => store.fileMissing,
  (v) => {
    showRelocate.value = v !== null;
  }
);

/** 重新定位成功：清除失效信息并自动重试打开原章节（无感恢复闭环） */
async function handleRelocated(): Promise<void> {
  // P2修复：优先用失效时记录的原始请求章——开书首次 loadChapter(进度章 N) 失败时
  // currentChapterIndex 仍是 0（成功路径才推进），按它重试会回第 0 章丢进度；
  // attemptedChapterIndex 缺失（理论不可达，防御）才回退 currentChapterIndex
  const retryIndex = store.fileMissing?.attemptedChapterIndex ?? store.currentChapterIndex;
  store.clearFileMissing();
  showRelocate.value = false;
  // P2 导入三模式：同步清除书架 link 失效角标（该书已恢复，含深度搜索自动恢复路径）
  try {
    useBookshelfStore().clearMissingLink(bookId.value);
  } catch {
    /* Pinia 未初始化时忽略（角标状态留待下次批量检查自然纠正） */
  }
  await store.loadChapter(retryIndex);
}
const settings = useSettingsStore();
const bookmarkStore = useBookmarkStore();

const message = useMessage();
const dialog = useDialog();
const { t } = useI18n();

/** 书籍 ID（从路由参数获取） */
const bookId = computed<number>(() => {
  const id = parseInt(route.params.bookId as string, 10);
  return Number.isNaN(id) ? 0 : id;
});

/** 滚动视图组件引用（文本内容） */
const scrollViewRef = ref<InstanceType<typeof ScrollView> | null>(null);
/** 翻页视图组件引用（文本内容） */
const pageViewRef = ref<InstanceType<typeof PageView> | null>(null);
/** 图片型内容阅读器引用（漫画 + PDF 图文/扫描版，一次一页/可视区懒加载） */
const comicViewerRef = ref<InstanceType<typeof ComicViewer> | null>(null);

/**
 * 是否为"图片型内容"阅读 —— 统一走 ComicViewer 按页渲染。
 * 由 store.loadChapter 按实际内容动态判定（v38 真图文修复）：
 *   纯文本 / 真图文（大量文字+插图） → ScrollView / PageView（[IMG:] 内嵌插图，
 *     字号/TTS/搜索/笔记等文字功能可用）
 *   PDF 扫描版 / 漫画 / EPUB·MOBI image 章节 → ComicViewer（一次一页/懒加载）
 * 判定在章节加载中完成（loading 遮罩期间），完成后直接呈现正确 UI，无闪烁。
 */
const isImageReader = computed<boolean>(() => store.renderAsImages);

/** ComicViewer 显示模式：page 模式翻页，其余（chapter/scroll/all）滚动 */
const comicMode = computed<'scroll' | 'page'>(() => (store.readMode === 'page' ? 'page' : 'scroll'));

/** 是否为"翻页式"阅读（图片型 page 或 文本 page） */
const isPagedReader = computed<boolean>(() =>
  isImageReader.value ? comicMode.value === 'page' : store.readMode === 'page'
);

/** 是否为文本滚动式阅读（ScrollView：chapter/scroll/all），图片型与文本翻页均不为滚动式 */
const isScrollReader = computed<boolean>(() => !isImageReader.value && !isPagedReader.value);

/** 统一读取当前阅读位置（0~1 归一化），跨三种阅读器 */
function readerGetCurrentPosition(): number {
  if (isImageReader.value) return comicViewerRef.value?.getCurrentPosition() ?? 0;
  if (store.readMode === 'page') return pageViewRef.value?.getCurrentPosition() ?? 0;
  return scrollViewRef.value?.getCurrentPosition() ?? 0;
}

/**
 * 统一跳转到阅读位置（0~1 归一化），跨三种阅读器。
 *
 * @param position 章内归一化位置（段落级坐标系）
 * @param charOffset 可选章内字符偏移（任务27）：文本滚动模式下透传给
 *   ScrollView.scrollToPosition 反推段内比例，恢复到保存时的真实段内位置
 *   （往返偏差从 0.5×段高降到像素级）；图片/翻页模式不消费（走各自既有定位）
 */
async function readerGoToPosition(position: number, charOffset?: number): Promise<void> {
  if (isImageReader.value) {
    comicViewerRef.value?.goToPosition(position);
  } else if (store.readMode === 'page') {
    pageViewRef.value?.goToPosition(position);
  } else {
    await scrollViewRef.value?.scrollToPosition(position, charOffset);
  }
}

/**
 * 任务25：章内字符偏移 → 段落归一位置（内容锚点定位，免疫排版变化）。
 *
 * 用当前章节源文本（store.chapterContent）重新分段后反查包含该偏移的段落，
 * 再换算为根因①统一坐标系的归一位置——不新开定位分支。锚点不可用时返回
 * null（offset≤0 旧数据 / markdown 单段 / 内容缺失），调用方回退
 * scroll_position 比例路径（向后兼容）。
 *
 * 分段规则变化（textConvert/替换规则）后段落数组可能与保存时不同，反查
 * clamp 到当前段落数内（computeParagraphIndexByCharOffset 内部越界兜底）。
 * 段内精度（任务27）由调用方将原始 charOffset 继续透传给
 * readerGoToPosition/scrollToPosition 处理，此处只负责段落级定位。
 */
function resolvePositionByCharOffset(charOffset: number): number | null {
  if (!Number.isFinite(charOffset) || charOffset <= 0) return null;
  const content = store.chapterContent;
  if (!content) return null;
  const paragraphs = splitParagraphs(content);
  if (paragraphs.length <= 1) return null;
  const idx = computeParagraphIndexByCharOffset(paragraphs, charOffset);
  return paragraphIndexToPosition(idx, paragraphs.length);
}

/** 统一获取当前可见文本（图片型返回空，仅文本阅读器有内容） */
function readerGetVisibleText(): string {
  if (isImageReader.value) return '';
  if (store.readMode === 'page') return pageViewRef.value?.getVisibleText() ?? '';
  return scrollViewRef.value?.getVisibleText() ?? '';
}

/** 统一回到阅读器顶部（切换章节后复位）：图片型回到第一页 */
async function readerScrollToTop(): Promise<void> {
  if (isImageReader.value) {
    comicViewerRef.value?.goToPosition(0);
  } else if (store.readMode === 'page') {
    pageViewRef.value?.goToPosition(0);
  } else {
    await scrollViewRef.value?.scrollToTop();
  }
}

/** 统一"上一页/上一屏"：图片型→上一张，文本翻页→上一页，文本滚动→上一屏 */
async function readerPrevPage(): Promise<void> {
  if (isImageReader.value) {
    comicViewerRef.value?.prevPage();
  } else if (store.readMode === 'page') {
    await pageViewRef.value?.prevPage();
  } else {
    scrollViewRef.value?.scrollPageUp();
  }
}

/** 统一"下一页/下一屏"：图片型→下一张，文本翻页→下一页，文本滚动→下一屏 */
async function readerNextPage(): Promise<void> {
  if (isImageReader.value) {
    comicViewerRef.value?.nextPage();
  } else if (store.readMode === 'page') {
    await pageViewRef.value?.nextPage();
  } else {
    scrollViewRef.value?.scrollPageDown();
  }
}

/** 书签抽屉显示状态 */
const showBookmarkDrawer = ref<boolean>(false);
/** 搜索面板显示状态 */
const showSearchPanel = ref<boolean>(false);
/**
 * v57 缩略图整合进目录抽屉：高亮的"当前页"（当前数据源章的章内页码）。
 * 目录抽屉打开/点击缩略图跳页时从 ComicViewer 拉取（拼接状态下章内页码 ≠ 全局槽位），
 * 经 props 传给 ChapterBar 的"页"视图。
 */
const thumbCurrentPage = ref<number>(1);

/** 阅读设置面板显示 */
const showSettings = ref<boolean>(false);
/** 是否已成功加载初始章节 */
const initialized = ref<boolean>(false);

/* ==================== 右键菜单 ==================== */

const { contextMenuShow, contextMenuX, contextMenuY, openContextMenu, closeContextMenu } = useContextMenu();
const currentSelectedText = ref<string>('');

/**
 * v56 P0 对标：右键目标图片（图片型阅读器 ComicViewer 内的 <img>）。
 * 非图片位置右键时为 null（不显示图片专属菜单项）。
 * 图片元数据从 store.comicImages 按 path 匹配（拼接列表含旧章图片时可能
 * 匹配不到，回退仅含 path 的最小对象——保存/查看只需 path）。
 */
const contextMenuImage = ref<{ path: string; width: number; height: number } | null>(null);

const contextMenuOptions = computed<DropdownOption[]>(() => {
  // 选中文字时：只显示文字操作相关菜单项
  if (currentSelectedText.value) {
    return [
      { label: t('common.actions.copy'), key: 'copy', icon: renderIcon(Copy) },

      { label: t('reader.contextMenu.addNote'), key: 'add-note', icon: renderIcon(StickyNote) },
      { label: t('reader.contextMenu.highlight'), key: 'highlight', icon: renderIcon(Highlighter) },

      { label: t('reader.contextMenu.replaceRule'), key: 'add-replace-rule', icon: renderIcon(Replace) },
      { type: 'divider', key: 'divider-tts' },
      { label: t('reader.contextMenu.ttsFromHere'), key: 'tts-from-here', icon: renderIcon(Play) }
    ];
  }

  // 未选中文字时：显示导航和设置类菜单项
  const options: DropdownOption[] = [];
  options.push({ label: t('reader.contextMenu.addBookmark'), key: 'add-bookmark', icon: renderIcon(BookmarkIcon) });
  options.push({ type: 'divider', key: 'divider-1' });
  options.push({ label: t('reader.contextMenu.toc'), key: 'toggle-chapter-bar', icon: renderIcon(TableOfContents) });
  options.push({ label: t('reader.contextMenu.readSettings'), key: 'show-settings', icon: renderIcon(Settings) });
  options.push({
    label: t('reader.contextMenu.bookmarkNote'),
    key: 'toggle-bookmark-drawer',
    icon: renderIcon(BookmarkCheck)
  });

  // 自动滚动选项：文本滚动模式 + 图片滚动模式（v39：图片型支持自动滚动，拼接续读）
  if (isScrollReader.value || (isImageReader.value && comicMode.value === 'scroll')) {
    options.push({
      label: autoScrollEnabled.value ? t('reader.contextMenu.stopAutoScroll') : t('reader.contextMenu.startAutoScroll'),
      key: 'toggle-auto-scroll',
      icon: renderIcon(Gauge)
    });
  }
  options.push({
    label: store.showToolbar ? t('reader.contextMenu.hideToolbar') : t('reader.contextMenu.showToolbar'),
    key: 'toggle-toolbar',
    icon: renderIcon(store.showToolbar ? EyeOff : Eye)
  });
  options.push({
    label: store.isFullscreen ? t('reader.contextMenu.exitFullscreen') : t('reader.contextMenu.enterFullscreen'),
    key: 'toggle-fullscreen',
    icon: renderIcon(store.isFullscreen ? Minimize : Maximize)
  });
  options.push({
    // 文案显示目标模式（下一个将切换到的模式），而非当前模式——避免"切换为X"点击后切到 Y 的语义反转
    label: t('reader.contextMenu.switchReadMode', { mode: nextReadModeLabel.value }),
    key: 'toggle-read-mode',
    icon: renderIcon(readModeIcon.value)
  });

  // 图片型内容（漫画/PDF 图文/扫描版）：图片适配模式子菜单，快速切换图片大小（用户"图片太小不能调整"的直达入口）
  if (isImageReader.value) {
    options.push({
      label: t('reader.contextMenu.imageScale'),
      key: 'image-scale',
      icon: renderIcon(Scaling),
      // 从共享枚举 COMIC_SCALE_TYPES 动态生成（单一数据源）：
      // 后续新增适配模式（如 fitHeight/custom）只需扩展 types.ts 的 Record，子菜单自动包含
      children: COMIC_SCALE_TYPES.map((value): DropdownOption => ({
        label: t(COMIC_SCALE_LABEL_KEYS[value]),
        key: `scale:${value}`,
        // 当前选中的适配模式前打勾（Check 图标），其余项无图标
        icon: value === settings.comicScaleType ? renderIcon(Check) : undefined
      }))
    });
  }

  // v56 P0 对标：右键图片 → 全屏查看原图（Calibre）+ 保存当前页（Mihon）
  // （contextMenuImage 仅在右键命中 ComicViewer 内 <img> 时非空）
  if (isImageReader.value && contextMenuImage.value) {
    options.push({ type: 'divider', key: 'divider-image-actions' });
    options.push({
      label: t('comic.viewer.viewFullscreen'),
      key: 'comic-view-image',
      icon: renderIcon(ImageIcon)
    });
    options.push({
      label: t('comic.viewer.savePage'),
      key: 'comic-save-image',
      icon: renderIcon(Download)
    });
  }

  return options;
});

const renderIcon = useDropdownIcon();

function handleContextMenu(event: MouseEvent): void {
  event.preventDefault();
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : '';
  currentSelectedText.value = text;
  // v56 P0 对标：右键图片型阅读器的 <img> 时记录目标图片（子组件 img 带
  // data-image-path；pending 占位页 path 为空 → 不显示图片专属菜单项）
  const target = event.target as HTMLElement | null;
  const imgPath =
    target instanceof HTMLImageElement
      ? target.dataset.imagePath
      : target?.closest?.('img')?.dataset.imagePath;
  if (isImageReader.value && imgPath) {
    const meta = store.comicImages.find((i) => i.path === imgPath);
    contextMenuImage.value = meta ?? { path: imgPath, width: 0, height: 0 };
  } else {
    contextMenuImage.value = null;
  }
  openContextMenu(event.clientX, event.clientY);
}

function handleContextMenuSelect(key: string | number): void {
  closeContextMenu();
  if (key === 'copy') {
    if (currentSelectedText.value) {
      navigator.clipboard.writeText(currentSelectedText.value).catch((err) => {
        console.error('[Reader] 复制到剪贴板失败:', err);
      });
    }
  } else if (key === 'add-bookmark') {
    void addBookmarkAtCurrentPosition().catch((e) => console.error('addBookmarkAtCurrentPosition 失败:', e));
  } else if (key === 'add-note') {
    openNoteModal();
  } else if (key === 'highlight') {
    void addHighlightFromSelection().catch((e) => console.error('addHighlightFromSelection 失败:', e));
  } else if (key === 'add-replace-rule') {
    openReplaceRuleModal();
  } else if (key === 'tts-from-here') {
    void startTTSFromSelection().catch((e) => console.error('startTTSFromSelection 失败:', e));
  } else if (key === 'toggle-chapter-bar') {
    store.toggleChapterBar();
  } else if (key === 'show-settings') {
    showSettings.value = true;
  } else if (key === 'toggle-bookmark-drawer') {
    toggleBookmarkDrawer();
  } else if (key === 'toggle-auto-scroll') {
    toggleAutoScroll();
  } else if (key === 'toggle-toolbar') {
    store.toggleToolbar();
  } else if (key === 'toggle-fullscreen') {
    store.toggleFullscreen();
  } else if (key === 'toggle-read-mode') {
    // 复用工具栏 readModeOptions 的候选序列（已按 isImageReader/isImageHeavyContent 过滤），
    // 不再使用固定四态循环——多图内容不会绕过防御切进 all 模式，
    // 图片型在 chapter/scroll/page 三模式间循环（v55）
    void handleReadModeSelect(nextReadMode.value).catch((e) => console.error('handleReadModeSelect 失败:', e));
  } else if (String(key).startsWith('scale:')) {
    // 图片适配模式快捷切换：持久化到设置，图片型阅读器即时响应新适配模式
    const value = String(key).slice('scale:'.length) as ComicScaleType;
    if (COMIC_SCALE_TYPES.includes(value)) {
      void settings.setComicScaleType(value).catch((e) => console.error('settings.setComicScaleType 失败:', e));
    }
  } else if (key === 'comic-view-image') {
    // v56 P0 对标 Calibre：右键图片 → 全屏原尺寸查看（ComicViewer 内挂 ComicLightbox）
    if (contextMenuImage.value) {
      comicViewerRef.value?.openLightbox(contextMenuImage.value);
    }
  } else if (key === 'comic-save-image') {
    // v56 P0 对标 Mihon：右键图片 → 保存当前页（主进程保存对话框 + copyFile）
    void saveContextMenuImage();
  }
}

/**
 * v56 P0 对标 Mihon：保存右键目标图片到用户指定位置。
 * 主进程校验源路径（isPathSafe）→ 系统保存对话框（默认 Downloads + 原缓存文件名，
 * PDF 页缓存名即 page_N.webp）→ copyFile。用户取消静默（不弹错误）。
 */
async function saveContextMenuImage(): Promise<void> {
  const img = contextMenuImage.value;
  if (!img || !img.path) return;
  try {
    const result = await window.dbApi.chapter.saveImage(img.path);
    if (result.success) {
      message.success(t('comic.viewer.saveSuccess', { path: result.savedPath ?? '' }));
    } else if (!result.canceled) {
      message.error(result.error ? `${t('comic.viewer.saveFailed')}：${result.error}` : t('comic.viewer.saveFailed'));
    }
    // canceled：用户在保存对话框点取消，静默处理
  } catch (err) {
    console.error('[Reader] 保存章节图片失败:', err);
    message.error(t('comic.viewer.saveFailed'));
  }
}

/* ==================== 添加书签 ==================== */

function getCurrentPositionAndText(): { position: number; content: string } {
  // 统一：文本滚动/翻页、图片型三种阅读器均通过代理获取
  const content = readerGetVisibleText();
  return {
    position: readerGetCurrentPosition(),
    // A7修复：图片型无可提取文本（content 为空）时回填「第 N 页（共 M 页）」页码预览，
    // 否则图片型书签 content 全为 null，书签列表中连加数个书签无法区分哪个是哪页
    content: content || (isImageReader.value ? imageBookmarkPreview() : '')
  };
}

/** A7：图片型书签预览文本——当前页码取 ComicViewer（1-based），总页数取当前章图片列表 */
function imageBookmarkPreview(): string {
  const current = comicViewerRef.value?.getCurrentPage();
  const total = store.comicImages.length;
  if (current == null || total === 0) return '';
  return t('reader.bookmark.imagePagePreview', { n: current, m: total });
}

async function addBookmarkAtCurrentPosition(): Promise<void> {
  if (!store.book) return;
  const { position, content } = getCurrentPositionAndText();
  const chapterIndex = store.currentChapterIndex;

  // 同位置去重检查：只检查同位置是否已有「书签」（无 note 无 highlight_color），笔记/划线不影响
  if (position !== null && position !== undefined) {
    const existing = bookmarkStore.bookmarks.find(
      (b) => b.chapter_index === chapterIndex && b.position === position && !b.note && !b.highlight_color
    );
    if (existing) {
      dialog.warning({
        title: t('reader.bookmark.existsTitle'),
        content: t('reader.bookmark.existsContent'),
        positiveText: t('reader.actions.update'),
        negativeText: t('common.actions.cancel'),
        onPositiveClick: async () => {
          const ok = await bookmarkStore.updateBookmark(existing.id, {
            content: content || null
          });
          if (ok) {
            message.success(t('reader.bookmark.updateSuccess'));
          } else {
            message.error(t('reader.bookmark.updateFailed'));
          }
        }
      });
      return;
    }
  }

  const bm = await bookmarkStore.addBookmark({
    book_id: store.book.id,
    chapter_index: chapterIndex,
    position,
    content: content || null,
    note: null
  });
  if (bm) {
    message.success(t('reader.bookmark.addSuccess'));
  } else {
    message.error(t('reader.bookmark.addFailed'));
  }
}

/* ==================== 添加笔记 ==================== */

const noteModalShow = ref<boolean>(false);
const noteContent = ref<string>('');
/** 笔记高亮颜色（默认 null = 无高亮） */
const noteHighlightColor = ref<string | null>(null);

watch(
  () => noteModalShow.value,
  (newShow: boolean) => {
    if (newShow) {
      noteContent.value = '';
      noteHighlightColor.value = null;
    }
  }
);

function openNoteModal(): void {
  if (!currentSelectedText.value) {
    message.warning(t('reader.note.selectFirst'));
    return;
  }
  noteModalShow.value = true;
}

async function saveNote(note: string): Promise<void> {
  if (!store.book) return;
  const trimmedNote = note.trim();
  if (!trimmedNote) {
    message.warning(t('reader.note.emptyContent'));
    return;
  }
  const { position } = getCurrentPositionAndText();
  const chapterIndex = store.currentChapterIndex;
  const selectedText =
    currentSelectedText.value.length > 200 ? currentSelectedText.value.slice(0, 200) + '…' : currentSelectedText.value;

  // 同内容去重检查：同章节同段落（content 相同）已存在笔记才提示重复，位置无关
  const existing = bookmarkStore.bookmarks.find(
    (b) => b.chapter_index === chapterIndex && b.content === selectedText && b.note && b.note.trim() !== ''
  );
  if (existing) {
    dialog.warning({
      title: t('reader.note.existsTitle'),
      content: t('reader.note.existsContent'),
      positiveText: t('reader.actions.update'),
      negativeText: t('common.actions.cancel'),
      onPositiveClick: async () => {
        const ok = await bookmarkStore.updateBookmark(existing.id, {
          content: selectedText,
          note: trimmedNote,
          highlight_color: noteHighlightColor.value
        });
        if (ok) {
          message.success(t('reader.note.updateSuccess'));
          noteModalShow.value = false;
          window.getSelection()?.removeAllRanges();
          currentSelectedText.value = '';
        } else {
          message.error(t('reader.note.updateFailed'));
        }
      }
    });
    return;
  }

  const bm = await bookmarkStore.addBookmark({
    book_id: store.book.id,
    chapter_index: chapterIndex,
    position,
    content: selectedText,
    note: trimmedNote,
    highlight_color: noteHighlightColor.value
  });
  if (bm) {
    message.success(t('reader.note.addSuccess'));
    noteModalShow.value = false;
    window.getSelection()?.removeAllRanges();
    currentSelectedText.value = '';
  } else {
    message.error(t('reader.note.addFailed'));
  }
}

/* ==================== 划线功能 ==================== */

async function addHighlightFromSelection(): Promise<void> {
  if (!store.book) return;
  if (!currentSelectedText.value) {
    message.warning(t('reader.note.selectFirst'));
    return;
  }
  const { position } = getCurrentPositionAndText();
  const chapterIndex = store.currentChapterIndex;
  const selectedText =
    currentSelectedText.value.length > 200 ? currentSelectedText.value.slice(0, 200) + '…' : currentSelectedText.value;

  // 同内容去重检查：同章节同段落（content 相同）已存在划线才提示重复，位置无关
  const existing = bookmarkStore.bookmarks.find(
    (b) => b.chapter_index === chapterIndex && b.content === selectedText && b.highlight_color && !b.note
  );
  if (existing) {
    dialog.warning({
      title: t('reader.highlight.existsTitle'),
      content: t('reader.highlight.existsContent'),
      positiveText: t('reader.actions.update'),
      negativeText: t('common.actions.cancel'),
      onPositiveClick: async () => {
        const ok = await bookmarkStore.updateBookmark(existing.id, {
          content: selectedText,
          note: null,
          highlight_color: 'yellow'
        });
        if (ok) {
          message.success(t('reader.highlight.updateSuccess'));
          window.getSelection()?.removeAllRanges();
          currentSelectedText.value = '';
        } else {
          message.error(t('reader.highlight.updateFailed'));
        }
      }
    });
    return;
  }

  const bm = await bookmarkStore.addBookmark({
    book_id: store.book.id,
    chapter_index: chapterIndex,
    position,
    content: selectedText,
    note: null,
    highlight_color: 'yellow'
  });
  if (bm) {
    message.success(t('reader.highlight.addSuccess'));
    window.getSelection()?.removeAllRanges();
    currentSelectedText.value = '';
  } else {
    message.error(t('reader.highlight.addFailed'));
  }
}

/* ==================== 内容替换（v18 新增） ==================== */

/** 内容替换模态框显示状态 */
const replaceRuleModalShow = ref<boolean>(false);
/** 替换为的内容 */
const replaceRuleReplacement = ref<string>('');
/** 替换规则作用范围：global=全局，book=仅本书 */
const replaceRuleScope = ref<'global' | 'book'>('global');
/** 是否正则表达式 */
const replaceRuleIsRegex = ref<boolean>(false);

watch(
  () => replaceRuleModalShow.value,
  (newShow: boolean) => {
    if (newShow) {
      // 打开模态框时重置输入
      replaceRuleReplacement.value = '';
      replaceRuleScope.value = 'global';
      replaceRuleIsRegex.value = false;
    }
  }
);

/** 打开内容替换模态框 */
function openReplaceRuleModal(): void {
  if (!currentSelectedText.value) {
    message.warning(t('reader.replace.selectFirst'));
    return;
  }
  if (currentSelectedText.value.length > 500) {
    message.warning(t('reader.replace.tooLong'));
    return;
  }
  replaceRuleModalShow.value = true;
}

/** 保存内容替换规则 */
async function saveReplaceRule(): Promise<void> {
  const pattern = currentSelectedText.value.trim();
  if (!pattern) {
    message.warning(t('reader.replace.selectFirst'));
    return;
  }
  if (!store.book) {
    message.error(t('reader.replace.bookMissing'));
    return;
  }
  try {
    await window.dbApi.replaceRule.add({
      pattern,
      replacement: replaceRuleReplacement.value,
      scope: replaceRuleScope.value,
      book_id: replaceRuleScope.value === 'book' ? store.book.id : null,
      is_regex: replaceRuleIsRegex.value ? 1 : 0
    });
    message.success(t('reader.replace.addSuccess'));
    replaceRuleModalShow.value = false;
    // 重新加载当前章节以应用新规则
    const savedPosition = getCurrentPositionAndText().position;
    // 任务25：快照内容锚点（替换规则改变文本后字符偏移仍是最近似锚点，
    // 比例锚点在段落重排后失准更严重）
    const savedCharOffset = store.liveChapterCharOffset;
    // 提前设置位置恢复标志（仅文本滚动模式需要），防止 loadChapter 触发 watch 的 scrollToTop 覆盖位置恢复
    if (savedPosition > 0 && isScrollReader.value) {
      scrollViewRef.value?.prepareRestore();
    }
    await store.loadChapter(store.currentChapterIndex);
    await nextTick();
    // 任务27：透传原始 charOffset（ScrollView 反推段内比例，恢复真实段内位置）
    const anchored = resolvePositionByCharOffset(savedCharOffset);
    await readerGoToPosition(anchored ?? savedPosition, anchored !== null ? savedCharOffset : undefined);
    window.getSelection()?.removeAllRanges();
    currentSelectedText.value = '';
  } catch (err) {
    console.error('[Reader] 添加内容替换规则失败:', err);
    message.error(t('reader.replace.addFailed'));
  }
}

/* ==================== TTS 朗读 ==================== */

/** 组件是否活跃（卸载后置 false，防止 TTS 异步回调访问已卸载的响应式变量） */
let isComponentActive = true;

/** TTS 是否正在朗读 */
const ttsPlaying = ref<boolean>(false);
/** TTS 是否暂停 */
const ttsPaused = ref<boolean>(false);
/** TTS 当前朗读的段落索引 */
const ttsCurrentParagraph = ref<number>(-1);
/** TTS 朗读的段落列表 */
const ttsParagraphs = ref<string[]>([]);
/** SpeechSynthesisUtterance 当前实例 */
let ttsUtterance: SpeechSynthesisUtterance | null = null;
/** TTS 自动续读下一章标志——防止 watch(currentChapterIndex) 在自动切换时停止 TTS */
let ttsAutoAdvancing = false;
/** TTS 是否正在朗读章节标题（标题读完后再开始正文） */
const ttsSpeakingTitle = ref<boolean>(false);
/** TTS 连续出错次数：开头即失败或连续多次失败时熔断，防止无语音引擎时瞬间跳光段落/连环跳章 */
let ttsErrorCount = 0;
/** TTS 看门狗定时器：Chromium（尤其 Linux speech-dispatcher）长文本朗读约 15s 后可能静默挂起 */
let ttsWatchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 等待系统语音列表加载
 *
 * Linux/Chromium 上 speechSynthesis.getVoices() 在页面刚加载时常常返回空数组，
 * 语音引擎异步就绪后通过 voiceschanged 事件通知，这里最多等待 2s。
 */
async function ensureTTSVoices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return [];
  const existing = window.speechSynthesis.getVoices();
  if (existing.length > 0) return existing;
  return await new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.speechSynthesis.removeEventListener('voiceschanged', onChanged);
      clearTimeout(timer);
      resolve(window.speechSynthesis.getVoices());
    };
    const onChanged = (): void => {
      if (window.speechSynthesis.getVoices().length > 0) finish();
    };
    window.speechSynthesis.addEventListener('voiceschanged', onChanged);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * 选择本次朗读使用的语音
 * 优先级：用户指定语音 → 中文语音 → 本地语音 → 任意可用语音；无语音返回 null
 */
function pickTTSVoice(): SpeechSynthesisVoice | null {
  if (!window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  if (settings.ttsVoice) {
    const selected = voices.find((v) => v.voiceURI === settings.ttsVoice);
    if (selected) return selected;
  }
  return (
    voices.find((v) => /^(zh|cmn|Chinese)/i.test(v.lang)) ?? voices.find((v) => v.localService) ?? voices[0] ?? null
  );
}

/** 按设置配置 utterance 的语速/音调/语音；语音 lang 跟随实际引擎，避免有引擎无中文语音时直接报错 */
function configureUtterance(u: SpeechSynthesisUtterance): void {
  u.rate = settings.ttsRate;
  u.pitch = settings.ttsPitch;
  const voice = pickTTSVoice();
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else {
    u.lang = 'zh-CN';
  }
}

/** 启动 TTS 看门狗：发现引擎静默挂起（既不在朗读也不在队列）时重说当前段落 */
function startTTSWatchdog(): void {
  stopTTSWatchdog();
  ttsWatchdogTimer = setInterval(() => {
    const synth = window.speechSynthesis;
    if (!synth || !ttsPlaying.value || ttsPaused.value || synth.paused) return;
    if (!synth.speaking && !synth.pending) {
      const idx = ttsCurrentParagraph.value;
      if (idx >= 0 && idx < ttsParagraphs.value.length) {
        synth.cancel();
        speakParagraph(idx);
      }
    }
  }, 10000);
}

/** 停止 TTS 看门狗 */
function stopTTSWatchdog(): void {
  if (ttsWatchdogTimer !== null) {
    clearInterval(ttsWatchdogTimer);
    ttsWatchdogTimer = null;
  }
}

/** 获取当前可见段落文本列表用于 TTS
 *
 * 翻页模式：从 .page-display 获取当前页可见段落（排除 .measure-layer）
 * 滚动/章节模式：从 .scroll-view 获取从当前可见区域开始的段落
 */
function getTTSParagraphs(): string[] {
  // 修复：过滤掉纯图片标记段落（[IMG:...），只保留有意义的文字内容
  // 这样图文/漫画章节中 TTS 只读文字部分，不会尝试朗读图片标记
  const filterReadableText = (text: string): string => {
    const trimmed = text.trim();
    if (!trimmed) return '';
    // 过滤掉纯图片标记段落（如 [IMG:path]）
    if (/^\[IMG:.*\]$/.test(trimmed)) return '';
    // 移除段落中的图片标记，保留其他文字
    return trimmed.replace(/\[IMG:[^\]]*\]/g, '').trim();
  };

  // 翻页模式：当前页所有段落
  const pageDisplay = document.querySelector('.page-display');
  if (pageDisplay) {
    const paraEls = pageDisplay.querySelectorAll<HTMLElement>('.paragraph');
    const texts: string[] = [];
    paraEls.forEach((p) => {
      const text = filterReadableText(p.textContent ?? '');
      if (text) texts.push(text);
    });
    return texts;
  }

  // 滚动/章节模式：从当前可见区域的第一段开始
  const scrollEl = document.querySelector('.scroll-view');
  if (!scrollEl) return [];
  const container = scrollEl as HTMLElement;
  const containerRect = container.getBoundingClientRect();
  const paraEls = container.querySelectorAll<HTMLElement>('.paragraph');
  const texts: string[] = [];
  let foundVisible = false;

  for (let i = 0; i < paraEls.length; i++) {
    const p = paraEls[i];
    if (!foundVisible) {
      const rect = p.getBoundingClientRect();
      // 段落底部在容器视口内 → 这是第一个可见段落
      if (rect.bottom >= containerRect.top) {
        foundVisible = true;
      } else {
        continue; // 跳过视口上方的段落
      }
    }
    const text = filterReadableText(p.textContent ?? '');
    if (text) texts.push(text);
  }

  return texts;
}

/** 从选中文本所在段落开始 TTS 朗读 */
async function startTTSFromSelection(): Promise<void> {
  if (ttsPlaying.value) return;
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    message.warning(t('reader.tts.notSupported'));
    return;
  }

  const selection = window.getSelection();
  if (!selection || !selection.anchorNode) {
    message.warning(t('reader.tts.selectFirst'));
    return;
  }

  // 找到选中文本所在的段落元素
  let node: Node | null = selection.anchorNode;
  let paragraphEl: HTMLElement | null = null;
  while (node && node !== document.body) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.classList?.contains('paragraph')) {
        paragraphEl = el;
        break;
      }
    }
    node = node.parentNode;
  }

  if (!paragraphEl) {
    // 没找到段落元素，退回普通 startTTS
    await startTTS();
    return;
  }

  // 获取从选中段落开始的所有段落文本
  const container = paragraphEl.closest('.scroll-view, .page-display');
  if (!container) {
    await startTTS();
    return;
  }

  const allParaEls = container.querySelectorAll<HTMLElement>('.paragraph');
  const startIndex = Array.from(allParaEls).indexOf(paragraphEl);
  if (startIndex === -1) {
    await startTTS();
    return;
  }

  const texts: string[] = [];
  for (let i = startIndex; i < allParaEls.length; i++) {
    const text = (allParaEls[i].textContent ?? '').trim();
    if (text) texts.push(text);
  }

  if (texts.length === 0) {
    message.warning(t('reader.tts.nothingToRead'));
    return;
  }

  // 预检系统语音引擎（Linux 无 speech-dispatcher/espeak-ng 时 voices 为空）
  const voices = await ensureTTSVoices();
  if (!isComponentActive) return;
  if (voices.length === 0) {
    message.error(t('reader.tts.noEngine'), { duration: 8000 });
    return;
  }

  window.speechSynthesis.cancel();
  ttsParagraphs.value = texts;
  ttsPlaying.value = true;
  ttsPaused.value = false;
  ttsCurrentParagraph.value = 0;
  ttsErrorCount = 0;
  startTTSWatchdog();
  // 从选中段落直接开始朗读正文（不朗读章节标题）
  ttsSpeakingTitle.value = false;
  speakParagraph(0);
}

/** 开始 TTS 朗读 */
async function startTTS(): Promise<void> {
  if (ttsPlaying.value) return;
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    message.warning(t('reader.tts.notSupported'));
    return;
  }
  // 先停止之前的朗读
  window.speechSynthesis.cancel();

  // 预检系统语音引擎：Linux 未安装 speech-dispatcher/espeak-ng 时 getVoices 为空，
  // 此时 speak() 会立刻 onerror，旧逻辑会瞬间"读完"所有段落并连环跳章
  const voices = await ensureTTSVoices();
  if (!isComponentActive) return;
  if (voices.length === 0) {
    message.error(t('reader.tts.noEngine'), { duration: 8000 });
    return;
  }

  ttsParagraphs.value = getTTSParagraphs();
  if (ttsParagraphs.value.length === 0) {
    message.warning(t('reader.tts.nothingToRead'));
    return;
  }

  ttsPlaying.value = true;
  ttsPaused.value = false;
  ttsCurrentParagraph.value = 0;
  ttsErrorCount = 0;
  startTTSWatchdog();
  // 先朗读章节标题，标题读完后再朗读正文
  speakChapterTitle();
}

/** 朗读章节标题，标题完毕后开始正文段落 */
function speakChapterTitle(): void {
  if (!window.speechSynthesis) return;
  const title = store.currentChapterTitle;
  if (!title) {
    // 没有标题，直接开始正文
    ttsSpeakingTitle.value = false;
    speakParagraph(0);
    return;
  }
  ttsSpeakingTitle.value = true;
  ttsUtterance = new SpeechSynthesisUtterance(title);
  configureUtterance(ttsUtterance);
  ttsUtterance.onend = () => {
    if (!isComponentActive) return;
    ttsSpeakingTitle.value = false;
    if (ttsPlaying.value && !ttsPaused.value) {
      speakParagraph(0);
    }
  };
  ttsUtterance.onerror = () => {
    if (!isComponentActive) return;
    // 标题朗读失败不阻断，直接进入正文（正文第一段的错误熔断会兜底引擎不可用）
    ttsSpeakingTitle.value = false;
    if (ttsPlaying.value && !ttsPaused.value) {
      speakParagraph(0);
    }
  };
  window.speechSynthesis.speak(ttsUtterance);
}

/** 朗读指定段落 */
function speakParagraph(idx: number): void {
  if (!window.speechSynthesis) return;
  if (idx < 0 || idx >= ttsParagraphs.value.length) {
    // 所有段落已读完，尝试自动朗读下一章
    void handleTTSChapterEnd().catch((e) => console.error('handleTTSChapterEnd 失败:', e));
    return;
  }
  ttsCurrentParagraph.value = idx;
  ttsUtterance = new SpeechSynthesisUtterance(ttsParagraphs.value[idx]);
  configureUtterance(ttsUtterance);
  ttsUtterance.onend = () => {
    if (!isComponentActive) return;
    // 本段朗读成功，重置连续错误计数
    ttsErrorCount = 0;
    // 自动朗读下一段
    if (ttsPlaying.value && !ttsPaused.value) {
      speakParagraph(idx + 1);
    }
  };
  ttsUtterance.onerror = (e) => {
    if (!isComponentActive) return;
    const errType = e.error ?? '';
    console.warn('[TTS] 朗读错误:', errType || e);
    if (!ttsPlaying.value || ttsPaused.value) return;
    // canceled/interrupted：被新的 speak/cancel 抢占（暂停后恢复、自动切章等），
    // 属于正常流程而非引擎故障：不推进段落、不计入错误、不熔断
    if (errType === 'canceled' || errType === 'interrupted') return;
    ttsErrorCount++;
    // 第一段就失败，或连续多次失败：判定语音引擎不可用，立即停止并提示。
    // 否则 Linux 无引擎时每段瞬间 onerror → 全部段落秒过 → 自动连环跳章
    if (idx === 0 || ttsErrorCount >= 3) {
      stopTTS();
      message.error(t('reader.tts.engineError'), { duration: 6000 });
      return;
    }
    // 偶发错误（如单段文本不支持）跳过本段继续
    speakParagraph(idx + 1);
  };
  window.speechSynthesis.speak(ttsUtterance);
}

/** TTS 当前章节段落读完后的处理：自动续读下一章或停止
 *
 * @param emptySkips 已连续跳过的"无可读内容"章节数（防止异常章节导致无限连环跳章）
 */
async function handleTTSChapterEnd(emptySkips = 0): Promise<void> {
  if (!ttsPlaying.value || ttsPaused.value) {
    stopTTS();
    return;
  }
  // 连续空章上限：漫画书/异常章节末尾可能整本书后半都没有文字，不能无限跳
  const MAX_EMPTY_SKIPS = 20;
  // 检查是否有下一章
  if (store.hasNextChapter) {
    ttsAutoAdvancing = true;
    try {
      await store.nextChapter();
      await nextTick();
      // 修复：等待组件就绪后再获取段落，确保图文/漫画章节切换后 DOM 已更新
      await waitForComponentReady();
      // 重新获取段落列表
      ttsParagraphs.value = getTTSParagraphs();
      ttsCurrentParagraph.value = 0;
      if (ttsParagraphs.value.length === 0) {
        // 下一章没有可朗读内容时跳过到再下一章，但连续跳过超过上限则停止，避免连环跳章
        if (store.hasNextChapter && emptySkips < MAX_EMPTY_SKIPS) {
          console.log('[TTS] 下一章无文字内容，尝试跳过到再下一章');
          await handleTTSChapterEnd(emptySkips + 1);
          return;
        }
        stopTTS();
        message.info(t('reader.tts.reachedLastChapter'));
        return;
      }
      // 先朗读下一章标题，再朗读正文
      speakChapterTitle();
    } catch (err) {
      // 修复：添加错误处理，避免 nextChapter 失败时 TTS 状态卡死
      console.error('[TTS] 自动续读下一章失败:', err);
      stopTTS();
      message.error(t('reader.tts.advanceFailed'));
    } finally {
      // 无论 nextChapter 是否抛异常，都必须重置 ttsAutoAdvancing，
      // 否则 watch(currentChapterIndex) 将永远无法停止 TTS，标志位永久卡死
      ttsAutoAdvancing = false;
    }
  } else {
    stopTTS();
    message.info(t('reader.tts.finishedLastChapter'));
  }
}

/** 暂停 TTS */
function pauseTTS(): void {
  if (!window.speechSynthesis || !ttsPlaying.value) return;
  window.speechSynthesis.pause();
  ttsPaused.value = true;
}

/** 继续 TTS */
function resumeTTS(): void {
  if (!window.speechSynthesis || !ttsPlaying.value || !ttsPaused.value) return;
  // 修复：先确保 speechSynthesis 状态正确，再恢复
  // 某些浏览器实现中 pause/resume 不稳定，使用 cancel + 重新朗读当前段落作为兜底
  try {
    window.speechSynthesis.resume();
    ttsPaused.value = false;
  } catch (err) {
    console.warn('[TTS] resume 失败，尝试重新朗读当前段落:', err);
    // 兜底：取消并重新朗读当前段落
    window.speechSynthesis.cancel();
    ttsPaused.value = false;
    if (ttsCurrentParagraph.value >= 0 && ttsCurrentParagraph.value < ttsParagraphs.value.length) {
      speakParagraph(ttsCurrentParagraph.value);
    }
  }
}

/** 停止 TTS */
function stopTTS(): void {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  // 清除 utterance 回调，防止组件卸载后回调触发访问已卸载的 ref
  if (ttsUtterance) {
    ttsUtterance.onend = null;
    ttsUtterance.onerror = null;
  }
  ttsPlaying.value = false;
  ttsPaused.value = false;
  ttsCurrentParagraph.value = -1;
  ttsParagraphs.value = [];
  ttsUtterance = null;
  ttsAutoAdvancing = false;
  ttsSpeakingTitle.value = false;
  ttsErrorCount = 0;
  stopTTSWatchdog();
}

/** TTS 按钮点击处理 */
function handleTTSButtonClick(): void {
  if (ttsPlaying.value && !ttsPaused.value) {
    pauseTTS();
  } else if (ttsPlaying.value && ttsPaused.value) {
    resumeTTS();
  } else {
    void startTTS().catch((e) => console.error('startTTS 失败:', e));
  }
}

/** 切换章节时停止 TTS（但 TTS 自动续读下一章时不停止） */
/* ==================== A4修复：目录小节书签页内定位 ==================== */

/**
 * 目录跳转的页内偏移（0~1，null=无定位请求）。
 * ChapterBar 点击时通过 chapter-locate 事件上报（pdf-parser 把 outline dest top
 * 归一化编码进章节 url "@ratio" 尾缀），currentChapterIndex 变化（新章图片已
 * 就绪，loadChapter 内先加载后设索引）后消费——图片滚动模式滚动到首页内偏移，
 * 点击小节书签直达小节实际位置而非仅章首。
 */
let pendingChapterLocate: number | null = null;

/** ChapterBar 目录点击回调：记录页内偏移（0=章顶为默认行为，无需定位） */
function onChapterLocate(ratio: number): void {
  pendingChapterLocate = ratio > 0 ? ratio : null;
  // v54：目录点击跳章 = 手动语义——若在途自动拼接（1.5 屏已触发未返回），
  // 强制组件 watch 走重置分支（清空拼接、回新章顶部），避免误追加
  if (isImageReader.value && comicMode.value === 'scroll') {
    comicViewerRef.value?.markManualJump();
  }
}

watch(
  () => store.currentChapterIndex,
  () => {
    // v54：滚动跨界引起的章变化（视口跨过章边界）非用户切章——跳过停 TTS/
    // 停自动滚动/目录定位消费，否则自动滚动+无限拼接每跨一章就被打断
    if (store.consumeViewportChapterSync()) return;
    if (ttsPlaying.value && !ttsAutoAdvancing) {
      stopTTS();
    }
    // P1-14修复：TTS 自动续读下一章（ttsAutoAdvancing=true）时不应停止自动滚动，
    // 仅在用户手动切章时才停止。否则 TTS 续读会打断用户的自动滚动阅读体验。
    if (!ttsAutoAdvancing) {
      autoScrollEnabled.value = false;
    }
    // A4修复：目录跳转页内定位（仅图片滚动模式；翻页/文字模式留章首——
    // 页内偏移对整页翻页无意义，文字模式无页概念）
    if (pendingChapterLocate !== null && isImageReader.value && comicMode.value === 'scroll') {
      const ratio = pendingChapterLocate;
      pendingChapterLocate = null;
      void (async () => {
        await nextTick();
        // 延迟执行：让 ComicScrollMode 的 watch(images) 重置分支（跳章回顶）先完成
        setTimeout(() => comicViewerRef.value?.scrollToAnchor(ratio), 150);
      })();
    } else {
      pendingChapterLocate = null;
    }
  }
);

/* ==================== 自动滚动 ==================== */

/** 自动滚动是否启用 */
const autoScrollEnabled = ref<boolean>(false);

/** 切换自动滚动 */
function toggleAutoScroll(): void {
  autoScrollEnabled.value = !autoScrollEnabled.value;
  if (!autoScrollEnabled.value) {
    stopAutoScroll();
  }
}

/** 停止自动滚动 */
function stopAutoScroll(): void {
  autoScrollEnabled.value = false;
}

/** 自动滚动速度调节 */
async function changeAutoScrollSpeed(value: number): Promise<void> {
  await settings.setAutoScrollSpeed(value);
}

/* ==================== 跳转到书签 ==================== */

/** v54：图片滚动模式手动跳章前置（书签/搜索/进度条跳章路径）：
 *  若此前 1.5 屏触发过自动拼接（isAppendingNextChapter=true 但加载未返回），
 *  跳章的 loadChapter 结果会被 watch 误判为追加——markManualJump 强制走重置分支 */
function markComicManualJumpIfScroll(): void {
  if (isImageReader.value && comicMode.value === 'scroll') {
    comicViewerRef.value?.markManualJump();
  }
}

async function jumpToBookmark(bm: Bookmark): Promise<void> {
  if (!store.book) return;
  const position = bm.position ?? 0;
  if (bm.chapter_index !== store.currentChapterIndex) {
    // 提前设置位置恢复标志，防止 loadChapter 触发 watch 的 scrollToTop 覆盖位置恢复
    if (position > 0 && isScrollReader.value) {
      scrollViewRef.value?.prepareRestore();
    }
    // v54：图片滚动模式跳章 = 手动语义（清空拼接、回新章顶部）
    markComicManualJumpIfScroll();
    await store.loadChapter(bm.chapter_index);
  }
  // 等待新视图组件挂载就绪
  await waitForComponentReady();
  await readerGoToPosition(position);
  await store.saveProgressImmediate(position);
  showBookmarkDrawer.value = false;
}

/**
 * 处理全文搜索结果的跳转事件
 *
 * SearchPanel emit('jump-to', { chapterIndex, position }) 时触发。
 * 行为与 jumpToBookmark 一致：切换到目标章节并滚动到归一化位置（0~1）。
 *
 * @param payload 搜索跳转参数：chapterIndex 目标章节序号；position 归一化位置（0~1）
 */
async function handleSearchJumpTo(payload: { chapterIndex: number; position: number }): Promise<void> {
  if (!store.book) return;
  const position = payload.position ?? 0;
  if (payload.chapterIndex !== store.currentChapterIndex) {
    // 提前设置位置恢复标志，防止 loadChapter 触发 watch 的 scrollToTop 覆盖位置恢复
    if (position > 0 && isScrollReader.value) {
      scrollViewRef.value?.prepareRestore();
    }
    // v54：图片滚动模式跳章 = 手动语义（清空拼接、回新章顶部）
    markComicManualJumpIfScroll();
    await store.loadChapter(payload.chapterIndex);
  }
  // 等待新视图组件挂载就绪
  await waitForComponentReady();
  await readerGoToPosition(position);
  await store.saveProgressImmediate(position);
  showSearchPanel.value = false;
}

/* ==================== 路由跳转 ==================== */

/**
 * 等待视图组件挂载就绪：nextTick + requestAnimationFrame 双重保证
 *
 * 章节切换时 readMode 可能变化，导致 v-if 切换视图组件（ScrollView ↔ PageView）。
 * 仅 await nextTick() 不足以保证新组件的 ref 已绑定且 onMounted 已执行：
 * - nextTick 等待一次微任务队列清空（DOM patch 完成）
 * - requestAnimationFrame 等待下一次浏览器重绘前（确保 onMounted 钩子已执行）
 *
 * 此函数统一封装这一等待时序，供 prevChapter/nextChapter/jumpToBookmark/initReader 复用。
 */
async function waitForComponentReady(): Promise<void> {
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * 从当前视图组件获取位置并保存进度（退出前调用，确保保存的是真实位置而非 debounce 旧值）。
 *
 * 根因③（position=0 无保护）：所有 ref 分支都未命中时（组件切换过渡态），
 * 原 `let position = 0` 初值会无条件把 0 写进 DB 覆盖正确进度——改为 null
 * 初值 + 条件保存：无有效位置时保持 DB 既有值。
 * 根因⑤联动：全文渐进拼接未完成时 ScrollView.getCurrentPosition 返回 null，
 * 同样跳过保存（分母失真时不写错误值）。
 */
async function flushCurrentProgress(): Promise<void> {
  if (!store.book) return;
  let position: number | null = null;
  /** chapter_offset 双模式语义：图片型=视口章页码（根因④），文本型=章内字符偏移（任务25） */
  let chapterOffset = 0;
  // v54：图片型优先（原实现遗漏 comicViewerRef 分支，图片模式落到 store 缓存
  // 兜底——debounce 未落库时丢失最新位置）。getCurrentPosition 返回视口所在章
  // 的章内归一位置（滚动=章内进度，翻页=页码归一），与 currentChapterIndex
  // （视口章）配对写入 DB。
  if (isImageReader.value && comicViewerRef.value) {
    position = comicViewerRef.value.getCurrentPosition();
    chapterOffset = comicViewerRef.value.getViewportChapterLocalPage();
  } else if (store.readMode === 'page' && pageViewRef.value) {
    position = pageViewRef.value.getCurrentPosition();
    // 任务25：文本翻页模式锚点同步为字符偏移（PageView 坐标系已是段落级锚点，
    // 字符偏移提供跨模式统一的恢复入口）
    chapterOffset = store.liveChapterCharOffset;
  } else if (scrollViewRef.value) {
    position = scrollViewRef.value.getCurrentPosition();
    // 任务25：文本滚动模式——字符偏移内容锚点（ScrollView.getCurrentPosition
    // 内已同步 liveChapterCharOffset，免疫排版变化）
    chapterOffset = store.liveChapterCharOffset;
  } else {
    // 子组件已卸载（Vue 卸载顺序：子→父），使用 store 中缓存的实时位置作为 fallback
    // 用 ?? 而非 ||：0 是合法的滚动位置（章节开头），不应被当 falsy 跳过
    position = store.liveScrollPosition ?? store.lastScrollPosition;
    chapterOffset = isImageReader.value ? store.liveChapterOffset : store.liveChapterCharOffset;
  }
  // 根因③：无有效位置（过渡态/拼接中）时不保存，保持 DB 既有进度
  if (position !== null) {
    await store.saveProgressImmediate(position, chapterOffset);
  }
}

async function backToBookshelf(): Promise<void> {
  await flushCurrentProgress();
  await store.cleanup();
  store.reset();
  router.push('/');
}

/* ==================== 章节加载与进度恢复 ==================== */

let initCanceled = false;

/** 章节切换重入保护：防止快速点击下一章/上一章多次触发 loadChapter 导致 seq 竞争 */
const isSwitchingChapter = ref(false);

async function initReader(): Promise<void> {
  initCanceled = false;
  if (Number.isNaN(bookId.value) || bookId.value <= 0) {
    message.error(t('reader.invalidBookId'));
    void backToBookshelf().catch((e) => console.error('backToBookshelf 失败:', e));
    return;
  }

  const queryChapter = route.query.chapter ? parseInt(String(route.query.chapter), 10) : undefined;
  const queryShowCatalog = route.query.showCatalog === '1';

  await settings.loadSettings();
  if (initCanceled) return;

  await store.loadPreferences();
  if (initCanceled) return;

  await store.loadBook(bookId.value);
  if (initCanceled) return;
  if (store.errorMsg) {
    message.error(store.errorMsg);
    return;
  }
  if (store.chapters.length === 0) {
    message.warning(t('reader.noChapters'));
    router.push('/');
    return;
  }

  let targetIndex: number;
  let scrollPosition = 0;
  /** 根因④：持久化的章内偏移（图片型=视口章页码 1-based；文字型/旧数据=0） */
  let chapterOffset = 0;
  if (queryChapter !== undefined && queryChapter >= 0 && queryChapter < store.chapters.length) {
    targetIndex = queryChapter;
  } else {
    const progress = await store.loadProgress();
    if (initCanceled) return;
    targetIndex =
      progress && progress.chapterIndex >= 0 && progress.chapterIndex < store.chapters.length
        ? progress.chapterIndex
        : 0;
    scrollPosition = progress?.scrollPosition ?? 0;
    chapterOffset = progress?.chapterOffset ?? 0;
  }

  // 提前设置位置恢复标志（仅文本滚动模式需要），防止 loadChapter 触发 watch 的 scrollToTop 覆盖位置恢复
  if ((scrollPosition > 0 || chapterOffset > 0) && isScrollReader.value) {
    scrollViewRef.value?.prepareRestore();
  }
  await store.loadChapter(targetIndex);
  if (initCanceled) return;

  if (scrollPosition > 0 || chapterOffset > 0) {
    // 等待视图组件挂载就绪：v-if 切换后新组件的 ref 绑定和 onMounted 需要额外一帧才能完成
    await waitForComponentReady();
    if (initCanceled) return;
    // 根因④（F-1 分母漂移）：图片模式优先用持久化的章内绝对页码恢复——
    // 重进时首批渲染页数与退出时全章页数不一致（首批 5 页/全章 30 页），
    // 归一换算 goToPosition 会漂移（第 5 页 → 第 2 页）；页码定位精确且
    // pending 占位页由组件续载机制补齐。clamp 到当章页数防御异常数据。
    if (isImageReader.value && chapterOffset > 0 && comicViewerRef.value) {
      const total = store.comicImages.length;
      if (total > 0) {
        const page = clampChapterOffset(chapterOffset, total);
        comicViewerRef.value.goToChapterPage(page);
        // 恢复后立即按 clamp 后的页码落库（幂等），防 debounce 窗口内位置回退
        await store.saveProgressImmediate(scrollPosition, page);
      } else {
        await readerGoToPosition(scrollPosition);
      }
    } else {
      // 任务25：文本模式优先用章内字符偏移锚点恢复——比例锚点保得住比例、
      // 保不住内容（字号 18→26 后视口首段完全变化）；字符偏移永远指向同一处
      // 文字。锚点不可用（=0 旧数据/markdown）→ 回退比例路径（向后兼容）
      const anchored = resolvePositionByCharOffset(chapterOffset);
      // 任务27：position + 原始 charOffset 一起传——ScrollView 内部反推段内
      // 比例恢复到保存时的真实段内位置（不在 Reader 侧重复计算）
      await readerGoToPosition(anchored ?? scrollPosition, anchored !== null ? chapterOffset : undefined);
    }
  }

  void bookmarkStore.loadBookmarks(bookId.value).catch((e) => console.error('bookmarkStore.loadBookmarks 失败:', e));

  initialized.value = true;
  store.setShowToolbar(true);

  if (queryShowCatalog) {
    store.showChapterBar = true;
  }
}

/* ==================== 快捷键 ==================== */

/**
 * 阅读器快捷键：完全基于设置页的 settings.keyboardShortcuts 配置匹配。
 * 用户在设置页修改/清空快捷键后即时生效；空串表示该动作禁用。
 * 组合格式（Ctrl+ArrowRight 等）与设置页捕获逻辑保持一致。
 */
async function handleKeydown(event: KeyboardEvent): Promise<void> {
  try {
    const target = event.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    // P1-1（导航审计 #1）：灯箱打开时阅读器快捷键全部旁路——灯箱（图片模式
    // ComicLightbox / 文本插图 lightbox）是 Teleport 独立层的最高层 UI，Escape
    // 只关灯箱（由灯箱自身监听处理）。两个 window keydown listener 会先后收到
    // 同一 Escape，preventDefault 拦不住后者：不守卫则"按 Esc 关大图"会同时
    // 触发下方"逐级关闭"链路直至 backToBookshelf 退出阅读器。
    // 灯箱侧另有 stopImmediatePropagation 兜底（防注册顺序变化），此处为主守卫。
    if (overlayLightboxOpen.value) {
      return;
    }

    // #18 尾部：按钮点击后焦点残留——聚焦按钮上按 Space 的默认行为是"激活
    // 该按钮"（如刚点过翻章按钮，空格会再次翻章）。吞掉 Space（不激活、也
    // 不触发阅读器快捷键），点击其它区域/Tab 移焦后恢复。
    if (target && target.tagName === 'BUTTON' && event.key === ' ') {
      event.preventDefault();
      return;
    }

    const shortcuts = settings.keyboardShortcuts;
    const match = (combo: string): boolean => matchKeyboardShortcut(event, combo);

    // 关闭/退出：保留逐级关闭语义（弹层 → 目录 → 全屏 → 返回书架）
    if (match(shortcuts.closeReader)) {
      event.preventDefault();
      if (noteModalShow.value) {
        noteModalShow.value = false;
        return;
      }
      if (showSettings.value) {
        showSettings.value = false;
        return;
      }
      if (showBookmarkDrawer.value) {
        showBookmarkDrawer.value = false;
        return;
      }
      if (showSearchPanel.value) {
        showSearchPanel.value = false;
        return;
      }
      if (store.showChapterBar) {
        store.showChapterBar = false;
        return;
      }
      // 全屏模式下退出键先退出全屏（而非返回书架）
      if (store.isFullscreen) {
        store.setFullscreen(false);
        return;
      }
      await backToBookshelf();
      return;
    }

    // 功能开关类
    if (match(shortcuts.toggleFullscreen)) {
      event.preventDefault();
      store.toggleFullscreen();
      return;
    }
    if (match(shortcuts.toggleBookmark)) {
      event.preventDefault();
      await addBookmarkAtCurrentPosition();
      return;
    }
    if (match(shortcuts.toggleSearch) && !isImageReader.value) {
      event.preventDefault();
      showSearchPanel.value = true;
      return;
    }
    if (match(shortcuts.toggleTTS) && !isImageReader.value) {
      event.preventDefault();
      handleTTSButtonClick();
      return;
    }

    // 固定排版快捷键（不在自定义范围内）：Ctrl/Cmd + , 打开设置、=/- 调整字号
    if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault();
      showSettings.value = true;
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === '=' || event.key === '+')) {
      event.preventDefault();
      await store.increaseFontSize();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === '-') {
      event.preventDefault();
      await store.decreaseFontSize();
      return;
    }

    // 阅读导航（统一）：章节键切章，翻页键按当前阅读器类型前进/后退
    // - 图片型（漫画/PDF图文）→ ComicViewer 上一张/下一张
    // - 文本翻页模式 → PageView 上一页/下一页
    // - 文本滚动模式 → ScrollView 上一屏/下一屏
    // - v58：图片型"按章"模式下翻页键升级为章级导航（用户定稿：按章模式的
    //   左右键/上下章语义对齐——章末转场卡停住、左右键即上一章/下一章；
    //   翻页模式才保留页级，滚动模式保持滚屏）
    if (match(shortcuts.prevChapter)) {
      event.preventDefault();
      await prevChapter();
      return;
    }
    if (match(shortcuts.nextChapter)) {
      event.preventDefault();
      await nextChapter();
      return;
    }
    // v59 用户定稿（左右键语义按模式自适应）：
    //   翻页模式（文本 page / 图片 page）→ ←/→ 翻页（页级）
    //   其余模式（chapter / scroll / all，文本+图片统一）→ ←/→ 切章（方向键默认切章）
    //   章内滚动/翻屏由滚轮/进度条/自定义键（如 Space）承担
    // （v58 仅图片 chapter 模式切章——文本 chapter/scroll 与图片 scroll 仍滚屏，
    //   与"左右键应该默认切章，还有根据模式"的用户定稿不符，v59 改为模式维度判断）
    if (match(shortcuts.prevPage)) {
      event.preventDefault();
      if (isPagedReader.value) {
        await readerPrevPage();
      } else {
        await prevChapter();
      }
      return;
    }
    if (match(shortcuts.nextPage)) {
      event.preventDefault();
      if (isPagedReader.value) {
        await readerNextPage();
      } else {
        await nextChapter();
      }
      return;
    }
  } catch (err) {
    console.error('[Reader] 快捷键处理失败:', err);
  }
}

/* ==================== 阅读模式切换 ==================== */

// 修复：图文/漫画多图时隐藏"全部加载"模式，避免一次性加载所有图片导致性能问题
// 判断依据：当前章节图片数量超过阈值（5张）或书籍为漫画/图文类型
const ALL_MODE_IMAGE_THRESHOLD = 5;
const isImageHeavyContent = computed<boolean>(() => {
  // 漫画书籍始终视为多图内容
  if (store.isComic) return true;
  // 当前章节图片数量超过阈值
  if (store.comicImages.length > ALL_MODE_IMAGE_THRESHOLD) return true;
  // 书籍 content_type 为 illustrated（图文）或 comic（漫画）
  const contentType = store.book?.content_type;
  if (contentType === 'illustrated' || contentType === 'comic') {
    // 图文书籍只有在当前章节确实有较多图片时才隐藏
    return store.comicImages.length > ALL_MODE_IMAGE_THRESHOLD;
  }
  return false;
});

const readModeOptions = computed<DropdownOption[]>(() => {
  // 图片型内容（漫画/PDF图文/扫描版）：按章 / 连续滚动 / 单页 三种模式（v55）。
  // "按章"与"连续滚动"共用 ComicViewer 滚动渲染（comicMode 均 'scroll'），组件内
  // 按 store.readMode 区分章末行为：chapter=章末转场卡停住（点击进下一章，安静
  // 阅读），scroll=跨章自动拼接衔接（v54）。"全部加载"对图片型是性能灾难，不显示。
  if (isImageReader.value) {
    return [
      { label: t('reader.readMode.chapter'), key: 'chapter', icon: renderIcon(ScrollText) },
      { label: t('reader.readMode.scroll'), key: 'scroll', icon: renderIcon(Layers) },
      { label: t('reader.readMode.page'), key: 'page', icon: renderIcon(Book) }
    ];
  }
  const options: DropdownOption[] = [
    { label: t('reader.readMode.chapter'), key: 'chapter', icon: renderIcon(ScrollText) },
    { label: t('reader.readMode.scroll'), key: 'scroll', icon: renderIcon(Layers) },
    { label: t('reader.readMode.page'), key: 'page', icon: renderIcon(Book) }
  ];
  // 修复：图文/漫画多图时不显示"全部加载"选项，避免性能问题
  if (!isImageHeavyContent.value) {
    options.push({ label: t('reader.readMode.all'), key: 'all', icon: renderIcon(Rows3) });
  }
  return options;
});

const readModeIcon = computed<Component>(() => {
  // 图片型：page=Book、chapter=ScrollText（按章）、scroll（含 all 等其余兜底）=Layers
  if (isImageReader.value) {
    if (store.readMode === 'page') return Book;
    if (store.readMode === 'chapter') return ScrollText;
    return Layers;
  }
  if (store.readMode === 'chapter') return ScrollText;
  if (store.readMode === 'scroll') return Layers;
  if (store.readMode === 'all') return Rows3;
  return Book;
});

const readModeLabel = computed<string>(() => {
  // 图片型：按章 / 连续滚动 / 单页 三态显示（v55 起图片型菜单含 chapter 项）
  if (isImageReader.value) {
    if (store.readMode === 'page') return t('reader.readMode.page');
    if (store.readMode === 'chapter') return t('reader.readMode.chapter');
    return t('reader.readMode.scroll');
  }
  if (store.readMode === 'chapter') return t('reader.readMode.chapter');
  if (store.readMode === 'scroll') return t('reader.readMode.scroll');
  if (store.readMode === 'all') return t('reader.readMode.all');
  return t('reader.readMode.page');
});

/** 下一个可切换的阅读模式：复用工具栏 readModeOptions 候选序列（已按图片型/多图内容过滤）求
 * 下一项循环——与工具栏口径严格一致，多图内容不会切进被过滤的 all 模式，
 * 图片型在 chapter/scroll/page 三模式间循环（v55） */
const nextReadMode = computed<ReadMode>(() => {
  const modes = readModeOptions.value.map((o) => String(o.key) as ReadMode);
  const curIdx = modes.indexOf(store.readMode);
  // 当前模式不在候选列表（异常态）时回落到第一项，否则循环取下一项
  return modes[(curIdx + 1) % modes.length] ?? modes[0];
});

/** 下一个阅读模式的显示名（右键菜单"切换为{mode}"文案用目标模式）：直接复用 readModeOptions 的 label */
const nextReadModeLabel = computed<string>(() => {
  const opt = readModeOptions.value.find((o) => String(o.key) === nextReadMode.value);
  return typeof opt?.label === 'string' ? opt.label : '';
});

async function handleReadModeSelect(key: string | number): Promise<void> {
  const mode = String(key) as ReadMode;
  if (mode === store.readMode) return;

  if (mode === 'page') {
    autoScrollEnabled.value = false;
  }
  const savedPosition = getCurrentPositionAndText().position;
  // 任务27：快照内容锚点（切换前 liveChapterCharOffset 总是最新值）——
  // 滚动类模式切换后恢复真实段内位置；落库同时携带防 chapter_offset 被清零
  const savedCharOffset = store.liveChapterCharOffset;
  // v55：记录切换前是否为图片滚动渲染（拼接列表可能存在多章）——须在
  // setReadMode 之前取值（切换后 page→chapter 的 comicMode 也变为 'scroll'）
  const wasImageScroll = isImageReader.value && comicMode.value === 'scroll';
  // A-1修复：markManualJump 必须在 setReadMode 之前调用——切 page 后 comicMode
  // 变为 'page'，ComicViewer.markManualJump 的 scroll 检查不再通过，须趁组件
  // 仍是滚动模式时置重置标志（防 loadChapter 返回时 isAppendingNextChapter
  // 挂起导致误追加）
  if (wasImageScroll && (mode === 'chapter' || mode === 'page')) {
    markComicManualJumpIfScroll();
  }
  await store.setReadMode(mode);
  // v55/A-1：滚动→按章或翻页：拼接列表重置为"视口章"单章——章节模式按章加载，
  // 若保留拼接则"下一章"预告卡会出现在拼接列表末尾而非当前章末尾，"章末停住"
  // 语义失效；page 模式下 store.comicImages 仍是最后拼接章的数据
  // （comicChapterIndex ≠ currentChapterIndex），翻页显示错章内容、进度/翻章
  // 全部错位。markManualJump 置重置标志 + loadChapter(视口章) 使 comicImages
  // 回到视口章单章数据；savedPosition 为切换前视口章的章内进度，时序在
  // loadChapter 之后，末尾 readerGoToPosition 恢复到同章同位置。
  // 反向（按章→滚动）无需处理：单章保留，接近章末时自动拼接自然生效；
  // page→chapter 由 v-if 切换组件重挂载，天然单章，跳过冗余 loadChapter。
  if (wasImageScroll && (mode === 'chapter' || mode === 'page')) {
    await store.loadChapter(store.currentChapterIndex);
  }
  // 任务27：落库同时携带锚点（防 chapter_offset 被覆盖为 0，切换后退出丢内容锚点）
  await store.saveProgressImmediate(savedPosition, savedCharOffset);
  // 等待新组件挂载完成：使用 waitForComponentReady 统一时序处理
  await waitForComponentReady();
  // 任务27：透传 charOffset（ScrollView 反推段内比例，恢复真实段内位置）
  await readerGoToPosition(savedPosition, savedCharOffset);
}

/* ==================== 章节导航 ==================== */

async function prevChapter(): Promise<void> {
  if (isSwitchingChapter.value) return;
  isSwitchingChapter.value = true;
  try {
    // 切换前保存当前章节的真实进度（避免丢失）
    // 必须 await：若不等待，flushCurrentProgress 的 DB 写入可能与下一章加载竞争，
    // 导致进度写入被覆盖或顺序错乱
    await flushCurrentProgress();
    // v48：手动跳章 → 图片滚动模式清空拼接、回到新章开头（区别于 85% 自动拼接的视口不动）
    if (isImageReader.value && comicMode.value === 'scroll') {
      comicViewerRef.value?.markManualJump();
    }
    await store.prevChapter();
    // 等待新视图组件挂载就绪：v-if 切换后新组件的 ref 绑定和 onMounted 需要额外一帧才能完成
    await waitForComponentReady();
    // 图片滚动模式已由 watch 重置分支 scrollTop=0；其余走统一跳顶
    if (!isImageReader.value || comicMode.value !== 'scroll') {
      await readerScrollToTop();
    }
  } finally {
    isSwitchingChapter.value = false;
  }
}

async function nextChapter(): Promise<void> {
  if (isSwitchingChapter.value) return;
  isSwitchingChapter.value = true;
  try {
    // 切换前保存当前章节的真实进度（避免丢失）
    // 必须 await：若不等待，flushCurrentProgress 的 DB 写入可能与下一章加载竞争，
    // 导致进度写入被覆盖或顺序错乱
    await flushCurrentProgress();
    // v48：手动跳章 → 图片滚动模式清空拼接、回到新章开头（区别于 85% 自动拼接的视口不动）
    if (isImageReader.value && comicMode.value === 'scroll') {
      comicViewerRef.value?.markManualJump();
    }
    await store.nextChapter();
    // 等待新视图组件挂载就绪：v-if 切换后新组件的 ref 绑定和 onMounted 需要额外一帧才能完成
    await waitForComponentReady();
    // 图片滚动模式已由 watch 重置分支 scrollTop=0；其余走统一跳顶
    if (!isImageReader.value || comicMode.value !== 'scroll') {
      await readerScrollToTop();
    }
  } finally {
    isSwitchingChapter.value = false;
  }
}

/* ==================== v54 图片模式跨章链路（滚动拼接 / 翻页衔接 / 进度按章） ==================== */

/** 图片模式自动拼接防重入标志（在途 loadChapter 未返回前忽略重复触发） */
let isAppendingComicChapter = false;

/** P1-2：图片模式前插拼接防重入标志（与 isAppendingComicChapter 互斥共用一把意图锁） */
let isPrependingComicChapter = false;

/**
 * ComicViewer 的 request-next-chapter 分发（v54 核心断点修复）：
 * - 滚动模式：**自动拼接**——不 markManualJump（组件 isAppendingNextChapter 保持，
 *   watch(props.images) 走追加分支，视口不动、新章图片拼接在下方）；防重入 +
 *   最后拼接章检查；loadChapter(comicLastSplicedIndex+1) 的首批 5 页快速返回，
 *   拼接后由 IntersectionObserver 续载（v53 机制，偏移=新章 lastChapterStartSlot）。
 *   原实现直接绑定 nextChapter() → 无条件 markManualJump → 追加分支永不生效，
 *   单章替换+回顶（用户"不是无限拼接"的根因）。
 *   P1-2：章号基准由 comicChapterIndex 改为 comicLastSplicedIndex——触顶前插
 *   上一章后数据源章（comicChapterIndex）前移至拼接首章，直接 +1 会请求已在
 *   拼接列表中的章（章号校验不过 → 误走重置分支清空拼接）。
 * - 翻页模式：保持手动跳章语义（末页 next → 切章回第 1 页），
 *   倒数 3 页时 ComicPageMode 已预取下一章首批（磁盘缓存热）。
 */
async function handleComicRequestNextChapter(): Promise<void> {
  if (isImageReader.value && comicMode.value === 'scroll') {
    // v55：章节模式禁用自动拼接（组件侧已不 emit request-next-chapter，此处兜底防御）
    if (store.readMode === 'chapter') return;
    // 已是最后拼接章：无下一章可拼（组件末尾显示"已是最后一章"提示卡）。
    // A-5修复：必须清组件的 isAppendingNextChapter 标志——组件 emit 前已置位，
    // 此处早退无人消费该标志 → 永久挂起，此后无 mark 的重载（textConvert/
    // relocate 重试）被误判为追加（当前章内容重复拼接一遍）
    if (store.comicLastSplicedIndex >= store.chapters.length - 1) {
      comicViewerRef.value?.resetAppendIntent();
      return;
    }
    // 防重入：在途拼接未完成（或正被切章 loading 遮罩）时忽略重复触发
    // （组件侧另有 3 秒冷却锁，此处兜底快速滚动的边界）。
    // 注意不清 isAppendingNextChapter：在途拼接的 loadChapter 返回后组件
    // watch 需凭该标志走追加分支（清了会误走重置分支导致视口跳顶）；
    // P1-2：前插在途时同样忽略（触底/触顶交错触发防串扰）
    if (isAppendingComicChapter || isPrependingComicChapter || store.loading || isSwitchingChapter.value) {
      return;
    }
    isAppendingComicChapter = true;
    try {
      // A-3修复：拼接路径传 append —— 不推进 currentChapterIndex（保持视口章
      // 语义，等组件滚动跨界时 setViewportChapterIndex 同步），避免拼接返回
      // 与视口跨界之间的窗口期保存进度写成"新章+旧章位置"的错位记录
      await store.loadChapter(store.comicLastSplicedIndex + 1, { append: true });
    } finally {
      isAppendingComicChapter = false;
    }
    return;
  }
  // 翻页模式（或渲染方式切换中的过渡态）：手动跳章（含 markManualJump/进度 flush/回顶）
  await nextChapter();
}

/**
 * P1-2（导航审计 #2）：ComicScrollMode 滚动模式触顶 → 前插拼接上一章
 * （request-prepend-prev-chapter 分发）。与底部"上一章"按钮（prevChapter：
 * markManualJump 清拼接 + 单章替换 + 回新章顶部）语义不同：触顶是连续阅读
 * 的回看——loadChapter(target, { prepend: true }) 不动 currentChapterIndex/
 * 不重置滚动位置，组件 watch(props.images) 前置分支把新章插到拼接列表头部
 * 并按 scrollHeight 差值补偿 scrollTop（视口内容完全不动）。
 * 组件 emit 已保证目标章 = 拼接首章 - 1 且 > 0；此处再作边界防御。
 */
async function handleComicRequestPrependPrevChapter(targetChapterIndex: number): Promise<void> {
  // 仅图片滚动模式走此路径（ComicPageMode 的章首回翻走 request-prev-chapter
  // = 手动跳章语义，绑定不变）；章节模式触顶完全静止（组件侧不 emit，防御）
  if (!isImageReader.value || comicMode.value !== 'scroll') return;
  if (store.readMode === 'chapter') return;
  if (targetChapterIndex < 0 || targetChapterIndex >= store.chapters.length) {
    // 章边界防御早退：清组件前插意图（对称 A-5 resetAppendIntent，防挂起后被
    // 无 mark 的重载误判为前插）
    comicViewerRef.value?.resetPrependIntent();
    return;
  }
  // 防重入：在途前插/拼接未完成（或正被切章 loading 遮罩）时忽略重复触发。
  // 注意不清组件 isPrependingPrevChapter：在途前插的 loadChapter 返回后组件
  // watch 需凭该标志走前置分支（清了会误走重置分支导致视口跳顶）
  if (isPrependingComicChapter || isAppendingComicChapter || store.loading || isSwitchingChapter.value) {
    return;
  }
  isPrependingComicChapter = true;
  try {
    await store.loadChapter(targetChapterIndex, { prepend: true });
  } finally {
    isPrependingComicChapter = false;
  }
}

/**
 * 图片滚动模式章内进度上报（v54）：scroll-progress = 视口所在章的章内归一位置。
 * 对齐文字 ScrollView 行为：实时 live + debounce 落库。
 * 根因④（F-1 分母漂移）：同时上报视口章的章内页码（1-based）持久化到
 * chapter_offset——首批渲染页数与全章页数不一致时，归一位置恢复会漂移，
 * 绝对页码恢复精确且幂等。
 */
function handleComicScrollProgress(progress: number): void {
  store.setLiveScrollPosition(progress);
  store.scheduleProgressSave(progress, comicViewerRef.value?.getViewportChapterLocalPage());
}

/**
 * 图片翻页模式进度上报（v54）：页码 → 章内归一位置。
 * 滚动模式的进度已由 scroll-progress 覆盖（page-change 仅更新页码上下文）。
 * 根因④：页码（1-based，翻页模式无拼接即章内页码）随归一位置一并持久化到
 * chapter_offset，恢复链优先按页码定位。
 */
function handleComicPageChange(page: number): void {
  if (comicMode.value !== 'page') return;
  const total = store.comicImages.length;
  const position = total > 1 ? (page - 1) / (total - 1) : 0;
  store.setLiveScrollPosition(position);
  store.scheduleProgressSave(position, page);
}

/**
 * 图片滚动模式视口章同步（v54）：滚动跨界时组件上报绝对章索引，
 * 经 store.setViewportChapterIndex 更新 currentChapterIndex（带豁免标志，
 * watch(currentChapterIndex) 跳过"切章停 TTS/停自动滚动"），目录高亮/
 * 进度条/进度保存的章基准跟随视口。
 */
function handleComicCurrentChapterChange(chapterIndex: number): void {
  store.setViewportChapterIndex(chapterIndex);
}

/**
 * v55 章节模式末尾"下一章"转场卡点击：手动跳章语义（与底部"下一章"按钮完全
 * 一致——markManualJump 清空拼接、loadChapter 单章、回新章顶部、进度按章保存）。
 * 组件已保证仅非最后一章的预告卡可点击，此处再作章边界防御。
 */
function handleComicGoNextChapter(): void {
  if (!isImageReader.value || comicMode.value !== 'scroll') return;
  if (store.comicChapterIndex >= store.chapters.length - 1) return;
  void nextChapter().catch((e) => console.error('章节模式转场卡跳章失败:', e));
}

/* ==================== v57 缩略图（整合进目录抽屉"页"视图，入口唯一化） ==================== */

/** 目录抽屉打开时拉取当前章内页码（"页"视图高亮"当前页"基准） */
watch(
  () => store.showChapterBar,
  (open) => {
    if (open && isImageReader.value) {
      thumbCurrentPage.value = comicViewerRef.value?.getCurrentChapterLocalPage() ?? 1;
    }
  }
);

/**
 * 目录抽屉"页"视图跳页（当前数据源章的章内页码，1-based）。
 * 滚动拼接模式下由 ComicViewer 按章边界换算全局槽位后定位；
 * pending 灰块也可点击跳页——阅读区滚动到该页自然触发续载渲染。
 */
function handleThumbJumpToPage(page: number): void {
  comicViewerRef.value?.goToChapterPage(page);
  thumbCurrentPage.value = page;
}

/* ==================== 阅读时间估算（对标 Kindle） ==================== */

/**
 * 剩余阅读时间估算（分钟）
 *
 * 计算方式：
 * - 剩余字数 = chapterContent.length * (1 - progressPercent)
 * - 阅读速度 ≈ 500 字/分钟（中文平均阅读速度）
 * - 分钟 = Math.ceil(剩余字数 / 500)
 *
 * 仅在 chapterContent 有内容时有效，否则返回 null
 */
const remainingReadMinutes = computed<number | null>(() => {
  if (!store.chapterContent || store.chapterContent.length === 0) return null;
  // progressPercent 为 0~1 之间
  const remainingChars = store.chapterContent.length * (1 - store.progressPercent);
  if (remainingChars <= 0) return 0;
  return Math.ceil(remainingChars / 500);
});

/**
 * 剩余阅读时间格式化文本（对标 Kindle "还剩约 X 分钟"）
 *
 * - null：不显示
 * - < 1 分钟：还剩不到 1 分钟
 * - 1~60 分钟：还剩约 X 分钟
 * - > 60 分钟：还剩约 X 小时 Y 分钟
 */
const remainingReadTimeText = computed<string>(() => {
  const minutes = remainingReadMinutes.value;
  if (minutes === null) return '';
  if (minutes < 1) return t('reader.remainingTime.lessThanMinute');
  if (minutes <= 60) return t('reader.remainingTime.minutes', { minutes });
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0
    ? t('reader.remainingTime.hours', { hours })
    : t('reader.remainingTime.hoursMinutes', { hours, minutes: mins });
});

/* ==================== 底部进度条点击跳转章节 ==================== */

/**
 * 进度百分比取整（0~100），用于底部进度条展示。
 *
 * 提取为 computed 缓存：模板中原本有两处 `Math.round(store.progressPercent * 100)` 调用，
 * 每次渲染都会重复计算，改为 computed 后仅在 progressPercent 变化时重算一次。
 */
// v59：进度百分比保留 1 位小数（Math.round 会把 3/1153=0.26% 显示成 0%，
// 千章大书前期长期显示 0%，用户误以为进度失效；1 位小数下为 0.3%）
const progressPercentRounded = computed<number>(() => Math.round(store.progressPercent * 1000) / 10);

/**

 * 进度条容器引用（用于 getBoundingClientRect 计算点击位置）
 */
const progressWrapRef = ref<HTMLElement | null>(null);

/**
 * 点击进度条跳转到对应章节
 *
 * 计算方式：点击位置百分比 * totalChapters = 目标章节索引
 *
 * @param event 鼠标点击事件
 */
async function jumpToChapterByProgressClick(event: MouseEvent): Promise<void> {
  // 章节数量小于等于 1 时无需跳转
  if (store.totalChapters <= 1) return;
  // 容器引用不存在则跳过
  const wrap = progressWrapRef.value;
  if (!wrap) return;

  // 优先使用进度条元素（.progress-bar）计算，避免文字/百分比标签干扰
  const bar = wrap.querySelector<HTMLElement>('.progress-bar');
  if (!bar) return;

  // 计算点击位置相对于进度条的水平百分比
  const rect = bar.getBoundingClientRect();
  const clickX = event.clientX - rect.left;
  let percent = clickX / rect.width;
  // 边界保护：限制在 [0, 1] 区间
  percent = Math.max(0, Math.min(1, percent));

  // 目标章节索引 = 百分比 * 总章节数，向下取整
  // 例如 10 章，点击 50% → 第 5 章（索引 5）
  let targetIndex = Math.floor(percent * store.totalChapters);
  // 边界保护：最大为 totalChapters - 1
  if (targetIndex >= store.totalChapters) targetIndex = store.totalChapters - 1;
  if (targetIndex < 0) targetIndex = 0;

  // 已经在当前章节则不跳转
  if (targetIndex === store.currentChapterIndex) return;

  // 切换前保存当前章节进度（避免丢失）
  await flushCurrentProgress();
  // v54：图片滚动模式跳章 = 手动语义（清空拼接、回新章顶部）
  markComicManualJumpIfScroll();
  await store.loadChapter(targetIndex);
  // 等待新视图组件挂载就绪
  await waitForComponentReady();
  // 跳转到目标章节开头
  await readerScrollToTop();
}

/**
 * 进度条点击处理：仅在章节数 > 1 时跳转，否则忽略。
 *
 * 从模板内联条件表达式提取，避免每次渲染创建新函数并提升可读性。
 */
function handleProgressClick(event: MouseEvent): void {
  if (store.totalChapters > 1) {
    void jumpToChapterByProgressClick(event).catch((e) => console.error('jumpToChapterByProgressClick 失败:', e));
  }
}

/* ==================== 字号调节 ==================== */

async function decreaseFont(): Promise<void> {
  await store.decreaseFontSize();
}

async function increaseFont(): Promise<void> {
  await store.increaseFontSize();
}

/* ==================== 阅读设置面板 ==================== */

function showMoreSettings(): void {
  showSettings.value = true;
}

function toggleBookmarkDrawer(): void {
  showBookmarkDrawer.value = !showBookmarkDrawer.value;
}

/* ==================== 工具栏显示/隐藏 ==================== */

function toggleToolbar(): void {
  store.toggleToolbar();
}

/* ==================== 全屏/沉浸阅读模式 ==================== */

/** 全屏模式下临时显示工具栏的定时器 */
let fullscreenToolbarTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 全屏模式下鼠标边缘检测：
 * - 鼠标移动到顶部边缘（0-5px）临时显示工具栏（2秒后自动隐藏）
 * - 鼠标移动到底部边缘临时显示底部导航（2秒后自动隐藏）
 *
 * 工具栏和底部导航共用 showToolbar 状态，因此统一控制 showToolbar。
 */
function handleFullscreenMouseMove(e: MouseEvent): void {
  if (!store.isFullscreen) return;
  // 鼠标在顶部5px范围内 → 临时显示工具栏
  if (e.clientY <= 5) {
    store.showToolbar = true;
    // 2秒后自动隐藏
    if (fullscreenToolbarTimer) clearTimeout(fullscreenToolbarTimer);
    fullscreenToolbarTimer = setTimeout(() => {
      if (store.isFullscreen) store.showToolbar = false;
    }, 2000);
  }
  // 鼠标在底部5px范围内 → 临时显示底部导航
  if (e.clientY >= window.innerHeight - 5) {
    store.showToolbar = true;
    if (fullscreenToolbarTimer) clearTimeout(fullscreenToolbarTimer);
    fullscreenToolbarTimer = setTimeout(() => {
      if (store.isFullscreen) store.showToolbar = false;
    }, 2000);
  }
}

/**
 * 监听全屏状态变化：
 * - 进入全屏时自动隐藏工具栏和底部导航
 * - 退出全屏时恢复工具栏和底部导航显示
 */
watch(
  () => store.isFullscreen,
  (fullscreen: boolean) => {
    if (fullscreen) {
      // 进入全屏：隐藏工具栏和底部导航
      store.showToolbar = false;
    } else {
      // 退出全屏：恢复工具栏和底部导航显示
      store.showToolbar = true;
      // 清理临时显示定时器
      if (fullscreenToolbarTimer) {
        clearTimeout(fullscreenToolbarTimer);
        fullscreenToolbarTimer = null;
      }
    }
  }
);

/* ==================== 监听章节切换 ==================== */

// 章节切换的进度保存已由以下机制保证（无需 watcher）：
// 1. 翻页/滚动时 scheduleProgressSave debounce 保存
// 2. 章节切换前由 nextChapter/prevChapter/jumpToChapter 的调用方 flush 进度
// 3. 退出时 flushCurrentProgress 统一保存
// TTS 自动停止逻辑在上方 TTS 部分的 watch(currentChapterIndex) 中处理

// textConvert / smartFormat 变化时需重新加载当前章节以应用新的文本处理规则。
// 合并监听：两个回调完全相同，合并为数组 watch 避免重复 loadChapter 调用。
watch([() => settings.textConvert, () => settings.smartFormat], () => {
  if (initialized.value && store.book) {
    const savedPosition = store.liveScrollPosition ?? store.lastScrollPosition;
    // 任务25：快照内容锚点（变化前 liveChapterCharOffset 总是最新值）——
    // 文本处理后段落/段落长度可能变化，字符偏移仍是最近似的内容锚点，
    // 远优于比例锚点（排版/分段变化后比例指向不同内容）
    const savedCharOffset = store.liveChapterCharOffset;
    // 提前设置位置恢复标志（仅文本滚动模式需要），防止 loadChapter 触发 watch 的 scrollToTop 覆盖位置恢复
    if (savedPosition !== null && savedPosition > 0 && isScrollReader.value) {
      scrollViewRef.value?.prepareRestore();
    }
    void store
      .loadChapter(store.currentChapterIndex)
      .then(() => {
        if (savedPosition !== null && savedPosition > 0) {
          nextTick(() => {
            // 任务25：优先字符偏移锚点恢复（基于处理后的新文本反查），锚点不可用回退比例
            // 任务27：透传原始 charOffset 供 ScrollView 反推段内比例（真实段内位置）
            const anchored = resolvePositionByCharOffset(savedCharOffset);
            void readerGoToPosition(
              anchored ?? savedPosition,
              anchored !== null ? savedCharOffset : undefined
            );
          });
        }
      })
      .catch((e) => console.error('loadChapter 失败:', e));
  }
});

/**
 * 任务25：排版参数变化（字号/行距/段距/页宽/边距/字体族）→ 按字符偏移锚点
 * 恢复视口内容。实测问题：字号 18→26 后 scrollTop 不变、排版重排，视口首段
 * 完全变化（比例锚点保比例不保内容）。字符偏移锚点免疫排版变化（第 X 个
 * 字符永远是那个字）→ 恢复后视口内容保持一致（Kindle「位置号」同款行为）。
 *
 * debounce 200ms 覆盖设置面板滑块的连续拖动（拖动过程不逐帧跳视口）。
 * 仅文本滚动模式生效：图片模式 charOffset=0 自然跳过；文本翻页模式 PageView
 * 已是段落级锚点坐标系（分页重算后同段落定位，免疫排版），无需处理。
 */
let layoutRestoreTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [
    settings.fontSize,
    settings.lineHeight,
    settings.paragraphSpacing,
    settings.margin,
    settings.pageWidth,
    settings.fontFamily
  ],
  () => {
    if (!initialized.value || !store.book || !isScrollReader.value) return;
    if (layoutRestoreTimer) clearTimeout(layoutRestoreTimer);
    layoutRestoreTimer = setTimeout(() => {
      layoutRestoreTimer = null;
      // 排版重排完成后按内容锚点重新定位：恢复后视口首段与变化前一致，
      // 且段内位置也精确还原（任务27：传 liveChapterCharOffset 反推真实比例）
      const charOffset = store.liveChapterCharOffset;
      const anchored = resolvePositionByCharOffset(charOffset);
      if (anchored === null) return;
      void scrollViewRef.value
        ?.scrollToPosition(anchored, charOffset)
        .catch((e) => console.error('[Reader] 排版变化后内容锚点恢复失败:', e));
    }, 200);
  }
);

// 修复：当切换到多图章节时，如果当前是"全部加载"模式，自动降级到"无限拼接"模式，
// 避免一次性加载所有图片导致性能问题
watch(isImageHeavyContent, (heavy) => {
  if (heavy && store.readMode === 'all') {
    void store.setReadMode('scroll').catch((e) => console.error('store.setReadMode 失败:', e));
  }
});

/* ==================== 生命周期 ==================== */

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('mousemove', handleFullscreenMouseMove);
  void initReader().catch((e) => console.error('initReader 失败:', e));
});

onBeforeUnmount(() => {
  isComponentActive = false;
  initCanceled = true;
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('mousemove', handleFullscreenMouseMove);
  // 清理全屏临时显示工具栏定时器
  if (fullscreenToolbarTimer) {
    clearTimeout(fullscreenToolbarTimer);
    fullscreenToolbarTimer = null;
  }
  // 任务25：清理排版变化锚点恢复的 debounce 定时器（防卸载后回调访问失效 ref）
  if (layoutRestoreTimer) {
    clearTimeout(layoutRestoreTimer);
    layoutRestoreTimer = null;
  }
  stopTTS();
  stopAutoScroll();
  // Vue 不 await async 钩子；先 flush 进度再 reset，避免 reset 清空 store.book 导致进度丢失
  void flushCurrentProgress()
    .finally(() => {
      void store
        .cleanup()
        .finally(() => {
          store.reset();
          bookmarkStore.reset();
        })
        .catch((e) => console.error('cleanup 失败:', e));
    })
    .catch((e) => console.error('flushCurrentProgress 失败:', e));
});
</script>

<template>
  <div class="reader-view" :class="{ 'fullscreen-mode': store.isFullscreen }">
    <!-- 加载骨架屏（章节标题 + 段落灰条 + 呼吸动画）：模拟真实内容形态，不暴露加载实现细节 -->
    <div v-if="store.loading && !store.chapterContent" class="loading-state" role="status">
      <div class="skeleton" aria-hidden="true">
        <div class="skeleton-title"></div>
        <div class="skeleton-line skeleton-line-1"></div>
        <div class="skeleton-line skeleton-line-2"></div>
        <div class="skeleton-line skeleton-line-3"></div>
        <div class="skeleton-line skeleton-line-4"></div>
        <div class="skeleton-line skeleton-line-5"></div>
      </div>
      <span class="sr-only">{{ t('reader.loadingChapter') }}</span>
    </div>

    <!-- 错误提示（错误图标 + 错误文字 + 重试按钮 + 返回按钮） -->
    <div v-else-if="store.errorMsg && !store.chapterContent" class="error-state">
      <n-icon :component="AlertCircle" :size="48" class="error-icon" />
      <span class="error-text">{{ store.errorMsg }}</span>
      <div class="error-actions">
        <n-button type="primary" @click="initReader">
          <template #icon>
            <n-icon :component="RotateCw" :size="16" />
          </template>
          {{ t('common.actions.retry') }}
        </n-button>
        <n-button @click="backToBookshelf">{{ t('reader.actions.backToShelf') }}</n-button>
      </div>
    </div>

    <!-- 无章节内容提示 -->
    <div v-else-if="store.book && store.chapters.length === 0" class="error-state">
      <span class="error-text">{{ t('reader.noChapters') }}</span>
      <n-button type="primary" @click="backToBookshelf">{{ t('reader.actions.backToShelf') }}</n-button>
    </div>

    <!-- 正常阅读状态 -->
    <template v-else>
      <!-- 章节切换加载圈（内容区域中间） -->
      <div v-if="store.loading" class="chapter-loading-overlay" aria-hidden="true">
        <div class="chapter-loading-spinner"></div>
      </div>

      <!-- 工具栏恢复入口（工具栏隐藏时显示，鼠标移入或点击恢复） -->
      <div v-if="!store.showToolbar" class="toolbar-restore" @mouseenter="toggleToolbar" @click="toggleToolbar"></div>

      <!-- 顶部工具栏（可隐藏） -->
      <transition name="toolbar-slide">
        <div v-if="store.showToolbar" class="toolbar">
          <div class="toolbar-inner">
            <div class="toolbar-tools">
              <!-- 章节目录（图片型时抽屉内含"章节|页"双视图：缩略图整合入口，v57 入口唯一化） -->
              <n-tooltip trigger="hover">
                <template #default>{{ t('reader.toolbar.toc') }}</template>
                <template #trigger>
                  <n-button quaternary circle @click="store.toggleChapterBar">
                    <template #icon>
                      <n-icon :component="TableOfContents" :size="20" />
                    </template>
                  </n-button>
                </template>
              </n-tooltip>

              <!-- 阅读模式切换 -->
              <n-tooltip trigger="hover">
                <template #default>{{ readModeLabel }}</template>
                <template #trigger>
                  <n-dropdown trigger="click" :options="readModeOptions" @select="handleReadModeSelect">
                    <n-button quaternary circle>
                      <template #icon>
                        <n-icon :component="readModeIcon" :size="20" />
                      </template>
                    </n-button>
                  </n-dropdown>
                </template>
              </n-tooltip>

              <!-- 字号调节（文字内容专属，图片型无字号概念） -->
              <div v-if="!isImageReader" class="font-controls">
                <n-button quaternary circle size="tiny" @click="decreaseFont" :title="t('reader.toolbar.decreaseFont')">
                  <template #icon>
                    <n-icon :component="Minus" :size="16" />
                  </template>
                </n-button>
                <span class="font-size-label">{{ store.fontSize }}</span>
                <n-button quaternary circle size="tiny" @click="increaseFont" :title="t('reader.toolbar.increaseFont')">
                  <template #icon>
                    <n-icon :component="Plus" :size="16" />
                  </template>
                </n-button>
              </div>

              <!-- 全文搜索（文字内容专属，图片内容无可搜文本） -->
              <n-tooltip v-if="!isImageReader" trigger="hover">
                <template #default>{{ t('reader.toolbar.search') }}</template>
                <template #trigger>
                  <n-button quaternary circle @click="showSearchPanel = true">
                    <template #icon>
                      <n-icon :component="Search" :size="20" />
                    </template>
                  </n-button>
                </template>
              </n-tooltip>

              <!-- 添加书签 -->
              <n-tooltip trigger="hover">
                <template #default>{{ t('reader.toolbar.addBookmark') }}</template>
                <template #trigger>
                  <n-button quaternary circle @click="addBookmarkAtCurrentPosition">
                    <template #icon>
                      <n-icon :component="BookmarkCheck" :size="20" />
                    </template>
                  </n-button>
                </template>
              </n-tooltip>

              <!-- 书签笔记抽屉 -->
              <n-tooltip trigger="hover">
                <template #default>{{ t('reader.toolbar.bookmarkNote') }}</template>
                <template #trigger>
                  <n-button quaternary circle @click="toggleBookmarkDrawer">
                    <template #icon>
                      <n-icon :component="BookmarkIcon" :size="20" />
                    </template>
                  </n-button>
                </template>
              </n-tooltip>

              <!-- TTS 朗读（文字内容专属，图片内容无可朗读文本） -->
              <n-tooltip v-if="!isImageReader" trigger="hover">
                <template #default>{{
                  ttsPlaying ? (ttsPaused ? t('reader.tts.resume') : t('reader.tts.pause')) : t('reader.tts.start')
                }}</template>
                <template #trigger>
                  <n-button quaternary circle @click="handleTTSButtonClick">
                    <template #icon>
                      <n-icon :component="ttsPlaying && !ttsPaused ? Pause : Volume2" :size="20" />
                    </template>
                  </n-button>
                </template>
              </n-tooltip>

              <!-- 停止朗读按钮（仅在朗读中显示） -->
              <n-tooltip v-if="ttsPlaying" trigger="hover">
                <template #default>{{ t('reader.tts.stop') }}</template>
                <template #trigger>
                  <n-button quaternary circle @click="stopTTS">
                    <template #icon>
                      <n-icon :component="Square" :size="20" />
                    </template>
                  </n-button>
                </template>
              </n-tooltip>

              <!-- 自动滚动（仅在章节/无限拼接模式下显示） -->
              <n-tooltip v-if="store.readMode !== 'page'" trigger="hover">
                <template #default>{{
                  autoScrollEnabled ? t('reader.autoScroll.stop') : t('reader.autoScroll.start')
                }}</template>
                <template #trigger>
                  <n-button quaternary circle @click="toggleAutoScroll">
                    <template #icon>
                      <n-icon :component="Gauge" :size="20" />
                    </template>
                  </n-button>
                </template>
              </n-tooltip>

              <!-- 阅读设置 -->
              <n-tooltip trigger="hover">
                <template #default>{{ t('reader.toolbar.readSettings') }}</template>
                <template #trigger>
                  <n-button quaternary circle @click="showMoreSettings">
                    <template #icon>
                      <n-icon :component="Settings" :size="20" />
                    </template>
                  </n-button>
                </template>
              </n-tooltip>
            </div>

            <!-- 隐藏工具栏按钮 + 全屏按钮 -->
            <div class="toolbar-toggle">
              <!-- 全屏/沉浸阅读模式切换 -->
              <n-tooltip trigger="hover">
                <template #default>{{
                  store.isFullscreen ? t('reader.toolbar.exitFullscreen') : t('reader.toolbar.enterFullscreen')
                }}</template>
                <template #trigger>
                  <n-button quaternary circle @click="store.toggleFullscreen">
                    <template #icon>
                      <n-icon :component="store.isFullscreen ? Minimize : Maximize" :size="20" />
                    </template>
                  </n-button>
                </template>
              </n-tooltip>

              <n-tooltip trigger="hover">
                <template #default>{{ t('reader.toolbar.hideToolbar') }}</template>
                <template #trigger>
                  <n-button quaternary circle @click="toggleToolbar">
                    <template #icon>
                      <n-icon :component="EyeOff" :size="20" />
                    </template>
                  </n-button>
                </template>
              </n-tooltip>
            </div>
          </div>
        </div>
      </transition>

      <!-- C-6修复：link 书失效常驻警示条 —— RelocateDialog 取消后 fileMissing
           仍非空但 watch（值未变）不再触发，阅读区无重试入口；警示条常驻直至
           恢复成功（fileMissing 清空自动消失），点击重开重新定位对话框 -->
      <div
        v-if="store.fileMissing && !showRelocate"
        class="file-missing-banner"
        role="button"
        tabindex="0"
        @click="showRelocate = true"
        @keydown.enter.prevent="showRelocate = true"
      >
        <n-icon :component="AlertCircle" :size="16" class="file-missing-banner-icon" />
        <span>{{ t('reader.fileMissingBanner') }}</span>
      </div>

      <!-- 正文区 — 文本模式，flex:1 占据剩余空间 -->
      <div class="content-area text-content-wrapper">
        <!-- 图片型内容（漫画 + PDF 图文/扫描版）统一走 ComicViewer：一次一页/可视区懒加载 -->
        <!-- v54：request-next-chapter 分发到 handleComicRequestNextChapter（滚动=自动拼接、
             翻页=手动跳章）；scroll-progress/page-change/current-chapter-change 处理
             阅读进度按章记录（章内归一位置 + 视口章同步）
             v55：go-next-chapter 分发到 handleComicGoNextChapter（章节模式末尾
             "下一章"转场卡点击 → 手动跳章进下一章）
             P1-2：request-prepend-prev-chapter 分发到 handleComicRequestPrependPrevChapter
             （滚动模式触顶 → 前插拼接上一章，视口位置保持） -->
        <ComicViewer
          v-if="isImageReader"
          ref="comicViewerRef"
          class="content-area"
          :images="store.comicImages"
          :mode="comicMode"
          :auto-scroll="comicMode === 'scroll' && autoScrollEnabled"
          @request-next-chapter="handleComicRequestNextChapter"
          @go-next-chapter="handleComicGoNextChapter"
          @request-prev-chapter="prevChapter"
          @request-prepend-prev-chapter="handleComicRequestPrependPrevChapter"
          @scroll-progress="handleComicScrollProgress"
          @page-change="handleComicPageChange"
          @current-chapter-change="handleComicCurrentChapterChange"
          @toggle-toolbar="toggleToolbar"
          @contextmenu="handleContextMenu"
        />
        <ScrollView
          v-else-if="store.readMode === 'chapter'"
          ref="scrollViewRef"
          class="content-area"
          :infinite-scroll="false"
          :auto-scroll="autoScrollEnabled"
          @contextmenu="handleContextMenu"
        />
        <ScrollView
          v-else-if="store.readMode === 'scroll'"
          ref="scrollViewRef"
          class="content-area"
          :infinite-scroll="true"
          :auto-scroll="autoScrollEnabled"
          @contextmenu="handleContextMenu"
        />
        <ScrollView
          v-else-if="store.readMode === 'all'"
          ref="scrollViewRef"
          class="content-area"
          :infinite-scroll="false"
          :load-all="true"
          :auto-scroll="autoScrollEnabled"
          @contextmenu="handleContextMenu"
        />
        <!-- P2-6：中间区点击切换工具栏（与图片翻页模式分区对齐，复用 toggleToolbar 分发链路） -->
        <PageView
          v-else
          ref="pageViewRef"
          class="content-area"
          @contextmenu="handleContextMenu"
          @toggle-toolbar="toggleToolbar"
        />
      </div>

      <!-- 底部导航（可隐藏） -->
      <transition name="bottom-nav-slide">
        <div v-if="store.showToolbar" class="bottom-nav">
          <div class="bottom-inner">
            <!-- v48：应用户要求恢复上下章按钮（滚动模式自动拼接 + 按钮手动跳章并存）。
                 v58 文案修正：按钮行为本就是章级（prevChapter/nextChapter），原用
                 common.actions.previous/next（"上一页/下一页"）文案与行为错位——
                 用户在按章模式下看到"下一页"实为切章，语义混乱。改为章级文案。 -->
            <n-button quaternary :disabled="!store.hasPrevChapter" @click="prevChapter">
              <template #icon>
                <n-icon :component="ChevronLeft" :size="18" />
              </template>
              {{ t('settings.shortcuts.prevChapter') }}
            </n-button>

            <div
              ref="progressWrapRef"
              class="progress-wrap"
              :class="{ 'progress-wrap-clickable': store.totalChapters > 1 }"
              :title="store.totalChapters > 1 ? t('reader.progressClickHint') : undefined"
              @click="handleProgressClick"
            >
              <span class="progress-text">
                {{
                  t('reader.chapterProgress', { current: store.currentChapterIndex + 1, total: store.totalChapters })
                }}
                <span v-if="remainingReadTimeText" class="progress-remaining-time">· {{ remainingReadTimeText }}</span>
              </span>
              <n-progress
                type="line"
                :percentage="progressPercentRounded"
                :show-indicator="false"
                :height="4"
                class="progress-bar"
              />
              <span class="progress-percent"> {{ progressPercentRounded }}% </span>
            </div>

            <n-button quaternary :disabled="!store.hasNextChapter" @click="nextChapter">
              {{ t('settings.shortcuts.nextChapter') }}
              <template #icon>
                <n-icon :component="ChevronRight" :size="18" />
              </template>
            </n-button>
          </div>
        </div>
      </transition>
    </template>

    <!-- 章节目录抽屉（A4修复：chapter-locate 上报小节书签页内偏移，切章后定位；
         v57：图片型阅读时内含"章节|页"双视图，页缩略图跳页走 jump-to-page） -->
    <ChapterBar
      :comic-current-page="thumbCurrentPage"
      @chapter-locate="onChapterLocate"
      @jump-to-page="handleThumbJumpToPage"
    />

    <!-- 书签笔记抽屉 -->
    <BookmarkBar
      :show="showBookmarkDrawer"
      @update:show="(v: boolean) => (showBookmarkDrawer = v)"
      @jump="jumpToBookmark"
    />

    <!-- 阅读设置抽屉 -->
    <!-- 阅读设置抽屉：图片型内容传 isComicMode，显示漫画专属设置（阅读方向/缩放），隐藏文字排版设置 -->
    <ReadSettings
      :show="showSettings"
      :is-comic-mode="isImageReader"
      @update:show="(v: boolean) => (showSettings = v)"
    />

    <!-- 重新定位对话框（批次 v54：link 书原文件失效恢复） -->
    <RelocateDialog
      :show="showRelocate"
      :data="store.fileMissing"
      @update:show="(v: boolean) => (showRelocate = v)"
      @relocated="handleRelocated"
    />

    <!-- TTS 朗读进度浮层 -->
    <div v-if="ttsPlaying" class="tts-overlay">
      <div class="tts-overlay-inner">
        <n-icon :component="Volume2" :size="16" class="tts-overlay-icon" />
        <span class="tts-overlay-text">
          {{
            ttsSpeakingTitle
              ? t('reader.tts.speakingTitle')
              : t(ttsPaused ? 'reader.tts.progressPaused' : 'reader.tts.progress', {
                  current: ttsCurrentParagraph + 1,
                  total: ttsParagraphs.length
                })
          }}
        </span>
        <n-button quaternary circle size="tiny" @click="handleTTSButtonClick">
          <template #icon>
            <n-icon :component="ttsPaused ? Play : Pause" :size="14" />
          </template>
        </n-button>
        <n-button quaternary circle size="tiny" @click="stopTTS">
          <template #icon>
            <n-icon :component="Square" :size="14" />
          </template>
        </n-button>
      </div>
    </div>

    <!-- 自动滚动控制浮层 -->
    <div v-if="autoScrollEnabled" class="auto-scroll-overlay">
      <div class="auto-scroll-overlay-inner">
        <n-icon :component="Gauge" :size="16" class="auto-scroll-overlay-icon" />
        <span class="auto-scroll-label">{{ t('reader.autoScroll.speed') }}</span>
        <n-slider
          :value="settings.autoScrollSpeed"
          :min="10"
          :max="200"
          :step="10"
          style="width: 120px"
          @update:value="changeAutoScrollSpeed"
        />
        <span class="auto-scroll-value">{{ settings.autoScrollSpeed }}</span>
        <n-button quaternary circle size="tiny" @click="toggleAutoScroll" :title="t('reader.autoScroll.stop')">
          <template #icon>
            <n-icon :component="Square" :size="14" />
          </template>
        </n-button>
      </div>
    </div>

    <!-- 正文区右键菜单 -->
    <n-dropdown
      placement="bottom-start"
      trigger="manual"
      :show="contextMenuShow"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextMenuOptions"
      @select="handleContextMenuSelect"
      @clickoutside="closeContextMenu"
    />

    <!-- 全文搜索抽屉（P1，对标 Kindle/Apple Books） -->
    <n-drawer v-model:show="showSearchPanel" :width="420" placement="right" :auto-focus="true">
      <n-drawer-content :title="t('reader.search.title')" closable>
        <SearchPanel :book-id="bookId" :chapters="store.chapters" @jump-to="handleSearchJumpTo" />
      </n-drawer-content>
    </n-drawer>


    <!-- 添加笔记弹窗 -->
    <n-modal
      :show="noteModalShow"
      preset="card"
      :title="t('reader.note.title')"
      style="width: 480px; max-width: 90vw"
      :bordered="false"
      @update:show="(v: boolean) => (noteModalShow = v)"
    >
      <n-space vertical :size="12">
        <div class="note-quote-label">{{ t('reader.note.quoteLabel') }}</div>
        <div class="note-quote-text">{{ currentSelectedText }}</div>
        <div class="note-highlight-label">{{ t('reader.note.colorLabel') }}</div>
        <div class="note-highlight-picker">
          <button
            class="highlight-color-btn"
            :class="{ active: noteHighlightColor === null }"
            :title="t('reader.note.noHighlight')"
            @click="noteHighlightColor = null"
          >
            <span class="highlight-color-none">{{ t('common.actions.none') }}</span>
          </button>
          <button
            v-for="color in HIGHLIGHT_COLORS"
            :key="color.key"
            class="highlight-color-btn"
            :class="{ active: noteHighlightColor === color.key }"
            :title="t(`readerBars.colors.${color.key}`)"
            @click="noteHighlightColor = color.key"
          >
            <span class="highlight-color-dot" :style="{ background: color.swatch }"></span>
          </button>
        </div>
        <div class="note-input-label">{{ t('reader.note.contentLabel') }}</div>
        <n-input
          v-model:value="noteContent"
          type="textarea"
          :rows="5"
          :placeholder="t('reader.note.placeholder')"
          autofocus
        />
      </n-space>
      <template #footer>
        <n-space justify="end">
          <n-button @click="noteModalShow = false">{{ t('common.actions.cancel') }}</n-button>
          <n-button type="primary" @click="saveNote(noteContent)">{{ t('reader.note.save') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 内容替换弹窗（v18 新增） -->
    <n-modal
      :show="replaceRuleModalShow"
      preset="card"
      :title="t('reader.replace.title')"
      style="width: 520px; max-width: 90vw"
      :bordered="false"
      @update:show="(v: boolean) => (replaceRuleModalShow = v)"
    >
      <n-space vertical :size="12">
        <div class="note-quote-label">{{ t('reader.replace.quoteLabel') }}</div>
        <div class="note-quote-text">{{ currentSelectedText }}</div>
        <div class="note-input-label">{{ t('reader.replace.replacementLabel') }}</div>
        <n-input
          v-model:value="replaceRuleReplacement"
          type="textarea"
          :rows="3"
          :placeholder="t('reader.replace.placeholder')"
          autofocus
        />
        <div class="replace-var-hint">
          {{ t('reader.replace.varHint') }}<code>\n</code>={{ t('reader.replace.varNewline') }} <code>\r</code>={{
            t('reader.replace.varCarriageReturn')
          }}
          <code>\t</code>={{ t('reader.replace.varTab') }} <code>\s</code>={{ t('reader.replace.varSpace') }}
          <code>\\</code>={{ t('reader.replace.varBackslash') }}
        </div>
        <div class="note-input-label">{{ t('reader.replace.scopeLabel') }}</div>
        <n-radio-group v-model:value="replaceRuleScope">
          <n-space>
            <n-radio value="global">{{ t('reader.replace.scopeGlobal') }}</n-radio>
            <n-radio value="book">{{ t('reader.replace.scopeBook') }}</n-radio>
          </n-space>
        </n-radio-group>
        <n-checkbox v-model:checked="replaceRuleIsRegex">
          {{ t('reader.replace.regex') }}
        </n-checkbox>
      </n-space>
      <template #footer>
        <n-space justify="end">
          <n-button @click="replaceRuleModalShow = false">{{ t('common.actions.cancel') }}</n-button>
          <n-button type="primary" @click="saveReplaceRule">{{ t('reader.replace.save') }}</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
/* ==================== 根容器 ==================== */
.reader-view {
  position: relative;
  height: 100%;
  width: 100%;
  background: var(--reader-bg);
  overflow: hidden;
  transition: background-color 0.3s ease;
  display: flex;
  flex-direction: column;
}

/* ==================== 全屏/沉浸阅读模式 ==================== */
/* 全屏模式下工具栏和底部导航显示时用更强的半透明背景+blur效果 */
.fullscreen-mode .toolbar {
  background: color-mix(in srgb, var(--reader-bg) 75%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.fullscreen-mode .bottom-nav {
  background: color-mix(in srgb, var(--reader-bg) 75%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

/* ==================== 工具栏过渡动画 ==================== */
.toolbar-slide-enter-active,
.toolbar-slide-leave-active {
  transition:
    transform 0.15s ease,
    opacity 0.15s ease;
}
.toolbar-slide-enter-from {
  transform: translateY(-100%);
  opacity: 0;
}
.toolbar-slide-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
.toolbar-slide-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 5;
}

/* ==================== 底部导航过渡动画 ==================== */
.bottom-nav-slide-enter-active,
.bottom-nav-slide-leave-active {
  transition:
    transform 0.15s ease,
    opacity 0.15s ease;
}
.bottom-nav-slide-enter-from {
  transform: translateY(100%);
  opacity: 0;
}
.bottom-nav-slide-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
.bottom-nav-slide-leave-active {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 5;
}

/* ==================== 工具栏恢复入口 ==================== */
.toolbar-restore {
  height: 4px;
  flex-shrink: 0;
  background: transparent;
  cursor: pointer;
  transition: background 0.2s ease;
  z-index: 100;
}
.toolbar-restore:hover {
  background: color-mix(in srgb, var(--reader-accent, #4f9cf9) 40%, transparent);
}

/* ==================== C-6：link 书失效常驻警示条 ==================== */
.file-missing-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 16px;
  background: color-mix(in srgb, var(--warning-color, #f0a020) 18%, var(--reader-bg));
  color: var(--warning-color, #f0a020);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
  transition: background 0.2s ease;
  z-index: 90;
}
.file-missing-banner:hover {
  background: color-mix(in srgb, var(--warning-color, #f0a020) 28%, var(--reader-bg));
}
.file-missing-banner:focus-visible {
  outline: 2px solid var(--warning-color, #f0a020);
  outline-offset: -2px;
}
.file-missing-banner-icon {
  flex-shrink: 0;
}

/* ==================== 顶部工具栏 ==================== */
.toolbar {
  position: relative;
  z-index: 100;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--reader-bg) 95%, transparent) 0%,
    color-mix(in srgb, var(--reader-bg) 85%, transparent) 70%,
    color-mix(in srgb, var(--reader-bg) 0%, transparent) 100%
  );
  backdrop-filter: blur(8px);
  padding: var(--spacing-10px) var(--spacing-md);
  pointer-events: auto;
  height: 56px;
  box-sizing: border-box;
  flex-shrink: 0;
}

.toolbar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  max-width: 1400px;
  margin: 0 auto;
  height: 100%;
  min-width: 0;
}

.toolbar-tools {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex: 1;
  min-width: 0;
  justify-content: center;
}

.toolbar-toggle {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.font-controls {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.font-size-label {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  min-width: 20px;
  text-align: center;
}

/* ==================== 底部导航 ==================== */
.bottom-nav {
  position: relative;
  z-index: 100;
  background: linear-gradient(
    to top,
    color-mix(in srgb, var(--reader-bg) 95%, transparent) 0%,
    color-mix(in srgb, var(--reader-bg) 85%, transparent) 70%,
    color-mix(in srgb, var(--reader-bg) 0%, transparent) 100%
  );
  backdrop-filter: blur(8px);
  padding: var(--spacing-14px) var(--spacing-lg);
  pointer-events: auto;
  height: 64px;
  box-sizing: border-box;
  flex-shrink: 0;
}

/* 底部导航按钮文字色绑定阅读器主题
 * n-button（quaternary）的文字/悬停/禁用色均由 Naive UI 应用主题的 CSS 变量
 * （--n-text-color / --n-text-color-hover / --n-text-color-disabled）驱动，
 * 与阅读器独立主题（--reader-*）无关。深色应用主题 + 浅色阅读器主题时会出现
 * "白色按钮文字落在米色背景上不可读"（用户投诉"没对接主题"）。
 * 这里统一改为当前阅读器主题文字色，任何"应用主题 × 阅读器主题"组合下均可读。
 *
 * 注意特异性：Naive UI 的 `.n-button:not(.n-button--disabled):hover` 等状态选择器
 * 特异性(0,3,0)高于基础 `.n-button`(0,1,0)，故 hover/focus/pressed 需分别覆盖，
 * 否则悬停时会回退到应用主题色。 */
.bottom-nav :deep(.n-button),
.bottom-nav :deep(.n-button .n-button__icon) {
  color: var(--reader-text);
}

/* 悬停/焦点/按下态：文字与背景均派生自阅读器主题。
 * quaternary 的悬停背景默认走应用主题（--n-color-hover），
 * 深色应用主题下会在浅色阅读器背景上形成突兀亮块，一并覆盖为文字色低透明度混合。 */
.bottom-nav :deep(.n-button:not(.n-button--disabled):hover),
.bottom-nav :deep(.n-button:not(.n-button--disabled):focus),
.bottom-nav :deep(.n-button:not(.n-button--disabled):active) {
  color: var(--reader-text);
  background-color: color-mix(in srgb, var(--reader-text) 8%, transparent);
}

.bottom-nav :deep(.n-button:not(.n-button--disabled).n-button--pressed) {
  color: var(--reader-text);
}

/* 禁用态：--n-text-color-disabled 同样走应用主题，用阅读器文字色 38% 透明度
 * 保持"不可用但仍可辨识"，且随阅读器背景和谐（含暗色阅读器主题）。 */
.bottom-nav :deep(.n-button.n-button--disabled),
.bottom-nav :deep(.n-button[disabled]) {
  color: color-mix(in srgb, var(--reader-text) 38%, transparent) !important;
}
.bottom-nav :deep(.n-button.n-button--disabled .n-button__icon),
.bottom-nav :deep(.n-button[disabled] .n-button__icon) {
  color: color-mix(in srgb, var(--reader-text) 38%, transparent) !important;
}

.bottom-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-lg);
  max-width: 1400px;
  margin: 0 auto;
  height: 100%;
}

.progress-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm-md);
  max-width: 600px;
  min-width: 0;
}

.progress-text {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  flex-shrink: 0;
  letter-spacing: 1px;
  white-space: nowrap;
}

.progress-bar {
  flex: 1;
  min-width: 0;
}

.progress-bar :deep(.n-progress__rail) {
  background: var(--border-color) !important;
}

.progress-bar :deep(.n-progress__fill) {
  background: var(--reader-primary) !important;
  transition: background 0.3s ease;
}

.progress-percent {
  font-size: var(--font-size-sm);
  color: var(--reader-primary);
  font-weight: 600;
  flex-shrink: 0;
  min-width: 36px;
  text-align: right;
}

/* ==================== 笔记弹窗 ==================== */
.note-quote-label,
.note-input-label,
.note-highlight-label {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin-bottom: calc(var(--spacing-xs) * -1);
}

.note-quote-text {
  padding: var(--spacing-10px) var(--spacing-sm-md);
  background: var(--bg-hover);
  border-left: var(--spacing-3px) solid var(--reader-primary);
  border-radius: var(--border-radius-xs);
  font-size: var(--font-size-sm-plus);
  color: var(--text-secondary);
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
  max-height: 120px;
  overflow-y: auto;
}

/* 内容替换变量提示 */
.replace-var-hint {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary, var(--text-secondary));
  line-height: 1.5;
}
.replace-var-hint code {
  padding: 1px 4px;
  background: var(--bg-hover);
  border-radius: var(--border-radius-xs);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--reader-primary);
}

/* 高亮颜色选择器 */
.note-highlight-picker {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.highlight-color-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid transparent;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition:
    border-color 0.15s ease,
    transform 0.15s ease;
}

.highlight-color-btn:hover {
  transform: scale(1.1);
}

.highlight-color-btn.active {
  border-color: var(--reader-primary);
}

.highlight-color-dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: block;
}

.highlight-color-none {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  font-weight: 500;
}

/* ==================== 内容区 ==================== */
.content-area {
  flex: 1;
  width: 100%;
  min-height: 0;
}

/* 文本模式内容包裹容器：display:flex 让内层 ScrollView/PageView 的 flex:1 正确填充 */
.text-content-wrapper {
  display: flex;
  flex-direction: column;
}

/* ==================== TTS 朗读浮层 ==================== */
.tts-overlay {
  position: absolute;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  pointer-events: auto;
}

.tts-overlay-inner {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-sm-md);
  background: color-mix(in srgb, var(--reader-bg) 92%, transparent);
  backdrop-filter: blur(8px);
  border-radius: var(--border-radius-lg);
  box-shadow: var(--shadow-elevated);
  border: 1px solid color-mix(in srgb, var(--reader-text) 8%, transparent);
}

.tts-overlay-icon {
  color: var(--reader-primary);
  flex-shrink: 0;
}

.tts-overlay-text {
  font-size: var(--font-size-sm);
  color: color-mix(in srgb, var(--reader-text) 65%, transparent);
  white-space: nowrap;
}

/* ==================== 自动滚动控制浮层 ==================== */
.auto-scroll-overlay {
  position: absolute;
  bottom: 130px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  pointer-events: auto;
}

.auto-scroll-overlay-inner {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-sm-md);
  background: color-mix(in srgb, var(--reader-bg) 92%, transparent);
  backdrop-filter: blur(8px);
  border-radius: var(--border-radius-lg);
  box-shadow: var(--shadow-elevated);
  border: 1px solid color-mix(in srgb, var(--reader-text) 8%, transparent);
}

.auto-scroll-overlay-icon {
  color: var(--reader-primary);
  flex-shrink: 0;
}

.auto-scroll-label {
  font-size: var(--font-size-sm);
  color: color-mix(in srgb, var(--reader-text) 65%, transparent);
  flex-shrink: 0;
}

.auto-scroll-value {
  font-size: var(--font-size-sm);
  color: var(--reader-primary);
  font-weight: 600;
  min-width: 28px;
  text-align: center;
  flex-shrink: 0;
}

/* ==================== 加载/错误状态 ==================== */

/* 章节切换加载圈（内容区域中间半透明覆盖） */
.chapter-loading-overlay {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 100;
  pointer-events: none;
}

.chapter-loading-spinner {
  width: 36px;
  height: 36px;
  border: 3px solid var(--text-tertiary, #ccc);
  border-top-color: var(--primary-color, #4f46e5);
  border-radius: 50%;
  animation: chapter-loading-spin 0.6s linear infinite;
}

@keyframes chapter-loading-spin {
  to {
    transform: rotate(360deg);
  }
}

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  height: 100%;
  color: var(--text-secondary);
}

/* 加载状态：淡入动画（对标 AppleBooks） */
.loading-state {
  animation: reader-fade-in 0.3s ease-out;
}

/* 加载骨架屏：模拟章节标题 + 段落灰条（无感化加载） */
.skeleton {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 18px; /* 段落行距 */
  width: min(420px, 72%);
}

/* 灰条：亮色 rgba(0,0,0,0.06)；--border-color 随深浅主题注入 :root，深色下自动适配 */
.skeleton-title,
.skeleton-line {
  background: var(--border-color, rgba(0, 0, 0, 0.06));
  animation: skeleton-breathe 1.5s ease-in-out infinite alternate;
}

/* 章节标题灰条：宽 40%、高 28px、圆角 */
.skeleton-title {
  width: 40%;
  height: 28px;
  border-radius: 8px;
  margin-bottom: 14px;
}

/* 段落灰条：高 16px、行距 18px（gap），宽度模拟自然段落的参差结尾 */
.skeleton-line {
  height: 16px;
  border-radius: 4px;
}


.skeleton-line-1 {
  width: 100%;
}

.skeleton-line-2 {
  width: 92%;
}

.skeleton-line-3 {
  width: 96%;
}

.skeleton-line-4 {
  width: 88%;
}

.skeleton-line-5 {
  width: 65%;
}

/* 呼吸动画：透明度 0.45 → 0.75 无限交替 */
@keyframes skeleton-breathe {
  from {
    opacity: 0.45;
  }
  to {
    opacity: 0.75;
  }
}

/* 减弱动态效果偏好：停用呼吸动画（可访问性） */
@media (prefers-reduced-motion: reduce) {
  .skeleton-title,
  .skeleton-line {
    animation: none;
  }
}

/* 仅供读屏的隐藏文本：保持加载状态对读屏用户可感知 */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@keyframes reader-fade-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}


/* 错误状态：淡入动画 */
.error-state {
  animation: reader-fade-in 0.3s ease-out;
}

.error-icon {
  color: var(--color-danger);
  opacity: 0.9;
}

.error-text {
  font-size: var(--font-size-base);
  color: var(--color-danger);
  text-align: center;
  max-width: 480px;
  line-height: 1.6;
}

/* 错误状态操作按钮组 */
.error-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

/* ==================== 底部进度条可交互 ==================== */
/* 文字模式下进度条容器可点击 */
.progress-wrap-clickable {
  cursor: pointer;
  border-radius: var(--border-radius-sm);
  /* 增大可点击区域，提升交互体验 */
  padding: var(--spacing-xs) var(--spacing-xs);
  margin: calc(var(--spacing-xs) * -1) calc(var(--spacing-xs) * -1);
  transition: background 0.15s ease;
}

.progress-wrap-clickable:hover {
  background: var(--bg-hover);
}

/* 阅读时间估算（对标 Kindle） */
.progress-remaining-time {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  font-weight: 400;
  letter-spacing: 0;
  margin-left: var(--spacing-xs);
}
</style>
