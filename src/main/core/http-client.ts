/**
 * 统一 HTTP 客户端封装
 *
 * 从 subscription.ts 的 fetchPage 逻辑提取，提供通用的 HTTP 请求能力：
 * - 重试（指数退避）
 * - 超时控制
 * - SSRF 防护（拒绝内网/本地地址）
 * - 编码检测（BOM / Content-Type / meta / jschardet）
 * - 代理支持（HTTP/HTTPS CONNECT 隧道）
 * - 请求间隔限速
 *
 * 同时保留 fetchPage 原有接口以便向后兼容。
 */

import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as dns from 'dns';
import * as iconv from 'iconv-lite';
import * as jschardet from 'jschardet';
import { join } from 'path';
import { getNetworkConfigTimeout, getNetworkConfigRetry } from './network-config';

/* ==================== 网络层文件日志 ==================== */

/**
 * 将网络层日志写入 userData/logs/network.log
 *
 * 修复 P0-13：打包后 console.error/console.warn 不可见，
 * 用文件日志诊断代理失败、SSRF 拦截、请求超时、图片下载失败等问题。
 * 参考 importer.ts 的 appendImportLog 实现。
 *
 * try-catch 包裹，日志写入失败不影响主流程。
 */
export function appendNetworkLog(message: string): void {
  try {
    // 延迟 require 避免循环依赖，且仅在主进程可用
    const { getUserDataRoot } = require('../utils') as typeof import('../utils');
    const fs = require('fs') as typeof import('fs');
    const logsDir = join(getUserDataRoot(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logPath = join(logsDir, 'network.log');
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(logPath, line, { flag: 'a' });
  } catch {
    // 日志写入失败不影响主流程
  }
}

// ═══════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_TIMEOUT = 30000;

export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY = 1000;

export const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

/** 图片请求专用头（覆盖 DEFAULT_HEADERS 中的 Sec-Fetch-*） */
export const IMAGE_FETCH_HEADERS: Record<string, string> = {
  Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
  'Sec-Fetch-Dest': 'image',
  'Sec-Fetch-Mode': 'no-cors',
  'Sec-Fetch-Site': 'cross-site'
};

/** 最大响应体大小 50MB，防止恶意服务器耗尽内存 */
export const MAX_RESPONSE_SIZE = 50 * 1024 * 1024;

const MIN_REQUEST_INTERVAL = 100;
const MAX_REQUEST_INTERVAL = 300;
let lastRequestTime = 0;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Edg/118.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
];

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

export interface ProxyConfig {
  type: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/**
 * 通用 HTTP 请求选项
 *
 * - retries：重试次数上限，默认 MAX_RETRIES；设为 0 表示不重试
 * - noRetry：为 true 时强制不重试（兼容 fetchPage 语义，等价于 retries=0）
 * - responseType：'text' 时按检测编码解码为字符串，'buffer' 时返回原始 Buffer
 * - applyInterval：是否应用全局请求间隔限速，默认 true（批量图片下载可关闭）
 * - validateSsrf：是否进行 SSRF 校验，默认 true
 * - maxResponseSize：响应体大小上限（字节），默认 MAX_RESPONSE_SIZE (50MB)；
 *   下载大文件（如书籍）时可传入更大值以放宽限制。
 */
export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  responseType?: 'text' | 'buffer';
  body?: string;
  signal?: AbortSignal;
  charset?: string;
  proxy?: ProxyConfig | null;
  noRetry?: boolean;
  includeHeaders?: boolean;
  applyInterval?: boolean;
  validateSsrf?: boolean;
  maxResponseSize?: number;
}

export interface HttpResponse {
  data: string | Buffer;
  status: number;
  headers: Record<string, string>;
  finalUrl: string;
  detectedCharset?: string;
}

/** fetchPage 原有选项（保持向后兼容） */
export interface FetchPageOptions {
  headers?: Record<string, string>;
  timeout?: number;
  includeHeaders?: boolean;
  signal?: AbortSignal;
  method?: string;
  body?: string;
  charset?: string;
  noRetry?: boolean;
  proxy?: ProxyConfig | null;
}

/** fetchPage 原有返回值（保持向后兼容） */
export interface FetchPageResult {
  status: number;
  body: string;
  headers?: Record<string, string>;
  finalUrl: string;
  detectedCharset?: string;
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function isRetryableError(err: unknown, status?: number): boolean {
  if (status !== undefined) {
    if (status >= 500 && status <= 599) return true;
    if (status === 429) return true;
    if (status >= 400 && status < 500) return false;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('abort') || msg.includes('timeout')) return true;
    if (msg.includes('econnreset') || msg.includes('econnrefused')) return true;
    if (msg.includes('enotfound') || msg.includes('etimedout')) return true;
    if (msg.includes('fetch failed') || msg.includes('network')) return true;
  }
  return false;
}

let globalProxyConfig: ProxyConfig | null = null;

export function setGlobalProxy(config: ProxyConfig | null): void {
  globalProxyConfig = config;
  if (config) {
    console.log(`[http-source] 全局代理已设置: ${config.type}://${config.host}:${config.port}`);
  } else {
    console.log('[http-source] 全局代理已清除');
  }
}

/**
 * SSRF 防护：验证 URL 是否安全
 * 拒绝非 http/https 协议、内网地址、localhost
 */
export function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    appendNetworkLog(`[SSRF] 无效的 URL: ${url}`);
    throw new Error(`无效的 URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    appendNetworkLog(`[SSRF] 不允许的协议: ${parsed.protocol} url=${url}`);
    throw new Error(`不允许的协议: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host === '::') {
    appendNetworkLog(`[SSRF] 拒绝本地地址: ${url}`);
    throw new Error('不允许请求本地地址');
  }
  if (host.startsWith('::ffff:')) {
    const ipv4Part = host.slice(7);
    const ipMatch4 = ipv4Part.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch4) {
      const [, a, b] = ipMatch4;
      const ai = Number(a),
        bi = Number(b);
      // P2 修复：复用统一 IPv4 SSRF 判定，覆盖 224/240 组播保留等地址
      if (isPrivateIPv4(ai, bi)) {
        appendNetworkLog(`[SSRF] 拒绝内网地址: ${host} url=${url}`);
        throw new Error(`不允许请求内网地址: ${host}`);
      }
    }
  }
  if (host.startsWith('2002:')) {
    const suffix = host.slice(5);
    const parts = suffix.split(':');
    if (parts.length >= 2) {
      const hex1 = parts[0];

      const a = parseInt(hex1, 16) >> 8;
      const b = parseInt(hex1, 16) & 0xff;
      // P2 修复：复用统一 IPv4 SSRF 判定，覆盖 224/240 组播保留等地址
      if (isPrivateIPv4(a, b)) {
        appendNetworkLog(`[SSRF] 拒绝内网地址(2002): ${host} url=${url}`);
        throw new Error(`不允许请求内网地址: ${host}`);
      }
    }
  }
  const ipMatch = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [, a, b] = ipMatch;
    const ai = Number(a),
      bi = Number(b);
    // P2 修复：复用统一 IPv4 SSRF 判定，覆盖 224/240 组播保留等地址
    if (isPrivateIPv4(ai, bi)) {
      appendNetworkLog(`[SSRF] 拒绝内网地址: ${host} url=${url}`);
      throw new Error(`不允许请求内网地址: ${host}`);
    }
  }
  // P1-6 修复：fe80::/10 范围检查，替换原有 fe80/fe90/fea0/feb0 前缀检查
  // 原检查遗漏 fe81-fe8f, fe91-fe9f, fea1-feaf, feb1-febf 等链路本地地址
  const ipv6Prefix = parseInt(host.slice(0, 4), 16);
  if (
    (ipv6Prefix >= 0xfc00 && ipv6Prefix <= 0xfdff) || // fc00::/7 唯一本地地址
    (ipv6Prefix >= 0xfe80 && ipv6Prefix <= 0xfebf) // fe80::/10 链路本地地址
  ) {
    appendNetworkLog(`[SSRF] 拒绝内网 IPv6 地址: ${host} url=${url}`);
    throw new Error(`不允许请求内网 IPv6 地址: ${host}`);
  }
}

