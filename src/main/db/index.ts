/**
 * SQLite 数据库初始化与迁移
 *
 * 职责：
 * 1. 用 better-sqlite3 打开 <userData>/youdu.db
 * 2. 开启 WAL 模式提升并发读写性能
 * 3. 基于 user_version pragma 的版本化迁移机制
 * 4. 暴露单例 db 实例供 Repository 使用
 *
 * 迁移机制：
 * - SQLite 的 `user_version` pragma 存储当前 schema 版本号（整数）
 * - 启动时读取 user_version，依次执行所有 version > 当前版本 的迁移
 * - 每个迁移在独立事务中执行，失败则抛错终止
 * - 全部迁移完成后更新 user_version 到最新版本
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { join } from 'path';
import { getDbPath } from '../utils';
import { isVolumeLine, extractVolumeTitle } from '../core/parsers/chapter-patterns';
import { extractSeriesFromFilename } from '../core/parsers/filename-series';
import schemaSql from './schema.sql?raw';

/** 当前 schema 版本号（每次 schema 变更 +1）。
 *  必须等于 migrations 数组中最大 version，否则 diagnoseMigrations 会误报 needsMigration。 */
export const SCHEMA_VERSION = 29;

/** 迁移定义：每个迁移把 schema 从 version-1 升级到 version */
interface Migration {
  version: number;
  description: string;
  /** 执行升级 SQL，在事务中运行 */
  up: (db: DatabaseType) => void;
}

/**
 * 迁移列表
 *
 * version 1：初始建表（groups/books/chapters/reading_progress/bookmarks/settings）
 * 后续新增迁移时往数组追加即可，不要修改已有迁移。
 */
