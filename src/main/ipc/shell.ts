/**
 * Shell IPC（打开外部链接等）
 */
import { ipcMain, shell } from 'electron';

import { IPC_CHANNELS, wrapHandler } from './shared';

/** 注册 Shell 相关 IPC handler（打开外部链接等） */
export function registerShellIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_EXTERNAL,
    wrapHandler((_e, url: string) => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        throw new Error('Invalid URL');
      }
      return shell.openExternal(url);
    })
  );
}