/**
 * 检查 IPv4 地址是否为内网/本地/保留地址
 *
 * 统一 IPv4 SSRF 判定逻辑，供 validateUrl 和 isPrivateIp 复用，避免多处重复条件漂移。
 *
 * 覆盖的保留范围（RFC 1918 / RFC 6890 等）：
 *   - 0.0.0.0/8       本地网络（"本机"）
 *   - 10.0.0.0/8      RFC 1918 内网
 *   - 100.64.0.0/10   CGNAT（RFC 6598）
 *   - 127.0.0.0/8     回环
 *   - 169.254.0.0/16  链路本地
 *   - 172.16.0.0/12   RFC 1918 内网
 *   - 192.0.0.0/24    IETF 协议分配
 *   - 192.0.2.0/24    TEST-NET-1（文档/测试）
 *   - 192.168.0.0/16  RFC 1918 内网
 *   - 198.18.0.0/15   基准测试（RFC 2544）
 *   - 198.51.100.0/24 TEST-NET-2
 *   - 203.0.113.0/24  TEST-NET-3
 *   - 224.0.0.0/4     组播（RFC 1112，D 类）
 *   - 240.0.0.0/4     保留（E 类，含 255.255.255.255 广播）
 *
 * P2 修复：原实现遗漏 224.0.0.0/4（组播）、240.0.0.0/4（保留）、
 * 192.0.2.0/24、198.51.100.0/24、203.0.113.0/24（TEST-NET 文档地址）、
 * 192.0.0.0/24、198.18.0.0/15 等保留范围，攻击者可借此绕过 SSRF 防护。
 *
 * @param ai 第一段（0-255）
 * @param bi 第二段（0-255）
 * @returns true 表示该 IPv4 为内网/本地/保留地址，应拒绝连接
 */
function isPrivateIPv4(ai: number, bi: number): boolean {
  // 127.0.0.0/8 回环、10.0.0.0/8 内网、0.0.0.0/8 本地网络
  // 192.168.0.0/16 内网、172.16.0.0/12 内网
  // 169.254.0.0/16 链路本地（P1-17）
  // 100.64.0.0/10 CGNAT（P1-18）
  // P2 修复：补充 224.0.0.0/4 组播、240.0.0.0/4 保留、TEST-NET 等保留地址
  if (
    ai === 0 || // 0.0.0.0/8
    ai === 10 || // 10.0.0.0/8
    ai === 127 || // 127.0.0.0/8
    ai >= 224 || // 224.0.0.0/4 组播 + 240.0.0.0/4 保留（含广播）
    (ai === 100 && bi >= 64 && bi <= 127) || // 100.64.0.0/10 CGNAT
    (ai === 169 && bi === 254) || // 169.254.0.0/16 链路本地
    (ai === 172 && bi >= 16 && bi <= 31) || // 172.16.0.0/12
    (ai === 192 && bi === 0) || // 192.0.0.0/24 IETF 协议分配
    (ai === 192 && bi === 2) || // 192.0.2.0/24 TEST-NET-1
    (ai === 192 && bi === 168) || // 192.168.0.0/16
    (ai === 198 && bi === 18) || // 198.18.0.0/15 基准测试起点
    (ai === 198 && bi === 19) || // 198.19.0.0/15 基准测试
    (ai === 198 && bi === 51) || // 198.51.100.0/24 TEST-NET-2
    (ai === 203 && bi === 0) // 203.0.113.0/24 TEST-NET-3
  ) {
    return true;
  }
  return false;
}

