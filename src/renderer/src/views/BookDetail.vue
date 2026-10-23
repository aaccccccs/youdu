<!--
  书籍详情页（M9 完整实现 + UI 改进 + 布局重构）

  布局结构：
  .detail-view (height:100%, overflow-y:auto) ← 整页可滚动（详情页无固定工具栏）
    └── .detail-container (max-width:800px, margin:0 auto)
        ├── 头部卡片（封面 + 基本信息 + 简介 + 信息栏 + 主操作按钮区）
        ├── 章节预览
        ├── 阅读统计
        └── 相关推荐

  功能：
  - 头部卡片：大封面（180x240）、书名/作者（可编辑）、文件类型标签
              + 统一编辑按钮 + 简介 + 信息栏（章节数/进度/书签/阅读时长）
              + 主操作按钮（开始阅读/下载章节/更多菜单）
  - 章节预览：显示前 5 章 + "查看全部" 按钮
  - 阅读统计：进度条 + 累计阅读时长 + 上次阅读位置 + 书签数 + 笔记数
  - "更多"下拉菜单：换源/搜索在线源、刷新目录、重新分章、导出(TXT/EPUB/CBZ)、删除

  设计原则：
  - 容器固定跟随窗口：height:100% 固定高度，整页可滚动
  - 统一 CSS 变量：所有颜色/间距/圆角通过 CSS 变量引用，零硬编码
  - camelCase 命名：所有变量/函数使用 camelCase
  - TypeScript 严格类型：所有函数参数和返回值必须有明确类型
-->
<script setup lang="ts">
import { ref, computed, reactive, watch, h, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  NCard,
  NButton,
  NIcon,
  NTag,
  NInput,
  NProgress,
  NSpin,
  NDropdown,
  NCheckbox,
  NAlert,
  type DropdownOption,
  useMessage,
  useDialog
} from 'naive-ui';
import {
  ArrowLeft,
  Book as BookIcon,
  Edit,
  Check,
  X,
  Trash,
  RefreshCw,
  Bookmark,
  Notebook,
  Clock,
  Hash,
  Calendar,
  History,
  ChevronDown,
  ChevronUp,
  ScrollText,
  Play,
  FileSearch,
  FolderSearch,
  HardDrive,
  Image,
  Percent,
  TrendingUp,
  Gauge,
  FileText,
  FileOutput,
  Star,
  StarOff,
  BookOpen,
  BookCheck,
  BookHeart,
  BookX,
  MoreHorizontal
} from '@lucide/vue';
import {
  useBookDetailStore,
  useBookshelfStore,
  type RelatedBook,
  TREND_DAYS,
  availableExportFormats,
  isImageBookGuard
} from '@renderer/stores';
import type { ReadingStatus } from '@renderer/types';

import { generateCoverDataUrl, coverPathToUrl } from '@renderer/utils';
import { formatRelativeTime, formatDateTime, formatDuration } from '@renderer/utils';
import { useDropdownIcon, useCover } from '@renderer/composables';
import DOMPurify from 'dompurify';

/* ==================== 主题与消息 API ==================== */

const message = useMessage();
const dialog = useDialog();
const { t } = useI18n();

/* ==================== 路由与 Store ==================== */

const route = useRoute();
const router = useRouter();
const store = useBookDetailStore();
/** 书架 store（P2 导入三模式：link 失效角标状态联动 + relocate 成功清标记） */
const bookshelfStore = useBookshelfStore();

/* ==================== 书籍 ID ==================== */

/** 从路由参数获取书籍 ID */
const bookId = computed<number>(() => {
  const id = Number(route.params.bookId);
  return Number.isNaN(id) ? 0 : id;
});

/* ==================== 封面 ==================== */

/**
 * 封面 URL（含加载失败回退）+ 加载失败状态 + 错误处理
 *
 * 复用 useCover composable，统一封装封面 URL 生成与 @error 回退逻辑。
 * store.book 为 null（加载中）时传入 { title: '未知' } 作为占位，
 * 与原实现行为一致。
 */
const { coverUrl, onCoverError } = useCover(() => store.book ?? { title: t('common.words.unknown') });

/* ==================== 编辑模式（书名/作者/简介） ==================== */

/** 是否处于编辑模式 */
const editing = ref<boolean>(false);
/** 编辑表单（书名/作者/简介） */
const editForm = reactive({
  title: '',
  author: '',
  intro: ''
});

/** 进入编辑模式 */
function startEdit(): void {
  if (!store.book) return;
  editForm.title = store.book.title;
  editForm.author = store.book.author ?? '';
  editForm.intro = store.book.intro ?? '';
  editing.value = true;
}

/** 取消编辑 */
function cancelEdit(): void {
  editing.value = false;
}

/** 保存编辑 */
async function saveEdit(): Promise<void> {
  if (!store.book) return;
  const title = editForm.title.trim();
  if (!title) {
    message.warning(t('bookDetail.validation.titleRequired'));
    return;
  }
  try {
    await store.updateBookMeta(store.book.id, {
      title,
      author: editForm.author.trim() || null,
      intro: editForm.intro.trim() || null
    });
    editing.value = false;
    message.success(t('common.actions.saved'));
  } catch {
    message.error(t('bookDetail.messages.saveFailed'));
  }
}

/* ==================== 封面上传 ==================== */

/** 封面上传中状态 */
const coverUploading = ref<boolean>(false);

/** 更换封面：选择图片文件 → 复制到 data/covers/ → 更新 book.cover */
async function changeCover(): Promise<void> {
  if (!store.book) return;
  coverUploading.value = true;
  try {
    const imagePath = await window.importApi.selectImage();
    if (!imagePath) {
      coverUploading.value = false;
      return;
    }

    const result = await store.setCover(store.book.id, imagePath);

    if (result.success) {
      message.success(t('bookDetail.cover.updated'));
    } else {
      message.error(t('bookDetail.cover.changeFailed', { msg: result.error ?? t('bookDetail.errors.unknownError') }));
    }
  } catch (err) {
    message.error(t('bookDetail.cover.changeFailed', { msg: (err as Error).message }));
  } finally {
    coverUploading.value = false;
  }
}

/* ==================== 恢复默认封面 ==================== */

/** 恢复默认封面：清除自定义封面，回到自动生成的 SVG 默认封面 */
async function resetCover(): Promise<void> {
  if (!store.book) return;
  try {
    const result = await store.resetCover(store.book.id);
    if (result.success) {
      message.success(t('bookDetail.cover.resetDone'));
    } else {
      message.error(t('bookDetail.cover.resetFailed', { msg: result.error ?? t('bookDetail.errors.unknownError') }));
    }
  } catch (err) {
    message.error(t('bookDetail.cover.resetFailed', { msg: (err as Error).message }));
  }
}

/* ==================== 简介展开/收起 ==================== */

/** 简介是否已展开 */
const introExpanded = ref<boolean>(false);
/** 简介最多显示行数 */
const INTRO_MAX_LINES = 4;
/** 简介文本元素引用（用于 DOM 测量实际行数） */
const introTextRef = ref<HTMLElement | null>(null);

/** 简介是否有多行（通过 DOM 测量实际行数，而非估算） */
const introOverflow = ref<boolean>(false);

/** 在 DOM 渲染后测量简介是否溢出（比字符估算更准确） */
function measureIntroOverflow(): void {
  if (!introTextRef.value) return;
  // 创建临时全高度元素测量实际行数
  const el = introTextRef.value;
  const fullHeight = el.scrollHeight;
  // 4 行的行高约 = lineHeight(1.8) * fontSize(16px) * 4 = 115.2px
  // 如果 scrollHeight > 4 行高度，说明溢出
  const lineHeightPx = parseFloat(getComputedStyle(el).lineHeight) || 28.8;
  const maxLinesHeight = lineHeightPx * INTRO_MAX_LINES;
  introOverflow.value = fullHeight > maxLinesHeight + 2; // 2px 容差
}

/** 切换简介展开/收起 */
function toggleIntro(): void {
  introExpanded.value = !introExpanded.value;
}

/**
 * 格式化简介内容，供 v-html 渲染：
 * - 检测转义的 HTML 实体（&lt; &gt; &amp; 等），若存在则解码为原始 HTML 再交由 v-html 渲染
 * - 若已是原始 HTML 或纯文本，直接使用
 * - 空值兜底"暂无简介"
 *
 * 背景：MOBI/PDF 的描述可能包含转义的 HTML 实体（如 &lt;div&gt;&lt;p&gt;text&lt;/p&gt;&lt;/div&gt;），
 * 直接用 v-html 会把实体解码为文本字符 <div><p>text</p></div> 并显示为纯文本，
 * 而非渲染为 HTML 元素。这里先解码实体，使 v-html 能正确渲染。
 */
const formattedIntro = computed<string>(() => {
  const raw = store.book?.intro ?? '';
  if (!raw) return t('bookDetail.noIntro');
  // 检测是否包含转义的 HTML 实体（命名实体或数字实体）
  const hasEscapedEntities = /&(lt|gt|amp|quot|apos|#\d+);/i.test(raw);
  let html: string;
  if (!hasEscapedEntities) {
    html = raw;
  } else {
    // 用 textarea 解码 HTML 实体（浏览器原生，能处理所有命名/数字实体）
    const textarea = document.createElement('textarea');
    textarea.innerHTML = raw;
    html = textarea.value;
  }
  // P1-11修复：DOMPurify 消毒，防止书籍元数据中注入恶意 HTML/JS
  // 允许常见排版标签，禁止 script/style/iframe 等危险标签
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'div',
      'span',
      'b',
      'i',
      'em',
      'strong',
      'a',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'blockquote',
      'hr',
      'img'
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'style']
  });
});

/* ==================== 计算属性 ==================== */

