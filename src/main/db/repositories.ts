/**
 * 数据库 Repository 合并模块
 *
 * 包含所有数据库表的 CRUD 操作、共享类型定义和延迟初始化工具。
 * 合并自原 repositories/ 目录下的12个文件。
 */
import { getDb } from './index';
import { safeStorage } from 'electron';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { Book, Bookmark, ChapterIndex, ImportMode } from '../../shared';
import type { ProducerStatRow } from '../core/parsers/classify-producer-stats';
export type { Book, Bookmark, ChapterIndex, ImportMode };

/* ==================== OPDS 密码加密工具 ==================== */

/**
 * 加密 OPDS 密码（使用 Electron safeStorage）
 *
 * safeStorage 使用操作系统级加密（Windows: DPAPI, macOS: Keychain, Linux: libsecret）。
 * 加密后的数据以 base64 字符串存储在数据库中。
 * 当 safeStorage 不可用时（如 Linux 无 secretstore），回退为明文存储。
 */
function encryptPassword(plain: string | null | undefined): string | null {
  if (!plain) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(plain);
      return 'enc:' + encrypted.toString('base64');
    }
  } catch (err) {
    console.error('[opds] 密码加密失败，回退明文:', err);
  }
  return plain;
}

/**
 * 解密 OPDS 密码
 *
 * 识别 'enc:' 前缀的加密数据并解密；无前缀的视为明文（向后兼容旧数据）。
 */
function decryptPassword(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith('enc:')) {
    try {
      const buf = Buffer.from(stored.slice(4), 'base64');
      return safeStorage.decryptString(buf);
    } catch (err) {
      console.error('[opds] 密码解密失败:', err);
      return null;
    }
  }
  return stored;
}

/* ==================== 延迟初始化工具 ==================== */

/**
 * 延迟初始化工具
 *
 * Repository 的预编译 SQL 语句需要在数据库初始化后才能 prepare，
 * 但模块加载发生在数据库初始化之前。用 lazy 包裹后，首次调用时才初始化。
 *
 * @example
 * const stmt = lazy(() => {
 *   const db = getDb()
 *   return { insert: db.prepare('INSERT ...') }
 * })
 * // 首次调用时初始化，后续直接返回缓存
 * stmt().insert.run(...)
 */
export function lazy<T>(factory: () => T): () => T {
  // 用独立标志位判定，避免 factory() 返回 null/undefined 时每次重新初始化
  let cached: T;
  let initialized = false;
  return (): T => {
    if (!initialized) {
      cached = factory();
      initialized = true;
    }
    return cached;
  };
}

/* ==================== 共享类型定义 ==================== */

/* -------------------- 分组 -------------------- */

/** groups 表行类型 */
export interface Group {
  id: number;
  name: string;
  sort_order: number;
  created_at: number | null;
}

/** 创建分组输入 */
export interface CreateGroupInput {
  name: string;
  sort_order?: number;
}

/** 更新分组输入（部分字段） */
export interface UpdateGroupInput {
  name?: string;
  sort_order?: number;
}

/* -------------------- 书籍 -------------------- */

/** books 表行类型（从 shared.ts re-export，消除重复定义） */

/** 创建书籍输入 */
export interface CreateBookInput {
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
  file_hash?: string | null;
  sort_order?: number;
  is_comic?: number;
  /** v21 新增：内容三分类 'text'=文本, 'illustrated'=图文, 'comic'=漫画 */
  content_type?: 'text' | 'illustrated' | 'comic';
  /** v11 新增：关联订阅源 id */
  subscription_id?: number | null;
  /** v11 新增：在线源的原始URL */
  source_url?: string | null;
  /** v12 新增：书籍来源 'local'=本地, 'online'=在线, 'download'=下载 */
  book_source?: 'local' | 'online' | 'download' | null;
  /** v26 新增（批次 v54）：导入存储模式 'copy'=复制（默认）, 'move'=移动, 'link'=引用 */
  import_mode?: ImportMode;
  /** v29 新增：系列名（ComicInfo.xml Series 或文件名模式提取，如"哆啦A梦[大长篇][台版]"） */
  series?: string | null;
  /** v29 新增：系列内序号（卷号，同名书区分与自然排序用；REAL 语义支持小数卷号） */
  series_number?: number | null;
  /** v29 新增：系列总数（ComicInfo.xml Count，"第N卷/共M卷"展示用） */
  series_total?: number | null;
}

/** 更新书籍输入（部分字段，只更新传入的字段） */
export interface UpdateBookInput {
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
  file_hash?: string;
  sort_order?: number;
  last_read_at?: number;
  reading_status?: string | null;
  rating?: number | null;
  is_comic?: number;
  /** v21 新增：内容三分类 'text'=文本, 'illustrated'=图文, 'comic'=漫画 */
  content_type?: 'text' | 'illustrated' | 'comic';
  /** v11 新增：关联订阅源 id */
  subscription_id?: number | null;
  /** v11 新增：标记有新更新（0/1） */
  has_update?: number;
  /** v11 新增：在线源的原始URL */
  source_url?: string | null;
  /** v12 新增：书籍来源 'local'=本地, 'online'=在线, 'download'=下载 */
  book_source?: 'local' | 'online' | 'download';
  /** v26 新增（批次 v54）：导入存储模式 'copy'=复制, 'move'=移动, 'link'=引用 */
  import_mode?: ImportMode;
}

/** 书籍排序字段白名单 */
export type BookSortField = 'last_read_at' | 'updated_at' | 'title' | 'created_at' | 'sort_order' | 'author';

/** 书籍类型筛选：text(纯文本)/illustrated(图文)/comic(漫画) */
export type BookTypeFilter = 'text' | 'illustrated' | 'comic';

/** 书籍列表查询参数 */
export interface BookListParams {
  group_id?: number | null;
  group_filter?: 'ungrouped' | null;
  keyword?: string;
  sort_field?: BookSortField;
  sort_order?: 'asc' | 'desc';
  reading_status?: string | null;
  /** 书籍类型筛选（text/illustrated/comic），不传或 null 表示不筛选 */
  book_type?: BookTypeFilter | null;
  limit?: number;
  offset?: number;
}

/** 删除书籍结果（返回被删书籍的文件信息，供调用方清理文件） */
export interface DeleteBookResult {
  id: number;
  local_file_path: string | null;
  cover: string | null;
  /** v26 新增（批次 v54）：导入存储模式。删除分流依据：link 书默认不删原文件
   *  （仅用户主动勾选"同时删除原文件"且路径不在 userData 内才删）。 */
  import_mode: ImportMode | null;
}

/** 相关书籍推荐结果项（Book + 关联类型标记） */
export interface RelatedBook extends Book {
  relation: 'same_author' | 'similar_title' | 'reading_history';
  relationLabel: string;
}

/** 相关书籍推荐结果 */
export interface RelatedBookResult {
  books: RelatedBook[];
  counts: {
    same_author: number;
    similar_title: number;
    reading_history: number;
  };
}

/* -------------------- 章节 -------------------- */

/** chapters 表行类型（含 content） */
export interface Chapter {
  id: number;
  book_id: number;
  chapter_index: number;
  title: string | null;
  content: string | null;
  file_offset: number | null;
  file_length: number | null;
  url: string | null;
  content_type: string | null;
  /** 卷层级（v14 新增）：记录章节所属卷标题 */
  volume: string | null;
  cached_at: number | null;
  last_accessed: number | null;
}

/** 章节索引（不含 content，目录用，从 shared.ts re-export） */

/** 批量插入章节索引输入 */
export interface InsertChapterIndexInput {
  book_id: number;
  chapter_index: number;
  title?: string | null;
  file_offset?: number | null;
  file_length?: number | null;
  url?: string | null;
  content_type?: string | null;
  volume?: string | null;
}

/* -------------------- 阅读进度 -------------------- */

/** reading_progress 表行类型 */
export interface ReadingProgress {
  book_id: number;
  chapter_index: number;
  chapter_offset: number;
  scroll_position: number;
  read_time: number;
  updated_at: number | null;
}

/** 保存阅读进度输入 */
export interface SaveProgressInput {
  book_id: number;
  chapter_index: number;
  chapter_offset?: number;
  scroll_position?: number;
  read_time?: number;
}

/* -------------------- 书签 -------------------- */

/** bookmarks 表行类型（从 shared.ts re-export） */

/** 创建书签输入 */
export interface CreateBookmarkInput {
  book_id: number;
  chapter_index: number;
  position?: number | null;
  content?: string | null;
  note?: string | null;
  highlight_color?: string | null;
}

/** 更新书签输入（部分字段） */
export interface UpdateBookmarkInput {
  position?: number | null;
  content?: string | null;
  note?: string | null;
  highlight_color?: string | null;
}

/* -------------------- 阅读会话 -------------------- */

/** reading_sessions 表行类型 */
export interface ReadingSession {
  id: number;
  book_id: number;
  start_time: number;
  end_time: number;
  duration: number;
  chapters_read: number;
  chars_read: number;
}

/** 创建阅读会话输入 */
export interface CreateReadingSessionInput {
  book_id: number;
  start_time: number;
  end_time: number;
  duration: number;
  chapters_read?: number;
  chars_read?: number;
}

/** 书籍阅读统计汇总 */
export interface BookReadingStats {
  total_duration: number;
  total_chars: number;
  total_chapters: number;
  session_count: number;
}

/** 按天阅读统计（趋势图用） */
export interface DailyReadingStat {
  date: string;
  duration: number;
  chars_read: number;
  chapters_read: number;
}

/* -------------------- 内容替换规则（v18 新增） -------------------- */

/** 替换规则作用范围：global=全局生效，book=仅指定书籍 */
export type ReplaceRuleScope = 'global' | 'book';

/** replace_rules 表行类型 */
export interface ReplaceRule {
  id: number;
  /** 要替换的文本（或正则表达式源串） */
  pattern: string;
  /** 替换为的内容 */
  replacement: string;
  /** 作用范围：global=全局，book=仅指定书籍 */
  scope: ReplaceRuleScope;
  /** scope='book' 时关联的书籍 ID；scope='global' 时为 null */
  book_id: number | null;
  /** 0=纯文本匹配，1=正则表达式 */
  is_regex: number;
  /** 0=禁用，1=启用 */
  enabled: number;
  created_at: number | null;
}

