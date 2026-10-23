/**
 * 统一文档分类内核 + 用户反馈闭环单元测试（P1+P2+P3）
 *
 * 覆盖：
 *   - classifyDocument 决策树（文本层/逐页书签漫画/无目录纯图漫画/扫描版/图文）
 *   - extrapolateImageCount 大文件图计数外推
 *   - applyFeedback k-NN 干预边界（样本不足不干预 / 一致不干预 / 分歧不覆盖 / 远邻不参与）
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDocument,
  classifyOutlineTitleKind,
  computeOutlinePageStyleRatio,
  computeOutlineSemanticRatio,
  computeOutlineSerialRatio,
  extrapolateImageCount,
  isPageStyleOutlineTitle,
  matchAnyProducer,
  normalizeOutlineTitle,
  scanImageColorStats,
  COMIC_PRODUCER_RES,
  SCAN_PRODUCER_RES,
  SCAN_TOOL_PRODUCER_RES,
  GRAY_IMAGE_SCAN_RATIO,
  type DocumentSignals
} from '../src/main/core/parsers/document-classifier';
import { applyFeedback, signalVector, shapeToResult } from '../src/main/core/parsers/classify-feedback';

/** 构造特征（默认值代表"无目录纯图"的图片型文档） */
function sig(over: Partial<DocumentSignals> = {}): DocumentSignals {
  return {
    pageCount: 200,
    totalTextChars: 0,
    textCharsPerPage: 0,
    textStdDev: 0,
    textPageRatio: 0,
    imageCount: 190,
    imageDensity: 0.95,
    outlineCount: 0,
    hasMixedOrientation: false,
    pageRatioStdDev: 0,
    fileSizePerPageMB: 0.3,
    ccittRatio: 0,
    ...over
  };
}

describe('classifyDocument 决策树', () => {
  it('大量文字 + 3 张以上内容插图 → illustrated（图文）', () => {
    const r = classifyDocument(sig({ textCharsPerPage: 634, imageCount: 3, imageDensity: 0.011 }));
    expect(r.shape).toBe('illustrated');
    expect(r.contentType).toBe('illustrated');
    expect(r.isComic).toBe(false);
  });

  it('大量文字 + 无内容插图（≤2 张封面装饰）→ text', () => {
    const r = classifyDocument(sig({ textCharsPerPage: 500, imageCount: 2, imageDensity: 0.01 }));
    expect(r.shape).toBe('text');
    expect(r.contentType).toBe('text');
  });

  it('逐页书签（日漫 PDF 特征）→ comic', () => {
    // 哆啦A梦实测：670 页 / 670 书签
    const r = classifyDocument(sig({ pageCount: 670, outlineCount: 670, imageCount: 647, imageDensity: 0.97 }));
    expect(r.shape).toBe('comic');
    expect(r.isComic).toBe(true);
    expect(r.chapterMode).toBe('per-page');
  });

  it('无目录 + 无字页 + 每页全页图 → comic', () => {
    const r = classifyDocument(sig({ pageCount: 191, outlineCount: 0, imageDensity: 1.0 }));
    expect(r.shape).toBe('comic');
    expect(r.chapterMode).toBe('per-page');
  });

  it('少文字 + 有章节目录（扫描版技术书）→ scan（标签 illustrated）', () => {
    // 0day安全实测：780 页 / 13 书签（章节级目录）
    const r = classifyDocument(sig({ pageCount: 780, outlineCount: 13, imageCount: 2289, imageDensity: 2.94 }));
    expect(r.shape).toBe('scan');
    expect(r.contentType).toBe('illustrated');
    expect(r.isComic).toBe(false);
    expect(r.chapterMode).toBe('page-chunk');
  });

  it('少文字 + 几乎无图 → text 兜底', () => {
    const r = classifyDocument(sig({ textCharsPerPage: 10, imageCount: 1, imageDensity: 0.005 }));
    expect(r.shape).toBe('text');
  });

  it('判定理由包含关键数据（可审计）', () => {
    const r = classifyDocument(sig({ pageCount: 670, outlineCount: 670 }));
    expect(r.reason).toContain('670');
    expect(r.reason.length).toBeGreaterThan(5);
  });
});

