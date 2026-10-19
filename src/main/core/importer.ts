/**
 * 书籍导入器
 *
 * 核心功能：
 * 1. 文件类型识别（.txt / .epub / .mobi / .pdf）
 * 2. 文件哈希计算（xxhash64 流式，支持大文件；P2 优化，原为 SHA-256）
 * 3. 重复检测（哈希存 books.file_hash 列，导入前比对；兼容旧 SHA-256 哈希迁移）
 * 4. 复制文件到 userData/books/<type>/<hash>.<ext>
 * 5. 调用对应解析器 parse() 建立章节索引
 * 6. 调用 BookRepo.createBook() + ChapterRepo.batchInsertChapterIndexes() 入库
 * 7. 提取封面（EPUB）保存到 covers/ 目录
 *
 * 分类策略（P2-5 说明）：
 * 历史上曾设计 L1~L4 多层分类架构（含 metadata-features / structure-features /
 * content-features / random-forest），运行时由随机森林综合各层特征做最终判定。
 * 该架构已弃用并删除（P2 清理）。
 * 当前策略：由 file-parser.ts 中各格式解析器（parsePdf 等）在解析阶段直接做多维度内容级分类，
 * 结果通过 ParsedBook.contentType 返回，本文件直接采用该结果，不再经过独立分类器。
 *
 * 导出：
 * - importFile(filePath, onProgress?): Promise<ImportResult>
 * - importFiles(filePaths, onProgress?): Promise<ImportResult[]>
 * - scanDirectory(dirPath): Promise<string[]>
 * - computeFileHash(filePath): Promise<string>
 */
import { createReadStream, promises as fsPromises, existsSync, statSync } from 'fs';
import { createHash, type Hash } from 'crypto';
import { basename, extname, join } from 'path';
import type { Dirent } from 'fs';

import xxhash from 'xxhash-wasm';
import type { XXHashAPI } from 'xxhash-wasm';

import * as BookRepo from '../db/repositories';
import * as ChapterRepo from '../db/repositories';
import * as ProgressRepo from '../db/repositories';
import { getDb } from '../db/index';
import type { Book } from '../db/repositories';

import {
  TxtParser,
  EpubParser,
  extractEpubCover,
  PdfParser,
  extractPdfCover,
  MobiParser,
  extractMobiCover,
  ComicParser,
  detectFormat,
  type FileParser,
  type ParsedBook
} from './file-parser';
import { pdfWorkerPool, WORKER_COUNT } from './pdf-worker-pool';

import { getBooksPath, getCoverPath, getUserDataRoot, type BookFileType } from '../utils';

/* ==================== 导入日志（文件） ==================== */

/**
 * 将导入日志写入 userData/import-log.txt
 * 打包后 console.error 不可见，用文件日志诊断导入失败
 */
function appendImportLog(message: string): void {
  try {
    const logPath = join(getUserDataRoot(), 'import-log.txt');
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    // 同步追加写入（错误路径，性能不敏感）
    const fs = require('fs');
    fs.appendFileSync(logPath, line, { flag: 'a' });
  } catch {
    // 日志写入失败不影响主流程
  }
}

/* ==================== 类型定义 ==================== */

/** 支持的文件类型 */
export type SupportedFileType = 'txt' | 'epub' | 'mobi' | 'pdf' | 'comic';

/** 单文件导入结果 */
export interface ImportResult {
  /** 源文件路径 */
  filePath: string;
  /** 文件名 */
  fileName: string;
  /** 是否跳过（重复或不支持） */
  skipped: boolean;
  /** 跳过/失败原因 */
  reason?: string;
  /** 导入成功的书籍记录（skipped=false 且成功时） */
  book?: Book;
  /** 是否失败 */
  failed: boolean;
  /** 错误信息（failed=true 时） */
  error?: string;
}

/** 导入进度（单文件级别） */
export interface ImportFileProgress {
  /** 当前文件序号（从 1 开始） */
  current: number;
  /** 总文件数 */
  total: number;
  /** 当前文件名 */
  fileName: string;
  /** 当前阶段状态 */
  status: 'hashing' | 'parsing' | 'importing' | 'done' | 'skipped' | 'failed';
  /** 当前文件解析进度（0~1） */
  fileProgress?: number;
  /** 导入成功的书名（status=done 时） */
  bookTitle?: string;
  /** 跳过/失败原因 */
  reason?: string;
}

/* ==================== 文件类型识别 ==================== */

/** 文件扩展名 → 支持的文件类型映射 */
const EXT_TO_TYPE: Record<string, SupportedFileType> = {
  '.txt': 'txt',
  '.epub': 'epub',
  '.mobi': 'mobi',
  '.azw': 'mobi',
  '.azw3': 'mobi',
  '.azw4': 'mobi',
  '.pdf': 'pdf',
  '.cbz': 'comic',
  '.cbr': 'comic',
  '.cb7': 'comic',
  '.cbt': 'comic',
  '.zip': 'comic',
  '.rar': 'comic'
};