/** 创建内容替换规则输入 */
export interface CreateReplaceRuleInput {
  pattern: string;
  replacement: string;
  scope: ReplaceRuleScope;
  /** scope='book' 时必传书籍 ID */
  book_id?: number | null;
  /** 0=纯文本匹配，1=正则表达式，默认 0 */
  is_regex?: number;
}

/** 更新内容替换规则输入（部分字段） */
export interface UpdateReplaceRuleInput {
  enabled?: number;
  replacement?: string;
}


/* -------------------- 阅读状态 -------------------- */

/** 阅读状态类型：reading(在读)/completed(已读)/want_to_read(想读)/dropped(弃读) */
export type ReadingStatus = 'reading' | 'completed' | 'want_to_read' | 'dropped' | null;

/* -------------------- 订阅源（v11 新增） -------------------- */

/** 订阅类型：folder=本地文件夹, rss=RSS/Atom, http=HTTP网页源 */
export type SubscriptionType = 'folder' | 'rss' | 'http';

/** subscriptions 表行类型 */
export interface Subscription {
  id: number;
  name: string;
  type: SubscriptionType;
  url: string;
  /** JSON 配置字符串（过滤规则、扩展名等） */
  config: string | null;
  last_check_at: number | null;
  /** 检查间隔（毫秒，默认 1 小时） */
  check_interval: number;
  /** 是否启用（0=禁用, 1=启用） */
  enabled: number;
  /** 是否自动导入新文件（0=否, 1=是） */
  auto_import: number;
  created_at: number | null;
}

/** 创建订阅输入 */
export interface CreateSubscriptionInput {
  name: string;
  type: SubscriptionType;
  url: string;
  config?: string | null;
  check_interval?: number;
  enabled?: number;
  auto_import?: number;
}

/** 更新订阅输入（部分字段） */
export interface UpdateSubscriptionInput {
  name?: string;
  url?: string;
  config?: string | null;
  check_interval?: number;
  enabled?: number;
  auto_import?: number;
  last_check_at?: number;
}

/** 订阅配置（JSON 解析后的结构） */
export interface SubscriptionConfig {
  /** 文件夹监控：允许的文件扩展名（如 ['.txt', '.epub']），空数组表示全部支持 */
  extensions?: string[];
  /** RSS/HTTP：上次检查到的最新条目 guid 或链接（用于增量筛选新条目） */
  lastGuid?: string;
  /** HTTP 源：章节列表 CSS 选择器 */
  listSelector?: string;
  /** HTTP 源：章节链接 CSS 选择器 */
  linkSelector?: string;
  /** HTTP 源：章节标题 CSS 选择器 */
  titleSelector?: string;
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** 是否递归监控子目录（folder 类型） */
  recursive?: boolean;
  /** 自动创建的分组 id（RSS/HTTP 导入的书籍归入此分组） */
  groupId?: number;
}

/* ==================== 书籍 Repository ==================== */

/** 排序字段白名单（防 SQL 注入，字段名需拼接） */
const SORT_FIELD_MAP: Record<BookSortField, string> = {
  last_read_at: 'last_read_at',
  updated_at: 'updated_at',
  title: 'title',
  created_at: 'created_at',
  sort_order: 'sort_order',
  author: 'author'
};

/** 预编译 SQL 语句（延迟初始化） */
const bookStmt = lazy(() => {
  const db = getDb();
  return {
    insert: db.prepare(
      `INSERT INTO books (
         group_id, source_id, source_book_id, title, author, cover, intro,
         catalog_url, local_file_path, file_type, encoding, total_chapters,
         custom_meta, file_hash, sort_order, last_read_at, is_comic, content_type,
         subscription_id, source_url, book_source, import_mode,
         series, series_number, series_total,
         created_at, updated_at
       ) VALUES (
         @group_id, @source_id, @source_book_id, @title, @author, @cover, @intro,
         @catalog_url, @local_file_path, @file_type, @encoding, @total_chapters,
         @custom_meta, @file_hash, @sort_order, @last_read_at, @is_comic, @content_type,
         @subscription_id, @source_url, @book_source, @import_mode,
         @series, @series_number, @series_total,
         @created_at, @updated_at
       )`
    ),
    getById: db.prepare('SELECT * FROM books WHERE id = ?'),
    getBySource: db.prepare('SELECT * FROM books WHERE source_id = ? AND source_book_id = ?'),
    getByHash: db.prepare('SELECT * FROM books WHERE file_hash = ?'),
    maxSortOrder: db.prepare('SELECT MAX(sort_order) as max FROM books'),
    touchLastRead: db.prepare('UPDATE books SET last_read_at = ? WHERE id = ?'),
    delChapters: db.prepare('DELETE FROM chapters WHERE book_id = ?'),
    delProgress: db.prepare('DELETE FROM reading_progress WHERE book_id = ?'),
    delBookmarks: db.prepare('DELETE FROM bookmarks WHERE book_id = ?'),
    delSessions: db.prepare('DELETE FROM reading_sessions WHERE book_id = ?'),
    delBook: db.prepare('DELETE FROM books WHERE id = ?'),
    moveBook: db.prepare('UPDATE books SET group_id = ?, updated_at = ? WHERE id = ?'),
    // ─── 相关书籍推荐查询 ───
    /** 同作者推荐：按阅读时间倒序，未读排后 */
    getRelatedByAuthor: db.prepare(
      `SELECT * FROM books WHERE author = ? AND id != ? ORDER BY last_read_at DESC NULLS LAST LIMIT ?`
    ),
    /** 相似书名推荐：按书名前缀 LIKE 匹配 */
    getRelatedByTitle: db.prepare(
      `SELECT * FROM books WHERE title LIKE ? AND id != ? ORDER BY last_read_at DESC NULLS LAST LIMIT ?`
    ),
    /** 最近阅读书籍的作者列表（用于阅读历史关联推荐） */
    getRecentReadAuthors: db.prepare(
      `SELECT DISTINCT b.author FROM books b
       JOIN reading_progress rp ON rp.book_id = b.id
       WHERE b.id != ? AND b.author IS NOT NULL AND b.author != ?
       ORDER BY rp.updated_at DESC LIMIT 5`
    )
  };
});

/**
 * 预编译语句缓存（按 SQL 文本签名），避免 listBooks/countBooks 每次重新 prepare。
 * better-sqlite3 的 prepare 开销不大但高频调用仍有成本，缓存后仅首次 prepare。
 */
const STATEMENT_CACHE_MAX = 100;

const statementCache = new Map<string, ReturnType<DatabaseType['prepare']>>();

function getCachedStatement(sql: string): ReturnType<DatabaseType['prepare']> {
  let s = statementCache.get(sql);
  if (s) {
    statementCache.delete(sql);
    statementCache.set(sql, s);
    return s;
  }
  s = getDb().prepare(sql);
  statementCache.set(sql, s);
  if (statementCache.size > STATEMENT_CACHE_MAX) {
    const oldest = statementCache.keys().next().value;
    if (oldest !== undefined) statementCache.delete(oldest);
  }
  return s;
}

/**

 * 转义 LIKE 查询中的特殊字符（% _ \），避免用户输入破坏模式匹配。
 *
 * SQLite LIKE 中 `%` 匹配任意字符序列、`_` 匹配单个字符，
 * 用户输入这些字符时需用 `\` 转义（配合 ESCAPE '\' 子句）。
 *
 * @param s 原始字符串
 * @returns 转义后的字符串（可安全用于 LIKE 模式）
 */
