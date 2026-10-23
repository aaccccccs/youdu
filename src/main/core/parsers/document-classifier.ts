/**
 * 统一文档分类内核（P1+P2）
 *
 * 背景：原分类逻辑三格式各自为政 ——
 *   - PDF：9 维二进制/文本统计加权评分（pdf-parser.ts）
 *   - EPUB：章节级 contentType + 文本/图片统计（另一套）
 *   - MOBI：又一套
 * 同一本书不同格式会得到不同分类，且"分类标签"与"分章方式"硬绑定，
 * 一旦判错（如日漫判 illustrated）分章结构也跟着错（20页/章而非每页一章）。
 *
 * 本模块提供与格式无关的统一方案：
 *   1. DocumentSignals：所有解析器统一采集同一组可解释的文档统计量
 *   2. classifyDocument：多级决策树（替代加权评分），输出
 *      { 形态、兼容三分类标签、分章方式、判定理由 }
 *
 * 设计原则：
 *   - 只用"人类可解释的文档统计量"，不引入机器学习依赖（低维特征下决策树
 *     与 ANN 精度差距 <2%，但零依赖、可解释、可调试）
 *   - 分章方式与分类标签解耦输出（chapterMode），修正"判错就全错"的旧问题
 *   - 判定理由（reason）便于日志排查与用户反馈对照
 */
import {
  lookupProducerPrior,
  PRODUCER_PRIOR_CONFIDENCE,
  type ProducerPrior
} from './classify-producer-stats';

/** 与格式无关的文档特征（PDF/EPUB/MOBI 统一采集） */
export interface DocumentSignals {
  /** 页数（EPUB/MOBI 无物理页概念时用章节数近似） */
  pageCount: number;
  /** 全书纯文本字符数（不含空白） */
  totalTextChars: number;
  /** 每页平均字符数 = totalTextChars / pageCount */
  textCharsPerPage: number;
  /** 每页字符数标准差（漫画文字少且均匀；图文书分布不均；文字书较大） */
  textStdDev: number;
  /** 有显著文字（>50 字）的页占比 —— 图片型内容接近 0 */
  textPageRatio: number;
  /** 图片总数（PDF 已按扫描覆盖率外推；EPUB/MOBI 为章节图片标记数） */
  imageCount: number;
  /** 图片密度 = imageCount / pageCount（每页全页图 ≈ 1） */
  imageDensity: number;
  /** 目录（书签/outline）条目数 */
  outlineCount: number;
  /** 页码式书签标题占比（0-1；undefined=未采集，不参与判定）。
   *  扫描版技术书的逐页书签（某些导出器默认逐页书签）标题是真章节名
   *  （"第一章 xxx"，且常为多层树）→ 占比低。仅在"中密度逐页书签 + 非整页图"
   *  时作为第三层复核（P2-4/P2-5 3a-3）。注意：真漫画标题也可能是导出器序号式
   *  （"1_001"/"1_002"，既非页码式也非章节名），故高密度漫画改由密度判据（P2-5 3a-1）
   *  直接判定、不依赖此占比。 */
  outlinePageStyleRatio?: number;
  /** 语义式书签标题占比（0-1；undefined=未采集，不参与判定）。
   *  任务37 新增：高密度逐页书签（3a-1）有两种来源 ——
   *    ① 真漫画（标题为导出器序号式/纯页码式）；
   *    ② 超星/SSReader 等导出的**扫描版技术书**（逐页书签但标题是真章节名
   *       "1.1.1 bug与漏洞"/"第一章 走出神墓"）。
   *  语义式占比 > 0.5 表示标题以真章节名为主 → 扫描版技术书，不判漫画。 */
  outlineSemanticRatio?: number;
  /** 序号式书签标题占比（0-1；undefined=未采集，不参与判定）。
   *  任务37 新增：真漫画逐页书签标题是导出器序号式（"1_001"/"Doraemon01_000"/
   *  "_SDK08-_0000"）；而超星扫描书可能用**纯页码式**（"1"/"130"）作逐页书签——
   *  此时语义式占比很低、序号式占比也低。仅当序号式占主导（≥阈值）才认为是漫画；
   *  纯页码式/混杂标题 → 扫描版（修复"纯页码式超星扫描书被误判漫画"的盲区）。 */
  outlineSerialRatio?: number;
  /** PDF 元数据 Producer 原始字符串（任务39；undefined=未采集/无 Producer，不参与判定）。
   *  全库 240 本实测 Producer×标签交叉表（维度A）：
   *    - iTextSharp（55/55 comic）、PDFdo.com（30/30）、AnnasArchive（27/27）、
   *      Acrobat 图片转换（12/13）→ **强漫画信号**（汉化组工具链）；
   *    - Ghostscript（38/39 illustrated）、zlib（3/3）→ **强扫描书信号**；
   *    - FreePic2Pdf（19 illustrated + 16 comic）→ **中性**（汉化组与扫书都用）。
   *  Producer 存于 PDF Info 字典（pdfjs getMetadata 可提取，二进制不可见——对象流压缩）。 */
  producer?: string;
  /** 黑白图片占比 = gray/index 色彩空间图片数 / 有色彩信息的图片总数（任务39；
   *  undefined=未采集，不参与判定）。
   *  采集方式：二进制扫描 /Subtype /Image 命中点前后窗口内的 ColorSpace 标记
   *  （/DeviceGray|/CalGray|/Indexed vs /DeviceRGB|/CalRGB|/DeviceCMYK），
   *  与 pdfimages -list 的 color 列实测相关性：979 index→0.99、992 gray→0.94、
   *  995 gray→0.97、985 gray→1.00、全彩漫画（奇天烈/超能力魔美）→0.00。
   *  ⚠️ 黑白≠扫描书：黑白漫画（哆啦A梦大长篇台版 gray 90-100%）同样命中，
   *  故本维度必须与 Producer（扫描工具组）组合使用，不可单独判定。 */
  grayOrIndexImageRatio?: number;
  /** 是否含 JPX/JBIG2 编码图片（DjVu 转换特征，任务39；undefined=未采集）。
   *  实测 0day=rgb+jpx 1560 张。当前仅作为采集信号输出（排障/审计），
   *  不参与决策判定（0day 密度 0.45 走兜底 scan 已正确）。 */
  djvuEncoded?: boolean;
  /** 是否横竖混排（漫画跨页特征） */
  hasMixedOrientation: boolean;
  /** 页面宽高比标准差（漫画跨页 → 变化大；扫描书 → 稳定） */
  pageRatioStdDev: number;
  /** 每页文件大小（MB） */
  fileSizePerPageMB: number;
  /** CCITT 传真压缩占比（黑白扫描特征） */
  ccittRatio: number;
}

