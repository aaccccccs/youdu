<!--
  书签笔记管理面板

  功能：
  - NDrawer 抽屉，从右侧滑出，宽度 360px
  - 顶部 Tab 切换：书签 / 划线 / 笔记
    · 书签 = 无高亮无笔记的纯位置标记
    · 划线 = 有高亮颜色但无笔记
    · 笔记 = 有笔记文字内容（不管有无高亮）
  - 书签项：章节名 + 内容摘要 + 添加时间
  - 划线项：左侧颜色竖条 + 章节名 + 原文摘要 + 添加时间
  - 笔记项有左侧紫色竖条区分
  - 列表按章节升序，显示章节标题 + 位置 + 摘要 + 创建时间
  - 点击列表项跳转到对应章节和位置（emit jump 事件）
  - 删除按钮（确认后删除）
  - 笔记支持查看/编辑笔记内容
  - 空状态：根据各 tab 给出对应提示

  父组件（Reader.vue）负责：
  - 控制 show 双向绑定
  - 监听 jump 事件执行跳转
-->
<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NDrawer,
  NDrawerContent,
  NTabs,
  NTabPane,
  NIcon,
  NButton,
  NTooltip,
  NPopconfirm,
  NScrollbar,
  NTag,
  NInput,
  NModal,
  NSpace,
  useMessage
} from 'naive-ui';
import {
  Bookmark as BookmarkIcon,
  StickyNote,
  Trash,
  Pencil,
  Quote,
  Highlighter,
  Search as SearchIcon
} from '@lucide/vue';
import { useReaderStore } from '@renderer/stores';
import { useBookmarkStore } from '@renderer/stores';
import type { Bookmark } from '@renderer/types';

import { formatDateTime } from '@renderer/utils';
import { HIGHLIGHT_COLORS, HIGHLIGHT_SWATCH } from '../../../../shared';

/* ==================== Props / Emits ==================== */

const props = defineProps<{
  /** 是否显示抽屉 */
  show: boolean;
}>();

const emit = defineEmits<{
  /** 关闭/打开抽屉 */
  (e: 'update:show', value: boolean): void;
  /** 跳转到书签位置 */
  (e: 'jump', bookmark: Bookmark): void;
}>();

const { t } = useI18n();
const readerStore = useReaderStore();
const bookmarkStore = useBookmarkStore();

// 消息 API（通过 App.vue 的 NMessageProvider 注入，自动跟随主题）
const message = useMessage();

/* ==================== Tab 切换 ==================== */

/** 当前 tab：bookmark=书签 / highlight=划线 / note=笔记 */
const activeTab = ref<'bookmark' | 'highlight' | 'note'>('bookmark');

/* ==================== 章节标题查找 ==================== */

/** 根据章节序号获取章节标题 */
function getChapterTitle(chapterIndex: number): string {
  const ch = readerStore.chapters[chapterIndex];
  return ch?.title ?? t('readerBars.chapter.chapterN', { n: chapterIndex + 1 });
}

/* ==================== 时间格式化 ==================== */

/** 格式化创建时间（复用 utils/time 的 formatDateTime，避免内联重复实现） */
function formatTime(ts: number | null): string {
  if (!ts) return '';
  return formatDateTime(ts);
}

