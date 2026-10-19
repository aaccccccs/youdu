/**
 * TXT 解析器
 *
 * 从 file-parser.ts 拆分而来。
 */

import { createReadStream, statSync, promises as fsPromises } from 'fs';
import { basename } from 'path';
import * as iconv from 'iconv-lite';
import { detectEncoding, decodeBuffer } from '../../utils';
import type { ChapterIndex, ParsedBook, FileParser, BookMeta, ParseMode } from './types';
import {
  matchChapterTitle,
  extractChapterTitle,
  isVolumeLine,
  extractVolumeTitle,
  isChapterLine,
  EMBEDDED_CHAPTER_RE,
  extractVolumeFromTitle
} from './chapter-patterns';

/* ==================== txt-parser.ts（TXT解析器） ==================== */
/**
 * TXT 深度解析器
 *
 * 核心设计：流式分章建索引，不全量入内存。
 *
 * 功能模块：
 * 1. 书名/作者提取（文件名 + 文件头部元信息）
 * 2. 流式逐行扫描（Buffer 层面找换行符，每行单独解码，确保字节偏移精确）
 * 3. 正则匹配章节标题，建立章节索引（只存字节偏移+长度，不存正文）
 * 4. 按需读取章节正文（fs.createReadStream 按字节范围读取）
 * 5. 内容清洗（合并空行、统一缩进、去广告）
 * 6. 分章兜底（无章节标题的 TXT 按字数均分）
 *
 * 导出：
 * - extractMeta(fileName, headContent): { title, author, description }
 * - parseTxt(filePath, onProgress?): Promise<ParsedBook>
 * - readChapter(filePath, encoding, fileOffset, fileLength): Promise<string>
 * - fallbackChunk(filePath, encoding, avgChars?): Promise<ChapterIndex[]>
 * - cleanContent(raw): string
 * - TxtParser 类（实现 FileParser 接口）
 */

/* ==================== 错误定义 ==================== */

/** TXT 解析自定义错误（友好提示 + 保留原始 cause） */
export class TxtParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'TxtParseError';
  }
}

/* ==================== 书名/作者提取 ==================== */

/**
 * 从文件名解析书名（兜底用，不扫描内容头部）
 *
 * 覆盖格式：
 * - 《书名》...           → 书名
 * - 书名 - 作者 / 书名 — 作者 / 书名_作者 → 书名
 * - 无分隔符             → 返回 null，由调用方用去扩展名文件名兜底
 *
 * @param fileName 文件名（含扩展名）
 */
