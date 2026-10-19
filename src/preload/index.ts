/**
 * 预加载脚本
 *
 * 通过 contextBridge.exposeInMainWorld 暴露安全 API 给渲染进程。
 * 安全策略：contextIsolation: true, nodeIntegration: false
 * 渲染进程通过 window.windowApi / window.appApi / window.dbApi 访问，无 Node.js 能力泄漏。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS } from '../shared';
import type { Book } from '../shared';

/** 窗口控制 API */
export const windowApi = {
  minimize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
  maximize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
  unmaximize: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_UNMAXIMIZE),
  close: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_TOGGLE_MAXIMIZE),
  /** 监听主进程推送的最大化状态变化 */
  onMaximizeChanged: (callback: (isMaximized: boolean) => void): void => {
    // 先移除旧 handler，避免重复注册导致泄漏
    if (maximizeChangedHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_MAXIMIZE_CHANGED, maximizeChangedHandler as never);
    }
    // 精确保存 handler 引用，offMaximizeChanged 时按引用移除（B-11）
    maximizeChangedHandler = (_event: unknown, isMaximized: boolean): void => callback(isMaximized);
    ipcRenderer.on(IPC_CHANNELS.WINDOW_MAXIMIZE_CHANGED, maximizeChangedHandler as never);
  },
  /** 取消监听（精确移除当前 handler，不影响其他组件注册的监听器） */
  offMaximizeChanged: (): void => {
    if (maximizeChangedHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_MAXIMIZE_CHANGED, maximizeChangedHandler as never);
      maximizeChangedHandler = null;
    }
  },
  /** L-1 修复：监听主进程的关闭请求（flush 进度/会话后调用 confirmClose） */
  onCloseRequested: (callback: () => void): void => {
    // 先移除旧 handler，避免重复注册导致泄漏
    if (closeRequestedHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_CLOSE_REQUESTED, closeRequestedHandler as never);
    }
    closeRequestedHandler = (): void => callback();
    ipcRenderer.on(IPC_CHANNELS.WINDOW_CLOSE_REQUESTED, closeRequestedHandler as never);
  },
  /** L-1 修复：确认关闭（渲染层 flush 完成后调用，主进程弹对话框让用户选择最小化/退出） */
  confirmClose: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CONFIRM_CLOSE),

  /** 强制退出应用（直接 app.quit()，触发 before-quit 清理） */
  forceQuit: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_FORCE_QUIT),
  /** 监听主进程退出前停止播放通知（TTS/音频），收到后应立即取消 speechSynthesis / 暂停音频 */
  onStopPlayback: (callback: () => void): void => {
    if (stopPlaybackHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.APP_STOP_PLAYBACK, stopPlaybackHandler as never);
    }
    stopPlaybackHandler = (): void => callback();
    ipcRenderer.on(IPC_CHANNELS.APP_STOP_PLAYBACK, stopPlaybackHandler as never);
  },
  /** 取消监听停止播放通知 */
  offStopPlayback: (): void => {
    if (stopPlaybackHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.APP_STOP_PLAYBACK, stopPlaybackHandler as never);
      stopPlaybackHandler = null;
    }
  },
  /** 切换窗口全屏状态（调用 Electron BrowserWindow.setFullScreen） */
  toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_TOGGLE_FULLSCREEN),
  /** 查询窗口是否处于全屏状态 */
  isFullscreen: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_FULLSCREEN),
  /** 监听主进程推送的全屏状态变化（F11 / OS 快捷键 / setFullScreen 触发） */
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void): void => {
    if (fullscreenChangedHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, fullscreenChangedHandler as never);
    }
    fullscreenChangedHandler = (_event: unknown, isFullscreen: boolean): void => callback(isFullscreen);
    ipcRenderer.on(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, fullscreenChangedHandler as never);
  },
  /** 取消监听全屏状态变化 */
  offFullscreenChanged: (): void => {
    if (fullscreenChangedHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, fullscreenChangedHandler as never);
      fullscreenChangedHandler = null;
    }
  }
};

