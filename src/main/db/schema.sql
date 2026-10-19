-- 幽读（youdu）数据库 Schema
-- 版本：23
-- 说明：书架、章节缓存、阅读进度、书签、分组、搜索历史、设置、阅读会话
--       v3: 新增 books_fts FTS5 全文搜索虚拟表，替代 LIKE 模糊查询
--       v5: 新增 ad_rules 去广告规则表，支持阅读器右键添加去广告规则
--       v6: 新增 reading_sessions 阅读会话表，用于阅读统计分析（累计时长/速度/趋势）
--       v7: 新增 highlights 高亮/划线表；books 新增 reading_status/rating 字段
--       v8: bookmarks 新增 highlight_color 字段，高亮合并到笔记中
--       v9: books 新增 author 索引
--       v10: books 新增 is_comic 字段；chapters 新增 content_type 字段（漫画阅读支持）
--       v11: 新增 subscriptions 订阅表；books 新增 subscription_id/has_update/source_url 字段
--       v12: 新增 download_tasks 下载任务表；books 新增 book_source 字段（在线浏览/下载管理）
--       v13: 预留
--       v14: chapters 新增 volume 字段（卷层级支持，记录章节所属卷标题）
--       v15: 预留
--       v16: 新增 search_cache 搜索缓存表（搜索结果持久化，重启后不丢失）
--       v18: 新增 replace_rules 内容替换规则表（支持全局/单本书 A→B 替换，纯文本/正则两种模式）
--       v19: 新增 opds_catalogs OPDS 书库目录表
--       v20: 将 ad_rules 数据迁移到 replace_rules（rule_text→pattern, scope='global', is_regex=0），
--            然后 DROP TABLE ad_rules。去广告规则统一合并到内容替换规则体系。
--       v21: books 新增 content_type 字段（'text'=文本, 'illustrated'=图文, 'comic'=漫画），
--            三分类替代 is_comic 二元判断。is_comic 保留向后兼容（= content_type==='comic' ? 1 : 0）。
-- 所有时间戳使用 Date.now() 毫秒数

-- 分组
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER
);

-- 书架
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER,
  source_id INTEGER,
  source_book_id TEXT,
  title TEXT NOT NULL,
  author TEXT,
  cover TEXT,
  intro TEXT,
  catalog_url TEXT,
  local_file_path TEXT,
  file_type TEXT,
  encoding TEXT,
  total_chapters INTEGER,
  custom_meta TEXT,
  file_hash TEXT,
  sort_order INTEGER DEFAULT 0,
  last_read_at INTEGER,
  reading_status TEXT DEFAULT NULL,
  rating INTEGER DEFAULT NULL,
  is_comic INTEGER DEFAULT 0,
  content_type TEXT DEFAULT 'text',  -- v21 新增：'text'=文本, 'illustrated'=图文, 'comic'=漫画
  book_source TEXT,  -- v12 新增：'local'=本地导入, 'online'=在线添加（不下载）, 'download'=下载到本地
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE(source_id, source_book_id),
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

-- 章节缓存/索引
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  chapter_index INTEGER NOT NULL,
  title TEXT,
  content TEXT,
  file_offset INTEGER,
  file_length INTEGER,
  url TEXT,
  content_type TEXT DEFAULT 'text',
  volume TEXT,
  cached_at INTEGER,
  last_accessed INTEGER,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
  UNIQUE(book_id, chapter_index)
);

-- 阅读进度
CREATE TABLE IF NOT EXISTS reading_progress (
  book_id INTEGER PRIMARY KEY,
  chapter_index INTEGER NOT NULL,
  chapter_offset INTEGER DEFAULT 0,
  scroll_position REAL DEFAULT 0,
  read_time INTEGER DEFAULT 0,
  updated_at INTEGER,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- 书签
-- v8: 新增 highlight_color 字段，高亮作为笔记的属性而非独立实体
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  chapter_index INTEGER NOT NULL,
  position INTEGER,
  content TEXT,
  note TEXT,
  highlight_color TEXT DEFAULT NULL,
  created_at INTEGER,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);


-- 阅读设置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);


-- 阅读会话（v6 新增）
-- 每次进入阅读器到退出记为一条会话，用于阅读统计分析：
-- 累计阅读时长、阅读速度（字/分钟）、最近7天阅读趋势。
-- duration/chapters_read/chars_read 由阅读器 store 在退出时计算并写入。
CREATE TABLE IF NOT EXISTS reading_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  chapters_read INTEGER DEFAULT 0,
  chars_read INTEGER DEFAULT 0,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- 高亮/划线（v7 新增）
-- 用户在阅读器中选中文本后创建的高亮记录，支持颜色标记和备注。
-- start_offset/end_offset 为章节内字符偏移量，用于精确定位高亮文本范围。
CREATE TABLE IF NOT EXISTS highlights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  chapter_index INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  color TEXT DEFAULT 'yellow',
  text TEXT,
  note TEXT,
  created_at INTEGER,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- 索引：加速常用查询
