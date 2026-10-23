#!/usr/bin/env node
/**
 * 存量书分类矫正脚本（任务31/37/39）
 *
 * 背景
 * ----
 * 任务29 修复了统一分类决策树（document-classifier.ts 的 3a 分支加"书签密度判据"），
 * 但决策树只在"导入/重新解析"时执行——**已导入的存量书不会自动重判**。实测有一批
 * 整页图漫画（书签标题为导出器序号式，如 "1_001"/"_SDK08-_0000"）被旧的 P2-4
 * "书签标题模式"复核误判成 illustrated（扫描版），需要一次性矫正（任务31/37）。
 * 任务39 升级为多维特征决策树（Producer + 图片颜色模式），矫正目标：
 *   - 822 藤子F不二雄大全集：illustrated → comic（Acrobat图片转换 Producer + 密度1.0）
 *   - 979 JavaScript框架高级编程 / 992 白帽子讲Web安全 / 995 iOS应用逆向：
 *     comic → illustrated（FreePic2Pdf Producer + 无书签 + 黑白图片主导 94-99%）
 *
 * 本脚本做什么
 * ------------
 * 1. 遍历 DB 中指定范围的书，逐本用 **pdfjs-dist** 从原文件重新采集真实信号
 *    （页数 / 书签总数与密度 / 书签标题模式 / 每页文字量 / 图片数 / Producer /
 *    图片颜色模式占比），并复用与导入时**完全一致**的决策树判据重新分类。
 * 2. 默认 **dry-run**：只输出"当前分类 → 新分类 + 判定理由 + 多维特征"，绝不写 DB。
 * 3. `--apply` 时在事务中更新 books 的 content_type / is_comic。
 *
 * 为什么不走 migration
 * --------------------
 * 判定需要读取 PDF 原文件结构（pdfjs 解析书签/文本/元数据），DB 迁移层无法调用
 * 异步解析器，故实现为可手动执行的维护脚本。
 *
 * ⚠️ 重要：--apply 只改"分类标签"，不重建 chapters 章节索引！
 *    books.content_type='comic' 会让阅读器进入"漫画模式"（每页一章、url 存页码），
 *    而原 illustrated 书的章节是 page-chunk（多页一章）。因此改完标签后，
 *    **必须对变更的书执行"重新解析"**（应用内书籍详情 → 重新检测漫画 / 主进程
 *    importer.reparseBook），才会重建出正确的漫画章节结构。
 *    推荐做法见脚本末尾 usage()。
 *
 * 与导入逻辑的一致性
 * ------------------
 * 判据内联自 src/main/core/parsers/document-classifier.ts（任务39 决策树），
 * 信号采集复刻 src/main/core/parsers/pdf-parser.ts 的 parsePdf：
 *   - pageCount / outline / Producer：pdfjs-dist（与 pdf-parse 同源，getMetadata）
 *   - imageCount：二进制扫描 /Subtype /Image 后按覆盖率外推（extrapolateImageCount）
 *   - grayOrIndexImageRatio / djvuEncoded：/Subtype /Image 窗口法查 ColorSpace/Filter
 *     （复刻 document-classifier.scanImageColorStats）
 *   - textCharsPerPage / textPageRatio / textStdDev：pdfjs 逐页 getTextContent
 *   - pageRatioStdDev / hasMixedOrientation：扫描前 2MB 的 /MediaBox
 *   - ccittRatio：/CCITTFaxDecode 占比
 * 这样 dry-run 结果 = "该文件若重新导入会被分成的类型"，才能正确指导矫正。
 *
 * 用法
 * ----
 *   node scripts/reclassify-books.mjs                       # dry-run，扫描 illustrated
 *   node scripts/reclassify-books.mjs --apply               # 执行标签更新（事务）
 *   node scripts/reclassify-books.mjs --id 822              # 只判一本书
 *   node scripts/reclassify-books.mjs --scope all           # 扫描全部 pdf 书
 *   node scripts/reclassify-books.mjs --cross-check         # 额外用 pdfimages -list 交叉验证
 *   node scripts/reclassify-books.mjs --scope comic         # 扫描 comic（任务39 矫正 979/992/995）
 *   node scripts/reclassify-books.mjs --db /tmp/copy.db --apply   # 指定 DB（测试用）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

/* ==========================================================================
 * 一、决策树常量（同步自 src/main/core/parsers/document-classifier.ts，任务29）
 * ========================================================================== */

/** 每页字符数 ≥ 此值视为"有实质文字层"（电子书正文） */
const TEXT_LAYER_MIN_CHARS_PER_PAGE = 100;
/** 有文字层时，内容插图数量 ≥ 此值视为图文书（封面/装饰不算） */
const ILLUSTRATED_MIN_IMAGE_COUNT = 3;
/** 图密度 < 此值视为"基本无图"（兜底） */
const IMAGE_MIN_DENSITY = 0.05;
/** 书签数 / 页数 > 此值视为"逐页书签" */
const OUTLINE_DENSITY_PER_PAGE = 0.5;
/** 逐页书签复核：页码式标题占比 ≤ 此值 → 扫描版（标题多为真章节名） */
const OUTLINE_PAGE_STYLE_MIN_RATIO = 0.8;
/** 任务37：高密度书签语义复核——语义式（真章节名）标题占比 > 此值 → 扫描版技术书 */
const OUTLINE_SEMANTIC_MAX_RATIO = 0.5;
/** 任务37：高密度书签序号式复核——序号式占比 < 此值（非序号式主导，如纯页码式）→ 扫描版 */
const OUTLINE_SERIAL_MIN_RATIO = 0.5;
/** 高密度书签强判据：一章一页 = 整页图漫画（不看标题，兼容序号式标题） */
const DENSITY_COMIC_STRONG = 0.8;
/** 中密度书签 + 每页恰好一整图（图密度区间）→ 整页图漫画 */
const FULL_PAGE_COMIC_MIN_DENSITY = 0.9;
const FULL_PAGE_COMIC_MAX_DENSITY = 1.9;

/* ==================== 任务39：多维特征常量（同步 document-classifier.ts） ==================== */