function parseFileNameTitle(fileName: string): string | null {
  // 去除扩展名（处理双扩展名如 .txt.TXT）
  // 注意：不能用 .[^.]+$ 因为文件名中可能有 . 分隔符（如 "001.[起点vip完结]《书名》.txt"）
  let nameWithoutExt = fileName
    .replace(/\.[a-zA-Z]{1,5}$/, '')
    .replace(/\.[a-zA-Z]{1,5}$/, '')
    .trim();
  if (!nameWithoutExt) return null;

  // 《书名》格式
  const m1 = nameWithoutExt.match(/《(.+?)》/);
  if (m1) return m1[1].trim();

  // "书名[xxx]作者：yyy" 格式 — 如"龙蛇演义[完本]作者：梦入神机"
  //   [完本]/[全本]/[精校]等是版本标注，作者：yyy是作者后缀
  //   约束：方括号内是版本标注关键词，后面紧跟"作者："或"作者:"
  const m1c = nameWithoutExt.match(
    /^(.+?)\[(?:完本|全本|精校|精校版|校对版|完结|完整|全文)\]\s*(?:作者|著作)[：:]\s*(.+)$/
  );
  if (m1c) return m1c[1].trim();

  // "书名⊙作者⊙备注" / "书名⊙作者" 格式 — ⊙分隔符
  //   见于轻小说收集格式：超次元直播⊙云巅流风⊙至245章
  //   第一部分是书名，第二部分是作者，第三部分（如有）是备注
  if (nameWithoutExt.includes('⊙')) {
    const parts = nameWithoutExt.split('⊙').map((p) => p.trim());
    if (parts.length >= 2 && parts[0].length >= 2) {
      return parts[0];
    }
  }

  // （作者）书名 格式 — 如"（白阳）生活在公寓里的二货"→"生活在公寓里的二货"
  //   约束：括号内2-6字且不含版本标注关键词（版/全本/完结/精校/校对等）
  const m1a = nameWithoutExt.match(/^[（(]([^（）()]{2,6})[）)]\s*(.+)$/);
  if (m1a && !/版|全本|完结|完本|精校|校对|全文|完整/.test(m1a[1])) {
    return m1a[2].trim();
  }

  // "书名 作者：xxx" / "书名 作者: xxx" / "书名 作者 xxx" 格式
  //    如"长生界  作者：辰东"→"长生界"、"神墓 作者 辰东"→"神墓"
  const m1b = nameWithoutExt.match(/^(.+?)\s+(?:作者|著作)[：:]?\s*.+$/);
  if (m1b) return m1b[1].trim();

  // 分隔符切分："书名 - 作者" / "书名 — 作者" / "书名_作者"
  const m2 = nameWithoutExt.match(/^(.+?)\s*[-—_]\s*(.+)$/);
  if (m2) return m2[1].trim();

  // 纯书名格式：去除常见前缀/后缀后作为书名返回
  //   见于"异界之板砖横行.txt"→"异界之板砖横行"
  //   见于"喜马拉雅听书 老衲要还俗  分享.txt"→"老衲要还俗"
  let cleaned = nameWithoutExt
    .replace(/^喜马拉雅听书\s*/, '')
    .replace(/^【[^】]+】\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\s*分享\s*$/, '')
    .replace(/\s*完本\s*$/, '')
    .replace(/\s*校对版\s*$/, '')
    .replace(/\s*精校版\s*$/, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .trim();
  if (cleaned && cleaned.length >= 2) {
    return cleaned;
  }

  return null;
}

/**
 * 从文件名解析作者（兜底用，精确格式匹配，避免"著"/"by"误判）
 *
 * 覆盖格式：
 * - 《书名》作者：xxx / 著作：xxx → xxx
 * - 文/xxx / 文／xxx              → xxx
 * - xxx 著（"著"在末尾，前面有空格）→ xxx
 * - 书名 - 作者 / 书名 — 作者 / 书名_作者 → 作者
 *
 * 不覆盖（避免误判）：
 * - "著名小说.txt"   → 不应把"名小说"当作者
 * - "baby story.txt" → 不应把"story"当作者
 *
 * @param fileName 文件名（含扩展名）
 */
function parseFileNameAuthor(fileName: string): string | null {
  // 去除扩展名（处理双扩展名如 .txt.TXT）
  // 注意：不能用 .[^.]+$ 因为文件名中可能有 . 分隔符（如 "001.[起点vip完结]《书名》.txt"）
  let nameWithoutExt = fileName
    .replace(/\.[a-zA-Z]{1,5}$/, '')
    .replace(/\.[a-zA-Z]{1,5}$/, '')
    .trim();
  if (!nameWithoutExt) return null;

  // （作者）书名 格式 — 如"（白阳）生活在公寓里的二货"→作者"白阳"
  //   约束：括号内2-6字且不含版本标注关键词
  const m0 = nameWithoutExt.match(/^[（(]([^（）()]{2,6})[）)]\s*(.+)$/);
  if (m0 && !/版|全本|完结|完本|精校|校对|全文|完整/.test(m0[1])) {
    return m0[1].trim().replace(/\s*\(\d+\)\s*$/, '');
  }

  // 《书名》作者：xxx 格式
  const m1 = nameWithoutExt.match(/(?:作者|著作)[：:]\s*(.+)$/);
  if (m1) return m1[1].trim().replace(/\s*\(\d+\)\s*$/, '');

  // "书名[xxx]作者：yyy" 格式
  const m0b = nameWithoutExt.match(
    /^(.+?)\[(?:完本|全本|精校|精校版|校对版|完结|完整|全文)\]\s*(?:作者|著作)[：:]\s*(.+)$/
  );
  if (m0b) return m0b[2].trim().replace(/\s*\(\d+\)\s*$/, '');

  // "书名⊙作者⊙备注" / "书名⊙作者" 格式 — ⊙分隔符
  if (nameWithoutExt.includes('⊙')) {
    const parts = nameWithoutExt.split('⊙').map((p) => p.trim());
    if (parts.length >= 2 && parts[1].length >= 2) {
      return parts[1].replace(/\s*\(\d+\)\s*$/, '').trim();
    }
  }

  // 文/xxx 或 文／xxx 格式
  const m2 = nameWithoutExt.match(/文[\/／](.+)$/);
  if (m2) return m2[1].trim().replace(/\s*\(\d+\)\s*$/, '');

  // xxx 著 格式（"著"必须在末尾，且前面有空格分隔，避免"著名小说"误判）
  const m3 = nameWithoutExt.match(/^(.+?)\s+著$/);
  if (m3) return m3[1].trim().replace(/\s*\(\d+\)\s*$/, '');

  // 分隔符切分：书名 - 作者 / 书名 — 作者 / 书名_作者
  const m4 = nameWithoutExt.match(/^(.+?)\s*[-—_]\s*(.+)$/);
  if (m4) return m4[2].trim().replace(/\s*\(\d+\)\s*$/, '');

  return null;
}

/* ==================== 元数据提取辅助函数 ==================== */

/**
 * 判断是否为广告行（需跳过，不参与元数据提取）
 *
 * 通用化增强：覆盖 36 个真实 TXT 文件中出现的各种广告/免责声明/制作信息格式
 *
 * 覆盖：
 * - 手机txt小说、小说排行榜、最新更新小说、提供下载
 * - http(s) URL、www.xxx.com
 * - 免责声明/免责申明
 * - 标签/状态/声明行
 * - 制作信息：本书由xxx整理制作
 * - 下载书籍请到
 * - 更多精校小说尽在（含"知轩藏书"等变体）
 * - 本作品来自互联网
 * - 版权归作者所有/版权归原作者所有
 * - 本站电子书
 * - 仅供学习交流使用
 * - 声明：本书为xxx
 * - 笔下文学整理收藏
 * - 用户上传之内容开始
 * - 草莓群机器人/香蕉群机器人（资源分享群广告）
 * - =====/----- 等纯分隔线
 */
export function isAdLine(line: string): boolean {
  const l = line.trim();
  if (!l) return true; // 空行视为需跳过
  if (/^手机txt/i.test(l)) return true;
  if (/小说排行榜|最新更新小说|提供下载/i.test(l)) return true;
  if (/^https?:\/\//i.test(l)) return true;
  if (/www\./i.test(l) && /\.com/i.test(l)) return true;
  // 免责声明/申明
  if (/^免责(声明|申明)/.test(l)) return true;
  // 标签/状态/声明行（元数据提取时跳过，非书名/作者/简介）
  if (/^(标签|状态|声明)[：:]/.test(l)) return true;
  // 制作信息
  if (/本书由.*整理制作/.test(l)) return true;
  // 下载书籍请到
  if (/^下载书籍请到/.test(l)) return true;
  // 更多精校小说尽在（含"知轩藏书"等变体）
  if (/^更多精校小说尽在/.test(l)) return true;
  // 精校小说尽在
  if (/精校小说尽在/.test(l)) return true;
  // 本作品来自互联网
  if (/本作品来自互联网/.test(l)) return true;
  // 版权归作者所有/版权归原作者所有
  if (/版权归.*所有/.test(l)) return true;
  // 本站电子书
  if (/本站电子书/.test(l)) return true;
  // 仅供学习交流使用
  if (/仅供学习交流使用/.test(l)) return true;
  // 声明：本书为xxx（如"声明：本书为无限小说网..."）

  if (/^声明[：:]/.test(l)) return true;
  // 笔下文学整理收藏
  if (/笔下文学.*整理收藏/.test(l)) return true;
  // 用户上传之内容开始
  if (/用户上传之内容开始/.test(l)) return true;
  // 如有侵权，请联系我们删除
  if (/如有侵权.*请联系.*删除/.test(l)) return true;
  // 资源来自于网络
  if (/^资源来自于网络/.test(l)) return true;
  // 草莓群机器人/香蕉群机器人（资源分享群广告）
  if (/[草蕉]莓群机器人|香蕉群机器人/.test(l)) return true;
  // 纯分隔线（===、---、____等连续3+个相同字符）
  if (/^[=\-_*~]{3,}$/.test(l)) return true;
  // 纯破折号分隔线（——连续3+个）
  if (/^[―—]{3,}$/.test(l)) return true;
  // 纯星号分隔线（☆连续3+个）
  if (/^[☆★]{3,}$/.test(l)) return true;
  // 框线分隔线（┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ 等）
  if (/^[┏┗━]{3,}$/.test(l)) return true;
  // "------章节内容开始-------" 等分隔标记
  if (/^[=\-_*~]{2,}.*[=\-_*~]{2,}$/.test(l) && l.length < 30) return true;
  // "更多小说：" / "更多精校小说尽在" 等下载提示变体
  if (/^更多小说[：:]/.test(l)) return true;
  // "精校小说尽在河洛网" 等变体
  if (/精校小说尽在/.test(l)) return true;
  // "本电子书由xxx整理校对" 等制作信息
  if (/本电子书由.*整理校对/.test(l)) return true;
  // "版权归原作者所有" 等版权声明变体
  if (/版权归原作者.*所有/.test(l)) return true;
  // "文本仅供试读" 等使用声明
  if (/文本仅供试读/.test(l)) return true;
  // "请勿转载" / "请勿用于" 等使用声明
  if (/请勿(转载|用于)/.test(l)) return true;
  return false;
}

/**
 * 判断是否为章节标题行（用于元数据提取时识别章节边界）
 *
 * 与下方 isChapterLine(line, prevLineEmpty) 不同，此函数不需要 prevLineEmpty 参数，
 * 仅用于 extractMeta 中识别章节标题以结束简介提取。
 *
 * 通用化增强：与 chapter-patterns.ts 的 CHAPTER_PATTERNS 保持一致，
 * 支持新增的"序"单独、"正文卷"、"外传N"、"第一集"/"第一篇"、"卷X"、
 * Prologue/Epilogue、Book/Vol/Ch 等格式。
 */
function isChapterTitleLine(line: string): boolean {
  const trimmed = line.trim();
  // 中文格式
  if (
    /^(第[一二三四五六七八九十百千零0-9]+[章节回卷部折话集篇]|序章?|楔子|番外篇?|前言|序言|引子|正文卷?|外传\d*|卷[一二三四五六七八九十百千零0-9]+)/.test(
      trimmed
    )
  ) {
    return true;
  }
  // 英文格式：Chapter/Section/Part/Prologue/Epilogue/Foreword/Afterword/Preface/Postscript/Book/Vol/Volume/Ch/Article
  if (
    /^(Chapter|SECTION|Part|Prologue|Epilogue|Foreword|Afterword|Preface|Postscript|Book|Vol\.?|Volume|Ch\.?|Article)\b/i.test(
      trimmed
    )
  ) {
    return true;
  }
  return false;
}

/**
 * 从指定行开始提取简介内容（直到章节标题或连续空行结束）
 *
 * 规则：
 * - 遇到章节标题行（第x章/序章/楔子/正文...）→ 结束
 * - 遇到"正文""作者自定义标签""PS："等标记 → 结束
 * - 跳过广告行
 * - 连续 2 个空行且有内容时结束
 * - 简介最多 500 字，避免提取正文
 *
 * @param lines 所有行
 * @param startIdx 开始提取的行索引
 * @returns 简介文本
 */
function extractDescriptionFromLine(lines: string[], startIdx: number): string {
  const descLines: string[] = [];
  let emptyCount = 0;

  for (let i = startIdx; i < lines.length; i++) {
    const trimmed = lines[i].trim().replace(/^[\uFEFF\u3000\s]+/, '');

    // 空行计数
    if (!trimmed) {
      emptyCount++;
      if (emptyCount >= 2 && descLines.length > 0) break; // 连续2个空行结束
      continue;
    }
    emptyCount = 0;

    // 章节标题行结束
    if (isChapterTitleLine(trimmed)) break;

    // "正文" / "作者自定义标签" / "PS：" 等结束
    if (/^(正文|作者自定义标签|PS：|PS:)/.test(trimmed)) break;

    // 跳过广告行
    if (isAdLine(trimmed)) continue;

    descLines.push(trimmed);

    // 简介最多 500 字
    if (descLines.join('').length > 500) break;
  }

  return descLines.join(' ').trim();
}

/**
 * 清理作者名（去除字数标注、版本标注等后缀）
 *
 * 覆盖：
 * - "狐尾的笔【216.01万字】" → "狐尾的笔"
 * - "xxx（校对版全本）" → "xxx"
 * - "xxx【精校版】" → "xxx"
 *
 * @param raw 原始作者名
 * @returns 清理后的作者名
 */
function cleanAuthorName(raw: string): string {
  return (
    raw
      // 去除字数标注后缀：【216.01万字】 / 【100万字】等
      .replace(/【[\d.]+万字】.*$/, '')
      // 去除版本标注后缀：（校对版全本） / （精校版全本）等
      .replace(/[（(][^（）()]*版[^（）()]*[）)]\s*$/, '')
      // 去除尾部【...】标注
      .replace(/【[^】]*】\s*$/, '')
      .trim()
  );
}

/**
 * 从文件名和文件头部内容提取书名、作者和简介（万能元数据提取，通用化增强版）
 *
 * 通用化增强：基于 80 个真实 TXT 文件语料分析，新增以下格式支持：
 * - 《书名 by 作者》格式（by 作者标记在书名号内，如文件31）
 * - 通用包裹符简介匹配：【关键词】xxx / 『关键词』xxx / [关键词]xxx / 「关键词」xxx
 * - 未闭合包裹符简介：『内容简介: 后换行（内容在下一行，如文件69）
 * - 无冒号简介标记：如"内容简介"后直接换行（如文件24）
 * - 增强广告行过滤：免责声明/标签/状态/制作信息/下载提示等
 *
 * 覆盖 15 种真实 TXT 格式（从用户 DATA 目录 80 个文件实际采样）：
 *  1. 《书名》（校对版全本）作者：xxx + 作品简介：
 *  2. 书名 作者：xxx（同一行）+ 内容简介：
 *  3. 书名\n作者：xxx（不同行）+ 简介无前缀直接跟
 *  4. 广告行 + 《书名》作者：xxx + 内容简介：
 *  5. 书名\n作者: xxx（英文冒号）+ 简介:
 *  6. 《书名》来自=第一章 xxx===（无作者无简介）
 *  7. 《书名》作者：xxx + 简介：
 *  8. 无书名无作者，直接序章
 *  9. 《书名》作者：xxx + 内容简介：
 * 10. 《书名》作者：xxx + 文案：（替代简介：）
 * 11. 简介跨多行
 * 12. 无前缀简介（作者行后空行 then 内容 then 章节标题）
 * 13. 《书名 by 作者》来自:（by 作者标记在书名号内）【新增】
 * 14. 『内容简介: 后换行（未闭合包裹符）【新增】
 * 15. 内容简介（无冒号，内容在下一行）【新增】
 *
 * 优先级（头部优先，文件名兜底）：
 * 1. 文件头部元信息：前 30 行扫描，支持《书名》/书名 作者：xxx/跨行作者/文案：/by 作者/通用包裹符等
 * 2. 文件名解析：《书名》作者：xxx / "书名 - 作者" / "书名_作者" / "xxx 著" 等格式
 * 3. 兜底：文件名（去扩展名）作书名，作者"未知"，简介空字符串
 *
 * 设计理由：真实 TXT 文件 80% 以上用《书名》作者：xxx 或 书名\n作者：xxx 格式，
 * 旧版只扫描显式"书名：""作者：""简介："标记，命中率不足 20%。
 * 通用化增强版支持书名号、同行/跨行作者、广告行过滤、文案：、英文冒号、BOM/全角空格清理、
 * by 作者标记、通用包裹符简介匹配、无冒号简介标记。
 *
 * @param fileName 文件名（含扩展名）
 * @param headContent 文件头部已解码的文本内容（前 4KB）
 */
export function extractMeta(fileName: string, headContent: string): BookMeta {
  const lines = headContent.split(/\r?\n/);
  const headLines = lines.slice(0, 30); // 扫描前 30 行

  let title: string | null = null;
  let author: string | null = null;
  let description: string | null = null;

  // === 第 0 步：优先从文件名提取书名 ===
  // 文件名通常更干净，TXT头部常有推广信息（[百度一下：xxx]、无限小说网等）干扰
  //   见于"001.[起点vip完结]《总裁的欢喜冤家》.txt"→"总裁的欢喜冤家"
  //   见于"龙在边缘.txt"→"龙在边缘"（parseFileNameTitle返回null，用nameWithoutExt）
  // 如果文件名提取到书名，TXT头部只用于补充作者和简介
  const fileNameTitle = parseFileNameTitle(fileName);
  if (fileNameTitle) {
    title = fileNameTitle;
  }
  const fileNameAuthor = parseFileNameAuthor(fileName);
  if (fileNameAuthor) {
    author = fileNameAuthor;
  }

  // === 第 1 步：扫描行，提取 title/author/description ===
  for (let i = 0; i < headLines.length; i++) {
    const trimmed = headLines[i].trim();
    // 去掉 BOM 和全角空格
    const clean = trimmed.replace(/^[\uFEFF\u3000\s]+/, '').replace(/[\u3000\s]+$/, '');
    if (!clean) continue;

    // 跳过广告行
    if (isAdLine(clean)) continue;

    // --- 书名提取 ---
    if (!title) {
      // 1a0. 显式 "本书名称：xxx" / "本书名称:xxx"
      const m0 = clean.match(/^本书名称[：:]\s*(.+)$/);
      if (m0) {
        title = m0[1].trim();
        continue;
      }

      // 1a. 显式 "书名：xxx" / "书名:xxx"
      const m1 = clean.match(/^书名[：:]\s*(.+)$/);
      if (m1) {
        title = m1[1].trim();
        continue;
      }

      // 1b. 《书名》格式（可能带括号注释和作者在同一行）
      //     《北朝帝业》（校对版全本）作者：衣冠正伦
      //     《丹修》 作者：丹修
      //     《代晋》 作者：大苹果
      //     《天才维修师》作者：李温酒
      //     《这游戏也太真实了》作者：晨星LL
      //     《万相天师》来自=第一章 祠堂挑战===
      //     《九零年代之我的老公是矿业大亨 by 骨色弯刀》来自:（by 作者标记在书名号内）
      //     《道诡异仙》（精校版全本）作者狐尾的笔（无冒号作者）【新增】
      //     《江南作品全集》·［文论］（副标题在《》外面，需包含）
      //     《江南作品全集》·［九州长篇小说］（同上）
      const m2 = clean.match(/《(.+?)》/);
      if (m2) {
        let bookTitle = m2[1].trim();
        // 检查书名内是否有 "by xxx" 作者标记
        //    如《九零年代之我的老公是矿业大亨 by 骨色弯刀》
        const byMatch = bookTitle.match(/^(.+?)\s+by\s+(.+)$/i);
        if (byMatch) {
          bookTitle = byMatch[1].trim();
          if (!author) author = byMatch[2].trim();
        }
        // 同行提取作者：《书名》...作者：xxx 或 《书名》...作者: xxx 或 《书名》...作者xxx（无冒号）
        const afterBook = clean.slice(clean.indexOf('》') + 1);
        // 先尝试有冒号格式："作者：xxx" / "作者: xxx"
        let authorMatch = afterBook.match(/(?:作者|著作)[：:]\s*(.+)$/);
        if (!authorMatch) {
          // 无冒号格式："作者xxx"（要求 xxx 至少2个中文字符开头，避免误判"作者是"等）
          //    见于《道诡异仙》（精校版全本）作者狐尾的笔
          authorMatch = afterBook.match(/(?:作者|著作)\s*([\u4e00-\u9fff]{2,}.*?)$/);
        }
        if (authorMatch && !author) {
          author = cleanAuthorName(authorMatch[1].trim());
        }
        // 检查《》后是否有副标题（如 ·［xxx］、·【xxx】）
        //   见于"《江南作品全集》·［文论］"、"《江南作品全集》·［九州长篇小说］"
        //   条件：以 · 或 . 开头，后跟 ［或【或(或（，且不含作者信息
        const afterCloseBook = afterBook.trim();
        if (
          afterCloseBook &&
          !authorMatch && // 同行无作者信息
          /^[·.]\s*[［【(（]/.test(afterCloseBook)
        ) {
          // 包含副标题，保留原始格式（含《》和副标题标记）
          bookTitle = `《${bookTitle}》${afterCloseBook}`;
        }
        title = bookTitle;
        // 检查下一非空行是否有 【xxx】 副标题（如"【九州志，十个一瞬间】"）
        //   见于"《江南作品全集》·［九州长篇小说］"下一行"【九州缥缈录Ⅰ：蛮荒】"
        if (title && title.includes('》')) {
          for (let j = i + 1; j < Math.min(i + 3, headLines.length); j++) {
            const nextTrim = headLines[j]
              .trim()
              .replace(/^[\uFEFF\u3000\s]+/, '')
              .replace(/[\u3000\s]+$/, '');
            if (!nextTrim) continue;
            // 下一行是 【xxx】 格式，追加到标题
            const subtitleMatch2 = nextTrim.match(/^【(.+?)】$/);
            if (subtitleMatch2) {
              title = title + `【${subtitleMatch2[1]}】`;
              continue; // 继续检查下一行
            }
            break; // 下一行不是 【xxx】，停止
          }
        }
        continue;
      }

      // 1b2. <<书名>> 双尖括号格式（如 <<秒杀>>、<<寒门祸害>>）
      const m2b = clean.match(/<<(.+?)>>/);
      if (m2b) {
        title = m2b[1].trim();
        continue;
      }

      // 1b3. <书名> 单尖括号格式（如 <傲天战魂>）
      const m2c = clean.match(/^<(.+?)>$/);
      if (m2c) {
        title = m2c[1].trim();
        continue;
      }

      // 1b4. 『书名/作者:xxx』 方括号格式（如 『茅山捉鬼人/作者:青子』）
      //      书名和作者在同一行用 / 分隔
      const m2d = clean.match(/^『(.+?)\/作者[：:](.+?)』$/);
      if (m2d) {
        title = m2d[1].trim();
        if (!author) author = m2d[2].trim();
        continue;
      }

      // 1b4b. 『书名/作者:xxx』 未闭合格式（如 『茅山捉鬼人/作者:青子』后无闭合』）
      //      见于"『茅山捉鬼人/作者:青子』"实际匹配但有些文件可能没有闭合
      const m2d2 = clean.match(/^『(.+?)\/作者[：:](.+?)』?/);
      if (m2d2) {
        title = m2d2[1].trim();
        if (!author) author = m2d2[2].trim().replace(/』$/, '');
        continue;
      }

      // 1b5. 【标签】《书名》作者：xxx / 【标签】《书名》 作者：xxx
      //      见于"【全本精校】《九死成神》 作者：冰城妖玉"等
      //      标签前缀（如【全本精校】、【精校版】等）+《书名》+作者
      //      当前1b正则能匹配《书名》，但显式处理可避免标签被误判为书名的一部分
      const m2e = clean.match(/^【[^】]{2,10}】\s*《(.+?)》\s*(?:作者|著作)?[：:?\s]*([^】]*)$/);
      if (m2e) {
        title = m2e[1].trim();
        const authorStr = m2e[2].trim();
        if (authorStr && !author) {
          author = cleanAuthorName(authorStr);
        }
        continue;
      }

      // 1b6. [书名 / 作者 著] 方括号格式
      //      见于"[龙蛇演义 / 梦入神机 著 ]"等
      //      方括号或【】包裹，内部用 / 分隔书名和作者，作者可能带"著"
      const m2f = clean.match(/^[【\[]\s*(.+?)\s*\/\s*(.+?)\s*著\s*[】\]]$/);
      if (m2f) {
        title = m2f[1].trim();
        if (!author) author = cleanAuthorName(m2f[2].trim());
        continue;
      }

      // 1b6b. [书名  作者 著] 方括号格式（空格分隔，无/）
      //      见于"[一刀劈开生死路  夜与雪 著 ]"、"[心跳领域   著 ]"等
      //      小说快捕制作的TXT常见此格式：方括号内用空格分隔书名和作者，作者带"著"
      const m2fb = clean.match(/^[【\[]\s*(.+?)\s+著\s*[】\]]$/);
      if (m2fb) {
        const inner = m2fb[1].trim();
        // 用2+空格分隔书名和作者
        const parts = inner.split(/\s{2,}/);
        if (parts.length >= 2) {
          title = parts[0].trim();
          if (!author) author = cleanAuthorName(parts[parts.length - 1].trim());
        } else {
          // 只有书名，无作者（如 [心跳领域   著 ]）
          title = inner;
        }
        continue;
      }

      // 1b7. [书名] 纯方括号书名格式（无作者信息）
      //      见于"[阳神]"等
      //      跳过元数据标记和非书名内容：
      //      - 元数据标记：[摘要 书籍简介]、[内容简介]、[正文 xxx] 等
      //      - 网站推广：[百度一下：无限小说网]、[本书下载官网www.xxx.com] 等
      //      - 含URL/网站名的方括号内容不是书名
      const m2g = clean.match(/^[【\[]\s*(.+?)\s*[】\]]$/);
      if (m2g) {
        const inner = m2g[1].trim();
        // 跳过元数据标记（非书名）
        if (
          /^(?:摘要|书籍简介|内容简介|作品简介|内容介绍|文案|简介|介绍|说明|概述|书籍介绍|故事简介|章节简介|目录|正文)/.test(
            inner
          )
        ) {
          continue;
        }
        // 跳过网站推广/URL等非书名内容
        if (
          /(?:百度一下|www\.|https?:\/\/|\.org|\.com|\.net|\.cn|小说网|中文网|下载官网|官网|网站|分享群|分享)/.test(
            inner
          )
        ) {
          continue;
        }
        title = inner;
        continue;
      }

      // 1c. "书名 作者：xxx" 同行格式（无书名号）
      //     家父汉高祖 作者：历史系之狼
      //     重生之我是皇帝 作者：历史系之狼
      const m3 = clean.match(/^(.+?)\s+(?:作者|著作)[：:]\s*(.+)$/);
      if (m3) {
        title = m3[1].trim();
        if (!author) author = cleanAuthorName(m3[2].trim());
        continue;
      }

      // 1c2. "书名 作者 xxx" 同行格式（无冒号，空格分隔）
      //      长生界 作者 辰东
      //      神墓 作者 辰东
      //      要求：作者后至少2个中文字符，避免误判
      const m3b = clean.match(/^(.+?)\s+(?:作者|著作)\s+([\u4e00-\u9fff]{2,}.*?)$/);
      if (m3b) {
        title = m3b[1].trim();
        if (!author) author = cleanAuthorName(m3b[2].trim());
        continue;
      }

      // 1d. 纯书名行（独占一行，后面行有"作者："或"内容简介"或章节标题）
      //     从行星总督开始\n作者：红心布
      //     绍宋\n作者: 榴弹怕水
      //     潮汐禁区\n作者：祈天狐
      //     神国之上\n作者：见异思剑
      //     阳神\n第一章 天意民意  (纯书名+下行章节标题)
      //     星峰传说\n内容简介：  (纯书名+下行简介标记)
      //     判断条件：当前行较短（<30字），不含章节关键词，下一非空行是"作者：xxx"或章节标题或简介标记
      //     排除"章节目录"等非书名标记（新增，避免误判）
      if (
        clean.length < 30 &&
        !isChapterTitleLine(clean) &&
        !isAdLine(clean) &&
        clean !== '章节目录' &&
        clean !== '目录'
      ) {
        // 往后找下一非空行
        for (let j = i + 1; j < Math.min(i + 5, headLines.length); j++) {
          const nextTrim = headLines[j].trim().replace(/^[\uFEFF\u3000\s]+/, '');
          if (!nextTrim) continue;
          const authorMatch = nextTrim.match(/^(?:作者|著作)[：:]\s*(.+)$/);
          if (authorMatch) {
            title = clean;
            if (!author) author = cleanAuthorName(authorMatch[1].trim());
            break;
          }
          // 下行是简介标记（如"内容简介："、"简介："等）
          if (/^(?:简介|内容简介|内容介绍|作品简介|文案|书籍介绍|故事简介)[：:]/.test(nextTrim)) {
            title = clean;
            break;
          }
          // 下行是章节标题（如"第一章 xxx"）
          if (isChapterTitleLine(nextTrim)) {
            title = clean;
            break;
          }
          break; // 下一非空行不是以上任何一种，放弃
        }
        if (title) continue;
      }
    }

    // --- 作者提取 ---
    if (!author) {
      // 2a0. 显式 "本书作者：xxx" / "本书作者: xxx"
      const m0 = clean.match(/^本书作者[：:]\s*(.+)$/);
      if (m0) {
        author = cleanAuthorName(m0[1].trim());
        continue;
      }

      // 2a. 显式 "作者：xxx" / "作者: xxx" / "著作：xxx"（行首）
      //     或 "》作者：xxx" / "》作者: xxx"（《书名》后同行，title 已设置时）
      //     见于《道诡异仙》作者：狐尾的笔【216.01万字】（第6行，第2行已提取title但author未提取）
      const m = clean.match(/(?:^|》)\s*(?:作者|著作)[：:]\s*(.+)$/);
      if (m) {
        const authorCandidate = cleanAuthorName(m[1].trim());
        // 长度约束：作者名不超过20字，超过则可能是简介/正文被误判
        if (authorCandidate.length <= 20) {
          author = authorCandidate;
          continue;
        }
      }

      // 2a2. 无冒号作者格式："作者xxx"（行首，要求 xxx 为2-6个中文字符）
      //      见于"作者狐尾的笔"（无冒号，但此格式较少见，优先级低于有冒号）
      //      约束：作者名2-6个中文字符（笔名通常2-6字），行尾就是作者名
      const m1b = clean.match(/^作者\s*([\u4e00-\u9fff]{2,6})$/);
      if (m1b) {
        author = cleanAuthorName(m1b[1].trim());
        continue;
      }

      // 2b. "文/xxx" / "文／xxx"
      const m2 = clean.match(/^文[\/／](.+)$/);
      if (m2) {
        author = cleanAuthorName(m2[1].trim());
        continue;
      }

      // 2c. "xxx 著"（"著"在末尾，前面有空格）
      const m3 = clean.match(/^(.+?)\s+著$/);
      if (m3) {
        const authorCandidate = cleanAuthorName(m3[1].trim());
        // 长度约束 + 排除章节标题特征
        if (authorCandidate.length <= 20 && !isChapterTitleLine(clean)) {
          author = authorCandidate;
          continue;
        }
      }
    }

    // --- 简介标记行检测（通用化框架） ---
    // 通用模式：
    // 1. 关键词 + 分隔符 + 内容：如 "简介：xxx" / "文案: xxx"
    // 2. 关键词（无分隔符，内容在下一行）：如 "内容简介" 后直接换行
    // 3. 包裹符 + 关键词 + 包裹符 + 分隔符? + 内容：如 "【作品简介】：xxx" / "【文案】"
    // 4. 包裹符 + 关键词 + 分隔符 + 内容（未闭合，内容在下一行）：如 "『内容简介:"
    // 关键词列表：简介/本书简介/内容简介/内容介绍/作品简介/文案/介绍/说明/摘要/概述
    // 分隔符：：:（支持中英文冒号）
    // 包裹符对：【】[]『』「」
    if (!description) {
      // 3a0. 显式 "本书简介：xxx" / "本书简介:xxx"
      const m0 = clean.match(/^本书简介[：:]\s*(.*)$/);
      if (m0) {
        if (m0[1].trim()) {
          description = m0[1].trim();
        } else {
          description = extractDescriptionFromLine(headLines, i + 1);
        }
        continue;
      }

      // 3a1. 闭合的通用包裹符匹配：【关键词】xxx / 『关键词』xxx / [关键词]xxx / 「关键词」xxx
      //    覆盖：【作品简介】：xxx / 【文案】 / 『内容简介:xxx』 / [简介] xxx 等
      //    关键词精确匹配，避免误判
      //    见于文件3/38/48/51/59 的"【文案】"/"【作品简介】："等
      const wrapMatch = clean.match(/^[【\[『「]([^\】\]』」]+)[】\]』」][：:]?\s*(.*)$/);
      if (wrapMatch) {
        const keyword = wrapMatch[1].trim();
        const content = wrapMatch[2].trim();
        if (/^(?:作品简介|内容简介|内容介绍|文案|简介|介绍|说明|摘要|概述|书籍介绍|故事简介|章节简介)$/.test(keyword)) {
          if (content) {
            description = content;
          } else {
            description = extractDescriptionFromLine(headLines, i + 1);
          }
          continue;
        }
      }

      // 3a2. 未闭合的包裹符：『关键词: 后换行（内容在下一行）
      //    见于文件69 的"『内容简介:"（『内容简介: 后面没有闭合 』，内容在下一行）
      const unclosedWrapMatch = clean.match(/^『(内容简介|简介|文案|作品简介|内容介绍)[：:]\s*$/);
      if (unclosedWrapMatch) {
        description = extractDescriptionFromLine(headLines, i + 1);
        continue;
      }

      // 3a. "简介：" / "内容简介：" / "内容介绍：" / "作品简介：" / "文案：" / "书籍介绍：" / "故事简介："
      //    新增：支持无冒号的情况（如"内容简介"后直接换行，内容在下一行）
      //    见于文件24 的"内容简介"（无冒号，内容在下一行）
      //    新增：书籍介绍/故事简介/章节简介（16K小说网/部分小说格式）
      const m = clean.match(/^(?:简介|内容简介|内容介绍|作品简介|文案|书籍介绍|故事简介)(?:[：:]\s*(.*))?$/);
      if (m) {
        // 简介内容可能在同一行，也可能在后续行
        if (m[1] && m[1].trim()) {
          description = m[1].trim();
        } else {
          // 简介标记后无内容，从下一行开始提取简介
          description = extractDescriptionFromLine(headLines, i + 1);
        }
        continue;
      }

      // 3b. "书名 内容简介" / "书名 内容简介：" 格式
      //     见于"地狱变 内容简介"（书名+空格+内容简介标记，内容在下一行）
      //     约束：行尾是"内容简介"或"内容简介："，前面有书名（2-20字中文）
      const m3b = clean.match(
        /^([\u4e00-\u9fff]{2,20})\s+(内容简介|简介|文案|内容介绍|作品简介|书籍介绍|故事简介)[：:]?\s*$/
      );
      if (m3b) {
        description = extractDescriptionFromLine(headLines, i + 1);
        continue;
      }

      // 3c. "书名章节简介：" / "xxx章节简介：" 格式
      //     见于"九州捭阖录章节简介："（书名+章节简介+冒号，内容在下一行）
      //     约束：含"章节简介"关键词，前面可能有书名
      const m3c = clean.match(/章节简介[：:]\s*$/);
      if (m3c) {
        description = extractDescriptionFromLine(headLines, i + 1);
        continue;
      }
    }
  }

  // === 第 2 步：如果无简介标记，尝试无前缀简介 ===
  // 格式3/12：作者行后面空行 then 内容 then 章节标题
  if (!description && author) {
    const authorLineIndex = headLines.findIndex((l) => l.trim().match(/^(?:作者|著作)[：:]/));
    if (authorLineIndex >= 0) {
      description = extractDescriptionFromLine(headLines, authorLineIndex + 1);
    }
  }

  // === 第 3 步：文件名兜底 ===
  // 如果文件名和TXT头部都没提取到书名，用文件名（去扩展名）作为最后兜底
  const nameWithoutExt = fileName
    .replace(/\.[a-zA-Z]{1,5}$/, '')
    .replace(/\.[a-zA-Z]{1,5}$/, '')
    .trim();
  if (!title) {
    title = nameWithoutExt || fileName;
  }
  if (!author) {
    author = '未知';
  }
  if (!description) {
    description = '';
  }

  return { title, author, description };
}

/* ==================== 流式行扫描（核心） ==================== */

/** 流式行扫描回调参数 */
interface LineInfo {
  /** 解码后的行内容（不含换行符，已去 \r 和 BOM） */
  line: string;
  /** 行起始字节偏移 */
  byteOffset: number;
  /** 行字节长度（不含换行符） */
  byteLength: number;
  /** 下一行起始字节偏移（= byteOffset + byteLength + separator.length） */
  nextByteOffset: number;
}

/**
 * 获取指定编码下的换行符字节序列
 *
 * 用于在 Buffer 层面按行切分（避免多字节编码下字符串长度 ≠ 字节长度的问题）。
 * - UTF-16LE：\n = 0x0A 0x00
 * - UTF-16BE：\n = 0x00 0x0A
 * - 其他（GBK/UTF-8/Big5）：\n = 0x0A
 */
function getLineSeparator(encoding: string): Buffer {
  const upper = encoding.toUpperCase();
  if (upper === 'UTF-16LE') return Buffer.from([0x0a, 0x00]);
  if (upper === 'UTF-16BE') return Buffer.from([0x00, 0x0a]);
  return Buffer.from([0x0a]);
}

/**
 * 流式按行扫描文件（按字节偏移定位，不全量入内存）
 *
 * 实现原理：
 * - 在 Buffer 层面找换行符，确定每行的字节范围 [startByte, endByte)
 * - 对每行的 Buffer 单独用 iconv-lite 解码，确保字节偏移精确
 * - 处理跨块的多字节字符和跨块的行（用 leftover 缓冲）
 *
 * 内存占用：仅当前块（64KB）+ leftover（< 64KB），与文件大小无关。
 *
 * @param filePath 文件路径
 * @param encoding 编码
 * @param onLine 每行回调，返回 false 提前终止扫描
 * @param onProgress 进度回调（0~1）
 */
async function streamLinesByByte(
  filePath: string,
  encoding: string,
  onLine: (info: LineInfo) => boolean | void,
  onProgress?: (p: number) => void
): Promise<void> {
  const totalSize = statSync(filePath).size;
  const separator = getLineSeparator(encoding);
  const sepLen = separator.length;

  let leftover: Buffer = Buffer.alloc(0);
  let baseByteOffset = 0; // leftover 起始的字节偏移
  let isFirstLine = true;

  return new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });

    stream.on('data', (chunk) => {
      const buf = leftover.length > 0 ? Buffer.concat([leftover, chunk as Buffer]) : (chunk as Buffer);
      let searchStart = 0;
      let stop = false;

      while (!stop) {
        const sepIdx = buf.indexOf(separator, searchStart);
        if (sepIdx === -1) break;

        const lineBuf = buf.subarray(searchStart, sepIdx);
        const lineByteOffset = baseByteOffset + searchStart;
        let line = iconv.decode(lineBuf, encoding);

        // 去掉行尾 \r（\r\n 中的 \r）
        line = line.replace(/\r$/, '');

        // 第一行去 BOM
        if (isFirstLine) {
          if (line.length > 0 && line.charCodeAt(0) === 0xfeff) {
            line = line.slice(1);
          }
          isFirstLine = false;
        }

        const nextByteOffset = lineByteOffset + lineBuf.length + sepLen;
        if (
          onLine({
            line,
            byteOffset: lineByteOffset,
            byteLength: lineBuf.length,
            nextByteOffset
          }) === false
        ) {
          stop = true;
          break;
        }

        searchStart = sepIdx + sepLen;
      }

      if (stop) {
        stream.destroy();
        resolve();
        return;
      }

      // 更新 leftover 和 baseByteOffset
      leftover = buf.subarray(searchStart);
      baseByteOffset += searchStart;

      if (onProgress && totalSize > 0) {
        onProgress(Math.min(1, (baseByteOffset + leftover.length) / totalSize));
      }
    });

    stream.on('end', () => {
      // 处理最后残留的行（文件不以换行符结尾的情况）
      if (leftover.length > 0) {
        let line = iconv.decode(leftover, encoding);
        line = line.replace(/\r$/, '');
        if (isFirstLine && line.length > 0 && line.charCodeAt(0) === 0xfeff) {
          line = line.slice(1);
        }
        onLine({
          line,
          byteOffset: baseByteOffset,
          byteLength: leftover.length,
          nextByteOffset: baseByteOffset + leftover.length
        });
      }
      if (onProgress) onProgress(1);
      resolve();
    });

    stream.on('error', (err) => {
      reject(new TxtParseError(`流式读取文件失败: ${err.message}`, err));
    });
  });
}

