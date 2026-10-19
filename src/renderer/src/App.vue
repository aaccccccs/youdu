<!--
  应用根组件
  - 顶部自定义标题栏（无边框窗口）
  - 下方路由视图
  - 主题根据 settings store 动态切换（日间/夜间/护眼/羊皮纸/自定义）
  - Naive UI Provider 嵌套顺序：NConfigProvider > NNotificationProvider > NMessageProvider > NDialogProvider
  - 布局：app-root(flex column, height:100%) > TitleBar(36px) + app-body(flex row, flex:1) > AppNav(60px) + app-content(flex:1)
-->
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NNotificationProvider,
  darkTheme,
  zhCN,
  enUS,
  type GlobalThemeOverrides,
  type GlobalTheme
} from 'naive-ui';
import { useI18n } from 'vue-i18n';
import TitleBar from '@renderer/components/common/TitleBar.vue';
import AppNav from '@renderer/components/common/AppNav.vue';
import { useSettingsStore, type ThemeType } from '@renderer/stores';
import { useReaderStore } from '@renderer/stores';

const route = useRoute();
const settingsStore = useSettingsStore();
const readerStore = useReaderStore();
const { locale } = useI18n();

const naiveLocale = computed(() => (locale.value === 'en' ? enUS : zhCN));

/* ==================== 路由判断 ==================== */

/** 阅读器类路由（阅读器/RSS文章）不显示 AppNav，使用阅读器主题 */
const isReaderRoute = computed((): boolean => route.name === 'reader' || route.name === 'article');

/**
 * 需要 keep-alive 缓存的组件名列表
 */
const keepAliveComponents: string[] = [];

/* ==================== 主题计算 ==================== */

/**
 * 当前生效的 Naive UI 主题类型
 *
 * 阅读器路由下使用阅读器主题（readerTheme），确保阅读器内 Naive UI 组件
 * （NDrawerContent 标题栏、NModal 标题栏、NButton、NInput 等）跟随阅读器主题；
 * 其他路由使用应用主题（appTheme）。
 */
const effectiveTheme = computed<ThemeType>(() =>
  isReaderRoute.value ? settingsStore.effectiveReaderTheme : settingsStore.effectiveAppTheme
);

/**
 * 当前生效的主题颜色
 *
 * 阅读器路由下使用 readerThemeColors，其他路由使用 appThemeColors。
 * 与 effectiveTheme 配合，确保 themeOverrides 在阅读器内用阅读器主题色派生。
 */
const effectiveThemeColors = computed(() =>
  isReaderRoute.value ? settingsStore.readerThemeColors : settingsStore.appThemeColors
);

/** Naive UI 主题：day/eye/parchment 用 null（亮色），night/custom 用 darkTheme */
const naiveTheme = computed<GlobalTheme | null>(() => {
  const t = effectiveTheme.value;
  if (t === 'night' || t === 'custom') return darkTheme;
  return null;
});