/** 当前注册的 maximizeChanged handler 引用（用于精确移除） */
let maximizeChangedHandler: ((_event: unknown, isMaximized: boolean) => void) | null = null;

/** L-1 修复：当前注册的 closeRequested handler 引用 */
let closeRequestedHandler: ((_event: unknown) => void) | null = null;

/** 当前注册的 stopPlayback handler 引用（用于精确移除） */
let stopPlaybackHandler: ((_event: unknown) => void) | null = null;

/** 当前注册的 fullscreenChanged handler 引用 */
let fullscreenChangedHandler: ((_event: unknown, isFullscreen: boolean) => void) | null = null;

/** 当前注册的 dataRootChanged handler 引用（用于精确移除） */
let dataRootChangedHandler: ((_event: unknown, payload: { newPath: string }) => void) | null = null;

/** 当前注册的 migrateProgress handler 引用（用于精确移除） */
let migrateProgressHandler:
  ((_event: unknown, progress: { current: number; total: number; entry?: string; done?: boolean }) => void) | null =
  null;

/** 应用信息 API */
export const appApi = {
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
  getPaths: (): Promise<{
    userData: string;
    config: string;
    books: string;
    covers: string;
    cache: string;
  }> => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PATHS),
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.APP_SELECT_DIRECTORY),
  /** 在系统文件管理器中打开数据目录（target: userData/books/covers/cache 枚举） */
  openPath: (target: string): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_PATH, target),
  /** 数据目录迁移：移动 books/covers/youdu.db 到 <newRoot>/Youdu 并写 youdu-config.json（剪切语义，旧目录数据清理） */
  migrateData: (newRoot: string): Promise<{ ok: boolean; newPath: string; oldPath: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_MIGRATE_DATA, newRoot),
  /** 监听主进程推送的数据目录切换通知（迁移后所有窗口需刷新书架/设置） */
  onDataRootChanged: (callback: (newPath: string) => void): void => {
    if (dataRootChangedHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.APP_DATA_ROOT_CHANGED, dataRootChangedHandler as never);
    }
    dataRootChangedHandler = (_e: unknown, payload: { newPath: string }): void => callback(payload.newPath);
    ipcRenderer.on(IPC_CHANNELS.APP_DATA_ROOT_CHANGED, dataRootChangedHandler as never);
  },
  /** 取消数据目录切换监听 */
  offDataRootChanged: (): void => {
    if (dataRootChangedHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.APP_DATA_ROOT_CHANGED, dataRootChangedHandler as never);
      dataRootChangedHandler = null;
    }
  },
  /** 监听数据迁移进度 */
  onMigrateProgress: (
    handler: (progress: { current: number; total: number; entry?: string; done?: boolean }) => void
  ): void => {
    if (migrateProgressHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.APP_MIGRATE_PROGRESS, migrateProgressHandler as never);
    }
    migrateProgressHandler = (
      _event: unknown,
      data: { current: number; total: number; entry?: string; done?: boolean }
    ): void => handler(data);
    ipcRenderer.on(IPC_CHANNELS.APP_MIGRATE_PROGRESS, migrateProgressHandler as never);
  },
  /** 取消数据迁移进度监听 */
  offMigrateProgress: (): void => {
    if (migrateProgressHandler) {
      ipcRenderer.removeAllListeners(IPC_CHANNELS.APP_MIGRATE_PROGRESS);
      migrateProgressHandler = null;
    }
  }
};