/**
 * 根据文件路径识别类型（扩展名优先，万能格式检测兜底）
 *
 * 先按扩展名快速识别，不支持的扩展名再用 magic number 检测。
 * 这样既能快速处理常见格式，又能兜底处理扩展名被改过的文件。
 *
 * @returns 文件类型，不支持的返回 null
 */
export function detectFileType(filePath: string): SupportedFileType | null {
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_TYPE[ext] ?? null;
}

/**
 * 万能格式检测（异步版本）
 *
 * 扩展名无法识别时，用 magic number 检测文件实际格式。
 * 用于处理扩展名被改过或无扩展名的文件。
 *
 * @param filePath 文件路径
 * @returns 文件类型，不支持的返回 null
 */
export async function detectFileTypeAdvanced(filePath: string): Promise<SupportedFileType | null> {
  // 1. 先按扩展名快速识别
  const extType = detectFileType(filePath);
  if (extType) return extType;

  // 2. 扩展名无法识别，用万能格式检测
  const format = await detectFormat(filePath);
  switch (format) {
    case 'txt':
      return 'txt';
    case 'epub':
      return 'epub';
    case 'mobi':
      return 'mobi';
    case 'pdf':
      return 'pdf';
    case 'cbz':
    case 'cbr':
    case 'cb7':
    case 'cbt':
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
      return 'comic';
    default:
      return null;
  }
}

/* ==================== 文件哈希计算（流式） ==================== */

/**
 * xxhash-wasm API 懒加载单例
 *
 * WASM 模块异步初始化（约 1ms），首次调用 computeFileHash 时加载，
 * 后续复用。模块内嵌 WASM 字节码，无需额外 .wasm 文件。
 */
let xxhashApiPromise: Promise<XXHashAPI> | null = null;
function getXxhashApi(): Promise<XXHashAPI> {
  if (!xxhashApiPromise) {
    xxhashApiPromise = xxhash();
  }
  return xxhashApiPromise;
}

/**
 * 计算文件哈希（xxhash64 流式，支持大文件）
 *
 * P2 优化（2026-09-13）：原为 SHA-256（64 字符 hex，~150MB/s），
 * 改用 xxhash64（16 字符 hex，~8GB/s），大文件哈希耗时从 500ms+ 降至 <20ms。
 * xxhash 为非加密哈希，去重场景下碰撞概率（2^-64）可忽略。
 *
 * 使用 xxhash-wasm 的 create64() 创建流式 hasher，fs.createReadStream
 * 固定 64KB 块大小，内存占用与文件大小无关。
 *
 * @param filePath 文件路径
 * @returns 哈希十六进制字符串（小写，16 字符）
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const api = await getXxhashApi();
  return new Promise<string>((resolve, reject) => {
    const hasher = api.create64();
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });

    stream.on('data', (chunk) => hasher.update(chunk as Buffer));
    stream.on('end', () => {
      // xxhash64 返回无符号 64 位 bigint，转 16 字符 hex（padStart 防高位 0 丢失）
      const hex = hasher.digest().toString(16).padStart(16, '0');
      resolve(hex);
    });
    stream.on('error', (err) => reject(new Error(`计算文件哈希失败: ${err.message}`)));
  });
}

/**
 * 计算文件 SHA-256 哈希（流式，仅用于旧哈希迁移检测）
 *
 * 旧版本（P2 前）用 SHA-256（64 字符 hex）作 file_hash。
 * 新版本用 xxhash64（16 字符 hex），重复检测时若新哈希未命中，
 * 会用此函数重算 SHA-256 查旧记录，命中后更新为新哈希（一次性迁移）。
 *
 * @param filePath 文件路径
 * @returns SHA-256 哈希十六进制字符串（小写，64 字符）
 */
export async function computeFileHashSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash: Hash = createHash('sha256');
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });

    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(new Error(`计算文件哈希失败: ${err.message}`)));
  });
}

/** 旧 SHA-256 哈希的十六进制字符长度（用于判断是否为旧哈希） */
const SHA256_HEX_LENGTH = 64;

/* ==================== 重复检测 ==================== */

/** custom_meta 中存储的哈希格式 */
const FILE_HASH_KEY = 'file_hash';

/**
 * 检查文件哈希是否已存在于数据库
 *
 * 通过 books.file_hash 列单次索引查询（D-04 优化，原为遍历全部书籍解析 JSON）。
 *
 * @param hash 文件哈希（xxhash64 16 字符 hex，或旧版 SHA-256 64 字符 hex）
 * @returns 已存在的书籍记录，不存在返回 null
 */
