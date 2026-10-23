<!--
  订阅源卡片组件

  功能：
  - 显示订阅源信息：名称、类型图标、URL、上次检查时间、关联书籍数、有更新数
  - 操作按钮组：检查更新、编辑、删除
  - 启用/禁用切换开关
  - 有更新时显示红色徽章
  - 禁用状态半透明显示

  样式与书架 GridItem 保持一致（玻璃质感、悬停上浮、CSS 变量）。
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NCard, NButton, NIcon, NSwitch, NTag, NTooltip } from 'naive-ui';
import { Folder, Rss, Globe, RefreshCw, Pencil, Trash, BookOpen, Clock, AlertCircle } from '@lucide/vue';
import type { Subscription } from '@renderer/types';
import type { SubscriptionStat } from '@renderer/stores';

const { t } = useI18n();

/** 组件属性 */
const props = defineProps<{
  /** 订阅数据 */
  subscription: Subscription;
  /** 统计信息 */
  stat?: SubscriptionStat;
  /** 是否正在检查更新 */
  checking?: boolean;
}>();

/** 组件事件 */
const emit = defineEmits<{
  /** 检查更新 */
  check: [id: number];
  /** 编辑 */
  edit: [subscription: Subscription];
  /** 删除 */
  delete: [id: number];
  /** 切换启用/禁用 */
  'toggle-enabled': [id: number];
}>();

/* ==================== 类型图标映射 ==================== */

/** 根据订阅类型返回图标组件 */
const typeIcon = computed((): typeof Folder => {
  switch (props.subscription.type) {
    case 'folder':
      return Folder;
    case 'rss':
      return Rss;
    default:
      return Folder;
  }
});

/** 根据订阅类型返回本地化名称 */
const typeName = computed((): string => {
  switch (props.subscription.type) {
    case 'folder':
      return t('subscription.typeFolder');
    case 'rss':
      return 'RSS';
    default:
      return t('common.words.unknown');
  }
});

/* ==================== 显示信息 ==================== */

/** 是否有更新 */
const hasUpdate = computed((): boolean => (props.stat?.updateCount ?? 0) > 0);

/** 关联书籍数 */
const bookCount = computed((): number => props.stat?.bookCount ?? 0);

/** 有更新数 */
const updateCount = computed((): number => props.stat?.updateCount ?? 0);

/** 是否启用 */
const enabled = computed<boolean>({
  get: (): boolean => props.subscription.enabled === 1,
  set: (): void => {
    emit('toggle-enabled', props.subscription.id);
  }
});

/** 上次检查时间（友好格式） */
const lastCheckText = computed((): string => {
  const ts = props.subscription.last_check_at;
  if (!ts) return t('subscription.neverChecked');
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60000) return t('subscription.justNow');
  if (diff < 3600000) return t('subscription.minutesAgo', { n: Math.floor(diff / 60000) });
  if (diff < 86400000) return t('subscription.hoursAgo', { n: Math.floor(diff / 3600000) });
  if (diff < 604800000) return t('subscription.daysAgo', { n: Math.floor(diff / 86400000) });
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});

/** URL 显示文本（过长截断） */
const urlDisplay = computed((): string => {
  const url = props.subscription.url;
  if (url.length > 50) return url.slice(0, 47) + '...';
  return url;
});

/* ==================== 事件处理 ==================== */

/** 检查更新 */
function handleCheck(): void {
  emit('check', props.subscription.id);
}

/** 编辑 */
function handleEdit(): void {
  emit('edit', props.subscription);
}

/** 删除 */
function handleDelete(): void {
  emit('delete', props.subscription.id);
}
</script>