/** 数据库 API（M2 数据层） */
export const dbApi = {
  // ─── 分组 ───
  group: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.GROUP_LIST),
    create: (input: { name: string; sort_order?: number }) => ipcRenderer.invoke(IPC_CHANNELS.GROUP_CREATE, input),
    update: (id: number, input: { name?: string; sort_order?: number }) =>
      ipcRenderer.invoke(IPC_CHANNELS.GROUP_UPDATE, id, input),
    delete: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.GROUP_DELETE, id),
    reorder: (orders: { id: number; sort_order: number }[]) => ipcRenderer.invoke(IPC_CHANNELS.GROUP_REORDER, orders)
  },

  // ─── 书籍 ───
  book: {
    list: (params?: {
      group_id?: number | null;
      group_filter?: 'ungrouped' | null;
      keyword?: string;
      sort_field?: 'last_read_at' | 'updated_at' | 'title' | 'created_at' | 'sort_order';
      sort_order?: 'asc' | 'desc';
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_LIST, params),
    get: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_GET, id),
    create: (input: {
      group_id?: number | null;
      source_id?: number | null;
      source_book_id?: string | null;
      title: string;
      author?: string | null;
      cover?: string | null;
      intro?: string | null;
      catalog_url?: string | null;
      local_file_path?: string | null;
      file_type?: string | null;
      encoding?: string | null;
      total_chapters?: number | null;
      custom_meta?: string | null;
      sort_order?: number;
    }) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_CREATE, input),
    update: (
      id: number,
      input: {
        group_id?: number | null;
        title?: string;
        author?: string | null;
        cover?: string | null;
        intro?: string | null;
        catalog_url?: string | null;
        local_file_path?: string | null;
        file_type?: string | null;
        encoding?: string | null;
        total_chapters?: number | null;
        custom_meta?: string | null;
        sort_order?: number;
        last_read_at?: number;
        reading_status?: string | null;
        rating?: number | null;
        /** 是否为漫画（0=否, 1=是） */
        is_comic?: number;
        /** 内容三分类 'text'=文本, 'illustrated'=图文, 'comic'=漫画 */
        content_type?: 'text' | 'illustrated' | 'comic';
      }
    ) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_UPDATE, id, input),
    delete: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_DELETE, id),
    batchDelete: (ids: number[]) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_BATCH_DELETE, ids),
    batchMove: (ids: number[], groupId: number | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.BOOK_BATCH_MOVE, ids, groupId),
    touchRead: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_TOUCH_READ, id),
    /** 获取相关推荐书籍（同作者/相似书名/阅读历史关联） */
    getRelated: (bookId: number, limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_GET_RELATED, bookId, limit),
    /** 按需读取章节正文（M6：从原文件读取，缓存到 DB） */
    readChapter: (bookId: number, chapterIndex: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.BOOK_READ_CHAPTER, bookId, chapterIndex),
    /** P1-9修复：预加载下一章（P1-2：翻页时预热缓存，fire-and-forget） */
    preloadNextChapter: (bookId: number, chapterIndex: number): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOOK_PRELOAD_NEXT_CHAPTER, bookId, chapterIndex),
    /** P1-9修复：全文搜索（在书籍所有章节内容中搜索关键词，对标 Kindle/Apple Books） */
    search: (bookId: number, keyword: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.BOOK_SEARCH, bookId, keyword),
    /** 取消书籍的所有章节读取任务（切换书时调用，避免旧任务占用 CPU） */
    cancelReads: (bookId: number) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_CANCEL_READS, bookId),
    /** 清理书籍在 worker 中的缓存（书籍关闭时调用，释放内存） */
    clearWorkerCache: (bookId?: number) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_CLEAR_WORKER_CACHE, bookId),
    /** 重新分章（M9：重新解析文件并更新章节索引） */
    reparse: (bookId: number) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_REPARSE, bookId),
    /** 导出书籍文件（复制原始文件到用户选择的目录） */
    export: (bookIds: number[]) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_EXPORT, bookIds),
    /** 设置自定义封面（复制图片到 data/covers/，更新 book.cover） */
    setCover: (bookId: number, imagePath: string) => ipcRenderer.invoke(IPC_CHANNELS.BOOK_SET_COVER, bookId, imagePath)
  },

  // ─── 章节 ───
  chapter: {
    listIndexes: (bookId: number) => ipcRenderer.invoke(IPC_CHANNELS.CHAPTER_LIST_INDEXES, bookId),
    get: (bookId: number, chapterIndex: number) => ipcRenderer.invoke(IPC_CHANNELS.CHAPTER_GET, bookId, chapterIndex),
    getContent: (bookId: number, chapterIndex: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAPTER_GET_CONTENT, bookId, chapterIndex),
    setContent: (bookId: number, chapterIndex: number, content: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAPTER_SET_CONTENT, bookId, chapterIndex, content),
    batchInsertIndexes: (
      input: {
        book_id: number;
        chapter_index: number;
        title?: string | null;
        file_offset?: number | null;
        file_length?: number | null;
        url?: string | null;
      }[]
    ) => ipcRenderer.invoke(IPC_CHANNELS.CHAPTER_BATCH_INSERT_INDEXES, input),
    /** 读取章节图片（漫画模式），返回图片文件路径列表 */
    readImages: (bookId: number, chapterIndex: number): Promise<string[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAPTER_READ_IMAGES, bookId, chapterIndex)
  },

  // ─── 阅读进度 ───
  progress: {
    save: (input: {
      book_id: number;
      chapter_index: number;
      chapter_offset?: number;
      scroll_position?: number;
      read_time?: number;
    }) => ipcRenderer.invoke(IPC_CHANNELS.PROGRESS_SAVE, input),
    load: (bookId: number) => ipcRenderer.invoke(IPC_CHANNELS.PROGRESS_LOAD, bookId)
  },

  // ─── 书签 ───
  bookmark: {
    add: (input: {
      book_id: number;
      chapter_index: number;
      position?: number | null;
      content?: string | null;
      note?: string | null;
    }) => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_ADD, input),
    list: (bookId: number) => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_LIST, bookId),
    get: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_GET, id),
    update: (
      id: number,
      input: {
        position?: number | null;
        content?: string | null;
        note?: string | null;
      }
    ) => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_UPDATE, id, input),
    remove: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_REMOVE, id)
  },

  // ─── 设置 ───
  setting: {
    get: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.SETTING_GET, key),
    set: (key: string, value: string) => ipcRenderer.invoke(IPC_CHANNELS.SETTING_SET, key, value),
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.SETTING_GET_ALL),
    delete: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.SETTING_DELETE, key)
  },

  // ─── 内容替换规则（v18 新增，支持全局/单本书 A→B 替换） ───
  replaceRule: {
    /** 添加内容替换规则 */
    add: (input: {
      pattern: string;
      replacement: string;
      scope: 'global' | 'book';
      book_id?: number | null;
      is_regex?: number;
    }) => ipcRenderer.invoke(IPC_CHANNELS.REPLACE_RULE_ADD, input),
    /** 查询全部内容替换规则（按创建时间倒序，设置页面用） */
    list: () => ipcRenderer.invoke(IPC_CHANNELS.REPLACE_RULE_LIST),
    /** 删除内容替换规则 */
    delete: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.REPLACE_RULE_DELETE, id),
    /** 启停内容替换规则（enabled: 0=禁用 1=启用） */
    toggle: (id: number, enabled: number) => ipcRenderer.invoke(IPC_CHANNELS.REPLACE_RULE_TOGGLE, id, enabled)
  },

  // ─── 阅读会话（v6 新增，阅读统计分析） ───
  readingSession: {
    /** 创建阅读会话（阅读器退出时调用） */
    create: (input: {
      book_id: number;
      start_time: number;
      end_time: number;
      duration: number;
      chapters_read?: number;
      chars_read?: number;
    }) => ipcRenderer.invoke(IPC_CHANNELS.READING_SESSION_CREATE, input),
    /** 查询某书阅读统计汇总（总时长/总字数/总章节数/session 数） */
    stats: (bookId: number) => ipcRenderer.invoke(IPC_CHANNELS.READING_SESSION_STATS, bookId),
    /** 查询某书最近 N 天的按天阅读统计（用于趋势图） */
    daily: (bookId: number, days: number) => ipcRenderer.invoke(IPC_CHANNELS.READING_SESSION_DAILY, bookId, days)
  },

  // ─── 高亮/划线（v7 新增） ───
  highlight: {
    /** 添加高亮 */
    add: (input: {
      book_id: number;
      chapter_index: number;
      start_offset: number;
      end_offset: number;
      color?: string;
      text?: string | null;
      note?: string | null;
    }) => ipcRenderer.invoke(IPC_CHANNELS.HIGHLIGHT_ADD, input),
    /** 查某本书的全部高亮 */
    list: (bookId: number) => ipcRenderer.invoke(IPC_CHANNELS.HIGHLIGHT_LIST, bookId),
    /** 查某章节的高亮 */
    listByChapter: (bookId: number, chapterIndex: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.HIGHLIGHT_LIST_BY_CHAPTER, bookId, chapterIndex),
    /** 更新高亮（颜色/笔记） */
    update: (
      id: number,
      input: {
        color?: string;
        note?: string | null;
      }
    ) => ipcRenderer.invoke(IPC_CHANNELS.HIGHLIGHT_UPDATE, id, input),
    /** 删除高亮 */
    remove: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.HIGHLIGHT_DELETE, id)
  },

  // ─── 阅读统计（全局，v8 新增） ───
  readingStats: {
    /** 全局阅读统计汇总（总时长/总次数/总字数/平均速度） */
    global: () => ipcRenderer.invoke(IPC_CHANNELS.READING_STATS_GLOBAL),
    /** 今日阅读统计 */
    today: () => ipcRenderer.invoke(IPC_CHANNELS.READING_STATS_TODAY),
    /** 最近 N 天阅读统计 */
    range: (days: number) => ipcRenderer.invoke(IPC_CHANNELS.READING_STATS_RANGE, days),
    /** 跨所有书籍按天聚合（热图用） */
    daily: (days: number) => ipcRenderer.invoke(IPC_CHANNELS.READING_STATS_DAILY, days),
    /** 阅读连续天数（streak） */
    streak: () => ipcRenderer.invoke(IPC_CHANNELS.READING_STATS_STREAK),
    /** 最常阅读 Top N */
    topBooks: (limit: number) => ipcRenderer.invoke(IPC_CHANNELS.READING_STATS_TOP_BOOKS, limit)
  }
};

