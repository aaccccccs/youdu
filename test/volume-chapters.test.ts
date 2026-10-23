/**
 * 卷级标记对齐 txt 标杆测试
 *
 * 覆盖路径：
 * 1. mobi splitChaptersByRegex（mobi 正则分章 + epub 单spine兜底共享）
 * 2. pdf splitChapters（无书签 PDF 的文本扫描兜底分章）
 * 3. migration v27（存量书卷标题章节清理 + 引用修正）
 * 4. pdf splitChaptersByOutline 卷标题页跳过（任务13：多层 outline 卷父节点
 *    不入章——0day安全"第1篇"卷扉页成章投诉；边界：孤叶/同页合并/单层）
 * 5. pdf splitChaptersByTextMode detectParseMode 守卫（任务13：八宝门功法
 *    正文行被裸正则误判分章——对齐 txt 的质量判定前置守卫）
 * 6. migration v28（任务13：清理 v27 漏掉的 PDF 卷标题章（content NULL），
 *    url 区间格式结构性双保险防误删）
 *
 * 语义对齐 txt-parser 标杆：卷级标记（含"第一卷 燎山纪氏"带卷名形态）
 * 不作为独立章节、卷标记行不进入任何章节内容、后续章节关联 volume、
 * 卷标记前的序言不属于该卷（volume=null）。
 */
import { describe, it, expect, vi } from 'vitest';

// mobi-parser → utils/epub-parser、db/index.ts → utils 均依赖 electron（路径管理），
// vitest node 环境无 Electron 运行时，mock 后即可加载（探针已验证）。
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import { splitChaptersByRegex } from '../src/main/core/parsers/mobi-parser';
import {
  splitChapters,
  splitChaptersByOutline,
  splitChaptersByTextMode,
  type FlatOutlineNode
} from '../src/main/core/parsers/pdf-parser';
import { migrations, SCHEMA_VERSION } from '../src/main/db/index';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

/* ==================== mobi splitChaptersByRegex 卷处理 ==================== */

describe('splitChaptersByRegex 卷级标记（mobi/epub兜底共享）', () => {
  it('带卷名形态（莽荒纪投诉场景）：卷标题不成章，后续章节关联卷', () => {
    const { chapters, chapterTexts } = splitChaptersByRegex(
      '第一卷 燎山纪氏\n第一章 地府\n地府正文。\n第二章 投胎\n投胎正文。'
    );
    // 无卷标题独立章节
    expect(chapters.map((c) => c.title)).toEqual(['第一章 地府', '第二章 投胎']);
    // 两章归属卷
    expect(chapters[0].volume).toBe('第一卷 燎山纪氏');
    expect(chapters[1].volume).toBe('第一卷 燎山纪氏');
    // 卷标记行不进入任何章节内容
    expect(chapterTexts.join('')).not.toContain('第一卷');
  });

  it('多卷场景：各章归属各自卷，卷标记行不入前章内容', () => {
    const { chapters, chapterTexts } = splitChaptersByRegex(
      '第一卷 甲卷\n第一章 A\na正文。\n第二卷 乙卷\n第一章 B\nb正文。'
    );
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('第一章 A');
    expect(chapters[0].volume).toBe('第一卷 甲卷');
    expect(chapters[1].title).toBe('第一章 B');
    expect(chapters[1].volume).toBe('第二卷 乙卷');
    // 第二卷标记行不进入 A 章内容
    expect(chapterTexts[0]).not.toContain('第二卷');
  });

  it('序言在卷标记之后：序言归属该卷（对齐 txt-parser 实际行为）', () => {
    const { chapters, chapterTexts } = splitChaptersByRegex(
      '第一卷 甲卷\n这是卷首的介绍文字。\n第一章 A\na正文。'
    );
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('序言');
    // txt-parser 标杆：序言 volume = currentVolume（卷标记后的序言归属该卷）
    expect(chapters[0].volume).toBe('第一卷 甲卷');
    expect(chapterTexts[0]).toBe('这是卷首的介绍文字。');
    expect(chapters[1].volume).toBe('第一卷 甲卷');
  });

  it('卷标记之前的散落文字不构成序言（对齐 txt preambleStart 语义）', () => {
    const { chapters } = splitChaptersByRegex('散落的封面文字。\n第一卷 甲卷\n第一章 A\na正文。');
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('第一章 A');
    expect(chapters[0].volume).toBe('第一卷 甲卷');
  });

  it('卷标记与首章间只有空行时不产生空序言（对齐 txt 九鼎记保护）', () => {
    const { chapters } = splitChaptersByRegex('第一卷 甲卷\n\n\n第一章 A\na正文。');
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('第一章 A');
  });

  it('纯卷标记（旧版已识别形态）跳过且记 volume（行为增强回归）', () => {
    const { chapters } = splitChaptersByRegex('第一卷\n第一章 A\na正文。');
    expect(chapters).toHaveLength(1);
    expect(chapters[0].volume).toBe('第一卷');
  });

  it('无卷标记的普通分章不受影响（回归保护）', () => {
    const { chapters } = splitChaptersByRegex('第一章 A\na正文。\n第二章 B\nb正文。');
    expect(chapters).toHaveLength(2);
    expect(chapters[0].volume).toBeNull();
    expect(chapters[1].volume).toBeNull();
  });
});