/** 总章节数 */
const totalChapters = computed<number>(() => {
  if (store.chapters.length > 0) return store.chapters.length;
  return store.book?.total_chapters ?? 0;
});

/** 已读章节序号（从 0 开始） */
const readChapterIndex = computed<number>(() => {
  return store.progress?.chapter_index ?? 0;
});

/** 已读章节数（当前章节 + 1，最多为总章节数） */
const readChapterCount = computed<number>(() => {
  if (!store.progress) return 0;
  return Math.min(readChapterIndex.value + 1, totalChapters.value);
});

/** 阅读进度百分比（0~100） */
const progressPercent = computed<number>(() => {
  if (totalChapters.value === 0) return 0;
  return Math.round((readChapterCount.value / totalChapters.value) * 100);
});

/** 累计阅读时长（格式化） */
const readDurationText = computed<string>(() => {
  return formatDuration(store.progress?.read_time ?? 0);
});

/** 上次阅读位置（章节标题） */
const lastReadChapterTitle = computed<string>(() => {
  if (!store.progress) return t('bookDetail.notRead');
  const idx = store.progress.chapter_index;
  const ch = store.chapters[idx];
  return ch?.title ?? t('bookDetail.chapterFallback', { n: idx + 1 });
});

/** 书签数量（有 content 的） */
const bookmarkCount = computed<number>(() => {
  return bookmarks.value.length;
});

/** 笔记数量（有 note 的） */
const noteCount = computed<number>(() => {
  return bookmarks.value.filter((b) => b.note && b.note.trim()).length;
});

/** 书签列表（直接从 store 获取） */
const bookmarks = computed(() => store.bookmarks);

/** 文件类型标签文本 */
const fileTypeText = computed<string>(() => {
  const ft = store.book?.file_type;
  if (!ft) return t('common.words.unknown');
  return ft.toUpperCase();
});

/* ==================== 系列信息（v29：重名系列书区分） ==================== */

/**
 * 系列卷号文本（详情页完整展示：系列名 · 第N卷/共M卷）
 *
 * - 无 series_number 不显示该行（单行本无系列信息）
 * - series 与 title 相同时省略系列名（避免"哆啦A梦[大长篇][台版] · 哆啦A梦[大长篇][台版]"式冗余）
 * - 有 series_total（ComicInfo.xml Count）时显示"第N卷 / 共M卷"完整形态
 */
const seriesVolumeText = computed<string | null>(() => {
  const b = store.book;
  if (!b || b.series_number === null || b.series_number === undefined) return null;
  const prefix = b.series && b.series.trim() !== b.title.trim() ? `${b.series} · ` : '';
  const volume = t('common.series.volumeOnly', { n: b.series_number });
  if (b.series_total !== null && b.series_total !== undefined && b.series_total > 0) {
    return `${prefix}${t('bookDetail.series.volumeCount', { n: b.series_number, total: b.series_total })}`;
  }
  return `${prefix}${volume}`;
});

/* ==================== 时间信息 ==================== */

/** 加入时间 */
const createdAtText = computed<string>(() => {
  const ts = store.book?.created_at;
  if (!ts) return t('common.words.unknown');
  return formatDateTime(ts);
});

/** 最近阅读时间 */
const lastReadAtText = computed<string>(() => {
  const ts = store.book?.last_read_at;
  if (!ts) return t('bookDetail.notRead');
  return formatRelativeTime(ts);
});

/** 章节预览：前 5 章 */
const previewChapters = computed(() => {
  return store.chapters.slice(0, 5);
});

/** 是否有更多章节（超过 5 章） */
const hasMoreChapters = computed<boolean>(() => {
  return store.chapters.length > 5;
});

/* ==================== 个人评分 ==================== */

/** 当前评分（1-5，null 表示未评分） */
const currentRating = computed<number | null>(() => {
  // rating 为 0 时视为未评分（0 被 || 当 falsy 转为 null），避免 0 被当作有效评分导致星星显示异常（P1-16）
  return store.book?.rating || null;
});

/** 评分星星图标列表：1-5 星，已评分的用 Star（填充），未评分的用 StarOff（描边） */
const ratingStars = computed<{ value: number; filled: boolean }[]>(() => {
  const rating = currentRating.value;
  return [1, 2, 3, 4, 5].map((value) => ({
    value,
    filled: rating !== null && value <= rating
  }));
});

/** 正在更新评分的标志（防重复点击） */
const ratingUpdating = ref<boolean>(false);

/** 点击星星设置评分：点击已评分的同一星可取消评分 */
async function handleSetRating(value: number): Promise<void> {
  if (!store.book || ratingUpdating.value) return;
  const newRating = currentRating.value === value ? null : value;
  ratingUpdating.value = true;
  try {
    await store.updateRating(store.book.id, newRating);
  } catch {
    message.error(t('bookDetail.rating.setFailed'));
  } finally {
    ratingUpdating.value = false;
  }
}

/* ==================== 阅读状态 ==================== */

/** 阅读状态选项配置 */
const readingStatusOptions = computed<{ status: Exclude<ReadingStatus, null>; label: string; icon: typeof BookOpen }[]>(
  () => [
    { status: 'reading', label: t('common.status.reading'), icon: BookOpen },
    { status: 'completed', label: t('common.status.completed'), icon: BookCheck },
    { status: 'want_to_read', label: t('common.status.wantToRead'), icon: BookHeart },
    { status: 'dropped', label: t('common.status.dropped'), icon: BookX }
  ]
);

/** 当前阅读状态 */
const currentReadingStatus = computed<ReadingStatus>(() => {
  return (store.book?.reading_status as ReadingStatus) ?? null;
});

/** 正在更新阅读状态的标志（防重复点击） */
const statusUpdating = ref<boolean>(false);

/** 点击状态按钮切换阅读状态：再次点击同一状态可取消（设为 null） */
async function handleSetReadingStatus(status: ReadingStatus): Promise<void> {
  if (!store.book || statusUpdating.value) return;
  const newStatus = currentReadingStatus.value === status ? null : status;
  statusUpdating.value = true;
  try {
    await store.updateReadingStatus(store.book.id, newStatus);
  } catch {
    message.error(t('bookDetail.status.setFailed'));
  } finally {
    statusUpdating.value = false;
  }
}

/* ==================== 阅读统计分析 ==================== */

/**
 * 平均阅读速度（字/分钟）。
 * 由 reading_sessions 汇总的总字数 ÷ 总时长(分钟) 计算。
 * 无会话记录或时长为 0 时返回 0。
 */
const avgReadingSpeed = computed<number>(() => {
  const stats = store.readingStats;
  if (!stats || stats.total_duration <= 0 || stats.total_chars <= 0) return 0;
  const minutes = stats.total_duration / 60000;
  return Math.round(stats.total_chars / minutes);
});

/** 平均阅读速度展示文本 */
const avgSpeedText = computed<string>(() => {
  const speed = avgReadingSpeed.value;
  return speed > 0 ? t('bookDetail.stats.wordsPerMinute', { n: speed }) : t('common.empty.noData');
});

/**
 * 最近7天阅读趋势（补零后的连续日期数组）。
 * 后端仅返回有阅读记录的日期，前端需补零以形成连续 7 天轴，便于柱状图绘制。
 * P2-8: TREND_DAYS 从 book-detail store 导入，避免与 store 重复定义。
 */
interface TrendBar {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 月份-日（MM-DD，用于横轴标签） */
  label: string;
  /** 当天阅读时长（ms） */
  duration: number;
  /** 柱高百分比（0~100，相对于7天内最大时长） */
  heightPercent: number;
}

const trendBars = computed<TrendBar[]>(() => {
  const dailyMap = new Map<string, number>();
  for (const d of store.dailyStats) {
    dailyMap.set(d.date, d.duration);
  }
  const bars: TrendBar[] = [];
  const now = new Date();
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    const date = `${y}-${m}-${day}`;
    bars.push({
      date,
      label: `${m}-${day}`,
      duration: dailyMap.get(date) ?? 0,
      heightPercent: 0
    });
  }
  const maxDuration = Math.max(...bars.map((b) => b.duration), 1);
  for (const b of bars) {
    b.heightPercent = Math.round((b.duration / maxDuration) * 100);
  }
  return bars;
});

/** 7天趋势是否有数据（至少一天有阅读记录） */
const hasTrendData = computed<boolean>(() => {
  return trendBars.value.some((b) => b.duration > 0);
});

/** 7天总阅读时长（ms） */
const trendTotalDuration = computed<number>(() => {
  return trendBars.value.reduce((sum, b) => sum + b.duration, 0);
});

/** 7天总阅读时长展示文本 */
const trendTotalText = computed<string>(() => {
  return formatDuration(trendTotalDuration.value);
});

/** 7天总阅读字数 */
const trendTotalChars = computed<number>(() => {
  return store.dailyStats.reduce((sum, d) => sum + (d.chars_read ?? 0), 0);
});

/** 7天总阅读字数展示文本（千字单位） */
const trendTotalCharsText = computed<string>(() => {
  const chars = trendTotalChars.value;
  if (chars >= 10000) {
    return t('bookDetail.trend.charsWan', {
      n: (chars / 10000).toFixed(1),
      k: Math.round(chars / 1000)
    });
  }
  if (chars >= 1000) return t('bookDetail.trend.charsThousand', { n: (chars / 1000).toFixed(1) });
  return t('bookDetail.trend.charsBasic', { n: chars });
});

/** 阅读完成度（已读章节/总章节，0~100） */
const completionPercent = computed<number>(() => {
  if (totalChapters.value === 0) return 0;
  return Math.round((readChapterCount.value / totalChapters.value) * 100);
});