export function findBookByHash(hash: string): Book | null {
  return BookRepo.getBookByHash(hash) ?? null;
}

/** 构建 custom_meta JSON 字符串（包含文件哈希） */
function buildCustomMeta(hash: string, extra?: Record<string, unknown>): string {
  const meta: Record<string, unknown> = {
    [FILE_HASH_KEY]: hash
  };
  if (extra) {
    Object.assign(meta, extra);
  }
  return JSON.stringify(meta);
}

/* ==================== 解析器选择 ==================== */

/** 根据文件类型获取对应解析器实例 */
function getParser(fileType: SupportedFileType): FileParser | null {
  switch (fileType) {
    case 'txt':
      return new TxtParser();
    case 'epub':
      return new EpubParser();
    case 'pdf':
      return new PdfParser();
    case 'mobi':
      return new MobiParser();
    case 'comic':
      return new ComicParser();
    default:
      return null;
  }
}

/* ==================== 统一封面提取 ==================== */

/**
 * 统一封面提取：根据文件格式调用对应的封面提取函数
 *
 * 支持 MOBI / EPUB / PDF 三种格式，分别调用：
 * - mobi:  extractMobiCover（从 EXTH 元数据或 record 扫描提取封面图片）
 * - epub:  extractEpubCover（从 OPF metadata/guide/manifest 多级兜底提取封面）
 * - pdf:   extractPdfCover（用 pdf-parse 渲染第一页为图片）
 *
 * 其他格式（txt/comic）返回 null，由调用方自行处理（如 comic 用第一张图片）。
 *
 * 注意：destPath 建议用 .jpg 扩展名。EPUB/PDF 内部会根据实际图片格式调整扩展名，
 *      返回的最终路径可能与 destPath 不同（如 PNG 封面会改为 .png）。
 *
 * @param fileType 文件类型（'mobi' | 'epub' | 'pdf' | ...）
 * @param filePath 源文件路径
 * @param destPath 封面保存目标路径（含扩展名）
 * @returns 成功返回最终保存路径，无封面或失败返回 null
 */
async function extractCover(fileType: SupportedFileType, filePath: string, destPath: string): Promise<string | null> {
  switch (fileType) {
    case 'mobi':
      return await extractMobiCover(filePath, destPath);
    case 'epub':
      return await extractEpubCover(filePath, destPath);
    case 'pdf':
      return await extractPdfCover(filePath, destPath);
    default:
      return null;
  }
}

/* ==================== 文件复制 ==================== */

/**
 * 复制文件到 userData/books/<type>/<hash>.<ext>
 *
 * 用哈希作文件名避免冲突，保留原扩展名。
 *
 * @param srcPath 源文件路径
 * @param fileType 文件类型
 * @param hash 文件哈希
 * @returns 目标文件路径
 */
async function copyBookFile(srcPath: string, fileType: BookFileType, hash: string): Promise<string> {
  const ext = extname(srcPath).toLowerCase();
  const destDir = getBooksPath(fileType);
  const destPath = join(destDir, `${hash}${ext}`);

  // 若目标已存在（相同哈希已复制过），跳过复制
  if (existsSync(destPath)) {
    return destPath;
  }

  // 确保目录存在
  await fsPromises.mkdir(destDir, { recursive: true });

  // 流式复制（支持大文件）
  await fsPromises.copyFile(srcPath, destPath);

  return destPath;
}

/* ==================== 单文件导入 ==================== */

/**
 * 导入单个文件
 *
 * 流程：
 * 1. 识别文件类型（txt/epub/mobi/azw/azw3/pdf）
 * 2. 流式计算 xxhash64 哈希
 * 3. 查 DB 检查哈希是否已存在 → 已存在跳过
 * 4. 复制文件到 userData/books/<type>/<hash>.<ext>
 * 5. 调用解析器 parse() 建立章节索引
 * 6. EPUB 提取封面到 covers/ 目录
 * 7. BookRepo.createBook() 创建图书记录
 * 8. ChapterRepo.batchInsertChapterIndexes() 批量插入章节索引
 *
 * @param filePath 源文件绝对路径
 * @param onProgress 单文件解析进度回调（0~1）
 * @returns 导入结果
 */
