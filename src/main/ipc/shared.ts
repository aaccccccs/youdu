/**
 * IPC 共享工具和类型
 *
 * 包含：
 * - IPC_CHANNELS / IpcChannel：IPC 通道常量与类型
 * - wrapHandler：IPC handler 异常包裹高阶函数
 * - isPathSafe：路径安全校验
 * - assertPositiveInt / assertNonEmptyString / assertPositiveIntArray：参数校验
 * - isValidImportPath：导入路径校验
 */
import type { IpcMainInvokeEvent } from 'electron';
import { resolve, sep } from 'path';

import { getUserDataRoot, getBooksRoot, getCoversRoot } from '../utils';

// 从 shared.ts 导入 IPC 通道常量（主进程与 preload 共享，实现编译时校验）
import { IPC_CHANNELS as SHARED_IPC_CHANNELS } from '../../shared';

/* ==================== IPC Channel 常量定义 ==================== */
// IPC_CHANNELS 已移至 src/shared.ts，供主进程和 preload 共享，实现编译时校验

export const IPC_CHANNELS = SHARED_IPC_CHANNELS;
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/* ==================== 通用 wrapHandler ==================== */

/**
 * 高阶函数：包裹 IPC handler，捕获异常并转换为可序列化的 Error
 *
 * - 同步 handler：try-catch 捕获后抛出
 * - 异步 handler：返回 Promise，reject 时会被 ipcMain 自动转发到渲染进程
 * - 错误信息提取 message 字段，避免抛出带不可序列化属性的对象
 */
export function wrapHandler<T>(
  handler: (e: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>
): (e: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T> {
  return async (e, ...args) => {
    try {
      return await handler(e, ...args);
    } catch (err) {
      console.error('[IPC] handler error:', err);
      const message = typeof err === 'object' && err && 'message' in err ? String((err as Error).message) : '内部错误';
      throw new Error(message);
    }
  };
}

/** 路径安全校验：确保文件路径在允许的目录内，防止路径遍历攻击 */
export function isPathSafe(filePath: string): boolean {
  const resolved = resolve(filePath);
  const booksDir = resolve(getBooksRoot());
  const coversDir = resolve(getCoversRoot());
  const userDataDir = resolve(getUserDataRoot());
  return (
    resolved === booksDir ||
    resolved.startsWith(booksDir + sep) ||
    resolved === coversDir ||
    resolved.startsWith(coversDir + sep) ||
    resolved === userDataDir ||
    resolved.startsWith(userDataDir + sep)
  );
}

/** 参数校验工具 */
export function assertPositiveInt(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`无效的 ${name}：必须为正整数`);
  }
}

/**
 * 断言非空字符串（类型收窄：通过后 value 收窄为 string）
 */
export function assertNonEmptyString(value: unknown, name: string, maxLen?: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`无效的 ${name}：必须为非空字符串`);
  }
  if (maxLen && value.length > maxLen) {
    throw new Error(`${name} 过长（超过 ${maxLen} 字）`);
  }
}

export function assertPositiveIntArray(value: unknown, name: string, maxLen?: number): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`无效的 ${name}：必须为非空数组`);
  }
  if (maxLen && value.length > maxLen) {
    throw new Error(`${name} 过长（超过 ${maxLen} 个元素）`);
  }
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new Error(`无效的 ${name}：所有元素必须为正整数`);
    }
  }
}

/**
 * 校验导入路径安全性：防 null byte injection 和空路径
 *
 * importFiles/importDirectory 的源路径由 Electron 文件选择器返回（可信），
 * 但 IPC 可被恶意渲染进程调用，仍需校验。不限制合法路径（中文、空格、
 * 任意目录均允许），只拒绝 null byte（防文件系统行为异常）和空字符串。
 *
 * @param p 待校验路径
 * @returns 是否为合法的导入路径
 */
export function isValidImportPath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && !p.includes('\0');
}
