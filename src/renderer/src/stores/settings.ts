import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { THEME_COLORS, deriveThemeColors } from '../../../shared';
import type { ThemeType, ThemeColors } from '../../../shared';
import type {
  FontFamilyType,
  TextConvertType,
  PageTurnAnimationType,
  ComicReadDirection,
  PageTurnDirectionType,
  TapTurnZoneType,
  KeyboardShortcuts,
  ComicPageTurnAnimationType,
  ComicImageGap,
  ComicImageSplitType,
  ComicScaleType,
  CustomThemeColors
} from './types';
// ────────────────────────── 常量定义 ──────────────────────────

export { THEME_COLORS };

/**
 * 字体族 CSS 栈：按「Linux 常见中文字体 → macOS → Windows」顺序排列，
 * 浏览器命中第一个本机已安装的字体，保证三平台切换字体都有可见效果。
 * Linux 对应字体（需系统安装，通常随 noto-cjk / 文泉驿 包提供）：
 * - 宋体：Noto Serif CJK SC / 思源宋体 / AR PL UMing
 * - 楷体：AR PL UKai（fonts-arphic-ukai）
 * - 黑体：Noto Sans CJK SC / 思源黑体 / 文泉驿
 */
const FONT_FAMILY_CSS: Record<FontFamilyType, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  serif:
    '"Noto Serif CJK SC", "Source Han Serif SC", "Source Han Serif CN", "AR PL UMing CN", "Songti SC", "STSong", "SimSun", "宋体", serif',
  kai: '"AR PL UKai CN", "FZKai-Z031", "Kaiti SC", "STKaiti", "KaiTi", "楷体", "Noto Serif CJK SC", serif',
  hei: '"Noto Sans CJK SC", "Source Han Sans SC", "Source Han Sans CN", "PingFang SC", "WenQuanYi Micro Hei", "WenQuanYi Zen Hei", "Droid Sans Fallback", "Microsoft YaHei", "SimHei", "黑体", sans-serif',
  custom: '"CustomFont", sans-serif'
};

const DEFAULTS = {
  fontSize: 18,
  fontFamily: 'system' as FontFamilyType,
  lineHeight: 1.8,
  pageWidth: 800,
  margin: 40,
  paragraphSpacing: 1.0,

  autoScrollSpeed: 50,
  ttsRate: 1.0,
  ttsVoice: null as string | null,
  ttsPitch: 1.0,
  appTheme: 'day' as ThemeType,
  readerTheme: 'day' as ThemeType,
  appThemeFollowSystem: false,
  readerThemeFollowSystem: false,
  customThemeColors: {
    bg: '#16151f',
    text: '#e6e6e6',
    primary: '#6366f1'
  } as CustomThemeColors,
  textConvert: 'off' as TextConvertType,
  smartFormat: false,
  pageTurnAnimation: 'none' as PageTurnAnimationType,

  // ─── 漫画阅读设置（对标 Tachiyomi/Kavita/Calibre） ───
  /** 漫画阅读方向：ltr=左到右（默认），rtl=右到左（日漫） */
  comicReadDirection: 'ltr' as ComicReadDirection,
  /** 双页模式：宽屏时左右两页同时显示 */
  comicDoublePage: false,
  /** 滚动模式图片间距（px）：0=无缝（默认，对标 Tachiyomi） */
  comicImageGap: 0 as ComicImageGap,
  /** 翻页模式预加载页数（当前页±N页），默认3对标 Tachiyomi */
  comicPreloadCount: 3,
  /** 翻页动画时长（ms），0=无动画 */
  comicPageTurnDuration: 200,
  /** 页面缩放类型（对标 Mihon），默认 smartFit 自动判断条漫/页漫 */
  comicScaleType: 'smartFit' as ComicScaleType,
  /** 连续阅读：滚到底部自动加载下一章（对标 Kavita） */
  comicContinuousReading: true,
  /** 漫画翻页动画类型（slide/fade/none），默认 slide 对标 Tachiyomi */
  comicPageTurnAnimation: 'slide' as ComicPageTurnAnimationType,

  // ─── 阅读增强设置 ───
  /** 自定义字体文件路径（保存到用户数据目录的绝对路径），null=未上传 */
  customFontPath: null as string | null,
  /** 自定义字体名称（用于显示和 @font-face font-family 名称） */
  customFontName: null as string | null,
  /** 自动连字（hyphenation），开启后在换行时自动添加连字符 */
  hyphenationEnabled: false,
  /** 自定义CSS样式（注入到阅读器视图的额外样式） */
  customCss: '',
  /** 垂直书写模式（writing-mode: vertical-rl），适用于传统中文/日文排版 */
  verticalWriting: false,

  // ─── 漫画增强设置 ───
  /** 漫画对比度（50-300，100=原始） */
  comicContrast: 100,
  /** 漫画图片分割类型 */
  comicImageSplit: 'fitScreen' as ComicImageSplitType,

  // ─── 阅读偏好设置（翻页/点击翻页） ───
  /** 翻页方向：left-to-right=左到右（默认），right-to-left=右到左 */
  pageTurnDirection: 'left-to-right' as PageTurnDirectionType,
  /** 点击翻页开关，开启后点击指定区域可翻页 */
  tapTurnEnabled: true,
  /** 点击翻页区域：left-right=左右两侧，bottom=底部，full=整个页面 */
  tapTurnZone: 'left-right' as TapTurnZoneType
};

/**
 * 默认快捷键映射
 * - nextPage：下一页
 * - prevPage：上一页
 * - nextChapter：下一章
 * - prevChapter：上一章
 * - toggleBookmark：添加/移除书签
 * - toggleSearch：搜索
 * - toggleFullscreen：全屏
 * - toggleTTS：朗读
 * - closeReader：退出阅读器
 */