/** 文档形态（4 类，比三分类更精确；scan 在标签上归入 illustrated 保持兼容） */
export type DocShape = 'text' | 'illustrated' | 'scan' | 'comic';

/** 分章方式（与分类标签解耦） */
export type ChapterMode =
  | 'outline' // 按 PDF outline / EPUB 目录分章
  | 'text-regex' // 按正则匹配"第X章"分章
  | 'page-chunk' // 按固定页数均分（扫描书/无目录图文）
  | 'per-page'; // 每页一章（漫画/纯图片型）

export interface ClassifyResult {
  /** 精确形态 */
  shape: DocShape;
  /** 兼容现有 DB 的三分类标签：scan 归 illustrated */
  contentType: 'text' | 'illustrated' | 'comic';
  /** 是否漫画（兼容 is_comic 字段） */
  isComic: boolean;
  /** 建议分章方式 */
  chapterMode: ChapterMode;
  /** 判定理由（可读，用于日志/调试/反馈核对） */
  reason: string;
}

/* ==================== 决策树阈值（依据 7 本实测书特征校准） ==================== */

/** 每页字符数 ≥ 此值视为"有实质文字层"（电子书正文）。实测真图文/文字书远超，扫描版近 0 */
export const TEXT_LAYER_MIN_CHARS_PER_PAGE = 100;
/** 有文字层时，内容插图数量 ≥ 此值视为图文书（1-2 张通常是封面/装饰，不算插图）。
 *  用"图片总数"而非"图密度"：大书（数百页）的 3 张内容插图密度极低（0.01），
 *  但确实是图文混排（实测《最强大脑训练课》168K字/265页/3图 = 图文书，密度判据会误判纯文字）。 */
export const ILLUSTRATED_MIN_IMAGE_COUNT = 3;
/** 图片型判定：图密度 < 此值视为"基本无图"（特例兜底，避免空书误判） */
export const IMAGE_MIN_DENSITY = 0.05;
/** 逐页书签判定：书签数 / 页数 > 此值视为"每页一个书签"（日漫 PDF 的典型结构） */
export const OUTLINE_DENSITY_PER_PAGE = 0.5;
/** 逐页书签复核（P2-4）：书签标题为页码式命名的占比 > 此值视为真漫画的页码式书签；
 *  ≤ 此值（标题多为真章节名，且/或存在多层书签树）视为扫描版/图文书的逐页书签，
 *  不判漫画、走 outline 分章保住真目录 */
export const OUTLINE_PAGE_STYLE_MIN_RATIO = 0.8;
/** 高密度书签判漫画（P2-5）：outlineDensity ≥ 此值意味"一章不到 1.25 页"，
 *  只有整页图漫画成立（漫画一章一页）。实证：哆啦A梦 670 页/670 书签 = 1.00、
 *  灌篮高手 117/117 = 1.00 → comic；扫描版技术书一章多页（0day 780 页/263 书签 = 0.34，
 *  十几页/章的更低）密度远低于此。此判据不看书签标题——漫画标题可能是导出器序号式
 *  （"1_001"、"1_002"），既非页码式也非真章节名，P2-4 的标题模式判据对此会失灵。 */
export const DENSITY_COMIC_STRONG = 0.8;
/** 整页图漫画判据（P2-5 第二层）：imageDensity 在此区间意味"每页恰好一整图"
 *  （哆啦A梦/灌篮高手 = 1.00 实测）；扫描技术书混排多图（0day = 3.00）不命中。
 *  配合中密度逐页书签（0.5~0.8）识别"书签标题为章节名但每页一整图"的整页图漫画。 */
export const FULL_PAGE_COMIC_MIN_DENSITY = 0.9;
export const FULL_PAGE_COMIC_MAX_DENSITY = 1.9;
/** 高密度书签语义复核（任务37）：高密度逐页书签中，语义式（真章节名）标题占比
 *  > 此值 → 判扫描版技术书（不判漫画）。实测：超星/SSReader 扫描技术书逐页书签
 *  标题为"1.1.1 bug与漏洞"/"第一章 xxx"，语义式占比 ≈ 100%；真漫画标题为导出器
 *  序号式（"1_001"），语义式占比 = 0%。混排书签（40% 序号 + 60% 章节名）也归扫描版。 */
export const OUTLINE_SEMANTIC_MAX_RATIO = 0.5;
/** 高密度书签序号式复核（任务37）：真漫画逐页书签标题为导出器序号式（"1_001"/
 *  "Doraemon01_000"/"_SDK08-_0000"）。若采集到序号式占比且**不足**此值（即标题
 *  并非以序号式为主，如纯页码式"1"/"130"的超星扫描书），判扫描版。仅当序号式
 *  占比 ≥ 此值才维持漫画判定。字段未采集（旧信号/EPUB/MOBI）时回退密度判据。 */
