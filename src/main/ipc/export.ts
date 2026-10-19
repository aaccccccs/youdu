/**
 * 数据导出 IPC（TXT / EPUB / CBZ）
 */
import { app, dialog, BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { join, basename } from 'path';
import { readdir, stat, unlink, rm, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

import { getCachePath } from '../utils';
import { readChapterContent, readChapterImages } from '../core/chapter-reader';
import * as BookRepo from '../db/repositories';
import * as ChapterRepo from '../db/repositories';
import { tMain } from '../i18n';

import { IPC_CHANNELS, wrapHandler, assertPositiveInt } from './shared';

// epub-gen 是 CommonJS 模块，Electron 主进程编译后也是 CommonJS 格式。
// 直接用 require 加载最可靠 — createRequire(import.meta.url) 在打包后 asar
// 环境中路径解析可能失败，动态 import() 也有 ESM/CJS 互操作问题。
// 懒加载：避免顶层 require 导致模块加载强依赖，若 epub-gen 未安装不会导致整个 export 模块加载失败
let _EPub: any;
// @ts-ignore — TypeScript ESM 模式下 require 不可用，但编译后运行时可用
function getEPub(): any {
  if (!_EPub) {
    // @ts-ignore
    _EPub = require('epub-gen');
  }
  return _EPub;
}

/**
 * 清空指定目录下的所有文件（递归子目录）
 *
 * 出于安全考虑只清空 cache 目录内容，不删除目录本身。
 * B-18 修复：递归删除子目录内容，避免子目录中的缓存文件残留。
 */
async function clearDirectoryFiles(dirPath: string): Promise<number> {
  if (!existsSync(dirPath)) return 0;

  const entries = await readdir(dirPath, { withFileTypes: true });
  let deletedCount = 0;

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(dirPath, entry.name);
    const info = await stat(fullPath);
    if (info.isFile()) {
      await unlink(fullPath);
      deletedCount++;
    } else if (info.isDirectory()) {
      deletedCount += await clearDirectoryFiles(fullPath);
      await rm(fullPath, { recursive: true, force: true });
    }
  }

  return deletedCount;
}

/* ─── 书籍章节内容收集 ─── */

/** 单章内容（标题 + 正文） */
interface ChapterContentResult {
  /** 章节标题（无标题时回退为"第 N 章"） */
  title: string;
  /** 章节正文（已应用去广告/繁简/排版） */
  content: string;
  /** 是否为图片章节（漫画模式） */
  isImage: boolean;
  /** 图片文件路径列表（仅 isImage=true 时有值，绝对路径） */
  imagePaths: string[];
}

/**
 * 读取书籍全部章节内容
 *
 * 遍历章节索引，逐章调用 readChapterContent 读取正文。
 * 对于漫画图片章节（content_type='image'），调用 readChapterImages 读取图片路径。
 * 读取失败的章节用占位文本替代，不中断整体导出。
 */
async function collectBookChapters(bookId: number, isComic: boolean = false): Promise<ChapterContentResult[]> {
  const indexes = ChapterRepo.listChapterIndexes(bookId);
  const results: ChapterContentResult[] = [];

  for (const idx of indexes) {
    const title = idx.title?.trim() || `第 ${idx.chapter_index + 1} 章`;
    const isImageChapter = isComic && idx.content_type === 'image';

    if (isImageChapter) {
      // 漫画图片章节：读取图片路径列表
      try {
        const imagePaths = await readChapterImages(bookId, idx.chapter_index);
        results.push({
          title,
          content: '',
          isImage: true,
          imagePaths
        });
      } catch (err) {
        console.warn(`[export] 读取漫画图片失败 bookId=${bookId} chapterIndex=${idx.chapter_index}:`, err);
        results.push({
          title,
          content: `[此章节图片读取失败: ${(err as Error).message}]`,
          isImage: false,
          imagePaths: []
        });
      }
      continue;
    }

    // 文字章节：读取正文
    try {
      const content = await readChapterContent(bookId, idx.chapter_index);
      results.push({
        title,
        content,
        isImage: false,
        imagePaths: []
      });
    } catch (err) {
      // 单章读取失败不中断导出，用错误提示替代正文
      console.warn(`[export] 读取章节失败 bookId=${bookId} chapterIndex=${idx.chapter_index}:`, err);
      results.push({
        title,
        content: `[此章节读取失败: ${(err as Error).message}]`,
        isImage: false,
        imagePaths: []
      });
    }
  }

  return results;
}

/* ─── TXT 导出 ─── */

/** TXT 章节分隔线 */
const TXT_CHAPTER_SEPARATOR = '\n\n\n' + '─'.repeat(40) + '\n\n';

/**
 * 把书籍章节拼接为 TXT 文本
 *
 * 格式：
 * - 文件头部：书名 / 作者 / 简介（可选）
 * - 每章：章节标题 + 空行 + 正文
 * - 章间用分隔线隔开
 */
function buildTxtContent(
  book: { title: string; author: string | null; intro: string | null },
  chapters: ChapterContentResult[]
): string {
  const lines: string[] = [];

  // 文件头：书名
  lines.push(book.title);
  // 作者
  if (book.author) {
    lines.push(`作者：${book.author}`);
  }
  // 简介
  if (book.intro) {
    lines.push('');
    lines.push(book.intro);
  }
  // 头部与正文之间的分隔
  lines.push(TXT_CHAPTER_SEPARATOR);

  // 各章正文
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    if (i > 0) {
      lines.push(TXT_CHAPTER_SEPARATOR);
    }
    lines.push(ch.title);
    lines.push('');
    lines.push(ch.content);
  }

  return lines.join('\n');
}

