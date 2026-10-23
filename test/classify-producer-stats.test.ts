/**
 * 数据驱动分类单元测试（任务41：去硬编码 + 激活 k-NN）
 *
 * 覆盖两层学习：
 * 1. Producer 统计先验（classify-producer-stats.ts）：
 *    - normalizeProducer：版本归并（FreePic2Pdf 三种版本写法 / iTextSharp 商标符号 /
 *      Acrobat 中置版本号——均来自当前 DB 243 本实测形态）
 *    - computeProducerPriors：多数标签 / 置信度 / 最小样本保护 / 用户反馈加权 ×2
 *    - lookupProducerPrior：未采集 / 未传先验表 / 无历史 → undefined
 * 2. 决策树先验接线（classifyDocument 第二参数）：
 *    - 3a-1c dominant=comic → comic；3a-1e/3b-0a dominant=illustrated → scan；
 *      3b-0b 非 comic 先验拦黑白扫描书 / dominant=comic 保护黑白漫画
 *    - 先验缺失回退正则组兜底（冷启动行为与任务39 完全一致——301 测试不回退）
 *    - 新工具（不在任何正则组）积累先验后自动拦截——数据驱动的扩展能力
 * 3. k-NN 样本池激活（classify-feedback.ts）：
 *    - user 样本投票权重 ×3（auto ×1），source 缺省的旧样本按 user 计
 *
 * 环境说明：reclassifier → db/repositories 依赖 electron（safeStorage），
 * vitest node 环境无 Electron 运行时，mock 后即可加载（与 reclassifier.test.ts
 * 同款基建）。纯函数不触发被 mock 的 API。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import {
  computeProducerPriors,
  lookupProducerPrior,
  normalizeProducer,
  PRODUCER_PRIOR_CONFIDENCE,
  PRODUCER_PRIOR_MIN_SAMPLES,
  USER_FEEDBACK_WEIGHT,
  type ProducerStatRow
} from '../src/main/core/parsers/classify-producer-stats';
import { classifyDocument, type DocumentSignals } from '../src/main/core/parsers/document-classifier';
import { applyFeedback } from '../src/main/core/parsers/classify-feedback';
import { producerStatRowsFromTargets } from '../src/main/core/reclassifier';

/** 构造特征（默认值代表"无目录纯图"的图片型文档，与 classify.test.ts 同款） */
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

/** 便捷构造 n 行同 Producer 同标签的统计行 */
function rowsOf(n: number, producer: string, contentType: string, isUserFeedback = false): ProducerStatRow[] {
  return Array.from({ length: n }, () => ({ producer, contentType, isUserFeedback }));
}

/* ==================== 当前 DB 实测分布的先验快照（四本对照的测试化身） ==================== */

/** itextsharp：实测 55 comic + 1 illustrated → dominant=comic 98% */
const itextsharpPriors = computeProducerPriors([
  ...rowsOf(55, 'iTextSharp 5.1.3 (c) 1T3XT BVBA', 'comic'),
  ...rowsOf(19, 'iTextSharp™ 5.5.13.1 ©2000-2019 iText Group NV', 'comic'),
  { producer: 'iTextSharp 5.2.0 (c) 1T3XT BVBA', contentType: 'illustrated', isUserFeedback: false }
]);
/** afpl ghostscript：实测 39 illustrated → dominant=illustrated 100% */
const ghostscriptPriors = computeProducerPriors(rowsOf(39, 'AFPL Ghostscript 8.54', 'illustrated'));
/** adobe acrobat：实测 13 comic + 1 illustrated（归并 19.8/9.0/6.0 三版本）→ dominant=comic 93% */
const acrobatPriors = computeProducerPriors([
  ...rowsOf(12, 'Adobe Acrobat 19.8 Image Conversion Plug-in', 'comic'),
  { producer: 'Adobe Acrobat 9.0 Image Conversion Plug-in', contentType: 'comic', isUserFeedback: false },
  { producer: 'Adobe Acrobat 6.0', contentType: 'illustrated', isUserFeedback: false }
]);
/** annasarchive：实测 27 illustrated → dominant=illustrated 100% */
const annasarchivePriors = computeProducerPriors(rowsOf(27, 'AnnasArchive', 'illustrated'));
/** freepic2pdf：实测 13 comic + 22 illustrated（三版本写法归并）→ 混合工具无先验 */
const freepic2pdfPriors = computeProducerPriors([
  ...rowsOf(12, 'FreePic2Pdf_Lib - v4.02', 'comic'),
  ...rowsOf(8, 'FreePic2Pdf_Lib - v3.02', 'illustrated'),
  ...rowsOf(6, 'FreePic2Pdf - 1.26', 'illustrated'),
  ...rowsOf(6, 'FreePic2Pdf - 2.00', 'illustrated'),
  ...rowsOf(3, 'FreePic2Pdf_Lib - v2.19', 'illustrated')
]);

