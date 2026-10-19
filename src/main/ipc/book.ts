/**
 * 书籍阅读 IPC
 */
import { ipcMain, app, dialog, BrowserWindow } from 'electron';
import { join, basename, extname, resolve, sep } from 'path';
import { copyFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

import { getCoversRoot, getUserDataRoot } from '../utils';
import {
  readChapterContent,
  preloadNextChapter,
  cancelChapterReads,
  clearBookWorkerCache
} from '../core/chapter-reader';
import { reparseBook } from '../core/importer';
import * as BookRepo from '../db/repositories';
import { tMain } from '../i18n';

import { IPC_CHANNELS, wrapHandler, assertPositiveInt } from './shared';

/** 单次导出书籍数量上限（B-15：防止超大批量导出导致主进程长时间阻塞） */
const MAX_EXPORT_COUNT = 500;

/** 导出文件名冲突时的最大重试次数（B-08：避免无限循环） */
const MAX_NAME_CONFLICT_RETRY = 99;

/** 注册书籍相关 IPC handler */
export function registerBookIpc(): void {
  // 按需读取章节正文
  // 参数：(bookId: number, chapterIndex: number)
  // 返回：章节文本内容
  ipcMain.handle(
    IPC_CHANNELS.BOOK_READ_CHAPTER,
    wrapHandler(async (_e, bookId: number, chapterIndex: number) => {
      if (typeof bookId !== 'number' || !Number.isFinite(bookId) || bookId <= 0) {
        throw new Error('无效的 bookId');
      }
      if (typeof chapterIndex !== 'number' || !Number.isFinite(chapterIndex) || chapterIndex < 0) {
        throw new Error('无效的 chapterIndex');
      }
      return readChapterContent(bookId, chapterIndex);
    })
  );

  // 预加载下一章（P1-2：前端翻页时可选调用，预热 DB 缓存）
  // 参数：(bookId: number, chapterIndex: number)
  // 返回：void（fire-and-forget，预加载失败静默忽略）
  ipcMain.handle(
    IPC_CHANNELS.BOOK_PRELOAD_NEXT_CHAPTER,
    wrapHandler(async (_e, bookId: number, chapterIndex: number) => {
      if (typeof bookId !== 'number' || !Number.isFinite(bookId) || bookId <= 0) {
        throw new Error('无效的 bookId');
      }
      if (typeof chapterIndex !== 'number' || !Number.isFinite(chapterIndex) || chapterIndex < 0) {
        throw new Error('无效的 chapterIndex');
      }
      return preloadNextChapter(bookId, chapterIndex);
    })
  );

  // 取消书籍的所有章节读取任务（切换书时调用）
  // 参数：(bookId: number)
  // 返回：void
  ipcMain.handle(
    IPC_CHANNELS.BOOK_CANCEL_READS,
    wrapHandler(async (_e, bookId: number) => {
      if (typeof bookId !== 'number' || !Number.isFinite(bookId) || bookId <= 0) {
        throw new Error('无效的 bookId');
      }
      return cancelChapterReads(bookId);
    })
  );

  // 清理书籍在 worker 中的缓存（书籍关闭时调用）
  // 参数：(bookId?: number)  不传则清理所有 worker 缓存
  // 返回：void
  ipcMain.handle(
    IPC_CHANNELS.BOOK_CLEAR_WORKER_CACHE,
    wrapHandler(async (_e, bookId?: number) => {
      if (bookId !== undefined && (typeof bookId !== 'number' || !Number.isFinite(bookId) || bookId <= 0)) {
        throw new Error('无效的 bookId');
      }
      return clearBookWorkerCache(bookId);
    })
  );

  // 重新分章
  // 参数：(bookId: number)
  // 返回：{ success, chapterCount, error? }
  ipcMain.handle(
    IPC_CHANNELS.BOOK_REPARSE,
    wrapHandler(async (_e, bookId: number) => {
      assertPositiveInt(bookId, 'bookId');
      return reparseBook(bookId);
    })
  );

  // 导出书籍文件
  // 参数：(bookIds: number[])
  // 返回：{ success, exportedCount, skippedCount, errors }
  ipcMain.handle(
    IPC_CHANNELS.BOOK_EXPORT,
    wrapHandler(async (event, bookIds: number[]) => {
      const result = {
        success: true,
        exportedCount: 0,
        skippedCount: 0,
        errors: [] as string[]
      };

      // B-15：限制单次导出上限，防止超大批量导出导致主进程长时间阻塞
      if (!Array.isArray(bookIds) || bookIds.length === 0) {
        result.success = false;
        result.errors.push('未指定要导出的书籍');
        return result;
      }
      if (bookIds.length > MAX_EXPORT_COUNT) {
        result.success = false;
        result.errors.push(`单次导出上限为 ${MAX_EXPORT_COUNT} 本，当前 ${bookIds.length} 本，请分批导出`);
        return result;
      }

      // 获取书籍信息
      const books = [];
      for (const id of bookIds) {
        const book = BookRepo.getBookById(id);
        if (book) {
          books.push(book);
        }
      }

      if (books.length === 0) {
        result.success = false;
        result.errors.push('未找到书籍');
        return result;
      }

      // 弹出目录选择对话框
      const win = BrowserWindow.fromWebContents(event.sender);
      const showOpen = (): Promise<Electron.OpenDialogReturnValue> => {
        if (win) {
          return dialog.showOpenDialog(win, {
            title: tMain('dialog.chooseExportDir'),
            properties: ['openDirectory', 'createDirectory']
          });
        }
        return dialog.showOpenDialog({
          title: tMain('dialog.chooseExportDir'),
          properties: ['openDirectory', 'createDirectory']
        });
      };

      const dialogResult = await showOpen();
      if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
        result.success = false;
        result.errors.push('用户取消');
        return result;
      }

      const targetDir = dialogResult.filePaths[0];

      // 逐个复制文件
      for (const book of books) {
        if (!book.local_file_path || !existsSync(book.local_file_path)) {
          result.skippedCount++;
          result.errors.push(`「${book.title}」无本地文件`);
          continue;
        }

        try {
          const fileName = basename(book.local_file_path);
          const targetPath = join(targetDir, fileName);

          // 检查目标文件是否已存在
          if (existsSync(targetPath)) {
            // 添加序号避免覆盖
            const ext = fileName.lastIndexOf('.') >= 0 ? fileName.slice(fileName.lastIndexOf('.')) : '';
            const baseName = ext ? fileName.slice(0, -ext.length) : fileName;
            let counter = 1;
            let newPath = join(targetDir, `${baseName} (${counter})${ext}`);
            // B-08：限制最大重试次数，避免极端情况下无限循环
            while (existsSync(newPath) && counter < MAX_NAME_CONFLICT_RETRY) {
              counter++;
              newPath = join(targetDir, `${baseName} (${counter})${ext}`);
            }
            if (existsSync(newPath)) {
              // 超过最大重试次数仍有冲突，跳过并记录错误
              result.skippedCount++;
              result.errors.push(`「${book.title}」文件名冲突超过 ${MAX_NAME_CONFLICT_RETRY} 次，已跳过`);
              continue;
            }
            await copyFile(book.local_file_path, newPath);
          } else {
            await copyFile(book.local_file_path, targetPath);
          }

          result.exportedCount++;
        } catch (err) {
          result.skippedCount++;
          result.errors.push(`「${book.title}」导出失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return result;
    })
  );

  // 设置自定义封面
  // 参数：(bookId: number, imagePath: string)
  // 返回：{ success, coverPath?, error? }
  ipcMain.handle(
    IPC_CHANNELS.BOOK_SET_COVER,
    wrapHandler(async (_e, bookId: number, imagePath: string) => {
      // P2 修复：补充 bookId 输入校验，防止无效 ID 导致后续 DB 操作异常
      assertPositiveInt(bookId, 'bookId');
      if (typeof imagePath !== 'string' || !imagePath) {
        return { success: false, error: '无效的图片路径' };
      }
      if (!imagePath || !existsSync(imagePath)) {
        return { success: false, error: '图片文件不存在' };
      }

      const resolvedPath = resolve(imagePath);
      const dataRoot = getUserDataRoot();
      const tempPath = app.getPath('temp');
      const isAllowed =
        resolvedPath === dataRoot ||
        resolvedPath.startsWith(dataRoot + sep) ||
        resolvedPath === tempPath ||
        resolvedPath.startsWith(tempPath + sep);
      if (!isAllowed) {
        return { success: false, error: '不允许从该路径复制文件' };
      }

      const ext = extname(imagePath).toLowerCase();
      const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];
      if (!allowedExts.includes(ext)) {
        return { success: false, error: '仅支持 jpg/png/webp 格式' };
      }

      const coversDir = getCoversRoot();
      if (!existsSync(coversDir)) {
        await mkdir(coversDir, { recursive: true });
      }

      const timestamp = Date.now();
      const coverFileName = `${bookId}_${timestamp}${ext}`;
      const coverPath = join(coversDir, coverFileName);

      await copyFile(imagePath, coverPath);
      BookRepo.updateBook(bookId, { cover: coverPath });

      return { success: true, coverPath };
    })
  );
}
