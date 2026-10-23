/**
 * 通用解析 Worker 池（parser-worker-pool）
 *
 * 在主线程维护一组 worker_threads 子线程，把 CPU 密集型文件解析（PDF/EPUB/MOBI/
 * TXT/Comic）、封面提取、章节阅读派发到子线程执行，避免阻塞主线程事件循环导致
 * 批量导入或阅读时界面卡死。
 *
 * - Worker 数量：WORKER_COUNT = clamp(cpus - 1, 1, 3)
 * - Worker 路径：编译后与本文件同目录的 pdf-worker.js（out/main/pdf-worker.js）
 * - 任务队列：所有 worker 忙碌时新任务入队，worker 空闲时自动派发
 * - 容错：worker 异常/error/非 0 退出时 reject 其所有 pending 任务并重启 worker
 *
 * 消息协议见 pdf-worker.ts。
 */

import { Worker } from 'worker_threads';
import { join } from 'path';
import os from 'os';
import type { ParsedBook, ChapterIndex, ParseMode } from './file-parser';
import type { ChapterImage } from '../../shared';

export const WORKER_COUNT = Math.min(Math.max(os.cpus().length - 1, 1), 3);
const WORKER_PATH = join(__dirname, 'pdf-worker.js');

/** worker 支持的文件格式 */
type ParserFileType = 'pdf' | 'epub' | 'mobi' | 'txt' | 'comic';

/** 用于运行时判断第一个参数是 fileType 还是 filePath */
const FILE_TYPES: ReadonlySet<string> = new Set(['pdf', 'epub', 'mobi', 'txt', 'comic']);

/**
 * 任务取消错误
 *
 * 当任务被 cancelTasksByFilePath 取消时，Promise 会 reject 此错误。
 * 调用方可以检查 err instanceof WorkerTaskCanceledError 来区分取消和其他错误。
 */
export class WorkerTaskCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerTaskCanceledError';
  }
}

interface PendingTask {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  onProgress?: (p: number) => void;
  /** 任务取消标志：true 表示已取消，结果应被丢弃 */
  canceled?: boolean;
  /** 任务关联的文件路径，用于按文件取消任务 */
  filePath?: string;
  /** 任务超时定时器，超时后 reject 并重置 worker */
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  pending: Map<number, PendingTask>;
}

/** 队列任务：priority 小的先派发（readChapter=0 > parse/cover=1） */
interface QueuedJob {
  priority: number;
  run: (slot: WorkerSlot) => void;
  /** 任务取消标志：true 表示已取消，派发前应跳过 */
  canceled?: boolean;
  /** 任务关联的文件路径，用于按文件取消队列中的任务 */
  filePath?: string;
  /** 任务拒绝函数，用于队列满时拒绝被丢弃的任务 */
  reject?: (err: Error) => void;
}

/** 优先级：阅读请求高优先，导入请求普通优先 */
const PRIORITY_READ = 0;
const PRIORITY_IMPORT = 1;

/** Worker V8 堆内存上限（MB），超限后 V8 会 OOM 并触发 worker 重启 */
const WORKER_HEAP_LIMIT_MB = 1536;

/** 队列最大长度，超限后丢弃最低优先级任务 */
const MAX_QUEUE_SIZE = 20;

/** 内存检查间隔（毫秒） */
const MEMORY_CHECK_INTERVAL_MS = 30_000;

/** 空闲9 worker 内存重启阈值（MB） */
const IDLE_WORKER_MEMORY_LIMIT_MB = 800;

/** 故障重启退避基础延迟（毫秒） */
const RESTART_BASE_DELAY_MS = 500;
/** 故障重启退避最大延迟（毫秒） */
const RESTART_MAX_DELAY_MS = 30_000;
/** 连续故障计数滑动窗口（毫秒）：窗口内无新故障则计数清零 */
const FAILURE_WINDOW_MS = 60_000;
/** 连续故障达到此值后开始告警（退避已到上限，防止无限快速重启循环） */
const MAX_CONSECUTIVE_FAILURES = 5;

