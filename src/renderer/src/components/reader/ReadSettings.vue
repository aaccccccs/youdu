<!--
  阅读设置面板

  功能：
  - 侧边抽屉（NDrawer，从右侧滑出，宽度 360px）
  - 设置项分组：显示（字号/行距/页宽/边距/段落间距/字体）、内容（繁简转换/智能排版）、朗读（TTS语速）、主题（日间/夜间/护眼/羊皮纸/自定义）
  - 字号调节用滑块 + 数字显示
  - 主题选择用色块按钮，当前主题高亮
  - 每组设置项之间有分割线
  - 主题跟随系统（NSwitch）
  - 自定义主题颜色选择器（NColorPicker，仅当 theme=custom 时显示）
  - 重置默认按钮

  实时预览：
  - 所有设置修改立即通过 settings store 响应式更新，应用到阅读器正文
  - 父组件无需额外处理，store 变化自动驱动视图更新

  用法：
  <ReadSettings :show="visible" @update:show="visible = $event" />
-->
<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NDrawer,
  NDrawerContent,
  NSlider,
  NSelect,
  NSwitch,
  NColorPicker,
  NButton,
  NIcon,
  NDivider,
  useMessage,
  type SelectOption
} from 'naive-ui';
import {
  RotateCcw,
  Type,
  Palette,
  ChevronDown,
  ChevronUp,
  BookOpen,
  Sun,
  Moon,
  Eye,
  Zap,
  FlaskConical
} from '@lucide/vue';
import {
  useSettingsStore,
  type ThemeType,
  type FontFamilyType,
  type TextConvertType,
  type PageTurnAnimationType,
  type ComicReadDirection,
  type ComicScaleType
} from '@renderer/stores';

import {
  fontFamilyOptions,
  useThemeSwatchOptions,
  useCustomThemeColors,
  useShowCustomColors
} from '@renderer/composables';

const props = defineProps<{
  /** 是否显示面板 */
  show: boolean;
  /** 是否处于漫画阅读模式（影响分组显示顺序与默认折叠状态） */
  isComicMode?: boolean;
  /** 漫画阅读模式：scroll=垂直滚动，page=翻页 */
  comicMode?: 'scroll' | 'page';
}>();

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void;
}>();

const settings = useSettingsStore();
const message = useMessage();
const { t } = useI18n();

/* ==================== 快速预设（对标主流阅读器一键方案） ==================== */

/**
 * 快速预设配置
 *
 * 4 个预设覆盖典型阅读场景：
 * - 舒适：大字号 + 宽行距 + 宋体，长篇文学首选
 * - 紧凑：小字号 + 窄行距 + 系统字体，信息密度高
 * - 夜间：黑体 + 夜间主题，暗光环境
 * - 护眼：楷体 + 护眼主题，长时间阅读
 *
 * 仅夜间/护眼预设覆盖主题，其余预设保留用户当前主题。
 * 预设不覆盖漫画设置与繁简转换等非显示类偏好。
 */
interface ReadPreset {
  name: string;
  icon: Component;
  fontSize: number;
  lineHeight: number;
  margin: number;
  paragraphSpacing: number;
  fontFamily: FontFamilyType;
  /** 仅夜间/护眼预设需要覆盖阅读器主题 */
  readerTheme?: ThemeType;
}

const readPresets = computed<ReadPreset[]>(() => [
  {
    name: t('readSettings.presets.comfortable'),
    icon: Sun,
    fontSize: 20,
    lineHeight: 2.0,
    margin: 60,
    paragraphSpacing: 1.5,
    fontFamily: 'serif'
  },
  {
    name: t('readSettings.presets.compact'),
    icon: Zap,
    fontSize: 16,
    lineHeight: 1.5,
    margin: 20,
    paragraphSpacing: 0.5,
    fontFamily: 'system'
  },
  {
    name: t('readSettings.presets.night'),
    icon: Moon,
    fontSize: 18,
    lineHeight: 1.8,
    margin: 40,
    paragraphSpacing: 1.0,
    fontFamily: 'hei',
    readerTheme: 'night'
  },
  {
    name: t('readSettings.presets.eye'),
    icon: Eye,
    fontSize: 18,
    lineHeight: 1.8,
    margin: 40,
    paragraphSpacing: 1.0,
    fontFamily: 'kai',
    readerTheme: 'eye'
  },
  {
    name: t('readSettings.presets.research'),
    icon: FlaskConical,
    fontSize: 17,
    lineHeight: 1.8,
    margin: 50,
    paragraphSpacing: 1.0,
    fontFamily: 'serif',
    readerTheme: 'research'
  }
]);