/** 主题覆盖：根据当前生效主题动态生成颜色（阅读器路由用阅读器主题） */
const themeOverrides = computed<GlobalThemeOverrides>(() => {
  const colors = effectiveThemeColors.value;

  // 所有语义令牌从 theme-colors.ts 直接读取，App.vue 不做任何颜色计算
  return {
    common: {
      bodyColor: colors.bg,
      cardColor: colors.cardBg,
      modalColor: colors.cardBg,
      popoverColor: colors.cardBg,
      primaryColor: colors.primary,
      primaryColorHover: colors.primaryHover,
      primaryColorPressed: colors.primaryPressed,
      textColorBase: colors.text,
      borderColor: colors.borderSubtle,
      inputColor: colors.cardBg,
      inputColorDisabled: colors.cardBg,
      actionColor: colors.cardBg,
      tableColor: colors.cardBg,
      hoverColor: colors.stateHover,
      pressedColor: colors.stateActive,
      tableHeaderColor: colors.cardBg
    },
    Drawer: {
      color: colors.cardBg,
      headerColor: colors.text,
      bodyColor: colors.cardBg,
      borderColor: colors.borderSubtle
    },
    Tabs: {
      tabTextColor: colors.textSecondary,
      tabTextColorActive: colors.primary,
      tabTextColorHover: colors.primary,
      barColor: colors.primary
    },
    Progress: {
      fillColor: colors.primary,
      railColor: colors.borderSubtle
    },
    Tag: {
      colorInfo: colors.primaryTag,
      textColorInfo: colors.primary,
      borderInfo: colors.borderPrimary
    },
    Input: {
      color: colors.cardBg,
      colorFocus: colors.cardBg,
      border: `1px solid ${colors.borderInteractive}`,
      borderHover: `1px solid ${colors.borderPrimary}`,
      borderFocus: `1px solid ${colors.primary}`,
      textColor: colors.text,
      placeholderColor: colors.textPlaceholder,
      caretColor: colors.primary,
      boxShadowFocus: `0 0 0 2px ${colors.primaryOverlay}`
    },
    Select: {
      peers: {
        InternalSelection: {
          color: colors.cardBg,
          colorActive: colors.cardBg,
          border: `1px solid ${colors.borderInteractive}`,
          borderHover: `1px solid ${colors.borderPrimary}`,
          borderFocus: `1px solid ${colors.primary}`,
          borderActive: `1px solid ${colors.primary}`,
          textColor: colors.text,
          placeholderColor: colors.textPlaceholder,
          arrowColor: colors.textTertiary
        },
        InternalSelectMenu: {
          color: colors.cardBg,
          optionTextColor: colors.text,
          optionTextColorActive: colors.primary,
          optionColorActive: colors.statePrimaryActive,
          optionColorPending: colors.stateHover,
          optionColorActivePending: colors.statePrimaryActive,
          borderColor: colors.borderDefault
        }
      }
    },
    Dropdown: {
      color: colors.cardBg,
      optionTextColor: colors.text,
      optionTextColorHover: colors.primary,
      optionColorHover: colors.stateHover,
      optionColorActive: colors.statePrimaryActive,
      borderColor: colors.borderDefault
    },
    Menu: {
      color: colors.cardBg,
      itemTextColor: colors.text,
      itemTextColorHover: colors.primary,
      itemTextColorActive: colors.primary,
      itemColorHover: colors.stateHover,
      itemColorActive: colors.statePrimaryActive,
      borderColor: colors.borderDefault
    },
    Card: {
      color: colors.cardBg,
      colorModal: colors.cardBg,
      textColor: colors.text,
      titleTextColor: colors.text,
      borderColor: colors.borderSubtle
    },
    Modal: {
      color: colors.cardBg,
      textColor: colors.text,
      titleTextColor: colors.text,
      borderColor: colors.borderSubtle
    },
    Dialog: {
      color: colors.cardBg,
      textColor: colors.text,
      titleTextColor: colors.text,
      borderColor: colors.borderSubtle
    },
    Checkbox: {
      colorChecked: colors.primary,
      border: `1px solid ${colors.borderInteractive}`,
      borderChecked: `1px solid ${colors.primary}`,
      textColor: colors.text
    },
    Switch: {
      railColorActive: colors.primary,
      railColor: colors.stateActive,
      buttonColor: colors.text
    },
    Slider: {
      fillColor: colors.primary,
      railColor: colors.borderSubtle,
      handleColor: colors.primary,
      dotColor: colors.primary,
      dotColorActive: colors.primary
    },
    Button: {
      textColor: colors.text,
      textColorHover: colors.primary,
      textColorPressed: colors.primaryPressed,
      textColorFocus: colors.primary,
      color: colors.cardBg,
      colorHover: colors.stateHover,
      colorPressed: colors.stateActive,
      colorFocus: colors.stateHover,
      border: `1px solid ${colors.borderInteractive}`,
      borderHover: `1px solid ${colors.borderPrimary}`,
      borderPressed: `1px solid ${colors.primary}`,
      borderFocus: `1px solid ${colors.primary}`
    },
    List: {
      color: colors.cardBg,
      textColor: colors.text,
      borderColor: colors.borderSubtle
    },
    Tooltip: {
      color: colors.elevatedBg,
      textColor: colors.text
    },
    Spin: {
      color: colors.primary
    },
    Empty: {
      textColor: colors.textTertiary
    },
    Popover: {
      color: colors.cardBg,
      textColor: colors.text,
      borderColor: colors.borderSubtle
    },
    Notification: {
      color: colors.cardBg,
      textColor: colors.text,
      borderColor: colors.borderSubtle
    },
    Divider: {
      color: colors.borderSubtle
    },
    Scrollbar: {
      color: colors.borderDefault,
      colorHover: colors.borderInteractive
    },
    Popconfirm: {
      color: colors.cardBg,
      textColor: colors.text,
      borderColor: colors.borderDefault,
      iconColor: colors.primary
    },
    Text: {
      textColor: colors.text,
      textColorPrimary: colors.primary,
      textColorInfo: colors.primary,
      textColorSuccess: colors.colorSuccess,
      // 警告色：不随主题变化的固定语义色（与 Naive UI 默认一致，深浅主题通用）
      textColorWarning: '#faad14',
      textColorError: colors.colorDanger
    },
    Thing: {
      color: colors.cardBg,
      textColor: colors.text,
      titleTextColor: colors.text,
      descriptionTextColor: colors.textSecondary
    },
    Statistic: {
      textColor: colors.text,
      labelTextColor: colors.textSecondary,
      valueTextColor: colors.text
    },
    ColorPicker: {
      color: colors.cardBg,
      textColor: colors.text,
      borderColor: colors.borderInteractive
    }
  };
});

