/**
 * 文件解析器共享类型和接口
 *
 * 从 file-parser.ts 拆分而来，包含所有格式解析器共享的类型定义。
 */

import type { DocumentSignals } from './document-classifier';

/**
 * 文件解析器基础接口
 *
 * 定义所有格式解析器（TXT/EPUB/MOBI/PDF）的统一接口，
 * 上层 importer.ts 通过 FileParser 接口统一调用，无需关心具体格式。
 */

/** 章节索引（解析器产出，用于建立 chapters 表索引） */
export interface ChapterIndex {
  /** 章节序号（从 0 开始） */
  index: number;
  /** 章节标题 */
  title: string;
  /** 文件字节偏移（TXT 为字节偏移；EPUB 为 spine 序号） */
  fileOffset: number;
  /** 文件字节长度（TXT 为字节长度；EPUB 为 entry 未压缩大小） */
  fileLength: number;
  /** URL/entry name（EPUB 为 ZIP entry name；TXT/MOBI/PDF 可选） */
  url?: string;
  /** 内容类型：'text'=文本章节，'image'=图片章节（漫画），'markdown'=Markdown渲染章节，'illustrated'=图文章节 */
  contentType?: 'text' | 'image' | 'markdown' | 'illustrated';
  /** 所属卷标题（如"第一卷 初入江湖"），无卷层级时为 null */
  volume?: string | null;
  /** 是否按字符偏移读取（EPUB单spine回退分章时为true）
   *  true 时 readEpubChapter 读取整个 entry HTML 转纯文本后按 fileOffset/fileLength 字符偏移截取 */
  isCharOffset?: boolean;
}

/** 解析结果（parse() 返回） */
export interface ParsedBook {
  /** 书名 */
  title: string;
  /** 作者 */
  author: string;
  /** 简介/描述 */
  description: string;
  /** 编码（TXT 为检测到的编码；EPUB 固定 'UTF-8'） */
  encoding: string;
  /** 章节索引列表 */
  chapters: ChapterIndex[];
  /** 是否为漫画（图片为主的书）—— 向后兼容字段，等价于 contentType === 'comic' */
  isComic?: boolean;
  /** v21 新增：内容三分类 'text'=文本, 'illustrated'=图文, 'comic'=漫画。
   *  优先使用此字段；isComic 保留向后兼容（= contentType === 'comic'）。 */
  contentType?: 'text' | 'illustrated' | 'comic';
  /** P3 分类反馈闭环：导入时的统一文档特征向量（存入 custom_meta，供用户修正后 k-NN 参考） */
  classifySignals?: DocumentSignals;
  /** Layer 3 内容特征（parsePdf/parseEpub 等解析器提取的内容级数据，供随机森林使用） */
  contentFeatures?: {
    totalTextLength: number;
    pageCount: number;
    imageCount: number;
  };
  /** v29 新增：系列名（漫画 ComicInfo.xml 的 Series，或导入层文件名模式兜底提取）。
   *  格式无关通用字段——系列书在书架内按"系列 · 第N卷"区分与自然排序。 */
  series?: string;
  /** v29 新增：系列内序号（ComicInfo.xml 的 Number 优先、Volume 兜底；文件名提取的卷号）。
   *  REAL 语义：部分漫画 Number 含小数（如 "2.5"）。 */
  seriesNumber?: number;
  /** v29 新增：系列总数（ComicInfo.xml 的 Count，"第N卷/共M卷"展示用） */
  seriesTotal?: number;
  /** v29 新增：ComicInfo.xml 全字段存档（AnansiProject 标准白名单字段 → 文本值）。
   *  导入层写入 custom_meta.comic_info，供详情页/未来功能使用，防止元数据提取后丢弃。 */
  comicInfo?: Record<string, string>;
}

/**
 * 文件解析器接口
 *
 * 各格式解析器（TxtParser/EpubParser/MobiParser/PdfParser）实现此接口，
 * 上层通过 FileParser 接口统一调用 parse() 和 readChapter()。
 */