/**
 * 弹出保存对话框，返回用户选择的路径；用户取消返回 null
 */
async function showSaveDialogForExport(
  win: BrowserWindow | null,
  title: string,
  defaultName: string,
  extensions: string[]
): Promise<string | null> {
  const filterName = extensions[0].toUpperCase() + ' 文件';
  const options: Electron.SaveDialogOptions = {
    title,
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions }]
  };

  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);

  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}

/**
 * 把字符串中的文件名非法字符替换为下划线
 *
 * Windows / macOS / Linux 通用非法字符：< > : " / \ | ? *
 */
function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || '未命名';
}

/* ─── EPUB 导出 ─── */

/**
 * 把纯文本章节正文转换为简单 HTML
 *
 * - 按空行分段，每段用 <p> 包裹
 * - 段内换行用 <br> 保留
 * - HTML 转义特殊字符
 */
function textToHtml(text: string): string {
  if (!text) return '<p></p>';

  // HTML 转义
  const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 按空行分段
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  if (paragraphs.length === 0) return '<p></p>';

  return paragraphs
    .map((p) => {
      // 段内换行 → <br>
      const withBr = escape(p.trim()).replace(/\n/g, '<br/>');
      return `<p>${withBr}</p>`;
    })
    .join('\n');
}

/**
 * 把漫画图片路径列表转换为 HTML（每张图片一个 <img> 标签）
 *
 * epub-gen 会自动扫描 HTML 中的 <img> 标签，把 src 指向的本地图片
 * 复制到 EPUB 的 images/ 目录，并重写 src 为相对路径。
 */
function comicImagesToHtml(imagePaths: string[]): string {
  if (imagePaths.length === 0) return '<p>（此章节无图片）</p>';

  return imagePaths
    .map((imgPath) => {
      // 用正斜杠确保跨平台兼容
      const src = imgPath.replace(/\\/g, '/');
      return `<div style="text-align:center;margin:0;padding:0;"><img src="${src}" alt="漫画图片" style="width:100%;display:block;"/></div>`;
    })
    .join('\n');
}

/**
 * 自定义 OPF 模板内容（EPUB3，含漫画标记）
 */