const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcuts = {
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

const LIMITS = {
  fontSize: { min: 14, max: 32 },
  lineHeight: { min: 1.2, max: 2.5 },
  pageWidth: { min: 600, max: 1200 },
  margin: { min: 0, max: 480 },
  paragraphSpacing: { min: 0.5, max: 3.0 },

  autoScrollSpeed: { min: 10, max: 200 },
  ttsRate: { min: 0.5, max: 2.0 },
  ttsPitch: { min: 0, max: 2.0 },

  // 漫画预加载页数：1~5（对标 Tachiyomi 默认 ±3）
  comicPreloadCount: { min: 1, max: 5 },
  // 漫画翻页动画时长：0~600ms
  comicPageTurnDuration: { min: 0, max: 600 },

  // 漫画对比度：50~300（100=原始）
  comicContrast: { min: 50, max: 300 }
};
// ────────────────────────── 辅助函数 ──────────────────────────

function readerKey(name: string): string {
  return `reader.${name}`;
}

function appKey(name: string): string {
  return `app.${name}`;
}

function clampFontSize(value: number): number {
  return Math.max(LIMITS.fontSize.min, Math.min(LIMITS.fontSize.max, value));
}

function clampLineHeight(value: number): number {
  return Math.max(LIMITS.lineHeight.min, Math.min(LIMITS.lineHeight.max, value));
}

function clampPageWidth(value: number): number {
  return Math.max(LIMITS.pageWidth.min, Math.min(LIMITS.pageWidth.max, value));
}

function clampMargin(value: number): number {
  return Math.max(LIMITS.margin.min, Math.min(LIMITS.margin.max, value));
}

function clampParagraphSpacing(value: number): number {
  return Math.max(LIMITS.paragraphSpacing.min, Math.min(LIMITS.paragraphSpacing.max, value));
}

function clampAutoScrollSpeed(value: number): number {
  return Math.max(LIMITS.autoScrollSpeed.min, Math.min(LIMITS.autoScrollSpeed.max, value));
}

function clampTtsRate(value: number): number {
  return Math.max(LIMITS.ttsRate.min, Math.min(LIMITS.ttsRate.max, value));
}

function clampTtsPitch(value: number): number {
  return Math.max(LIMITS.ttsPitch.min, Math.min(LIMITS.ttsPitch.max, value));
}

function isValidFontFamily(value: string): value is FontFamilyType {
  return value === 'system' || value === 'serif' || value === 'kai' || value === 'hei' || value === 'custom';
}

function isValidTheme(value: string): value is ThemeType {
  return (
    value === 'day' ||
    value === 'night' ||
    value === 'eye' ||
    value === 'parchment' ||
    value === 'research' ||
    value === 'custom'
  );
}

function isValidTextConvert(value: string): value is TextConvertType {
  return value === 'off' || value === 's2t' || value === 't2s';
}

function isValidPageTurnAnimation(value: string): value is PageTurnAnimationType {
  return value === 'slide' || value === 'flip' || value === 'fade' || value === 'curl' || value === 'none';
}

function isValidComicReadDirection(value: string): value is ComicReadDirection {
  return value === 'ltr' || value === 'rtl';
}

function isValidComicImageGap(value: number): value is ComicImageGap {
  return value === 0 || value === 2 || value === 4;
}

function isValidComicScaleType(value: string): value is ComicScaleType {
  return value === 'fitScreen' || value === 'fitWidth' || value === 'original' || value === 'smartFit';
}

function isValidComicPageTurnAnimation(value: string): value is ComicPageTurnAnimationType {
  return value === 'slide' || value === 'fade' || value === 'none';
}

function isValidComicImageSplit(value: string): value is ComicImageSplitType {
  return value === 'fitScreen' || value === 'rtl' || value === 'ltr' || value === 'none';
}

function isValidPageTurnDirection(value: string): value is PageTurnDirectionType {
  return value === 'left-to-right' || value === 'right-to-left';
}

function isValidTapTurnZone(value: string): value is TapTurnZoneType {
  return value === 'left-right' || value === 'bottom' || value === 'full';
}

/**
 * 解析快捷键 JSON：返回合法的 KeyboardShortcuts，解析失败返回 null
 * 仅校验是否为对象且所有值为字符串，不校验具体动作名（允许自定义动作）
 */
function parseKeyboardShortcuts(json: string): KeyboardShortcuts | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result: KeyboardShortcuts = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') result[k] = v;
      }
      // 至少包含一个键才认为是有效配置，否则返回 null 使用默认值
      return Object.keys(result).length > 0 ? result : null;
    }
  } catch {
    // 忽略 JSON 解析错误
  }
  return null;
}
function clampComicContrast(value: number): number {
  return Math.max(LIMITS.comicContrast.min, Math.min(LIMITS.comicContrast.max, value));
}

function clampComicPreloadCount(value: number): number {
  return Math.max(LIMITS.comicPreloadCount.min, Math.min(LIMITS.comicPreloadCount.max, value));
}

function clampComicPageTurnDuration(value: number): number {
  return Math.max(LIMITS.comicPageTurnDuration.min, Math.min(LIMITS.comicPageTurnDuration.max, value));
}

function parseCustomColors(json: string): CustomThemeColors | null {
  try {
    const parsed = JSON.parse(json);
    if (
      parsed &&
      typeof parsed.bg === 'string' &&
      typeof parsed.text === 'string' &&
      typeof parsed.primary === 'string'
    ) {
      return parsed as CustomThemeColors;
    }
  } catch {
    // 忽略 JSON 解析错误
  }
  return null;
}