/** 迁移定义列表（导出供单元测试在内存 SQLite 上验证迁移逻辑） */
export const migrations: Migration[] = [
  {
    version: 1,
    description: '初始建表：groups/books/chapters/reading_progress/bookmarks/settings',
    up: (db) => {
      // schemaSql 包含全部 CREATE TABLE IF NOT EXISTS 语句，安全可重入
      db.exec(schemaSql);
    }
  },
  {
    version: 2,
    description: '外键加 ON DELETE CASCADE；books 新增 file_hash 列与索引',
    up: (db) => {
      // 1. books 表新增 file_hash 列（SQLite 支持 ADD COLUMN）
      const cols = db.prepare("SELECT name FROM pragma_table_info('books')").all() as { name: string }[];
      if (!cols.some((c) => c.name === 'file_hash')) {
        db.exec('ALTER TABLE books ADD COLUMN file_hash TEXT');
      }

      // 2. 重建 chapters 表以加 ON DELETE CASCADE
      //    SQLite 不支持 ALTER FOREIGN KEY，需重建表
      const chaptersFk = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chapters'").get() as
        { sql: string } | undefined;
      if (chaptersFk && !chaptersFk.sql.includes('ON DELETE CASCADE')) {
        db.exec(`
          CREATE TABLE chapters_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            chapter_index INTEGER NOT NULL,
            title TEXT,
            content TEXT,
            file_offset INTEGER,
            file_length INTEGER,
            url TEXT,
            cached_at INTEGER,
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
            UNIQUE(book_id, chapter_index)
          );
          INSERT INTO chapters_new SELECT id, book_id, chapter_index, title, content, file_offset, file_length, url, cached_at FROM chapters;
          DROP TABLE chapters;
          ALTER TABLE chapters_new RENAME TO chapters;
          CREATE INDEX idx_chapters_book_id ON chapters(book_id);
        `);
      }

      // 3. 重建 reading_progress 表以加 ON DELETE CASCADE
      const progressFk = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reading_progress'")
        .get() as { sql: string } | undefined;
      if (progressFk && !progressFk.sql.includes('ON DELETE CASCADE')) {
        db.exec(`
          CREATE TABLE reading_progress_new (
            book_id INTEGER PRIMARY KEY,
            chapter_index INTEGER NOT NULL,
            chapter_offset INTEGER DEFAULT 0,
            scroll_position REAL DEFAULT 0,
            read_time INTEGER DEFAULT 0,
            updated_at INTEGER,
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
          );
          INSERT INTO reading_progress_new SELECT book_id, chapter_index, chapter_offset, scroll_position, read_time, updated_at FROM reading_progress;
          DROP TABLE reading_progress;
          ALTER TABLE reading_progress_new RENAME TO reading_progress;
        `);
      }

      // 4. 重建 bookmarks 表以加 ON DELETE CASCADE
      const bookmarkFk = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookmarks'").get() as
        { sql: string } | undefined;
      if (bookmarkFk && !bookmarkFk.sql.includes('ON DELETE CASCADE')) {
        db.exec(`
          CREATE TABLE bookmarks_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            chapter_index INTEGER NOT NULL,
            position INTEGER,
            content TEXT,
            note TEXT,
            created_at INTEGER,
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
          );
          INSERT INTO bookmarks_new SELECT id, book_id, chapter_index, position, content, note, created_at FROM bookmarks;
          DROP TABLE bookmarks;
          ALTER TABLE bookmarks_new RENAME TO bookmarks;
          CREATE INDEX idx_bookmarks_book_id ON bookmarks(book_id);
        `);
      }

      // 5. file_hash 索引
      db.exec('CREATE INDEX IF NOT EXISTS idx_books_file_hash ON books(file_hash)');
    }
  },
  {
    version: 3,
    description: '新增 FTS5 全文搜索虚拟表 books_fts 及同步触发器（v23 已弃用并清理，此迁移仅保留历史占位）',
    up: (db) => {
      // P1-6 修复：FTS5 已弃用（中文分词不佳，改用 LIKE 搜索）
      // schemaSql 已移除 books_fts 定义和触发器，此处仅执行 schemaSql 创建其他表
      // v23 迁移会 DROP 旧安装中可能存在的 books_fts 表和触发器
      db.exec(schemaSql);
    }
  },
  {
    version: 4,
    description: 'chapters 新增 last_accessed 列，用于章节缓存 LRU 淘汰（P0-3）',
    up: (db) => {
      // chapters 表新增 last_accessed 列（记录章节最后访问时间戳，供 LRU 淘汰排序）
      // ALTER TABLE ADD COLUMN 是幂等不安全的，需先检查列是否存在
      const cols = db.prepare("SELECT name FROM pragma_table_info('chapters')").all() as { name: string }[];
      if (!cols.some((c) => c.name === 'last_accessed')) {
        db.exec('ALTER TABLE chapters ADD COLUMN last_accessed INTEGER');
      }
    }
  },
  {
    version: 5,
    description: '新增 ad_rules 去广告规则表，支持阅读器右键添加去广告规则',
    up: (db) => {
      // schemaSql 已包含 ad_rules 表定义（CREATE TABLE IF NOT EXISTS，安全可重入）
      db.exec(schemaSql);
    }
  },
  {
    version: 6,
    description: '新增 reading_sessions 阅读会话表，用于阅读统计分析（累计时长/速度/趋势）',
    up: (db) => {
      // schemaSql 已包含 reading_sessions 表定义和索引（CREATE ... IF NOT EXISTS，安全可重入）
      db.exec(schemaSql);
    }
  },
  {
    version: 7,
    description: '新增 highlights 高亮/划线表；books 新增 reading_status/rating 字段',
    up: (db) => {
      // 1. schemaSql 已包含 highlights 表定义和索引（CREATE ... IF NOT EXISTS，安全可重入）
      db.exec(schemaSql);

      // 2. books 表新增 reading_status 列（ALTER TABLE ADD COLUMN 需先检查列是否存在）
      const bookCols = db.prepare("SELECT name FROM pragma_table_info('books')").all() as { name: string }[];
      if (!bookCols.some((c) => c.name === 'reading_status')) {
        db.exec('ALTER TABLE books ADD COLUMN reading_status TEXT DEFAULT NULL');
      }
      if (!bookCols.some((c) => c.name === 'rating')) {
        db.exec('ALTER TABLE books ADD COLUMN rating INTEGER DEFAULT NULL');
      }
    }
  },
  {
    version: 8,
    description: 'bookmarks 新增 highlight_color 字段，高亮合并到笔记中',
    up: (db) => {
      // bookmarks 表新增 highlight_color 列（ALTER TABLE ADD COLUMN 需先检查列是否存在）
      const cols = db.prepare("SELECT name FROM pragma_table_info('bookmarks')").all() as { name: string }[];
      if (!cols.some((c) => c.name === 'highlight_color')) {
        db.exec('ALTER TABLE bookmarks ADD COLUMN highlight_color TEXT DEFAULT NULL');
      }
    }
  },
  {
    version: 9,
    description: 'books 表新增 author 索引，加速相关推荐与作者筛选查询',
    up: (db) => {
      db.exec('CREATE INDEX IF NOT EXISTS idx_books_author ON books(author)');
    }
  },
  {
    version: 10,
    description: 'books 新增 is_comic 字段；chapters 新增 content_type 字段（漫画阅读支持）',
    up: (db) => {
      // 1. books 表新增 is_comic 列（0=文本书籍, 1=漫画书籍）
      const bookCols = db.prepare("SELECT name FROM pragma_table_info('books')").all() as { name: string }[];
      if (!bookCols.some((c) => c.name === 'is_comic')) {
        db.exec('ALTER TABLE books ADD COLUMN is_comic INTEGER DEFAULT 0');
      }

      // 2. chapters 表新增 content_type 列（'text'=文本章节, 'image'=图片章节）
      const chapterCols = db.prepare("SELECT name FROM pragma_table_info('chapters')").all() as { name: string }[];
      if (!chapterCols.some((c) => c.name === 'content_type')) {
        db.exec("ALTER TABLE chapters ADD COLUMN content_type TEXT DEFAULT 'text'");
      }
    }
  },
  {
    version: 11,
    description: '新增 subscriptions 订阅表；books 新增 subscription_id/has_update/source_url 字段（订阅系统）',
    up: (db) => {
      // 1. schemaSql 已包含 subscriptions 表定义和索引（CREATE ... IF NOT EXISTS，安全可重入）
      db.exec(schemaSql);

      // 2. books 表新增 subscription_id 列（关联订阅源，ALTER TABLE ADD COLUMN 需先检查列是否存在）
      const bookCols = db.prepare("SELECT name FROM pragma_table_info('books')").all() as { name: string }[];
      if (!bookCols.some((c) => c.name === 'subscription_id')) {
        db.exec('ALTER TABLE books ADD COLUMN subscription_id INTEGER');
      }
      // 3. books 表新增 has_update 列（标记有新更新，书架显示更新徽章）
      if (!bookCols.some((c) => c.name === 'has_update')) {
        db.exec('ALTER TABLE books ADD COLUMN has_update INTEGER DEFAULT 0');
      }
      // 4. books 表新增 source_url 列（在线源的原始URL）
      if (!bookCols.some((c) => c.name === 'source_url')) {
        db.exec('ALTER TABLE books ADD COLUMN source_url TEXT');
      }

      // 5. books 表新增 subscription_id 索引（按订阅源查关联书籍）
      db.exec('CREATE INDEX IF NOT EXISTS idx_books_subscription_id ON books(subscription_id)');
      // 6. books 表新增 has_update 索引（书架快速筛选有更新的书籍）
      db.exec('CREATE INDEX IF NOT EXISTS idx_books_has_update ON books(has_update)');
    }
  },
  {
    version: 12,
    description: 'books 新增 book_source 字段（标记书籍来源类型）',
    up: (db) => {
      // 1. books 表新增 book_source 列
      const bookCols = db.prepare("SELECT name FROM pragma_table_info('books')").all() as { name: string }[];
      if (!bookCols.some((c) => c.name === 'book_source')) {
        db.exec("ALTER TABLE books ADD COLUMN book_source TEXT DEFAULT 'local'");
      }
    }
  },
  {
    version: 14,
    description: 'chapters 新增 volume 字段（卷层级支持，记录章节所属卷标题）',
    up: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('chapters')").all() as { name: string }[];
      if (!cols.some((c) => c.name === 'volume')) {
        db.exec('ALTER TABLE chapters ADD COLUMN volume TEXT');
      }
    }
  },
  {
    version: 18,
    description: '新增 replace_rules 内容替换规则表（支持全局/单本书 A→B 替换，纯文本/正则两种模式）',
    up: (db) => {
      // schemaSql 已包含 replace_rules 表定义和索引（CREATE ... IF NOT EXISTS，安全可重入）
      db.exec(schemaSql);
    }
  },
  {
    version: 19,
    description: '新增 opds_catalogs OPDS 书库目录表',
    up: (db) => {
      // schemaSql 已包含 opds_catalogs 表定义（CREATE TABLE IF NOT EXISTS，安全可重入）
      db.exec(schemaSql);
    }
  },
  {
    version: 20,
    description: '将 ad_rules 数据迁移到 replace_rules，然后删除 ad_rules 表（去广告规则统一合并到内容替换规则）',
    up: (db) => {
      // 1. 检查 ad_rules 表是否存在（全新安装不会有此表，跳过迁移）
      const adRulesTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ad_rules'").get();
      if (adRulesTable) {
        // 2. 将 ad_rules 数据迁移到 replace_rules
        //    映射：rule_text → pattern, '' → replacement, 'global' → scope,
        //          0 → is_regex, enabled → enabled, created_at → created_at
        //    book_id 为 NULL（全局规则），is_regex=0（纯文本匹配）
        db.exec(`
          INSERT INTO replace_rules (pattern, replacement, scope, book_id, is_regex, enabled, created_at)
          SELECT rule_text, '', 'global', NULL, 0, enabled, created_at FROM ad_rules
        `);
        // 3. 删除 ad_rules 表
        db.exec('DROP TABLE IF EXISTS ad_rules');
      }
    }
  },
  {
    version: 21,
    description: 'books 新增 content_type 字段（text/illustrated/comic 三分类），迁移 is_comic=1 → content_type=comic',
    up: (db) => {
      // 1. books 表新增 content_type 列（ALTER TABLE ADD COLUMN 需先检查列是否存在）
      const bookCols = db.prepare("SELECT name FROM pragma_table_info('books')").all() as { name: string }[];
      if (!bookCols.some((c) => c.name === 'content_type')) {
        db.exec("ALTER TABLE books ADD COLUMN content_type TEXT DEFAULT 'text'");
      }
      // 2. 迁移：is_comic=1 → content_type='comic'（is_comic 保留向后兼容）
      db.exec(
        "UPDATE books SET content_type = 'comic' WHERE is_comic = 1 AND (content_type IS NULL OR content_type = 'text')"
      );
      // 3. content_type 索引（按类型查询/过滤）
      db.exec('CREATE INDEX IF NOT EXISTS idx_books_content_type ON books(content_type)');
    }
  },
  {
    version: 22,
    description: '修正旧书 content_type，识别图文书籍（illustrated）：v21 只识别了 comic，遗漏了 illustrated',
    up: (db) => {
      // v21 缺陷修复：v21 只把 is_comic=1 的旧书设为 content_type='comic'，
      // 其余全部默认 'text'，没有识别图文书籍（illustrated）。
      // 本迁移对 content_type='text' 的旧书，检查是否存在
      // chapters.content_type IN ('illustrated', 'image') 的章节，
      // 若有则更新为 content_type='illustrated'。
      // 注意：仅修正 content_type='text' 的记录，避免覆盖已正确分类的 comic/text。
      db.exec(`
        UPDATE books SET content_type = 'illustrated'
        WHERE content_type = 'text'
          AND EXISTS (
            SELECT 1 FROM chapters
            WHERE chapters.book_id = books.id
              AND chapters.content_type IN ('illustrated', 'image')
          )
      `);
    }
  },
  {
    version: 23,
    description:
      'P1-6修复：清理已弃用的 FTS5 全文搜索触发器和虚拟表，消除每次启动的 rebuild 开销和写入时的触发器副作用',
    up: (db) => {
      // FTS5 全文搜索（books_fts）已弃用：unicode61 分词器对中文支持不佳
      // （连续中文字符被当作单个 token，搜不到中文书名），改用 LIKE 查询。
      // 但 FTS5 的同步触发器（books_ai/books_ad/books_au）仍在每次 INSERT/DELETE/UPDATE
      // 时执行，造成不必要的写入开销；且每次启动都 rebuild 索引。
      // 本迁移彻底清理 FTS5 相关对象：
      //   1. DROP 三个同步触发器
      //   2. DROP books_fts 虚拟表
      // 全新安装（user_version 从 0 升级）时 books_fts 由 schema.sql 创建，
      // 但 schema.sql 已移除 FTS5 定义，所以新安装不会有 books_fts。
      // 旧安装（已有 books_fts）通过本迁移清理。
      db.exec('DROP TRIGGER IF EXISTS books_ai');
      db.exec('DROP TRIGGER IF EXISTS books_ad');
      db.exec('DROP TRIGGER IF EXISTS books_au');
      db.exec('DROP TABLE IF EXISTS books_fts');
    }
  },
  {
    version: 24,
    description:
      'P3用户反馈闭环：新增 classification_feedback 表，记录用户手动修正的分类（文字/图文/漫画/扫描版）及其文档特征向量，导入新书时用 k-NN 参考历史修正，实现个性化分类（越用越准，无需训练模型）',
    up: (db) => {
      // schemaSql 已包含该表定义（CREATE ... IF NOT EXISTS，安全可重入）
      db.exec(schemaSql);
    }
  },
  {
    version: 25,
    description:
      '数据修复：清理 0.2.5 期间被分类采样（textOnly 轻量路径）污染缓存的图片型 PDF 章节 —— 该路径跳过了图片提取，回写的纯文本覆盖了缓存中原有的 [IMG:] 图片标记，导致这些章节阅读时丢图。清理后这些章节下次打开会自动重新提取（一次性），恢复正常',
    up: (db) => {
      // 精准清理：仅图片型 PDF（illustrated/comic）的章节，且缓存为非空且不含 [IMG:] 标记。
      // 纯文字书（text）不受影响；误清的"真图文书中本就无插图的章"会在下次读取时
      // 正常重写缓存（一次性成本），不丢数据。
      const info = db
        .prepare(
          `UPDATE chapters
           SET content = NULL, cached_at = NULL
           WHERE content IS NOT NULL
             AND content != ''
             AND content NOT LIKE '%[IMG:%'
             AND book_id IN (SELECT id FROM books WHERE file_type = 'pdf' AND content_type IN ('illustrated','comic'))`
        )
        .run();
      console.log(`[db] v25 清理被采样污染的图片型 PDF 章节缓存: ${info.changes} 条`);
    }
  },
  {
    version: 26,
    description:
      "导入三模式（批次 v54）：books 新增 import_mode 字段（'copy'=复制（默认，原行为）, 'move'=移动, 'link'=引用（文件留在原目录，local_file_path 指向原路径））。旧数据默认 'copy'，与现状行为一致，迁移零风险",
    up: (db) => {
      // books 表新增 import_mode 列（ALTER TABLE ADD COLUMN 需先检查列是否存在）
      const bookCols = db.prepare("SELECT name FROM pragma_table_info('books')").all() as { name: string }[];
      if (!bookCols.some((c) => c.name === 'import_mode')) {
        db.exec("ALTER TABLE books ADD COLUMN import_mode TEXT DEFAULT 'copy'");
      }
    }
  },
  {
    version: 27,
    description:
      '卷级标记对齐（用户投诉：莽荒纪 epub 卷标题"第一卷 燎山纪氏"被当成独立章节）：清理被误建为独立章节的卷标题章节（title 匹配卷模式 且 内容<100字符），将其后章节归属到对应卷（chapters.volume），重排 chapter_index 并修正 reading_progress/bookmarks/highlights 引用。格式无关（epub/pdf/mobi 存量书均适用），对齐 txt 解析器的卷处理标杆（卷标记不作为独立章节）',
    up: (db) => {
      /** 卷标题章节判定阈值：真实章节即使标题形似卷名，内容也不会只有几十字 */
      const VOLUME_CHAPTER_MAX_CONTENT = 100;

      const books = db.prepare('SELECT id FROM books').all() as { id: number }[];
      const selectChapters = db.prepare(
        'SELECT chapter_index, title, content FROM chapters WHERE book_id = ? ORDER BY chapter_index'
      );
      const setVolume = db.prepare(
        'UPDATE chapters SET volume = ? WHERE book_id = ? AND chapter_index = ?'
      );
      const deleteChapter = db.prepare('DELETE FROM chapters WHERE book_id = ? AND chapter_index = ?');
      const reindexChapter = db.prepare(
        'UPDATE chapters SET chapter_index = ? WHERE book_id = ? AND chapter_index = ?'
      );
      const selectProgress = db.prepare(
        'SELECT chapter_index FROM reading_progress WHERE book_id = ?'
      );
      const updateProgress = db.prepare(
        'UPDATE reading_progress SET chapter_index = ? WHERE book_id = ?'
      );
      const selectBookmarks = db.prepare(
        'SELECT id, chapter_index FROM bookmarks WHERE book_id = ?'
      );
      const updateBookmark = db.prepare('UPDATE bookmarks SET chapter_index = ? WHERE id = ?');
      const selectHighlights = db.prepare(
        'SELECT id, chapter_index FROM highlights WHERE book_id = ?'
      );
      const updateHighlight = db.prepare('UPDATE highlights SET chapter_index = ? WHERE id = ?');

      let totalBooksFixed = 0;
      let totalChaptersDeleted = 0;

      for (const book of books) {
        const chapters = selectChapters.all(book.id) as Array<{
          chapter_index: number;
          title: string | null;
          content: string | null;
        }>;

        // 卷标题章节：title 匹配卷模式（isVolumeLine，含"第一卷 燎山纪氏"带卷名形态）
        // 且内容极短（NULL/空视为未缓存的卷标题页）
        const volumeChapters = chapters.filter(
          (c) => (c.title ?? '').trim() !== '' && isVolumeLine((c.title ?? '').trim()) && (c.content ?? '').length < VOLUME_CHAPTER_MAX_CONTENT
        );
        if (volumeChapters.length === 0) continue;
        // 全卷保护：删除后必须仍有章节（整本书全是卷标题章节的病态数据不处理）
        if (volumeChapters.length >= chapters.length) continue;

        const volumeIdxSet = new Set(volumeChapters.map((c) => c.chapter_index));
        const kept = chapters.filter((c) => !volumeIdxSet.has(c.chapter_index));

        // 1. 卷归属：每个卷章节到下一个卷章节之间的章节，volume 设为该卷标题
        for (let vi = 0; vi < volumeChapters.length; vi++) {
          const volIdx = volumeChapters[vi].chapter_index;
          const volTitle = extractVolumeTitle((volumeChapters[vi].title ?? '').trim());
          if (!volTitle) continue;
          const nextVolIdx =
            vi + 1 < volumeChapters.length ? volumeChapters[vi + 1].chapter_index : Infinity;
          for (const c of kept) {
            if (c.chapter_index > volIdx && c.chapter_index < nextVolIdx) {
              setVolume.run(volTitle, book.id, c.chapter_index);
            }
          }
        }

        // 2. 旧→新 index 映射（保留章节按原顺序重排为 0..n-1）
        const oldToNew = new Map<number, number>();
        kept.forEach((c, i) => oldToNew.set(c.chapter_index, i));
        // 引用落点：卷章节上的引用 → 其后第一个保留章节（其后无保留章节则落到最后一个保留章节）
        const mapRef = (oldIdx: number): number | null => {
          const direct = oldToNew.get(oldIdx);
          if (direct !== undefined) return direct;
          for (const c of kept) {
            if (c.chapter_index > oldIdx) return oldToNew.get(c.chapter_index) ?? null;
          }
          return kept.length > 0 ? (oldToNew.get(kept[kept.length - 1].chapter_index) ?? null) : null;
        };

        // 3. 修正引用表 chapter_index（按主键定位行，避免新旧值碰撞）
        const progress = selectProgress.get(book.id) as { chapter_index: number } | undefined;
        if (progress) {
          const newIdx = mapRef(progress.chapter_index);
          if (newIdx !== null) updateProgress.run(newIdx, book.id);
        }
        for (const bm of selectBookmarks.all(book.id) as Array<{ id: number; chapter_index: number }>) {
          const newIdx = mapRef(bm.chapter_index);
          if (newIdx !== null) updateBookmark.run(newIdx, bm.id);
        }
        for (const hl of selectHighlights.all(book.id) as Array<{ id: number; chapter_index: number }>) {
          const newIdx = mapRef(hl.chapter_index);
          if (newIdx !== null) updateHighlight.run(newIdx, hl.id);
        }

        // 4. 删除卷标题章节
        for (const vc of volumeChapters) {
          deleteChapter.run(book.id, vc.chapter_index);
        }

        // 5. 重排保留章节 chapter_index（两阶段经负数区中转，避开 UNIQUE(book_id, chapter_index) 冲突）
        for (const c of kept) {
          reindexChapter.run(-(c.chapter_index + 1), book.id, c.chapter_index);
        }
        for (const c of kept) {
          reindexChapter.run(oldToNew.get(c.chapter_index) ?? 0, book.id, -(c.chapter_index + 1));
        }

        totalBooksFixed++;
        totalChaptersDeleted += volumeChapters.length;
      }

      if (totalBooksFixed > 0) {
        console.log(
          `[db] v27 卷标题章节清理: ${totalBooksFixed} 本书, 删除 ${totalChaptersDeleted} 个卷标题章节并归属到卷`
        );
      }
    }
  },
  {
    version: 28,
    description:
      'PDF 卷标题章清理（任务13，用户投诉"PDF 解析处理排序有问题，没有 txt 完善"）：v27 清理后新导入的 PDF outline 卷标题章 content 常为 NULL（无文字层/未缓存）被漏掉（实测 0day安全 id=720 idx=5"第1篇 漏洞利用原理（初级）"url=26-26 单页）。v28 判定（比 v27 增加结构性双保险）：title 匹配卷模式 且 (content NULL 或 <100 字符) 且 (url 为单页区间 N-N 或 file_length 极小)，防误删有文字的真章；仅处理 PDF 书。其余复用 v27 模式（卷归属已关联的不动、删除+重排两阶段负数中转、修正 reading_progress/bookmarks/highlights 引用、全卷保护）',
    up: (db) => {
      /** 卷标题章节判定阈值（与 v27 一致）：真实章节即使标题形似卷名，内容也不会只有几十字 */
      const VOLUME_CHAPTER_MAX_CONTENT = 100;
      /** file_length 极小阈值：卷标题页独占单页且无文字层，章节文本长度接近 0 */
      const VOLUME_CHAPTER_MAX_FILE_LENGTH = 100;
      /** PDF outline 文本路径的区间 url："N-N"（可带 @ratio 页内偏移尾缀）。
       *  纯数字 url（如 "26"）是漫画 per-page 路径格式——漫画卷首页有内容不该清，
       *  必须排除；txt 无 url / epub href / mobi 无 url 天然不匹配 */
      const PAGE_RANGE_URL_RE = /^(\d+)-(\d+)(@\d+(?:\.\d+)?)?$/;

      /** 该章是否为"卷标题页"结构性特征：PDF outline 区间 url 且（单页区间
       *  （卷扉页独占一页，如 '26-26'）或 file_length 极小） */
      const isVolumePageUrl = (url: string | null, fileLength: number | null): boolean => {
        if (!url) return false;
        const m = url.match(PAGE_RANGE_URL_RE);
        if (m === null) return false; // 漫画纯数字/其他格式 url 不适用本迁移
        if (m[1] === m[2]) return true; // 单页区间：卷扉页独占一页
        return fileLength != null && fileLength < VOLUME_CHAPTER_MAX_FILE_LENGTH;
      };

      // 仅处理 PDF 书（v28 聚焦 v27 漏掉的 PDF 卷标题章；'N-N' url 为 PDF outline
      // 路径特有格式，epub href/mobi 无 url 天然不命中，file_type 过滤双保险）
      const books = db
        .prepare("SELECT id FROM books WHERE file_type = 'pdf'")
        .all() as { id: number }[];
      const selectChapters = db.prepare(
        'SELECT chapter_index, title, content, url, file_length FROM chapters WHERE book_id = ? ORDER BY chapter_index'
      );
      // v28 与 v27 的差异：卷归属已关联的章节不动（volume IS NULL 才补）——
      // v27 后新导入的书子章 volume 已由解析代码正确关联，无条件覆盖可能改掉
      // 与卷章标题略有差异的既有值
      const setVolume = db.prepare(
        'UPDATE chapters SET volume = ? WHERE book_id = ? AND chapter_index = ? AND volume IS NULL'
      );
      const deleteChapter = db.prepare('DELETE FROM chapters WHERE book_id = ? AND chapter_index = ?');
      const reindexChapter = db.prepare(
        'UPDATE chapters SET chapter_index = ? WHERE book_id = ? AND chapter_index = ?'
      );
      const selectProgress = db.prepare('SELECT chapter_index FROM reading_progress WHERE book_id = ?');
      const updateProgress = db.prepare('UPDATE reading_progress SET chapter_index = ? WHERE book_id = ?');
      const selectBookmarks = db.prepare('SELECT id, chapter_index FROM bookmarks WHERE book_id = ?');
      const updateBookmark = db.prepare('UPDATE bookmarks SET chapter_index = ? WHERE id = ?');
      const selectHighlights = db.prepare('SELECT id, chapter_index FROM highlights WHERE book_id = ?');
      const updateHighlight = db.prepare('UPDATE highlights SET chapter_index = ? WHERE id = ?');

      let totalBooksFixed = 0;
      let totalChaptersDeleted = 0;

      for (const book of books) {
        const chapters = selectChapters.all(book.id) as Array<{
          chapter_index: number;
          title: string | null;
          content: string | null;
          url: string | null;
          file_length: number | null;
        }>;

        // 卷标题章节（比 v27 多结构性双保险）：
        // 1. title 匹配卷模式（isVolumeLine，含"第1篇 漏洞利用原理（初级）"带卷名形态）
        // 2. content NULL（PDF 卷标题页无文字层/未缓存）或 <100 字符
        // 3. PDF outline 区间 url 且（单页区间（'26-26'，卷扉页独占一页）或
        //    file_length 极小）——双保险防误删有文字的真章（真章 url 通常为
        //    多页区间且 file_length 大），同时排除漫画纯数字 url（卷首页有内容）
        const volumeChapters = chapters.filter((c) => {
          const title = (c.title ?? '').trim();
          if (title === '') return false;
          if (!isVolumeLine(title)) return false;
          if (!((c.content ?? '').length < VOLUME_CHAPTER_MAX_CONTENT)) return false;
          return isVolumePageUrl(c.url, c.file_length);
        });
        if (volumeChapters.length === 0) continue;
        // 全卷保护：删除后必须仍有章节（整本书全是卷标题章节的病态数据不处理）
        if (volumeChapters.length >= chapters.length) continue;

        const volumeIdxSet = new Set(volumeChapters.map((c) => c.chapter_index));
        const kept = chapters.filter((c) => !volumeIdxSet.has(c.chapter_index));

        // 1. 卷归属：每个卷章节到下一个卷章节之间的章节，volume 补为该卷标题
        //    （已关联的不动——volume IS NULL 才补，v28 语义）
        for (let vi = 0; vi < volumeChapters.length; vi++) {
          const volIdx = volumeChapters[vi].chapter_index;
          const volTitle = extractVolumeTitle((volumeChapters[vi].title ?? '').trim());
          if (!volTitle) continue;
          const nextVolIdx =
            vi + 1 < volumeChapters.length ? volumeChapters[vi + 1].chapter_index : Infinity;
          for (const c of kept) {
            if (c.chapter_index > volIdx && c.chapter_index < nextVolIdx) {
              setVolume.run(volTitle, book.id, c.chapter_index);
            }
          }
        }

        // 2. 旧→新 index 映射（保留章节按原顺序重排为 0..n-1）
        const oldToNew = new Map<number, number>();
        kept.forEach((c, i) => oldToNew.set(c.chapter_index, i));
        // 引用落点：卷章节上的引用 → 其后第一个保留章节（其后无保留章节则落到最后一个保留章节）
        const mapRef = (oldIdx: number): number | null => {
          const direct = oldToNew.get(oldIdx);
          if (direct !== undefined) return direct;
          for (const c of kept) {
            if (c.chapter_index > oldIdx) return oldToNew.get(c.chapter_index) ?? null;
          }
          return kept.length > 0 ? (oldToNew.get(kept[kept.length - 1].chapter_index) ?? null) : null;
        };

        // 3. 修正引用表 chapter_index（按主键定位行，避免新旧值碰撞）
        const progress = selectProgress.get(book.id) as { chapter_index: number } | undefined;
        if (progress) {
          const newIdx = mapRef(progress.chapter_index);
          if (newIdx !== null) updateProgress.run(newIdx, book.id);
        }
        for (const bm of selectBookmarks.all(book.id) as Array<{ id: number; chapter_index: number }>) {
          const newIdx = mapRef(bm.chapter_index);
          if (newIdx !== null) updateBookmark.run(newIdx, bm.id);
        }
        for (const hl of selectHighlights.all(book.id) as Array<{ id: number; chapter_index: number }>) {
          const newIdx = mapRef(hl.chapter_index);
          if (newIdx !== null) updateHighlight.run(newIdx, hl.id);
        }

        // 4. 删除卷标题章节
        for (const vc of volumeChapters) {
          deleteChapter.run(book.id, vc.chapter_index);
        }

        // 5. 重排保留章节 chapter_index（两阶段经负数区中转，避开 UNIQUE(book_id, chapter_index) 冲突）
        for (const c of kept) {
          reindexChapter.run(-(c.chapter_index + 1), book.id, c.chapter_index);
        }
        for (const c of kept) {
          reindexChapter.run(oldToNew.get(c.chapter_index) ?? 0, book.id, -(c.chapter_index + 1));
        }

        totalBooksFixed++;
        totalChaptersDeleted += volumeChapters.length;
      }

      if (totalBooksFixed > 0) {
        console.log(
          `[db] v28 PDF 卷标题章节清理: ${totalBooksFixed} 本书, 删除 ${totalChaptersDeleted} 个卷标题章节（含 content NULL 被 v27 漏掉的）`
        );
      }
    }
  },
  {
    version: 29,
    description:
      '系列元数据（任务14，用户投诉"comic 的提取、分析，我们好像遗漏了很多"）：books 新增 series/series_number/series_total 列，并从 custom_meta.original_filename 的文件名卷号模式（_NN/-NN/第N卷/vol/（N）/尾部裸数字等）回填存量书。格式无关——54 本"哆啦A梦[大长篇][台版]"PDF 漫画内嵌 title 重名无法区分、"21世纪小福星"、"SF短篇集" mobi、txt/epub 系列书统一受益，配合渲染端"系列 · 第N卷"副标题与 title 次级 series_number 自然排序。已有 series 值不覆盖（幂等可重跑）',
    up: (db) => {
      // 1. books 表新增系列列（ALTER TABLE ADD COLUMN 需先检查列是否存在，全新安装 schema.sql 已含列）
      const bookCols = db.prepare("SELECT name FROM pragma_table_info('books')").all() as { name: string }[];
      if (!bookCols.some((c) => c.name === 'series')) {
        db.exec('ALTER TABLE books ADD COLUMN series TEXT');
      }
      if (!bookCols.some((c) => c.name === 'series_number')) {
        db.exec('ALTER TABLE books ADD COLUMN series_number REAL');
      }
      if (!bookCols.some((c) => c.name === 'series_total')) {
        db.exec('ALTER TABLE books ADD COLUMN series_total INTEGER');
      }

      // 2. 存量回填：从 original_filename 提取系列/卷号（只填 series IS NULL 的行，不覆盖已有值）
      const selectBooks = db.prepare('SELECT id, custom_meta FROM books WHERE series IS NULL');
      const updateSeries = db.prepare('UPDATE books SET series = ?, series_number = ? WHERE id = ?');
      let totalBackfilled = 0;

      for (const row of selectBooks.all() as Array<{ id: number; custom_meta: string | null }>) {
        if (!row.custom_meta) continue;
        try {
          const meta = JSON.parse(row.custom_meta) as { original_filename?: unknown };
          if (typeof meta.original_filename !== 'string' || meta.original_filename === '') continue;
          const extracted = extractSeriesFromFilename(meta.original_filename);
          if (!extracted) continue;
          updateSeries.run(extracted.series, extracted.number, row.id);
          totalBackfilled++;
        } catch {
          // 损坏的 custom_meta JSON 跳过，不影响其余书回填
        }
      }

      if (totalBackfilled > 0) {
        console.log(`[db] v29 系列回填: ${totalBackfilled} 本书从原文件名提取到系列信息`);
      }
    }
  }
];