/** 应用快速预设：批量写入显示类偏好，夜间/护眼额外切换主题 */
async function applyPreset(preset: ReadPreset): Promise<void> {
  const tasks: Promise<void>[] = [
    settings.setFontSize(preset.fontSize),
    settings.setLineHeight(preset.lineHeight),
    settings.setMargin(preset.margin),
    settings.setParagraphSpacing(preset.paragraphSpacing),
    settings.setFontFamily(preset.fontFamily)
  ];
  if (preset.readerTheme) {
    tasks.push(settings.setReaderTheme(preset.readerTheme));
  }
  await Promise.all(tasks);
  message.success(t('readSettings.presets.applied', { name: preset.name }));
}

/* ==================== 分组折叠/展开（按模式组织） ==================== */

/**
 * 三个主分组的展开状态（ref<boolean> 控制）
 *
 * 规则：
 * - 当前模式对应的分组默认展开，非当前模式的分组默认折叠
 * - 漫画模式：漫画阅读组展开，文字阅读组折叠
 * - 文字模式：文字阅读组展开，漫画阅读组折叠
 * - 通用设置组始终展开
 *
 * 分组标题高亮：
 * - 当前模式对应的分组标题用 var(--reader-primary) 高亮
 * - 非当前模式分组标题用 var(--text-secondary)
 */
const textGroupExpanded = ref<boolean>(true);
const comicGroupExpanded = ref<boolean>(false);
const generalGroupExpanded = ref<boolean>(true);

/** 分组名称类型（用于 toggleGroup/isGroupActive 参数约束） */
type GroupName = 'text' | 'comic' | 'general';

/** 初始化分组折叠状态：当前模式对应分组展开，非当前模式折叠 */
function initCollapsedState(): void {
  if (props.isComicMode) {
    // 漫画模式：漫画组展开，文字组折叠，通用组展开
    comicGroupExpanded.value = true;
    textGroupExpanded.value = false;
    generalGroupExpanded.value = true;
  } else {
    // 文字模式：文字组展开，漫画组折叠，通用组展开
    textGroupExpanded.value = true;
    comicGroupExpanded.value = false;
    generalGroupExpanded.value = true;
  }
}

/** 切换分组折叠/展开状态 */
function toggleGroup(name: GroupName): void {
  switch (name) {
    case 'text':
      textGroupExpanded.value = !textGroupExpanded.value;
      break;
    case 'comic':
      comicGroupExpanded.value = !comicGroupExpanded.value;
      break;
    case 'general':
      generalGroupExpanded.value = !generalGroupExpanded.value;
      break;
  }
}

/** 判断分组是否已展开 */
function isGroupExpanded(name: GroupName): boolean {
  switch (name) {
    case 'text':
      return textGroupExpanded.value;
    case 'comic':
      return comicGroupExpanded.value;
    case 'general':
      return generalGroupExpanded.value;
  }
}

/**
 * 判断分组标题是否高亮（当前模式对应的分组高亮）
 * - 漫画模式：漫画阅读组高亮
 * - 文字模式：文字阅读组高亮
 * - 通用设置组不高亮（始终中立显示）
 */
function isGroupActive(name: GroupName): boolean {
  if (name === 'text') return !props.isComicMode;
  if (name === 'comic') return props.isComicMode === true;
  return false;
}