/** 截断摘要，过长省略 */
function truncate(text: string | null, max = 60): string {
  if (!text) return '';
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/* ==================== 列表数据 ==================== */

/**
 * 三类分类规则：
 * - 书签：无高亮颜色且无笔记内容的纯位置标记
 * - 划线：有高亮颜色但无笔记内容
 * - 笔记：有笔记文字内容（不管有无高亮）
 */

/** 书签列表（无高亮无笔记的纯位置标记） */
const bookmarkList = computed<Bookmark[]>(() =>
  bookmarkStore.bookmarks.filter(
    (bm) => (!bm.highlight_color || bm.highlight_color.trim() === '') && (!bm.note || bm.note.trim() === '')
  )
);

/** 划线列表（有高亮颜色但无笔记） */
const highlightList = computed<Bookmark[]>(() =>
  bookmarkStore.bookmarks.filter(
    (bm) => bm.highlight_color && bm.highlight_color.trim() !== '' && (!bm.note || bm.note.trim() === '')
  )
);

/** 笔记列表（有笔记文字内容） */
const noteList = computed<Bookmark[]>(() => bookmarkStore.bookmarks.filter((bm) => bm.note && bm.note.trim() !== ''));

/* ==================== 笔记筛选与分组 ==================== */

/** 颜色筛选：null = 全部 */
const noteFilterColor = ref<string | null>(null);

/** 搜索关键词 */
const noteSearchKeyword = ref<string>('');

/** 按颜色筛选后的笔记 */
const filteredNotes = computed<Bookmark[]>(() => {
  let list = bookmarkStore.noteOnly;
  if (noteFilterColor.value) {
    list = list.filter((bm) => bm.highlight_color === noteFilterColor.value);
  }
  if (noteSearchKeyword.value.trim()) {
    const kw = noteSearchKeyword.value.trim().toLowerCase();
    list = list.filter((bm) => bm.note?.toLowerCase().includes(kw) || bm.content?.toLowerCase().includes(kw));
  }
  return list;
});

/** 按章节分组 */
const groupedNotes = computed<Array<[number, Bookmark[]]>>(() => {
  const map = new Map<number, Bookmark[]>();
  for (const bm of filteredNotes.value) {
    const arr = map.get(bm.chapter_index);
    if (arr) arr.push(bm);
    else map.set(bm.chapter_index, [bm]);
  }
  return Array.from(map.entries());
});

/* ==================== 点击书签跳转 ==================== */

/** 点击列表项 */
function handleClickBookmark(bm: Bookmark): void {
  emit('jump', bm);
}

/** 键盘激活列表项（Enter / Space） */
function handleBookmarkKeyActivate(bm: Bookmark): void {
  emit('jump', bm);
}

/** 构造列表项 aria-label */
function bookmarkAriaLabel(bm: Bookmark): string {
  const title = getChapterTitle(bm.chapter_index);
  const note = bm.note ? t('readerBars.bookmark.ariaNote', { text: truncate(bm.note, 30) }) : '';
  const excerpt = bm.content ? t('readerBars.bookmark.ariaExcerpt', { text: truncate(bm.content, 30) }) : '';
  return t('readerBars.bookmark.ariaLabel', {
    title,
    excerpt,
    note,
    time: formatTime(bm.created_at)
  });
}

/** 按颜色 key 获取本地化颜色名（shared 的中文 label 不直接使用） */
function colorLabel(key: string): string {
  return t(`readerBars.colors.${key}`);
}

/* ==================== 删除 ==================== */

/** 删除书签/笔记 */
async function handleDelete(bm: Bookmark): Promise<void> {
  const ok = await bookmarkStore.removeBookmark(bm.id);
  if (ok) {
    message.success(t('common.feedback.deleted'));
  } else {
    message.error(t('readerBars.bookmark.deleteFailed'));
  }
}

/* ==================== 笔记编辑 ==================== */

/** 编辑弹窗显示 */
const editModalShow = ref<boolean>(false);
/** 当前编辑的书签 id */
const editingId = ref<number | null>(null);
/** 编辑中的笔记内容 */
const editingNote = ref<string>('');
/** 编辑中的摘要内容 */
const editingContent = ref<string>('');
/** 编辑中的高亮颜色 */
const editingHighlightColor = ref<string | null>(null);

/** 打开编辑弹窗 */
function openEdit(bm: Bookmark): void {
  editingId.value = bm.id;
  editingNote.value = bm.note ?? '';
  editingContent.value = bm.content ?? '';
  editingHighlightColor.value = bm.highlight_color ?? null;
  editModalShow.value = true;
}

/** 保存编辑 */
async function saveEdit(): Promise<void> {
  if (editingId.value === null) return;
  const ok = await bookmarkStore.updateBookmark(editingId.value, {
    note: editingNote.value.trim() || null,
    content: editingContent.value.trim() || null,
    highlight_color: editingHighlightColor.value
  });
  if (ok) {
    message.success(t('common.actions.saved'));
    editModalShow.value = false;
    editingId.value = null;
  } else {
    message.error(t('readerBars.bookmark.saveFailed'));
  }
}

/* ==================== 抽屉打开时刷新 ==================== */

watch(
  () => props.show,
  (visible) => {
    if (visible && readerStore.book) {
      void bookmarkStore
        .loadBookmarks(readerStore.book.id)
        .catch((e) => console.error('bookmarkStore.loadBookmarks 失败:', e));
    }
  }
);
</script>

<template>
  <n-drawer :show="props.show" :width="360" placement="right" @update:show="(v: boolean) => emit('update:show', v)">
    <n-drawer-content :native-scrollbar="false" :title="t('readerBars.bookmark.panelTitle')">
      <div class="bookmark-bar">
        <!-- 头部 -->
        <div class="bar-header">
          <div class="header-row">
            <span class="bar-title">{{ t('readerBars.bookmark.headerTitle') }}</span>
          </div>
        </div>

        <!-- Tab 切换 -->
        <n-tabs v-model:value="activeTab" type="line" class="bar-tabs" pane-wrapper-style="flex: 1; overflow: hidden;">
          <!-- 书签 Tab -->
          <n-tab-pane name="bookmark" :tab="t('readerBars.bookmark.tabBookmark', { n: bookmarkList.length })">
            <div class="pane-container">
              <!-- 空状态：还没有书签 + 提示如何添加 -->
              <div v-if="bookmarkList.length === 0" class="empty-state">
                <n-icon :component="BookmarkIcon" :size="48" class="empty-icon" />
                <div class="empty-title">{{ t('readerBars.bookmark.emptyBookmark') }}</div>
                <div class="empty-hint">
                  {{ t('readerBars.bookmark.emptyBookmarkHint1') }}<br />
                  {{ t('readerBars.bookmark.emptyBookmarkHint2') }}
                </div>
              </div>
              <n-scrollbar v-else class="list-scroll">
                <div
                  v-for="bm in bookmarkList"
                  :key="bm.id"
                  class="list-item"
                  role="button"
                  tabindex="0"
                  :aria-label="bookmarkAriaLabel(bm)"
                  @click="handleClickBookmark(bm)"
                  @keydown.enter="handleBookmarkKeyActivate(bm)"
                  @keydown.space.prevent="handleBookmarkKeyActivate(bm)"
                >
                  <!-- 章节名 -->
                  <div class="item-header">
                    <n-tag size="tiny" type="info" round>
                      {{ getChapterTitle(bm.chapter_index) }}
                    </n-tag>
                    <span class="item-time">{{ formatTime(bm.created_at) }}</span>
                    <div class="item-actions">
                      <n-popconfirm
                        @positive-click="handleDelete(bm)"
                        :positive-text="t('readerBars.bookmark.confirmDelete')"
                        :negative-text="t('common.actions.cancel')"
                      >
                        <template #trigger>
                          <n-button
                            quaternary
                            circle
                            size="tiny"
                            class="item-delete"
                            :title="t('common.actions.delete')"
                            @click.stop
                          >
                            <template #icon>
                              <n-icon :component="Trash" :size="14" />
                            </template>
                          </n-button>
                        </template>
                        {{ t('readerBars.bookmark.confirmDeleteBookmark') }}
                      </n-popconfirm>
                    </div>
                  </div>
                  <!-- 内容摘要 -->
                  <div v-if="bm.content" class="item-content">
                    {{ truncate(bm.content, 80) }}
                  </div>
                  <div v-else class="item-content placeholder">{{ t('readerBars.bookmark.noExcerpt') }}</div>
                </div>
              </n-scrollbar>
            </div>
          </n-tab-pane>

          <!-- 划线 Tab -->
          <n-tab-pane name="highlight" :tab="t('readerBars.bookmark.tabHighlight', { n: highlightList.length })">
            <div class="pane-container">
              <!-- 空状态：还没有划线 -->
              <div v-if="highlightList.length === 0" class="empty-state">
                <n-icon :component="Highlighter" :size="48" class="empty-icon" />
                <div class="empty-title">{{ t('readerBars.bookmark.emptyHighlight') }}</div>
                <div class="empty-hint">
                  {{ t('readerBars.bookmark.emptyHighlightHint1') }}<br />
                  {{ t('readerBars.bookmark.emptyHighlightHint2') }}
                </div>
              </div>
              <n-scrollbar v-else class="list-scroll">
                <div
                  v-for="bm in highlightList"
                  :key="bm.id"
                  class="list-item highlight-item"
                  :style="{
                    borderLeftColor: bm.highlight_color
                      ? (HIGHLIGHT_SWATCH[bm.highlight_color] ?? 'var(--primary)')
                      : 'var(--primary)'
                  }"
                  role="button"
                  tabindex="0"
                  :aria-label="bookmarkAriaLabel(bm)"
                  @click="handleClickBookmark(bm)"
                  @keydown.enter="handleBookmarkKeyActivate(bm)"
                  @keydown.space.prevent="handleBookmarkKeyActivate(bm)"
                >
                  <div class="item-header">
                    <n-tag size="tiny" type="info" round>
                      {{ getChapterTitle(bm.chapter_index) }}
                    </n-tag>
                    <span class="item-time">{{ formatTime(bm.created_at) }}</span>
                    <div class="item-actions">
                      <n-tooltip trigger="hover">
                        <template #default>{{ t('common.actions.edit') }}</template>
                        <template #trigger>
                          <n-button quaternary circle size="tiny" @click.stop="openEdit(bm)">
                            <template #icon>
                              <n-icon :component="Pencil" :size="14" />
                            </template>
                          </n-button>
                        </template>
                      </n-tooltip>
                      <n-popconfirm
                        @positive-click="handleDelete(bm)"
                        :positive-text="t('readerBars.bookmark.confirmDelete')"
                        :negative-text="t('common.actions.cancel')"
                      >
                        <template #trigger>
                          <n-button
                            quaternary
                            circle
                            size="tiny"
                            class="item-delete"
                            :title="t('common.actions.delete')"
                            @click.stop
                          >
                            <template #icon>
                              <n-icon :component="Trash" :size="14" />
                            </template>
                          </n-button>
                        </template>
                        {{ t('readerBars.bookmark.confirmDeleteHighlight') }}
                      </n-popconfirm>
                    </div>
                  </div>
                  <!-- 选中的原文摘要 -->
                  <div v-if="bm.content" class="item-quote">
                    <n-icon :component="Quote" :size="12" class="quote-icon" />
                    <span>{{ truncate(bm.content, 80) }}</span>
                  </div>
                </div>
              </n-scrollbar>
            </div>
          </n-tab-pane>

          <!-- 笔记 Tab -->
          <n-tab-pane name="note" :tab="t('readerBars.bookmark.tabNote', { n: noteList.length })">
            <div class="pane-container">
              <!-- 搜索框 -->
              <div class="note-search">
                <n-input
                  v-model:value="noteSearchKeyword"
                  :placeholder="t('readerBars.bookmark.searchPlaceholder')"
                  clearable
                  size="small"
                >
                  <template #prefix>
                    <n-icon :component="SearchIcon" :size="14" />
                  </template>
                </n-input>
              </div>

              <!-- 颜色筛选按钮行 -->
              <div class="note-color-filter">
                <button
                  class="filter-color-btn"
                  :class="{ active: noteFilterColor === null }"
                  @click="noteFilterColor = null"
                >
                  {{ t('common.actions.all') }}
                </button>
                <button
                  v-for="color in HIGHLIGHT_COLORS"
                  :key="color.key"
                  class="filter-color-btn"
                  :class="{ active: noteFilterColor === color.key }"
                  :title="colorLabel(color.key)"
                  @click="noteFilterColor = color.key"
                >
                  <span class="filter-color-dot" :style="{ background: color.swatch }"></span>
                </button>
              </div>

              <!-- 空状态：完全没有笔记 -->
              <div v-if="noteList.length === 0" class="empty-state">
                <n-icon :component="StickyNote" :size="48" class="empty-icon" />
                <div class="empty-title">{{ t('readerBars.bookmark.emptyNote') }}</div>
                <div class="empty-hint">
                  {{ t('readerBars.bookmark.emptyNoteHint1') }}<br />
                  {{ t('readerBars.bookmark.emptyNoteHint2') }}
                </div>
              </div>

              <!-- 空状态：有笔记但筛选/搜索后无匹配 -->
              <div v-else-if="filteredNotes.length === 0" class="empty-state">
                <n-icon :component="SearchIcon" :size="48" class="empty-icon" />
                <div class="empty-title">{{ t('readerBars.bookmark.noMatchNote') }}</div>
                <div class="empty-hint">{{ t('readerBars.bookmark.noMatchHint') }}</div>
              </div>

              <!-- 分组列表 -->
              <n-scrollbar v-else class="list-scroll">
                <div v-for="[chapterIndex, items] in groupedNotes" :key="chapterIndex" class="note-group">
                  <div class="note-group-title">{{ getChapterTitle(chapterIndex) }}</div>
                  <div
                    v-for="bm in items"
                    :key="bm.id"
                    class="list-item note-item"
                    :style="{
                      borderLeftColor: bm.highlight_color
                        ? (HIGHLIGHT_SWATCH[bm.highlight_color] ?? 'var(--primary)')
                        : 'var(--primary)'
                    }"
                    role="button"
                    tabindex="0"
                    :aria-label="bookmarkAriaLabel(bm)"
                    @click="handleClickBookmark(bm)"
                    @keydown.enter="handleBookmarkKeyActivate(bm)"
                    @keydown.space.prevent="handleBookmarkKeyActivate(bm)"
                  >
                    <div class="item-header">
                      <n-tag size="tiny" type="info" round>
                        {{ getChapterTitle(bm.chapter_index) }}
                      </n-tag>
                      <span class="item-time">{{ formatTime(bm.created_at) }}</span>
                      <div class="item-actions">
                        <n-tooltip trigger="hover">
                          <template #default>{{ t('readerBars.bookmark.editNote') }}</template>
                          <template #trigger>
                            <n-button quaternary circle size="tiny" @click.stop="openEdit(bm)">
                              <template #icon>
                                <n-icon :component="Pencil" :size="14" />
                              </template>
                            </n-button>
                          </template>
                        </n-tooltip>
                        <n-popconfirm
                          @positive-click="handleDelete(bm)"
                          :positive-text="t('readerBars.bookmark.confirmDelete')"
                          :negative-text="t('common.actions.cancel')"
                        >
                          <template #trigger>
                            <n-button
                              quaternary
                              circle
                              size="tiny"
                              class="item-delete"
                              :title="t('common.actions.delete')"
                              @click.stop
                            >
                              <template #icon>
                                <n-icon :component="Trash" :size="14" />
                              </template>
                            </n-button>
                          </template>
                          {{ t('readerBars.bookmark.confirmDeleteNote') }}
                        </n-popconfirm>
                      </div>
                    </div>
                    <!-- 选中的原文摘要 -->
                    <div v-if="bm.content" class="item-quote">
                      <n-icon :component="Quote" :size="12" class="quote-icon" />
                      <span>{{ truncate(bm.content, 80) }}</span>
                    </div>
                    <!-- 笔记内容 -->
                    <div class="item-note">{{ bm.note }}</div>
                  </div>
                </div>
              </n-scrollbar>
            </div>
          </n-tab-pane>
        </n-tabs>
      </div>
    </n-drawer-content>

    <!-- 编辑笔记弹窗 -->
    <n-modal
      v-model:show="editModalShow"
      preset="card"
      :title="t('readerBars.bookmark.editTitle')"
      style="width: 480px; max-width: 90vw"
      :bordered="false"
    >
      <n-space vertical :size="12">
        <div class="edit-label">{{ t('readerBars.bookmark.fieldExcerpt') }}</div>
        <n-input
          v-model:value="editingContent"
          type="textarea"
          :rows="3"
          :placeholder="t('readerBars.bookmark.excerptPlaceholder')"
        />
        <div class="edit-label">{{ t('readerBars.bookmark.fieldNote') }}</div>
        <n-input
          v-model:value="editingNote"
          type="textarea"
          :rows="5"
          :placeholder="t('readerBars.bookmark.notePlaceholder')"
        />
        <div class="edit-label">{{ t('readerBars.bookmark.fieldHighlight') }}</div>
        <div class="edit-highlight-picker">
          <button
            class="edit-color-btn"
            :class="{ active: editingHighlightColor === null }"
            :title="t('readerBars.bookmark.noHighlight')"
            @click="editingHighlightColor = null"
          >
            <span class="edit-color-none">{{ t('common.actions.none') }}</span>
          </button>
          <button
            v-for="color in HIGHLIGHT_COLORS"
            :key="color.key"
            class="edit-color-btn"
            :class="{ active: editingHighlightColor === color.key }"
            :title="colorLabel(color.key)"
            @click="editingHighlightColor = color.key"
          >
            <span class="edit-color-dot" :style="{ background: color.swatch }"></span>
          </button>
        </div>
      </n-space>
      <template #footer>
        <n-space justify="end">
          <n-button @click="editModalShow = false">{{ t('common.actions.cancel') }}</n-button>
          <n-button type="primary" @click="saveEdit">{{ t('common.actions.save') }}</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-drawer>