/**
 * 在超长行中扫描内嵌的章节标记，返回标记位置数组
 *
 * 用于处理章节标记嵌入在超长行中的情况：
 * - 014交错时光：207877字的行，包含76个"第一章：穿越时空"等标记
 * - 星戒：1074字的行，在位置933处嵌入"第二百零二章"等标记
 *
 * @param line 超长行文本
 * @returns 章节标记位置数组，每个元素包含 { position, title } 或 null（无标记）
 */
function findEmbeddedChapters(line: string): { position: number; title: string }[] | null {
  if (line.length < 500) return null;

  const results: { position: number; title: string }[] = [];

  // 扫描行内的 "第X章/节/回" 标记
  //   约束：标记后必须有空格/冒号/中文字符/引号（避免匹配"第X章到"等非标题）
  //   前置不约束（超长行中标记可能紧跟书名/冒号等字符）
  //   见于交错时光"下部:第一章:标题"、星戒"女婿第二百零二章"天"等格式
  // 复用模块级预编译正则（需重置 lastIndex，因全局匹配会保留状态）
  const re = EMBEDDED_CHAPTER_RE;
  re.lastIndex = 0;

  let match;
  while ((match = re.exec(line)) !== null) {
    // 提取标记位置（跳过前面的空格/全角空格）
    const markerStart = match.index + (match[0].length - match[0].trimStart().length);
    // 提取标题（从标记开始到下一个标记或行尾，最多60字）
    const titleStart = markerStart;
    // 找到标题结束位置：下一个换行符、下一个标记、或+60字
    let titleEnd = Math.min(titleStart + 60, line.length);
    // 检查标题中是否包含换行符
    const newlineIdx = line.indexOf('\n', titleStart);
    if (newlineIdx >= 0 && newlineIdx < titleEnd) {
      titleEnd = newlineIdx;
    }
    const title = line.substring(titleStart, titleEnd).trim();
    if (title.length >= 3 && title.length <= 60) {
      results.push({ position: titleStart, title });
    }
    // 移动到下一个可能的位置
    re.lastIndex = match.index + match[0].length;
  }

  return results.length > 0 ? results : null;
}