CREATE INDEX IF NOT EXISTS idx_books_group_id ON books(group_id);
CREATE INDEX IF NOT EXISTS idx_books_last_read_at ON books(last_read_at);
CREATE INDEX IF NOT EXISTS idx_books_updated_at ON books(updated_at);
CREATE INDEX IF NOT EXISTS idx_books_sort_order ON books(sort_order);
CREATE INDEX IF NOT EXISTS idx_books_file_hash ON books(file_hash);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_chapters_book_id ON chapters(book_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_book_id ON bookmarks(book_id);
CREATE INDEX IF NOT EXISTS idx_highlights_book_id ON highlights(book_id);
-- reading_sessions：按书查会话、按时间查趋势
CREATE INDEX IF NOT EXISTS idx_reading_sessions_book_id ON reading_sessions(book_id);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_start_time ON reading_sessions(start_time);
-- ──────────────────────────────────────────────────────────────────────────
-- FTS5 全文搜索虚拟表（v3 新增，v23 弃用并清理）
--
-- 弃用原因：unicode61 分词器对中文支持不佳（连续中文字符被当作单个 token，
-- 导致搜不到中文书名），改用 LIKE 模糊查询（见 repositories.ts buildWhereClause）。
-- v23 迁移已 DROP books_fts 表和 books_ai/books_ad/books_au 触发器。
-- 此处保留注释说明历史，不再创建 FTS5 相关对象。
-- ──────────────────────────────────────────────────────────────────────────
-- 订阅源（v11 新增）
--
-- 用途：订阅本地文件夹/RSS/HTTP 源，自动检查更新并导入新内容。
--       type='folder' 监控本地文件夹；type='rss' 解析 RSS/Atom feed；
--       type='http' 抓取通用 HTTP 网页。config 存 JSON 配置（过滤规则等）。
--       last_check_at + check_interval 决定下次检查时机。
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                      -- 订阅名称
  type TEXT NOT NULL,                      -- 'folder' | 'rss' | 'http'
  url TEXT NOT NULL,                       -- 文件夹路径 / RSS URL / HTTP源URL
  config TEXT,                             -- JSON配置（过滤规则、自动导入等）
  last_check_at INTEGER,                   -- 上次检查更新时间
  check_interval INTEGER DEFAULT 3600000,  -- 检查间隔（毫秒，默认1小时）
  enabled INTEGER DEFAULT 1,               -- 是否启用
  auto_import INTEGER DEFAULT 1,           -- 是否自动导入新文件
  created_at INTEGER
);

-- 订阅源索引：按启用状态查询到期订阅
CREATE INDEX IF NOT EXISTS idx_subscriptions_enabled ON subscriptions(enabled);
CREATE INDEX IF NOT EXISTS idx_subscriptions_type ON subscriptions(type);
-- ──────────────────────────────────────────────────────────────────────────

-- 内容替换规则（v18 新增）
--
-- 用途：用户在阅读器右键菜单"内容替换"选中文本后，输入替换为的内容，
--       章节读取时按规则将 pattern 替换为 replacement。
--       支持两种作用范围：
--         scope='global' 全局生效，对所有书籍应用
--         scope='book'   仅对 book_id 指定的书籍应用
--       支持两种匹配模式：
--         is_regex=0 纯文本匹配（split+join 全局替换）
--         is_regex=1 正则表达式匹配（new RegExp(pattern, 'g')）
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS replace_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,             -- 要替换的文本（或正则表达式源串）
  replacement TEXT NOT NULL DEFAULT '', -- 替换为的内容
  scope TEXT NOT NULL DEFAULT 'global', -- 'global' | 'book'
  book_id INTEGER,                   -- scope='book' 时关联的书籍 ID
  is_regex INTEGER DEFAULT 0,        -- 0=纯文本匹配, 1=正则表达式
  enabled INTEGER DEFAULT 1,         -- 0=禁用, 1=启用
  created_at INTEGER,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);

-- 索引：按范围查询（章节读取时按 global/book_id 拉取规则）
CREATE INDEX IF NOT EXISTS idx_replace_rules_scope ON replace_rules(scope);
CREATE INDEX IF NOT EXISTS idx_replace_rules_book_id ON replace_rules(book_id);
CREATE INDEX IF NOT EXISTS idx_replace_rules_enabled ON replace_rules(enabled);
-- ──────────────────────────────────────────────────────────────────────────
-- OPDS 书库目录（v19 新增）
--
-- 用途：存储用户添加的 OPDS (Open Publication Distribution System) 目录配置，
--       支持浏览在线书库、搜索书籍、下载并导入到书架。
--       username/password 为可选的 HTTP Basic 认证凭据。
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opds_catalogs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  username TEXT,
  password TEXT,
  created_at INTEGER
);