<!--
  书架视图（M5 完整实现 + 左侧导航栏重构）

  布局结构（核心约束）：
  .bookshelf-root (display:flex, height:100%, overflow:hidden)
    └── DropZone.bookshelf-view (flex:1, display:flex, flex-direction:column, min-height:0, overflow:hidden)
        └── .bookshelf-layout (display:flex, flex:1, min-height:0, overflow:hidden)
            ├── .sidebar-wrap (flex-shrink:0, width:200px, overflow:hidden, display:flex, flex-direction:column)
            │   └── GroupSidebar
            └── .main-area (flex:1, display:flex, flex-direction:column, min-width:0, overflow:hidden)
                ├── .toolbar (height:48px, flex-shrink:0)
                ├── .content-area (flex:1, overflow-y:auto, min-height:0) ← 唯一滚动区
                └── .batch-bar-wrap (flex-shrink:0)

  功能：
  - 顶部工具栏：侧边栏切换 + 视图切换（九宫格/列表）+ 排序 + 搜索 + 导入按钮 + 批量管理
  - 书籍展示区：九宫格网格 或 列表视图（虚拟滚动 NVirtualList）
  - 底部批量操作栏（多选时显示）
  - 拖拽导入（DropZone 包裹）
  - 导入对话框（ImportDialog）
  - 空状态引导
  - 右键菜单（NDropdown）
  - 分组侧边栏（GroupSidebar）
  - 设置持久化（视图/排序/分组）

  设计原则：
  - 容器固定跟随窗口：height:100%/flex:1 固定高度，绝不被内容撑开
  - 内容区滚动：只有 .content-area 设置 overflow:auto，其他容器 overflow:hidden
  - 统一 CSS 变量：所有颜色/间距/圆角通过 CSS 变量引用，零硬编码
  - camelCase 命名：所有变量/函数使用 camelCase
  - TypeScript 严格类型：所有函数参数和返回值必须有明确类型
-->
<script setup lang="ts">
import { ref, computed, h, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import {
  NButton,
  NIcon,
  NInput,
  NButtonGroup,
  NSelect,
  NDropdown,
  NSpin,
  NVirtualList,
  NCheckbox,
  useMessage,
  useDialog,
  type SelectOption,
  type DropdownOption
} from 'naive-ui';
import {
  BookOpen,
  Book as BookIcon,
  FilePlus,
  LayoutGrid,
  List,
  Search,
  ArrowUp,
  ArrowDown,
  Trash,
  Folder,
  PanelLeft,
  ListChecks,
  Download,
  FileText,
  ScrollText,
  X,
  ChevronDown,
  CheckCircle,
  Bookmark,
  Ban,
  Tag,
  Type,
  Image,
  Layers,
  RefreshCw
} from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useBookshelfStore, availableExportFormats, isImageBookGuard } from '@renderer/stores';
import { useDropdownIcon, useDebounce, useContextMenu } from '@renderer/composables';
import type { Book, SortField, GroupFilter, ReadingStatus } from '@renderer/types';
import ImportDialog from '@renderer/components/common/ImportDialog.vue';
import DropZone from '@renderer/components/common/DropZone.vue';
import GridItem from '@renderer/components/bookshelf/GridItem.vue';
import ListItem from '@renderer/components/bookshelf/ListItem.vue';
import GroupSidebar from '@renderer/components/bookshelf/GroupSidebar.vue';

const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const store = useBookshelfStore();
const { t } = useI18n();

/* ==================== 导入对话框 ==================== */

/** 导入对话框显示状态 */
const showImportDialog = ref(false);
/** ImportDialog 组件实例引用 */
const importDialogRef = ref<InstanceType<typeof ImportDialog> | null>(null);

/** 打开导入对话框 */
function openImportDialog(): void {
  showImportDialog.value = true;
}

/** 导入对话框关闭 */
function handleDialogUpdateShow(value: boolean): void {
  showImportDialog.value = value;
}

/** 导入完成，刷新书架 */
function handleImported(): void {
  store.refresh();
}

/** 拖拽放下文件 */
async function handleDrop(filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) return;
  showImportDialog.value = true;
  await nextTick();
  importDialogRef.value?.importByPaths(filePaths);
}

/* ==================== 侧边栏折叠 ==================== */

/** 侧边栏是否折叠 */
const sidebarCollapsed = ref(false);

/** 切换侧边栏折叠 */
function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
}

/* ==================== 批量管理模式 ==================== */

/** 批量管理模式（点击书籍切换选中而非打开） */
const batchMode = ref(false);

/** 切换批量管理模式 */
function toggleBatchMode(): void {
  batchMode.value = !batchMode.value;
  if (!batchMode.value) {
    store.clearSelection();
  }
}

/** 退出批量管理模式（清空勾选 + 关闭批量模式） */
function exitBatchMode(): void {
  batchMode.value = false;
  store.clearSelection();
}

// 收藏被删空（或筛选/搜索结果为 0）时自动退出批量模式，
// 否则工具栏的批量按钮随 bookCount=0 消失，用户会被困在批量模式
watch(
  () => store.bookCount,
  (count) => {
    if (count === 0 && batchMode.value) {
      exitBatchMode();
    }
  }
);

/** 书籍点击处理：批量模式下切换选中，正常模式下打开 */
function handleBookActivate(book: Book): void {
  if (batchMode.value) {
    handleToggleSelect(book.id);
  } else {
    openBook(book);
  }
}

/* ==================== 视图/排序/搜索 ==================== */

/** 排序字段下拉选项（随语言切换响应） */
const sortFieldOptions = computed<SelectOption[]>(() => [
  { label: t('bookshelf.sort.lastReadAt'), value: 'last_read_at' },
  { label: t('bookshelf.sort.updatedAt'), value: 'updated_at' },
  { label: t('common.words.title'), value: 'title' },
  { label: t('common.words.author'), value: 'author' },
  { label: t('bookshelf.sort.addedAt'), value: 'created_at' },
  { label: t('bookshelf.sort.manual'), value: 'sort_order' }
]);

/** 当前排序字段（v-model 中转） */
const sortFieldModel = computed({
  get: (): SortField => store.sortField,
  set: (val: SortField): void => {
    store.setSort(val, store.sortOrder);
  }
});

/** 切换视图模式 */
function handleViewChange(mode: 'grid' | 'list'): void {
  store.setViewMode(mode);
}

/** 切换排序方向 */
function handleToggleSortOrder(): void {
  store.toggleSortOrder();
}

/* ==================== 阅读状态筛选 ==================== */

/** 阅读状态筛选下拉选项（随语言切换响应） */
const readingStatusOptions = computed<SelectOption[]>(() => [
  { label: t('common.actions.all'), value: '' },
  { label: t('common.status.reading'), value: 'reading' },
  { label: t('common.status.completed'), value: 'completed' },
  { label: t('common.status.wantToRead'), value: 'want_to_read' },
  { label: t('common.status.dropped'), value: 'dropped' }
]);

