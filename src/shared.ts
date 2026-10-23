/**
 * 共享常量与类型定义（主进程与渲染进程共享）
 *
 * 合并自 highlight-colors.ts 和 theme-colors.ts
 *
 * ━━━ 高亮颜色系统 ━━━
 * 统一定义6种高亮颜色，供 Reader.vue、BookmarkBar.vue、ScrollView.vue、PageView.vue 共用。
 *
 * 设计要点：
 *   1. swatch — UI 选择器中显示的不透明色块颜色（按钮上的小圆点）
 *   2. markBg — 正文 <mark> 标签的背景色（半透明 rgba，0.35 透明度）
 *      半透明设计使颜色在浅色背景上柔和、在深色背景上自动混合变暗，适配所有主题
 *   3. color: inherit — <mark> 默认 color:black 会在深色主题下导致文字不可见，必须继承父元素颜色
 *
 * 关键 Bug 修复：
 *   高亮 CSS class 必须定义在全局 CSS（main.css）中，不能放在 <style scoped> 里。
 *   因为 <mark> 标签通过 v-html 渲染，Vue scoped CSS 依赖 data-v-xxx 属性选择器，
 *   v-html 插入的内容没有该属性，导致 scoped CSS 无法匹配，所有颜色回退到 <mark> 默认黄色。
 *
 * ━━━ 主题颜色系统 ━━━
 * 这是主题系统的唯一源头——所有主题颜色值在此定义。
 * 修改主题颜色只需修改此文件，全局自动同步。
 *
 * 架构设计：
 *   1. 每个主题只需定义3个基础值（bg/text/primary）
 *   2. deriveThemeColors() 从基础值自动派生出所有语义令牌（22个）
 *   3. App.vue 只做映射（令牌→Naive UI属性/CSS变量），不做计算
 *   4. 修改任何颜色只需改此文件
 *
 * 语义令牌分层：
 *   - 基础层：bg, text, primary（每个主题自定义）
 *   - 背景层：bgTitlebar, bgReader, cardBg, elevatedBg（从 bg 派生）
 *   - 边框层：borderSubtle, borderDefault, borderInteractive, borderPrimary
 *   - 状态层：stateHover, stateActive, statePrimaryActive
 *   - 主色层：primaryHover, primaryPressed, primaryTag, primaryOverlay
 *   - 文字层：textSecondary, textTertiary, textPlaceholder
 *   - 功能层：colorDanger, colorDangerStrong, colorSuccess
 */

// ═══════════════════════════════════════════════════════════
// 高亮颜色系统
// ═══════════════════════════════════════════════════════════

export interface HighlightColorOption {
  key: string;
  label: string;
  swatch: string; // UI色块按钮显示的颜色（不透明）
  markBg: string; // 正文mark标签背景色（半透明rgba）
}

export const HIGHLIGHT_COLORS: HighlightColorOption[] = [
  { key: 'yellow', label: '黄色', swatch: '#ffe066', markBg: 'rgba(255, 224, 102, 0.35)' },
  { key: 'green', label: '绿色', swatch: '#69db7c', markBg: 'rgba(105, 219, 124, 0.35)' },
  { key: 'blue', label: '蓝色', swatch: '#74c0fc', markBg: 'rgba(116, 192, 252, 0.35)' },
  { key: 'pink', label: '粉色', swatch: '#faa2c1', markBg: 'rgba(250, 162, 193, 0.35)' },
  { key: 'purple', label: '紫色', swatch: '#b197fc', markBg: 'rgba(177, 151, 252, 0.35)' },
  { key: 'orange', label: '橙色', swatch: '#ffa94d', markBg: 'rgba(255, 169, 77, 0.35)' }
];

/** key → swatch 映射（UI色块按钮颜色、BookmarkBar竖条颜色） */
export const HIGHLIGHT_SWATCH: Record<string, string> = Object.fromEntries(
  HIGHLIGHT_COLORS.map((c) => [c.key, c.swatch])
);

/** key → CSS class 映射（mark标签的class名） */
export const HIGHLIGHT_COLOR_CLASS: Record<string, string> = Object.fromEntries(
  HIGHLIGHT_COLORS.map((c) => [c.key, `highlight-${c.key}`])
);

// ═══════════════════════════════════════════════════════════
// 主题颜色系统
// ═══════════════════════════════════════════════════════════

// ─── 颜色工具函数（纯函数，不依赖任何运行时 API） ───