describe('P2-4 逐页书签误判漫画复核（书签标题模式）', () => {
  it('逐页书签 + 页码式标题占比 100% → 仍判 comic（P2-5 高密度判据兜底，不依赖标题）', () => {
    const r = classifyDocument(
      sig({ pageCount: 670, outlineCount: 670, imageCount: 647, imageDensity: 0.97, outlinePageStyleRatio: 1 })
    );
    expect(r.shape).toBe('comic');
    expect(r.isComic).toBe(true);
    expect(r.chapterMode).toBe('per-page');
  });

  it('中密度逐页书签 + 真章节名标题 → 不判 comic，判 scan（扫描技术书保住真目录）', () => {
    // 中密度(0.7)逐页书签 + 混排多图(3.0) + 标题是真章节名（多层书签树）。
    // P2-5 后：高密度（≥0.8）由密度判据直接判漫画；此复核仅在"中密度 + 非整页图"时生效。
    const r = classifyDocument(
      sig({ pageCount: 100, outlineCount: 70, imageCount: 300, imageDensity: 3.0, outlinePageStyleRatio: 0.02 })
    );
    expect(r.shape).toBe('scan');
    expect(r.contentType).toBe('illustrated');
    expect(r.isComic).toBe(false);
    expect(r.chapterMode).toBe('outline');
  });

  it('中密度逐页书签 + 混合标题（页码式占 50%）→ 不判 comic（保守保目录）', () => {
    const r = classifyDocument(
      sig({ pageCount: 100, outlineCount: 70, imageCount: 300, imageDensity: 3.0, outlinePageStyleRatio: 0.5 })
    );
    expect(r.shape).toBe('scan');
    expect(r.isComic).toBe(false);
  });

  it('占比未采集（undefined）→ 维持原行为判 comic（向后兼容，如 EPUB/MOBI 无书签标题）', () => {
    const r = classifyDocument(sig({ pageCount: 670, outlineCount: 670 }));
    expect(r.shape).toBe('comic');
    expect(r.chapterMode).toBe('per-page');
  });

  it('边界：中密度+非整页图下，占比 0.81 > 0.8 → comic；0.79 → scan（3a-3 复核阈值）', () => {
    const hi = classifyDocument(
      sig({ pageCount: 100, outlineCount: 70, imageCount: 300, imageDensity: 3.0, outlinePageStyleRatio: 0.81 })
    );
    expect(hi.shape).toBe('comic');
    const lo = classifyDocument(
      sig({ pageCount: 100, outlineCount: 70, imageCount: 300, imageDensity: 3.0, outlinePageStyleRatio: 0.79 })
    );
    expect(lo.shape).toBe('scan');
  });

  it('低书签密度（< 0.5）→ 复核字段不参与判定（普通章节书仍走扫描版兜底）', () => {
    const r = classifyDocument(
      sig({ pageCount: 780, outlineCount: 13, imageCount: 2289, imageDensity: 2.94, outlinePageStyleRatio: 0 })
    );
    expect(r.shape).toBe('scan');
    expect(r.isComic).toBe(false);
  });

  it('复核否决时 reason 记录占比数据（可审计）', () => {
    const r = classifyDocument(
      sig({ pageCount: 100, outlineCount: 70, imageCount: 300, imageDensity: 3.0, outlinePageStyleRatio: 0.02 })
    );
    expect(r.reason).toContain('逐页书签');
    expect(r.reason).toContain('2%');
    expect(r.reason).toContain('扫描版');
  });
});

describe('P2-5 逐页书签密度优先判漫画（三层复核）', () => {
  it('哆啦A梦形态：670页/670书签(密度1.00)/每页整图/标题序号式(非页码) → comic', () => {
    // 真实 signals：书签标题为导出器序号式 "1_001"（outlinePageStyleRatio=0，非页码非章节名）
    const r = classifyDocument(
      sig({
        pageCount: 670,
        outlineCount: 670,
        imageCount: 670,
        imageDensity: 1.0,
        totalTextChars: 0,
        textCharsPerPage: 0,
        textPageRatio: 0,
        outlinePageStyleRatio: 0
      })
    );
    expect(r.shape).toBe('comic');
    expect(r.contentType).toBe('comic');
    expect(r.isComic).toBe(true);
    expect(r.chapterMode).toBe('per-page');
  });

  it('灌篮高手形态：117页/117书签(密度1.00)/每页整图 → comic', () => {
    const r = classifyDocument(
      sig({
        pageCount: 117,
        outlineCount: 117,
        imageCount: 117,
        imageDensity: 1.0,
        textCharsPerPage: 0,
        textPageRatio: 0,
        outlinePageStyleRatio: 0
      })
    );
    expect(r.shape).toBe('comic');
    expect(r.isComic).toBe(true);
    expect(r.chapterMode).toBe('per-page');
  });

  it('回归关键——0day 扫描技术书：780页/263书签(密度0.34)/2340图(3.0)/章节名 → illustrated', () => {
    // 密度 0.34 不进 3a（≤0.5），走兜底 scan（标签 illustrated），新判据不误伤扫描技术书
    const r = classifyDocument(
      sig({
        pageCount: 780,
        outlineCount: 263,
        imageCount: 2340,
        imageDensity: 3.0,
        textCharsPerPage: 5,
        textPageRatio: 0.8,
        outlinePageStyleRatio: 0.02
      })
    );
    expect(r.shape).toBe('scan');
    expect(r.contentType).toBe('illustrated');
    expect(r.isComic).toBe(false);
  });

  it('3a-2：中密度(0.6)+每页整图(0.9~1.9) → comic', () => {
    const r = classifyDocument(
      sig({ pageCount: 100, outlineCount: 60, imageCount: 120, imageDensity: 1.2, outlinePageStyleRatio: 0 })
    );
    expect(r.shape).toBe('comic');
    expect(r.isComic).toBe(true);
    expect(r.chapterMode).toBe('per-page');
  });

  it('3a-2 边界：图密度 0.9/1.9 命中；0.89/1.91 落到 3a-3', () => {
    const lo = classifyDocument(
      sig({ pageCount: 100, outlineCount: 60, imageCount: 90, imageDensity: 0.9, outlinePageStyleRatio: 0 })
    );
    expect(lo.shape).toBe('comic');
    const hi = classifyDocument(
      sig({ pageCount: 100, outlineCount: 60, imageCount: 190, imageDensity: 1.9, outlinePageStyleRatio: 0 })
    );
    expect(hi.shape).toBe('comic');
    const below = classifyDocument(
      sig({ pageCount: 100, outlineCount: 60, imageCount: 89, imageDensity: 0.89, outlinePageStyleRatio: 0 })
    );
    expect(below.shape).toBe('scan');
    const above = classifyDocument(
      sig({ pageCount: 100, outlineCount: 60, imageCount: 191, imageDensity: 1.91, outlinePageStyleRatio: 0 })
    );
    expect(above.shape).toBe('scan');
  });

  it('3a-3：中密度+非整页图(3.0)+章节名标题(ratio 0) → illustrated（保留原 P2-4 行为）', () => {
    const r = classifyDocument(
      sig({ pageCount: 100, outlineCount: 60, imageCount: 300, imageDensity: 3.0, outlinePageStyleRatio: 0 })
    );
    expect(r.shape).toBe('scan');
    expect(r.contentType).toBe('illustrated');
    expect(r.chapterMode).toBe('outline');
  });

  it('3a 尾部：中密度+非整页图+页码式标题(ratio 1.0) → comic', () => {
    const r = classifyDocument(
      sig({ pageCount: 100, outlineCount: 60, imageCount: 300, imageDensity: 3.0, outlinePageStyleRatio: 1.0 })
    );
    expect(r.shape).toBe('comic');
    expect(r.isComic).toBe(true);
  });

  it('3a-1 边界：书签密度恰好 0.8 → comic（含）；0.79 → 走 3a-2/3', () => {
    const at = classifyDocument(
      sig({ pageCount: 100, outlineCount: 80, imageCount: 300, imageDensity: 3.0, outlinePageStyleRatio: 0 })
    );
    expect(at.shape).toBe('comic'); // 80/100 = 0.80 ≥ 0.8 → 3a-1 直接判漫画
    const under = classifyDocument(
      sig({ pageCount: 100, outlineCount: 79, imageCount: 300, imageDensity: 3.0, outlinePageStyleRatio: 0 })
    );
    expect(under.shape).toBe('scan'); // 79/100 = 0.79 < 0.8 → 3a-3 当 ratio=0 否决
  });

  it('低密度/无书签不回归：outlineDensity ≤ 0.5 行为完全不变', () => {
    // 无目录纯图漫画（21世纪小福星形态）
    const noOutline = classifyDocument(sig({ pageCount: 191, outlineCount: 0, imageDensity: 1.0 }));
    expect(noOutline.shape).toBe('comic');
    expect(noOutline.chapterMode).toBe('per-page');
    // 低密度扫描书
    const scan = classifyDocument(sig({ pageCount: 780, outlineCount: 13, imageCount: 2289, imageDensity: 2.94 }));
    expect(scan.shape).toBe('scan');
    // 密度恰好 0.5（不 > 0.5）→ 不进 3a
    const half = classifyDocument(sig({ pageCount: 100, outlineCount: 50, imageCount: 300, imageDensity: 3.0 }));
    expect(half.shape).toBe('scan');
  });

  it('reason 记录密度数据（可审计）', () => {
    const r = classifyDocument(sig({ pageCount: 670, outlineCount: 670, imageCount: 670, imageDensity: 1.0 }));
    expect(r.reason).toContain('670');
    expect(r.reason).toContain('一章一页');
  });
});