/** 当前阅读状态筛选（v-model 中转，'' 表示全部/无筛选） */
const readingStatusModel = computed({
  get: (): string => store.currentReadingStatusFilter ?? '',
  set: (val: string): void => {
    store.setReadingStatusFilter((val || null) as ReadingStatus);
  }
});

/* ==================== 搜索（debounce 300ms） ==================== */

/** 搜索输入值（本地，debounce 后同步到 store） */
const searchInput = ref('');
const { run: debouncedSearch } = useDebounce((val: string) => store.search(val), 300);

/** 监听搜索输入，debounce 300ms 后触发搜索 */
watch(searchInput, (val) => debouncedSearch(val));

/* ==================== 书籍操作 ==================== */

/** 打开书籍（RSS 文章跳转文章视图，其他统一跳转小说阅读器） */
async function openBook(book: Book): Promise<void> {
  await store.touchRead(book.id);
  // 统一阅读器：所有类型都用Reader（小说阅读器承担一切）
  if (book.file_type === 'rss') {
    router.push(`/article/${book.id}`);
  } else {
    router.push(`/reader/${book.id}`);
  }
}

/** 通过 ID 打开书籍（侧边栏最近阅读点击） */
async function handleOpenBookById(id: number): Promise<void> {
  await store.touchRead(id);
  const book = store.books.find((b) => b.id === id);
  // 统一阅读器：所有类型都用Reader
  if (book?.file_type === 'rss') {
    router.push(`/article/${id}`);
  } else {
    router.push(`/reader/${id}`);
  }
}

/** 切换选中 */
function handleToggleSelect(id: number): void {
  store.toggleSelect(id);
}

/* ==================== 右键菜单 ==================== */

/** 右键菜单状态 */
const { contextMenuShow, contextMenuX, contextMenuY, openContextMenu, closeContextMenu } = useContextMenu();
const contextMenuBook = ref<Book | null>(null);

/** 移动到分组子菜单选项 */
const moveGroupOptions = computed<DropdownOption[]>(() => {
  const opts: DropdownOption[] = [{ label: t('bookshelf.removeFromGroup'), key: 'move:null' }];
  if (store.groups.length > 0) {
    opts.push({ type: 'divider', key: 'move-d' });
    for (const g of store.groups) {
      opts.push({ label: g.name, key: `move:${g.id}` });
    }
  }
  return opts;
});

/** 简单 icon 渲染：返回 VNode 的函数，用于 NDropdown 选项的 icon */
const renderIcon = useDropdownIcon();

/**
 * 可重新解析的文件类型白名单（与 BookDetail.REPARSE_SUPPORTED 一致）
 *
 * E1：书架右键「重新解析」入口——PDF 扫描版乱码书的高频修复路径原本藏在
 * BookDetail「更多」菜单，用户在书架发现书有问题要多跳一页；
 * rss 等无 parser 的类型不显示（点击必报错"不支持的文件类型"）。
 */
const REPARSE_SUPPORTED = ['txt', 'epub', 'mobi', 'pdf', 'comic'] as const;

/** 右键菜单选项 */
const contextMenuOptions = computed<DropdownOption[]>(() => {
  const book = contextMenuBook.value;

  const opts: DropdownOption[] = [
    { label: t('common.actions.open'), key: 'open', icon: renderIcon(BookIcon) },
    { label: t('bookshelf.bookDetail'), key: 'detail', icon: renderIcon(ScrollText) }
  ];

  opts.push({ type: 'divider', key: 'd1' });
  opts.push({
    label: t('bookshelf.moveToGroup'),
    key: 'move',
    icon: renderIcon(Folder),
    children: moveGroupOptions.value
  });
  opts.push({
    label: t('bookshelf.markAs'),
    key: 'mark',
    icon: renderIcon(BookOpen),
    children: [
      { label: t('common.status.reading'), key: 'mark-reading', icon: renderIcon(BookOpen) },
      { label: t('common.status.completed'), key: 'mark-completed', icon: renderIcon(CheckCircle) },
      { label: t('common.status.wantToRead'), key: 'mark-want_to_read', icon: renderIcon(Bookmark) },
      { label: t('common.status.dropped'), key: 'mark-dropped', icon: renderIcon(Ban) }
    ]
  });
  opts.push({
    label: t('bookshelf.classify.menu'),
    key: 'classify',
    icon: renderIcon(Tag),
    children: [
      { label: t('common.bookType.text'), key: 'classify-text', icon: renderIcon(Type) },
      { label: t('common.bookType.illustrated'), key: 'classify-illustrated', icon: renderIcon(Image) },
      { label: t('common.bookType.scan'), key: 'classify-scan', icon: renderIcon(FileText) },
      { label: t('common.bookType.comic'), key: 'classify-comic', icon: renderIcon(Layers) }
    ]
  });
  // E1：重新解析入口（白名单内的类型才显示，避免 rss 等无 parser 类型点击必报错）
  if (book && REPARSE_SUPPORTED.includes(book.file_type as (typeof REPARSE_SUPPORTED)[number])) {
    opts.push({ label: t('bookDetail.reparse.title'), key: 'reparse', icon: renderIcon(RefreshCw) });
  }
  // P2 修复：导出子菜单按内容类型过滤，统一走 availableExportFormats（与 BookDetail"更多"菜单共享口径）
  // - 漫画（comic/is_comic=1）：TXT 空壳 → 隐藏；EPUB 嵌图有效 → 保留；CBZ 原样打包 → 保留
  // - 扫描版（scan 或 PDF+illustrated 粗判扫描式）：TXT/EPUB 乱码层 → 隐藏；CBZ 主进程必报错 → 隐藏
  // - 文本型（text/illustrated 其余情形）：TXT + EPUB 可用；CBZ 仅漫画显示（既有 P2 项保持）
  const exportFormats = availableExportFormats(book ?? {});
  const exportChildren: DropdownOption[] = [];
  if (exportFormats.txt) {
    exportChildren.push({ label: t('bookshelf.exportAs.txt'), key: 'export-txt', icon: renderIcon(FileText) });
  }
  if (exportFormats.epub) {
    exportChildren.push({ label: t('bookshelf.exportAs.epub'), key: 'export-epub', icon: renderIcon(BookIcon) });
  }
  if (exportFormats.cbz) {
    exportChildren.push({ label: t('bookshelf.exportAs.cbz'), key: 'export-cbz', icon: renderIcon(BookIcon) });
  }
  // 导出源文件：复制导入时的原始文件（不重新生成），对所有有本地源文件的书可用；
  // 图片型/扫描版书即使 TXT/EPUB/CBZ 全部不可用（避免空壳/乱码产物），
  // 也始终保留此入口——这正是用户「直接导出源文件」诉求的落点（在线书/RSS 无 local_file_path 不显示）
  if (book?.local_file_path) {
    exportChildren.push({ label: t('bookshelf.exportAs.source'), key: 'export-source', icon: renderIcon(Download) });
  }
  if (exportChildren.length > 0) {
    opts.push({
      label: t('bookshelf.exportBook'),
      key: 'export',
      icon: renderIcon(Download),
      children: exportChildren
    });
  }
  opts.push({ type: 'divider', key: 'd2' });
  opts.push({ label: t('common.actions.delete'), key: 'delete', icon: renderIcon(Trash) });

  return opts;
});