/** 数据库单例 */
let dbInstance: DatabaseType | null = null;

/**
 * 初始化数据库
 *
 * 在 app.whenReady() 中、创建窗口前调用。
 * 幂等：重复调用返回已存在的实例。
 *
 * @returns better-sqlite3 Database 实例
 */
export function initDatabase(): DatabaseType {
  if (dbInstance) return dbInstance;

  const dbPath = getDbPath();
  dbInstance = new Database(dbPath);

  // P1-5 修复：WAL 模式 + 性能优化，减少 better-sqlite3 同步阻塞事件循环的时间
  // 开启 WAL 模式：读写并发性能更好，崩溃恢复更安全
  dbInstance.pragma('journal_mode = WAL');
  // foreign_keys = ON：开启外键约束，删书时级联检查
  dbInstance.pragma('foreign_keys = ON');
  // busy_timeout：多进程访问时等待 5s 而非立即报错
  dbInstance.pragma('busy_timeout = 5000');
  // synchronous = NORMAL：WAL 模式下 NORMAL 足够安全且减少 fsync 阻塞，提升写入吞吐
  // （FULL 每次提交都 fsync，NORMAL 仅在 checkpoint 时 fsync，大幅减少主进程阻塞）
  dbInstance.pragma('synchronous = NORMAL');
  // cache_size = -64000：64MB 内存缓存页，减少磁盘 I/O，加速读写
  // （负值表示以 KB 为单位的总缓存大小，-64000 = 64MB）
  dbInstance.pragma('cache_size = -64000');
  // mmap_size = 268435456：256MB 内存映射 I/O，让 SQLite 直接用 mmap 读数据库文件
  // （减少 read 系统调用，对大数据库读取显著加速）
  dbInstance.pragma('mmap_size = 268435456');
  // WAL 自动 checkpoint 策略：PASSIVE（默认），不在每次提交时主动 checkpoint
  // 避免 checkpoint 阻塞主进程事件循环，让 WAL 文件自然增长由 SQLite 后台处理
  dbInstance.pragma('wal_autocheckpoint = 1000');

  try {
    runMigrations(dbInstance);
    // P1-6修复：FTS5 已弃用（中文分词不佳，改用 LIKE 搜索），不再每次启动 rebuild
    // books_fts 表保留在 schema 中但不再用于搜索，无需维护索引同步
  } catch (err) {
    // 迁移失败时关闭数据库并清空引用，避免后续操作访问损坏的 schema
    console.error('[db] 数据库迁移失败:', err);
    try {
      dbInstance.close();
    } catch {
      /* ignore */
    }
    dbInstance = null;
    throw err;
  }

  return dbInstance;
}

