-- 幽读（youdu）数据库 Schema
-- 版本：29
-- 说明：书架、章节缓存、阅读进度、书签、分组、搜索历史、设置、阅读会话
--       v3: 新增 books_fts FTS5 全文搜索虚拟表，替代 LIKE 模糊查询
--       v5: 新增 ad_rules 去广告规则表，支持阅读器右键添加去广告规则
--       v6: 新增 reading_sessions 阅读会话表，用于阅读统计分析（累计时长/速度/趋势）
--       v7: 新增 highlights 高亮/划线表；books 新增 reading_status/rating 字段
--       v8: bookmarks 新增 highlight_color 字段，高亮合并到笔记中
--       v9: books 新增 author 索引
--       v10: books 新增 is_comic 字段；chapters 新增 content_type 字段（漫画阅读支持）
--       v11: 新增 subscriptions 订阅表；books 新增 subscription_id/has_update/source_url 字段
--       v12: books 新增 book_source 字段（标记书籍来源类型）
--       v14: chapters 新增 volume 字段（卷层级支持，记录章节所属卷标题）
--       v18: 新增 replace_rules 内容替换规则表（支持全局/单本书 A→B 替换，纯文本/正则两种模式）
--       v19: 新增 opds_catalogs OPDS 书库目录表
--       v20: 将 ad_rules 数据迁移到 replace_rules（rule_text→pattern, scope='global', is_regex=0），
--            然后 DROP TABLE ad_rules。去广告规则统一合并到内容替换规则体系。
--       v21: books 新增 content_type 字段（'text'=文本, 'illustrated'=图文, 'comic'=漫画），
--            三分类替代 is_comic 二元判断。is_comic 保留向后兼容（= content_type==='comic' ? 1 : 0）。
--       v22: 修正旧书 content_type，识别图文书籍（illustrated）：v21 只识别 comic，遗漏 illustrated。
--       v23: 清理已弃用的 books_fts FTS5 触发器和虚拟表（unicode61 对中文支持不佳，
--            且每次启动 rebuild 有开销），改用 LIKE 模糊查询。
--       v26: books 新增 import_mode 字段（导入三模式，功能批次 v54）：
--            'copy'=复制（默认，原行为，副本入 userData）
--            'move'=移动（导入后原目录文件移走，运行时与 copy 无差异）
--            'link'=引用（文件留在原目录，local_file_path 指向原路径，
--            打开时 existsSync 校验，原文件丢失可重新定位恢复）
--       v27: 卷级标记对齐 txt 标杆（用户投诉：epub 卷标题"第一卷 燎山纪氏"被当成独立章节）：
--            清理被误建为独立章节的卷标题章节（title 匹配卷模式 且 content<100 字符，
--            格式无关），将其后章节归属到对应卷（chapters.volume），重排 chapter_index，
--            并修正 reading_progress/bookmarks/highlights 的 chapter_index 引用。
--       v28: PDF 卷标题章清理（任务13，用户投诉"PDF 解析处理排序有问题，没有 txt 完善"）：
--            v27 清理后新导入的 PDF outline 卷标题章 content 常为 NULL（无文字层/未缓存）
--            被漏掉（实测 0day安全 idx=5"第1篇"）。v28 判定（比 v27 增加结构性双保险）：
--            title 匹配卷模式 且 (content NULL 或 <100 字符) 且 (url 为单页区间 N-N 或
--            file_length 极小)，防误删有文字的真章；仅处理 PDF 书。其余复用 v27 模式
--            （卷归属已关联的不动、删除+重排两阶段负数中转、三表引用修正、全卷保护）。
--       v29: 系列元数据（任务14，用户投诉"comic 的提取、分析，我们好像遗漏了很多"）：
--            books 新增 series/series_number/series_total 列（ComicInfo.xml Series/Number/
--            Volume/Count 或文件名卷号模式 _NN/-NN/第N卷/vol 等提取，格式无关），存量书由
--            migration v29 从 custom_meta.original_filename 回填。同名系列书（54 本
--            "哆啦A梦[大长篇][台版]"）靠"系列 · 第N卷"副标题区分，title 排序次级
--            series_number 自然排序（第1卷→第54卷）。
-- 注：v13/v15/v16/v17 为历史预留号，从未实现（相关 download_tasks/search_cache 表未采用），
--     迁移列表中已省略这些版本号。
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
  import_mode TEXT DEFAULT 'copy',  -- v26 新增（批次 v54）：'copy'=复制, 'move'=移动, 'link'=引用（原文件保持原位）
  series TEXT,  -- v29 新增：系列名（ComicInfo.xml Series 或文件名卷号模式提取，如"哆啦A梦[大长篇][台版]"）
  series_number REAL,  -- v29 新增：系列内序号（REAL 支持小数卷号；title 排序次级自然排序用）
  series_total INTEGER,  -- v29 新增：系列总数（ComicInfo.xml Count，"第N卷/共M卷"展示用）
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


-- ──────────────────────────────────────────────────────────────────────────
-- 分类反馈样本（v24 新增，P3 用户反馈闭环）
--
-- 用途：记录用户手动修正的书籍分类（"标记为 文字/图文/漫画/扫描版"）
--       及其导入时的文档特征向量（signals JSON）。导入新书时用 k-NN
--       参考历史修正，实现"越用越准"的个性化分类 —— 无需训练 ANN，
--       零额外依赖、可解释、样本随使用增长。
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS classification_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER,                   -- 关联书籍（书删除后样本保留，故不加 CASCADE）
  shape TEXT NOT NULL,               -- 用户标记形态: 'text' | 'illustrated' | 'scan' | 'comic'
  signals TEXT NOT NULL,             -- 文档特征向量 JSON（DocumentSignals）
  created_at INTEGER,
  UNIQUE(book_id)                    -- 每本书一条，重复标记则更新
);

-- 索引：按形态查询（k-NN 投票时按标签分组统计）
CREATE INDEX IF NOT EXISTS idx_classify_feedback_shape ON classification_feedback(shape);