/** 显示右键菜单 */
function handleContextMenu(book: Book, x: number, y: number): void {
  contextMenuBook.value = book;
  openContextMenu(x, y);
}

/** 右键菜单选择 */
async function handleContextMenuSelect(key: string | number): Promise<void> {
  const book = contextMenuBook.value;
  if (!book) return;
  closeContextMenu();

  const keyStr = String(key);

  if (keyStr === 'open') {
    await openBook(book);
  } else if (keyStr === 'detail') {
    router.push(`/book/${book.id}`);
  } else if (keyStr.startsWith('move:')) {
    const target = keyStr.slice(5);
    const groupId = target === 'null' ? null : Number(target);
    try {
      await store.moveBook(book.id, groupId);
      message.success(t('bookshelf.move.success'));
    } catch {
      message.error(t('bookshelf.move.failed'));
    }
  } else if (keyStr === 'export-txt') {
    await handleExportTxt(book.id);
  } else if (keyStr === 'export-epub') {
    await handleExportEpub(book.id);
  } else if (keyStr === 'export-cbz') {
    await handleExportCbz(book.id);
  } else if (keyStr === 'export-source') {
    await handleExportSource(book.id);
  } else if (keyStr === 'reparse') {
    handleReparseBook(book);
  } else if (keyStr.startsWith('mark-')) {
    const status = keyStr.slice(5) as ReadingStatus;
    await handleMarkReadingStatus(book.id, status);
  } else if (keyStr.startsWith('classify-')) {
    const shape = keyStr.slice(9) as 'text' | 'illustrated' | 'scan' | 'comic';
    await handleClassifyBook(book.id, shape);
  } else if (keyStr === 'delete') {
    handleDeleteBook(book);
  }
}

/**
 * 删除单本书籍（带确认，批次 v54 删除分流）
 *
 * - copy/move 书：保持原有简单确认（删除的是应用自管副本）
 * - link 书：清单式确认——展示将删除的应用内数据 + 复选框"同时删除引用的原文件"
 *   （默认不勾，勾选才删用户原文件，主进程还有 userData 内护栏兜底）
 */
function handleDeleteBook(book: Book): void {
  if (book.import_mode !== 'link') {
    dialog.warning({
      title: t('bookshelf.deleteBook.title'),
      content: t('bookshelf.deleteBook.confirm', { title: book.title }),
      positiveText: t('common.actions.delete'),
      negativeText: t('common.actions.cancel'),
      onPositiveClick: async () => {
        try {
          await store.deleteBook(book.id);
          message.success(t('common.feedback.deleted'));
        } catch {
          message.error(t('bookshelf.deleteBook.failed'));
        }
      }
    });
    return;
  }

  // link 书：清单式确认 + 原文件删除复选框（默认不勾）
  let deleteSource = false;
  dialog.warning({
    title: t('bookshelf.deleteBook.title'),
    content: () =>
      h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, [
        h('div', null, [
          h('p', { style: 'margin:0 0 6px;font-weight:500' }, `《${book.title}》`),
          h('p', { style: 'margin:0;color:var(--text-secondary)' }, t('import.delete.cleanupList'))
        ]),
        h(
          NCheckbox,
          {
            checked: deleteSource,
            'onUpdate:checked': (v: boolean) => {
              deleteSource = v;
            }
          },
          { default: () => t('import.delete.deleteSource', { n: 1 }) }
        )
      ]),
    positiveText: t('common.actions.delete'),
    negativeText: t('common.actions.cancel'),
    onPositiveClick: async () => {
      try {
        await store.deleteBook(book.id, deleteSource);
        message.success(t('common.feedback.deleted'));
      } catch {
        message.error(t('bookshelf.deleteBook.failed'));
      }
    }
  });
}

/* ==================== 批量操作 ==================== */

/**
 * 重新解析（确认对话框）
 *
 * E1：复用 BookDetail 同款 reparse IPC（dbApi.book.reparse），书架右键直达；
 * 重新解析会变更章节索引/封面/分类标记，完成后刷新书架列表。
 */