/** 强漫画 Producer 组：iTextSharp 55/55、PDFdo 30/30、Acrobat图片转换 12/13（v2 移除 AnnasArchive：循环论证纠错，实为养生书组） */
const COMIC_PRODUCER_RES = [/Acrobat[^]*Image Conversion/i, /iTextSharp/i, /PDFdo\.com/i];
/** 强扫描书 Producer 组（3a-1e）：Ghostscript 38/39、zlib 3/3（不含中性的 FreePic2Pdf） */
const SCAN_PRODUCER_RES = [/Ghostscript/i, /^zlib/i, /AnnasArchive/i];
/** 扫描工具 Producer 组（3b-0）：多 FreePic2Pdf，仅在"无书签+无字页+黑白主导"收窄条件参与 */
const SCAN_TOOL_PRODUCER_RES = [/Ghostscript/i, /^zlib/i, /FreePic2Pdf/i, /AnnasArchive/i];
/** 黑白图片占比阈值（gray/index > 此值 → 黑白扫描书；实测 979=0.99/992=0.94/995=0.97，
 *  彩色印刷技术书 986=0.00/989=0.08 不命中，全彩漫画 0.00 不命中） */
const GRAY_IMAGE_SCAN_RATIO = 0.5;

/** 判断 Producer 是否命中正则组（未采集 → false 不干预） */
function matchAnyProducer(producer, res) {
  return typeof producer === 'string' && res.some((re) => re.test(producer));
}

/* ==================== 任务41：Producer 统计先验（同步 classify-producer-stats.ts） ==================== */

/** 先验参数：最小加权样本量 / 多数标签最低占比 / 用户反馈样本权重 */
const PRODUCER_PRIOR_MIN_SAMPLES = 5;
const PRODUCER_PRIOR_CONFIDENCE = 0.85;
const USER_FEEDBACK_WEIGHT = 2;

/**
 * 归一化 Producer（版本归并，先验统计 key）
 * 规则：小写 + 商标符号→空格 + 截断到首个版本式 token + 工具库尾缀归并。
 * 实测："FreePic2Pdf - 1.26"/"FreePic2Pdf_Lib - v2.19" → "freepic2pdf"、
 * "iTextSharp™ 5.5.13.1 ©…" → "itextsharp"、"Adobe Acrobat 19.8 Image…" → "adobe acrobat"。
 */
function normalizeProducer(raw) {
  const lowered = String(raw).toLowerCase().replace(/[^\x20-\x7e]+/g, ' ');
  const tokens = lowered.split(/\s+/).filter(Boolean);
  let cut = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-') {
      cut = i;
      break;
    }
    const core = token.replace(/[^a-z0-9.]/g, '');
    if (core.length > 0 && /^v?\d[\d.]*$/.test(core)) {
      cut = i;
      break;
    }
  }
  const kept = (cut === -1 ? tokens : tokens.slice(0, cut)).join(' ');
  return kept.replace(/[\s_-]+lib$/, '').trim();
}

/**
 * 从书库统计行计算 Producer 先验（数据驱动，替代硬编码正则组）
 * 数据源行：{ producer, contentType, isUserFeedback }（isUserFeedback 权重 ×2）
 * 返回 Map<归一化Producer, {producer,total,comic,illustrated,text,dominant,confidence}>；
 * dominant=null 表示不产生先验（样本不足/混合工具），决策树回退正则兜底。
 */
function computeProducerPriors(rows) {
  const acc = new Map();
  for (const row of rows) {
    const key = normalizeProducer(row.producer);
    if (!key) continue;
    const weight = row.isUserFeedback ? USER_FEEDBACK_WEIGHT : 1;
    const entry = acc.get(key) || { comic: 0, illustrated: 0, text: 0 };
    if (row.contentType === 'comic') entry.comic += weight;
    else if (row.contentType === 'illustrated' || row.contentType === 'scan') entry.illustrated += weight;
    else if (row.contentType === 'text') entry.text += weight;
    acc.set(key, entry);
  }
  const priors = new Map();
  for (const [key, counts] of acc) {
    const total = counts.comic + counts.illustrated + counts.text;
    if (total <= 0) continue;
    let dominant = 'comic';
    let dominantCount = counts.comic;
    if (counts.illustrated > dominantCount) {
      dominant = 'illustrated';
      dominantCount = counts.illustrated;
    }
    if (counts.text > dominantCount) {
      dominant = 'text';
      dominantCount = counts.text;
    }
    const confidence = dominantCount / total;
    if (total < PRODUCER_PRIOR_MIN_SAMPLES || confidence < PRODUCER_PRIOR_CONFIDENCE) {
      dominant = null;
    }
    priors.set(key, { producer: key, total, ...counts, dominant, confidence });
  }
  return priors;
}

/** 查询某书 Producer 先验（缺失 → undefined，调用方回退正则组） */
function lookupProducerPrior(producer, priors) {
  if (!priors || typeof producer !== 'string') return undefined;
  const key = normalizeProducer(producer);
  if (!key) return undefined;
  return priors.get(key);
}

/**
 * Producer 先验裁决（三态，同步 document-classifier.priorVerdict）：
 * - true：先验存在且 dominant=expectLabel（置信度达标）→ 先验裁决命中
 * - false：先验存在但 dominant 指向其他 → 先验裁决否决（数据优先于正则）
 * - undefined：无先验（缺失 / dominant=null 小样本混合 / 置信度不达标）→ 回退正则兜底
 *   （"不产生先验=不干预"：#974 小样本越权拦截回归防护）
 */
function priorVerdict(prior, expectLabel) {
  if (!prior || prior.dominant === null || prior.confidence < PRODUCER_PRIOR_CONFIDENCE) {
    return undefined;
  }
  return prior.dominant === expectLabel;
}

/**
 * 全库加载 Producer 统计行（books.custom_meta.classify_signals.producer ×
 * books.content_type，LEFT JOIN classification_feedback 判定用户修正样本）。
 * 独立于 --scope（先验=书库全量历史，非本次待判定范围）。
 */
function loadProducerStatRows(db) {
  const rows = db
    .prepare(
      `SELECT b.custom_meta AS custom_meta, b.content_type AS content_type, f.signals AS feedback_signals
       FROM books b
       LEFT JOIN classification_feedback f ON f.book_id = b.id
       WHERE b.file_type = 'pdf'
          OR (b.local_file_path IS NOT NULL AND lower(b.local_file_path) LIKE '%.pdf')`
    )
    .all();
  const out = [];
  for (const row of rows) {
    let producer;
    try {
      producer = JSON.parse(row.custom_meta || '{}').classify_signals?.producer;
    } catch {
      continue;
    }
    if (typeof producer !== 'string' || producer.length === 0) continue;
    let isUserFeedback = false;
    if (row.feedback_signals) {
      try {
        const source = JSON.parse(row.feedback_signals).source;
        isUserFeedback = source === undefined || source === 'user';
      } catch {
        isUserFeedback = true;
      }
    }
    out.push({ producer, contentType: row.content_type || '', isUserFeedback });
  }
  return out;
}

