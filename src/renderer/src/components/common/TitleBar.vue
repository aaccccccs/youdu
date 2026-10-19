<!--
  自定义标题栏（无边框窗口核心）

  - 顶部栏：左侧返回按钮，中间书名/应用名，右侧最小化/最大化/关闭按钮
  - 阅读器路由时中间显示当前书名，其他路由显示应用名"幽读"
  - 拖拽区：CSS -webkit-app-region: drag；按钮区 no-drag
  - macOS：系统交通灯按钮已由 titleBarStyle: 'hiddenInset' 提供，左侧留出空间
  - 按钮点击通过 window.windowApi 通知主进程
-->
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NIcon, NButton } from 'naive-ui';
import { Minus, Square, Copy, X, ArrowLeft } from '@lucide/vue';
import { useReaderStore } from '@renderer/stores';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const readerStore = useReaderStore();
const isMaximized = ref(false);
const isMac = computed((): boolean => navigator.userAgent.includes('Mac'));

/* ==================== 路由判断 ==================== */

/** 是否显示返回按钮（阅读器、详情页、RSS 文章页显示） */
const showBack = computed(
  (): boolean => route.name === 'reader' || route.name === 'book-detail' || route.name === 'article'
);

/** 是否处于阅读器路由 */
const isReaderRoute = computed((): boolean => route.name === 'reader');

/* ==================== 标题栏样式 ==================== */

/** 标题栏中间显示文本：阅读器路由时显示书名，其他路由显示应用名（common.appName） */
const titleText = computed((): string => {
  if (isReaderRoute.value && readerStore.book?.title) {
    return readerStore.book.title;
  }
  return t('common.appName');
});

/* ==================== 窗口控制 ==================== */

/** 返回书架 */
function goBack(): void {
  if (window.history.length > 1) {
    router.back();
  } else {
    router.push('/');
  }
}

async function syncMaximizeState(): Promise<void> {
  try {
    if (window.windowApi) {
      isMaximized.value = await window.windowApi.isMaximized();
    }
  } catch {
    // ignore
  }
}

function handleMaximizeChanged(val: boolean): void {
  isMaximized.value = val;
}

async function minimize(): Promise<void> {
  await window.windowApi?.minimize();
}

async function toggleMaximize(): Promise<void> {
  await window.windowApi?.toggleMaximize();
  await syncMaximizeState();
}

async function close(): Promise<void> {
  await window.windowApi?.close();
}

/* ==================== 生命周期 ==================== */

onMounted(async () => {
  await syncMaximizeState();
  window.windowApi?.onMaximizeChanged(handleMaximizeChanged);
});

onBeforeUnmount(() => {
  window.windowApi?.offMaximizeChanged();
});
</script>

<template>
  <div class="title-bar" :class="{ 'is-mac': isMac }">
    <!-- 左侧：返回按钮 -->
    <div class="title-left">
      <n-button
        v-if="showBack"
        quaternary
        circle
        :focusable="false"
        class="back-btn"
        :title="t('shell.titleBar.backToLibrary')"
        @click="goBack"
      >
        <n-icon :component="ArrowLeft" :size="18" />
      </n-button>
    </div>

    <!-- 中间：书名/应用名（拖拽区） -->
    <div class="title-center">
      <span class="title-text">{{ titleText }}</span>
    </div>

    <!-- 右侧：窗口控制按钮（no-drag） -->
    <div v-if="!isMac" class="title-right">
      <n-button class="win-btn" quaternary :focusable="false" :title="t('shell.titleBar.minimize')" @click="minimize">
        <n-icon :component="Minus" :size="16" />
      </n-button>
      <n-button
        class="win-btn"
        quaternary
        :focusable="false"
        @click="toggleMaximize"
        :title="isMaximized ? t('shell.titleBar.restore') : t('shell.titleBar.maximize')"
      >
        <n-icon :component="isMaximized ? Copy : Square" :size="14" />
      </n-button>
      <n-button
        class="win-btn close-btn"
        quaternary
        :focusable="false"
        :title="t('common.actions.close')"
        @click="close"
      >
        <n-icon :component="X" :size="16" />
      </n-button>
    </div>
  </div>
</template>

<style scoped>
/*
  标题栏布局约束：
  - flex-shrink:0 → 不被 flex 父容器压缩
  - height:36px → 固定高度
  - overflow:hidden → 不被内容撑开
*/
.title-bar {
  display: flex;
  align-items: center;
  height: 36px;
  flex-shrink: 0;
  overflow: hidden;
  padding: 0 var(--spacing-sm);
  background: var(--bg-titlebar);
  border-bottom: 1px solid var(--border-color);
  user-select: none;
  -webkit-app-region: drag;
  transition: background-color 0.3s ease;
}

.title-bar.is-mac {
  padding-left: 80px;
}

.title-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  -webkit-app-region: no-drag;
}

.back-btn {
  margin-left: var(--spacing-xs);
  -webkit-app-region: no-drag;
}

.title-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  overflow: hidden;
  -webkit-app-region: drag;
}

.title-text {
  font-size: var(--font-size-sm-plus);
  font-weight: 500;
  color: var(--text-primary);
  letter-spacing: 1px;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}

.title-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-2xs);
  -webkit-app-region: no-drag;
}

.win-btn {
  height: 28px;
  border-radius: var(--border-radius-sm);
  color: var(--text-secondary);
}

.win-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.close-btn:hover {
  background: var(--color-danger-strong);
  color: var(--bg-base);
}
</style>