function handleReparseBook(book: Book): void {
  dialog.warning({
    title: t('bookDetail.reparse.title'),
    content: t('bookDetail.reparse.confirm'),
    positiveText: t('common.actions.confirm'),
    negativeText: t('common.actions.cancel'),
    onPositiveClick: async () => {
      try {
        const result = await window.dbApi.book.reparse(book.id);
        if (result.success) {
          message.success(t('bookDetail.reparse.done', { n: result.chapterCount }));
          await store.loadBooks();
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
 * 批量删除（批次 v54 删除分流）
 *
 * 选中书含 link 书 → 清单式确认 + 复选框"同时删除引用的原文件（{n} 本）"
 * （默认不勾）；不含 link 书保持原有行为（Popconfirm 已在模板中移除，统一走此处确认）。
 */
function handleBatchDelete(): void {
  const selectedBooks = store.books.filter((b) => store.isSelected(b.id));
  const linkCount = selectedBooks.filter((b) => b.import_mode === 'link').length;

  if (linkCount === 0) {
    // 无 link 书：简单确认（与原 Popconfirm 行为一致）
    dialog.warning({
      title: t('bookshelf.deleteBook.title'),
      content: t('bookshelf.batchDeleteConfirm', { n: selectedBooks.length }),
      positiveText: t('common.actions.delete'),
      negativeText: t('common.actions.cancel'),
      onPositiveClick: async () => {
        await doBatchDelete();
      }
    });
    return;
  }

  // 含 link 书：清单式确认 + 原文件删除复选框（默认不勾）
  // v57 修复：NCheckbox 改非受控模式（不传 checked）——原受控写法以普通 let 变量
  // 作 checked 源，dialog content 渲染函数仅执行一次不再重渲染，勾选视觉永不生效
  let deleteSource = false;
  dialog.warning({
    title: t('bookshelf.deleteBook.title'),
    content: () =>
      h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, [
        h('p', { style: 'margin:0;color:var(--text-secondary)' }, t('import.delete.cleanupList')),
        h(
          NCheckbox,
          {
            'onUpdate:checked': (v: boolean) => {
              deleteSource = v;
            }
          },
          { default: () => t('import.delete.deleteSource', { n: linkCount }) }
        )
      ]),
    positiveText: t('common.actions.delete'),
    negativeText: t('common.actions.cancel'),
    onPositiveClick: async () => {
      await doBatchDelete(deleteSource);
    }
  });
}

/** 批量删除执行（handleBatchDelete 的实际删除动作） */
async function doBatchDelete(deleteSourceFile?: boolean): Promise<void> {
  try {
    const count = await store.deleteSelected(deleteSourceFile);
    message.success(t('bookshelf.deletedN', { n: count }));
  } catch {
    message.error(t('bookshelf.batchDeleteFailed'));
  }
}

/** 批量移动 */
async function handleBatchMove(groupId: number | null): Promise<void> {
  try {
    await store.moveSelected(groupId);
    message.success(t('bookshelf.move.success'));
  } catch {
    message.error(t('bookshelf.move.failed'));
  }
}

/** 取消选择 */
function handleClearSelection(): void {
  store.clearSelection();
}

/** 移动到分组下拉选项 */
const moveOptions = computed<DropdownOption[]>(() => {
  const options: DropdownOption[] = [{ label: t('bookshelf.removeFromGroup'), key: 'null' }];
  if (store.groups.length > 0) {
    options.push({ type: 'divider', key: 'd1' });
    for (const g of store.groups) {
      options.push({ label: g.name, key: String(g.id) });
    }
  }
  return options;
});

/** 选择移动目标 */
function handleMoveSelect(key: string | number): void {
  if (key === 'null') {
    handleBatchMove(null);
  } else {
    handleBatchMove(Number(key));
  }
}

/* ==================== 分组侧边栏操作 ==================== */

/** 选择分组 */
function handleSelectGroup(filter: GroupFilter): void {
  store.setGroupFilter(filter);
}

/** 新建分组 */
async function handleCreateGroup(name: string): Promise<void> {
  try {
    await store.createGroup(name);
    message.success(t('bookshelf.group.created'));
  } catch {
    message.error(t('bookshelf.group.createFailed'));
  }
}

/** 重命名分组 */
async function handleRenameGroup(id: number, name: string): Promise<void> {
  try {
    await store.renameGroup(id, name);
    message.success(t('bookshelf.group.renamed'));
  } catch {
    message.error(t('bookshelf.group.renameFailed'));
  }
}

/** 删除分组 */
function handleDeleteGroup(id: number): void {
  const group = store.groups.find((g) => g.id === id);
  dialog.warning({
    title: t('bookshelf.group.deleteTitle'),
    content: t('bookshelf.group.deleteConfirm', { name: group?.name ?? '' }),
    positiveText: t('common.actions.delete'),
    negativeText: t('common.actions.cancel'),
    onPositiveClick: async () => {
      try {
        await store.deleteGroup(id);
        message.success(t('bookshelf.group.deleted'));
      } catch {
        message.error(t('bookshelf.group.deleteFailed'));
      }
    }
  });
}

/** 上移分组 */
async function handleMoveGroupUp(id: number): Promise<void> {
  try {
    await store.moveGroupUp(id);
  } catch {
    message.error(t('bookshelf.move.orderFailed'));
  }
}

/** 下移分组 */
async function handleMoveGroupDown(id: number): Promise<void> {
  try {
    await store.moveGroupDown(id);
  } catch {
    message.error(t('bookshelf.move.orderFailed'));
  }
}

/* ==================== 分组书籍数量 ==================== */

/** 全部书籍列表（仅用于分组数量计数，独立于 store.books 过滤逻辑） */
const allBooksForCount = ref<Book[]>([]);

/**
 * 分组数量加载状态标记（脏数据标记 + debounce 合并）
 * - dirty: 数据已变更，需要重新加载
 *
 * 优化：避免每次 books/groups 变化都立即调用 IPC 加载全部书籍，
 * 通过 debounce 300ms 合并连续变更，减少 IPC 调用次数。
 */
let groupCountsDirty = false;

/** 分组数量加载 debounce 延迟（ms） */
const GROUP_COUNTS_DEBOUNCE_MS = 300;

/** 分组书籍数量映射（分组 id → 数量） */
const groupBookCounts = computed<Record<number, number>>(() => {
  const counts: Record<number, number> = {};
  for (const book of allBooksForCount.value) {
    if (book.group_id !== null) {
      counts[book.group_id] = (counts[book.group_id] ?? 0) + 1;
    }
  }
  return counts;
});

const { run: debouncedLoadGroupCounts } = useDebounce(async () => {
  if (!groupCountsDirty) return;
  groupCountsDirty = false;
  try {
    allBooksForCount.value = await store.loadAllBooksForCount();
  } catch (err) {
    console.warn('[bookshelf] 加载分组数量失败:', err);
  }
}, GROUP_COUNTS_DEBOUNCE_MS);

/**
 * 加载全部书籍用于分组数量计数（debounce 合并多次触发）
 * 短时间内的多次调用只会触发一次实际 IPC 请求
 */
async function loadGroupBookCounts(): Promise<void> {
  groupCountsDirty = true;
  debouncedLoadGroupCounts();
}

/* ==================== 导出 ==================== */

/** 导出单本书为 TXT */
async function handleExportTxt(bookId: number): Promise<void> {
  const loadingMsg = message.loading(t('bookshelf.export.exportingTxt'), { duration: 0 });
  try {
    const savedPath = await window.exportApi.exportBookTxt(bookId);
    loadingMsg.destroy();
    if (isImageBookGuard(savedPath)) {
      // 图片型守卫：主进程拒绝生成空壳文件，引导用户改用源文件/CBZ 导出
      message.warning(t('bookshelf.export.imageBookHint'));
      return;
    }
    if (savedPath) {
      message.success(t('bookshelf.export.exportedTo', { path: savedPath }));
    }
  } catch (err) {
    loadingMsg.destroy();
    message.error(t('bookshelf.export.txtFailed', { message: (err as Error).message }));
  }
}

/** 导出单本书为 EPUB */
async function handleExportEpub(bookId: number): Promise<void> {
  const loadingMsg = message.loading(t('bookshelf.export.exportingEpub'), { duration: 0 });
  try {
    const savedPath = await window.exportApi.exportBookEpub(bookId);
    loadingMsg.destroy();
    if (isImageBookGuard(savedPath)) {
      // 图片型守卫：主进程拒绝生成空壳文件，引导用户改用源文件/CBZ 导出
      message.warning(t('bookshelf.export.imageBookHint'));
      return;
    }
    if (savedPath) {
      message.success(t('bookshelf.export.exportedTo', { path: savedPath }));
    }
  } catch (err) {
    loadingMsg.destroy();
    message.error(t('bookshelf.export.epubFailed', { message: (err as Error).message }));
  }
}

/** 导出单本漫画为 CBZ */
async function handleExportCbz(bookId: number): Promise<void> {
  const loadingMsg = message.loading(t('bookshelf.export.exportingCbz'), { duration: 0 });
  try {
    const savedPath = await window.exportApi.exportBookCbz(bookId);
    loadingMsg.destroy();
    if (savedPath) {
      message.success(t('bookshelf.export.exportedTo', { path: savedPath }));
    }
  } catch (err) {
    loadingMsg.destroy();
    message.error(t('bookshelf.export.cbzFailed', { message: (err as Error).message }));
  }
}

/** 导出源文件（复制导入时的原始文件，不重新生成内容——图片型/扫描版书的首选导出方式） */
async function handleExportSource(bookId: number): Promise<void> {
  const loadingMsg = message.loading(t('bookshelf.export.exportingSource'), { duration: 0 });
  try {
    const savedPath = await window.exportApi.exportBookSource(bookId);
    loadingMsg.destroy();
    if (savedPath) {
      message.success(t('bookshelf.export.exportedTo', { path: savedPath }));
    }
  } catch (err) {
    loadingMsg.destroy();
    message.error(t('bookshelf.export.sourceFailed', { message: (err as Error).message }));
  }
}

/** 批量导出中标志，防止重复点击 */
const batchExporting = ref<boolean>(false);

/** 批量导出选中的书籍为TXT */
async function handleBatchExport(): Promise<void> {
  if (batchExporting.value) return;
  const ids = Array.from(store.selectedIds);
  if (ids.length === 0) return;
  batchExporting.value = true;
  const loadingMsg = message.loading(t('bookshelf.export.batchExporting', { n: ids.length }), { duration: 0 });
  let successCount = 0;
  let failCount = 0;
  const failedTitles: string[] = [];
  try {
    for (const id of ids) {
      try {
        const result = await window.exportApi.exportBookTxt(id);
        if (isImageBookGuard(result)) {
          // 图片型守卫：主进程拒绝生成空壳文件，计入失败列表（batchWarning 汇总提示）
          failCount++;
          const book = store.books.find((b) => b.id === id);
          if (book) failedTitles.push(book.title);
          continue;
        }
        successCount++;
      } catch {
        failCount++;
        const book = store.books.find((b) => b.id === id);
        if (book) failedTitles.push(book.title);
      }
    }
    if (failCount === 0) {
      message.success(t('bookshelf.export.batchSuccess', { n: successCount }));
    } else {
      const detail =
        failedTitles.length > 0
          ? t('bookshelf.export.failedList', { titles: failedTitles.join(t('bookshelf.listSeparator')) })
          : '';
      message.warning(t('bookshelf.export.batchWarning', { success: successCount, failed: failCount, detail }));
    }
  } finally {
    loadingMsg.destroy();
    batchExporting.value = false;
  }
}

/* ==================== 标记阅读状态 ==================== */

/** 阅读状态标签（用于消息提示，随语言切换响应） */
function readingStatusLabel(status: string): string {
  switch (status) {
    case 'reading':
      return t('common.status.reading');
    case 'completed':
      return t('common.status.completed');
    case 'want_to_read':
      return t('common.status.wantToRead');
    case 'dropped':
      return t('common.status.dropped');
    default:
      return status;
  }
}

/** 标记书籍阅读状态（直接调用 IPC API，不依赖 book-detail store） */
async function handleMarkReadingStatus(bookId: number, status: ReadingStatus): Promise<void> {
  try {
    await window.dbApi.book.update(bookId, { reading_status: status });
    message.success(t('bookshelf.markedAs', { status: readingStatusLabel(status ?? '') }));
    await store.refresh();
  } catch {
    message.error(t('bookshelf.markStatusFailed'));
  }
}

/* ==================== 分类标记 ==================== */

/**
 * 标记书籍内容分类（文本/图文/漫画）
 *
 * 同时更新 content_type 和 is_comic 字段，保持两字段一致性
 * （来源：2026-09-23-comic-content-type-two-layer-routing 经验，
 *  content_type 为权威字段，is_comic 为向后兼容字段）。
 */
async function handleClassifyBook(
  bookId: number,
  shape: 'text' | 'illustrated' | 'scan' | 'comic'
): Promise<void> {
  try {
    // P3：走专用接口 —— 更新标签 + 记录反馈样本（供后续导入 k-NN 参考，越用越准）
    await window.dbApi.book.setContentType(bookId, shape);
    // 提示用用户选择的形态名（scan 标签同为 illustrated，但显示「扫描版」更贴合用户选择）
    message.success(t('bookshelf.classifiedAs', { type: t(`common.bookType.${shape}`) }));
    await store.refresh();
  } catch {
    message.error(t('bookshelf.classifyFailed'));
  }
}

/* ==================== 全选 ==================== */

/** 是否全选当前书籍 */
const isAllSelected = computed((): boolean => {
  return store.bookCount > 0 && store.selectedCount === store.bookCount;
});

/** 全选/取消全选 */
function handleSelectAll(): void {
  if (isAllSelected.value) {
    store.clearSelection();
  } else {
    store.selectAll();
  }
}

/* ==================== 虚拟滚动 ==================== */

/** 列表视图每项高度（px），用于 NVirtualList itemSize */
const LIST_ITEM_SIZE = 80;

/* ==================== 网格视图分页加载（P2-7 修复） ==================== */
/*
 * 问题：网格视图使用 v-for 直接渲染所有书籍，书籍量大时性能差。
 * 修复：采用 IntersectionObserver 懒加载，每页 100 本，滚到底部自动加载下一页。
 * 来源：经验库 2026-09-24-vue-tab-restructure-lazy-load-adapt（懒加载模式）
 */

/** 网格视图每页加载数量 */
const GRID_PAGE_SIZE = 100;

/** 网格视图当前已加载的页数 */
const gridPage = ref(1);

/** 网格视图底部哨兵元素引用（用于 IntersectionObserver） */
const gridSentinel = ref<HTMLElement | null>(null);

/** IntersectionObserver 实例 */
let gridObserver: IntersectionObserver | null = null;

/** 网格视图当前显示的书籍（分页截取） */
const gridDisplayBooks = computed<Book[]>(() => {
  return store.books.slice(0, gridPage.value * GRID_PAGE_SIZE);
});

/** 网格视图是否还有更多未加载的书籍 */
const gridHasMore = computed<boolean>(() => {
  return gridPage.value * GRID_PAGE_SIZE < store.books.length;
});

/** 重置网格分页到第一页 */
function resetGridPage(): void {
  gridPage.value = 1;
}

/** 加载下一页网格数据 */
function loadNextGridPage(): void {
  if (gridHasMore.value) {
    gridPage.value++;
  }
}

/** 设置 IntersectionObserver 监听哨兵元素 */
function setupGridObserver(): void {
  if (gridObserver) {
    gridObserver.disconnect();
  }
  gridObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && gridHasMore.value) {
          loadNextGridPage();
        }
      }
    },
    { root: null, rootMargin: '200px', threshold: 0 }
  );
  if (gridSentinel.value) {
    gridObserver.observe(gridSentinel.value);
  }
}

/** 监听哨兵元素出现时重新挂载 observer */
watch(gridSentinel, (el) => {
  if (el && gridObserver) {
    gridObserver.observe(el);
  }
});

/** 书籍列表变化时重置分页（搜索/筛选/排序后回到第一页） */
watch(
  () => store.books.length,
  () => {
    resetGridPage();
  }
);

/* ==================== 后台导入：增量刷新 + 完成通知 ==================== */

/**
 * 后台导入：每本书导入成功后节流刷新书架（最多1次/秒）
 *
 * 设计：
 * - 首次收到 onBookAdded 时启动 1s 定时器，期间后续事件忽略
 * - 定时器触发时调用 store.loadBooks() 增量显示新书
 * - 这样批量导入 N 本时，刷新次数 ≈ N/（每秒导入数），而非 N 次
 */
let bookAddedRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/** 单本书导入成功：节流刷新书架 */
function handleBookAdded(): void {
  if (bookAddedRefreshTimer) return; // 已有定时器在等待，跳过
  bookAddedRefreshTimer = setTimeout(() => {
    bookAddedRefreshTimer = null;
    // 同时刷新 books（书架列表）和 allBooks（统计计数），
    // 否则导入过程中书架有新书但统计总数不更新
    store.loadBooks();
    store.loadAllBooks();
  }, 1000); // 最多1次/秒
}

/** 批量导入完成：刷新书架 + 显示完成通知 */
function handleImportComplete(summary: { total: number; success: number; skipped: number; failed: number }): void {
  store.refresh();
  if (summary.success > 0) {
    let text = t('bookshelf.importResult.complete', { success: summary.success });
    if (summary.skipped > 0) {
      text += t('bookshelf.importResult.skippedPart', { n: summary.skipped });
    }
    if (summary.failed > 0) {
      text += t('bookshelf.importResult.failedPart', { n: summary.failed });
    }
    message.success(text);
  } else if (summary.failed > 0) {
    message.error(t('bookshelf.importResult.failedN', { n: summary.failed }));
  } else if (summary.skipped > 0) {
    message.info(t('bookshelf.importResult.skippedDuplicate', { n: summary.skipped }));
  }
}

/* ==================== 生命周期 ==================== */

/** 点击空白处关闭右键菜单 */
function handleGlobalClick(): void {
  if (contextMenuShow.value) {
    closeContextMenu();
  }
}

/** Esc 键退出批量选择模式 */
function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && (store.isSelectionMode || batchMode.value)) {
    store.clearSelection();
    batchMode.value = false;
  }
}

