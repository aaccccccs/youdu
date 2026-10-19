/**
 * 格式检测器
 *
 * 从 file-parser.ts 拆分而来。
 */

import { promises as fsPromises } from 'fs';
import { extname } from 'path';
import type { DetectedFormat } from './types';

/* ==================== format-detector.ts（格式检测器） ==================== */
/**
 * 万能格式检测器
 *
 * 通过扩展名 + 文件头（magic number）双重检测文件实际格式。
 * 不依赖扩展名，直接读取文件前几个字节判断格式。
 *
 * 支持检测的格式：
 * - ZIP/CBZ: PK\x03\x04
 * - RAR/CBR: Rar!\x1a\x07
 * - 7z/CB7: 7z\xbc\xaf\x27\x1c
 * - PDF: %PDF
 * - EPUB: ZIP + META-INF/container.xml
 * - MOBI: BOOKMOBI (偏移60)
 * - Tar/CBT: ustar (偏移257)
 * - TXT: 无 magic number，UTF-8/GBK/Big5 检测
 * - 图片: PNG/JPG/GIF/WebP/BMP
 *
 * 导出：
 * - detectFormat(filePath): Promise<DetectedFormat>
 * - detectFormatByExt(filePath): DetectedFormat | null
 * - detectFormatByMagicNumber(filePath): Promise<string | null>
 */

/** 扩展名 → 格式映射 */
const EXT_TO_FORMAT: Record<string, DetectedFormat> = {
  '.txt': 'txt',
  '.md': 'txt', // Markdown 按 TXT 处理（detectParseMode 会识别为 markdown 模式）
  '.markdown': 'txt', // Markdown 变体扩展名
  '.epub': 'epub',
  '.mobi': 'mobi',
  '.mb': 'mobi', // .mb 是 Mobipocket 旧格式，与 .mobi 兼容
  '.azw': 'mobi', // Amazon Kindle 格式
  '.azw3': 'mobi', // Kindle KF8
  '.azw4': 'mobi', // Kindle KF8 变体
  '.prc': 'mobi', // PalmDOC/Mobipocket PRC 格式
  '.pdf': 'pdf',
  '.cbz': 'cbz',
  '.cbr': 'cbr',
  '.cb7': 'cb7',
  '.cbt': 'cbt',
  '.zip': 'zip',
  '.rar': 'rar',
  '.7z': '7z',
  '.tar': 'tar',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image'
};

/**
 * 通过扩展名检测格式
 *
 * @param filePath 文件路径
 * @returns 格式类型，不支持的扩展名返回 null
 */
export function detectFormatByExt(filePath: string): DetectedFormat | null {
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_FORMAT[ext] ?? null;
}

/**
 * 通过文件头（magic number）检测文件实际格式
 *
 * Magic numbers：
 * - ZIP/CBZ/EPUB: PK\x03\x04 (0x504B0304)
 * - RAR/CBR: Rar!\x1a\x07 (0x526172211A07)
 * - 7z/CB7: 7z\xbc\xaf\x27\x1c
 * - PDF: %PDF (0x25504446)
 * - MOBI: BOOKMOBI (偏移60处)
 * - Tar/CBT: ustar (偏移257处)
 * - PNG: \x89PNG
 * - JPG: \xFF\xD8\xFF
 * - GIF: GIF87a/GIF89a
 * - WebP: RIFF....WEBP
 * - BMP: BM
 *
 * @param filePath 文件路径
 * @returns 检测到的格式名称，无法识别返回 null
 */
