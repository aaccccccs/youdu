/**
 * 应用信息 IPC
 */
import { ipcMain, app, dialog, BrowserWindow, shell } from 'electron';
import { existsSync, promises as fsp } from 'fs';
import { join, resolve, sep, isAbsolute } from 'path';

import { getUserDataRoot, getConfigPath, getBooksRoot, getCoversRoot, getCachePath, setDataRoot } from '../utils';
import { closeDatabase, initDatabase, rewriteBookPaths } from '../db';
import { closeAllEpubCaches } from '../core/parsers/epub-parser';
import { closeAllPdfCaches } from '../core/parsers/pdf-parser';
import { closeAllMobiCaches } from '../core/parsers/mobi-parser';
import { closeAllComicCaches } from '../core/parsers/comic-parser';
import { pdfWorkerPool } from '../core/pdf-worker-pool';

import { IPC_CHANNELS, wrapHandler, assertNonEmptyString } from './shared';

/** APP_OPEN_PATH 允许打开的目录枚举（主进程自行解析路径，防止任意路径打开） */
type OpenPathTarget = 'userData' | 'books' | 'covers' | 'cache';

/** 枚举 → 实际目录解析表 */
function resolveOpenTarget(target: string): string | null {
  switch (target as OpenPathTarget) {
    case 'userData':
      return getUserDataRoot();
    case 'books':
      return getBooksRoot();
    case 'covers':
      return getCoversRoot();
    case 'cache':
      return getCachePath();
    default:
      return null;
  }
}