/* ==================== 流式分章建索引 ==================== */

/** 读取文件头部指定字节数 */
async function readFileHead(filePath: string, bytes: number): Promise<Buffer> {
  // Windows 上文件刚复制完可能被系统短暂锁定（EBUSY），添加重试
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 200;
  let handle;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      handle = await fsPromises.open(filePath, 'r');
      break;
    } catch (err: any) {
      if (err.code === 'EBUSY' && attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  if (!handle) throw new Error(`无法打开文件: ${filePath}`);
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * 检测是否为非小说文件（EA GAMES README、MEMCOUNT、软件站说明、免责申明等）
 *
 * 通过文件头部关键词识别非小说 TXT 文件（如游戏 README、安装说明、数据文件、
 * 软件站说明、免责申明等），避免将这些文件误导入为小说。
 *
 * 通用化增强：基于 36 个真实 TXT 文件语料分析，新增以下非小说文件检测：
 * - 3322软件站说明（"抖音账号：3322软件站" / "32r.com" / "解压密码：www.32r.com"）
 * - 免责申明 + 用户使用协议（"免责申明" + "用户使用协议"）
 * - EA GAMES 多语言 README（法语/德语/意大利语/西班牙语/瑞典语/韩语/英语）
 *
 * @param headContent 文件头部已解码的文本内容
 * @param fileName 文件名（含扩展名）
 * @returns true 表示该文件不是小说文件，应跳过导入
 */
function isNonNovelFile(headContent: string, _fileName: string): boolean {
  const head = headContent.slice(0, 800).toUpperCase();
  // EA GAMES README（多语言版本：presents/presenta/présente/pr鋝entiert 等）
  if (head.includes('EA GAMES') && head.includes('NEED FOR SPEED')) return true;
  if (head.includes('README?8README')) return true;
  // MEMCOUNT 数据文件
  if (head.includes('MEMCOUNT') && head.includes('ADDRESS')) return true;
  // 安装说明
  if (head.includes('REGSETUP.EXE') || head.includes('NFSHP2.EXE')) return true;
  // 文件列表（cache.dat）
  if (head.includes('CACHE.DAT') && head.includes('EAUNINSTALL.EXE')) return true;
  // 3322软件站说明（"抖音账号：3322软件站" / "网站：32r.com" / "解压密码：www.32r.com"）
  if (head.includes('3322软件站') || head.includes('32R.COM')) return true;
  // 免责申明 + 用户使用协议
  if (headContent.includes('免责申明') && headContent.includes('用户使用协议')) return true;
  // 纯安装说明文件（"运行RegSetup.exe  安装注册表" + "再运行NFSHP2.exe进入游戏"）
  if (headContent.includes('运行RegSetup.exe') && headContent.includes('进入游戏')) return true;
  return false;
}

/**
 * 解析 TXT 文件，建立章节索引（不加载正文）
 *
 * 流程：
 * 1. 校验文件存在 + 非空
 * 2. detectEncoding 检测编码
 * 3. 提取书名作者（文件名 + 头部 4KB）
 * 4. 流式逐行扫描，正则匹配章节标题
 * 5. 匹配到标题 → 上一章结束，记录 { index, title, fileOffset, fileLength }
 * 6. 无章节标题 → 走分章兜底 fallbackChunk
 *
 * 关键：解析阶段只建索引不加载正文，100MB 文件几秒建完索引。
 *
 * @param filePath 文件绝对路径
 * @param onProgress 解析进度回调（0~1，供 UI 显示加载动画）
 * @returns { encoding, title, author, chapters }
 * @throws TxtParseError 文件不存在/为空/编码检测失败/非小说文件
 */
export async function parseTxt(
  filePath: string,
  onProgress?: (p: number) => void,
  originalFileName?: string,
  parseMode?: ParseMode
): Promise<ParsedBook> {
  // 校验文件存在
  let stat;
  try {
    stat = statSync(filePath);
  } catch (err) {
    throw new TxtParseError(`文件不存在或无法访问: ${filePath}`, err as Error);
  }

  if (stat.size === 0) {
    throw new TxtParseError('文件为空');
  }

  // 1. 检测编码
  let encoding: string;
  try {
    encoding = await detectEncoding(filePath);
  } catch (err) {
    throw new TxtParseError(`编码检测失败: ${(err as Error).message}`, err as Error);
  }

  // 2. 提取书名作者（优先用原始文件名，头部 4KB）
  const fileName = originalFileName || basename(filePath);
  let headContent = '';
  try {
    const headBuf = await readFileHead(filePath, 4096);
    headContent = decodeBuffer(headBuf, encoding);
  } catch {
    // 头部读取失败不致命，用文件名兜底
    headContent = '';
  }

  // 非小说文件检测（EA GAMES README、MEMCOUNT、软件站说明等）
  if (isNonNovelFile(headContent, fileName)) {
    throw new TxtParseError('该文件不是小说文件');
  }

  const { title, author, description } = extractMeta(fileName, headContent);

  // 解析模式分发：auto/novel/markdown/plain
  let mode = parseMode ?? 'auto';
  if (mode === 'auto') {
    // 读取前 64KB 做模式检测（原 20KB 对章节间距大的小说不够，如九州缥缈录前20KB仅1个章节标记）
    let detectContent = headContent;
    try {
      const detectBuf = await readFileHead(filePath, 65536);
      detectContent = decodeBuffer(detectBuf, encoding);
    } catch {
      // 用已有的 headContent 兜底
    }
    mode = detectParseMode(detectContent);

    // 扩大检测窗口：前 64KB 没识别到模式（返回 'plain'）时，读前 1MB 再试
    //   某些 TXT 文件有长前缀（书评/山海经/简介等），如长生界前 325KB 无章节标记
    //   64KB 窗口完全在前缀内 → 误判为 plain → 整书单章
    //   扩大到 1MB 覆盖绝大多数前缀长度，对正常文件零额外开销（只在前 64KB 失败时触发）
    if (mode === 'plain' && stat.size > 65536) {
      try {
        const largerBuf = await readFileHead(filePath, 1048576); // 1MB
        const largerContent = decodeBuffer(largerBuf, encoding);
        const largerMode = detectParseMode(largerContent);
        if (largerMode !== 'plain') {
          mode = largerMode;
        }
      } catch {
        // 读取失败，保持 'plain'
      }
    }

    // 进一步扩大到 3MB：超长行内嵌标记可能在文件较后位置
    //   见于星戒(18MB)：5个超长行内嵌标记在行6338(约1.6MB)，前1MB仅1个标记不够阈值
    //   前3MB有2个标记足够识别为 novel 模式
    if (mode === 'plain' && stat.size > 1048576) {
      try {
        const largerBuf = await readFileHead(filePath, 3 * 1048576); // 3MB
        const largerContent = decodeBuffer(largerBuf, encoding);
        const largerMode = detectParseMode(largerContent);
        if (largerMode !== 'plain') {
          mode = largerMode;
        }
      } catch {
        // 读取失败，保持 'plain'
      }
    }
  }

  // Markdown 模式：按 ATX 标题分节
  if (mode === 'markdown') {
    return parseMarkdown(filePath, encoding, stat, title, author, onProgress);
  }

  // 纯文本模式：整篇单章节
  if (mode === 'plain') {
    return parsePlainText(encoding, stat, title, author, onProgress);
  }

  // novel 模式：继续小说章节正则匹配流程

  // 3. 流式分章建索引
  const chapters: ChapterIndex[] = [];
  let currentChapter: { title: string; fileOffset: number } | null = null;
  let chapterIndex = 0;
  let prevLineEmpty = true; // 文件开头视为"空行"（便于纯数字章节匹配）
  let currentVolume: string | null = null; // 当前卷标题（遇到卷标记时更新）
  let firstChapterSeen = false; // 是否已遇到第一个章节标题（防止卷标记后产生多余序言）
  let preambleStart = 0; // 序言起始字节偏移（跳过文件开头的卷标记行）

  // 上下文验证状态
  let lastChapterEndOffset = 0; // 上一个章节结束的字节偏移（用于间距检查）
  let consecutivePureNumbers = 0; // 连续纯数字"章节"计数（检测正文编号列表）
  const MIN_CHAPTER_GAP = 50; // 两章节间最小字节距离（<50说明太近，可能是误判）

  await streamLinesByByte(
    filePath,
    encoding,
    ({ line, byteOffset, nextByteOffset }) => {
      const trimmed = line.trim();
      const lineIsEmpty = trimmed === '';

      // 超长行内嵌章节标记处理
      //   某些TXT文件有超长行（>500字），章节标记嵌入在行内
      //   如014交错时光(207877字行,76个标记)、星戒(1074字行,5个标记)
      //   扫描行内章节标记，在每个标记位置创建新章节
      if (line.length > 500) {
        const embedded = findEmbeddedChapters(line);
        if (embedded && embedded.length > 0) {
          for (const { position, title: embeddedTitle } of embedded) {
            // 精确计算字节偏移：用 iconv-lite 编码前 position 个字符，获取实际字节长度
            //   旧方案用字符比例估算（charRatio = position / line.length），多字节编码下
            //   中文字符占3字节ASCII占1字节，比例非线性，导致章节内容截取错位
            const charBytes = iconv.encode(line.substring(0, position), encoding).length;
            const embeddedByteOffset = byteOffset + charBytes;

            // 结束上一章
            if (currentChapter) {
              chapters.push({
                index: chapterIndex++,
                title: currentChapter.title,
                fileOffset: currentChapter.fileOffset,
                fileLength: embeddedByteOffset - currentChapter.fileOffset,
                volume: currentVolume
              });
            }

            // 开始新章
            currentChapter = { title: embeddedTitle, fileOffset: embeddedByteOffset };
            firstChapterSeen = true;
            lastChapterEndOffset = embeddedByteOffset;
          }
          prevLineEmpty = false;
          return; // 超长行已处理，跳过正常章节检测
        }
      }

      if (!lineIsEmpty && isChapterLine(line, prevLineEmpty)) {
        // 卷级标记（如"第一卷""卷一""上卷""第一卷 初入江湖"）：
        // 不作为独立章节，而是记录卷标题，后续章节关联到该卷
        if (isVolumeLine(line)) {
          // 先结束当前章节（使用旧 currentVolume，fileLength 排除卷标记行，
          // 使卷标记行不进入任何章节内容）
          if (currentChapter) {
            chapters.push({
              index: chapterIndex++,
              title: currentChapter.title,
              fileOffset: currentChapter.fileOffset,
              fileLength: byteOffset - currentChapter.fileOffset,
              volume: currentVolume
            });
            currentChapter = null;
          }
          currentVolume = extractVolumeTitle(line);
          // 记录卷标记行之后的字节位置，用于排除序言中的卷标记行
          if (!firstChapterSeen) {
            preambleStart = nextByteOffset;
          }
          prevLineEmpty = lineIsEmpty;
          return;
        }

        // 章节去重：相同标题的章节只保留第一个
        //    见于完美世界"第一章到"出现多次，产生重复章节
        const newChapterTitle = extractChapterTitle(line);

        // === 上下文验证（阶段2）：正则候选 → 上下文过滤 ===

        // 2a. 连续纯数字检测：连续2个以上纯数字"章节"→ 正文编号列表，排除
        //    见于大奉打更人正文中编号"2""3""4"...被误判为章节标题（96处）
        //    修复：阈值从3降为2，且回溯删除前1个已误判的纯数字章节
        //    原3阈值导致"1\n2\n3"中1和2被误判为章节，到3才排除但前2个不回溯
        const isPureNumber = /^\s*\d{1,6}\s*$/.test(trimmed);
        if (isPureNumber) {
          consecutivePureNumbers++;
          if (consecutivePureNumbers >= 2) {
            // 回溯删除前1个误判的纯数字章节（其内容会被下一个真实章节包含）
            if (chapters.length > 0) {
              const lastCh = chapters[chapters.length - 1];
              if (/^\s*\d{1,6}\s*$/.test(lastCh.title.trim())) {
                chapters.pop();
                chapterIndex--;
                // 恢复 currentChapter 到误判前的状态
                if (chapters.length > 0) {
                  const prev = chapters[chapters.length - 1];
                  currentChapter = { title: prev.title, fileOffset: prev.fileOffset };
                } else {
                  currentChapter = null;
                }
              }
            }
            prevLineEmpty = lineIsEmpty;
            return;
          }
        } else {
          consecutivePureNumbers = 0;
        }

        // 2b. 章节间距检查：与前一个章节距离太近 → 排除
        //    正文章节标题间通常有数百字内容，<50字节说明是正文中的误判
        if (currentChapter && lastChapterEndOffset > 0) {
          const gap = byteOffset - lastChapterEndOffset;
          if (gap < MIN_CHAPTER_GAP) {
            prevLineEmpty = lineIsEmpty;
            return;
          }
        }

        if (currentChapter && currentChapter.title === newChapterTitle) {
          // 与当前章节标题相同，跳过此行（不结束当前章节，不开始新章节）
          prevLineEmpty = lineIsEmpty;
          return;
        }

        // 匹配到章节标题 → 上一章在此行之前结束
        if (currentChapter) {
          chapters.push({
            index: chapterIndex++,
            title: currentChapter.title,
            fileOffset: currentChapter.fileOffset,
            fileLength: byteOffset - currentChapter.fileOffset,
            volume: currentVolume
          });
          lastChapterEndOffset = byteOffset;
        } else if (byteOffset > 0 && !firstChapterSeen && byteOffset > preambleStart) {
          // 第一个章节标题之前有内容（序言/简介），作为「序言」章节保留
          // 跳过文件开头的卷标记行（preambleStart 之后的 content 才是真正的序言）
          const preambleLength = byteOffset - preambleStart;
          // 序言太短（<50字节）时跳过，避免只含空行/换行符的无意义序言
          // 见于九鼎记：卷标记"第一篇 狼"与"第一章"之间只有\r\n\r\n（8字节）
          if (preambleLength >= 50) {
            chapters.push({
              index: chapterIndex++,
              title: '序言',
              fileOffset: preambleStart,
              fileLength: preambleLength,
              volume: currentVolume
            });
          }
        }

        // 3. 从章节标题中提取卷/篇信息（阶段3：后处理）
        //    "第一卷 走出神墓 第一章 远古神墓" → volume="第一卷 走出神墓", title="第一章 远古神墓"
        let finalTitle = newChapterTitle;
        const volFromTitle = extractVolumeFromTitle(newChapterTitle);
        if (volFromTitle) {
          currentVolume = volFromTitle.volume;
          finalTitle = volFromTitle.remainingTitle;
        }

        // 新章从这一行开始（含标题行）
        currentChapter = {
          title: finalTitle,
          fileOffset: byteOffset
        };
        firstChapterSeen = true;
      }

      prevLineEmpty = lineIsEmpty;
    },
    onProgress
  );

  // 最后一章
  // 注意：currentChapter 在闭包中被赋值，TypeScript 控制流分析不追踪闭包赋值，
  // 需用类型断言以正确 narrow 类型
  const lastChapter = currentChapter as { title: string; fileOffset: number } | null;
  if (lastChapter) {
    chapters.push({
      index: chapterIndex++,
      title: lastChapter.title,
      fileOffset: lastChapter.fileOffset,
      fileLength: stat.size - lastChapter.fileOffset,
      volume: currentVolume
    });
  }

  // 4. 无章节标题 → 分章兜底
  if (chapters.length === 0) {
    const fallbackChapters = await fallbackChunk(filePath, encoding, 3000);
    return {
      encoding,
      title,
      author,
      description,
      chapters: fallbackChapters,
      isComic: false,
      contentType: 'text' as const
    };
  }

  // 4b. 少章兜底：文件较大但识别到的章节数极少（如18MB只有8章）
  //     这种情况通常是网络小说抓取格式，章节标题混在导航链接或正文中
  //     修复：原逻辑丢弃已识别章节改为均分，会丢失已识别的章节边界
  //     新逻辑：保留已识别章节，不强制均分。用户可用"全部加载"模式阅读
  //     仅当完全没有识别到章节（chapters.length === 0）时才走 fallbackChunk
  //     条件放宽：只有 chapters.length < 3 且文件>2MB 才兜底（极大概率是未识别）
  if (chapters.length < 3 && stat.size > 2 * 1024 * 1024) {
    const avgChapterSize = stat.size / chapters.length;
    if (avgChapterSize > 200 * 1024) {
      const fallbackChapters = await fallbackChunk(filePath, encoding, 3000);
      return {
        encoding,
        title,
        author,
        description,
        chapters: fallbackChapters,
        isComic: false,
        contentType: 'text' as const
      };
    }
  }

  // 5. 章节去重 + 过滤过短章节 + 合并相邻同名章节
  //    - 用 Set 记录已见标题（trim().toLowerCase() 作为 key，忽略大小写和空格差异）
  //    - 相邻同名章节合并：扩展前一个章节的 fileLength 到后一个章节的末尾
  //    - 非相邻同名章节：自动加序号后缀（如「楔子（2）」）保留，避免内容丢失
  //    - 跳过内容过短章节（fileLength < 50 字节，只有标题无正文），但保留至少一个章节
  const deduplicatedChapters: ChapterIndex[] = [];
  const seenTitles = new Set<string>();
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const titleKey = ch.title.trim().toLowerCase();

    // "正文"/"目录"等无意义标题且内容过短 → 直接跳过，保留下一个真实章节
    //   见于永生L3"正文"(14字节)，不应合并到第一章而应直接丢弃
    if (ch.fileLength < 50 && /^(正文|目录|内容介绍|简介)$/.test(ch.title.trim())) {
      continue;
    }

    // 过短章节处理（< 50 字节，只有标题无正文）
    //   双重标题模式修复：某些TXT文件存在双重标题（如"1171 犹有文襄"紧跟"第1172章犹有文襄"），
    //   前一个标题的fileLength<50（只有标题行+空行），后一个标题包含实际正文。
    //   旧逻辑直接跳过过短章节 → 章节编号缺失（如1170直接跳到1172）。
    //   新逻辑：保留过短章节标题，合并下一个章节的内容到当前章节，然后跳过下一个章节。
    //   这样1171章标题保留，正文内容从"第1172章犹有文襄"章节合并过来。
    if (ch.fileLength < 50 && deduplicatedChapters.length > 0) {
      // 如果有下一个章节，合并下一个章节的内容到当前章节
      if (i + 1 < chapters.length) {
        const nextCh = chapters[i + 1];
        // 如果下一个章节与当前章节之间有间隙（卷标记行），不合并，直接跳过过短章节
        //   卷标记处理会将上一章 fileLength 截到卷标记行之前，导致 fileLength 很小
        //   此时合并会跨越卷标记行，使卷标记行重新进入章节内容
        if (nextCh.fileOffset > ch.fileOffset + ch.fileLength) {
          continue;
        }
        // 扩展当前章节的fileLength到下一个章节的末尾
        ch.fileLength = nextCh.fileOffset + nextCh.fileLength - ch.fileOffset;
        // 标记下一个章节已被合并（i+1会在循环末尾i++跳过）
        // 但由于for循环会继续处理i+1，我们需要在seenTitles中标记nextCh的标题
        // 以便i+1迭代时走"相邻同名章节合并"逻辑
        // 更简单的方法：直接跳过下一个章节
        seenTitles.add(titleKey);
        deduplicatedChapters.push({ ...ch });
        // 跳过下一个章节（它已被合并到当前章节）
        i++;
        continue;
      }
      // 没有下一个章节，直接跳过过短章节
      continue;
    }

    // 处理重复标题
    if (seenTitles.has(titleKey)) {
      // 如果是相邻的同名章节，合并到上一个
      const last = deduplicatedChapters[deduplicatedChapters.length - 1];
      if (last && last.title.trim().toLowerCase() === titleKey) {
        // 合并：扩展前一个章节的长度到后一个章节的末尾
        last.fileLength = ch.fileOffset + ch.fileLength - last.fileOffset;
        continue;
      }
      // 非相邻同名章节：加序号后缀保留，避免内容丢失
      let suffix = 2;
      let newTitle = `${ch.title}（${suffix}）`;
      while (seenTitles.has(newTitle.trim().toLowerCase())) {
        suffix++;
        newTitle = `${ch.title}（${suffix}）`;
      }
      seenTitles.add(newTitle.trim().toLowerCase());
      deduplicatedChapters.push({ ...ch, title: newTitle });
      continue;
    }

    seenTitles.add(titleKey);
    deduplicatedChapters.push({ ...ch });
  }

  // 重新编号 index
  deduplicatedChapters.forEach((ch, i) => {
    ch.index = i;
  });

  // 确保至少有一个章节（避免全部过滤后为空）
  if (deduplicatedChapters.length === 0 && chapters.length > 0) {
    deduplicatedChapters.push({ ...chapters[0], index: 0 });
  }

  // 用去重后的结果替换原数组
  chapters.length = 0;
  chapters.push(...deduplicatedChapters);

  // TXT 固定为文本类型
  const txtTotalText = chapters.reduce((sum, ch) => sum + ch.fileLength, 0);
  return {
    encoding,
    title,
    author,
    description,
    chapters,
    isComic: false,
    contentType: 'text',
    contentFeatures: { totalTextLength: txtTotalText, pageCount: chapters.length, imageCount: 0 }
  };
}

/* ==================== 分章兜底 ==================== */

/**
 * 分章兜底：无章节标题的 TXT 按字数均分
 *
 * - 每 avgChars 字切为一章，标题"第1节""第2节"…
 * - 在行边界切分（不会把一行切成两半）
 * - 末尾短章节合并：若最后一章字数 < avgChars/3，合并到前一章，
 *   避免传统文学/短文本产生过短末尾章节
 * - 传统文学支持：无章节标记的整篇文本（如古文、诗词集、英文文献）
 *   总字数 < avgChars 时直接作为一章，不强制切分
 *
 * @param filePath 文件路径
 * @param encoding 编码
 * @param avgChars 每章平均字数（默认 3000）
 * @returns 章节索引数组
 */
export async function fallbackChunk(filePath: string, encoding: string, avgChars = 3000): Promise<ChapterIndex[]> {
  const stat = statSync(filePath);
  const totalSize = stat.size;

  if (totalSize === 0) return [];

  const chapters: ChapterIndex[] = [];
  let currentChapterStart = 0;
  let charCount = 0;
  let chapterIndex = 0;

  await streamLinesByByte(filePath, encoding, ({ line, nextByteOffset }) => {
    charCount += line.length + 1; // +1 for newline
    if (charCount >= avgChars && nextByteOffset < totalSize) {
      // 切分一章
      chapters.push({
        index: chapterIndex,
        title: `第${chapterIndex + 1}节`,
        fileOffset: currentChapterStart,
        fileLength: nextByteOffset - currentChapterStart
      });
      chapterIndex++;
      currentChapterStart = nextByteOffset;
      charCount = 0;
    }
  });

  // 最后一章
  if (currentChapterStart < totalSize) {
    chapters.push({
      index: chapterIndex,
      title: `第${chapterIndex + 1}节`,
      fileOffset: currentChapterStart,
      fileLength: totalSize - currentChapterStart
    });
  }

  // 末尾短章节合并：若最后一章字数过短（< avgChars/3），合并到前一章
  //    避免传统文学/短文本均分后产生过短末尾章节（如 3000 字均分后末尾仅 200 字）
  //    仅当存在前一章时合并，保证至少保留一个章节
  if (chapters.length >= 2) {
    const lastChapter = chapters[chapters.length - 1];
    // 估算最后一章字数（用字节长度粗略估算，中文约 2 字节/字，英文约 1 字节/字）
    const lastChapterChars = lastChapter.fileLength / 2;
    if (lastChapterChars < avgChars / 3) {
      const prevChapter = chapters[chapters.length - 2];
      // 合并：扩展前一章的长度到末尾
      prevChapter.fileLength = lastChapter.fileOffset + lastChapter.fileLength - prevChapter.fileOffset;
      chapters.pop();
    }
  }

  // 重新编号 index（合并后可能减少一章，需重新连续编号）
  chapters.forEach((ch, i) => {
    ch.index = i;
  });

  return chapters;
}

/* ==================== 按需读取 ==================== */

/**
 * 按需读取章节正文
 *
 * 用 fs.createReadStream 按字节范围读取，iconv-lite 转码，清洗后返回。
 * 不全量加载文件，仅读取指定章节的字节范围。
 *
 * @param filePath 文件路径
 * @param encoding 编码
 * @param fileOffset 章节起始字节偏移
 * @param fileLength 章节字节长度
 * @returns 清洗后的章节正文
 * @throws TxtParseError 读取失败
 */
export async function readChapter(
  filePath: string,
  encoding: string,
  fileOffset: number,
  fileLength: number
): Promise<string> {
  if (fileLength <= 0) {
    return '';
  }

  return new Promise<string>((resolve, reject) => {
    // fs.createReadStream 的 end 是 inclusive，所以 end = fileOffset + fileLength - 1
    const stream = createReadStream(filePath, {
      start: fileOffset,
      end: fileOffset + fileLength - 1,
      highWaterMark: 64 * 1024
    });

    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('end', () => {
      const buf = Buffer.concat(chunks);
      const raw = decodeBuffer(buf, encoding);
      // 删除第一行章节标题行（fileOffset 指向标题行，读取内容包含标题）
      // 否则正文第一行就是章节标题文本，造成正文内容包含章节名
      // 修复：matchChapterTitle 不做上下文过滤，纯数字行也匹配，
      //   正文首行"1923年""3."等会被误删。增加严格约束：
      //   1. 标题行必须短（<60字，与 isChapterLine 一致）
      //   2. 不含句号（正文段落特征）
      //   3. 不是纯数字行（避免误删"1923"等年份/编号）
      //   4. 用 isChapterLine 而非 matchChapterTitle（有上下文过滤）
      const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      if (lines.length > 0) {
        const firstLine = lines[0].trim();
        if (
          firstLine.length < 60 &&
          !firstLine.includes('。') &&
          !/^\s*\d{1,6}\s*$/.test(firstLine) &&
          isChapterLine(firstLine, true)
        ) {
          lines.shift(); // 删除标题行
        }
      }
      const contentWithoutTitle = lines.join('\n');
      const cleaned = cleanContent(contentWithoutTitle);
      resolve(cleaned);
    });
    stream.on('error', (err) => {
      reject(new TxtParseError(`读取章节失败: ${err.message}`, err));
    });
  });
}

/* ==================== 内容清洗 ==================== */

/**
 * 古文句读分句处理
 *
 * 古文（如《诗经》）常用全角顿号"、"做句读，阅读器不识别导致文字挤成一坨。
 * 当一行中连续出现3+个"、"且不含现代中文句号"。"和逗号"，"时，
 * 判定为古文句读格式，在每个"、"后换行使每句独占一行。
 *
 * 判断条件（全部满足才处理）：
 * - 一行中"、"（U+3001）出现3次以上
 * - 该行不包含"。"（现代中文句号）
 * - 该行不包含"，"（现代中文逗号）
 *
 * 注意：只处理全角顿号"、"（U+3001），不处理半角逗号","。
 *       避免误判现代中文中正常的顿号（如"苹果、橘子、香蕉"只有2个顿号）。
 */
function splitClassicalPunctuation(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const dunhaoCount = (line.match(/、/g) || []).length;
      if (dunhaoCount >= 3 && !line.includes('。') && !line.includes('，')) {
        return line.replace(/、/g, '、\n');
      }
      return line;
    })
    .join('\n');
}