/* ==================== pdf splitChapters 卷处理（文本扫描路径） ==================== */

describe('pdf splitChapters 卷级标记（无书签 PDF 文本兜底）', () => {
  it('带卷名形态：卷标题不成章，后续章节关联卷，卷行不入内容', () => {
    const { chapters, chapterTexts } = splitChapters(
      '第一卷 燎山纪氏\n第一章 地府\n地府正文。\n第二章 投胎\n投胎正文。'
    );
    expect(chapters.map((c) => c.title)).toEqual(['第一章 地府', '第二章 投胎']);
    expect(chapters[0].volume).toBe('第一卷 燎山纪氏');
    expect(chapters[1].volume).toBe('第一卷 燎山纪氏');
    expect(chapterTexts.join('')).not.toContain('第一卷');
  });

  it('多卷场景：各章归属各自卷', () => {
    const { chapters } = splitChapters('第一卷 甲卷\n第一章 A\na正文。\n第二卷 乙卷\n第一章 B\nb正文。');
    expect(chapters).toHaveLength(2);
    expect(chapters[0].volume).toBe('第一卷 甲卷');
    expect(chapters[1].volume).toBe('第二卷 乙卷');
  });

  it('无卷标记的普通分章不受影响（回归保护）', () => {
    const { chapters } = splitChapters('第一章 A\na正文。\n第二章 B\nb正文。');
    expect(chapters).toHaveLength(2);
    expect(chapters.every((c) => c.volume == null)).toBe(true);
  });
});

/* ==================== migration v27：存量卷标题章节清理 ==================== */