/** P1-11: 监听下载完成事件，自动刷新书架 */
function onBookshelfRefresh(): void {
  // 修复：无论 initialized 状态如何，都强制刷新数据，
  // 确保 RSS/OPDS 导入后书架和统计立即更新
  if (store.initialized) {
    store.refresh();
  } else {
    store.init();
  }
}

/**
 * link 书失效检查定时器（P2 导入三模式，设计文档第二节第 2 层）
 *
 * 挂载 30s 后异步调主进程 book:checkLinks（批量 existsSync），
 * 不阻塞书架渲染（任务要求：异步后置）；组件卸载清理。
 */
let linkCheckTimer: ReturnType<typeof setTimeout> | null = null;

/** 点击失效角标：跳转详情页（重新定位/深度搜索恢复入口） */
function handleOpenDetail(book: Book): void {
  router.push(`/book/${book.id}`);
}

onMounted(() => {
  // 从阅读器/详情页返回书架时，store.keyword 可能残留上次搜索关键词，
  // 但本地 searchInput 已因组件重新挂载而重置为空。
  // 同步两者，确保搜索框显示与实际过滤状态一致。
  if (store.keyword) {
    searchInput.value = store.keyword;
  }
  // 修复：无论从哪里导航到书架，都强制刷新数据，
  // 确保 RSS/OPDS 导入后书架和统计立即显示
  if (store.initialized) {
    store.refresh();
  } else {
    store.init();
  }

  // P2 导入三模式：30s 后批量检查 link 书失效（不阻塞渲染；
  // checkMissingLinks 内部失败静默降级，角标不显示不影响书架功能）
  linkCheckTimer = setTimeout(() => {
    void store.checkMissingLinks();
  }, 30 * 1000);

  document.addEventListener('click', handleGlobalClick);
  document.addEventListener('keydown', handleKeydown);
  // P2 修复：注册前先移除旧监听器，防止组件被多次挂载时重复注册
  // 导致一次刷新事件触发多次 onBookshelfRefresh
  window.removeEventListener('bookshelf:refresh', onBookshelfRefresh);
  window.addEventListener('bookshelf:refresh', onBookshelfRefresh);

  // 后台导入：监听单本书导入成功（节流刷新）和批量导入完成（刷新+通知）
  window.importApi?.onBookAdded(handleBookAdded);
  window.importApi?.onComplete(handleImportComplete);

  // 主进程推送的书架刷新通知（RSS/OPDS 导入后触发）
  // bookshelfApi.onRefresh 内部已做去重（先 removeListener 再 addListener）
  window.bookshelfApi?.onRefresh(onBookshelfRefresh);

  // P2-7 修复：初始化网格视图懒加载 IntersectionObserver
  setupGridObserver();
});