/**
 * 章节内容清洗
 *
 * 处理步骤：
 * 1. 统一换行符 \r\n / \r → \n
 * 2. 过滤非法控制字符和私用区字符（原文中混入的垃圾数据）
 * 3. 去行首尾空白
 * 4. 合并连续空行（最多保留 1 个）
 * 5. 段落首行缩进（两个全角空格 "　　"），章节标题行不缩进
 * 6. 去首尾空行
 * 7. 去常见广告标记（可选）
 *
 * @param raw 原始正文
 * @returns 清洗后的正文
 */
export function cleanContent(raw: string): string {
  // 1. 统一换行符
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 2. 过滤非法控制字符和私用区字符
  //    见于《万相天师》等文件：原文中混入 U+0001-U+001F（除 \t \n）、U+007F、
  //    U+E000-U+F8FF（私用区 PUA）等非法文本字符，显示为乱码方块
  //    保留 \t(U+0009)、\n(U+000A)，其余 C0/C1 控制字符和 PUA 字符全部删除
  const cleanedText = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uE000-\uF8FF]/g, '');

  // 3. 按行处理
  const lines = cleanedText.split('\n');

  // 4. 去行首尾空白，同时记录原行是否有缩进（用于步骤6决定是否加缩进）
  //    修复：原逻辑 trim 后统一加"　　"缩进，破坏诗歌/代码块/引用等特殊格式
  //    新逻辑：保留原缩进信息，有原缩进的行不加缩进，无缩进的行才加"　　"
  const trimmedLines: string[] = [];
  const hadIndent: boolean[] = [];
  for (const line of lines) {
    // 检测原行是否有缩进：全角空格(U+3000)、制表符(\t)、2+半角空格
    hadIndent.push(/^[　\t]|^ {2,}/.test(line));
    trimmedLines.push(line.trim());
  }

  // 5. 合并连续空行（最多保留 1 个），同步维护 hadIndent
  const mergedLines: string[] = [];
  const mergedHadIndent: boolean[] = [];
  for (let i = 0; i < trimmedLines.length; i++) {
    const line = trimmedLines[i];
    if (line === '') {
      if (mergedLines.length === 0 || mergedLines[mergedLines.length - 1] !== '') {
        mergedLines.push(line);
        mergedHadIndent.push(false);
      }
    } else {
      mergedLines.push(line);
      mergedHadIndent.push(hadIndent[i]);
    }
  }

  // 6. 段落首行缩进（章节标题行不缩进，图片占位标记行不缩进）
  //    修复：原逻辑对所有非空行强制加"　　"缩进，破坏诗歌/代码块/引用等特殊格式
  //    新逻辑：保留原缩进信息，有原缩进的行不加缩进，无缩进的行才加"　　"
  //    这样既保持普通小说的段落缩进，又不破坏特殊格式
  const indentedLines = mergedLines.map((line, i) => {
    if (line === '') return line;
    if (matchChapterTitle(line)) return line;
    if (line.startsWith('[IMG:')) return line; // 图片占位标记不缩进
    if (mergedHadIndent[i]) return line; // 原行已有缩进，保留原样
    return '　　' + line;
  });

  // 7. 去首尾空行
  let result = indentedLines.join('\n');
  result = result.replace(/^\n+/, '').replace(/\n+$/, '');

  // 8. 去广告
  result = removeAds(result);

  // 9. 古文句读分句：一行中3+个"、"且无"。"且无"，"时，每个"、"后换行
  //    使诗经/古文等用顿号做句读的文本不挤成一坨
  result = splitClassicalPunctuation(result);

  return result;
}