function escapeLikePattern(s: string): string {
  return s.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

/**
 * 构建列表查询的 WHERE 子句和绑定参数（listBooks 与 countBooks 共用）
 * 排序字段走白名单校验，其余参数走 prepare 绑定。
 *
 * 搜索逻辑：有 keyword 时使用 LIKE 模糊匹配（title/author），无 keyword 时无搜索条件。
 *
 * 说明：原 FTS5 全文索引（books_fts）对中文分词支持不佳（unicode61 tokenizer
 * 将连续中文字符当作单个 token，导致搜不到中文书名），改用 LIKE 查询。
 * books_fts 表仍保留在 schema 中，但不再用于搜索。
 */
function buildWhereClause(params: BookListParams): {
  whereSql: string;
  bindParams: Record<string, unknown>;
  /** 是否包含关键词搜索条件（调用方据此决定排序策略） */
  hasKeyword: boolean;
} {
  const where: string[] = [];
  const bind: Record<string, unknown> = {};

  // 分组过滤
  if (params.group_filter === 'ungrouped') {
    where.push('group_id IS NULL');
  } else if (typeof params.group_id === 'number') {
    where.push('group_id = @group_id');
    bind.group_id = params.group_id;
  }

  // 阅读状态过滤
  if (params.reading_status) {
    where.push('reading_status = @reading_status');
    bind.reading_status = params.reading_status;
  }

  // 关键词搜索：LIKE 模糊匹配 title/author（支持中文，不依赖 FTS5 分词）
  const keyword = params.keyword?.trim() ?? '';
  const hasKeyword = keyword.length > 0;
  if (hasKeyword) {
    const pattern = `%${escapeLikePattern(keyword)}%`;
    where.push("(title LIKE @keywordPattern ESCAPE '\\' OR author LIKE @keywordPattern ESCAPE '\\')");
    bind.keywordPattern = pattern;
  }

  // 书籍类型过滤（文本/图文/漫画）
  // 修复：WHERE 子句必须与 SELECT 中的 book_category（COALESCE 兜底逻辑）完全一致，
  // 否则 content_type 为 NULL 的旧书（依赖 is_comic 或 chapters 推导）会被错误过滤。
  // 三个分支统一使用与 buildListQuery 中 SELECT book_category 相同的 COALESCE 表达式，
  // 确保 WHERE 与 SELECT 对同一行的分类判定完全一致。
  if (params.book_type) {
    // book_category 兜底表达式：content_type 优先，其次 is_comic，再查 chapters，最后 text
    const bookCategoryExpr = `COALESCE(books.content_type, CASE WHEN books.is_comic = 1 THEN 'comic' WHEN EXISTS (SELECT 1 FROM chapters WHERE book_id = books.id AND content_type IN ('illustrated', 'image')) THEN 'illustrated' ELSE 'text' END)`;
    if (params.book_type === 'comic') {
      where.push(`${bookCategoryExpr} = 'comic'`);
    } else if (params.book_type === 'text') {
      where.push(`${bookCategoryExpr} = 'text'`);
    } else if (params.book_type === 'illustrated') {
      where.push(`${bookCategoryExpr} = 'illustrated'`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, bindParams: bind, hasKeyword };
}

/**
 * 构建列表查询 SQL（动态 WHERE + ORDER BY + LIMIT）
 * 排序字段走白名单校验，其余参数走 prepare 绑定。
 *
 * 统一使用普通 SELECT（不再 JOIN books_fts）：
 * - 有搜索关键词：按 title 排序（FTS5 rank 相关性排序不再可用，用 title 代替）
 * - 无搜索关键词：按用户指定字段排序
 */
function buildListQuery(params: BookListParams): {
  sql: string;
  bindParams: Record<string, unknown>;
} {
  const { whereSql, bindParams: bind, hasKeyword } = buildWhereClause(params);

  // 分页
  const limit = params.limit ?? -1;
  const offset = params.offset ?? 0;
  bind._limit = limit;
  bind._offset = offset;

  // 排序：有搜索关键词时按 title 排序（相关性排序不再可用），否则按用户指定字段
  // v29：title 排序追加 series_number 次级排序——同名系列书按卷号自然顺序排列
  //（54 本"哆啦A梦[大长篇][台版]"重名场景：第1卷→第54卷），无卷号的书排同名组末尾
  let orderSql: string;
  if (hasKeyword) {
    orderSql = 'ORDER BY title ASC, series_number ASC NULLS LAST';
  } else {
    const sortField = params.sort_field ?? 'last_read_at';
    const sortColumn = SORT_FIELD_MAP[sortField];
    const direction = params.sort_order === 'asc' ? 'ASC' : 'DESC';
    const nullOrder = direction === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';
    orderSql = `ORDER BY ${sortColumn} ${direction} ${nullOrder}`;
    if (sortColumn === 'title') {
      orderSql += `, series_number ${direction} NULLS LAST`;
    }
  }

  const sql = `SELECT id, group_id, source_id, source_book_id, title, author, cover,
    intro, custom_meta,
    file_type, encoding, local_file_path, file_hash, total_chapters,
    last_read_at, reading_status, rating,
    is_comic, content_type, has_update, sort_order, created_at, updated_at,
    subscription_id, catalog_url, source_url, book_source, import_mode,
    series, series_number, series_total,
    COALESCE(content_type,
      CASE
        WHEN is_comic = 1 THEN 'comic'
        WHEN EXISTS (SELECT 1 FROM chapters WHERE book_id = books.id AND content_type IN ('illustrated', 'image')) THEN 'illustrated'
        ELSE 'text'
      END) as book_category
    FROM books ${whereSql} ${orderSql} LIMIT @_limit OFFSET @_offset`;

  return { sql, bindParams: bind };
}

/** 创建书籍 */
export function createBook(input: CreateBookInput): Book {
  const s = bookStmt();
  const now = Date.now();
  // v21：content_type 与 is_comic 保持一致。
  // 优先用传入的 content_type；未传则由 is_comic 推导（向后兼容旧调用方）。
  const contentType = input.content_type ?? (input.is_comic === 1 ? 'comic' : 'text');
  const isComic = input.is_comic ?? (contentType === 'comic' ? 1 : 0);
  const result = s.insert.run({
    group_id: input.group_id ?? null,
    source_id: input.source_id ?? null,
    source_book_id: input.source_book_id ?? null,
    title: input.title,
    author: input.author ?? null,
    cover: input.cover ?? null,
    intro: input.intro ?? null,
    catalog_url: input.catalog_url ?? null,
    local_file_path: input.local_file_path ?? null,
    file_type: input.file_type ?? null,
    encoding: input.encoding ?? null,
    total_chapters: input.total_chapters ?? null,
    custom_meta: input.custom_meta ?? null,
    file_hash: input.file_hash ?? null,
    sort_order: input.sort_order ?? 0,
    last_read_at: null,
    is_comic: isComic,
    content_type: contentType,
    subscription_id: input.subscription_id ?? null,
    source_url: input.source_url ?? null,
    book_source: input.book_source ?? 'local',
    // v26（批次 v54）：导入存储模式，缺省 'copy'（与 DB DEFAULT 一致，显式传值利于阅读）
    import_mode: input.import_mode ?? 'copy',
    // v29：系列信息（ComicInfo.xml 或文件名模式提取，同名书区分与自然排序用）
    series: input.series ?? null,
    series_number: input.series_number ?? null,
    series_total: input.series_total ?? null,
    created_at: now,
    updated_at: now
  });

  const newId = result.lastInsertRowid as number;

  return s.getById.get(newId) as Book;
}

/** 根据 id 查询书籍 */
export function getBookById(id: number): Book | undefined {
  return bookStmt().getById.get(id) as Book | undefined;
}

/** 根据 file_hash 查询书籍（本地文件去重用，单次索引查询） */
export function getBookByHash(fileHash: string): Book | undefined {
  return bookStmt().getByHash.get(fileHash) as Book | undefined;
}

/** 书籍列表（分组过滤 + 关键词搜索 + 排序 + 分页） */
export function listBooks(params: BookListParams = {}): Book[] {
  const { sql, bindParams } = buildListQuery(params);
  // 用 SQL 文本做签名缓存预编译语句，避免每次 prepare
  return getCachedStatement(sql).all(bindParams) as Book[];
}

/** 书籍总数（配合 listBooks 分页） */
export function countBooks(params: BookListParams = {}): number {
  const { whereSql, bindParams } = buildWhereClause(params);
  const countSql = `SELECT COUNT(*) as count FROM books ${whereSql}`;
  const row = getCachedStatement(countSql).get(bindParams) as { count: number };
  return row.count;
}


/** 更新书籍（部分字段，只更新传入的字段） */
export function updateBook(id: number, input: UpdateBookInput): void {
  const existing = getBookById(id);
  if (!existing) {
    throw new Error(`[book] 书籍不存在: id=${id}`);
  }

  const sets: string[] = [];
  const bind: Record<string, unknown> = { id };

  if (input.group_id !== undefined) {
    sets.push('group_id = @group_id');
    bind.group_id = input.group_id;
  }
  if (input.title !== undefined) {
    sets.push('title = @title');
    bind.title = input.title;
  }
  if (input.author !== undefined) {
    sets.push('author = @author');
    bind.author = input.author;
  }
  if (input.cover !== undefined) {
    sets.push('cover = @cover');
    bind.cover = input.cover;
  }
  if (input.intro !== undefined) {
    sets.push('intro = @intro');
    bind.intro = input.intro;
  }
  if (input.catalog_url !== undefined) {
    sets.push('catalog_url = @catalog_url');
    bind.catalog_url = input.catalog_url;
  }
  if (input.local_file_path !== undefined) {
    sets.push('local_file_path = @local_file_path');
    bind.local_file_path = input.local_file_path;
  }
  if (input.file_type !== undefined) {
    sets.push('file_type = @file_type');
    bind.file_type = input.file_type;
  }
  if (input.encoding !== undefined) {
    sets.push('encoding = @encoding');
    bind.encoding = input.encoding;
  }
  if (input.total_chapters !== undefined) {
    sets.push('total_chapters = @total_chapters');
    bind.total_chapters = input.total_chapters;
  }
  if (input.custom_meta !== undefined) {
    sets.push('custom_meta = @custom_meta');
    bind.custom_meta = input.custom_meta;
  }
  if (input.file_hash !== undefined) {
    sets.push('file_hash = @file_hash');
    bind.file_hash = input.file_hash;
  }
  if (input.sort_order !== undefined) {
    sets.push('sort_order = @sort_order');
    bind.sort_order = input.sort_order;
  }
  if (input.last_read_at !== undefined) {
    sets.push('last_read_at = @last_read_at');
    bind.last_read_at = input.last_read_at;
  }
  if (input.reading_status !== undefined) {
    sets.push('reading_status = @reading_status');
    bind.reading_status = input.reading_status;
  }
  if (input.rating !== undefined) {
    sets.push('rating = @rating');
    bind.rating = input.rating;
  }
  // P1-7 修复：is_comic 与 content_type 双字段同步
  // 规则：content_type='comic' 时 is_comic=1，其余 content_type 时 is_comic=0
  // 当只传了其中一个字段时，自动推导另一个字段，确保两者始终一致。
  if (input.is_comic !== undefined && input.content_type === undefined) {
    // 只传 is_comic：根据 is_comic 推导 content_type
    sets.push('is_comic = @is_comic');
    bind.is_comic = input.is_comic;
    sets.push('content_type = @content_type');
    bind.content_type = input.is_comic === 1 ? 'comic' : 'text';
  } else if (input.content_type !== undefined && input.is_comic === undefined) {
    // 只传 content_type：根据 content_type 推导 is_comic
    sets.push('content_type = @content_type');
    bind.content_type = input.content_type;
    sets.push('is_comic = @is_comic');
    bind.is_comic = input.content_type === 'comic' ? 1 : 0;
  } else if (input.is_comic !== undefined && input.content_type !== undefined) {
    // 两个都传了：都写入（调用方负责保证一致性）
    sets.push('is_comic = @is_comic');
    bind.is_comic = input.is_comic;
    sets.push('content_type = @content_type');
    bind.content_type = input.content_type;
  }
  if (input.subscription_id !== undefined) {
    sets.push('subscription_id = @subscription_id');
    bind.subscription_id = input.subscription_id;
  }
  if (input.has_update !== undefined) {
    sets.push('has_update = @has_update');
    bind.has_update = input.has_update;
  }
  if (input.source_url !== undefined) {
    sets.push('source_url = @source_url');
    bind.source_url = input.source_url;
  }
  if (input.book_source !== undefined) {
    sets.push('book_source = @book_source');
    bind.book_source = input.book_source;
  }
  // v26（批次 v54）：导入存储模式（copy/move/link）
  if (input.import_mode !== undefined) {
    sets.push('import_mode = @import_mode');
    bind.import_mode = input.import_mode;
  }

  if (sets.length === 0) return;

  sets.push('updated_at = @updated_at');
  bind.updated_at = Date.now();

  getDb()
    .prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = @id`)
    .run(bind);
}

/** 更新阅读进度时间（轻量更新，不改 updated_at） */
export function touchLastReadAt(id: number): void {
  bookStmt().touchLastRead.run(Date.now(), id);
}

/**
 * 删除单本书籍（事务保证一致性）
 *
 * 事务内删除：books + chapters + reading_progress + bookmarks + reading_sessions
 * 返回被删书籍的 local_file_path 和 cover，供调用方清理文件。
 * 文件删除失败不应回滚 DB（DB 已提交），由调用方记日志。
 */
export function deleteBook(bookId: number): DeleteBookResult | null {
  const s = bookStmt();
  const db = getDb();

  let result: DeleteBookResult | null = null;

  db.transaction(() => {
    const book = s.getById.get(bookId) as Book | undefined;
    if (!book) return;

    result = {
      id: book.id,
      local_file_path: book.local_file_path,
      cover: book.cover,
      import_mode: book.import_mode ?? null
    };

    s.delChapters.run(bookId);
    s.delProgress.run(bookId);
    s.delBookmarks.run(bookId);
    s.delSessions.run(bookId);
    highlightStmt().deleteByBook.run(bookId);
    // F1修复：级联清理分类反馈样本——删书不清理会让 classification_feedback
    // 残留孤儿 book_id，污染 k-NN 反馈闭环的样本统计（高优先级缺陷）
    deleteClassifyFeedbackByBook(bookId);
    s.delBook.run(bookId);
  })();

  return result;
}

/**
 * 批量删除书籍（事务保证一致性）
 *
 * @returns 被删书籍的文件信息列表，供调用方批量清理文件
 */
export function deleteBooks(bookIds: number[]): DeleteBookResult[] {
  if (bookIds.length === 0) return [];

  const s = bookStmt();
  const db = getDb();
  const results: DeleteBookResult[] = [];

  db.transaction(() => {
    for (const id of bookIds) {
      const book = s.getById.get(id) as Book | undefined;
      if (!book) continue;
      results.push({
        id: book.id,
        local_file_path: book.local_file_path,
        cover: book.cover,
        import_mode: book.import_mode ?? null
      });
      s.delChapters.run(id);
      s.delProgress.run(id);
      s.delBookmarks.run(id);
      s.delSessions.run(id);
      highlightStmt().deleteByBook.run(id);
      // F1修复：级联清理分类反馈样本（与 deleteBook 同口径，事务内执行）
      deleteClassifyFeedbackByBook(id);
      s.delBook.run(id);
    }
  })();

  return results;
}

/**
 * 批量移动书籍到指定分组
 */
export function moveBooksToGroup(bookIds: number[], groupId: number | null): void {
  if (bookIds.length === 0) return;
  const s = bookStmt();
  const db = getDb();
  const now = Date.now();
  db.transaction(() => {
    for (const id of bookIds) {
      s.moveBook.run(groupId, now, id);
    }
  })();
}

/** 获取书籍下一个可用 sort_order */
export function nextBookSortOrder(): number {
  const row = bookStmt().maxSortOrder.get() as { max: number | null };
  return (row.max ?? -1) + 1;
}

/* -------------------- 相关书籍推荐 -------------------- */

/**
 * 获取相关推荐书籍（纯 SQL 实现，无需 ML）
 *
 * 推荐策略（按优先级从高到低）：
 * 1. 同作者推荐 — 同一作者的其他书籍，按最近阅读时间排序
 * 2. 相似书名推荐 — 书名前 2 字符 LIKE 前缀匹配
 * 3. 阅读历史关联 — 用户最近阅读的其他书籍的同作者书籍
 *
 * 去重：已选书籍不会在后续类别中重复出现。
 * 排序：同作者 > 相似书名 > 阅读关联，各类内部按 last_read_at 倒序。
 *
 * @param bookId 当前书籍 ID
 * @param limit  返回的最大推荐数量（默认 8）
 * @returns 推荐结果（含书籍列表 + 各类型计数）
 */
export function getRelatedBooks(bookId: number, limit = 8): RelatedBookResult {
  const s = bookStmt();
  const book = getBookById(bookId);
  const emptyResult: RelatedBookResult = {
    books: [],
    counts: { same_author: 0, similar_title: 0, reading_history: 0 }
  };
  if (!book) return emptyResult;

  const result: RelatedBook[] = [];
  const seenIds = new Set<number>([bookId]);
  const counts = { same_author: 0, similar_title: 0, reading_history: 0 };
  const perCategoryLimit = Math.max(limit, 5);

  // ─── 1. 同作者推荐 ───
  if (book.author && book.author.trim()) {
    const rows = s.getRelatedByAuthor.all(book.author, bookId, perCategoryLimit) as Book[];
    for (const b of rows) {
      if (!seenIds.has(b.id)) {
        seenIds.add(b.id);
        result.push({ ...b, relation: 'same_author', relationLabel: '同作者' });
        counts.same_author++;
      }
    }
  }

  // ─── 2. 相似书名推荐 ───
  const titlePrefix = book.title.slice(0, 2);
  if (titlePrefix.length >= 1) {
    const rows = s.getRelatedByTitle.all(`${titlePrefix}%`, bookId, perCategoryLimit) as Book[];
    for (const b of rows) {
      if (!seenIds.has(b.id)) {
        seenIds.add(b.id);
        result.push({ ...b, relation: 'similar_title', relationLabel: '相似书名' });
        counts.similar_title++;
      }
    }
  }

  // ─── 3. 基于阅读历史关联推荐 ───
  if (result.length < limit) {
    const recentAuthors = s.getRecentReadAuthors.all(bookId, book.author ?? null) as { author: string | null }[];

    for (const { author } of recentAuthors) {
      if (result.length >= limit) break;
      if (!author) continue;
      const rows = s.getRelatedByAuthor.all(author, bookId, perCategoryLimit) as Book[];
      for (const b of rows) {
        if (result.length >= limit) break;
        if (!seenIds.has(b.id)) {
          seenIds.add(b.id);
          result.push({ ...b, relation: 'reading_history', relationLabel: '阅读关联' });
          counts.reading_history++;
        }
      }
    }
  }

  return { books: result.slice(0, limit), counts };
}

/* ==================== 章节 Repository ==================== */

/** 预编译 SQL 语句（延迟初始化） */
const chapterStmt = lazy(() => {
  const db = getDb();
  return {
    listIndexes: db.prepare(
      `SELECT id, book_id, chapter_index, title, file_offset, file_length, url, content_type, volume, cached_at
         FROM chapters
        WHERE book_id = ?
        ORDER BY chapter_index ASC`
    ),
    getByBookAndIndex: db.prepare('SELECT * FROM chapters WHERE book_id = ? AND chapter_index = ?'),
    getById: db.prepare('SELECT * FROM chapters WHERE id = ?'),
    insertIndex: db.prepare(
      `INSERT OR IGNORE INTO chapters (
         book_id, chapter_index, title, file_offset, file_length, url, content_type, volume, cached_at
       ) VALUES (
         @book_id, @chapter_index, @title, @file_offset, @file_length, @url, @content_type, @volume, @cached_at
       )`
    ),
    getContent: db.prepare('SELECT content FROM chapters WHERE book_id = ? AND chapter_index = ?'),
    setContent: db.prepare(
      `UPDATE chapters
          SET content = @content,
              cached_at = @cached_at,
              last_accessed = @last_accessed
        WHERE book_id = @book_id AND chapter_index = @chapter_index`
    ),
    /** 更新章节最后访问时间戳（P0-3：LRU 淘汰排序依据） */
    touchAccess: db.prepare(
      `UPDATE chapters
          SET last_accessed = @last_accessed
        WHERE book_id = @book_id AND chapter_index = @chapter_index`
    ),
    /** 查询所有已缓存章节的总字符数（用于估算总字节数，判断是否需要淘汰） */
    getTotalContentSize: db.prepare('SELECT sum(length(content)) AS total FROM chapters WHERE content IS NOT NULL'),
    /** 按 last_accessed 升序列出已缓存章节（最久未访问在前，供 LRU 逐个淘汰） */
    listForEviction: db.prepare(
      `SELECT book_id, chapter_index, length(content) AS size
         FROM chapters
        WHERE content IS NOT NULL
        ORDER BY last_accessed ASC`
    ),
    clearContent: db.prepare('UPDATE chapters SET content = NULL WHERE book_id = ? AND chapter_index = ?'),
    deleteByBook: db.prepare('DELETE FROM chapters WHERE book_id = ?'),
    countByBook: db.prepare('SELECT COUNT(*) as count FROM chapters WHERE book_id = ?')
  };
});

/** 按 book_id 查章节索引列表（不含 content，按 chapter_index 排序） */
export function listChapterIndexes(bookId: number): ChapterIndex[] {
  return chapterStmt().listIndexes.all(bookId) as ChapterIndex[];
}

/** 查单章（含 content） */
export function getChapter(bookId: number, chapterIndex: number): Chapter | undefined {
  return chapterStmt().getByBookAndIndex.get(bookId, chapterIndex) as Chapter | undefined;
}


/**
 * 批量插入章节索引（INSERT OR IGNORE，重复跳过）
 *
 * 用于本地文件解析后一次性写入章节目录。
 * 不写 content，仅写索引（title / file_offset / file_length / url）。
 */
export function batchInsertChapterIndexes(input: InsertChapterIndexInput[]): number {
  if (input.length === 0) return 0;

  const s = chapterStmt();
  const db = getDb();
  const now = Date.now();

  const result = db.transaction((items: InsertChapterIndexInput[]) => {
    let inserted = 0;
    for (const item of items) {
      const r = s.insertIndex.run({
        book_id: item.book_id,
        chapter_index: item.chapter_index,
        title: item.title ?? null,
        file_offset: item.file_offset ?? null,
        file_length: item.file_length ?? null,
        url: item.url ?? null,
        content_type: item.content_type ?? 'text',
        volume: item.volume ?? null,
        cached_at: now
      });
      if (r.changes > 0) inserted++;
    }
    return inserted;
  })(input);

  return result;
}

/** 查询章节内容缓存（仅当 content 非空时返回） */
export function getChapterContent(bookId: number, chapterIndex: number): string | null {
  const row = chapterStmt().getContent.get(bookId, chapterIndex) as { content: string | null } | undefined;
  return row?.content ?? null;
}

/** 存储章节内容缓存（更新已有章节记录的 content 字段，同时刷新 last_accessed） */
export function setChapterContent(bookId: number, chapterIndex: number, content: string): void {
  const now = Date.now();
  chapterStmt().setContent.run({
    book_id: bookId,
    chapter_index: chapterIndex,
    content,
    cached_at: now,
    last_accessed: now
  });
}

/**
 * 更新章节最后访问时间戳（P0-3：LRU 淘汰排序依据）
 *
 * 读取章节时调用，记录访问时间。淘汰时按 last_accessed 升序（最久未访问优先）。
 */
export function touchChapterAccess(bookId: number, chapterIndex: number): void {
  chapterStmt().touchAccess.run({
    book_id: bookId,
    chapter_index: chapterIndex,
    last_accessed: Date.now()
  });
}

/** 章节内容平均字节/字符比（UTF-8 中文约 3 字节，英文 1 字节，混合内容按 2.5 估算） */
const BYTES_PER_CHAR = 2.5;

/**
 * 章节缓存 LRU 淘汰（P0-3）
 *
 * 查询 chapters 表中所有 content IS NOT NULL 的总大小，超过阈值时
 * 按 last_accessed 升序（最久未访问优先）逐章 SET content = NULL，直到总大小低于阈值。
 *
 * 大小估算：SQLite length() 返回字符数，UTF-8 中文约 3 字节、英文 1 字节，
 * 混合内容按 2 字节/字符估算（BYTES_PER_CHAR）。
 *
 * @param maxTotalBytes 缓存总大小上限（字节），默认 500MB
 * @returns 实际淘汰的章节数
 */
export function evictChapterCache(maxTotalBytes: number = 500 * 1024 * 1024): number {
  const s = chapterStmt();

  // 1. 估算当前缓存总字节数
  const totalRow = s.getTotalContentSize.get() as { total: number | null };
  const totalChars = totalRow?.total ?? 0;
  const totalBytes = totalChars * BYTES_PER_CHAR;

  if (totalBytes <= maxTotalBytes) return 0;

  // 2. 按 last_accessed 升序逐章淘汰
  const candidates = s.listForEviction.all() as {
    book_id: number;
    chapter_index: number;
    size: number;
  }[];

  let evicted = 0;
  let currentBytes = totalBytes;
  getDb().transaction(() => {
    for (const c of candidates) {
      if (currentBytes <= maxTotalBytes) break;
      s.clearContent.run(c.book_id, c.chapter_index);
      currentBytes -= c.size * BYTES_PER_CHAR;
      evicted++;
    }
  })();
  return evicted;
}

/** 删除单章缓存内容（保留索引，清空 content） */
export function clearChapterContent(bookId: number, chapterIndex: number): void {
  chapterStmt().clearContent.run(bookId, chapterIndex);
}

/** 删除指定书籍的全部章节（删书时调用，book.repo 已封装事务） */
export function deleteChaptersByBookId(bookId: number): number {
  const result = chapterStmt().deleteByBook.run(bookId);
  return result.changes;
}

/* ==================== 书签 Repository ==================== */

/** 预编译 SQL 语句（延迟初始化） */
const bookmarkStmt = lazy(() => {
  const db = getDb();
  return {
    insert: db.prepare(
      `INSERT INTO bookmarks (
         book_id, chapter_index, position, content, note, highlight_color, created_at
       ) VALUES (
         @book_id, @chapter_index, @position, @content, @note, @highlight_color, @created_at
       )`
    ),
    getById: db.prepare('SELECT * FROM bookmarks WHERE id = ?'),
    listByBook: db.prepare('SELECT * FROM bookmarks WHERE book_id = ? ORDER BY chapter_index ASC, id ASC'),
    listByChapter: db.prepare('SELECT * FROM bookmarks WHERE book_id = ? AND chapter_index = ? ORDER BY id ASC'),
    delete: db.prepare('DELETE FROM bookmarks WHERE id = ?'),
    deleteByBook: db.prepare('DELETE FROM bookmarks WHERE book_id = ?')
  };
});

/** 添加书签 */
export function createBookmark(input: CreateBookmarkInput): Bookmark {
  const s = bookmarkStmt();
  const now = Date.now();
  const result = s.insert.run({
    book_id: input.book_id,
    chapter_index: input.chapter_index,
    position: input.position ?? null,
    content: input.content ?? null,
    note: input.note ?? null,
    highlight_color: input.highlight_color ?? null,
    created_at: now
  });

  return s.getById.get(result.lastInsertRowid) as Bookmark;
}

/** 根据 id 查书签 */
export function getBookmarkById(id: number): Bookmark | undefined {
  return bookmarkStmt().getById.get(id) as Bookmark | undefined;
}

/** 查某本书的全部书签（按 chapter_index 排序） */
export function listBookmarksByBookId(bookId: number): Bookmark[] {
  return bookmarkStmt().listByBook.all(bookId) as Bookmark[];
}

/** 更新书签（部分字段） */
export function updateBookmark(id: number, input: UpdateBookmarkInput): void {
  const existing = getBookmarkById(id);
  if (!existing) {
    throw new Error(`[bookmark] 书签不存在: id=${id}`);
  }

  const sets: string[] = [];
  const bind: Record<string, unknown> = { id };

  if (input.position !== undefined) {
    sets.push('position = @position');
    bind.position = input.position;
  }
  if (input.content !== undefined) {
    sets.push('content = @content');
    bind.content = input.content;
  }
  if (input.note !== undefined) {
    sets.push('note = @note');
    bind.note = input.note;
  }
  if (input.highlight_color !== undefined) {
    sets.push('highlight_color = @highlight_color');
    bind.highlight_color = input.highlight_color;
  }

  if (sets.length === 0) return;

  getDb()
    .prepare(`UPDATE bookmarks SET ${sets.join(', ')} WHERE id = @id`)
    .run(bind);
}

/** 删除书签 */
export function deleteBookmark(id: number): void {
  bookmarkStmt().delete.run(id);
}

/* ==================== 高亮/划线 Repository ==================== */

/**
 * 高亮清理预编译语句（延迟初始化）
 *
 * v7 高亮 CRUD 链路（IPC handler + preload + 渲染层 store）已整体删除，
 * 仅保留 deleteByBook 供 deleteBook/deleteBooks 事务级联清理孤儿高亮。
 */
const highlightStmt = lazy(() => {
  const db = getDb();
  return {
    deleteByBook: db.prepare('DELETE FROM highlights WHERE book_id = ?')
  };
});

/* ==================== 阅读进度 Repository ==================== */

/** 预编译 SQL 语句（延迟初始化） */
const progressStmt = lazy(() => {
  const db = getDb();
  return {
    save: db.prepare(
      `INSERT INTO reading_progress (
         book_id, chapter_index, chapter_offset, scroll_position,
         read_time, updated_at
       ) VALUES (
         @book_id, @chapter_index, @chapter_offset, @scroll_position,
         @read_time, @updated_at
       )
       ON CONFLICT(book_id) DO UPDATE SET
         chapter_index = @chapter_index,
         chapter_offset = @chapter_offset,
         scroll_position = @scroll_position,
         read_time = @read_time,
         updated_at = @updated_at`
    ),
    get: db.prepare('SELECT * FROM reading_progress WHERE book_id = ?'),
    delete: db.prepare('DELETE FROM reading_progress WHERE book_id = ?'),
    addReadTime: db.prepare(
      `UPDATE reading_progress SET
         read_time = read_time + @delta,
         updated_at = @now
       WHERE book_id = @book_id`
    )
  };
});

/** 保存阅读进度（UPSERT：存在则更新，不存在则插入） */
export function saveProgress(input: SaveProgressInput): void {
  progressStmt().save.run({
    book_id: input.book_id,
    chapter_index: input.chapter_index,
    chapter_offset: input.chapter_offset ?? 0,
    scroll_position: input.scroll_position ?? 0,
    read_time: input.read_time ?? 0,
    updated_at: Date.now()
  });
}

/** 读取阅读进度 */
export function getProgress(bookId: number): ReadingProgress | undefined {
  return progressStmt().get.get(bookId) as ReadingProgress | undefined;
}

/** 删除阅读进度（删书时调用） */
export function deleteProgress(bookId: number): void {
  progressStmt().delete.run(bookId);
}

/** 累加阅读时间（在不更新其他字段的情况下累加 read_time） */
export function addReadTime(bookId: number, deltaMs: number): void {
  progressStmt().addReadTime.run({
    book_id: bookId,
    delta: deltaMs,
    now: Date.now()
  });
}

/* ==================== 阅读会话 Repository ==================== */

/** 预编译 SQL 语句（延迟初始化） */
const sessionStmt = lazy(() => {
  const db = getDb();
  return {
    insert: db.prepare(
      `INSERT INTO reading_sessions (
         book_id, start_time, end_time, duration, chapters_read, chars_read
       ) VALUES (
         @book_id, @start_time, @end_time, @duration, @chapters_read, @chars_read
       )`
    ),
    listByBook: db.prepare('SELECT * FROM reading_sessions WHERE book_id = ? ORDER BY start_time DESC'),
    deleteByBook: db.prepare('DELETE FROM reading_sessions WHERE book_id = ?'),
    // 汇总统计：单条 SQL 聚合，COALESCE 保证空表返回 0
    statsByBook: db.prepare(
      `SELECT
         COALESCE(SUM(duration), 0) AS total_duration,
         COALESCE(SUM(chars_read), 0) AS total_chars,
         COALESCE(SUM(chapters_read), 0) AS total_chapters,
         COUNT(*) AS session_count
       FROM reading_sessions WHERE book_id = ?`
    )
  };
});

/** 创建阅读会话（阅读器退出时调用） */
export function createSession(input: CreateReadingSessionInput): void {
  sessionStmt().insert.run({
    book_id: input.book_id,
    start_time: input.start_time,
    end_time: input.end_time,
    duration: input.duration,
    chapters_read: input.chapters_read ?? 0,
    chars_read: input.chars_read ?? 0
  });
}

/** 查询某书阅读统计汇总（总时长/总字数/总章节数/session 数） */
export function getStatsByBookId(bookId: number): BookReadingStats {
  return sessionStmt().statsByBook.get(bookId) as BookReadingStats;
}

/**
 * 查询某书最近 N 天的按天阅读统计（用于趋势图）
 *
 * 用 strftime 按本地时区把 start_time（ms）映射到 YYYY-MM-DD，
 * 再按天 GROUP BY 聚合 duration/chars_read/chapters_read。
 * 仅返回有阅读记录的日期，调用方需自行补零以填充连续日期轴。
 *
 * @param bookId 书籍 id
 * @param days 统计天数（如 7 表示最近 7 天）
 */
export function getDailyStatsByBookId(bookId: number, days: number): DailyReadingStat[] {
  const db = getDb();
  const now = Date.now();
  const startTime = now - (days - 1) * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT
       strftime('%Y-%m-%d', start_time / 1000, 'unixepoch', 'localtime') AS date,
       SUM(duration) AS duration,
       SUM(chars_read) AS chars_read,
       SUM(chapters_read) AS chapters_read
     FROM reading_sessions
     WHERE book_id = ? AND start_time >= ?
     GROUP BY date
     ORDER BY date ASC`
    )
    .all(bookId, startTime) as DailyReadingStat[];
  return rows;
}

/* -------------------- 全局阅读统计（仪表盘） -------------------- */

/** 全局阅读统计汇总 */
export interface GlobalReadingStats {
  /** 总阅读时长（毫秒） */
  totalDuration: number;
  /** 总阅读次数 */
  totalSessions: number;
  /** 总阅读字数 */
  totalChars: number;
  /** 平均阅读速度（字/分钟） */
  avgSpeed: number;
}

/** 时间范围内的阅读统计（今日/本周/本月等） */
export interface RangeReadingStats {
  /** 阅读时长（毫秒） */
  duration: number;
  /** 阅读次数 */
  sessions: number;
  /** 阅读字数 */
  chars: number;
}

/** 跨所有书籍的按天阅读统计（热图用） */
export interface DailyReadingStatAllBooks {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 当天阅读时长（毫秒） */
  duration: number;
  /** 当天阅读字数 */
  chars: number;
}

/** 最常阅读的书籍项 */
export interface TopBookStat {
  /** 书籍 id */
  bookId: number;
  /** 书名 */
  title: string;
  /** 阅读时长（毫秒） */
  duration: number;
  /** 封面路径（可能为空） */
  cover?: string | null;
}

/** 一天的毫秒数 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 全局阅读统计汇总
 *
 * 汇总所有书籍的全部阅读会话：总时长、总次数、总字数、平均阅读速度。
 * 平均速度 = 总字数 / (总时长分钟)，总时长为 0 时返回 0 避免除零。
 */
export function getGlobalStats(): GlobalReadingStats {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
       COALESCE(SUM(duration), 0) AS total_duration,
       COALESCE(SUM(chars_read), 0) AS total_chars,
       COUNT(*) AS session_count
     FROM reading_sessions`
    )
    .get() as { total_duration: number; total_chars: number; session_count: number };

  const totalDuration = row.total_duration ?? 0;
  const totalChars = row.total_chars ?? 0;
  const totalSessions = row.session_count ?? 0;
  const totalMinutes = totalDuration / 60000;
  const avgSpeed = totalMinutes > 0 ? Math.round(totalChars / totalMinutes) : 0;

  return {
    totalDuration,
    totalSessions,
    totalChars,
    avgSpeed
  };
}

/**
 * 今日阅读统计
 *
 * 查询今天 0 点至今的阅读会话，按本地时区计算今日起点。
 */
export function getTodayStats(): RangeReadingStats {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return getRangeStatsFromStart(todayStart.getTime());
}

/**
 * 最近 N 天阅读统计
 *
 * @param days 天数（如 7 表示本周最近 7 天，30 表示本月最近 30 天）
 */
export function getRangeStats(days: number): RangeReadingStats {
  const now = Date.now();
  const startTime = now - (days - 1) * ONE_DAY_MS;
  return getRangeStatsFromStart(startTime);
}

/**
 * 按起始时间戳查询阅读统计（内部共用）
 *
 * @param startTime 起始时间戳（毫秒，含）
 */
function getRangeStatsFromStart(startTime: number): RangeReadingStats {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
       COALESCE(SUM(duration), 0) AS duration,
       COALESCE(SUM(chars_read), 0) AS chars,
       COUNT(*) AS sessions
     FROM reading_sessions
     WHERE start_time >= ?`
    )
    .get(startTime) as { duration: number; chars: number; sessions: number };

  return {
    duration: row.duration ?? 0,
    sessions: row.sessions ?? 0,
    chars: row.chars ?? 0
  };
}

/**
 * 跨所有书籍按天聚合的阅读统计（用于绘制阅读热图）
 *
 * 用 strftime 按本地时区分组，仅返回有阅读记录的日期，
 * 调用方需自行补零以填充连续日期轴。
 *
 * @param days 统计天数（如 30 表示最近 30 天）
 */
export function getDailyStatsAllBooks(days: number): DailyReadingStatAllBooks[] {
  const db = getDb();
  const now = Date.now();
  const startTime = now - (days - 1) * ONE_DAY_MS;
  const rows = db
    .prepare(
      `SELECT
       strftime('%Y-%m-%d', start_time / 1000, 'unixepoch', 'localtime') AS date,
       SUM(duration) AS duration,
       SUM(chars_read) AS chars
     FROM reading_sessions
     WHERE start_time >= ?
     GROUP BY date
     ORDER BY date ASC`
    )
    .all(startTime) as DailyReadingStatAllBooks[];
  return rows;
}

/**
 * 阅读连续天数（打卡 streak）
 *
 * 从今天往前数，连续有阅读记录的天数。今天若未阅读则从昨天开始计数。
 * 算法：先一次性查出所有有阅读记录的日期（去重升序），再从最新日期开始
 * 向前逐天检查是否连续，遇到断档即返回。
 */
export function getStreakDays(): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT
       strftime('%Y-%m-%d', start_time / 1000, 'unixepoch', 'localtime') AS date
     FROM reading_sessions
     ORDER BY date ASC`
    )
    .all() as { date: string }[];

  if (rows.length === 0) return 0;

  const dateSet = new Set<string>(rows.map((r) => r.date));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let cursor = new Date(today);
  if (!dateSet.has(formatDate(cursor))) {
    cursor = new Date(today.getTime() - ONE_DAY_MS);
  }

  let streak = 0;
  while (dateSet.has(formatDate(cursor))) {
    streak++;
    cursor = new Date(cursor.getTime() - ONE_DAY_MS);
  }
  return streak;
}

/** 格式化 Date 为 YYYY-MM-DD（本地时区） */
function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 最常阅读的书籍 Top N
 *
 * 按阅读时长倒序，JOIN books 表获取书名和封面。
 *
 * @param limit 返回条数（如 5 表示 Top5）
 */
export function getTopBooks(limit: number): TopBookStat[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
       rs.book_id AS bookId,
       b.title AS title,
       rs.duration AS duration,
       b.cover AS cover
     FROM (
       SELECT book_id, SUM(duration) AS duration
       FROM reading_sessions
       GROUP BY book_id
       ORDER BY duration DESC
       LIMIT ?
     ) rs
     JOIN books b ON b.id = rs.book_id
     ORDER BY rs.duration DESC`
    )
    .all(limit) as TopBookStat[];
  return rows;
}

