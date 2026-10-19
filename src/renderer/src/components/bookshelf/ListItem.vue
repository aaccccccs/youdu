<!--
  列表书籍项（M5）

  功能：
  - 小封面缩略图（48x64，3:4 比例）
  - 书名 + 作者 + 章节数 + 最近阅读时间
  - 点击跳转阅读器
  - 右键菜单（同 GridItem）
  - 多选支持
  - 选中状态：左侧高亮条 + 背景色

  共享逻辑通过 useBookItem composable 复用（封面 URL、点击/键盘激活、右键菜单等）。
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NIcon, NCheckbox } from 'naive-ui';
import { Check } from '@lucide/vue';
import type { Book } from '@renderer/types';
import { useBookItem, useCover } from '@renderer/composables';

/** 组件属性 */
const props = defineProps<{
  /** 书籍数据 */
  book: Book;
  /** 是否选中 */
  selected?: boolean;
  /** 是否处于多选模式 */
  selectionMode?: boolean;
}>();

/** 组件事件 */
const emit = defineEmits<{
  /** 点击书籍（非多选模式下跳转阅读器） */
  open: [book: Book];
  /** 切换选中状态 */
  'toggle-select': [id: number];
  /** 右键菜单 */
  contextmenu: [book: Book, x: number, y: number];
}>();

const { t } = useI18n();

/* ==================== 共享逻辑（useBookItem + useCover） ==================== */

const { relativeTime, authorText, handleClick, handleKeyActivate, handleContextmenu, handleCheckboxClick } =
  useBookItem(
    () => props.book,
    () => props.selectionMode ?? false,
    emit
  );

/** 封面 URL（含加载失败回退）+ 加载失败状态 + 错误处理 */
const { coverUrl, onCoverError } = useCover(() => props.book);

/* ==================== ListItem 专属逻辑 ==================== */

/** 章节数文本 */
const chaptersText = computed((): string => {
  const n = props.book.total_chapters;
  if (n === null || n === undefined) return t('item.unknownChapters');
  return t('item.chapters', { n });
});

/** 用于 aria-label 的描述文字 */
const ariaLabel = computed((): string =>
  t('item.aria.listBook', {
    title: props.book.title,
    author: authorText.value,
    chapters: chaptersText.value,
    time: relativeTime.value
  })
);
</script>

<template>
  <div
    class="listItem"
    :class="{
      selected: selected,
      selectionMode: selectionMode
    }"
    role="button"
    tabindex="0"
    :aria-label="ariaLabel"
    @click="handleClick"
    @contextmenu="handleContextmenu"
    @keydown.enter="handleKeyActivate"
    @keydown.space.prevent="handleKeyActivate"
  >
    <!-- 多选复选框 -->
    <div v-if="selectionMode" class="checkboxCell" @click="handleCheckboxClick">
      <n-checkbox :checked="selected" />
    </div>

    <!-- 封面缩略图 -->
    <div class="coverCell">
      <img
        :src="coverUrl"
        class="cover"
        loading="lazy"
        :alt="t('item.coverAlt')"
        draggable="false"
        @error="onCoverError"
      />
    </div>

    <!-- 书籍信息 -->
    <div class="infoCell">
      <div class="infoRow1">
        <span class="bookTitle" :title="book.title">{{ book.title }}</span>
        <span class="bookAuthor">{{ authorText }}</span>
      </div>
      <div class="infoRow2">
        <span class="metaItem">{{ chaptersText }}</span>
      </div>
    </div>

    <!-- 右侧时间 -->
    <div class="timeCell">
      <span class="timeText">{{ relativeTime }}</span>
    </div>

    <!-- 选中标记（非多选模式下，Ctrl 选中时显示） -->
    <div v-if="selected && !selectionMode" class="checkBadge">
      <n-icon :component="Check" :size="12" color="var(--bg-base)" />
    </div>
  </div>
</template>

<style scoped>
.listItem {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm-md);
  /* 高度填满虚拟列表 wrapper（80px），box-sizing 包含 border，
     去掉垂直 padding 用 flex centering 居中，确保实际高度 = LIST_ITEM_SIZE */
  height: 100%;
  padding: 0 var(--spacing-sm-md);
  cursor: pointer;
  border-radius: var(--border-radius-sm);
  /* 底部分割线 */
  border-bottom: 1px solid var(--border-color);
  transition: background 0.15s ease;
  user-select: none;
  position: relative;
  /* 宽度自适应容器，不随书名长度变化 */
  width: 100%;
  box-sizing: border-box;
}

.listItem:hover {
  background: var(--bg-hover);
}

.listItem.selected {
  background: var(--bg-active);
}

/* 选中状态左侧高亮条 */
.listItem.selected::before {
  content: '';
  position: absolute;
  left: 0;
  top: var(--spacing-sm);
  bottom: var(--spacing-sm);
  width: var(--spacing-3px);
  border-radius: var(--border-radius-xs);
  background: var(--primary);
}

/* 复选框 */
.checkboxCell {
  flex-shrink: 0;
  width: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 封面缩略图 */
.coverCell {
  flex-shrink: 0;
  width: 48px;
  height: 64px;
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  background: var(--bg-card);
  box-shadow: var(--shadow-card);
}

.cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* 书籍信息 */
.infoCell {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-6px);
}

.infoRow1 {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
  min-width: 0;
}

.bookTitle {
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
  min-width: 0;
  line-height: 1.4;
}

.bookAuthor {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
  line-height: 1.4;
}

.infoRow2 {
  display: flex;
  align-items: center;
  gap: var(--spacing-6px);
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.metaItem {
  white-space: nowrap;
  line-height: 1.4;
}

/* 右侧时间 */
.timeCell {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.timeText {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  white-space: nowrap;
  line-height: 1.4;
}

/* 选中徽章 */
.checkBadge {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: var(--shadow-primary);
}
</style>