/**
 * 去常见广告标记
 *
 * 第一版仅去典型广告行，后续可扩展为规则引擎。
 * 去除：
 * - "本文来自xxx" / "本章节来自xxx"
 * - "请搜索xxx" / "更多精彩请访问xxx"
 * - 独立 URL 行
 * - "一秒记住xxx" / "无弹窗，更新快" 等小说网广告（新增）
 * - "(本章完)" / "（本章完）" 章节结束标记（新增）
 */
function removeAds(text: string): string {
  // 所有正则加 ^ 行首锚定，避免误删正文中含广告关键词的句子
  const adPatterns = [
    /^本文来自.+/,
    /^本章节来自.+/,
    /^请搜索.+/,
    /^更多精彩请访问.+/,
    /^https?:\/\/\S+$/,
    // 新增：小说网广告
    /^一秒记住.+/,
    /^无弹窗.*更新快/,
    /^\(本章完\)/,
    /^（本章完）/,
    // 新增：求书网等网站广告
    /^求书网.+/,
    // 新增：草莓小说网等广告
    /.*WWW\..*\.Com.*无弹窗.*/,
    // 新增：笔趣阁等网站广告
    /^.*请记住.*小说网.*/,
    // 新增：章节末尾的网站URL
    /^https?:\/\/www\.\S+\.(com|cc|org|net|me|info)$/
  ];

  const lines = text.split('\n');
  const filtered = lines.filter((line) => {
    for (const pattern of adPatterns) {
      if (pattern.test(line)) return false;
    }
    return true;
  });

  return filtered.join('\n');
}

