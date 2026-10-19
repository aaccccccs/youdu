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
  Replace
} from '@lucide/vue';
import { useReaderStore, type ReadMode } from '@renderer/stores';
import { useSettingsStore, matchKeyboardShortcut } from '@renderer/stores';
import { useBookmarkStore, type Bookmark } from '@renderer/stores';

import { useDropdownIcon, useContextMenu } from '@renderer/composables';
import ScrollView from '@renderer/components/reader/ScrollView.vue';
import PageView from '@renderer/components/reader/PageView.vue';

import ChapterBar from '@renderer/components/reader/ChapterBar.vue';
import BookmarkBar from '@renderer/components/reader/BookmarkBar.vue';
import ReadSettings from '@renderer/components/reader/ReadSettings.vue';
import SearchPanel from '@renderer/components/reader/SearchPanel.vue';

import { HIGHLIGHT_COLORS } from '../../../shared';

const route = useRoute();
const router = useRouter();
const store = useReaderStore();
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

/** 滚动视图组件引用 */
const scrollViewRef = ref<InstanceType<typeof ScrollView> | null>(null);
/** 翻页视图组件引用 */
const pageViewRef = ref<InstanceType<typeof PageView> | null>(null);

/** 书签抽屉显示状态 */
const showBookmarkDrawer = ref<boolean>(false);
/** 搜索面板显示状态 */
const showSearchPanel = ref<boolean>(false);

/** 阅读设置面板显示 */
const showSettings = ref<boolean>(false);

/** 是否已成功加载初始章节 */
const initialized = ref<boolean>(false);

/* ==================== 右键菜单 ==================== */

const { contextMenuShow, contextMenuX, contextMenuY, openContextMenu, closeContextMenu } = useContextMenu();
const currentSelectedText = ref<string>('');

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

  // 自动滚动选项仅在章节/无限拼接模式下显示
  if (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all') {
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
    label: t('reader.contextMenu.switchReadMode', { mode: readModeLabel.value }),
    key: 'toggle-read-mode',
    icon: renderIcon(readModeIcon.value)
  });

  return options;
});

const renderIcon = useDropdownIcon();

function handleContextMenu(event: MouseEvent): void {
  event.preventDefault();
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : '';
  currentSelectedText.value = text;
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
    const nextMode: ReadMode =
      store.readMode === 'chapter'
        ? 'scroll'
        : store.readMode === 'scroll'
          ? 'page'
          : store.readMode === 'page'
            ? 'all'
            : 'chapter';
    void handleReadModeSelect(nextMode).catch((e) => console.error('handleReadModeSelect 失败:', e));
  }
}

/* ==================== 添加书签 ==================== */