/* ==================== CSS 变量注入 ==================== */

/** 应用根背景色（使用应用主题） */
const rootBg = computed((): string => settingsStore.appThemeColors.bg);

/**
 * 当前生效的主题颜色数据源
 *
 * 阅读器路由时使用 readerThemeColors，其他路由使用 appThemeColors。
 * 这样 NDrawer/NModal 等 teleport 到 body 的组件在阅读器内也能拿到阅读器主题变量。
 */
const activeThemeColors = computed(() =>
  isReaderRoute.value ? settingsStore.readerThemeColors : settingsStore.appThemeColors
);

/**
 * 阅读器专属 CSS 变量（仅阅读器路由时注入 :root）
 *
 * 提供 --reader-bg / --reader-text / --reader-primary 三个语义变量，
 * 供阅读器内组件直接引用当前阅读器主题颜色。
 */
const readerVars = computed<Record<string, string>>(() => {
  const vars: Record<string, string> = {};
  if (!isReaderRoute.value) return vars;
  const colors = settingsStore.readerThemeColors;
  vars['--reader-bg'] = colors.bg;
  vars['--reader-text'] = colors.text;
  vars['--reader-primary'] = colors.primary;
  return vars;
});

/**
 * 动态 CSS 变量（绑定到当前生效主题）
 *
 * 把主题颜色注入为 CSS 变量，所有非阅读器页面/组件通过 var(--bg-base) 等引用，
 * 切换主题时自动响应。
 *
 * 数据源根据路由切换：阅读器路由用 readerThemeColors，其他路由用 appThemeColors。
 * 通过 watch 注入到 document.documentElement（:root）。
 */
const themeVars = computed<Record<string, string>>(() => {
  const colors = activeThemeColors.value;

  return {
    // 品牌色
    '--primary': colors.primary,
    '--primary-hover': colors.primaryHover,
    '--primary-pressed': colors.primaryPressed,
    // 背景
    '--bg-base': colors.bg,
    '--bg-titlebar': colors.bgTitlebar,
    '--bg-reader': colors.bgReader,
    '--bg-card': colors.cardBg,
    '--bg-elevated': colors.elevatedBg,
    '--bg-hover': colors.stateHover,
    '--bg-active': colors.stateActive,
    // 主色衍生
    '--bg-primary-active': colors.statePrimaryActive,
    '--bg-primary-tag': colors.primaryTag,
    '--bg-primary-overlay': colors.primaryOverlay,
    '--bg-primary-badge': colors.primaryOverlay,
    '--border-primary': colors.borderPrimary,
    '--shadow-primary': `0 2px 8px ${colors.primaryOverlay}`,
    // 徽章
    '--bg-badge': colors.borderSubtle,
    '--bg-badge-hover': colors.borderDefault,
    // 功能色
    '--color-danger': colors.colorDanger,
    '--color-danger-strong': colors.colorDangerStrong,
    '--color-success': colors.colorSuccess,
    '--bg-danger-hover': `${colors.colorDanger}1a`,
    // 特殊背景
    '--bg-bar': `color-mix(in srgb, ${colors.cardBg} 95%, transparent)`,
    '--bg-highlight': colors.stateHover,
    // 特殊阴影（深浅色统一用中性黑色阴影）
    '--shadow-card': '0 2px 8px rgba(0,0,0,0.08)',
    '--shadow-hover': '0 8px 24px rgba(0,0,0,0.12)',
    '--shadow-elevated': '0 4px 16px rgba(0,0,0,0.1)',
    '--shadow-menu': '0 4px 16px rgba(0,0,0,0.15)',
    '--shadow-bar': '0 -4px 16px rgba(0,0,0,0.1)',
    // 滚动条
    '--scrollbar-thumb': colors.borderDefault,
    '--scrollbar-thumb-hover': colors.borderInteractive,
    // 文字
    '--text-primary': colors.text,
    '--text-secondary': colors.textSecondary,
    '--text-tertiary': colors.textTertiary,
    // 主色按钮上的文字色：不随主题变化的固定语义色（深浅主题下白色均保证对比度）
    '--text-on-primary': '#ffffff',
    // 边框语义令牌
    '--border-subtle': colors.borderSubtle,
    '--border-default': colors.borderDefault,
    '--border-interactive': colors.borderInteractive,
    // 边框别名（向后兼容）
    '--border-color': colors.borderSubtle,
    '--border-color-strong': colors.borderDefault,
    // 交互状态语义令牌
    '--state-hover': colors.stateHover,
    '--state-active': colors.stateActive,
    '--state-primary-active': colors.statePrimaryActive
  };
});