/**
 * 自动检测 TXT 文件的解析模式
 *
 * 检测策略：
 * - 读取文件前 20KB，统计 Markdown 标题行（#/##/###）和小说章节标题行
 * - Markdown 标题 ≥ 2 → 'markdown'
 * - 小说章节标题 ≥ 3 → 'novel'
 * - 否则 → 'plain'
 */
export function detectParseMode(content: string): ParseMode {
  const lines = content.split('\n');

  let markdownHeaders = 0;
  let novelChapters = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Markdown ATX 标题：# / ## / ### / #### / ##### / ######
    if (/^#{1,6}\s+\S/.test(trimmed)) {
      markdownHeaders++;
      continue;
    }

    // 小说章节标题（复用 isChapterLine 的快速过滤）
    if (isChapterLine(trimmed, true)) {
      novelChapters++;
    } else if (line.length > 500) {
      // 超长行内嵌章节标记（如014交错时光207877字行含76个标记）
      //   isChapterLine 的60字长度限制会过滤超长行，需用 findEmbeddedChapters 检查
      const embedded = findEmbeddedChapters(line);
      if (embedded && embedded.length > 0) {
        novelChapters += embedded.length;
      }
    }
  }

  // 修复：阈值从3降到2，使短诗集/短篇集（如《诗经》只有2个章节标记）也能被识别为novel模式分章
  //   原3阈值会漏判短篇集；2个章节标记对诗集已足够可靠
  if (markdownHeaders >= 3) return 'markdown';
  if (novelChapters >= 2) return 'novel';
  return 'plain';
}