function getCurrentPositionAndText(): { position: number; content: string } {
  if (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all') {
    return {
      position: scrollViewRef.value?.getCurrentPosition() ?? 0,
      content: scrollViewRef.value?.getVisibleText() ?? ''
    };
  }
  return {
    position: pageViewRef.value?.getCurrentPosition() ?? 0,
    content: pageViewRef.value?.getVisibleText() ?? ''
  };
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
    // 提前设置位置恢复标志，防止 loadChapter 触发 watch 的 scrollToTop 覆盖位置恢复
    if (
      savedPosition > 0 &&
      (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all')
    ) {
      scrollViewRef.value?.prepareRestore();
    }
    await store.loadChapter(store.currentChapterIndex);
    await nextTick();
    if (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all') {
      await scrollViewRef.value?.scrollToPosition(savedPosition);
    } else {
      pageViewRef.value?.goToPosition(savedPosition);
    }
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
watch(
  () => store.currentChapterIndex,
  () => {
    if (ttsPlaying.value && !ttsAutoAdvancing) {
      stopTTS();
    }
    // P1-14修复：TTS 自动续读下一章（ttsAutoAdvancing=true）时不应停止自动滚动，
    // 仅在用户手动切章时才停止。否则 TTS 续读会打断用户的自动滚动阅读体验。
    if (!ttsAutoAdvancing) {
      autoScrollEnabled.value = false;
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

async function jumpToBookmark(bm: Bookmark): Promise<void> {
  if (!store.book) return;
  const position = bm.position ?? 0;
  if (bm.chapter_index !== store.currentChapterIndex) {
    // 提前设置位置恢复标志，防止 loadChapter 触发 watch 的 scrollToTop 覆盖位置恢复
    if (position > 0 && (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all')) {
      scrollViewRef.value?.prepareRestore();
    }
    await store.loadChapter(bm.chapter_index);
  }
  // 等待新视图组件挂载就绪
  await waitForComponentReady();
  if (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all') {
    await scrollViewRef.value?.scrollToPosition(position);
  } else {
    pageViewRef.value?.goToPosition(position);
  }
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
    if (position > 0 && (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all')) {
      scrollViewRef.value?.prepareRestore();
    }
    await store.loadChapter(payload.chapterIndex);
  }
  // 等待新视图组件挂载就绪
  await waitForComponentReady();
  if (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all') {
    await scrollViewRef.value?.scrollToPosition(position);
  } else {
    pageViewRef.value?.goToPosition(position);
  }
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

/** 从当前视图组件获取位置并保存进度（退出前调用，确保保存的是真实位置而非 debounce 旧值） */
async function flushCurrentProgress(): Promise<void> {
  if (!store.book) return;
  let position = 0;
  if (store.readMode === 'page' && pageViewRef.value) {
    position = pageViewRef.value.getCurrentPosition();
  } else if (scrollViewRef.value) {
    position = scrollViewRef.value.getCurrentPosition();
  } else {
    // 子组件已卸载（Vue 卸载顺序：子→父），使用 store 中缓存的实时位置作为 fallback
    // 用 ?? 而非 ||：0 是合法的滚动位置（章节开头），不应被当 falsy 跳过
    position = store.liveScrollPosition ?? store.lastScrollPosition;
  }
  await store.saveProgressImmediate(position);
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
  }

  // 提前设置位置恢复标志，防止 loadChapter 触发 watch 的 scrollToTop 覆盖位置恢复
  if (scrollPosition > 0 && (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all')) {
    scrollViewRef.value?.prepareRestore();
  }
  await store.loadChapter(targetIndex);
  if (initCanceled) return;

  if (scrollPosition > 0) {
    // 等待视图组件挂载就绪：v-if 切换后新组件的 ref 绑定和 onMounted 需要额外一帧才能完成
    await waitForComponentReady();
    if (initCanceled) return;
    if (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all') {
      await scrollViewRef.value?.scrollToPosition(scrollPosition);
    } else {
      pageViewRef.value?.goToPosition(scrollPosition);
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
    if (match(shortcuts.toggleSearch)) {
      event.preventDefault();
      showSearchPanel.value = true;
      return;
    }
    if (match(shortcuts.toggleTTS)) {
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

    // 阅读导航：翻页模式
    if (store.readMode === 'page') {
      if (match(shortcuts.prevPage)) {
        event.preventDefault();
        await pageViewRef.value?.prevPage();
        return;
      }
      if (match(shortcuts.nextPage)) {
        event.preventDefault();
        await pageViewRef.value?.nextPage();
        return;
      }
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
      return;
    }

    // 滚动/章节/全部模式：上一页/下一页 = 上下滚动一屏；章节键切换上下章
    if (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all') {
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
      if (match(shortcuts.prevPage)) {
        event.preventDefault();
        scrollViewRef.value?.scrollPageUp();
        return;
      }
      if (match(shortcuts.nextPage)) {
        event.preventDefault();
        scrollViewRef.value?.scrollPageDown();
        return;
      }
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
  if (store.readMode === 'chapter') return ScrollText;
  if (store.readMode === 'scroll') return Layers;
  if (store.readMode === 'all') return Rows3;
  return Book;
});

const readModeLabel = computed<string>(() => {
  if (store.readMode === 'chapter') return t('reader.readMode.chapter');
  if (store.readMode === 'scroll') return t('reader.readMode.scroll');
  if (store.readMode === 'all') return t('reader.readMode.all');
  return t('reader.readMode.page');
});

async function handleReadModeSelect(key: string | number): Promise<void> {
  const mode = String(key) as ReadMode;
  if (mode === store.readMode) return;

  if (mode === 'page') {
    autoScrollEnabled.value = false;
  }
  const savedPosition = getCurrentPositionAndText().position;
  await store.setReadMode(mode);
  await store.saveProgressImmediate(savedPosition);
  // 等待新组件挂载完成：使用 waitForComponentReady 统一时序处理
  await waitForComponentReady();
  if (mode === 'chapter' || mode === 'scroll' || mode === 'all') {
    await scrollViewRef.value?.scrollToPosition(savedPosition);
  } else {
    pageViewRef.value?.goToPosition(savedPosition);
  }
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
    await store.prevChapter();
    // 等待新视图组件挂载就绪：v-if 切换后新组件的 ref 绑定和 onMounted 需要额外一帧才能完成
    await waitForComponentReady();
    // scrollToTop 是 async 函数，必须 await 确保滚动完成
    await scrollViewRef.value?.scrollToTop();
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
    await store.nextChapter();
    // 等待新视图组件挂载就绪：v-if 切换后新组件的 ref 绑定和 onMounted 需要额外一帧才能完成
    await waitForComponentReady();
    // scrollToTop 是 async 函数，必须 await 确保滚动完成
    await scrollViewRef.value?.scrollToTop();
  } finally {
    isSwitchingChapter.value = false;
  }
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
const progressPercentRounded = computed<number>(() => Math.round(store.progressPercent * 100));

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
  await store.loadChapter(targetIndex);
  // 等待新视图组件挂载就绪
  await waitForComponentReady();
  // 跳转到目标章节开头
  await scrollViewRef.value?.scrollToTop();
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
    // 提前设置位置恢复标志，防止 loadChapter 触发 watch 的 scrollToTop 覆盖位置恢复
    if (
      savedPosition !== null &&
      savedPosition > 0 &&
      (store.readMode === 'chapter' || store.readMode === 'scroll' || store.readMode === 'all')
    ) {
      scrollViewRef.value?.prepareRestore();
    }
    void store
      .loadChapter(store.currentChapterIndex)
      .then(() => {
        if (savedPosition !== null && savedPosition > 0) {
          nextTick(() => {
            if (store.readMode === 'page') {
              pageViewRef.value?.goToPosition(savedPosition);
            } else {
              scrollViewRef.value?.scrollToPosition(savedPosition);
            }
          });
        }
      })
      .catch((e) => console.error('loadChapter 失败:', e));
  }
});

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
  stopTTS();
  stopAutoScroll();
  // Vue 不 await async 钩子；先 flush 进度再 reset，避免 reset 清空 store.book 导致进度丢失
  // 窗口关闭路径由 App.vue onCloseRequested → flushProgressForClose 保证进度保存，
  // isClosing 为 true 时跳过 flushCurrentProgress，避免组件卸载时获取错误位置覆盖已保存的正确进度
  if (!store.isClosing) {
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
  } else {
    void store
      .cleanup()
      .finally(() => {
        store.reset();
        bookmarkStore.reset();
      })
      .catch((e) => console.error('cleanup 失败:', e));
  }
});
</script>

<template>
  <div class="reader-view" :class="{ 'fullscreen-mode': store.isFullscreen }">
    <!-- 加载中（旋转动画 + 文字 + 淡入动画，对标 AppleBooks） -->
    <div v-if="store.loading && !store.chapterContent" class="loading-state">
      <div class="loading-spinner" aria-hidden="true"></div>
      <span class="loading-text">{{ t('reader.loadingChapter') }}</span>
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
              <!-- 章节目录 -->
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

              <!-- 字号调节 -->
              <div class="font-controls">
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

              <!-- 全文搜索 -->
              <n-tooltip trigger="hover">
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

              <!-- TTS 朗读 -->
              <n-tooltip trigger="hover">
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

      <!-- 正文区 — 文本模式，flex:1 占据剩余空间 -->
      <div class="content-area text-content-wrapper">
        <ScrollView
          v-if="store.readMode === 'chapter'"
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
        <PageView v-else ref="pageViewRef" class="content-area" @contextmenu="handleContextMenu" />
      </div>

      <!-- 底部导航（可隐藏） -->
      <transition name="bottom-nav-slide">
        <div v-if="store.showToolbar" class="bottom-nav">
          <div class="bottom-inner">
            <n-button quaternary :disabled="!store.hasPrevChapter" @click="prevChapter">
              <template #icon>
                <n-icon :component="ChevronLeft" :size="18" />
              </template>
              {{ t('common.actions.previous') }}
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
              {{ t('common.actions.next') }}
              <template #icon>
                <n-icon :component="ChevronRight" :size="18" />
              </template>
            </n-button>
          </div>
        </div>
      </transition>
    </template>

    <!-- 章节目录抽屉 -->
    <ChapterBar />

    <!-- 书签笔记抽屉 -->
    <BookmarkBar
      :show="showBookmarkDrawer"
      @update:show="(v: boolean) => (showBookmarkDrawer = v)"
      @jump="jumpToBookmark"
    />

    <!-- 阅读设置抽屉 -->
    <ReadSettings :show="showSettings" @update:show="(v: boolean) => (showSettings = v)" />

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

/* 旋转 spinner（CSS @keyframes spin 实现） */
.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top-color: var(--reader-primary);
  border-radius: 50%;
  animation: reader-spin 0.8s linear infinite;
}

@keyframes reader-spin {
  to {
    transform: rotate(360deg);
  }
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

.loading-text {
  font-size: var(--font-size-base);
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