describe('normalizeProducer 版本归并（实测形态）', () => {
  it('FreePic2Pdf 三种版本写法 → freepic2pdf（_Lib 库变体 + 点分版本 + v前缀版本）', () => {
    expect(normalizeProducer('FreePic2Pdf - 1.26')).toBe('freepic2pdf');
    expect(normalizeProducer('FreePic2Pdf - 2.04')).toBe('freepic2pdf');
    expect(normalizeProducer('FreePic2Pdf_Lib - v2.19')).toBe('freepic2pdf');
    expect(normalizeProducer('FreePic2Pdf_Lib - v4.02')).toBe('freepic2pdf');
    // 版本后带 "modified using iText" 尾巴同样归并（截断在首个版本 token）
    expect(normalizeProducer('FreePic2Pdf - 2.05; modified using iText® 5.1.3 ©2000-2011 1T3XT BVBA')).toBe(
      'freepic2pdf'
    );
  });

  it('iTextSharp 商标/版权符号 + 多版本 → itextsharp', () => {
    expect(normalizeProducer('iTextSharp 5.1.3 (c) 1T3XT BVBA')).toBe('itextsharp');
    expect(normalizeProducer('iTextSharp™ 5.5.13.1 ©2000-2019 iText Group NV (AGPL-version)')).toBe('itextsharp');
    expect(normalizeProducer('iTextSharp 5.2.0 (c) 1T3XT BVBA')).toBe('itextsharp');
  });

  it('其余实测 Producer 形态归一', () => {
    expect(normalizeProducer('AFPL Ghostscript 8.54')).toBe('afpl ghostscript');
    expect(normalizeProducer('GPL Ghostscript 9.54')).toBe('gpl ghostscript');
    expect(normalizeProducer('zlib')).toBe('zlib');
    expect(normalizeProducer('zlib 1.2.11')).toBe('zlib');
    expect(normalizeProducer('AnnasArchive')).toBe('annasarchive');
    expect(normalizeProducer('PDFdo.com  5.5.6.0')).toBe('pdfdo.com'); // 双空格分隔
    // Acrobat 版本号夹在中间：截断到版本号 → 丢 Image Conversion 后缀（与纯 Acrobat 归并，
    // 样本量从 12 → 14，纯 Acrobat 的 1 本 illustrated 由置信度机制容忍）
    expect(normalizeProducer('Adobe Acrobat 19.8 Image Conversion Plug-in')).toBe('adobe acrobat');
    expect(normalizeProducer('Adobe Acrobat 9.0 Image Conversion Plug-in')).toBe('adobe acrobat');
    expect(normalizeProducer('Adobe Acrobat 6.0')).toBe('adobe acrobat');
    // "modified using iTextSharp" 的后处理形态：主体工具名在前，截断于首个版本 token
    expect(normalizeProducer('Adobe Acrobat Pro 9.0.0; modified using iTextSharp™ 5.5.9 ©2…')).toBe(
      'adobe acrobat pro'
    );
    expect(normalizeProducer('calibre (5.32.0) [https://calibre-ebook.com]')).toBe('calibre');
    expect(normalizeProducer('A-PDF Watermark 4.7.6')).toBe('a-pdf watermark');
    expect(normalizeProducer('A-PDF Watermark 4.1.0')).toBe('a-pdf watermark'); // 两版本归并
  });

  it('空串 / 纯空白 / 纯版本号 → 空串（不参与先验统计）', () => {
    expect(normalizeProducer('')).toBe('');
    expect(normalizeProducer('   ')).toBe('');
    expect(normalizeProducer('5.1.3')).toBe('');
    expect(normalizeProducer('v2.19')).toBe('');
  });
});