export const OUTLINE_SERIAL_MIN_RATIO = 0.5;
/* ==================== 任务39：多维特征（Producer + 图片颜色模式） ==================== */
/* 任务41 说明：以下三组 Producer 正则已降级为"冷启动兜底"——运行时主判据是
 * Producer 统计先验（classify-producer-stats.ts，数据驱动：从书库历史标签
 * 自动学习，新工具积累 5+ 本后自动产生先验，无需改正则）。先验缺失
 * （未传入先验表 / 该 Producer 无历史）时才走正则组，行为与任务39 完全
 * 一致——这也是 AnnasArchive 曾在漫画组/扫描组之间来回搬家（循环论证
 * 纠错）问题的根治方案：分组交给数据，不靠人工维护白名单。 */

/** 强漫画 Producer 组（3a-1c 冷启动兜底）：全库实测纯度 —— iTextSharp 55/55、
 *  PDFdo 30/30、Acrobat 图片转换 12/13（唯一例外 822 即本判据的矫正目标）。
 *  均为汉化组/漫画打包工具链。命中的书在"高密度逐页书签"下直接判漫画。
 *  v2（用户反馈"漫画有很多是图文"纠错）：移除 AnnasArchive——其 27 本当前
 *  标签 comic 是历史误判（实为壮阳/补肾养生书扫描版），此前划入漫画组属
 *  循环论证（用误判标签定义"纯度"再自我强化）。 */
export const COMIC_PRODUCER_RES: readonly RegExp[] = [
  /Acrobat[^]*Image Conversion/i, // "Adobe Acrobat 19.8 Image Conversion Plug-in"
  /iTextSharp/i, // "iTextSharp 5.1.3 (c) 1T3XT BVBA"
  /PDFdo\.com/i
];
/** 强扫描书 Producer 组（3a-1e/3b-0a 冷启动兜底）：纯实证组 —— Ghostscript 38/39、zlib 3/3。
 *  ⚠️ 不含 FreePic2Pdf：它是中性两用工具（19 illustrated + 16 comic），
 *  奇天烈/超能力魔美等真漫画同样使用，放入会把它们误判扫描版。
 *  v3：AnnasArchive 加入——库中 27 本全是壮阳/补肾养生书（黑白已由 3b-0b 拦截、
 *  彩色系如 718/930 由本组不限颜色拦截），无一本真漫画，归强扫描组安全。 */
export const SCAN_PRODUCER_RES: readonly RegExp[] = [/Ghostscript/i, /^zlib/i, /AnnasArchive/i];
/** 扫描工具 Producer 组（3b-0b 冷启动兜底，比 SCAN_PRODUCER_RES 多 FreePic2Pdf/AnnasArchive）：
 *  仅在"无目录 + 无字页 + 黑白图片主导"的收窄条件下参与判定——
 *  全库实证 FreePic2Pdf 系 + 无书签 + 黑白主导的 3 本书（979/992/995）
 *  全部是黑白扫描技术书，而 FreePic2Pdf 的真漫画（奇天烈/超能力魔美）
 *  均为 rgb 全彩，不受本判据影响（黑白漫画走 iTextSharp/Acrobat/无Producer）。
 *  v2：AnnasArchive 加入——27 本养生书（gray/jbig2 主导+无书签）由此拦截。 */
export const SCAN_TOOL_PRODUCER_RES: readonly RegExp[] = [/Ghostscript/i, /^zlib/i, /FreePic2Pdf/i, /AnnasArchive/i];
/** 黑白图片占比阈值（3a-1d/3b-0）：gray/index 图片占比 > 此值视为黑白扫描书。
 *  实测：误判技术书 979 index=99%/992 gray=96%/995 gray=97% 均远超；
 *  彩色印刷技术书 986 rgb=100%/989 index=8% 均低于 → 不误伤（保持 comic 现状）；
 *  全彩漫画（奇天烈/超能力魔美/哆啦A梦短篇）rgb=100% → 不命中。 */
export const GRAY_IMAGE_SCAN_RATIO = 0.5;
/** 判断 Producer 是否命中给定正则组（producer 未采集时返回 false，不参与判定） */
export function matchAnyProducer(producer: string | undefined, res: readonly RegExp[]): boolean {
  return typeof producer === 'string' && res.some((re) => re.test(producer));
}

/**
 * Producer 先验裁决（任务41 四个分支共用）：三态语义
 * - true：先验存在（dominant 指向 expectLabel 且置信度达标）→ 先验裁决命中
 * - false：先验存在但 dominant 指向其他标签 → 先验裁决否决（数据优先于正则）
 * - undefined：无先验（未传 map / Producer 无历史 / dominant=null 小样本混合 /
 *   置信度不达标）→ 调用方回退正则组兜底（冷启动行为与任务39 一致）
 *
 * ⚠️ dominant=null 必须回退正则而非直接否决/命中——实测回归 #974（pdfFactory
 * Pro 仅 3 本历史，dominant=null）曾被"非 comic 即拦"越权判 scan（基线判
 * comic）；而 979（FreePic2Pdf 38 样本混合，dominant=null）的黑白书由正则
 * 兜底拦截（FreePic2Pdf 本就在 SCAN_TOOL 正则组）。"不产生先验=不干预"
 * 保证最小样本保护在所有分支一致生效。
 */
function priorVerdict(
  prior: ProducerPrior | undefined,
  expectLabel: 'comic' | 'illustrated'
): boolean | undefined {
  if (!prior || prior.dominant === null || prior.confidence < PRODUCER_PRIOR_CONFIDENCE) {
    return undefined;
  }
  return prior.dominant === expectLabel;
}

/* ==================== 决策树 ==================== */

