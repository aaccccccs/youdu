<!--
  设置视图（自包含，7 个标签页已内联）

  布局结构：
  .settings-root (display:flex, height:100%, overflow:hidden)
    └── .settings-view (flex:1, height:100%, overflow:auto) ← 唯一滚动区
        └── .settings-container (max-width:720px, margin:0 auto)
            └── NTabs (7个标签页)

  顶部标签页分类（7 个 tab）：
  1. 通用    → 界面语言/快捷键/通知设置
  2. 阅读    → 字号/字体/行距/页宽/繁简转换/智能排版/翻页方向/点击翻页/自动滚动
  3. 外观    → 应用主题/阅读器主题/自定义颜色
  4. 数据    → 数据目录/缓存清理/重新检测漫画
  5. 高级    → 内容替换规则/网络配置
  6. 阅读统计 → 阅读时长/热图/最常阅读
  7. 关于     → 应用版本/数据路径/开源信息
-->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NTabs,
  NTabPane,
  NCard,
  NSlider,
  NSelect,
  NSwitch,
  NButton,
  NTag,
  NIcon,
  NColorPicker,
  NDivider,
  NInput,
  NInputNumber,
  NList,
  NListItem,
  NThing,
  NSpace,
  NTimePicker,
  NModal,
  NProgress,
  useMessage,
  useDialog
} from 'naive-ui';
import type { SelectOption, MessageReactive } from 'naive-ui';
import {
  Palette,
  RotateCcw,
  Trash,
  Folder,
  Database,
  RefreshCw,
  CircleCheck,
  CircleX,
  Info,
  TrendingUp,
  ShieldX,
  BookOpen,
  Replace,
  Keyboard,
  SlidersHorizontal
} from '@lucide/vue';
import {
  useSettingsStore,
  type ThemeType,
  type FontFamilyType,
  type TextConvertType,
  type PageTurnDirectionType,
  type TapTurnZoneType,
  type KeyboardShortcuts
} from '@renderer/stores';
import {
  fontFamilyOptions,
  useThemeSwatchOptions,
  useCustomThemeColors,
  useShowCustomColors
} from '@renderer/composables';
import { THEME_COLORS } from '../../../shared';
import { coverPathToUrl, generateCoverDataUrl } from '@renderer/utils';

const settingsStore = useSettingsStore();
const message = useMessage();
const dialog = useDialog();
const { t, locale } = useI18n();

/* ==================== 界面语言（P0-3 i18n） ==================== */

const localeOptions = computed<SelectOption[]>(() => [
  { label: t('common.lang.zh-CN'), value: 'zh-CN' },
  { label: t('common.lang.en'), value: 'en' }
]);
const currentLocale = computed(() => locale.value);

function handleLocaleChange(val: 'zh-CN' | 'en'): void {
  const setLocale = (window as unknown as Record<string, unknown>).__setLocale as
    ((l: 'zh-CN' | 'en') => void) | undefined;
  if (setLocale) {
    setLocale(val);
    message.success(t('settings.localeSwitched'));
  }
}

const activeTab = ref<string>('general');

/* ==================== 通用设置 ==================== */

const themeSwatchOptions = useThemeSwatchOptions();
const { customBg, customText, customPrimary } = useCustomThemeColors();
const showCustomColors = useShowCustomColors('app');

/** 预设主题快捷选项（label 按当前语言本地化，颜色值原样透传） */
const presetThemeOptions = computed(() => [
  {
    key: 'day',
    label: t('settings.themes.day'),
    bg: THEME_COLORS.day.bg,
    text: THEME_COLORS.day.text,
    primary: THEME_COLORS.day.primary
  },
  {
    key: 'night',
    label: t('settings.themes.night'),
    bg: THEME_COLORS.night.bg,
    text: THEME_COLORS.night.text,
    primary: THEME_COLORS.night.primary
  },
  {
    key: 'eye',
    label: t('settings.themes.eye'),
    bg: THEME_COLORS.eye.bg,
    text: THEME_COLORS.eye.text,
    primary: THEME_COLORS.eye.primary
  },
  {
    key: 'parchment',
    label: t('settings.themes.parchment'),
    bg: THEME_COLORS.parchment.bg,
    text: THEME_COLORS.parchment.text,
    primary: THEME_COLORS.parchment.primary
  },
  {
    key: 'research',
    label: t('settings.themes.research'),
    bg: THEME_COLORS.research.bg,
    text: THEME_COLORS.research.text,
    primary: THEME_COLORS.research.primary
  }
]);

/** 主题色块选项（composables 数据含中文 label，按 value 映射为本地化标签，颜色值原样透传） */
const localizedThemeSwatchOptions = computed(() =>
  themeSwatchOptions.value.map((opt) => ({
    ...opt,
    label: t(`settings.themes.${opt.value}`)
  }))
);

/** 字体选项（composables 数据含中文 label，按 value 映射为本地化标签） */
const localizedFontFamilyOptions = computed<SelectOption[]>(() =>
  fontFamilyOptions.map((opt) => ({
    ...opt,
    label: t(`settings.fonts.${String(opt.value)}`)
  }))
);

/** 应用预设主题颜色到自定义主题 */
function applyPresetTheme(preset: { bg: string; text: string; primary: string }): void {
  customBg.value = preset.bg;
  customText.value = preset.text;
  customPrimary.value = preset.primary;
}

const lineHeightLabel = computed<string>(() => settingsStore.lineHeight.toFixed(1));

/** 繁简转换选项 */
const textConvertOptions = computed<SelectOption[]>(() => [
  { label: t('settings.reading.convertOff'), value: 'off' },
  { label: t('settings.reading.convertS2T'), value: 's2t' },
  { label: t('settings.reading.convertT2S'), value: 't2s' }
]);

function onFontSizeChange(value: number): void {
  void settingsStore.setFontSize(value).catch((e) => console.error('settingsStore.setFontSize 失败:', e));
}

function onFontFamilyChange(value: string): void {
  void settingsStore
    .setFontFamily(value as FontFamilyType)
    .catch((e) => console.error('settingsStore.setFontFamily 失败:', e));
}

function onLineHeightChange(value: number): void {
  void settingsStore.setLineHeight(value).catch((e) => console.error('settingsStore.setLineHeight 失败:', e));
}

function onPageWidthChange(value: number): void {
  void settingsStore.setPageWidth(value).catch((e) => console.error('settingsStore.setPageWidth 失败:', e));
}

function onTextConvertChange(value: string): void {
  void settingsStore
    .setTextConvert(value as TextConvertType)
    .catch((e) => console.error('settingsStore.setTextConvert 失败:', e));
}

function onSmartFormatChange(value: boolean): void {
  void settingsStore.setSmartFormat(value).catch((e) => console.error('settingsStore.setSmartFormat 失败:', e));
}

function onThemeChange(value: string): void {
  void settingsStore.setAppTheme(value as ThemeType).catch((e) => console.error('settingsStore.setAppTheme 失败:', e));
}

function onThemeFollowSystemChange(value: boolean): void {
  void settingsStore
    .setAppThemeFollowSystem(value)
    .catch((e) => console.error('settingsStore.setAppThemeFollowSystem 失败:', e));
}

function onReaderThemeChange(value: string): void {
  void settingsStore
    .setReaderTheme(value as ThemeType)
    .catch((e) => console.error('settingsStore.setReaderTheme 失败:', e));
}

function onReaderThemeFollowSystemChange(value: boolean): void {
  void settingsStore
    .setReaderThemeFollowSystem(value)
    .catch((e) => console.error('settingsStore.setReaderThemeFollowSystem 失败:', e));
}

async function handleReset(): Promise<void> {
  await settingsStore.resetToDefaults();
  message.success(t('settings.reading.resetDone'));
}

/* ==================== 数据管理 ==================== */

const userDataPath = ref<string>('');
const loading = ref<boolean>(false);
const clearing = ref<boolean>(false);

/** appApi.getPaths 返回的完整数据目录集合 */
interface AppPathsInfo {
  userData: string;
  config: string;
  books: string;
  covers: string;
  cache: string;
}

/** 完整路径集合（数据目录区展示子路径 + 打开按钮用） */
const appPaths = ref<AppPathsInfo | null>(null);

/** 数据目录子路径展示列表（每项带"打开"按钮） */
const dataSubPaths = computed<Array<{ key: 'books' | 'covers' | 'cache'; label: string; value: string }>>(() => {
  if (!appPaths.value) return [];
  return [
    { key: 'books', label: t('settings.data.booksDir'), value: appPaths.value.books },
    { key: 'covers', label: t('settings.data.coversDir'), value: appPaths.value.covers },
    { key: 'cache', label: t('settings.data.cacheDir'), value: appPaths.value.cache }
  ];
});

/** 在系统文件管理器中打开数据目录（主进程枚举白名单校验） */
async function handleOpenPath(target: 'userData' | 'books' | 'covers' | 'cache'): Promise<void> {
  try {
    await window.appApi.openPath(target);
  } catch (err) {
    console.error('[settings] 打开目录失败:', err);
    message.error(t('settings.data.openDirFailed'));
  }
}

/* ─── 数据目录迁移（高级页） ─── */

/** 迁移进行中标志（按钮 loading） */
const migrating = ref<boolean>(false);

/** 迁移进度（由 APP_MIGRATE_PROGRESS 事件驱动） */
const migrateProgress = ref<{ show: boolean; current: number; total: number; percentage: number; done: boolean }>({
  show: false,
  current: 0,
  total: 0,
  percentage: 0,
  done: false
});

/**
 * 更改数据目录：选目录 → 确认（剪切语义说明）→ 主进程移动 books/covers/youdu.db
 * → 写 youdu-config.json → 通知所有窗口全局刷新。
 */
async function handleChangeDataRoot(): Promise<void> {
  if (migrating.value) return;

  let newRoot: string | null = null;
  try {
    newRoot = await window.appApi.selectDirectory();
  } catch (err) {
    console.error('[settings] 选择目录失败:', err);
    return;
  }
  if (!newRoot) return; // 用户取消

  // 确认对话框：明确"剪切不是复制"、旧数据清理、大数据量耗时
  dialog.warning({
    title: t('settings.advanced.dataRoot.confirmTitle'),
    content: t('settings.advanced.dataRoot.confirmContent'),
    positiveText: t('common.actions.confirm'),
    negativeText: t('common.actions.cancel'),
    onPositiveClick: () => {
      void doMigrateDataRoot(newRoot as string);
    }
  });
}

/** 执行迁移（主进程移动数据 + 写配置），完成后由主进程自动重启 */
async function doMigrateDataRoot(newRoot: string): Promise<void> {
  migrating.value = true;
  // 重置进度状态，避免上一次迁移的残留显示
  migrateProgress.value = { show: false, current: 0, total: 0, percentage: 0, done: false };
  // loadingMsg 声明在 try 外，使 finally 能访问到（参考 handleRedetectAllComics）。
  // 避免迁移中抛异常时 destroy() 不执行导致 loading 永久显示。
  let loadingMsg: MessageReactive | null = null;
  try {
    // 显示持久 loading 提示，让用户知道正在迁移（不再隐藏在后台）
    loadingMsg = message.loading(t('settings.advanced.dataRoot.migrating'), { duration: 0 });

    const result = await window.appApi.migrateData(newRoot);
    if (result.ok) {
      // 不再显示 dialog.success——主进程会发送 done:true 进度事件，
      // 然后自动重启。这里只需保持 loading 显示直到重启。
    }
  } catch (err) {
    console.error('[settings] 数据目录迁移失败:', err);
    message.error(t('settings.advanced.dataRoot.migrateFailed', { message: (err as Error).message }));
    // 失败时隐藏进度条
    migrateProgress.value.show = false;
  } finally {
    // 无论成功或失败都销毁 loading 提示，避免永久显示
    if (loadingMsg) {
      loadingMsg.destroy();
    }
    migrating.value = false;
  }
}

