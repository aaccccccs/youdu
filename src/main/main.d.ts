/**
 * 主进程类型声明
 *
 * 声明 vite ?raw 导入和第三方库的类型。
 */

/** vite ?raw 导入：以字符串形式读取文件内容 */
declare module '*?raw' {
  const content: string;
  export default content;
}

/** epub-gen 库（无官方类型声明） */
declare module 'epub-gen' {
  interface EpubGenOptions {
    title?: string;
    author?: string;
    publisher?: string;
    cover?: string;
    content?: Array<{ title?: string; data: string }>;
    verbose?: boolean;
    appendChapterTitles?: boolean;
    [key: string]: unknown;
  }
  export default class EpubGen {
    constructor(options: EpubGenOptions, output?: string);
    promise: Promise<unknown>;
  }
}