/**
 * 执行版本化迁移
 *
 * 读取 user_version，依次执行 version > user_version 的迁移，
 * 每个迁移在独立事务中运行，全部完成后更新 user_version。
 */
function runMigrations(db: DatabaseType): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  console.log(`[db] 当前 schema 版本: v${currentVersion}, 目标版本: v${SCHEMA_VERSION}`);

  if (currentVersion >= SCHEMA_VERSION) {
    console.log('[db] 数据库已是最新版本，无需迁移');
    return;
  }

  const pending = migrations.filter((m) => m.version > currentVersion);
  pending.sort((a, b) => a.version - b.version);
  console.log(`[db] 待执行迁移: v${pending.map((m) => m.version).join(', v')}`);

  for (const migration of pending) {
    try {
      const tx = db.transaction(() => {
        migration.up(db);
        db.pragma(`user_version = ${migration.version}`);
      });
      tx();
      console.log(`[db] 迁移完成 v${migration.version}: ${migration.description}`);
    } catch (err) {
      console.error(`[db] 迁移失败 v${migration.version}: ${migration.description}`);
      console.error('[db] 错误详情:', err);
      // 不继续执行后续迁移，抛出错误让上层处理
      throw err;
    }
  }
}

/**
 * 获取数据库实例
 *
 * 必须在 initDatabase() 之后调用，否则抛错。
 * Repository 通过此函数获取 db 引用。
 */
