/**
 * mergeChapterImages / parseFileMissingMessage 单元测试（任务 #22 第⑤项）
 *
 * 覆盖终验探针验证过的场景：
 * - mergeChapterImages（v53 分批渐进加载的前端合并纯函数）：
 *   正常队列对齐合并 / updated 缩短防御 / pending 非法槽位 /
 *   空列表 / blank 占位条目保留
 * - parseFileMissingMessage（批次 v54 link 书失效结构化错误解析）：
 *   前缀解析 / JSON roundtrip / 非法输入（无前缀、坏 JSON、字段类型非法）返回 null
 */
import { describe, it, expect } from 'vitest';
import { mergeChapterImages, parseFileMissingMessage } from '../src/shared';
import type { ChapterImage } from '../src/shared';

/** 已渲染图片条目（i 用于生成可区分的 path） */
const img = (i: number, width = 800, height = 600): ChapterImage => ({
  path: `/data/images/ch1_p${i}.webp`,
  width,
  height
});

/** pending 占位条目（主进程未渲染槽位的 blank 标记） */
const blank = (): ChapterImage => ({ path: '', width: 0, height: 0, pending: true });

describe('mergeChapterImages', () => {
  it('正常队列对齐：非 pending 取 updated 最新值，pending 槽位依序保留 current 占位', () => {
    const current = [img(0), blank(), blank(), blank()];
    // 续载后主进程渲染出第 1、2 页（内容更新），末页仍 pending
    const updated = [img(0, 1600, 1200), img(1), img(2), blank()];
    const merged = mergeChapterImages(current, updated);

    expect(merged).toHaveLength(4);
    // 非 pending 槽位：采用 updated 的最新值（含重渲染后的新尺寸）
    expect(merged[0]).toBe(updated[0]);
    expect(merged[0].width).toBe(1600);
    expect(merged[1]).toBe(updated[1]);
    expect(merged[2]).toBe(updated[2]);
    // pending 槽位：保留 current 的占位（引用不变，维持数组长度语义）
    expect(merged[3].pending).toBe(true);
    expect(merged[3]).toBe(current[1]);
  });

  it('updated 缩短防御：近空白页渲染后不占槽位，列表随 updated 收缩', () => {
    const current = [img(0), blank(), blank()];
    // 第 2 页近空白被主进程跳过 → updated 无该槽位且不再有 pending
    const updated = [img(0), img(1)];
    const merged = mergeChapterImages(current, updated);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(updated[0]);
    expect(merged[1]).toBe(updated[1]);
    expect(merged.some((e) => e.pending)).toBe(false);
  });

  it('pending 非法槽位：updated 末尾 pending 多于 current 占位时原样保留（防御）', () => {
    // 语义约定外的不该发生输入：current 无 pending，updated 却带 pending
    const current = [img(0)];
    const strayPending = blank();
    const updated = [img(0), strayPending];
    const merged = mergeChapterImages(current, updated);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(updated[0]);
    // pendingSlots 已耗尽 → 采用 updated 自己的 pending 条目
    expect(merged[1]).toBe(strayPending);
  });

  it('空列表：current 为空时逐条采用 updated（含其 pending）', () => {
    const updated = [img(0), blank(), img(2)];
    const merged = mergeChapterImages([], updated);

    expect(merged).toHaveLength(3);
    expect(merged[0]).toBe(updated[0]);
    expect(merged[1]).toBe(updated[1]);
    expect(merged[2]).toBe(updated[2]);
  });

  it('空列表：updated 为空返回空数组', () => {
    expect(mergeChapterImages([img(0), blank()], [])).toEqual([]);
    expect(mergeChapterImages([], [])).toEqual([]);
  });

  it('blank 占位条目跨轮合并保留（数组长度语义不因续载漂移）', () => {
    // 首轮：1 页已渲染 + 2 个 blank 占位
    let current: ChapterImage[] = [img(0), blank(), blank()];
    // 第二轮：续载渲染 1 页，仍有 1 个 blank 占位
    current = mergeChapterImages(current, [img(0), img(1), blank()]);
    expect(current).toHaveLength(3);
    expect(current[2].pending).toBe(true);

    // 第三轮：全部渲染完成，无 blank
    const final = mergeChapterImages(current, [img(0), img(1), img(2)]);
    expect(final).toHaveLength(3);
    expect(final.some((e) => e.pending)).toBe(false);
    expect(final[2].path).toBe('/data/images/ch1_p2.webp');
  });
});

