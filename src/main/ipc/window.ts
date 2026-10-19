/**
 * 窗口控制 IPC
 *
 * 关闭流程：用户点关闭 → WINDOW_CLOSE → win.close() → close 事件保存窗口状态并放行
 * → window-all-closed → app.quit() → before-quit 清理资源
 */
import { ipcMain, BrowserWindow, app } from 'electron';

import { IPC_CHANNELS, wrapHandler } from './shared';

/** 注册窗口控制相关 IPC handler */
export function registerWindowIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    IPC_CHANNELS.WINDOW_MINIMIZE,
    wrapHandler(() => {
      const win = getMainWindow();
      win?.minimize();
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_MAXIMIZE,
    wrapHandler(() => {
      const win = getMainWindow();
      win?.maximize();
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_UNMAXIMIZE,
    wrapHandler(() => {
      const win = getMainWindow();
      win?.unmaximize();
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.WINDOW_CLOSE,
    wrapHandler(() => {
      const win = getMainWindow();
      win?.close();
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

  // 强制退出（渲染层主动调用，如设置页"退出"按钮）
  ipcMain.handle(
    IPC_CHANNELS.WINDOW_FORCE_QUIT,
    wrapHandler(() => {
      app.quit();
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