const COMIC_OPF_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf"
         version="3.0"
         unique-identifier="BookId"
         xmlns:dc="http://purl.org/dc/elements/1.1/"
         xmlns:dcterms="http://purl.org/dc/terms/"
         xml:lang="en"
         xmlns:media="http://www.idpf.org/epub/vocab/overlays/#"
         prefix="ibooks: http://vocabulary.itunes.apple.com/rdf/ibooks/vocabulary-extensions-1.0/">

    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"
              xmlns:opf="http://www.idpf.org/2007/opf">

        <dc:identifier id="BookId"><%= id %></dc:identifier>
        <meta refines="#BookId" property="identifier-type" scheme="onix:codelist5">22</meta>
        <meta property="dcterms:identifier" id="meta-identifier">BookId</meta>
        <dc:title><%= title %></dc:title>
        <meta property="dcterms:title" id="meta-title"><%= title %></meta>
        <dc:language><%= lang || "en" %></dc:language>
        <meta property="dcterms:language" id="meta-language"><%= lang || "en" %></meta>
        <meta property="dcterms:modified"><%= (new Date()).toISOString().split(".")[0]+ "Z" %></meta>
        <dc:creator id="creator"><%= author.length ? author.join(",") : author %></dc:creator>
        <meta refines="#creator" property="file-as"><%= author.length ? author.join(",") : author %></meta>
        <meta property="dcterms:publisher"><%= publisher || "anonymous" %></meta>
        <dc:publisher><%= publisher || "anonymous" %></dc:publisher>
        <% var date = new Date(); var year = date.getFullYear(); var month = date.getMonth() + 1; var day = date.getDate(); var stringDate = "" + year + "-" + month + "-" + day; %>
        <meta property="dcterms:date"><%= stringDate %></meta>
        <dc:date><%= stringDate %></dc:date>
        <meta property="dcterms:rights">All rights reserved</meta>
        <dc:rights>Copyright &#x00A9; <%= (new Date()).getFullYear() %> by <%= publisher || "anonymous" %></dc:rights>
        <meta name="cover" content="image_cover"/>
        <meta name="generator" content="epub-gen" />
        <meta property="ibooks:specified-fonts">true</meta>
        <meta name="comic" content="true"/>
        <meta name="primary-writing-mode" content="horizontal"/>

    </metadata>

    <manifest>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
        <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="css" href="style.css" media-type="text/css" />

        <% if(locals.cover) { %>
        <item id="image_cover" href="cover.<%= _coverExtension %>" media-type="<%= _coverMediaType %>" />
        <% } %>
        
        <% images.forEach(function(image, index){ %>
        <item id="image_<%= index %>" href="images/<%= image.id %>.<%= image.extension %>" media-type="<%= image.mediaType %>" />
        <% }) %>
        
        <% content.forEach(function(content, index){ %>
        <item id="content_<%= index %>_<%= content.id %>" href="<%= content.href %>" media-type="application/xhtml+xml" />
        <% }) %>

        <% fonts.forEach(function(font, index){%>
        <item id="font_<%= index%>" href="fonts/<%= font %>" media-type="application/x-font-ttf" />
        <%})%>
    </manifest>

    <spine toc="ncx">
        <% content.forEach(function(content, index){ %>
            <% if(content.beforeToc && !content.excludeFromToc){ %>
                <itemref idref="content_<%= index %>_<%= content.id %>"/>
            <% } %>
        <% }) %>
        <itemref idref="toc" />
        <% content.forEach(function(content, index){ %>
            <% if(!content.beforeToc && !content.excludeFromToc){ %>
                <itemref idref="content_<%= index %>_<%= content.id %>"/>
            <% } %>
        <% }) %>
    </spine>
    <guide>
        <reference type="text" title="Table of Content" href="toc.xhtml"/>
    </guide>