describe('任务37 高密度书签标题语义三分法（3a-1 盲区修复）', () => {
  it('classifyOutlineTitleKind 三类标题判定（实测形态归纳）', () => {
    // page：纯页码式
    for (const t of ['670', '45', '第670页', '45页', '第 45 页', 'page 670', 'page45', '第670']) {
      expect(classifyOutlineTitleKind(t)).toBe('page');
    }
    // serial：导出器序号式（哆啦A梦/藤子F不二雄/灌篮高手 实测）
    for (const t of ['1_001', '1_002', 'Doraemon01_000', '_SDK08-_0000', 'p001', 'img_001', '第1话']) {
      expect(classifyOutlineTitleKind(t)).toBe('serial');
    }
    // semantic：真章节名（超星/SSReader 扫描技术书实测）
    for (const t of [
      '第一章 走出神墓',
      '1.1.1 bug与漏洞',
      '第1章 纵观Android生态圈',
      '1.1 简介',
      '附录A',
      '目录',
      '第1篇 基础知识\u0000'
    ]) {
      expect(classifyOutlineTitleKind(t)).toBe('semantic');
    }
  });

  it('分类边界：纯数字→page（非 serial）；含中文→semantic；空标题→semantic（保守）', () => {
    expect(classifyOutlineTitleKind('001')).toBe('page'); // 纯数字（含前导零）仍归 page
    expect(classifyOutlineTitleKind('1_001')).toBe('serial');
    expect(classifyOutlineTitleKind('第一章')).toBe('semantic');
    expect(classifyOutlineTitleKind('')).toBe('semantic');
  });

  it('normalizeOutlineTitle 剥离控制字符（SSReader 标题尾部 \\u0000）', () => {
    expect(normalizeOutlineTitle('1\u0000')).toBe('1');
    expect(normalizeOutlineTitle('第1篇 基础知识\u0000')).toBe('第1篇 基础知识');
    expect(classifyOutlineTitleKind('1\u0000')).toBe('page'); // 不剥离会误判为 serial
  });

  it('哆啦A梦形态：670页/670书签(密度1.00) + 序号式标题(serial 100%) → comic', () => {
    const r = classifyDocument(
      sig({
        pageCount: 670,
        outlineCount: 670,
        imageCount: 647,
        imageDensity: 0.97,
        outlineSemanticRatio: 0,
        outlineSerialRatio: 1
      })
    );
    expect(r.shape).toBe('comic');
    expect(r.contentType).toBe('comic');
    expect(r.isComic).toBe(true);
    expect(r.chapterMode).toBe('per-page');
  });

  it('灌篮高手形态：117页/117书签(密度1.00) + 序号式标题 → comic', () => {
    const r = classifyDocument(
      sig({
        pageCount: 117,
        outlineCount: 117,
        imageCount: 117,
        imageDensity: 1.0,
        outlineSemanticRatio: 0,
        outlineSerialRatio: 1
      })
    );
    expect(r.shape).toBe('comic');
    expect(r.isComic).toBe(true);
  });

  it('超星扫描技术书形态：密度0.95 + 语义式标题(100%) → illustrated（盲区修复）', () => {
    const r = classifyDocument(
      sig({
        pageCount: 410,
        outlineCount: 389,
        imageCount: 410,
        imageDensity: 1.0,
        outlineSemanticRatio: 1,
        outlineSerialRatio: 0
      })
    );
    expect(r.shape).toBe('scan');
    expect(r.contentType).toBe('illustrated');
    expect(r.isComic).toBe(false);
    expect(r.chapterMode).toBe('outline');
  });

  it('中密度超星扫描书（972 Android形态）：密度0.67 + 每页整图 + 语义式100% → illustrated', () => {
    // 6/18 扫描书密度落在 0.5~0.8（走 3a-2），语义复核同样须覆盖
    const r = classifyDocument(
      sig({
        pageCount: 410,
        outlineCount: 276,
        imageCount: 410,
        imageDensity: 1.0,
        outlineSemanticRatio: 1,
        outlineSerialRatio: 0
      })
    );
    expect(r.shape).toBe('scan');
    expect(r.contentType).toBe('illustrated');
    expect(r.isComic).toBe(false);
  });

  it('纯页码式超星扫描书（985 Web渗透形态）：密度0.96 + 语义式低 + 序号式0 → illustrated', () => {
    const r = classifyDocument(
      sig({
        pageCount: 275,
        outlineCount: 264,
        imageCount: 272,
        imageDensity: 0.99,
        outlineSemanticRatio: 0.01,
        outlineSerialRatio: 0
      })
    );
    expect(r.shape).toBe('scan');
    expect(r.contentType).toBe('illustrated');
    expect(r.isComic).toBe(false);
  });

  it('0day 形态：密度0.34（不进 3a）+ 语义式标题 → 兜底 illustrated（不变）', () => {
    const r = classifyDocument(
      sig({
        pageCount: 780,
        outlineCount: 263,
        imageCount: 2340,
        imageDensity: 3.0,
        outlineSemanticRatio: 1,
        outlineSerialRatio: 0
      })
    );
    expect(r.shape).toBe('scan');
    expect(r.contentType).toBe('illustrated');
    expect(r.isComic).toBe(false);
  });

  it('混排书签：serial 40% + semantic 60% → semantic(>0.5) → illustrated', () => {
    const r = classifyDocument(
      sig({
        pageCount: 100,
        outlineCount: 95,
        imageCount: 100,
        imageDensity: 1.0,
        outlineSemanticRatio: 0.6,
        outlineSerialRatio: 0.4
      })
    );
    expect(r.shape).toBe('scan');
    expect(r.contentType).toBe('illustrated');
    expect(r.isComic).toBe(false);
  });

  it('回归保护：占比未采集(undefined) → 回退密度判据判 comic（任务29 兼容）', () => {
    // 旧信号 / EPUB / MOBI 不采集标题占比 → 保持任务29 行为（密度≥0.8 → comic）
    const r = classifyDocument(sig({ pageCount: 670, outlineCount: 670, imageCount: 647, imageDensity: 0.97 }));
    expect(r.shape).toBe('comic');
    expect(r.isComic).toBe(true);
    expect(r.chapterMode).toBe('per-page');
  });

  it('reason 记录语义复核数据（可审计）', () => {
    const r = classifyDocument(
      sig({
        pageCount: 410,
        outlineCount: 389,
        imageCount: 410,
        imageDensity: 1.0,
        outlineSemanticRatio: 0.97,
        outlineSerialRatio: 0
      })
    );
    expect(r.reason).toContain('语义式');
    expect(r.reason).toContain('扫描版');
  });

  it('computeOutlineSemanticRatio / computeOutlineSerialRatio：空列表 → undefined', () => {
    expect(computeOutlineSemanticRatio([])).toBeUndefined();
    expect(computeOutlineSerialRatio([])).toBeUndefined();
  });

  it('computeOutlineSemanticRatio / computeOutlineSerialRatio：序号式与章节名统计', () => {
    const serialNodes = Array.from({ length: 100 }, (_, i) => ({ title: `1_${String(i + 1).padStart(3, '0')}` }));
    expect(computeOutlineSerialRatio(serialNodes)).toBe(1);
    expect(computeOutlineSemanticRatio(serialNodes)).toBe(0);

    const semNodes = Array.from({ length: 100 }, (_, i) => ({ title: `第${i + 1}章 走出神墓` }));
    expect(computeOutlineSemanticRatio(semNodes)).toBe(1);
    expect(computeOutlineSerialRatio(semNodes)).toBe(0);

    const mixed = [
      ...Array.from({ length: 40 }, () => ({ title: '1_001' })),
      ...Array.from({ length: 60 }, () => ({ title: '第1章 走出神墓' }))
    ];
    expect(computeOutlineSerialRatio(mixed)).toBeCloseTo(0.4, 5);
    expect(computeOutlineSemanticRatio(mixed)).toBeCloseTo(0.6, 5);
  });
});