/** 书籍格式导出 / 缓存管理 API */
export const exportApi = {
  /** 清空缓存目录，返回删除文件数 */
  clearCache: (): Promise<{
    success: boolean;
    deletedCount: number;
    cachePath: string;
  }> => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_CLEAR_CACHE),
  /** 导出单本书为 TXT，返回保存路径；用户取消返回 null */
  exportBookTxt: (bookId: number): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_BOOK_TXT, bookId),
  /** 导出单本书为 EPUB，返回保存路径；用户取消返回 null */
  exportBookEpub: (bookId: number): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_BOOK_EPUB, bookId),
  /** 导出单本漫画为 CBZ（ZIP 包含所有图片），返回保存路径；用户取消返回 null */
  exportBookCbz: (bookId: number): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_BOOK_CBZ, bookId),
  /** 导出全部书籍为 TXT（每本书一个文件，保存到用户选择的目录） */
  exportAllBooksTxt: (): Promise<{
    dirPath: string;
    count: number;
    skipped: string[];
  } | null> => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_ALL_BOOKS_TXT)
};

/** 文件导入进度数据（主进程推送） */
interface ImportProgressData {
  /** 当前文件序号（从 1 开始） */
  current: number;
  /** 总文件数 */
  total: number;
  /** 当前文件名 */
  fileName: string;
  /** 当前阶段状态 */
  status: 'hashing' | 'parsing' | 'importing' | 'done' | 'skipped' | 'failed';
  /** 当前文件解析进度（0~1） */
  fileProgress?: number;
  /** 导入成功的书名（status=done 时） */
  bookTitle?: string;
  /** 跳过/失败原因 */
  reason?: string;
}