</package>`;

/**
 * 生成 EPUB 文件到指定路径
 *
 * 使用 epub-gen 库，每章作为一节，正文转换为 HTML。
 * 处理 CommonJS/ESM 互操作：epub-gen 是 CommonJS 模块，
 * 动态 import() 返回的命名空间对象中 .default 为构造函数。
 * 同时将 Q promise 包装为原生 Promise，确保 await 行为一致。
 */
async function generateEpub(
  book: { title: string; author: string | null; intro: string | null },
  chapters: ChapterContentResult[],
  outputPath: string,
  isComic: boolean = false,
  coverPath: string | null = null
): Promise<void> {
  // 构建章节内容：漫画图片章节用 <img> 标签，文字章节用 textToHtml
  const epubChapters = chapters.map((ch) => ({
    title: ch.title,
    data: ch.isImage ? comicImagesToHtml(ch.imagePaths) : textToHtml(ch.content)
  }));

  // epub-gen 默认将临时目录设在 node_modules/epub-gen/tempDir/，
  // Electron 打包后该路径位于 app.asar 归档内（只读文件），fs.mkdirSync 会抛出 ENOTDIR。
  // 必须将 tempDir 指向真实的文件系统路径。
  const tempDir = join(app.getPath('temp'), 'epub-gen');

  // 构建选项
  const options: Record<string, unknown> = {
    title: book.title,
    author: book.author ?? '未知',
    description: book.intro ?? book.title,
    publisher: '幽读',
    lang: 'zh',
    content: epubChapters,
    appendChapterTitles: false,
    tempDir
  };

  // 封面：传入则包含在 EPUB 中
  if (coverPath && existsSync(coverPath)) {
    options.cover = coverPath;
  }

  // 漫画：使用自定义 OPF 模板添加漫画标记
  if (isComic) {
    // 把自定义 OPF 模板写到临时文件，传给 epub-gen
    const customOpfPath = join(tempDir, `comic-opf-${Date.now()}.opf.ejs`);
    try {
      await mkdir(tempDir, { recursive: true });
      await writeFile(customOpfPath, COMIC_OPF_TEMPLATE, 'utf-8');
      options.customOpfTemplatePath = customOpfPath;
    } catch (err) {
      console.warn('[export] 写入自定义 OPF 模板失败，使用默认模板:', err);
    }
  }

  const EPub = getEPub();
  const epub = new EPub(options, outputPath);
  try {
    await Promise.resolve(epub.promise);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    if (isComic && options.customOpfTemplatePath) {
      try {
        await unlink(options.customOpfTemplatePath as string);
      } catch {
        // 清理失败忽略
      }
    }
  }
}

/* ─── CBZ 导出（漫画格式） ─── */

/**
 * 把漫画导出为 CBZ 文件（ZIP 包含所有章节图片）
 *
 * CBZ 是漫画归档格式，本质是 ZIP 文件，包含按顺序命名的图片。
 * 导入时会被 comic-parser 识别为漫画，每张图片作为一个章节。
 *
 * 使用 archiver 库（v8，纯 ESM）创建 ZIP。
 */
async function generateCbz(chapters: ChapterContentResult[], outputPath: string): Promise<void> {
  // archiver v8 起改为纯 ESM 包（无 CJS 入口）且导出方式从函数工厂
  // archiver('zip', options) 变更为命名导出类（ZipArchive 等）。
  // 本文件为 CJS 上下文，使用 dynamic import 加载 ESM 入口，
  // 用 ZipArchive 类替代原工厂函数，其余方法/事件（file/pipe/finalize/
  // abort/'error' 等）在 v8 中均保留。
  // @ts-ignore — archiver v8 未提供类型声明
  const { ZipArchive } = await import('archiver');
  const fs = require('fs');

  return new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    let settled = false;

    output.on('close', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    output.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        try {
          archive.abort();
        } catch {
          /* abort 失败忽略 */
        }
        reject(err);
      }
    });
    archive.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        try {
          output.destroy();
        } catch {
          /* destroy 失败忽略 */
        }
        reject(err);
      }
    });

    archive.pipe(output);

    // 按章节顺序添加图片，用全局序号命名确保排序正确
    let globalIndex = 0;
    const padWidth = String(chapters.reduce((sum, ch) => sum + ch.imagePaths.length, 0)).length;

    for (const ch of chapters) {
      for (const imgPath of ch.imagePaths) {
        if (existsSync(imgPath)) {
          const ext = basename(imgPath).split('.').pop() || 'jpg';
          const paddedIndex = String(globalIndex).padStart(padWidth, '0');
          archive.file(imgPath, { name: `${paddedIndex}.${ext}` });
          globalIndex++;
        }
      }
    }

    archive.finalize();
  });
}

/** 注册书籍格式导出与缓存管理 IPC handler */
export function registerExportIpc(getMainWindow: () => BrowserWindow | null): void {
  // 清除缓存目录
  ipcMain.handle(
    IPC_CHANNELS.EXPORT_CLEAR_CACHE,
    wrapHandler(async () => {
      const cachePath = getCachePath();
      const deleted = await clearDirectoryFiles(cachePath);
      return { success: true, deletedCount: deleted, cachePath };
    })
  );

  /* ─── 导出单本书为 TXT ─── */
  ipcMain.handle(
    IPC_CHANNELS.EXPORT_BOOK_TXT,
    wrapHandler(async (event, bookId: number): Promise<string | null> => {
      assertPositiveInt(bookId, 'bookId');
      const book = BookRepo.getBookById(bookId);
      if (!book) {
        throw new Error(`书籍不存在: id=${bookId}`);
      }

      // 1. 读取全部章节内容（漫画模式下图片章节返回空 content）
      const isComic = book.is_comic === 1;
      const chapters = await collectBookChapters(bookId, isComic);
      if (chapters.length === 0) {
        throw new Error('书籍没有章节，无法导出');
      }

      // 2. 拼接为 TXT 文本
      const txtContent = buildTxtContent(book, chapters);

      // 3. 弹出保存对话框
      const win = getMainWindow() ?? BrowserWindow.fromWebContents(event.sender);
      const defaultName = `${sanitizeFileName(book.title)}.txt`;
      const filePath = await showSaveDialogForExport(win, '选择 TXT 导出保存位置', defaultName, ['txt']);
      if (!filePath) return null;

      // 4. 写入文件（UTF-8 BOM，便于部分编辑器识别编码）
      const BOM = '\uFEFF';
      await writeFile(filePath, BOM + txtContent, 'utf-8');

      return filePath;
    })
  );

  /* ─── 导出单本书为 EPUB ─── */
  ipcMain.handle(
    IPC_CHANNELS.EXPORT_BOOK_EPUB,
    wrapHandler(async (event, bookId: number): Promise<string | null> => {
      assertPositiveInt(bookId, 'bookId');
      const book = BookRepo.getBookById(bookId);
      if (!book) {
        throw new Error(`书籍不存在: id=${bookId}`);
      }

      // 1. 读取全部章节内容（漫画模式下图片章节读取图片路径）
      const isComic = book.is_comic === 1;
      const chapters = await collectBookChapters(bookId, isComic);
      if (chapters.length === 0) {
        throw new Error('书籍没有章节，无法导出');
      }

      // 2. 弹出保存对话框
      const win = getMainWindow() ?? BrowserWindow.fromWebContents(event.sender);
      const defaultName = `${sanitizeFileName(book.title)}.epub`;
      const filePath = await showSaveDialogForExport(win, '选择 EPUB 导出保存位置', defaultName, ['epub']);
      if (!filePath) return null;

      // 3. 生成 EPUB（传入封面路径和漫画标记）
      await generateEpub(book, chapters, filePath, isComic, book.cover);

      return filePath;
    })
  );

  /* ─── 导出单本漫画为 CBZ（ZIP 包含所有图片） ─── */
  ipcMain.handle(
    IPC_CHANNELS.EXPORT_BOOK_CBZ,
    wrapHandler(async (event, bookId: number): Promise<string | null> => {
      assertPositiveInt(bookId, 'bookId');
      const book = BookRepo.getBookById(bookId);
      if (!book) {
        throw new Error(`书籍不存在: id=${bookId}`);
      }

      // 漫画导出为 CBZ：收集所有章节图片打包为 ZIP
      const isComic = book.is_comic === 1;
      if (!isComic) {
        throw new Error('该书籍不是漫画，无法导出为 CBZ 格式');
      }

      // 1. 读取全部章节图片
      const chapters = await collectBookChapters(bookId, true);
      if (chapters.length === 0) {
        throw new Error('书籍没有章节，无法导出');
      }

      // 检查是否有图片
      const totalImages = chapters.reduce((sum, ch) => sum + ch.imagePaths.length, 0);
      if (totalImages === 0) {
        throw new Error('漫画没有图片，无法导出为 CBZ');
      }

      // 2. 弹出保存对话框
      const win = getMainWindow() ?? BrowserWindow.fromWebContents(event.sender);
      const defaultName = `${sanitizeFileName(book.title)}.cbz`;
      const filePath = await showSaveDialogForExport(win, '选择 CBZ 导出保存位置', defaultName, ['cbz']);
      if (!filePath) return null;

      // 3. 生成 CBZ
      await generateCbz(chapters, filePath);

      return filePath;
    })
  );

  /* ─── 导出全部书籍为 TXT（每本书一个文件，保存到用户选择的目录） ─── */
  ipcMain.handle(
    IPC_CHANNELS.EXPORT_ALL_BOOKS_TXT,
    wrapHandler(async (event): Promise<{ dirPath: string; count: number; skipped: string[] } | null> => {
      const books = BookRepo.listBooks({});
      if (books.length === 0) {
        throw new Error('书架没有书籍，无法导出');
      }

      // 1. 弹出目录选择对话框
      const win = getMainWindow() ?? BrowserWindow.fromWebContents(event.sender);
      const dirResult = win
        ? await dialog.showOpenDialog(win, {
            title: tMain('dialog.chooseTxtExportDir'),
            properties: ['createDirectory', 'openDirectory']
          })
        : await dialog.showOpenDialog({
            title: tMain('dialog.chooseTxtExportDir'),
            properties: ['createDirectory', 'openDirectory']
          });

      if (dirResult.canceled || dirResult.filePaths.length === 0) {
        return null;
      }
      const dirPath = dirResult.filePaths[0];

      // 2. 确保目录存在
      await mkdir(dirPath, { recursive: true });

      // 3. 逐本导出
      const BOM = '\uFEFF';
      const skipped: string[] = [];
      let count = 0;
      for (const book of books) {
        try {
          const isComic = book.is_comic === 1;
          const chapters = await collectBookChapters(book.id, isComic);
          if (chapters.length === 0) {
            skipped.push(`${book.title}（无章节）`);
            continue;
          }
          const txtContent = buildTxtContent(book, chapters);
          const fileName = `${sanitizeFileName(book.title)}.txt`;
          const filePath = join(dirPath, fileName);
          await writeFile(filePath, BOM + txtContent, 'utf-8');
          count++;
        } catch (err) {
          console.warn(`[export] 导出书籍失败 id=${book.id}:`, err);
          skipped.push(`${book.title}（${(err as Error).message}）`);
        }
      }

      return { dirPath, count, skipped };
    })
  );
}