onBeforeUnmount(() => {
  // P2 导入三模式：清理失效检查定时器（离开书架页不再检查）
  if (linkCheckTimer) {
    clearTimeout(linkCheckTimer);
    linkCheckTimer = null;
  }

  document.removeEventListener('click', handleGlobalClick);
  document.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('bookshelf:refresh', onBookshelfRefresh);

  // 清理后台导入监听
  if (bookAddedRefreshTimer) {
    clearTimeout(bookAddedRefreshTimer);
    bookAddedRefreshTimer = null;
  }
  window.importApi?.offBookAdded();
  window.importApi?.offComplete();
  window.bookshelfApi?.offRefresh();

  // P2-7 修复：清理网格视图 IntersectionObserver
  if (gridObserver) {
    gridObserver.disconnect();
    gridObserver = null;
  }
});

/* ==================== 数据变更后刷新分组数量 ==================== */

watch(
  () => store.books.length,
  () => {
    loadGroupBookCounts();
  }
);
watch(
  () => store.groups.length,
  () => {
    loadGroupBookCounts();
  }
);
</script>

<template>
  <div class="bookshelf-root">
    <DropZone class="bookshelf-view" @drop="handleDrop">
      <div class="bookshelf-layout">
        <!-- 左侧：分组侧边栏 -->
        <aside v-show="!sidebarCollapsed" class="sidebar-wrap">
          <GroupSidebar
            :groups="store.groups"
            :current="store.currentGroupFilter"
            :counts="groupBookCounts"
            @select="handleSelectGroup"
            @create="handleCreateGroup"
            @rename="handleRenameGroup"
            @delete="handleDeleteGroup"
            @move-up="handleMoveGroupUp"
            @move-down="handleMoveGroupDown"
            @open-book="handleOpenBookById"
          />
        </aside>

        <!-- 右侧：主区域 -->
        <section class="main-area">
          <!-- 顶部工具栏 -->
          <header class="toolbar">
            <div class="toolbar-left">
              <!-- 侧边栏切换按钮 -->
              <n-button quaternary circle @click="toggleSidebar" :title="t('bookshelf.toggleSidebar')">
                <template #icon>
                  <n-icon :component="PanelLeft" />
                </template>
              </n-button>

              <h1 class="page-title">{{ t('bookshelf.title') }}</h1>

              <!-- 批量管理按钮：批量模式下即使列表为空也必须保留，作为退出入口 -->
              <n-button
                v-if="batchMode || store.bookCount > 0"
                size="small"
                :type="batchMode ? 'primary' : 'default'"
                @click="toggleBatchMode"
                :title="t('bookshelf.batchManage')"
              >
                <template #icon>
                  <n-icon :component="ListChecks" :size="16" />
                </template>
                {{ batchMode ? t('bookshelf.exitBatch') : t('bookshelf.batchManage') }}
              </n-button>

              <!-- 全选按钮（仅批量管理模式显示） -->
              <n-button v-if="batchMode && store.bookCount > 0" size="small" quaternary @click="handleSelectAll">
                {{ isAllSelected ? t('bookshelf.deselectAll') : t('common.actions.selectAll') }}
              </n-button>
            </div>

            <div class="toolbar-right">
              <!-- 搜索框 -->
              <n-input
                v-model:value="searchInput"
                :placeholder="t('bookshelf.searchPlaceholder')"
                clearable
                size="small"
                class="search-input"
              >
                <template #prefix>
                  <n-icon :component="Search" :size="14" />
                </template>
              </n-input>

              <!-- 阅读状态筛选 -->
              <n-select
                v-model:value="readingStatusModel"
                :options="readingStatusOptions"
                size="small"
                :placeholder="t('common.actions.all')"
                class="status-select"
              />

              <!-- 排序选择 -->
              <n-select v-model:value="sortFieldModel" :options="sortFieldOptions" size="small" class="sort-select" />

              <!-- 升降序切换 -->
              <n-button
                size="small"
                quaternary
                @click="handleToggleSortOrder"
                :title="store.sortOrder === 'asc' ? t('bookshelf.sort.ascTitle') : t('bookshelf.sort.descTitle')"
              >
                <template #icon>
                  <n-icon :component="store.sortOrder === 'asc' ? ArrowUp : ArrowDown" />
                </template>
              </n-button>

              <!-- 视图切换 -->
              <n-button-group size="small">
                <n-button
                  :type="store.viewMode === 'grid' ? 'primary' : 'default'"
                  @click="handleViewChange('grid')"
                  :title="t('bookshelf.gridView')"
                >
                  <template #icon>
                    <n-icon :component="LayoutGrid" />
                  </template>
                </n-button>
                <n-button
                  :type="store.viewMode === 'list' ? 'primary' : 'default'"
                  @click="handleViewChange('list')"
                  :title="t('bookshelf.listView')"
                >
                  <template #icon>
                    <n-icon :component="List" />
                  </template>
                </n-button>
              </n-button-group>

              <!-- 导入按钮 -->
              <n-button type="primary" size="small" @click="openImportDialog">
                <template #icon>
                  <n-icon :component="FilePlus" />
                </template>
                {{ t('common.actions.import') }}
              </n-button>
            </div>
          </header>

          <!-- 搜索结果提示 -->
          <div v-if="searchInput && !store.loading" class="search-result-hint">
            <span v-if="store.bookCount > 0">{{ t('bookshelf.foundN', { n: store.bookCount }) }}</span>
            <span v-else>{{ t('bookshelf.noResultsFor', { keyword: searchInput }) }}</span>
          </div>

          <!-- 书籍展示区（唯一可滚动区域） -->
          <div class="content-area">
            <!-- 加载中 -->
            <div v-if="store.loading && store.bookCount === 0" class="loading-state">
              <n-spin size="large" />
            </div>

            <!-- 空状态 -->
            <div v-else-if="store.isEmpty" class="empty-state">
              <div class="empty-icon-wrap">
                <n-icon :component="BookOpen" :size="72" />
              </div>
              <p class="empty-title">{{ t('bookshelf.empty.title') }}</p>
              <n-button type="primary" size="large" @click="openImportDialog" class="empty-action">
                <template #icon>
                  <n-icon :component="FilePlus" />
                </template>
                {{ t('bookshelf.empty.importLocal') }}
              </n-button>
              <p class="empty-hint">{{ t('bookshelf.empty.hint') }}</p>
            </div>

            <!-- 搜索无结果 -->
            <div v-else-if="store.bookCount === 0 && searchInput" class="empty-state">
              <div class="empty-icon-wrap">
                <n-icon :component="Search" :size="56" />
              </div>
              <p class="empty-title">{{ t('bookshelf.noResultsFor', { keyword: searchInput }) }}</p>
            </div>

            <!-- 九宫格视图（P2-7 修复：分页懒加载，每页100本） -->
            <div v-else-if="store.viewMode === 'grid'" class="grid-view">
              <GridItem
                v-for="book in gridDisplayBooks"
                :key="book.id"
                :book="book"
                :selected="store.isSelected(book.id)"
                :selection-mode="store.isSelectionMode || batchMode"
                :missing-link="store.isMissingLink(book.id)"
                @open="handleBookActivate"
                @open-detail="handleOpenDetail"
                @toggle-select="handleToggleSelect"
                @contextmenu="handleContextMenu"
              />
              <!-- 懒加载哨兵元素：进入视口时加载下一页 -->
              <div v-if="gridHasMore" ref="gridSentinel" class="grid-sentinel">
                <n-spin size="small" />
                <span class="grid-sentinel-text">{{ t('common.actions.loadingMore') }}</span>
              </div>
            </div>

            <!-- 列表视图（虚拟滚动） -->
            <n-virtual-list v-else :items="store.books" :item-size="LIST_ITEM_SIZE" class="list-virtual">
              <template #default="{ item }">
                <div :style="{ height: LIST_ITEM_SIZE + 'px' }" class="list-item-wrap">
                  <ListItem
                    :book="item"
                    :selected="store.isSelected(item.id)"
                    :selection-mode="store.isSelectionMode || batchMode"
                    @open="handleBookActivate"
                    @toggle-select="handleToggleSelect"
                    @contextmenu="handleContextMenu"
                  />
                </div>
              </template>
            </n-virtual-list>
          </div>

          <!-- 底部：批量操作栏 -->
          <footer v-if="store.isSelectionMode || batchMode" class="batch-bar-wrap">
            <div class="batch-bar">
              <!-- 左侧：退出批量 / 取消选择 -->
              <div class="batch-left">
                <n-button v-if="batchMode" size="small" type="primary" quaternary @click="exitBatchMode">
                  <template #icon>
                    <n-icon :component="X" />
                  </template>
                  {{ t('bookshelf.exitBatch') }}
                </n-button>
                <n-button v-else size="small" quaternary @click="handleClearSelection">
                  <template #icon>
                    <n-icon :component="X" />
                  </template>
                  {{ t('common.actions.clearSelection') }}
                </n-button>
              </div>

              <!-- 中间：已选数量 -->
              <div class="batch-center">
                <span class="count-text"
                  >{{ t('bookshelf.selectedPrefix') }} <strong>{{ store.selectedCount }}</strong>
                  {{ t('bookshelf.selectedSuffix') }}</span
                >
              </div>

              <!-- 右侧：操作按钮 -->
              <div class="batch-actions">
                <!-- 移动到分组 -->
                <n-dropdown :options="moveOptions" trigger="click" @select="handleMoveSelect">
                  <n-button size="small" quaternary>
                    <template #icon>
                      <n-icon :component="Folder" />
                    </template>
                    {{ t('bookshelf.moveToGroup') }}
                    <n-icon :component="ChevronDown" :size="14" class="chevron-icon" />
                  </n-button>
                </n-dropdown>

                <!-- 导出 -->
                <n-button size="small" quaternary @click="handleBatchExport">
                  <template #icon>
                    <n-icon :component="Download" />
                  </template>
                  {{ t('common.actions.export') }}
                </n-button>

                <!-- 删除（批次 v54：统一走 JS 确认对话框，link 书含原文件复选框） -->
                <n-button size="small" type="error" quaternary @click="handleBatchDelete">
                  <template #icon>
                    <n-icon :component="Trash" />
                  </template>
                  {{ t('common.actions.delete') }}
                </n-button>
              </div>
            </div>
          </footer>
        </section>
      </div>

      <!-- 右键菜单（NDropdown 手动定位） -->
      <n-dropdown
        placement="bottom-start"
        trigger="manual"
        :show="contextMenuShow"
        :options="contextMenuOptions"
        :x="contextMenuX"
        :y="contextMenuY"
        @select="handleContextMenuSelect"
        @clickoutside="closeContextMenu"
      />

      <!-- 导入对话框 -->
      <ImportDialog
        ref="importDialogRef"
        :show="showImportDialog"
        :group-id="typeof store.currentGroupFilter === 'number' ? store.currentGroupFilter : null"
        @update:show="handleDialogUpdateShow"
        @imported="handleImported"
      />
    </DropZone>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════
   布局结构 — 容器固定跟随窗口，内容区滚动
   ═══════════════════════════════════════════════════════════════ */