/** 注册应用信息相关 IPC handler */
export function registerAppIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.APP_GET_VERSION,
    wrapHandler(() => {
      return app.getVersion();
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.APP_GET_PATHS,
    wrapHandler(() => {
      return {
        userData: getUserDataRoot(),
        config: getConfigPath(),
        books: getBooksRoot(),
        covers: getCoversRoot(),
        cache: getCachePath()
      };
    })
  );

  // 选择目录对话框（用于数据目录展示/定位）
  ipcMain.handle(
    IPC_CHANNELS.APP_SELECT_DIRECTORY,
    wrapHandler(async () => {
      const win = BrowserWindow.getFocusedWindow();
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    })
  );

  // 在系统文件管理器中打开数据目录（安全：仅枚举白名单，主进程解析路径）
  ipcMain.handle(
    IPC_CHANNELS.APP_OPEN_PATH,
    wrapHandler(async (_e, target: unknown) => {
      assertNonEmptyString(target, 'target');
      const resolved = resolveOpenTarget(target);
      if (!resolved) {
        throw new Error('无效的 target：仅支持 userData/books/covers/cache');
      }
      if (!existsSync(resolved)) {
        await fsp.mkdir(resolved, { recursive: true });
      }
      const errorMessage = await shell.openPath(resolved);
      if (errorMessage) {
        throw new Error(`打开目录失败: ${errorMessage}`);
      }
      return true;
    })
  );

  // 数据目录迁移：移动 books/covers/youdu.db 到 <newRoot>/Youdu 并写 youdu-config.json
  // 语义：剪切（不是复制）——旧目录数据全部转到新目录，旧目录数据文件被自动删除；
  // 任何步骤失败都不写配置、不删旧数据（回滚到旧 db 供当前会话继续使用）。
  // 移动策略：先尝试 fsp.rename（同磁盘原子操作最快），跨磁盘 EXDEV 时 fallback 到
  // fsp.cp + fsp.rm（复制后删除源）。移动全部成功后清理旧目录残留数据文件。
  ipcMain.handle(
    IPC_CHANNELS.APP_MIGRATE_DATA,
    wrapHandler(async (_e, newRoot: unknown) => {
      assertNonEmptyString(newRoot, 'newRoot');
      if (!isAbsolute(newRoot) || newRoot.includes('\0')) {
        throw new Error('无效的 newRoot：必须为不含非法字符的绝对路径');
      }

      // 目标目录必须已存在、是目录、可写（来自系统目录选择器的返回值）
      const stat = await fsp.stat(newRoot).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        throw new Error('无效的 newRoot：目录不存在');
      }
      await fsp.access(newRoot, fsp.constants.W_OK);

      const oldRoot = getUserDataRoot();
      // 新数据根固定为 <newRoot>/Youdu，避免污染用户选择的根目录
      const targetRoot = join(newRoot, 'Youdu');
      const resolvedTarget = resolve(targetRoot);
      const resolvedOld = resolve(oldRoot);
      // 防重叠：目标不能等于/包含/被包含于当前数据目录
      if (
        resolvedTarget === resolvedOld ||
        resolvedTarget.startsWith(resolvedOld + sep) ||
        resolvedOld.startsWith(resolvedTarget + sep)
      ) {
        throw new Error('目标目录与当前数据目录重叠，请选择其他位置');
      }
      // 目标已含数据库视为"已迁移过"，拒绝覆盖
      if (existsSync(join(targetRoot, 'youdu.db'))) {
        throw new Error('目标目录已存在 youdu.db，请更换目录或先清理');
      }
      const srcDb = join(oldRoot, 'youdu.db');
      if (!existsSync(srcDb)) {
        throw new Error('当前数据目录缺少 youdu.db，无法迁移');
      }

      /**
       * 移动文件/目录：先尝试 rename（同磁盘原子操作最快），失败且 EXDEV
       * （跨磁盘）时 fallback 到 cp + rm（复制后删除源）。
       * 任何其他错误直接抛出，由上层回滚。
       */
      async function moveEntry(src: string, dest: string): Promise<void> {
        try {
          await fsp.rename(src, dest);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'EXDEV') throw err;
          // 跨磁盘：先复制再删除源（recursive 支持目录）
          await fsp.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
          await fsp.rm(src, { recursive: true, force: true });
        }
      }

      // 关闭 db 连接（closeDatabase 会先执行 wal_checkpoint(TRUNCATE) 把 WAL 全部
      // 合并进 youdu.db 并截断 WAL 文件，确保 youdu.db 自包含）
      closeDatabase();
      // 清理文件解析器缓存和 PDF worker 缓存：缓存中持有旧路径文件的句柄，
      // 不清理会导致 (1) Windows 上 rename 失败（文件被占用）(2) 迁移后重新打开
      // 书籍时从旧路径读取（文件已删除）报错。必须在移动数据之前清理。
      try {
        closeAllEpubCaches();
      } catch (e) {
        console.warn('[app:migrateData] EPUB缓存清理失败:', e);
      }
      try {
        closeAllPdfCaches();
      } catch (e) {
        console.warn('[app:migrateData] PDF缓存清理失败:', e);
      }
      try {
        closeAllMobiCaches();
      } catch (e) {
        console.warn('[app:migrateData] MOBI缓存清理失败:', e);
      }
      try {
        closeAllComicCaches();
      } catch (e) {
        console.warn('[app:migrateData] Comic缓存清理失败:', e);
      }
      try {
        pdfWorkerPool.clearWorkerCache();
      } catch (e) {
        console.warn('[app:migrateData] Worker缓存清理失败:', e);
      }
      // 逐个移动文件并发送进度到所有窗口。
      // 'app:migrate-progress' 通道由任务 #29 统一定义为 IPC_CHANNELS.APP_MIGRATE_PROGRESS。
      let total = 0;
      try {
        await fsp.mkdir(targetRoot, { recursive: true });
        // 移动旧目录下所有内容到新目录（除了 youdu-config.json 配置指针）。
        // 用 readdir 动态列举，确保不遗漏任何子目录（rss-images/images/logs 等）。
        const entries = await fsp.readdir(oldRoot);
        const entriesToMove = entries.filter((e) => e !== 'youdu-config.json');
        total = entriesToMove.length;
        let completed = 0;
        for (const entry of entriesToMove) {
          await moveEntry(join(oldRoot, entry), join(targetRoot, entry));
          completed++;
          for (const win of BrowserWindow.getAllWindows()) {
            // F3修复：使用共享通道常量，避免硬编码字符串与 preload 侧常量漂移
            win.webContents.send(IPC_CHANNELS.APP_MIGRATE_PROGRESS, { current: completed, total, entry });
          }
        }
      } catch (err) {
        // 移动失败：不写配置、不删旧数据；恢复 db 供当前会话继续使用
        try {
          initDatabase();
        } catch (reinitErr) {
          console.warn('[app:migrateData] 迁移失败后恢复数据库失败:', reinitErr);
        }
        throw err;
      }

      // 移动全部成功后，清理旧目录残留（rename 已移走，这里兜底删未被列入的残留）。
      // 保留 youdu-config.json（配置指针）。
      // 带重试机制：Windows 上文件可能被短暂占用（如杀软扫描），单次 rm 易失败。
      async function rmWithRetry(target: string, maxRetries = 3): Promise<void> {
        for (let i = 0; i < maxRetries; i++) {
          try {
            await fsp.rm(target, { recursive: true, force: true });
            return;
          } catch (err) {
            if (i === maxRetries - 1) throw err;
            await new Promise((r) => setTimeout(r, 200 * (i + 1)));
          }
        }
      }

      for (const entry of await fsp.readdir(oldRoot)) {
        if (entry === 'youdu-config.json') continue;
        const oldEntry = join(oldRoot, entry);
        if (existsSync(oldEntry)) {
          await rmWithRetry(oldEntry).catch((rmErr) => {
            console.warn(`[app:migrateData] 清理旧目录残留 ${entry} 失败:`, rmErr);
          });
        }
      }

      // 删除旧目录本身（如果不是 Electron userData 目录）。
      // userData 目录不能删（删了会导致应用崩溃），只删其下残留（上面已处理），保留空目录。
      // 非 userData 目录（用户自定义路径）则整个删除，避免用户看到旧目录以为迁移没成功。
      const electronUserData = app.getPath('userData');
      if (resolve(oldRoot) !== resolve(electronUserData)) {
        await rmWithRetry(oldRoot).catch((err) => {
          console.warn('[app:migrateData] 删除旧目录本身失败（可忽略）:', err);
        });
      }

      // 移动全部成功后才写配置并同步内存缓存（setDataRoot 会刷新 _dataRoot）
      setDataRoot(targetRoot);

      // 此时 _dataRoot 已指向新目录，initDatabase 会打开新路径的 youdu.db，
      // 后续路径重写基于新打开的 db。
      // 恢复失败仅告警，不影响迁移结果（重启后仍使用新目录）
      try {
        initDatabase();
      } catch (reinitErr) {
        console.warn('[app:migrateData] 迁移后恢复数据库失败（重启后使用新目录）:', reinitErr);
      }

      // 重写数据库中的绝对路径（cover 和 local_file_path 存的是旧目录的绝对路径）。
      // 迁移后数据目录变了，若不重写，重启后封面和书籍都找不到。
      // 失败仅告警，不影响迁移结果（重启后仍使用新目录）
      try {
        rewriteBookPaths(oldRoot, targetRoot);
      } catch (rewriteErr) {
        console.warn('[app:migrateData] 数据库路径重写失败（部分封面/书籍可能无法打开）:', rewriteErr);
      }

      // 通知前端迁移完成，即将重启（done: true 让前端显示"即将重启"提示）
      for (const win of BrowserWindow.getAllWindows()) {
        // F3修复：使用共享通道常量，避免硬编码字符串与 preload 侧常量漂移
        win.webContents.send(IPC_CHANNELS.APP_MIGRATE_PROGRESS, { current: total, total, done: true });
      }

      // 延迟 1.5 秒后自动重启，让用户看到"即将重启"提示。
      // 自动重启比全局刷新更可靠：所有状态从新目录干净加载，
      // 避免旧 db 句柄/缓存/worker 拿着旧路径数据造成的不一致。
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 1500);

      // 返回值在重启后无意义，但保持结构一致便于前端处理
      return { ok: true, newPath: targetRoot, oldPath: oldRoot };
    })
  );

}
