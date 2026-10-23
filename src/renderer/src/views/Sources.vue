<!--
  订阅页面 — OPDS 书库与 RSS 订阅的统一入口

  布局：复用 Bookshelf 的 toolbar 模式（48px 琉璃质感）
  - toolbar-left：tab 按钮（书库 / 订阅）
  - toolbar-right：操作按钮（根据 activeTab 用 v-if 切换，ref 调用子组件方法）
  - 内容区：v-show 切换子组件（始终挂载）

  设计要点：
  - tab 和操作按钮在同一行，无冗余工具栏
  - 不用 Teleport，用 ref + defineExpose 通信
  - 琉璃质感、48px 高度，和 Bookshelf/Settings 统一
  - Tab 状态持久化到 URL query（?tab=rss），刷新后保持
-->
<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NButton, NIcon, NInput } from 'naive-ui';
import { Search, Plus, RefreshCw } from '@lucide/vue';
import OpdsBrowser from '@renderer/views/OpdsBrowser.vue';
import Subscriptions from '@renderer/views/Subscriptions.vue';

const { t } = useI18n();

const route = useRoute();
const router = useRouter();

const activeTab = ref<'rss' | 'opds'>('rss');

/** 子组件 ref */
const opdsRef = ref<InstanceType<typeof OpdsBrowser> | null>(null);
const subRef = ref<InstanceType<typeof Subscriptions> | null>(null);

/** 搜索关键词（双向绑定到 OpdsBrowser） */
const opdsSearch = ref('');

onMounted(() => {
  const tab = route.query.tab;
  if (tab === 'opds') activeTab.value = 'opds';
});

watch(activeTab, (tab) => {
  router.replace({ path: '/sources', query: { tab } });
});

/** 搜索 */
function handleOpdsSearch(): void {
  opdsRef.value?.handleSearch(opdsSearch.value);
}

/** 打开添加目录对话框 */
function handleOpenAddCatalog(): void {
  if (opdsRef.value) {
    opdsRef.value.showAddDialog = true;
  }
}

/** 全部检查更新 */
function handleCheckAll(): void {
  subRef.value?.handleCheckAll();
}

/** 打开添加订阅对话框 */
function handleOpenAddSub(): void {
  subRef.value?.openAddDialog();
}
</script>

<template>
  <div class="sources-root">
    <!-- 统一 toolbar：tab + 操作按钮 同一行 -->
    <header class="toolbar">
      <div class="toolbar-left">
        <button class="tab-item" :class="{ active: activeTab === 'rss' }" @click="activeTab = 'rss'">
          {{ t('sources.tabs.rss') }}
        </button>
        <button class="tab-item" :class="{ active: activeTab === 'opds' }" @click="activeTab = 'opds'">
          {{ t('sources.tabs.opds') }}
        </button>
      </div>
      <div class="toolbar-right">
        <!-- 书库 tab 的操作按钮 -->
        <template v-if="activeTab === 'opds'">
          <n-input
            v-if="opdsRef?.currentCatalog"
            v-model:value="opdsSearch"
            :placeholder="t('sources.searchPlaceholder')"
            size="small"
            clearable
            style="width: 200px"
            @keyup.enter="handleOpdsSearch"
          >
            <template #prefix>
              <n-icon :component="Search" :size="14" />
            </template>
          </n-input>
          <n-button type="primary" size="small" @click="handleOpenAddCatalog">
            <template #icon>
              <n-icon :component="Plus" :size="16" />
            </template>
            {{ t('sources.addCatalog') }}
          </n-button>
        </template>
        <!-- 订阅 tab 的操作按钮 -->
        <template v-if="activeTab === 'rss'">
          <n-button v-if="subRef?.hasSubscriptions" size="small" :loading="subRef?.checking" @click="handleCheckAll">
            <template #icon>
              <n-icon :component="RefreshCw" :size="16" />
            </template>
            {{ t('sources.checkAll') }}
          </n-button>
          <n-button type="primary" size="small" @click="handleOpenAddSub">
            <template #icon>
              <n-icon :component="Plus" :size="16" />
            </template>
            {{ t('sources.addSubscription') }}
          </n-button>
        </template>
      </div>
    </header>

    <!-- 内容区 -->
    <div class="sources-content">
      <OpdsBrowser ref="opdsRef" v-show="activeTab === 'opds'" :external-search="opdsSearch" />
      <Subscriptions ref="subRef" v-show="activeTab === 'rss'" />
    </div>
  </div>
</template>

<style scoped>
.sources-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
}

/* 复用 Bookshelf 的 toolbar 模式 */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  height: 48px;
  flex-shrink: 0;
  padding: 0 var(--spacing-lg);
  background: color-mix(in srgb, var(--bg-card) 75%, transparent);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  border-bottom: 1px solid var(--border-color);
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 0;
  flex-shrink: 0;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: nowrap;
  min-width: 0;
  overflow: hidden;
}

/* tab 按钮 */
.tab-item {
  padding: var(--spacing-sm) var(--spacing-md);
  font-size: var(--font-size-base-plus);
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition:
    color 0.2s ease,
    border-color 0.2s ease;
  white-space: nowrap;
}

.tab-item:hover {
  color: var(--text-primary);
}

.tab-item.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

/* 内容区 */
.sources-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