/* 书架根容器：固定高度，不被内容撑开 */
.bookshelf-root {
  display: flex;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
}

/* bookshelf-view：DropZone 包裹，flex:1 拉伸，min-height:0 防止被内容撑开 */
.bookshelf-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-base);
}

/* 布局层：横向 flex，侧边栏 + 主区域 */
.bookshelf-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* 侧边栏：固定宽度 200px，不被内容撑开 */
.sidebar-wrap {
  flex-shrink: 0;
  width: 200px;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 主区域：flex:1 拉伸，纵向 flex（工具栏 + 内容区 + 批量栏） */
.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding-left: var(--spacing-lg);
}

/* ═══════════════════════════════════════════════════════════════
   工具栏 — 固定高度 48px，flex-shrink:0
   ═══════════════════════════════════════════════════════════════ */

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  height: 48px;
  flex-shrink: 0;
  padding: 0 var(--spacing-xs);
  background: color-mix(in srgb, var(--bg-card) 75%, transparent);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);

  border-bottom: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  margin-top: var(--spacing-md);
  margin-right: var(--spacing-lg);
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
  flex-shrink: 0;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: nowrap;
  min-width: 0;
  overflow: hidden;
}

.page-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: var(--font-size-lg);
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
  white-space: nowrap;
}