/** 页码式书签标题：纯数字 / "第N页" / "N页" / "第N" / "page N" */
const PAGE_STYLE_TITLE_RE = /^(?:第?\s*\d+\s*页?|page\s*\d+|\d+)$/i;

/**
 * 书签标题规范化：剥离控制字符（部分导出器如 SSReader 会在标题尾部附 \u0000）
 * 并折叠空白，避免"1\u0000"这类纯页码标题被误判为序号式。
 */
function normalizeTitle(title) {
  let out = '';
  for (const ch of String(title)) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) continue; // 跳过控制字符
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function isPageStyleOutlineTitle(title) {
  return PAGE_STYLE_TITLE_RE.test(normalizeTitle(title));
}

/**
 * 计算书签标题为页码式命名的占比（复刻 computeOutlinePageStyleRatio）
 * @param {Array<{title: string}>} nodes 扁平书签节点
 * @returns {number|undefined} 占比 0-1；空列表返回 undefined（不干预判定）
 */
function computeOutlinePageStyleRatio(nodes) {
  if (nodes.length === 0) return undefined;
  let hits = 0;
  for (const node of nodes) {
    if (isPageStyleOutlineTitle(node.title)) hits++;
  }
  return hits / nodes.length;
}

/* ==================== 书签标题语义三分法（同步 document-classifier.ts 任务37） ==================== */

/** 导出器序号式：含数字且非纯数字，字符集仅 A-Za-z0-9_.-（实测 "1_001"/"Doraemon01_000"/"_SDK08-_0000"） */
const SERIAL_TITLE_RE = /^(?=.*\d)(?!\d+$)[A-Za-z0-9_.-]{1,40}$/;
/** 漫画话数编号："第1话"/"第3回"/"第2集"（区别于"第1章/篇/节"的真章节名，判 serial） */
const SERIAL_EPISODE_RE = /^第\s*\d+\s*[话回集]$/;

/**
 * 三分法判定单个书签标题形态（与 document-classifier.classifyOutlineTitleKind 一致）
 * @returns {'page'|'serial'|'semantic'}
 */
function classifyOutlineTitleKind(title) {
  const t = normalizeTitle(title);
  if (!t) return 'semantic'; // 空标题保守归语义式
  if (PAGE_STYLE_TITLE_RE.test(t)) return 'page';
  if (SERIAL_EPISODE_RE.test(t)) return 'serial';
  if (SERIAL_TITLE_RE.test(t)) return 'serial';
  return 'semantic';
}

/** 统计三类标题占比，返回 { page, serial, semantic }（空列表 → 各项 undefined） */
function computeOutlineKindRatios(nodes) {
  if (nodes.length === 0) return { page: undefined, serial: undefined, semantic: undefined };
  let page = 0;
  let serial = 0;
  let semantic = 0;
  for (const n of nodes) {
    const k = classifyOutlineTitleKind(n.title);
    if (k === 'page') page++;
    else if (k === 'serial') serial++;
    else semantic++;
  }
  const total = nodes.length;
  return { page: page / total, serial: serial / total, semantic: semantic / total };
}

/** 图片数按二进制扫描覆盖率外推（复刻 document-classifier.extrapolateImageCount） */
function extrapolateImageCount(rawCount, scannedBytes, totalBytes, pageCount) {
  if (totalBytes <= 0 || scannedBytes <= 0) return rawCount;
  const coverage = Math.min(1, scannedBytes / totalBytes);
  if (coverage >= 0.99) return rawCount;
  const extrapolated = Math.round(rawCount / coverage);
  return Math.min(extrapolated, Math.max(pageCount, 1) * 5);
}

/**
 * @param {object} s DocumentSignals
 * @param {Map|null} [producerPriors] Producer 统计先验（任务41：数据驱动优先，
 *   缺失时回退正则组兜底——冷启动行为与任务39 一致）
 * @returns {{shape:string, contentType:'text'|'illustrated'|'comic', isComic:boolean, chapterMode:string, reason:string}}
 */