/* ==================== 内容替换规则 Repository ==================== */

/** 预编译 SQL 语句（延迟初始化） */
const replaceRuleStmt = lazy(() => {
  const db = getDb();
  return {
    insert: db.prepare(
      `INSERT INTO replace_rules (pattern, replacement, scope, book_id, is_regex, created_at, enabled)
       VALUES (@pattern, @replacement, @scope, @book_id, @is_regex, @created_at, 1)`
    ),
    getById: db.prepare('SELECT * FROM replace_rules WHERE id = ?'),
    listAll: db.prepare('SELECT * FROM replace_rules ORDER BY created_at DESC'),
    listGlobalEnabled: db.prepare(
      `SELECT * FROM replace_rules
       WHERE scope = 'global' AND enabled = 1
       ORDER BY created_at DESC`
    ),
    listBookEnabled: db.prepare(
      `SELECT * FROM replace_rules
       WHERE scope = 'book' AND book_id = ? AND enabled = 1
       ORDER BY created_at DESC`
    ),
    delete: db.prepare('DELETE FROM replace_rules WHERE id = ?'),
    clear: db.prepare('DELETE FROM replace_rules')
  };
});

/** 创建内容替换规则 */
export function createReplaceRule(input: CreateReplaceRuleInput): ReplaceRule {
  const s = replaceRuleStmt();
  const now = Date.now();
  const result = s.insert.run({
    pattern: input.pattern,
    replacement: input.replacement,
    scope: input.scope,
    book_id: input.scope === 'book' ? (input.book_id ?? null) : null,
    is_regex: input.is_regex ?? 0,
    created_at: now
  });
  return s.getById.get(result.lastInsertRowid) as ReplaceRule;
}

