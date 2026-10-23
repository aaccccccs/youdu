/**
 * 窗口关闭前的阅读进度 flush 协调（根因②：点 X 关窗口进度丢失）
 *
 * 背景：主进程不拦截关闭时，用户点 X = 渲染进程直接销毁，最后未 debounce
 * 落库的阅读位置（滚动停止后 PROGRESS_DEBOUNCE_MS 内）与阅读会话统计全部丢失。
 *
 * 协议（三段）：
 * 1. 主进程 close 事件拦截（window.ts，preventDefault）或 before-quit（index.ts）
 *    → webContents.send(WINDOW_BEFORE_CLOSE_FLUSH)
 * 2. 渲染端（App.vue 注册 onBeforeCloseFlush）用 reader store 缓存值立即保存进度
 *    → ipcRenderer.invoke(WINDOW_CLOSE_FLUSH_DONE) 回执
 * 3. 主进程收到回执 resolve 等待；超过 CLOSE_FLUSH_TIMEOUT_MS 强制 resolve
 *    （渲染端无响应/未注册监听/已崩溃时不能卡住关窗）
 *
 * 独立模块原因：window.ts（close 事件）与 ipc/window.ts（回执 handler）都需要
 * 访问同一等待状态，从两者任一方互相导入都会形成模块循环依赖。
 */
import { BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '../shared';

/**
 * 渲染端进度 flush 的最长等待时间（ms）。
 * 链路预算：渲染端同步读 store 缓存值 + 一次 IPC 写 DB（SQLite 本地写 <50ms），
 * 800ms 留有充分余量；超时强制放行，保证关窗不卡顿。
 */
export const CLOSE_FLUSH_TIMEOUT_MS = 800;

/** 当前 flush 等待的 resolver（收到渲染端回执时调用；null 表示无在途等待） */
let closeFlushResolve: (() => void) | null = null;

/** 当前 flush 的超时定时器（回执先到时清除，避免泄漏） */
let closeFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 通知渲染端在窗口关闭前 flush 阅读进度，等待回执或超时后 resolve。
 *
 * 幂等性：并发调用（close 拦截 + before-quit 同时发生）时后调用者覆盖
 * 前者的 resolver，前者由自身的超时定时器兜底 resolve，两者均不会悬挂。
 */
export function requestRendererFlush(win: BrowserWindow): Promise<void> {
  return new Promise<void>((resolve) => {
    closeFlushResolve = resolve;
    try {
      win.webContents.send(IPC_CHANNELS.WINDOW_BEFORE_CLOSE_FLUSH);
    } catch (err) {
      // 渲染进程已崩溃/正在销毁：无可保存进度，立即放行
      console.warn('[close-flush] 发送关闭前 flush 通知失败:', err);
      resolve();
      return;
    }
    closeFlushTimer = setTimeout(() => {
      console.warn('[close-flush] 渲染端进度 flush 超时，继续关闭流程');
      resolve();
    }, CLOSE_FLUSH_TIMEOUT_MS);
  }).finally(() => {
    if (closeFlushTimer !== null) {
      clearTimeout(closeFlushTimer);
      closeFlushTimer = null;
    }
    closeFlushResolve = null;
  });
}

/**
 * 渲染端进度 flush 完成回执（ipc/window.ts 的 WINDOW_CLOSE_FLUSH_DONE
 * handler 调用），提前结束等待，避免固定等待 800ms 拖慢关窗。
 */
export function notifyCloseFlushDone(): void {
  if (closeFlushResolve) closeFlushResolve();
}