/**
 * 检查单个 IP 地址是否为内网/本地地址（用于 DNS Rebinding 防护）
 *
 * P1-19 修复：validateUrl 只在 URL 解析时检查 hostname，但攻击者可以通过 DNS Rebinding
 * 让域名首次解析为公网 IP（通过 validateUrl），随后在实际请求时解析为内网 IP。
 * 本函数在 DNS 解析后对实际 IP 地址进行二次校验。
 *
 * @param ip DNS 解析得到的 IP 地址字符串
 * @returns true 表示该 IP 为内网/本地地址，应拒绝连接
 */
function isPrivateIp(ip: string): boolean {
  // IPv6 本地地址
  if (ip === '::1' || ip === '::' || ip === '[::1]') return true;
  // IPv6 链路本地 / 唯一本地 / 内网地址
  // P1-6 修复：fe80::/10 范围检查，替换原有 fe80/fe90/fea0/feb0 前缀检查
  // 原检查遗漏 fe81-fe8f, fe91-fe9f, fea1-feaf, feb1-febf 等链路本地地址
  const ipv6Prefix = parseInt(ip.slice(0, 4), 16);
  if (
    (ipv6Prefix >= 0xfc00 && ipv6Prefix <= 0xfdff) || // fc00::/7 唯一本地地址
    (ipv6Prefix >= 0xfe80 && ipv6Prefix <= 0xfebf) // fe80::/10 链路本地地址
  )
    return true;

  // IPv4-mapped IPv6 地址 (::ffff:x.x.x.x)
  let ipv4 = ip;
  if (ip.startsWith('::ffff:')) {
    ipv4 = ip.slice(7);
  }

  // IPv4 检查
  const ipMatch = ipv4.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipMatch) {
    const [, a, b] = ipMatch;
    const ai = Number(a),
      bi = Number(b);
    return isPrivateIPv4(ai, bi);
  }
  return false;
}

/**
 * DNS Rebinding 防护：解析 hostname 并检查实际 IP 是否为内网地址
 *
 * P1-19 修复：在发起 HTTP 请求前，先用 dns.lookup 解析 hostname，
 * 检查解析结果中的每个 IP 是否为内网地址。如果发现内网 IP，拒绝请求。
 *
 * 注意限制：
 * - Node.js 原生 fetch 不暴露 DNS 解析中间步骤，无法在 fetch 内部插入检查。
 *   本函数在 fetch 之前做预解析检查，能拦截大部分 DNS Rebinding 攻击。
 * - 但存在 TOCTOU 竞争窗口：预解析检查通过后，fetch 内部再次 DNS 解析时
 *   攻击者可能已切换到内网 IP。完整防护需要自定义 DNS 解析器或使用
 *   自定义 Agent（将 IP 固定传给 fetch），但这对 Node.js 原生 fetch 难以实现。
 * - 当前实现作为纵深防御的一层，已能显著降低 DNS Rebinding 风险。
 *
 * @param hostname 请求的 hostname
 * @param url 原始 URL（用于日志记录）
 */
