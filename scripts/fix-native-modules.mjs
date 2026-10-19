// 替换 Linux 版原生模块
//
// 背景：项目 node_modules 是从 Windows 同步过来的，原生模块是 win32 变体（PE32），
// 直接打包成 Linux deb/AppImage 会崩溃。本脚本用项目根目录下已下载好的两个 Linux
// 原生模块 tarball 替换 win32 变体：
//   - napi-rs-canvas-linux-x64-gnu-1.0.9.tgz  → @napi-rs/canvas-linux-x64-gnu + 主包 .node
//   - img-sharp-linux-x64-0.35.4.tgz           → @img/sharp-linux-x64
// better-sqlite3 用 prebuilds 多平台预编译，已含 linux-x64.node (ELF)，无需处理。
//
// 经验来源：
//   - 2026-09-27-deb-native-module-platform-binary-trap（@napi-rs/canvas / @img/sharp 变体映射）
//   - 2026-09-27-electron-asar-boundary-require-platform-package-fail（asar 边界 require 解析）
//
// 导出 replaceNativeModules(nodeModulesDir) 供 afterPack hook 复用；
// 直接 `node scripts/fix-native-modules.mjs` 运行时，对 dist/linux-unpacked 下
// 的 app.asar.unpacked/node_modules 执行替换（事后手动修复用）。
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync } from 'fs';
import { join } from 'path';
import * as tar from 'tar';

const CANVAS_TGZ = 'napi-rs-canvas-linux-x64-gnu-1.0.9.tgz';
const SHARP_TGZ = 'img-sharp-linux-x64-0.35.4.tgz';

/**
 * 解压两个 Linux 原生模块 tarball 到临时目录。
 * @param {string} tmpDir 临时目录绝对路径
 * @returns {{ canvasPkg: string, sharpPkg: string }} 解压后 package/ 目录绝对路径
 */
async function extractTarballs(tmpDir) {
  console.log('=== 1. 解压 Linux 原生模块 ===');

  const canvasDir = join(tmpDir, 'canvas');
  mkdirSync(canvasDir, { recursive: true });
  await tar.x({ file: CANVAS_TGZ, cwd: canvasDir });
  console.log('  canvas 解压完成');

  const sharpDir = join(tmpDir, 'sharp');
  mkdirSync(sharpDir, { recursive: true });
  await tar.x({ file: SHARP_TGZ, cwd: sharpDir });
  console.log('  sharp 解压完成');

  return {
    canvasPkg: join(canvasDir, 'package'),
    sharpPkg: join(sharpDir, 'package'),
  };
}

/**
 * 替换 @napi-rs/canvas：
 *   - 删除 win32 平台包（如存在）
 *   - 创建 linux 平台包并复制内容
 *   - 把 skia.linux-x64-gnu.node 复制到主包目录（js-binding.js 会 require 它）
 * @param {string} nodeModulesDir node_modules 绝对路径
 * @param {string} canvasPkg 解压后的 canvas package/ 目录
 */
function replaceCanvas(nodeModulesDir, canvasPkg) {
  console.log('=== 2. 替换 @napi-rs/canvas ===');
  const napiRsDir = join(nodeModulesDir, '@napi-rs');
  const canvasWinDir = join(napiRsDir, 'canvas-win32-x64-msvc');
  const canvasLinuxDir = join(napiRsDir, 'canvas-linux-x64-gnu');

  if (existsSync(canvasWinDir)) {
    rmSync(canvasWinDir, { recursive: true, force: true });
    console.log('  删除 win32 版本');
  }

  mkdirSync(canvasLinuxDir, { recursive: true });
  cpSync(canvasPkg, canvasLinuxDir, { recursive: true });
  console.log('  ✅ canvas-linux-x64-gnu:', readdirSync(canvasLinuxDir));

  // 将 Linux .node 文件复制到 @napi-rs/canvas 主包目录
  // js-binding.js 会先尝试 require('./skia.linux-x64-gnu.node')
  const canvasMainDir = join(napiRsDir, 'canvas');
  if (existsSync(canvasMainDir)) {
    const linuxNode = join(canvasLinuxDir, 'skia.linux-x64-gnu.node');
    if (existsSync(linuxNode)) {
      cpSync(linuxNode, join(canvasMainDir, 'skia.linux-x64-gnu.node'));
      console.log('  ✅ skia.linux-x64-gnu.node 已复制到 @napi-rs/canvas 主包目录');
    } else {
      console.warn('  ⚠️ 未找到 skia.linux-x64-gnu.node，跳过主包复制');
    }
  } else {
    console.warn('  ⚠️ @napi-rs/canvas 主包目录不存在，跳过主包 .node 复制');
  }
}

