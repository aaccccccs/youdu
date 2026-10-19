<!--
  分组侧边栏（M5）

  功能：
  - "全部书籍"（无分组过滤）
  - "未分组"选项
  - 分组列表（可点击切换）
  - 每个分组右键：重命名/删除/上移/下移
  - 底部"新建分组"按钮
  - 分组可上下移动排序

  说明：通过 emit 通知父组件操作，由父组件调用 store actions。
-->
<script setup lang="ts">
import { computed, ref, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NIcon, NInput, NModal, NSpace, NText, NDropdown, useMessage } from 'naive-ui';
import type { DropdownOption } from 'naive-ui';
import {
  BookOpen,
  Folder,
  FolderPlus,
  Pencil,
  Trash,
  ChevronUp,
  ChevronDown,
  FileText,
  Image,
  BookImage
} from '@lucide/vue';
import type { Group, GroupFilter } from '@renderer/types';
import { useBookshelfStore } from '@renderer/stores';
import { useDropdownIcon, useContextMenu } from '@renderer/composables';

/** 组件属性 */
const props = defineProps<{
  /** 分组列表 */
  groups: Group[];
  /** 当前选中过滤 */
  current: GroupFilter;
  /** 分组书籍数量映射（分组 id → 数量），可选 */
  counts?: Record<number, number>;
}>();

/** 组件事件 */
const emit = defineEmits<{
  /** 切换分组过滤 */
  select: [filter: GroupFilter];
  /** 新建分组 */
  create: [name: string];
  /** 重命名分组 */
  rename: [id: number, name: string];
  /** 删除分组 */
  delete: [id: number];
  /** 上移分组 */
  'move-up': [id: number];
  /** 下移分组 */
  'move-down': [id: number];
  /** 打开书籍（跳转到阅读器） */
  'open-book': [id: number];
}>();

const message = useMessage();
const { t } = useI18n();

// ─── 右键菜单图标渲染（与 Bookshelf/Reader 统一） ───
const renderDropdownIcon = useDropdownIcon();

// ─── 书架 store（用于最近阅读和统计概览） ───
const bookshelfStore = useBookshelfStore();

/* ==================== 计算属性 ==================== */

/** 按 sort_order 排序的分组 */
const sortedGroups = computed((): Group[] => [...props.groups].sort((a, b) => a.sort_order - b.sort_order));

/** 是否选中「全部」 */
const isAll = computed((): boolean => props.current === null);

/** 获取分组数量 */
function getGroupCount(id: number): number | undefined {
  return props.counts?.[id];
}

/** 分组项无障碍标签（含名称与可选数量） */
function groupAriaLabel(group: Group): string {
  const count = getGroupCount(group.id);
  return count !== undefined
    ? t('group.aria.groupWithCount', { name: group.name, count })
    : t('group.aria.group', { name: group.name });
}

/* ==================== 智能分组数量徽章（P2-20 修复） ==================== */
/*
 * 问题：智能分组（文本/图文/漫画）没有显示数量徽章。
 * 修复：从 bookshelfStore.bookTypeCounts 获取各分类数量，
 * 在智能分组按钮上显示数量徽章。
 * 来源：经验库 2026-09-24-batch-ui-text-replacement-workflow（grep 定位 + 逐文件确认）
 */

/** 按内容类型分类的书籍数量（来自 store 计算属性） */
const bookTypeCounts = computed(() => bookshelfStore.bookTypeCounts);

/* ==================== 统计概览 ==================== */

/** 书架统计概览（来自 store） */
const stats = computed(() => bookshelfStore.stats);

/* ==================== 右键菜单（NDropdown） ==================== */

/** 右键菜单状态 */
const { contextMenuShow, contextMenuX, contextMenuY, openContextMenu, closeContextMenu } = useContextMenu();
const contextMenuGroup = ref<Group | null>(null);

/** 右键菜单选项 */
const contextMenuOptions = computed<DropdownOption[]>(() => {
  return [
    { label: t('common.actions.rename'), key: 'rename', icon: renderDropdownIcon(Pencil) },
    { label: t('group.actions.moveUp'), key: 'up', icon: renderDropdownIcon(ChevronUp) },
    { label: t('group.actions.moveDown'), key: 'down', icon: renderDropdownIcon(ChevronDown) },
    { type: 'divider', key: 'd1' },
    { label: t('group.actions.deleteGroup'), key: 'delete', icon: renderDropdownIcon(Trash) }
  ];
});