/**
 * 分组在 flex 容器中的显示顺序（CSS order 值）
 * - 漫画模式：漫画阅读(0) → 文字阅读(2) → 通用设置(4) → 重置(6)
 * - 文字模式：文字阅读(0) → 漫画阅读(2) → 通用设置(4) → 重置(6)
 *
 * 通过 CSS order 控制顺序，当前模式对应的分组始终置顶。
 * 每个分组与其后的分割线共享同一个 order 区间（分组用偶数，分割线用奇数）。
 */
const groupOrders = computed<Record<string, number>>(() => {
  if (props.isComicMode) {
    return { comic: 0, text: 2, general: 4, reset: 6 };
  }
  return { text: 0, comic: 2, general: 4, reset: 6 };
});

/* ==================== 选项常量 ==================== */

/** 繁简转换选项 */
const textConvertOptions = computed<SelectOption[]>(() => [
  { label: t('readSettings.textConvert.off'), value: 'off' },
  { label: t('readSettings.textConvert.s2t'), value: 's2t' },
  { label: t('readSettings.textConvert.t2s'), value: 't2s' }
]);

/** 翻页动画选项 */
const pageTurnAnimationOptions = computed<SelectOption[]>(() => [
  { label: t('readSettings.pageTurnAnimation.slide'), value: 'slide' },
  { label: t('readSettings.pageTurnAnimation.flip'), value: 'flip' },
  { label: t('readSettings.pageTurnAnimation.fade'), value: 'fade' },
  { label: t('readSettings.pageTurnAnimation.curl'), value: 'curl' },
  { label: t('readSettings.pageTurnAnimation.none'), value: 'none' }
]);

/** 漫画阅读方向选项 */
const comicReadDirectionOptions = computed<SelectOption[]>(() => [
  { label: t('readSettings.comicReadDirection.ltr'), value: 'ltr' },
  { label: t('readSettings.comicReadDirection.rtl'), value: 'rtl' }
]);

/** 漫画页面缩放类型选项（对标 Mihon/Tachiyomi） */
const comicScaleTypeOptions = computed<SelectOption[]>(() => [
  { label: t('readSettings.comicScale.fitWidth'), value: 'fitWidth' },
  { label: t('readSettings.comicScale.fitScreen'), value: 'fitScreen' },
  { label: t('readSettings.comicScale.original'), value: 'original' },
  { label: t('readSettings.comicScale.smartFit'), value: 'smartFit' }
]);

/* ==================== 主题设置 composable ==================== */

const themeOptions = useThemeSwatchOptions();
const { customBg, customText, customPrimary } = useCustomThemeColors();
const showCustomColors = useShowCustomColors('reader');

/** 主题名 i18n 键映射（按主题值查表） */
const themeLabelKeys: Record<ThemeType, string> = {
  day: 'readSettings.themes.day',
  night: 'readSettings.themes.night',
  eye: 'readSettings.themes.eye',
  parchment: 'readSettings.themes.parchment',
  research: 'readSettings.themes.research',
  custom: 'readSettings.themes.custom'
};

/** 主题色块选项（标签本地化，颜色数据沿用共享 composable） */
const localizedThemeOptions = computed(() =>
  themeOptions.value.map((opt) => ({ ...opt, label: t(themeLabelKeys[opt.value]) }))
);

/** 字体下拉选项（标签本地化，选项值/顺序沿用共享常量） */
const fontFamilySelectOptions = computed<SelectOption[]>(() =>
  fontFamilyOptions.map((opt) => {
    switch (opt.value) {
      case 'serif':
        return { ...opt, label: t('readSettings.fonts.serif') };
      case 'kai':
        return { ...opt, label: t('readSettings.fonts.kai') };
      case 'hei':
        return { ...opt, label: t('readSettings.fonts.hei') };
      default:
        return { ...opt, label: t('readSettings.fonts.system') };
    }
  })
);

/* ==================== 响应式辅助 ==================== */

/** 行距显示标签（保留 1 位小数） */
const lineHeightLabel = computed(() => settings.lineHeight.toFixed(1));

/** 段落间距显示标签（保留 1 位小数） */
const paragraphSpacingLabel = computed(() => settings.paragraphSpacing.toFixed(1));

