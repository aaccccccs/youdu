/**
 * 文件导入 IPC
 */
import { ipcMain, dialog, BrowserWindow } from 'electron';

import {
  importFiles,
  scanDirectory,
  summarizeResults,
  type ImportFileProgress,
  type ImportResult
} from '../core/importer';
import { tMain } from '../i18n';

import { IPC_CHANNELS, wrapHandler, assertPositiveInt, isValidImportPath } from './shared';

/** 文件选择对话框过滤器（按当前语言生成） */
function getFileFilters(): Electron.FileFilter[] {
  return [
    {
      name: tMain('dialog.filters.books'),
      extensions: ['txt', 'epub', 'mobi', 'azw', 'azw3', 'pdf', 'fb2', 'cbz', 'cbr', 'cb7', 'cbt', 'zip', 'rar']
    },
    { name: tMain('dialog.filters.txt'), extensions: ['txt'] },
    { name: tMain('dialog.filters.epub'), extensions: ['epub'] },
    { name: tMain('dialog.filters.mobi'), extensions: ['mobi', 'azw', 'azw3'] },
    { name: tMain('dialog.filters.pdf'), extensions: ['pdf'] },
    { name: tMain('dialog.filters.comic'), extensions: ['cbz', 'cbr', 'cb7', 'cbt', 'zip', 'rar'] },
    { name: tMain('dialog.filters.all'), extensions: ['*'] }
  ];
}

/** 导入完成后的汇总结果（通过 IPC 返回给渲染进程） */
interface ImportSummary {
  results: ImportResult[];
  summary: {
    total: number;
    success: number;
    skipped: number;
    failed: number;
  };
  /** 导入过程中发生致命错误时的错误信息（如目录扫描失败、文件读取异常等） */
  error?: string;
}

/**
 * 注册文件导入 IPC handler
 *
 * @param getMainWindow 获取主窗口实例的函数（用于推送进度事件）
 */
export function registerImportIpc(getMainWindow: () => BrowserWindow | null): void {
  // ─── 打开文件选择对话框（多选） ───
  ipcMain.handle(
    IPC_CHANNELS.IMPORT_SELECT_FILES,
    wrapHandler(async (): Promise<string[]> => {
      const result = await dialog.showOpenDialog({
        title: tMain('dialog.chooseBookFiles'),
        properties: ['openFile', 'multiSelections'],
        filters: getFileFilters()
      });
      if (result.canceled || result.filePaths.length === 0) {
        return [];
      }
      return result.filePaths;
    })
  );

  // ─── 打开文件夹选择对话框 ───
  ipcMain.handle(
    IPC_CHANNELS.IMPORT_SELECT_DIRECTORY,
    wrapHandler(async (): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        title: tMain('dialog.chooseBookFolder'),
        properties: ['openDirectory']
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    })
  );

  // ─── 打开图片选择对话框（单选，过滤 jpg/png/webp） ───
  ipcMain.handle(
    IPC_CHANNELS.IMPORT_SELECT_IMAGE,
    wrapHandler(async (): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        title: tMain('dialog.chooseCover'),
        properties: ['openFile'],
        filters: [
          { name: tMain('dialog.filters.images'), extensions: ['jpg', 'jpeg', 'png', 'webp'] },
          { name: tMain('dialog.filters.all'), extensions: ['*'] }
        ]
      });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    })
  );

  // ─── 批量导入文件 ───
  ipcMain.handle(
    IPC_CHANNELS.IMPORT_FILES,
    wrapHandler(
      async (_e, filePaths: string[], groupId?: number | null, parseMode?: string): Promise<ImportSummary> => {
        const empty: ImportSummary = {
          results: [],
          summary: { total: 0, success: 0, skipped: 0, failed: 0 }
        };
        // P2 修复：文件路径输入校验，防止异常输入导致崩溃
        // 安全修复：用 isValidImportPath 校验每个路径，防 null byte injection 和空路径
        if (!Array.isArray(filePaths)) return empty;
        if (filePaths.length === 0) return empty;
        if (filePaths.length > 1000) {
          return {
            results: [],
            summary: { total: filePaths.length, success: 0, skipped: 0, failed: filePaths.length },
            error: '单次导入文件过多（超过 1000），请分批导入'
          };
        }
        for (const fp of filePaths) {
          if (!isValidImportPath(fp)) {
            return {
              results: [],
              summary: { total: filePaths.length, success: 0, skipped: 0, failed: filePaths.length },
              error: '无效的文件路径（空字符串或含 null byte）'
            };
          }
        }
        if (groupId !== undefined && groupId !== null) assertPositiveInt(groupId, 'groupId');

        try {
          const results = await importFiles(
            filePaths,
            (progress: ImportFileProgress) => {
              const win = getMainWindow();
              if (win && !win.isDestroyed()) {
                win.webContents.send(IPC_CHANNELS.IMPORT_PROGRESS, progress);
              }
            },
            groupId,
            parseMode as any,
            (book) => {
              const win = getMainWindow();
              if (win && !win.isDestroyed()) {
                win.webContents.send(IPC_CHANNELS.IMPORT_BOOK_ADDED, book);
              }
            }
          );

          const summary = summarizeResults(results);
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.IMPORT_COMPLETE, summary);
          }
          return { results, summary };
        } catch (err) {
          console.error('[IPC] import:files error:', err);
          const message = err instanceof Error ? err.message : String(err);
          return {
            results: [],
            summary: { total: filePaths.length, success: 0, skipped: 0, failed: filePaths.length },
            error: message
          };
        }
      }
    )
  );

  // ─── 扫描文件夹并批量导入 ───
  ipcMain.handle(
    IPC_CHANNELS.IMPORT_DIRECTORY,
    wrapHandler(async (_e, dirPath: string, groupId?: number | null): Promise<ImportSummary> => {
      const empty: ImportSummary = {
        results: [],
        summary: { total: 0, success: 0, skipped: 0, failed: 0 }
      };
      // P2 修复：文件路径输入校验，防止异常输入导致崩溃
      // 安全修复：用 isValidImportPath 校验目录路径，防 null byte injection 和空路径
      if (!isValidImportPath(dirPath) || !dirPath.trim()) {
        return empty;
      }
      if (groupId !== undefined && groupId !== null) assertPositiveInt(groupId, 'groupId');

      try {
        // 扫描目录
        const filePaths = await scanDirectory(dirPath);
        if (filePaths.length === 0) {
          return empty;
        }

        const results = await importFiles(
          filePaths,
          (progress: ImportFileProgress) => {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send(IPC_CHANNELS.IMPORT_PROGRESS, progress);
            }
          },
          groupId,
          undefined,
          (book) => {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send(IPC_CHANNELS.IMPORT_BOOK_ADDED, book);
            }
          }
        );

        const summary = summarizeResults(results);
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.IMPORT_COMPLETE, summary);
        }
        return { results, summary };
      } catch (err) {
        console.error('[IPC] import:directory error:', err);
        const message = err instanceof Error ? err.message : String(err);
        return {
          results: [],
          summary: { total: 0, success: 0, skipped: 0, failed: 0 },
          error: message
        };
      }
    })
  );
}
