/// <reference types="vite/client" />

/**
 * 全局环境类型声明
 *
 * 为 preload bridge 通过 contextBridge.exposeInMainWorld 暴露的 10 个 API
 * 声明 Window 类型，修复渲染进程中 window.xxxApi 的 TS2339/TS2551 错误。
 *
 * 类型来源：src/preload/index.ts 中导出的 const（windowApi/appApi/dbApi/
 * exportApi/importApi/subscriptionApi/shellApi/opdsApi/networkApi/bookshelfApi）
 */
import type * as Preload from '../../preload/index';

declare global {
  interface Window {
    windowApi: typeof Preload.windowApi;
    appApi: typeof Preload.appApi;
    dbApi: typeof Preload.dbApi;
    exportApi: typeof Preload.exportApi;
    importApi: typeof Preload.importApi;
    subscriptionApi: typeof Preload.subscriptionApi;
    shellApi: typeof Preload.shellApi;
    opdsApi: typeof Preload.opdsApi;
    networkApi: typeof Preload.networkApi;
    bookshelfApi: typeof Preload.bookshelfApi;
  }
}

export {};