/**
 * 统一分类决策树
 *
 * 判定顺序（先文本层 → 再图片型细分 → 最后漫画/扫描版）：
 *
 * 1) 有实质文字层（textCharsPerPage ≥ 100）
 *    - 图密度高 → illustrated（图文：文字为主 + 插图，走文字渲染 + 章节分章）
 *    - 否则     → text（纯文字）
 *
 * 2) 少量文字（< 100/页）
 *    - 图密度过低 → text（兜底：无图无字，罕见）
 *    - 逐页书签（outlineDensity > 0.5）——多重复核（P2-5 + 任务37/39）：
 *      3a-1 高密度（≥0.8，"一章不到 1.25 页"）→ 默认 comic（整页图漫画，一章一页。
 *           实测：哆啦A梦 670/670=1.00、灌篮高手 117/117=1.00）。任务37 加书签标题
 *           语义三分法复核（page/serial/semantic）修复盲区；任务39 加 Producer +
 *           图片颜色模式多维裁决：
 *             3a-1a 语义式占比 > 0.5（标题多为真章节名）→ scan（超星扫描技术书，
 *                   逐页书签密度同样 ≥0.8，误伤修复）
 *             3a-1c Producer 命中强漫画组（iTextSharp/PDFdo/AnnasArchive/
 *                   Acrobat图片转换）→ comic（救 822：Acrobat图片转换+密度1.0，
 *                   压过 3a-1b 的页码式书签误判；注意须置于 3a-1b 之前）
 *             3a-1d 黑白图片占比 > 0.5 → scan（黑白扫描技术书；实测 985 gray=100%。
 *                   强漫画组的黑白卷已被 3a-1c 前置拦截，无冲突）
 *             3a-1b 序号式占比 < 0.5（标题非导出器序号式，如纯页码式超星书）→ scan
 *             3a-1e Producer 命中强扫描组（Ghostscript/zlib）→ scan（Ghostscript
 *                   组 38/39 实证）
 *           未采集标题占比（旧信号/EPUB/MOBI）时回退密度判据（兼容任务29 行为）
 *      3a-2 中密度（0.5~0.8）+ 每页整图（图密度 0.9~1.9）→ comic（整页图漫画）
 *      3a-3 中密度 + 非整页图 + 标题多为章节名（页码式占比 ≤ 0.8）→ scan（走 outline 分章保真目录）
 *      其余 → comic
 *    - 3b-0 无目录 + 无字页 + 黑白图片主导 + 扫描工具 Producer（FreePic2Pdf/
 *      Ghostscript/zlib 系）→ scan（任务39：黑白扫描技术书。实测 979（FreePic2Pdf+
 *      index99%）/992（FreePic2Pdf_Lib+gray94%）/995（FreePic2Pdf+gray97%）无书签
 *      走此路径；黑白漫画保护——iTextSharp/Acrobat图片转换/无 Producer 的黑白
 *      漫画（哆啦A梦大长篇台版等）不命中 Producer 条件，维持 comic）
 *    - 3b 无目录 + 无字页 + 每页全页图 → comic（实测：21世纪小福星 191页/191图/无字）
 *    - 3c 无目录 + 无字页 + 跨页/混排特征 → comic
 *    - 其余（有章节目录 / 有 OCR 文字页）→ scan（扫描版技术书，走图片渲染 + 章节分章）
 *
 * 任务41（数据驱动 Producer 先验）：可选参数 producerPriors 传入书库统计先验
 * （computeProducerPriors 的输出）时，3a-1c/3a-1e/3b-0a/3b-0b 四个 Producer
 * 判据改为**先验优先**——先验说 comic 就 comic、说 illustrated 就 scan；
 * 先验缺失（未传 map / 该 Producer 无历史 / 混合工具无先验）时回退正则组
 * （冷启动兜底），行为与任务39 完全一致。
 */