/** 导入完成汇总结果 */
interface ImportSummaryResult {
  results: Array<{
    filePath: string;
    fileName: string;
    skipped: boolean;
    reason?: string;
    failed: boolean;
    error?: string;
    book?: unknown;
  }>;
  summary: {
    total: number;
    success: number;
    skipped: number;
    failed: number;
  };
}

/** 文件导入 API（M4） */
export const importApi = {
  /** 打开文件选择对话框（多选，过滤 txt/epub/mobi/pdf），返回选中文件路径数组 */
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SELECT_FILES),
  /** 打开文件夹选择对话框，返回路径；用户取消返回 null */
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SELECT_DIRECTORY),
  /** 打开图片选择对话框（单选，过滤 jpg/png/webp），返回路径；用户取消返回 null */
  selectImage: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SELECT_IMAGE),
  /** 传入文件路径数组，执行批量导入 */
  importFiles: (paths: string[], groupId?: number | null, parseMode?: string): Promise<ImportSummaryResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_FILES, paths, groupId, parseMode),
  /** 传入文件夹路径，扫描后批量导入 */
  importDirectory: (dirPath: string, groupId?: number | null): Promise<ImportSummaryResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_DIRECTORY, dirPath, groupId),

  /** 监听主进程推送的导入进度 */
  onProgress: (callback: (data: ImportProgressData) => void): void => {
    // 先移除旧 handler，避免重复注册导致泄漏
    if (importProgressHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.IMPORT_PROGRESS, importProgressHandler as never);
    }
    // 精确保存 handler 引用，offProgress 时按引用移除（B-11）
    importProgressHandler = (_e: unknown, data: ImportProgressData): void => callback(data);
    ipcRenderer.on(IPC_CHANNELS.IMPORT_PROGRESS, importProgressHandler as never);
  },
  /** 取消进度监听（精确移除当前 handler，不影响其他组件注册的监听器） */
  offProgress: (): void => {
    if (importProgressHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.IMPORT_PROGRESS, importProgressHandler as never);
      importProgressHandler = null;
    }
  },
  /** 监听单本书导入成功（后台增量显示用，每本成功触发一次） */
  onBookAdded: (callback: (book: Book) => void): void => {
    if (importBookAddedHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.IMPORT_BOOK_ADDED, importBookAddedHandler as never);
    }
    importBookAddedHandler = (_e: unknown, book: Book): void => callback(book);
    ipcRenderer.on(IPC_CHANNELS.IMPORT_BOOK_ADDED, importBookAddedHandler as never);
  },
  /** 取消单本书导入成功监听 */
  offBookAdded: (): void => {
    if (importBookAddedHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.IMPORT_BOOK_ADDED, importBookAddedHandler as never);
      importBookAddedHandler = null;
    }
  },
  /** 监听批量导入完成 */
  onComplete: (
    callback: (summary: { total: number; success: number; skipped: number; failed: number }) => void
  ): void => {
    if (importCompleteHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.IMPORT_COMPLETE, importCompleteHandler as never);
    }
    importCompleteHandler = (
      _e: unknown,
      summary: { total: number; success: number; skipped: number; failed: number }
    ): void => callback(summary);
    ipcRenderer.on(IPC_CHANNELS.IMPORT_COMPLETE, importCompleteHandler as never);
  },
  /** 取消批量导入完成监听 */
  offComplete: (): void => {
    if (importCompleteHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.IMPORT_COMPLETE, importCompleteHandler as never);
      importCompleteHandler = null;
    }
  },
  /** 获取拖拽 File 对象的完整文件系统路径（Electron 32+ webUtils.getPathForFile） */
  getFilePath: (file: File): string => webUtils.getPathForFile(file)
};