export async function detectFormatByMagicNumber(filePath: string): Promise<string | null> {
  let fd: fsPromises.FileHandle | null = null;
  try {
    fd = await fsPromises.open(filePath, 'r');
    const buf = Buffer.alloc(263); // 足够覆盖 Tar 的 ustar（偏移257+5）
    await fd.read(buf, 0, 263, 0);

    // ZIP/CBZ/EPUB: PK
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      // 进一步检测是否为 EPUB（ZIP 内有 META-INF/container.xml）
      // 这里只返回 'zip'，由上层判断是 CBZ 还是 EPUB
      return 'zip';
    }
    // RAR/CBR: Rar!
    if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) {
      return 'rar';
    }
    // 7z/CB7: 7z\xbc\xaf\x27\x1c
    if (
      buf[0] === 0x37 &&
      buf[1] === 0x7a &&
      buf[2] === 0xbc &&
      buf[3] === 0xaf &&
      buf[4] === 0x27 &&
      buf[5] === 0x1c
    ) {
      return '7z';
    }
    // PDF: %PDF
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
      return 'pdf';
    }
    // PNG: \x89PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return 'png';
    }
    // JPG: \xFF\xD8\xFF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return 'jpg';
    }
    // GIF: GIF87a/GIF89a
    if (
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) &&
      buf[5] === 0x61
    ) {
      return 'gif';
    }
    // BMP: BM
    if (buf[0] === 0x42 && buf[1] === 0x4d) {
      return 'bmp';
    }
    // WebP: RIFF....WEBP
    if (
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    ) {
      return 'webp';
    }
    // MOBI: BOOKMOBI 在偏移60处
    if (buf.length >= 68) {
      const mobiMagic = buf.toString('ascii', 60, 68);
      if (mobiMagic === 'BOOKMOBI') {
        return 'mobi';
      }
    }
    // Tar/CBT: ustar 在偏移257处
    if (buf.length >= 262) {
      const tarMagic = buf.toString('ascii', 257, 262);
      if (tarMagic === 'ustar') {
        return 'tar';
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    if (fd) await fd.close();
  }
}

/**
 * 检测 ZIP 文件是否为 EPUB
 *
 * EPUB 本质是 ZIP，但包含 META-INF/container.xml。
 * 通过检查 ZIP 内是否有此文件来区分 EPUB 和 CBZ/ZIP。
 *
 * @param filePath ZIP 文件路径
 * @returns true=EPUB, false=CBZ/ZIP
 */
export async function isEpubZip(filePath: string): Promise<boolean> {
  try {
    const StreamZip = (await import('node-stream-zip')).default;
    const zip = new StreamZip.async({ file: filePath });
    try {
      const entries = await zip.entries();
      return 'META-INF/container.xml' in entries;
    } finally {
      await zip.close();
    }
  } catch {
    return false;
  }
}

/**
 * 万能格式检测（扩展名 + magic number 双重检测）
 *
 * 检测策略：
 * 1. 先按扩展名检测
 * 2. 再按 magic number 检测
 * 3. 如果两者不一致，以 magic number 为准（扩展名可能被改过）
 * 4. 对于 ZIP 格式，进一步检测是否为 EPUB
 *
 * @param filePath 文件路径
 * @returns 检测到的格式
 */
export async function detectFormat(filePath: string): Promise<DetectedFormat> {
  // 1. 扩展名检测
  const extFormat = detectFormatByExt(filePath);

  // 2. magic number 检测
  const magicFormat = await detectFormatByMagicNumber(filePath);

  // 3. 优先用 magic number（扩展名可能被改过）
  if (magicFormat) {
    // ZIP 可能是 EPUB 或 CBZ
    if (magicFormat === 'zip') {
      if (extFormat === 'epub') {
        return 'epub';
      }
      // 检测 ZIP 内是否有 META-INF/container.xml
      const isEpub = await isEpubZip(filePath);
      return isEpub ? 'epub' : extFormat === 'cbz' ? 'cbz' : 'zip';
    }
    // RAR 可能是 CBR
    if (magicFormat === 'rar') {
      return extFormat === 'cbr' ? 'cbr' : 'rar';
    }
    // 7z 可能是 CB7
    if (magicFormat === '7z') {
      return extFormat === 'cb7' ? 'cb7' : '7z';
    }
    // Tar 可能是 CBT
    if (magicFormat === 'tar') {
      return extFormat === 'cbt' ? 'cbt' : 'tar';
    }
    // PDF/MOBI/图片等直接返回
    if (magicFormat === 'pdf') return 'pdf';
    if (magicFormat === 'mobi') return 'mobi';
    if (['png', 'jpg', 'gif', 'bmp', 'webp'].includes(magicFormat)) return 'image';
  }

  // 4. magic number 无法识别，用扩展名兜底
  if (extFormat) {
    return extFormat;
  }

  // 5. 都无法识别，可能是 TXT
  // P2-13修复：对未知格式输出警告日志，便于排查文件类型识别失败的原因。
  // 原代码静默返回 'unknown'，上层（ipc.ts downloadBookFile）会强制改为 .txt 扩展名，
  // 可能导致二进制文件被当作文本处理而丢失内容。
  console.warn(
    `[detectFormat] 无法识别文件格式: ${filePath}（扩展名: ${extname(filePath) || '无'}，magic number: ${magicFormat || '未识别'}），返回 'unknown'`
  );
  return 'unknown';
}
