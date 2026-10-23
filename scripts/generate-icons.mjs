/**
 * 图标生成脚本
 *
 * 从 resources/icon.svg 生成：
 *   - resources/icon.png  (1024x1024 PNG，用于 macOS/Linux 和 electron-builder 自动生成 icns)
 *   - resources/icon.ico  (Windows ICO，多尺寸：16,32,48,64,128,256)
 *   - resources/icons/            (Linux 平铺多尺寸，electron-builder deb 拾取)
 *   - resources/icons-hicolor/    (Linux hicolor 目录树 16-1024 全 8 档，玲珑包拾取)
 *
 * 使用 sharp（内置 librsvg）渲染 SVG，再用 png-to-ico 打包成 ICO。
 */
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const resourcesDir = resolve(rootDir, 'resources');

const svgPath = resolve(resourcesDir, 'icon.svg');
const pngPath = resolve(resourcesDir, 'icon.png');
const icoPath = resolve(resourcesDir, 'icon.ico');

// ICO 需要的多尺寸
const icoSizes = [16, 32, 48, 64, 128, 256];
// PNG 主图标尺寸（1024 用于 macOS icns 自动生成，electron-builder 会自动 resize）
const pngSize = 1024;
// Linux 多尺寸图标（安装到 /usr/share/icons/hicolor/{size}x{size}/apps/）
const linuxSizes = [16, 32, 48, 64, 128, 256, 512];
// 玲珑包 hicolor 全尺寸档（16-1024 共 8 档，每档真实渲染像素，目录与尺寸严格一致）
const hicolorSizes = [16, 32, 48, 64, 128, 256, 512, 1024];

async function generateIcons() {
  console.log('[icons] 读取 SVG:', svgPath);
  const svgBuffer = await readFile(svgPath);

  // 1. 生成 1024x1024 PNG
  console.log(`[icons] 生成 PNG ${pngSize}x${pngSize} ->`, pngPath);
  await sharp(svgBuffer, { density: 300 })
    .resize(pngSize, pngSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(pngPath);

  // 2. 为 ICO 生成各尺寸 PNG buffer
  console.log(`[icons] 生成 ICO 多尺寸 [${icoSizes.join(', ')}] ->`, icoPath);
  const pngBuffers = await Promise.all(
    icoSizes.map(async (size) => {
      return await sharp(svgBuffer, { density: 300 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    })
  );

  // 3. 打包成 ICO
  const icoBuffer = await pngToIco(pngBuffers);
  await writeFile(icoPath, icoBuffer);

  // 4. 生成 Linux 多尺寸图标到 resources/icons/
  //    electron-builder 打 deb 时自动拾取此目录，安装到 hicolor 主题目录
  //    Deepin 25 DDE 启动器通过 hicolor 图标缓存显示应用图标
  const linuxIconsDir = resolve(resourcesDir, 'icons');
  await mkdir(linuxIconsDir, { recursive: true });
  console.log(`[icons] 生成 Linux 多尺寸 [${linuxSizes.join(', ')}] ->`, linuxIconsDir);
  await Promise.all(
    linuxSizes.map(async (size) => {
      const outPath = resolve(linuxIconsDir, `${size}x${size}.png`);
      await sharp(svgBuffer, { density: 300 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(outPath);
    })
  );

  // 5. 生成 Linux hicolor 标准目录树（玲珑包用）
  //    输出 resources/icons-hicolor/<size>x<size>/apps/youdu.png，全部 8 档真实尺寸。
  //    刻意放在 resources/ 下而非 linglong/ 工作目录：linglong/ 是 ll-builder 的
  //    构建工作区（含 cache/output），避免被 ll-builder 清理时误删。
  //    小尺寸档（<=64）提高 SVG 渲染密度（DPI），下采样到目标像素更清晰。
  const hicolorDir = resolve(resourcesDir, 'icons-hicolor');
  await rm(hicolorDir, { recursive: true, force: true });
  console.log(`[icons] 生成 hicolor 目录树 [${hicolorSizes.join(', ')}] ->`, hicolorDir);
  await Promise.all(
    hicolorSizes.map(async (size) => {
      const outDir = resolve(hicolorDir, `${size}x${size}`, 'apps');
      await mkdir(outDir, { recursive: true });
      const density = size <= 64 ? 600 : 300;
      await sharp(svgBuffer, { density })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(resolve(outDir, 'youdu.png'));
    })
  );

  console.log('[icons] 完成 ✓');
  console.log('  -', pngPath);
  console.log('  -', icoPath);
  console.log('  -', linuxIconsDir, '(Linux 多尺寸)');
  console.log('  -', hicolorDir, '(Linux hicolor 目录树，玲珑包用)');
}

generateIcons().catch((err) => {
  console.error('[icons] 失败:', err);
  process.exit(1);
});