function classifyDocument(s, producerPriors) {
  const p = Math.max(s.pageCount, 1);
  const outlineDensity = s.outlineCount / p;
  const fmt = (n, d = 2) => n.toFixed(d);
  const producerPrior = lookupProducerPrior(s.producer, producerPriors);

  // 第 1 级：文本层
  if (s.textCharsPerPage >= TEXT_LAYER_MIN_CHARS_PER_PAGE) {
    if (s.imageCount >= ILLUSTRATED_MIN_IMAGE_COUNT) {
      return {
        shape: 'illustrated',
        contentType: 'illustrated',
        isComic: false,
        chapterMode: 'page-chunk',
        reason: `文字层充足(${fmt(s.textCharsPerPage, 0)}字/页)且含内容插图(${s.imageCount}张≥${ILLUSTRATED_MIN_IMAGE_COUNT}) → 图文`
      };
    }
    return {
      shape: 'text',
      contentType: 'text',
      isComic: false,
      chapterMode: 'text-regex',
      reason: `文字层充足(${fmt(s.textCharsPerPage, 0)}字/页)且无内容插图(${s.imageCount}张) → 纯文字`
    };
  }

  // 第 2 级：图片型兜底
  if (s.imageDensity < IMAGE_MIN_DENSITY) {
    return {
      shape: 'text',
      contentType: 'text',
      isComic: false,
      chapterMode: 'text-regex',
      reason: `文字稀疏(${fmt(s.textCharsPerPage, 0)}字/页)但几乎无图(密度${fmt(s.imageDensity)}) → 按文字兜底`
    };
  }

  // 第 3 级：漫画 vs 扫描版
  if (outlineDensity > OUTLINE_DENSITY_PER_PAGE) {
    // 3a-1a（任务37）：书签标题语义复核（3a-1 与 3a-2 共用，故置于分支最前）
    if (s.outlineSemanticRatio !== undefined && s.outlineSemanticRatio > OUTLINE_SEMANTIC_MAX_RATIO) {
      return {
        shape: 'scan',
        contentType: 'illustrated',
        isComic: false,
        chapterMode: 'outline',
        reason: `逐页书签(密度${fmt(outlineDensity)})但标题多为真章节名(语义式${Math.round(s.outlineSemanticRatio * 100)}%>${Math.round(OUTLINE_SEMANTIC_MAX_RATIO * 100)}%) → 扫描版技术书`
      };
    }
    // 3a-1：高密度书签 = 一章一页
    if (outlineDensity >= DENSITY_COMIC_STRONG) {
      // 3a-1c（任务41 数据驱动）：先验裁决优先，正则组冷启动兜底（null 回退正则）
      const comicProducerHit =
        priorVerdict(producerPrior, 'comic') ?? matchAnyProducer(s.producer, COMIC_PRODUCER_RES);
      if (comicProducerHit) {
        return {
          shape: 'comic',
          contentType: 'comic',
          isComic: true,
          chapterMode: 'per-page',
          reason: producerPrior && producerPrior.dominant !== null
            ? `高密度逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)})+Producer先验(${producerPrior.producer}: comic ${Math.round(producerPrior.confidence * 100)}%, ${producerPrior.total}样本) → 漫画`
            : `高密度逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)})+强漫画Producer(${s.producer.slice(0, 30)}) → 漫画`
        };
      }
      // 3a-1d（任务39）：黑白图片主导 → 黑白扫描书（实测 985 gray=100% 走此分支）
      if (s.grayOrIndexImageRatio !== undefined && s.grayOrIndexImageRatio > GRAY_IMAGE_SCAN_RATIO) {
        return {
          shape: 'scan',
          contentType: 'illustrated',
          isComic: false,
          chapterMode: 'outline',
          reason: `高密度逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)})但图片为黑白主导(灰度/索引${Math.round(s.grayOrIndexImageRatio * 100)}%>${Math.round(GRAY_IMAGE_SCAN_RATIO * 100)}%) → 黑白扫描书`
        };
      }
      // 3a-1b：标题非以序号式为主（纯页码式/混杂）→ 扫描版；未采集时回退密度判据
      if (s.outlineSerialRatio !== undefined && s.outlineSerialRatio < OUTLINE_SERIAL_MIN_RATIO) {
        return {
          shape: 'scan',
          contentType: 'illustrated',
          isComic: false,
          chapterMode: 'outline',
          reason: `高密度逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)}≥${DENSITY_COMIC_STRONG})但标题非序号式(序号式仅${Math.round(s.outlineSerialRatio * 100)}%<${Math.round(OUTLINE_SERIAL_MIN_RATIO * 100)}%，疑超星扫描书) → 扫描版`
        };
      }
      // 3a-1e（任务41 数据驱动）：先验裁决优先，正则组冷启动兜底（null 回退正则）
      const scanProducerHit =
        priorVerdict(producerPrior, 'illustrated') ?? matchAnyProducer(s.producer, SCAN_PRODUCER_RES);
      if (scanProducerHit) {
        return {
          shape: 'scan',
          contentType: 'illustrated',
          isComic: false,
          chapterMode: 'outline',
          reason: producerPrior && producerPrior.dominant !== null
            ? `高密度逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)})+Producer先验(${producerPrior.producer}: illustrated ${Math.round(producerPrior.confidence * 100)}%, ${producerPrior.total}样本) → 扫描书`
            : `高密度逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)})+扫描书Producer(${s.producer.slice(0, 30)}) → 扫描书`
        };
      }
      return {
        shape: 'comic',
        contentType: 'comic',
        isComic: true,
        chapterMode: 'per-page',
        reason: `逐页书签高密度(${s.outlineCount}/${p}=${fmt(outlineDensity)}≥${DENSITY_COMIC_STRONG}) → 漫画(一章一页)`
      };
    }
    // 3a-2：中密度 + 每页恰好一整图 → 整页图漫画
    if (
      Number.isFinite(s.imageDensity) &&
      s.imageDensity >= FULL_PAGE_COMIC_MIN_DENSITY &&
      s.imageDensity <= FULL_PAGE_COMIC_MAX_DENSITY
    ) {
      return {
        shape: 'comic',
        contentType: 'comic',
        isComic: true,
        chapterMode: 'per-page',
        reason: `逐页书签(${fmt(outlineDensity)})+每页整图(密度${fmt(s.imageDensity)}) → 漫画`
      };
    }
    // 3a-3：中密度 + 非整页图 + 标题多为章节名 → 扫描版（保真目录）
    if (s.outlinePageStyleRatio !== undefined && s.outlinePageStyleRatio <= OUTLINE_PAGE_STYLE_MIN_RATIO) {
      return {
        shape: 'scan',
        contentType: 'illustrated',
        isComic: false,
        chapterMode: 'outline',
        reason: `逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)})但标题多为章节名(页码式仅${Math.round(
          s.outlinePageStyleRatio * 100
        )}%≤${Math.round(OUTLINE_PAGE_STYLE_MIN_RATIO * 100)}%) → 扫描版(按outline分章)`
      };
    }
    return {
      shape: 'comic',
      contentType: 'comic',
      isComic: true,
      chapterMode: 'per-page',
      reason: `逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)}>${OUTLINE_DENSITY_PER_PAGE}) → 漫画`
    };
  }
  // 3b-0a（v2 用户反馈纠错）：无目录 + 无字页 + 强扫描 Producer → 扫描书（不限颜色）。
  //   实测 989《PHP5与MySQL5》（Ghostscript + rgb 彩色印刷 + 无书签）被 3b 误判 comic，
  //   彩色印刷技术书同样需拦截；Ghostscript 组其余 38 本均正确为 illustrated，无回退风险。
  //   任务41 数据驱动：先验裁决优先（dominant=illustrated 且置信度达标），无先验回退正则组。
  const strongScanHit =
    priorVerdict(producerPrior, 'illustrated') ?? matchAnyProducer(s.producer, SCAN_PRODUCER_RES);
  if (s.outlineCount === 0 && s.textPageRatio < 0.05 && strongScanHit) {
    return {
      shape: 'scan',
      contentType: 'illustrated',
      isComic: false,
      chapterMode: 'page-chunk',
      reason: producerPrior && producerPrior.dominant !== null
        ? `无目录+无字页+Producer先验(${producerPrior.producer}: illustrated ${Math.round(producerPrior.confidence * 100)}%, ${producerPrior.total}样本) → 扫描书`
        : `无目录+无字页+强扫描Producer(${s.producer.slice(0, 24)}) → 扫描书`
    };
  }
  // 3b-0b（任务39 实测新增）：无目录 + 无字页 + 黑白图片主导 + 扫描工具 Producer → 黑白扫描书。
  //   实测 979/992/995 三本误判 comic 的技术书均无书签走此路径（而非 3a-1）；
  //   黑白漫画保护：iTextSharp/Acrobat图片转换/无 Producer 的黑白漫画不命中 Producer 条件。
  //   v2：AnnasArchive 加入工具组——27 本养生书（gray/jbig2+无书签）由此拦截。
  //   任务41 数据驱动：先验优先——高置信非 comic 先验（illustrated/text）判 scan；
  //   dominant=comic 保护黑白漫画；dominant=null（小样本/混合"不产生先验"）回退
  //   正则组（最小样本保护在所有分支一致生效，#974 回归防护；FreePic2Pdf 混合组
  //   的黑白书由正则兜底拦截——它本就在 SCAN_TOOL 正则组）。
  const priorComicVerdict = priorVerdict(producerPrior, 'comic'); // true=漫画工具 false=非漫画工具 undefined=无先验
  const scanToolHit =
    priorComicVerdict === undefined
      ? matchAnyProducer(s.producer, SCAN_TOOL_PRODUCER_RES) // 无先验 → 正则兜底
      : !priorComicVerdict; // 有先验：非 comic 工具（illustrated/text）拦，comic 工具不拦
  if (
    s.outlineCount === 0 &&
    s.textPageRatio < 0.05 &&
    s.grayOrIndexImageRatio !== undefined &&
    s.grayOrIndexImageRatio > GRAY_IMAGE_SCAN_RATIO &&
    scanToolHit
  ) {
    return {
      shape: 'scan',
      contentType: 'illustrated',
      isComic: false,
      chapterMode: 'page-chunk',
      reason: producerPrior && producerPrior.dominant !== null
        ? `无目录+无字页+黑白图片主导(灰度/索引${Math.round(s.grayOrIndexImageRatio * 100)}%)+Producer先验(${producerPrior.producer}: ${producerPrior.dominant} ${Math.round(producerPrior.confidence * 100)}%, ${producerPrior.total}样本) → 黑白扫描书`
        : `无目录+无字页+黑白图片主导(灰度/索引${Math.round(s.grayOrIndexImageRatio * 100)}%)+扫描工具Producer(${s.producer.slice(0, 24)}) → 黑白扫描书`
    };
  }
  // 3b：无目录 + 无字页 + 每页全页图
  if (s.outlineCount === 0 && s.textPageRatio < 0.05 && s.imageDensity >= 0.8 && s.imageDensity <= 5) {
    return {
      shape: 'comic',
      contentType: 'comic',
      isComic: true,
      chapterMode: 'per-page',
      reason: `无目录+无字页(${fmt(s.textPageRatio)})+每页全页图(${fmt(s.imageDensity)}) → 漫画`
    };
  }
  // 3c：无目录 + 无字页 + 跨页/混排特征
  if (s.outlineCount === 0 && s.textPageRatio < 0.05 && (s.hasMixedOrientation || s.pageRatioStdDev > 0.02)) {
    return {
      shape: 'comic',
      contentType: 'comic',
      isComic: true,
      chapterMode: 'per-page',
      reason: `无目录+无字页+跨页特征(混排:${s.hasMixedOrientation}/比例σ${fmt(s.pageRatioStdDev, 3)}) → 漫画`
    };
  }

  // 兜底：扫描版
  return {
    shape: 'scan',
    contentType: 'illustrated',
    isComic: false,
    chapterMode: 'page-chunk',
    reason: `少文字(${fmt(s.textCharsPerPage, 0)}字/页)+图片型，有目录(${s.outlineCount})或有字页(${fmt(
      s.textPageRatio
    )}) → 扫描版`
  };
}