export async function importFile(
  filePath: string,
  onProgress?: (p: number) => void,
  groupId?: number | null,
  parseMode?: import('./file-parser').ParseMode
): Promise<ImportResult> {
  const fileName = basename(filePath);

  // 1. 识别文件类型（扩展名优先，万能格式检测兜底）
  let fileType = detectFileType(filePath);
  if (!fileType) {
    // 扩展名无法识别，用万能格式检测
    fileType = await detectFileTypeAdvanced(filePath);
  }
  if (!fileType) {
    return {
      filePath,
      fileName,
      skipped: true,
      failed: false,
      reason: `不支持的文件类型: ${extname(filePath)}`
    };
  }

  // 标记是否已复制文件（catch 中据此清理）
  let localFilePath: string | null = null;
  // 标记本次是否为新建（非去重跳过），catch 中仅清理新建的文件
  let isNewImport = false;

  try {
    // 2. 校验文件存在且非空
    if (!existsSync(filePath)) {
      return {
        filePath,
        fileName,
        skipped: false,
        failed: true,
        error: '文件不存在'
      };
    }
    const stat = statSync(filePath);
    if (stat.size === 0) {
      return {
        filePath,
        fileName,
        skipped: false,
        failed: true,
        error: '文件为空'
      };
    }

    // 3. 计算哈希（xxhash64，快）
    const hash = await computeFileHash(filePath);
    await yieldToEventLoop();

    // 4. 重复检测
    //    先用新哈希（xxhash64，16 字符）查 books.file_hash 索引
    let existingBook = findBookByHash(hash);

    // P2 兼容：旧版本用 SHA-256（64 字符 hex）作 file_hash。
    // 新哈希查不到时，若数据库中存在 64 字符长度的旧哈希，
    // 用 SHA-256 重算并查旧记录。命中后更新为新哈希（一次性迁移），后续走快路径。
    // 仅在首次重复导入旧记录时多算一次 SHA-256，更新后不再触发。
    if (!existingBook) {
      // 优化：先检查数据库中是否存在任何旧哈希记录，不存在则跳过 SHA-256 计算
      const db = getDb();
      const legacyCount = db
        .prepare('SELECT COUNT(*) as cnt FROM books WHERE LENGTH(file_hash) = ?')
        .get(SHA256_HEX_LENGTH) as { cnt: number };
      if (legacyCount.cnt > 0) {
        const sha256Hash = await computeFileHashSha256(filePath);
        const legacyBook = findBookByHash(sha256Hash);
        if (legacyBook && legacyBook.file_hash && legacyBook.file_hash.length === SHA256_HEX_LENGTH) {
          // 更新旧记录的 file_hash 为新算法哈希，后续导入直接命中新哈希
          BookRepo.updateBook(legacyBook.id, { file_hash: hash });
          existingBook = legacyBook;
        }
      }
    }

    if (existingBook) {
      return {
        filePath,
        fileName,
        skipped: true,
        failed: false,
        reason: `已存在相同文件: ${existingBook.title}`,
        book: existingBook
      };
    }

    // 5. 复制文件到 userData
    localFilePath = await copyBookFile(filePath, fileType, hash);
    isNewImport = true;
    await yieldToEventLoop();

    // 6. 解析
    const parser = getParser(fileType);
    if (!parser) {
      return {
        filePath,
        fileName,
        skipped: true,
        failed: false,
        reason: '无可用解析器'
      };
    }

    // PDF诊断日志
    if (fileType === 'pdf') {
      appendImportLog(`[START] ${fileName} (${stat.size} bytes) → parse...`);
    }

    // P1-3修复：删除 parser.parseMode = parseMode 设置。
    // 原代码在主线程设置 parser.parseMode，但实际解析在 worker_threads 子线程执行
    // （见下方 pdfWorkerPool.parseInWorker），主线程的 parser 实例与 worker 中的
    // parser 是不同对象，设置不会传递到 worker。parseMode 已通过 parseInWorker
    // 的第5个参数正确传递到 worker，此处的设置是冗余且无效的。

    // 所有格式解析都移到 worker_threads 子线程，避免 CPU 密集型操作
    // （pdfjs-dist + @napi-rs/canvas / EPUB ZIP 解压 / MOBI KF8 解码等）
    // 阻塞主线程事件循环导致批量导入时界面卡死。
    let parsed: ParsedBook;
    parsed = await pdfWorkerPool.parseInWorker(fileType, localFilePath, fileName, onProgress, parseMode);
    await yieldToEventLoop();

    // PDF诊断日志：解析成功
    if (fileType === 'pdf') {
      appendImportLog(
        `[PARSED] ${fileName} → ${parsed.contentType}, chapters=${parsed.chapters.length}, title="${parsed.title || ''}"`
      );
    }

    // 7. 提取封面
    //    MOBI/EPUB/PDF：调用对应格式的封面提取函数
    //    comic：用第一张图片作为封面
    //    txt：无封面
    let coverPath: string | null = null;
    if (fileType === 'mobi' || fileType === 'epub' || fileType === 'pdf') {
      // MOBI/EPUB/PDF：统一通过 worker 子线程调用 extractCover 提取封面
      const coverDest = getCoverPath(hash, '.jpg');
      try {
        coverPath = await pdfWorkerPool.extractCoverInWorker(fileType, localFilePath, coverDest);
        await yieldToEventLoop();
      } catch (err) {
        console.warn(`[import] 提取 ${fileType} 封面失败:`, err);
        coverPath = null;
      }
    } else if (fileType === 'comic' && parsed.isComic && parsed.chapters.length > 0) {
      // 漫画：用第一张图片作为封面
      let imageDir: string | null = null;
      try {
        const firstChapter = parsed.chapters[0];
        imageDir = join(getUserDataRoot(), 'comic-images', `temp_${hash}`);
        const parserInstance = getParser(fileType);
        if (parserInstance && parserInstance.readChapterImages) {
          const images = await parserInstance.readChapterImages(localFilePath, firstChapter, imageDir);
          if (images.length > 0) {
            const ext = extname(images[0]).toLowerCase() || '.jpg';
            const coverDest = getCoverPath(hash, ext);
            await fsPromises.copyFile(images[0], coverDest);
            coverPath = coverDest;
          }
        }
      } catch (err) {
        console.warn('[import] 提取漫画封面失败:', err);
        coverPath = null;
      } finally {
        // R2修复：无论成功或异常都清理临时目录，防止资源泄漏
        if (imageDir) {
          await fsPromises
            .rm(imageDir, { recursive: true, force: true })
            .catch((e) => console.warn('[cleanup] 操作失败:', e));
        }
      }
    }

    // 8. 创建图书记录 + 批量插入章节索引（事务包裹，保证原子性）
    const sortOrder = BookRepo.nextBookSortOrder();
    const customMeta = buildCustomMeta(hash, {
      original_filename: fileName,
      file_size: stat.size,
      parse_mode: parseMode ?? 'auto',
      // 内容特征元数据（解析器提取，存档备用；分类器已弃用，不再有随机森林消费此字段）
      content_features: parsed.contentFeatures ?? undefined,
      // 解析器直接给出的分类结果（当前分类策略：parser 直接分类，无独立分类器层）
      parser_content_type: parsed.contentType ?? (parsed.isComic ? 'comic' : 'text')
    });

    const chapterInputs = parsed.chapters.map((ch) => ({
      book_id: 0, // 占位，事务内用实际 book.id 替换
      chapter_index: ch.index,
      title: ch.title,
      file_offset: ch.fileOffset,
      file_length: ch.fileLength,
      url: ch.url ?? null,
      content_type: ch.contentType ?? 'text',
      volume: ch.volume ?? null
    }));

    const db = getDb();
    const txResult = db.transaction(() => {
      const existing = findBookByHash(hash);
      if (existing) {
        return { existing: true, book: existing };
      }
      // 直接使用 parser 的分类结果（file-parser.ts 中各解析器已做多维度内容级分类）
      const finalContentType: 'text' | 'illustrated' | 'comic' =
        parsed.contentType ?? (parsed.isComic ? 'comic' : 'text');
      console.log(`[import] 分类: ${finalContentType} 《${parsed.title || fileName}》`);

      const created = BookRepo.createBook({
        title: parsed.title || fileName,
        author: parsed.author || '未知',
        intro: parsed.description || null,
        cover: coverPath,
        local_file_path: localFilePath,
        file_type: fileType,
        encoding: parsed.encoding,
        total_chapters: parsed.chapters.length,
        custom_meta: customMeta,
        file_hash: hash,
        sort_order: sortOrder,
        is_comic: finalContentType === 'comic' ? 1 : 0,
        content_type: finalContentType,
        group_id: groupId ?? null
      });

      if (chapterInputs.length > 0) {
        for (const ci of chapterInputs) {
          ci.book_id = created.id;
        }
        ChapterRepo.batchInsertChapterIndexes(chapterInputs);
      }

      return { existing: false, book: created };
    })();

    if (txResult.existing) {
      if (localFilePath && isNewImport) {
        fsPromises.unlink(localFilePath).catch((e) => console.warn('[cleanup] 操作失败:', e));
      }
      return {
        filePath,
        fileName,
        skipped: true,
        failed: false,
        reason: `已存在相同文件: ${txResult.book.title}`,
        book: txResult.book
      };
    }

    // DB 事务完成后让出事件循环，确保 IPC 进度事件能及时推送
    await yieldToEventLoop();

    const book = txResult.book;

    // 导入成功，文件归 book 管理，不再清理
    localFilePath = null;

    // 写入文件日志（PDF诊断用）
    if (fileType === 'pdf') {
      appendImportLog(`[OK] ${fileName} → ${book.content_type} (chapters=${book.total_chapters})`);
    }

    return {
      filePath,
      fileName,
      skipped: false,
      failed: false,
      book
    };
  } catch (err) {
    console.error('[import] 导入失败:', filePath, err);
    // 写入文件日志（打包后诊断用）
    const errObj = err as Error;
    appendImportLog(
      `[FAIL] ${fileName} (${filePath}): ${errObj.message || String(err)}\n  stack: ${errObj.stack || 'N/A'}`
    );
    // D-08: 解析失败时清理已复制的文件（仅本次新建的）
    if (localFilePath && isNewImport) {
      fsPromises.unlink(localFilePath).catch((err) => {
        console.warn('[import] 清理失败文件失败:', localFilePath, err);
      });
    }
    return {
      filePath,
      fileName,
      skipped: false,
      failed: true,
      error: (err as Error).message || String(err)
    };
  }
}

