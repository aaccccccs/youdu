<!--
  九宫格书籍项（M5）

  功能：
  - 3:4 比例封面（有封面用图片，无封面用 SVG 生成）
  - 书名（下方，单行省略）
  - 作者（更小字，单行省略）
  - 最近阅读时间（相对时间）
  - 点击跳转阅读器 /reader/:bookId
  - 右键菜单（打开/详情/删除/移动到分组）
  - 多选模式下点击选中而非跳转
  - 选中状态：边框高亮 + 勾选标记

  共享逻辑通过 useBookItem composable 复用（封面 URL、点击/键盘激活、右键菜单等）。
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NCheckbox } from 'naive-ui';
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
const { coverUrl, coverLoadFailed, onCoverError } = useCover(() => props.book);

/* ==================== GridItem 专属逻辑 ==================== */

/** 是否有真实封面（用于决定是否加 object-fit） */
const hasRealCover = computed((): boolean => !!props.book.cover);

/** 用于 aria-label 的描述文字 */
const ariaLabel = computed((): string =>
  t('item.aria.gridBook', { title: props.book.title, author: authorText.value, time: relativeTime.value })
);

/**
 * 阅读状态徽章信息（对标 Kindle，封面右上角）
 *
 * - reading     → 在读（半透明蓝色）
 * - completed   → 已读（半透明绿色）
 * - want_to_read→ 想读（半透明橙色）
 * - dropped/null→ 不显示
 */
const readingStatusBadge = computed<{ text: string; cls: string } | null>((): { text: string; cls: string } | null => {
  switch (props.book.reading_status) {
    case 'reading':
      return { text: t('common.status.reading'), cls: 'badge-reading' };
    case 'completed':
      return { text: t('common.status.completed'), cls: 'badge-completed' };
    case 'want_to_read':
      return { text: t('common.status.wantToRead'), cls: 'badge-wanted' };
    default:
      return null;
  }
});

/**
 * 类型标识（封面左下角）
 *
 * 五类标签：
 * - file_type === 'rss' → 文章（橙色，RSS 订阅文章，不走小说/图文/漫画分类）
 * - book_source === 'download' + catalog_url → OPDS（青色，OPDS 书库下载）
 * - book_category === 'comic' → 漫画（紫色）
 * - book_category === 'illustrated' → 图文（蓝色）
 * - book_category === 'text' → 小说（绿色）
 *
 * RSS 和 OPDS 采用独立标签，不参与小说/图文/漫画分类。
 * 分类规则（后端 SQL 计算）：
 * - is_comic=1 → 漫画
 * - 图片章节数 > 1 → 图文
 * - 图片章节数 ≤ 1（只有封面或无图）→ 小说
 */
const typeBadge = computed<{ text: string; cls: string } | null>((): { text: string; cls: string } | null => {
  // RSS 文章：独立标签，不走小说/图文/漫画分类
  if (props.book.file_type === 'rss') return { text: t('common.words.article'), cls: 'badge-article' };
  // OPDS 书库下载：独立标签
  if (props.book.book_source === 'download' && props.book.catalog_url) return { text: 'OPDS', cls: 'badge-opds' };
  const cat = props.book.book_category;
  if (cat === 'comic') return { text: t('common.bookType.comic'), cls: 'badge-comic' };
  if (cat === 'illustrated') return { text: t('common.bookType.illustrated'), cls: 'badge-illustrated' };
  if (cat === 'text') return { text: t('item.type.novel'), cls: 'badge-novel' };
  // v21 fallback：优先用 content_type 判断，兼容 is_comic
  if (props.book.content_type === 'comic' || props.book.is_comic === 1)
    return { text: t('common.bookType.comic'), cls: 'badge-comic' };
  if (props.book.content_type === 'illustrated')
    return { text: t('common.bookType.illustrated'), cls: 'badge-illustrated' };
  return null;
});

/**

 * 是否有新更新（订阅源检测到新内容时 has_update=1）
 *
 * 用于在封面右上角显示红色圆点徽章，提示用户该书有新内容。
 * 与阅读状态徽章错位显示：阅读状态在右上角，更新红点在右下角。
 */
const hasUpdate = computed((): boolean => props.book.has_update === 1);
</script>

<template>
  <div
    class="gridItem"
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
    <!-- 封面区域 -->
    <div class="coverWrap">
      <!--
        无封面时 coverUrl 由 useBookItem → generateCoverDataUrl 生成 SVG，
        该 SVG 已在中央渲染书名首字（font-size 120, font-weight 700）+ 书名 + 作者，
        故此处无需再用 CSS 叠加首字（避免重复显示）。
      -->
      <img
        :src="coverUrl"
        class="cover"
        :class="{ realCover: hasRealCover && !coverLoadFailed }"
        loading="lazy"
        :alt="t('item.coverAlt')"
        draggable="false"
        @error="onCoverError"
      />

      <!-- 阅读状态徽章（右上角，对标 Kindle） -->
      <div v-if="readingStatusBadge" class="statusBadge" :class="readingStatusBadge.cls">
        {{ readingStatusBadge.text }}
      </div>

      <!-- 类型标识（左下角，漫画/图文） -->
      <div v-if="typeBadge" class="typeBadge" :class="typeBadge.cls">
        {{ typeBadge.text }}
      </div>

      <!-- 更新红点徽章（右下角，订阅源检测到新内容时显示） -->
      <div v-if="hasUpdate" class="updateDot" :title="t('item.hasUpdate')">
        <span class="updateDotInner" />
      </div>

      <!-- 多选复选框（多选模式下显示在左上角） -->
      <div v-if="selectionMode" class="checkboxCorner" @click="handleCheckboxClick">
        <n-checkbox :checked="selected" />
      </div>
    </div>

    <!-- 书籍信息 -->
    <div class="bookInfo">
      <div class="bookTitle" :title="book.title">{{ book.title }}</div>
      <div class="bookAuthor" :title="authorText">{{ authorText }}</div>
      <div class="bookTime">{{ relativeTime }}</div>
    </div>
  </div>