describe('computeProducerPriors 统计先验计算', () => {
  it('多数标签 + 置信度：iTextSharp 实测分布（55 comic + 1 illus）→ dominant=comic', () => {
    const prior = itextsharpPriors.get('itextsharp');
    expect(prior).toBeDefined();
    expect(prior!.total).toBe(75); // 55 + 19 + 1
    expect(prior!.comic).toBe(74);
    expect(prior!.dominant).toBe('comic');
    expect(prior!.confidence).toBeCloseTo(74 / 75, 4);
  });

  it('强扫描 Producer：Ghostscript 39/39 illustrated → dominant=illustrated', () => {
    const prior = ghostscriptPriors.get('afpl ghostscript');
    expect(prior!.dominant).toBe('illustrated');
    expect(prior!.confidence).toBe(1);
  });

  it('最小样本保护：加权样本量 < 5 → 不产生先验（zlib 实测仅 3 本）', () => {
    const priors = computeProducerPriors(rowsOf(4, 'zlib', 'illustrated'));
    const prior = priors.get('zlib');
    expect(prior!.total).toBe(4);
    expect(prior!.dominant).toBeNull(); // 不满足 PRODUCER_PRIOR_MIN_SAMPLES
  });

  it('低置信混合：FreePic2Pdf 实测分布（13 comic + 22 illus）→ dominant=null 不站队', () => {
    const prior = freepic2pdfPriors.get('freepic2pdf');
    expect(prior!.total).toBe(35);
    expect(prior!.comic).toBe(12);
    expect(prior!.illustrated).toBe(23);
    expect(prior!.dominant).toBeNull();
    expect(prior!.confidence).toBeCloseTo(23 / 35, 4); // 0.657 < 0.85
  });

  it('用户反馈加权 ×2：5 本 user comic + 1 本 auto illus → 产生 comic 先验；不加权则不达标', () => {
    // 加权：comic = 5×2 = 10，illustrated = 1 → total 11，confidence 10/11 ≈ 91% ≥ 85% ✓
    const weighted = computeProducerPriors([
      ...rowsOf(5, 'NewTool 1.0', 'comic', true),
      ...rowsOf(1, 'NewTool 1.0', 'illustrated')
    ]);
    const prior = weighted.get('newtool');
    expect(prior!.total).toBe(5 * USER_FEEDBACK_WEIGHT + 1);
    expect(prior!.comic).toBe(10);
    expect(prior!.dominant).toBe('comic');
    expect(prior!.confidence).toBeCloseTo(10 / 11, 4);
    // 不加权对照：同样 6 本全 auto → 5/6 ≈ 83% < 85% → 无先验
    const unweighted = computeProducerPriors([
      ...rowsOf(5, 'NewTool 1.0', 'comic'),
      ...rowsOf(1, 'NewTool 1.0', 'illustrated')
    ]);
    expect(unweighted.get('newtool')!.dominant).toBeNull();
  });

  it('无 Producer / 空 Producer / 损坏 contentType 行跳过', () => {
    const priors = computeProducerPriors([
      { producer: '', contentType: 'comic', isUserFeedback: false },
      { producer: '   ', contentType: 'comic', isUserFeedback: false },
      { producer: 'SomeTool', contentType: 'unknown-label', isUserFeedback: false }
    ]);
    // 空归一化 key 跳过；未知 contentType 忽略 → SomeTool total=0 不入表
    expect(priors.size).toBe(0);
  });

  it("scan 容错归 illustrated（feedback 样本 shape 四值直传安全）", () => {
    const priors = computeProducerPriors(rowsOf(6, 'XTool', 'scan'));
    const prior = priors.get('xtool');
    expect(prior!.illustrated).toBe(6);
    expect(prior!.dominant).toBe('illustrated');
  });

  it('先验参数常量导出（决策树与测试共用同一阈值）', () => {
    expect(PRODUCER_PRIOR_MIN_SAMPLES).toBe(5);
    expect(PRODUCER_PRIOR_CONFIDENCE).toBe(0.85);
    expect(USER_FEEDBACK_WEIGHT).toBe(2);
  });
});