</template>

<style scoped>
.bookmark-bar {
  display: flex;
  flex-direction: column;
  height: 100%;

  overflow: hidden;
}

/* ==================== 头部 ==================== */
.bar-header {
  padding: var(--spacing-xs) var(--spacing-xs) 0;
  flex-shrink: 0;
}

.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--spacing-xs);
}

.bar-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text-primary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

/* ==================== Tab ==================== */
.bar-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0 var(--spacing-xs);
}

.pane-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ==================== 空状态 ==================== */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-3xl) var(--spacing-lg);
  text-align: center;
}

.empty-icon {
  color: var(--text-tertiary);
  opacity: 0.5;
  margin-bottom: var(--spacing-md);
}

.empty-title {
  font-size: var(--font-size-base-plus);
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: var(--spacing-sm);
}

.empty-hint {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  line-height: 1.7;
}

.list-scroll {
  flex: 1;
  padding: var(--spacing-sm) var(--spacing-xs) var(--spacing-md);
}

/* ==================== 列表项 ==================== */
.list-item {
  padding: var(--spacing-sm-md);
  margin-bottom: var(--spacing-sm);
  border-radius: var(--border-radius);
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition: all 0.15s ease;
}

.list-item:hover {
  background: var(--bg-active);
  border-color: var(--primary);
}