export function classifyDocument(
  s: DocumentSignals,
  producerPriors?: Map<string, ProducerPrior>
): ClassifyResult {
  const p = Math.max(s.pageCount, 1);
  const outlineDensity = s.outlineCount / p;
  const fmt = (n: number, d = 2) => n.toFixed(d);
  // 任务41：本书 Producer 的统计先验（缺失时各分支回退正则组兜底）
  const producerPrior = lookupProducerPrior(s.producer, producerPriors);

  /* ---- 第 1 级：文本层 ---- */
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

  /* ---- 第 2 级：图片型兜底 ---- */
  if (s.imageDensity < IMAGE_MIN_DENSITY) {
    return {
      shape: 'text',
      contentType: 'text',
      isComic: false,
      chapterMode: 'text-regex',
      reason: `文字稀疏(${fmt(s.textCharsPerPage, 0)}字/页)但几乎无图(密度${fmt(s.imageDensity)}) → 按文字兜底`
    };
  }

  /* ---- 第 3 级：漫画 vs 扫描版 ---- */
  // 3a. 逐页书签：日漫 PDF 常见"每页一个书签"结构（实测分离度最佳，>0.5 vs 技术书 <0.1）。
  //     P2-4 用"书签标题是否页码式"复核，但实测发现漫画标题可能是导出器序号式
  //     （"1_001"/"1_002"/"_SDK08-_0000"），既非页码式也非真章节名 → 复核失灵、误判扫描版。
  //     P2-5 改为"书签密度优先"（用户领域经验 + 实测双证）：一章一页的整页图漫画
  //     书签密度必然 ≈ 1（哆啦A梦 670/670、灌篮高手 117/117），而扫描技术书一章多页
  //     （0day 780 页/263 书签 = 0.34，十几页/章的更低）密度远达不到 0.8。三层复核：
  if (outlineDensity > OUTLINE_DENSITY_PER_PAGE) {
    // 3a-1a（任务37）：书签标题语义复核（3a-1 与 3a-2 共用，故置于分支最前）。
    //   "逐页书签 + 每页整图"有两种来源：
    //     ① 真漫画：标题为导出器序号式（"1_001"/"_SDK08-_0000"）或纯页码式；
    //     ② 超星/SSReader 导出的**扫描版技术书**：逐页书签、密度 0.5~1.0，
    //        但标题是真章节名（"1.1.1 bug与漏洞"/"第一章 xxx"）→ 原实现无条件判 comic 会误伤。
    //   实测 18 本扫描书（Android/ASP.NET/HADOOP/黑客攻防/壮阳食谱等）语义式占比 ≈ 100%，
    //   其中 12 本密度 ≥0.8（走 3a-1）、6 本密度 0.5~0.8（走 3a-2），故复核须覆盖两者。
    if (s.outlineSemanticRatio !== undefined && s.outlineSemanticRatio > OUTLINE_SEMANTIC_MAX_RATIO) {
      return {
        shape: 'scan',
        contentType: 'illustrated',
        isComic: false,
        chapterMode: 'outline',
        reason: `逐页书签(密度${fmt(outlineDensity)})但标题多为真章节名(语义式${Math.round(s.outlineSemanticRatio * 100)}%>${Math.round(OUTLINE_SEMANTIC_MAX_RATIO * 100)}%) → 扫描版技术书`
      };
    }
    // 3a-1（最强判据）：高密度书签（≥0.8）= 一章一页 → 漫画。
    if (outlineDensity >= DENSITY_COMIC_STRONG) {
      // 3a-1c（任务41 数据驱动）：Producer 判漫画——先验裁决优先，正则组降级冷启动兜底。
      //   先验路径：该 Producer 历史多数标签为 comic 且置信度达标（如实测 itextsharp
      //   74/75=98%、pdfdo.com 30/30、adobe acrobat 14/15=93%）→ comic；
      //   先验否决：先验指向其他标签 → 不判漫画（数据优先于正则）；
      //   兜底路径：无先验（未传先验表/无历史/小样本混合）时走 COMIC_PRODUCER_RES
      //   正则组（任务39 行为，iTextSharp/PDFdo/Acrobat图片转换）。
      //   必须置于 3a-1b 之前：822（Acrobat图片转换 + 密度1.0 + 页码式书签 sr=0.01）
      //   会被 3a-1b 误判 scan，漫画 Producer 信号压过页码式书签的误判。
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
            : `高密度逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)})+强漫画Producer(${(s.producer as string).slice(0, 30)}) → 漫画`
        };
      }
      // 3a-1d（任务39）：黑白图片主导（gray/index > 0.5）→ 黑白扫描书。
      //   实测 985（FreePic2Pdf + gray 100% + 密度0.96）走此分支正确判 scan；
      //   彩色印刷技术书 986 rgb=100%/989 index=8% 不命中（保持 comic 现状）；
      //   强漫画组的黑白卷已被 3a-1c 前置拦截，无冲突。
      if (s.grayOrIndexImageRatio !== undefined && s.grayOrIndexImageRatio > GRAY_IMAGE_SCAN_RATIO) {
        return {
          shape: 'scan',
          contentType: 'illustrated',
          isComic: false,
          chapterMode: 'outline',
          reason: `高密度逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)})但图片为黑白主导(灰度/索引${Math.round(s.grayOrIndexImageRatio * 100)}%>${Math.round(GRAY_IMAGE_SCAN_RATIO * 100)}%) → 黑白扫描书`
        };
      }
      // 3a-1b：标题非以"序号式"为主（如纯页码式/混杂）→ 扫描版。
      //       仅当采集到序号式占比时启用；未采集（旧信号/EPUB/MOBI）回退密度判据，
      //       兼容任务29 行为（密度 ≥ 0.8 → comic）。
      if (s.outlineSerialRatio !== undefined && s.outlineSerialRatio < OUTLINE_SERIAL_MIN_RATIO) {
        return {
          shape: 'scan',
          contentType: 'illustrated',
          isComic: false,
          chapterMode: 'outline',
          reason: `高密度逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)}≥${DENSITY_COMIC_STRONG})但标题非序号式(序号式仅${Math.round(s.outlineSerialRatio * 100)}%<${Math.round(OUTLINE_SERIAL_MIN_RATIO * 100)}%，疑超星扫描书) → 扫描版`
        };
      }
      // 3a-1e（任务41 数据驱动）：Producer 判扫描书——先验裁决优先，正则组降级冷启动兜底。
      //   先验路径：该 Producer 历史多数标签为 illustrated（扫描书标签）且置信度达标
      //   （如实测 afpl ghostscript 40/40、annasarchive 54/54）→ scan；
      //   先验否决：先验指向 comic/text → 不判扫描书；
      //   兜底路径：无先验时走 SCAN_PRODUCER_RES 正则组（Ghostscript/zlib/AnnasArchive）。
      //   兜在 comic 兜底之前：Ghostscript + 高密度书签 + 序号式标题（3a-1b 不拦）
      //   的扫描书会被误判 comic，此分支保住。
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
            : `高密度逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)})+扫描书Producer(${(s.producer as string).slice(0, 30)}) → 扫描书`
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
    // 3a-2：中密度(0.5~0.8) + 每页恰好一整图（图密度 0.9~1.9）→ 整页图漫画
    //       （书签略稀但每页一图，形态仍是整页图漫画；扫描技术书混排多图不命中）
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
    // 3a-3（原 P2-4 保留，处理"中密度 + 非整页图"场景）：书签标题多为真章节名
    //       （页码式占比 ≤ 0.8）→ 扫描版/图文书的逐页书签，走 outline 分章保真目录。
    //       占比未采集（undefined）时不干预，落到下方 comic 兜底。
    if (s.outlinePageStyleRatio !== undefined && s.outlinePageStyleRatio <= OUTLINE_PAGE_STYLE_MIN_RATIO) {
      return {
        shape: 'scan',
        contentType: 'illustrated',
        isComic: false,
        chapterMode: 'outline',
        reason: `逐页书签(${s.outlineCount}/${p}=${fmt(outlineDensity)})但标题多为章节名(页码式仅${Math.round(s.outlinePageStyleRatio * 100)}%≤${Math.round(OUTLINE_PAGE_STYLE_MIN_RATIO * 100)}%) → 扫描版(按outline分章)`
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
  // 3b-0（任务39 实测新增）：无目录 + 无字页 + 黑白图片主导 + 扫描工具 Producer → 黑白扫描书。
  //     实测 979（FreePic2Pdf 1.26 + index 99.9%）/992（FreePic2Pdf_Lib v2.19 + gray 96%）
  //     /995（FreePic2Pdf 1.07 + gray 99.6%）三本误判 comic 的技术书**均无书签**、
  //     走 3b（无目录+无字页+每页全页图 → comic）而非 3a-1，故黑白复核须前置到 3b。
  //     ⚠️ 黑白图片主导不能单独作判据（黑白漫画同样命中：哆啦A梦大长篇台版
  //     gray 90-100%/藤子F大全集黑白卷 index 100%），必须叠加"扫描工具 Producer"
  //     收窄：iTextSharp/Acrobat图片转换/AnnasArchive 组及无 Producer 的黑白漫画
  //     不命中，维持 comic（全库 243 本实测零误伤）；FreePic2Pdf 的真漫画
  //     （奇天烈/超能力魔美）为 rgb 全彩，亦不命中。
  // 3b-0a. 无目录 + 无字页 + 强扫描 Producer（Ghostscript/zlib）→ 扫描书
  //     v2（用户反馈纠错）：不限颜色——实测 989《PHP5与MySQL5从入门到精通》
  //     （Ghostscript 8.54 + rgb 彩色印刷 + 无书签）被 3b 误判 comic，
  //     彩色印刷技术书同样需要拦截。Ghostscript 组其余 38 本均正确为
  //     illustrated，本分支判 scan 与其一致，无回退风险。
  //     任务41 数据驱动：先验裁决优先（dominant=illustrated 且置信度达标，如
  //     annasarchive 54/54 → 彩色系养生书 718/930 由本分支不限颜色拦截）；
  //     无先验回退 SCAN_PRODUCER_RES 正则组。
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
        : `无目录+无字页+强扫描Producer(${(s.producer as string).slice(0, 24)}) → 扫描书`
    };
  }
  // 3b-0b. 无目录 + 无字页 + 黑白图片主导 + 扫描工具 Producer（FreePic2Pdf/
  //     Ghostscript/zlib/AnnasArchive）→ 黑白扫描书
  //     实测 979（FreePic2Pdf+index99%）/992（FreePic2Pdf_Lib+gray94%）/
  //     /995（FreePic2Pdf 1.07 + gray 99.6%）三本误判 comic 的技术书**均无书签**、
  //     走 3b（无目录+无字页+每页全页图 → comic）而非 3a-1，故黑白复核须前置到 3b。
  //     ⚠️ 黑白图片主导不能单独作判据（黑白漫画同样命中：哆啦A梦大长篇台版
  //     gray 90-100%/藤子F大全集黑白卷 index 100%），必须叠加"扫描工具 Producer"
  //     收窄：iTextSharp/Acrobat图片转换 组及无 Producer 的黑白漫画
  //     不命中，维持 comic（全库 243 本实测零误伤）；FreePic2Pdf 的真漫画
  //     （奇天烈/超能力魔美）为 rgb 全彩，亦不命中。
  //     v2：AnnasArchive 加入工具组——27 本养生书（gray/jbig2+无书签）由此拦截。
  //     任务41 数据驱动：先验裁决优先——**高置信非 comic 先验**（dominant 为
  //     illustrated/text）视为"该 Producer 历史上不产漫画"，在"黑白主导 +
  //     无目录 + 无字页"收窄条件下判 scan；dominant=comic 的先验（itextsharp
  //     等）则保护黑白漫画不误伤。这样新扫描工具（如未来某 DjVu 批量转换器）
  //     积累 5+ 本非 comic 历史后自动被本分支拦截，无需改正则。
  //     无先验（缺失或 dominant=null 小样本混合）回退 SCAN_TOOL_PRODUCER_RES
  //     正则组——#974 回归防护（pdfFactory Pro 仅 3 本历史曾被"非 comic 即拦"
  //     误判 scan）；FreePic2Pdf 混合组的黑白书由正则兜底拦截（它本就在正则组，
  //     979/992/995 行为不变）。
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
        : `无目录+无字页+黑白图片主导(灰度/索引${Math.round(s.grayOrIndexImageRatio * 100)}%)+扫描工具Producer(${(s.producer as string).slice(0, 24)}) → 黑白扫描书`
    };
  }
  // 3b. 无目录 + 无字页 + 每页全页图（约 1 张/页）：纯图片漫画无误判风险
  if (s.outlineCount === 0 && s.textPageRatio < 0.05 && s.imageDensity >= 0.8 && s.imageDensity <= 5) {
    return {
      shape: 'comic',
      contentType: 'comic',
      isComic: true,
      chapterMode: 'per-page',
      reason: `无目录+无字页(${fmt(s.textPageRatio)})+每页全页图(${fmt(s.imageDensity)}) → 漫画`
    };
  }
  // 3c. 无目录 + 无字页 + 跨页/混排特征：散装漫画
  if (s.outlineCount === 0 && s.textPageRatio < 0.05 && (s.hasMixedOrientation || s.pageRatioStdDev > 0.02)) {
    return {
      shape: 'comic',
      contentType: 'comic',
      isComic: true,
      chapterMode: 'per-page',
      reason: `无目录+无字页+跨页特征(混排:${s.hasMixedOrientation}/比例σ${fmt(s.pageRatioStdDev, 3)}) → 漫画`
    };
  }

  /* ---- 兜底：扫描版（有章节目录 / 有 OCR 文字页 的图片型内容） ---- */
  return {
    shape: 'scan',
    contentType: 'illustrated',
    isComic: false,
    chapterMode: 'page-chunk',
    reason: `少文字(${fmt(s.textCharsPerPage, 0)}字/页)+图片型，有目录(${s.outlineCount})或有字页(${fmt(s.textPageRatio)}) → 扫描版`
  };
}

