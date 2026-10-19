/**
 * 主进程入口
 *
 * 职责：
 * 1. app ready 后初始化 userData 子目录 + 数据库
 * 2. 注册 IPC handler
 * 3. 创建主窗口
 * 4. 处理单实例锁、窗口全关闭退出、退出前关闭数据库等生命周期
 * 5. 提供系统通知服务（showNotification，受 settings 表 notification_config 控制）
 * 6. 启动阅读提醒定时器（到点显示通知）
 * 7. 注册 RSS 更新通知回调（订阅发现新内容时显示通知）
 */

// 清除 ELECTRON_RUN_AS_NODE 环境变量：CodeArts 等 IDE 会设置此变量，
// 导致 Electron 作为纯 Node.js 运行而不创建窗口（症状：进程存活但无界面）。
// 必须在 import electron 之前执行，否则 Electron 内部已读取该变量。
delete process.env.ELECTRON_RUN_AS_NODE;

import { app, BrowserWindow, dialog, Notification } from 'electron';
import { join, dirname } from 'path';
import { existsSync, statSync, renameSync } from 'fs';
import { createMainWindow, getMainWindow } from './window';
import { createDesktopShortcutIfFirstRun } from './desktop-shortcut';
import { registerAllIpc } from './ipc';

import { ensureUserDataDirs, getPendingPathRewrite, clearPendingPathRewrite } from './utils';
import { initDatabase, closeDatabase, rewriteBookPaths } from './db';
import { setGlobalProxy, type ProxyConfig } from './core/subscription';
import * as settingsRepo from './db/repositories';
import { closeAllEpubCaches, closeAllPdfCaches, closeAllMobiCaches } from './core/file-parser';
import { pdfWorkerPool } from './core/pdf-worker-pool';
import { IPC_CHANNELS } from '../shared';
import { init as initSubscription, shutdown as shutdownSubscription, setOnNewItemsCallback } from './core/subscription';
import { refreshMainLocale, tMain } from './i18n';

// 全局异常兜底：避免未捕获异常导致主进程崩溃白屏
// 仅记录日志，不退出进程；让 Electron 继续运行，由用户自行处理或重启
process.on('uncaughtException', (err) => {
  console.error('[main] 未捕获异常:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] 未处理的 Promise 拒绝:', reason);
});

// 固定 userData 目录（必须在单实例锁/任何 getPath 使用之前）。
// 三平台统一规范：userData 即书库根目录，固定为 appData/youdu：
//   Linux: ~/.config/youdu
//   Win:   %APPDATA%\youdu
//   Mac:   ~/Library/Application Support/youdu
// Electron 默认按 productName 命名该目录，且 Linux 下还会被 GTK prgname
// 影响；这里与启动方式、productName 彻底解耦。
// 历史目录（youdu-local / YouduLocal / 幽读本地版）做一次性 rename 迁移，
// 同盘瞬时完成；新目录已存在则不动，避免覆盖。
{
  const appDataDir = app.getPath('appData');
  const fixedUserData = join(appDataDir, 'youdu');
  const legacyUserDataDirs = ['youdu-local', 'YouduLocal', '幽读本地版'];
  // 注意：此处绝不能提前调用 app.getPath('userData') —— Electron 在首次访问时
  // 会立即按当前应用名创建默认 userData 目录（打包后 name=youdu，恰好就是目标
  // 目录名），导致下面的旧配置 rename 迁移被“新目录已存在”误判而整体跳过。
  if (!existsSync(fixedUserData)) {
    for (const legacyName of legacyUserDataDirs) {
      const legacyDir = join(appDataDir, legacyName);
      if (!existsSync(legacyDir)) continue;
      try {
        renameSync(legacyDir, fixedUserData);
        console.info('[migration] userData 已迁移:', legacyDir, '->', fixedUserData);
        break;
      } catch (err) {
        console.warn('[migration] userData 目录迁移失败（尝试下一候选）:', (err as Error).message);
      }
    }
  }
  // 无条件固定（默认路径可能是 ~/.config/<productName>，与产品名解耦）
  app.setPath('userData', fixedUserData);
}

// 单实例锁：禁止多开
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// 硬件加速：保持开启以获得流畅的 CSS 动画渲染
// 历史上部分 Windows GPU 驱动冲突会导致白屏，曾用 app.disableHardwareAcceleration() 兜底
// 但副作用是所有动画退化为 CPU 渲染导致严重卡顿，现改为保持开启
// 如遇白屏可恢复：if (process.platform === 'win32') app.disableHardwareAcceleration()