export function getDb(): DatabaseType {
  if (!dbInstance) {
    throw new Error('[db] 数据库未初始化，请先调用 initDatabase()');
  }
  return dbInstance;
}

/**
 * 关闭数据库
 *
 * 在 app.before-quit 时调用，确保 WAL 写回主库。
 * 关闭后清空单例，允许重新初始化（主要用于测试）。
 *
 * 显式执行 wal_checkpoint(TRUNCATE) 的原因：
 * better-sqlite3 的 close() 内部 checkpoint 使用 QUIET 模式，遇到残留读锁时
 * 不会强制写回所有 WAL 帧，导致 youdu.db 主库缺失最新数据。TRUNCATE 模式
 * 会把 WAL 全部帧合并进主库并截断 WAL 文件，保证 close 后 youdu.db 自包含。
 * 这对数据目录迁移（仅复制 youdu.db）尤为关键——若 WAL 未完全 checkpoint，
 * 复制出的 youdu.db 会丢失最近写入，重启后表现为书架空。
 */
export function closeDatabase(): void {
  if (dbInstance) {
    try {
      // 先尝试 TRUNCATE checkpoint；即使失败也继续 close（close 还会再尝试一次）
      dbInstance.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      console.warn('[db] WAL checkpoint(TRUNCATE) 失败:', err);
    }
    try {
      dbInstance.close();
    } catch (err) {
      // close 失败不阻断退出，仅告警；强制清空单例允许重新初始化
      console.warn('[db] 关闭数据库失败:', err);
    }
    dbInstance = null;
  }
}