describe('lookupProducerPrior 先验查询', () => {
  it('未采集 Producer / 未传先验表 / 该 Producer 无历史 → undefined', () => {
    expect(lookupProducerPrior(undefined, new Map())).toBeUndefined();
    expect(lookupProducerPrior('iTextSharp 5.1.3', undefined)).toBeUndefined();
    // freepic2pdf 混合无先验（dominant=null 但条目存在——由调用方判断 dominant）
    expect(lookupProducerPrior('FreePic2Pdf - 1.26', freepic2pdfPriors)).toBeDefined();
    expect(lookupProducerPrior('Ghostscript', itextsharpPriors)).toBeUndefined();
  });

  it('原始串归一化后命中（查询侧无需预先归一）', () => {
    const prior = lookupProducerPrior('iTextSharp™ 5.5.13.1 ©2000-2019 iText Group NV', itextsharpPriors);
    expect(prior!.dominant).toBe('comic');
  });
});

describe('classifyDocument Producer 先验接线（任务41 决策树）', () => {
  it('3a-1c：dominant=comic 高置信 → comic（822 藤子F形态，reason 标注先验来源）', () => {
    // 实测信号：p=364 od=364 d=1.00 img=1.30 sr=0.01 sm=0.00 gray=0.00
    // producer="Adobe Acrobat 19.8 Image Conversion Plug-in"
    const signals = sig({
      pageCount: 364,
      outlineCount: 364,
      imageCount: 474,
      imageDensity: 1.3,
      outlineSemanticRatio: 0,
      outlineSerialRatio: 0.01,
      producer: 'Adobe Acrobat 19.8 Image Conversion Plug-in',
      grayOrIndexImageRatio: 0
    });
    const r = classifyDocument(signals, acrobatPriors);
    expect(r.shape).toBe('comic');
    expect(r.contentType).toBe('comic');
    expect(r.isComic).toBe(true);
    expect(r.chapterMode).toBe('per-page');
    expect(r.reason).toContain('Producer先验');
    expect(r.reason).toContain('adobe acrobat');
    expect(r.reason).toContain('93%'); // 13/14 置信度
  });

  it('3a-1c 回退：不传先验 → 正则组兜底判 comic（冷启动行为不变，回归保护）', () => {
    const signals = sig({
      pageCount: 364,
      outlineCount: 364,
      imageCount: 474,
      imageDensity: 1.3,
      outlineSemanticRatio: 0,
      outlineSerialRatio: 0.01,
      producer: 'Adobe Acrobat 19.8 Image Conversion Plug-in',
      grayOrIndexImageRatio: 0
    });
    const r = classifyDocument(signals);
    expect(r.shape).toBe('comic');
    expect(r.reason).toContain('强漫画Producer'); // 正则兜底路径的 reason 文案
  });

  it('3a-1c 回退：传入先验表但该 Producer 无历史（新工具）→ 回退任务39 行为', () => {
    // BrandNewTool 不在 itextsharpPriors（归一化 brandnewtool 无历史）→ 先验缺失；
    // 也不在 COMIC_PRODUCER_RES 正则组 → 正则兜底不命中 → 落 3a-1b（sr=0.01 < 0.5）判 scan。
    // 与完全不传先验表的行为逐位一致（渐进增强：先验表传入不改变无历史 Producer 的判定）
    const signals = sig({
      pageCount: 364,
      outlineCount: 364,
      imageDensity: 1.3,
      outlineSemanticRatio: 0,
      outlineSerialRatio: 0.01,
      producer: 'BrandNewTool 2.0',
      grayOrIndexImageRatio: 0
    });
    const withPriors = classifyDocument(signals, itextsharpPriors);
    const withoutPriors = classifyDocument(signals);
    expect(withPriors.shape).toBe('scan'); // 3a-1b 拦截（页码式书签 → 疑超星扫描书）
    expect(withPriors.shape).toBe(withoutPriors.shape);
    expect(withPriors.reason).toBe(withoutPriors.reason);
  });

  it('3a-1c 先验否决正则：先验表说 dominant=illustrated 时，正则组不再兜底判 comic', () => {
    // Ghostscript 有 illustrated 先验时：即使 COMIC_PRODUCER_RES 命中（构造罕见场景），
    // 先验优先。实际库中 Ghostscript 不在漫画正则组——这里用 annasarchivePriors
    // 验证"先验存在即接管"的语义：dominant 非 comic → 不走漫画分支。
    // AnnasArchive 曾在漫画组（v1 循环论证误判）——数据驱动后此争议由先验裁决。
    const r = classifyDocument(
      sig({
        pageCount: 209,
        outlineCount: 0,
        imageCount: 205,
        imageDensity: 0.98,
        producer: 'AnnasArchive',
        grayOrIndexImageRatio: 0.95
      }),
      annasarchivePriors
    );
    expect(r.shape).toBe('scan');
    expect(r.reason).toContain('Producer先验');
    expect(r.reason).toContain('annasarchive');
  });

  it('3a-1e：dominant=illustrated + 高密度书签 + 序号式标题 → scan（先验优先）', () => {
    const r = classifyDocument(
      sig({
        pageCount: 200,
        outlineCount: 180,
        imageCount: 190,
        imageDensity: 0.95,
        outlineSemanticRatio: 0,
        outlineSerialRatio: 1,
        producer: 'AFPL Ghostscript 8.54'
      }),
      ghostscriptPriors
    );
    expect(r.shape).toBe('scan');
    expect(r.contentType).toBe('illustrated');
    expect(r.reason).toContain('Producer先验');
    expect(r.reason).toContain('afpl ghostscript');
  });

  it('3b-0a：dominant=illustrated + 无目录 + 无字页 → scan（AnnasArchive 彩色养生书 718/930 形态）', () => {
    const r = classifyDocument(
      sig({
        pageCount: 195,
        outlineCount: 0,
        imageCount: 190,
        imageDensity: 0.97,
        producer: 'AnnasArchive',
        grayOrIndexImageRatio: 0.1 // 彩色系——3b-0b 黑白条件不命中，靠 3b-0a 先验拦截
      }),
      annasarchivePriors
    );
    expect(r.shape).toBe('scan');
    expect(r.reason).toContain('Producer先验');
  });

  it('3b-0a 数据驱动扩展：新工具（不在任何正则组）积累 illustrated 先验后自动拦截', () => {
    // pdfFactory Pro 不在 SCAN_PRODUCER_RES 正则组——冷启动时无先验 → 落 3b 判 comic；
    // 积累 6 本 illustrated 历史后先验接管 → 3b-0a 拦截判 scan（无需改正则）
    const pdffactoryPriors = computeProducerPriors(rowsOf(6, 'pdfFactory Pro 3.52 (Windows XP)', 'illustrated'));
    const signals = sig({
      pageCount: 300,
      outlineCount: 0,
      imageDensity: 1.0,
      producer: 'pdfFactory Pro 3.52 (Windows XP Professional Chinese)'
    });
    // 冷启动（无先验）：正则组不含 pdfFactory → 落 3b 无目录全页图 → comic
    expect(classifyDocument(signals).shape).toBe('comic');
    // 先验接管：3b-0a 拦截 → scan
    const r = classifyDocument(signals, pdffactoryPriors);
    expect(r.shape).toBe('scan');
    expect(r.reason).toContain('Producer先验');
  });

  it('3b-0b：混合工具（FreePic2Pdf dominant=null）+ 无目录 + 黑白主导 → 回退正则仍拦（979 形态）', () => {
    // 实测 979 JavaScript框架形态：p=780 od=0 img=0.91 gray=0.99 producer="FreePic2Pdf - 1.26"
    // freepic2pdf 是 38 样本混合工具（dominant=null，不产生先验）→ 回退正则组兜底，
    // 而 FreePic2Pdf 本就在 SCAN_TOOL_PRODUCER_RES → 仍判 scan（基线行为不变）
    const r = classifyDocument(
      sig({
        pageCount: 780,
        outlineCount: 0,
        imageCount: 710,
        imageDensity: 0.91,
        producer: 'FreePic2Pdf - 1.26',
        grayOrIndexImageRatio: 0.99
      }),
      freepic2pdfPriors
    );
    expect(r.shape).toBe('scan');
    expect(r.contentType).toBe('illustrated');
    expect(r.reason).toContain('黑白扫描书');
    expect(r.reason).toContain('扫描工具Producer'); // 正则兜底路径文案（非先验）
  });

  it('3b-0b 回归防护 #974：小样本混合工具（dominant=null）不越权拦截——回退正则组', () => {
    // 实测 #974（pdfFactory Pro 仅 3 本历史 1 comic + 2 illus → dominant=null）
    // 曾被"非 comic 即拦"误判 scan（基线判 comic）。最小样本保护必须在所有
    // 分支一致生效：null=不产生先验=不干预，pdfFactory 不在 SCAN_TOOL 正则 → 不拦。
    const pdffactoryPriors = computeProducerPriors([
      { producer: 'pdfFactory Pro 4.75', contentType: 'comic', isUserFeedback: false },
      { producer: 'pdfFactory Pro 3.52', contentType: 'illustrated', isUserFeedback: false },
      { producer: 'pdfFactory Pro 2.10', contentType: 'illustrated', isUserFeedback: false }
    ]);
    const r = classifyDocument(
      sig({
        pageCount: 428,
        outlineCount: 0,
        imageCount: 2140,
        imageDensity: 5.0,
        producer: 'pdfFactory Pro 4.75 (Windows 7 Ultimate x86 Chinese)',
        grayOrIndexImageRatio: 1
      }),
      pdffactoryPriors
    );
    expect(r.shape).toBe('comic'); // 与基线（不传先验）一致
    expect(classifyDocument(sig({
      pageCount: 428,
      outlineCount: 0,
      imageCount: 2140,
      imageDensity: 5.0,
      producer: 'pdfFactory Pro 4.75 (Windows 7 Ultimate x86 Chinese)',
      grayOrIndexImageRatio: 1
    })).shape).toBe('comic');
  });

  it('3b-0b 黑白漫画保护：dominant=comic 先验（iTextSharp）+ 无目录 + 黑白主导 → comic 保持', () => {
    // 实测哆啦A梦大长篇台版形态：p=189 od=0 index 100% producer="iTextSharp 5.1.3"
    const r = classifyDocument(
      sig({
        pageCount: 189,
        outlineCount: 0,
        imageCount: 189,
        imageDensity: 1.0,
        producer: 'iTextSharp 5.1.3 (c) 1T3XT BVBA',
        grayOrIndexImageRatio: 1
      }),
      itextsharpPriors
    );
    expect(r.shape).toBe('comic');
    expect(r.isComic).toBe(true);
  });

  it('先验与正则组结论一致：iTextSharp 高密度黑白卷两条路径均判 comic', () => {
    // 强漫画组高密度黑白卷（826-832 藤子F大全集形态）：先验路径（先验拦截 3a-1c）
    // 与正则兜底路径（3a-1c 正则拦截）结论一致——渐进增强而非推翻
    const signals = sig({
      pageCount: 786,
      outlineCount: 786,
      imageCount: 786,
      imageDensity: 1.0,
      outlineSemanticRatio: 0,
      outlineSerialRatio: 1,
      producer: 'iTextSharp 5.1.3 (c) 1T3XT BVBA',
      grayOrIndexImageRatio: 1
    });
    expect(classifyDocument(signals).shape).toBe('comic'); // 正则路径
    expect(classifyDocument(signals, itextsharpPriors).shape).toBe('comic'); // 先验路径
  });

  it('第 1/2 级判定不受先验影响：文字层充足的书照走文本层分支', () => {
    const r = classifyDocument(
      sig({ textCharsPerPage: 634, imageCount: 3, imageDensity: 0.011, producer: 'AnnasArchive' }),
      annasarchivePriors
    );
    expect(r.shape).toBe('illustrated'); // 图文——先验只在第 3 级图片型分支参与
  });
});

