/**
 * 网络配置 IPC（v20 新增，设置页"网络"标签页）
 */
import { ipcMain } from 'electron';

import * as SettingsRepo from '../db/repositories';
import { setGlobalProxy } from '../core/subscription';
import { getNetworkConfig, clearNetworkConfigCache, type NetworkConfig } from '../core/network-config';

import { IPC_CHANNELS, wrapHandler } from './shared';

/** 注册网络配置相关 IPC handler（v20 新增，设置页"网络"标签页） */
export function registerNetworkIpc(): void {
  // 获取网络配置
  ipcMain.handle(
    IPC_CHANNELS.NETWORK_CONFIG_GET,
    wrapHandler(() => {
      return getNetworkConfig();
    })
  );

  // 设置网络配置
  ipcMain.handle(
    IPC_CHANNELS.NETWORK_CONFIG_SET,
    wrapHandler((_e, config: unknown) => {
      console.log('[ipc:network] 收到网络配置保存请求, config type:', typeof config, 'keys:', config && typeof config === 'object' ? Object.keys(config) : 'N/A');
      // 参数校验：必须是对象，且包含必要字段
      if (!config || typeof config !== 'object') {
        throw new Error('无效的网络配置：必须为对象');
      }
      const cfg = config as Partial<NetworkConfig>;
      if (typeof cfg.userAgent !== 'string') {
        throw new Error(`无效的网络配置：userAgent 必须为字符串（实际: ${typeof cfg.userAgent}）`);
      }
      if (!Array.isArray(cfg.customHeaders)) {
        throw new Error('无效的网络配置：customHeaders 必须为数组');
      }
      if (!cfg.proxy || typeof cfg.proxy !== 'object') {
        throw new Error(`无效的网络配置：proxy 必须为对象（实际: ${cfg.proxy === undefined ? 'undefined' : typeof cfg.proxy}）`);
      }
      // 持久化（走 Repository 层，避免直接操作 db）
      SettingsRepo.setSetting('network_config', JSON.stringify(cfg));
      console.log('[ipc:network] 网络配置已持久化到数据库');
      // 清除缓存，下次请求会重新读取
      clearNetworkConfigCache();
      // 实时更新全局代理（与 SETTING_SET 中 http_proxy 的逻辑保持一致）
      try {
        if (cfg.proxy.enabled && cfg.proxy.host && cfg.proxy.port) {
          setGlobalProxy({
            type: cfg.proxy.type === 'socks5' ? 'socks5' : 'http',
            host: cfg.proxy.host,
            port: cfg.proxy.port,
            // P1-15 修复：传递代理认证凭据，使 HTTP CONNECT 和 SOCKS5 隧道能使用用户名密码认证
            username: cfg.proxy.username,
            password: cfg.proxy.password
          });
        } else {
          setGlobalProxy(null);
        }
      } catch (err) {
        console.warn('[ipc] 代理设置失败:', err);
      }
      return true;
    })
  );
}