/** TTS语速显示标签（保留 1 位小数） */
const ttsRateLabel = computed(() => settings.ttsRate.toFixed(1));

/** TTS音调显示标签（保留 1 位小数） */
const ttsPitchLabel = computed(() => settings.ttsPitch.toFixed(1));

/* ==================== TTS 语音列表 ==================== */

/** 系统可用语音列表 */
const ttsVoices = ref<SpeechSynthesisVoice[]>([]);

/** 语音选择下拉选项 */
const ttsVoiceOptions = computed<SelectOption[]>(() => {
  const options: SelectOption[] = [{ label: t('readSettings.tts.autoSelect'), value: '' }];
  for (const voice of ttsVoices.value) {
    options.push({
      label: `${voice.name} (${voice.lang})`,
      value: voice.voiceURI
    });
  }
  return options;
});

/** 语音列表延迟重试定时器（Linux 上 voiceschanged 可能不触发，主动轮询兜底） */
let voiceRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** 加载系统语音列表；为空时延迟重试若干次（引擎异步就绪） */
function loadTtsVoices(retry = 0): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    ttsVoices.value = voices;
    if (voiceRetryTimer !== null) {
      clearTimeout(voiceRetryTimer);
      voiceRetryTimer = null;
    }
    return;
  }
  // 最多重试 6 次（间隔 500ms，共约 3s），覆盖 Linux speech-dispatcher 慢启动
  if (retry < 6) {
    voiceRetryTimer = setTimeout(() => loadTtsVoices(retry + 1), 500);
  }
}

/** 语音列表变化事件处理 */
function onVoicesChanged(): void {
  loadTtsVoices();
}

/* ==================== 事件处理 ==================== */

/** 字号变化 */
function onFontSizeChange(value: number): void {
  void settings.setFontSize(value).catch((e) => console.error('settings.setFontSize 失败:', e));
}

/** 字体变化 */
function onFontFamilyChange(value: string): void {
  void settings.setFontFamily(value as FontFamilyType).catch((e) => console.error('settings.setFontFamily 失败:', e));
}

/** 行距变化 */
function onLineHeightChange(value: number): void {
  void settings.setLineHeight(value).catch((e) => console.error('settings.setLineHeight 失败:', e));
}

/** 页宽变化 */
function onPageWidthChange(value: number): void {
  void settings.setPageWidth(value).catch((e) => console.error('settings.setPageWidth 失败:', e));
}

/** 边距变化 */
function onMarginChange(value: number): void {
  void settings.setMargin(value).catch((e) => console.error('settings.setMargin 失败:', e));
}

/** 段落间距变化 */
function onParagraphSpacingChange(value: number): void {
  void settings.setParagraphSpacing(value).catch((e) => console.error('settings.setParagraphSpacing 失败:', e));
}

/** TTS语速变化 */
function onTtsRateChange(value: number): void {
  void settings.setTtsRate(value).catch((e) => console.error('settings.setTtsRate 失败:', e));
}

/** TTS语音变化 */
function onTtsVoiceChange(value: string): void {
  void settings.setTtsVoice(value === '' ? null : value).catch((e) => console.error('settings.setTtsVoice 失败:', e));
}

/** TTS音调变化 */
function onTtsPitchChange(value: number): void {
  void settings.setTtsPitch(value).catch((e) => console.error('settings.setTtsPitch 失败:', e));
}

/** 主题变化 */
function onThemeChange(value: ThemeType): void {
  void settings.setReaderTheme(value).catch((e) => console.error('settings.setReaderTheme 失败:', e));
}

/** 主题跟随系统变化 */
function onThemeFollowSystemChange(value: boolean): void {
  void settings
    .setReaderThemeFollowSystem(value)
    .catch((e) => console.error('settings.setReaderThemeFollowSystem 失败:', e));
}

/** 繁简转换变化 */
function onTextConvertChange(value: string): void {
  void settings
    .setTextConvert(value as TextConvertType)
    .catch((e) => console.error('settings.setTextConvert 失败:', e));
}