<template>
  <div class="subscription-card-wrap" :class="{ disabled: !enabled }">
    <n-card class="subscription-card" :bordered="true">
      <!-- 头部：类型图标 + 名称 + 更新徽章 -->
      <template #header>
        <div class="card-header">
          <div class="card-title-area">
            <n-icon :component="typeIcon" :size="18" class="type-icon" />
            <span class="card-title" :title="subscription.name">{{ subscription.name }}</span>
          </div>
          <div class="card-badges">
            <!-- 有更新红色徽章 -->
            <span v-if="hasUpdate" class="update-badge">
              {{ t('subscription.updatesBadge', { n: updateCount }) }}
            </span>
            <n-tag size="small" :type="enabled ? 'success' : 'default'" round>
              {{ typeName }}
            </n-tag>
          </div>
        </div>
      </template>

      <!-- 内容区 -->
      <div class="card-content">
        <!-- URL/路径 -->
        <div class="info-row">
          <n-icon :component="subscription.type === 'folder' ? Folder : Globe" :size="14" class="info-icon" />
          <span class="info-text" :title="subscription.url">{{ urlDisplay }}</span>
        </div>

        <!-- 统计信息 -->
        <div class="info-row">
          <n-icon :component="BookOpen" :size="14" class="info-icon" />
          <span class="info-text">{{ t('subscription.bookCount', { n: bookCount }) }}</span>
          <span v-if="hasUpdate" class="update-count-text">
            <n-icon :component="AlertCircle" :size="12" />
            {{ t('subscription.updatesInline', { n: updateCount }) }}
          </span>
        </div>

        <!-- 上次检查时间 -->
        <div class="info-row">
          <n-icon :component="Clock" :size="14" class="info-icon" />
          <span class="info-text">{{ lastCheckText }}</span>
        </div>
      </div>

      <!-- 操作区 -->
      <template #action>
        <div class="card-actions">
          <!-- 左侧：启用/禁用开关 -->
          <div class="action-left">
            <n-tooltip placement="top">
              <template #trigger>
                <n-switch v-model:value="enabled" size="small" />
              </template>
              {{ enabled ? t('subscription.enabled') : t('subscription.disabled') }}
            </n-tooltip>
          </div>

          <!-- 右侧：操作按钮 -->
          <div class="action-right">
            <n-button
              size="small"
              quaternary
              :loading="checking"
              :title="t('subscription.checkUpdate')"
              @click="handleCheck"
            >
              <template #icon>
                <n-icon :component="RefreshCw" :size="16" />
              </template>
            </n-button>

            <n-button size="small" quaternary :title="t('common.actions.edit')" @click="handleEdit">
              <template #icon>
                <n-icon :component="Pencil" :size="16" />
              </template>
            </n-button>

            <n-button size="small" quaternary type="error" :title="t('common.actions.delete')" @click="handleDelete">
              <template #icon>
                <n-icon :component="Trash" :size="16" />
              </template>
            </n-button>
          </div>
        </div>
      </template>
    </n-card>
  </div>
</template>

<style scoped>
.subscription-card-wrap {
  transition: opacity 0.25s ease;
}

.subscription-card-wrap.disabled {
  opacity: 0.55;
}

.subscription-card {
  border-radius: var(--border-radius);
  transition:
    transform 0.25s ease-out,
    box-shadow 0.25s ease-out;
}

.subscription-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-hover);
}

/* 头部 */
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  min-width: 0;
}

.card-title-area {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
  flex: 1;
}

.type-icon {
  color: var(--primary);
  flex-shrink: 0;
}

.card-title {
  font-size: var(--font-size-base-plus);
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-badges {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex-shrink: 0;
}

/* 更新徽章 */
.update-badge {
  display: inline-flex;
  align-items: center;
  padding: var(--spacing-2xs) var(--spacing-sm);
  border-radius: var(--border-radius-sm);
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1.5;
  color: var(--text-on-primary);
  background: color-mix(in srgb, var(--color-danger) 85%, transparent);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  letter-spacing: 0.5px;
}

/* 内容区 */
.card-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) 0;
}

.info-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  min-width: 0;
}

.info-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.info-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.update-count-text {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-2xs);
  color: var(--color-danger);
  font-size: var(--font-size-sm);
}

/* 操作区 */
.card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
}

.action-left {
  display: flex;
  align-items: center;
}

.action-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-2xs);
}
</style>
