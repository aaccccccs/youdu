/**
 * 窗口控制 IPC
 *
 * 关闭流程（根因②：点 X 关窗口进度丢失修复）：
 * 用户点关闭 → WINDOW_CLOSE → win.close() → close 事件拦截（preventDefault）
 * → send WINDOW_BEFORE_CLOSE_FLUSH → 渲染端保存阅读进度 → invoke
 * WINDOW_CLOSE_FLUSH_DONE 回执 → 主进程 destroy() → window-all-closed
 * → app.quit() → before-quit 清理资源
 */
import { ipcMain, BrowserWindow } from 'electron';

import { IPC_CHANNELS, wrapHandler } from './shared';
import { notifyCloseFlushDone } from '../close-flush';

/** 注册窗口控制相关 IPC handler */
export function registerWindowIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    IPC_CHANNELS.WINDOW_CLOSE,
    wrapHandler(() => {
      const win = getMainWindow();
      win?.close();
    })
  );

  // 根因②：渲染端关闭前进度 flush 完成回执（close 事件拦截后主进程等待此回执再销毁窗口）
  ipcMain.handle(
    IPC_CHANNELS.WINDOW_CLOSE_FLUSH_DONE,
    wrapHandler(() => {
      notifyCloseFlushDone();
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_MAXIMIZE,
    wrapHandler(() => {
      const win = getMainWindow();
      win?.maximize();
    })
  );

  // 标题栏最小化（用户实测"最小化不能用"修复）：通道在 shared/preload 一直存在，
  // 但主进程 handler 缺失——invoke('window:minimize') 抛 "No handler registered"，
  // TitleBar 按钮点击无效。补注册（与 WINDOW_MAXIMIZE 同款模式）。
  ipcMain.handle(
    IPC_CHANNELS.WINDOW_MINIMIZE,
    wrapHandler(() => {
      const win = getMainWindow();
      win?.minimize();
    })
  );

  ipcMain.handle(

    IPC_CHANNELS.WINDOW_IS_MAXIMIZED,
    wrapHandler(() => {
      const win = getMainWindow();
      return win ? win.isMaximized() : false;
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_TOGGLE_MAXIMIZE,
    wrapHandler(() => {
      const win = getMainWindow();
      if (!win) return false;
      if (win.isMaximized()) {
        win.unmaximize();
        return false;
      } else {
        win.maximize();
        return true;
      }
    })
  );


  ipcMain.handle(
    IPC_CHANNELS.WINDOW_TOGGLE_FULLSCREEN,
    wrapHandler(() => {
      const win = getMainWindow();
      if (!win) return false;
      win.setFullScreen(!win.isFullScreen());
      return win.isFullScreen();
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_IS_FULLSCREEN,
    wrapHandler(() => {
      const win = getMainWindow();
      return win ? win.isFullScreen() : false;
    })
  );
}

/**
 * 监听窗口最大化状态变化，主动推送给渲染进程
 *
 * 必须在 BrowserWindow 创建完成后调用，否则监听器无法注册。
 * 从 registerWindowIpc 中拆出，避免在窗口创建前调用导致监听器丢失。
 */
export function registerMaximizeListener(win: BrowserWindow): void {
  win.on('maximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WINDOW_MAXIMIZE_CHANGED, true);
    }
  });
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WINDOW_MAXIMIZE_CHANGED, false);
    }
  });
  win.on('enter-full-screen', () => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, true);
    }
  });
  win.on('leave-full-screen', () => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WINDOW_FULLSCREEN_CHANGED, false);
    }
  });
}