async function handleClearCache(): Promise<void> {
  if (clearing.value) return;
  clearing.value = true;
  try {
    const result = await window.exportApi.clearCache();
    if (result.success) {
      message.success(t('settings.data.cacheCleared', { n: result.deletedCount }));
    } else {
      message.error(t('settings.data.cacheClearFailed'));
    }
  } catch (err) {
    console.error('[export] 清空缓存失败', err);
    message.error(t('settings.data.cacheClearFailedLog'));
  } finally {
    clearing.value = false;
  }
}

/** 重新检测所有漫画状态 */
const redetecting = ref<boolean>(false);

/**
 * 批量重新解析所有 EPUB/MOBI/PDF 书籍
 *
 * 用于修复旧数据：漫画检测逻辑修复前导入的书 is_comic=0，
 * 此函数逐本调用 reparse 重新解析并更新 is_comic/content_type/章节索引/封面。
 */
async function handleRedetectAllComics(): Promise<void> {
  if (redetecting.value) return;
  redetecting.value = true;
  // P2 修复：将 loadingMsg 声明在 try 外，使 finally 能访问到。
  // 原实现 loadingMsg 在 try 内声明，若循环中抛异常则 destroy() 不会执行，
  // 导致加载提示永久显示。现统一在 finally 中销毁。
  let loadingMsg: MessageReactive | null = null;
  try {
    // 获取全部书籍
    const allBooks = (await window.dbApi.book.list({ limit: -1 })) as Array<{
      id: number;
      title?: string;
      file_type?: string | null;
    }>;
    // 仅对 epub/mobi/pdf 类型重新检测（txt/comic 无需检测）
    const targets = allBooks.filter((b) => b.file_type === 'epub' || b.file_type === 'mobi' || b.file_type === 'pdf');

    if (targets.length === 0) {
      message.info(t('settings.data.redetectNone'));
      return;
    }

    loadingMsg = message.loading(t('settings.data.redetectLoading', { current: 0, total: targets.length }), {
      duration: 0
    });

    let successCount = 0;
    let failCount = 0;
    let comicCount = 0;

    for (let i = 0; i < targets.length; i++) {
      const book = targets[i];
      if (loadingMsg) {
        loadingMsg.content = t('settings.data.redetectProgress', {
          current: i + 1,
          total: targets.length,
          title: book.title ?? ''
        });
      }
      try {
        const result = await window.dbApi.book.reparse(book.id);
        if (result.success) {
          successCount++;
          if (result.isComic) comicCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

    if (failCount === 0) {
      message.success(t('settings.data.redetectDone', { total: targets.length, comic: comicCount }));
    } else {
      message.warning(
        t('settings.data.redetectDonePartial', { success: successCount, fail: failCount, comic: comicCount })
      );
    }
  } catch (err) {
    console.error('[settings] 批量重新解析失败', err);
    message.error(t('settings.data.redetectFailed'));
  } finally {
    // P2 修复：无论成功或失败都销毁加载提示，避免永久显示
    if (loadingMsg) {
      loadingMsg.destroy();
    }
    redetecting.value = false;
  }
}

async function loadPaths(): Promise<void> {
  loading.value = true;
  try {
    const paths = await window.appApi.getPaths();
    appPaths.value = paths;
    userDataPath.value = paths.userData;
  } catch (err) {
    console.error('[settings] 读取路径失败', err);
  } finally {
    loading.value = false;
  }
}

function formatCreatedAt(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ==================== 内容替换规则（v18 新增） ==================== */

interface ReplaceRuleItem {
  id: number;
  pattern: string;
  replacement: string;
  scope: 'global' | 'book';
  book_id: number | null;
  is_regex: number;
  enabled: number;
  created_at: number | null;
}

const replaceRules = ref<ReplaceRuleItem[]>([]);
const replaceRulesLoading = ref<boolean>(false);

async function loadReplaceRules(): Promise<void> {
  replaceRulesLoading.value = true;
  try {
    replaceRules.value = await window.dbApi.replaceRule.list();
  } catch (err) {
    console.error('[settings] 加载内容替换规则失败', err);
    message.error(t('settings.advanced.rules.loadFailed'));
  } finally {
    replaceRulesLoading.value = false;
  }
}

async function handleDeleteReplaceRule(id: number): Promise<void> {
  try {
    await window.dbApi.replaceRule.delete(id);
    message.success(t('settings.advanced.rules.deleted'));
    await loadReplaceRules();
  } catch (err) {
    console.error('[settings] 删除替换规则失败', err);
    message.error(t('settings.advanced.rules.deleteFailed'));
  }
}

async function handleToggleReplaceRule(item: ReplaceRuleItem): Promise<void> {
  const newEnabled = item.enabled === 1 ? 0 : 1;
  try {
    await window.dbApi.replaceRule.toggle(item.id, newEnabled);
    item.enabled = newEnabled;
  } catch (err) {
    console.error('[settings] 切换替换规则状态失败', err);
    message.error(t('settings.advanced.rules.toggleFailed'));
  }
}

/** 格式化替换规则展示文本（截断长文本） */
function formatPattern(text: string): string {
  return text.length > 40 ? text.slice(0, 40) + '…' : text;
}

/** 格式化替换为的内容展示 */
function formatReplacement(text: string): string {
  if (!text) return t('settings.advanced.rules.deleteMark');
  return text.length > 40 ? text.slice(0, 40) + '…' : text;
}

/* ─── 内容替换规则批量管理（合并去广告功能后新增） ─── */

/** 选中的替换规则 ID 集合 */
const selectedReplaceRuleIds = ref<Set<number>>(new Set());
/** 批量操作进行中标志 */
const replaceBatchOperating = ref<boolean>(false);

/** 是否全选 */
const isAllReplaceSelected = computed<boolean>(
  () => replaceRules.value.length > 0 && selectedReplaceRuleIds.value.size === replaceRules.value.length
);

/** 是否有选中项 */
const hasReplaceSelection = computed<boolean>(() => selectedReplaceRuleIds.value.size > 0);

/** 切换全选/全不选 */
function toggleSelectAllReplace(): void {
  if (isAllReplaceSelected.value) {
    selectedReplaceRuleIds.value = new Set();
  } else {
    selectedReplaceRuleIds.value = new Set(replaceRules.value.map((r: ReplaceRuleItem) => r.id));
  }
}

/** 切换单条规则选中状态 */
function toggleSelectReplaceRule(id: number): void {
  const next = new Set(selectedReplaceRuleIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedReplaceRuleIds.value = next;
}

/** 批量删除选中的替换规则 */
async function handleReplaceBatchDelete(): Promise<void> {
  if (replaceBatchOperating.value || selectedReplaceRuleIds.value.size === 0) return;
  const count = selectedReplaceRuleIds.value.size;
  dialog.warning({
    title: t('settings.advanced.rules.confirmDeleteTitle'),
    content: t('settings.advanced.rules.confirmDeleteContent', { n: count }),
    positiveText: t('settings.advanced.rules.confirmDelete'),
    negativeText: t('common.actions.cancel'),
    onPositiveClick: async () => {
      replaceBatchOperating.value = true;
      try {
        const ids = Array.from(selectedReplaceRuleIds.value);
        await Promise.all(ids.map((id: number) => window.dbApi.replaceRule.delete(id)));
        message.success(t('settings.advanced.rules.batchDeleted', { n: count }));
        selectedReplaceRuleIds.value = new Set();
        await loadReplaceRules();
      } catch (err) {
        console.error('[settings] 批量删除替换规则失败', err);
        message.error(t('settings.advanced.rules.batchDeleteFailed'));
      } finally {
        replaceBatchOperating.value = false;
      }
    }
  });
}

/** 批量启用/禁用选中的替换规则 */
async function handleReplaceBatchToggle(enabled: number): Promise<void> {
  if (replaceBatchOperating.value || selectedReplaceRuleIds.value.size === 0) return;
  const count = selectedReplaceRuleIds.value.size;
  replaceBatchOperating.value = true;
  try {
    const ids = Array.from(selectedReplaceRuleIds.value);
    await Promise.all(ids.map((id: number) => window.dbApi.replaceRule.toggle(id, enabled)));
    message.success(
      enabled === 1
        ? t('settings.advanced.rules.batchEnabled', { n: count })
        : t('settings.advanced.rules.batchDisabled', { n: count })
    );
    selectedReplaceRuleIds.value = new Set();
    await loadReplaceRules();
  } catch (err) {
    console.error('[settings] 批量启停替换规则失败', err);
    message.error(t('settings.advanced.rules.batchOpFailed'));
  } finally {
    replaceBatchOperating.value = false;
  }
}

/* ==================== 阅读统计 ==================== */

/** 全局阅读统计汇总 */
interface GlobalStats {
  totalDuration: number;
  totalSessions: number;
  totalChars: number;
  avgSpeed: number;
}

/** 时间范围内的阅读统计 */
interface RangeStats {
  duration: number;
  sessions: number;
  chars: number;
}

/** 按天阅读统计（热图用） */
interface DailyStat {
  date: string;
  duration: number;
  chars: number;
}

/** 最常阅读书籍项 */
interface TopBook {
  bookId: number;
  title: string;
  duration: number;
  cover?: string | null;
}

/** 热图展示天数 */
const HEATMAP_DAYS = 30;

const globalStats = ref<GlobalStats>({
  totalDuration: 0,
  totalSessions: 0,
  totalChars: 0,
  avgSpeed: 0
});
const todayStats = ref<RangeStats>({ duration: 0, sessions: 0, chars: 0 });
const weekStats = ref<RangeStats>({ duration: 0, sessions: 0, chars: 0 });
const monthStats = ref<RangeStats>({ duration: 0, sessions: 0, chars: 0 });
const streakDays = ref<number>(0);
const topBooks = ref<TopBook[]>([]);
/** 热图原始数据（仅有记录的日期） */
const dailyStatsRaw = ref<DailyStat[]>([]);
/** 热图展示数据（已补零，长度恒为 HEATMAP_DAYS） */
const dailyStats = computed<DailyStat[]>(() => {
  const map = new Map<string, number>();
  const charsMap = new Map<string, number>();
  for (const d of dailyStatsRaw.value) {
    map.set(d.date, d.duration);
    charsMap.set(d.date, d.chars);
  }
  const result: DailyStat[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ONE_DAY = 24 * 60 * 60 * 1000;
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * ONE_DAY);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${day}`;
    result.push({
      date: dateStr,
      duration: map.get(dateStr) ?? 0,
      chars: charsMap.get(dateStr) ?? 0
    });
  }
  return result;
});

const statsLoading = ref<boolean>(false);

/**
 * 格式化阅读时长（毫秒 → 友好文本）
 *
 * - <1 小时：X分钟
 * - <1 天：X小时Y分
 * - >=1 天：X天Y小时
 */
function formatDuration(ms: number): string {
  if (ms <= 0) return t('settings.stats.duration.zero');
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return t('settings.stats.duration.minutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) {
    return mins > 0
      ? t('settings.stats.duration.hoursMinutes', { h: hours, m: mins })
      : t('settings.stats.duration.hours', { n: hours });
  }
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0
    ? t('settings.stats.duration.daysHours', { d: days, h: remainHours })
    : t('settings.stats.duration.days', { n: days });
}

/**
 * 获取热图颜色级别（GitHub 风格，5 级）
 *
 * - level-0：无阅读
 * - level-1：<10 分钟
 * - level-2：<30 分钟
 * - level-3：<1 小时
 * - level-4：>=1 小时
 */
function getHeatmapClass(duration: number): string {
  if (duration === 0) return 'heatmap-level-0';
  if (duration < 10 * 60 * 1000) return 'heatmap-level-1';
  if (duration < 30 * 60 * 1000) return 'heatmap-level-2';
  if (duration < 60 * 60 * 1000) return 'heatmap-level-3';
  return 'heatmap-level-4';
}

/** 加载阅读统计数据 */
async function loadReadingStats(): Promise<void> {
  const api = window.dbApi.readingStats;
  statsLoading.value = true;
  try {
    const [globalRes, todayRes, weekRes, monthRes, streakRes, topRes, dailyRes] = await Promise.all([
      api.global(),
      api.today(),
      api.range(7),
      api.range(30),
      api.streak(),
      api.topBooks(5),
      api.daily(HEATMAP_DAYS)
    ]);
    globalStats.value = globalRes;
    todayStats.value = todayRes;
    weekStats.value = weekRes;
    monthStats.value = monthRes;
    streakDays.value = streakRes;
    topBooks.value = topRes;
    dailyStatsRaw.value = dailyRes;
  } catch (err) {
    console.error('[settings] 加载阅读统计失败', err);
    message.error(t('settings.stats.loadFailed'));
  } finally {
    statsLoading.value = false;
  }
}

/* ==================== 网络配置（v20 新增） ==================== */

/** 网络配置类型（与主进程 NetworkConfig 对应） */
interface NetworkConfig {
  userAgent: string;
  /**
   * 自定义 HTTP 头列表。
   * P2 修复：新增可选 _id 字段作为前端 v-for key，避免用数组索引 idx 作 key
   * 导致删除/重排时 Vue 复用错误 DOM。_id 仅前端使用，保存到主进程时会被剥离。
   */
  customHeaders: Array<{ key: string; value: string; _id?: string }>;
  proxy: { enabled: boolean; type: string; host: string; port: number };
  /** 连接超时（毫秒），默认 30000，范围 5000-120000 */
  timeout: number;
  /** 重试次数，默认 3，范围 0-10 */
  retryCount: number;
  /** 重试间隔（毫秒），默认 1000，范围 100-10000 */
  retryDelay: number;
}

/** 网络配置默认值（与主进程 DEFAULT_NETWORK_CONFIG 保持一致） */
const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  customHeaders: [],
  proxy: { enabled: false, type: 'http', host: '', port: 0 },
  timeout: 30000,
  retryCount: 3,
  retryDelay: 1000
};

const networkConfig = ref<NetworkConfig>({
  userAgent: DEFAULT_NETWORK_CONFIG.userAgent,
  customHeaders: [],
  proxy: { enabled: false, type: 'http', host: '', port: 0 },
  timeout: DEFAULT_NETWORK_CONFIG.timeout,
  retryCount: DEFAULT_NETWORK_CONFIG.retryCount,
  retryDelay: DEFAULT_NETWORK_CONFIG.retryDelay
});

/** 网络配置自动保存防抖 timer ID（onBeforeUnmount 清理，防止卸载后触发保存） */
let networkSaveTimer: ReturnType<typeof setTimeout> | null = null;
/** 网络配置加载完成标志：load 回写触发的 watch 不触发自动保存 */
let networkLoaded = false;

/** User-Agent 预设（点击即填入输入框） */
const UA_PRESETS: Array<{ label: string; value: string; auto?: boolean }> = [
  { label: '自动（跟随系统）', value: '', auto: true },
  {
    label: 'Chrome (Windows)',
    value:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  },
  {
    label: 'Chrome (Linux)',
    value:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  },
  {
    label: 'Firefox (Windows)',
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
  },
  {
    label: 'Firefox (Linux)',
    value: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0'
  },
  {
    label: 'Safari (macOS)',
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
  }
];

/** 根据当前操作系统自动选择对应平台的 User-Agent */
function getAutoUA(): string {
  const platform = navigator.platform || '';
  if (platform.startsWith('Win')) {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  } else if (platform.startsWith('Mac')) {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15';
  }
  // Linux 及其他
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}

/** 加载网络配置（从主进程读取） */
async function loadNetworkConfig(): Promise<void> {
  try {
    if (!window.networkApi) return;
    const config = await window.networkApi.getConfig();
    if (config) {
      // P2 修复：为每个 customHeader 补充唯一 _id（旧数据可能没有）
      // 确保前端 v-for key 稳定，删除/重排时不会渲染错误。
      // 注意：preload 返回的 customHeaders 类型不含 _id，需在此重建数组。
      const headers = (Array.isArray(config.customHeaders) ? config.customHeaders : []).map((h) => ({
        key: h.key,
        value: h.value,
        _id: generateHeaderId()
      }));
      networkLoaded = false;
      networkConfig.value = {
        ...networkConfig.value,
        ...config,
        customHeaders: headers
      };
      // 等本次赋值触发的 watch 回调跳过后再放开自动保存
      void nextTick(() => {
        networkLoaded = true;
      });
    } else {
      networkLoaded = true;
    }
  } catch (err) {
    console.error('[settings] 加载网络配置失败:', err);
    networkLoaded = true;
  }
}

/**
 * 保存网络配置（写入主进程并实时应用）
 * 由 watch 防抖自动触发；成功不提示（避免频繁打扰），仅失败提示。
 */
async function saveNetworkConfig(): Promise<void> {
  try {
    if (!window.networkApi) return;
    // P2 修复：保存前剥离 _id 字段，主进程 NetworkConfig 不包含此字段
    // 重要：必须手动构造纯对象，不能用 ...networkConfig.value 浅拷贝——
    // proxy 仍是 Vue reactive Proxy，在 sandbox+contextIsolation 下
    // contextBridge 无法序列化 ES Proxy，导致 IPC 调用失败。
    const configToSave = {
      userAgent: networkConfig.value.userAgent,
      customHeaders: networkConfig.value.customHeaders.map(({ key, value }) => ({ key, value })),
      proxy: {
        enabled: networkConfig.value.proxy.enabled,
        type: networkConfig.value.proxy.type,
        host: networkConfig.value.proxy.host,
        port: networkConfig.value.proxy.port
      },
      timeout: networkConfig.value.timeout,
      retryCount: networkConfig.value.retryCount,
      retryDelay: networkConfig.value.retryDelay
    };
    await window.networkApi.setConfig(configToSave);
  } catch (err) {
    console.error('[settings] 网络配置保存失败:', err);
    message.error(t('settings.advanced.network.saveFailed', { message: (err as Error).message }));
  }
}

// 自动保存：配置变更后防抖 500ms 写入（用户要求免手动保存）
watch(
  networkConfig,
  () => {
    if (!networkLoaded) return;
    if (networkSaveTimer) clearTimeout(networkSaveTimer);
    networkSaveTimer = setTimeout(() => {
      networkSaveTimer = null;
      void saveNetworkConfig();
    }, 500);
  },
  { deep: true }
);

/**
 * 生成 customHeader 项的唯一标识。
 * 使用递增计数器 + 时间戳，保证当前会话内唯一。
 */
let headerIdCounter = 0;
function generateHeaderId(): string {
  headerIdCounter++;
  return `hdr-${Date.now()}-${headerIdCounter}`;
}

/** 添加自定义头（在列表末尾追加空行） */
function addCustomHeader(): void {
  networkConfig.value.customHeaders.push({ key: '', value: '', _id: generateHeaderId() });
}

/** 删除指定位置的自定义头 */
function removeCustomHeader(index: number): void {
  networkConfig.value.customHeaders.splice(index, 1);
}

/* ==================== 阅读偏好设置 ==================== */

/** 翻页方向选项 */
const pageTurnDirectionOptions = computed<SelectOption[]>(() => [
  { label: t('settings.reading.directionLtr'), value: 'left-to-right' },
  { label: t('settings.reading.directionRtl'), value: 'right-to-left' }
]);

/** 点击翻页区域选项 */
const tapTurnZoneOptions = computed<SelectOption[]>(() => [
  { label: t('settings.reading.zoneLeftRight'), value: 'left-right' },
  { label: t('settings.reading.zoneBottom'), value: 'bottom' },
  { label: t('settings.reading.zoneFull'), value: 'full' }
]);

function onPageTurnDirectionChange(value: string): void {
  void settingsStore
    .setPageTurnDirection(value as PageTurnDirectionType)
    .catch((e) => console.error('settingsStore.setPageTurnDirection 失败:', e));
}

function onTapTurnEnabledChange(value: boolean): void {
  void settingsStore.setTapTurnEnabled(value).catch((e) => console.error('settingsStore.setTapTurnEnabled 失败:', e));
}

function onTapTurnZoneChange(value: string): void {
  void settingsStore
    .setTapTurnZone(value as TapTurnZoneType)
    .catch((e) => console.error('settingsStore.setTapTurnZone 失败:', e));
}

function onAutoScrollSpeedChange(value: number): void {
  void settingsStore.setAutoScrollSpeed(value).catch((e) => console.error('settingsStore.setAutoScrollSpeed 失败:', e));
}

/* ==================== 快捷键设置 ==================== */

/** 快捷键动作顺序（用于列表展示） */
const SHORTCUT_ACTION_ORDER = [
  'nextPage',
  'prevPage',
  'nextChapter',
  'prevChapter',
  'toggleBookmark',
  'toggleSearch',
  'toggleFullscreen',
  'toggleTTS',
  'closeReader'
];

/** 快捷键列表（按 SHORTCUT_ACTION_ORDER 顺序展开为 {action, label, key}，label 随语言本地化） */
const shortcutList = computed<Array<{ action: string; label: string; key: string }>>(() =>
  SHORTCUT_ACTION_ORDER.map((action) => ({
    action,
    label: t(`settings.shortcuts.${action}`),
    key: settingsStore.keyboardShortcuts[action] ?? ''
  }))
);

/** 当前正在编辑的快捷键动作名（null 表示未编辑） */
const editingShortcutAction = ref<string | null>(null);
/** 快捷键编辑模态框可见性 */
const shortcutModalVisible = ref<boolean>(false);
/** 当前捕获到的按键组合（待保存） */
const capturedKey = ref<string>('');
/** 捕获区域元素引用（Bug 修复：模态框打开后自动聚焦，keydown 才能触发） */
const shortcutCaptureRef = ref<HTMLElement | null>(null);

/** 打开快捷键编辑模态框 */
function handleEditShortcut(action: string): void {
  editingShortcutAction.value = action;
  capturedKey.value = settingsStore.keyboardShortcuts[action] ?? '';
  shortcutModalVisible.value = true;
  // Bug 修复：模态框打开后自动聚焦捕获区域，否则 keydown 事件不触发、捕获不到按键
  void nextTick(() => {
    shortcutCaptureRef.value?.focus();
  });
}

/**
 * 捕获按键事件并格式化为快捷键组合字符串
 *
 * 格式：修饰键+键名，如 "Ctrl+ArrowRight"、"Alt+B"、"F11"
 * 修饰键顺序：Ctrl → Alt → Shift → Meta
 */
function handleKeyCapture(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();

  // Escape 不捕获为快捷键，而是关闭模态框（否则用户无法用 Esc 退出）
  if (event.key === 'Escape') {
    shortcutModalVisible.value = false;
    return;
  }

  // 忽略单独按下修饰键
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  parts.push(event.key);
  capturedKey.value = parts.join('+');
}

/** 保存当前捕获的快捷键 */
async function handleSaveShortcut(): Promise<void> {
  if (!editingShortcutAction.value) return;
  await settingsStore.setKeyboardShortcut(editingShortcutAction.value, capturedKey.value);
  shortcutModalVisible.value = false;
  editingShortcutAction.value = null;
  message.success(t('settings.shortcuts.updated'));
}

/** 清除某个动作的快捷键 */
async function handleClearShortcut(action: string): Promise<void> {
  await settingsStore.setKeyboardShortcut(action, '');
  message.success(t('settings.shortcuts.cleared'));
}

/** 重置所有快捷键为默认值 */
async function handleResetShortcuts(): Promise<void> {
  // 逐个重置为默认值（通过 setKeyboardShortcut 写入空再 resetToDefaults 会重置全部设置，
  // 这里仅重置快捷键：直接调用 resetToDefaults 中的快捷键部分）
  // 由于 stores 未暴露单独的 resetKeyboardShortcuts，这里通过逐个设置默认值实现
  const defaults: KeyboardShortcuts = {
    nextPage: 'ArrowRight',
    prevPage: 'ArrowLeft',
    nextChapter: 'Ctrl+ArrowRight',
    prevChapter: 'Ctrl+ArrowLeft',
    toggleBookmark: 'Ctrl+B',
    toggleSearch: 'Ctrl+F',
    toggleFullscreen: 'F11',
    toggleTTS: 'Ctrl+T',
    closeReader: 'Escape'
  };
  for (const action of SHORTCUT_ACTION_ORDER) {
    await settingsStore.setKeyboardShortcut(action, defaults[action] ?? '');
  }
  message.success(t('settings.shortcuts.resetDone'));
}

/* ==================== 通知设置 ==================== */

/** 通知配置（存储在 settings 表 key='notification_config'） */
interface NotificationConfig {
  /** RSS 更新通知 */
  rssUpdate: boolean;
  /** 阅读提醒 */
  readingReminder: boolean;
  /** 提醒时间（NTimePicker 毫秒值，从当天 00:00 起算；20:00 = 72000000） */
  reminderTime: number;
}

/** 通知默认配置 */
const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  rssUpdate: true,
  readingReminder: false,
  reminderTime: 20 * 60 * 60 * 1000 // 20:00 → 72000000ms
};

const notificationConfig = ref<NotificationConfig>({ ...DEFAULT_NOTIFICATION_CONFIG });
/** 通知配置自动保存防抖 timer ID（onBeforeUnmount 清理，防止卸载后触发保存） */
let notificationSaveTimer: ReturnType<typeof setTimeout> | null = null;
/** 通知配置加载完成标志：load 回写触发的 watch 不触发自动保存 */
let notificationLoaded = false;

/** 加载通知配置 */
async function loadNotificationConfig(): Promise<void> {
  try {
    const raw = await window.dbApi.setting.get('notification_config');
    notificationLoaded = false;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NotificationConfig>;
      notificationConfig.value = {
        rssUpdate: typeof parsed.rssUpdate === 'boolean' ? parsed.rssUpdate : DEFAULT_NOTIFICATION_CONFIG.rssUpdate,
        readingReminder:
          typeof parsed.readingReminder === 'boolean'
            ? parsed.readingReminder
            : DEFAULT_NOTIFICATION_CONFIG.readingReminder,
        reminderTime:
          typeof parsed.reminderTime === 'number' ? parsed.reminderTime : DEFAULT_NOTIFICATION_CONFIG.reminderTime
      };
    }
    // 等本次赋值触发的 watch 回调跳过后再放开自动保存
    void nextTick(() => {
      notificationLoaded = true;
    });
  } catch (err) {
    console.error('[settings] 加载通知配置失败:', err);
    notificationLoaded = true;
  }
}

/**
 * 保存通知配置
 * 由 watch 防抖自动触发；成功不提示（避免频繁打扰），仅失败提示。
 */
async function saveNotificationConfig(): Promise<void> {
  try {
    await window.dbApi.setting.set('notification_config', JSON.stringify(notificationConfig.value));
  } catch (err) {
    console.error('[settings] 自动保存通知配置失败:', err);
    message.error(t('settings.general.saveFailed'));
  }
}

// 自动保存：配置变更后防抖 500ms 写入（用户要求免手动保存）
watch(
  notificationConfig,
  () => {
    if (!notificationLoaded) return;
    if (notificationSaveTimer) clearTimeout(notificationSaveTimer);
    notificationSaveTimer = setTimeout(() => {
      notificationSaveTimer = null;
      void saveNotificationConfig();
    }, 500);
  },
  { deep: true }
);

/** NTimePicker 值（毫秒数）变更处理 */
function onReminderTimeChange(value: number | null): void {
  notificationConfig.value.reminderTime = value ?? DEFAULT_NOTIFICATION_CONFIG.reminderTime;
}


/* ==================== 关于 ==================== */

const appVersion = ref<string>('0.0.1');
const techStack: string[] = ['Electron', 'Vue 3', 'TypeScript', 'Naive UI', 'SQLite'];

/** 关于页功能特性列表（随语言本地化） */
const aboutFeatures = computed<string[]>(() => [
  t('settings.about.feature1'),
  t('settings.about.feature2'),
  t('settings.about.feature3'),
  t('settings.about.feature4'),
  t('settings.about.feature5'),
  t('settings.about.feature6'),
  t('settings.about.feature7'),
  t('settings.about.feature8'),
  t('settings.about.feature9'),
  t('settings.about.feature10'),
  t('settings.about.feature11'),
  t('settings.about.feature12')
]);

/* ==================== 初始化 ==================== */

async function loadSettings(): Promise<void> {
  try {
    await settingsStore.loadSettings();
  } catch (err) {
    console.error('[settings] 读取设置失败', err);
    message.error(t('settings.loadSettingsFailed'));
  }
}

async function loadAppVersion(): Promise<void> {
  try {
    if (window.appApi) {
      const v = await window.appApi.getVersion();
      if (v) appVersion.value = v;
    }
  } catch (err) {
    console.warn('[settings] 获取版本失败', err);
  }
}

// 已加载过的 tab 集合，避免重复加载
const loadedTabs = ref<Set<string>>(new Set());

/** 懒加载某个 tab 的数据（只在首次切换到该 tab 时加载） */
function ensureTabLoaded(tab: string): void {
  if (loadedTabs.value.has(tab)) return;
  loadedTabs.value.add(tab);

  if (tab === 'reading') {
    // 阅读设置数据已在 loadSettings 中加载（settingsStore）
    void loadSettings().catch((e) => console.error('loadSettings 失败:', e));
  } else if (tab === 'appearance') {
    void loadSettings().catch((e) => console.error('loadSettings 失败:', e));
  } else if (tab === 'general') {
    // 快捷键/语言在 settingsStore（启动已加载），这里补载通知配置
    void loadNotificationConfig().catch((e) => console.error('loadNotificationConfig 失败:', e));
  } else if (tab === 'data') {
    void loadPaths().catch((e) => console.error('loadPaths 失败:', e));
  } else if (tab === 'advanced') {
    // 高级：内容替换规则 + 网络配置
    void loadReplaceRules().catch((e) => console.error('loadReplaceRules 失败:', e));
    void loadNetworkConfig().catch((e) => console.error('loadNetworkConfig 失败:', e));
    void loadPaths().catch((e) => console.error('loadPaths 失败:', e));
  } else if (tab === 'stats') {
    void loadReadingStats().catch((e) => console.error('loadReadingStats 失败:', e));
  } else if (tab === 'about') {
    void loadAppVersion().catch((e) => console.error('loadAppVersion 失败:', e));
    void loadPaths().catch((e) => console.error('loadPaths 失败:', e));
  }
}

// 启动时预载设置项和应用版本，再按默认 tab 懒加载
onMounted(() => {
  void loadSettings().catch((e) => console.error('loadSettings 失败:', e));
  void loadAppVersion().catch((e) => console.error('loadAppVersion 失败:', e));
  ensureTabLoaded(activeTab.value);

  // 监听迁移进度：主进程逐个移动文件时推送进度，完成后提示"即将自动重启"
  window.appApi.onMigrateProgress((progress) => {
    if (progress.done) {
      migrateProgress.value.done = true;
      migrateProgress.value.percentage = 100;
    } else {
      migrateProgress.value.show = true;
      migrateProgress.value.current = progress.current;
      migrateProgress.value.total = progress.total;
      migrateProgress.value.percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
    }
  });

});

// 清理自动保存防抖 timer：组件卸载后不再触发保存，避免访问已销毁的 message/配置
onBeforeUnmount(() => {
  if (notificationSaveTimer) {
    clearTimeout(notificationSaveTimer);
    notificationSaveTimer = null;
  }
  if (networkSaveTimer) {
    clearTimeout(networkSaveTimer);
    networkSaveTimer = null;
  }

  window.appApi.offMigrateProgress();
});

// 监听 tab 切换，懒加载对应数据
watch(activeTab, (newTab: string) => {
  ensureTabLoaded(newTab);
});
</script>

<template>
  <div class="settings-root">
    <!-- 固定 header -->
    <header class="settings-header">
      <h1 class="page-title">
        <n-icon :component="Palette" :size="20" class="title-icon" />
        {{ t('settings.title') }}
      </h1>
    </header>

    <!-- 内容滚动区 -->
    <div class="settings-view">
      <div class="settings-container">
        <n-tabs v-model:value="activeTab" type="line" animated class="settings-tabs">
          <!-- ─── 通用（语言 / 快捷键 / 通知） ─── -->
          <n-tab-pane name="general" :tab="t('settings.tabs.general')">
            <n-card class="settings-card" bordered>
              <template #header>
                <div class="card-header">
                  <n-icon :component="Keyboard" :size="16" class="card-header-icon" />
                  <span>{{ t('settings.tabs.general') }}</span>
                </div>
              </template>

              <!-- 区域1：界面语言 -->
              <div class="section-title">{{ t('settings.general.language') }}</div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.general.language') }}</span>
                  <span class="label-hint">{{ t('settings.general.languageHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-select
                    :value="currentLocale"
                    :options="localeOptions"
                    style="width: 180px"
                    @update:value="handleLocaleChange"
                  />
                </div>
              </div>

              <n-divider class="group-divider" />

              <!-- 区域2：快捷键设置 -->
              <div class="section-title">{{ t('settings.general.shortcutSettings') }}</div>

              <div class="ad-rules-hint">
                {{ t('settings.general.shortcutHint') }}
              </div>

              <n-list bordered>
                <n-list-item v-for="item in shortcutList" :key="item.action">
                  <n-thing>
                    <template #header>
                      <span class="shortcut-action-label">{{ item.label }}</span>
                    </template>
                    <template #description>
                      <n-tag size="small" type="info" round>
                        {{ item.key || t('settings.shortcuts.notSet') }}
                      </n-tag>
                    </template>
                    <template #action>
                      <n-space size="small">
                        <n-button size="small" quaternary @click="handleEditShortcut(item.action)">
                          {{ t('common.actions.edit') }}
                        </n-button>
                        <n-button size="small" quaternary type="error" @click="handleClearShortcut(item.action)">
                          {{ t('settings.shortcuts.clear') }}
                        </n-button>
                      </n-space>
                    </template>
                  </n-thing>
                </n-list-item>
              </n-list>

              <div class="reset-row">
                <n-button block secondary @click="handleResetShortcuts">
                  <template #icon>
                    <n-icon :component="RotateCcw" :size="16" />
                  </template>
                  {{ t('settings.shortcuts.resetToDefault') }}
                </n-button>
              </div>

              <n-divider class="group-divider" />

              <!-- 区域3：通知设置 -->
              <div class="section-title">{{ t('settings.general.notifications') }}</div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.general.rssUpdate') }}</span>
                  <span class="label-hint">{{ t('settings.general.rssUpdateHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-switch v-model:value="notificationConfig.rssUpdate" />
                </div>
              </div>

              <n-divider class="sub-divider" />

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.general.readingReminder') }}</span>
                  <span class="label-hint">{{ t('settings.general.readingReminderHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-switch v-model:value="notificationConfig.readingReminder" />
                </div>
              </div>

              <div v-if="notificationConfig.readingReminder" class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.general.reminderTime') }}</span>
                  <span class="label-hint">{{ t('settings.general.reminderTimeHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-time-picker
                    :value="notificationConfig.reminderTime"
                    format="HH:mm"
                    style="width: 160px"
                    @update:value="onReminderTimeChange"
                  />
                </div>
              </div>

            </n-card>
          </n-tab-pane>

          <!-- ─── 阅读 ─── -->
          <n-tab-pane name="reading" :tab="t('settings.tabs.reading')">
            <n-card class="settings-card" bordered>
              <template #header>
                <div class="card-header">
                  <n-icon :component="SlidersHorizontal" :size="16" class="card-header-icon" />
                  <span>{{ t('settings.tabs.reading') }}</span>
                </div>
              </template>

              <!-- 区域1：排版设置 -->
              <div class="section-title">{{ t('settings.reading.layout') }}</div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.reading.fontSize') }}</span>
                  <span class="label-hint">{{ t('settings.reading.fontSizeHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-slider
                    :value="settingsStore.fontSize"
                    :min="14"
                    :max="32"
                    :step="1"
                    :format-tooltip="(v: number) => `${v}px`"
                    style="width: 220px"
                    @update:value="onFontSizeChange"
                  />
                  <n-tag size="small" type="info" round>{{ settingsStore.fontSize }}px</n-tag>
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.reading.fontFamily') }}</span>
                  <span class="label-hint">{{ t('settings.reading.fontFamilyHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-select
                    :value="settingsStore.fontFamily"
                    :options="localizedFontFamilyOptions"
                    style="width: 180px"
                    @update:value="onFontFamilyChange"
                  />
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.reading.lineHeight') }}</span>
                  <span class="label-hint">{{ t('settings.reading.lineHeightHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-slider
                    :value="settingsStore.lineHeight"
                    :min="1.2"
                    :max="2.5"
                    :step="0.1"
                    :format-tooltip="(v: number) => v.toFixed(1)"
                    style="width: 220px"
                    @update:value="onLineHeightChange"
                  />
                  <n-tag size="small" type="info" round>{{ lineHeightLabel }}</n-tag>
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.reading.pageWidth') }}</span>
                  <span class="label-hint">{{ t('settings.reading.pageWidthHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-slider
                    :value="settingsStore.pageWidth"
                    :min="600"
                    :max="1200"
                    :step="50"
                    :format-tooltip="(v: number) => `${v}px`"
                    style="width: 220px"
                    @update:value="onPageWidthChange"
                  />
                  <n-tag size="small" type="info" round>{{ settingsStore.pageWidth }}px</n-tag>
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.reading.textConvert') }}</span>
                  <span class="label-hint">{{ t('settings.reading.textConvertHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-select
                    :value="settingsStore.textConvert"
                    :options="textConvertOptions"
                    style="width: 180px"
                    @update:value="onTextConvertChange"
                  />
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.reading.smartFormat') }}</span>
                  <span class="label-hint">{{ t('settings.reading.smartFormatHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-switch :value="settingsStore.smartFormat" @update:value="onSmartFormatChange" />
                </div>
              </div>

              <n-divider class="sub-divider" />

              <!-- 区域2：翻页设置 -->
              <div class="section-title">{{ t('settings.reading.pageTurn') }}</div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.reading.pageTurnDirection') }}</span>
                  <span class="label-hint">{{ t('settings.reading.pageTurnDirectionHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-select
                    :value="settingsStore.pageTurnDirection"
                    :options="pageTurnDirectionOptions"
                    style="width: 180px"
                    @update:value="onPageTurnDirectionChange"
                  />
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.reading.tapTurn') }}</span>
                  <span class="label-hint">{{ t('settings.reading.tapTurnHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-switch :value="settingsStore.tapTurnEnabled" @update:value="onTapTurnEnabledChange" />
                </div>
              </div>

              <div v-if="settingsStore.tapTurnEnabled" class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.reading.tapTurnZone') }}</span>
                  <span class="label-hint">{{ t('settings.reading.tapTurnZoneHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-select
                    :value="settingsStore.tapTurnZone"
                    :options="tapTurnZoneOptions"
                    style="width: 180px"
                    @update:value="onTapTurnZoneChange"
                  />
                </div>
              </div>

              <n-divider class="sub-divider" />

              <!-- 区域3：自动滚动 -->
              <div class="section-title">{{ t('settings.reading.autoScroll') }}</div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.reading.autoScrollSpeed') }}</span>
                  <span class="label-hint">{{ t('settings.reading.autoScrollSpeedHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-slider
                    :value="settingsStore.autoScrollSpeed"
                    :min="10"
                    :max="200"
                    :step="5"
                    :format-tooltip="(v: number) => String(v)"
                    style="width: 220px"
                    @update:value="onAutoScrollSpeedChange"
                  />
                  <n-tag size="small" type="info" round>{{ settingsStore.autoScrollSpeed }}</n-tag>
                </div>
              </div>

              <n-divider class="group-divider" />

              <!-- 恢复默认 -->
              <div class="reset-row">
                <n-button block secondary @click="handleReset">
                  <template #icon>
                    <n-icon :component="RotateCcw" :size="16" />
                  </template>
                  {{ t('settings.reading.reset') }}
                </n-button>
              </div>
            </n-card>
          </n-tab-pane>

          <!-- ─── 外观 ─── -->
          <n-tab-pane name="appearance" :tab="t('settings.tabs.appearance')">
            <n-card class="settings-card" bordered>
              <template #header>
                <div class="card-header">
                  <n-icon :component="Palette" :size="16" class="card-header-icon" />
                  <span>{{ t('settings.tabs.appearance') }}</span>
                </div>
              </template>

              <!-- 区域1：应用主题 -->
              <div class="section-title">{{ t('settings.appearance.appTheme') }}</div>

              <!-- 应用主题（色块按钮） -->
              <div class="setting-row setting-row-block">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.appearance.appTheme') }}</span>
                  <span class="label-hint">{{ t('settings.appearance.appThemeHint') }}</span>
                </div>
                <div class="theme-grid">
                  <button
                    v-for="opt in localizedThemeSwatchOptions"
                    :key="`app-${opt.value}`"
                    type="button"
                    class="theme-swatch"
                    :class="{ active: settingsStore.appTheme === opt.value }"
                    :style="{ background: opt.bg, color: opt.text }"
                    @click="onThemeChange(opt.value)"
                  >
                    <span class="theme-swatch-label">A</span>
                    <span class="theme-swatch-name">{{ opt.label }}</span>
                  </button>
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.appearance.followSystem') }}</span>
                  <span class="label-hint">{{ t('settings.appearance.appFollowSystemHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-switch :value="settingsStore.appThemeFollowSystem" @update:value="onThemeFollowSystemChange" />
                </div>
              </div>

              <n-divider class="sub-divider" />

              <!-- 区域2：阅读器主题 -->
              <div class="section-title">{{ t('settings.appearance.readerTheme') }}</div>

              <!-- 阅读器主题（色块按钮） -->
              <div class="setting-row setting-row-block">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.appearance.readerTheme') }}</span>
                  <span class="label-hint">{{ t('settings.appearance.readerThemeHint') }}</span>
                </div>
                <div class="theme-grid">
                  <button
                    v-for="opt in localizedThemeSwatchOptions"
                    :key="`reader-${opt.value}`"
                    type="button"
                    class="theme-swatch"
                    :class="{ active: settingsStore.readerTheme === opt.value }"
                    :style="{ background: opt.bg, color: opt.text }"
                    @click="onReaderThemeChange(opt.value)"
                  >
                    <span class="theme-swatch-label">A</span>
                    <span class="theme-swatch-name">{{ opt.label }}</span>
                  </button>
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.appearance.followSystem') }}</span>
                  <span class="label-hint">{{ t('settings.appearance.readerFollowSystemHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-switch
                    :value="settingsStore.readerThemeFollowSystem"
                    @update:value="onReaderThemeFollowSystemChange"
                  />
                </div>
              </div>

              <n-divider class="sub-divider" />

              <!-- 区域3：自定义颜色 -->
              <div class="section-title">{{ t('settings.appearance.customColors') }}</div>

              <!-- 自定义主题颜色 -->
              <div v-if="showCustomColors" class="custom-colors">
                <div class="custom-colors-header">
                  <span class="label-text">{{ t('settings.appearance.customColors') }}</span>
                  <span class="label-hint">{{
                    t('settings.appearance.customColorsHint', { custom: t('settings.themes.custom') })
                  }}</span>
                </div>
                <!-- 预设主题快捷选择 -->
                <div class="preset-themes">
                  <span class="preset-label">{{ t('settings.appearance.presets') }}</span>
                  <button
                    v-for="preset in presetThemeOptions"
                    :key="preset.key"
                    type="button"
                    class="preset-btn"
                    :style="{ background: preset.bg, color: preset.text }"
                    @click="applyPresetTheme(preset)"
                  >
                    {{ preset.label }}
                  </button>
                </div>
                <div class="color-row">
                  <span class="color-label">{{ t('settings.appearance.bgColor') }}</span>
                  <n-color-picker
                    :value="customBg"
                    size="small"
                    :show-alpha="false"
                    @update:value="(v: string) => (customBg = v)"
                  />
                </div>
                <div class="color-row">
                  <span class="color-label">{{ t('settings.appearance.textColor') }}</span>
                  <n-color-picker
                    :value="customText"
                    size="small"
                    :show-alpha="false"
                    @update:value="(v: string) => (customText = v)"
                  />
                </div>
                <div class="color-row">
                  <span class="color-label">{{ t('settings.appearance.primaryColor') }}</span>
                  <n-color-picker
                    :value="customPrimary"
                    size="small"
                    :show-alpha="false"
                    @update:value="(v: string) => (customPrimary = v)"
                  />
                </div>
              </div>
            </n-card>
          </n-tab-pane>

          <!-- ─── 数据 ─── -->
          <n-tab-pane name="data" :tab="t('settings.tabs.data')">
            <n-card class="settings-card" bordered>
              <template #header>
                <div class="card-header">
                  <n-icon :component="Database" :size="16" class="card-header-icon" />
                  <span>{{ t('settings.tabs.data') }}</span>
                </div>
              </template>

              <!-- 区域1：数据管理 -->
              <div class="section-title">{{ t('settings.data.management') }}</div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.data.dataDir') }}</span>
                  <span class="label-hint">{{ t('settings.data.dataDirHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-input
                    :value="userDataPath"
                    readonly
                    style="width: 360px"
                    :placeholder="t('common.actions.loading')"
                  >
                    <template #prefix>
                      <n-icon :component="Folder" :size="16" />
                    </template>
                    <template #suffix>
                      <n-button size="tiny" quaternary @click="handleOpenPath('userData')">
                        {{ t('settings.data.openDir') }}
                      </n-button>
                    </template>
                  </n-input>
                  <n-button
                    type="primary"
                    ghost
                    size="small"
                    :loading="migrating"
                    style="margin-left: 8px; flex-shrink: 0"
                    @click="handleChangeDataRoot"
                  >
                    <template #icon>
                      <n-icon :component="Folder" />
                    </template>
                    {{ t('settings.advanced.dataRoot.changeButton') }}
                  </n-button>
                </div>
              </div>

              <!-- 迁移进度 -->
              <div v-if="migrateProgress.show || migrateProgress.done" class="migrate-progress">
                <n-progress
                  type="line"
                  :percentage="migrateProgress.percentage"
                  indicator-placement="inside"
                  :status="migrateProgress.done ? 'success' : 'default'"
                  :processing="!migrateProgress.done"
                />
                <div v-if="migrateProgress.done" class="migrate-restart-hint">
                  {{ t('settings.advanced.dataRoot.restarting') }}
                </div>
                <div v-else class="migrate-progress-text">
                  {{ migrateProgress.current }} / {{ migrateProgress.total }}
                </div>
              </div>

              <!-- 子目录路径列表（各带打开按钮） -->
              <div v-if="dataSubPaths.length > 0" class="data-sub-paths">
                <div v-for="p in dataSubPaths" :key="p.key" class="data-sub-path-row">
                  <span class="data-sub-path-label">{{ p.label }}</span>
                  <span class="data-sub-path-value" :title="p.value">{{ p.value }}</span>
                  <n-button size="tiny" quaternary @click="handleOpenPath(p.key)">
                    {{ t('settings.data.openDir') }}
                  </n-button>
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.data.clearCache') }}</span>
                  <span class="label-hint">{{ t('settings.data.clearCacheHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-button type="warning" :loading="clearing" :disabled="loading" @click="handleClearCache">
                    <template #icon>
                      <n-icon :component="Trash" />
                    </template>
                    {{ t('settings.data.clearCache') }}
                  </n-button>
                </div>
              </div>

              <div class="setting-row">
                <div class="setting-label">
                  <span class="label-text">{{ t('settings.data.redetect') }}</span>
                  <span class="label-hint">{{ t('settings.data.redetectHint') }}</span>
                </div>
                <div class="setting-control">
                  <n-button type="info" :loading="redetecting" @click="handleRedetectAllComics">
                    <template #icon>
                      <n-icon :component="RefreshCw" />
                    </template>
                    {{ t('settings.data.redetectButton') }}
                  </n-button>
                </div>
              </div>

            </n-card>
          </n-tab-pane>

          <!-- ─── 高级 ─── -->
          <n-tab-pane name="advanced" :tab="t('settings.tabs.advanced')">
            <n-card class="settings-card" bordered>
              <template #header>
                <div class="card-header">
                  <n-icon :component="ShieldX" :size="16" class="card-header-icon" />
                  <span>{{ t('settings.tabs.advanced') }}</span>
                </div>
              </template>

              <!-- 区域1：内容替换规则 -->
              <div class="section-title">{{ t('settings.advanced.rules.title') }}</div>

              <div class="ad-rules-hint">
                {{ t('settings.advanced.rules.hint') }}
                <br /><strong>{{ t('settings.advanced.rules.mergedNote') }}</strong>
              </div>
              <div class="replace-var-hint">
                {{ t('settings.advanced.rules.varSupport') }}<code>\n</code>={{
                  t('settings.advanced.rules.varNewline')
                }}
                <code>\r</code>={{ t('settings.advanced.rules.varCarriageReturn') }} <code>\t</code>={{
                  t('settings.advanced.rules.varTab')
                }}
                <code>\s</code>={{ t('settings.advanced.rules.varSpace') }} <code>\\</code>={{
                  t('settings.advanced.rules.varBackslash')
                }}
                <br />{{ t('settings.advanced.rules.varHintTail') }}
              </div>

              <!-- 批量操作工具栏 -->
              <div v-if="replaceRules.length > 0" class="ad-rules-batch-bar">
                <n-checkbox :checked="isAllReplaceSelected" @update:checked="toggleSelectAllReplace">
                  {{ t('common.actions.selectAll') }}
                </n-checkbox>
                <span class="ad-rules-count">
                  {{ t('settings.advanced.rules.count', { n: replaceRules.length })
                  }}{{
                    hasReplaceSelection
                      ? t('settings.advanced.rules.selectedCount', { n: selectedReplaceRuleIds.size })
                      : ''
                  }}
                </span>
                <div class="ad-rules-batch-actions">
                  <n-button
                    size="small"
                    type="error"
                    ghost
                    :disabled="!hasReplaceSelection"
                    :loading="replaceBatchOperating"
                    @click="handleReplaceBatchDelete"
                  >
                    <template #icon>
                      <n-icon :component="Trash" :size="16" />
                    </template>
                    {{ t('settings.advanced.rules.batchDelete') }}
                  </n-button>
                  <n-button
                    size="small"
                    type="primary"
                    ghost
                    :disabled="!hasReplaceSelection"
                    :loading="replaceBatchOperating"
                    @click="handleReplaceBatchToggle(1)"
                  >
                    <template #icon>
                      <n-icon :component="CircleCheck" :size="16" />
                    </template>
                    {{ t('settings.advanced.rules.batchEnable') }}
                  </n-button>
                  <n-button
                    size="small"
                    type="warning"
                    ghost
                    :disabled="!hasReplaceSelection"
                    :loading="replaceBatchOperating"
                    @click="handleReplaceBatchToggle(0)"
                  >
                    <template #icon>
                      <n-icon :component="CircleX" :size="16" />
                    </template>
                    {{ t('settings.advanced.rules.batchDisable') }}
                  </n-button>
                </div>
              </div>

              <div v-if="!replaceRulesLoading && replaceRules.length === 0" class="empty-state">
                <div class="empty-icon-wrap">
                  <n-icon :component="Replace" :size="56" />
                </div>
                <p class="empty-title">{{ t('settings.advanced.rules.empty') }}</p>
                <p class="empty-hint">{{ t('settings.advanced.rules.emptyHint') }}</p>
              </div>

              <n-list v-else bordered>
                <n-list-item v-for="item in replaceRules" :key="item.id">
                  <template #prefix>
                    <n-checkbox
                      :checked="selectedReplaceRuleIds.has(item.id)"
                      @update:checked="toggleSelectReplaceRule(item.id)"
                    />
                  </template>
                  <n-thing>
                    <template #header>
                      <span class="ad-rule-text" :class="{ 'ad-rule-disabled': item.enabled === 0 }">
                        {{ formatPattern(item.pattern) }}
                        <span class="replace-arrow">→</span>
                        <span class="replace-result">{{ formatReplacement(item.replacement) }}</span>
                      </span>
                    </template>
                    <template #description>
                      <span class="ad-rule-meta">
                        <n-tag size="small" :type="item.scope === 'global' ? 'info' : 'success'" round>
                          {{
                            item.scope === 'global'
                              ? t('settings.advanced.rules.scopeGlobal')
                              : t('settings.advanced.rules.scopeBook', { id: item.book_id })
                          }}
                        </n-tag>
                        <n-tag v-if="item.is_regex === 1" size="small" type="warning" round>
                          {{ t('settings.advanced.rules.regex') }}
                        </n-tag>
                        <n-tag v-else size="small" type="default" round>
                          {{ t('settings.advanced.rules.plainText') }}
                        </n-tag>
                        <span class="ad-rule-status">
                          {{ item.enabled === 1 ? t('settings.advanced.enabled') : t('settings.advanced.disabled') }}
                        </span>
                        <span class="ad-rule-time">
                          {{ formatCreatedAt(item.created_at) }}
                        </span>
                      </span>
                    </template>
                    <template #action>
                      <n-space size="small">
                        <n-button size="small" quaternary @click="handleToggleReplaceRule(item)">
                          {{ item.enabled === 1 ? t('common.actions.disable') : t('common.actions.enable') }}
                        </n-button>
                        <n-button size="small" quaternary type="error" @click="handleDeleteReplaceRule(item.id)">
                          {{ t('common.actions.delete') }}
                        </n-button>
                      </n-space>
                    </template>
                  </n-thing>
                </n-list-item>
              </n-list>

              <n-divider class="group-divider" />

              <!-- 区域2：网络配置 -->
              <div class="section-title">{{ t('settings.advanced.network.title') }}</div>

              <!-- User-Agent -->
              <div class="settings-section">
                <div class="settings-label">User-Agent</div>
                <n-input
                  v-model:value="networkConfig.userAgent"
                  type="textarea"
                  :rows="2"
                  :placeholder="t('settings.advanced.network.uaPlaceholder')"
                />
                <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap">
                  <n-button
                    v-for="preset in UA_PRESETS"
                    :key="preset.label"
                    size="tiny"
                    quaternary
                    @click="networkConfig.userAgent = preset.auto ? getAutoUA() : preset.value"
                  >
                    {{ preset.label }}
                  </n-button>
                </div>
              </div>

              <!-- 自定义 HTTP 头 -->
              <div class="settings-section">
                <div class="settings-label">{{ t('settings.advanced.network.customHeaders') }}</div>
                <div
                  v-for="(header, idx) in networkConfig.customHeaders"
                  :key="header._id ?? idx"
                  style="display: flex; gap: 8px; margin-bottom: 8px"
                >
                  <n-input
                    v-model:value="header.key"
                    :placeholder="t('settings.advanced.network.headerName')"
                    size="small"
                    style="flex: 1"
                  />
                  <n-input
                    v-model:value="header.value"
                    :placeholder="t('settings.advanced.network.headerValue')"
                    size="small"
                    style="flex: 2"
                  />
                  <n-button size="small" quaternary type="error" @click="removeCustomHeader(idx)">
                    {{ t('common.actions.delete') }}
                  </n-button>
                </div>
                <n-button size="small" dashed @click="addCustomHeader">
                  {{ t('settings.advanced.network.addHeader') }}
                </n-button>
              </div>

              <!-- 代理配置 -->
              <div class="settings-section">
                <div class="settings-label">{{ t('settings.advanced.network.proxy') }}</div>
                <n-switch v-model:value="networkConfig.proxy.enabled">
                  <template #checked>{{ t('settings.advanced.enabled') }}</template>
                  <template #unchecked>{{ t('settings.advanced.disabled') }}</template>
                </n-switch>
                <div
                  v-if="networkConfig.proxy.enabled"
                  style="display: flex; gap: 8px; margin-top: 8px; align-items: center"
                >
                  <n-select
                    v-model:value="networkConfig.proxy.type"
                    :options="[
                      { label: 'HTTP', value: 'http' },
                      { label: 'SOCKS5', value: 'socks5' }
                    ]"
                    size="small"
                    style="width: 100px"
                  />
                  <n-input
                    v-model:value="networkConfig.proxy.host"
                    :placeholder="t('settings.advanced.network.proxyHost')"
                    size="small"
                    style="flex: 1"
                  />
                  <n-input-number
                    v-model:value="networkConfig.proxy.port"
                    :placeholder="t('settings.advanced.network.proxyPort')"
                    size="small"
                    :min="0"
                    :max="65535"
                    style="width: 120px"
                  />
                </div>
              </div>

              <!-- 连接超时与重试 -->
              <div class="settings-section">
                <div class="settings-label">{{ t('settings.advanced.network.timeoutRetry') }}</div>
                <div class="setting-row">
                  <div class="setting-label">
                    <span class="label-text">{{ t('settings.advanced.network.timeout') }}</span>
                    <span class="label-hint">{{ t('settings.advanced.network.timeoutHint') }}</span>
                  </div>
                  <div class="setting-control">
                    <n-input-number
                      v-model:value="networkConfig.timeout"
                      :min="5000"
                      :max="120000"
                      :step="1000"
                      style="width: 160px"
                    />
                    <span class="unit-text">ms</span>
                  </div>
                </div>
                <div class="setting-row">
                  <div class="setting-label">
                    <span class="label-text">{{ t('settings.advanced.network.retryCount') }}</span>
                    <span class="label-hint">{{ t('settings.advanced.network.retryCountHint') }}</span>
                  </div>
                  <div class="setting-control">
                    <n-input-number
                      v-model:value="networkConfig.retryCount"
                      :min="0"
                      :max="10"
                      :step="1"
                      style="width: 160px"
                    />
                    <span class="unit-text">{{ t('settings.advanced.network.times') }}</span>
                  </div>
                </div>
                <div class="setting-row">
                  <div class="setting-label">
                    <span class="label-text">{{ t('settings.advanced.network.retryDelay') }}</span>
                    <span class="label-hint">{{ t('settings.advanced.network.retryDelayHint') }}</span>
                  </div>
                  <div class="setting-control">
                    <n-input-number
                      v-model:value="networkConfig.retryDelay"
                      :min="100"
                      :max="10000"
                      :step="100"
                      style="width: 160px"
                    />
                    <span class="unit-text">ms</span>
                  </div>
                </div>
              </div>

            </n-card>
          </n-tab-pane>

          <!-- ─── 阅读统计 ─── -->
          <n-tab-pane name="stats" :tab="t('settings.tabs.stats')">
            <n-card class="settings-card stats-card" bordered>
              <template #header>
                <div class="card-header">
                  <n-icon :component="TrendingUp" :size="16" class="card-header-icon" />
                  <span>{{ t('settings.tabs.stats') }}</span>
                </div>
              </template>

              <div v-if="statsLoading" class="stats-loading">{{ t('common.actions.loading') }}</div>

              <div v-else class="stats-dashboard">
                <!-- 概览卡片 -->
                <div class="stats-cards">
                  <div class="stat-card">
                    <div class="stat-card-icon">📖</div>
                    <div class="stat-card-value">{{ formatDuration(todayStats.duration) }}</div>
                    <div class="stat-card-label">{{ t('settings.stats.today') }}</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-card-icon">📅</div>
                    <div class="stat-card-value">{{ formatDuration(weekStats.duration) }}</div>
                    <div class="stat-card-label">{{ t('settings.stats.thisWeek') }}</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-card-icon">🔥</div>
                    <div class="stat-card-value">{{ t('settings.stats.daysValue', { n: streakDays }) }}</div>
                    <div class="stat-card-label">{{ t('settings.stats.streak') }}</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-card-icon">⚡</div>
                    <div class="stat-card-value">{{ t('settings.stats.speedValue', { n: globalStats.avgSpeed }) }}</div>
                    <div class="stat-card-label">{{ t('settings.stats.speed') }}</div>
                  </div>
                </div>

                <!-- 累计统计 -->
                <div class="stats-summary">
                  <div class="stats-summary-item">
                    <span class="stats-summary-label">{{ t('settings.stats.totalDuration') }}</span>
                    <span class="stats-summary-value">{{ formatDuration(globalStats.totalDuration) }}</span>
                  </div>
                  <div class="stats-summary-item">
                    <span class="stats-summary-label">{{ t('settings.stats.totalSessions') }}</span>
                    <span class="stats-summary-value">{{
                      t('settings.stats.sessionsValue', { n: globalStats.totalSessions })
                    }}</span>
                  </div>
                  <div class="stats-summary-item">
                    <span class="stats-summary-label">{{ t('settings.stats.totalChars') }}</span>
                    <span class="stats-summary-value">{{
                      t('settings.stats.charsValue', { n: globalStats.totalChars.toLocaleString() })
                    }}</span>
                  </div>
                  <div class="stats-summary-item">
                    <span class="stats-summary-label">{{ t('settings.stats.thisMonth') }}</span>
                    <span class="stats-summary-value">{{ formatDuration(monthStats.duration) }}</span>
                  </div>
                </div>

                <!-- 阅读热图（GitHub 风格） -->
                <div class="stats-heatmap">
                  <div class="heatmap-title">{{ t('settings.stats.heatmapTitle', { n: HEATMAP_DAYS }) }}</div>
                  <div class="heatmap-grid">
                    <div
                      v-for="day in dailyStats"
                      :key="day.date"
                      class="heatmap-cell"
                      :class="getHeatmapClass(day.duration)"
                      :title="t('settings.stats.cellTitle', { date: day.date, duration: formatDuration(day.duration) })"
                    ></div>
                  </div>
                  <div class="heatmap-legend">
                    <span class="heatmap-legend-label">{{ t('settings.stats.heatmapLess') }}</span>
                    <div class="heatmap-cell heatmap-level-0"></div>
                    <div class="heatmap-cell heatmap-level-1"></div>
                    <div class="heatmap-cell heatmap-level-2"></div>
                    <div class="heatmap-cell heatmap-level-3"></div>
                    <div class="heatmap-cell heatmap-level-4"></div>
                    <span class="heatmap-legend-label">{{ t('settings.stats.heatmapMore') }}</span>
                  </div>
                </div>

                <!-- 最常阅读 Top5 -->
                <div class="stats-top-books">
                  <div class="top-books-title">{{ t('settings.stats.topBooks') }}</div>
                  <div v-if="topBooks.length === 0" class="empty-state">
                    <div class="empty-icon-wrap">
                      <n-icon :component="BookOpen" :size="56" />
                    </div>
                    <p class="empty-title">{{ t('settings.stats.empty') }}</p>
                    <p class="empty-hint">{{ t('settings.stats.emptyHint') }}</p>
                  </div>
                  <div v-else class="top-books-list">
                    <div v-for="(book, index) in topBooks" :key="book.bookId" class="top-book-item">
                      <div class="top-book-rank">{{ index + 1 }}</div>
                      <div class="top-book-cover">
                        <img :src="coverPathToUrl(book.cover ?? null) ?? generateCoverDataUrl(book.title)" alt="" />
                      </div>
                      <div class="top-book-info">
                        <div class="top-book-title">{{ book.title }}</div>
                        <div class="top-book-duration">{{ formatDuration(book.duration) }}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </n-card>
          </n-tab-pane>

          <!-- ─── 关于 ─── -->
          <n-tab-pane name="about" :tab="t('settings.tabs.about')">
            <n-card class="settings-card about-tab-card" bordered>
              <template #header>
                <div class="card-header">
                  <n-icon :component="Info" :size="16" class="card-header-icon" />
                  <span>{{ t('settings.about.title', { app: t('common.appName') }) }}</span>
                </div>
              </template>

              <div class="about-tab-content">
                <!-- 应用图标 + 名称 + 版本 -->
                <div class="about-header">
                  <div class="app-icon">
                    <svg width="80" height="80" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <defs>
                        <linearGradient id="aboutBg" x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0%" stop-color="#1a1b3a" />
                          <stop offset="55%" stop-color="#2d1b4e" />
                          <stop offset="100%" stop-color="#0f0f23" />
                        </linearGradient>
                        <radialGradient id="aboutMoonGlow" cx="0.5" cy="0.5" r="0.5">
                          <stop offset="0%" stop-color="#e8e4d0" stop-opacity="0.5" />
                          <stop offset="100%" stop-color="#e8e4d0" stop-opacity="0" />
                        </radialGradient>
                        <linearGradient id="aboutPage" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stop-color="#f5f3ea" />
                          <stop offset="100%" stop-color="#d8d4c4" />
                        </linearGradient>
                      </defs>
                      <rect width="512" height="512" rx="112" fill="url(#aboutBg)" />
                      <circle cx="330" cy="150" r="80" fill="url(#aboutMoonGlow)" />
                      <path d="M 330 95 A 55 55 0 1 0 330 205 A 42 42 0 1 1 330 95 Z" fill="#e8e4d0" />
                      <path
                        d="M 256 230 L 120 250 L 120 400 L 256 380 Z"
                        fill="url(#aboutPage)"
                        stroke="#8a87a8"
                        stroke-width="2"
                      />
                      <path
                        d="M 256 230 L 392 250 L 392 400 L 256 380 Z"
                        fill="url(#aboutPage)"
                        stroke="#8a87a8"
                        stroke-width="2"
                      />
                      <line x1="256" y1="230" x2="256" y2="380" stroke="#8a87a8" stroke-width="2" />
                    </svg>
                  </div>

                  <h1 class="app-name">{{ t('common.appName') }}</h1>
                  <div class="app-version">
                    <span>v{{ appVersion }}</span>
                  </div>
                </div>

                <!-- 简介 -->
                <p class="app-intro">{{ t('settings.about.intro') }}</p>

                <!-- 功能特性 -->
                <div class="about-features">
                  <div class="about-features-title">{{ t('settings.about.featuresTitle') }}</div>
                  <ul class="about-features-list">
                    <li v-for="(feature, idx) in aboutFeatures" :key="idx">{{ feature }}</li>
                  </ul>
                </div>

                <!-- 设计理念 -->
                <div class="about-design-philosophy">
                  <div class="about-features-title">{{ t('settings.about.philosophyTitle') }}</div>
                  <p class="about-philosophy-text">{{ t('settings.about.philosophy') }}</p>
                </div>

                <!-- 信息列表 -->
                <div class="about-info-block">
                  <div class="about-info-row">
                    <span class="about-info-label">{{ t('settings.about.authorLabel') }}</span>
                    <span class="about-info-value">小白</span>
                  </div>
                  <div class="about-info-row">
                    <span class="about-info-label">{{ t('settings.about.techStackLabel') }}</span>
                    <div class="about-info-value">
                      <n-space size="small">
                        <n-tag v-for="tech in techStack" :key="tech" size="small" type="info" round>
                          {{ tech }}
                        </n-tag>
                      </n-space>
                    </div>
                  </div>
                </div>

                <!-- 底部版权 -->
                <p class="copyright-tip">{{ t('settings.about.copyright', { app: t('common.appName') }) }}</p>
              </div>
            </n-card>
          </n-tab-pane>
        </n-tabs>
      </div>
    </div>

    <!-- 快捷键编辑模态框 -->
    <n-modal
      v-model:show="shortcutModalVisible"
      preset="card"
      :title="t('settings.shortcuts.modalTitle')"
      style="width: 420px"
      :bordered="false"
    >
      <div class="shortcut-edit-content">
        <p class="shortcut-edit-hint">{{ t('settings.shortcuts.modalHint') }}</p>
        <div ref="shortcutCaptureRef" class="shortcut-capture-area" tabindex="0" @keydown="handleKeyCapture">
          <n-tag size="large" type="info" round>
            {{ capturedKey || t('settings.shortcuts.pressKey') }}
          </n-tag>
        </div>
      </div>
      <template #footer>
        <n-space justify="end">
          <n-button @click="shortcutModalVisible = false">{{ t('common.actions.cancel') }}</n-button>
          <n-button type="primary" @click="handleSaveShortcut">{{ t('common.actions.save') }}</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
/* ==================== 应用级布局 ==================== */
.settings-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
}

/* 固定 header — 琉璃质感 */
.settings-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  height: 48px;
  flex-shrink: 0;
  padding: 0 var(--spacing-lg);
  background: color-mix(in srgb, var(--bg-card) 75%, transparent);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  border-bottom: 1px solid var(--border-color);
}

/* settings-view：内容滚动区 */
.settings-view {
  flex: 1;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-md) var(--spacing-lg);
  display: flex;
  justify-content: center;
  min-width: 0;
  background: var(--bg-base);
}

/* 整体限宽 800px 居中 */
.settings-container {
  width: 100%;
  max-width: 800px;
  min-width: 0;
}

.page-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: var(--font-size-lg);
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}

.title-icon {
  color: var(--text-secondary);
}

/* ==================== 自定义空状态（替代 NEmpty） ==================== */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl) 0;
  gap: var(--spacing-md);
}

.empty-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: var(--bg-active);
  color: var(--text-tertiary);
  margin-bottom: var(--spacing-sm);
}

.empty-title {
  font-size: var(--font-size-lg);
  font-weight: 500;
  color: var(--text-secondary);
  margin: 0;
}

.empty-hint {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin: 0;
}

.settings-tabs {
  margin-bottom: var(--spacing-md);
}

/* ==================== 共享卡片样式 ==================== */
.settings-card {
  margin-bottom: var(--spacing-md);
  border-radius: var(--border-radius);
}

.card-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: var(--font-size-base-plus);
  font-weight: 600;
  color: var(--text-primary);
}

.card-header-icon {
  color: var(--primary);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  padding: var(--spacing-14px) 0;
  border-bottom: 1px solid var(--border-color);
}

.setting-row:last-child {
  border-bottom: none;
}

.setting-label {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2xs);
  min-width: 0;
}

.label-text {
  font-size: var(--font-size-base);
  color: var(--text-primary);
}

.label-hint {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.setting-control {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm-md);
  flex-shrink: 0;
}

/* ==================== 通用设置标签页 ==================== */
.section-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--primary);
  margin: var(--spacing-xs) 0 var(--spacing-sm);
  padding-bottom: var(--spacing-6px);
  border-bottom: 2px solid var(--primary);
  display: inline-block;
}

.section-title:first-child {
  margin-top: 0;
}

/* ==================== 网络设置标签页 ==================== */
.settings-section {
  margin-bottom: var(--spacing-md, 16px);
}

.settings-section:last-child {
  margin-bottom: 0;
}

.settings-label {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary, var(--text));
  margin-bottom: var(--spacing-xs, 8px);
}

.group-divider {
  margin: var(--spacing-sm-md) 0 var(--spacing-sm) !important;
}

.sub-divider {
  margin: var(--spacing-sm) 0 !important;
}

.setting-row-block {
  flex-direction: column;
  align-items: stretch;
  gap: var(--spacing-sm-md);
}

.custom-colors {
  margin-top: var(--spacing-sm);
}

.custom-colors-header {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2xs);
  margin-bottom: var(--spacing-sm-md);
}

/* 预设主题快捷选择 */
.preset-themes {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  margin-bottom: var(--spacing-sm-md);
}

.preset-label {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.preset-btn {
  padding: var(--spacing-xs) var(--spacing-sm);
  border: 1px solid var(--border-default);
  border-radius: var(--border-radius-sm);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all 0.2s ease;
}

.preset-btn:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-card);
}

.reset-row {
  padding: var(--spacing-sm) 0;
}

/* ==================== 数据目录子路径列表 ==================== */
.data-sub-paths {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-sm-md);
  background: var(--bg-hover);
  border-radius: var(--border-radius-sm);
  margin-bottom: var(--spacing-sm);
}

.data-sub-path-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
}

.data-sub-path-label {
  flex-shrink: 0;
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.data-sub-path-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.data-sub-path-row .n-button {
  flex-shrink: 0;
}

/* ==================== 内容替换规则样式 ==================== */
.ad-rules-hint {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  line-height: 1.6;
  padding: var(--spacing-sm) var(--spacing-sm-md);
  background: var(--bg-hover);
  border-radius: var(--border-radius-sm);
  margin-bottom: var(--spacing-md);
}

.ad-rules-batch-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm-md);
  padding: var(--spacing-10px) var(--spacing-sm-md);
  margin-bottom: var(--spacing-sm-md);
  background: var(--bg-hover);
  border-radius: var(--border-radius-sm);
  flex-wrap: wrap;
}

.ad-rules-count {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.ad-rules-batch-actions {
  display: flex;
  gap: var(--spacing-sm);
  margin-left: auto;
}

.ad-rule-text {
  font-size: var(--font-size-base);
  color: var(--text-primary);
  word-break: break-all;
}

.ad-rule-disabled {
  color: var(--text-tertiary);
  text-decoration: line-through;
}

.ad-rule-meta {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.ad-rule-status {
  padding: var(--spacing-2xs) var(--spacing-sm);
  border-radius: var(--border-radius-10px);
  background: var(--bg-active);
  font-size: var(--font-size-xs);
}

/* 内容替换规则相关样式 */
.ad-rule-time {
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
}

.replace-arrow {
  margin: 0 var(--spacing-xs);
  color: var(--text-tertiary);
  font-weight: 700;
}

.replace-result {
  color: var(--primary);
}

.replace-var-hint {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  line-height: 1.6;
  margin-bottom: var(--spacing-sm);
}
.replace-var-hint code {
  padding: 1px 4px;
  background: var(--bg-hover);
  border-radius: var(--border-radius-xs);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--primary);
}

/* ==================== 阅读统计标签页 ==================== */
.stats-card {
  margin-bottom: var(--spacing-md);
}

.stats-loading {
  padding: var(--spacing-lg) 0;
  text-align: center;
  color: var(--text-tertiary);
  font-size: var(--font-size-base);
}

.stats-dashboard {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  padding: var(--spacing-xs) 0;
}

/* 概览卡片 */
.stats-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--spacing-sm);
}

@media (max-width: 600px) {
  .stats-cards {
    grid-template-columns: repeat(2, 1fr);
  }
}

.stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-2xs);
  padding: var(--spacing-sm-md) var(--spacing-xs);
  background: var(--bg-hover);
  border-radius: var(--border-radius);
  text-align: center;
}

.stat-card-icon {
  font-size: var(--font-size-2xl);
  line-height: 1;
}

.stat-card-value {
  font-size: var(--font-size-base-plus);
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-all;
}

.stat-card-label {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

/* 累计统计 */
.stats-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--spacing-sm);
  padding: var(--spacing-sm-md) 0;
  border-top: 1px solid var(--border-color);
  border-bottom: 1px solid var(--border-color);
}

@media (max-width: 600px) {
  .stats-summary {
    grid-template-columns: repeat(2, 1fr);
  }
}

.stats-summary-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-2xs);
}

.stats-summary-label {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.stats-summary-value {
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--text-primary);
}

/* 阅读热图 */
.stats-heatmap {
  padding: var(--spacing-sm) 0;
}

.heatmap-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: var(--spacing-sm);
}

.heatmap-grid {
  display: grid;
  grid-template-columns: repeat(15, 1fr);
  gap: var(--spacing-xs);
  margin-bottom: var(--spacing-sm);
}

@media (max-width: 600px) {
  .heatmap-grid {
    grid-template-columns: repeat(10, 1fr);
    gap: var(--spacing-3px);
  }
}

.heatmap-cell {
  aspect-ratio: 1 / 1;
  border-radius: 3px;
  min-width: 12px;
  min-height: 12px;
}

.heatmap-level-0 {
  background: var(--bg-hover);
}

.heatmap-level-1 {
  background: color-mix(in srgb, var(--color-success) 25%, transparent);
}

.heatmap-level-2 {
  background: color-mix(in srgb, var(--color-success) 50%, transparent);
}

.heatmap-level-3 {
  background: color-mix(in srgb, var(--color-success) 75%, transparent);
}

.heatmap-level-4 {
  background: var(--color-success);
}

.heatmap-legend {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  justify-content: flex-end;
}

.heatmap-legend-label {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  margin: 0 2px;
}

.heatmap-legend .heatmap-cell {
  width: 14px;
  height: 14px;
  aspect-ratio: auto;
}

/* 最常阅读 Top5 */
.stats-top-books {
  padding: var(--spacing-sm) 0;
  border-top: 1px solid var(--border-color);
}

.top-books-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: var(--spacing-sm);
}

.top-books-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.top-book-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm-md);
  padding: var(--spacing-sm) var(--spacing-sm-md);
  background: var(--bg-hover);
  border-radius: var(--border-radius-sm);
}

.top-book-rank {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--primary);
  color: var(--text-on-primary);
  font-size: var(--font-size-sm);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.top-book-cover {
  flex-shrink: 0;
  width: 36px;
  height: 48px;
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  background: var(--bg-active);
  display: flex;
  align-items: center;
  justify-content: center;
}

.top-book-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.top-book-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2xs);
}

.top-book-title {
  font-size: var(--font-size-base);
  color: var(--text-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.top-book-duration {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

/* ==================== 关于标签页 ==================== */
.about-tab-card {
  text-align: center;
}

.about-tab-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) 0;
  align-items: center;
}

.about-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm-md);
  padding: var(--spacing-md) 0 var(--spacing-sm);
}

.app-icon {
  width: 80px;
  height: 80px;
  border-radius: 18px;
  overflow: hidden;
  box-shadow: var(--shadow-card);
}

.app-name {
  font-size: var(--font-size-28px);
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
  letter-spacing: 2px;
}

.app-version {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: var(--font-size-sm-plus);
  font-weight: 500;
  color: var(--primary);
  padding: var(--spacing-xs) var(--spacing-sm-md);
  background: var(--bg-active);
  border: 1px solid var(--border-primary);
  border-radius: var(--border-radius-lg);
}

.app-intro {
  margin: 0;
  font-size: var(--font-size-base);
  color: var(--text-secondary);
  line-height: 1.6;
}

.about-features,
.about-design-philosophy {
  width: 100%;
  text-align: left;
  padding: var(--spacing-sm) 0;
  border-top: 1px solid var(--border-color);
}

.about-features-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: var(--spacing-10px);
}

.about-features-list {
  margin: 0;
  padding-left: 20px;
  font-size: var(--font-size-sm-plus);
  color: var(--text-secondary);
  line-height: 1.8;
  list-style-type: disc;
}

.about-philosophy-text {
  margin: 0;
  font-size: var(--font-size-sm-plus);
  color: var(--text-secondary);
  line-height: 1.8;
}

.about-info-block {
  display: flex;
  flex-direction: column;
  width: 100%;
  text-align: left;
  padding: var(--spacing-sm) 0;
  border-top: 1px solid var(--border-color);
}

.about-info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm-md) 0;
  border-bottom: 1px solid var(--border-color);
}

.about-info-row:last-child {
  border-bottom: none;
}

.about-info-label {
  font-size: var(--font-size-sm-plus);
  color: var(--text-tertiary);
}

.about-info-value {
  font-size: var(--font-size-base);
  color: var(--text-primary);
}

.copyright-tip {
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin: 0;
  letter-spacing: 0.5px;
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--border-color);
  width: 100%;
}

/* ==================== 网络设置：超时/重试单位文本 ==================== */
.unit-text {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin-left: var(--spacing-2xs);
}

/* ==================== 快捷键设置 ==================== */
.shortcut-action-label {
  font-size: var(--font-size-base);
  color: var(--text-primary);
  font-weight: 500;
}

/* 快捷键编辑模态框 */
.shortcut-edit-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) 0;
}

.shortcut-edit-hint {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin: 0;
  text-align: center;
}

.shortcut-capture-area {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80px;
  padding: var(--spacing-md);
  border: 2px dashed var(--border-default);
  border-radius: var(--border-radius);
  background: var(--bg-hover);
  outline: none;
  cursor: pointer;
  transition: border-color 0.2s ease;
}

.shortcut-capture-area:focus,
.shortcut-capture-area:focus-visible {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 5%, var(--bg-hover));
}

/* ==================== 数据迁移进度条 ==================== */
.migrate-progress {
  margin-top: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-sm-md);
  background: var(--bg-hover);
  border-radius: var(--border-radius-sm);
}

.migrate-progress-text {
  margin-top: var(--spacing-xs);
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  text-align: center;
}

.migrate-restart-hint {
  margin-top: var(--spacing-xs);
  font-size: var(--font-size-sm);
  color: var(--primary);
  text-align: center;
  font-weight: 500;
}
</style>