/**
 * 重写 books 表中的绝对路径（cover 和 local_file_path）。
 *
 * 数据目录迁移后，数据库中存储的绝对路径仍指向旧目录，
 * 需重写为新目录下的对应路径，否则重启后封面和书籍全部找不到。
 *
 * 仅重写以 oldRoot 开头的路径，其他路径（如空值、相对路径、其他目录）不动。
 * 用 join(newRoot, path.slice(oldRoot.length)) 而非字符串替换，
 * 确保路径分隔符在跨平台时正确。
 *
 * 用 transaction 包裹批量更新，保证原子性。
 *
 * 供启动迁移（index.ts）和手动迁移（ipc/app.ts）复用。
 *
 * 必须在 initDatabase() 之后调用。
 */
export function rewriteBookPaths(oldRoot: string, newRoot: string): void {
  const db = getDb();
  const books = db.prepare('SELECT id, cover, local_file_path FROM books').all() as {
    id: number;
    cover: string | null;
    local_file_path: string | null;
  }[];
  const updateStmt = db.prepare('UPDATE books SET cover = ?, local_file_path = ? WHERE id = ?');
  const rewriteTx = db.transaction(() => {
    for (const book of books) {
      const newCover =
        book.cover && book.cover.startsWith(oldRoot) ? join(newRoot, book.cover.slice(oldRoot.length)) : book.cover;
      const newPath =
        book.local_file_path && book.local_file_path.startsWith(oldRoot)
          ? join(newRoot, book.local_file_path.slice(oldRoot.length))
          : book.local_file_path;
      if (newCover !== book.cover || newPath !== book.local_file_path) {
        updateStmt.run(newCover, newPath, book.id);
      }
    }
  });
  rewriteTx();
  console.info('[db] 数据库路径重写完成:', oldRoot, '->', newRoot);
}

