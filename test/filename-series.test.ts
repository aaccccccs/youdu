/**
 * 文件名系列信息提取测试（v29：Comic 元数据完整提取配套）
 *
 * 覆盖：
 * 1. 实测数据库模式（data/youdu.db custom_meta.original_filename 取证）：
 *    哆啦A梦[大长篇][台版]_01 大雄的恐龙.pdf / 21世纪小福星_01.pdf /
 *    SF短篇集_01.mobi / 藤子F不二雄大全集-哆啦A梦大长篇_01.pdf
 * 2. 通用模式库：_NN / -NN / 第N卷（阿拉伯+中文数字）/ vol/v / （N）括号 / 尾部裸数字
 * 3. 防误判：纯数字书名（1984）/ 年份形态（_2008）/ 章节号（第1500章）/
 *    空格分隔裸数字（Dev 2、Windows 11）/ 单行本无卷号
 * 4. 中文数字解析（一~九十九）
 */
import { describe, it, expect } from 'vitest';

import {
  extractSeriesFromFilename,
  parseChineseVolumeNumber,
  type ExtractedSeries
} from '../src/main/core/parsers/filename-series';

/** 断言辅助：提取结果等于期望的 { series, number } */
function expectSeries(fileName: string, series: string, number: number): void {
  const actual: ExtractedSeries | null = extractSeriesFromFilename(fileName);
  expect(actual, `文件名 "${fileName}" 应命中模式`).toEqual({ series, number });
}

/** 断言辅助：提取结果为 null（未命中/防误判） */
function expectNoSeries(fileName: string): void {
  const actual: ExtractedSeries | null = extractSeriesFromFilename(fileName);
  expect(actual, `文件名 "${fileName}" 不应命中模式`).toBeNull();
}

/* ==================== 实测数据库模式（重名书投诉场景） ==================== */

describe('extractSeriesFromFilename 实测库模式', () => {
  it('哆啦A梦大长篇：_NN 后跟空格副标题（54 本重名书的区分线索）', () => {
    expectSeries('哆啦A梦[大长篇][台版]_01 大雄的恐龙.pdf', '哆啦A梦[大长篇][台版]', 1);
    expectSeries('哆啦A梦[大长篇][台版]_05 大雄的魔界大冒险.pdf', '哆啦A梦[大长篇][台版]', 5);
  });

  it('哆啦A梦短篇全彩版：_NN 直接收尾', () => {
    expectSeries('哆啦A梦[短篇][全彩版][台版]_01.pdf', '哆啦A梦[短篇][全彩版][台版]', 1);
    expectSeries('哆啦A梦[短篇][全彩版][台版]_02.pdf', '哆啦A梦[短篇][全彩版][台版]', 2);
  });

  it('21世纪小福星：_NN 下划线卷号', () => {
    expectSeries('21世纪小福星_01.pdf', '21世纪小福星', 1);
    expectSeries('21世纪小福星_04.pdf', '21世纪小福星', 4);
  });

  it('SF短篇集 mobi：_NN', () => {
    expectSeries('SF短篇集_01.mobi', 'SF短篇集', 1);
    expectSeries('SF短篇集_05.mobi', 'SF短篇集', 5);
  });

  it('藤子F不二雄大全集：系列名内含连字符 + _NN 卷号（贪嘴匹配不拆错系列名）', () => {
    expectSeries('藤子F不二雄大全集-哆啦A梦大长篇_01.pdf', '藤子F不二雄大全集-哆啦A梦大长篇', 1);
    expectSeries('藤子F不二雄大全集-哆啦A梦大长篇_03.pdf', '藤子F不二雄大全集-哆啦A梦大长篇', 3);
  });

  it('SF短篇集 PDF：尾部" - 卷NN"形态', () => {
    expectSeries('SF短篇集 - 卷01.pdf', 'SF短篇集', 1);
    expectSeries('SF短篇集 - 卷11.pdf', 'SF短篇集', 11);
  });
});

/* ==================== 通用模式库 ==================== */