/* 笔记项：左侧紫色竖条区分 */
.note-item {
  border-left: 3px solid var(--primary);
}

/* 划线项：左侧颜色竖条区分（颜色由 inline style 注入） */
.highlight-item {
  border-left: 3px solid var(--primary);
}

/* 划线项的原文引用：与笔记项保持一致风格 */
.highlight-item .item-quote {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-6px);
  padding: var(--spacing-sm) var(--spacing-10px);
  background: var(--bg-active);
  border-left: 3px solid var(--primary);
  border-radius: var(--border-radius-sm);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  line-height: 1.5;
  word-break: break-word;
}

.item-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-6px);
}

.item-time {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  margin-left: auto;
  white-space: nowrap;
}

.item-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-2xs);
}

.item-delete {
  opacity: 0.6;
  transition: opacity 0.15s ease;
}

.item-delete:hover {
  opacity: 1;
}

.item-delete:hover :deep(.n-icon) {
  color: var(--color-danger);
}

.item-content {
  font-size: var(--font-size-sm-plus);
  color: var(--text-secondary);
  line-height: 1.6;
  word-break: break-word;
}

.item-content.placeholder {
  color: var(--text-tertiary);
  font-style: italic;
}

/* ==================== 笔记项内容 ==================== */
/* 笔记项的原文引用：紫色左边线 + 微光背景 */
.note-item .item-quote {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-6px);
  padding: var(--spacing-sm) var(--spacing-10px);
  margin-bottom: var(--spacing-sm);
  background: var(--bg-active);
  border-left: 3px solid var(--primary);
  border-radius: var(--border-radius-sm);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  line-height: 1.5;
  word-break: break-word;
}