/* ==========================================================================
 * 二、PDF 信号采集（复刻 pdf-parser.ts 的 parsePdf 采集口径）
 * ========================================================================== */

const BINARY_SCAN_LIMIT = 20 * 1024 * 1024; // 与 pdf-parser 一致的二进制扫描上限

/** 统计 buffer 中 pattern 出现次数（复刻 pdf-parser.countInBuffer） */
function countInBuffer(buf, pattern) {
  let count = 0;
  let pos = 0;
  const patternBuf = Buffer.from(pattern, 'latin1');
  while (true) {
    pos = buf.indexOf(patternBuf, pos);
    if (pos === -1) break;
    count++;
    pos += patternBuf.length;
  }
  return count;
}

/**
 * 图片颜色模式二进制扫描（复刻 document-classifier.scanImageColorStats，任务39）
 *
 * 对每个 /Subtype /Image 命中点取前后 300 字节窗口查 ColorSpace 标记，
 * 返回黑白占比（gray+index / 总数）与 DjVu 编码特征。
 * 实测与 pdfimages -list color 列高一致：979 index99.9%→0.99、992 gray96%→0.94、
 * 995 gray99.6%→0.97、全彩漫画→0.00。
 */
function scanImageColorStats(buf) {
  const scanBuf = buf.length > BINARY_SCAN_LIMIT ? buf.subarray(0, BINARY_SCAN_LIMIT) : buf;
  const positions = [];
  for (const pat of ['/Subtype /Image', '/Subtype/Image']) {
    const pb = Buffer.from(pat, 'latin1');
    let pos = 0;
    while (true) {
      pos = scanBuf.indexOf(pb, pos);
      if (pos === -1) break;
      positions.push(pos);
      pos += pb.length;
    }
  }
  positions.sort((a, b) => a - b);
  const WINDOW = 300;
  let gray = 0;
  let indexed = 0;
  let color = 0;
  let unknown = 0;
  let djvu = 0;
  for (const pos of positions) {
    const start = Math.max(0, pos - WINDOW);
    const end = Math.min(scanBuf.length, pos + WINDOW);
    const win = scanBuf.subarray(start, end).toString('latin1');
    if (/\/DeviceGray|\/CalGray/.test(win)) gray++;
    else if (/\/Indexed/.test(win)) indexed++;
    else if (/\/DeviceRGB|\/CalRGB|\/DeviceCMYK/.test(win)) color++;
    else unknown++;
    if (/\/JPXDecode|\/JBIG2Decode/.test(win)) djvu++;
  }
  const total = gray + indexed + color + unknown;
  return {
    grayOrIndexImageRatio: total > 0 ? (gray + indexed) / total : undefined,
    djvuEncoded: djvu > 0,
    imageObjects: positions.length
  };
}

/** 递归扁平化 pdfjs outline（复刻 pdf-parser.flattenOutline：跳过空标题与外链） */
function flattenOutline(outline, result = [], depth = 0) {
  for (const node of outline || []) {
    if (!node || !node.title || node.url) continue;
    const childItems = Array.isArray(node.items) ? node.items : [];
    result.push({ title: String(node.title).trim(), depth, hasChildren: childItems.length > 0 });
    if (childItems.length > 0) flattenOutline(childItems, result, depth + 1);
  }
  return result;
}