/* ==================== 批量导入 ==================== */

/**
 * 批量导入并发数
 *
 * 限制为 5 的原因：
 * - 磁盘 I/O：并发过高会导致随机读写抖动，HDD 尤其明显
 * - DB 写锁：better-sqlite3 单连接写事务串行化，并发写入会互相阻塞
 * - CPU：解析（尤其 EPUB unzip + XML parse）是 CPU 密集型，5 路并行在多核 CPU 上效果更好
 * - 经验值：N=3 时总耗时 ≈ Σ单文件耗时 / 3，再增大收益递减且抖动加剧
 * - 与 worker 池大小对齐：避免导入任务数 > worker 数导致排队浪费
 */
const IMPORT_CONCURRENCY_LIMIT = WORKER_COUNT;

/**
 * 让出事件循环（yield to event loop）
 *
 * better-sqlite3 的 DB 操作（查询/事务）是同步的，会阻塞 Node.js 事件循环。
 * 批量导入时若不让出，主进程无法处理 IPC 通信（进度推送、importFiles 返回），
 * 导致前端一直停留在 'importing' 状态，模态框无法关闭（mask-closable=false）。
 *
 * setImmediate 在 I/O 事件之后执行，确保 IPC 消息有机会处理。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 批量导入文件
 *
 * 并发池模式：维护 running Set，当运行数 < IMPORT_CONCURRENCY_LIMIT 时启动新任务，
 * 否则 await Promise.race(running) 等待任一完成再继续。
 * 单个文件失败不影响后续文件，错误信息收集到对应 result 中返回。
 *
 * **事件循环让出**：每处理完一个文件后调用 yieldToEventLoop()，防止 better-sqlite3
 * 同步操作长时间阻塞主进程，确保 IPC 进度事件能及时推送到前端。
 *
 * 进度回调语义保持与串行版一致：current = 文件启动序号（从 1 开始），
 * 并发下多个文件的进度可能交错到达，UI 取最新一条即可。
 *
 * @param filePaths 文件路径数组
 * @param onProgress 进度回调
 * @param groupId 导入到指定分组（null=未分组，undefined=不指定）
 * @param parseMode TXT 解析模式
 * @param onBookAdded 单本书导入成功回调（后台增量显示用，每本成功调用一次）
 * @returns 每个文件的导入结果（顺序与输入一致）
 */