describe('applyFeedback k-NN 样本池激活（user 权重 ×3）', () => {
  const base = classifyDocument(sig({})); // 无目录纯图 → comic

  it('user 样本权重 ×3：3 auto comic + 2 user text → text 以 66.7% 票数翻盘', () => {
    const samples = [
      ...Array.from({ length: 3 }, () => ({
        shape: 'comic' as const,
        signals: sig({}),
        source: 'auto-reclassify' as const
      })),
      ...Array.from({ length: 2 }, () => ({ shape: 'text' as const, signals: sig({}), source: 'user' as const }))
    ];
    // 权重：comic 3×1/(0+0.05)=60；text 2×3/(0+0.05)=120 → text 占 120/180 ≈ 66.7% ≥ 60%
    const r = applyFeedback(sig({}), base, samples);
    expect(r.adjusted).toBe(true);
    expect(r.result.shape).toBe('text');
    expect(r.result.contentType).toBe('text');
  });

  it('对照：同构全 auto 样本（3 comic + 2 text）→ comic 60% 维持决策树结果', () => {
    const samples = [
      ...Array.from({ length: 3 }, () => ({
        shape: 'comic' as const,
        signals: sig({}),
        source: 'auto-reclassify' as const
      })),
      ...Array.from({ length: 2 }, () => ({
        shape: 'text' as const,
        signals: sig({}),
        source: 'auto-reclassify' as const
      }))
    ];
    const r = applyFeedback(sig({}), base, samples);
    expect(r.adjusted).toBe(false);
    expect(r.result.shape).toBe('comic');
  });

  it('source 缺省的旧样本按 user 权重计（任务41 之前的手动修正样本）', () => {
    const samples = [
      ...Array.from({ length: 3 }, () => ({
        shape: 'comic' as const,
        signals: sig({}),
        source: 'auto-reclassify' as const
      })),
      ...Array.from({ length: 2 }, () => ({ shape: 'text' as const, signals: sig({}) })) // 无 source
    ];
    const r = applyFeedback(sig({}), base, samples);
    expect(r.adjusted).toBe(true);
    expect(r.result.shape).toBe('text');
  });

  it('全 user 样本一致 → 修正（与既有行为等价，权重同乘不影响占比）', () => {
    const samples = Array.from({ length: 5 }, () => ({
      shape: 'text' as const,
      signals: sig({}),
      source: 'user' as const
    }));
    const r = applyFeedback(sig({}), base, samples);
    expect(r.adjusted).toBe(true);
    expect(r.result.shape).toBe('text');
  });
});