.quote-icon {
  color: var(--primary);
  margin-top: var(--spacing-2xs);
  flex-shrink: 0;
}

.item-note {
  font-size: var(--font-size-sm-plus);
  color: var(--text-primary);
  font-weight: 500;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
  padding: var(--spacing-6px) 0 var(--spacing-2xs);
  border-top: 1px dashed var(--border-color);
}

/* ==================== 编辑弹窗 ==================== */
.edit-label {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin-bottom: calc(var(--spacing-xs) * -1);
}

.edit-highlight-picker {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.edit-color-btn {
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

.edit-color-btn:hover {
  transform: scale(1.1);
}

.edit-color-btn.active {
  border-color: var(--primary);
}

.edit-color-dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: block;
}

.edit-color-none {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  font-weight: 500;
}

/* ==================== 笔记搜索框 ==================== */
.note-search {
  padding: var(--spacing-xs) var(--spacing-xs) 0;
  flex-shrink: 0;
}

/* ==================== 笔记颜色筛选 ==================== */
.note-color-filter {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-xs) var(--spacing-sm);
  flex-shrink: 0;
}

.filter-color-btn {
  width: 28px;
  height: 28px;
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
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.filter-color-btn:hover {
  transform: scale(1.1);
}

.filter-color-btn.active {
  border-color: var(--primary);
}

.filter-color-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: block;
}

/* ==================== 笔记章节分组 ==================== */
.note-group {
  margin-bottom: var(--spacing-md);
}

.note-group-title {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-weight: 500;
  padding: var(--spacing-2xs) var(--spacing-xs);
  margin-bottom: var(--spacing-sm);
  border-bottom: 1px solid var(--border-color);
}
</style>