async function validateDnsResolution(hostname: string, url: string): Promise<void> {
  // 如果 hostname 本身就是 IP 地址，validateUrl 已检查过，无需重复检查
  const isDirectIp = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.test(hostname) || hostname.includes(':');
  if (isDirectIp) return;

  try {
    // 使用 dns.lookup 解析，all: true 返回所有解析结果
    // family: 0 表示同时解析 IPv4 和 IPv6
    const addresses = await dns.promises.lookup(hostname, { all: true, family: 0 });
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        appendNetworkLog(
          `[SSRF-DNS-REBINDING] 拒绝 DNS 解析到内网地址: hostname=${hostname} ip=${addr.address} url=${url}`
        );
        throw new Error(`[SSRF] DNS 解析到内网地址，疑似 DNS Rebinding 攻击: ${hostname} -> ${addr.address}`);
      }
    }
  } catch (err) {
    // 如果是我们主动抛出的内网地址错误，继续向上抛
    if (err instanceof Error && err.message.includes('DNS Rebinding')) {
      throw err;
    }
    // P2 修复：DNS 解析失败时也必须拒绝请求。
    // 原实现仅记录警告并放行，存在 DNS Rebinding 竞争窗口：
    // 预解析失败（如 DNS 服务器超时）后，fetch 内部再次解析可能返回内网 IP。
    // 安全优先：解析失败一律拒绝，避免攻击者利用 DNS 抖动绕过 SSRF 防护。
    const errMsg = err instanceof Error ? err.message : String(err);
    appendNetworkLog(`[SSRF-DNS-FAIL] DNS 预解析失败，拒绝请求: hostname=${hostname} err=${errMsg}`);
    throw new Error(`[SSRF] DNS 解析失败，拒绝请求: hostname=${hostname} err=${errMsg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

let requestChain: Promise<void> = Promise.resolve();

export async function applyRequestInterval(): Promise<void> {
  const wait = requestChain.then(async () => {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    const requiredInterval = MIN_REQUEST_INTERVAL + Math.random() * (MAX_REQUEST_INTERVAL - MIN_REQUEST_INTERVAL);
    if (elapsed < requiredInterval) {
      await sleep(requiredInterval - elapsed);
    }
    lastRequestTime = Date.now();
  });
  requestChain = wait;
  await wait;
}

function normalizeCharset(charset: string): string {
  const upper = charset.toUpperCase().replace(/_/g, '-');
  const aliasMap: Record<string, string> = {
    ASCII: 'UTF-8',
    'US-ASCII': 'UTF-8',
    UTF8: 'UTF-8',
    'UTF-8-SIG': 'UTF-8',
    GB2312: 'GBK',
    'ISO-8859-1': 'LATIN1',
    'WINDOWS-1252': 'LATIN1',
    'SHIFT-JIS': 'Shift_JIS',
    SHIFTJIS: 'Shift_JIS',
    SJIS: 'Shift_JIS',
    'EUC-JP': 'EUC-JP',
    EUCJP: 'EUC-JP',
    'EUC-KR': 'EUC-KR',
    EUCKR: 'EUC-KR',
    CP949: 'CP949',
    'KS-C-5601-1987': 'CP949',
    KSC5601: 'CP949',
    'WINDOWS-949': 'CP949',
    'X-CP949': 'CP949'
  };
  return aliasMap[upper] ?? charset;
}

function detectBOM(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return 'UTF-8';
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return 'UTF-16LE';
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return 'UTF-16BE';
  }
  if (buf.length >= 4 && buf[0] === 0x84 && buf[1] === 0x31 && buf[2] === 0x95 && buf[3] === 0x33) {
    return 'GB18030';
  }
  return null;
}

function detectCharsetFromBuffer(
  buffer: Buffer,
  headers: Record<string, string> | undefined,
  explicitCharset?: string
): string {
  if (explicitCharset) {
    return normalizeCharset(explicitCharset);
  }

  if (headers) {
    const contentType = headers['content-type'] || headers['Content-Type'] || '';
    const ctMatch = contentType.match(/charset=([^\s;]+)/i);
    if (ctMatch) {
      return normalizeCharset(ctMatch[1]);
    }
  }

  const bomEncoding = detectBOM(buffer);
  if (bomEncoding) {
    return bomEncoding;
  }

  const utf8Preview = buffer.toString('utf-8', 0, Math.min(buffer.length, 4096));
  const metaMatch = utf8Preview.match(/<meta[^>]+charset=["']?([^"'\s;>]+)/i);
  if (metaMatch) {
    return normalizeCharset(metaMatch[1]);
  }

  try {
    const headBuf = buffer.subarray(0, Math.min(buffer.length, 4096));
    const result = jschardet.detect(headBuf);
    if (result && result.encoding && result.confidence >= 0.5) {
      return normalizeCharset(result.encoding);
    }
  } catch {
    // jschardet 检测失败，继续兜底
  }

  return 'UTF-8';
}

// ═══════════════════════════════════════════════════════════════
// 代理请求
// ═══════════════════════════════════════════════════════════════

/**
 * 建立 SOCKS5 隧道（修复 P0-12）
 *
 * 原实现无论 proxy.type 是 http 还是 socks5 都用 HTTP CONNECT，导致 SOCKS5 代理无法工作。
 * SOCKS5 协议（RFC 1928）分为三个阶段：
 *   1. 握手：协商认证方法（0=无认证，2=用户名密码）
 *   2. 认证：若服务器选定方法 2，发送用户名/密码（RFC 1929）
 *   3. 连接：发送 CONNECT 请求，告知目标地址和端口，服务器返回绑定地址
 *
 * @returns 已建立隧道的 net.Socket，供后续 HTTP/TLS 请求复用
 */

/**
 * R3修复：展开IPv6缩写格式（如 ::1 → 0:0:0:0:0:0:0:1）
 * SOCKS5协议要求IPv6地址为完整的16字节（8段×2字节），缩写格式需先展开
 */
function expandIPv6(addr: string): string {
  // 去掉IPv6映射的IPv4后缀（如 ::ffff:192.168.1.1）
  const v4Match = addr.match(/:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4Match) {
    const v4Parts = v4Match.slice(1).map((n) => parseInt(n, 10));
    const v4Hex = v4Parts.map((p) => p.toString(16).padStart(2, '0')).join('');
    const prefix = addr.slice(0, addr.lastIndexOf(':'));
    addr = `${prefix}:${v4Hex.slice(0, 4)}:${v4Hex.slice(4)}`;
  }
  if (!addr.includes('::')) return addr;
  const [left, right] = addr.split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const missing = 8 - leftParts.length - rightParts.length;
  return [...leftParts, ...Array(missing).fill('0'), ...rightParts].join(':');
}

function createSocks5Tunnel(
  proxy: { host: string; port: number; username?: string; password?: string },
  targetHost: string,
  targetPort: number,
  timeout: number
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let stage: 'greeting' | 'auth' | 'connect' | 'done' = 'greeting';

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error(`[http-source] SOCKS5 握手超时 (${timeout}ms)`));
    }, timeout);

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeAllListeners('data');
    };

    socket.on('error', (err) => {
      fail(new Error(`[http-source] SOCKS5 连接错误: ${err.message}`));
    });

    socket.on('close', () => {
      if (!settled && stage !== 'done') {
        fail(new Error('[http-source] SOCKS5 连接在握手阶段关闭'));
      }
    });

    socket.on('connect', () => {
      // 阶段 1：发送问候消息
      // VER=5, NMETHODS=1 或 2, METHODS=[0] 或 [0,2]
      const hasAuth = !!(proxy.username && proxy.password);
      const methods = hasAuth ? Buffer.from([0x00, 0x02]) : Buffer.from([0x00]);
      const greeting = Buffer.alloc(2 + methods.length);
      greeting[0] = 0x05; // SOCKS 版本 5
      greeting[1] = methods.length;
      methods.copy(greeting, 2);
      socket.write(greeting);
    });

    // P1-5 修复：TCP 粘包/分包处理
    // 原代码假设每次 data 事件收到完整 SOCKS5 响应，但 TCP 流可能粘包
    // （一次收到多阶段响应）或分包（一个响应分多次到达）。
    // 引入 Buffer 累积器，按协议阶段解析，不足则等待更多数据，处理完保留剩余数据。
    let recvBuffer = Buffer.alloc(0);

    socket.on('data', (data: Buffer) => {
      if (settled) return;
      recvBuffer = Buffer.concat([recvBuffer, data]);

      // 循环处理：一次 data 可能包含多个阶段的响应（粘包）
      while (recvBuffer.length > 0 && !settled) {
        if (stage === 'greeting') {
          // 服务器选择方法：VER=5, METHOD，共 2 字节
          if (recvBuffer.length < 2) return; // 等待更多数据
          if (recvBuffer[0] !== 0x05) {
            fail(new Error(`[http-source] SOCKS5 版本不匹配: ${recvBuffer[0]}`));
            return;
          }
          const method = recvBuffer[1];
          recvBuffer = recvBuffer.subarray(2); // 消费 2 字节，保留剩余
          if (method === 0x00) {
            // 无需认证，直接进入连接阶段
            sendConnectRequest();
          } else if (method === 0x02) {
            // 用户名/密码认证
            stage = 'auth';
            sendAuth();
          } else {
            fail(new Error(`[http-source] SOCKS5 服务器选择了不支持的认证方法: ${method}`));
            return;
          }
        } else if (stage === 'auth') {
          // 认证响应：VER=1, STATUS（0=成功），共 2 字节
          if (recvBuffer.length < 2) return; // 等待更多数据
          if (recvBuffer[1] !== 0x00) {
            fail(new Error(`[http-source] SOCKS5 认证失败，状态码: ${recvBuffer[1]}`));
            return;
          }
          recvBuffer = recvBuffer.subarray(2); // 消费 2 字节，保留剩余
          // 认证成功，进入连接阶段
          sendConnectRequest();
        } else if (stage === 'connect') {
          // 连接响应：VER=5, REP, RSV=0, ATYP, BND.ADDR, BND.PORT
          if (recvBuffer.length < 4) return; // 等待至少 4 字节
          if (recvBuffer[0] !== 0x05) {
            fail(new Error(`[http-source] SOCKS5 连接响应版本不匹配: ${recvBuffer[0]}`));
            return;
          }
          const rep = recvBuffer[1];
          if (rep !== 0x00) {
            const repMessages: Record<number, string> = {
              0x01: '一般性失败',
              0x02: '规则不允许的连接',
              0x03: '网络不可达',
              0x04: '主机不可达',
              0x05: '连接被拒绝',
              0x06: 'TTL 过期',
              0x07: '不支持的命令',
              0x08: '不支持的地址类型'
            };
            fail(new Error(`[http-source] SOCKS5 连接被拒绝: ${repMessages[rep] ?? `错误码 ${rep}`}`));
            return;
          }
          // 根据 ATYP 计算 BND.ADDR 长度，确定完整响应长度
          const atyp = recvBuffer[3];
          let addrLen: number;
          if (atyp === 0x01) {
            addrLen = 4; // IPv4
          } else if (atyp === 0x03) {
            // 域名：第 5 字节是域名长度
            if (recvBuffer.length < 5) return; // 等待更多数据以读取长度字段
            addrLen = 1 + recvBuffer[4]; // 1 字节长度 + N 字节域名
          } else if (atyp === 0x04) {
            addrLen = 16; // IPv6
          } else {
            fail(new Error(`[http-source] SOCKS5 不支持的 ATYP: ${atyp}`));
            return;
          }
          // 完整连接响应长度 = 4 (VER+REP+RSV+ATYP) + addrLen + 2 (BND.PORT)
          const totalLen = 4 + addrLen + 2;
          if (recvBuffer.length < totalLen) return; // 等待更多数据
          // 消费完整响应，保留剩余数据
          recvBuffer = recvBuffer.subarray(totalLen);
          // 连接成功，移交 socket 给上层
          stage = 'done';
          settled = true;
          // 若有剩余数据（握手响应与应用层数据粘包），放回 socket 流
          // 供上层重新监听 data 事件时首先收到
          if (recvBuffer.length > 0) {
            try {
              socket.unshift(recvBuffer);
            } catch {
              /* unshift 失败不影响握手已完成 */
            }
          }
          cleanup();
          resolve(socket);
        } else {
          // stage === 'done'，不应再进入循环
          return;
        }
      }
    });

    function sendAuth(): void {
      // RFC 1929 用户名/密码认证
      // VER=1, ULEN, UNAME, PLEN, PASSWD
      const userBuf = Buffer.from(proxy.username ?? '', 'utf-8');
      const passBuf = Buffer.from(proxy.password ?? '', 'utf-8');
      if (userBuf.length > 255 || passBuf.length > 255) {
        fail(new Error('[http-source] SOCKS5 用户名或密码过长（>255 字节）'));
        return;
      }
      const authReq = Buffer.alloc(3 + userBuf.length + passBuf.length);
      let offset = 0;
      authReq[offset++] = 0x01; // 认证子协议版本
      authReq[offset++] = userBuf.length;
      userBuf.copy(authReq, offset);
      offset += userBuf.length;
      authReq[offset++] = passBuf.length;
      passBuf.copy(authReq, offset);
      socket.write(authReq);
    }

    function sendConnectRequest(): void {
      // VER=5, CMD=1(CONNECT), RSV=0, ATYP, DST.ADDR, DST.PORT
      stage = 'connect';
      // 判断目标地址类型
      const isIPv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.test(targetHost);
      const isIPv6 = targetHost.includes(':');
      let addrBuf: Buffer;
      let atyp: number;
      if (isIPv4) {
        atyp = 0x01; // IPv4
        const parts = targetHost.split('.').map((p) => parseInt(p, 10));
        addrBuf = Buffer.from(parts);
      } else if (isIPv6) {
        atyp = 0x04; // IPv6
        // R3修复：正确处理IPv6缩写格式（如 ::1, 2001:db8::1）
        const expanded = expandIPv6(targetHost);
        const parts = expanded.split(':').map((seg) => parseInt(seg, 16));
        addrBuf = Buffer.from(parts.flatMap((p) => [Math.floor(p / 256), p % 256]));
      } else {
        atyp = 0x03; // 域名
        const domainBuf = Buffer.from(targetHost, 'utf-8');
        if (domainBuf.length > 255) {
          fail(new Error(`[http-source] SOCKS5 目标域名过长: ${targetHost}`));
          return;
        }
        addrBuf = Buffer.alloc(1 + domainBuf.length);
        addrBuf[0] = domainBuf.length;
        domainBuf.copy(addrBuf, 1);
      }
      const connectReq = Buffer.alloc(4 + addrBuf.length + 2);
      let offset = 0;
      connectReq[offset++] = 0x05; // SOCKS 版本 5
      connectReq[offset++] = 0x01; // CMD: CONNECT
      connectReq[offset++] = 0x00; // 保留
      connectReq[offset++] = atyp;
      addrBuf.copy(connectReq, offset);
      offset += addrBuf.length;
      connectReq.writeUInt16BE(targetPort, offset);
      socket.write(connectReq);
    }
  });
}

/**
 * 通过 HTTP CONNECT 隧道建立到目标的连接（原 fetchViaProxy 的隧道建立逻辑）
 *
 * 返回一个已建立隧道的 net.Socket，供后续 HTTP/TLS 请求复用。
 */
function createHttpConnectTunnel(
  proxy: { host: string; port: number; username?: string; password?: string },
  targetHost: string,
  targetPort: number,

  timeout: number
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proxyReq.destroy();
        reject(new Error(`[http-source] HTTP CONNECT 超时: ${timeout}ms`));
      }
    }, timeout);

    const proxyReqHeaders: Record<string, string> = {};
    if (proxy.username && proxy.password) {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
      proxyReqHeaders['Proxy-Authorization'] = `Basic ${auth}`;
    }

    const proxyReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: proxyReqHeaders
    });

    proxyReq.on('connect', (_res, socket) => {
      if (_res.statusCode !== 200) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`[http-source] 代理 CONNECT 失败: ${_res.statusCode}`));
        }
        return;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(socket);
      }
    });

    proxyReq.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    proxyReq.end();
  });
}

/**
 * 代理响应处理：从 http.IncomingMessage 收集数据并构建 HttpResponse
 *
 * 提取自 fetchViaProxy 中 HTTPS 和 HTTP 两条路径的重复代码（约65行×2）。
 * 包含响应体大小限制检查、编码检测、header 转发。
 */
function handleProxyResponse(
  response: http.IncomingMessage,
  url: string,
  options: HttpRequestOptions,
  responseType: 'text' | 'buffer',
  settled: boolean,
  timer: NodeJS.Timeout,
  resolve: (value: HttpResponse) => void,
  reject: (reason: Error) => void
): void {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  const maxResponseSize = options.maxResponseSize ?? MAX_RESPONSE_SIZE;
  response.on('data', (chunk: Buffer) => {
    totalSize += chunk.length;
    if (totalSize > maxResponseSize) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        response.destroy();
        reject(new Error(`代理响应体过大: ${totalSize} bytes (限制 ${maxResponseSize} bytes)`));
      }
      return;
    }
    chunks.push(chunk);
  });
  response.on('end', () => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      const buffer = Buffer.concat(chunks);
      if (buffer.length > maxResponseSize) {
        reject(new Error(`代理响应体过大: ${buffer.length} bytes (限制 ${maxResponseSize} bytes)`));
        return;
      }
      const charset = detectCharsetFromBuffer(buffer, response.headers as Record<string, string>, options.charset);
      let data: string | Buffer;
      if (responseType === 'buffer') {
        data = buffer;
      } else {
        try {
          data = iconv.decode(buffer, charset);
        } catch {
          data = buffer.toString('utf-8');
        }
      }
      const result: HttpResponse = {
        status: response.statusCode || 0,
        data,
        headers: {},
        finalUrl: url,
        detectedCharset: charset
      };
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === 'string') {
          result.headers[key] = value;
        } else if (Array.isArray(value)) {
          result.headers[key] = value.join(', ');
        }
      }
      resolve(result);
    }
  });
  response.on('error', (err: Error) => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

async function fetchViaProxy(
  url: string,
  options: HttpRequestOptions,
  responseType: 'text' | 'buffer'
): Promise<HttpResponse> {
  if (!globalProxyConfig) {
    throw new Error('[http-source] 代理未配置');
  }

  const targetUrl = new URL(url);
  const isHttps = targetUrl.protocol === 'https:';
  const proxy = globalProxyConfig;
  const targetHost = targetUrl.hostname;
  const targetPort = targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80;

  // 修复 P0-12：根据 proxy.type 选择不同的隧道建立方式
  //   - socks5：执行 SOCKS5 握手协议（RFC 1928）
  //   - http/https：使用 HTTP CONNECT 方法
  let tunnelSocket: net.Socket;
  const tunnelTimeout = options.timeout ?? getNetworkConfigTimeout();
  try {
    if (proxy.type === 'socks5') {
      tunnelSocket = await createSocks5Tunnel(
        { host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password },
        targetHost,
        targetPort,
        tunnelTimeout
      );
    } else {
      tunnelSocket = await createHttpConnectTunnel(
        { host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password },
        targetHost,
        targetPort,

        tunnelTimeout
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendNetworkLog(`[PROXY-FAIL] type=${proxy.type} proxy=${proxy.host}:${proxy.port} target=${url}: ${msg}`);
    throw err;
  }

  return new Promise<HttpResponse>((resolve, reject) => {
    const timeout = options.timeout ?? getNetworkConfigTimeout();
    let settled = false;
    let actualReq: http.ClientRequest | null = null;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        tunnelSocket.destroy();
        if (actualReq) {
          try {
            actualReq.destroy();
          } catch {
            /* 已销毁忽略 */
          }
        }
        const msg = `[http-source] 代理请求超时: ${timeout}ms`;
        appendNetworkLog(`[PROXY-TIMEOUT] ${msg} url=${url}`);
        reject(new Error(msg));
      }
    }, timeout);

    const actualHeaders: Record<string, string> = {
      ...DEFAULT_HEADERS,
      'User-Agent': getRandomUserAgent(),
      ...options.headers,
      // P1-7 修复：Host 头应包含端口（targetUrl.host 含端口，hostname 不含）
      // 部分代理/服务器依赖完整 Host:port 做虚拟主机路由，缺少端口会导致请求异常
      Host: targetUrl.host
    };

    if (
      options.body &&
      options.method?.toUpperCase() === 'POST' &&
      !actualHeaders['Content-Type'] &&
      !actualHeaders['content-type']
    ) {
      actualHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const reqOptions: https.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: (options.method || 'GET').toUpperCase(),
      headers: actualHeaders,
      agent: false as unknown as https.Agent
    };

    if (isHttps) {
      const tlsSocket = (require('tls') as typeof import('tls')).connect({
        socket: tunnelSocket,
        servername: targetUrl.hostname
      });
      // TLS 握手失败时 reject，避免 Promise 永久挂起
      tlsSocket.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          tunnelSocket.destroy();
          tlsSocket.destroy();
          appendNetworkLog(`[PROXY-TLS-FAIL] TLS 连接失败: ${err.message} url=${url}`);
          reject(new Error(`TLS 连接失败: ${err.message}`));
        }
      });
      actualReq = https.request({
        ...reqOptions,
        createConnection: () => tlsSocket
      });

      actualReq.on('response', (response: http.IncomingMessage) => {
        handleProxyResponse(response, url, options, responseType, settled, timer, resolve, reject);
      });

      actualReq.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      if (options.body) {
        actualReq.write(options.body);
      }
      actualReq.end();
    } else {
      actualReq = http.request({
        ...reqOptions,
        createConnection: () => tunnelSocket
      });

      actualReq.on('response', (response: http.IncomingMessage) => {
        handleProxyResponse(response, url, options, responseType, settled, timer, resolve, reject);
      });

      actualReq.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      if (options.body) {
        actualReq.write(options.body);
      }
      actualReq.end();
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// 核心请求函数
// ═══════════════════════════════════════════════════════════════

/**
 * 通用 HTTP 请求
 *
 * 统一封装重试、超时、SSRF 防护、编码检测、代理支持。
 *
 * @param url 请求 URL
 * @param options 请求选项
 * @returns 响应对象，data 为解码后的字符串或原始 Buffer
 */
export async function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  if (options.validateSsrf !== false) {
    validateUrl(url);
  }
  // P1-19 修复：DNS Rebinding 防护
  // validateUrl 只检查 URL 中的 hostname，但实际 DNS 解析可能返回内网 IP。
  // 在请求前预解析 DNS 并检查解析结果，拦截 DNS Rebinding 攻击。
  // 注意：存在 TOCTOU 竞争窗口（见 validateDnsResolution 注释），此为纵深防御措施。
  if (options.validateSsrf !== false) {
    const parsedUrl = new URL(url);
    // P2 修复：DNS 解析失败现在也拒绝请求（见 validateDnsResolution）。
    // 不再吞掉非 DNS Rebinding 错误，所有 DNS 错误一律向上抛。
    await validateDnsResolution(parsedUrl.hostname, url);
  }
  const proxyConfig = options.proxy !== undefined ? options.proxy : globalProxyConfig;
  // 超时与重试默认值来自网络配置（network-config），调用方显式指定时优先使用调用方值
  const effectiveTimeout = options.timeout ?? getNetworkConfigTimeout();
  const retryConfig = getNetworkConfigRetry();
  // P2 修复：只对幂等方法（GET/HEAD/OPTIONS）重试。
  // 非幂等方法（POST/PUT/DELETE/PATCH 等）重试会导致重复提交/删除等副作用，
  // 即使服务端返回 5xx 或网络错误也不应自动重试，除非调用方显式设置 retries > 0。
  const HTTP_IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  const methodUpper = (options.method || 'GET').toUpperCase();
  const isIdempotent = HTTP_IDEMPOTENT_METHODS.has(methodUpper);
  // 调用方显式设置 options.retries 时视为明确要求重试（如已知服务端去重），尊重其意图；
  // 否则非幂等方法自动禁用重试。
  const maxRetries = options.noRetry
    ? 0
    : options.retries !== undefined
      ? options.retries
      : isIdempotent
        ? retryConfig.count
        : 0;
  const retryBaseDelay = retryConfig.delay;
  const responseType: 'text' | 'buffer' = options.responseType ?? 'text';

  async function singleFetch(): Promise<HttpResponse> {
    if (options.applyInterval !== false) {
      await applyRequestInterval();
    }

    if (proxyConfig) {
      return fetchViaProxy(url, options, responseType);
    }

    const timeout = effectiveTimeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // 转发外部 signal 的 abort 事件，并在完成后移除监听器避免泄漏
    const onExternalAbort = (): void => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', onExternalAbort);
      }
    }

    try {
      const headers: Record<string, string> = {
        ...DEFAULT_HEADERS,
        'User-Agent': getRandomUserAgent(),
        ...options.headers
      };
      if (!headers['Referer'] && !headers['referer']) {
        try {
          headers['Referer'] = new URL(url).origin;
        } catch {}
      }
      const fetchInit: RequestInit & { redirect: 'follow' | 'error' | 'manual' } = {
        signal: controller.signal,
        headers,
        redirect: 'follow'
      };
      if (options.method) {
        fetchInit.method = options.method;
      }
      if (options.body) {
        fetchInit.body = options.body;
        if (
          options.method &&
          options.method.toUpperCase() === 'POST' &&
          !headers['Content-Type'] &&
          !headers['content-type']
        ) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      }
      const response = await fetch(url, fetchInit);

      const maxResponseSize = options.maxResponseSize ?? MAX_RESPONSE_SIZE;
      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > maxResponseSize) {
        throw new Error(`响应体过大: ${contentLength} bytes (限制 ${maxResponseSize} bytes)`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > maxResponseSize) {
        throw new Error(`响应体过大: ${buffer.length} bytes (限制 ${maxResponseSize} bytes)`);
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const charset = detectCharsetFromBuffer(buffer, responseHeaders, options.charset);

      let data: string | Buffer;
      if (responseType === 'buffer') {
        data = buffer;
      } else {
        try {
          data = iconv.decode(buffer, charset);
        } catch {
          data = buffer.toString('utf-8');
        }
      }

      return {
        status: response.status,
        data,
        headers: responseHeaders,
        finalUrl: response.url || url,
        detectedCharset: charset
      };
    } finally {
      clearTimeout(timer);
      if (options.signal && !options.signal.aborted) {
        options.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  if (maxRetries === 0) {
    return singleFetch();
  }

  let lastError: unknown = null;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw new Error('[http-source] 请求被取消');
    }

    try {
      const result = await singleFetch();
      if (isRetryableError(null, result.status) && attempt < maxRetries) {
        const delay = retryBaseDelay * Math.pow(2, attempt);
        const msg = `[http-source] HTTP ${result.status}，${delay}ms 后重试 (attempt ${attempt + 1}/${maxRetries}): ${url}`;
        console.warn(msg);
        appendNetworkLog(`[RETRY] ${msg}`);
        await sleep(delay);
        lastStatus = result.status;
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
      if (isRetryableError(err) && attempt < maxRetries) {
        const delay = retryBaseDelay * Math.pow(2, attempt);
        const errMsg = err instanceof Error ? err.message : String(err);
        const msg = `[http-source] 请求失败，${delay}ms 后重试 (attempt ${attempt + 1}/${maxRetries}): ${url}`;
        console.warn(msg, errMsg);
        appendNetworkLog(`[RETRY] ${msg} err=${errMsg}`);
        await sleep(delay);
        continue;
      }
      // 重试耗尽或不可重试错误，写入文件日志便于诊断
      appendNetworkLog(
        `[REQ-FAIL] url=${url} attempt=${attempt + 1}/${maxRetries + 1} err=${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }
  }

  if (lastError) {
    appendNetworkLog(
      `[RETRY-EXHAUSTED] url=${url} status=${lastStatus} err=${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
    throw lastError;
  }
  appendNetworkLog(`[RETRY-EXHAUSTED] url=${url} status=${lastStatus}`);
  throw new Error(`[http-source] 重试耗尽: ${url} status=${lastStatus}`);
}

// ═══════════════════════════════════════════════════════════════
// fetchPage（向后兼容包装）
// ═══════════════════════════════════════════════════════════════

/**
 * 抓取页面（向后兼容接口）
 *
 * 内部调用 httpRequest，保持原有 FetchPageOptions / FetchPageResult 接口不变。
 */
export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<FetchPageResult> {
  const response = await httpRequest(url, {
    method: options.method,
    headers: options.headers,
    timeout: options.timeout,
    body: options.body,
    signal: options.signal,
    charset: options.charset,
    noRetry: options.noRetry,
    proxy: options.proxy,
    includeHeaders: options.includeHeaders,
    responseType: 'text'
  });
  const result: FetchPageResult = {
    status: response.status,
    body: response.data as string,
    finalUrl: response.finalUrl,
    detectedCharset: response.detectedCharset
  };
  if (options.includeHeaders) {
    result.headers = response.headers;
  }
  return result;
}