// Linux Wayland 兼容：Electron 44（Chromium 新版）在 Wayland 会话下默认走 Ozone Wayland
// 原生模式。在部分 Wayland 合成器（实测 Deepin 25 treeland）上，frame:false 的无边框
// 顶层窗口不会被映射到屏幕——X 窗口树中只剩一个 10x10 的 X11 占位窗，症状即"进程存活
// 但窗口完全不显示"，ready-to-show 的强制 show 兜底也无效（Wayland 表面根本没被合成）。
// 检测到 Wayland 会话时强制使用 XWayland（x11），与系统中正常显示的 Qt 应用一致。
// X11 会话不受影响；用户仍可通过命令行 --ozone-platform=wayland 自行覆盖。
if (process.platform === 'linux' && (process.env['WAYLAND_DISPLAY'] || process.env['XDG_SESSION_TYPE'] === 'wayland')) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

// Linux SUID 沙箱检测：chrome-sandbox 必须为 root:root 且带 setuid 位（mode 4755）。
// 应用解压/运行在 NTFS、exFAT、U 盘等不支持 Unix 权限的文件系统（nosuid 挂载）时，
// setuid 位无法保留，Chromium 会直接 FATAL 中止（"SUID sandbox helper ... not configured
// correctly"，exit 133），窗口尚未创建进程就退出——症状即"双击毫无反应、无窗口"。
// 检测到沙箱文件存在但权限不正确时自动降级 --no-sandbox，保证在任何位置都能启动；
// 文件不存在时不干预（现代内核可走 user namespace 沙箱）。
// 注意：仅关闭 Chromium 进程级沙箱，渲染层 contextIsolation / preload 隔离仍然生效。
if (process.platform === 'linux') {
  const sandboxCandidates = [
    // 打包后：chrome-sandbox 与可执行文件同目录
    join(dirname(process.execPath), 'chrome-sandbox'),
    // 开发模式：electron 解压在 node_modules/electron/dist
    join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'chrome-sandbox')
  ];
  let sandboxFound = false;
  let sandboxUsable = false;
  for (const candidate of sandboxCandidates) {
    try {
      const st = statSync(candidate);
      sandboxFound = true;
      // root 属主 + setuid 位 + 可执行位
      if (st.uid === 0 && (st.mode & 0o4000) !== 0 && (st.mode & 0o100) !== 0) {
        sandboxUsable = true;
        break;
      }
    } catch {
      // 候选路径不存在，继续尝试下一个
    }
  }
  if (sandboxFound && !sandboxUsable) {
    console.warn(
      '[main] chrome-sandbox 权限不正确（需要 root:root + 4755，常见于 NTFS/exFAT 盘直接运行），自动启用 --no-sandbox'
    );
    app.commandLine.appendSwitch('no-sandbox');
  }
}

