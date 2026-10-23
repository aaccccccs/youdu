import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Book, ChapterIndex, ReadMode } from '@renderer/types';
import type { ChapterImage } from '../../../shared';
import { mergeChapterImages, parseFileMissingMessage } from '../../../shared';

import { i18n } from '@renderer/i18n';
import { useSettingsStore } from './settings';
import { useBookDetailStore } from './book-detail';

// ═══════════════════════════════════════════════════════════════════════
// 5. Reader Store
// ═══════════════════════════════════════════════════════════════════════

/**
 * 阅读器状态管理（Pinia Store）
 *
 * 维护当前书籍、章节目录、章节正文、阅读进度等状态。
 * 阅读偏好（字号/行距/页宽/主题/字体）委托给 settings store（单一数据源）。
 * 本 store 仅保留阅读模式（readMode）的持久化。
 *
 * 设计要点：
 * - 章节正文按需加载，仅持有当前章节 + 预加载下一章
 * - 翻章时优先使用预加载内容，避免等待
 * - 进度保存 debounce 2 秒，翻章/退出立即保存
 * - 阅读会话计时用于阅读统计分析
 */
// P1-9: 跨 Store 同步 — 延迟导入避免循环依赖，在 action 内部动态获取 store 实例


const READ_MODE_KEY = 'reader.readMode';
const DEFAULT_READ_MODE: ReadMode = 'chapter';
const PROGRESS_DEBOUNCE_MS = 2000;

/* ─── v53 分批渐进加载（扫描版 PDF 首批快速返回 + 滚动/翻页幂等续载） ─── */

/**
 * 首批渲染页数：扫描版一章 5-20 页，整章预渲染每页数百 ms → 白屏数秒；
 * 首批 3 页（约 1s）先返回可交互，其余页 pending 占位、按需续载。
 * 漫画一章一图（1 页 < 3）自然全量渲染，不受影响。
 *
 * 5 → 3 的依据：扫描书单页 getScreenshot（含 JBIG2/JPX 解码 + scale2）实测
 * ~480-720ms，首批页数是首屏绝对耗时大头；减到 3 页后主进程侧首批渲染耗时
 * 由 ~4.5s 降至 ~2s 区间（视前端 desiredWidth 而定），配合滚动续载不失体验。
 */
const COMIC_INITIAL_RENDER_PAGES = 3;

/**
 * 阅读器首屏耗时诊断开关（定位"打开扫描版书很久/一次读取很多图片很卡"）。
 *
 * 开启：DevTools 控制台执行 `localStorage.setItem('youdu:reader-prof', '1')`
 * 后刷新页面并重新打开书籍。关闭：`localStorage.removeItem('youdu:reader-prof')`。
 * 默认关闭，零日志噪声；输出前缀 [reader-prof] 便于过滤。
 */
const READER_PROF_ENABLED: boolean = (() => {
  try {
    return localStorage.getItem('youdu:reader-prof') === '1';
  } catch {
    return false;
  }
})();
function profLog(msg: string): void {
  if (READER_PROF_ENABLED) console.log(`[reader-prof] ${msg}`);
}

/** 续载去抖窗口（ms）：IntersectionObserver 高频回调合并为一次 IPC */
const ENSURE_IMAGES_DEBOUNCE_MS = 200;

/**
 * link 书失效信息（批次 v54 + P2修复）：parseFileMissingMessage 的解析结果
 * 附加"原始请求章索引"。
 *
 * P2修复背景：开书首次 loadChapter(进度章 N) 失败时 currentChapterIndex 尚未
 * 推进（仍为 0，成功路径才写索引），Reader.vue handleRelocated 若按
 * currentChapterIndex 重试会回第 0 章而非原进度章 N。恢复重试必须用此处的
 * attemptedChapterIndex（loadChapter 请求参数的忠实快照）。
 */
interface FileMissingInfo {
  bookId: number;
  path: string;
  hash: string | null;
  /** loadChapter 失败时的原始请求章索引（重试恢复的目标章） */
  attemptedChapterIndex: number;
}