/** 当前注册的 import:progress handler 引用（用于精确移除） */
let importProgressHandler: ((_e: unknown, data: ImportProgressData) => void) | null = null;

/** 当前注册的 import:bookAdded handler 引用（用于精确移除） */
let importBookAddedHandler: ((_e: unknown, book: Book) => void) | null = null;

/** 当前注册的 import:complete handler 引用（用于精确移除） */
let importCompleteHandler:
  ((_e: unknown, summary: { total: number; success: number; skipped: number; failed: number }) => void) | null = null;

/** 订阅源 API（v11 新增） */
export const subscriptionApi = {
  /** 添加订阅 */
  add: (input: {
    name: string;
    type: 'folder' | 'rss' | 'http';
    url: string;
    config?: string | null;
    check_interval?: number;
    enabled?: number;
    auto_import?: number;
  }): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_ADD, input),
  /** 移除订阅（不删除关联书籍） */
  remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_REMOVE, id),
  /** 列出全部订阅 */
  list: (): Promise<unknown[]> => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_LIST),
  /** 获取单个订阅 */
  get: (id: number): Promise<unknown | undefined> => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_GET, id),
  /** 更新订阅配置 */
  update: (
    id: number,
    input: {
      name?: string;
      url?: string;
      config?: string | null;
      check_interval?: number;
      enabled?: number;
      auto_import?: number;
      last_check_at?: number;
    }
  ): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_UPDATE, id, input),
  /** 手动检查单个订阅更新 */
  checkUpdate: (
    id: number
  ): Promise<{
    subscriptionId: number;
    subscriptionName: string;
    type: string;
    success: boolean;
    newCount: number;
    newItems?: Array<{ title: string; link: string; pubDate: number | null; content: string; guid: string }>;
    error?: string;
  }> => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_CHECK_UPDATE, id),
  /** 手动检查所有订阅更新 */
  checkAllUpdates: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_CHECK_ALL_UPDATES),
  /** 获取有更新的书籍列表（书架徽章用） */
  getUpdates: (): Promise<unknown[]> => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_GET_UPDATES),
  /** 获取某订阅关联的书籍 */
  getBooks: (subscriptionId: number): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_GET_BOOKS, subscriptionId),
  /** 标记书籍更新状态（清除/设置徽章） */
  markBookUpdate: (bookId: number, hasUpdate: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_MARK_BOOK_UPDATE, bookId, hasUpdate),
  /** 清除所有书籍更新标记 */
  clearAllUpdates: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_CLEAR_ALL_UPDATES),
  /** 添加订阅源（自动检测格式） */
  addSmart: (
    url: string,
    name?: string
  ): Promise<{
    kind: 'subscription' | 'opds';
    subscriptionId?: number;
    subscriptionName?: string;
    contentType?: string;
    warning?: string;
  }> => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_ADD_SMART, url, name)
};