/** 加载 pdfjs 模块与资源目录（wasm/字体/cmap，缺字体会导致文本提取为空） */
async function loadPdfjs() {
  const req = createRequire(import.meta.url);
  const pkgDir = path.dirname(req.resolve('pdfjs-dist/package.json'));
  const dirUrl = (name) => pathToFileURL(path.join(pkgDir, name)).toString() + '/';
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return {
    pdfjs,
    urls: {
      wasmUrl: dirUrl('wasm'),
      standardFontDataUrl: dirUrl('standard_fonts'),
      cMapUrl: dirUrl('cmaps')
    }
  };
}

/**
 * 采集单本 PDF 的 DocumentSignals
 * @param {Buffer} buf 完整文件字节
 * @param {{pdfjs:any, urls:object}} loader loadPdfjs 的返回值
 * @returns {Promise<object>} DocumentSignals
 */
async function extractSignals(buf, loader) {
  const { pdfjs, urls } = loader;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    wasmUrl: urls.wasmUrl,
    standardFontDataUrl: urls.standardFontDataUrl,
    cMapUrl: urls.cMapUrl,
    cMapPacked: true,
    verbosity: 0
  }).promise;

  try {
    const pageCount = doc.numPages || 1;

    // 书签（getOutline 只调用一次）
    let outlineTopLevelCount = 0;
    let outlineNodes = [];
    try {
      const outline = await doc.getOutline();
      outlineTopLevelCount = outline?.length ?? 0;
      outlineNodes = flattenOutline(outline || []);
    } catch (err) {
      // 加密/损坏 PDF：书签解析失败，向上抛由调用方记录并跳过
      throw new Error(`getOutline 失败: ${err.message}`, { cause: err });
    }

    // Producer（任务39 维度A）：pdfjs getMetadata 的 info.Producer。
    // Info 字典经对象流压缩、二进制不可见，必须经 pdfjs 提取（与生产 pdf-parse getInfo 同源）。
    // 失败不致命：producer 留 undefined，决策树不干预（兼容旧信号）。
    let producer;
    try {
      const md = await doc.getMetadata();
      const raw = md?.info?.Producer;
      if (typeof raw === 'string' && raw.trim()) producer = raw.trim();
    } catch {
      /* 元数据提取失败不致命 */
    }

    // 文本（逐页）：统计总量、分布、有字页占比
    let totalLen = 0;
    let totalNonSpace = 0;
    let pagesWithSignificantText = 0;
    const pageLens = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it) => it.str || '').join('');
      pageLens.push(text.length);
      totalLen += text.length;
      totalNonSpace += text.replace(/\s/g, '').length;
      if (text.length > 50) pagesWithSignificantText++;
    }

    const textCharsPerPage = totalLen / pageCount;
    const textPageRatio = pagesWithSignificantText / pageCount;
    const textVariance =
      pageLens.length > 0
        ? pageLens.reduce((sum, len) => sum + Math.pow(len - textCharsPerPage, 2), 0) / pageLens.length
        : 0;
    const textStdDev = Math.sqrt(textVariance);

    // 图片计数（复刻 pdf-parser：二进制扫描 + 覆盖率外推）
    const scanBuf = buf.length > BINARY_SCAN_LIMIT ? buf.subarray(0, BINARY_SCAN_LIMIT) : buf;
    const rawImageCount = countInBuffer(scanBuf, '/Subtype /Image') + countInBuffer(scanBuf, '/Subtype/Image');
    const imageCount = extrapolateImageCount(rawImageCount, scanBuf.length, buf.length, pageCount);
    const imageDensity = imageCount / pageCount;

    // 页面宽高比 / 混排（扫描前 2MB 的 /MediaBox）
    let pageRatioStdDev = 0;
    let hasMixedOrientation = false;
    {
      const scanSize = Math.min(buf.length, 2 * 1024 * 1024);
      const scanStr = buf.subarray(0, scanSize).toString('latin1');
      const mediaBoxRegex = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g;
      const ratios = [];
      let m;
      while ((m = mediaBoxRegex.exec(scanStr)) !== null) {
        const w = Math.abs(parseFloat(m[3]) - parseFloat(m[1]));
        const h = Math.abs(parseFloat(m[4]) - parseFloat(m[2]));
        if (w > 0 && h > 0) ratios.push(w / h);
      }
      if (ratios.length > 0) {
        const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
        pageRatioStdDev =
          ratios.length > 1 ? Math.sqrt(ratios.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / ratios.length) : 0;
        const orientations = new Set(ratios.map((r) => (r > 1 ? 'L' : 'P')));
        hasMixedOrientation = orientations.size > 1;
      }
    }

    // 压缩滤镜占比
    const ccittCount = countInBuffer(scanBuf, '/CCITTFaxDecode');
    const dctCount = countInBuffer(scanBuf, '/DCTDecode');
    const flateCount = countInBuffer(scanBuf, '/FlateDecode');
    const totalFilters = ccittCount + dctCount + flateCount;
    const ccittRatio = totalFilters > 0 ? ccittCount / totalFilters : 0;

    // 图片颜色模式占比 + DjVu 编码（任务39 维度B，复刻 scanImageColorStats）
    const colorStats = scanImageColorStats(buf);

    // 书签标题三类占比（page/serial/semantic）
    const kindRatios = computeOutlineKindRatios(outlineNodes);

    return {
      pageCount,
      totalTextChars: totalNonSpace,
      textCharsPerPage,
      textStdDev,
      textPageRatio,
      imageCount,
      imageDensity,
      outlineCount: outlineNodes.length,
      outlinePageStyleRatio: computeOutlinePageStyleRatio(outlineNodes),
      // 任务37：标题语义三分法复核信号（与生产 document-classifier 一致）
      outlineSemanticRatio: kindRatios.semantic,
      outlineSerialRatio: kindRatios.serial,
      // 任务39：多维特征信号（Producer / 图片颜色模式 / DjVu 编码）
      producer,
      grayOrIndexImageRatio: colorStats.grayOrIndexImageRatio,
      djvuEncoded: colorStats.djvuEncoded,
      hasMixedOrientation,
      pageRatioStdDev,
      fileSizePerPageMB: buf.length / pageCount / (1024 * 1024),
      ccittRatio,
      // 附加信息（非 DocumentSignals 字段，供输出排障）
      _outlineTopLevel: outlineTopLevelCount,
      _outlineTitles: outlineNodes.slice(0, 5).map((n) => n.title),
      _kindRatios: kindRatios,
      _colorStats: colorStats
    };
  } finally {
    try {
      await doc.destroy();
    } catch {
      /* 忽略销毁失败 */
    }
  }
}