/** 环形进度条周长（用于 stroke-dashoffset 计算） */
const RING_RADIUS = 52;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 环形进度条 dashoffset */
const ringDashOffset = computed<number>(() => {
  return RING_CIRCUMFERENCE * (1 - completionPercent.value / 100);
});

/* ==================== 相关推荐 ==================== */

/** 推荐书籍封面加载失败状态（按书籍ID跟踪） */
const relatedCoverFailed = ref<Set<number>>(new Set());

/** 推荐书籍封面 URL：有封面用图片，无封面生成 SVG；加载失败时回退到默认SVG */
function getRelatedCoverUrl(book: RelatedBook): string {
  if (relatedCoverFailed.value.has(book.id)) {
    return generateCoverDataUrl(book.title, book.author);
  }
  const url = coverPathToUrl(book.cover);
  if (url) return url;
  return generateCoverDataUrl(book.title, book.author);
}

/** 推荐书籍封面加载失败时标记，回退到默认SVG */
function onRelatedCoverError(bookId: number): void {
  relatedCoverFailed.value = new Set([...relatedCoverFailed.value, bookId]);
}

/** 推荐原因对应的 Naive UI 标签类型 */
function getRelationTagType(relation: RelatedBook['relation']): 'success' | 'info' | 'warning' {
  switch (relation) {
    case 'same_author':
      return 'success';
    case 'similar_title':
      return 'info';
    case 'reading_history':
      return 'warning';
  }
}

/** 推荐原因标签的本地化文本（relationLabel 为主进程数据，视图层按 relation 映射展示） */
function getRelationLabelText(relation: RelatedBook['relation']): string {
  switch (relation) {
    case 'same_author':
      return t('bookDetail.relations.sameAuthor');
    case 'similar_title':
      return t('bookDetail.relations.similarTitle');
    case 'reading_history':
      return t('bookDetail.relations.readingHistory');
  }
}

/** 跳转到推荐书籍详情页 */
function goToRelatedBook(id: number): void {
  router.push(`/book/${id}`);
}

/* ==================== 操作按钮 ==================== */

/** 开始/继续阅读（RSS 文章跳转文章视图，其他统一跳转小说阅读器） */
function startReading(): void {
  if (!store.book) return;
  // 统一阅读器：所有类型都用Reader（小说阅读器承担一切）
  if (store.book.file_type === 'rss') {
    router.push(`/article/${store.book.id}`);
  } else {
    router.push(`/reader/${store.book.id}`);
  }
}

/** 返回书架 */
function goBack(): void {
  router.push('/');
}

/** 跳转到指定章节（RSS 文章只有1章，直接跳文章视图；其他跳阅读器） */
function goToChapter(chapterIndex: number): void {
  if (!store.book) return;
  // 统一阅读器：所有类型都用Reader
  if (store.book.file_type === 'rss') {
    router.push(`/article/${store.book.id}`);
  } else {
    router.push(`/reader/${store.book.id}?chapter=${chapterIndex}`);
  }
}

/** 查看全部章节（RSS 文章跳文章视图，其他跳阅读器展示目录） */
function viewAllChapters(): void {
  if (!store.book) return;
  // 统一阅读器：所有类型都用Reader
  if (store.book.file_type === 'rss') {
    router.push(`/article/${store.book.id}`);
  } else {
    router.push(`/reader/${store.book.id}?showCatalog=1`);
  }
}

/** 重新分章（确认对话框） */
function handleReparse(): void {
  if (!store.book) return;
  dialog.warning({
    title: t('bookDetail.reparse.title'),
    content: t('bookDetail.reparse.confirm'),
    positiveText: t('common.actions.confirm'),
    negativeText: t('common.actions.cancel'),
    onPositiveClick: async () => {
      if (!store.book) return;
      try {
        const result = await store.reparseChapters(store.book.id);
        if (result.success) {
          message.success(t('bookDetail.reparse.done', { n: result.chapterCount }));
        } else {
          message.error(
            t('bookDetail.reparse.failedWith', {
              msg: result.error ?? t('bookDetail.errors.unknownError')
            })
          );
        }
      } catch {
        message.error(t('bookDetail.reparse.failed'));
      }
    }
  });
}

/**
 * 删除书籍（确认对话框，批次 v54 删除分流）
 *
 * link 书：清单式确认 + "同时删除引用的原文件"复选框（默认不勾）；
 * copy/move 书保持原有简单确认。
 */
function handleDelete(): void {
  if (!store.book) return;
  const title = store.book.title;
  const isLink = store.book.import_mode === 'link';
  // v57 修复：NCheckbox 改非受控模式（不传 checked）——原受控写法以普通 let 变量
  // 作 checked 源，dialog content 渲染函数仅执行一次不再重渲染，勾选视觉永不生效
  let deleteSource = false;

  dialog.warning({
    title: t('bookDetail.deleteBook.title'),
    content: () => {
      if (!isLink) {
        return t('bookDetail.deleteBook.confirm', { title });
      }
      return h('div', { style: 'display:flex;flex-direction:column;gap:8px;margin:4px 0;' }, [
        h('p', { style: 'margin:0 0 4px;font-weight:500;' }, `《${title}》`),
        h('p', { style: 'margin:0;color:var(--text-secondary);font-size:13px;' }, t('import.delete.cleanupList')),
        h(
          NCheckbox,
          {
            'onUpdate:checked': (v: boolean) => {
              deleteSource = v;
            }
          },
          { default: () => t('import.delete.deleteSource', { n: 1 }) }
        )
      ]);
    },
    positiveText: t('common.actions.delete'),
    negativeText: t('common.actions.cancel'),
    onPositiveClick: async () => {
      if (!store.book) return;
      try {
        await store.deleteBook(store.book.id, deleteSource);
        message.success(t('common.feedback.deleted'));
        router.push('/');
      } catch {
        message.error(t('bookDetail.deleteBook.failed'));
      }
    }
  });
}

/* ==================== 重新定位 + 深度搜索 + 存储模式转换（P2 导入三模式） ==================== */

/** 重新定位执行中（按钮 loading） */
const relocating = ref(false);

/**
 * 当前书是否为失效的 link 书（书架批量检查结果联动，响应式）：
 * 详情页 NAlert 失效提示 + 深度搜索入口强调的判断依据。
 */
const isMissingLink = computed<boolean>(
  () => store.book?.import_mode === 'link' && bookshelfStore.isMissingLink(bookId.value)
);

/** 当前书是否为引用模式（存储模式区展示与转换入口判断） */
const isLinkMode = computed<boolean>(() => store.book?.import_mode === 'link');

/** 存储模式标签文案（复用导入模式确认对话框的 copy/move/link 文案） */
const storageModeText = computed<string>(() => {
  switch (store.book?.import_mode) {
    case 'link':
      return t('import.mode.link');
    case 'move':
      return t('import.mode.move');
    default:
      return t('import.mode.copy');
  }
});

/** 存储模式说明文案（当前模式的行为描述） */
const storageDescText = computed<string>(() => {
  if (isLinkMode.value) return t('bookDetail.storage.linkDesc');
  if (store.book?.import_mode === 'move') return t('bookDetail.storage.moveDesc');
  return t('bookDetail.storage.copyDesc');
});

/**
 * 重新定位 link 书：详情页入口（原文件失效后用户可从这里再试）。
 * 选择新文件 → relocate 哈希校验 → 一致静默更新路径；不一致提示后可重选。
 * 恢复成功同步清除书架失效角标状态（任务要求：relocate 成功回调里更新 store）。
 */
async function handleRelocate(): Promise<void> {
  if (!store.book || relocating.value || !window.importApi) return;
  try {
    const paths = await window.importApi.selectFiles();
    if (paths.length === 0) return;
    relocating.value = true;
    const result = await window.dbApi.book.relocate(store.book.id, paths[0]);
    relocating.value = false;
    if (result.success) {
      message.success(t('bookDetail.relocate.recovered'));
      // 同步清除书架失效角标（该书已恢复）
      bookshelfStore.clearMissingLink(store.book.id);
      // 刷新详情（local_file_path 已更新）
      await store.loadDetail(store.book.id);
      return;
    }
    if (result.error === 'HASH_MISMATCH') {
      message.error(t('bookDetail.relocate.mismatch'));
      return;
    }
    if (result.error === 'FILE_NOT_FOUND') {
      message.error(t('bookDetail.relocate.fileNotFound'));
      return;
    }
    message.error(t('bookDetail.relocate.failed', { msg: result.error ?? '' }));
  } catch (err) {
    relocating.value = false;
    message.error(t('bookDetail.relocate.failed', { msg: (err as Error).message }));
  }
}

/** 深度搜索执行中（按钮 loading） */
const searching = ref(false);

/**
 * 深度搜索（P2 目录递归恢复，设计文档第二节第 3 层）：
 * 选目录 → 主进程按 file_hash 递归查找（大小过滤+扩展名过滤+xxhash64）→
 * 找到自动 relocate（复用无感恢复闭环）→ toast"已在 {path} 找到原文件"；
 * 未找到/超时给出对应提示。
 */
async function handleDeepSearch(): Promise<void> {
  if (!store.book || searching.value || !window.importApi) return;
  try {
    const dir = await window.importApi.selectDirectory();
    if (!dir) return;
    searching.value = true;
    const result = await window.dbApi.book.searchFile(store.book.id, dir);
    searching.value = false;

    if (result.success && result.path) {
      // 命中：自动重新定位落库（searchFile 已按哈希校验，relocate 再校验一次双保险）
      const reloc = await window.dbApi.book.relocate(store.book.id, result.path);
      if (reloc.success) {
        message.success(t('bookDetail.search.found', { path: result.path }));
        bookshelfStore.clearMissingLink(store.book.id);
        await store.loadDetail(store.book.id);
      } else {
        message.error(t('bookDetail.relocate.failed', { msg: reloc.error ?? '' }));
      }
      return;
    }
    if (result.error === 'TIMEOUT') {
      message.warning(t('bookDetail.search.timeout'));
      return;
    }
    if (result.error === 'NO_HASH') {
      message.warning(t('bookDetail.search.noHash'));
      return;
    }
    if (result.error === 'INVALID_DIR') {
      message.error(t('bookDetail.search.invalidDir'));
      return;
    }
    message.warning(t('bookDetail.search.notFound'));
  } catch (err) {
    searching.value = false;
    message.error(t('bookDetail.search.failed', { msg: (err as Error).message }));
  }
}