class PdfWorkerPool {
  private workers: WorkerSlot[] = [];
  private queue: QueuedJob[] = [];
  private nextId = 1;
  private terminated = false;
  private memoryCheckTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * 已取消任务的 id 集合。
   *
   * 任务被 cancelTasksByFilePath 取消时，会从 slot.pending 中删除并加入此集合。
   * 当 worker 仍处理完毕并返回结果时，message handler 据此识别已取消任务，
   * 正确重置 slot.busy 并从集合中清理，避免 worker slot 永久卡在 busy=true。
   *
   * 修复 P0-8: 此前取消任务仅从 pending 删除，message handler 找不到 task 直接
   * return，导致 slot.busy 永远不会被重置为 false，worker 永久卡死无法接受新任务。
   */
  private cancelledTasks = new Set<number>();
  /** 连续故障次数（error / 非 0 退出）；内存超限等恢复性重启不计入 */
  private consecutiveFailures = 0;
  /** 最近一次故障时间戳，用于滑动窗口清零 */
  private lastFailureAt = 0;

  constructor() {
    for (let i = 0; i < WORKER_COUNT; i++) {
      this.workers.push(this.createWorker());
    }
    this.startMemoryMonitoring();
  }

  private createWorker(): WorkerSlot {
    const worker = new Worker(WORKER_PATH, {
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_HEAP_LIMIT_MB,
        maxYoungGenerationSizeMb: 64
      }
      // 注意：不传 execArgv: ['--expose-gc']。
      // Electron 打包后的 asar 环境不支持该 flag，会导致 ERR_WORKER_INVALID_EXEC_ARGV 崩溃。
      // pdf-worker.ts 中已有 if (globalThis.gc) 保护，gc 不可用时自动跳过，不影响功能。
    });
    const slot: WorkerSlot = { worker, busy: false, pending: new Map() };

    worker.on('message', (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      const { type, id } = msg;

      if (type === 'progress') {
        const task = slot.pending.get(id);
        if (task?.onProgress) task.onProgress(msg.value);
        return;
      }

      // P1-3修复：处理 worker 发送的 error 消息（unhandledRejection/uncaughtException）
      // worker 在遇到未捕获异常时会发送 { type: 'error', error: msg, id? }
      // 如果带 id，说明是某个具体任务失败，需要 reject 该任务并重置 slot.busy
      // 如果不带 id 且 slot 正忙，说明全局异常可能导致当前任务挂起，
      // 需 reject 所有 pending 任务并重置 slot.busy，避免 worker slot 卡死在 busy=true
      if (type === 'error') {
        console.error(`[worker-pool] worker ${slot.worker.threadId} 未捕获异常: ${msg.error || '未知错误'}`);
        if (id !== undefined) {
          // 带id的错误：reject对应任务，重置slot.busy
          const task = slot.pending.get(id);
          if (task) {
            slot.pending.delete(id);
            if (!task.canceled) {
              task.reject(new Error(msg.error || 'worker 执行失败'));
            }
          }
          slot.busy = false;
          this.dispatchNext();
        } else if (slot.busy && slot.pending.size > 0) {
          // 全局未捕获异常且slot正忙：reject所有pending任务，重置slot避免卡死
          for (const task of slot.pending.values()) {
            if (!task.canceled) {
              task.reject(new Error(msg.error || 'worker 未捕获异常'));
            }
          }
          slot.pending.clear();
          slot.busy = false;
          this.dispatchNext();
        }
        return;
      }

      if (type === 'parseResult' || type === 'coverResult' || type === 'readChapterResult' || type === 'readImagesResult') {
        const task = slot.pending.get(id);
        if (!task) {
          // 任务不在 pending 中：可能是已取消（从 pending 删除但 worker 仍返回结果），
          // 也可能是未知 id。无论哪种情况，都必须重置 slot.busy 并派发下一个任务，
          // 否则该 worker slot 会永久卡在 busy=true，无法接受新任务（P0-8）。
          if (this.cancelledTasks.has(id)) {
            // 确认是已取消任务：从集合中清理，重置 slot 释放 worker
            this.cancelledTasks.delete(id);
          } else {
            // 收到未知 id 的结果（非取消流程产生），记录日志便于排查
            // 仍需重置 busy 防止 slot 卡死
            console.warn(`[worker-pool] 收到未知任务 id=${id} 的结果，slot 已重置`);
          }
          slot.busy = false;
          this.dispatchNext();
          return;
        }
        slot.pending.delete(id);
        // 清除任务超时定时器
        if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
        // 任务已取消：丢弃结果，不 resolve 也不 reject（Promise 已被 reject）
        if (task.canceled) {
          slot.busy = false;
          this.dispatchNext();
          return;
        }
        if (msg.success) {
          task.resolve(msg.data);
        } else {
          task.reject(new Error(msg.error || 'worker 执行失败'));
        }
        slot.busy = false;
        this.dispatchNext();
      }

      if (type === 'memoryUsage') {
        const heapUsedMb = msg.heapUsed / (1024 * 1024);
        // 只重启空闲且内存超限的 worker（忙碌 worker 正在处理任务，内存使用是预期的）
        if (heapUsedMb > IDLE_WORKER_MEMORY_LIMIT_MB && !slot.busy && slot.pending.size === 0 && !this.terminated) {
          console.warn(
            `[worker-pool] 空闲 worker ${slot.worker.threadId} 内存 ${heapUsedMb.toFixed(0)}MB 超限 ${IDLE_WORKER_MEMORY_LIMIT_MB}MB，重启`
          );
          this.handleWorkerFailure(slot, new Error(`worker 内存超限: ${heapUsedMb.toFixed(0)}MB`), true);
        }
        return;
      }

      // cacheCleared 消息无需特殊处理，只是确认清理完成
      if (type === 'cacheCleared') {
        return;
      }
    });