/** 智能排版变化 */
function onSmartFormatChange(value: boolean): void {
  void settings.setSmartFormat(value).catch((e) => console.error('settings.setSmartFormat 失败:', e));
}

/** 翻页动画变化 */
function onPageTurnAnimationChange(value: string): void {
  void settings
    .setPageTurnAnimation(value as PageTurnAnimationType)
    .catch((e) => console.error('settings.setPageTurnAnimation 失败:', e));
}

/** 漫画阅读方向变化 */
function onComicReadDirectionChange(value: string): void {
  void settings
    .setComicReadDirection(value as ComicReadDirection)
    .catch((e) => console.error('settings.setComicReadDirection 失败:', e));
}

/** 漫画页面缩放类型变化 */
function onComicScaleTypeChange(value: string): void {
  void settings
    .setComicScaleType(value as ComicScaleType)
    .catch((e) => console.error('settings.setComicScaleType 失败:', e));
}

/** 重置为默认值 */
async function handleReset(): Promise<void> {
  await settings.resetToDefaults();
}

/** 关闭面板 */
function handleUpdateShow(value: boolean): void {
  emit('update:show', value);
}

/* ==================== 生命周期 ==================== */

onMounted(() => {
  initCollapsedState();
  loadTtsVoices();
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
  }
});

/** 面板每次打开时重新初始化折叠状态，确保漫画/文字模式切换后分组状态正确 */
watch(
  () => props.show,
  (newShow: boolean) => {
    if (newShow) {
      initCollapsedState();
    }
  }
);

onBeforeUnmount(() => {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
  }
  if (voiceRetryTimer !== null) {
    clearTimeout(voiceRetryTimer);
    voiceRetryTimer = null;
  }
});
</script>