/** 分组项右键：显示 NDropdown 菜单 */
function handleContextMenu(e: MouseEvent, group: Group): void {
  e.preventDefault();
  e.stopPropagation();
  contextMenuGroup.value = group;
  openContextMenu(e.clientX, e.clientY);
}

/** 右键菜单选择处理 */
function handleContextMenuSelect(key: string | number): void {
  const group = contextMenuGroup.value;
  if (!group) return;
  closeContextMenu();

  switch (key) {
    case 'rename':
      openRenameModal(group);
      break;
    case 'up':
      emit('move-up', group.id);
      break;
    case 'down':
      emit('move-down', group.id);
      break;
    case 'delete':
      handleDeleteGroup(group);
      break;
  }
}

/* ==================== 新建分组 ==================== */

/** 新建分组 modal */
const showCreateModal = ref(false);

/** 新建分组名称 */
const newGroupName = ref('');

function openCreateModal(): void {
  newGroupName.value = '';
  showCreateModal.value = true;
}

function handleCreateConfirm(): void {
  const name = newGroupName.value.trim();
  if (!name) {
    message.warning(t('group.messages.nameRequired'));
    return;
  }
  emit('create', name);
  showCreateModal.value = false;
}

/* ==================== 重命名 ==================== */

/** 重命名 modal */
const showRenameModal = ref(false);

/** 重命名的分组 */
const renameTarget = ref<Group | null>(null);

/** 新名称 */
const renameName = ref('');

/** 重命名输入框引用 */
const renameInputRef = ref<InstanceType<typeof NInput> | null>(null);

function openRenameModal(group: Group): void {
  renameTarget.value = group;
  renameName.value = group.name;
  showRenameModal.value = true;
  // 自动聚焦输入框
  nextTick(() => {
    renameInputRef.value?.focus();
  });
}

function handleRenameConfirm(): void {
  if (!renameTarget.value) return;
  const name = renameName.value.trim();
  if (!name) {
    message.warning(t('group.messages.nameRequired'));
    return;
  }
  if (name === renameTarget.value.name) {
    showRenameModal.value = false;
    return;
  }
  emit('rename', renameTarget.value.id, name);
  showRenameModal.value = false;
}

/* ==================== 删除分组 ==================== */

/**
 * 删除分组：直接 emit 通知父组件，由父组件统一弹出确认对话框
 * 避免子组件和父组件两层确认对话框重复弹出
 */
function handleDeleteGroup(group: Group): void {
  emit('delete', group.id);
}

/* ==================== 选择分组 ==================== */

function selectAll(): void {
  emit('select', null);
}

function selectGroup(group: Group): void {
  emit('select', group.id);
}

/** 键盘激活分组项（Enter / Space） */
function handleGroupKeyActivate(group: Group): void {
  selectGroup(group);
}
</script>