</template>

<style scoped>
.gridItem {
  display: flex;
  flex-direction: column;
  cursor: pointer;
  border-radius: var(--border-radius);
  transition:
    transform 0.25s ease-out,
    background 0.25s ease-out;
  user-select: none;
  will-change: transform;
  /* P0-2: 虚拟渲染优化——跳过屏幕外卡片的渲染/绘制，大幅提升 1000+ 本书时的滚动性能 */
  content-visibility: auto;
  contain-intrinsic-size: 160px 280px;
}

.gridItem:hover {
  background: var(--bg-hover);
  transform: translateY(-4px);
}

.gridItem:active {
  transform: translateY(-2px) scale(0.98);
}

/* 选中状态：紫色边框 + 半透明紫色遮罩 */
.gridItem.selected {
  background: var(--bg-active);
  outline: 2px solid var(--primary);
  outline-offset: -2px;
  border-radius: var(--border-radius);
}

/* 封面容器 */
.coverWrap {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: var(--border-radius);
  overflow: hidden;
  background: var(--bg-card);
  box-shadow: var(--shadow-card);
  transition: box-shadow 0.25s ease-out;
}

/* 悬停时封面阴影加深（叠加更深的投影） */
.gridItem:hover .coverWrap {
  box-shadow: var(--shadow-hover), var(--shadow-card-extra);
}

/* 悬停时封面高光叠层 */
.coverWrap::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--bg-highlight) 0%, transparent 50%);
  opacity: 0;
  transition: opacity 0.25s ease-out;
  pointer-events: none;
  border-radius: var(--border-radius);
}

.gridItem:hover .coverWrap::after {
  opacity: 1;
}

/* 选中时封面紫色遮罩 */
.gridItem.selected .coverWrap::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--bg-primary-overlay);
  pointer-events: none;
  z-index: 1;
  border-radius: var(--border-radius);
}

/* 封面图片 */
.cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.25s ease-out;
  will-change: transform;
}

.cover.realCover {
  object-fit: cover;
}

/* 悬停时封面微缩放 */
.gridItem:hover .cover {
  transform: scale(1.02);
}

/* ─── 阅读状态徽章（封面右上角，对标 Kindle） ─── */
.statusBadge {
  position: absolute;
  right: var(--spacing-sm);
  top: var(--spacing-sm);
  z-index: 2;
  padding: var(--spacing-2xs) var(--spacing-sm);
  border-radius: var(--border-radius-sm);
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1.5;
  color: var(--text-on-primary);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  pointer-events: none;
  letter-spacing: 0.5px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

/* 在读：半透明蓝色 */
.statusBadge.badge-reading {
  background: var(--badge-info);
}

/* 已读：半透明绿色 */
.statusBadge.badge-completed {
  background: var(--badge-success);
}

/* 想读：半透明橙色 */
.statusBadge.badge-wanted {
  background: var(--badge-warning);
}

/* ─── 类型标识（封面左下角） ─── */
.typeBadge {
  position: absolute;
  left: var(--spacing-sm);
  bottom: var(--spacing-sm);
  z-index: 2;
  padding: var(--spacing-2xs) var(--spacing-sm);
  border-radius: var(--border-radius-sm);
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1.5;
  color: var(--text-on-primary);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  pointer-events: none;
  letter-spacing: 0.5px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

/* 漫画：半透明紫色 */
.typeBadge.badge-comic {
  background: var(--badge-primary);
}

/* 图文：半透明蓝色 */
.typeBadge.badge-illustrated {
  background: var(--badge-info);
}

/* 小说：半透明绿色 */
.typeBadge.badge-novel {
  background: var(--badge-success);
}

/* 文章（RSS）：半透明橙色 */
.typeBadge.badge-article {
  background: var(--badge-warning);
}

/* OPDS 书库：半透明青色 */
.typeBadge.badge-opds {
  background: color-mix(in srgb, var(--primary) 60%, var(--badge-info));
}

/* ─── 更新红点徽章（封面右下角，订阅源新内容提示） ─── */
.updateDot {
  position: absolute;
  right: var(--spacing-sm);
  bottom: var(--spacing-sm);
  z-index: 2;
  width: 10px;
  height: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.updateDotInner {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-danger);
  box-shadow:
    0 0 4px color-mix(in srgb, var(--color-danger) 60%, transparent),
    0 0 0 2px rgba(255, 255, 255, 0.3);
  animation: updatePulse 2s ease-in-out infinite;
}

@keyframes updatePulse {
  0%,
  100% {
    box-shadow:
      0 0 4px color-mix(in srgb, var(--color-danger) 60%, transparent),
      0 0 0 2px rgba(255, 255, 255, 0.3);
  }
  50% {
    box-shadow:
      0 0 8px color-mix(in srgb, var(--color-danger) 80%, transparent),
      0 0 0 3px rgba(255, 255, 255, 0.4);
  }
}

/* 多选复选框（左上角） */
.checkboxCorner {
  position: absolute;
  left: var(--spacing-sm);
  top: var(--spacing-sm);
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elevated);
  border-radius: var(--border-radius-sm);
  z-index: 2;
  backdrop-filter: blur(4px);
}

/* 书籍信息区域 */
.bookInfo {
  padding: var(--spacing-10px) var(--spacing-2xs) var(--spacing-xs);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-3px);
}

.bookTitle {
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.bookAuthor {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.bookTime {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  line-height: 1.4;
  margin-top: var(--spacing-2xs);
}
</style>