export async function importFiles(
  filePaths: string[],
  onProgress?: (progress: ImportFileProgress) => void,
  groupId?: number | null,
  parseMode?: import('./file-parser').ParseMode,
  onBookAdded?: (book: Book) => void
): Promise<ImportResult[]> {
  const total = filePaths.length;
  if (total === 0) return [];

  // 预分配结果数组，每个任务按索引写入，保证顺序与输入一致
  const results: ImportResult[] = new Array(total);

  // 正在运行的 Promise 集合（并发池）
  const running: Set<Promise<void>> = new Set();

  // 进度节流：大量文件时减少回调频率，避免 IPC 消息堆积导致前端卡顿
  // 状态变更（hashing→parsing→done/failed/skipped）始终发送，中间 parsing 进度节流
  let lastProgressTime = 0;
  const PROGRESS_THROTTLE_MS = 200;
  function throttledOnProgress(progress: ImportFileProgress): void {
    if (!onProgress) return;
    // 状态变更（非 parsing）始终立即发送
    if (progress.status !== 'parsing') {
      onProgress(progress);
      lastProgressTime = Date.now();
      return;
    }
    // parsing 状态节流
    const now = Date.now();
    if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
      onProgress(progress);
      lastProgressTime = now;
    }
  }

  for (let i = 0; i < total; i++) {
    // 每次迭代开始前让出事件循环，确保上一轮的同步 DB 操作不会连续阻塞
    // 这样 IPC 进度事件、importFiles 的 invoke 返回等都能及时处理
    await yieldToEventLoop();

    const filePath = filePaths[i];
    const fileName = basename(filePath);
    const current = i + 1;

    // 报告开始
    throttledOnProgress({
      current,
      total,
      fileName,
      status: 'hashing',
      fileProgress: 0
    });

    // 启动单个文件导入任务（IIFE 异步函数）
    // 内部 try/catch 兜底：importFile 自身已 try/catch 不抛，
    // 此处防御 onProgress 回调异常等未预期情况，确保 task 不会 reject
    const task: Promise<void> = (async () => {
      try {
        const result = await importFile(
          filePath,
          (fileP) => {
            throttledOnProgress({
              current,
              total,
              fileName,
              status: 'parsing',
              fileProgress: fileP
            });
          },
          groupId,
          parseMode
        );

        results[i] = result;

        // 单本书导入成功，触发 onBookAdded 回调（后台增量显示用）
        if (!result.skipped && !result.failed && result.book) {
          onBookAdded?.(result.book);
        }

        // 报告完成
        let status: ImportFileProgress['status'];
        let reason: string | undefined;
        let bookTitle: string | undefined;

        if (result.failed) {
          status = 'failed';
          reason = result.error;
        } else if (result.skipped) {
          status = 'skipped';
          reason = result.reason;
        } else {
          status = 'done';
          bookTitle = result.book?.title;
        }

        throttledOnProgress({
          current,
          total,
          fileName,
          status,
          fileProgress: 1,
          bookTitle,
          reason
        });
      } catch (err) {
        // 兜底：记录失败结果，不中断其他文件导入
        console.error('[importFiles] 任务异常:', filePath, err);
        results[i] = {
          filePath,
          fileName,
          skipped: false,
          failed: true,
          error: (err as Error).message || String(err)
        };
      }
    })();

    running.add(task);

    // 任务完成后从 running 集合移除
    // 注意：finally 回调在 task settle 后入微任务队列，
    // 因在此处注册（早于 Promise.race 内部 then），故 race resolve 时 running 已更新
    task.finally(() => running.delete(task));

    // 当运行数达到上限，等待任一完成再启动新任务
    if (running.size >= IMPORT_CONCURRENCY_LIMIT) {
      await Promise.race(running);
      // 等待完成后让出事件循环，处理积压的 IPC 消息
      await yieldToEventLoop();
    }
  }

  // 等待所有剩余任务完成
  await Promise.all(running);

  // 最终让出一次事件循环，确保最后的进度事件和 IPC 返回能及时处理
  await yieldToEventLoop();

  return results;
}