/** 模式转换执行中（按钮 loading） */
const converting = ref(false);

/**
 * copy/move → link 转换：选择原文件 → 主进程哈希校验一致 → 切换引用并删除
 * userData 副本 → toast 显示释放空间。原文件内容与本书不一致时提示可重选。
 */
async function handleConvertToLink(): Promise<void> {
  if (!store.book || converting.value || !window.importApi) return;
  try {
    const paths = await window.importApi.selectFiles();
    if (paths.length === 0) return;
    converting.value = true;
    const result = await window.dbApi.book.convertImportMode(store.book.id, 'link', paths[0]);
    converting.value = false;
    if (result.success) {
      message.success(
        result.freedBytes && result.freedBytes > 0
          ? t('bookDetail.storage.freed', { size: formatFileSize(result.freedBytes) })
          : t('bookDetail.storage.convertedLink')
      );
      // 刷新详情（import_mode/local_file_path 已更新）
      await store.loadDetail(store.book.id);
      return;
    }
    if (result.error === 'HASH_MISMATCH') {
      message.error(t('bookDetail.relocate.mismatch'));
      return;
    }
    if (result.error === 'FILE_NOT_FOUND') {
      message.error(t('bookDetail.relocate.fileNotFound'));
      return;
    }
    message.error(t('bookDetail.storage.convertFailed', { msg: result.error ?? '' }));
  } catch (err) {
    converting.value = false;
    message.error(t('bookDetail.storage.convertFailed', { msg: (err as Error).message }));
  }
}

/**
 * link → copy 转换：原文件已知（local_file_path），主进程复制到 userData
 * （.tmp 原子落位三层防御）→ toast 显示文件大小。原文件保留不动，无需确认。
 */
async function handleConvertToCopy(): Promise<void> {
  if (!store.book || converting.value) return;
  try {
    converting.value = true;
    const result = await window.dbApi.book.convertImportMode(store.book.id, 'copy');
    converting.value = false;
    if (result.success) {
      message.success(
        t('bookDetail.storage.copied', { size: formatFileSize(result.copiedBytes ?? 0) })
      );
      await store.loadDetail(store.book.id);
      return;
    }
    if (result.error === 'FILE_NOT_FOUND') {
      message.error(t('bookDetail.relocate.fileNotFound'));
      return;
    }
    message.error(t('bookDetail.storage.convertFailed', { msg: result.error ?? '' }));
  } catch (err) {
    converting.value = false;
    message.error(t('bookDetail.storage.convertFailed', { msg: (err as Error).message }));
  }
}

/** 字节数转人类可读（toast 展示释放/占用空间，KB 起步保留 1 位小数） */
function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/* ==================== 导出 ==================== */

/** TXT 导出中状态 */
const exportingTxt = ref<boolean>(false);
/** EPUB 导出中状态 */
const exportingEpub = ref<boolean>(false);
/** CBZ 导出中状态（漫画专用） */
const exportingCbz = ref<boolean>(false);
/** 源文件导出中状态 */
const exportingSource = ref<boolean>(false);

/** 导出为 TXT */
async function handleExportTxt(): Promise<void> {
  if (!store.book || exportingTxt.value) return;
  exportingTxt.value = true;
  try {
    const savedPath = await window.exportApi.exportBookTxt(store.book.id);
    if (isImageBookGuard(savedPath)) {
      // 图片型守卫：主进程拒绝生成空壳文件，引导用户改用源文件/CBZ 导出
      message.warning(t('bookDetail.export.imageBookHint'));
      return;
    }
    if (savedPath) {
      message.success(t('bookDetail.export.done', { format: 'TXT', path: savedPath }));
    } else {
      message.info(t('bookDetail.export.canceled'));
    }
  } catch (err) {
    console.error('[book-detail] 导出 TXT 失败', err);
    message.error(t('bookDetail.export.failed', { format: 'TXT', msg: (err as Error).message }));
  } finally {
    exportingTxt.value = false;
  }
}

/** 导出为 EPUB */
async function handleExportEpub(): Promise<void> {
  if (!store.book || exportingEpub.value) return;
  exportingEpub.value = true;
  try {
    const savedPath = await window.exportApi.exportBookEpub(store.book.id);
    if (isImageBookGuard(savedPath)) {
      // 图片型守卫：主进程拒绝生成空壳文件，引导用户改用源文件/CBZ 导出
      message.warning(t('bookDetail.export.imageBookHint'));
      return;
    }
    if (savedPath) {
      message.success(t('bookDetail.export.done', { format: 'EPUB', path: savedPath }));
    } else {
      message.info(t('bookDetail.export.canceled'));
    }
  } catch (err) {
    console.error('[book-detail] 导出 EPUB 失败', err);
    message.error(t('bookDetail.export.failed', { format: 'EPUB', msg: (err as Error).message }));
  } finally {
    exportingEpub.value = false;
  }
}

/** 导出为 CBZ（漫画专用格式） */
async function handleExportCbz(): Promise<void> {
  if (!store.book || exportingCbz.value) return;
  exportingCbz.value = true;
  try {
    const savedPath = await window.exportApi.exportBookCbz(store.book.id);
    if (savedPath) {
      message.success(t('bookDetail.export.done', { format: 'CBZ', path: savedPath }));
    } else {
      message.info(t('bookDetail.export.canceled'));
    }
  } catch (err) {
    console.error('[book-detail] 导出 CBZ 失败', err);
    message.error(t('bookDetail.export.failed', { format: 'CBZ', msg: (err as Error).message }));
  } finally {
    exportingCbz.value = false;
  }
}

/** 导出源文件（复制导入时的原始文件，不重新生成内容——图片型/扫描版书的首选导出方式） */
async function handleExportSource(): Promise<void> {
  if (!store.book || exportingSource.value) return;
  exportingSource.value = true;
  try {
    const savedPath = await window.exportApi.exportBookSource(store.book.id);
    if (savedPath) {
      message.success(t('bookDetail.export.sourceDone', { path: savedPath }));
    } else {
      message.info(t('bookDetail.export.canceled'));
    }
  } catch (err) {
    console.error('[book-detail] 导出源文件失败', err);
    message.error(t('bookDetail.export.sourceFailed', { msg: (err as Error).message }));
  } finally {
    exportingSource.value = false;
  }
}

/* ==================== "更多"下拉菜单（次要操作收纳） ==================== */

/** NDropdown 图标渲染 helper */
const renderDropdownIcon = useDropdownIcon();

/**
 * 重新分章支持的文件类型白名单
 *
 * 与主进程 importer.getParser 支持的类型一致（txt/epub/mobi/pdf/comic）。
 * rss 等类型无对应 parser，点击"重新分章"必报错（"不支持的文件类型: rss"），
 * 因此仅对白名单内类型显示该菜单项。
 */
const REPARSE_SUPPORTED = ['txt', 'epub', 'mobi', 'pdf', 'comic'] as const;

/**
 * "更多"下拉菜单选项
 *
 * 收纳的次要操作：
 *   - 重新分章（仅 txt/epub/mobi/pdf/comic 等可重新解析的类型）
 *   - 导出 TXT / EPUB / CBZ
 *   - 删除（红色文字）
 */
const moreMenuOptions = computed<DropdownOption[]>(() => {
  const opts: DropdownOption[] = [];

  // 重新分章（rss 等无 parser 的类型不显示，避免点击必报错）
  if (REPARSE_SUPPORTED.includes(store.book?.file_type as (typeof REPARSE_SUPPORTED)[number])) {
    opts.push({ label: t('bookDetail.reparse.title'), key: 'reparse', icon: renderDropdownIcon(RefreshCw) });
  }

  // 重新定位（批次 v54：仅 link 书显示——原文件失效后从详情页再试的恢复入口）
  if (store.book?.import_mode === 'link') {
    opts.push({ label: t('bookDetail.relocate.title'), key: 'relocate', icon: renderDropdownIcon(FileSearch) });
  }

  // 导出分隔线 + 导出选项（P2 修复：按内容类型过滤，统一走 availableExportFormats，
  // 与 Bookshelf 右键导出子菜单共享口径——漫画 TXT 空壳、扫描版 TXT/EPUB 乱码层均不再显示）
  const exportFormats = availableExportFormats(store.book ?? {});
  // 导出源文件：复制导入时的原始文件（不重新生成），对所有有本地源文件的书可用；
  // 图片型/扫描版书即使其余格式全隐藏也保留此入口（在线书/RSS 无 local_file_path 不显示）
  if (exportFormats.txt || exportFormats.epub || exportFormats.cbz || store.book?.local_file_path) {
    opts.push({ type: 'divider', key: 'd-export' });
    if (exportFormats.txt) {
      opts.push({
        label: t('bookDetail.export.label', { format: 'TXT' }),
        key: 'export-txt',
        icon: renderDropdownIcon(FileText)
      });
    }
    if (exportFormats.epub) {
      opts.push({
        label: t('bookDetail.export.label', { format: 'EPUB' }),
        key: 'export-epub',
        icon: renderDropdownIcon(FileOutput)
      });
    }
    if (exportFormats.cbz) {
      opts.push({
        label: t('bookDetail.export.cbzComic'),
        key: 'export-cbz',
        icon: renderDropdownIcon(FileOutput)
      });
    }
    if (store.book?.local_file_path) {
      opts.push({
        label: t('bookDetail.export.source'),
        key: 'export-source',
        icon: renderDropdownIcon(FileOutput)
      });
    }
  }

  // 删除分隔线 + 删除项（红色文字）
  opts.push({ type: 'divider', key: 'd-delete' });
  opts.push({
    label: t('common.actions.delete'),
    key: 'delete',
    icon: renderDropdownIcon(Trash),
    props: { style: 'color: var(--color-danger)' }
  });

  return opts;
});

