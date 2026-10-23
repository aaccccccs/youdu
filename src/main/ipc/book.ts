/**
 * 书籍阅读 IPC
 */
import { ipcMain, app, dialog, BrowserWindow } from 'electron';
import { join, basename, extname, resolve, sep } from 'path';
import { copyFile, mkdir, rm } from 'fs/promises';
import { existsSync, statSync } from 'fs';

import { getCoversRoot, getUserDataRoot, type BookFileType } from '../utils';
import { readChapterContent, cancelChapterReads, clearBookWorkerCache } from '../core/chapter-reader';
import { reparseBook, importBookFile, verifyFileMatchesHash, searchBookFileInDirectory } from '../core/importer';
import { reclassifyAllBooks, cancelReclassify } from '../core/reclassifier';
import { getDb } from '../db/index';
import { upsertClassifyFeedback, updateBookContentType } from '../db/repositories';
import * as BookRepo from '../db/repositories';
import { tMain } from '../i18n';

import { IPC_CHANNELS, wrapHandler, assertPositiveInt, isPathSafe } from './shared';

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
    wrapHandler(async (_e, bookId: number, chapterIndex: number, opts?: { textOnly?: boolean }) => {
      if (typeof bookId !== 'number' || !Number.isFinite(bookId) || bookId <= 0) {
        throw new Error('无效的 bookId');
      }
      if (typeof chapterIndex !== 'number' || !Number.isFinite(chapterIndex) || chapterIndex < 0) {
        throw new Error('无效的 chapterIndex');
      }
      return readChapterContent(bookId, chapterIndex, opts);
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

  // P3：用户手动修正内容分类（文字/图文/漫画/扫描版）
  // 参数：(bookId: number, shape: 'text'|'illustrated'|'scan'|'comic')
  // 返回：{ ok, contentType, sampled }  sampled=是否记录了反馈样本（有特征向量才记）
  // 说明：更新 books.content_type/is_comic 立即生效（渲染路由由运行时判定自动跟随），
  //       若有导入时存档的特征向量则写入 classification_feedback，供后续导入 k-NN 参考。
  ipcMain.handle(
    IPC_CHANNELS.BOOK_SET_CONTENT_TYPE,
    wrapHandler(async (_e, bookId: number, shape: string) => {
      if (typeof bookId !== 'number' || !Number.isFinite(bookId) || bookId <= 0) {
        throw new Error('无效的 bookId');
      }
      const SHAPES = ['text', 'illustrated', 'scan', 'comic'] as const;
      if (!SHAPES.includes(shape as (typeof SHAPES)[number])) {
        throw new Error(`无效的分类形态: ${shape}`);
      }
      const book = BookRepo.getBookById(bookId);
      if (!book) throw new Error(`书籍不存在: id=${bookId}`);

      // 读取导入时存档的特征向量（custom_meta.classify_signals）
      // 任务41：嵌 source='user' 标记（signals JSON 内嵌字段区分用户手动修正
      // 与批量重检 auto 样本，k-NN 投票时 user 权重 ×3；旧样本无 source 视为 user）
      let signalsJson: string | null = null;
      try {
        const meta = JSON.parse(book.custom_meta ?? '{}') as { classify_signals?: unknown };
        if (meta.classify_signals && typeof meta.classify_signals === 'object') {
          signalsJson = JSON.stringify({ ...(meta.classify_signals as object), source: 'user' });
        }
      } catch {
        // custom_meta 损坏，忽略
      }

      // scan 归入 illustrated 标签（与三分类兼容），行为同为"图片渲染"
      const contentType: 'text' | 'illustrated' | 'comic' =
        shape === 'comic' ? 'comic' : shape === 'text' ? 'text' : 'illustrated';
      updateBookContentType(bookId, contentType);

      let sampled = false;
      if (signalsJson) {
        upsertClassifyFeedback(bookId, shape, signalsJson);
        sampled = true;
      }
      console.log(
        `[classify] 用户修正: bookId=${bookId} 《${book.title}》 → ${shape}(标签${contentType})${sampled ? ' + 已记录反馈样本' : '（无特征向量，仅改标签）'}`
      );
      return { ok: true, contentType, sampled };
    })
  );

  // 批量重新分类（任务40）：全库 PDF 重检
  // 参数：() 无参
  // 返回：{ processed, changed, skipped, failed, cancelled }
  //   processed=完成信号采集与判定的本数；changed=标签/is_comic 变更的本数；
  //   skipped=文件缺失等未处理；failed=解析失败/超时/写库失败；cancelled=用户取消
  // 进度：每本完成后向所有窗口 send BOOK_RECLASSIFY_PROGRESS（载荷含 from/to/changed）。
  // 互斥：已在跑时抛错；取消经 BOOK_RECLASSIFY_CANCEL（当前书判定完成后停止）。
  // ⚠️ 只改 content_type/is_comic/custom_meta.classify_signals，绝不重建 chapters
  //    （不破坏阅读进度）；变更后章节结构不匹配的书由用户手动触发"重新解析"。
  ipcMain.handle(
    IPC_CHANNELS.BOOK_RECLASSIFY_ALL,
    wrapHandler(async () => {
      return reclassifyAllBooks((payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC_CHANNELS.BOOK_RECLASSIFY_PROGRESS, payload);
        }
      });
    })
  );

  // 批量重新分类取消（任务40）
  // 参数：() 无参
  // 返回：{ cancelled: boolean }  true=已对运行中的重检置取消标志；false=当前无任务
  ipcMain.handle(
    IPC_CHANNELS.BOOK_RECLASSIFY_CANCEL,
    wrapHandler(async () => {
      return { cancelled: cancelReclassify() };
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

  // 重新定位（批次 v54 导入三模式）
  // 参数：(bookId: number, newPath: string)
  // 返回：{ success: boolean, error?: 'FILE_NOT_FOUND' | 'HASH_MISMATCH' | string }
  // 流程：新路径流式算哈希（复用 importer 的 xxhash64；file_hash 为 64 位旧
  // SHA-256 时双哈希兼容）→ 与 books.file_hash 比对 → 一致则静默更新
  // local_file_path（无感恢复，前端自动重试打开）；不一致返回 HASH_MISMATCH
  // （所选文件与原书内容不同），不更新 DB。
  ipcMain.handle(
    IPC_CHANNELS.BOOK_RELOCATE,
    wrapHandler(async (_e, bookId: number, newPath: string) => {
      assertPositiveInt(bookId, 'bookId');
      if (typeof newPath !== 'string' || !newPath.trim() || newPath.includes('\0')) {
        return { success: false, error: '无效的文件路径' };
      }
      if (!existsSync(newPath)) {
        return { success: false, error: 'FILE_NOT_FOUND' };
      }
      const stat = statSync(newPath);
      if (stat.size === 0) {
        return { success: false, error: 'FILE_NOT_FOUND' };
      }

      const book = BookRepo.getBookById(bookId);
      if (!book) {
        return { success: false, error: `书籍不存在: id=${bookId}` };
      }
      if (!book.file_hash) {
        // 无哈希记录的旧书（理论不出现：导入时必算哈希）——直接更新路径
        BookRepo.updateBook(bookId, { local_file_path: newPath });
        return { success: true };
      }

      // 双哈希兼容：file_hash 64 位 = 旧 SHA-256，16 位 = xxhash64。
      // verifyFileMatchesHash 先算当前算法（快），未命中且为旧哈希再算 SHA-256（慢，仅旧库触发一次）
      const matched = await verifyFileMatchesHash(newPath, book.file_hash);

      if (!matched) {
        return { success: false, error: 'HASH_MISMATCH' };
      }

      // 哈希一致：静默更新路径（无感恢复，阅读器无感重试）
      BookRepo.updateBook(bookId, { local_file_path: newPath });
      console.log(`[relocate] bookId=${bookId} 《${book.title}》已重新定位: ${newPath}`);
      return { success: true };
    })
  );

  // 批量检查 link 书失效（P2 导入三模式，设计文档第二节第 2 层检测）
  // 参数：() 无参
  // 返回：{ bookId: number; missing: boolean }[]
  // 轻量：查全部 import_mode='link' 的书逐本 existsSync（不读文件内容，
  // 不哈希）。渲染端书架挂载 30s 后异步调用（不阻塞书架渲染），
  // 结果存 bookshelf store 供封面 ⚠ 角标与详情页 NAlert 消费。
  ipcMain.handle(
    IPC_CHANNELS.BOOK_CHECK_LINKS,
    wrapHandler(async () => {
      const db = getDb();
      const rows = db.prepare('SELECT id, local_file_path FROM books WHERE import_mode = ?').all('link') as Array<{
        id: number;
        local_file_path: string | null;
      }>;
      return rows.map((r) => ({
        bookId: r.id,
        // 路径为空同样视为失效（防御：异常数据不炸书架）
        missing: !r.local_file_path || !existsSync(r.local_file_path)
      }));
    })
  );

  // 目录递归深度搜索（P2 导入三模式，设计文档第二节第 3 层深度恢复）
  // 参数：(bookId: number, startDir: string)
  // 返回：{ success: true, path } 找到匹配文件；{ success: false, error } 结构化错误：
  //   'INVALID_DIR' 起始目录不存在/非目录；'NO_HASH' 书无哈希记录；
  //   'NOT_FOUND' 未找到；'TIMEOUT' 超过 30s 放弃
  // 流程：custom_meta.file_size 大小过滤（缺失时退化全哈希）→ 扩展名匹配
  // → xxhash64 快路径（旧 SHA-256 双哈希兼容）→ 与 books.file_hash 比对。
  // 找到后前端自动调 BOOK_RELOCATE 落库（复用无感恢复闭环）。
  ipcMain.handle(
    IPC_CHANNELS.BOOK_SEARCH_FILE,
    wrapHandler(async (_e, bookId: number, startDir: string) => {
      assertPositiveInt(bookId, 'bookId');
      if (typeof startDir !== 'string' || !startDir.trim() || startDir.includes('\0')) {
        return { success: false, error: 'INVALID_DIR' };
      }
      let isDir = false;
      try {
        isDir = statSync(startDir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        return { success: false, error: 'INVALID_DIR' };
      }

      const book = BookRepo.getBookById(bookId);
      if (!book) {
        return { success: false, error: `书籍不存在: id=${bookId}` };
      }
      if (!book.file_hash) {
        // 无哈希无法按内容查找（理论不出现：导入时必算哈希）
        return { success: false, error: 'NO_HASH' };
      }

      // 大小过滤依据：custom_meta.file_size（导入时存档）。
      // custom_meta 损坏/缺失 → null → 退化为对全部候选文件哈希（正确性优先）
      let expectedSize: number | null = null;
      try {
        const meta = JSON.parse(book.custom_meta ?? '{}') as { file_size?: unknown };
        if (typeof meta.file_size === 'number' && Number.isFinite(meta.file_size) && meta.file_size > 0) {
          expectedSize = meta.file_size;
        }
      } catch {
        // custom_meta 损坏，忽略（走全哈希路径）
      }

      const result = await searchBookFileInDirectory(book.file_hash, book.file_type ?? '', startDir, expectedSize);
      if (result.success && result.path) {
        console.log(
          `[searchFile] bookId=${bookId} 《${book.title}》深度搜索命中（扫描 ${result.scannedFiles} 个文件）: ${result.path}`
        );
      } else {
        console.log(
          `[searchFile] bookId=${bookId} 《${book.title}》深度搜索未命中: ${result.error}（扫描 ${result.scannedFiles} 个文件）`
        );
      }
      return result;
    })
  );

  // copy↔link 存储模式转换（P2 导入三模式，设计文档第六节 #9）
  // 参数：(bookId: number, targetMode: 'copy' | 'link', newSrcPath?: string)
  // 返回：{ success, error?, freedBytes?, copiedBytes? }
  //   error 码：'FILE_NOT_FOUND' 源/原文件不存在；'HASH_MISMATCH' copy→link
  //   所选原文件与本书内容不一致；'NO_HASH' 无哈希记录无法校验；其余为文字说明
  // 中间态保护（任务要求：UPDATE 放在文件操作成功之后）：
  //   - copy/move→link：哈希校验（文件操作）成功 → UPDATE DB → 删 userData 副本。
  //     删副本在 UPDATE 之后：DB 已指向新路径，删除失败只残留孤儿副本（无害），
  //     不存在"删了副本 DB 却没改"的丢书窗口；isPathSafe 护栏防误删 userData 外文件
  //   - link→copy：importBookFile copy 分支（.tmp 原子落位三层防御）复制成功
  //     → UPDATE DB；复制失败抛错 DB 不动，原文件全程无损
  ipcMain.handle(
    IPC_CHANNELS.BOOK_CONVERT_IMPORT_MODE,
    wrapHandler(async (_e, bookId: number, targetMode: string, newSrcPath?: string) => {
      assertPositiveInt(bookId, 'bookId');
      if (targetMode !== 'link' && targetMode !== 'copy') {
        return { success: false, error: `无效的目标模式: ${targetMode}` };
      }
      const book = BookRepo.getBookById(bookId);
      if (!book) {
        return { success: false, error: `书籍不存在: id=${bookId}` };
      }
      const currentMode = book.import_mode ?? 'copy';

      // ─── copy/move → link：释放 userData 副本空间 ───
      if (targetMode === 'link') {
        if (currentMode === 'link') {
          return { success: false, error: '当前已是引用模式' };
        }
        if (typeof newSrcPath !== 'string' || !newSrcPath.trim() || newSrcPath.includes('\0')) {
          return { success: false, error: '缺少原文件路径' };
        }
        if (!existsSync(newSrcPath) || statSync(newSrcPath).size === 0) {
          return { success: false, error: 'FILE_NOT_FOUND' };
        }
        // 哈希校验必须有（防把内容不同的文件挂到书上——章节 offset 全错位）
        if (!book.file_hash) {
          return { success: false, error: 'NO_HASH' };
        }
        const matched = await verifyFileMatchesHash(newSrcPath, book.file_hash);
        if (!matched) {
          return { success: false, error: 'HASH_MISMATCH' };
        }

        // 校验通过 → 切换 DB（local_file_path 指向已验证的新路径）
        const oldPath = book.local_file_path;
        BookRepo.updateBook(bookId, { local_file_path: newSrcPath, import_mode: 'link' });

        // DB 已切换后删除旧副本：失败仅残留孤儿副本（下次同 hash 导入会复用），不回滚
        let freedBytes = 0;
        if (oldPath && isPathSafe(oldPath) && existsSync(oldPath)) {
          try {
            freedBytes = statSync(oldPath).size;
            await rm(oldPath, { force: true });
          } catch (err) {
            console.warn(`[convert] 删除旧副本失败（残留孤儿副本，不影响使用）: ${oldPath}`, err);
            freedBytes = 0;
          }
        } else if (oldPath) {
          // 旧路径不在 userData 自管目录内（异常状态）：跳过删除只告警
          console.warn(`[convert] 旧副本路径未通过安全校验，跳过删除: ${oldPath}`);
        }
        console.log(
          `[convert] bookId=${bookId} 《${book.title}》${currentMode}→link: ${newSrcPath}，释放 ${freedBytes} 字节`
        );
        return { success: true, freedBytes };
      }

      // ─── link → copy：收归 userData 自管（原文件保留不动） ───
      if (currentMode !== 'link') {
        return { success: false, error: '当前已是复制模式' };
      }
      const srcPath = book.local_file_path;
      if (!srcPath || !existsSync(srcPath) || statSync(srcPath).size === 0) {
        return { success: false, error: 'FILE_NOT_FOUND' };
      }
      if (!book.file_type) {
        return { success: false, error: '书籍文件类型未知' };
      }
      if (!book.file_hash) {
        return { success: false, error: 'NO_HASH' };
      }

      // 复用 importBookFile 的 copy 分支：含 .tmp 原子落位 + 大小校验三层防御
      // （与正常导入同一代码路径；目标已存在且完整时幂等复用）
      const destPath = await importBookFile(srcPath, book.file_type as BookFileType, book.file_hash, 'copy');

      // 复制成功后才改 DB（复制失败上方已抛错，DB 不动）
      BookRepo.updateBook(bookId, { local_file_path: destPath, import_mode: 'copy' });
      let copiedBytes = 0;
      try {
        copiedBytes = statSync(destPath).size;
      } catch {
        // statSync 刚落位即失败属极端场景，大小仅作 toast 展示
      }
      console.log(`[convert] bookId=${bookId} 《${book.title}》link→copy: ${srcPath} → ${destPath}`);
      return { success: true, copiedBytes };
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

  // 保存章节图片（v56 P0 对标 Mihon：图片右键"保存当前页"）
  // 参数：(imagePath: string, suggestedName?: string)
  // 返回：{ success, canceled?, savedPath?, error? }
  // 流程：isPathSafe 校验源路径（防任意文件复制——章节图片缓存在 userData
  // 自管目录 images/comic 下）→ 系统保存对话框（默认 Downloads 目录 +
  // 建议文件名，扩展名过滤）→ fsPromises.copyFile。用户取消返回
  // { success:false, canceled:true }（前端静默不弹错误）。
  ipcMain.handle(
    IPC_CHANNELS.CHAPTER_SAVE_IMAGE,
    wrapHandler(async (event, imagePath: string, suggestedName?: string) => {
      if (typeof imagePath !== 'string' || !imagePath.trim() || imagePath.includes('\0')) {
        return { success: false, error: '无效的图片路径' };
      }
      if (!isPathSafe(imagePath) || !existsSync(imagePath)) {
        return { success: false, error: '图片文件不存在' };
      }

      // 建议文件名：basename 剥离目录部分（防建议名携带路径穿越），
      // 缺省用源文件名（PDF 页缓存即 page_N.webp，天然满足"页号命名"）
      const defaultName =
        typeof suggestedName === 'string' && suggestedName.trim()
          ? basename(suggestedName.trim())
          : basename(imagePath);

      // 扩展名跟随源文件（webp/png），保存对话框限定同类过滤
      const ext = extname(defaultName).toLowerCase() || extname(imagePath).toLowerCase() || '.webp';
      const extNoDot = ext.replace('.', '');
      const dialogOptions: Electron.SaveDialogOptions = {
        title: tMain('dialog.saveImage'),
        defaultPath: join(app.getPath('downloads'), defaultName),
        filters: [{ name: extNoDot.toUpperCase(), extensions: [extNoDot] }]
      };

      const win = BrowserWindow.fromWebContents(event.sender);
      const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      try {
        await copyFile(imagePath, result.filePath);
      } catch (err) {
        return { success: false, error: `复制文件失败: ${err instanceof Error ? err.message : String(err)}` };
      }
      console.log(`[saveImage] 章节图片已保存: ${result.filePath}`);
      return { success: true, savedPath: result.filePath };
    })
  );
}