.title-icon {
  color: var(--text-secondary);
}

/* 搜索框宽度 */
.search-input {
  width: 240px;
}

/* 排序选择宽度 */
.sort-select {
  width: 120px;
}

/* 阅读状态筛选宽度 */
.status-select {
  width: 100px;
}

/* 书籍类型筛选宽度 */
.type-select {
  width: 100px;
}

/* 下拉箭头图标间距 */
.chevron-icon {
  margin-left: var(--spacing-xs);
}

/* ═══════════════════════════════════════════════════════════════
   搜索结果提示 — flex-shrink:0
   ═══════════════════════════════════════════════════════════════ */

.search-result-hint {
  padding: var(--spacing-xs) var(--spacing-lg);
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  flex-shrink: 0;
}

/* ═══════════════════════════════════════════════════════════════
   内容区 — 唯一可滚动区域
   ═══════════════════════════════════════════════════════════════ */

.content-area {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: var(--spacing-md) 0 0 0;
}

/* 加载状态 */
.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

/* 空状态 */
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

.empty-action {
  margin-top: var(--spacing-xs);
}

.empty-hint {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin: var(--spacing-xs) 0 0;
}

/* ═══════════════════════════════════════════════════════════════
   九宫格视图
   ═══════════════════════════════════════════════════════════════ */

.grid-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--spacing-lg);
  padding: var(--spacing-sm) var(--spacing-lg) var(--spacing-lg);
}

/* P2-7 修复：网格视图懒加载哨兵元素样式 */
.grid-sentinel {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-lg) 0;
  color: var(--text-tertiary);
}

.grid-sentinel-text {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

/* ═══════════════════════════════════════════════════════════════
   列表视图（虚拟滚动）
   ═══════════════════════════════════════════════════════════════ */

.list-virtual {
  width: 100%;
  height: 100%;
  padding: var(--spacing-xs) 0;
}

.list-item-wrap {
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  padding: 0 var(--spacing-lg) 0 var(--spacing-xs);
}

/* ═══════════════════════════════════════════════════════════════
   批量操作栏 — flex-shrink:0
   ═══════════════════════════════════════════════════════════════ */

.batch-bar-wrap {
  flex-shrink: 0;
  padding: 0 0 var(--spacing-md) var(--spacing-lg);
}

.batch-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-10px) var(--spacing-md-lg);
  background: color-mix(in srgb, var(--bg-card) 75%, transparent);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);

  border-top: 1px solid var(--border-color);
  box-shadow: var(--shadow-bar);
  z-index: 10;
}

.batch-left {
  flex-shrink: 0;
}

.batch-center {
  flex-shrink: 0;
}

.count-text {
  font-size: var(--font-size-sm-plus);
  color: var(--text-secondary);
}

.count-text strong {
  color: var(--primary);
  font-size: var(--font-size-base-plus);
  font-weight: 600;
  margin: 0 var(--spacing-2xs);
}

.batch-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-left: auto;
}
</style>