/** "更多"下拉菜单选择处理 */
function handleMoreMenuSelect(key: string): void {
  switch (key) {
    case 'reparse':
      handleReparse();
      break;
    case 'export-txt':
      handleExportTxt();
      break;
    case 'export-epub':
      handleExportEpub();
      break;
    case 'export-cbz':
      handleExportCbz();
      break;
    case 'export-source':
      handleExportSource();
      break;
    case 'relocate':
      void handleRelocate();
      break;
    case 'delete':
      handleDelete();
      break;
  }
}

/* ==================== 生命周期 ==================== */

/** 错误页自动跳转定时器（onBeforeUnmount 中清理，避免用户手动导航后 setTimeout 仍执行） */
let errorRedirectTimer: ReturnType<typeof setTimeout> | null = null;

/** 组件是否已卸载（防止 async 操作完成后写入已卸载的组件状态） */
let isUnmounted = false;

onMounted(async () => {
  if (bookId.value > 0) {
    await store.loadDetail(bookId.value);
    if (isUnmounted) return;

    if (!store.book && !store.loading) {
      message.error(t('bookDetail.errors.notFound'));
      errorRedirectTimer = setTimeout(() => router.push('/'), 1000);
    } else {
      await nextTick();
      if (isUnmounted) return;
      measureIntroOverflow();
    }
  } else {
    message.error(t('bookDetail.errors.invalidId'));
    errorRedirectTimer = setTimeout(() => router.push('/'), 1000);
  }
});

/**
 * 监听 bookId 变化：从相关推荐点击跳转到另一本书的详情页时，
 * Vue Router 复用同一组件实例（同路由不同参数），onMounted 不会再次执行。
 * 需在此 watch 中重新加载详情数据。
 */
watch(
  () => bookId.value,
  async (newId: number, oldId: number) => {
    if (newId !== oldId && newId > 0) {
      if (errorRedirectTimer) {
        clearTimeout(errorRedirectTimer);
        errorRedirectTimer = null;
      }
      editing.value = false;
      introOverflow.value = false;

      relatedCoverFailed.value.clear();
      store.reset();
      await store.loadDetail(newId);
      if (isUnmounted) return;
      if (!store.book && !store.loading) {
        message.error(t('bookDetail.errors.notFound'));
        errorRedirectTimer = setTimeout(() => router.push('/'), 1000);
      } else {
        await nextTick();
        if (isUnmounted) return;
        measureIntroOverflow();
      }
    }
  }
);

onBeforeUnmount(() => {
  isUnmounted = true;
  if (errorRedirectTimer) {
    clearTimeout(errorRedirectTimer);
    errorRedirectTimer = null;
  }

  store.reset();
});
</script>

