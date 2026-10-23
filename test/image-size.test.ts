/**
 * 图片尺寸文件头解析单元测试（v49 精确占位的数据基础）
 *
 * 用真实生成的 PDF 渲染 PNG 与系统 JPEG 资源验证 PNG IHDR / JPEG SOF 解析。
 */
import { describe, it, expect } from 'vitest';
import { readImageSize } from '../src/main/core/parsers/image-size';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const COMIC_DIR = join(
  process.env.HOME ?? '',
  '.local/share/youdu/images/comic'
);

describe('readImageSize 文件头解析', () => {
  it('PNG/WebP：解析渲染页真实尺寸（文件头）', () => {
    const book1049 = join(COMIC_DIR, '1049');
    if (!existsSync(book1049)) return; // 环境无测试数据时跳过
    // v50 起落盘为 .webp，兼容旧数据 .png（按存在优先级取第一个）
    const page1 = ['page_1.png', 'page_1.webp']
      .map((f) => join(book1049, f))
      .find((p) => existsSync(p));
    if (!page1) return;
    const size = readImageSize(page1);
    // 实测该文件为 1190x1316（scale 2 渲染）
    expect(size).not.toBeNull();
    expect(size!.width).toBe(1190);
    expect(size!.height).toBe(1316);
  });

  it('全书各页尺寸一致性（宽高比稳定）', () => {
    const book1049 = join(COMIC_DIR, '1049');
    if (!existsSync(book1049)) return;
    // v50 起落盘为 .webp，兼容旧数据 .png
    const files = readdirSync(book1049).filter((f) => /\.(png|webp)$/.test(f)).slice(0, 5);
    const ratios = new Set<number>();
    for (const f of files) {
      const size = readImageSize(join(book1049, f));
      expect(size).not.toBeNull();
      ratios.add(Math.round((size!.width / size!.height) * 1000));
    }
    // 同一 PDF 渲染的页宽高比应一致（扫描版统一版式）
    expect(ratios.size).toBe(1);
  });

  it('不存在的文件返回 null（不抛异常）', () => {
    expect(readImageSize('/nonexistent/path/page.png')).toBeNull();
  });

  it('非图片文件返回 null', () => {
    // 用自身的 ts 源文件（文本）测试
    expect(readImageSize(join(process.cwd(), 'src/main/core/parsers/image-size.ts'))).toBeNull();
  });

  it('WebP：sharp 生成的真实文件头解析（v50 图片阅读器落盘格式）', async () => {
    // 用 sharp 生成一张已知尺寸的 WebP（与主进程 readPdfChapterImages 同路径）
    const sharp = (await import('sharp')).default;
    const buf = await sharp({
      create: { width: 1190, height: 1316, channels: 3, background: '#888888' }
    })
      .webp({ quality: 85 })
      .toBuffer();
    const { writeFileSync, unlinkSync } = await import('fs');
    const tmp = '/tmp/test-webp-size.webp';
    writeFileSync(tmp, buf);
    try {
      const size = readImageSize(tmp);
      expect(size).not.toBeNull();
      expect(size!.width).toBe(1190);
      expect(size!.height).toBe(1316);
    } finally {
      unlinkSync(tmp);
    }
  });

});
