import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

/**
 * 首次运行时自动在桌面创建快捷方式
 *
 * 适用场景：
 * - 玲珑包：安装时无 postinstall 机制，首次运行补建桌面图标
 * - AppImage / tar.gz：无安装脚本，首次运行补建桌面图标
 * - deb 包：postinst 已创建，标志文件存在，不会重复创建
 *
 * 幂等保证：用 ~/.local/share/youdu/.desktop-shortcut-created 标志文件
 */
export function createDesktopShortcutIfFirstRun(): void {
  // 仅 Linux
  if (platform() !== 'linux') return;

  const home = homedir();
  const dataDir = join(home, '.local', 'share', 'youdu');
  const flagFile = join(dataDir, '.desktop-shortcut-created');

  // 已创建过，跳过
  if (existsSync(flagFile)) return;

  // 查找桌面目录（Deepin 中文桌面可能是 ~/桌面，英文是 ~/Desktop）
  const desktopDirs = [join(home, 'Desktop'), join(home, '桌面')];
  const desktopDir = desktopDirs.find((d) => existsSync(d));
  if (!desktopDir) return;

  // 检测运行环境，生成对应的 Exec 命令
  const execCmd = detectExecCommand();
  if (!execCmd) return;

  // 生成 .desktop 文件内容
  const desktopContent = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=幽读',
    'GenericName=本地小说阅读器',
    'Comment=支持 TXT/EPUB/MOBI/PDF/CBZ/CBR 的本地电子书阅读器',
    `Exec=${execCmd}`,
    'Icon=youdu',
    'Categories=Office;Utility;TextEditor;',
    'Terminal=false',
    'StartupWMClass=youdu',
    'MimeType=application/epub+zip;application/pdf;text/plain;application/x-mobipocket-ebook;',
    '',
  ].join('\n');

  try {
    // 写入桌面 .desktop 文件
    const desktopFile = join(desktopDir, 'youdu.desktop');
    writeFileSync(desktopFile, desktopContent, { mode: 0o755 });

    // 标记为已创建（防止重复创建）
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(flagFile, new Date().toISOString());

    // 尝试设置可信标志（Deepin 桌面需要）
    try {
      const { execSync } = require('child_process');
      execSync(`gio set "${desktopFile}" metadata::trusted true`, { stdio: 'ignore' });
    } catch {
      // gio 不存在或设置失败，忽略
    }

    console.log('[desktop] 首次运行，已创建桌面快捷方式');
  } catch (err) {
    console.warn('[desktop] 创建桌面快捷方式失败:', err);
  }
}

/**
 * 检测运行环境，返回对应的 Exec 命令
 */
function detectExecCommand(): string | null {
  const appPath = process.execPath;

  // 1. 玲珑包：路径包含 /linglong/ 或 /opt/apps/io.github.youdu/
  if (appPath.includes('linglong') || appPath.includes('/opt/apps/io.github.youdu/')) {
    return '/usr/bin/ll-cli run io.github.youdu -- %U';
  }

  // 2. deb 包：安装在 /opt/Youdu/
  if (appPath.startsWith('/opt/Youdu/') || appPath.startsWith('/opt/youdu/')) {
    return '/opt/Youdu/youdu %U';
  }

  // 3. AppImage 或 tar.gz：用当前可执行文件路径
  return `${appPath} %U`;
}