<template>
  <div class="detail-root">
    <!-- 固定 header — 琉璃质感 -->
    <header class="detail-header">
      <n-button quaternary circle size="small" @click="goBack">
        <template #icon>
          <n-icon :component="ArrowLeft" />
        </template>
      </n-button>
      <h1 class="page-title">{{ store.book?.title ?? t('bookDetail.title') }}</h1>
    </header>

    <!-- 内容滚动区 -->
    <div class="detail-view">
      <!-- 加载中 -->
      <div v-if="store.loading" class="loading-state">
        <n-spin size="large" />
      </div>

      <!-- 错误提示 -->
      <div v-else-if="store.errorMsg && !store.book" class="error-state">
        <div class="empty-state">
          <div class="empty-icon-wrap">
            <n-icon :component="BookIcon" :size="56" />
          </div>
          <p class="empty-title">{{ t('bookDetail.errors.stateTitle') }}</p>
          <p class="empty-hint">{{ t('bookDetail.errors.stateHint') }}</p>
        </div>
      </div>

      <!-- 详情内容 -->
      <div v-else-if="store.book" class="detail-container">
        <!-- 头部区域：大封面 + 基本信息 + 简介 + 信息栏 -->
        <n-card class="section-card header-card" bordered>
          <!-- link 书失效提示（P2 导入三模式：书架批量检查结果联动） -->
          <n-alert v-if="isMissingLink" type="warning" :show-icon="true" class="missing-alert">
            {{ t('bookDetail.storage.fileMissing') }}
          </n-alert>
          <div class="header-layout">
            <!-- 大封面 180x240，hover 时显示更换封面按钮 -->
            <div class="cover-wrap" :class="{ 'cover-uploading': coverUploading }">
              <img
                :src="coverUrl"
                class="cover"
                :alt="t('bookDetail.cover.alt')"
                draggable="false"
                @error="onCoverError"
              />
              <div class="cover-overlay">
                <button class="cover-action-btn" @click="changeCover">
                  <n-icon :component="Image" :size="20" />
                  <span>{{ t('bookDetail.cover.change') }}</span>
                </button>
                <button v-if="store.book?.cover" class="cover-action-btn" @click="resetCover">
                  <n-icon :component="RefreshCw" :size="20" />
                  <span>{{ t('bookDetail.cover.reset') }}</span>
                </button>
              </div>
              <div v-if="coverUploading" class="cover-loading">
                <n-spin size="small" />
              </div>
            </div>

            <!-- 基本信息 -->
            <div class="info-area">
              <!-- 书名（可编辑） -->
              <div class="info-row title-row">
                <n-input
                  v-if="editing"
                  v-model:value="editForm.title"
                  size="large"
                  :placeholder="t('common.words.title')"
                  class="edit-input"
                />
                <h2 v-else class="book-title">{{ store.book.title }}</h2>
              </div>

              <!-- 作者（可编辑） -->
              <div class="info-row author-row">
                <span class="info-label">{{ t('common.words.author') }}</span>
                <n-input
                  v-if="editing"
                  v-model:value="editForm.author"
                  size="small"
                  :placeholder="t('common.words.author')"
                  class="edit-input"
                />
                <span v-else class="info-value">{{ store.book.author || t('common.words.unknown') }}</span>
              </div>

              <!-- 系列（v29：重名系列书区分，"系列 · 第N卷/共M卷"） -->
              <div v-if="seriesVolumeText" class="info-row series-row">
                <span class="info-label">{{ t('bookDetail.fields.series') }}</span>
                <span class="info-value">{{ seriesVolumeText }}</span>
              </div>

              <!-- 元数据标签行 -->
              <div class="info-row tags-row">
                <n-tag size="small" type="info" round>{{ fileTypeText }}</n-tag>
                <n-tag size="small" type="default" round>
                  <n-icon :component="Hash" :size="12" class="tag-icon" />
                  {{ t('bookDetail.chaptersCount', { n: totalChapters }) }}
                </n-tag>
                <n-tag size="small" type="default" round>
                  <n-icon :component="Calendar" :size="12" class="tag-icon" />
                  {{ createdAtText }}
                </n-tag>
                <n-tag size="small" type="default" round>
                  <n-icon :component="History" :size="12" class="tag-icon" />
                  {{ lastReadAtText }}
                </n-tag>
              </div>

              <!-- 个人评分 -->
              <div class="info-row rating-row">
                <span class="info-label">{{ t('bookDetail.fields.rating') }}</span>
                <div class="rating-stars">
                  <button
                    v-for="star in ratingStars"
                    :key="star.value"
                    class="rating-star-btn"
                    :class="{ 'rating-star-filled': star.filled }"
                    :title="t('bookDetail.rating.starsTitle', { n: star.value })"
                    @click="handleSetRating(star.value)"
                  >
                    <n-icon :component="star.filled ? Star : StarOff" :size="20" />
                  </button>
                </div>
              </div>

              <!-- 阅读状态标记 -->
              <div class="info-row status-row">
                <span class="info-label">{{ t('common.words.status') }}</span>
                <div class="status-buttons">
                  <button
                    v-for="opt in readingStatusOptions"
                    :key="opt.status"
                    class="status-btn"
                    :class="{ 'status-btn-active': currentReadingStatus === opt.status }"
                    @click="handleSetReadingStatus(opt.status)"
                  >
                    <n-icon :component="opt.icon" :size="14" />
                    <span>{{ opt.label }}</span>
                  </button>
                </div>
              </div>

              <!-- 编辑按钮 -->
              <div class="edit-actions">
                <template v-if="editing">
                  <n-button type="primary" size="small" :loading="store.actionLoading" @click="saveEdit">
                    <template #icon>
                      <n-icon :component="Check" />
                    </template>
                    {{ t('common.actions.save') }}
                  </n-button>
                  <n-button size="small" @click="cancelEdit">
                    <template #icon>
                      <n-icon :component="X" />
                    </template>
                    {{ t('common.actions.cancel') }}
                  </n-button>
                </template>
                <n-button v-else size="small" quaternary @click="startEdit">
                  <template #icon>
                    <n-icon :component="Edit" />
                  </template>
                  {{ t('common.actions.edit') }}
                </n-button>
              </div>
            </div>
          </div>

          <!-- 简介区域（在头部卡片内，紧贴基本信息） -->
          <div class="intro-section">
            <div class="intro-header">
              <span class="intro-title">{{ t('bookDetail.fields.intro') }}</span>
            </div>
            <div class="intro-content">
              <n-input
                v-if="editing"
                v-model:value="editForm.intro"
                type="textarea"
                :autosize="{ minRows: 4, maxRows: 10 }"
                :placeholder="t('bookDetail.fields.introPlaceholder')"
              />
              <p
                v-else
                ref="introTextRef"
                class="intro-text"
                :class="{ 'intro-collapsed': !introExpanded && introOverflow }"
                v-html="formattedIntro"
              ></p>
              <!-- 展开/收起按钮 -->
              <button v-if="!editing && introOverflow" class="intro-toggle" @click="toggleIntro">
                <n-icon :component="introExpanded ? ChevronUp : ChevronDown" :size="14" />
                <span>{{ introExpanded ? t('bookDetail.intro.collapse') : t('bookDetail.intro.expand') }}</span>
              </button>
            </div>
          </div>

          <!-- 信息栏：章节数 / 阅读进度 / 书签数 / 阅读时长 -->
          <div class="info-bar">
            <div class="info-bar-item">
              <n-icon :component="Hash" :size="18" class="info-bar-icon" />
              <span class="info-bar-label">{{ t('bookDetail.fields.chapters') }}</span>
              <span class="info-bar-value">{{ totalChapters }}</span>
            </div>
            <div class="info-bar-divider"></div>
            <div class="info-bar-item">
              <n-icon :component="Percent" :size="18" class="info-bar-icon" />
              <span class="info-bar-label">{{ t('bookDetail.sections.progress') }}</span>
              <span class="info-bar-value">{{ progressPercent }}%</span>
            </div>
            <div class="info-bar-divider"></div>
            <div class="info-bar-item">
              <n-icon :component="Bookmark" :size="18" class="info-bar-icon" />
              <span class="info-bar-label">{{ t('bookDetail.sections.bookmarks') }}</span>
              <span class="info-bar-value">{{ bookmarkCount }}</span>
            </div>
            <div class="info-bar-divider"></div>
            <div class="info-bar-item">
              <n-icon :component="Clock" :size="18" class="info-bar-icon" />
              <span class="info-bar-label">{{ t('bookDetail.fields.readingDuration') }}</span>
              <span class="info-bar-value">{{ readDurationText }}</span>
            </div>
          </div>

          <!-- 主操作按钮区：开始阅读 + 更多菜单 -->
          <div class="primary-actions">
            <n-button type="primary" size="large" @click="startReading" class="primary-action-btn">
              <template #icon>
                <n-icon :component="BookIcon" />
              </template>
              {{ store.progress ? t('bookDetail.continueReading') : t('bookDetail.startReading') }}
            </n-button>

            <n-dropdown
              trigger="click"
              :options="moreMenuOptions"
              @select="handleMoreMenuSelect"
              placement="bottom-end"
            >
              <n-button size="large" class="primary-action-btn">
                <template #icon>
                  <n-icon :component="MoreHorizontal" />
                </template>
                {{ t('common.actions.more') }}
              </n-button>
            </n-dropdown>
          </div>

          <!-- 存储模式区（P2 导入三模式：模式展示 + copy↔link 转换 + 深度搜索入口） -->
          <div v-if="store.book?.local_file_path" class="storage-section">
            <div class="storage-header">
              <n-icon :component="HardDrive" :size="14" class="storage-header-icon" />
              <span class="storage-title">{{ t('bookDetail.storage.title') }}</span>
              <n-tag size="tiny" :type="isLinkMode ? 'warning' : 'default'" round>
                {{ storageModeText }}
              </n-tag>
            </div>
            <div class="storage-desc">{{ storageDescText }}</div>
            <div class="storage-actions">
              <!-- 深度搜索（仅 link 书：失效后在指定目录按内容哈希找回原文件） -->
              <n-button
                v-if="isLinkMode"
                size="tiny"
                quaternary
                :loading="searching"
                @click="handleDeepSearch"
              >
                <template #icon>
                  <n-icon :component="FolderSearch" />
                </template>
                {{ t('bookDetail.search.title') }}
              </n-button>
              <!-- link → copy：收归 userData 自管（原文件保留不动） -->
              <n-button
                v-if="isLinkMode"
                size="tiny"
                quaternary
                :loading="converting"
                @click="handleConvertToCopy"
              >
                {{ t('bookDetail.storage.toCopy') }}
              </n-button>
              <!-- copy/move → link：提供原文件路径释放 userData 副本空间 -->
              <n-button v-else size="tiny" quaternary :loading="converting" @click="handleConvertToLink">
                {{ t('bookDetail.storage.toLink') }}
              </n-button>
            </div>
          </div>
        </n-card>

        <!-- 章节预览：前 5 章 + 查看全部 -->
        <n-card class="section-card" bordered>
          <template #header>
            <div class="card-header">
              <span>
                <n-icon :component="ScrollText" :size="16" class="card-header-icon" />
                {{ t('bookDetail.sections.chapterPreview') }}
              </span>
              <n-button v-if="hasMoreChapters" size="tiny" quaternary @click="viewAllChapters" class="header-action">
                {{ t('bookDetail.viewAll') }}
                <template #icon>
                  <n-icon :component="ArrowLeft" :size="14" class="arrow-right-icon" />
                </template>
              </n-button>
            </div>
          </template>
          <div class="chapter-preview">
            <div
              v-for="(ch, idx) in previewChapters"
              :key="ch.id"
              class="chapter-item"
              @click="goToChapter(ch.chapter_index)"
            >
              <span class="chapter-index">{{ idx + 1 }}</span>
              <span class="chapter-title text-ellipsis">{{
                ch.title || t('bookDetail.chapterFallback', { n: ch.chapter_index + 1 })
              }}</span>
              <n-icon
                v-if="store.progress && ch.chapter_index === store.progress.chapter_index"
                :component="Play"
                :size="14"
                class="chapter-current-icon"
              />
            </div>
            <div v-if="store.chapters.length === 0" class="chapter-empty">{{ t('bookDetail.noChapters') }}</div>
            <!-- 查看全部按钮 -->
            <div v-if="hasMoreChapters" class="view-all-row">
              <n-button size="small" quaternary block @click="viewAllChapters">
                {{ t('bookDetail.viewAllN', { n: store.chapters.length }) }}
              </n-button>
            </div>
          </div>
        </n-card>

        <!-- 阅读统计卡片 -->
        <n-card class="section-card" bordered>
          <template #header>
            <div class="card-header">
              <span>{{ t('bookDetail.sections.stats') }}</span>
            </div>
          </template>
          <div class="progress-content">
            <!-- 进度条 -->
            <div class="progress-row">
              <div class="progress-label">
                <span>{{ t('bookDetail.chaptersRatio', { read: readChapterCount, total: totalChapters }) }}</span>
                <span class="progress-percent">{{ progressPercent }}%</span>
              </div>
              <n-progress
                type="line"
                :percentage="progressPercent"
                :height="8"
                :border-radius="4"
                class="detail-progress"
              />
            </div>

            <!-- 统计网格 -->
            <div class="stats-grid">
              <div class="stat-item">
                <n-icon :component="Clock" :size="20" class="stat-icon" />
                <div class="stat-text">
                  <div class="stat-label">{{ t('bookDetail.stats.totalTime') }}</div>
                  <div class="stat-value">{{ readDurationText }}</div>
                </div>
              </div>
              <div class="stat-item">
                <n-icon :component="Hash" :size="20" class="stat-icon" />
                <div class="stat-text">
                  <div class="stat-label">{{ t('bookDetail.stats.chaptersRead') }}</div>
                  <div class="stat-value">
                    {{ t('bookDetail.chaptersRatio', { read: readChapterCount, total: totalChapters }) }}
                  </div>
                </div>
              </div>
              <div class="stat-item">
                <n-icon :component="Gauge" :size="20" class="stat-icon" />
                <div class="stat-text">
                  <div class="stat-label">{{ t('bookDetail.stats.speed') }}</div>
                  <div class="stat-value">{{ avgSpeedText }}</div>
                </div>
              </div>
              <div class="stat-item">
                <n-icon :component="BookIcon" :size="20" class="stat-icon" />
                <div class="stat-text">
                  <div class="stat-label">{{ t('bookDetail.stats.lastPosition') }}</div>
                  <div class="stat-value text-ellipsis" :title="lastReadChapterTitle">
                    {{ lastReadChapterTitle }}
                  </div>
                </div>
              </div>
              <div class="stat-item">
                <n-icon :component="Bookmark" :size="20" class="stat-icon" />
                <div class="stat-text">
                  <div class="stat-label">{{ t('bookDetail.sections.bookmarks') }}</div>
                  <div class="stat-value">{{ t('bookDetail.itemCount', { n: bookmarkCount }) }}</div>
                </div>
              </div>
              <div class="stat-item">
                <n-icon :component="Notebook" :size="20" class="stat-icon" />
                <div class="stat-text">
                  <div class="stat-label">{{ t('bookDetail.stats.notes') }}</div>
                  <div class="stat-value">{{ t('bookDetail.itemCount', { n: noteCount }) }}</div>
                </div>
              </div>
            </div>

            <!-- 最近7天阅读趋势（纯 CSS 柱状图） -->
            <div class="trend-section">
              <div class="trend-header">
                <span class="trend-title">
                  <n-icon :component="TrendingUp" :size="16" class="trend-title-icon" />
                  {{ t('bookDetail.trend.title') }}
                </span>
                <span class="trend-total">{{ t('bookDetail.trend.total', { duration: trendTotalText }) }}</span>
              </div>
              <div v-if="hasTrendData" class="trend-chart">
                <div v-for="bar in trendBars" :key="bar.date" class="trend-bar-col">
                  <div class="trend-bar-wrap">
                    <div
                      class="trend-bar"
                      :style="{ height: bar.heightPercent + '%' }"
                      :title="
                        t('bookDetail.trend.barTitle', {
                          date: bar.date,
                          duration: formatDuration(bar.duration)
                        })
                      "
                    ></div>
                  </div>
                  <span class="trend-bar-label">{{ bar.label }}</span>
                </div>
              </div>
              <div v-else class="trend-empty">{{ t('bookDetail.trend.empty') }}</div>
              <!-- 7天阅读字数总计 -->
              <div class="trend-chars-total">
                <n-icon :component="FileText" :size="14" class="trend-chars-icon" />
                <span>{{ t('bookDetail.trend.charsTotal', { chars: trendTotalCharsText }) }}</span>
              </div>
            </div>

            <!-- 阅读完成度环形进度条 -->
            <div class="completion-section">
              <div class="completion-ring-wrap">
                <svg class="completion-ring" viewBox="0 0 120 120">
                  <!-- 背景圆环 -->
                  <circle cx="60" cy="60" :r="RING_RADIUS" fill="none" stroke="var(--border-color)" stroke-width="8" />
                  <!-- 进度圆环 -->
                  <circle
                    cx="60"
                    cy="60"
                    :r="RING_RADIUS"
                    fill="none"
                    stroke="var(--primary)"
                    stroke-width="8"
                    stroke-linecap="round"
                    :stroke-dasharray="RING_CIRCUMFERENCE"
                    :stroke-dashoffset="ringDashOffset"
                    transform="rotate(-90 60 60)"
                    class="completion-ring-fill"
                  />
                </svg>
                <div class="completion-ring-text">
                  <div class="completion-ring-percent">{{ completionPercent }}%</div>
                  <div class="completion-ring-label">{{ t('bookDetail.stats.completion') }}</div>
                </div>
              </div>
              <div class="completion-detail">
                <div class="completion-detail-item">
                  <span class="completion-detail-label">{{ t('bookDetail.stats.chaptersRead') }}</span>
                  <span class="completion-detail-value">{{
                    t('bookDetail.chaptersCount', { n: readChapterCount })
                  }}</span>
                </div>
                <div class="completion-detail-item">
                  <span class="completion-detail-label">{{ t('bookDetail.stats.totalChapters') }}</span>
                  <span class="completion-detail-value">{{ t('bookDetail.chaptersCount', { n: totalChapters }) }}</span>
                </div>
              </div>
            </div>
          </div>
        </n-card>

        <!-- 相关推荐 -->
        <n-card v-if="store.relatedBooks.length > 0" class="section-card" bordered>
          <template #header>
            <div class="card-header">
              <span>
                <n-icon :component="BookIcon" :size="16" class="card-header-icon" />
                {{ t('bookDetail.sections.recommendations') }}
              </span>
            </div>
          </template>
          <div class="related-list">
            <div
              v-for="book in store.relatedBooks"
              :key="book.id"
              class="related-card"
              @click="goToRelatedBook(book.id)"
            >
              <img
                :src="getRelatedCoverUrl(book)"
                class="related-cover"
                :alt="t('bookDetail.cover.alt')"
                draggable="false"
                @error="onRelatedCoverError(book.id)"
              />
              <div class="related-info">
                <div class="related-title text-ellipsis" :title="book.title">{{ book.title }}</div>
                <div class="related-author text-ellipsis">
                  {{ book.author || t('common.words.unknown') }}
                </div>
                <n-tag size="tiny" :type="getRelationTagType(book.relation)" round class="related-tag">
                  {{ getRelationLabelText(book.relation) }}
                </n-tag>
              </div>
            </div>
          </div>
        </n-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════
   详情页根容器 — 固定 header + 内容滚动
   ═══════════════════════════════════════════════════════════════ */