describe('页码式书签标题判定（isPageStyleOutlineTitle / computeOutlinePageStyleRatio）', () => {
  it('页码式标题："45" / "第45页" / "45页" / "第 45 页" / "Page 45" / "page45" / "第45"', () => {
    for (const t of ['45', '第45页', '45页', '第 45 页', 'Page 45', 'page45', '第45']) {
      expect(isPageStyleOutlineTitle(t)).toBe(true);
    }
  });

  it('非页码式标题："第一章 走出神墓" / "1.1 简介" / "附录A" / "目录" / "第45页图"', () => {
    for (const t of ['第一章 走出神墓', '1.1 简介', '附录A', '目录', '第45页图']) {
      expect(isPageStyleOutlineTitle(t)).toBe(false);
    }
  });

  it('computeOutlinePageStyleRatio：空列表 → undefined（未采集，判定不干预）', () => {
    expect(computeOutlinePageStyleRatio([])).toBeUndefined();
  });

  it('computeOutlinePageStyleRatio：哆啦A梦式 670 个页码式书签 → 1', () => {
    const nodes = Array.from({ length: 670 }, (_, i) => ({ title: `第${i + 1}页`, depth: 0 }));
    expect(computeOutlinePageStyleRatio(nodes)).toBe(1);
  });

  it('computeOutlinePageStyleRatio：扫描书真章节名书签 → 0', () => {
    const nodes = Array.from({ length: 670 }, (_, i) => ({
      title: `第${Math.floor(i / 20) + 1}章 走出神墓`,
      depth: 1
    }));
    expect(computeOutlinePageStyleRatio(nodes)).toBe(0);
  });

  it('computeOutlinePageStyleRatio：混合 50% 页码式 + 50% 章节名 → 0.5', () => {
    const nodes = [
      ...Array.from({ length: 50 }, (_, i) => ({ title: `${i + 1}` })),
      ...Array.from({ length: 50 }, (_, i) => ({ title: `第${i + 1}章 走出神墓` }))
    ];
    expect(computeOutlinePageStyleRatio(nodes)).toBe(0.5);
  });
});