/** 根据 id 查替换规则 */
export function getReplaceRuleById(id: number): ReplaceRule | undefined {
  return replaceRuleStmt().getById.get(id) as ReplaceRule | undefined;
}

/** 查全部替换规则（按创建时间倒序，设置页面用） */
export function listAllReplaceRules(): ReplaceRule[] {
  return replaceRuleStmt().listAll.all() as ReplaceRule[];
}

/** 查启用的全局替换规则（按创建时间倒序） */
export function listEnabledGlobalReplaceRules(): ReplaceRule[] {
  return replaceRuleStmt().listGlobalEnabled.all() as ReplaceRule[];
}

/** 查某本书启用的替换规则（按创建时间倒序） */
export function listEnabledBookReplaceRules(bookId: number): ReplaceRule[] {
  return replaceRuleStmt().listBookEnabled.all(bookId) as ReplaceRule[];
}

/** 更新替换规则（启停/修改 replacement） */
export function updateReplaceRule(id: number, input: UpdateReplaceRuleInput): void {
  const existing = getReplaceRuleById(id);
  if (!existing) {
    throw new Error(`[replace-rule] 替换规则不存在: id=${id}`);
  }

  const sets: string[] = [];
  const bind: Record<string, unknown> = { id };

  if (input.enabled !== undefined) {
    sets.push('enabled = @enabled');
    bind.enabled = input.enabled;
  }

  if (input.replacement !== undefined) {
    sets.push('replacement = @replacement');
    bind.replacement = input.replacement;
  }

  if (sets.length === 0) return;

  getDb()
    .prepare(`UPDATE replace_rules SET ${sets.join(', ')} WHERE id = @id`)
    .run(bind);
}