<template>
  <n-drawer :show="props.show" :width="360" placement="right" @update:show="handleUpdateShow">
    <n-drawer-content :title="t('readSettings.title')" closable>
      <div class="settings-panel">
        <!-- ═══════════════ 快速预设（置顶，不受分组折叠影响） ═══════════════ -->
        <div v-if="!isComicMode" class="preset-bar" :style="{ order: -2 }">
          <button
            v-for="preset in readPresets"
            :key="preset.name"
            type="button"
            class="preset-btn"
            @click="applyPreset(preset)"
          >
            <n-icon :component="preset.icon" :size="16" class="preset-icon" />
            <span class="preset-name">{{ preset.name }}</span>
          </button>
        </div>

        <n-divider v-if="!isComicMode" class="group-divider preset-divider" :style="{ order: -1 }" />

        <!-- ═══════════════ 漫画阅读分组（单一定义，通过 CSS order 控制显示位置） ═══════════════ -->
        <div class="setting-group" :style="{ order: groupOrders['comic'] }">
          <div
            class="group-header group-header-collapsible"
            :class="{ active: isGroupActive('comic') }"
            @click="toggleGroup('comic')"
          >
            <n-icon :component="BookOpen" :size="16" class="group-icon" />
            <span class="group-title">{{ t('readSettings.groups.comic') }}</span>
            <n-icon
              :component="isGroupExpanded('comic') ? ChevronUp : ChevronDown"
              :size="16"
              class="group-collapse-icon"
            />
          </div>

          <div v-show="isGroupExpanded('comic')" class="setting-group-content">
            <!-- 阅读方向（仅翻页模式） -->
            <div v-if="comicMode === 'page'" class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.readDirection') }}</span>
              </div>
              <n-select
                :value="settings.comicReadDirection"
                :options="comicReadDirectionOptions"
                @update:value="onComicReadDirectionChange"
              />
              <p class="section-hint">{{ t('readSettings.hints.comicDirection') }}</p>
            </div>

            <!-- 页面缩放类型（两种模式通用） -->
            <div class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.pageScale') }}</span>
              </div>
              <n-select
                :value="settings.comicScaleType"
                :options="comicScaleTypeOptions"
                @update:value="onComicScaleTypeChange"
              />
              <p class="section-hint">{{ t('readSettings.hints.comicScale') }}</p>
            </div>
          </div>
        </div>

        <n-divider class="group-divider" :style="{ order: groupOrders['comic'] + 1 }" />

        <!-- ═══════════════ 文字阅读分组（合并原"显示"+"内容"分组） ═══════════════ -->
        <div v-if="!isComicMode" class="setting-group" :style="{ order: groupOrders['text'] }">
          <div
            class="group-header group-header-collapsible"
            :class="{ active: isGroupActive('text') }"
            @click="toggleGroup('text')"
          >
            <n-icon :component="Type" :size="16" class="group-icon" />
            <span class="group-title">{{ t('readSettings.groups.text') }}</span>
            <n-icon
              :component="isGroupExpanded('text') ? ChevronUp : ChevronDown"
              :size="16"
              class="group-collapse-icon"
            />
          </div>

          <div v-show="isGroupExpanded('text')" class="setting-group-content">
            <!-- 字号 -->
            <div class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.fontSize') }}</span>
                <span class="section-value">{{ t('readSettings.px', { n: settings.fontSize }) }}</span>
              </div>
              <n-slider
                :value="settings.fontSize"
                :min="14"
                :max="32"
                :step="1"
                :format-tooltip="(v: number) => t('readSettings.px', { n: v })"
                @update:value="onFontSizeChange"
              />
            </div>

            <!-- 行距 -->
            <div class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.lineHeight') }}</span>
                <span class="section-value">{{ lineHeightLabel }}</span>
              </div>
              <div class="section-hint">{{ t('readSettings.hints.lineHeight') }}</div>
              <n-slider
                :value="settings.lineHeight"
                :min="1.2"
                :max="2.5"
                :step="0.1"
                :format-tooltip="(v: number) => v.toFixed(1)"
                @update:value="onLineHeightChange"
              />
            </div>

            <!-- 页宽 -->
            <div class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.pageWidth') }}</span>
                <span class="section-value">{{ t('readSettings.px', { n: settings.pageWidth }) }}</span>
              </div>
              <n-slider
                :value="settings.pageWidth"
                :min="600"
                :max="1200"
                :step="50"
                :format-tooltip="(v: number) => t('readSettings.px', { n: v })"
                @update:value="onPageWidthChange"
              />
            </div>

            <!-- 边距 -->
            <div class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.margin') }}</span>
                <span class="section-value">{{ t('readSettings.px', { n: settings.margin }) }}</span>
              </div>
              <n-slider
                :value="settings.margin"
                :min="0"
                :max="480"
                :step="10"
                :format-tooltip="(v: number) => t('readSettings.px', { n: v })"
                @update:value="onMarginChange"
              />
            </div>

            <!-- 段落间距 -->
            <div class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.paragraphSpacing') }}</span>
                <span class="section-value">{{ paragraphSpacingLabel }}</span>
              </div>
              <div class="section-hint">{{ t('readSettings.hints.paragraphSpacing') }}</div>
              <n-slider
                :value="settings.paragraphSpacing"
                :min="0.5"
                :max="3.0"
                :step="0.1"
                :format-tooltip="(v: number) => v.toFixed(1)"
                @update:value="onParagraphSpacingChange"
              />
            </div>

            <!-- 字体 -->
            <div class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.fontFamily') }}</span>
              </div>
              <n-select
                :value="settings.fontFamily"
                :options="fontFamilySelectOptions"
                @update:value="onFontFamilyChange"
              />
            </div>

            <!-- 翻页动画 -->
            <div class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.pageTurnAnimation') }}</span>
              </div>
              <n-select
                :value="settings.pageTurnAnimation"
                :options="pageTurnAnimationOptions"
                @update:value="onPageTurnAnimationChange"
              />
            </div>

            <!-- 繁简转换 -->
            <div class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.textConvert') }}</span>
              </div>
              <n-select
                :value="settings.textConvert"
                :options="textConvertOptions"
                @update:value="onTextConvertChange"
              />
            </div>

            <!-- 智能排版 -->
            <div class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.smartFormat') }}</span>
                <n-switch :value="settings.smartFormat" @update:value="onSmartFormatChange" />
              </div>
              <p class="section-hint">{{ t('readSettings.hints.smartFormat') }}</p>
            </div>
          </div>
        </div>

        <n-divider v-if="!isComicMode" class="group-divider" :style="{ order: groupOrders['text'] + 1 }" />

        <!-- ═══════════════ 通用设置分组（合并原"朗读"+"主题"分组，始终展开） ═══════════════ -->
        <div class="setting-group" :style="{ order: groupOrders['general'] }">
          <div
            class="group-header group-header-collapsible"
            :class="{ active: isGroupActive('general') }"
            @click="toggleGroup('general')"
          >
            <n-icon :component="Palette" :size="16" class="group-icon" />
            <span class="group-title">{{ t('readSettings.groups.general') }}</span>
            <n-icon
              :component="isGroupExpanded('general') ? ChevronUp : ChevronDown"
              :size="16"
              class="group-collapse-icon"
            />
          </div>

          <div v-show="isGroupExpanded('general')" class="setting-group-content">
            <!-- 主题色块按钮 -->
            <div class="setting-section">
              <div class="theme-grid">
                <button
                  v-for="opt in localizedThemeOptions"
                  :key="opt.value"
                  type="button"
                  class="theme-swatch"
                  :class="{ active: settings.readerTheme === opt.value }"
                  :style="{ background: opt.bg, color: opt.text }"
                  @click="onThemeChange(opt.value)"
                >
                  <span class="theme-swatch-label">A</span>
                  <span class="theme-swatch-name">{{ opt.label }}</span>
                </button>
              </div>
            </div>

            <!-- 主题跟随系统 -->
            <div class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.followSystem') }}</span>
                <n-switch :value="settings.readerThemeFollowSystem" @update:value="onThemeFollowSystemChange" />
              </div>
              <p class="section-hint">{{ t('readSettings.hints.followSystem') }}</p>
            </div>

            <!-- 自定义主题颜色（仅当 theme=custom 时显示） -->
            <div v-if="showCustomColors" class="setting-section custom-colors">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.customColors') }}</span>
              </div>
              <div class="color-row">
                <span class="color-label">{{ t('readSettings.colors.bg') }}</span>
                <n-color-picker
                  :value="customBg"
                  size="small"
                  :show-alpha="false"
                  @update:value="(v: string) => (customBg = v)"
                />
              </div>
              <div class="color-row">
                <span class="color-label">{{ t('readSettings.colors.text') }}</span>
                <n-color-picker
                  :value="customText"
                  size="small"
                  :show-alpha="false"
                  @update:value="(v: string) => (customText = v)"
                />
              </div>
              <div class="color-row">
                <span class="color-label">{{ t('readSettings.colors.primary') }}</span>
                <n-color-picker
                  :value="customPrimary"
                  size="small"
                  :show-alpha="false"
                  @update:value="(v: string) => (customPrimary = v)"
                />
              </div>
            </div>

            <!-- TTS语速（仅文本模式，漫画无文字可朗读） -->
            <div v-if="!isComicMode" class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.ttsRate') }}</span>
                <span class="section-value">{{ ttsRateLabel }}</span>
              </div>
              <n-slider
                :value="settings.ttsRate"
                :min="0.5"
                :max="2.0"
                :step="0.1"
                :format-tooltip="(v: number) => v.toFixed(1)"
                @update:value="onTtsRateChange"
              />
            </div>

            <!-- TTS音调（仅文本模式） -->
            <div v-if="!isComicMode" class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.ttsPitch') }}</span>
                <span class="section-value">{{ ttsPitchLabel }}</span>
              </div>
              <n-slider
                :value="settings.ttsPitch"
                :min="0"
                :max="2.0"
                :step="0.1"
                :format-tooltip="(v: number) => v.toFixed(1)"
                @update:value="onTtsPitchChange"
              />
            </div>

            <!-- TTS语音选择（仅文本模式） -->
            <div v-if="!isComicMode" class="setting-section">
              <div class="section-header">
                <span class="section-title">{{ t('readSettings.sections.voice') }}</span>
              </div>
              <n-select :value="settings.ttsVoice ?? ''" :options="ttsVoiceOptions" @update:value="onTtsVoiceChange" />
              <div v-if="ttsVoices.length === 0" class="section-hint section-hint--warn">
                {{ t('readSettings.hints.noVoice') }}
              </div>
            </div>
          </div>
        </div>

        <n-divider class="group-divider" :style="{ order: groupOrders['general'] + 1 }" />

        <!-- ═══════════════ 重置 ═══════════════ -->
        <div class="setting-section" :style="{ order: groupOrders['reset'] }">
          <n-button block secondary @click="handleReset">
            <template #icon>
              <n-icon :component="RotateCcw" :size="16" />
            </template>
            {{ t('readSettings.actions.restoreDefaults') }}
          </n-button>
        </div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.settings-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) 0;
  overflow-y: auto;
}