export const useReaderStore = defineStore('reader', () => {
  const settings = useSettingsStore();

  // ─── State：书籍与章节 ───
  const book = ref<Book | null>(null);
  const chapters = ref<ChapterIndex[]>([]);
  const currentChapterIndex = ref<number>(0);
  const chapterContent = ref<string>('');
  const nextChapterContent = ref<string | null>(null);
  const nextChapterPreloaded = ref<boolean>(false);
  const loading = ref<boolean>(false);
  const errorMsg = ref<string>('');
  /**
   * link 书原文件失效信息（批次 v54 导入三模式）：
   * loadChapter 收到 [FILE_MISSING] 结构化错误时填充，Reader.vue watch 后弹
   * 重新定位对话框；恢复成功（RelocateDialog 调 relocate）后调 clearFileMissing
   * 并自动重试打开原章节。
   */
  const fileMissing = ref<FileMissingInfo | null>(null);

  // ─── State：阅读模式 ───
  const readMode = ref<ReadMode>(DEFAULT_READ_MODE);

  // ─── State：漫画模式 ───
  /** 当前书籍是否为漫画 */
  const isComic = ref<boolean>(false);
  /** 当前章节的图片列表（图片渲染模式，v49 起含真实尺寸供精确占位） */
  const comicImages = ref<ChapterImage[]>([]);
  /**
   * comicImages 原地合并的版本号（v53 续载用）。
   * 续载成功后 splice 原地写回 comicImages（保持数组引用不变 → 组件
   * watch(props.images) 不触发、不重置滚动/加载状态），数组内容的响应式
   * 变化对直接渲染 props.images 的组件（ComicPageMode）自动生效；
   * ComicScrollMode 因维护拼接拷贝（accumulatedImages）无法感知原地变更，
   * 通过 watch 此版本号同步当前章区间。
   */
  const comicImagesRevision = ref<number>(0);
  /**
   * comicImages 数据源章索引（v54 跨章无限滚动）。
   * 与 currentChapterIndex（阅读进度/目录高亮语义，滚动拼接模式下跟随视口所在章）
   * 解耦：滚动拼接后用户滚回旧章时 currentChapterIndex 会回退，但 comicImages
   * 仍持有最后拼接章的数据 —— 续载 IPC（dispatchEnsure）必须用本索引才能与
   * comicImages/组件 lastChapterStartSlot 对齐，避免错章合并。
   * 翻页模式无拼接，两者恒等。
   */
  const comicChapterIndex = ref<number>(0);

  /**
   * P1-2（导航审计 #2）：拼接列表最后拼接章的绝对索引。
   *
   * append 模式（距底拼接下一章）下与 comicChapterIndex 相同（数据源章=
   * 最后拼接章）；prepend 模式（触顶拼接上一章）下数据源章前移至拼接首章
   * （comicChapterIndex 跟随），最后拼接章不变——Reader 侧"还有没有下一章
   * 可拼 / 下一章章号"须以此为准（comicChapterIndex 在 prepend 后指向首章，
   * 直接 +1 会请求已在拼接列表中的章）。
   */
  const comicLastSplicedIndex = ref<number>(0);
  /** 漫画阅读模式：'scroll'=垂直滚动，'page'=翻页 */
  const comicMode = ref<'scroll' | 'page'>('scroll');

  // ─── State：渲染路由（v38 真图文修复） ───
  /**
   * 当前章节是否以"图片阅读器"（ComicViewer 一次一页/懒加载）渲染。
   * 取值由 loadChapter 按内容动态判定：
   *   - 漫画（content_type=comic）→ true
   *   - PDF 扫描版（illustrated 且章节纯文本极少）→ true
   *   - PDF 真图文（illustrated 且章节大量文字）→ false（ScrollView 图文混排，[IMG:] 内嵌插图）
   *   - EPUB/MOBI 的 image 章节 → true；文字章节 → false
   * Reader.vue 依据此值路由渲染组件并增减文字专属 UI（字号/TTS/搜索）。
   */
  const renderAsImages = ref<boolean>(false);
  /**
   * PDF 图文书（content_type='illustrated'）的"扫描版式"判定结果（书级，一次判定）。
   * true=扫描版（图片渲染）；false=真图文（文字渲染）。
   * 首章加载后按纯文本量判定，之后整本书沿用，避免章节间渲染器跳变。
   */
  let pdfIllustratedIsScanLike = false;
  let pdfIllustratedDetermined = false;
  /** PDF 图文书判定阈值：采样章累计"正常字符"（CJK+ASCII，乱码不计入）/页低于此值视为扫描版。
   *  v47：累计口径（替代 v45 的"任一章最大"）—— 混合质量书少数好页不再一票通过。
   *  依据：真图文每页 ≥ 300 正常 CJK 字（文字为主）；扫描版 OCR 每页 < 300。 */
  const PDF_SCAN_NORMAL_CHARS_PER_PAGE = 300;
  /** PDF 图文书判定阈值②（v47 新增）：采样章累计乱码率超过此值视为扫描版（文字层不可靠）。
   *  实测《iOS实战篇》逐页乱码率 60~90%（少数页 <20%）→ 累计乱码率高 → 正确判扫描版；
   *  真图文（原生文字层）累计乱码率 <10%。25% 是两者间 2.5 倍安全余量。 */
  const PDF_SCAN_GARBLED_RATIO_MAX = 0.25;

  // ─── 阅读偏好：从 settings store 派生 ───
  const fontSize = computed<number>(() => settings.fontSize);
  const lineHeight = computed<number>(() => settings.lineHeight);
  const pageWidth = computed<number>(() => settings.pageWidth);
  const fontFamilyCss = computed<string>(() => settings.fontFamilyCss);
  const margin = computed<number>(() => settings.margin);
  const paragraphSpacing = computed<number>(() => settings.paragraphSpacing);

  const autoScrollSpeed = computed<number>(() => settings.autoScrollSpeed);
  const ttsRate = computed<number>(() => settings.ttsRate);

  // ─── State：UI ───
  const showChapterBar = ref<boolean>(false);
  const showToolbar = ref<boolean>(false);
  /** 全屏/沉浸阅读模式（对标 Kindle/Apple Books 全屏阅读体验）
   *
   * F2 修复：除 toggleFullscreen 主动切换外，用户经系统途径（F11/OS 快捷键/
   * 窗口管理器）切全屏时由主进程 WINDOW_FULLSCREEN_CHANGED 事件推送——此处
   * 常驻监听同步 ref，保证 App.vue 标题栏显隐与阅读器全屏样式判定不失步。
   * 监听在 store 首次实例化时注册一次（App.vue 启动即 useReaderStore），
   * App.vue onBeforeUnmount 中统一 offFullscreenChanged（根组件与应用同生命周期）。
   */
  const isFullscreen = ref<boolean>(false);
  if (window.windowApi?.onFullscreenChanged) {
    window.windowApi.onFullscreenChanged((fullscreen: boolean): void => {
      isFullscreen.value = fullscreen;
    });
  }

  // ─── State：阅读进度 ───
  const readStartTime = ref<number>(Date.now());
  const accumulatedReadTime = ref<number>(0);
  const lastScrollPosition = ref<number>(0);
  /** 实时滚动位置（由视图组件实时更新，不受 debounce 影响，用于进度条显示）
   *  类型为 number | null：null 表示"未设置/未滚动"，0 表示"滚动到章节开头"（合法值）。
   *  这样 progressPercent 可用 ?? 正确 fallback，避免 0 被当 falsy 误判。
   */
  const liveScrollPosition = ref<number | null>(null);
  /**
   * 实时章内偏移（根因④：图片模式 chapter_offset 持久化）。
   * 图片型内容 = 当前视口章的章内页码（1-based）；文字型内容恒 0
   * （文字模式的位置由 scroll_position 的段落归一化坐标表达，见根因①）。
   * 与 liveScrollPosition 同步更新，供窗口关闭兜底（flushProgressOnClose）
   * 在 debounce 未落库时取到最新页码。
   */
  const liveChapterOffset = ref<number>(0);
  /**
   * 实时章内字符偏移（任务25：文本模式的内容锚点，chapter_offset 字段
   * 在文本模式下的语义——图片模式用 liveChapterOffset 页码，两模式互不冲突）。
   * 语义 = 视口顶落在本章第 X 个字符处（源文本累加 + 段内 0.5 比例），
   * 免疫字号/行距/窗口/主题变化；由 ScrollView 在滚动时实时维护
   * （markdown/全文模式无可靠锚点，恒 0 → 恢复走比例路径）。
   */
  const liveChapterCharOffset = ref<number>(0);

  // ─── 内部变量：阅读会话计时 ───
  let sessionStartTime = 0;

  let sessionVisitedChapters = new Set<number>();
  /** 每个访问过章节的字数（chapter_index → content.length），用于按滚动进度估算 chars_read */
  let sessionChapterLengths = new Map<number, number>();
  /** 每个章节的最大滚动进度（chapter_index → 0~1），退出时按 progress × length 计算实际阅读字数 */
  let sessionChapterProgress = new Map<number, number>();

  // ─── 内部变量：进度保存定时器 ───
  let progressTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── 内部变量：预加载取消标志 ───
  // 使用对象引用而非布尔值，每次 preloadNext 创建自己的标志对象，
  // 避免快速连续翻章时旧的预加载检查到已被重置的全局标志
  let preloadAbortFlag: { aborted: boolean } | null = null;

  // ─── 内部变量：页面可见性计时 ───
  // 页面隐藏时暂停阅读计时，恢复时重新开始，避免非活跃时间被计入阅读时长
  let visibilityHandler: (() => void) | null = null;

  // ─── 内部变量：空闲检测计时 ───
  // 用户长时间无操作（mousemove/keydown/click/wheel/scroll）时暂停会话计时，
  // 避免用户离开屏幕但页面仍可见时，墙钟时间被全部计入 reading_sessions.duration。
  // 与 visibilityHandler 互补：visibilitychange 只覆盖"切走标签页"，空闲检测覆盖"标签页可见但人不在"。
  // P2-19 修复：空闲阈值由 60 秒调整为 120 秒（2 分钟）。
  // 原因：60 秒对静止阅读场景过短，用户在专注阅读时可能长时间不触发交互，
  // 导致会话计时被频繁中断。120 秒在"静止阅读"与"离开屏幕"之间取得平衡。
  /** 空闲阈值：120 秒无任何用户交互视为空闲 */
  const IDLE_THRESHOLD_MS = 120 * 1000;
  /** 空闲检测轮询间隔：每 5 秒检查一次 lastActivityTime */
  const IDLE_CHECK_INTERVAL_MS = 5 * 1000;
  /** 最后一次用户交互时间戳（ms） */
  let lastActivityTime = 0;
  /** 当前活跃段开始时间戳；为 0 表示当前处于空闲状态 */
  let lastActiveStart = 0;
  /** 本会话累计活跃阅读时间（ms），仅在不空闲时累加 */
  let sessionActiveTime = 0;
  /** 空闲检测定时器句柄 */
  let idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** 用户交互事件监听器引用，便于 cleanup 时移除 */
  let activityHandlers: { name: string; handler: () => void }[] = [];

  // ─── Getters ───

  const currentChapterTitle = computed<string>(() => {
    const ch = chapters.value[currentChapterIndex.value];
    return ch?.title ?? i18n.global.t('reader.chapterN', { n: currentChapterIndex.value + 1 });
  });

  const totalChapters = computed<number>(() => chapters.value.length);

  const hasPrevChapter = computed<boolean>(() => currentChapterIndex.value > 0);

  const hasNextChapter = computed<boolean>(() => currentChapterIndex.value < chapters.value.length - 1);

  /** 基于 file_length 加权的进度百分比（0~1）
   *
   * 用各章节的 file_length 作为权重，计算已读比例：
   * - 已读完章节的权重全额计入
   * - 当前章节的权重按 scroll_position（0~1）比例计入
   * - file_length 为 null/0 的章节权重按 1 处理（等权 fallback）
   *
   * 比纯章节数百分比更精确：大章节贡献更多进度，小章节贡献更少。
   */
  const progressPercent = computed<number>(() => {
    if (totalChapters.value === 0) return 0;

    // 计算各章节权重（file_length 作为相对大小指标，null/0 时 fallback 为 1）
    const weights = chapters.value.map((ch) => ch.file_length ?? 1);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight === 0) return 0;

    // 已读完章节的权重和
    let completedWeight = 0;
    for (let i = 0; i < currentChapterIndex.value; i++) {
      completedWeight += weights[i] ?? 1;
    }

    // 当前章节按阅读位置比例计入
    // 优先使用 liveScrollPosition（实时更新），fallback 到 lastScrollPosition（debounce 后）
    // 用 ?? 而非 ||：0 是合法的滚动位置（章节开头），不应被当 falsy 跳过
    const currentWeight = weights[currentChapterIndex.value] ?? 1;
    const currentChapterProgress = liveScrollPosition.value ?? lastScrollPosition.value;
    completedWeight += currentWeight * currentChapterProgress;

    return completedWeight / totalWeight;
  });

  // ─── Actions：偏好加载/持久化 ───

  async function loadPreferences(): Promise<void> {
    try {
      const mode = await window.dbApi.setting.get(READ_MODE_KEY);
      if (mode === 'chapter' || mode === 'scroll' || mode === 'page' || mode === 'all') readMode.value = mode;
    } catch (err) {
      console.warn('[reader] 加载阅读模式失败:', err);
    }
    await settings.loadSettings();
  }

  async function setReadMode(mode: ReadMode): Promise<void> {
    readMode.value = mode;
    try {
      await window.dbApi.setting.set(READ_MODE_KEY, mode);
    } catch (err) {
      console.warn('[reader] 持久化阅读模式失败:', err);
    }
  }

  async function increaseFontSize(): Promise<void> {
    await settings.increaseFontSize();
  }

  async function decreaseFontSize(): Promise<void> {
    await settings.decreaseFontSize();
  }

  // ─── Actions：漫画模式 ───

  // v53 分批渐进加载的续载控制（模块级变量随 store 闭包，见文件顶部常量）
  /** 去抖累积的待续载请求（A-4：章索引 → 该章槽位集合，槽位 1-based = 章内数组下标 + 1） */
  let pendingEnsureSlots = new Map<number, Set<number>>();
  let ensureDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 在途标志：dispatch 运行中时新槽位仅入集合，完成后立刻补发一轮 */
  let ensureDispatching = false;
  /** 续载请求序号：loadChapter 时 ++ 使旧响应失效（防翻章竞争错章合并） */
  let ensureSeq = 0;
  /**
   * A-4：跨章续载响应通道 —— 拼接列表中旧章（非数据源章）的完整图片列表。
   * comicImages 只持有数据源章（最后拼接章）数据，旧章续载响应无法经
   * mergeChapterImages(comicImages) 原地合并（会与新章数据错乱），改经本
   * Map 传递，ComicScrollMode watch(comicImagesRevision) 时按章边界同步到
   * 拼接列表区间，消费后由 consumeComicChapterImageUpdates 清空。
   */
  const comicChapterImageUpdates = ref<Map<number, ChapterImage[]>>(new Map());

  /** 实际发起续载 IPC 并合并结果（一次处理当前累积的全部章请求，逐章顺序） */
  async function dispatchEnsure(): Promise<void> {
    if (ensureDispatching) return;
    if (!book.value || pendingEnsureSlots.size === 0) return;
    ensureDispatching = true;
    const requests = Array.from(pendingEnsureSlots.entries()).map(([chapterIndex, slots]) => ({
      chapterIndex,
      pages: Array.from(slots).sort((a, b) => a - b)
    }));
    pendingEnsureSlots.clear();
    const seq = ensureSeq;
    const bookIdAtRequest = book.value.id;
    try {
      for (const req of requests) {
        const updated = await window.dbApi.chapter.ensureImages(bookIdAtRequest, req.chapterIndex, req.pages);
        // 竞争检查：翻章/切书后旧响应丢弃（拼接列表已被重置，合并会错章）
        if (!updated || seq !== ensureSeq || !book.value || book.value.id !== bookIdAtRequest) return;
        if (req.chapterIndex === comicChapterIndex.value) {
          // 数据源章：原地合并 comicImages（splice 保持数组引用）：组件
          // watch(props.images) 不触发、不重置滚动/加载状态；数组内容变化经
          // 响应式传播，直接渲染 props.images 的组件自动更新，拼接拷贝组件
          // （ComicScrollMode）经 revision 信号同步
          const merged = mergeChapterImages(comicImages.value, updated);
          comicImages.value.splice(0, comicImages.value.length, ...merged);
        } else {
          // A-4：拼接列表中的旧章 → 跨章通道（ComicScrollMode 按章边界同步）
          const map = new Map(comicChapterImageUpdates.value);
          map.set(req.chapterIndex, updated);
          comicChapterImageUpdates.value = map;
        }
        comicImagesRevision.value++;
      }
    } catch (err) {
      console.error('[reader] ensureImages 续载失败:', err);
    } finally {
      ensureDispatching = false;
      // dispatch 期间（含去抖窗口跳过）又累积的槽位 → 立刻补发（无去抖，尽快渲染）
      if (pendingEnsureSlots.size > 0) {
        void dispatchEnsure();
      }
    }
  }

  /** 消费跨章续载响应（ComicScrollMode 同步拼接列表后调用，防重复消费） */
  function consumeComicChapterImageUpdates(): void {
    if (comicChapterImageUpdates.value.size === 0) return;
    comicChapterImageUpdates.value = new Map();
  }

  /**
   * 续载章节图片（v53 分批渐进加载，幂等）
   *
   * 前端滚动/翻页接近 pending 占位页时调用（fire-and-forget，无需 await）。
   * 请求经 200ms 去抖合并为一次 IPC（观察器高频回调不放大 IPC 次数）；
   * 主进程按槽位映射渲染仍缺失的页，已渲染页复用磁盘缓存（多次调用无副作用）。
   * 成功后：数据源章原地合并 comicImages 并递增 comicImagesRevision；旧章
   * （A-4 拼接列表中）写入 comicChapterImageUpdates 同步通道。
   *
   * @param pages 请求续载的槽位列表（1-based = 该章图片数组下标 + 1）
   * @param chapterIndex 目标章索引（A-4：默认 comicChapterIndex 数据源章；
   *   拼接列表旧章的 pending 页按所属章传参）
   */
  function ensureImages(pages: number[], chapterIndex?: number): void {
    if (!book.value) return;
    const targetChapter = chapterIndex ?? comicChapterIndex.value;
    let slots = pendingEnsureSlots.get(targetChapter);
    if (!slots) {
      slots = new Set<number>();
      pendingEnsureSlots.set(targetChapter, slots);
    }
    let added = false;
    for (const p of pages) {
      // 槽位有效性：1-based。数据源章以 comicImages 长度为界；跨章（拼接旧章）
      // 的章内列表长度组件侧才知晓，主进程 computeEnsureRenderPages 对越界
      // 槽位天然忽略，此处放宽为正整数即可
      const inRange = Number.isInteger(p) && p >= 1 &&
        (targetChapter !== comicChapterIndex.value || p <= comicImages.value.length);
      if (inRange) {
        slots.add(p);
        added = true;
      }
    }
    if (!added && pendingEnsureSlots.size === 0) return;
    if (ensureDebounceTimer !== null) return; // 去抖已排定：新槽位并入集合即可
    ensureDebounceTimer = setTimeout(() => {
      ensureDebounceTimer = null;
      void dispatchEnsure();
    }, ENSURE_IMAGES_DEBOUNCE_MS);
  }

  /** 加载章节图片（漫画模式） */
  async function loadComicImages(bookId: number, chapterIndex: number): Promise<void> {
    try {
      const images = await window.dbApi.chapter.readImages(bookId, chapterIndex);
      comicImages.value = images ?? [];
    } catch (err) {
      console.error('[reader] 加载漫画图片失败:', err);
      comicImages.value = [];
    }
  }

  /* ─── v54 跨章无限滚动：下一章首批预取 + 视口章同步 ─── */

  /** 已成功预取过首批的章索引（缓存命中即跳过，避免重复 IPC） */
  const comicPrefetchedChapters = new Set<number>();
  /** 预取进行中标志（滚动/翻页两处触发合并为一次在途请求） */
  let comicChapterPrefetching = false;

  /**
   * 预取下一章图片首批（v54 跨章衔接，fire-and-forget 幂等）。
   *
   * 滚动模式距底 <1.5 屏 / 翻页模式倒数 3 页时调用：主进程提前渲染下一章
   * 前 COMIC_INITIAL_RENDER_PAGES 页并落磁盘缓存（不回写 comicImages，不污染
   * 当前章数据）；随后正式 loadChapter(next) 的首批读取命中缓存，拼接/切章
   * 近乎即时。失败静默（正式加载路径会重试）。
   */
  async function prefetchNextChapterImages(): Promise<void> {
    if (!book.value || !renderAsImages.value) return;
    const nextIdx = comicChapterIndex.value + 1;
    if (nextIdx < 0 || nextIdx >= chapters.value.length) return;
    if (comicPrefetchedChapters.has(nextIdx) || comicChapterPrefetching) return;
    comicChapterPrefetching = true;
    try {
      await window.dbApi.chapter.readImages(book.value.id, nextIdx, COMIC_INITIAL_RENDER_PAGES);
      comicPrefetchedChapters.add(nextIdx);
    } catch (err) {
      console.warn('[reader] 预取下一章图片失败:', err);
    } finally {
      comicChapterPrefetching = false;
    }
  }

  /** 视口章同步豁免标志：置位期间 currentChapterIndex 变化视为滚动跨界（非用户切章） */
  let viewportChapterSync = false;

  /**
   * 滚动拼接模式视口章同步（v54）：ComicScrollMode 检测到视口跨过章边界时调用。
   * 更新 currentChapterIndex 使目录高亮/进度条/progressPercent 跟随视口章；
   * 置位豁免标志，Reader.vue 的 watch(currentChapterIndex) 消费
   * （consumeViewportChapterSync）后跳过"切章停 TTS/停自动滚动"副作用。
   */
  function setViewportChapterIndex(index: number): void {
    if (index < 0 || index >= chapters.value.length) return;
    if (index === currentChapterIndex.value) return;
    viewportChapterSync = true;
    currentChapterIndex.value = index;
  }

  /** 消费视口章同步豁免标志（true=本次章变化由滚动跨界引起，非用户切章） */
  function consumeViewportChapterSync(): boolean {
    const wasViewportSync = viewportChapterSync;
    viewportChapterSync = false;
    return wasViewportSync;
  }

  /** 切换漫画阅读模式 */
  function setComicMode(mode: 'scroll' | 'page'): void {
    comicMode.value = mode;
  }

  // ─── Actions：书籍/章节加载 ───

  async function loadBook(bookId: number): Promise<void> {
    // 清理上一本书的状态，避免残留内容闪现
    // P1-4：先清空 book.value，避免加载失败时残留上一本书的 book.value
    // 性能优化：取消旧书的 worker 任务 + 清理 worker 缓存，避免旧任务占用 CPU 和内存
    const oldBookId = book.value?.id;
    if (oldBookId && oldBookId !== bookId) {
      try {
        await window.dbApi.book.cancelReads(oldBookId);
        window.dbApi.book.clearWorkerCache(oldBookId);
      } catch {
        // 非致命：取消失败不阻断新书加载
      }
    }
    book.value = null;
    chapterContent.value = '';
    nextChapterContent.value = null;
    nextChapterPreloaded.value = false;
    currentChapterIndex.value = 0;
    // P0-1：重置漫画模式状态，避免上一本书的漫画状态残留到新书
    isComic.value = false;
    comicImages.value = [];
    comicImagesRevision.value = 0;
    // v53：作废在途续载 + 清空累积槽位（切书后旧请求不应合并到新书列表）
    ensureSeq++;
    pendingEnsureSlots.clear();
    // v54：清数据源章 + 预取缓存（新书从零开始）
    comicChapterIndex.value = 0;
    // P1-2：最后拼接章同步归零（新书无拼接）
    comicLastSplicedIndex.value = 0;
    comicPrefetchedChapters.clear();
    comicMode.value = 'scroll';
    // v38：重置渲染路由判定（PDF 图文书"真图文/扫描版"按新书首章重新判定）
    renderAsImages.value = false;
    pdfIllustratedDetermined = false;
    pdfIllustratedIsScanLike = false;
    abortPreload();

    loading.value = true;
    errorMsg.value = '';
    try {
      const [bookInfo, chapterList] = await Promise.all([
        window.dbApi.book.get(bookId),
        window.dbApi.chapter.listIndexes(bookId)
      ]);
      if (!bookInfo) {
        errorMsg.value = i18n.global.t('reader.errors.bookNotFound');
        return;
      }
      book.value = bookInfo as Book;
      // P0-3：根据 bookInfo.content_type 设置 isComic，兼容 is_comic 兜底
      // v21：优先用 content_type === 'comic' 判断
      isComic.value = (bookInfo as Book).content_type === 'comic' || (bookInfo as Book).is_comic === 1;
      chapters.value = chapterList as ChapterIndex[];
      try {
        await window.dbApi.book.touchRead(bookId);
      } catch {
        // 非致命
      }
      // 清除订阅更新徽章：用户已打开此书，不再显示红点
      if ((bookInfo as Book).has_update === 1) {
        try {
          await window.subscriptionApi.markBookUpdate(bookId, false);
          // 更新本地 book.value 使书架刷新后红点消失
          book.value = { ...book.value!, has_update: 0 };
        } catch {
          // 非致命
        }
      }
      readStartTime.value = Date.now();
      sessionStartTime = Date.now();

      sessionVisitedChapters = new Set<number>();
      sessionChapterLengths = new Map();
      sessionChapterProgress = new Map();
      // 监听页面可见性变化：隐藏时暂停阅读计时，恢复时重新开始
      setupVisibilityTracking();
      // 启动空闲检测：用户无操作时暂停会话计时，避免墙钟时间虚高
      setupIdleDetection();
    } catch (err) {
      errorMsg.value = i18n.global.t('reader.errors.loadBookFailed', { msg: (err as Error).message });
      console.error('[reader] loadBook 失败:', err);
    } finally {
      loading.value = false;
    }
  }

  /** loadChapter 请求序号，防止快速翻章时旧请求覆盖新请求 */
  let loadChapterSeq = 0;

  /**
   * 加载章节（图片型按 v53 分批渲染首批 + 文本整章）。
   *
   * @param index 目标章索引（0-based）
   * @param opts.append A-3修复：滚动拼接模式追加下一章时传 true —— 不更新
   *   currentChapterIndex（保持"视口章"语义：拼接加载返回时用户视口仍在旧章，
   *   若提前推进到新章，此窗口内保存进度会写成"新章+旧章位置"错位记录，
   *   等组件滚动跨界时由 setViewportChapterIndex 同步）；comicChapterIndex
   *   （数据源章）仍正常推进。同时保留实时滚动位置（视口未动）。
   * @param opts.prepend P1-2：滚动模式触顶拼接上一章时传 true —— 与 append
   *   同样不更新 currentChapterIndex / 不重置滚动位置（视口未动，组件侧按
   *   scrollHeight 差值补偿 scrollTop）；comicChapterIndex（数据源章）前移至
   *   该章，comicLastSplicedIndex（最后拼接章）保持不变（prepend 不改变
   *   拼接列表尾部的章）。
   */
  async function loadChapter(index: number, opts?: { append?: boolean; prepend?: boolean }): Promise<void> {
    if (!book.value) return;
    if (index < 0 || index >= chapters.value.length) return;
    const isAppend = opts?.append === true;
    const isPrepend = opts?.prepend === true;
    // 拼接语义（append/prepend）：视口未动，视口章与实时滚动位置均保留
    const isSplice = isAppend || isPrepend;

    const seq = ++loadChapterSeq;
    // P1-1：重置滚动位置，避免上一章节的位置残留影响新章节的进度计算
    // liveScrollPosition 重置为 null（未设置），lastScrollPosition 重置为 0
    // A-3：append 路径视口未动，保留现有位置（拼接期间进度条不闪跳 0）
    // P1-2：prepend 路径同理保留（视口未动）
    if (!isSplice) {
      lastScrollPosition.value = 0;
      liveScrollPosition.value = null;
    }
    loading.value = true;
    errorMsg.value = '';
    try {
      // v38 渲染路由：按"书的形态"而非单一 content_type 决定数据加载方式。
      //   漫画（content_type=comic，含 PDF/MOBI/EPUB/CBZ）→ 图片路径
      //   PDF 图文（illustrated）→ 图片+文本并行加载，随后按纯文本量动态判定渲染方式
      //   EPUB/MOBI 的 image 章节 → 图片路径
      //   其余（纯文本、EPUB/MOBI 图文书文字章节）→ 文字路径
      // 背景：0.2.2 曾把 illustrated 整体路由到 ComicViewer，误伤"真图文书"
      // （大量文字+插图，如带插图小说/图文技术书）——文字排版、字号、TTS、搜索全失效。
      const chapterContentType = chapters.value[index]?.content_type;
      const bookContentType = book.value?.content_type;
      const isPdfBook = book.value?.file_type === 'pdf';
      const isPdfComicBook = isPdfBook && bookContentType === 'comic';
      const isPdfIllustratedBook = isPdfBook && bookContentType === 'illustrated';
      const needLoadImages =
        isPdfComicBook ||
        isPdfIllustratedBook ||
        chapterContentType === 'image' ||
        (!isPdfBook && isComic.value && !chapterContentType);

      if (needLoadImages) {
        // P1-15修复：两步串行 IPC 改为 Promise.all 并行，减少总等待时间
        // v53：翻章作废在途续载（旧章响应迟到合并到新章列表会错章）
        ensureSeq++;
        pendingEnsureSlots.clear();
        // v53 分批渐进加载：首批只渲染前 5 个缺失页（磁盘已缓存页免费复用），
        // 其余页 pending 占位 —— 点击章节约 1~2s 内可交互，滚动/翻页时续载
        //
        // 【打开扫描版性能修复】尚未判定渲染方式的 PDF 图文书，当前章改用 textOnly
        // 读取：扫描版无需正文（走图片渲染），而完整读取会触发 enrichPdfChapterWithImages
        // 的 getImage() 全量图片提取——对扫描书极慢（实测 780 页扫描书单章 >150s），
        // 是"打开要很久/一次读取很多图片很卡"的直接根因。判定为非扫描版（真图文）后
        // 再补读一次完整内容以拿到 [IMG:] 插图标记。
        const tFirstScreen = Date.now();
        const needIllustratedProbe = isPdfIllustratedBook && !pdfIllustratedDetermined;
        let content: string;
        const [contentRaw, images] = await Promise.all([
          needIllustratedProbe
            ? window.dbApi.book.readChapter(book.value.id, index, { textOnly: true })
            : window.dbApi.book.readChapter(book.value.id, index),
          window.dbApi.chapter.readImages(book.value.id, index, COMIC_INITIAL_RENDER_PAGES)
        ]);
        content = contentRaw;
        profLog(
          `loadChapter 首批 IPC 完成 ch${index} 用时 ${Date.now() - tFirstScreen}ms（图片 ${images?.length ?? 0} 条，textOnly=${needIllustratedProbe}）`
        );
        if (seq !== loadChapterSeq) {
          console.warn('[reader] loadChapter: 图片章节加载被中断(seq失效), index:', index);
          // P0-3修复：seq 失效时重置 loading，避免 loading 卡死导致 nextChapter 重试逻辑误判
          loading.value = false;
          return;
        }
        // A-3：append 时不推进视口章（保持旧章，等滚动跨界同步）；
        // P1-2：prepend 同理（视口未动）
        if (!isSplice) currentChapterIndex.value = index;
        // v54：comicImages 数据源章跟随（滚动拼接模式续载/预取的章基准）
        comicChapterIndex.value = index;
        // P1-2：prepend 不改变拼接列表尾部（最后拼接章保持原章）；append/
        // 普通加载数据源章=列表尾章，comicLastSplicedIndex 跟随推进
        if (!isPrepend) comicLastSplicedIndex.value = index;

        // v42→v47：PDF 图文书渲染判定（书级一次判定：真图文 vs 扫描版）。
        // 采样策略：当前章 + 全书 30% 处起的 3 章正文章节。
        //
        // v47 决定性修正（逐页实测 2074《黑客攻防·iOS实战篇》发现）：
        // 该书是"混合质量文字层"——前30页乱码率 60~90%（OCR 差），但 p15-17/p80/p180
        // 等少数页乱码率 <20%（OCR 好）。v45 的"任一章正常字 ≥300 → 真图文"恰好
        // 采样到好页 → 整本误判真图文 → 大部分页显示乱码（用户"还是不行"的根因）。
        //
        // v47 方案：**累计**所有采样章的正常字符与乱码字符，用两个总量指标判定：
        //   ① 累计正常字符/页 ≥ 300（文字量足够）
        //   ② 累计乱码率 ≤ 25%（文字层可靠：混合质量的书乱码率被坏页拉高 → 扫描版）
        // 两条件同时满足才判真图文；任一不满足 → 扫描版（走图片渲染，不显示乱码）。
        // 少数好页不再能"一票通过"，多数坏页会正确拉高乱码率。
        if (isPdfIllustratedBook && !pdfIllustratedDetermined) {
          const tJudge = Date.now();
          // 字符分类：正常 = CJK(4E00-9FFF) + ASCII可打印(20-7E) + CJK标点(3000-303F) + 全角(FF00-FFEF)
          const classifyText = (s: string): { normal: number; total: number } => {
            const text = (s || '').replace(/\[IMG:[^\]]*\]/g, '').replace(/\s+/g, '');
            if (text.length === 0) return { normal: 0, total: 0 };
            const normal = text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u0020-\u007e]/g);
            return { normal: normal ? normal.length : 0, total: text.length };
          };
          // 从章节 url 推断该章覆盖的页数（无需 enrich，轻量）
          const estimatePages = (idx: number): number => {
            const url = chapters.value[idx]?.url ?? '';
            if (url.includes('-')) {
              const parts = url.split('-');
              const s = parseInt(parts[0], 10);
              const e = parseInt(parts[1], 10);
              if (!isNaN(s) && !isNaN(e) && e >= s) return e - s + 1;
            }
            return 1;
          };
          const probeIndexes = new Set<number>([index]);
          const start = Math.floor(chapters.value.length * 0.3);
          for (let i = 0; i < 3 && start + i < chapters.value.length; i++) {
            probeIndexes.add(start + i);
          }
          // v47：累计所有采样章的字符统计（不再"任一章通过"）
          let totalNormal = 0;
          let totalChars = 0;
          let totalPages = 0;
          {
            const c = classifyText(content);
            totalNormal += c.normal;
            totalChars += c.total;
            totalPages += estimatePages(index);
          }
          for (const probeIdx of probeIndexes) {
            if (probeIdx === index) continue;
            try {
              const probeContent = await window.dbApi.book.readChapter(book.value.id, probeIdx, {
                textOnly: true
              });
              if (seq !== loadChapterSeq) break;
              const c = classifyText(probeContent);
              totalNormal += c.normal;
              totalChars += c.total;
              totalPages += estimatePages(probeIdx);
            } catch {
              break;
            }
          }
          const avgNormalPerPage = totalNormal / Math.max(totalPages, 1);
          const garbledRatio = totalChars > 0 ? 1 - totalNormal / totalChars : 1;
          pdfIllustratedIsScanLike = !(
            avgNormalPerPage >= PDF_SCAN_NORMAL_CHARS_PER_PAGE && garbledRatio <= PDF_SCAN_GARBLED_RATIO_MAX
          );
          pdfIllustratedDetermined = true;
          console.log(
            `[reader] PDF 图文书渲染判定（采样 ${probeIndexes.size} 章 ${totalPages} 页：正常字 ${avgNormalPerPage.toFixed(0)}/页（阈值 ${PDF_SCAN_NORMAL_CHARS_PER_PAGE}），乱码率 ${(garbledRatio * 100).toFixed(0)}%（阈值 ${PDF_SCAN_GARBLED_RATIO_MAX * 100}%）):`,
            pdfIllustratedIsScanLike ? '扫描版 → 图片阅读器' : '真图文 → 文字图文混排'
          );
          profLog(
            `scanLike 判定 采样 ${probeIndexes.size} 章 ${totalPages} 页 用时 ${Date.now() - tJudge}ms → ${pdfIllustratedIsScanLike ? '扫描版' : '真图文'}`
          );
        }

        if (isPdfIllustratedBook && !pdfIllustratedIsScanLike) {
          // 真图文：文字渲染（[IMG:] 内嵌插图），字号/TTS/搜索等文字功能恢复可用。
          // 判定阶段用的是 textOnly（见上），真图文需补读完整内容才能拿到插图标记；
          // textOnly 不回写 DB 缓存，此处完整读取走正常解析路径取回 [IMG:] 插图。
          if (needIllustratedProbe) {
            content = await window.dbApi.book.readChapter(book.value.id, index);
            if (seq !== loadChapterSeq) {
              loading.value = false;
              return;
            }
          }
          chapterContent.value = content;
          comicImages.value = [];
          renderAsImages.value = false;
        } else {
          // 图片渲染：漫画 / PDF 扫描版 / EPUB·MOBI image 章节
          chapterContent.value = content ?? '';
          comicImages.value = images ?? [];
          renderAsImages.value = true;
        }
        console.log(
          '[reader] loadChapter: 图片分支完成, renderAsImages:',
          renderAsImages.value,
          'images count:',
          comicImages.value.length
        );
        profLog(
          `loadChapter 首屏数据就绪 ch${index} 总用时 ${Date.now() - tFirstScreen}ms（renderAsImages=${renderAsImages.value}）`
        );
      } else if (
        !isSplice &&  // A-3：append 恒为图片路径的追加（needLoadImages 已分流），防御性排除（P1-2：prepend 同理）
        index === currentChapterIndex.value + 1 &&
        nextChapterPreloaded.value &&
        nextChapterContent.value !== null
      ) {
        // 若目标章节正是已预加载的下一章，直接复用
        // P1-12修复：seq 失效时需清理预加载状态，避免残留的 nextChapterContent 被后续章节误用
        // P0-3修复：seq 失效时重置 loading，避免 loading 卡死
        if (seq !== loadChapterSeq) {
          loading.value = false;
          abortPreload();
          return;
        }
        currentChapterIndex.value = index;
        // v54：文字预加载复用分支同样对齐 comicImages 数据源章
        comicChapterIndex.value = index;
        comicLastSplicedIndex.value = index;
        chapterContent.value = nextChapterContent.value;
      } else {
        const content = await window.dbApi.book.readChapter(book.value.id, index);
        // P0-3修复：seq 失效时重置 loading，避免 loading 卡死
        if (seq !== loadChapterSeq) {
          loading.value = false;
          return;
        }
        // A-3：append 时不推进视口章（保持旧章，等滚动跨界同步）；
        // P1-2：prepend 同理（视口未动）
        if (!isSplice) currentChapterIndex.value = index;
        // v54：文字路径（comicImages 清空）同样对齐数据源章
        comicChapterIndex.value = index;
        comicLastSplicedIndex.value = index;
        chapterContent.value = content;
        // 文字路径：文字渲染（含 EPUB/MOBI 图文书的文字章节）
        renderAsImages.value = false;
        comicImages.value = [];
      }
      // 重置预加载状态
      abortPreload();
      nextChapterContent.value = null;
      nextChapterPreloaded.value = false;
      // 累加阅读会话统计（仅文字渲染章节计入字数：真图文/纯文本）
      // P1-3：仅在该章节首次被访问时记录，避免重复翻章导致重复累加
      const isFirstVisit = !sessionVisitedChapters.has(index);
      sessionVisitedChapters.add(index);
      if (isFirstVisit && !renderAsImages.value) {
        // 记录章节字数，退出时按滚动进度比例计算实际阅读字数
        // 避免打开一章即计整章字数（如星戒692万字/39秒的异常）
        sessionChapterLengths.set(index, chapterContent.value.length);
        sessionChapterProgress.set(index, 0);
      }
      // 异步预加载下一章（文字渲染章节：纯文本/真图文；纯图片章节无预加载）
      if (!renderAsImages.value) {
        void preloadNext().catch((e) => console.error('preloadNext 失败:', e));
      }
    } catch (err) {
      // P0-3修复：seq 失效时重置 loading，避免 loading 卡死
      if (seq !== loadChapterSeq) {
        loading.value = false;
        return;
      }
      // 忽略任务取消错误（切换书时取消旧书的章节读取）
      if (err instanceof Error && err.name === 'WorkerTaskCanceledError') return;
      // 批次 v54：link 书原文件失效 → 记录结构化信息由 Reader.vue 弹重新定位对话框，
      // 不显示普通加载失败文案（对话框内有原路径与恢复引导，信息更充分）
      const missing = parseFileMissingMessage((err as Error).message || '');
      if (missing && book.value && missing.bookId === book.value.id) {
        // P2修复：附带原始请求章索引——首次开书恢复进度时 loadChapter(进度章 N)
        // 失败，currentChapterIndex 仍是 0（成功路径才推进），恢复重试须用 N 而非
        // currentChapterIndex，否则回第 0 章丢失原进度
        fileMissing.value = { ...missing, attemptedChapterIndex: index };
        console.warn('[reader] link 书原文件失效:', missing.path, '请求章:', index);
        return;
      }
      errorMsg.value = i18n.global.t('reader.errors.loadChapterFailed', { msg: (err as Error).message });
      console.error('[reader] loadChapter 失败:', err);
    } finally {
      if (seq === loadChapterSeq) loading.value = false;
    }
  }

  /**
   * 清除 link 书失效信息（批次 v54）：RelocateDialog 恢复成功后调用，
   * 随后由 Reader.vue 自动重试打开当前章节（无感恢复闭环）。
   */
  function clearFileMissing(): void {
    fileMissing.value = null;
  }

  async function nextChapter(): Promise<void> {
    if (!hasNextChapter.value) {
      console.warn('[reader] nextChapter: 已是最后一章，无法继续');
      return;
    }
    const nextIdx = currentChapterIndex.value + 1;
    console.log(
      '[reader] nextChapter: 切换到第',
      nextIdx + 1,
      '章, content_type:',
      chapters.value[nextIdx]?.content_type
    );
    // P0-14 修复：多次重试应对 seq 竞争
    // 快速点击"下一章"多次时，loadChapterSeq 递增会使之前的加载在
    // `if (seq !== loadChapterSeq) return` 处被丢弃。原逻辑只重试一次，
    // 若重试也失败则按钮"无反应"。此处改为最多 3 次重试 + 短暂等待，
    // 并在每次重试前重新检查 hasNextChapter 避免越界。
    for (let attempt = 0; attempt < 3; attempt++) {
      // 重试前重新检查是否还有下一章，避免越界
      if (!hasNextChapter.value) {
        console.warn('[reader] nextChapter: 重试期间已到最后一章，终止');
        return;
      }
      await loadChapter(nextIdx);
      // 加载成功则直接返回
      if (currentChapterIndex.value === nextIdx) {
        return;
      }
      // 若当前正在加载中，等待一小段时间再继续重试
      if (loading.value) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      // seq 失效导致加载被丢弃，短暂等待后重试
      console.warn(`[reader] nextChapter: 第${attempt + 1}次重试（seq 失效）`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 所有重试均失败
    console.error('[reader] nextChapter: 3 次重试均失败，按钮可能无反应');
  }

  async function prevChapter(): Promise<void> {
    if (!hasPrevChapter.value) {
      console.warn('[reader] prevChapter: 已是第一章，无法继续');
      return;
    }
    const prevIdx = currentChapterIndex.value - 1;
    console.log(
      '[reader] prevChapter: 切换到第',
      prevIdx + 1,
      '章, content_type:',
      chapters.value[prevIdx]?.content_type
    );
    // P0-14 修复：与 nextChapter 保持一致的多次重试逻辑
    // 快速点击"上一章"多次时同样会触发 seq 竞争导致加载被丢弃。
    for (let attempt = 0; attempt < 3; attempt++) {
      // 重试前重新检查是否还有上一章，避免越界
      if (!hasPrevChapter.value) {
        console.warn('[reader] prevChapter: 重试期间已到第一章，终止');
        return;
      }
      await loadChapter(prevIdx);
      // 加载成功则直接返回
      if (currentChapterIndex.value === prevIdx) {
        return;
      }
      // 若当前正在加载中，等待一小段时间再继续重试
      if (loading.value) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      // seq 失效导致加载被丢弃，短暂等待后重试
      console.warn(`[reader] prevChapter: 第${attempt + 1}次重试（seq 失效）`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 所有重试均失败
    console.error('[reader] prevChapter: 3 次重试均失败，按钮可能无反应');
  }

  async function jumpToChapter(index: number): Promise<void> {
    // A-8修复：图片模式下同章点击不再早退——拼接态下点目录"当前视口章"用户
    // 期望"回到该章开头/清空拼接"（原直接 return 无反应）。仍调 loadChapter：
    // comicImages 引用变化触发组件 watch 重置分支（回章首）。误追加已由组件
    // A-5 章号校验防御（同章重载 comicChapterIndex ≠ 最后拼接章+1 → 走重置）。
    // 文字模式同章点击保持无操作（章节内容未变，重载无意义）
    if (index === currentChapterIndex.value && !renderAsImages.value) {
      showChapterBar.value = false;
      return;
    }
    // 切换前保存当前章节的进度（使用 lastScrollPosition，可能比实时位置稍旧但不会丢失）
    const position = liveScrollPosition.value ?? lastScrollPosition.value;
    if (position !== null && position >= 0) {
      await saveProgressImmediate(position);
    }
    await loadChapter(index);
    showChapterBar.value = false;
  }

  async function preloadNext(): Promise<void> {
    if (!book.value || !hasNextChapter.value) return;
    if (nextChapterPreloaded.value) return;
    // 每次预加载创建自己的取消标志对象
    const myFlag = { aborted: false };
    preloadAbortFlag = myFlag;
    try {
      const nextIdx = currentChapterIndex.value + 1;
      const content = await window.dbApi.book.readChapter(book.value.id, nextIdx);
      // 检查自己的标志，而非全局标志
      if (myFlag.aborted) return;
      // 确保当前预加载仍是活跃的（未被新的 preloadNext 替换）
      if (preloadAbortFlag !== myFlag) return;
      nextChapterContent.value = content;
      nextChapterPreloaded.value = true;
    } catch (err) {
      console.warn('[reader] 预加载下一章失败:', err);
    }
  }

  function abortPreload(): void {
    // 标记当前预加载为已取消
    if (preloadAbortFlag) {
      preloadAbortFlag.aborted = true;
    }
    preloadAbortFlag = null;
    nextChapterContent.value = null;
    nextChapterPreloaded.value = false;
  }

  // ─── Actions：阅读进度 ───

  /**
   * 立即保存阅读进度（清除 pending debounce，直接落库）。
   *
   * @param scrollPosition 章内归一化位置（0~1）
   * @param chapterOffset 章内偏移（根因④：图片型内容为视口章的章内页码 1-based；
   *   文字型内容保持 0——文字位置已由 scroll_position 的段落归一化坐标精确表达，
   *   不写非零值以维持旧数据"chapter_offset=0 → 归一化恢复"的兼容语义）
   */
  async function saveProgressImmediate(scrollPosition: number, chapterOffset = 0): Promise<void> {
    if (!book.value) return;
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    try {
      // P0-2：页面隐藏时 readStartTime=0，此时 Date.now()-0≈1.7万亿ms 会导致阅读时长暴增
      // 当 readStartTime=0 时不累加 delta，仅重置计时起点
      if (readStartTime.value === 0) {
        readStartTime.value = Date.now();
      } else {
        const delta = Date.now() - readStartTime.value;
        accumulatedReadTime.value += delta;
        readStartTime.value = Date.now();
      }
      await window.dbApi.progress.save({
        book_id: book.value.id,
        chapter_index: currentChapterIndex.value,
        chapter_offset: chapterOffset,
        scroll_position: scrollPosition,
        read_time: accumulatedReadTime.value
      });
      lastScrollPosition.value = scrollPosition;
      liveChapterOffset.value = chapterOffset;
      // 更新当前章节的滚动进度（用于 saveReadingSession 时按进度估算 chars_read）
      sessionChapterProgress.set(
        currentChapterIndex.value,
        Math.max(sessionChapterProgress.get(currentChapterIndex.value) ?? 0, scrollPosition)
      );
      // P1-9: 同步 book-detail store 的 progress（若详情页已加载同一本书）
      try {
        const detailStore = useBookDetailStore();
        if (detailStore.book?.id === book.value.id) {
          detailStore.progress = {
            book_id: book.value.id,
            chapter_index: currentChapterIndex.value,
            chapter_offset: chapterOffset,
            scroll_position: scrollPosition,
            read_time: accumulatedReadTime.value,
            updated_at: Date.now()
          };
        }
      } catch {
        /* Pinia 未初始化时忽略 */
      }
    } catch (err) {
      console.warn('[reader] 保存进度失败:', err);
    }
  }

  /**
   * debounce 保存阅读进度。
   *
   * @param scrollPosition 章内归一化位置；null 表示当前无有效位置
   *   （根因⑤：全文渐进拼接未完成时归一化分母失真），直接跳过不写错误值
   * @param chapterOffset 章内偏移（图片型=视口章页码，文字型=0）；
   *   调用方不传时按文字语义写 0（显式清零，防止跨模式残留）
   */
  function scheduleProgressSave(scrollPosition: number | null, chapterOffset = 0): void {
    if (scrollPosition === null) return;
    // 实时页码缓存与 debounce 落库独立维护：关闭兜底（flushProgressOnClose）
    // 在 debounce 窗口内也能取到最新页码
    liveChapterOffset.value = chapterOffset;
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      void saveProgressImmediate(scrollPosition, chapterOffset).catch((e) =>
        console.error('saveProgressImmediate 失败:', e)
      );
    }, PROGRESS_DEBOUNCE_MS);
  }

  /**
   * 窗口关闭前的进度兜底保存（根因②：点 X 退出时 debounce 未落库的位置丢失）。
   *
   * 由 App.vue 的 onBeforeCloseFlush 通知触发，不依赖视图组件 ref
   * （窗口关闭时子组件可能已不可靠），使用 store 缓存的实时值：
   * liveScrollPosition 滚动/翻页时实时更新，丢失窗口 ≤ 一屏，可接受。
   * 无书/无有效位置时幂等跳过。链路总耗时必须 < 800ms（主进程超时强杀）。
   */
  async function flushProgressOnClose(): Promise<void> {
    if (!book.value) return;
    const position = liveScrollPosition.value;
    if (position !== null) {
      // 任务25：chapter_offset 双模式语义——图片模式=视口章页码，
      // 文本模式=章内字符偏移（内容锚点，免疫排版变化）
      const offset = renderAsImages.value ? liveChapterOffset.value : liveChapterCharOffset.value;
      await saveProgressImmediate(position, offset);
    }
    // 阅读会话统计快速路径：关闭即会话结束，把最后一段活跃时间落库
    //（短会话 <1s 由 saveReadingSession 内部过滤，重复调用幂等——sessionStartTime 置 0）
    await saveReadingSession();
  }

  /**
   * 读取阅读进度。
   * chapterOffset（根因④）：图片型内容为退出时的章内页码（1-based），
   * 恢复链优先用它精确定位（首批渲染页数 ≠ 全章页数时归一换算会漂移）；
   * 文字型/旧数据为 0，走 scroll_position 归一化恢复（向后兼容）。
   */
  async function loadProgress(): Promise<{
    chapterIndex: number;
    scrollPosition: number;
    chapterOffset: number;
  } | null> {
    if (!book.value) return null;
    try {
      const p = await window.dbApi.progress.load(book.value.id);
      if (!p) return null;
      accumulatedReadTime.value = p.read_time ?? 0;
      readStartTime.value = Date.now();
      return {
        chapterIndex: p.chapter_index,
        scrollPosition: p.scroll_position ?? 0,
        chapterOffset: p.chapter_offset ?? 0
      };
    } catch (err) {
      console.warn('[reader] 读取进度失败:', err);
      return null;
    }
  }

  async function cleanup(): Promise<void> {
    // 清理 debounce 定时器（进度保存由 Reader.vue 在调用 cleanup 前通过 flushCurrentProgress 完成）
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    // 清理 visibility 监听器，避免泄漏
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = null;
    }
    // 先保存阅读会话（需要 lastActiveStart 还未被清理，以累加最后的活跃时间段）
    // 必须在 cleanupIdleDetection() 之前调用，否则 lastActiveStart 被重置为 0，
    // 导致持续阅读（未进入空闲）的会话 duration=0 而被丢弃
    await saveReadingSession();
    // 清理空闲检测监听器和定时器
    cleanupIdleDetection();
  }


  async function saveReadingSession(): Promise<void> {
    if (!book.value || sessionStartTime === 0) return;
    const endTime = Date.now();
    // 累加最后的活跃段（如果当前正处于活跃状态）
    if (lastActiveStart > 0) {
      sessionActiveTime += Date.now() - lastActiveStart;
      lastActiveStart = 0;
    }
    // 用活跃阅读时间替代纯墙钟时间，扣除用户离开屏幕但页面仍可见的空闲段
    const duration = sessionActiveTime;
    if (duration < 1000) return;
    try {
      await window.dbApi.readingSession.create({
        book_id: book.value.id,
        start_time: sessionStartTime,
        end_time: endTime,
        duration,
        chapters_read: sessionVisitedChapters.size,
        // 按滚动进度估算实际阅读字数：Σ(章节字数 × 该章节最大滚动进度)
        // 避免打开一章即计整章字数（如星戒692万字），只按用户实际滚动过的比例计入
        chars_read: (() => {
          let total = 0;
          for (const [chIdx, chLen] of sessionChapterLengths) {
            const progress = sessionChapterProgress.get(chIdx) ?? 0;
            total += Math.round(chLen * progress);
          }
          return total;
        })()
      });
      // 重置标志，防止 cleanup 重复调用时保存重复会话
      sessionStartTime = 0;
    } catch (err) {
      console.warn('[reader] 保存阅读会话失败:', err);
    }
  }

  // ─── Actions：UI ───

  /** 设置页面可见性追踪：隐藏时暂停阅读计时，恢复时重新开始 */
  function setupVisibilityTracking(): void {
    // 先清理旧的监听器（如重复调用 loadBook）
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler);
    }
    visibilityHandler = () => {
      if (document.hidden) {
        // 页面隐藏：累加已读时间，暂停计时
        if (readStartTime.value > 0) {
          accumulatedReadTime.value += Date.now() - readStartTime.value;
          readStartTime.value = 0;
        }
        // 同步暂停空闲检测的活跃段（页面隐藏期间不计入活跃时间）
        if (lastActiveStart > 0) {
          sessionActiveTime += Date.now() - lastActiveStart;
          lastActiveStart = 0;
        }
      } else {
        // 页面恢复：重新开始计时
        readStartTime.value = Date.now();
        // 恢复时若用户最近有交互则重新开启活跃段，否则等下次交互再开
        if (Date.now() - lastActivityTime < IDLE_THRESHOLD_MS) {
          lastActiveStart = Date.now();
        }
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }

  /**
   * 设置空闲检测：监听用户交互事件，长时间无操作时暂停会话计时。
   *
   * 工作原理：
   * - 监听 mousemove/keydown/click/wheel/scroll 事件，更新 lastActivityTime
   * - 每 IDLE_CHECK_INTERVAL_MS 检查一次：若距上次交互超过 IDLE_THRESHOLD_MS 则进入空闲
   * - 活跃时 lastActiveStart > 0，sessionActiveTime 在段结束时累加
   * - 空闲时 lastActiveStart = 0，不累加时间
   *
   * 与 setupVisibilityTracking 互补：
   * - visibilitychange 覆盖"切走标签页"场景
   * - 空闲检测覆盖"标签页可见但用户不在屏幕前"场景
   */
  function setupIdleDetection(): void {
    // 先清理旧的监听器（如重复调用 loadBook）
    cleanupIdleDetection();

    const now = Date.now();
    lastActivityTime = now;
    lastActiveStart = now;
    sessionActiveTime = 0;

    // 用户交互事件：更新 lastActivityTime
    const updateActivity = (): void => {
      const t = Date.now();
      lastActivityTime = t;
      // 如果当前处于空闲状态（lastActiveStart === 0），重新开启活跃段
      if (lastActiveStart === 0 && !document.hidden) {
        lastActiveStart = t;
        // 同步恢复 accumulatedReadTime 计时（与 visibilityTracking 保持一致）
        if (readStartTime.value === 0) {
          readStartTime.value = t;
        }
      }
    };

    // 注册监听器（passive 尽可能降低开销）
    // 所有 handler 仅更新 lastActivityTime，不调用 preventDefault，因此全部使用 passive: true。
    // keydown 虽然默认非 passive，但此处仅用于空闲检测无需阻止默认行为，设为 passive: true
    // 可避免浏览器为生成 preventDefault 上下文而增加的开销。
    const events: { name: keyof DocumentEventMap; passive: boolean }[] = [
      { name: 'mousemove', passive: true },
      { name: 'keydown', passive: true },
      { name: 'click', passive: true },
      { name: 'wheel', passive: true },
      { name: 'scroll', passive: true }
    ];
    activityHandlers = events.map(({ name, passive }) => {
      const handler = updateActivity;
      document.addEventListener(name, handler, { passive });
      return { name: name as string, handler };
    });

    // 定期检查空闲状态
    idleCheckTimer = setInterval(() => {
      // 页面隐藏时不处理（由 visibilityHandler 负责）
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastActivityTime > IDLE_THRESHOLD_MS) {
        // 进入空闲：累加当前活跃段并暂停
        if (lastActiveStart > 0) {
          sessionActiveTime += now - lastActiveStart;
          lastActiveStart = 0;
          // 同步暂停 accumulatedReadTime 计时（与 visibilityTracking 保持一致）
          if (readStartTime.value > 0) {
            accumulatedReadTime.value += now - readStartTime.value;
            readStartTime.value = 0;
          }
        }
      } else {
        // 活跃中：如果之前空闲了，重新开始计时
        if (lastActiveStart === 0) {
          lastActiveStart = now;
        }
      }
    }, IDLE_CHECK_INTERVAL_MS);
  }

  /** 清理空闲检测资源：移除事件监听器和定时器 */
  function cleanupIdleDetection(): void {
    if (idleCheckTimer) {
      clearInterval(idleCheckTimer);
      idleCheckTimer = null;
    }
    for (const { name, handler } of activityHandlers) {
      document.removeEventListener(name, handler);
    }
    activityHandlers = [];
    lastActiveStart = 0;
  }

  function toggleChapterBar(): void {
    showChapterBar.value = !showChapterBar.value;
  }

  function toggleToolbar(): void {
    showToolbar.value = !showToolbar.value;
  }

  function setShowToolbar(value: boolean): void {
    showToolbar.value = value;
  }

  /** 切换全屏/沉浸阅读模式（同时调用 Electron BrowserWindow.setFullScreen） */
  async function toggleFullscreen(): Promise<void> {
    try {
      if (window.windowApi?.toggleFullscreen) {
        const fs = await window.windowApi.toggleFullscreen();
        isFullscreen.value = fs;
      } else {
        isFullscreen.value = !isFullscreen.value;
      }
    } catch {
      isFullscreen.value = !isFullscreen.value;
    }
  }

  /** 设置全屏/沉浸阅读模式状态 */
  function setFullscreen(value: boolean): void {
    isFullscreen.value = value;
  }

  function setCurrentChapterIndex(index: number): void {
    currentChapterIndex.value = index;
  }

  /** 更新实时滚动位置（由视图组件在滚动时调用，不受 debounce 影响） */
  function setLiveScrollPosition(position: number): void {
    liveScrollPosition.value = position;
  }

  /** 更新实时章内字符偏移（任务25：文本模式内容锚点，由 ScrollView 滚动时维护） */
  function setLiveChapterCharOffset(offset: number): void {
    liveChapterCharOffset.value = offset;
  }

  function reset(): void {
    abortPreload();
    // 性能优化：退出阅读器时取消当前书的 worker 任务 + 清理 worker 缓存
    // 避免子线程在后台继续运行占用 CPU 和内存
    const currentBookId = book.value?.id;
    if (currentBookId) {
      try {
        window.dbApi.book.cancelReads(currentBookId);
        window.dbApi.book.clearWorkerCache(currentBookId);
      } catch {
        // 非致命：清理失败不影响退出
      }
    }
    loadChapterSeq = 0;

    // 清理进度保存定时器
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    // 清理页面可见性监听器
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = null;
    }
    // 清理空闲检测监听器和定时器
    cleanupIdleDetection();
    book.value = null;
    chapters.value = [];
    currentChapterIndex.value = 0;
    chapterContent.value = '';
    nextChapterContent.value = null;
    nextChapterPreloaded.value = false;
    loading.value = false;
    errorMsg.value = '';
    showChapterBar.value = false;
    showToolbar.value = false;
    isFullscreen.value = false;
    accumulatedReadTime.value = 0;
    readStartTime.value = Date.now();
    lastScrollPosition.value = 0;
    liveScrollPosition.value = null;
    // 根因④：实时章内偏移同步清零（防下一本书残留上一本的页码）
    liveChapterOffset.value = 0;
    // 任务25：文本模式内容锚点同步清零
    liveChapterCharOffset.value = 0;
    // 重置漫画模式状态
    isComic.value = false;
    comicImages.value = [];
    comicMode.value = 'scroll';
    // v54：清数据源章 + 预取缓存 + 豁免标志
    comicChapterIndex.value = 0;
    // P1-2：最后拼接章同步归零
    comicLastSplicedIndex.value = 0;
    comicPrefetchedChapters.clear();
    viewportChapterSync = false;
    // A-4：清跨章续载通道与待续载请求（切书后旧请求不应合并到新书列表）
    comicChapterImageUpdates.value = new Map();
    pendingEnsureSlots.clear();
    sessionStartTime = 0;

    sessionVisitedChapters = new Set<number>();
    sessionChapterLengths = new Map();
    sessionChapterProgress = new Map();
    // 重置空闲检测状态
    lastActivityTime = 0;
    sessionActiveTime = 0;
    lastActiveStart = 0;
  }

  return {
    // state
    book,
    chapters,
    currentChapterIndex,
    chapterContent,
    loading,
    errorMsg,
    // link 书失效信息（批次 v54 导入三模式）
    fileMissing,
    readMode,
    isComic,
    comicImages,
    comicImagesRevision,
    comicMode,
    renderAsImages,
    fontSize,
    lineHeight,
    pageWidth,
    fontFamilyCss,
    margin,
    paragraphSpacing,

    autoScrollSpeed,
    ttsRate,
    showChapterBar,
    showToolbar,
    isFullscreen,
    // 阅读进度（暴露供 Reader.vue fallback 使用）
    liveScrollPosition,
    lastScrollPosition,
    // 根因④：实时章内偏移（图片型=视口章页码，供关闭兜底取最新页码）
    liveChapterOffset,
    // 任务25：实时章内字符偏移（文本型=内容锚点，恢复/排版变化定位用）
    liveChapterCharOffset,
    // getters
    currentChapterTitle,
    totalChapters,
    hasPrevChapter,
    hasNextChapter,
    progressPercent,
    // actions
    loadPreferences,
    setReadMode,
    increaseFontSize,
    decreaseFontSize,
    loadBook,
    loadChapter,
    clearFileMissing,
    nextChapter,
    prevChapter,
    jumpToChapter,
    loadComicImages,
    ensureImages,
    // v54 跨章无限滚动
    comicChapterIndex,
    // P1-2 触顶拼接：最后拼接章（append 后 prepend 数据源章前移，下章请求以此为准）
    comicLastSplicedIndex,
    prefetchNextChapterImages,
    setViewportChapterIndex,
    consumeViewportChapterSync,
    setComicMode,
    // A-4 跨章续载：旧章更新通道 + 消费接口（ComicScrollMode 拼接同步用）
    comicChapterImageUpdates,
    consumeComicChapterImageUpdates,
    saveProgressImmediate,
    scheduleProgressSave,
    loadProgress,
    // 根因②：窗口关闭前的进度兜底保存（App.vue 的 onBeforeCloseFlush 触发）
    flushProgressOnClose,

    cleanup,
    toggleChapterBar,
    toggleToolbar,
    setShowToolbar,
    toggleFullscreen,
    setFullscreen,
    setCurrentChapterIndex,
    setLiveScrollPosition,
    // 任务25：文本模式内容锚点实时更新（ScrollView 滚动时调用）
    setLiveChapterCharOffset,

    reset
  };
});