.detail-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
}

/* 固定 header — 琉璃质感 */
.detail-header {
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

/* 内容滚动区 */
.detail-view {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: var(--spacing-xl);
  background: var(--bg-base);
}

/* 加载状态 */
.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

/* 错误状态 */
.error-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

/* 详情容器：居中限宽 800px */
.detail-container {
  max-width: 800px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

/* ═══════════════════════════════════════════════════════════════
   页面标题（在固定 header 中）
   ═══════════════════════════════════════════════════════════════ */

.page-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ═══════════════════════════════════════════════════════════════
   空状态（自定义样式，替代 NEmpty）
   ═══════════════════════════════════════════════════════════════ */

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
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

/* ═══════════════════════════════════════════════════════════════
   分区卡片
   ═══════════════════════════════════════════════════════════════ */

.section-card {
  border-radius: var(--border-radius);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
}

.card-header-icon {
  margin-right: var(--spacing-sm-md);
  vertical-align: calc(var(--spacing-2xs) * -1);
}

.header-action {
  margin-left: var(--spacing-sm);
}

/* 箭头右转图标（ArrowLeft 旋转 180deg 表示向右） */
.arrow-right-icon {
  transform: rotate(180deg);
}

/* 标签内图标间距 */
.tag-icon {
  margin-right: var(--spacing-xs);
}

/* ═══════════════════════════════════════════════════════════════
   头部卡片 — 封面 + 基本信息 + 简介 + 信息栏
   ═══════════════════════════════════════════════════════════════ */

.header-card {
  padding: var(--spacing-xs);
}

.header-layout {
  display: flex;
  gap: var(--spacing-lg);
  align-items: flex-start;
}

/* 大封面 180x240 */
.cover-wrap {
  flex-shrink: 0;
  width: 180px;
  height: 240px;
  border-radius: var(--border-radius);
  overflow: hidden;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-card);
  position: relative;
  cursor: pointer;
}

.cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* 封面 hover 遮罩层 — 使用 color-mix 基于 --text-primary 生成主题感知的深色半透明遮罩 */
.cover-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-6px);
  background: color-mix(in srgb, var(--text-primary) 55%, transparent);
  color: var(--bg-base);
  font-size: var(--font-size-sm-plus);
  opacity: 0;
  transition: opacity 0.25s ease;
  pointer-events: none;
}

.cover-wrap:hover .cover-overlay {
  opacity: 1;
  pointer-events: auto;
}

/* 封面操作按钮（更换封面 / 恢复默认） */
.cover-action-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-2xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: color-mix(in srgb, var(--bg-base) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--bg-base) 25%, transparent);
  border-radius: var(--border-radius-sm);
  color: var(--bg-base);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.cover-action-btn:hover {
  background: color-mix(in srgb, var(--bg-base) 25%, transparent);
  border-color: color-mix(in srgb, var(--bg-base) 40%, transparent);
}

/* 封面上传中状态 */
.cover-uploading {
  cursor: wait;
}

.cover-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--text-primary) 40%, transparent);
}

/* ═══════════════════════════════════════════════════════════════
   基本信息
   ═══════════════════════════════════════════════════════════════ */

.info-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm-md);
}

.info-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.title-row {
  align-items: center;
}

.book-title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  margin: 0;
  color: var(--text-primary);
  line-height: 1.3;
  word-break: break-word;
}

.author-row {
  font-size: var(--font-size-lg);
}

/* 系列行（v29：与作者行同级展示，"系列 · 第N卷/共M卷"） */
.series-row {
  font-size: var(--font-size-lg);
}

.info-label {
  color: var(--text-tertiary);
  flex-shrink: 0;
  font-size: var(--font-size-base);
}

.info-value {
  color: var(--text-secondary);
  font-size: var(--font-size-lg);
}

.edit-input {
  flex: 1;
  min-width: 0;
}

/* 标签行 */
.tags-row {
  flex-wrap: wrap;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-xs);
}

/* ═══════════════════════════════════════════════════════════════
   书籍来源标识（琉璃/玻璃透明质感标签）
   ═══════════════════════════════════════════════════════════════ */

.source-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-2xs);
  padding: var(--spacing-2xs) var(--spacing-sm);
  border-radius: var(--border-radius-sm);
  font-size: var(--font-size-sm);
  font-weight: 500;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid transparent;
  white-space: nowrap;
}

.source-badge-icon {
  flex-shrink: 0;
}

/* 在线书籍：蓝色琉璃质感 */
.source-badge-online {
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  border-color: color-mix(in srgb, var(--primary) 25%, transparent);
  color: var(--primary);
}

/* 已下载：绿色琉璃质感 */
.source-badge-downloaded {
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
  border-color: color-mix(in srgb, var(--color-success) 25%, transparent);
  color: var(--color-success);
}

/* ═══════════════════════════════════════════════════════════════
   来源信息行
   ═══════════════════════════════════════════════════════════════ */

.source-row {
  margin-top: var(--spacing-xs);
  gap: var(--spacing-sm);
}

.source-url {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.source-url:hover {
  color: var(--primary);
}

.copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: var(--border-radius-xs);
  transition:
    color 0.2s,
    background 0.2s;
  flex-shrink: 0;
}

.copy-btn:hover {
  color: var(--primary);
  background: var(--bg-active);
}

.copy-btn-done {
  color: var(--color-success);
}

/* ═══════════════════════════════════════════════════════════════
   下载状态行
   ═══════════════════════════════════════════════════════════════ */

.download-status-row {
  margin-top: var(--spacing-xs);
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}

.download-status-text {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  white-space: nowrap;
}

.download-status-active {
  color: var(--primary);
  font-weight: 500;
}

.download-progress-bar {
  flex: 1;
  min-width: 100px;
  max-width: 200px;
}

.download-progress-bar :deep(.n-progress__rail) {
  background: var(--border-color) !important;
}

.download-progress-bar :deep(.n-progress__fill) {
  background: var(--primary) !important;
}

/* 旋转动画（下载中 Loader 图标） */
.icon-spin {
  animation: icon-spin 1s linear infinite;
}

@keyframes icon-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 编辑按钮 */
.edit-actions {
  display: flex;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-sm);
}