export interface FileParser {
  /**
   * 解析文件，建立章节索引
   *
   * @param filePath 文件绝对路径
   * @param onProgress 解析进度回调（0~1）
   * @param originalFileName 原始文件名（拖拽导入时可能与 filePath 不同）
   * @returns 解析结果（元数据 + 章节索引）
   */
  parse(filePath: string, onProgress?: (p: number) => void, originalFileName?: string): Promise<ParsedBook>;

  /**
   * 按需读取单章正文
   *
   * @param filePath 文件绝对路径
   * @param chapter 章节索引（含 fileOffset/fileLength/url 等定位信息）
   * @param imageDir 图片保存目录（绝对路径，可选）。传入则提取图片并保留占位标记
   * @returns 章节正文文本（可能包含 [IMG:file:///...] 图片占位标记）
   */
  readChapter(filePath: string, chapter: ChapterIndex, imageDir?: string): Promise<string>;

  /**
   * 读取图片章节，提取图片到指定目录
   *
   * 仅 EPUB/MOBI 解析器实现此方法（漫画模式）。
   * TXT/PDF 解析器不支持，调用方应先判断 content_type 是否为 'image'。
   *
   * @param filePath 文件绝对路径
   * @param chapter 章节索引（含 fileOffset/fileLength/url 等定位信息）
   * @param imageDir 图片保存目录（绝对路径）
   * @returns 图片文件路径列表（绝对路径）
   */
  readChapterImages?(filePath: string, chapter: ChapterIndex, imageDir: string): Promise<string[]>;
}

/** 检测到的格式类型 */
export type DetectedFormat =
  'txt' | 'epub' | 'mobi' | 'pdf' | 'cbz' | 'cbr' | 'cb7' | 'cbt' | 'zip' | 'rar' | '7z' | 'tar' | 'image' | 'unknown';

/** 元信息提取结果 */
export interface BookMeta {
  title: string;
  author: string;
  /** 简介/描述（从文件头部"简介："等关键词提取，无则为空字符串） */
  description: string;
}

/* ==================== TXT 解析模式（小说/Markdown/纯文本） ==================== */

/** TXT 文件解析模式 */
export type ParseMode = 'auto' | 'novel' | 'markdown' | 'plain';

/**
 * EPUB 解析结果（扩展 ParsedBook，添加固定布局标记）
 *
 * 固定布局 EPUB（绘本/画册）每页是固定尺寸的图片，
 * 解析时需要保留原始 HTML 排版，不做段落重排。
 * 对标 Apple Books 对固定布局 EPUB 的处理方式。
 */
export interface EpubParsedBook extends ParsedBook {
  /** 是否为固定布局 EPUB（绘本/画册，每页固定尺寸，保留原始排版） */
  isFixedLayout?: boolean;
}

/**

 * htmlToPlainText 选项
 */
export interface HtmlToPlainTextOptions {
  /**
   * 图片 src 替换回调。
   *
   * 在去 HTML 标签前，对每个 `<img src="...">` / `<image xlink:href="...">` 调用此回调，
   * 返回本地绝对路径则替换为 `\n[IMG:file:///绝对路径]\n` 占位标记，
   * 返回 null 则去掉该图片（保留为空）。
   *
   * 用于文字小说插图保留：解析器提取图片到磁盘，渲染时用 file:/// 协议加载。
   */
  replaceImage?: (src: string) => string | null;
  /**
   * P1-2修复：内联 SVG 矢量图形替换回调。
   *
   * 在去 HTML 标签前，对每个不含 <image> 子标签的内联 `<svg>...</svg>` 调用此回调，
   * 传入完整的 SVG 标签内容，返回本地绝对路径则替换为 `[IMG:file:///路径]` 占位标记，
   * 返回 null 则保留 SVG 原始 HTML（不丢失矢量图形信息）。
   *
   * 用于保留 EPUB 中的内联矢量图形（图标、插图、装饰图等），
   * 避免 `<svg><path d="..."/></svg>` 被去标签时丢弃。
   */
  replaceInlineSvg?: (svgContent: string, index: number) => string | null;
}

/** 漫画格式类型 */
export type ComicFormat = 'cbz' | 'cbr' | 'cb7' | 'cbt' | 'zip' | 'rar';
