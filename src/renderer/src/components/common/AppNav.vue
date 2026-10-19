<!--
  应用级左侧导航栏

  功能：
  - 固定宽度 60px，垂直排列图标
  - 三个入口：书架（BookOpen 图标）、订阅（Rss 图标）、设置（Settings 图标）
  - 使用应用主题颜色（appThemeColors）
  - 当前路由高亮显示（图标着色 + 背景高亮）

  注意：此组件嵌入到 App.vue 的 app-body 中，不设 height:100%，
  依赖 flex 父容器 align-items:stretch 拉伸到全高。
  书架页面内部的分组侧边栏（GroupSidebar）是书架内部功能，与此导航栏独立。
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NIcon, NTooltip } from 'naive-ui';
import { BookOpen, Settings, Rss } from '@lucide/vue';

const router = useRouter();
const route = useRoute();
const { t } = useI18n();

/* ==================== 导航项定义 ==================== */

interface NavItem {
  key: string;
  label: string;
  icon: typeof BookOpen;
  route: string;
}

const navItems = computed<NavItem[]>(() => [
  { key: 'bookshelf', label: t('shell.nav.library'), icon: BookOpen, route: '/' },
  { key: 'subscriptions', label: t('shell.nav.sources'), icon: Rss, route: '/sources' },
  { key: 'settings', label: t('shell.nav.settings'), icon: Settings, route: '/settings' }
]);

/* ==================== 导航逻辑 ==================== */

/**
 * 判断导航项是否处于活跃状态
 * - 书架（'/'）：精确匹配根路径，避免在 /book/:bookId 等子路由上误高亮
 * - 其他项：精确匹配
 */
function isActive(item: NavItem): boolean {
  if (item.route === '/') {
    return route.path === '/';
  }
  return route.path === item.route;
}

/** 点击导航项 */
function handleNavClick(item: NavItem): void {
  router.push(item.route);
}
</script>

<template>
  <nav class="app-nav">
    <!-- 导航项列表 -->
    <div class="nav-items">
      <n-tooltip v-for="item in navItems" :key="item.key" placement="right-start" :delay="300" to="body">
        <template #trigger>
          <button
            class="nav-item"
            :class="{ active: isActive(item) }"
            :aria-current="isActive(item) ? 'page' : undefined"
            @click="handleNavClick(item)"
          >
            <n-icon :component="item.icon" :size="22" />
          </button>
        </template>
        {{ item.label }}
      </n-tooltip>
    </div>
  </nav>
</template>

<style scoped>
/*
  导航栏布局约束：
  - width:60px, flex-shrink:0 → 固定宽度，不被压缩
  - 不设 height:100%，依赖 flex 父容器 align-items:stretch 拉伸到全高
  - overflow:hidden → 裁剪内部溢出，NTooltip 已 teleport 到 body 不受影响
*/
.app-nav {
  width: 60px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--spacing-sm-md) 0;
  background: var(--bg-base);
  border-right: 1px solid var(--border-color);
  transition: background-color 0.3s ease;
  overflow: hidden;
}

.nav-items {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  align-items: center;
}

.nav-item {
  width: 40px;
  height: 40px;
  border-radius: var(--border-radius-10px);
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  padding: 0;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--bg-hover);
  color: var(--primary);
}

.nav-item.active:hover {
  background: var(--bg-hover);
  color: var(--primary);
}
</style>