function getInitialSystemTheme(): 'light' | 'dark' {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function resolveThemeColors(theme: ThemeType, customColors: CustomThemeColors): ThemeColors {
  if (theme === 'custom') {
    return deriveThemeColors(customColors);
  }
  return { ...THEME_COLORS[theme] };
}
// ────────────────────────── Store 定义 ──────────────────────────

export const useSettingsStore = defineStore('settings', () => {
  // ─── State：阅读偏好 ───
  const fontSize = ref<number>(DEFAULTS.fontSize);
  const fontFamily = ref<FontFamilyType>(DEFAULTS.fontFamily);
  const lineHeight = ref<number>(DEFAULTS.lineHeight);
  const pageWidth = ref<number>(DEFAULTS.pageWidth);
  const margin = ref<number>(DEFAULTS.margin);
  const paragraphSpacing = ref<number>(DEFAULTS.paragraphSpacing);

  const autoScrollSpeed = ref<number>(DEFAULTS.autoScrollSpeed);
  const ttsRate = ref<number>(DEFAULTS.ttsRate);
  const ttsVoice = ref<string | null>(DEFAULTS.ttsVoice);
  const ttsPitch = ref<number>(DEFAULTS.ttsPitch);

  // ─── State：应用主题 ───
  const appTheme = ref<ThemeType>(DEFAULTS.appTheme);
  const appThemeFollowSystem = ref<boolean>(DEFAULTS.appThemeFollowSystem);

  // ─── State：阅读器主题 ───
  const readerTheme = ref<ThemeType>(DEFAULTS.readerTheme);
  const readerThemeFollowSystem = ref<boolean>(DEFAULTS.readerThemeFollowSystem);
  const customThemeColors = ref<CustomThemeColors>({ ...DEFAULTS.customThemeColors });

  // ─── State：繁简转换与智能排版 ───
  const textConvert = ref<TextConvertType>(DEFAULTS.textConvert);
  const smartFormat = ref<boolean>(DEFAULTS.smartFormat);

  // ─── State：翻页动画 ───
  const pageTurnAnimation = ref<PageTurnAnimationType>(DEFAULTS.pageTurnAnimation);

  // ─── State：漫画阅读设置（对标 Tachiyomi/Kavita/Calibre） ───
  /** 漫画阅读方向：ltr=左到右，rtl=右到左（日漫） */
  const comicReadDirection = ref<ComicReadDirection>(DEFAULTS.comicReadDirection);
  /** 双页模式：宽屏时左右两页同时显示 */
  const comicDoublePage = ref<boolean>(DEFAULTS.comicDoublePage);
  /** 滚动模式图片间距（px）：0=无缝 */
  const comicImageGap = ref<ComicImageGap>(DEFAULTS.comicImageGap);
  /** 翻页模式预加载页数 */
  const comicPreloadCount = ref<number>(DEFAULTS.comicPreloadCount);
  /** 翻页动画时长（ms），0=无动画 */
  const comicPageTurnDuration = ref<number>(DEFAULTS.comicPageTurnDuration);
  /** 页面缩放类型（对标 Mihon：fitScreen/fitWidth/original/smartFit） */
  const comicScaleType = ref<ComicScaleType>(DEFAULTS.comicScaleType);
  /** 连续阅读：滚到底部自动加载下一章 */
  const comicContinuousReading = ref<boolean>(DEFAULTS.comicContinuousReading);
  /** 漫画翻页动画类型（slide/fade/none） */
  const comicPageTurnAnimation = ref<ComicPageTurnAnimationType>(DEFAULTS.comicPageTurnAnimation);

  // ─── State：阅读增强设置 ───
  /** 自定义字体文件路径（绝对路径），null=未上传 */
  const customFontPath = ref<string | null>(DEFAULTS.customFontPath);
  /** 自定义字体名称 */
  const customFontName = ref<string | null>(DEFAULTS.customFontName);
  /** 自动连字 */
  const hyphenationEnabled = ref<boolean>(DEFAULTS.hyphenationEnabled);
  /** 自定义CSS样式 */
  const customCss = ref<string>(DEFAULTS.customCss);
  /** 垂直书写模式 */
  const verticalWriting = ref<boolean>(DEFAULTS.verticalWriting);

  // ─── State：漫画增强设置 ───
  /** 漫画对比度（50-300，100=原始） */
  const comicContrast = ref<number>(DEFAULTS.comicContrast);
  /** 漫画图片分割类型 */
  const comicImageSplit = ref<ComicImageSplitType>(DEFAULTS.comicImageSplit);

  // ─── State：阅读偏好设置（翻页/点击翻页） ───
  /** 翻页方向：left-to-right=左到右，right-to-left=右到左 */
  const pageTurnDirection = ref<PageTurnDirectionType>(DEFAULTS.pageTurnDirection);
  /** 点击翻页开关 */
  const tapTurnEnabled = ref<boolean>(DEFAULTS.tapTurnEnabled);
  /** 点击翻页区域：left-right / bottom / full */
  const tapTurnZone = ref<TapTurnZoneType>(DEFAULTS.tapTurnZone);

  // ─── State：快捷键自定义 ───
  /** 快捷键映射（key=动作名，value=按键组合） */
  const keyboardShortcuts = ref<KeyboardShortcuts>({ ...DEFAULT_KEYBOARD_SHORTCUTS });

  // ─── State：系统主题 ───
  const systemTheme = ref<'light' | 'dark'>(getInitialSystemTheme());

  // ─── 内部变量：系统主题监听 ───
  let mediaQuery: MediaQueryList | null = null;
  let mediaQueryHandler: ((e: MediaQueryListEvent) => void) | null = null;

  // ─── 内部变量：加载幂等保护 ───
  let loadSettingsPromise: Promise<void> | null = null;

  // ─── Getters ───

  const effectiveAppTheme = computed<ThemeType>(() => {
    if (appThemeFollowSystem.value) {
      return systemTheme.value === 'dark' ? 'night' : 'day';
    }
    return appTheme.value;
  });

  const effectiveReaderTheme = computed<ThemeType>(() => {
    if (readerThemeFollowSystem.value) {
      return systemTheme.value === 'dark' ? 'night' : 'day';
    }
    return readerTheme.value;
  });

  const appThemeColors = computed<ThemeColors>(() =>
    resolveThemeColors(effectiveAppTheme.value, customThemeColors.value)
  );

  const readerThemeColors = computed<ThemeColors>(() =>
    resolveThemeColors(effectiveReaderTheme.value, customThemeColors.value)
  );

  const fontFamilyCss = computed<string>(() => {
    if (fontFamily.value === 'custom' && customFontPath.value) {
      // 自定义字体：使用 @font-face 注册的 "CustomFont" 名称
      return '"CustomFont", sans-serif';
    }
    return FONT_FAMILY_CSS[fontFamily.value];
  });

  // ─── Actions：加载与持久化 ───

  async function loadSettings(): Promise<void> {
    if (loadSettingsPromise) return loadSettingsPromise;

    loadSettingsPromise = (async () => {
      try {
        // 使用 Promise.allSettled：单个设置项加载失败不影响其他设置项（P3-1）
        const results = await Promise.allSettled([
          // 阅读偏好
          window.dbApi.setting.get(readerKey('fontSize')),
          window.dbApi.setting.get(readerKey('fontFamily')),
          window.dbApi.setting.get(readerKey('lineHeight')),
          window.dbApi.setting.get(readerKey('pageWidth')),
          window.dbApi.setting.get(readerKey('margin')),
          window.dbApi.setting.get(readerKey('paragraphSpacing')),
          window.dbApi.setting.get(readerKey('autoScrollSpeed')),
          window.dbApi.setting.get(readerKey('ttsRate')),
          window.dbApi.setting.get(readerKey('ttsVoice')),
          window.dbApi.setting.get(readerKey('ttsPitch')),
          window.dbApi.setting.get(readerKey('theme')),
          window.dbApi.setting.get(readerKey('themeFollowSystem')),
          window.dbApi.setting.get(readerKey('customThemeColors')),
          window.dbApi.setting.get(readerKey('textConvert')),
          window.dbApi.setting.get(readerKey('smartFormat')),
          window.dbApi.setting.get(readerKey('pageTurnAnimation')),
          // 应用主题
          window.dbApi.setting.get(appKey('theme')),
          window.dbApi.setting.get(appKey('themeFollowSystem')),
          // 漫画设置（向后兼容：旧库无这些 key 时使用默认值）
          window.dbApi.setting.get(readerKey('comicReadDirection')),
          window.dbApi.setting.get(readerKey('comicDoublePage')),
          window.dbApi.setting.get(readerKey('comicImageGap')),
          window.dbApi.setting.get(readerKey('comicPreloadCount')),
          window.dbApi.setting.get(readerKey('comicPageTurnDuration')),
          window.dbApi.setting.get(readerKey('comicScaleType')),
          window.dbApi.setting.get(readerKey('comicContinuousReading')),
          window.dbApi.setting.get(readerKey('comicPageTurnAnimation')),
          // 阅读增强设置
          window.dbApi.setting.get(readerKey('customFontPath')),
          window.dbApi.setting.get(readerKey('customFontName')),
          window.dbApi.setting.get(readerKey('hyphenationEnabled')),
          window.dbApi.setting.get(readerKey('customCss')),
          window.dbApi.setting.get(readerKey('verticalWriting')),
          // 漫画增强设置
          window.dbApi.setting.get(readerKey('comicContrast')),
          window.dbApi.setting.get(readerKey('comicImageSplit')),
          // 阅读偏好设置（翻页/点击翻页）
          window.dbApi.setting.get(readerKey('pageTurnDirection')),
          window.dbApi.setting.get(readerKey('tapTurnEnabled')),
          window.dbApi.setting.get(readerKey('tapTurnZone')),
          // 快捷键自定义
          window.dbApi.setting.get(readerKey('keyboardShortcuts'))
        ]);
        // 辅助函数：从 allSettled 结果中提取 fulfilled 的值，rejected 返回 undefined
        const val = (i: number): string | null | undefined =>
          results[i].status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<string | null>).value : undefined;

        const size = val(0),
          family = val(1),
          lh = val(2),
          pw = val(3),
          mg = val(4),
          ps = val(5),
          ass = val(6),
          tr = val(7),
          tv = val(8),
          tp = val(9),
          rTheme = val(10),
          rFollow = val(11),
          ctc = val(12),
          tc = val(13),
          sf = val(14),
          pta = val(15);
        const aTheme = val(16),
          aFollow = val(17);
        const cDir = val(18),
          cDouble = val(19),
          cGap = val(20),
          cPreload = val(21),
          cDur = val(22),
          cScale = val(23),
          cCont = val(24),
          cPta = val(25);
        const cfPath = val(26),
          cfName = val(27),
          hyphen = val(28),
          css = val(29),
          vWriting = val(30),
          cContrast = val(31),
          cSplit = val(32);
        const ptd = val(33),
          tapEnabled = val(34),
          tapZone = val(35),
          ks = val(36);

        if (size) {
          const n = parseInt(size, 10);
          if (!Number.isNaN(n)) fontSize.value = clampFontSize(n);
        }
        if (family && isValidFontFamily(family)) fontFamily.value = family;
        if (lh) {
          const n = parseFloat(lh);
          if (!Number.isNaN(n)) lineHeight.value = clampLineHeight(n);
        }
        if (pw) {
          const n = parseInt(pw, 10);
          if (!Number.isNaN(n)) pageWidth.value = clampPageWidth(n);
        }
        if (mg) {
          const n = parseInt(mg, 10);
          if (!Number.isNaN(n)) margin.value = clampMargin(n);
        }
        if (ps) {
          const n = parseFloat(ps);
          if (!Number.isNaN(n)) paragraphSpacing.value = clampParagraphSpacing(n);
        }

        if (ass) {
          const n = parseInt(ass, 10);
          if (!Number.isNaN(n)) autoScrollSpeed.value = clampAutoScrollSpeed(n);
        }
        if (tr) {
          const n = parseFloat(tr);
          if (!Number.isNaN(n)) ttsRate.value = clampTtsRate(n);
        }
        if (tv != null) {
          ttsVoice.value = tv === '' ? null : tv;
        }
        if (tp) {
          const n = parseFloat(tp);
          if (!Number.isNaN(n)) ttsPitch.value = clampTtsPitch(n);
        }
        if (rTheme && isValidTheme(rTheme)) readerTheme.value = rTheme;
        if (rFollow != null) readerThemeFollowSystem.value = rFollow === 'true';
        if (ctc) {
          const colors = parseCustomColors(ctc);
          if (colors) customThemeColors.value = colors;
        }
        if (tc && isValidTextConvert(tc)) textConvert.value = tc;
        if (sf != null) smartFormat.value = sf === 'true';
        if (pta && isValidPageTurnAnimation(pta)) pageTurnAnimation.value = pta;
        if (aTheme && isValidTheme(aTheme)) appTheme.value = aTheme;
        if (aFollow != null) appThemeFollowSystem.value = aFollow === 'true';

        // 漫画设置解析
        if (cDir && isValidComicReadDirection(cDir)) comicReadDirection.value = cDir;
        if (cDouble != null) comicDoublePage.value = cDouble === 'true';
        if (cGap != null) {
          const n = parseInt(cGap, 10);
          if (!Number.isNaN(n) && isValidComicImageGap(n)) comicImageGap.value = n;
        }
        if (cPreload) {
          const n = parseInt(cPreload, 10);
          if (!Number.isNaN(n)) comicPreloadCount.value = clampComicPreloadCount(n);
        }
        if (cDur) {
          const n = parseInt(cDur, 10);
          if (!Number.isNaN(n)) comicPageTurnDuration.value = clampComicPageTurnDuration(n);
        }
        if (cScale && isValidComicScaleType(cScale)) comicScaleType.value = cScale;
        if (cCont != null) comicContinuousReading.value = cCont === 'true';
        if (cPta && isValidComicPageTurnAnimation(cPta)) comicPageTurnAnimation.value = cPta;

        // 阅读增强设置解析
        if (cfPath) customFontPath.value = cfPath;
        if (cfName) customFontName.value = cfName;
        if (hyphen != null) hyphenationEnabled.value = hyphen === 'true';
        if (css != null) customCss.value = css;
        if (vWriting != null) verticalWriting.value = vWriting === 'true';

        // 漫画增强设置解析
        if (cContrast) {
          const n = parseInt(cContrast, 10);
          if (!Number.isNaN(n)) comicContrast.value = clampComicContrast(n);
        }
        if (cSplit && isValidComicImageSplit(cSplit)) comicImageSplit.value = cSplit;

        // 阅读偏好设置解析（翻页/点击翻页）
        if (ptd && isValidPageTurnDirection(ptd)) pageTurnDirection.value = ptd;
        if (tapEnabled != null) tapTurnEnabled.value = tapEnabled === 'true';
        if (tapZone && isValidTapTurnZone(tapZone)) tapTurnZone.value = tapZone;

        // 快捷键自定义解析
        if (ks) {
          const shortcuts = parseKeyboardShortcuts(ks);
          if (shortcuts) keyboardShortcuts.value = { ...DEFAULT_KEYBOARD_SHORTCUTS, ...shortcuts };
        }
      } catch (err) {
        console.warn('[settings] 加载设置失败:', err);
      } finally {
        // 无论成功或失败，都重置 promise，允许后续重试
        loadSettingsPromise = null;
      }
    })();

    return loadSettingsPromise;
  }

  async function setFontSize(size: number): Promise<void> {
    fontSize.value = clampFontSize(size);
    try {
      await window.dbApi.setting.set(readerKey('fontSize'), String(fontSize.value));
    } catch (err) {
      console.warn('[settings] 持久化字号失败:', err);
    }
  }

  async function increaseFontSize(): Promise<void> {
    await setFontSize(fontSize.value + 1);
  }

  async function decreaseFontSize(): Promise<void> {
    await setFontSize(fontSize.value - 1);
  }

  async function setFontFamily(family: FontFamilyType): Promise<void> {
    fontFamily.value = family;
    try {
      await window.dbApi.setting.set(readerKey('fontFamily'), family);
    } catch (err) {
      console.warn('[settings] 持久化字体失败:', err);
    }
  }

  async function setLineHeight(height: number): Promise<void> {
    lineHeight.value = clampLineHeight(height);
    try {
      await window.dbApi.setting.set(readerKey('lineHeight'), String(lineHeight.value));
    } catch (err) {
      console.warn('[settings] 持久化行距失败:', err);
    }
  }

  async function setPageWidth(width: number): Promise<void> {
    pageWidth.value = clampPageWidth(width);
    try {
      await window.dbApi.setting.set(readerKey('pageWidth'), String(pageWidth.value));
    } catch (err) {
      console.warn('[settings] 持久化页宽失败:', err);
    }
  }

  async function setMargin(value: number): Promise<void> {
    margin.value = clampMargin(value);
    try {
      await window.dbApi.setting.set(readerKey('margin'), String(margin.value));
    } catch (err) {
      console.warn('[settings] 持久化边距失败:', err);
    }
  }

  async function setParagraphSpacing(value: number): Promise<void> {
    paragraphSpacing.value = clampParagraphSpacing(value);
    try {
      await window.dbApi.setting.set(readerKey('paragraphSpacing'), String(paragraphSpacing.value));
    } catch (err) {
      console.warn('[settings] 持久化段落间距失败:', err);
    }
  }

  async function setAutoScrollSpeed(value: number): Promise<void> {
    autoScrollSpeed.value = clampAutoScrollSpeed(value);
    try {
      await window.dbApi.setting.set(readerKey('autoScrollSpeed'), String(autoScrollSpeed.value));
    } catch (err) {
      console.warn('[settings] 持久化自动滚动速度失败:', err);
    }
  }

  async function setTtsRate(value: number): Promise<void> {
    ttsRate.value = clampTtsRate(value);
    try {
      await window.dbApi.setting.set(readerKey('ttsRate'), String(ttsRate.value));
    } catch (err) {
      console.warn('[settings] 持久化TTS语速失败:', err);
    }
  }

  async function setTtsVoice(value: string | null): Promise<void> {
    ttsVoice.value = value;
    try {
      await window.dbApi.setting.set(readerKey('ttsVoice'), value ?? '');
    } catch (err) {
      console.warn('[settings] 持久化TTS语音失败:', err);
    }
  }

  async function setTtsPitch(value: number): Promise<void> {
    ttsPitch.value = clampTtsPitch(value);
    try {
      await window.dbApi.setting.set(readerKey('ttsPitch'), String(ttsPitch.value));
    } catch (err) {
      console.warn('[settings] 持久化TTS音调失败:', err);
    }
  }

  // ─── Actions：应用主题 ───

  async function setAppTheme(theme: ThemeType): Promise<void> {
    appTheme.value = theme;
    const needUnfollow = appThemeFollowSystem.value;
    if (needUnfollow) appThemeFollowSystem.value = false;
    try {
      if (needUnfollow) {
        await Promise.all([
          window.dbApi.setting.set(appKey('theme'), theme),
          window.dbApi.setting.set(appKey('themeFollowSystem'), 'false')
        ]);
      } else {
        await window.dbApi.setting.set(appKey('theme'), theme);
      }
    } catch (err) {
      console.warn('[settings] 持久化应用主题失败:', err);
    }
  }

  async function setAppThemeFollowSystem(value: boolean): Promise<void> {
    appThemeFollowSystem.value = value;
    try {
      await window.dbApi.setting.set(appKey('themeFollowSystem'), String(value));
    } catch (err) {
      console.warn('[settings] 持久化应用跟随系统失败:', err);
    }
  }

  // ─── Actions：阅读器主题 ───

  async function setReaderTheme(theme: ThemeType): Promise<void> {
    readerTheme.value = theme;
    const needUnfollow = readerThemeFollowSystem.value;
    if (needUnfollow) readerThemeFollowSystem.value = false;
    try {
      if (needUnfollow) {
        await Promise.all([
          window.dbApi.setting.set(readerKey('theme'), theme),
          window.dbApi.setting.set(readerKey('themeFollowSystem'), 'false')
        ]);
      } else {
        await window.dbApi.setting.set(readerKey('theme'), theme);
      }
    } catch (err) {
      console.warn('[settings] 持久化阅读器主题失败:', err);
    }
  }

  async function setReaderThemeFollowSystem(value: boolean): Promise<void> {
    readerThemeFollowSystem.value = value;
    try {
      await window.dbApi.setting.set(readerKey('themeFollowSystem'), String(value));
    } catch (err) {
      console.warn('[settings] 持久化阅读器跟随系统失败:', err);
    }
  }

  async function setCustomThemeColors(colors: CustomThemeColors): Promise<void> {
    customThemeColors.value = { ...colors };
    try {
      await window.dbApi.setting.set(readerKey('customThemeColors'), JSON.stringify(customThemeColors.value));
    } catch (err) {
      console.warn('[settings] 持久化自定义主题颜色失败:', err);
    }
  }

  // ─── Actions：繁简转换与智能排版 ───

  async function setTextConvert(value: TextConvertType): Promise<void> {
    textConvert.value = value;
    try {
      await window.dbApi.setting.set(readerKey('textConvert'), value);
    } catch (err) {
      console.warn('[settings] 持久化繁简转换失败:', err);
    }
  }

  async function setSmartFormat(value: boolean): Promise<void> {
    smartFormat.value = value;
    try {
      await window.dbApi.setting.set(readerKey('smartFormat'), String(value));
    } catch (err) {
      console.warn('[settings] 持久化智能排版失败:', err);
    }
  }

  // ─── Actions：翻页动画 ───

  async function setPageTurnAnimation(value: PageTurnAnimationType): Promise<void> {
    pageTurnAnimation.value = value;
    try {
      await window.dbApi.setting.set(readerKey('pageTurnAnimation'), value);
    } catch (err) {
      console.warn('[settings] 持久化翻页动画失败:', err);
    }
  }

  // ─── Actions：漫画阅读设置 ───

  /** 设置漫画阅读方向（ltr=左到右，rtl=右到左） */
  async function setComicReadDirection(value: ComicReadDirection): Promise<void> {
    comicReadDirection.value = value;
    try {
      await window.dbApi.setting.set(readerKey('comicReadDirection'), value);
    } catch (err) {
      console.warn('[settings] 持久化漫画阅读方向失败:', err);
    }
  }

  /** 设置双页模式 */
  async function setComicDoublePage(value: boolean): Promise<void> {
    comicDoublePage.value = value;
    try {
      await window.dbApi.setting.set(readerKey('comicDoublePage'), String(value));
    } catch (err) {
      console.warn('[settings] 持久化双页模式失败:', err);
    }
  }

  /** 设置图片间距（0/2/4px） */
  async function setComicImageGap(value: ComicImageGap): Promise<void> {
    comicImageGap.value = value;
    try {
      await window.dbApi.setting.set(readerKey('comicImageGap'), String(value));
    } catch (err) {
      console.warn('[settings] 持久化图片间距失败:', err);
    }
  }

  /** 设置预加载页数 */
  async function setComicPreloadCount(value: number): Promise<void> {
    comicPreloadCount.value = clampComicPreloadCount(value);
    try {
      await window.dbApi.setting.set(readerKey('comicPreloadCount'), String(comicPreloadCount.value));
    } catch (err) {
      console.warn('[settings] 持久化预加载页数失败:', err);
    }
  }

  /** 设置翻页动画时长（ms） */
  async function setComicPageTurnDuration(value: number): Promise<void> {
    comicPageTurnDuration.value = clampComicPageTurnDuration(value);
    try {
      await window.dbApi.setting.set(readerKey('comicPageTurnDuration'), String(comicPageTurnDuration.value));
    } catch (err) {
      console.warn('[settings] 持久化翻页动画时长失败:', err);
    }
  }

  /** 设置页面缩放类型（对标 Mihon：fitScreen/fitWidth/original/smartFit） */
  async function setComicScaleType(value: ComicScaleType): Promise<void> {
    comicScaleType.value = value;
    try {
      await window.dbApi.setting.set(readerKey('comicScaleType'), value);
    } catch (err) {
      console.warn('[settings] 持久化页面缩放类型失败:', err);
    }
  }

  /** 设置连续阅读（滚到底部自动加载下一章） */
  async function setComicContinuousReading(value: boolean): Promise<void> {
    comicContinuousReading.value = value;
    try {
      await window.dbApi.setting.set(readerKey('comicContinuousReading'), String(value));
    } catch (err) {
      console.warn('[settings] 持久化连续阅读失败:', err);
    }
  }

  /** 设置漫画翻页动画类型（slide/fade/none） */
  async function setComicPageTurnAnimation(value: ComicPageTurnAnimationType): Promise<void> {
    comicPageTurnAnimation.value = value;
    try {
      await window.dbApi.setting.set(readerKey('comicPageTurnAnimation'), value);
    } catch (err) {
      console.warn('[settings] 持久化漫画翻页动画失败:', err);
    }
  }

  // ─── Actions：阅读增强设置 ───

  /** 设置自定义字体路径和名称 */
  async function setCustomFont(path: string | null, name: string | null): Promise<void> {
    customFontPath.value = path;
    customFontName.value = name;
    try {
      await Promise.all([
        window.dbApi.setting.set(readerKey('customFontPath'), path ?? ''),
        window.dbApi.setting.set(readerKey('customFontName'), name ?? '')
      ]);
    } catch (err) {
      console.warn('[settings] 持久化自定义字体失败:', err);
    }
  }

  /** 设置自动连字 */
  async function setHyphenationEnabled(value: boolean): Promise<void> {
    hyphenationEnabled.value = value;
    try {
      await window.dbApi.setting.set(readerKey('hyphenationEnabled'), String(value));
    } catch (err) {
      console.warn('[settings] 持久化自动连字失败:', err);
    }
  }

  /** 设置自定义CSS样式 */
  async function setCustomCss(value: string): Promise<void> {
    customCss.value = value;
    try {
      await window.dbApi.setting.set(readerKey('customCss'), value);
    } catch (err) {
      console.warn('[settings] 持久化自定义CSS失败:', err);
    }
  }

  /** 设置垂直书写模式 */
  async function setVerticalWriting(value: boolean): Promise<void> {
    verticalWriting.value = value;
    try {
      await window.dbApi.setting.set(readerKey('verticalWriting'), String(value));
    } catch (err) {
      console.warn('[settings] 持久化垂直书写失败:', err);
    }
  }

  // ─── Actions：漫画增强设置 ───

  /** 设置漫画对比度（50-300，100=原始） */
  async function setComicContrast(value: number): Promise<void> {
    comicContrast.value = clampComicContrast(value);
    try {
      await window.dbApi.setting.set(readerKey('comicContrast'), String(comicContrast.value));
    } catch (err) {
      console.warn('[settings] 持久化漫画对比度失败:', err);
    }
  }

  /** 设置漫画图片分割类型 */
  async function setComicImageSplit(value: ComicImageSplitType): Promise<void> {
    comicImageSplit.value = value;
    try {
      await window.dbApi.setting.set(readerKey('comicImageSplit'), value);
    } catch (err) {
      console.warn('[settings] 持久化漫画图片分割失败:', err);
    }
  }

  // ─── Actions：阅读偏好设置（翻页/点击翻页） ───

  /** 设置翻页方向（left-to-right / right-to-left） */
  async function setPageTurnDirection(value: PageTurnDirectionType): Promise<void> {
    pageTurnDirection.value = value;
    try {
      await window.dbApi.setting.set(readerKey('pageTurnDirection'), value);
    } catch (err) {
      console.warn('[settings] 持久化翻页方向失败:', err);
    }
  }

  /** 设置点击翻页开关 */
  async function setTapTurnEnabled(value: boolean): Promise<void> {
    tapTurnEnabled.value = value;
    try {
      await window.dbApi.setting.set(readerKey('tapTurnEnabled'), String(value));
    } catch (err) {
      console.warn('[settings] 持久化点击翻页开关失败:', err);
    }
  }

  /** 设置点击翻页区域（left-right / bottom / full） */
  async function setTapTurnZone(value: TapTurnZoneType): Promise<void> {
    tapTurnZone.value = value;
    try {
      await window.dbApi.setting.set(readerKey('tapTurnZone'), value);
    } catch (err) {
      console.warn('[settings] 持久化点击翻页区域失败:', err);
    }
  }

  // ─── Actions：快捷键自定义 ───

  /**
   * 设置某个动作的快捷键
   * @param action 动作名（如 nextPage、prevPage 等）
   * @param key 按键组合（如 'Ctrl+ArrowRight'），空字符串表示清除该快捷键
   */
  async function setKeyboardShortcut(action: string, key: string): Promise<void> {
    keyboardShortcuts.value = { ...keyboardShortcuts.value, [action]: key };
    try {
      await window.dbApi.setting.set(readerKey('keyboardShortcuts'), JSON.stringify(keyboardShortcuts.value));
    } catch (err) {
      console.warn('[settings] 持久化快捷键失败:', err);
    }
  }

  // ─── Actions：重置 ───

  async function resetToDefaults(): Promise<void> {
    fontSize.value = DEFAULTS.fontSize;
    fontFamily.value = DEFAULTS.fontFamily;
    lineHeight.value = DEFAULTS.lineHeight;
    pageWidth.value = DEFAULTS.pageWidth;
    margin.value = DEFAULTS.margin;
    paragraphSpacing.value = DEFAULTS.paragraphSpacing;

    autoScrollSpeed.value = DEFAULTS.autoScrollSpeed;
    ttsRate.value = DEFAULTS.ttsRate;
    ttsVoice.value = DEFAULTS.ttsVoice;
    ttsPitch.value = DEFAULTS.ttsPitch;
    appTheme.value = DEFAULTS.appTheme;
    appThemeFollowSystem.value = DEFAULTS.appThemeFollowSystem;
    readerTheme.value = DEFAULTS.readerTheme;
    readerThemeFollowSystem.value = DEFAULTS.readerThemeFollowSystem;
    customThemeColors.value = { ...DEFAULTS.customThemeColors };
    textConvert.value = DEFAULTS.textConvert;
    smartFormat.value = DEFAULTS.smartFormat;
    pageTurnAnimation.value = DEFAULTS.pageTurnAnimation;

    // 重置漫画设置
    comicReadDirection.value = DEFAULTS.comicReadDirection;
    comicDoublePage.value = DEFAULTS.comicDoublePage;
    comicImageGap.value = DEFAULTS.comicImageGap;
    comicPreloadCount.value = DEFAULTS.comicPreloadCount;
    comicPageTurnDuration.value = DEFAULTS.comicPageTurnDuration;
    comicScaleType.value = DEFAULTS.comicScaleType;
    comicContinuousReading.value = DEFAULTS.comicContinuousReading;
    comicPageTurnAnimation.value = DEFAULTS.comicPageTurnAnimation;

    // 重置阅读增强设置
    customFontPath.value = DEFAULTS.customFontPath;
    customFontName.value = DEFAULTS.customFontName;
    hyphenationEnabled.value = DEFAULTS.hyphenationEnabled;
    customCss.value = DEFAULTS.customCss;
    verticalWriting.value = DEFAULTS.verticalWriting;

    // 重置漫画增强设置
    comicContrast.value = DEFAULTS.comicContrast;
    comicImageSplit.value = DEFAULTS.comicImageSplit;

    // 重置阅读偏好设置
    pageTurnDirection.value = DEFAULTS.pageTurnDirection;
    tapTurnEnabled.value = DEFAULTS.tapTurnEnabled;
    tapTurnZone.value = DEFAULTS.tapTurnZone;

    // 重置快捷键自定义
    keyboardShortcuts.value = { ...DEFAULT_KEYBOARD_SHORTCUTS };

    try {
      await Promise.all([
        window.dbApi.setting.set(readerKey('fontSize'), String(DEFAULTS.fontSize)),
        window.dbApi.setting.set(readerKey('fontFamily'), DEFAULTS.fontFamily),
        window.dbApi.setting.set(readerKey('lineHeight'), String(DEFAULTS.lineHeight)),
        window.dbApi.setting.set(readerKey('pageWidth'), String(DEFAULTS.pageWidth)),
        window.dbApi.setting.set(readerKey('margin'), String(DEFAULTS.margin)),
        window.dbApi.setting.set(readerKey('paragraphSpacing'), String(DEFAULTS.paragraphSpacing)),

        window.dbApi.setting.set(readerKey('autoScrollSpeed'), String(DEFAULTS.autoScrollSpeed)),
        window.dbApi.setting.set(readerKey('ttsRate'), String(DEFAULTS.ttsRate)),
        window.dbApi.setting.set(readerKey('ttsVoice'), DEFAULTS.ttsVoice ?? ''),
        window.dbApi.setting.set(readerKey('ttsPitch'), String(DEFAULTS.ttsPitch)),
        window.dbApi.setting.set(readerKey('theme'), DEFAULTS.readerTheme),
        window.dbApi.setting.set(readerKey('themeFollowSystem'), String(DEFAULTS.readerThemeFollowSystem)),
        window.dbApi.setting.set(appKey('theme'), DEFAULTS.appTheme),
        window.dbApi.setting.set(appKey('themeFollowSystem'), String(DEFAULTS.appThemeFollowSystem)),
        window.dbApi.setting.set(readerKey('customThemeColors'), JSON.stringify(DEFAULTS.customThemeColors)),
        window.dbApi.setting.set(readerKey('textConvert'), DEFAULTS.textConvert),
        window.dbApi.setting.set(readerKey('smartFormat'), String(DEFAULTS.smartFormat)),
        window.dbApi.setting.set(readerKey('pageTurnAnimation'), DEFAULTS.pageTurnAnimation),
        // 重置漫画设置
        window.dbApi.setting.set(readerKey('comicReadDirection'), DEFAULTS.comicReadDirection),
        window.dbApi.setting.set(readerKey('comicDoublePage'), String(DEFAULTS.comicDoublePage)),
        window.dbApi.setting.set(readerKey('comicImageGap'), String(DEFAULTS.comicImageGap)),
        window.dbApi.setting.set(readerKey('comicPreloadCount'), String(DEFAULTS.comicPreloadCount)),
        window.dbApi.setting.set(readerKey('comicPageTurnDuration'), String(DEFAULTS.comicPageTurnDuration)),
        window.dbApi.setting.set(readerKey('comicScaleType'), DEFAULTS.comicScaleType),
        window.dbApi.setting.set(readerKey('comicContinuousReading'), String(DEFAULTS.comicContinuousReading)),
        window.dbApi.setting.set(readerKey('comicPageTurnAnimation'), DEFAULTS.comicPageTurnAnimation),
        // 重置阅读增强设置
        window.dbApi.setting.set(readerKey('customFontPath'), DEFAULTS.customFontPath ?? ''),
        window.dbApi.setting.set(readerKey('customFontName'), DEFAULTS.customFontName ?? ''),
        window.dbApi.setting.set(readerKey('hyphenationEnabled'), String(DEFAULTS.hyphenationEnabled)),
        window.dbApi.setting.set(readerKey('customCss'), DEFAULTS.customCss),
        window.dbApi.setting.set(readerKey('verticalWriting'), String(DEFAULTS.verticalWriting)),
        // 重置漫画增强设置
        window.dbApi.setting.set(readerKey('comicContrast'), String(DEFAULTS.comicContrast)),
        window.dbApi.setting.set(readerKey('comicImageSplit'), DEFAULTS.comicImageSplit),
        // 重置阅读偏好设置
        window.dbApi.setting.set(readerKey('pageTurnDirection'), DEFAULTS.pageTurnDirection),
        window.dbApi.setting.set(readerKey('tapTurnEnabled'), String(DEFAULTS.tapTurnEnabled)),
        window.dbApi.setting.set(readerKey('tapTurnZone'), DEFAULTS.tapTurnZone),
        // 重置快捷键自定义
        window.dbApi.setting.set(readerKey('keyboardShortcuts'), JSON.stringify(DEFAULT_KEYBOARD_SHORTCUTS))
      ]);
    } catch (err) {
      console.warn('[settings] 重置设置失败:', err);
    }
  }

  // ─── Actions：系统主题监听 ───

  function initSystemThemeListener(): void {
    if (mediaQuery) return;
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    systemTheme.value = mediaQuery.matches ? 'dark' : 'light';
    mediaQueryHandler = (e: MediaQueryListEvent): void => {
      systemTheme.value = e.matches ? 'dark' : 'light';
    };
    mediaQuery.addEventListener('change', mediaQueryHandler);
  }

  function cleanupSystemThemeListener(): void {
    if (mediaQuery && mediaQueryHandler) {
      mediaQuery.removeEventListener('change', mediaQueryHandler);
    }
    mediaQuery = null;
    mediaQueryHandler = null;
  }

  return {
    // state
    fontSize,
    fontFamily,
    lineHeight,
    pageWidth,
    margin,
    paragraphSpacing,

    autoScrollSpeed,
    ttsRate,
    ttsVoice,
    ttsPitch,
    appTheme,
    appThemeFollowSystem,
    readerTheme,
    readerThemeFollowSystem,
    customThemeColors,
    systemTheme,
    textConvert,
    smartFormat,
    pageTurnAnimation,
    // 漫画设置 state
    comicReadDirection,
    comicDoublePage,
    comicImageGap,
    comicPreloadCount,
    comicPageTurnDuration,
    comicScaleType,
    comicContinuousReading,
    comicPageTurnAnimation,
    // 阅读增强设置 state
    customFontPath,
    customFontName,
    hyphenationEnabled,
    customCss,
    verticalWriting,
    // 漫画增强设置 state
    comicContrast,
    comicImageSplit,
    // 阅读偏好设置 state
    pageTurnDirection,
    tapTurnEnabled,
    tapTurnZone,
    // 快捷键自定义 state
    keyboardShortcuts,
    // getters
    effectiveAppTheme,
    effectiveReaderTheme,
    appThemeColors,
    readerThemeColors,
    fontFamilyCss,
    // actions
    loadSettings,
    setFontSize,
    increaseFontSize,
    decreaseFontSize,
    setFontFamily,
    setLineHeight,
    setPageWidth,
    setMargin,
    setParagraphSpacing,

    setAutoScrollSpeed,
    setTtsRate,
    setTtsVoice,
    setTtsPitch,
    setAppTheme,
    setAppThemeFollowSystem,
    setReaderTheme,
    setReaderThemeFollowSystem,
    setCustomThemeColors,
    setTextConvert,
    setSmartFormat,
    setPageTurnAnimation,
    // 漫画设置 actions
    setComicReadDirection,
    setComicDoublePage,
    setComicImageGap,
    setComicPreloadCount,
    setComicPageTurnDuration,
    setComicScaleType,
    setComicContinuousReading,
    setComicPageTurnAnimation,
    // 阅读增强设置 actions
    setCustomFont,
    setHyphenationEnabled,
    setCustomCss,
    setVerticalWriting,
    // 漫画增强设置 actions
    setComicContrast,
    setComicImageSplit,
    // 阅读偏好设置 actions
    setPageTurnDirection,
    setTapTurnEnabled,
    setTapTurnZone,
    // 快捷键自定义 actions
    setKeyboardShortcut,
    resetToDefaults,
    initSystemThemeListener,
    cleanupSystemThemeListener
  };
});