describe('parseFileMissingMessage', () => {
  it('解析 [FILE_MISSING] 前缀消息的三个字段', () => {
    const message = '[FILE_MISSING]{"bookId":7,"path":"/home/u/书.epub","hash":"ab12cd34ef56"}';
    expect(parseFileMissingMessage(message)).toEqual({
      bookId: 7,
      path: '/home/u/书.epub',
      hash: 'ab12cd34ef56'
    });
  });

  it('JSON roundtrip：主进程编码格式解析回原对象（含中文路径/特殊字符）', () => {
    // 与主进程 FileMissingError 编码严格一致（chapter-reader.ts）：
    // message = '[FILE_MISSING]' + JSON.stringify({ bookId, path, hash })
    const payload = { bookId: 42, path: '/mnt/外部盘/幽 读 (v2).pdf', hash: '9f8e7d6c' };
    const message = `[FILE_MISSING]${JSON.stringify(payload)}`;
    expect(parseFileMissingMessage(message)).toEqual(payload);
  });

  it('hash 缺失或非字符串时归一为 null', () => {
    expect(parseFileMissingMessage('[FILE_MISSING]{"bookId":1,"path":"/a.epub"}')).toEqual({
      bookId: 1,
      path: '/a.epub',
      hash: null
    });
    expect(
      parseFileMissingMessage('[FILE_MISSING]{"bookId":1,"path":"/a.epub","hash":123}')
    ).toEqual({ bookId: 1, path: '/a.epub', hash: null });
  });

  it('无 [FILE_MISSING] 前缀的普通错误消息返回 null', () => {
    expect(parseFileMissingMessage('读取章节失败: EACCES')).toBeNull();
    expect(parseFileMissingMessage('')).toBeNull();
    // 前缀出现在中间（非 startsWith）同样视为普通错误
    expect(parseFileMissingMessage('Error: [FILE_MISSING]{"bookId":1,"path":"/a"}')).toBeNull();
  });

  it('前缀后非合法 JSON 返回 null', () => {
    expect(parseFileMissingMessage('[FILE_MISSING]{oops')).toBeNull();
    expect(parseFileMissingMessage('[FILE_MISSING]')).toBeNull();
    expect(parseFileMissingMessage('[FILE_MISSING]null')).toBeNull();
  });

  it('字段类型非法返回 null（bookId 非数字/非整数/非正数，path 非字符串/空）', () => {
    expect(parseFileMissingMessage('[FILE_MISSING]{"path":"/a","hash":"h"}')).toBeNull();
    expect(
      parseFileMissingMessage('[FILE_MISSING]{"bookId":"1","path":"/a","hash":"h"}')
    ).toBeNull();
    expect(
      parseFileMissingMessage('[FILE_MISSING]{"bookId":1.5,"path":"/a","hash":"h"}')
    ).toBeNull();
    expect(
      parseFileMissingMessage('[FILE_MISSING]{"bookId":0,"path":"/a","hash":"h"}')
    ).toBeNull();
    expect(
      parseFileMissingMessage('[FILE_MISSING]{"bookId":-3,"path":"/a","hash":"h"}')
    ).toBeNull();
    expect(parseFileMissingMessage('[FILE_MISSING]{"bookId":1,"hash":"h"}')).toBeNull();
    expect(parseFileMissingMessage('[FILE_MISSING]{"bookId":1,"path":"","hash":"h"}')).toBeNull();
    expect(
      parseFileMissingMessage('[FILE_MISSING]{"bookId":1,"path":123,"hash":"h"}')
    ).toBeNull();
  });
});