/** 删除替换规则 */
export function deleteReplaceRule(id: number): void {
  replaceRuleStmt().delete.run(id);
}

/* ==================== 设置 Repository ==================== */

/** 预编译 SQL 语句（延迟初始化） */
const settingsStmt = lazy(() => {
  const db = getDb();
  return {
    get: db.prepare('SELECT value FROM settings WHERE key = ?'),
    set: db.prepare(
      `INSERT INTO settings (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = @value`
    ),
    delete: db.prepare('DELETE FROM settings WHERE key = ?')
  };
});

/** 获取设置项（不存在返回 null） */
export function getSetting(key: string): string | null {
  const row = settingsStmt().get.get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

/** 获取设置项并 JSON.parse（不存在或解析失败返回 defaultValue） */
export function getSettingJson<T>(key: string, defaultValue: T): T {
  const raw = getSetting(key);
  if (raw === null) return defaultValue;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

/** 设置设置项（UPSERT） */
export function setSetting(key: string, value: string): void {
  settingsStmt().set.run({ key, value });
}

/** 删除设置项 */
export function deleteSetting(key: string): void {
  settingsStmt().delete.run(key);
}


/* ==================== 分组 Repository ==================== */

/** 预编译 SQL 语句（延迟初始化） */
const groupStmt = lazy(() => {
  const db = getDb();
  return {
    insert: db.prepare(
      `INSERT INTO groups (name, sort_order, created_at)
       VALUES (@name, @sort_order, @created_at)`
    ),
    getById: db.prepare('SELECT * FROM groups WHERE id = ?'),
    getAll: db.prepare('SELECT * FROM groups ORDER BY sort_order ASC, id ASC'),
    update: db.prepare(
      `UPDATE groups
         SET name = @name,
             sort_order = @sort_order
       WHERE id = @id`
    ),
    delete: db.prepare('DELETE FROM groups WHERE id = ?'),
    countBooks: db.prepare('SELECT COUNT(*) as count FROM books WHERE group_id = ?'),
    maxSortOrder: db.prepare('SELECT MAX(sort_order) as max FROM groups'),
    clearBooksGroup: db.prepare('UPDATE books SET group_id = NULL WHERE group_id = ?'),
    updateSortOrder: db.prepare('UPDATE groups SET sort_order = ? WHERE id = ?')
  };
});

/** 创建分组 */
export function createGroup(input: CreateGroupInput): Group {
  const s = groupStmt();
  const now = Date.now();
  const sort_order = input.sort_order ?? 0;
  const result = s.insert.run({
    name: input.name,
    sort_order,
    created_at: now
  });
  return s.getById.get(result.lastInsertRowid) as Group;
}

/** 查询全部分组（按 sort_order 排序） */
export function listGroups(): Group[] {
  return groupStmt().getAll.all() as Group[];
}

/** 更新分组（部分字段） */
export function updateGroup(id: number, input: UpdateGroupInput): void {
  const s = groupStmt();
  const existing = s.getById.get(id) as Group | undefined;
  if (!existing) {
    throw new Error(`[group] 分组不存在: id=${id}`);
  }
  s.update.run({
    id,
    name: input.name ?? existing.name,
    sort_order: input.sort_order ?? existing.sort_order
  });
}

/** 删除分组。删除前会把该分组下的书籍 group_id 置空（归入未分组）。 */
export function deleteGroup(id: number): void {
  const s = groupStmt();
  const db = getDb();
  db.transaction(() => {
    s.clearBooksGroup.run(id);
    s.delete.run(id);
  })();
}

/**
 * 批量更新分组排序
 * @param orders id -> sort_order 映射
 */
export function reorderGroups(orders: { id: number; sort_order: number }[]): void {
  if (orders.length === 0) return;
  const s = groupStmt();
  const db = getDb();
  db.transaction(() => {
    for (const { id, sort_order } of orders) {
      s.updateSortOrder.run(sort_order, id);
    }
  })();
}

/* ==================== 订阅源 Repository ==================== */

/** 订阅类型白名单（防 SQL 注入，写入前校验） */
const VALID_SUB_TYPES: Set<SubscriptionType> = new Set(['folder', 'rss', 'http']);

/** 校验订阅类型合法 */
function assertValidSubType(type: string): asserts type is SubscriptionType {
  if (!VALID_SUB_TYPES.has(type as SubscriptionType)) {
    throw new Error(`[subscription] 无效的订阅类型: ${type}（仅支持 folder/rss/http）`);
  }
}

/** 订阅源预编译 SQL 语句（延迟初始化） */
const subStmt = lazy(() => {
  const db = getDb();
  return {
    insert: db.prepare(
      `INSERT INTO subscriptions (
         name, type, url, config, last_check_at, check_interval,
         enabled, auto_import, created_at
       ) VALUES (
         @name, @type, @url, @config, @last_check_at, @check_interval,
         @enabled, @auto_import, @created_at
       )`
    ),
    getById: db.prepare('SELECT * FROM subscriptions WHERE id = ?'),
    listAll: db.prepare('SELECT * FROM subscriptions ORDER BY created_at DESC'),
    listEnabled: db.prepare('SELECT * FROM subscriptions WHERE enabled = 1 ORDER BY created_at DESC'),
    listDue: db.prepare(
      `SELECT * FROM subscriptions
       WHERE enabled = 1
         AND (last_check_at IS NULL OR last_check_at + check_interval <= ?)
       ORDER BY last_check_at ASC NULLS FIRST`
    ),
    updateLastCheckAt: db.prepare('UPDATE subscriptions SET last_check_at = ? WHERE id = ?'),
    delete: db.prepare('DELETE FROM subscriptions WHERE id = ?'),
    listBooksBySubscription: db.prepare('SELECT * FROM books WHERE subscription_id = ? ORDER BY created_at DESC'),
    listUpdatedBooksBySubscription: db.prepare(
      'SELECT * FROM books WHERE subscription_id = ? AND has_update = 1 ORDER BY updated_at DESC'
    ),
    markBookUpdate: db.prepare('UPDATE books SET has_update = ?, updated_at = ? WHERE id = ?'),
    listAllUpdatedBooks: db.prepare('SELECT * FROM books WHERE has_update = 1 ORDER BY updated_at DESC'),
    getBookBySubscriptionAndUrl: db.prepare('SELECT * FROM books WHERE subscription_id = ? AND source_url = ?'),
    getBookBySubscriptionAndPath: db.prepare('SELECT * FROM books WHERE subscription_id = ? AND local_file_path = ?')
  };
});

/** 创建订阅源 */
export function createSubscription(input: CreateSubscriptionInput): Subscription {
  assertValidSubType(input.type);
  const s = subStmt();
  const now = Date.now();
  const result = s.insert.run({
    name: input.name,
    type: input.type,
    url: input.url,
    config: input.config ?? null,
    last_check_at: null,
    check_interval: input.check_interval ?? 3600000,
    enabled: input.enabled ?? 1,
    auto_import: input.auto_import ?? 1,
    created_at: now
  });
  return s.getById.get(result.lastInsertRowid) as Subscription;
}

/** 根据 id 查订阅 */
export function getSubscription(id: number): Subscription | undefined {
  return subStmt().getById.get(id) as Subscription | undefined;
}

/** 列出全部订阅（按创建时间倒序） */
export function listSubscriptions(): Subscription[] {
  return subStmt().listAll.all() as Subscription[];
}

/** 列出启用的订阅 */
export function listEnabledSubscriptions(): Subscription[] {
  return subStmt().listEnabled.all() as Subscription[];
}

/** 查询到期订阅（供定时器调用） */
export function getSubscriptionsDue(now: number = Date.now()): Subscription[] {
  return subStmt().listDue.all(now) as Subscription[];
}

/** 更新订阅（部分字段，只更新传入的字段） */
export function updateSubscription(id: number, input: UpdateSubscriptionInput): void {
  const existing = getSubscription(id);
  if (!existing) {
    throw new Error(`[subscription] 订阅不存在: id=${id}`);
  }

  const sets: string[] = [];
  const bind: Record<string, unknown> = { id };

  if (input.name !== undefined) {
    sets.push('name = @name');
    bind.name = input.name;
  }
  if (input.url !== undefined) {
    sets.push('url = @url');
    bind.url = input.url;
  }
  if (input.config !== undefined) {
    sets.push('config = @config');
    bind.config = input.config;
  }
  if (input.check_interval !== undefined) {
    sets.push('check_interval = @check_interval');
    bind.check_interval = input.check_interval;
  }
  if (input.enabled !== undefined) {
    sets.push('enabled = @enabled');
    bind.enabled = input.enabled;
  }
  if (input.auto_import !== undefined) {
    sets.push('auto_import = @auto_import');
    bind.auto_import = input.auto_import;
  }
  if (input.last_check_at !== undefined) {
    sets.push('last_check_at = @last_check_at');
    bind.last_check_at = input.last_check_at;
  }

  if (sets.length === 0) return;

  getDb()
    .prepare(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = @id`)
    .run(bind);
}

/** 更新订阅上次检查时间 */
export function updateLastCheckAt(id: number, at: number = Date.now()): void {
  subStmt().updateLastCheckAt.run(at, id);
}

/** 删除订阅 */
export function deleteSubscription(id: number): void {
  getDb().transaction(() => {
    getDb().prepare('UPDATE books SET subscription_id = NULL WHERE subscription_id = ?').run(id);
    subStmt().delete.run(id);
  })();
}

/** 查询某订阅源关联的所有书籍 */
export function getBooksBySubscription(subscriptionId: number): Book[] {
  return subStmt().listBooksBySubscription.all(subscriptionId) as Book[];
}

/** 查询某订阅源下有更新的书籍 */
export function getUpdatedBooksBySubscription(subscriptionId: number): Book[] {
  return subStmt().listUpdatedBooksBySubscription.all(subscriptionId) as Book[];
}

/** 查询所有有更新的书籍（书架徽章用） */
export function listUpdatedBooks(): Book[] {
  return subStmt().listAllUpdatedBooks.all() as Book[];
}

/** 标记书籍更新状态 */
export function markBookUpdate(bookId: number, hasUpdate: boolean): void {
  subStmt().markBookUpdate.run(hasUpdate ? 1 : 0, Date.now(), bookId);
}

/** 按订阅源 + 源 URL 查书籍（在线源去重） */
export function getBookBySubscriptionAndUrl(subscriptionId: number, sourceUrl: string): Book | undefined {
  return subStmt().getBookBySubscriptionAndUrl.get(subscriptionId, sourceUrl) as Book | undefined;
}

/** 按订阅源 + 本地文件路径查书籍（文件夹源去重） */
export function getBookBySubscriptionAndPath(subscriptionId: number, localFilePath: string): Book | undefined {
  return subStmt().getBookBySubscriptionAndPath.get(subscriptionId, localFilePath) as Book | undefined;
}
/* ==================== OPDS 书库目录 Repository（v19 新增） ==================== */

/** opds_catalogs 表行类型 */
export interface OpdsCatalog {
  id: number;
  name: string;
  url: string;
  username: string | null;
  password: string | null;
  created_at: number | null;
}

/** 创建 OPDS 目录输入 */
export interface CreateOpdsCatalogInput {
  name: string;
  url: string;
  username?: string | null;
  password?: string | null;
}

/** 更新 OPDS 目录输入（部分字段） */
export interface UpdateOpdsCatalogInput {
  name?: string;
  url?: string;
  username?: string | null;
  password?: string | null;
}

/** 预编译 SQL 语句（延迟初始化） */
const opdsCatalogStmt = lazy(() => {
  const db = getDb();
  return {
    insert: db.prepare(
      `INSERT INTO opds_catalogs (name, url, username, password, created_at)
       VALUES (@name, @url, @username, @password, @created_at)`
    ),
    getById: db.prepare('SELECT * FROM opds_catalogs WHERE id = ?'),
    getByUrl: db.prepare('SELECT * FROM opds_catalogs WHERE url = ?'),
    listAll: db.prepare('SELECT * FROM opds_catalogs ORDER BY created_at DESC'),
    delete: db.prepare('DELETE FROM opds_catalogs WHERE id = ?')
  };
});

/** 创建 OPDS 书库目录（URL 去重：相同 URL 已存在则抛出错误） */
export function createOpdsCatalog(input: CreateOpdsCatalogInput): OpdsCatalog {
  const s = opdsCatalogStmt();
  // 去重检查：相同 URL 的目录已存在则拒绝
  const existing = s.getByUrl.get(input.url) as OpdsCatalog | undefined;
  if (existing) {
    throw new Error(`目录已存在：${existing.name}（URL 相同）`);
  }
  const now = Date.now();
  const result = s.insert.run({
    name: input.name,
    url: input.url,
    username: input.username ?? null,
    password: encryptPassword(input.password),
    created_at: now
  });
  const created = s.getById.get(result.lastInsertRowid) as OpdsCatalog;
  if (created.password) {
    created.password = decryptPassword(created.password);
  }
  return created;
}

/** 根据 id 查 OPDS 目录 */
export function getOpdsCatalogById(id: number): OpdsCatalog | undefined {
  const catalog = opdsCatalogStmt().getById.get(id) as OpdsCatalog | undefined;
  if (catalog?.password) {
    catalog.password = decryptPassword(catalog.password);
  }
  return catalog;
}

/** 列出全部 OPDS 目录（按创建时间倒序） */
export function listOpdsCatalogs(): OpdsCatalog[] {
  const catalogs = opdsCatalogStmt().listAll.all() as OpdsCatalog[];
  for (const catalog of catalogs) {
    if (catalog.password) {
      catalog.password = decryptPassword(catalog.password);
    }
  }
  return catalogs;
}


/** 删除 OPDS 目录 */
export function deleteOpdsCatalog(id: number): void {
  opdsCatalogStmt().delete.run(id);
}


/* -------------------- 分类反馈样本（P3 用户反馈闭环） -------------------- */

/** 分类反馈样本行（DB classification_feedback） */
export interface ClassifyFeedbackRow {
  id: number;
  book_id: number | null;
  shape: string;
  signals: string;
  created_at: number | null;
}

/** 写入/更新一条分类反馈样本（每本书一条，重复标记覆盖） */
export function upsertClassifyFeedback(bookId: number, shape: string, signalsJson: string): void {
  getDb()
    .prepare(
      `INSERT INTO classification_feedback (book_id, shape, signals, created_at)
       VALUES (@book_id, @shape, @signals, @created_at)
       ON CONFLICT(book_id) DO UPDATE SET shape = excluded.shape, signals = excluded.signals, created_at = excluded.created_at`
    )
    .run({ book_id: bookId, shape, signals: signalsJson, created_at: Date.now() });
}

/** 列出全部反馈样本（k-NN 用；样本量随用户使用增长，数百条内开销可忽略） */
export function listClassifyFeedback(): ClassifyFeedbackRow[] {
  return getDb()
    .prepare('SELECT id, book_id, shape, signals, created_at FROM classification_feedback ORDER BY created_at DESC LIMIT 500')
    .all() as ClassifyFeedbackRow[];
}


/** 删除某书的反馈样本（书籍删除时清理） */
export function deleteClassifyFeedbackByBook(bookId: number): void {
  getDb().prepare('DELETE FROM classification_feedback WHERE book_id = ?').run(bookId);
}

/* -------------------- Producer 统计先验数据源（任务41 数据驱动分类） -------------------- */

/**
 * 列出 Producer 统计行（classify-producer-stats.computeProducerPriors 的数据源）
 *
 * 一次查询 + 内存计算（243 本量级毫秒级），返回：
 *   - producer：books.custom_meta.classify_signals.producer（PDF Info 元数据存档）
 *   - contentType：books.content_type（书库历史标签）
 *   - isUserFeedback：该书在 classification_feedback 有样本且 source='user'
 *     （旧样本无 source 字段——任务41 之前只有用户手动修正会写入，视为 user）→
 *     先验计算时权重 ×2（用户意见优先于自动判定历史）
 *
 * 无 Producer 的书（EPUB/MOBI/TXT/旧 PDF 信号）与 custom_meta 损坏的书跳过——
 * 它们不参与 Producer 先验统计。
 */
export function listProducerStatRows(): ProducerStatRow[] {
  interface Row {
    custom_meta: string | null;
    content_type: string | null;
    feedback_signals: string | null;
  }
  const rows = getDb()
    .prepare(
      `SELECT b.custom_meta AS custom_meta, b.content_type AS content_type, f.signals AS feedback_signals
       FROM books b
       LEFT JOIN classification_feedback f ON f.book_id = b.id
       WHERE b.file_type = 'pdf'
          OR (b.local_file_path IS NOT NULL AND lower(b.local_file_path) LIKE '%.pdf')`
    )
    .all() as Row[];

  const out: ProducerStatRow[] = [];
  for (const row of rows) {
    let producer: unknown;
    try {
      const meta = JSON.parse(row.custom_meta ?? '{}') as { classify_signals?: { producer?: unknown } };
      producer = meta.classify_signals?.producer;
    } catch {
      continue; // custom_meta 损坏：不可信，跳过
    }
    if (typeof producer !== 'string' || producer.length === 0) continue;

    let isUserFeedback = false;
    if (row.feedback_signals !== null) {
      try {
        const source = (JSON.parse(row.feedback_signals) as { source?: unknown }).source;
        isUserFeedback = source === undefined || source === 'user';
      } catch {
        isUserFeedback = true; // 损坏样本保守视为用户反馈（宁可加权不可漏权）
      }
    }
    out.push({ producer, contentType: row.content_type ?? '', isUserFeedback });
  }
  return out;
}

/** 更新书籍内容分类标签（P3：用户手动修正） */
export function updateBookContentType(
  bookId: number,
  contentType: 'text' | 'illustrated' | 'comic'
): void {
  getDb()
    .prepare('UPDATE books SET content_type = ?, is_comic = ?, updated_at = ? WHERE id = ?')
    .run(contentType, contentType === 'comic' ? 1 : 0, Date.now(), bookId);
}