/** Shell API（打开外部链接等） */
export const shellApi = {
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url)
};

// 暴露到渲染进程 window 对象
contextBridge.exposeInMainWorld('windowApi', windowApi);
contextBridge.exposeInMainWorld('appApi', appApi);
contextBridge.exposeInMainWorld('dbApi', dbApi);
contextBridge.exposeInMainWorld('exportApi', exportApi);
contextBridge.exposeInMainWorld('importApi', importApi);
contextBridge.exposeInMainWorld('subscriptionApi', subscriptionApi);
contextBridge.exposeInMainWorld('shellApi', shellApi);

/** OPDS 书库浏览 API（v19 新增） */
export const opdsApi = {
  addCatalog: (input: {
    name: string;
    url: string;
    username?: string;
    password?: string;
  }): Promise<{
    id: number;
    name: string;
    url: string;
    hasAuth?: boolean;
  }> => ipcRenderer.invoke(IPC_CHANNELS.OPDS_ADD_CATALOG, input),
  listCatalogs: (): Promise<
    Array<{
      id: number;
      name: string;
      url: string;
      hasAuth?: boolean;
    }>
  > => ipcRenderer.invoke(IPC_CHANNELS.OPDS_LIST_CATALOGS),
  removeCatalog: (id: number): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OPDS_REMOVE_CATALOG, id),
  browse: (
    url: string,
    catalogId?: number
  ): Promise<{
    title: string;
    navigationLinks: Array<{
      title: string;
      href: string;
      rel: string;
      isNavigation: boolean;
    }>;
    entries: Array<{
      title: string;
      author: string;
      summary: string;
      coverUrl?: string;
      downloadUrl: string;
      format: string;
      categories: string[];
      id?: string;
    }>;
    nextLink?: string;
    previousLink?: string;
    searchUrl?: string;
    selfLink?: string;
  }> => ipcRenderer.invoke(IPC_CHANNELS.OPDS_BROWSE, url, catalogId),
  search: (
    catalogUrl: string,
    query: string,
    catalogId?: number
  ): Promise<{
    title: string;
    navigationLinks: Array<{
      title: string;
      href: string;
      rel: string;
      isNavigation: boolean;
    }>;
    entries: Array<{
      title: string;
      author: string;
      summary: string;
      coverUrl?: string;
      downloadUrl: string;
      format: string;
      categories: string[];
      id?: string;
    }>;
    nextLink?: string;
    previousLink?: string;
    searchUrl?: string;
    selfLink?: string;
  }> => ipcRenderer.invoke(IPC_CHANNELS.OPDS_SEARCH, catalogUrl, query, catalogId),
  download: (
    downloadUrl: string,
    filename: string,
    format: string,
    catalogId?: number,
    groupId?: number | null
  ): Promise<{ success: boolean; bookId?: number; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.OPDS_DOWNLOAD, downloadUrl, filename, format, catalogId, groupId)
};