    worker.on('error', (err) => {
      this.handleWorkerFailure(slot, err);
    });

    worker.on('exit', (code) => {
      if (this.terminated) return;
      if (code !== 0) {
        this.handleWorkerFailure(slot, new Error(`worker 异常退出 code=${code}`));
      }
    });

    return slot;
  }

  /**
   * 处理 worker 故障：reject pending 任务并重建 worker。
   *
   * @param recoverable true 表示恢复性重启（内存超限/任务超时），不计入连续故障，
   *                    立即重建；false 表示真实故障（error / 非 0 退出），
   *                    会累计计数并指数退避后重建，避免"失败→重建→再失败"的
   *                    无限快速重启循环持续占用 CPU。
   */
  private handleWorkerFailure(slot: WorkerSlot, err: unknown, recoverable = false) {
    const e = err instanceof Error ? err : new Error(String(err));
    // reject 该 worker 所有 pending 任务
    for (const task of slot.pending.values()) {
      if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
      task.reject(e);
    }
    slot.pending.clear();
    slot.busy = false;

    // 终止 worker
    try {
      slot.worker.terminate();
    } catch {
      /* ignore */
    }

    const idx = this.workers.indexOf(slot);
    if (idx < 0 || this.terminated) {
      this.dispatchNext();
      return;
    }

    // 恢复性重启：立即重建，不累计故障
    if (recoverable) {
      this.consecutiveFailures = 0;
      this.workers[idx] = this.createWorker();
      this.dispatchNext();
      return;
    }

    // 真实故障：滑动窗口内累计计数，超过窗口则清零
    const now = Date.now();
    if (now - this.lastFailureAt > FAILURE_WINDOW_MS) {
      this.consecutiveFailures = 0;
    }
    this.lastFailureAt = now;
    this.consecutiveFailures++;

    // 指数退避：500ms → 1s → 2s → 4s … 上限 30s
    const delay = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** Math.min(this.consecutiveFailures - 1, 6),
      RESTART_MAX_DELAY_MS
    );
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(
        `[worker-pool] worker 连续故障 ${this.consecutiveFailures} 次，已退避至 ${delay}ms 上限（每次最多重试一次，避免 CPU 空转）: ${e.message}`
      );
    } else {
      console.warn(`[worker-pool] worker 故障（连续第 ${this.consecutiveFailures} 次），${delay}ms 后重建: ${e.message}`);
    }

    // 立即移除故障 slot，避免 dispatchNext 派发到已终止的 worker；延迟后补回
    this.workers.splice(idx, 1);
    setTimeout(() => {
      if (this.terminated) return;
      this.workers.push(this.createWorker());
      this.dispatchNext();
    }, delay);
    this.dispatchNext();
  }

  /**
   * 启动定期内存监控
   *
   * 每 30 秒检查一次空闲 worker 的内存使用，超限则重启。
   * 忙碌 worker 不检查（正在处理任务，内存使用是预期的）。
   */
  private startMemoryMonitoring(): void {
    this.memoryCheckTimer = setInterval(() => this.checkWorkerMemory(), MEMORY_CHECK_INTERVAL_MS);
  }

  /**
   * 检查所有空闲 worker 的内存使用
   *
   * 向每个空闲 worker 发送 getMemoryUsage 消息，worker 回报内存后
   * 在 message handler 中判断是否需要重启。
   */
  private checkWorkerMemory(): void {
    if (this.terminated) return;
    for (const slot of this.workers) {
      // 只检查空闲 worker（忙碌 worker 正在处理任务，内存使用是预期的）
      if (!slot.busy && slot.pending.size === 0) {
        try {
          slot.worker.postMessage({ type: 'getMemoryUsage', id: this.nextId++ });
        } catch {
          /* ignore */
        }
      }
    }
  }

  private getFreeWorker(): WorkerSlot | null {
    for (const slot of this.workers) {
      if (!slot.busy) return slot;
    }
    return null;
  }

  private dispatchNext() {
    while (this.queue.length > 0) {
      const slot = this.getFreeWorker();
      if (!slot) return;
      // 队列已按 priority 升序排列，shift() 取优先级最高的（值最小）
      const job = this.queue.shift()!;
      // 跳过已取消的队列任务
      if (job.canceled) continue;
      slot.busy = true;
      job.run(slot);
    }
  }

  /**
   * 按 filePath 一致性 hash 计算 worker 索引。
   * 同一文件的 parse / cover / readChapter 优先派发到同一 worker，
   * 利用 worker 内部的 PDF/EPUB/MOBI 缓存，避免重复解析。
   */
  private getWorkerIndexForFile(filePath: string): number {
    // 故障退避期间 workers 可能暂时为空，避免除零返回 NaN
    if (this.workers.length === 0) return 0;
    let hash = 0;
    for (let i = 0; i < filePath.length; i++) {
      hash = ((hash << 5) - hash + filePath.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % this.workers.length;
  }

  /**
   * 把一个任务派发给 worker：有空闲 worker 立即执行，否则入队等待。
   * sendMessage 负责向 worker postMessage 注册请求 id。
   *
   * @param priority PRIORITY_READ（阅读，高优先）或 PRIORITY_IMPORT（导入，普通优先）
   * @param preferredWorkerIndex 按文件 hash 计算的 worker 索引，优先使用该 worker（缓存亲和）
   * @param filePath 任务关联的文件路径，用于按文件取消任务（可选）
   */
  private enqueue<T>(
    sendMessage: (slot: WorkerSlot, id: number) => void,
    onProgress?: (p: number) => void,
    priority: number = PRIORITY_IMPORT,
    preferredWorkerIndex?: number,
    filePath?: string,
    timeoutMs?: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const task: PendingTask = { resolve, reject, onProgress, filePath };

      const run = (slot: WorkerSlot) => {
        // 派发前检查是否已被取消
        if (task.canceled) {
          reject(new WorkerTaskCanceledError('任务已取消'));
          slot.busy = false;
          this.dispatchNext();
          return;
        }
        slot.pending.set(id, task);
        // 启动超时定时器：超时后 reject 任务并重置 worker slot
        if (timeoutMs && timeoutMs > 0) {
          task.timeoutTimer = setTimeout(() => {
            const t = slot.pending.get(id);
            if (t) {
              slot.pending.delete(id);
              // 显式 reject 当前超时任务（handleWorkerFailure 只 reject 剩余 pending）
              t.reject(new Error(`worker 任务超时 (${timeoutMs / 1000}s): ${filePath ?? 'unknown'}`));
              slot.busy = false;
              // 超时视为恢复性重启：立即重建卡死的 worker。
              // 恢复性重启不计入连续故障（超时本身受 timeoutMs 限制，不会高频循环）。
              this.handleWorkerFailure(slot, new Error(`worker 任务超时 (${timeoutMs / 1000}s)`), true);
            }
          }, timeoutMs);
        }
        try {
          sendMessage(slot, id);
        } catch (err) {
          if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
          slot.pending.delete(id);
          reject(err as Error);
          slot.busy = false;
          this.dispatchNext();
        }
      };

      // 1) 优先使用亲和 worker（缓存命中）
      if (preferredWorkerIndex !== undefined) {
        const preferred = this.workers[preferredWorkerIndex];
        if (preferred && !preferred.busy) {
          preferred.busy = true;
          run(preferred);
          return;
        }
      }

      // 2) 亲和 worker 忙碌 → 尝试任意空闲 worker（缓存未命中但不等待）
      const slot = this.getFreeWorker();
      if (slot) {
        slot.busy = true;
        run(slot);
      } else {
        // 3) 全部忙碌 → 入队，按 priority 升序插入到正确位置
        const job: QueuedJob = { priority, run, filePath, reject };
        // P1-4修复：用二分查找找到插入位置后 splice 插入（O(n)），
        // 替代每次 push + sort 全排序（O(n log n)），避免大量任务时总复杂度 O(n²log n) 退化
        let lo = 0,
          hi = this.queue.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (this.queue[mid].priority > job.priority) {
            hi = mid;
          } else {
            lo = mid + 1;
          }
        }
        this.queue.splice(lo, 0, job);
        // 队列超限：丢弃最低优先级（最后面的）任务
        while (this.queue.length > MAX_QUEUE_SIZE) {
          const dropped = this.queue.pop()!;
          if (dropped.reject && !dropped.canceled) {
            dropped.reject(new Error('worker 队列已满，任务被丢弃'));
          }
        }
      }
    });
  }

  /**
   * 在 worker 中解析文件，返回 ParsedBook（可序列化，仅含索引和元数据）。
   *
   * 支持两种调用签名（重载）：
   *   旧签名（兼容，默认 fileType='pdf'）：
   *     parseInWorker(filePath, fileName?, onProgress?)
   *   新签名（通用格式）：
   *     parseInWorker(fileType, filePath, fileName?, onProgress?, parseMode?)
   *
   * 运行时通过判断第一个参数是否为已知的 fileType 来区分两种签名。
   */
  parseInWorker(filePath: string, fileName?: string, onProgress?: (p: number) => void): Promise<ParsedBook>;
  parseInWorker(
    fileType: ParserFileType,
    filePath: string,
    fileName?: string,
    onProgress?: (p: number) => void,
    parseMode?: ParseMode
  ): Promise<ParsedBook>;
  parseInWorker(
    fileTypeOrFilePath: string,
    filePathOrFileName?: string,
    fileNameOrOnProgress?: string | ((p: number) => void),
    onProgressOrParseMode?: ((p: number) => void) | ParseMode,
    parseMode?: ParseMode
  ): Promise<ParsedBook> {
    let fileType: ParserFileType;
    let filePath: string;
    let fileName: string | undefined;
    let onProgress: ((p: number) => void) | undefined;
    let mode: ParseMode | undefined;

    if (FILE_TYPES.has(fileTypeOrFilePath)) {
      // 新签名: parseInWorker(fileType, filePath, fileName?, onProgress?, parseMode?)
      fileType = fileTypeOrFilePath as ParserFileType;
      filePath = filePathOrFileName!;
      if (typeof fileNameOrOnProgress === 'string') {
        fileName = fileNameOrOnProgress;
        onProgress = typeof onProgressOrParseMode === 'function' ? onProgressOrParseMode : undefined;
      } else {
        fileName = undefined;
        onProgress =
          typeof fileNameOrOnProgress === 'function'
            ? fileNameOrOnProgress
            : typeof onProgressOrParseMode === 'function'
              ? onProgressOrParseMode
              : undefined;
      }
      mode =
        parseMode ?? (typeof onProgressOrParseMode === 'string' ? (onProgressOrParseMode as ParseMode) : undefined);
    } else {
      // 旧签名（兼容）: parseInWorker(filePath, fileName?, onProgress?)  默认 fileType='pdf'
      fileType = 'pdf';
      filePath = fileTypeOrFilePath;
      if (typeof filePathOrFileName === 'string') {
        fileName = filePathOrFileName;
        onProgress = typeof fileNameOrOnProgress === 'function' ? fileNameOrOnProgress : undefined;
      } else {
        fileName = undefined;
        onProgress =
          typeof filePathOrFileName === 'function'
            ? filePathOrFileName
            : typeof fileNameOrOnProgress === 'function'
              ? (fileNameOrOnProgress as (p: number) => void)
              : undefined;
      }
    }

    return this.enqueue<ParsedBook>(
      (slot, id) =>
        slot.worker.postMessage({
          type: 'parse',
          id,
          fileType,
          filePath,
          fileName,
          parseMode: mode
        }),
      onProgress,
      PRIORITY_IMPORT,
      this.getWorkerIndexForFile(filePath),
      filePath,
      180_000 // 导入解析超时 180 秒（大 PDF 可能需要较长时间）
    );
  }

  /**
   * 在 worker 中提取封面，返回封面图片路径或 null。
   *
   * 支持两种调用签名（重载）：
   *   旧签名（兼容，默认 fileType='pdf'）：
   *     extractCoverInWorker(filePath, destPath)
   *   新签名（通用格式）：
   *     extractCoverInWorker(fileType, filePath, destPath)
   */
  extractCoverInWorker(filePath: string, destPath: string): Promise<string | null>;
  extractCoverInWorker(fileType: ParserFileType, filePath: string, destPath: string): Promise<string | null>;
  extractCoverInWorker(
    fileTypeOrFilePath: string,
    filePathOrDestPath?: string,
    destPath?: string
  ): Promise<string | null> {
    let fileType: ParserFileType;
    let filePath: string;
    let dest: string;

    if (FILE_TYPES.has(fileTypeOrFilePath)) {
      // 新签名: extractCoverInWorker(fileType, filePath, destPath)
      fileType = fileTypeOrFilePath as ParserFileType;
      filePath = filePathOrDestPath!;
      dest = destPath!;
    } else {
      // 旧签名（兼容）: extractCoverInWorker(filePath, destPath)  默认 fileType='pdf'
      fileType = 'pdf';
      filePath = fileTypeOrFilePath;
      dest = filePathOrDestPath!;
    }

    return this.enqueue<string | null>(
      (slot, id) => slot.worker.postMessage({ type: 'cover', id, fileType, filePath, destPath: dest }),
      undefined,
      PRIORITY_IMPORT,
      this.getWorkerIndexForFile(filePath)
    );
  }

  /**
   * 在 worker 中读取章节内容（缓存 miss 时在 worker 内重解析，不阻塞主线程）。
   *
   * 支持 PDF/MOBI/EPUB 三种格式：
   *   - PDF:  readPdfChapter(filePath, chapter, imageDir?, allowScreenshotFallback?)
   *   - MOBI: readMobiChapter(filePath, chapter, imageDir?)
   *   - EPUB: readEpubChapter(filePath, chapter, imageDir?)
   *
   * TXT 按字节偏移读取很轻量，保持主线程执行不走 worker。
   */
  readChapterInWorker(
    fileType: ParserFileType,
    filePath: string,
    chapter: ChapterIndex,
    imageDir?: string | null,
    allowScreenshotFallback?: boolean
  ): Promise<string> {
    return this.enqueue<string>(
      (slot, id) =>
        slot.worker.postMessage({
          type: 'readChapter',
          id,
          fileType,
          filePath,
          chapter,
          imageDir,
          allowScreenshotFallback
        }),
      undefined,
      PRIORITY_READ, // 阅读请求高优先，批量导入时不排队
      this.getWorkerIndexForFile(filePath), // 亲和同一 worker，利用缓存
      filePath, // 用于按文件取消任务
      60_000 // 阅读章节超时 60 秒
    );
  }

  /**
   * 在 worker 中读取 PDF 章节图片，返回 ChapterImage[]（含 pending 占位条目）。
   *
   * A1修复：readPdfChapterImages 的 scale 2.0 整页渲染 + sharp WebP 压缩是
   * CPU 密集操作，此前在主进程主线程执行会阻塞事件循环（切章卡死根因），
   * 与 readChapter 同构挪进 worker 分发。仅 PDF 走此路径；EPUB/MOBI/CBZ 的
   * readXxxChapterImages 是原文件解压提取（轻 IO），保留主线程执行。
   *
   * 池繁忙时不回退主线程（与 readChapter 行为一致）：按 PRIORITY_READ 排队，
   * readImages 渲染本身可被取消/超时保护，回退主线程反而重新引入卡死。
   *
   * @param filePath PDF 文件路径
   * @param chapter 章节索引（url 字段存页码或页区间）
   * @param imageDir 图片保存目录（绝对路径）
   * @param initialPages 首批渲染页数（v53 分批渐进加载；缺省全量渲染）
   * @param desiredWidth 目标渲染像素宽（A3修复：前端上报容器宽×DPR，透传给
   *        pdf-parse 换算 scale 根治 HiDPI 模糊；缺省 scale 2 兜底）
   */
  readImagesInWorker(
    filePath: string,
    chapter: ChapterIndex,
    imageDir: string,
    initialPages?: number,
    desiredWidth?: number
  ): Promise<ChapterImage[]> {
    return this.enqueue<ChapterImage[]>(
      (slot, id) =>
        slot.worker.postMessage({
          type: 'readImages',
          id,
          filePath,
          chapter,
          imageDir,
          initialPages,
          desiredWidth
        }),
      undefined,
      PRIORITY_READ, // 阅读请求高优先，批量导入时不排队
      this.getWorkerIndexForFile(filePath), // 亲和同一 worker，复用已缓存的 PDF parser
      filePath, // 用于按文件取消任务
      120_000 // 超时 120 秒：首批 initialPages 通常几页秒级完成；全量兜底渲染上限 PDF_CHAPTER_MAX_PAGES=50 页，取 read(60s) 与 parse(180s) 之间
    );
  }

  /**
   * 在 worker 中续载 PDF 章节图片（幂等，v53 分批渐进加载），返回完整列表。
   *
   * A1修复：续载（用户滚动到 pending 页附近触发）与首次读取走同一条
   * renderPdfChapterImages 渲染链路，同样必须进 worker，否则渐进加载的
   * 后续批次仍会阻塞主进程。协议复用 readImages 消息（pages 字段区分），
   * 响应同为 readImagesResult。
   *
   * @param filePath PDF 文件路径
   * @param chapter 章节索引（url 字段存页码或页区间）
   * @param imageDir 图片保存目录（绝对路径）
   * @param pages 请求续载的槽位列表（1-based，前端 comicImages 下标 + 1）
   * @param desiredWidth 目标渲染像素宽（A3修复：与首批渲染同源，续载页分辨率口径一致）
   */
  ensureImagesInWorker(
    filePath: string,
    chapter: ChapterIndex,
    imageDir: string,
    pages: number[],
    desiredWidth?: number
  ): Promise<ChapterImage[]> {
    return this.enqueue<ChapterImage[]>(
      (slot, id) =>
        slot.worker.postMessage({
          type: 'readImages',
          id,
          filePath,
          chapter,
          imageDir,
          pages,
          desiredWidth
        }),
      undefined,
      PRIORITY_READ,
      this.getWorkerIndexForFile(filePath),
      filePath,
      120_000 // 超时 120 秒，理由同 readImagesInWorker
    );
  }

  /**
   * 取消指定文件路径关联的所有任务（pending + queued）。
   *
   * 用于切换书时取消旧书的章节读取任务，避免旧任务继续占用 worker CPU，
   * 也避免旧任务完成后覆盖新书的数据。
   *
   * 注意：已经在 worker 中执行的任务无法直接中断（worker_threads 不支持），
   * 但会在结果返回时丢弃（task.canceled = true）。
   *
   * @param filePath 文件路径，匹配 enqueue 时传入的 filePath
   */
  cancelTasksByFilePath(filePath: string): void {
    if (!filePath) return;

    // 1. 取消所有 worker 中 pending 的任务
    for (const slot of this.workers) {
      for (const [id, task] of slot.pending) {
        if (task.filePath === filePath) {
          task.canceled = true;
          // P1-8 修复：不再清除超时定时器。
          // 原代码 clearTimeout(task.timeoutTimer) 后，若 worker 仍卡在处理中，
          // 该任务既不会被取消 reject 触发重置，也不会被超时定时器保护重启 worker，
          // 导致 worker slot 永久 busy=true 卡死。保留超时定时器，让原有超时机制
          // 继续保护：worker 真正卡死时超时回调仍会触发 reject + 重启 worker。
          // 立即 reject，让调用方知道任务已取消
          task.reject(new WorkerTaskCanceledError(`任务已取消: ${filePath}`));
          slot.pending.delete(id);
          // 记录到 cancelledTasks 集合：message handler 收到该 id 的结果时，
          // 据此正确重置 slot.busy 并清理集合，避免 worker slot 永久卡死（P0-8）
          this.cancelledTasks.add(id);
        }
      }
    }

    // 2. 取消队列中等待派发的任务
    for (const job of this.queue) {
      if (job.filePath === filePath) {
        job.canceled = true;
      }
    }
  }

  /**
   * 通知 worker 清理内部缓存。
   *
   * Worker 内部会缓存已解析的 PDF/EPUB/MOBI 文档对象，避免重复解析。
   * 但这会导致内存占用持续增长，特别是切换书后旧书的文档对象仍驻留内存。
   *
   * - 指定 filePath：通知对应 worker 清理该文件的缓存
   * - 不指定 filePath：通知所有 worker 清理所有缓存
   *
   * 注意：worker 需要支持 'clearCache' 消息类型才会生效，否则消息被忽略。
   *
   * @param filePath 可选，指定清理哪个文件的缓存
   */
  clearWorkerCache(filePath?: string): void {
    if (filePath) {
      // 清理指定文件的缓存：派发到亲和 worker
      const workerIndex = this.getWorkerIndexForFile(filePath);
      const slot = this.workers[workerIndex];
      if (slot) {
        try {
          slot.worker.postMessage({ type: 'clearCache', filePath });
        } catch {
          /* ignore */
        }
      }
    } else {
      // 清理所有 worker 的缓存
      for (const slot of this.workers) {
        try {
          slot.worker.postMessage({ type: 'clearCache' });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 关闭所有 worker（应用退出时调用） */
  shutdownAllWorkers(): void {
    this.terminated = true;
    if (this.memoryCheckTimer) {
      clearInterval(this.memoryCheckTimer);
      this.memoryCheckTimer = null;
    }
    for (const slot of this.workers) {
      try {
        slot.worker.terminate();
      } catch {
        /* ignore */
      }
    }
    this.workers = [];
    this.queue = [];
    // 清理已取消任务集合，释放内存
    this.cancelledTasks.clear();
  }
}

export const pdfWorkerPool = new PdfWorkerPool();