/**
 * 解析 Markdown 文件，按 ATX 标题（#/##/###）分节
 *
 * - 每个标题行开始一个新章节，标题文本作为章节标题
 * - 第一个标题之前的内容作为"前言"章节
 * - H1 标题作为卷层级（volume），H2+ 作为章节
 * - contentType 设为 'markdown'，阅读器据此启用 Markdown 渲染
 */
async function parseMarkdown(
  filePath: string,
  encoding: string,
  stat: { size: number },
  title: string,
  author: string,
  onProgress?: (p: number) => void
): Promise<ParsedBook> {
  const chapters: ChapterIndex[] = [];
  let chapterIndex = 0;
  let currentVolume: string | null = null;

  // 标题/作者提取
  let detectedTitle = title;
  let detectedAuthor = author;
  let description = '';

  interface MdSection {
    title: string;
    fileOffset: number;
    level: number;
  }

  const sections: MdSection[] = [];
  let firstHeaderOffset = -1;

  await streamLinesByByte(
    filePath,
    encoding,
    ({ line, byteOffset }) => {
      const trimmed = line.trim();
      const mdMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);

      if (mdMatch) {
        const level = mdMatch[1].length;
        const headerTitle = mdMatch[2].trim();

        if (firstHeaderOffset < 0) {
          firstHeaderOffset = byteOffset;
        }

        sections.push({ title: headerTitle, fileOffset: byteOffset, level });
      }
    },
    onProgress
  );

  // 提取元数据：第一个 H1 作为标题，紧跟的段落作为描述
  if (sections.length > 0 && sections[0].level === 1) {
    detectedTitle = sections[0].title;
  }

  // 前言（第一个标题之前的内容）
  if (firstHeaderOffset > 0) {
    chapters.push({
      index: chapterIndex++,
      title: '前言',
      fileOffset: 0,
      fileLength: firstHeaderOffset,
      contentType: 'markdown',
      volume: null
    });
  }

  // 按标题分节
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const nextOffset = i + 1 < sections.length ? sections[i + 1].fileOffset : stat.size;
    const fileLength = nextOffset - sec.fileOffset;

    // H1 作为卷标记
    if (sec.level === 1) {
      currentVolume = sec.title;
    }

    chapters.push({
      index: chapterIndex++,
      title: sec.title,
      fileOffset: sec.fileOffset,
      fileLength,
      contentType: 'markdown',
      volume: sec.level <= 1 ? null : currentVolume
    });
  }

  // 无标题 → 整文件作为一个章节
  if (chapters.length === 0) {
    chapters.push({
      index: 0,
      title: detectedTitle,
      fileOffset: 0,
      fileLength: stat.size,
      contentType: 'markdown',
      volume: null
    });
  }

  return {
    title: detectedTitle,
    author: detectedAuthor,
    description,
    encoding,
    chapters
  };
}

/**
 * 解析纯文本文件，整篇作为单章节（连续阅读模式）
 *
 * 不做任何章节分割，整个文件内容作为一个章节。
 * 适用于文献、日志、代码、短文等无章节结构的文本。
 */
async function parsePlainText(
  encoding: string,
  stat: { size: number },
  title: string,
  author: string,
  onProgress?: (p: number) => void
): Promise<ParsedBook> {
  if (onProgress) onProgress(1);

  return {
    title,
    author,
    description: '',
    encoding,
    chapters: [
      {
        index: 0,
        title,
        fileOffset: 0,
        fileLength: stat.size,
        contentType: 'text',
        volume: null
      }
    ]
  };
}

/* ==================== TxtParser 类（实现 FileParser 接口） ==================== */

/**
 * TXT 解析器类，实现 FileParser 接口
 *
 * 上层通过 FileParser 接口统一调用，无需关心具体格式。
 * 内部缓存 parse 时检测的 encoding，供 readChapter(chapter) 使用。
 *
 * 注意：每个文件应使用独立的 TxtParser 实例（或使用导出的函数直接传 encoding）。
 */
export class TxtParser implements FileParser {
  /** 上次 parse 检测到的编码 */
  private lastEncoding: string = 'UTF-8';
  /** 解析模式（auto/novel/markdown/plain） */
  parseMode: ParseMode = 'auto';

  async parse(filePath: string, onProgress?: (p: number) => void, originalFileName?: string): Promise<ParsedBook> {
    const result = await parseTxt(filePath, onProgress, originalFileName, this.parseMode);
    this.lastEncoding = result.encoding;
    return result;
  }

  async readChapter(filePath: string, chapter: ChapterIndex, _imageDir?: string): Promise<string> {
    return readChapter(filePath, this.lastEncoding, chapter.fileOffset, chapter.fileLength);
  }
}

/* ==================== epub-parser.ts（EPUB解析器） ==================== */
/**
 * EPUB 解析器
 *
 * 核心设计：不全量解压、不全量入内存，按需读取单个章节。
 *
 * 实现方案：
 * - parse() 时用 node-stream-zip 打开 EPUB（不解压），读 OPF/NCX/nav 建立章节索引
 * - 每章的 ZIP entry name 存到 ChapterIndex.url 字段
 * - ChapterIndex.fileOffset 存 spine 序号，fileLength 存 entry 未压缩大小（参考用）
 * - readChapter() 时用 node-stream-zip 的 entry() 方法按需读取单个 HTML entry
 * - 提取的封面图片保存到 covers/ 目录
 *
 * 支持 EPUB2（NCX 目录）和 EPUB3（nav.xhtml 导航文件）两种格式。
 *
 * 导出：
 * - parseEpub(filePath, onProgress?): Promise<ParsedBook>
 * - readEpubChapter(filePath, chapter): Promise<string>
 * - extractEpubCover(filePath, destPath): Promise<string | null>
 * - EpubParser 类（实现 FileParser 接口）
 */
