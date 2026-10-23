/**
 * 通用解析 Worker 入口（parser-worker）
 *
 * 在 worker_threads 子线程中执行 CPU 密集型文件解析（PDF/EPUB/MOBI/TXT/Comic），
 * 避免阻塞主线程事件循环导致批量导入时界面卡死。
 *
 * 消息协议：
 * - 主线程 → worker：
 *   - { type: 'parse',      id, fileType, filePath, fileName?, parseMode? }  通用解析
 *   - { type: 'cover',      id, fileType, filePath, destPath }               通用封面提取
 *   - { type: 'readChapter', id, fileType, filePath, chapter, imageDir?, allowScreenshotFallback? }  阅读章节
 *   - { type: 'readImages', id, filePath, chapter, imageDir, initialPages?, pages? }  阅读章节图片（A1修复，仅 PDF）
 * - worker → 主线程：
 *   - { type: 'progress',          id, value }                    解析进度
 *   - { type: 'parseResult',       id, success, data? | error? }  parse 结果
 *   - { type: 'coverResult',       id, success, data? | error? }  cover 结果
 *   - { type: 'readChapterResult', id, success, data? | error? }  readChapter 结果
 *   - { type: 'readImagesResult',  id, success, data? | error? }  readImages 结果（A1修复，data 为 ChapterImage[]）
 *
 * 支持的 fileType：
 *   - parse:  'pdf' | 'epub' | 'mobi' | 'txt' | 'comic'
 *   - cover:  'pdf' | 'epub' | 'mobi'
 *   - readChapter: 'pdf' | 'mobi' | 'epub'
 *
 * 所有操作均用 try/catch 包裹，异常通过消息回传，不让 worker 崩溃。
 */

// Electron stub 已移到 rollup banner 中（在所有 require() 之前执行）
// banner 中用 isMainThread 检查确保只在 worker_threads 中生效

import { parentPort } from 'worker_threads';
import type { ChapterImage } from '../../shared';
import {
  parsePdf,
  parseEpub,
  parseMobi,
  parseTxt,
  parseComic,
  extractPdfCover,
  extractEpubCover,
  extractMobiCover,
  readPdfChapter,
  readEpubChapter,
  readMobiChapter,
  readPdfChapterImages,
  ensurePdfChapterImages,
  clearAllWorkerCaches
} from './file-parser';

if (!parentPort) {
  process.exit(1);
}

// 防止未捕获的 Promise rejection 导致 worker 崩溃
process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    parentPort!.postMessage({ type: 'error', error: msg });
  } catch {
    /* ignore */
  }
});
process.on('uncaughtException', (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    parentPort!.postMessage({ type: 'error', error: msg });
  } catch {
    /* ignore */
  }
});

const port = parentPort;

