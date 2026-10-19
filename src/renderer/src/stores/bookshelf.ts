import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  Book,
  Group,
  ViewMode,
  SortField,
  SortOrder,
  GroupFilter,
  ReadingStatus,
  BookTypeFilter
} from '@renderer/types';
import { SETTING_KEYS } from '@renderer/types';

// ═══════════════════════════════════════════════════════════════════════
// 2. Bookshelf Store
// ═══════════════════════════════════════════════════════════════════════

/**
 * 书架状态管理（Pinia Store）
 *
 * 维护书籍列表、分组列表、视图/排序/搜索/多选等 UI 状态，
 * 通过 window.dbApi 与主进程交互，偏好通过 setting 表持久化。
 */

const DEFAULT_VIEW_MODE: ViewMode = 'grid';
const DEFAULT_SORT_FIELD: SortField = 'last_read_at';
const DEFAULT_SORT_ORDER: SortOrder = 'desc';

const VALID_SORT_FIELDS: SortField[] = ['last_read_at', 'updated_at', 'title', 'created_at', 'sort_order', 'author'];

export const useBookshelfStore = defineStore('bookshelf', () => {
  // ─── State ───
  const books = ref<Book[]>([]);
  /** 全部书籍（不受分组/筛选影响，用于最近阅读和统计概览） */
  const allBooks = ref<Book[]>([]);
  const groups = ref<Group[]>([]);
  const currentGroupFilter = ref<GroupFilter>(null);
  const currentReadingStatusFilter = ref<ReadingStatus>(null);
  const currentBookTypeFilter = ref<BookTypeFilter>(null);
  const viewMode = ref<ViewMode>(DEFAULT_VIEW_MODE);
  const sortField = ref<SortField>(DEFAULT_SORT_FIELD);
  const sortOrder = ref<SortOrder>(DEFAULT_SORT_ORDER);
  const keyword = ref<string>('');
  const selectedIds = ref<Set<number>>(new Set());
  const loading = ref<boolean>(false);
  const initialized = ref<boolean>(false);

  // ─── Getters ───
  const selectedCount = computed<number>(() => selectedIds.value.size);
  const isSelectionMode = computed<boolean>(() => selectedIds.value.size > 0);
  const bookCount = computed<number>(() => books.value.length);
  const isEmpty = computed<boolean>(() => !loading.value && books.value.length === 0);

  /**
   * 最近阅读的书籍（按 last_read_at 倒序，取前5本有阅读时间的）
   *
   * 筛选条件：last_read_at 不为 null（即曾经打开过阅读）
   * 排序：last_read_at 倒序（最近阅读的排前面）
   * 数量：最多5本
   */
  const recentBooks = computed<Book[]>(() => {
    return allBooks.value
      .filter((b) => b.last_read_at !== null && b.last_read_at !== undefined)
      .slice()
      .sort((a, b) => (b.last_read_at ?? 0) - (a.last_read_at ?? 0))
      .slice(0, 5);
  });

  /**
   * 书架统计概览
   *
   * - total: 总书数
   * - reading: 在读（reading_status === 'reading'）
   * - read: 已读（reading_status === 'completed'）
   * - wantRead: 想读（reading_status === 'want_to_read'）
   */
  const stats = computed(() => {
    const total = allBooks.value.length;
    const reading = allBooks.value.filter((b) => b.reading_status === 'reading').length;
    const read = allBooks.value.filter((b) => b.reading_status === 'completed').length;
    const wantRead = allBooks.value.filter((b) => b.reading_status === 'want_to_read').length;
    return { total, reading, read, wantRead };
  });

  /**
   * 按内容类型分类的书籍数量（P2-20 修复：供 GroupSidebar 智能分组徽章使用）
   *
   * - text: 文本类（content_type === 'text'）
   * - illustrated: 图文类（content_type === 'illustrated'）
   * - comic: 漫画类（content_type === 'comic'）
   */
  const bookTypeCounts = computed(() => {
    let text = 0;
    let illustrated = 0;
    let comic = 0;
    for (const b of allBooks.value) {
      if (b.content_type === 'text') text++;
      else if (b.content_type === 'illustrated') illustrated++;
      else if (b.content_type === 'comic') comic++;
    }
    return { text, illustrated, comic };
  });

  // ─── Actions：数据加载 ───

  /** loadBooks 请求序号，防止快速切换分组/筛选时旧请求覆盖新请求 */
  let loadBooksSeq = 0;

  async function loadBooks(): Promise<void> {
    const seq = ++loadBooksSeq;
    loading.value = true;
    try {
      const params: {
        group_id?: number | null;
        keyword?: string;
        sort_field: 'last_read_at' | 'updated_at' | 'title' | 'created_at' | 'sort_order';
        sort_order: SortOrder;
        reading_status?: ReadingStatus;
        book_type?: BookTypeFilter;
      } = {
        sort_field: sortField.value as 'last_read_at' | 'updated_at' | 'title' | 'created_at' | 'sort_order',
        sort_order: sortOrder.value
      };

      const filter = currentGroupFilter.value;
      if (typeof filter === 'number') {
        params.group_id = filter;
      }

      if (currentReadingStatusFilter.value) {
        params.reading_status = currentReadingStatusFilter.value;
      }

      if (currentBookTypeFilter.value) {
        params.book_type = currentBookTypeFilter.value;
      }

      const kw = keyword.value.trim();
      if (kw.length > 0) params.keyword = kw;

      const result = (await window.dbApi.book.list(params)) as Book[];
      if (seq !== loadBooksSeq) return;
      books.value = result;
    } catch (err) {
      if (seq !== loadBooksSeq) return;
      console.error('[bookshelf] 加载书籍失败:', err);
      books.value = [];
    } finally {
      // P1-13修复：无条件重置 loading，避免快速切换时旧请求 seq 失效导致 loading 卡死
      // 原实现 `if (seq === loadBooksSeq) loading.value = false` 在 seq 失效时不重置，
      // 若新请求未触发 loading=true（如被防抖）则 loading 永远卡在 true。
      loading.value = false;
    }
  }

  async function loadGroups(): Promise<void> {
    try {
      groups.value = (await window.dbApi.group.list()) as Group[];
    } catch (err) {
      console.error('[bookshelf] 加载分组失败:', err);
      groups.value = [];
    }
  }

  async function init(): Promise<void> {
    if (initialized.value) return;

    try {
      const [view, sField, sOrder, rStatus, bType] = await Promise.all([
        window.dbApi.setting.get(SETTING_KEYS.VIEW),
        window.dbApi.setting.get(SETTING_KEYS.SORT_FIELD),
        window.dbApi.setting.get(SETTING_KEYS.SORT_ORDER),
        window.dbApi.setting.get(SETTING_KEYS.READING_STATUS),
        window.dbApi.setting.get(SETTING_KEYS.BOOK_TYPE)
      ]);

      if (view === 'grid' || view === 'list') viewMode.value = view;
      if (sField && VALID_SORT_FIELDS.includes(sField as SortField)) sortField.value = sField as SortField;
      if (sOrder === 'asc' || sOrder === 'desc') sortOrder.value = sOrder;
      if (rStatus && ['reading', 'completed', 'want_to_read', 'dropped'].includes(rStatus as string)) {
        currentReadingStatusFilter.value = rStatus as ReadingStatus;
      }
      if (bType && ['text', 'illustrated', 'comic'].includes(bType as string)) {
        currentBookTypeFilter.value = bType as BookTypeFilter;
      }
    } catch (err) {
      console.warn('[bookshelf] 读取持久化设置失败，使用默认值:', err);
    }

    await Promise.all([loadBooks(), loadGroups(), loadAllBooks()]);

    // 所有异步操作完成后才标记 initialized=true，避免失败时误判已初始化（P1-6）
    initialized.value = true;
  }

  // ─── Actions：视图/排序/分组/搜索 ───

  async function setViewMode(mode: ViewMode): Promise<void> {
    if (viewMode.value === mode) return;
    viewMode.value = mode;
    try {
      await window.dbApi.setting.set(SETTING_KEYS.VIEW, mode);
    } catch (err) {
      console.warn('[bookshelf] 持久化视图模式失败:', err);
    }
  }

  async function setSort(field: SortField, order: SortOrder): Promise<void> {
    sortField.value = field;
    sortOrder.value = order;
    try {
      await Promise.all([
        window.dbApi.setting.set(SETTING_KEYS.SORT_FIELD, field),
        window.dbApi.setting.set(SETTING_KEYS.SORT_ORDER, order)
      ]);
    } catch (err) {
      console.warn('[bookshelf] 持久化排序失败:', err);
    }
    await loadBooks();
  }

  async function toggleSortOrder(): Promise<void> {
    await setSort(sortField.value, sortOrder.value === 'asc' ? 'desc' : 'asc');
  }

  async function setGroupFilter(filter: GroupFilter): Promise<void> {
    // 智能分组（文本/图文/漫画）与用户分组互斥：
    // - 'text'/'illustrated'/'comic' → 设置 bookTypeFilter，清空 groupFilter
    // - number（用户分组）→ 设置 groupFilter，清空 bookTypeFilter
    // - null（全部书籍）→ 清空两个
    // v21：'mixed' 改为 'illustrated'，对齐 content_type 三分类
    if (filter === 'text' || filter === 'illustrated' || filter === 'comic') {
      currentBookTypeFilter.value = filter as BookTypeFilter;
      currentGroupFilter.value = null;
    } else {
      currentGroupFilter.value = filter;
      currentBookTypeFilter.value = null;
    }
    clearSelection();
    try {
      const value = typeof filter === 'number' ? String(filter) : (filter ?? '');
      await window.dbApi.setting.set(SETTING_KEYS.GROUP_ID, value);
    } catch (err) {
      console.warn('[bookshelf] 持久化分组失败:', err);
    }
    await loadBooks();
  }

  async function setReadingStatusFilter(status: ReadingStatus): Promise<void> {
    currentReadingStatusFilter.value = status;
    clearSelection();
    try {
      const value = status ?? '';
      await window.dbApi.setting.set(SETTING_KEYS.READING_STATUS, value);
    } catch (err) {
      console.warn('[bookshelf] 持久化阅读状态筛选失败:', err);
    }
    await loadBooks();
  }

  async function setBookTypeFilter(type: BookTypeFilter): Promise<void> {
    currentBookTypeFilter.value = type;
    clearSelection();
    try {
      const value = type ?? '';
      await window.dbApi.setting.set(SETTING_KEYS.BOOK_TYPE, value);
    } catch (err) {
      console.warn('[bookshelf] 持久化书籍类型筛选失败:', err);
    }
    await loadBooks();
  }

  async function search(kw: string): Promise<void> {
    keyword.value = kw;
    await loadBooks();
  }

  // ─── Actions：多选 ───

  function toggleSelect(id: number): void {
    const next = new Set(selectedIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds.value = next;
  }

  function isSelected(id: number): boolean {
    return selectedIds.value.has(id);
  }

  function selectAll(): void {
    selectedIds.value = new Set(books.value.map((b) => b.id));
  }

  function clearSelection(): void {
    selectedIds.value = new Set();
  }

  // ─── Actions：批量操作 ───

  async function deleteSelected(): Promise<number> {
    const ids = Array.from(selectedIds.value);
    if (ids.length === 0) return 0;
    try {
      await window.dbApi.book.batchDelete(ids);
      clearSelection();
      await loadBooks();
      return ids.length;
    } catch (err) {
      console.error('[bookshelf] 批量删除失败:', err);
      throw err;
    }
  }

  async function moveSelected(groupId: number | null): Promise<void> {
    const ids = Array.from(selectedIds.value);
    if (ids.length === 0) return;
    try {
      await window.dbApi.book.batchMove(ids, groupId);
      clearSelection();
      await loadBooks();
    } catch (err) {
      console.error('[bookshelf] 批量移动失败:', err);
      throw err;
    }
  }

  async function deleteBook(id: number): Promise<void> {
    try {
      await window.dbApi.book.delete(id);
      books.value = books.value.filter((b) => b.id !== id);
      allBooks.value = allBooks.value.filter((b) => b.id !== id);
      if (selectedIds.value.has(id)) {
        const next = new Set(selectedIds.value);
        next.delete(id);
        selectedIds.value = next;
      }
    } catch (err) {
      console.error('[bookshelf] 删除书籍失败:', err);
      throw err;
    }
  }

  async function moveBook(id: number, groupId: number | null): Promise<void> {
    try {
      await window.dbApi.book.update(id, { group_id: groupId });
      await loadBooks();
    } catch (err) {
      console.error('[bookshelf] 移动书籍失败:', err);
      throw err;
    }
  }

  // ─── Actions：分组管理 ───

  async function createGroup(name: string): Promise<Group | null> {
    if (!name.trim()) return null;
    try {
      const nextOrder = groups.value.length > 0 ? Math.max(...groups.value.map((g) => g.sort_order)) + 1 : 0;
      const created = await window.dbApi.group.create({ name: name.trim(), sort_order: nextOrder });
      await loadGroups();
      return created as Group;
    } catch (err) {
      console.error('[bookshelf] 新建分组失败:', err);
      throw err;
    }
  }

  async function renameGroup(id: number, name: string): Promise<void> {
    if (!name.trim()) return;
    try {
      await window.dbApi.group.update(id, { name: name.trim() });
      await loadGroups();
    } catch (err) {
      console.error('[bookshelf] 重命名分组失败:', err);
      throw err;
    }
  }

  async function deleteGroup(id: number): Promise<void> {
    try {
      await window.dbApi.group.delete(id);
      if (currentGroupFilter.value === id) {
        currentGroupFilter.value = null;
        try {
          await window.dbApi.setting.set(SETTING_KEYS.GROUP_ID, '');
        } catch (err) {
          console.warn('[bookshelf] 持久化分组回退失败:', err);
        }
      }
      await loadGroups();
      await loadBooks();
    } catch (err) {
      console.error('[bookshelf] 删除分组失败:', err);
      throw err;
    }
  }

  async function moveGroupUp(id: number): Promise<void> {
    const sorted = [...groups.value].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex((g) => g.id === id);
    if (idx <= 0) return;
    const prev = sorted[idx - 1];
    const curr = sorted[idx];
    try {
      await window.dbApi.group.reorder([
        { id: curr.id, sort_order: prev.sort_order },
        { id: prev.id, sort_order: curr.sort_order }
      ]);
      await loadGroups();
    } catch (err) {
      console.error('[bookshelf] 上移分组失败:', err);
      throw err;
    }
  }

  async function moveGroupDown(id: number): Promise<void> {
    const sorted = [...groups.value].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex((g) => g.id === id);
    if (idx < 0 || idx >= sorted.length - 1) return;
    const curr = sorted[idx];
    const next = sorted[idx + 1];
    try {
      await window.dbApi.group.reorder([
        { id: curr.id, sort_order: next.sort_order },
        { id: next.id, sort_order: curr.sort_order }
      ]);
      await loadGroups();
    } catch (err) {
      console.error('[bookshelf] 下移分组失败:', err);
      throw err;
    }
  }

  // ─── Actions：其他 ───

  // P2-8 修复：allBooks 缓存机制，避免 loadAllBooks 与 loadAllBooksForCount 重复调用 IPC。
  // 缓存有效期 5 秒：若 allBooks 在 5 秒内已加载，loadAllBooksForCount 直接复用缓存而非再次发起 IPC。
  /** allBooks 最后一次成功加载的时间戳（ms），0 表示从未加载 */
  let allBooksLoadedAt = 0;
  /** allBooks 缓存有效期（ms）：超过此时间才允许重新发起 IPC */
  const ALL_BOOKS_CACHE_TTL_MS = 5 * 1000;

  /** 加载全部书籍（不受筛选影响，用于最近阅读和统计） */
  async function loadAllBooks(): Promise<void> {
    try {
      allBooks.value = (await window.dbApi.book.list({})) as Book[];
      allBooksLoadedAt = Date.now();
    } catch (err) {
      console.warn('[bookshelf] 加载全部书籍失败:', err);
    }
  }

  /**
   * 加载全部书籍用于计数（P2-8 修复：优先复用 allBooks 缓存，避免重复 IPC 调用）
   *
   * 策略：若 allBooks 在缓存有效期（ALL_BOOKS_CACHE_TTL_MS）内已加载，
   * 直接返回 allBooks.value，不再发起 IPC；否则发起 IPC 并同步更新 allBooks 缓存。
   */
  async function loadAllBooksForCount(): Promise<Book[]> {
    // 缓存命中：allBooks 已在有效期内加载，直接复用
    if (allBooksLoadedAt > 0 && Date.now() - allBooksLoadedAt < ALL_BOOKS_CACHE_TTL_MS) {
      return allBooks.value;
    }
    // 缓存未命中或已过期：发起 IPC 获取最新数据
    try {
      const list = (await window.dbApi.book.list({})) as Book[];
      // 同步更新 allBooks 缓存，使后续调用也能命中
      allBooks.value = list;
      allBooksLoadedAt = Date.now();
      return list;
    } catch (err) {
      console.warn('[bookshelf] 加载全部书籍失败:', err);
      return [];
    }
  }

  async function touchRead(id: number): Promise<void> {
    try {
      await window.dbApi.book.touchRead(id);
    } catch (err) {
      console.warn('[bookshelf] 更新阅读时间失败:', err);
    }
  }

  async function refresh(): Promise<void> {
    await Promise.all([loadBooks(), loadGroups(), loadAllBooks()]);
  }

  return {
    // state
    books,
    groups,
    currentGroupFilter,
    currentReadingStatusFilter,
    currentBookTypeFilter,
    viewMode,
    sortField,
    sortOrder,
    keyword,
    selectedIds,
    loading,
    initialized,
    // getters
    selectedCount,
    isSelectionMode,
    bookCount,
    isEmpty,
    recentBooks,
    stats,
    bookTypeCounts,
    // actions
    loadBooks,
    loadGroups,
    init,
    setViewMode,
    setSort,
    toggleSortOrder,
    setGroupFilter,
    setReadingStatusFilter,
    setBookTypeFilter,
    search,
    toggleSelect,
    isSelected,
    selectAll,
    clearSelection,
    deleteSelected,
    moveSelected,
    deleteBook,
    moveBook,
    createGroup,
    renameGroup,
    deleteGroup,
    moveGroupUp,
    moveGroupDown,
    loadAllBooksForCount,
    loadAllBooks,
    touchRead,
    refresh
  };
});
