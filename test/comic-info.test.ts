/**
 * ComicInfo.xml 全字段解析 + migration v29 系列回填测试
 *
 * 覆盖：
 * 1. parseComicInfoXml 对齐 AnansiProject 全字段（31 字段：系列聚合核心/书目信息/创作人员/登场要素等）
 * 2. author/summary 兜底链（Penciller→Writer / Summary→Comments）
 * 3. parseComicNumber 宽松数字解析（整数/小数/范围值/非数字）
 * 4. migration v29：books 加 series/series_number/series_total 列 +
 *    从 custom_meta.original_filename 文件名模式回填存量书（54 本哆啦A梦重名书区分）
 *
 * 环境说明：db/index.ts → utils 依赖 electron（路径管理），vitest node 环境
 * 无 Electron 运行时，mock 后即可加载（与 volume-chapters.test.ts 同款基建）。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import {
  parseComicInfoXml,
  parseComicNumber,
  type ComicInfoMetadata
} from '../src/main/core/parsers/comic-parser';
import { migrations } from '../src/main/db/index';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

/** AnansiProject 标准全字段样例 XML */
const FULL_COMIC_INFO_XML = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Title>大雄的恐龙</Title>
  <Series>哆啦A梦大长篇</Series>
  <Number>1</Number>
  <Volume>1</Volume>
  <Count>24</Count>
  <Summary>大雄用时光布孵出了一只小恐龙。</Summary>
  <Writer>藤子·F·不二雄</Writer>
  <Penciller>藤子·F·不二雄</Penciller>
  <Inker>佐藤勾线</Inker>
  <Colorist>田中上色</Colorist>
  <Letterer>山田嵌字</Letterer>
  <CoverArtist>铃木封面</CoverArtist>
  <Publisher>小学馆</Publisher>
  <PublicationDate>1980-03-15</PublicationDate>
  <Genre>科幻; 冒险</Genre>
  <LanguageISO>zh</LanguageISO>
  <AgeRating>Everyone</AgeRating>
  <PageCount>192</PageCount>
  <Format>Digest</Format>
  <Price>460 円</Price>
  <Characters>野比大雄, 哆啦A梦</Characters>
  <Teams>大雄Team</Teams>
  <Locations>东京</Locations>
  <AlternateSeries>哆啦A梦大全集</AlternateSeries>
  <AlternateNumber>5</AlternateNumber>
  <StoryArc>大长篇</StoryArc>
  <StoryArcNumber>1</StoryArcNumber>
  <SeriesGroup>藤子系列</SeriesGroup>
  <Web>https://example.com/doraemon</Web>
  <Notes>台版</Notes>
  <ScanInformation>某扫描组</ScanInformation>