describe('producerStatRowsFromTargets（重检前快照 → 先验数据源）', () => {
  it('解析 classify_signals.producer + feedback source 判定用户修正样本', () => {
    const rows = producerStatRowsFromTargets([
      {
        id: 1,
        title: 'a',
        content_type: 'comic',
        is_comic: 1,
        local_file_path: '/x.pdf',
        custom_meta: JSON.stringify({ classify_signals: { producer: 'iTextSharp 5.1.3' } }),
        feedback_signals: JSON.stringify({ source: 'user', pageCount: 100 })
      },
      {
        id: 2,
        title: 'b',
        content_type: 'illustrated',
        is_comic: 0,
        local_file_path: '/y.pdf',
        custom_meta: JSON.stringify({ classify_signals: { producer: 'Ghostscript 8.54' } }),
        feedback_signals: JSON.stringify({ source: 'auto-reclassify', pageCount: 200 })
      },
      {
        id: 3,
        title: 'c',
        content_type: 'comic',
        is_comic: 1,
        local_file_path: '/z.pdf',
        custom_meta: JSON.stringify({ classify_signals: { producer: 'PDFdo.com' } }),
        feedback_signals: null
      }
    ]);
    expect(rows).toEqual([
      { producer: 'iTextSharp 5.1.3', contentType: 'comic', isUserFeedback: true },
      { producer: 'Ghostscript 8.54', contentType: 'illustrated', isUserFeedback: false },
      { producer: 'PDFdo.com', contentType: 'comic', isUserFeedback: false }
    ]);
  });

  it('损坏 custom_meta / 无 producer / 无 custom_meta 的行跳过', () => {
    expect(
      producerStatRowsFromTargets([
        {
          id: 1,
          title: 'x',
          content_type: 'comic',
          is_comic: 1,
          local_file_path: '/x.pdf',
          custom_meta: '{broken json',
          feedback_signals: null
        },
        {
          id: 2,
          title: 'y',
          content_type: 'comic',
          is_comic: 1,
          local_file_path: '/y.pdf',
          custom_meta: JSON.stringify({ classify_signals: {} }),
          feedback_signals: null
        },
        {
          id: 3,
          title: 'z',
          content_type: 'text',
          is_comic: 0,
          local_file_path: null,
          custom_meta: null,
          feedback_signals: null
        }
      ])
    ).toEqual([]);
  });

  it('损坏 feedback signals 保守视为用户反馈（宁可加权不可漏权）', () => {
    const rows = producerStatRowsFromTargets([
      {
        id: 1,
        title: 'a',
        content_type: 'comic',
        is_comic: 1,
        local_file_path: '/x.pdf',
        custom_meta: JSON.stringify({ classify_signals: { producer: 'XTool' } }),
        feedback_signals: '{broken'
      }
    ]);
    expect(rows).toEqual([{ producer: 'XTool', contentType: 'comic', isUserFeedback: true }]);
  });
});