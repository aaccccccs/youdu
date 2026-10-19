/**
 * IPC 模块入口（barrel re-export + registerAllIpc）
 *
 * 原本单文件 ipc.ts 已按 IPC 域拆分到 ./ipc/ 子目录：
 * - shared.ts：IPC 通道常量、wrapHandler、参数校验工具
 * - window.ts：窗口控制 IPC
 * - app.ts：应用信息 IPC
 * - shell.ts：Shell IPC（打开外部链接）
 * - book.ts：书籍阅读 IPC
 * - db.ts：数据库 CRUD IPC
 * - export.ts：数据导出 IPC（TXT/EPUB/CBZ）
 * - import.ts：文件导入 IPC
 * - replace-rule.ts：内容替换规则 IPC
 * - subscription.ts：订阅源 IPC
 * - opds.ts：OPDS 书库浏览 IPC
 * - network.ts：网络配置 IPC
 *
 * 本文件保留 registerAllIpc（聚合所有 register 函数），并 barrel re-export 各子模块的 public API，
 * 使现有的 `from './ipc'` 引用无需修改。
 */
import type { BrowserWindow } from 'electron';

import { registerWindowIpc } from './ipc/window';
import { registerAppIpc } from './ipc/app';
import { registerShellIpc } from './ipc/shell';
import { registerDbIpc } from './ipc/db';
import { registerExportIpc } from './ipc/export';
import { registerImportIpc } from './ipc/import';
import { registerBookIpc } from './ipc/book';
import { registerReplaceRuleIpc } from './ipc/replace-rule';
import { registerSubscriptionIpc } from './ipc/subscription';
import { registerOpdsIpc } from './ipc/opds';
import { registerNetworkIpc } from './ipc/network';


// barrel re-export：保持 `from './ipc'` 的现有引用不变
export * from './ipc/shared';
export * from './ipc/window';
export * from './ipc/app';
export * from './ipc/shell';
export * from './ipc/book';
export * from './ipc/db';
export * from './ipc/export';
export * from './ipc/import';
export * from './ipc/replace-rule';
export * from './ipc/subscription';
export * from './ipc/opds';
export * from './ipc/network';


/** 注册全部 IPC handler */
export function registerAllIpc(getMainWindow: () => BrowserWindow | null): void {
  registerWindowIpc(getMainWindow);
  registerAppIpc();
  registerShellIpc();
  registerDbIpc();
  registerExportIpc(getMainWindow);
  registerImportIpc(getMainWindow);
  registerBookIpc();

  // v18 新增：内容替换规则 IPC
  registerReplaceRuleIpc();
  // v11 新增：订阅源 IPC（用 try-catch 保护，失败不阻止应用启动）
  try {
    registerSubscriptionIpc();
  } catch (err) {
    console.error('[ipc] 订阅 IPC 注册失败，应用将继续启动:', err);
  }
  // v19 新增：OPDS 书库浏览 IPC
  try {
    registerOpdsIpc();
  } catch (err) {
    console.error('[ipc] OPDS IPC 注册失败，应用将继续启动:', err);
  }
  // v20 新增：网络配置 IPC
  try {
    registerNetworkIpc();
  } catch (err) {
    console.error('[ipc] 网络配置 IPC 注册失败，应用将继续启动:', err);
  }

}
