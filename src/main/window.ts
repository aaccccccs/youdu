/**
 * 窗口管理：无边框 BrowserWindow + 大小/位置记忆
 *
 * - Windows/Linux：frame: false，使用自定义 TitleBar
 * - macOS：titleBarStyle: 'hiddenInset'，保留交通灯按钮
 * - 关闭时保存 bounds 到 config/window-state.json，启动恢复
 */
import { app, BrowserWindow, shell, screen, session, Menu } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { getWindowStateFile, getConfigPath } from './utils';
import { registerMaximizeListener } from './ipc';
import { requestRendererFlush } from './close-flush';
import { getDb } from './db';
import { THEME_COLORS } from '../shared';
import { tMain } from './i18n';

/** 窗口状态持久化数据 */
interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

/** 默认窗口尺寸 */
const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 800;
/** 最小窗口尺寸 */
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

let mainWindow: BrowserWindow | null = null;


/**
 * 从数据库读取应用主题对应的背景色（窗口启动时使用，避免主题闪烁）
 * 颜色值来自 shared/theme-colors.ts 的 THEME_COLORS，与渲染进程共用同一源头。
 */
function getAppBackgroundColor(): string {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app.theme') as
      { value: string } | undefined;
    const theme = row?.value ?? 'day';
    if (theme === 'custom') {
      const customRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('app.customThemeColors') as
        { value: string } | undefined;
      if (customRow?.value) {
        const customColors = JSON.parse(customRow.value) as { bg?: string };
        if (customColors.bg) return customColors.bg;
      }
    }
    return THEME_COLORS[theme as keyof typeof THEME_COLORS]?.bg ?? THEME_COLORS.day.bg;
  } catch {
    return THEME_COLORS.day.bg;
  }
}