/* ==================== 目录扫描 ==================== */

/** 支持的扩展名集合 */
const SUPPORTED_EXTS = new Set([
  '.txt',
  '.epub',
  '.mobi',
  '.azw',
  '.azw3',
  '.pdf',
  '.cbz',
  '.cbr',
  '.cb7',
  '.cbt',
  '.zip',
  '.rar',
  '.7z',
  '.tar'
]);

/** 最大递归深度（防止循环链接） */
const MAX_DEPTH = 20;

/**
 * 递归扫描目录，返回所有支持的书籍文件路径
 *
 * @param dirPath 目录路径
 * @returns 文件路径数组（绝对路径）
 */
export async function scanDirectory(dirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      console.warn(`[scan] 达到最大递归深度 ${MAX_DEPTH}，跳过: ${dir}`);
      return;
    }

    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`[scan] 读取目录失败: ${dir}`, err);
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // 跳过隐藏文件/目录（.开头）
      if (entry.name.startsWith('.')) continue;

      // 显式跳过符号链接（防止循环引用和重复扫描）
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(dirPath, 0);
  return results;
}

/* ==================== 统计辅助 ==================== */

/** 从导入结果数组统计汇总 */
export function summarizeResults(results: ImportResult[]): {
  total: number;
  success: number;
  skipped: number;
  failed: number;
} {
  let success = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.failed) failed++;
    else if (r.skipped) skipped++;
    else success++;
  }
  return { total: results.length, success, skipped, failed };
}
/* ==================== 重新分章 ==================== */

/** 重新分章结果 */
export interface ReparseResult {
  /** 是否成功 */
  success: boolean;
  /** 新章节数 */
  chapterCount: number;
  /** 新的漫画检测结果（true=漫画，false=文本）；失败时为 undefined */
  isComic?: boolean;
  /** v21：内容三分类 'text'=文本, 'illustrated'=图文, 'comic'=漫画；失败时为 undefined */
  contentType?: 'text' | 'illustrated' | 'comic';
  /** 错误信息（失败时） */
  error?: string;
}

/**
 * 重新解析：对已导入的书籍重新解析文件并更新章节索引
 *
 * 统一的重新解析函数，兼具原"重新分章"和"重新检测漫画"两个功能：
 * （重新检测漫画）的功能：
 *
 * 流程：
 * 1. 查 Book 获取 local_file_path 和 file_type
 * 2. 校验文件存在
 * 3. 调用对应解析器 parse() 重新解析（复用 getParser）
 * 4. 校验解析结果非空（空章节时保留原有数据）
 * 5. 重新提取封面（事务外，失败保留旧封面）
 * 6. 在事务中：删除旧章节 + 阅读进度，重新插入章节索引（含 content_type）
 * 7. 更新 books.total_chapters、encoding、is_comic、cover
 *
 * 注意：
 * - 不会重新复制文件，复用已存在的 local_file_path
 * - txt/comic 类型也会重新解析（不跳过）
 * - 封面提取失败不致命，保留旧封面
 *
 * @param bookId 书籍 id
 * @returns 重新解析结果
 */