/** 可选：用 pdfimages -list 交叉验证图片数（poppler 子进程，较慢，仅 --cross-check 时调用） */
async function probePdfimages(filePath) {
  try {
    const { stdout } = await execFileAsync('pdfimages', ['-list', filePath], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000
    });
    const rows = stdout.split('\n').filter((l) => /\bimage\b/.test(l)).length;
    return rows;
  } catch (err) {
    return { error: err.message.split('\n')[0] };
  }
}

/* ==========================================================================
 * 三、参数解析
 * ========================================================================== */

function parseArgs(argv) {
  const opts = {
    apply: false,
    db: path.join(PROJECT_ROOT, 'data', 'youdu.db'),
    scope: 'illustrated', // illustrated | comic | all
    id: null,
    limit: null,
    crossCheck: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--cross-check') opts.crossCheck = true;
    else if (a === '--db') opts.db = path.resolve(argv[++i]);
    else if (a === '--scope') opts.scope = argv[++i];
    else if (a === '--id') opts.id = Number(argv[++i]);
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      console.error(`未知参数: ${a}（--help 查看用法）`);
      process.exit(2);
    }
  }
  return opts;
}

function usage() {
  console.log(`存量书分类矫正脚本（任务31/37/39）

用法:
  node scripts/reclassify-books.mjs [选项]

选项:
  --apply          执行标签更新（默认 dry-run，只打印不写库）
  --scope <s>      扫描范围: illustrated(默认) | comic | all
  --id <n>         只处理指定书籍 id
  --limit <n>      最多处理 n 本（调试用）
  --cross-check    额外用 pdfimages -list 交叉验证图片数（较慢）
  --db <path>      指定数据库路径（默认 <项目>/data/youdu.db）
  -h, --help       显示帮助

判定依据（与生产 document-classifier 决策树一致，任务39 多维特征）:
  1. 高密度逐页书签（密度 ≥ 0.8）的书签标题三分法 + Producer + 颜色多维裁决：
     - semantic（真章节名）占比 > 0.5 → 扫描版技术书 → illustrated
     - Producer 命中强漫画组（iTextSharp/PDFdo/AnnasArchive/Acrobat图片转换）→ comic
     - 黑白图片主导（gray/index > 50%）→ 黑白扫描书 → illustrated
     - serial（序号式 "1_001"）非主导（< 0.5）→ 扫描版 → illustrated
     - Producer 命中强扫描组（Ghostscript/zlib）→ 扫描书 → illustrated
  2. 无目录 + 无字页 + 黑白图片主导 + 扫描工具 Producer（FreePic2Pdf 系）→ illustrated
     （任务39：979/992/995 三本误判 comic 的黑白技术书走此分支矫正）

⚠️ --apply 只改 books.content_type / is_comic，**不重建章节**。
   改完需对变更书执行"重新解析"（应用内书籍详情 → 重新检测漫画），
   否则漫画模式会因章节结构不匹配而显示异常。`);
}

/* ==========================================================================
 * 四、主流程
 * ========================================================================== */

/** 数据源查询：按 scope 拉取待判定书目 */
function loadBooks(db, opts) {
  let sql = 'SELECT id, title, file_type, content_type, is_comic, local_file_path FROM books';
  const params = [];
  if (opts.id != null) {
    sql += ' WHERE id = ?';
    params.push(opts.id);
  } else if (opts.scope === 'illustrated') {
    sql += " WHERE content_type = 'illustrated'";
  } else if (opts.scope === 'comic') {
    sql += " WHERE content_type = 'comic'";
  } else if (opts.scope === 'all') {
    // 全部 PDF 书（非 pdf 跳过，由过滤逻辑处理）
    sql += " WHERE file_type = 'pdf' OR local_file_path LIKE '%.pdf'";
  } else {
    console.error(`未知 scope: ${opts.scope}（可选 illustrated|comic|all）`);
    process.exit(2);
  }
  sql += ' ORDER BY id';
  if (opts.limit != null) sql += ` LIMIT ${Number(opts.limit)}`;
  return db.prepare(sql).all(...params);
}

/** 判断书籍是否为可判定的 PDF（file_type 或扩展名） */
function isPdfBook(book) {
  if (book.file_type === 'pdf') return true;
  return typeof book.local_file_path === 'string' && book.local_file_path.toLowerCase().endsWith('.pdf');
}