/* ==================== 快速预设 ==================== */
.preset-bar {
  display: flex;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) 0 var(--spacing-sm);
}

.preset-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-2xs);
  padding: var(--spacing-sm) var(--spacing-xs);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: var(--font-size-sm-plus);
  cursor: pointer;
  transition:
    background 0.18s ease,
    color 0.18s ease,
    transform 0.18s ease,
    border-color 0.18s ease;
  user-select: none;
}

.preset-btn:hover {
  background: var(--bg-hover);
  border-color: var(--border-default);
  color: var(--text-primary);
  transform: scale(1.03);
}

.preset-btn:active {
  transform: scale(0.97);
  background: var(--bg-active);
}

.preset-icon {
  flex-shrink: 0;
  color: var(--primary);
}

.preset-name {
  font-weight: 500;
  letter-spacing: 0.5px;
}

.preset-divider {
  margin: var(--spacing-xs) 0 var(--spacing-sm) !important;
}

/* ==================== 分组 ==================== */
.setting-group {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.setting-group-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.group-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
  padding: var(--spacing-xs) 0;
}

.group-header-collapsible {
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
  border-radius: var(--border-radius-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
}

.group-header-collapsible:hover {
  background: var(--bg-hover);
}

.group-collapse-icon {
  margin-left: auto;
  color: var(--text-tertiary);
  flex-shrink: 0;
  transition: transform 0.2s ease;
}

.group-icon {
  color: var(--primary);
  flex-shrink: 0;
}

.group-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 1px;
  transition: color 0.2s ease;
}