export async function reparseBook(bookId: number): Promise<ReparseResult> {
  // 1. 查书籍
  const book = BookRepo.getBookById(bookId);
  if (!book) {
    return { success: false, chapterCount: 0, error: '书籍不存在' };
  }

  // 2. 校验文件路径和类型
  const filePath = book.local_file_path;
  if (!filePath) {
    return { success: false, chapterCount: 0, error: '书籍本地文件路径缺失' };
  }
  if (!existsSync(filePath)) {
    return { success: false, chapterCount: 0, error: `书籍文件不存在: ${filePath}` };
  }
  if (!book.file_type) {
    return { success: false, chapterCount: 0, error: '书籍文件类型未知' };
  }

  // 3. 识别文件类型（用 book.file_type 而非扩展名，避免不一致）
  const fileType = book.file_type as SupportedFileType;
  const parser = getParser(fileType);
  if (!parser) {
    return {
      success: false,
      chapterCount: 0,
      error: `不支持的文件类型: ${book.file_type}`
    };
  }

  try {
    // 4. 先重新解析文件到内存（不动旧数据，解析失败直接返回错误）
    //    P1修复：通过 Worker 子线程解析，避免大文件阻塞主线程事件循环
    const parsed: ParsedBook = await pdfWorkerPool.parseInWorker(
      fileType,
      filePath,
      book.title || 'reparse',
      undefined,
      undefined
    );

    // 校验解析结果：空章节时保留原有数据，避免书籍失去所有章节索引
    if (parsed.chapters.length === 0) {
      return {
        success: false,
        chapterCount: 0,
        error: '解析结果无章节，已保留原有章节索引'
      };
    }

    // 5. 重新提取封面（事务外，异步操作）
    //    重新解析时封面可能变化（如 MOBI 重新解析后 KF8 格式封面不同），
    //    用 book.file_hash 作封面文件名（与 importFile 一致），兜底用 bookId。
    let newCoverPath: string | null = null;
    const coverName = book.file_hash || String(bookId);
    const coverDest = getCoverPath(coverName, '.jpg');
    try {
      newCoverPath = await extractCover(fileType, filePath, coverDest);
    } catch (err) {
      console.warn(`[import] 重新解析时提取 ${fileType} 封面失败:`, err);
      // 封面提取失败不致命，保留旧封面
      newCoverPath = book.cover;
    }
    // 封面提取返回 null（无封面）时保留旧封面，避免无故丢失封面
    if (newCoverPath === null) {
      newCoverPath = book.cover;
    }

    // 6. 解析成功，在事务中执行"删旧 + 插新 + 更新"（保证原子性）
    //    若事务中途失败，旧数据因事务回滚而不受影响
    const isComicBool = parsed.isComic ?? false;
    const isComic = isComicBool ? 1 : 0;
    // v21：content_type 三分类。兼容旧解析器：无 contentType 时用 isComic 兜底
    const contentType = parsed.contentType ?? (isComicBool ? 'comic' : 'text');

    // 构造章节索引输入（包含 content_type，逐章设置）
    //    漫画章节 contentType='image'，文本章节 contentType='text'
    const chapterInputs = parsed.chapters.map((ch) => ({
      book_id: bookId,
      chapter_index: ch.index,
      title: ch.title,
      file_offset: ch.fileOffset,
      file_length: ch.fileLength,
      url: ch.url ?? null,
      content_type: ch.contentType ?? 'text',
      volume: ch.volume ?? null
    }));

    const db = getDb();
    db.transaction(() => {
      // 删除旧章节索引和阅读进度
      ChapterRepo.deleteChaptersByBookId(bookId);
      ProgressRepo.deleteProgress(bookId);

      // 插入新章节索引（含 content_type）
      if (chapterInputs.length > 0) {
        ChapterRepo.batchInsertChapterIndexes(chapterInputs);
      }

      // 更新 books.total_chapters、encoding、is_comic、content_type、cover
      BookRepo.updateBook(bookId, {
        total_chapters: parsed.chapters.length,
        encoding: parsed.encoding,
        is_comic: isComic,
        content_type: contentType,
        cover: newCoverPath
      });
    })();

    return { success: true, chapterCount: parsed.chapters.length, isComic: isComicBool, contentType };
  } catch (err) {
    console.error('[import] 重新解析失败:', bookId, err);
    return {
      success: false,
      chapterCount: 0,
      error: (err as Error).message || String(err)
    };
  }
}