</ComicInfo>`;

/* ==================== ComicInfo.xml 全字段解析 ==================== */

describe('parseComicInfoXml 全字段（AnansiProject 标准）', () => {
  it('提取全部 31 个标准字段', () => {
    const meta: ComicInfoMetadata = parseComicInfoXml(FULL_COMIC_INFO_XML);

    // 系列聚合核心（→ books.series/series_number/series_total）
    expect(meta.series).toBe('哆啦A梦大长篇');
    expect(meta.number).toBe('1');
    expect(meta.volume).toBe('1');
    expect(meta.count).toBe('24');

    // 书目信息
    expect(meta.publisher).toBe('小学馆');
    expect(meta.publicationDate).toBe('1980-03-15');
    expect(meta.genre).toBe('科幻; 冒险');
    expect(meta.languageIso).toBe('zh');
    expect(meta.ageRating).toBe('Everyone');
    expect(meta.pageCount).toBe('192');
    expect(meta.format).toBe('Digest');
    expect(meta.price).toBe('460 円');

    // 创作人员细分
    expect(meta.writer).toBe('藤子·F·不二雄');
    expect(meta.penciller).toBe('藤子·F·不二雄');
    expect(meta.inker).toBe('佐藤勾线');
    expect(meta.colorist).toBe('田中上色');
    expect(meta.letterer).toBe('山田嵌字');
    expect(meta.coverArtist).toBe('铃木封面');

    // 登场要素
    expect(meta.characters).toBe('野比大雄, 哆啦A梦');
    expect(meta.teams).toBe('大雄Team');
    expect(meta.locations).toBe('东京');

    // 系列扩展
    expect(meta.alternateSeries).toBe('哆啦A梦大全集');
    expect(meta.alternateNumber).toBe('5');
    expect(meta.storyArc).toBe('大长篇');
    expect(meta.storyArcNumber).toBe('1');
    expect(meta.seriesGroup).toBe('藤子系列');

    // 其他
    expect(meta.title).toBe('大雄的恐龙');
    expect(meta.summary).toBe('大雄用时光布孵出了一只小恐龙。');
    expect(meta.web).toBe('https://example.com/doraemon');
    expect(meta.notes).toBe('台版');
    expect(meta.scanInformation).toBe('某扫描组');

    // 合成字段
    expect(meta.author).toBe('藤子·F·不二雄');
  });

  it('author 兜底链：Penciller 优先，缺失时用 Writer', () => {
    const meta = parseComicInfoXml('<ComicInfo><Writer>只写了编剧</Writer></ComicInfo>');
    expect(meta.author).toBe('只写了编剧');
    expect(meta.penciller).toBeUndefined();
    expect(meta.writer).toBe('只写了编剧');
  });

  it('summary 兜底链：Summary 优先，缺失时用 Comments', () => {
    const meta = parseComicInfoXml('<ComicInfo><Comments>评论区信息</Comments></ComicInfo>');
    expect(meta.summary).toBe('评论区信息');
  });

  it('空标签归一化为 undefined（不产生空串）', () => {
    const meta = parseComicInfoXml('<ComicInfo><Series>  </Series><Title></Title></ComicInfo>');
    expect(meta.series).toBeUndefined();
    expect(meta.title).toBeUndefined();
  });

  it('根节点缺失/结构异常返回空元数据（不影响解析主流程）', () => {
    expect(parseComicInfoXml('<Other/>')).toEqual({});
    expect(parseComicInfoXml('not an xml <<<')).toEqual({});
  });
});

/* ==================== 数字字段宽松解析 ==================== */

describe('parseComicNumber', () => {
  it('整数', () => {
    expect(parseComicNumber('2')).toBe(2);
    expect(parseComicNumber('24')).toBe(24);
  });

  it('小数卷号（AnansiProject 允许 Number 为小数）', () => {
    expect(parseComicNumber('2.5')).toBe(2.5);
  });

  it('范围值取起始（如合订 "1-3"）', () => {
    expect(parseComicNumber('1-3')).toBe(1);
  });

  it('非数字文本与空值返回 undefined', () => {
    expect(parseComicNumber('Special')).toBeUndefined();
    expect(parseComicNumber('')).toBeUndefined();
    expect(parseComicNumber(undefined)).toBeUndefined();
  });
});

/* ==================== migration v29：系列列 + 存量回填 ==================== */

/** v29 迁移对象（按版本号定位，缺失时给出明确错误） */
const MIGRATION_V29 = migrations.find((m) => m.version === 29);

describe('migration v29 系列元数据（列扩展 + 文件名回填）', () => {
  it('v29 迁移存在且为最新版本', () => {
    expect(MIGRATION_V29, 'migrations 数组应包含 version 29').toBeDefined();
    const maxVersion = Math.max(...migrations.map((m) => m.version));
    expect(maxVersion).toBe(29);
  });

  it('旧库（无系列列）：加列 + 从 original_filename 回填存量书', () => {
    expect(MIGRATION_V29).toBeDefined();
    const db: DatabaseType = new Database(':memory:');
    // 模拟 v28 时代的旧 books 表（无 series 列，仅含本测试关心的字段）
    db.exec(`CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT,
      file_type TEXT,
      custom_meta TEXT,
      created_at INTEGER,
      updated_at INTEGER
    )`);
    const insert = db.prepare(
      'INSERT INTO books (title, author, file_type, custom_meta) VALUES (?, ?, ?, ?)'
    );
    // 投诉场景：PDF 内嵌 title 统一导致 54 本重名，original_filename 是唯一区分线索
    insert.run('哆啦A梦[大长篇][台版]', '未知', 'pdf', '{"original_filename":"哆啦A梦[大长篇][台版]_01 大雄的恐龙.pdf"}');
    insert.run('哆啦A梦[大长篇][台版]', '未知', 'pdf', '{"original_filename":"哆啦A梦[大长篇][台版]_02 大雄的宇宙开拓史.pdf"}');
    // mobi 无内嵌 title 的系列书同样受益（格式无关）
    insert.run('SF短篇集_01', '未知', 'mobi', '{"original_filename":"SF短篇集_01.mobi"}');
    // 单行本：文件名无卷号模式，不回填
    insert.run('三体', '刘慈欣', 'txt', '{"original_filename":"三体.txt"}');
    // custom_meta 缺失的书不动
    insert.run('无元数据书', '未知', 'epub', null);
    // 已有 series 的书（用户手动/上游写入）不被覆盖
    insert.run('守护系列', '某人', 'pdf', '{"original_filename":"守护者_09.pdf"}');

    // 先跑一次 v29：加列 + 全量回填（守护系列此时也会被回填，属首次填充）
    MIGRATION_V29!.up(db);
    // 模拟用户在回填后手动修正守护系列的 series 值
    db.prepare("UPDATE books SET series = '用户自定义系列', series_number = 99 WHERE title = '守护系列'").run();
    // 再跑一次 v29：已有值保护，用户修正不被文件名提取结果覆盖
    MIGRATION_V29!.up(db);

    const rows = db
      .prepare('SELECT title, series, series_number, series_total FROM books ORDER BY id')
      .all() as Array<{ title: string; series: string | null; series_number: number | null; series_total: number | null }>;

    expect(rows[0]).toMatchObject({ series: '哆啦A梦[大长篇][台版]', series_number: 1 });
    expect(rows[1]).toMatchObject({ series: '哆啦A梦[大长篇][台版]', series_number: 2 });
    expect(rows[2]).toMatchObject({ series: 'SF短篇集', series_number: 1 });
    expect(rows[3]).toMatchObject({ series: null, series_number: null });
    expect(rows[4]).toMatchObject({ series: null, series_number: null });
    // 已有值保护：不被文件名提取结果（守护者/9）覆盖
    expect(rows[5]).toMatchObject({ series: '用户自定义系列', series_number: 99 });

    db.close();
  });

  it('幂等：重复执行不报错、不重复回填', () => {
    expect(MIGRATION_V29).toBeDefined();
    const db: DatabaseType = new Database(':memory:');
    db.exec(`CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      custom_meta TEXT
    )`);
    db.prepare('INSERT INTO books (title, custom_meta) VALUES (?, ?)').run(
      '小福星',
      '{"original_filename":"21世纪小福星_03.pdf"}'
    );

    MIGRATION_V29!.up(db);
    MIGRATION_V29!.up(db); // 第二次执行应幂等

    const row = db.prepare('SELECT series, series_number FROM books').get() as {
      series: string | null;
      series_number: number | null;
    };
    expect(row).toEqual({ series: '21世纪小福星', series_number: 3 });
    db.close();
  });

  it('全新安装路径（schema.sql 建表已含列）跑 v29 不报错且回填仍生效', () => {
    expect(MIGRATION_V29).toBeDefined();
    const db: DatabaseType = new Database(':memory:');
    // v1 迁移用 schema.sql 建表（全新安装 = 最新结构，已含 series 列）
    const v1 = migrations.find((m) => m.version === 1)!;
    v1.up(db);
    db.prepare('INSERT INTO books (title, custom_meta) VALUES (?, ?)').run(
      '哆啦A梦[大长篇][台版]',
      '{"original_filename":"哆啦A梦[大长篇][台版]_10 大雄的日本诞生.pdf"}'
    );

    // 列已存在 → ALTER 跳过，回填逻辑照常执行
    MIGRATION_V29!.up(db);

    const row = db.prepare('SELECT series, series_number FROM books').get() as {
      series: string | null;
      series_number: number | null;
    };
    expect(row).toEqual({ series: '哆啦A梦[大长篇][台版]', series_number: 10 });
    db.close();
  });
});