interface RgbComponents {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): RgbComponents | null {
  const m: RegExpMatchArray | null = hex.replace('#', '').match(/^([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  let h: string = m[1];
  if (h.length === 3) {
    h = h
      .split('')
      .map((c: string): string => c + c)
      .join('');
  }
  const n: number = parseInt(h, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((c: number): string => c.toString(16).padStart(2, '0')).join('');
}

function clamp(n: number): number {
  return Math.max(0, Math.min(255, n));
}

function adjustBg(hex: string, amount: number): string {
  const rgb: RgbComponents | null = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(
    clamp(Math.round(rgb.r + 255 * amount)),
    clamp(Math.round(rgb.g + 255 * amount)),
    clamp(Math.round(rgb.b + 255 * amount))
  );
}

function isDarkBg(hex: string): boolean {
  const rgb: RgbComponents | null = hexToRgb(hex);
  if (!rgb) return true;
  const luma: number = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  return luma < 128;
}

// ─── 类型定义 ───

export type ThemeType = 'day' | 'night' | 'eye' | 'parchment' | 'research' | 'custom';

export interface ThemeColors {
  // 基础值（每个主题自定义）
  bg: string;
  text: string;
  primary: string;

  // 背景层次（从 bg 派生）
  bgTitlebar: string;
  bgReader: string;
  cardBg: string;
  elevatedBg: string;

  // 边框（中性色 + 主色）
  borderSubtle: string;
  borderDefault: string;
  borderInteractive: string;
  borderPrimary: string;

  // 交互状态（中性色 + 主色）
  stateHover: string;
  stateActive: string;
  statePrimaryActive: string;

  // 主色衍生
  primaryHover: string;
  primaryPressed: string;
  primaryTag: string;
  primaryOverlay: string;

  // 文字层次（从 text 派生）
  textSecondary: string;
  textTertiary: string;
  textPlaceholder: string;

  // 功能色
  colorDanger: string;
  colorDangerStrong: string;
  colorSuccess: string;
}

// ─── 派生函数 ───

/**
 * 从3个基础值派生出完整的22个语义令牌
 *
 * 派生规则：
 *   - 深色主题（isDark=true）：背景层次向上提亮，边框/状态用白色透明度
 *   - 浅色主题（isDark=false）：背景层次向下压暗，边框/状态用黑色透明度
 *   - 主色衍生：hover提亮8%，pressed压暗8%，tag/overlay用主色透明度
 *   - 文字层次：secondary向bg方向靠15%，tertiary靠35%，placeholder用text 40%透明度
 */
export function deriveThemeColors(base: { bg: string; text: string; primary: string }): ThemeColors {
  const isDark: boolean = isDarkBg(base.bg);
  const pr: RgbComponents | null = hexToRgb(base.primary);
  const pR: number = pr?.r ?? 139;
  const pG: number = pr?.g ?? 92;
  const pB: number = pr?.b ?? 246;
  const tr: RgbComponents | null = hexToRgb(base.text);
  const tR: number = tr?.r ?? 51;
  const tG: number = tr?.g ?? 51;
  const tB: number = tr?.b ?? 51;

  return {
    // 基础
    bg: base.bg,
    text: base.text,
    primary: base.primary,

    // 背景层次
    bgTitlebar: adjustBg(base.bg, isDark ? 0.03 : -0.04),
    bgReader: adjustBg(base.bg, isDark ? 0.02 : -0.02),
    cardBg: adjustBg(base.bg, isDark ? 0.06 : -0.03),
    elevatedBg: adjustBg(base.bg, isDark ? 0.12 : -0.06),

    // 边框
    borderSubtle: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    borderDefault: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
    borderInteractive: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)',
    borderPrimary: `rgba(${pR},${pG},${pB},${isDark ? 0.2 : 0.15})`,

    // 交互状态
    stateHover: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
    stateActive: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
    statePrimaryActive: `rgba(${pR},${pG},${pB},${isDark ? 0.15 : 0.12})`,

    // 主色衍生
    primaryHover: adjustBg(base.primary, 0.08),
    primaryPressed: adjustBg(base.primary, -0.08),
    primaryTag: `rgba(${pR},${pG},${pB},${isDark ? 0.1 : 0.08})`,
    primaryOverlay: `rgba(${pR},${pG},${pB},${isDark ? 0.18 : 0.15})`,

    // 文字层次
    textSecondary: adjustBg(base.text, isDark ? -0.15 : 0.15),
    textTertiary: adjustBg(base.text, isDark ? -0.35 : 0.35),
    textPlaceholder: `rgba(${tR},${tG},${tB},0.4)`,

    // 功能色
    colorDanger: '#f56565',
    colorDangerStrong: isDark ? '#ff4444' : '#e81123',
    colorSuccess: '#52c41a'
  };
}

// ─── 主题定义（每个主题只需3个基础值，其余自动派生） ───

export const THEME_COLORS: Record<ThemeType, ThemeColors> = {
  day: deriveThemeColors({ bg: '#f5f3f0', text: '#333333', primary: '#8b5cf6' }),
  night: deriveThemeColors({ bg: '#16151f', text: '#e6e6e6', primary: '#6366f1' }),
  eye: deriveThemeColors({ bg: '#c7edcc', text: '#333333', primary: '#5a9c4e' }),
  parchment: deriveThemeColors({ bg: '#f4ecd8', text: '#5b4636', primary: '#b8860b' }),
  research: deriveThemeColors({ bg: '#f7f8fa', text: '#1a1a1a', primary: '#2c5282' }),
  custom: deriveThemeColors({ bg: '#16151f', text: '#e6e6e6', primary: '#6366f1' })
};

// ═══════════════════════════════════════════════════════════
// 核心实体类型（主进程与渲染进程共享，与 DB 表行结构一致）
// ═══════════════════════════════════════════════════════════

/**
 * 导入三模式（批次 v54，DB schema v26）
 *
 * - copy：复制文件到应用数据目录（默认，原行为）。数据自包含，删原目录无影响，占用双倍空间。
 * - move：把文件移入应用数据目录（同盘 rename 瞬间完成；跨盘复制成功后删源文件）。
 *         导入后原目录不再有此文件，运行时行为与 copy 完全一致。
 * - link：引用模式，文件保持原位不复制，local_file_path 指向原路径。零复制空间，
 *         但移动/删除原文件或拔出存储设备会导致书籍失效（打开时返回 FILE_MISSING
 *         结构化错误，前端弹重新定位对话框恢复）。
 */
export type ImportMode = 'copy' | 'move' | 'link';

/**
 * books 表行类型（与 DB books 表行结构一致，由 dbApi.book.list 返回）
 *
 * 字段名保持 snake_case，与 DB 表行结构一致。
 */
export interface Book {
  id: number;
  group_id: number | null;
  source_id: number | null;
  source_book_id: string | null;

  title: string;
  author: string | null;
  cover: string | null;
  intro: string | null;
  catalog_url: string | null;
  local_file_path: string | null;
  file_type: string | null;
  encoding: string | null;
  total_chapters: number | null;
  custom_meta: string | null;
  file_hash: string | null;
  sort_order: number;
  last_read_at: number | null;
  reading_status: string | null;
  rating: number | null;
  is_comic: number;
  /** v21 新增：书籍内容三分类 'text'=文本, 'illustrated'=图文, 'comic'=漫画。
   *  旧数据通过迁移填充：is_comic=1 → 'comic'，其余 → 'text'。
   *  is_comic 保留向后兼容（= content_type === 'comic' ? 1 : 0）。 */
  content_type: 'text' | 'illustrated' | 'comic' | null;
  /** v11 新增：关联订阅源 id（null=非订阅导入） */
  subscription_id: number | null;
  /** v11 新增：标记有新更新（0=无, 1=有，书架显示更新徽章） */
  has_update: number;
  /** v11 新增：在线源的原始URL（folder 类型无此字段） */
  source_url: string | null;
  /** v12 新增：书籍来源 'local'=本地, 'online'=在线, 'download'=下载 */
  book_source: 'local' | 'online' | 'download' | null;
  /**
   * v26 新增（批次 v54）：导入存储模式。
   * 'copy'=复制（默认，副本在 userData）；'move'=移动（导入后文件在 userData，运行时与 copy 一致）；
   * 'link'=引用（文件留在原目录，local_file_path 指向原路径，打开时 existsSync 校验失效）。
   */
  import_mode: ImportMode | null;
  /** v29 新增：系列名（ComicInfo.xml 的 Series，或导入层文件名模式提取，如"哆啦A梦[大长篇][台版]"）。
   *  格式无关通用字段，同名系列书在书架按"系列 · 第N卷"区分并自然排序。 */
  series: string | null;
  /** v29 新增：系列内序号（卷号；REAL 语义支持小数卷号，如 ComicInfo Number="2.5"） */
  series_number: number | null;
  /** v29 新增：系列总数（ComicInfo.xml 的 Count，详情页"第N卷/共M卷"展示用） */
  series_total: number | null;
  /** 书籍分类（listBooks 查询时计算，非数据库字段）：comic=漫画, illustrated=图文, text=小说。
   *  v21 起优先使用 content_type 字段，book_category 作为查询时计算字段保留兼容。 */
  book_category?: 'comic' | 'illustrated' | 'text';
  created_at: number | null;
  updated_at: number | null;
}

/**
 * bookmarks 表行类型（与 DB bookmarks 表行结构一致）
 *
 * 字段名保持 snake_case，与 DB 表行结构一致。
 */
export interface Bookmark {
  id: number;
  book_id: number;
  chapter_index: number;
  position: number | null;
  content: string | null;
  note: string | null;
  highlight_color: string | null;
  created_at: number | null;
}

/**
 * 章节索引（不含 content，目录用，与 DB chapters 表行结构一致）
 *
 * 字段名保持 snake_case，与 DB 表行结构一致。
 */
/**
 * 章节图片（图片型阅读器 ComicViewer 的数据单元）
 *
 * v49：新增 width/height —— 主流阅读器（PDF.js/Preview/Mihon）在像素加载前
 * 就知道每页几何，占位高度用真实宽高比精确计算（aspect-ratio），滚动条稳定、
 * 进度准确、懒加载预判可靠；此前固定 min-height:100vh 占位低估真实高度约 2 倍，
 * 导致图片加载后高度突变（滚动跳动/进度失真）。
 * width/height 为 0 表示尺寸未知（读取失败），前端回退 100vh 估计占位。
 */
export interface ChapterImage {
  /** 图片文件绝对路径 */
  path: string;
  /** 图片宽度（px；0=未知） */
  width: number;
  /** 图片高度（px；0=未知） */
  height: number;
  /**
   * 该页尚未渲染（分批渐进加载占位）。
   *
   * v53：扫描版 PDF 一章 5-20 页，主进程整章预渲染（scale2 + WebP，每页数百 ms）
   * 导致点击章节后白屏等待数秒。分批方案：首批只渲染前几页，其余页返回
   * { path:'', width:0, height:0, pending:true } 占位条目，前端数组长度仍等于
   * 章节总页数（滚动条/页码/占位高度不乱），滚动/翻页接近时按需续载（幂等）。
   * 仅 PDF 渲染路径产生 pending；EPUB/MOBI/CBZ 提取原文件无渲染概念。
   */
  pending?: boolean;
}

/**
 * 合并续载结果到当前图片列表（v53 分批渐进加载，纯函数，供探针/单测）
 *
 * 语义约定（主进程组装规则保证）：
 * - updated 的非 pending 条目序列 ⊇ current 的（幂等：已渲染页集合单调不减，
 *   条目内容不变，页序一致）
 * - 近空白页在渲染后不占槽位 → 列表长度可能缩短（updated.length ≤ current.length
 *   当有新渲染的空白页时）
 *
 * 算法（"pending 队列对齐"）：非 pending 条目直接采用 updated 的最新值；
 * pending 槽位从 current 依序保留占位（维持数组长度语义），updated 末尾多出的
 * pending（不该发生，防御性）原样保留。
 *
 * @param current 前端当前列表（含 pending 占位）
 * @param updated 主进程返回的完整列表
 * @returns 合并后的新数组（调用方负责以 splice 原地写回以保持数组引用）
 */
export function mergeChapterImages(current: ChapterImage[], updated: ChapterImage[]): ChapterImage[] {
  const pendingSlots = current.filter((e) => e.pending);
  let qi = 0;
  const merged: ChapterImage[] = [];
  for (const e of updated) {
    if (e.pending) {
      merged.push(qi < pendingSlots.length ? pendingSlots[qi] : e);
      qi++;
    } else {
      merged.push(e);
    }
  }
  return merged;
}

export interface ChapterIndex {
  id: number;
  book_id: number;
  chapter_index: number;
  title: string | null;
  file_offset: number | null;
  file_length: number | null;
  url: string | null;
  content_type: string | null;
  volume: string | null;
  cached_at: number | null;
}

/**
 * 解析 link 书失效结构化错误消息（批次 v54 导入三模式，纯函数，供渲染端/单测）
 *
 * 主进程 FileMissingError 把结构化信息编进 message（wrapHandler 只透传 message）：
 *   message = '[FILE_MISSING]' + JSON.stringify({ bookId, path, hash })
 * 前端 catch 后用本函数解析；非 FILE_MISSING 消息返回 null（走普通错误分支）。
 *
 * @param message IPC 错误消息
 * @returns { bookId, path, hash }；非失效错误返回 null
 */
export function parseFileMissingMessage(message: string): { bookId: number; path: string; hash: string | null } | null {
  // 与主进程 FileMissingError 的编码格式严格一致（chapter-reader.ts）：
  // message = '[FILE_MISSING]' + JSON.stringify({ bookId, path, hash })
  const prefix = '[FILE_MISSING]';
  if (!message.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(message.slice(prefix.length)) as {
      bookId?: unknown;
      path?: unknown;
      hash?: unknown;
    };
    if (typeof parsed.bookId !== 'number' || !Number.isInteger(parsed.bookId) || parsed.bookId <= 0) return null;
    if (typeof parsed.path !== 'string' || parsed.path.length === 0) return null;
    return { bookId: parsed.bookId, path: parsed.path, hash: typeof parsed.hash === 'string' ? parsed.hash : null };
  } catch {
    // 消息体非合法 JSON（非本错误透传）→ 走普通错误分支
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// IPC 通道常量（主进程与 preload 共享，实现编译时校验）
// ═══════════════════════════════════════════════════════════

export const IPC_CHANNELS = {
  // 窗口控制
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',

  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:isMaximized',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggleMaximize',
  /** 窗口最大化状态变化通知（主进程 → 渲染进程，单向 send） */
  WINDOW_MAXIMIZE_CHANGED: 'window:maximizeChanged',

  /**
   * 窗口关闭前进度 flush 通知（主进程 → 渲染进程，单向 send）。
   * 根因②（点 X 关窗口进度丢失）：主进程 close 事件拦截后发送，渲染端
   * 收到后应立即保存阅读进度（store 缓存值兜底），完成后回执
   * WINDOW_CLOSE_FLUSH_DONE；主进程等待回执或超时后销毁窗口。
   */
  WINDOW_BEFORE_CLOSE_FLUSH: 'window:before-close-flush',
  /** 渲染端进度 flush 完成回执（渲染进程 → 主进程，invoke 型） */
  WINDOW_CLOSE_FLUSH_DONE: 'window:close-flush-done',

  /** 主进程 → 渲染进程：退出前停止所有播放（TTS/音频），单向 send */
  APP_STOP_PLAYBACK: 'app:stopPlayback',
  /** 切换窗口全屏状态（渲染进程 → 主进程） */
  WINDOW_TOGGLE_FULLSCREEN: 'window:toggleFullscreen',
  /** 查询窗口是否全屏（渲染进程 → 主进程） */
  WINDOW_IS_FULLSCREEN: 'window:isFullscreen',
  /** 窗口全屏状态变化通知（主进程 → 渲染进程，单向 send） */
  WINDOW_FULLSCREEN_CHANGED: 'window:fullscreenChanged',

  // 书籍
  /** 全文搜索：在书籍所有章节内容中搜索关键词（P1，对标 Kindle/Apple Books） */
  BOOK_SEARCH: 'book:search',

  /** 按需读取章节正文（M6：从原文件读取，缓存到 DB） */
  BOOK_READ_CHAPTER: 'book:readChapter',

  /** 取消书籍的所有章节读取任务（切换书时调用，避免旧任务占用 CPU） */
  BOOK_CANCEL_READS: 'book:cancelReads',
  /** 清理书籍在 worker 中的缓存（书籍关闭时调用，释放内存） */
  BOOK_CLEAR_WORKER_CACHE: 'book:clearWorkerCache',
  /** P3：用户手动修正内容分类（文字/图文/漫画/扫描版）+ 记录反馈样本 */
  BOOK_SET_CONTENT_TYPE: 'book:setContentType',
  /** 重新分章（M9：重新解析文件并更新章节索引） */
  BOOK_REPARSE: 'book:reparse',
  /**
   * 重新定位（批次 v54 导入三模式）：link 书原文件失效后，校验新路径哈希与
   * books.file_hash 一致则静默更新 local_file_path（无感恢复）。
   * 参数：(bookId, newPath)，返回 { success, error? }：
   *   error='FILE_NOT_FOUND' 新路径不存在；'HASH_MISMATCH' 所选文件与原书不一致
   */
  BOOK_RELOCATE: 'book:relocate',
  /**
   * 批量检查 link 书失效（P2 导入三模式，设计文档第二节第 2 层检测）：
   * 查全部 import_mode='link' 的书逐本 existsSync（轻量，不读文件内容），
   * 返回 { bookId, missing }[]。渲染端书架挂载 30s 后异步调用，
   * 结果存 store 供封面 ⚠ 角标与详情页提示消费。
   */
  BOOK_CHECK_LINKS: 'book:checkLinks',
  /**
   * 目录递归深度搜索（P2 导入三模式，设计文档第二节第 3 层深度恢复）：
   * 在用户指定目录按 books.file_hash 递归查找原文件（深度≤6、单目录条目
   * 上限 10000、跳过 node_modules/隐藏目录；先按文件大小过滤再哈希），
   * 找到返回 { success:true, path }，未找到/超时(30s)返回结构化 error。
   * 参数：(bookId, startDir)
   */
  BOOK_SEARCH_FILE: 'book:searchFile',
  /**
   * copy↔link 存储模式转换（P2 导入三模式，设计文档第六节 #9）：
   * - copy/move→link：需提供原文件路径 newSrcPath，哈希校验一致后
   *   UPDATE local_file_path+import_mode，再删 userData 副本（isPathSafe
   *   护栏）释放空间，返回 { freedBytes }
   * - link→copy：复用 importBookFile copy 分支（.tmp 原子落位）复制到
   *   userData，成功后 UPDATE，原文件保留不动，返回 { copiedBytes }
   * 中间态保护：UPDATE 一律在文件操作（校验/复制）成功之后。
   * 参数：(bookId, targetMode, newSrcPath?)
   */
  BOOK_CONVERT_IMPORT_MODE: 'book:convertImportMode',
  /** 导出书籍文件（复制原始文件到用户选择的目录） */
  BOOK_EXPORT: 'book:export',
  /** 设置自定义封面（复制图片到 data/covers/，更新 book.cover） */
  BOOK_SET_COVER: 'book:setCover',
  /**
   * 批量重新分类（任务40）：invoke 启动全库 PDF 重检 —— 逐本重采文档信号
   * （producer/书签/文本/图片颜色）并按最新决策树重判 content_type/is_comic。
   * ⚠️ 只改分类标签与 custom_meta.classify_signals，绝不重新分章（不破坏阅读进度）。
   * 串行执行（约 115ms/本），进度经 BOOK_RECLASSIFY_PROGRESS 推送，可随时取消。
   * 返回：{ processed, changed, skipped, failed, cancelled }
   */
  BOOK_RECLASSIFY_ALL: 'book:reclassify-all',
  /**
   * 主进程 → 渲染进程：批量重检进度事件（每本完成后推送）：
   * { current, total, bookId, title, from, to, changed, done? }
   *   from/to 为分类标签（'text'|'illustrated'|'comic'，null 归一为 'unknown'）
   */
  BOOK_RECLASSIFY_PROGRESS: 'book:reclassify-progress',
  /** 批量重新分类取消（invoke）：设置取消标志，当前书判定完成后停止，剩余书不再处理 */
  BOOK_RECLASSIFY_CANCEL: 'book:reclassify-cancel',

  // 阅读进度（M6）
  PROGRESS_SAVE: 'progress:save',
  PROGRESS_LOAD: 'progress:load',

  // 书签笔记（M7）
  BOOKMARK_ADD: 'bookmark:add',
  BOOKMARK_LIST: 'bookmark:list',
  BOOKMARK_REMOVE: 'bookmark:remove',

  // Shell
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',

  // 应用信息
  APP_GET_VERSION: 'app:getVersion',
  APP_GET_PATHS: 'app:getPaths',
  APP_SELECT_DIRECTORY: 'app:selectDirectory',
  /** 在系统文件管理器中打开应用数据目录（枚举白名单，主进程解析路径） */
  APP_OPEN_PATH: 'app:openPath',
  /** 数据目录迁移：移动 books/covers/youdu.db 到新目录并写入 youdu-config.json（剪切语义） */
  APP_MIGRATE_DATA: 'app:migrateData',
  /** 主进程 → 渲染进程：数据迁移进度事件（current/total/entry/done） */
  APP_MIGRATE_PROGRESS: 'app:migrate-progress',

  // 分组（M2）
  GROUP_LIST: 'group:list',
  GROUP_CREATE: 'group:create',
  GROUP_UPDATE: 'group:update',
  GROUP_DELETE: 'group:delete',
  GROUP_REORDER: 'group:reorder',

  // 书架/书籍（M2 数据层，M4 接入业务）
  BOOK_LIST: 'book:list',
  BOOK_GET: 'book:get',
  BOOK_CREATE: 'book:create',
  BOOK_UPDATE: 'book:update',
  BOOK_DELETE: 'book:delete',
  BOOK_BATCH_DELETE: 'book:batchDelete',
  BOOK_BATCH_MOVE: 'book:batchMove',
  BOOK_TOUCH_READ: 'book:touchRead',
  /** 获取相关推荐书籍（同作者/相似书名/阅读历史关联） */
  BOOK_GET_RELATED: 'book:getRelated',

  // 章节（M2）
  CHAPTER_LIST_INDEXES: 'chapter:listIndexes',
  CHAPTER_GET_CONTENT: 'chapter:getContent',
  /** 读取章节图片（漫画模式） */
  CHAPTER_READ_IMAGES: 'chapter:readImages',
  /**
   * 续载章节图片（幂等）：渲染请求页中仍缺失的页，返回更新后的完整列表。
   * 配合 CHAPTER_READ_IMAGES 的 initialPages 分批使用（v53 渐进加载）。
   */
  CHAPTER_ENSURE_IMAGES: 'chapter:ensureImages',
  /**
   * 保存章节图片到用户指定位置（P0 竞品对标 Mihon：图片右键"保存当前页"）。
   * 源路径经 isPathSafe 校验（userData 自管目录内，防任意文件复制），
   * 目标路径由系统保存对话框选择（默认 Downloads + 建议文件名）。
   */
  CHAPTER_SAVE_IMAGE: 'chapter:saveImage',
  /**
   * 获取章节缩略图列表（P0 竞品对标：缩略图面板 thumb_180 小图缓存）：
   * 仅对已落盘的章节图片懒生成 180px 宽小图（幂等：thumb 已存在跳过），
   * 未渲染页返回 pending 占位（不触发渲染，前端灰块显示）。
   */
  CHAPTER_THUMBNAILS: 'chapter:thumbnails',

  // 书签笔记（M2）

  BOOKMARK_UPDATE: 'bookmark:update',

  // 设置（M2）
  SETTING_GET: 'setting:get',
  SETTING_SET: 'setting:set',

  SETTING_DELETE: 'setting:delete',

  // 内容替换规则（v18 新增，支持全局/单本书 A→B 替换）
  /** 添加内容替换规则 */
  REPLACE_RULE_ADD: 'replaceRule:add',
  /** 查询全部内容替换规则（设置页面用） */
  REPLACE_RULE_LIST: 'replaceRule:list',
  /** 删除内容替换规则 */
  REPLACE_RULE_DELETE: 'replaceRule:delete',
  /** 启停内容替换规则 */
  REPLACE_RULE_TOGGLE: 'replaceRule:toggle',

  // 阅读会话（v6 新增，阅读统计分析）
  /** 创建阅读会话（阅读器退出时调用） */
  READING_SESSION_CREATE: 'readingStats:create',
  /** 查询某书阅读统计汇总（总时长/总字数/总章节数/session 数） */
  READING_SESSION_STATS: 'readingStats:stats',
  /** 查询某书最近 N 天的按天阅读统计（用于趋势图） */
  READING_SESSION_DAILY: 'readingStats:bookDaily',

  // 阅读统计仪表盘（全局统计，跨书籍聚合）
  /** 全局阅读统计汇总（总时长/总次数/总字数/平均速度） */
  READING_STATS_GLOBAL: 'readingStats:global',
  /** 今日阅读统计（时长/次数/字数） */
  READING_STATS_TODAY: 'readingStats:today',
  /** 最近 N 天阅读统计（时长/次数/字数） */
  READING_STATS_RANGE: 'readingStats:range',
  /** 跨所有书籍按天聚合的阅读统计（用于热图） */
  READING_STATS_DAILY: 'readingStats:daily',
  /** 阅读连续天数（打卡 streak） */
  READING_STATS_STREAK: 'readingStats:streak',
  /** 最常阅读的书籍 Top N */
  READING_STATS_TOP_BOOKS: 'readingStats:topBooks',

  // 书籍格式导出/缓存管理
  EXPORT_CLEAR_CACHE: 'export:clearCache',
  /** 导出单本书为 TXT（按章节拼接，含章节标题） */
  EXPORT_BOOK_TXT: 'export:bookTxt',
  /** 导出单本书为 EPUB（使用 epub-gen 库生成） */
  EXPORT_BOOK_EPUB: 'export:bookEpub',
  /** 导出单本漫画为 CBZ（ZIP 包含所有图片，漫画专用格式） */
  EXPORT_BOOK_CBZ: 'export:bookCbz',
  /** 导出书籍源文件（复制 books.local_file_path 原始文件到用户选择的位置） */
  EXPORT_BOOK_SOURCE: 'export:bookSource',

  // 文件导入（M4）
  IMPORT_SELECT_FILES: 'import:selectFiles',
  IMPORT_SELECT_DIRECTORY: 'import:selectDirectory',
  IMPORT_SELECT_IMAGE: 'import:selectImage',
  IMPORT_FILES: 'import:files',
  IMPORT_DIRECTORY: 'import:directory',
  /** 主进程 → 渲染进程：导入进度推送 */
  IMPORT_PROGRESS: 'import:progress',
  /** 主进程 → 渲染进程：单本书导入成功事件（后台增量显示用） */
  IMPORT_BOOK_ADDED: 'import:bookAdded',
  /** 主进程 → 渲染进程：批量导入完成事件 */
  IMPORT_COMPLETE: 'import:complete',

  // 订阅源（v11 新增）
  /** 添加订阅 */
  SUBSCRIPTION_ADD: 'subscription:add',
  /** 移除订阅 */
  SUBSCRIPTION_REMOVE: 'subscription:remove',
  /** 列出全部订阅 */
  SUBSCRIPTION_LIST: 'subscription:list',

  /** 更新订阅配置 */
  SUBSCRIPTION_UPDATE: 'subscription:update',
  /** 手动检查单个订阅更新 */
  SUBSCRIPTION_CHECK_UPDATE: 'subscription:checkUpdate',
  /** 手动检查所有订阅更新 */
  SUBSCRIPTION_CHECK_ALL_UPDATES: 'subscription:checkAllUpdates',
  /** 获取有更新的书籍列表（书架徽章用） */
  SUBSCRIPTION_GET_UPDATES: 'subscription:getUpdates',
  /** 获取某订阅关联的书籍 */
  SUBSCRIPTION_GET_BOOKS: 'subscription:getBooks',
  /** 标记书籍更新状态（清除/设置徽章） */
  SUBSCRIPTION_MARK_BOOK_UPDATE: 'subscription:markBookUpdate',
  /** 清除所有书籍更新标记 */
  SUBSCRIPTION_CLEAR_ALL_UPDATES: 'subscription:clearAllUpdates',
  /** 添加订阅源（自动检测格式） */
  SUBSCRIPTION_ADD_SMART: 'subscription:addSmart',

  // OPDS 书库浏览（v19 新增）
  /** 添加 OPDS 目录 */
  OPDS_ADD_CATALOG: 'opds:addCatalog',
  /** 列出已添加的 OPDS 目录 */
  OPDS_LIST_CATALOGS: 'opds:listCatalogs',
  /** 删除 OPDS 目录 */
  OPDS_REMOVE_CATALOG: 'opds:removeCatalog',
  /** 浏览 OPDS 目录的 feed */
  OPDS_BROWSE: 'opds:browse',
  /** 搜索 OPDS 目录中的书籍 */
  OPDS_SEARCH: 'opds:search',
  /** 下载书籍并导入到书架 */
  OPDS_DOWNLOAD: 'opds:download',

  // 网络配置（v20 新增，设置页"网络"标签页）
  /** 获取网络配置（User-Agent/自定义头/代理） */
  NETWORK_CONFIG_GET: 'network:config:get',
  /** 设置网络配置（User-Agent/自定义头/代理） */
  NETWORK_CONFIG_SET: 'network:config:set',

  /** 主进程 → 渲染进程：书架数据已变更，需要刷新（RSS/OPDS 导入后触发） */
  BOOKSHELF_REFRESH: 'bookshelf:refresh'
} as const;