describe('extractSeriesFromFilename 通用模式', () => {
  it('分隔符数字：_NN / -NN / ·NN，含多卷号位数', () => {
    expectSeries('凡人修仙传_12.epub', '凡人修仙传', 12);
    expectSeries('凡人修仙传-12.epub', '凡人修仙传', 12);
    expectSeries('凡人修仙传·12.epub', '凡人修仙传', 12);
    expectSeries('斗罗大陆_123.txt', '斗罗大陆', 123);
  });

  it('中文卷号：第N卷/第N册（阿拉伯数字）', () => {
    expectSeries('凡人修仙传第12卷.pdf', '凡人修仙传', 12);
    expectSeries('凡人修仙传 第12卷.pdf', '凡人修仙传', 12);
    expectSeries('遮天第7册.epub', '遮天', 7);
  });

  it('中文卷号：中文数字（第一卷~第九十九卷）', () => {
    expectSeries('凡人修仙传 第一卷.pdf', '凡人修仙传', 1);
    expectSeries('凡人修仙传 第十二卷 精校版.epub', '凡人修仙传', 12);
    expectSeries('神游第二十卷.txt', '神游', 20);
  });

  it('卷/册 + 数字（无"第"）：卷NN 收尾', () => {
    expectSeries('大剑 卷03.cbz', '大剑', 3);
    expectSeries('大剑卷03.cbz', '大剑', 3);
  });

  it('英文卷号：vol / vol. / v（大小写不敏感）', () => {
    expectSeries('火影忍者 vol.03.cbr', '火影忍者', 3);
    expectSeries('火影忍者 vol03.cbr', '火影忍者', 3);
    expectSeries('海贼王 v05.zip', '海贼王', 5);
    expectSeries('海贼王 V5.zip', '海贼王', 5);
    expectSeries('One Piece Vol 12.cbz', 'One Piece', 12);
  });

  it('括号卷号：全角/半角，括号后可跟文字', () => {
    expectSeries('进击的巨人（4）.cbz', '进击的巨人', 4);
    expectSeries('进击的巨人(4).cbz', '进击的巨人', 4);
  });

  it('尾部紧贴裸数字：大长篇全集01 / 三体2', () => {
    expectSeries('大长篇全集01.pdf', '大长篇全集', 1);
    expectSeries('三体2.txt', '三体', 2);
    expectSeries('三体3.txt', '三体', 3);
  });

  it('兼容不含扩展名的输入', () => {
    expectSeries('21世纪小福星_01', '21世纪小福星', 1);
  });
});

/* ==================== 防误判 ==================== */

describe('extractSeriesFromFilename 防误判', () => {
  it('纯数字书名（1984）不拆系列', () => {
    expectNoSeries('1984.epub');
  });

  it('年份形态（4 位数字落在 1900-2099）不当卷号', () => {
    expectNoSeries('斗破苍穹_2008.txt');
    expectNoSeries('摄影集_2019.pdf');
  });

  it('数字后直接跟随文字（非空格分隔）不截断', () => {
    expectNoSeries('xxx_2022年完结版.txt');
  });

  it('章节号（第N章）不是卷号', () => {
    expectNoSeries('斗破苍穹 第1500章.txt');
  });

  it('空格分隔裸数字不识别（Dev 2 / Windows 11 均为名随数字形态）', () => {
    expectNoSeries('Dev 2.pdf');
    expectNoSeries('Windows 11.pdf');
  });

  it('单行本无卷号返回 null', () => {
    expectNoSeries('三体.txt');
    expectNoSeries('活着.epub');
    expectNoSeries('小说规则下载器 V4.1.0 【2023-06-09】.zip');
  });

  it('卷号打头（第一卷 甲卷）系列名在后不识别（罕见形态，宁缺勿错）', () => {
    expectNoSeries('第一卷 甲卷.txt');
  });

  it('空输入安全', () => {
    expectNoSeries('');
  });
});

/* ==================== 中文数字解析 ==================== */

describe('parseChineseVolumeNumber', () => {
  it('一~九', () => {
    expect(parseChineseVolumeNumber('一')).toBe(1);
    expect(parseChineseVolumeNumber('五')).toBe(5);
    expect(parseChineseVolumeNumber('九')).toBe(9);
    expect(parseChineseVolumeNumber('两')).toBe(2);
    expect(parseChineseVolumeNumber('零')).toBe(0);
  });

  it('十位组合', () => {
    expect(parseChineseVolumeNumber('十')).toBe(10);
    expect(parseChineseVolumeNumber('十二')).toBe(12);
    expect(parseChineseVolumeNumber('二十')).toBe(20);
    expect(parseChineseVolumeNumber('九十九')).toBe(99);
    expect(parseChineseVolumeNumber('三十五')).toBe(35);
  });

  it('超范围（百位组合）返回 null 不误判', () => {
    expect(parseChineseVolumeNumber('一百零三')).toBeNull();
    expect(parseChineseVolumeNumber('')).toBeNull();
  });
});