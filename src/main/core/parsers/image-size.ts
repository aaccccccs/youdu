/**
 * 图片尺寸读取（零依赖，只读文件头，不解码像素）
 *
 * 用途：图片型阅读器（ComicViewer）的精确占位 —— 主流阅读器（PDF.js/Preview/
 * Mihon）都在像素加载前就知道每页的 width/height，占位高度用真实宽高比计算，
 * 滚动条稳定、进度准确、懒加载预判可靠。我们此前用 min-height:100vh 固定占位
 * （真实页 1190×1316 在 1200px 容器下高≈1327px，占位低估 2 倍），导致滚动
 * 跳动与进度失真。
 *
 * 支持：PNG（IHDR 固定偏移）与 JPEG（扫描 SOF0/1/2/C2 marker）。
 * 失败返回 null（调用方回退到 100vh 估计占位）。
 */
import { openSync, readSync, closeSync, statSync } from 'fs';

export interface ImageSize {
  width: number;
  height: number;
}

/** 读文件头部（最多 128KB，覆盖 JPEG SOF marker 的实际分布） */
function readHead(path: string, maxBytes = 128 * 1024): Buffer | null {
  try {
    const size = statSync(path).size;
    if (size <= 0) return null;
    const fd = openSync(path, 'r');
    try {
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      const read = readSync(fd, buf, 0, len, 0);
      return read > 0 ? buf.subarray(0, read) : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** 解析 PNG 尺寸：字节签名 89 50 4E 47，IHDR 固定在偏移 16（宽）20（高），big-endian */
function parsePng(buf: Buffer): ImageSize | null {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** 解析 JPEG 尺寸：扫描 SOF0/1/2/C2 marker（跳过压缩数据段），取段内高/宽 */
function parseJpeg(buf: Buffer): ImageSize | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // SOF0(标准)/SOF1/SOF2(渐进)/SOF3/C2(渐进) —— 高在前宽在后
    if (marker >= 0xc0 && marker <= 0xc3 && marker !== 0xc4 && marker !== 0xc8) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    // 其他 marker：跳过其段（段长含自身 2 字节）
    if (i + 3 >= buf.length) return null;
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen <= 0) return null;
    i += 2 + segLen;
  }
  return null;
}

/** 解析 WebP 尺寸：RIFF/WEBP 容器，按首个 chunk 分发 VP8X/VP8/VP8L
 *  （v50 图片阅读器路径改用 sharp 落盘 WebP，压缩体积约为 PNG 的 11%） */
function parseWebp(buf: Buffer): ImageSize | null {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    // 扩展格式：canvas 尺寸以 24bit LE 存储（值-1），位于 payload offset 4-9
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    if (width > 0 && height > 0) return { width, height };
    return null;
  }
  if (chunk === 'VP8 ') {
    // 有损 simple：payload = frame tag(3B) + sync 0x9D012A(3B) + width(2B LE) + height(2B LE)
    const width = buf.readUInt16LE(26);
    const height = buf.readUInt16LE(28);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }
  if (chunk === 'VP8L') {
    // 无损：payload 首字节 0x2F，随后 4 字节位流：width-1(14bit) | height-1(14bit)（低位在前）
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (width > 0 && height > 0) return { width, height };
    return null;
  }
  return null;
}

/** 读取图片尺寸（PNG/JPEG/WebP 文件头解析）。失败返回 null。 */
export function readImageSize(path: string): ImageSize | null {
  const buf = readHead(path, 128 * 1024);
  if (!buf) return null;
  return parsePng(buf) ?? parseJpeg(buf) ?? parseWebp(buf);
}