contextBridge.exposeInMainWorld('opdsApi', opdsApi);

/** 网络配置 API（v20 新增，设置页"网络"标签页） */
export const networkApi = {
  /** 获取网络配置（User-Agent/自定义头/代理/超时重试） */
  getConfig: (): Promise<{
    userAgent: string;
    customHeaders: Array<{ key: string; value: string }>;
    proxy: { enabled: boolean; type: string; host: string; port: number };
    timeout: number;
    retryCount: number;
    retryDelay: number;
  }> => ipcRenderer.invoke(IPC_CHANNELS.NETWORK_CONFIG_GET),
  /** 设置网络配置（User-Agent/自定义头/代理/超时重试） */
  setConfig: (config: {
    userAgent: string;
    customHeaders: Array<{ key: string; value: string }>;
    proxy: { enabled: boolean; type: string; host: string; port: number };
    timeout: number;
    retryCount: number;
    retryDelay: number;
  }): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.NETWORK_CONFIG_SET, config)
};

contextBridge.exposeInMainWorld('networkApi', networkApi);

/** 书架刷新 API（主进程通知渲染进程书架数据已变更） */
let bookshelfRefreshHandler: (() => void) | null = null;
export const bookshelfApi = {
  /** 监听主进程推送的书架刷新通知（RSS/OPDS 导入后触发） */
  onRefresh: (callback: () => void): void => {
    if (bookshelfRefreshHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.BOOKSHELF_REFRESH, bookshelfRefreshHandler as never);
    }
    bookshelfRefreshHandler = (): void => callback();
    ipcRenderer.on(IPC_CHANNELS.BOOKSHELF_REFRESH, bookshelfRefreshHandler as never);
  },
  /** 取消书架刷新监听 */
  offRefresh: (): void => {
    if (bookshelfRefreshHandler) {
      ipcRenderer.removeListener(IPC_CHANNELS.BOOKSHELF_REFRESH, bookshelfRefreshHandler as never);
      bookshelfRefreshHandler = null;
    }
  }
};

contextBridge.exposeInMainWorld('bookshelfApi', bookshelfApi);

