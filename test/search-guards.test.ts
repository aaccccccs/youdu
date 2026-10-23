/**
 * 深度搜索守卫纯函数单元测试（任务 #21 P2 导入三模式第②项）
 *
 * 覆盖 searchBookFileInDirectory 的三级过滤中可纯函数验证的两级：
 * - isCandidateBookFile（扩展名过滤）：EXT_TO_TYPE 反向匹配各书籍类型、
 *   大小写不敏感、不相关扩展名/无扩展名拒绝
 * - isSkippedSearchDirName（目录守卫）：隐藏目录（.git/.svn 等）、
 *   node_modules、Windows 回收站跳过；普通目录放行
 * - verifyFileMatchesHash（双哈希兼容）：xxhash64 快路径命中 /
 *   不一致返回 false（不触发 SHA-256 慢路径的行为由实现保证，此处
 *   用真实临时文件验证快路径正确性）
 *
 * 注：目录 BFS 遍历与超时逻辑依赖真实文件系统与较大目录结构，
 * 由集成验证（手工 smoke）覆盖，不在单测范围。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isCandidateBookFile,
  isSkippedSearchDirName,
  verifyFileMatchesHash,
  computeFileHash
} from '../src/main/core/importer';

/** 测试用临时目录（afterAll 清理） */
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'youdu-search-guards-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('isCandidateBookFile（深度搜索扩展名过滤）', () => {
  it('各书籍类型的正向扩展名匹配', () => {
    expect(isCandidateBookFile('/books/novel.txt', 'txt')).toBe(true);
    expect(isCandidateBookFile('/books/novel.TXT', 'txt')).toBe(true); // 大小写不敏感
    expect(isCandidateBookFile('/books/a.epub', 'epub')).toBe(true);
    expect(isCandidateBookFile('/books/b.pdf', 'pdf')).toBe(true);
    // mobi 家族：.mobi/.azw/.azw3/.azw4 同属 mobi 类型
    expect(isCandidateBookFile('/books/c.mobi', 'mobi')).toBe(true);
    expect(isCandidateBookFile('/books/c.azw3', 'mobi')).toBe(true);
    // comic 家族：.cbz/.cbr/.zip/.rar 同属 comic 类型
    expect(isCandidateBookFile('/books/d.cbz', 'comic')).toBe(true);
    expect(isCandidateBookFile('/books/d.zip', 'comic')).toBe(true);
  });

  it('不相关扩展名与跨类型拒绝（哈希前的零成本剪枝）', () => {
    expect(isCandidateBookFile('/books/cover.jpg', 'pdf')).toBe(false);
    expect(isCandidateBookFile('/books/video.mp4', 'comic')).toBe(false);
    expect(isCandidateBookFile('/books/novel.txt', 'epub')).toBe(false); // 类型不匹配
    expect(isCandidateBookFile('/books/noext', 'txt')).toBe(false); // 无扩展名
    expect(isCandidateBookFile('/books/.hidden.pdf', 'txt')).toBe(false); // 扩展名为 .pdf
  });
});

describe('isSkippedSearchDirName（深度搜索目录守卫）', () => {
  it('隐藏目录与已知无关目录跳过', () => {
    expect(isSkippedSearchDirName('.git')).toBe(true);
    expect(isSkippedSearchDirName('.svn')).toBe(true);
    expect(isSkippedSearchDirName('.DS_Store')).toBe(true);
    expect(isSkippedSearchDirName('node_modules')).toBe(true);
    expect(isSkippedSearchDirName('$RECYCLE.BIN')).toBe(true);
    expect(isSkippedSearchDirName('System Volume Information')).toBe(true);
  });

  it('普通目录（含中文/空格）放行', () => {
    expect(isSkippedSearchDirName('Books')).toBe(false);
    expect(isSkippedSearchDirName('我的书库')).toBe(false);
    expect(isSkippedSearchDirName('My Novels')).toBe(false);
    expect(isSkippedSearchDirName('downloads')).toBe(false);
  });
});

describe('verifyFileMatchesHash（双哈希兼容快路径）', () => {
  it('xxhash64 哈希一致返回 true（relocate/深度搜索/模式转换共用的校验）', async () => {
    const filePath = join(tmpDir, 'sample.txt');
    writeFileSync(filePath, 'youdu p2 search guards fixture');
    const hash = await computeFileHash(filePath);
    expect(hash).toHaveLength(16); // xxhash64 = 16 字符 hex
    expect(await verifyFileMatchesHash(filePath, hash)).toBe(true);
  });

  it('内容变化（哈希不一致）返回 false', async () => {
    const filePath = join(tmpDir, 'other.txt');
    writeFileSync(filePath, 'different content entirely');
    const hash = await computeFileHash(join(tmpDir, 'sample.txt'));
    expect(await verifyFileMatchesHash(filePath, hash)).toBe(false);
  });

  it('空内容与同哈希的空文件自洽（防御：空文件不参与搜索但校验函数自身一致）', async () => {
    const filePath = join(tmpDir, 'empty.txt');
    writeFileSync(filePath, '');
    const hash = await computeFileHash(filePath);
    expect(await verifyFileMatchesHash(filePath, hash)).toBe(true);
  });
});