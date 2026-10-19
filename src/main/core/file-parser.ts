/**
 * 文件解析器 barrel re-export
 *
 * 本文件原为 10317 行的合并文件，现已拆分到 ./parsers/ 子目录：
 * - parsers/types.ts（共享类型和接口）
 * - parsers/chapter-patterns.ts（章节标题正则模式）
 * - parsers/format-detector.ts（格式检测器）
 * - parsers/txt-parser.ts（TXT 解析器）
 * - parsers/epub-parser.ts（EPUB 解析器）
 * - parsers/mobi-parser.ts（MOBI 解析器）
 * - parsers/pdf-parser.ts（PDF 解析器）
 * - parsers/comic-parser.ts（漫画解析器）
 *
 * 所有原有 export 都可通过 `from './file-parser'` 访问，无需修改现有 import。
 */

export * from './parsers/types';
export * from './parsers/chapter-patterns';
export * from './parsers/format-detector';
export * from './parsers/txt-parser';
export * from './parsers/epub-parser';
export * from './parsers/mobi-parser';
export * from './parsers/pdf-parser';
export * from './parsers/comic-parser';