/* ═══════════════════════════════════════════════════════════════
   个人评分
   ═══════════════════════════════════════════════════════════════ */

.rating-row {
  margin-top: var(--spacing-xs);
}

.rating-stars {
  display: flex;
  gap: var(--spacing-2xs);
}

.rating-star-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-tertiary);
  transition:
    color 0.2s ease,
    transform 0.15s ease;
  border-radius: var(--border-radius-xs);
}

.rating-star-btn:hover {
  transform: scale(1.15);
}

.rating-star-filled {
  color: var(--primary);
}

.rating-star-filled:hover {
  color: var(--primary);
}

/* ═══════════════════════════════════════════════════════════════
   阅读状态标记
   ═══════════════════════════════════════════════════════════════ */

.status-row {
  margin-top: var(--spacing-xs);
}

.status-buttons {
  display: flex;
  gap: var(--spacing-xs);
}

.status-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-2xs);
  padding: var(--spacing-2xs) var(--spacing-sm);
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-sm);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all 0.2s ease;
}

.status-btn:hover {
  background: var(--bg-active);
  border-color: var(--primary);
}

.status-btn-active {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--bg-base);
}

.status-btn-active:hover {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--bg-base);
}

/* ═══════════════════════════════════════════════════════════════
   简介区域
   ═══════════════════════════════════════════════════════════════ */

.intro-section {
  margin-top: var(--spacing-md-lg);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

.intro-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-sm);
}

.intro-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-secondary);
}

.intro-content {
  position: relative;
}

.intro-text {
  margin: 0;
  font-size: var(--font-size-base);
  line-height: 1.8;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 折叠状态：最多 4 行 */
.intro-text.intro-collapsed {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
}

/* 展开/收起按钮 */
.intro-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  margin-top: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: transparent;
  border: none;
  color: var(--primary);
  font-size: var(--font-size-sm-plus);
  cursor: pointer;
  border-radius: var(--border-radius-sm);
  transition: background 0.2s;
}

.intro-toggle:hover {
  background: var(--bg-active);
}

/* ═══════════════════════════════════════════════════════════════
   信息栏 — 章节数 / 进度 / 书签数 / 阅读时长
   ═══════════════════════════════════════════════════════════════ */

.info-bar {
  display: flex;
  align-items: center;
  justify-content: space-around;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-md);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

.info-bar-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex: 1;
  justify-content: center;
}

.info-bar-icon {
  color: var(--primary);
  flex-shrink: 0;
}

.info-bar-label {
  font-size: var(--font-size-sm-plus);
  color: var(--text-tertiary);
}

.info-bar-value {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
}

.info-bar-divider {
  width: 1px;
  height: 24px;
  background: var(--border-color);
  flex-shrink: 0;
}

/* ═══════════════════════════════════════════════════════════════
   章节预览
   ═══════════════════════════════════════════════════════════════ */

.chapter-preview {
  display: flex;
  flex-direction: column;
}

.chapter-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm-md);
  padding: var(--spacing-10px) var(--spacing-sm);
  border-radius: var(--border-radius-sm);
  cursor: pointer;
  transition: background 0.2s;
}

.chapter-item:hover {
  background: var(--bg-active);
}

.chapter-index {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  border-radius: 50%;
}

.chapter-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-base);
  color: var(--text-primary);
}

.chapter-current-icon {
  color: var(--primary);
  flex-shrink: 0;
}

.chapter-empty {
  padding: var(--spacing-lg) 0;
  text-align: center;
  font-size: var(--font-size-sm-plus);
  color: var(--text-tertiary);
}

.view-all-row {
  margin-top: var(--spacing-sm);
  padding-top: var(--spacing-sm);
  border-top: 1px solid var(--border-color);
}

/* ═══════════════════════════════════════════════════════════════
   阅读统计
   ═══════════════════════════════════════════════════════════════ */

.progress-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md-lg);
}

.progress-row {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.progress-label {
  display: flex;
  justify-content: space-between;
  font-size: var(--font-size-sm-plus);
  color: var(--text-secondary);
}

.progress-percent {
  color: var(--primary);
  font-weight: 600;
}

/* 进度条主题化：覆盖 Naive UI 默认颜色 */
.detail-progress :deep(.n-progress__rail) {
  background: var(--border-color) !important;
}
.detail-progress :deep(.n-progress__fill) {
  background: var(--primary) !important;
  transition: background 0.3s ease;
}

/* 统计网格 */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--spacing-md);
}

.stat-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm-md);
  padding: var(--spacing-sm-md);
  background: var(--bg-hover);
  border-radius: var(--border-radius);
}

.stat-icon {
  color: var(--primary);
  flex-shrink: 0;
}

.stat-text {
  flex: 1;
  min-width: 0;
}

.stat-label {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin-bottom: var(--spacing-2xs);
}

.stat-value {
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--text-primary);
}

/* ═══════════════════════════════════════════════════════════════
   最近7天阅读趋势（纯 CSS 柱状图）
   ═══════════════════════════════════════════════════════════════ */

.trend-section {
  margin-top: var(--spacing-md);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

.trend-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-md);
}

.trend-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-secondary);
}

.trend-title-icon {
  margin-right: var(--spacing-sm-md);
  vertical-align: calc(var(--spacing-2xs) * -1);
}

.trend-total {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.trend-chart {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-sm);
  height: 120px;
  padding: var(--spacing-sm) 0;
}

.trend-bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-6px);
  height: 100%;
}

.trend-bar-wrap {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  min-height: 0;
}

.trend-bar {
  width: 70%;
  min-height: 2px;
  background: linear-gradient(to top, var(--primary), color-mix(in srgb, var(--primary) 70%, transparent));
  border-radius: var(--border-radius-xs) var(--border-radius-xs) 0 0;
  transition: height 0.3s ease;
  opacity: 0.85;
}

.trend-bar-col:hover .trend-bar {
  opacity: 1;
}

.trend-bar-label {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.trend-empty {
  padding: var(--spacing-lg) 0;
  text-align: center;
  font-size: var(--font-size-sm-plus);
  color: var(--text-tertiary);
}

/* 7天阅读字数总计 */
.trend-chars-total {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  margin-top: var(--spacing-sm);
  padding-top: var(--spacing-sm);
  border-top: 1px solid var(--border-color);
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.trend-chars-icon {
  color: var(--primary);
}

/* ═══════════════════════════════════════════════════════════════
   阅读完成度环形进度条
   ═══════════════════════════════════════════════════════════════ */

.completion-section {
  display: flex;
  align-items: center;
  gap: var(--spacing-lg);
  margin-top: var(--spacing-md);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

.completion-ring-wrap {
  position: relative;
  width: 120px;
  height: 120px;
  flex-shrink: 0;
}

.completion-ring {
  width: 100%;
  height: 100%;
}

.completion-ring-fill {
  transition: stroke-dashoffset 0.5s ease;
}

.completion-ring-text {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.completion-ring-percent {
  font-size: var(--font-size-xl);
  font-weight: 700;
  color: var(--primary);
  line-height: 1;
}

.completion-ring-label {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  margin-top: var(--spacing-2xs);
}

.completion-detail {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.completion-detail-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.completion-detail-label {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.completion-detail-value {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
}

/* ═══════════════════════════════════════════════════════════════
   相关推荐
   ═══════════════════════════════════════════════════════════════ */

.related-list {
  display: flex;
  gap: var(--spacing-md);
  overflow-x: auto;
  padding-bottom: var(--spacing-xs);
  scrollbar-width: thin;
}

.related-list::-webkit-scrollbar {
  height: 6px;
}

.related-list::-webkit-scrollbar-thumb {
  background: var(--border-color);
  border-radius: var(--border-radius-xs);
}

.related-list::-webkit-scrollbar-track {
  background: transparent;
}

.related-card {
  flex-shrink: 0;
  width: 120px;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm);
  border-radius: var(--border-radius);
  cursor: pointer;
  transition:
    background 0.2s,
    box-shadow 0.2s;
  background: var(--bg-hover);
}

.related-card:hover {
  background: var(--bg-active);
  box-shadow: var(--shadow-card);
}

.related-cover {
  width: 100%;
  height: 168px;
  object-fit: cover;
  border-radius: var(--border-radius-sm);
  display: block;
  background: var(--bg-elevated);
}

.related-info {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.related-title {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-primary);
  line-height: 1.3;
}

.related-author {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.related-tag {
  align-self: flex-start;
}

/* ═══════════════════════════════════════════════════════════════
   主操作按钮区 — 顶部信息卡内（开始阅读 + 下载章节 + 更多菜单）
   ═══════════════════════════════════════════════════════════════ */

.primary-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-sm-md);
  margin-top: var(--spacing-md);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

.primary-action-btn {
  flex: 1;
  min-width: 120px;
  max-width: 100%;
}

/* 主按钮（开始阅读）占据更多空间 */
.primary-actions > .n-button--primary-type {
  flex: 2;
  min-width: 200px;
}

/* ═══════════════════════════════════════════════════════════════
   link 书失效提示 + 存储模式区（P2 导入三模式）
   ═══════════════════════════════════════════════════════════════ */

/* 失效提示条（书架批量检查结果联动，置顶醒目但不打断布局） */
.missing-alert {
  margin-bottom: var(--spacing-md);
}

/* 存储模式区：一行模式标签 + 说明 + 转换/搜索按钮（克制样式） */
.storage-section {
  margin-top: var(--spacing-sm-md);
  padding-top: var(--spacing-sm-md);
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.storage-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.storage-header-icon {
  color: var(--text-tertiary);
}

.storage-title {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-secondary);
}

.storage-desc {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  line-height: 1.5;
}

.storage-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
  margin-top: var(--spacing-2xs);
}
</style>
