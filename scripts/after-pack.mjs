import { writeFileSync, copyFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { replaceNativeModules } from './fix-native-modules.mjs';

export default async function afterPack(context) {
  const outDir = context.appOutDir;
  const electronPlatform = context.electronPlatformName;

  // === Linux：修正 chrome-sandbox 权限为 setuid root（4755）===
  // 在 ext4 等原生文件系统上打包时生效，保证 linux-unpacked / tar.gz 直接可运行；
  // 在 NTFS/exFAT（nosuid 挂载）上 chmod 会静默无效，运行时由主进程自动降级 --no-sandbox 兜底。
  if (electronPlatform === 'linux') {
    try {
      chmodSync(join(outDir, 'chrome-sandbox'), 0o4755);
      console.log('[afterPack] chrome-sandbox 权限已设置为 4755');
    } catch (err) {
      console.warn('[afterPack] 设置 chrome-sandbox 4755 失败（可忽略，运行时自动降级）:', err?.message);
    }
  }

  // === Linux：生成自定义 .desktop 文件（随包携带，postinst 还会再覆盖一次系统副本）===
  // 三平台统一规范：内部名 youdu（可执行文件/图标文件），显示名中文“幽读”。
  // electron-builder 默认 .desktop 的 Name/Icon 取 productName，这里显式写死，
  // 避免 Deepin 25 DDE 图标匹配和 WM_CLASS 关联问题。
  if (electronPlatform === 'linux') {
    const desktopContent = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=幽读',
      'GenericName=本地小说阅读器',
      'Comment=支持 TXT/EPUB/MOBI/PDF/CBZ/CBR 的本地电子书阅读器',
      'Exec=youdu %U',
      'Icon=youdu',
      'Categories=Office;Utility;TextEditor;',
      'Terminal=false',
      'StartupWMClass=youdu',
      'MimeType=application/epub+zip;application/pdf;text/plain;application/x-mobipocket-ebook;',
      ''
    ].join('\n');

    writeFileSync(join(outDir, 'youdu.desktop'), desktopContent, 'utf-8');
    console.log('[afterPack] Linux .desktop 文件已生成（Name=幽读, Icon=youdu）');
  }

  // === Linux：替换 win32 原生模块为 Linux 版（@napi-rs/canvas、@img/sharp）===
  // 项目 node_modules 从 Windows 同步而来，win32 平台包是 PE32 格式，直接打包到
  // Linux 会崩溃。afterPack 时 context.appOutDir 即 unpacked 目录，原生模块位于
  // resources/app.asar.unpacked/node_modules。用 try/catch 包裹，失败只告警不中断
  // 打包（例如 tarball 缺失时由后续手动 fix-native-modules 兜底）。
  if (electronPlatform === 'linux') {
    try {
      const unpackedNodeModules = join(outDir, 'resources', 'app.asar.unpacked', 'node_modules');
      console.log('[afterPack] 开始替换 Linux 原生模块:', unpackedNodeModules);
      await replaceNativeModules(unpackedNodeModules);
      console.log('[afterPack] Linux 原生模块替换完成');
    } catch (err) {
      console.warn('[afterPack] 替换 Linux 原生模块失败（打包继续，可事后手动修复）:', err?.message);
    }
  }
}