/* ==================== 逐页书签标题模式复核（P2-4 / P2-5 3a-3） ==================== */

/** 页码式书签标题：纯数字 / "第N页" / "N页" / "第N" / "page N"（忽略大小写与空白） */
const PAGE_STYLE_TITLE_RE = /^(?:第?\s*\d+\s*页?|page\s*\d+|\d+)$/i;

/**
 * 书签标题规范化
 *
 * 部分导出器（如超星/SSReader）会在书签标题尾部附控制字符（\u0000 等），
 * 若不剥离，"1\u0000" 这类纯页码标题会因结尾非数字而无法命中页码式正则，
 * 进而被误判为序号式。此处统一剥离控制字符并折叠空白。
 */
export function normalizeOutlineTitle(title: string): string {
  let out = '';
  for (const ch of String(title)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // 跳过控制字符
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 判断单个书签标题是否为页码式命名（"670"/"第670页"/"page 670"）
 *
 * 真漫画一章一图，逐页书签的标题也可能是页码；但超星扫描书同样可能用页码作逐页书签。
 * 注意：部分漫画的标题是导出器序号式（"1_001"/"_SDK08-_0000"），既非页码式也非
 * 真章节名——由 classifyOutlineTitleKind 归入 serial。
 */
export function isPageStyleOutlineTitle(title: string): boolean {
  return PAGE_STYLE_TITLE_RE.test(normalizeOutlineTitle(title));
}

/* ==================== 书签标题语义三分法（任务37，修复 3a-1 盲区） ==================== */

/** 书签标题形态：page=纯页码式；serial=导出器序号式（漫画强信号）；semantic=真章节名 */
export type OutlineTitleKind = 'page' | 'serial' | 'semantic';

/**
 * 导出器序号式书签标题（真漫画逐页书签特征）
 *
 * 实测形态归纳（任务31/37 在 93 本存量书上的实测）：
 *   - 哆啦A梦[短篇]：`1_001` / `1_002`（数字_数字）
 *   - 藤子F不二雄大全集：`Doraemon01_000`（字母+数字_数字）
 *   - 灌篮高手：`_SDK08-_0000`（下划线/短横分隔的混合编号）
 *
 * 判据（刻意精确到"含数字且非纯数字 + 字符集受限"）：
 *   - 含至少一个数字（(?=.*\d)）
 *   - **不是**纯数字（(?!\d+$)）——纯数字由页码式在更早分支处理
 *   - 整串仅由 A-Za-z0-9_.- 组成（不含中文/全角/空白）→ 天然排除"第一章 xxx"
 * 这样 "670"→page、"1_001"/"_SDK08-_0000"/"p001"/"img_001"→serial、
 * "第一章 走出神墓"/"1.1.1 bug与漏洞"→semantic，实测 11 本真漫画 100% 命中 serial。
 */
const SERIAL_TITLE_RE = /^(?=.*\d)(?!\d+$)[A-Za-z0-9_.-]{1,40}$/;

/** 漫画话数编号："第1话"/"第3回"/"第2集"（区别于"第1章/篇/节"的真章节名，判 serial） */
const SERIAL_EPISODE_RE = /^第\s*\d+\s*[话回集]$/;

/**
 * 三分法判定单个书签标题形态（供 PDF 信号采集 / 决策树复核 / 脚本复用）
 *
 * @param title 书签标题原文
 * @returns 'page' | 'serial' | 'semantic'
 */
export function classifyOutlineTitleKind(title: string): OutlineTitleKind {
  const t = normalizeOutlineTitle(title);
  if (!t) return 'semantic'; // 空标题保守归语义式（避免误判漫画）
  if (PAGE_STYLE_TITLE_RE.test(t)) return 'page';
  if (SERIAL_EPISODE_RE.test(t)) return 'serial';
  if (SERIAL_TITLE_RE.test(t)) return 'serial';
  return 'semantic';
}

/**
 * 统计书签标题中语义式（真章节名）占比
 * @returns 0-1；空列表返回 undefined（未采集，判定不干预）
 */
export function computeOutlineSemanticRatio(nodes: readonly { title: string }[]): number | undefined {
  if (nodes.length === 0) return undefined;
  let hits = 0;
  for (const node of nodes) {
    if (classifyOutlineTitleKind(node.title) === 'semantic') hits++;
  }
  return hits / nodes.length;
}

/**
 * 统计书签标题中导出器序号式占比
 * @returns 0-1；空列表返回 undefined（未采集，判定不干预）
 */
export function computeOutlineSerialRatio(nodes: readonly { title: string }[]): number | undefined {
  if (nodes.length === 0) return undefined;
  let hits = 0;
  for (const node of nodes) {
    if (classifyOutlineTitleKind(node.title) === 'serial') hits++;
  }
  return hits / nodes.length;
}

/**
 * 计算书签标题为页码式命名的占比（DocumentSignals.outlinePageStyleRatio 的采集入口）
 *
 * P2-5 后该占比仅作"中密度（0.5~0.8）逐页书签 + 非整页图"场景的第三层复核（3a-3）：
 * 占比 > OUTLINE_PAGE_STYLE_MIN_RATIO（标题多为页码式）→ 维持 comic；
 * 占比不足（标题多为真章节名，且/或存在多层书签树）→ 扫描版/图文书的逐页书签，
 * 走 outline 分章保住真目录。高密度（≥0.8，一章一页的整页图漫画）由密度判据先行
 * 判定，不进入本复核。多层结构（depth>0）是扫描版的强辅助信号，但为避免误伤
 * "卷层级 + 逐页页码式书签"的真漫画，仅作人工核对参考、不参与自动判定。
 *
 * @param nodes 书签节点列表（只需 title 字段，PDF 侧直接传 FlatOutlineNode[]）
 * @returns 页码式标题占比（0-1）；空列表返回 undefined（未采集，判定不干预）
 */
export function computeOutlinePageStyleRatio(nodes: readonly { title: string }[]): number | undefined {
  if (nodes.length === 0) return undefined;
  let hits = 0;
  for (const node of nodes) {
    if (isPageStyleOutlineTitle(node.title)) hits++;
  }
  return hits / nodes.length;
}

/* ==================== 图计数扫描外推（修复大文件失真） ==================== */

/**
 * 按二进制扫描覆盖率外推图片总数
 *
 * 问题：原实现只扫描前 20MB（BINARY_SCAN_LIMIT）。实测 243 本 PDF 中
 * 93 本 > 50MB（中位 44.8MB），大书的图片计数被严重低估 ——
 * 例如哆啦A梦 670 页真实图密度 ≈ 1，仅扫前段算出 0.29，导致后续维度判断失真。
 *
 * 修复：按扫描覆盖率线性外推。PDF 图片对象在文件中分布相对均匀
 * （每页一组对象），线性外推误差可控；设 pageCount*5 上限防止极端高估。
 *
 * @param rawCount 扫描范围内的原始图片计数
 * @param scannedBytes 实际扫描字节数
 * @param totalBytes 文件总字节数
 * @param pageCount 页数（用于上限约束）
 */
export function extrapolateImageCount(
  rawCount: number,
  scannedBytes: number,
  totalBytes: number,
  pageCount: number
): number {
  if (totalBytes <= 0 || scannedBytes <= 0) return rawCount;
  const coverage = Math.min(1, scannedBytes / totalBytes);
  if (coverage >= 0.99) return rawCount; // 已全量扫描，无需外推
  const extrapolated = Math.round(rawCount / coverage);
  // 上限：每页至多 5 张图（扫描页 1-3 张，极端情况 5 张足够）
  return Math.min(extrapolated, Math.max(pageCount, 1) * 5);
}
/* ==================== 图片颜色模式二进制扫描（任务39） ==================== */

/** 图片对象字典窗口半径（字节）：图片 XObject 字典形如
 *  `<< /Type /XObject /Subtype /Image /Width .. /ColorSpace /DeviceRGB .. /Filter .. >>`，
 *  键顺序不定，取 /Subtype /Image 命中点前后各 300 字节足以覆盖整个字典。 */
const IMAGE_DICT_WINDOW_BYTES = 300;
/** 黑白系色彩空间标记（DeviceGray/CalGray = 灰度；Indexed = 调色板索引） */
const GRAY_COLORSPACE_RE = /\/DeviceGray|\/CalGray/;
/** 索引色标记（单列判定，避免与 DeviceGray 的窗口重叠计数） */
const INDEXED_COLORSPACE_RE = /\/Indexed/;
/** 彩色系色彩空间标记（DeviceRGB/CalRGB/DeviceCMYK） */
const COLOR_COLORSPACE_RE = /\/DeviceRGB|\/CalRGB|\/DeviceCMYK/;
/** DjVu 转换特征编码（JPX/JBIG2） */
const DJVU_FILTER_RE = /\/JPXDecode|\/JBIG2Decode/;

/**
 * 二进制扫描图片颜色模式（任务39：DocumentSignals.grayOrIndexImageRatio / djvuEncoded 的采集入口）
 *
 * 对每个 /Subtype /Image 命中点取前后窗口（默认 ±300 字节），在窗口内查找
 * ColorSpace 标记归类（gray/index/彩色/未知），返回黑白占比与 DjVu 编码特征。
 * 与 extrapolateImageCount 共享"二进制扫描 PDF 对象"的扩展点（v30 引入），
 * 零解码成本；实测与 pdfimages -list 的 color 列高度一致：
 *   979 index=99.9%→ratio 0.99、992 gray=96%→0.94、995 gray=99.6%→0.97、
 *   985 gray=100%→1.00、全彩漫画 rgb=100%→0.00。
 *
 * 注意：SMask（软蒙版，DeviceGray 的独立 /Subtype /Image 对象）会被一并统计，
 * 主图 rgb + smask gray 的 DjVu 书（如 0day）ratio ≈ 0.33-0.5，天然处于阈值
 * 之下不触发黑白判据——与"彩色扫描书不该判黑白"的语义一致。
 *
 * @param buf 完整文件字节（内部与生产一致只扫前 20MB）
 * @param scanLimit 二进制扫描上限（与 pdf-parser 的 BINARY_SCAN_LIMIT 一致，默认 20MB）
 */
export function scanImageColorStats(
  buf: Buffer,
  scanLimit = 20 * 1024 * 1024
): { grayOrIndexImageRatio?: number; djvuEncoded: boolean; imageObjects: number } {
  const scanBuf = buf.length > scanLimit ? buf.subarray(0, scanLimit) : buf;
  // 收集全部 /Subtype /Image 命中点（与 pdf-parser 的 rawImageCount 同口径，含紧凑格式）
  const patterns = ['/Subtype /Image', '/Subtype/Image'];
  const positions: number[] = [];
  for (const pat of patterns) {
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

  let gray = 0;
  let indexed = 0;
  let color = 0;
  let unknown = 0;
  let djvu = 0;
  for (const pos of positions) {
    const start = Math.max(0, pos - IMAGE_DICT_WINDOW_BYTES);
    const end = Math.min(scanBuf.length, pos + IMAGE_DICT_WINDOW_BYTES);
    const win = scanBuf.subarray(start, end).toString('latin1');
    if (GRAY_COLORSPACE_RE.test(win)) gray++;
    else if (INDEXED_COLORSPACE_RE.test(win)) indexed++;
    else if (COLOR_COLORSPACE_RE.test(win)) color++;
    else unknown++;
    if (DJVU_FILTER_RE.test(win)) djvu++;
  }
  const total = gray + indexed + color + unknown;
  return {
    grayOrIndexImageRatio: total > 0 ? (gray + indexed) / total : undefined,
    djvuEncoded: djvu > 0,
    imageObjects: positions.length
  };
}