/**

 * 诊断数据库迁移状态
 *
 * 检查 user_version 和所有预期列/表是否存在，
 * 返回详细诊断信息。供 IPC 调用。
 */
export function diagnoseMigrations(): {
  currentVersion: number;
  expectedVersion: number;
  missingColumns: { table: string; columns: string[] }[];
  missingTables: string[];
  needsMigration: boolean;
} {
  const db = getDb();
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  const missingColumns: { table: string; columns: string[] }[] = [];
  const missingTables: string[] = [];

  // 检查 books 表列
  const bookCols = db.prepare("SELECT name FROM pragma_table_info('books')").all() as { name: string }[];
  const expectedBookCols = [
    'reading_status',
    'rating',
    'is_comic',
    'content_type',
    'subscription_id',
    'has_update',
    'source_url',
    'book_source',
    'import_mode'
  ];
  const missingBookCols = expectedBookCols.filter((c) => !bookCols.some((b) => b.name === c));
  if (missingBookCols.length > 0) {
    missingColumns.push({ table: 'books', columns: missingBookCols });
  }

  // 检查 chapters 表列
  const chapterCols = db.prepare("SELECT name FROM pragma_table_info('chapters')").all() as { name: string }[];
  const expectedChapterCols = ['content_type'];
  const missingChapterCols = expectedChapterCols.filter((c) => !chapterCols.some((ch) => ch.name === c));
  if (missingChapterCols.length > 0) {
    missingColumns.push({ table: 'chapters', columns: missingChapterCols });
  }

  // 检查 bookmarks 表列
  const bookmarkCols = db.prepare("SELECT name FROM pragma_table_info('bookmarks')").all() as { name: string }[];
  const expectedBookmarkCols = ['highlight_color'];
  const missingBookmarkCols = expectedBookmarkCols.filter((c) => !bookmarkCols.some((b) => b.name === c));
  if (missingBookmarkCols.length > 0) {
    missingColumns.push({ table: 'bookmarks', columns: missingBookmarkCols });
  }

  // 检查 highlights 表
  const highlightsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='highlights'").get();
  if (!highlightsTable) {
    missingTables.push('highlights');
  }

  // 检查 subscriptions 表（v11 新增）
  const subscriptionsTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subscriptions'")
    .get();
  if (!subscriptionsTable) {
    missingTables.push('subscriptions');
  }

  return {
    currentVersion,
    expectedVersion: SCHEMA_VERSION,
    missingColumns,
    missingTables,
    needsMigration: currentVersion < SCHEMA_VERSION || missingColumns.length > 0 || missingTables.length > 0
  };
}