/* ==================== CSS 变量应用 ==================== */

/** 将 CSS 变量应用到 document.documentElement（:root） */
function applyThemeVarsToRoot(): void {
  const root = document.documentElement;
  const vars = themeVars.value;
  Object.entries(vars).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
  const rVars = readerVars.value;
  Object.entries(rVars).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
  if (!isReaderRoute.value) {
    root.style.removeProperty('--reader-bg');
    root.style.removeProperty('--reader-text');
    root.style.removeProperty('--reader-primary');
  }
}

/* ==================== 生命周期 ==================== */

onMounted(() => {
  void settingsStore.loadSettings().catch((e) => console.error('settingsStore.loadSettings 失败:', e));
  settingsStore.initSystemThemeListener();
  applyThemeVarsToRoot();

  // 数据目录迁移后主进程会自动重启（app.relaunch + app.exit），
  // 不再需要全局监听 APP_DATA_ROOT_CHANGED 做就地刷新。
  // 重启后所有状态从新数据目录干净加载。

  window.windowApi.onCloseRequested(async () => {
    try {
      if (readerStore.book) {
        // 3 秒超时保护，防止 IPC 卡死时窗口无法关闭
        const flushP = readerStore
          .flushProgressForClose()
          .catch((e) => console.warn('[cleanup] 操作失败:', e))
          .then(() => readerStore.cleanup());
        await Promise.race([flushP, new Promise((resolve) => setTimeout(resolve, 3000))]);
      }
    } catch {
      // flush 失败不阻断关闭
    } finally {
      void window.windowApi.confirmClose();
    }
  });
});

watch(
  [themeVars, readerVars],
  () => {
    applyThemeVarsToRoot();
  },
  { deep: true }
);

onBeforeUnmount(() => {
  settingsStore.cleanupSystemThemeListener();
  window.windowApi.offStopPlayback();
});

// 监听主进程退出前停止播放通知：立即取消 TTS 语音合成
// 主进程 before-quit 会 send APP_STOP_PLAYBACK，等待 300ms 后继续清理退出
window.windowApi.onStopPlayback(() => {
  try {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  } catch (err) {
    console.warn('[App] 停止播放失败:', err);
  }
});
</script>

<template>
  <n-config-provider :theme="naiveTheme" :theme-overrides="themeOverrides" :locale="naiveLocale" style="height: 100%">
    <n-notification-provider>
      <n-message-provider>
        <n-dialog-provider>
          <div class="app-root" :style="{ background: rootBg }">
            <TitleBar v-if="!isReaderRoute || !readerStore.isFullscreen" />
            <div class="app-body">
              <AppNav v-if="!isReaderRoute" />
              <main class="app-content">
                <router-view v-slot="{ Component }">
                  <transition name="page-fade" mode="out-in">
                    <keep-alive :include="keepAliveComponents">
                      <component :is="Component" />
                    </keep-alive>
                  </transition>
                </router-view>
              </main>
            </div>
          </div>
        </n-dialog-provider>
      </n-message-provider>
    </n-notification-provider>
  </n-config-provider>
</template>

<style scoped>
/*
  布局约束核心：
  - html/body height:100% → app-root height:100% → 容器固定跟随窗口
  - app-root: flex column, overflow:hidden → 不被内容撑开
  - app-body: flex:1, min-height:0, overflow:hidden → 不被内容撑开
  - app-content: flex:1, min-width:0, min-height:0, overflow:hidden → 内容区不撑开容器
  - 只有内容区内部页面自行设置 overflow:auto 滚动
*/
.app-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  transition: background-color 0.3s ease;
}

.app-body {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.app-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
</style>