/** 读取已保存的窗口状态 */
function readWindowState(): WindowState | null {
  try {
    const file = getWindowStateFile();
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf-8');
    const data = JSON.parse(raw) as WindowState;
    if (typeof data.width !== 'number' || typeof data.height !== 'number') {
      return null;
    }
    // 校验最小尺寸：保存的尺寸若小于最小尺寸，视为无效数据
    if (data.width < MIN_WIDTH || data.height < MIN_HEIGHT) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/** 保存窗口状态 */
function saveWindowState(win: BrowserWindow): void {
  try {
    const configDir = getConfigPath();
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    const isMaximized = win.isMaximized();
    const state: WindowState = {
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      isMaximized
    };
    if (!isMaximized) {
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      state.x = x;
      state.y = y;
      state.width = width;
      state.height = height;
    } else {
      // 最大化时尝试读取之前的 normal bounds
      const prev = readWindowState();
      if (prev && prev.x !== undefined && prev.y !== undefined) {
        state.x = prev.x;
        state.y = prev.y;
        state.width = prev.width;
        state.height = prev.height;
      }
    }
    writeFileSync(getWindowStateFile(), JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[window] 保存窗口状态失败:', err);
  }
}

/**
 * 校验窗口位置是否在可视屏幕范围内（避免多显示器切换后窗口不可见）
 *
 * 检查窗口中心点是否落在任意一个显示器范围内，
 * 比仅检查左上角更稳健：窗口部分超出但中心可见时仍认为可用。
 */
function ensureBoundsVisible(state: WindowState): WindowState {
  if (state.x === undefined || state.y === undefined) return state;
  // 计算窗口中心点
  const centerX = state.x + state.width / 2;
  const centerY = state.y + state.height / 2;
  const displays = screen.getAllDisplays();
  const visible = displays.some((display) => {
    const { x, y, width, height } = display.bounds;
    return centerX >= x && centerX < x + width && centerY >= y && centerY < y + height;
  });
  if (!visible) {
    // 不在可视区域，重置到主屏中央
    const primary = screen.getPrimaryDisplay();
    state.x = Math.floor(primary.bounds.x + (primary.bounds.width - state.width) / 2);
    state.y = Math.floor(primary.bounds.y + (primary.bounds.height - state.height) / 2);
  }
  return state;
}


/** child-process-gone 监听器是否已注册（避免 createMainWindow 多次调用时重复注册） */
let childProcessGoneListenerRegistered = false;

/**
 * 关闭流程（根因②修复：点 X 丢进度）：
 * 1. close 事件拦截（preventDefault）→ 保存窗口状态 → requestRendererFlush 通知渲染端保存进度
 * 2. 渲染端回执 WINDOW_CLOSE_FLUSH_DONE 或 CLOSE_FLUSH_TIMEOUT_MS 超时 → destroy() 绕过再次 close
 * 3. window-all-closed → app.quit() → before-quit 清理资源（既有逻辑不变）
 * 状态机（requestRendererFlush/notifyCloseFlushDone）在 ./close-flush.ts，
 * 独立模块避免 window.ts ↔ ipc/window.ts 循环导入。
 */
let awaitingFlushClose = false;


/** 创建主窗口 */
export function createMainWindow(): BrowserWindow {
  const saved = readWindowState();
  const initial: WindowState = saved
    ? ensureBoundsVisible(saved)
    : {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        x: undefined,
        y: undefined
      };

  // macOS 用 hiddenInset 保留交通灯按钮；其他平台完全无边框
  const isMac = process.platform === 'darwin';

  // 生产环境移除默认菜单（含 View > Toggle Developer Tools）
  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }

  mainWindow = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    x: initial.x,
    y: initial.y,
    show: false,
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    backgroundColor: getAppBackgroundColor(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 开启沙箱：preload 仅通过 contextBridge 暴露安全 API，未直接使用 Node.js API
      sandbox: true,
      webSecurity: true
    }
  });

  // 最大化恢复
  if (saved?.isMaximized) {
    mainWindow.maximize();
  }

  // 注册最大化状态变化监听器（必须在窗口创建后调用，B-01 修复）
  registerMaximizeListener(mainWindow);

  // ready-to-show 超时兜底：5 秒后如果还没显示，强制 show
  // 防止 GPU/渲染进程崩溃导致 ready-to-show 不触发，窗口永远不显示（进程存活但无界面）
  const showTimeout = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('[window] ready-to-show 超时（5s），强制显示窗口');
      mainWindow.show();
    }
  }, 5000);

  mainWindow.on('ready-to-show', () => {
    clearTimeout(showTimeout);
    mainWindow?.show();
  });

  // 设置 CSP：允许 file:// 页面加载 https:// 远程图片（RSS 文章图文在线加载）
  // CSP 收紧策略（来源：2026-10-19-electron-csp-policy-hardening-checklist）：
  // - script-src：生产环境 'self' file:（无 unsafe-inline）；开发环境保留 unsafe-inline（Vue HMR 需要）
  // - style-src：保留 'unsafe-inline'（naive-ui 的 css-render 在运行时动态插入 <style> 标签，
  //   受 style-src 管控，移除 unsafe-inline 会导致 naive-ui 全部动态样式被 CSP 拦截→布局/图标崩坏）
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isDev = !app.isPackaged && process.env['NODE_ENV'] !== 'production';
    const scriptSrc = isDev ? "script-src 'self' 'unsafe-inline' file:" : "script-src 'self' file:";
    const styleSrc = "style-src 'self' 'unsafe-inline' file: data:";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self' file: data:; img-src 'self' file: data: https:; ${styleSrc}; ${scriptSrc} font-src 'self' file: data:; connect-src 'self' file: https:`
        ]
      }
    });
  });

  // 关闭流程（根因②修复：点 X 丢进度，状态机说明见上方 awaitingFlushClose 声明处）
  mainWindow.on('close', (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveWindowState(mainWindow);
    }
    // 已在 flush 等待中的二次 close（用户再点 X）：放行，立即销毁
    if (awaitingFlushClose) return;
    // 渲染页面未加载完成（启动即关）时无进度可保存，直接放行关闭
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
      return;
    }
    e.preventDefault();
    awaitingFlushClose = true;
    const win = mainWindow;
    void requestRendererFlush(win)
      .catch((err) => console.warn('[window] 关闭前 flush 异常:', err))
      .finally(() => {
        awaitingFlushClose = false;
        // destroy 绕过 close 事件，避免再次触发拦截；window-all-closed → app.quit() 不变
        if (!win.isDestroyed()) win.destroy();
      });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外链用系统浏览器打开；仅允许 http/https 协议，拒绝 file://、javascript: 等危险协议
  mainWindow.webContents.setWindowOpenHandler((details) => {
    const url = details.url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { action: 'deny' };
    }
    shell.openExternal(url).catch((err) => {
      console.error(`[window] shell.openExternal 失败: ${url}`, err);
    });
    return { action: 'deny' };
  });

  // 拦截 <a href> 点击导致的窗口内导航（will-navigate）
  // Electron 默认会在当前 BrowserWindow 中加载 <a> 链接的 URL，导致页面跳转到无 CSS/无返回键的裸网页。
  // setWindowOpenHandler 只拦截 window.open，不拦截 <a> 点击导航，必须用 will-navigate 事件拦截。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // 只允许 http/https 外链用系统浏览器打开，阻止窗口内导航
    if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(url).catch((err) => {
        console.error(`[window] will-navigate shell.openExternal 失败: ${url}`, err);
      });
    } else {
      // 非 http/https 协议（file://、javascript: 等）直接阻止
      event.preventDefault();
    }
  });

  // 原生右键菜单：支持输入框复制/粘贴/剪切/全选，链接复制/打开，图片复制
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];

    // 可编辑区域（输入框/文本域）：撤销/重做/剪切/复制/粘贴/删除/全选
    if (params.isEditable) {
      if (params.editFlags.canUndo) {
        menuItems.push({ label: tMain('menu.undo'), role: 'undo', accelerator: 'CmdOrCtrl+Z' });
      }
      if (params.editFlags.canRedo) {
        menuItems.push({ label: tMain('menu.redo'), role: 'redo', accelerator: 'CmdOrCtrl+Y' });
      }
      if (menuItems.length > 0) menuItems.push({ type: 'separator' });

      if (params.editFlags.canCut) {
        menuItems.push({ label: tMain('menu.cut'), role: 'cut', accelerator: 'CmdOrCtrl+X' });
      }
      if (params.editFlags.canCopy) {
        menuItems.push({ label: tMain('menu.copy'), role: 'copy', accelerator: 'CmdOrCtrl+C' });
      }
      if (params.editFlags.canPaste) {
        menuItems.push({ label: tMain('menu.paste'), role: 'paste', accelerator: 'CmdOrCtrl+V' });
      }
      if (params.editFlags.canDelete) {
        menuItems.push({ label: tMain('menu.delete'), role: 'delete' });
      }
      if (params.editFlags.canSelectAll) {
        menuItems.push({ type: 'separator' });
        menuItems.push({ label: tMain('menu.selectAll'), role: 'selectAll', accelerator: 'CmdOrCtrl+A' });
      }
    } else if (params.selectionText) {
      // 非编辑区域但有选中文本：仅复制
      menuItems.push({ label: tMain('menu.copy'), role: 'copy', accelerator: 'CmdOrCtrl+C' });
    }

    // 链接右键
    if (params.linkURL) {
      if (menuItems.length > 0) menuItems.push({ type: 'separator' });
      menuItems.push({
        label: tMain('menu.copyLink'),
        click: () => {
          const { clipboard } = require('electron');
          clipboard.writeText(params.linkURL);
        }
      });
      menuItems.push({
        label: tMain('menu.openLink'),
        click: () => {
          shell.openExternal(params.linkURL).catch((e) => console.warn('[cleanup] 操作失败:', e));
        }
      });
    }

    // 图片右键
    if (params.mediaType === 'image' && params.srcURL) {
      if (menuItems.length > 0) menuItems.push({ type: 'separator' });
      menuItems.push({
        label: tMain('menu.copyImage'),
        click: () => {
          mainWindow?.webContents.copyImageAt(params.x, params.y);
        }
      });
      menuItems.push({
        label: tMain('menu.copyImageUrl'),
        click: () => {
          const { clipboard } = require('electron');
          clipboard.writeText(params.srcURL);
        }
      });
    }

    if (menuItems.length > 0) {
      const menu = Menu.buildFromTemplate(menuItems);
      if (mainWindow && !mainWindow.isDestroyed()) {
        menu.popup({ window: mainWindow });
      }
    }
  });

  // 开发环境自动打开 DevTools；生产环境彻底禁用
  if (!app.isPackaged && process.env['NODE_ENV'] !== 'production') {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    });
  } else {
    // 生产环境拦截 DevTools 快捷键（F12 / Ctrl+Shift+I / Cmd+Opt+I）
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown') {
        const key = input.key.toLowerCase();
        if (
          key === 'f12' ||
          (key === 'i' && input.control && input.shift) ||
          (key === 'i' && input.meta && input.alt)
        ) {
          _e.preventDefault();
        }
      }
    });
  }

  // 加载失败始终记录（生产环境也需要排障）
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error(`[window] 页面加载失败: code=${errorCode}, desc=${errorDescription}, url=${validatedURL}`);
    // 确保窗口可见，让用户看到错误而不是无窗口
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });
  // 渲染进程 console 转发仅开发环境
  if (!app.isPackaged && process.env['NODE_ENV'] !== 'production') {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer][L${level}] ${message} (${sourceId}:${line})`);
    });
  }
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[window] 渲染进程崩溃: ${JSON.stringify(details)}`);

    // 渲染进程崩溃后自动恢复：延迟1秒后重新加载页面
    // 防止用户看到白屏，需要手动重启应用
    setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('[window] 渲染进程崩溃恢复：重新加载页面...');
          if (process.env['ELECTRON_RENDERER_URL']) {
            mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
          } else {
            const rendererPath = join(__dirname, '../renderer/index.html');
            mainWindow.loadFile(rendererPath);
          }
          // 确保窗口可见（首次启动可能从未显示过）
          if (!mainWindow.isVisible()) {
            mainWindow.show();
          }
        }
      } catch (err) {
        console.error('[window] 渲染进程崩溃恢复失败:', err);
      }
    }, 1000);
  });

  // 捕获子进程（GPU、网络服务等）崩溃（仅注册一次，避免 createMainWindow 多次调用时重复注册）
  if (!childProcessGoneListenerRegistered) {
    childProcessGoneListenerRegistered = true;
    app.on('child-process-gone', (_e, details) => {
      console.warn(`[window] 子进程崩溃: ${JSON.stringify(details)}`);
    });
  }

  // 加载渲染进程
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    const rendererPath = join(__dirname, '../renderer/index.html');
    console.log(`[window] 加载渲染进程: ${rendererPath}`);
    mainWindow.loadFile(rendererPath);
  }

  return mainWindow;
}

/** 获取主窗口实例 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