/** 构建内存测试库的最小表结构（与 schema.sql 对齐的最小集） */
function buildTestDb(): DatabaseType {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, file_type TEXT DEFAULT 'txt');
    CREATE TABLE chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      chapter_index INTEGER NOT NULL,
      title TEXT,
      content TEXT,
      url TEXT,
      file_length INTEGER,
      volume TEXT,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
      UNIQUE(book_id, chapter_index)
    );
    CREATE TABLE reading_progress (
      book_id INTEGER PRIMARY KEY,
      chapter_index INTEGER NOT NULL,
      scroll_position REAL DEFAULT 0
    );
    CREATE TABLE bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      chapter_index INTEGER NOT NULL,
      position INTEGER
    );
    CREATE TABLE highlights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL,
      chapter_index INTEGER NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL
    );
  `);
  return db;
}

/** 取 v27 迁移定义 */
function getMigration27(): (db: DatabaseType) => void {
  const m = migrations.find((x) => x.version === 27);
  if (!m) throw new Error('v27 迁移不存在');
  return m.up;
}

describe('migration v27 存量卷标题章节清理', () => {
  it('莽荒纪场景：卷章节删除、后续归属卷、index 重排、三表引用修正', () => {
    const db = buildTestDb();
    const bookId = 1;
    db.prepare("INSERT INTO books (id, title, file_type) VALUES (1, '莽荒纪', 'epub')").run();
    const insertChapter = db.prepare(
      'INSERT INTO chapters (book_id, chapter_index, title, content) VALUES (?, ?, ?, ?)'
    );
    insertChapter.run(bookId, 0, '封面', '封面页内容');
    insertChapter.run(bookId, 1, '第一章 地府', '第一章的正文内容比较长，超过一百个字符。'.repeat(3));
    insertChapter.run(bookId, 2, '第一卷 燎山纪氏', '第一卷 燎山纪氏'); // 8 字符卷标题章节
    insertChapter.run(bookId, 3, '第二章 投胎', '第二章的正文内容比较长，超过一百个字符。'.repeat(3));
    // 阅读进度恰好停在卷标题章节上（实测场景）
    db.prepare('INSERT INTO reading_progress (book_id, chapter_index) VALUES (?, ?)').run(bookId, 2);
    db.prepare('INSERT INTO bookmarks (book_id, chapter_index) VALUES (?, ?)').run(bookId, 3);
    db.prepare('INSERT INTO highlights (book_id, chapter_index, start_offset, end_offset) VALUES (?, ?, ?, ?)').run(
      bookId,
      1,
      0,
      10
    );

    getMigration27()(db);

    // 卷章节被删，剩余 3 章且 index 连续 0..2
    const chapters = db
      .prepare('SELECT chapter_index, title, volume FROM chapters WHERE book_id = ? ORDER BY chapter_index')
      .all(bookId) as Array<{ chapter_index: number; title: string; volume: string | null }>;
    expect(chapters).toHaveLength(3);
    expect(chapters.map((c) => c.chapter_index)).toEqual([0, 1, 2]);
    expect(chapters.map((c) => c.title)).toEqual(['封面', '第一章 地府', '第二章 投胎']);
    // 卷章节之后的章节归属到卷；卷章节之前的（封面、第一章）不受影响
    expect(chapters[0].volume).toBeNull();
    expect(chapters[1].volume).toBeNull();
    expect(chapters[2].volume).toBe('第一卷 燎山纪氏');

    // 引用修正：原 index=2（被删卷章节）→ 其后第一个保留章节（原3 → 新2）
    const progress = db
      .prepare('SELECT chapter_index FROM reading_progress WHERE book_id = ?')
      .get(bookId) as { chapter_index: number };
    expect(progress.chapter_index).toBe(2);
    // 原 index=3（保留章节）→ 偏移 -1 → 新2
    const bookmark = db
      .prepare('SELECT chapter_index FROM bookmarks WHERE book_id = ?')
      .get(bookId) as { chapter_index: number };
    expect(bookmark.chapter_index).toBe(2);
    // 原 index=1（卷前保留章节）→ 不偏移 → 新1
    const highlight = db
      .prepare('SELECT chapter_index FROM highlights WHERE book_id = ?')
      .get(bookId) as { chapter_index: number };
    expect(highlight.chapter_index).toBe(1);

    db.close();
  });

  it('标题像卷名但内容不短的真实章节不误删（保护）', () => {
    const db = buildTestDb();
    db.prepare("INSERT INTO books (id, title, file_type) VALUES (1, '正常书', 'txt')").run();
    const insertChapter = db.prepare(
      'INSERT INTO chapters (book_id, chapter_index, title, content) VALUES (?, ?, ?, ?)'
    );
    // 标题是卷模式但内容 200+ 字符 → 真实章节，不删
    insertChapter.run(1, 0, '第一卷 长篇正文', '真实章节内容。'.repeat(50));
    db.prepare('INSERT INTO reading_progress (book_id, chapter_index) VALUES (?, ?)').run(1, 0);

    getMigration27()(db);

    const count = db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number };
    expect(count.n).toBe(1);
    const progress = db
      .prepare('SELECT chapter_index FROM reading_progress WHERE book_id = ?')
      .get(1) as { chapter_index: number };
    expect(progress.chapter_index).toBe(0);
    db.close();
  });

  it('无卷章节的书完全不受影响 + 幂等重入安全', () => {
    const db = buildTestDb();
    db.prepare("INSERT INTO books (id, title, file_type) VALUES (1, '普通书', 'txt')").run();
    db.prepare(
      'INSERT INTO chapters (book_id, chapter_index, title, content) VALUES (1, 0, ?, ?)'
    ).run('第一章 起点', '正文内容。'.repeat(30));

    const up = getMigration27();
    up(db);
    up(db); // 幂等重入

    const count = db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });
});
/* ==================== pdf splitChaptersByOutline 卷标题页跳过（任务13） ==================== */

/** 构造扁平 outline 节点的测试辅助（dest 不参与分章逻辑，置 null） */
function outlineNode(
  title: string,
  pageNumber: number,
  depth: number,
  hasChildren = false
): FlatOutlineNode {
  return { title, dest: null, pageNumber, depth, hasChildren };
}

describe('pdf splitChaptersByOutline 卷标题页跳过（多层 outline 卷父节点）', () => {
  it('0day场景：卷父节点（第X篇）不入章，子章归属卷，卷标题页不入章节内容', () => {
    // 复刻实测数据：《0day安全》卷扉页（第1篇，0-based 页 25）成了一章
    const pageTexts = Array.from({ length: 30 }, (_, i) => `第${i + 1}页正文内容。`);
    pageTexts[25] = '第1篇 漏洞利用原理（初级）';
    pageTexts[28] = '第2篇 漏洞利用原理（高级）';
    const flatOutline: FlatOutlineNode[] = [
      outlineNode('前言', 3, 0),
      outlineNode('目录', 14, 0),
      outlineNode('第1篇 漏洞利用原理（初级）', 25, 0, true), // 卷父节点（有子节点）
      outlineNode('1.1.2 几个令人困惑的安全问题', 26, 1),
      outlineNode('1.1.3 漏洞挖掘、漏洞分析、漏洞利用', 27, 1),
      outlineNode('第2篇 漏洞利用原理（高级）', 28, 0, true), // 第二个卷父节点
      outlineNode('2.1.1 shellcode与exploit', 29, 1)
    ];

    const { chapters, chapterTexts } = splitChaptersByOutline(flatOutline, pageTexts, 30);

    // 卷父节点不入章（txt 标杆：卷标记不入章）
    expect(chapters.map((c) => c.title)).toEqual([
      '前言',
      '目录',
      '1.1.2 几个令人困惑的安全问题',
      '1.1.3 漏洞挖掘、漏洞分析、漏洞利用',
      '2.1.1 shellcode与exploit'
    ]);
    // 子章归属各自的卷
    expect(chapters[2].volume).toBe('第1篇 漏洞利用原理（初级）');
    expect(chapters[3].volume).toBe('第1篇 漏洞利用原理（初级）');
    expect(chapters[4].volume).toBe('第2篇 漏洞利用原理（高级）');
    // 卷标题页（0-based 25/28）不进入任何章节内容（txt"卷标记行不入内容"的页级近似）
    expect(chapterTexts.join('')).not.toContain('第1篇 漏洞利用原理');
    expect(chapterTexts.join('')).not.toContain('第2篇 漏洞利用原理');
    // index 连续无空洞（readPdfChapter 用 index 直接索引 chapterTexts）
    expect(chapters.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
    // url 边界与实测对齐：目录章到卷扉页前（15-25）、首子章 27-27
    expect(chapters[1].url).toBe('15-25');
    expect(chapters[2].url).toBe('27-27');
    expect(chapters[4].url).toBe('30-30');
  });

  it('孤叶顶层节点（无子节点的 depth=0）是真章节，不跳过', () => {
    const pageTexts = Array.from({ length: 8 }, (_, i) => `第${i + 1}页正文内容。`);
    const flatOutline: FlatOutlineNode[] = [
      outlineNode('第1篇 甲', 1, 0, true), // 卷父节点
      outlineNode('1.1 小节', 2, 1),
      outlineNode('附录A', 5, 0) // 孤叶顶层（无子节点）：真章节
    ];

    const { chapters } = splitChaptersByOutline(flatOutline, pageTexts, 8);

    // 卷父跳过、孤叶保留
    expect(chapters.map((c) => c.title)).toEqual(['1.1 小节', '附录A']);
    expect(chapters[0].volume).toBe('第1篇 甲');
    // 孤叶顶层节点视作普通章节（depth=0 不填 volume）
    expect(chapters[1].volume).toBeUndefined();
  });

  it('同页合并组（卷头+首章同页）不跳过：组承载首章内容页', () => {
    const pageTexts = Array.from({ length: 5 }, (_, i) => `第${i + 1}页正文内容。`);
    pageTexts[2] = '第1篇 甲卷\n1.1.1 首章内容开头。';
    const flatOutline: FlatOutlineNode[] = [
      outlineNode('第1篇 甲卷', 2, 0, true), // 卷父节点
      outlineNode('1.1.1 首章标题比较长一些', 2, 1) // 与卷父同页 → 合并成一组
    ];

    const { chapters, chapterTexts } = splitChaptersByOutline(flatOutline, pageTexts, 5);

    // 混合组保留（跳过会丢首章内容页）；标题取信息量更大的子章标题
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('1.1.1 首章标题比较长一些');
    // 组内容包含同页正文（首章内容页不丢）
    expect(chapterTexts[0]).toContain('1.1.1 首章内容开头');
    // 卷语义经 volumeSource 溯源（后续 depth>0 章节归属用，本组自身 depth=0 不填）
    expect(chapters[0].volume).toBeUndefined();
  });

  it('单层 outline（全 depth=0）不跳过（回归保护：否则删光所有章）', () => {
    const pageTexts = Array.from({ length: 9 }, (_, i) => `第${i + 1}页正文内容。`);
    const flatOutline: FlatOutlineNode[] = [
      outlineNode('第一章 A', 0, 0),
      outlineNode('第二章 B', 3, 0),
      outlineNode('第三章 C', 6, 0)
    ];

    const { chapters } = splitChaptersByOutline(flatOutline, pageTexts, 9);

    expect(chapters.map((c) => c.title)).toEqual(['第一章 A', '第二章 B', '第三章 C']);
    // 单层不填 volume（保持平级）
    expect(chapters.every((c) => c.volume === undefined)).toBe(true);
  });
});

/* ==================== pdf splitChaptersByTextMode detectParseMode 守卫（任务13） ==================== */

describe('pdf splitChaptersByTextMode 文本分章质量守卫', () => {
  it('纯正文（无章节标记）→ 不分章，整书单章（八宝门功法场景）', () => {
    // 复刻实测：《八宝门功法大全》正文行无任何章节标记
    const fullText = [
      '揉摩：在练习排打腹部之前，应先揉摩腹部，使腹部肌肉放松。',
      '罗汉抱肚：身正直，双脚横开与肩同宽，双手叠于腹前。',
      '排打：以药捶或沙袋沿腹部经络依次排打，力度由轻渐重。'
    ].join('\n').repeat(5);

    const { chapters, chapterTexts } = splitChaptersByTextMode(fullText);

    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('全文');
    expect(chapters[0].fileOffset).toBe(0);
    expect(chapters[0].fileLength).toBe(fullText.length);
    expect(chapterTexts).toEqual([fullText]);
  });

  it('有章节标记的文本 → 正常分章（novel 模式不受守卫影响）', () => {
    const fullText = '第一章 起\n起正文。\n第二章 承\n承正文。';
    const { chapters } = splitChaptersByTextMode(fullText);
    expect(chapters.map((c) => c.title)).toEqual(['第一章 起', '第二章 承']);
  });

  it('markdown 模式不拦截（保持既有 splitChapters 行为）', () => {
    // 3+ 个 ATX 标题 → detectParseMode 返回 'markdown'，守卫只拦 plain
    const mdText = '# 标题一\n正文一\n# 标题二\n正文二\n# 标题三\n正文三';
    const { chapters } = splitChaptersByTextMode(mdText);
    // 与守卫前行为一致：# 标题行不被章节正则识别 → 空（调用方 pageChunk 兜底）
    expect(chapters).toHaveLength(0);
  });
});

/* ==================== migration v28：PDF 卷标题章清理（任务13） ==================== */

/** 取 v28 迁移定义 */
function getMigration28(): (db: DatabaseType) => void {
  const m = migrations.find((x) => x.version === 28);
  if (!m) throw new Error('v28 迁移不存在');
  return m.up;
}

describe('migration v28 PDF 卷标题章清理（含 content NULL）', () => {
  it('SCHEMA_VERSION 与 migrations 最大 version 一致（防误报 needsMigration）', () => {
    expect(SCHEMA_VERSION).toBe(migrations[migrations.length - 1].version);
    // v29（任务14 系列元数据）追加后，最新版本号守卫同步递增
    expect(migrations[migrations.length - 1].version).toBe(29);
  });

  it('0day场景：content NULL 卷标题章（url 26-26）被清理、引用修正、已关联卷不动', () => {
    const db = buildTestDb();
    const bookId = 1;
    db.prepare(
      "INSERT INTO books (id, title, file_type) VALUES (1, '0day安全：软件漏洞分析技术', 'pdf')"
    ).run();
    const insertChapter = db.prepare(
      'INSERT INTO chapters (book_id, chapter_index, title, content, url, file_length, volume) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insertChapter.run(bookId, 0, '目录', null, '15-25', 20, null);
    // v27 漏掉的 PDF 卷标题章：content NULL（无文字层/未缓存）、单页区间 url
    insertChapter.run(bookId, 1, '第1篇 漏洞利用原理（初级）', null, '26-26', 0, null);
    // 子章卷归属已由新解析代码正确关联（v28 语义：已关联的不动）
    insertChapter.run(bookId, 2, '1.1.2 几个令人困惑的安全问题', null, '27-27', 0, '第1篇 漏洞利用原理（初级）');
    // volume 未关联的子章（v28 补齐）
    insertChapter.run(bookId, 3, '1.1.3 漏洞挖掘', null, '28-29', 2, null);
    // 阅读进度恰好停在卷标题章上（实测场景）
    db.prepare('INSERT INTO reading_progress (book_id, chapter_index) VALUES (?, ?)').run(bookId, 1);
    db.prepare('INSERT INTO bookmarks (book_id, chapter_index) VALUES (?, ?)').run(bookId, 2);
    db.prepare('INSERT INTO highlights (book_id, chapter_index, start_offset, end_offset) VALUES (?, ?, ?, ?)').run(
      bookId,
      3,
      0,
      10
    );

    getMigration28()(db);

    // 卷标题章被删，剩 3 章 index 连续 0..2
    const chapters = db
      .prepare('SELECT chapter_index, title, volume FROM chapters WHERE book_id = ? ORDER BY chapter_index')
      .all(bookId) as Array<{ chapter_index: number; title: string; volume: string | null }>;
    expect(chapters.map((c) => c.title)).toEqual(['目录', '1.1.2 几个令人困惑的安全问题', '1.1.3 漏洞挖掘']);
    expect(chapters.map((c) => c.chapter_index)).toEqual([0, 1, 2]);
    // 已关联的卷不动；未关联的补为卷标题
    expect(chapters[1].volume).toBe('第1篇 漏洞利用原理（初级）');
    expect(chapters[2].volume).toBe('第1篇 漏洞利用原理（初级）');

    // 引用修正：原 idx=1（被删卷章）→ 其后第一个保留章（原2 → 新1）
    const progress = db
      .prepare('SELECT chapter_index FROM reading_progress WHERE book_id = ?')
      .get(bookId) as { chapter_index: number };
    expect(progress.chapter_index).toBe(1);
    // 原 idx=2（保留章）→ 偏移 -1 → 新1
    const bookmark = db
      .prepare('SELECT chapter_index FROM bookmarks WHERE book_id = ?')
      .get(bookId) as { chapter_index: number };
    expect(bookmark.chapter_index).toBe(1);
    // 原 idx=3（保留章）→ 偏移 -1 → 新2
    const highlight = db
      .prepare('SELECT chapter_index FROM highlights WHERE book_id = ?')
      .get(bookId) as { chapter_index: number };
    expect(highlight.chapter_index).toBe(2);

    db.close();
  });

  it('双保险：标题像卷名的未读真章（content NULL + 多页区间 + file_length 大）不误删', () => {
    const db = buildTestDb();
    db.prepare("INSERT INTO books (id, title, file_type) VALUES (1, '真章书', 'pdf')").run();
    // v27 会误删这种（content NULL 即命中）；v28 的 url/file_length 双保险保护
    db.prepare(
      'INSERT INTO chapters (book_id, chapter_index, title, content, url, file_length, volume) VALUES (1, 0, ?, ?, ?, ?, ?)'
    ).run('第一卷 长篇正文', null, '5-30', 2000, null);
    db.prepare('INSERT INTO reading_progress (book_id, chapter_index) VALUES (1, 0)').run();

    getMigration28()(db);

    const count = db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number };
    expect(count.n).toBe(1);
    const progress = db
      .prepare('SELECT chapter_index FROM reading_progress WHERE book_id = ?')
      .get(1) as { chapter_index: number };
    expect(progress.chapter_index).toBe(0);
    db.close();
  });

  it('漫画纯数字 url（per-page 格式）不清理（漫画卷首页有内容）', () => {
    const db = buildTestDb();
    db.prepare("INSERT INTO books (id, title, file_type) VALUES (1, '漫画书', 'pdf')").run();
    db.prepare(
      'INSERT INTO chapters (book_id, chapter_index, title, content, url, file_length, volume) VALUES (1, 0, ?, ?, ?, ?, ?)'
    ).run('第1卷', null, '26', 0, null);

    getMigration28()(db);

    const count = db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it('非 PDF 书不受影响 + 幂等重入安全', () => {
    const db = buildTestDb();
    // txt 书的同形态数据（v27 的管辖范围，v28 只管 PDF）
    db.prepare("INSERT INTO books (id, title, file_type) VALUES (1, 'txt书', 'txt')").run();
    db.prepare(
      'INSERT INTO chapters (book_id, chapter_index, title, content, url, file_length, volume) VALUES (1, 0, ?, ?, ?, ?, ?)'
    ).run('第一卷 甲卷', null, '26-26', 0, null);

    const up = getMigration28();
    up(db);
    up(db); // 幂等重入

    const count = db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it('全卷保护：整本书全是卷标题章时不处理', () => {
    const db = buildTestDb();
    db.prepare("INSERT INTO books (id, title, file_type) VALUES (1, '病态书', 'pdf')").run();
    const insertChapter = db.prepare(
      'INSERT INTO chapters (book_id, chapter_index, title, content, url, file_length, volume) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insertChapter.run(1, 0, '第一卷 甲', null, '2-2', 0, null);
    insertChapter.run(1, 1, '第二卷 乙', null, '5-5', 0, null);

    getMigration28()(db);

    const count = db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });
});