<template>
  <div class="groupSidebar">
    <!-- 统计概览（置顶，卡片样式，固定不滚动） -->
    <div class="stats-card">
      <div class="sidebar-section-title">{{ t('group.stats.title') }}</div>
      <div class="stats-grid">
        <div class="stat-item">
          <span class="stat-value">{{ stats.total }}</span>
          <span class="stat-label">{{ t('group.stats.totalBooks') }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">{{ stats.reading }}</span>
          <span class="stat-label">{{ t('common.status.reading') }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">{{ stats.read }}</span>
          <span class="stat-label">{{ t('common.status.completed') }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">{{ stats.wantRead }}</span>
          <span class="stat-label">{{ t('common.status.wantToRead') }}</span>
        </div>
      </div>
    </div>

    <!-- 顶部：固定选项（全部书籍 + 智能分组，卡片样式，固定不滚动） -->
    <div class="filter-card">
      <div class="groupItem" :class="{ active: isAll }" @click="selectAll">
        <n-icon :component="BookOpen" :size="16" />
        <span class="groupName">{{ t('group.filters.allBooks') }}</span>
      </div>
      <!-- 智能分组（按书籍类型自动分类，v21 content_type 三分类） -->
      <!-- P2-20 修复：添加数量徽章显示各分类的书籍数量 -->
      <div class="groupItem smartGroup" :class="{ active: current === 'text' }" @click="emit('select', 'text')">
        <n-icon :component="FileText" :size="16" />
        <span class="groupName">{{ t('common.bookType.text') }}</span>
        <span v-if="bookTypeCounts.text > 0" class="groupCountBadge">{{ bookTypeCounts.text }}</span>
      </div>
      <div
        class="groupItem smartGroup"
        :class="{ active: current === 'illustrated' }"
        @click="emit('select', 'illustrated')"
      >
        <n-icon :component="Image" :size="16" />
        <span class="groupName">{{ t('common.bookType.illustrated') }}</span>
        <span v-if="bookTypeCounts.illustrated > 0" class="groupCountBadge">{{ bookTypeCounts.illustrated }}</span>
      </div>
      <div class="groupItem smartGroup" :class="{ active: current === 'comic' }" @click="emit('select', 'comic')">
        <n-icon :component="BookImage" :size="16" />
        <span class="groupName">{{ t('common.bookType.comic') }}</span>
        <span v-if="bookTypeCounts.comic > 0" class="groupCountBadge">{{ bookTypeCounts.comic }}</span>
      </div>
    </div>

    <!-- 分组列表（可滚动区域） -->
    <div class="groups-section">
      <div class="sectionTitle">
        <span>{{ t('common.words.group') }}</span>
        <n-button size="tiny" quaternary circle @click="openCreateModal" :title="t('group.actions.newGroup')">
          <template #icon>
            <n-icon :component="FolderPlus" :size="14" />
          </template>
        </n-button>
      </div>

      <div v-if="sortedGroups.length === 0" class="emptyGroups">
        <n-text depth="3" style="font-size: var(--font-size-xs)">{{ t('group.groups.empty') }}</n-text>
      </div>

      <div
        v-for="group in sortedGroups"
        :key="group.id"
        class="groupItem"
        :class="{ active: current === group.id }"
        role="button"
        tabindex="0"
        :aria-label="groupAriaLabel(group)"
        @click="selectGroup(group)"
        @contextmenu="handleContextMenu($event, group)"
        @keydown.enter="handleGroupKeyActivate(group)"
        @keydown.space.prevent="handleGroupKeyActivate(group)"
      >
        <n-icon :component="Folder" :size="16" />
        <span class="groupName" :title="group.name">{{ group.name }}</span>

        <!-- 数量徽章 -->
        <span v-if="getGroupCount(group.id) !== undefined" class="groupCountBadge">{{ getGroupCount(group.id) }}</span>
      </div>
    </div>

    <!-- 底部新建分组按钮 -->
    <div class="sidebarFooter">
      <n-button block size="small" @click="openCreateModal">
        <template #icon>
          <n-icon :component="FolderPlus" />
        </template>
        {{ t('group.actions.newGroup') }}
      </n-button>
    </div>

    <!-- 新建分组对话框 -->
    <n-modal
      v-model:show="showCreateModal"
      preset="card"
      :title="t('group.createModal.title')"
      :bordered="false"
      style="width: 420px; max-width: 90vw"
    >
      <n-space vertical :size="12">
        <n-input
          v-model:value="newGroupName"
          :placeholder="t('group.createModal.namePlaceholder')"
          maxlength="20"
          show-count
          @keyup.enter="handleCreateConfirm"
        />
        <n-space justify="end">
          <n-button @click="showCreateModal = false">{{ t('common.actions.cancel') }}</n-button>
          <n-button type="primary" @click="handleCreateConfirm">{{ t('common.actions.confirm') }}</n-button>
        </n-space>
      </n-space>
    </n-modal>

    <!-- 重命名对话框 -->
    <n-modal
      v-model:show="showRenameModal"
      preset="card"
      :title="t('group.renameModal.title')"
      :bordered="false"
      style="width: 420px; max-width: 90vw"
    >
      <n-space vertical :size="12">
        <n-input
          ref="renameInputRef"
          v-model:value="renameName"
          :placeholder="t('group.renameModal.namePlaceholder')"
          maxlength="20"
          show-count
          @keyup.enter="handleRenameConfirm"
        />
        <n-space justify="end">
          <n-button @click="showRenameModal = false">{{ t('common.actions.cancel') }}</n-button>
          <n-button type="primary" @click="handleRenameConfirm">{{ t('common.actions.confirm') }}</n-button>
        </n-space>
      </n-space>
    </n-modal>

    <!-- 分组右键菜单（NDropdown，与书架/阅读器保持一致） -->
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
  </div>
</template>

<style scoped>
.groupSidebar {
  display: flex;
  flex-direction: column;
  /* 用 flex:1 代替 height:100%，在 flex 父容器中更可靠地拉伸到全高 */
  flex: 1;
  min-height: 0;
  padding: var(--spacing-md) var(--spacing-sm);
  overflow: hidden; /* 整体不滚动，仅分组列表区域滚动 */
  background: color-mix(in srgb, var(--bg-card) 75%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-right: 1px solid var(--border-color);
}

/* ==================== 卡片通用样式 ==================== */
/* 统计卡片、全部书籍+智能分组卡片 共用基础样式 */
.stats-card,
.filter-card {
  background: var(--bg-elevated, color-mix(in srgb, var(--bg-card) 90%, transparent));
  border-radius: var(--border-radius);
  border: 1px solid var(--border-color);
  padding: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
  flex-shrink: 0;
}

/* ==================== 统计概览区域 ==================== */
/* .stats-card 卡片样式已在上方与 .filter-card 统一定义 */
/* 此处保留统计概览区域内部元素的样式 */

.sidebar-section-title {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  font-weight: 600;
  margin-bottom: var(--spacing-xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--spacing-sm);
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-2xs);
}

.stat-value {
  font-size: var(--font-size-lg);
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.stat-label {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
}

/* ==================== 分组列表区域（可滚动，卡片样式） ==================== */
/* 与 .stats-card / .filter-card 统一卡片外观 */
.groups-section {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden; /* 防止操作菜单等子元素溢出产生横向滚动条 */
  display: flex;
  flex-direction: column;
  /* 卡片样式 */
  background: var(--bg-elevated, color-mix(in srgb, var(--bg-card) 90%, transparent));
  border-radius: var(--border-radius);
  border: 1px solid var(--border-color);
  padding: var(--spacing-sm);
}

.sectionTitle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-xs) var(--spacing-sm);
  margin-bottom: var(--spacing-xs);
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.groupItem {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  /* 分组项高度 36px */
  height: 36px;
  padding: 0 var(--spacing-10px);
  border-radius: var(--border-radius-sm);
  cursor: pointer;
  font-size: var(--font-size-sm-plus);
  color: var(--text-secondary);
  transition:
    background 0.15s ease,
    color 0.15s ease;
  position: relative;
  user-select: none;
}

.groupItem:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 当前分组高亮：左侧 3px 紫色竖条 + 半透明紫色背景 */
.groupItem.active {
  background: var(--bg-primary-active);
  color: var(--primary);
  font-weight: 500;
}

.groupItem.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: var(--spacing-6px);
  bottom: var(--spacing-6px);
  width: var(--spacing-3px);
  border-radius: 0 var(--border-radius-xs) var(--border-radius-xs) 0;
  background: var(--primary);
}

.groupName {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 分组数量徽章 */
.groupCountBadge {
  flex-shrink: 0;
  min-width: 20px;
  height: 18px;
  padding: 0 var(--spacing-6px);
  border-radius: 9px;
  background: var(--bg-badge);
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  font-weight: 500;
  line-height: 1.5;
  text-align: center;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.groupItem.active .groupCountBadge {
  background: var(--bg-primary-badge);
  color: var(--primary);
}

.groupItem:hover .groupCountBadge {
  background: var(--bg-badge-hover);
  color: var(--text-secondary);
}

.emptyGroups {
  padding: var(--spacing-sm) var(--spacing-10px);
  text-align: center;
}

.sidebarFooter {
  margin-top: auto;
  padding: var(--spacing-sm);
}
</style>