/**
 * 替换 @img/sharp：
 *   - 删除 win32 平台包（如存在）
 *   - 创建 linux 平台包并复制内容
 * @param {string} nodeModulesDir node_modules 绝对路径
 * @param {string} sharpPkg 解压后的 sharp package/ 目录
 */
function replaceSharp(nodeModulesDir, sharpPkg) {
  console.log('=== 3. 替换 @img/sharp ===');
  const imgDir = join(nodeModulesDir, '@img');
  const sharpWinDir = join(imgDir, 'sharp-win32-x64');
  const sharpLinuxDir = join(imgDir, 'sharp-linux-x64');

  if (existsSync(sharpWinDir)) {
    rmSync(sharpWinDir, { recursive: true, force: true });
    console.log('  删除 win32 版本');
  }

  mkdirSync(sharpLinuxDir, { recursive: true });
  cpSync(sharpPkg, sharpLinuxDir, { recursive: true });
  console.log('  ✅ sharp-linux-x64:', readdirSync(sharpLinuxDir));
}

/**
 * 替换指定 node_modules 目录下的 win32 原生模块为 Linux 版本。
 *
 * 流程：
 *   a. 在 process.cwd()/dist/tmp-native 下解压两个 tarball
 *   b. 替换 @napi-rs/canvas（删 win32、建 linux、复制 .node 到主包）
 *   c. 替换 @img/sharp（删 win32、建 linux）
 *   d. 清理临时目录
 *
 * @param {string} nodeModulesDir 要替换的 node_modules 目录的绝对路径
 */
export async function replaceNativeModules(nodeModulesDir) {
  const ROOT = process.cwd();
  const TMP = join(ROOT, 'dist', 'tmp-native');

  // 清理可能残留的临时目录
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }

  try {
    const { canvasPkg, sharpPkg } = await extractTarballs(TMP);
    replaceCanvas(nodeModulesDir, canvasPkg);
    replaceSharp(nodeModulesDir, sharpPkg);

    console.log('=== 4. 验证 ===');
    const napiRsDir = join(nodeModulesDir, '@napi-rs');
    const imgDir = join(nodeModulesDir, '@img');
    if (existsSync(napiRsDir)) {
      console.log('  @napi-rs/:', readdirSync(napiRsDir));
    }
    if (existsSync(imgDir)) {
      console.log('  @img/:', readdirSync(imgDir));
    }

    console.log('\n✅ 原生模块替换完成！');
  } finally {
    // 无论成功失败都清理临时目录
    if (existsSync(TMP)) {
      rmSync(TMP, { recursive: true, force: true });
    }
  }
}

// 独立运行入口：对 dist/linux-unpacked/resources/app.asar.unpacked/node_modules 执行替换
// 用法：node scripts/fix-native-modules.mjs
import { fileURLToPath } from 'url';
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const ROOT = process.cwd();
  const UNPACKED_NM = join(
    ROOT,
    'dist',
    'linux-unpacked',
    'resources',
    'app.asar.unpacked',
    'node_modules',
  );
  if (!existsSync(UNPACKED_NM)) {
    console.error(`❌ 目标目录不存在: ${UNPACKED_NM}`);
    console.error('   请先运行 electron-builder 生成 linux-unpacked，或确认路径正确。');
    process.exit(1);
  }
  await replaceNativeModules(UNPACKED_NM);
}