describe('extrapolateImageCount 大文件图计数外推', () => {
  it('全量扫描时返回原值', () => {
    expect(extrapolateImageCount(100, 50, 50, 200)).toBe(100);
  });

  it('部分扫描时按覆盖率外推', () => {
    // 20/167MB ≈ 12% 覆盖率，原计数 194 → 外推 ≈ 1617（上限 pageCount*5=3350 内）
    const n = extrapolateImageCount(194, 20 * 1048576, 167 * 1048576, 670);
    expect(n).toBeGreaterThan(1500);
    expect(n).toBeLessThanOrEqual(670 * 5);
  });

  it('外推不超过 pageCount*5 上限', () => {
    const n = extrapolateImageCount(10000, 1 * 1048576, 100 * 1048576, 10);
    expect(n).toBe(10 * 5);
  });
});

describe('任务39 多维特征决策树（Producer + 图片颜色模式）', () => {
  describe('matchAnyProducer 正则组匹配', () => {
    it('强漫画组：iTextSharp / PDFdo.com / Acrobat 图片转换（v2 移除 AnnasArchive——循环论证纠错，实为养生书组）', () => {
      expect(matchAnyProducer('iTextSharp 5.1.3 (c) 1T3XT BVBA', COMIC_PRODUCER_RES)).toBe(true);
      expect(matchAnyProducer('PDFdo.com', COMIC_PRODUCER_RES)).toBe(true);
      // v2：AnnasArchive 移入扫描工具组（27 本壮阳/补肾养生书实证）
      expect(matchAnyProducer('AnnasArchive', COMIC_PRODUCER_RES)).toBe(false);
      expect(matchAnyProducer('AnnasArchive', SCAN_TOOL_PRODUCER_RES)).toBe(true);
      expect(matchAnyProducer('Adobe Acrobat 19.8 Image Conversion Plug-in', COMIC_PRODUCER_RES)).toBe(true);
      expect(matchAnyProducer('Adobe Acrobat 9.0 Image Conversion Plug-in', COMIC_PRODUCER_RES)).toBe(true);
    });

    it('强漫画组不误命中：FreePic2Pdf / Ghostscript / 纯 Acrobat / undefined', () => {
      expect(matchAnyProducer('FreePic2Pdf_Lib - v4.02', COMIC_PRODUCER_RES)).toBe(false);
      expect(matchAnyProducer('AFPL Ghostscript 8.54', COMIC_PRODUCER_RES)).toBe(false);
      expect(matchAnyProducer('Adobe Acrobat 19.8', COMIC_PRODUCER_RES)).toBe(false); // 无 Image Conversion 后缀
      expect(matchAnyProducer(undefined, COMIC_PRODUCER_RES)).toBe(false);
      expect(matchAnyProducer('', COMIC_PRODUCER_RES)).toBe(false);
    });

    it('强扫描组与扫描工具组的差异：FreePic2Pdf 只在工具组命中', () => {
      expect(matchAnyProducer('FreePic2Pdf - 1.26', SCAN_PRODUCER_RES)).toBe(false); // 中性，不进强扫描组
      expect(matchAnyProducer('FreePic2Pdf - 1.26', SCAN_TOOL_PRODUCER_RES)).toBe(true); // 仅收窄条件参与
      expect(matchAnyProducer('FreePic2Pdf_Lib - v2.19', SCAN_TOOL_PRODUCER_RES)).toBe(true);
      expect(matchAnyProducer('AFPL Ghostscript 8.54', SCAN_PRODUCER_RES)).toBe(true);
      expect(matchAnyProducer('zlib 1.2.11', SCAN_PRODUCER_RES)).toBe(true);
    });
  });

  describe('3a-1c 强漫画 Producer（矫正 822）', () => {
    it('822 藤子F不二雄大全集形态：密度1.0 + 页码书签(sr低) + Acrobat图片转换 + 全彩 → comic（压过 3a-1b）', () => {
      // 实测信号：p=364 od=364 d=1.00 img=1.30 sr=0.01 sm=0.00 gray=0.00
      // producer="Adobe Acrobat 19.8 Image Conversion Plug-in"
      const r = classifyDocument(
        sig({
          pageCount: 364,
          outlineCount: 364,
          imageCount: 474,
          imageDensity: 1.3,
          outlineSemanticRatio: 0,
          outlineSerialRatio: 0.01,
          producer: 'Adobe Acrobat 19.8 Image Conversion Plug-in',
          grayOrIndexImageRatio: 0
        })
      );
      expect(r.shape).toBe('comic');
      expect(r.contentType).toBe('comic');
      expect(r.isComic).toBe(true);
      expect(r.chapterMode).toBe('per-page');
      expect(r.reason).toContain('强漫画Producer');
    });

    it('3a-1c 置于 3a-1b 之前：同形态无 Producer 时走 3a-1b 判 scan（回归对照）', () => {
      const r = classifyDocument(
        sig({
          pageCount: 364,
          outlineCount: 364,
          imageCount: 474,
          imageDensity: 1.3,
          outlineSemanticRatio: 0,
          outlineSerialRatio: 0.01
        })
      );
      expect(r.shape).toBe('scan');
    });

    it('强漫画组高密度黑白卷：iTextSharp + 密度1.0 + 黑白(不触发 3a-1d，3a-1c 先行) → comic', () => {
      // 回归保护：826-832 藤子F大全集黑白卷（Acrobat图片转换+高密度书签）等形态
      const r = classifyDocument(
        sig({
          pageCount: 786,
          outlineCount: 786,
          imageCount: 786,
          imageDensity: 1.0,
          outlineSemanticRatio: 0,
          outlineSerialRatio: 1,
          producer: 'iTextSharp 5.1.3 (c) 1T3XT BVBA',
          grayOrIndexImageRatio: 1
        })
      );
      expect(r.shape).toBe('comic');
      expect(r.isComic).toBe(true);
    });
  });

  describe('3a-1d 黑白图片主导（985 实证）', () => {
    it('985 Web渗透形态：密度0.96 + gray 100% + FreePic2Pdf → illustrated（黑白扫描书）', () => {
      // 实测信号：p=275 od=264 d=0.96 img=0.99 sr=0.00 sm=0.02 gray=1.00 producer="FreePic2Pdf - 2.04"
      const r = classifyDocument(
        sig({
          pageCount: 275,
          outlineCount: 264,
          imageCount: 272,
          imageDensity: 0.99,
          outlineSemanticRatio: 0.02,
          outlineSerialRatio: 0,
          producer: 'FreePic2Pdf - 2.04',
          grayOrIndexImageRatio: 1
        })
      );
      expect(r.shape).toBe('scan');
      expect(r.contentType).toBe('illustrated');
      expect(r.isComic).toBe(false);
      expect(r.reason).toContain('黑白');
    });

    it('边界：gray 恰好 0.5 不触发（> 严格比较）；0.51 触发', () => {
      const at = classifyDocument(
        sig({
          pageCount: 275,
          outlineCount: 264,
          imageDensity: 0.99,
          outlineSemanticRatio: 0,
          outlineSerialRatio: 1,
          grayOrIndexImageRatio: GRAY_IMAGE_SCAN_RATIO
        })
      );
      expect(at.shape).toBe('comic'); // 0.5 不 > 0.5 → 落 comic 兜底
      const above = classifyDocument(
        sig({
          pageCount: 275,
          outlineCount: 264,
          imageDensity: 0.99,
          outlineSemanticRatio: 0,
          outlineSerialRatio: 1,
          grayOrIndexImageRatio: 0.51
        })
      );
      expect(above.shape).toBe('scan');
    });

    it('989 PHP 彩色印刷技术书形态：Ghostscript + 无书签 → 3b-0a 拦截判 scan（v2 用户反馈纠错）', () => {
      const r = classifyDocument(
        sig({
          pageCount: 553,
          outlineCount: 0,
          imageCount: 525,
          imageDensity: 0.95,
          producer: 'AFPL Ghostscript 8.54',
          grayOrIndexImageRatio: 0.08
        })
      );
      // v2：强扫描 Producer + 无书签 + 无字页 → 不再放行 3b，彩色印刷技术书也拦截
      expect(r.shape).toBe('scan');
      expect(r.contentType).toBe('illustrated');
      expect(r.reason).toContain('强扫描Producer');
    });
    it('AnnasArchive 养生书形态：无书签 + 黑白主导 → 3b-0b 拦截判 scan（v2：26 本壮阳系列矫正）', () => {
      const r = classifyDocument(
        sig({
          pageCount: 209,
          outlineCount: 0,
          imageCount: 205,
          imageDensity: 0.98,
          producer: 'AnnasArchive',
          grayOrIndexImageRatio: 0.95
        })
      );
      expect(r.shape).toBe('scan');
      expect(r.contentType).toBe('illustrated');
      expect(r.reason).toContain('Producer');  // v3: AnnasArchive 升强扫描组，走 3b-0a（不限颜色）
    });
  });

  describe('3a-1e 强扫描 Producer（Ghostscript 组实证）', () => {
    it('Ghostscript + 高密度书签 + 序号式标题(sr=1，3a-1b 不拦) → illustrated', () => {
      // 无 3a-1e 时会落 comic 兜底误判；此分支保住 Ghostscript 扫描书
      const r = classifyDocument(
        sig({
          pageCount: 200,
          outlineCount: 180,
          imageCount: 190,
          imageDensity: 0.95,
          outlineSemanticRatio: 0,
          outlineSerialRatio: 1,
          producer: 'AFPL Ghostscript 8.54'
        })
      );
      expect(r.shape).toBe('scan');
      expect(r.contentType).toBe('illustrated');
      expect(r.reason).toContain('扫描书Producer');
    });

    it('zlib Producer 同样命中', () => {
      const r = classifyDocument(
        sig({
          pageCount: 200,
          outlineCount: 180,
          imageDensity: 0.95,
          outlineSemanticRatio: 0,
          outlineSerialRatio: 1,
          producer: 'zlib 1.2.11'
        })
      );
      expect(r.shape).toBe('scan');
    });
  });

  describe('3b-0 无目录黑白扫描书（矫正 979/992/995，实测走 3b 而非 3a-1）', () => {
    it('979 JavaScript框架形态：无书签 + 无字页 + FreePic2Pdf + index 99% → illustrated', () => {
      // 实测信号：p=780 od=0 img=0.91 gray=0.99 producer="FreePic2Pdf - 1.26"（index 99.9%）
      const r = classifyDocument(
        sig({
          pageCount: 780,
          outlineCount: 0,
          imageCount: 710,
          imageDensity: 0.91,
          producer: 'FreePic2Pdf - 1.26',
          grayOrIndexImageRatio: 0.99
        })
      );
      expect(r.shape).toBe('scan');
      expect(r.contentType).toBe('illustrated');
      expect(r.isComic).toBe(false);
      expect(r.chapterMode).toBe('page-chunk');
      expect(r.reason).toContain('黑白扫描书');
    });

    it('992 白帽子形态：FreePic2Pdf_Lib + gray 96% → illustrated', () => {
      const r = classifyDocument(
        sig({
          pageCount: 449,
          outlineCount: 0,
          imageCount: 592,
          imageDensity: 1.32,
          producer: 'FreePic2Pdf_Lib - v2.19',
          grayOrIndexImageRatio: 0.94
        })
      );
      expect(r.contentType).toBe('illustrated');
    });

    it('995 iOS逆向形态：FreePic2Pdf + gray 97% → illustrated', () => {
      const r = classifyDocument(
        sig({
          pageCount: 274,
          outlineCount: 0,
          imageCount: 266,
          imageDensity: 0.97,
          producer: 'FreePic2Pdf - 1.07',
          grayOrIndexImageRatio: 0.97
        })
      );
      expect(r.contentType).toBe('illustrated');
    });

    it('黑白漫画保护：无 Producer 的黑白漫画（哆啦A梦大长篇全集形态）→ comic 保持', () => {
      // 实测信号：p=623 od=0 img≈1.0 gray=0.90 producer=undefined
      // 黑白图片主导不能单独作判据——必须叠加扫描工具 Producer 收窄
      const r = classifyDocument(
        sig({
          pageCount: 623,
          outlineCount: 0,
          imageCount: 610,
          imageDensity: 0.98,
          grayOrIndexImageRatio: 0.9
        })
      );
      expect(r.shape).toBe('comic');
      expect(r.isComic).toBe(true);
    });

    it('黑白漫画保护：iTextSharp 黑白漫画（哆啦A梦大长篇台版形态）→ comic 保持', () => {
      // 实测信号：p=189 od=0 index 100% producer="iTextSharp 5.1.3"
      const r = classifyDocument(
        sig({
          pageCount: 189,
          outlineCount: 0,
          imageCount: 189,
          imageDensity: 1.0,
          producer: 'iTextSharp 5.1.3 (c) 1T3XT BVBA',
          grayOrIndexImageRatio: 1
        })
      );
      expect(r.shape).toBe('comic');
      expect(r.isComic).toBe(true);
    });

    it('黑白漫画保护：Acrobat图片转换黑白卷（od=0 形态）→ comic 保持', () => {
      // 实测 #833：od=0 + Acrobat图片转换 + gray 100%
      const r = classifyDocument(
        sig({
          pageCount: 720,
          outlineCount: 0,
          imageCount: 720,
          imageDensity: 1.0,
          producer: 'Adobe Acrobat 19.8 Image Conversion Plug-in',
          grayOrIndexImageRatio: 1
        })
      );
      expect(r.shape).toBe('comic');
    });

    it('奇天烈形态（实测无书签）：FreePic2Pdf + rgb 全彩 → comic（3b-0 颜色不命中）', () => {
      // 实测信号：p=95 od=0 img=1.00 gray=0.00 producer="FreePic2Pdf_Lib - v4.02"
      const r = classifyDocument(
        sig({
          pageCount: 95,
          outlineCount: 0,
          imageCount: 95,
          imageDensity: 1.0,
          producer: 'FreePic2Pdf_Lib - v4.02',
          grayOrIndexImageRatio: 0
        })
      );
      expect(r.shape).toBe('comic');
      expect(r.isComic).toBe(true);
      expect(r.chapterMode).toBe('per-page');
    });
  });

  describe('旧信号兼容（新字段全 undefined → 任务37 行为不变）', () => {
    it('高密度书签 + 序号式标题 → comic（密度判据回退）', () => {
      const r = classifyDocument(
        sig({ pageCount: 670, outlineCount: 670, imageCount: 647, imageDensity: 0.97, outlineSerialRatio: 1 })
      );
      expect(r.shape).toBe('comic');
    });

    it('高密度书签 + 纯页码式(sr<0.5) → scan（3a-1b 回退）', () => {
      const r = classifyDocument(
        sig({ pageCount: 275, outlineCount: 264, imageDensity: 0.99, outlineSemanticRatio: 0.01, outlineSerialRatio: 0 })
      );
      expect(r.shape).toBe('scan');
    });

    it('无目录 + 无字页 + 每页全页图 → comic（3b 回退，21世纪小福星形态）', () => {
      const r = classifyDocument(sig({ pageCount: 191, outlineCount: 0, imageDensity: 1.0 }));
      expect(r.shape).toBe('comic');
    });

    it('无目录 + 无字页 + 黑白主导但无 Producer → comic（黑白漫画不受影响）', () => {
      const r = classifyDocument(
        sig({ pageCount: 191, outlineCount: 0, imageDensity: 1.0, grayOrIndexImageRatio: 0.95 })
      );
      expect(r.shape).toBe('comic');
    });
  });

  describe('scanImageColorStats 二进制颜色扫描', () => {
    /** 构造合成 PDF 字节流：多张图片对象字典（/Subtype /Image + ColorSpace + Filter）。
     *  图片之间填充 700B stream 数据——真实 PDF 的图片 stream（jpeg/jbig2 编码数据）
     *  通常几十 KB，足以隔开相邻字典使 ±300B 窗口不互相污染。 */
    function makePdf(images: Array<{ colorspace: string; filter?: string }>): Buffer {
      const padding = 'x'.repeat(700);
      let objects = '';
      for (const img of images) {
        const filter = img.filter ? ` /Filter ${img.filter}` : '';
        objects += `<< /Type /XObject /Subtype /Image /Width 100 /Height 200 /ColorSpace ${img.colorspace} /BitsPerComponent 8${filter} /Length 700 >> stream\n${padding}\nendstream\n`;
      }
      return Buffer.from(`%PDF-1.7\n${objects}%%EOF\n`, 'latin1');
    }

    it('全灰度图片 → ratio=1，非 djvu', () => {
      const buf = makePdf([
        { colorspace: '/DeviceGray' },
        { colorspace: '/DeviceGray' },
        { colorspace: '/CalGray' }
      ]);
      const r = scanImageColorStats(buf);
      expect(r.imageObjects).toBe(3);
      expect(r.grayOrIndexImageRatio).toBe(1);
      expect(r.djvuEncoded).toBe(false);
    });

    it('索引色图片计入黑白：/Indexed', () => {
      const buf = makePdf([{ colorspace: '/Indexed' }]);
      const r = scanImageColorStats(buf);
      expect(r.grayOrIndexImageRatio).toBe(1);
    });

    it('彩色图片不计入黑白：/DeviceRGB /DeviceCMYK', () => {
      const buf = makePdf([
        { colorspace: '/DeviceRGB' },
        { colorspace: '/DeviceRGB' },
        { colorspace: '/DeviceCMYK' }
      ]);
      const r = scanImageColorStats(buf);
      expect(r.grayOrIndexImageRatio).toBe(0);
    });

    it('混合 2 gray + 2 rgb → ratio 0.5（979/992 场景的近邻形态）', () => {
      const buf = makePdf([
        { colorspace: '/DeviceGray' },
        { colorspace: '/Indexed' },
        { colorspace: '/DeviceRGB' },
        { colorspace: '/DeviceRGB' }
      ]);
      const r = scanImageColorStats(buf);
      expect(r.grayOrIndexImageRatio).toBe(0.5);
    });

    it('JPX/JBIG2 滤镜检出 djvuEncoded（0day DjVu 特征）', () => {
      const buf = makePdf([
        { colorspace: '/DeviceRGB', filter: '/JPXDecode' },
        { colorspace: '/DeviceGray', filter: '/JBIG2Decode' }
      ]);
      const r = scanImageColorStats(buf);
      expect(r.djvuEncoded).toBe(true);
    });

    it('ColorSpace 在 /Subtype /Image 之前也能命中（字典键顺序不定，窗口双向）', () => {
      const buf = Buffer.from(
        '%PDF-1.7\n<< /ColorSpace /DeviceGray /Type /XObject /Subtype /Image /Width 10 /Height 10 >>\n%%EOF\n',
        'latin1'
      );
      const r = scanImageColorStats(buf);
      expect(r.imageObjects).toBe(1);
      expect(r.grayOrIndexImageRatio).toBe(1);
    });

    it('无图片对象 → ratio undefined（不参与判定）', () => {
      const r = scanImageColorStats(Buffer.from('%PDF-1.7\n%%EOF\n', 'latin1'));
      expect(r.grayOrIndexImageRatio).toBeUndefined();
      expect(r.djvuEncoded).toBe(false);
      expect(r.imageObjects).toBe(0);
    });

    it('scanLimit 截断：仅统计前 N 字节内的图片对象', () => {
      const part1 = makePdf([{ colorspace: '/DeviceGray' }]);
      const part2 = makePdf([{ colorspace: '/DeviceRGB' }]);
      const buf = Buffer.concat([part1, part2]);
      const r = scanImageColorStats(buf, part1.length); // 只扫第一段
      expect(r.imageObjects).toBe(1);
      expect(r.grayOrIndexImageRatio).toBe(1);
    });
  });
});