function pad(str, width) {
  const s = String(str ?? '');
  const chars = [...s];
  if (chars.length >= width) return chars.slice(0, width).join('');
  return s + ' '.repeat(width - chars.length);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  if (!fs.existsSync(opts.db)) {
    console.error(`数据库不存在: ${opts.db}`);
    process.exit(1);
  }

  const db = new Database(opts.db, { readonly: !opts.apply });
  if (opts.apply) db.pragma('journal_mode = WAL');

  const books = loadBooks(db, opts);
  console.log('='.repeat(100));
  console.log(`存量书分类矫正 ${opts.apply ? '【APPLY 写库】' : '【DRY-RUN 只读】'}`);
  console.log(`DB: ${opts.db}`);
  console.log(`范围: ${opts.id != null ? 'id=' + opts.id : 'scope=' + opts.scope}，待判定 ${books.length} 本`);
  console.log('='.repeat(100));

  const loader = await loadPdfjs();

  // 任务41：Producer 统计先验——基于全库（独立于 --scope）重检前快照计算，
  // 数据驱动替代硬编码正则组（先验缺失的书回退正则兜底，行为与任务39 一致）
  const producerPriors = computeProducerPriors(loadProducerStatRows(db));
  const priorEntries = [...producerPriors.values()].filter((x) => x.dominant !== null);
  console.log(
    `Producer 先验: ${priorEntries.length}/${producerPriors.size} 个归一化 Producer 产生先验（` +
      priorEntries.map((x) => `${x.producer}=${x.dominant}(${Math.round(x.confidence * 100)}%)`).join(', ') +
      '）'
  );

  const results = []; // 全部（含 skipped）
  const changes = []; // 需要变更的

  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    const tag = `[${i + 1}/${books.length}]`;
    const label = `#${book.id} ${book.title}`;

    // 非 PDF：跳过（本脚本只做 PDF 判定）
    if (!isPdfBook(book)) {
      console.log(`${tag} ${pad(label, 50)} → SKIP(非PDF: ${book.file_type})`);
      results.push({ book, status: 'skipped', reason: `非 PDF 文件（file_type=${book.file_type}）` });
      continue;
    }

    const filePath = book.local_file_path;
    if (!filePath || !fs.existsSync(filePath)) {
      console.log(`${tag} ${pad(label, 50)} → SKIP(文件不存在)`);
      results.push({ book, status: 'skipped', reason: `文件不存在: ${filePath || '(空路径)'}` });
      continue;
    }

    let buf;
    try {
      buf = fs.readFileSync(filePath);
    } catch (err) {
      console.log(`${tag} ${pad(label, 50)} → SKIP(读取失败)`);
      results.push({ book, status: 'skipped', reason: `读取文件失败: ${err.message}` });
      continue;
    }

    let signals;
    try {
      signals = await extractSignals(buf, loader);
    } catch (err) {
      console.log(`${tag} ${pad(label, 50)} → SKIP(解析失败: ${err.message})`);
      results.push({ book, status: 'skipped', reason: `PDF 解析失败: ${err.message}` });
      continue;
    }

    const verdict = classifyDocument(signals, producerPriors);
    const changed = verdict.contentType !== book.content_type || Boolean(verdict.isComic) !== (book.is_comic === 1);
    // 书签标题三类占比（page/serial/semantic），作为判定依据可审计
    const kr = signals._kindRatios;
    const kindStr = `pg${(kr.page ?? 0).toFixed(2)} sr${(kr.serial ?? 0).toFixed(2)} sm${(kr.semantic ?? 0).toFixed(2)}`;
    // 任务39 多维特征列：黑白图片占比 + Producer（截断显示）
    const grayStr = signals.grayOrIndexImageRatio === undefined ? '  n/a' : signals.grayOrIndexImageRatio.toFixed(2);
    const prodStr = (signals.producer || '-').slice(0, 26);

    // 交叉验证图片数（可选）
    let pdfimgInfo = '';
    if (opts.crossCheck) {
      const n = await probePdfimages(filePath);
      pdfimgInfo = typeof n === 'number' ? ` imgPdf=${(n / signals.pageCount).toFixed(2)}` : ` imgPdf=n/a`;
    }

    const line =
      `${tag} ${pad(label, 46)} ` +
      `p=${pad(signals.pageCount, 5)} out=${pad(signals.outlineCount, 5)} ` +
      `dens=${pad(signals.outlineCount / signals.pageCount, 5)} img=${pad(signals.imageDensity.toFixed(2), 5)} ` +
      `cpp=${pad(signals.textCharsPerPage.toFixed(0), 6)} [${kindStr}] gray=${pad(grayStr, 5)} prod=${pad(prodStr, 27)}${pdfimgInfo} | ` +
      `${book.content_type}${changed ? ' → ' + verdict.contentType : ' (不变)'}`;
    console.log(line);

    const record = {
      book,
      status: changed ? 'changed' : 'same',
      signals,
      verdict,
      changed,
      kindStr,
      reason: verdict.reason
    };
    results.push(record);
    if (changed) changes.push(record);

    // 重点书完整理由（任务39 矫正目标 + 回归保护样本）
    if (
      [720, 726, 770, 772, 788, 822, 826, 845, 847, 860, 970, 979, 985, 986, 989, 992, 995, 280].includes(book.id)
    ) {
      console.log(
        `        ↳ reason: ${verdict.reason}\n        ↳ signals: outlineTitles=${JSON.stringify(
          signals._outlineTitles
        )} kindRatios=${JSON.stringify(kr)} grayOrIndex=${grayStr} djvu=${signals.djvuEncoded === true} ` +
          `producer=${JSON.stringify(signals.producer)} textPageRatio=${signals.textPageRatio.toFixed(3)} imgCount=${
            signals.imageCount
          }`
      );
    }
  }

  /* ---------- 汇总 ---------- */
  const skipped = results.filter((r) => r.status === 'skipped');

  const ok = results.filter((r) => r.status !== 'skipped');

  console.log('-'.repeat(100));
  console.log(`判定完成：处理 ${ok.length} 本，跳过 ${skipped.length} 本`);
  if (skipped.length > 0) {
    console.log('\n【跳过清单】');
    for (const r of skipped) {
      console.log(`  #${r.book.id} ${r.book.title} → ${r.reason}`);
    }
  }

  const header = `  ${pad('id', 6)} ${pad('当前', 12)} ${pad('新', 12)} ${pad('pages', 6)} ${pad('outline', 8)} ${pad(
    'imgDens',
    7
  )} ${pad('kind(pg/sr/sm)', 24)} ${pad('gray', 5)} ${pad('producer', 26)} ${pad('title', 28)} reason`;
  const printRow = (r) => {
    const s = r.signals;
    const gray = s.grayOrIndexImageRatio === undefined ? 'n/a' : s.grayOrIndexImageRatio.toFixed(2);
    console.log(
      `  ${pad(r.book.id, 6)} ${pad(r.book.content_type, 12)} ${pad(r.verdict.contentType, 12)} ${pad(
        s.pageCount,
        6
      )} ${pad(s.outlineCount, 8)} ${pad(s.imageDensity.toFixed(2), 7)} ${pad(r.kindStr, 24)} ${pad(gray, 5)} ${pad(
        (s.producer || '-').slice(0, 26),
        26
      )} ${pad(r.book.title, 28)} ${r.reason}`
    );
  };

  console.log(`\n【拟变更清单】共 ${changes.length} 本`);
  if (changes.length > 0) {
    console.log(header);
    for (const r of changes) printRow(r);
  } else {
    console.log('  （无需变更）');
  }

  const stats = {};
  for (const r of changes)
    stats[r.book.content_type + '→' + r.verdict.contentType] =
      (stats[r.book.content_type + '→' + r.verdict.contentType] || 0) + 1;
  console.log(`\n  统计: ${JSON.stringify(stats)}`);

  if (!opts.apply) {
    console.log('\n(DRY-RUN) 未修改数据库。确认无误后加 --apply 执行。');
    db.close();
    return;
  }

  /* ---------- 写库 ---------- */
  if (changes.length === 0) {
    console.log('\n无变更，无需写库。');
    db.close();
    return;
  }

  const stmt = db.prepare('UPDATE books SET content_type = ?, is_comic = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  const tx = db.transaction((list) => {
    for (const r of list) {
      stmt.run(r.verdict.contentType, r.verdict.isComic ? 1 : 0, now, r.book.id);
    }
  });
  tx(changes);

  console.log(`\n✅ 已更新 ${changes.length} 本书的 content_type / is_comic。`);
  console.log('⚠️  请对上述书执行"重新解析"（应用内：书籍详情 → 重新检测漫画）以重建漫画章节结构。');
  db.close();
}

main().catch((err) => {
  console.error('脚本执行失败:', err);
  process.exit(1);
});