port.on('message', async (msg: any) => {
  if (!msg || typeof msg !== 'object') return;
  const { type, id } = msg;

  // ===== 通用解析 =====
  if (type === 'parse') {
    const { fileType, filePath, fileName, parseMode } = msg;
    try {
      const onProgress = (p: number) => {
        port.postMessage({ type: 'progress', id, value: p });
      };
      let parsed: unknown;
      switch (fileType) {
        case 'pdf':
          parsed = await parsePdf(filePath, onProgress, fileName);
          break;
        case 'epub':
          parsed = await parseEpub(filePath, onProgress, fileName);
          break;
        case 'mobi':
          parsed = await parseMobi(filePath, onProgress, fileName);
          break;
        case 'txt':
          parsed = await parseTxt(filePath, onProgress, fileName, parseMode);
          break;
        case 'comic':
          parsed = await parseComic(filePath, onProgress);
          break;
        default:
          throw new Error(`不支持的解析格式: ${fileType}`);
      }
      port.postMessage({ type: 'parseResult', id, success: true, data: parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      port.postMessage({ type: 'parseResult', id, success: false, error: message });
    }
    return;
  }

  // ===== 通用封面提取 =====
  if (type === 'cover') {
    const { fileType, filePath, destPath } = msg;
    try {
      let coverPath: string | null;
      switch (fileType) {
        case 'pdf':
          coverPath = await extractPdfCover(filePath, destPath);
          break;
        case 'epub':
          coverPath = await extractEpubCover(filePath, destPath);
          break;
        case 'mobi':
          coverPath = await extractMobiCover(filePath, destPath);
          break;
        default:
          throw new Error(`不支持的封面提取格式: ${fileType}`);
      }
      port.postMessage({ type: 'coverResult', id, success: true, data: coverPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      port.postMessage({ type: 'coverResult', id, success: false, error: message });
    }
    return;
  }

  // ===== 阅读章节（缓存 miss 时重解析） =====
  if (type === 'readChapter') {
    const { fileType, filePath, chapter, imageDir, allowScreenshotFallback } = msg;
    try {
      let content: string;
      switch (fileType) {
        case 'pdf':
          content = await readPdfChapter(filePath, chapter, imageDir, allowScreenshotFallback);
          break;
        case 'mobi':
          content = await readMobiChapter(filePath, chapter, imageDir);
          break;
        case 'epub':
          content = await readEpubChapter(filePath, chapter, imageDir);
          break;
        default:
          throw new Error(`不支持的阅读章节格式: ${fileType}`);
      }
      port.postMessage({ type: 'readChapterResult', id, success: true, data: content });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      port.postMessage({ type: 'readChapterResult', id, success: false, error: message });
    }
    return;
  }

  // ===== 阅读章节图片（A1修复：PDF 整章渲染进 worker，根治切章卡死） =====
  // readPdfChapterImages / ensurePdfChapterImages 的 scale 2.0 整页渲染 + sharp
  // WebP 压缩是 CPU 密集操作，此前在主进程主线程执行会阻塞事件循环（打开扫描版
  // 书/切章时所有 IPC 排队、界面卡住数秒）。与 readChapter 同构挪进 worker。
  // 仅 PDF 走此路径（EPUB/MOBI/CBZ 图片是原文件解压提取，轻 IO 留在主线程）。
  if (type === 'readImages') {
    const { filePath, chapter, imageDir, initialPages, pages, desiredWidth } = msg;
    try {
      let images: ChapterImage[];
      if (Array.isArray(pages) && pages.length > 0) {
        // 续载路径（ensureChapterImages）：渲染请求槽位中仍缺失的页（幂等）
        // A3修复：desiredWidth（前端上报容器宽×DPR）透传，续载页与首批渲染分辨率口径一致
        images = await ensurePdfChapterImages(filePath, chapter, imageDir, pages, desiredWidth);
      } else {
        // 首次读取（readChapterImages）：initialPages 分批渐进，缺省全量渲染
        // A3修复：desiredWidth 透传给 pdf-parse 换算 scale（HiDPI 根治），缺省走 scale 2 兜底
        images = await readPdfChapterImages(filePath, chapter, imageDir, initialPages, desiredWidth);
      }
      // ChapterImage 含 pending 可选布尔字段，普通对象经结构化克隆完整保留
      port.postMessage({ type: 'readImagesResult', id, success: true, data: images });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      port.postMessage({ type: 'readImagesResult', id, success: false, error: message });
    }
    return;
  }

  // ===== 清理缓存 =====
  if (type === 'clearCache') {
    const { filePath } = msg;
    try {
      clearAllWorkerCaches(filePath);
      // 尝试强制 GC 释放内存（需要 --expose-gc 启动标志）
      if (globalThis.gc) {
        globalThis.gc();
      }
      port.postMessage({ type: 'cacheCleared', id, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      port.postMessage({ type: 'cacheCleared', id, success: false, error: message });
    }
    return;
  }

  // ===== 内存使用报告 =====
  if (type === 'getMemoryUsage') {
    const mem = process.memoryUsage();
    port.postMessage({
      type: 'memoryUsage',
      id,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external
    });
    return;
  }
});