describe('applyFeedback k-NN 用户反馈干预', () => {
  const base = classifyDocument(sig({}));

  it('样本不足 3 条 → 完全不干预', () => {
    const r = applyFeedback(sig({}), base, [{ shape: 'text', signals: sig({}) }]);
    expect(r.adjusted).toBe(false);
    expect(r.result.shape).toBe(base.shape);
  });

  it('近邻一致且与决策树不同 → 修正', () => {
    const samples = Array.from({ length: 5 }, () => ({ shape: 'text' as const, signals: sig({}) }));
    const r = applyFeedback(sig({}), base, samples);
    expect(base.shape).toBe('comic');
    expect(r.adjusted).toBe(true);
    expect(r.result.shape).toBe('text');
    expect(r.result.contentType).toBe('text');
  });

  it('近邻与决策树一致 → 不干预', () => {
    const samples = Array.from({ length: 5 }, () => ({ shape: 'comic' as const, signals: sig({}) }));
    const r = applyFeedback(sig({}), base, samples);
    expect(r.adjusted).toBe(false);
  });

  it('近邻投票分歧（占比不足 60%）→ 不覆盖', () => {
    const samples = [
      ...Array.from({ length: 3 }, () => ({ shape: 'comic' as const, signals: sig({}) })),
      ...Array.from({ length: 2 }, () => ({ shape: 'text' as const, signals: sig({}) }))
    ];
    const r = applyFeedback(sig({}), base, samples);
    // 3 comic(距离0) vs 2 text(距离0)：权重 3:2 → comic 占比 60%，与 base 一致 → 不调整
    expect(r.adjusted).toBe(false);
  });

  it('距离过远的样本不参与投票', () => {
    const far = Array.from({ length: 5 }, () => ({
      shape: 'text' as const,
      signals: sig({ textCharsPerPage: 800, imageCount: 0, imageDensity: 0, outlineCount: 100 })
    }));
    const r = applyFeedback(sig({}), base, far);
    expect(r.adjusted).toBe(false);
    expect(r.detail).toContain('无足够近邻');
  });

  it('shapeToResult 形态 → 标签/分章映射正确', () => {
    expect(shapeToResult('comic', '').contentType).toBe('comic');
    expect(shapeToResult('comic', '').chapterMode).toBe('per-page');
    expect(shapeToResult('scan', '').contentType).toBe('illustrated');
    expect(shapeToResult('text', '').contentType).toBe('text');
  });

  it('signalVector 输出固定 9 维且归一化到合理范围', () => {
    const v = signalVector(sig({ pageCount: 670, outlineCount: 670, imageCount: 647 }));
    expect(v).toHaveLength(9);
    expect(v.every((x) => x >= 0 && x <= 2.0001)).toBe(true);
  });
});