// GPU 渲染优化开关：必须在 app.whenReady() 之前设置，影响 Chromium 启动参数
// 仅 Windows 启用：Linux GPU 驱动多样（集显/虚拟 GPU/开源 nouveau 等），强制启用可能致
// 渲染进程崩溃 → ready-to-show 不触发 → 窗口不显示（进程存活但无界面）
// macOS 自带良好 GPU 驱动，也启用
if (process.platform !== 'linux') {
  // 启用 GPU 光栅化：让图片和图层由 GPU 光栅化，提升渲染性能（尤其大量图片的阅读器场景）
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  // 启用零拷贝光栅化：光栅化结果直接留在8 内存拷贝
  app.commandLine.appendSwitch('enable-zero-copy');
  // 忽略 GPU 黑名单：某些 GPU 驱动可能被 Chromium 错误黑名单，强制启用 GPU1
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

app.on('window-all-closed', () => {
  // 窗口关闭直接退出应用（close 事件仅保存窗口状态，不拦截）
  app.quit();
});

app.on('activate', () => {
  // macOS dock 点击重新创建窗口
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// 退出前关闭数据库和 EPUB ZIP 句柄缓存、PDF 全文缓存、MOBI 全文缓存，确保 WAL 写回主库、内存释放
app.on('before-quit', (event) => {
  if (!subscriptionShutdownStarted) {
    subscriptionShutdownStarted = true;
    event.preventDefault();
    const cleanupTimeout = setTimeout(() => {
      console.warn('[main] 清理超时，强制退出');
      process.exit(0);
    }, 5000);

    // 先通知渲染层停止所有播放（TTS/音频），等待 300ms 让其处理完毕再清理
    // 避免退出时 TTS 语音继续播放或音频句柄泄漏
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send(IPC_CHANNELS.APP_STOP_PLAYBACK);
      } catch (err) {
        console.warn('[main] 发送停止播放通知失败:', err);
      }
    }

    // 停止播放等待时间（ms）：给渲染层足够时间取消 speechSynthesis / 暂停音频
    const STOP_PLAYBACK_DELAY = 300;

    setTimeout(() => {
      // 清理阅读提醒定时器
      if (readingReminderTimerHandle) {
        clearInterval(readingReminderTimerHandle);
        readingReminderTimerHandle = null;
      }

      shutdownSubscription().finally(() => {
        clearTimeout(cleanupTimeout);
        try {
          closeAllEpubCaches();
        } catch (err) {
          console.error('[main] EPUB缓存关闭失败:', err);
        }
        try {
          closeAllPdfCaches();
        } catch (err) {
          console.error('[main] PDF缓存关闭失败:', err);
        }
        try {
          closeAllMobiCaches();
        } catch (err) {
          console.error('[main] MOBI缓存关闭失败:', err);
        }
        try {
          closeDatabase();
        } catch (err) {
          console.error('[main] 数据库关闭失败:', err);
        }
        // 终止所有 worker_threads 子线程，释放 native 资源（sharp/@napi-rs/canvas）
        try {
          pdfWorkerPool.shutdownAllWorkers();
        } catch (err) {
          console.error('[main] worker池关闭失败:', err);
        }
        // 所有资源已清理完毕，强制退出进程
        // app.quit() 不会终止残留的 native 句柄（chokidar fs.watch / better-sqlite3 线程），
        // 导致进程退出后仍残留。process.exit(0) 确保进程彻底结束。
        process.exit(0);
      });
    }, STOP_PLAYBACK_DELAY);
  }
});

/** 订阅系统关闭流程是否已启动（防止 before-quit 重复触发） */
let subscriptionShutdownStarted = false;

/* ==================== 通知服务 ==================== */

/** 通知配置（存储在 settings 表 key='notification_config'） */
interface NotificationConfig {
  enabled: boolean;
  rssUpdate: boolean;
  readingReminder: boolean;
  reminderTime: string;
}

/** 阅读提醒定时器句柄 */
let readingReminderTimerHandle: NodeJS.Timeout | null = null;

/**
 * 读取通知配置
 *
 * 从 settings 表读取 key='notification_config'，解析失败或不存在时返回默认值。
 */
function getNotificationConfig(): NotificationConfig {
  return settingsRepo.getSettingJson<NotificationConfig>('notification_config', {
    enabled: true,
    rssUpdate: true,
    readingReminder: false,
    reminderTime: '20:00'
  });
}

/**
 * 显示系统通知
 *
 * - 平台不支持 Notification 时静默跳过
 * - 通知配置未启用时静默跳过
 * - 点击通知时聚焦主窗口
 *
 * @param title 通知标题
 * @param body 通知正文
 */
export function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;

  const config = getNotificationConfig();
  if (!config.enabled) return;

  const notification = new Notification({ title, body });
  notification.show();

  notification.on('click', () => {
    // 点击通知时聚焦主窗口
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/**
 * 启动阅读提醒定时器
 *
 * 每分钟检查一次，到提醒时间时显示通知。
 * 用 lastReminderDate 防止同一分钟内重复触发。
 */
function startReadingReminderTimer(): void {
  let lastReminderDate = '';

  readingReminderTimerHandle = setInterval(() => {
    const config = getNotificationConfig();
    if (!config.enabled || !config.readingReminder) return;

    const now = new Date();
    const timeParts = config.reminderTime.split(':').map(Number);
    const hours = timeParts[0] ?? 0;
    const minutes = timeParts[1] ?? 0;

    if (now.getHours() === hours && now.getMinutes() === minutes) {
      // 防止同一分钟内重复触发（setInterval 可能多次进入同一分钟）
      const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${hours}-${minutes}`;
      if (todayKey === lastReminderDate) return;
      lastReminderDate = todayKey;

      showNotification(tMain('notification.readingReminderTitle'), tMain('notification.readingReminderBody'));
    }
  }, 60_000); // 1 minute

  console.log('[reading-reminder] 阅读提醒定时器已启动');
}

/**
 * 注册 RSS 更新通知回调
 *
 * 当 subscription.ts 的 checkAllUpdates 发现新条目时，
 * 通过回调触发系统通知（受通知配置 rssUpdate 开关控制），
 * 并发送 IPC 通知渲染进程刷新书架。
 */
function registerRssUpdateNotification(): void {
  setOnNewItemsCallback((subscriptionName: string, newCount: number) => {
    // 通知渲染进程刷新书架（新书已导入 DB）
    getMainWindow()?.webContents.send(IPC_CHANNELS.BOOKSHELF_REFRESH);

    const config = getNotificationConfig();
    if (!config.enabled || !config.rssUpdate) return;

    showNotification(
      tMain('notification.rssUpdateTitle'),
      tMain('notification.rssUpdateBody', { name: subscriptionName, n: newCount })
    );
  });
}

app.whenReady().then(() => {
  // 1. 初始化 userData 子目录
  ensureUserDataDirs();

  // 1.5 首次运行时自动创建桌面快捷方式（玲珑包/AppImage 无 postinstall）
  createDesktopShortcutIfFirstRun();

  // 2. 初始化数据库（在注册 IPC 和创建窗口前，确保 Repository 可用）
  try {
    initDatabase();
  } catch (err) {
    console.error('[main] 数据库初始化失败:', err);
    dialog.showErrorBox(tMain('dialog.dbInitTitle'), tMain('dialog.dbInitBody', { msg: (err as Error).message }));
    app.quit();
    return;
  }

  // 2.0a 启动迁移后重写数据库中的绝对路径。
  // migrateLegacyAppDataRoot 在迁移文件后设置 _pendingPathRewrite 标志，
  // 此处数据库已打开，重写 books.cover/local_file_path 指向新目录。
  // 失败只 warn 不阻断启动（部分封面/书籍可能无法打开，用户可手动迁移修复）。
  const pendingRewrite = getPendingPathRewrite();
  if (pendingRewrite) {
    try {
      rewriteBookPaths(pendingRewrite.oldRoot, pendingRewrite.newRoot);
    } catch (rewriteErr) {
      console.warn('[main] 启动迁移后数据库路径重写失败（部分封面/书籍可能无法打开）:', rewriteErr);
    }
    clearPendingPathRewrite();
  }

  // 2.0 同步界面语言偏好（供右键菜单/通知/原生对话框使用）
  refreshMainLocale();

  // 2.1 P2: 加载代理配置到 HTTP 请求层（必须在 initDatabase 之后）
  try {
    const proxyJson = settingsRepo.getSetting('http_proxy');
    if (proxyJson) {
      const proxyConfig = JSON.parse(proxyJson) as ProxyConfig;
      if (proxyConfig.host && proxyConfig.port) {
        setGlobalProxy(proxyConfig);
        console.log(`[main] 已加载代理配置: ${proxyConfig.type}://${proxyConfig.host}:${proxyConfig.port}`);
      }
    }
  } catch (err) {
    console.warn('[main] 加载代理配置失败，应用将继续启动:', err);
  }

  // 3. 注册 IPC
  registerAllIpc(getMainWindow);

  // 4. 创建主窗口（订阅系统延迟到窗口显示后初始化，避免阻塞启动）
  createMainWindow();


  // 5. 窗口显示后再初始化订阅系统（恢复文件夹监控 + 启动定时检查）
  //    用 try-catch 保护，即使订阅系统初始化失败也不阻止应用运行
  getMainWindow()?.once('ready-to-show', () => {
    try {
      initSubscription();
    } catch (err) {
      console.error('[main] 订阅系统初始化失败，应用将继续运行:', err);
    }
  });

  // 6. 启动阅读提醒定时器（每分钟检查，受 notification_config.readingReminder 控制）
  try {
    startReadingReminderTimer();
  } catch (err) {
    console.error('[main] 阅读提醒定时器启动失败，应用将继续运行:', err);
  }

  // 7. 注册 RSS 更新通知回调（订阅检查发现新内容时触发系统通知）
  try {
    registerRssUpdateNotification();
  } catch (err) {
    console.error('[main] RSS 更新通知回调注册失败，应用将继续运行:', err);
  }
});
