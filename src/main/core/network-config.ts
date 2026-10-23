/**
 * 网络配置模块
 *
 * 从 ipc.ts 提取的网络配置相关逻辑，供主进程各模块共享：
 * - NetworkConfig 类型定义（与前端 NetworkConfig 对应，存储在 settings 表 key='network_config'）
 * - getNetworkConfig()：读取网络配置（带缓存）
 * - getNetworkConfigHeaders()：返回包含 User-Agent 和自定义头的请求头对象
 * - clearNetworkConfigCache()：清空缓存（setNetworkConfig 时调用）
 *
 * 数据来源：settings 表，通过 SettingsRepo（../db/repositories）读写。
 */

import * as SettingsRepo from '../db/repositories';

/**
 * 网络配置类型（与前端 NetworkConfig 对应，存储在 settings 表 key='network_config'）
 *
 * 字段说明：
 *   - userAgent：HTTP 请求 User-Agent 头
 *   - customHeaders：自定义 HTTP 头列表（键值对）
 *   - proxy：代理配置（enabled/type/host/port/username/password）
 *   - timeout：连接超时（毫秒），默认 30000
 *   - retryCount：重试次数，默认 3
 *   - retryDelay：重试间隔（毫秒），默认 1000
 */
export interface NetworkConfig {
  userAgent: string;
  customHeaders: Array<{ key: string; value: string }>;
  // P1-15 修复：proxy 增加 username/password 可选字段，支持代理认证
  proxy: {
    enabled: boolean;
    type: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
  };
  timeout: number;
  retryCount: number;
  retryDelay: number;
}

/** 网络配置默认值（首次访问或解析失败时使用） */
const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  customHeaders: [],
  proxy: { enabled: false, type: 'http', host: '', port: 0 },
  timeout: 30000,
  retryCount: 3,
  retryDelay: 1000
};

/** 网络配置缓存（避免每次请求都查 DB；setNetworkConfig 时清空） */
let networkConfigCache: NetworkConfig | null = null;

/**
 * 读取网络配置（带缓存）
 *
 * - 首次调用从 settings 表读取，解析失败时使用默认值
 * - 后续调用直接返回缓存
 * - setNetworkConfig 时清空缓存，下次调用重新读取
 */
export function getNetworkConfig(): NetworkConfig {
  if (networkConfigCache) return networkConfigCache;
  try {
    const raw = SettingsRepo.getSetting('network_config');
    if (raw) {
      const parsed = JSON.parse(raw) as NetworkConfig;
      // 防御性校验：确保必要字段存在，避免老数据/坏数据导致请求失败
      networkConfigCache = {
        userAgent: typeof parsed.userAgent === 'string' ? parsed.userAgent : DEFAULT_NETWORK_CONFIG.userAgent,
        customHeaders: Array.isArray(parsed.customHeaders) ? parsed.customHeaders : [],
        proxy: {
          enabled: !!parsed.proxy?.enabled,
          type: parsed.proxy?.type === 'socks5' ? 'socks5' : 'http',
          host: typeof parsed.proxy?.host === 'string' ? parsed.proxy.host : '',
          port: typeof parsed.proxy?.port === 'number' ? parsed.proxy.port : 0,
          // P1-15 修复：传递代理认证凭据（可选字段，仅在配置了用户名密码时生效）
          username: typeof parsed.proxy?.username === 'string' ? parsed.proxy.username : undefined,
          password: typeof parsed.proxy?.password === 'string' ? parsed.proxy.password : undefined
        },
        // timeout 必须为正数；否则回退默认值
        timeout:
          typeof parsed.timeout === 'number' && parsed.timeout > 0 ? parsed.timeout : DEFAULT_NETWORK_CONFIG.timeout,
        // retryCount 必须 >= 0；否则回退默认值
        retryCount:
          typeof parsed.retryCount === 'number' && parsed.retryCount >= 0
            ? parsed.retryCount
            : DEFAULT_NETWORK_CONFIG.retryCount,
        // retryDelay 必须 >= 0；否则回退默认值
        retryDelay:
          typeof parsed.retryDelay === 'number' && parsed.retryDelay >= 0
            ? parsed.retryDelay
            : DEFAULT_NETWORK_CONFIG.retryDelay
      };
    } else {
      networkConfigCache = { ...DEFAULT_NETWORK_CONFIG };
    }
  } catch {
    networkConfigCache = { ...DEFAULT_NETWORK_CONFIG };
  }
  return networkConfigCache!;
}

/**
 * 获取网络配置请求头（User-Agent + 自定义头）
 *
 * 返回包含 User-Agent 和所有自定义头的对象，供 HTTP 请求直接合并使用。
 * 跳过空键/空值的自定义头，避免覆盖调用方设置的默认头。
 */
export function getNetworkConfigHeaders(): { 'User-Agent': string; [key: string]: string } {
  const cfg = getNetworkConfig();
  const headers: { 'User-Agent': string; [key: string]: string } = {
    'User-Agent': cfg.userAgent
  };
  for (const h of cfg.customHeaders) {
    if (h.key && h.value) headers[h.key] = h.value;
  }
  return headers;
}

/**
 * 清空网络配置缓存
 *
 * 在 setNetworkConfig 持久化新配置后调用，确保下次 getNetworkConfig() 重新从 DB 读取。
 */
export function clearNetworkConfigCache(): void {
  networkConfigCache = null;
}
/**
 * 获取连接超时（毫秒）
 *
 * 供 HTTP 客户端在调用方未指定 timeout 时作为默认值使用。
 * 始终返回正数（getNetworkConfig 已做防御性校验）。
 */
export function getNetworkConfigTimeout(): number {
  return getNetworkConfig().timeout;
}

/**
 * 获取重试配置
 *
 * 供 HTTP 客户端在调用方未指定重试参数时作为默认值使用。
 * - count：重试次数上限（>= 0）
 * - delay：重试间隔基础值（毫秒，>= 0）
 */
export function getNetworkConfigRetry(): { count: number; delay: number } {
  const cfg = getNetworkConfig();
  return { count: cfg.retryCount, delay: cfg.retryDelay };
}
