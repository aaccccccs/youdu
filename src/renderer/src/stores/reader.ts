import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  Book,
  ChapterIndex,
  Bookmark,
  ReadMode,
  AddBookmarkInput,
  UpdateBookmarkInput,
  Highlight,
  AddHighlightInput,
  UpdateHighlightInput
} from '@renderer/types';
import type { ThemeType } from '../../../shared';
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
// P2-7: 高亮颜色统一从 shared/highlight-colors.ts 导入，避免与共享定义重复

// Re-export 类型以兼容现有从 stores/reader 导入的代码
export type {
  ChapterIndex,
  ReadMode,
  Bookmark,
  AddBookmarkInput,
  UpdateBookmarkInput,
  Highlight,
  AddHighlightInput,
  UpdateHighlightInput
};

export type ReaderTheme = ThemeType;

const READ_MODE_KEY = 'reader.readMode';
const DEFAULT_READ_MODE: ReadMode = 'chapter';
const PROGRESS_DEBOUNCE_MS = 2000;

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

  // ─── State：阅读模式 ───
  const readMode = ref<ReadMode>(DEFAULT_READ_MODE);

  // ─── State：漫画模式 ───
  /** 当前书籍是否为漫画 */
  const isComic = ref<boolean>(false);
  /** 当前章节的图片路径列表（漫画模式） */
  const comicImages = ref<string[]>([]);
  /** 漫画阅读模式：'scroll'=垂直滚动，'page'=翻页 */
  const comicMode = ref<'scroll' | 'page'>('scroll');

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
  /** 全屏/沉浸阅读模式（对标 Kindle/Apple Books 全屏阅读体验） */
  const isFullscreen = ref<boolean>(false);

  // ─── State：阅读进度 ───
  const readStartTime = ref<number>(Date.now());
  const accumulatedReadTime = ref<number>(0);
  const lastScrollPosition = ref<number>(0);
  /** 实时滚动位置（由视图组件实时更新，不受 debounce 影响，用于进度条显示）
   *  类型为 number | null：null 表示"未设置/未滚动"，0 表示"滚动到章节开头"（合法值）。
   *  这样 progressPercent 可用 ?? 正确 fallback，避免 0 被当 falsy 误判。
   */
  const liveScrollPosition = ref<number | null>(null);

  /** 窗口关闭标志：flushProgressForClose 设为 true 后，onBeforeUnmount 中的进度保存跳过
   *  防止组件卸载时 getCurrentChapterProgress() 返回错误值覆盖已保存的正确进度 */
  const isClosing = ref<boolean>(false);

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
    comicMode.value = 'scroll';
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

  async function loadChapter(index: number): Promise<void> {
    if (!book.value) return;
    if (index < 0 || index >= chapters.value.length) return;

    const seq = ++loadChapterSeq;
    // P1-1：重置滚动位置，避免上一章节的位置残留影响新章节的进度计算
    // liveScrollPosition 重置为 null（未设置），lastScrollPosition 重置为 0
    lastScrollPosition.value = 0;
    liveScrollPosition.value = null;
    loading.value = true;
    errorMsg.value = '';
    try {
      // 统一阅读器：PDF书都走文字路径（readPdfChapter生成[IMG:标记）
      // 只有cbz等纯漫画格式（file_type='comic'）才走图片路径
      const chapterContentType = chapters.value[index]?.content_type;
      const isPdfBook = book.value?.file_type === 'pdf';
      // 修复：图文书籍(content_type='illustrated')的图片章节也需要加载图片
      // 原逻辑：chapterContentType === 'image' || (isComic.value && !chapterContentType)
      // 新增：book.content_type === 'illustrated' 且 chapterContentType === 'image' 时也加载图片（原逻辑已覆盖）
      // 确保 isComic 为 true 但 chapterContentType 为 'text' 时不误判为图片章节
      const needLoadImages = !isPdfBook && (chapterContentType === 'image' || (isComic.value && !chapterContentType));

      if (needLoadImages) {
        // 修复：图文/漫画章节加载，添加详细日志帮助排查"下一章没反应"问题
        console.log(
          '[reader] loadChapter: 加载图片章节, index:',
          index,
          'isComic:',
          isComic.value,
          'contentType:',
          chapterContentType
        );
        // P1-15修复：两步串行 IPC 改为 Promise.all 并行，减少总等待时间
        // 原实现先 await readChapter 再 await readImages，两步串行；
        // 并行化后只需等待较慢的一个，提升图片章节加载速度。
        const [content, images] = await Promise.all([
          window.dbApi.book.readChapter(book.value.id, index),
          window.dbApi.chapter.readImages(book.value.id, index)
        ]);
        if (seq !== loadChapterSeq) {
          console.warn('[reader] loadChapter: 图片章节加载被中断(seq失效), index:', index);
          // P0-3修复：seq 失效时重置 loading，避免 loading 卡死导致 nextChapter 重试逻辑误判
          loading.value = false;
          return;
        }
        currentChapterIndex.value = index;
        chapterContent.value = content;
        comicImages.value = images ?? [];
        console.log('[reader] loadChapter: 图片章节加载完成, images count:', (images ?? []).length);
      } else if (
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
        chapterContent.value = nextChapterContent.value;
      } else {
        const content = await window.dbApi.book.readChapter(book.value.id, index);
        // P0-3修复：seq 失效时重置 loading，避免 loading 卡死
        if (seq !== loadChapterSeq) {
          loading.value = false;
          return;
        }
        currentChapterIndex.value = index;
        chapterContent.value = content;
      }
      // 重置预加载状态
      abortPreload();
      nextChapterContent.value = null;
      nextChapterPreloaded.value = false;
      // 累加阅读会话统计（仅文字章节计入字数）
      // P1-3：仅在该章节首次被访问时记录，避免重复翻章导致重复累加
      const isFirstVisit = !sessionVisitedChapters.has(index);
      sessionVisitedChapters.add(index);
      if (isFirstVisit && !needLoadImages) {
        // 记录章节字数，退出时按滚动进度比例计算实际阅读字数
        // 避免打开一章即计整章字数（如星戒692万字/39秒的异常）
        sessionChapterLengths.set(index, chapterContent.value.length);
        sessionChapterProgress.set(index, 0);
      }
      // 异步预加载下一章（仅文字章节，图片章节无预加载）
      if (!needLoadImages) {
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
      errorMsg.value = i18n.global.t('reader.errors.loadChapterFailed', { msg: (err as Error).message });
      console.error('[reader] loadChapter 失败:', err);
    } finally {
      if (seq === loadChapterSeq) loading.value = false;
    }
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
    if (index === currentChapterIndex.value) {
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

  async function saveProgressImmediate(scrollPosition: number): Promise<void> {
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
        chapter_offset: 0,
        scroll_position: scrollPosition,
        read_time: accumulatedReadTime.value
      });
      lastScrollPosition.value = scrollPosition;
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
            chapter_offset: 0,
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

  function scheduleProgressSave(scrollPosition: number): void {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      void saveProgressImmediate(scrollPosition).catch((e) => console.error('saveProgressImmediate 失败:', e));
    }, PROGRESS_DEBOUNCE_MS);
  }

  async function loadProgress(): Promise<{ chapterIndex: number; scrollPosition: number } | null> {
    if (!book.value) return null;
    try {
      const p = await window.dbApi.progress.load(book.value.id);
      if (!p) return null;
      accumulatedReadTime.value = p.read_time ?? 0;
      readStartTime.value = Date.now();
      return {
        chapterIndex: p.chapter_index,
        scrollPosition: p.scroll_position ?? 0
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

  /**
   * 窗口关闭时 flush 进度：不依赖子组件 ref（此时子组件可能已卸载），
   * 使用 store 中缓存的实时位置。由 App.vue onCloseRequested 调用。
   */
  async function flushProgressForClose(): Promise<void> {
    if (!book.value) return;
    isClosing.value = true;
    const position = liveScrollPosition.value ?? lastScrollPosition.value;
    await saveProgressImmediate(position);
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
    isClosing.value = false;
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
    // 重置漫画模式状态
    isComic.value = false;
    comicImages.value = [];
    comicMode.value = 'scroll';
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
    readMode,
    isComic,
    comicImages,
    comicMode,
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
    nextChapter,
    prevChapter,
    jumpToChapter,
    loadComicImages,
    setComicMode,
    saveProgressImmediate,
    scheduleProgressSave,
    loadProgress,
    flushProgressForClose,
    cleanup,
    toggleChapterBar,
    toggleToolbar,
    setShowToolbar,
    toggleFullscreen,
    setFullscreen,
    setCurrentChapterIndex,
    setLiveScrollPosition,
    isClosing,
    reset
  };
});