/* 可折叠分组标题默认非高亮（var(--text-secondary)） */
.group-header-collapsible .group-title {
  color: var(--text-secondary);
}

/* 当前模式对应的分组标题高亮（var(--reader-primary)） */
.group-header-collapsible.active .group-title {
  color: var(--reader-primary);
}

/* 高亮时图标也跟随主色 */
.group-header-collapsible.active .group-icon {
  color: var(--reader-primary);
}

.group-divider {
  margin: var(--spacing-sm) 0 var(--spacing-xs) !important;
}

/* ==================== 设置项 ==================== */
.setting-section {
  padding: var(--spacing-sm) 0;
}

.section-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-sm-md);
}

.section-title {
  font-size: var(--font-size-sm-plus);
  font-weight: 500;
  color: var(--text-secondary);
  flex: 1;
}

.section-value {
  font-size: var(--font-size-sm);
  color: var(--primary);
  font-weight: 600;
  padding: var(--spacing-2xs) var(--spacing-sm);
  background: var(--bg-primary-tag);
  border-radius: var(--border-radius-10px);
  flex-shrink: 0;
}

.section-hint {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin: 0;
  line-height: 1.5;
}

/* ==================== 设置项说明文字 ==================== */
.section-hint {
  margin: 2px 0 var(--spacing-xs);
  font-size: var(--font-size-xs);
  line-height: 1.4;
  color: var(--text-tertiary);
}

.section-hint--warn {
  color: var(--warning-color, #f0a020);
}
</style>
