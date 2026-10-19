/**
 * OPDS 书库浏览 IPC
 */
import { ipcMain } from 'electron';
import { unlink } from 'fs/promises';
import { XMLParser } from 'fast-xml-parser';

import * as OpdsCatalogRepo from '../db/repositories';
import type { CreateOpdsCatalogInput } from '../db/repositories';
import {
  parseOpdsFeed,
  parseOpds2Feed,
  isOpds2Json,
  buildSearchUrl,
  downloadOpdsBook,
  fetchPage,
  type OpdsCatalog
} from '../core/subscription';
import { getNetworkConfig } from '../core/network-config';
import { importFile } from '../core/importer';

import { IPC_CHANNELS, wrapHandler, assertPositiveInt, assertNonEmptyString } from './shared';

/**
 * 将 Repository 层的 OpdsCatalog（含 username/password）转换为前端使用的 OpdsCatalog（含 hasAuth 标记）
 *
 * Repository 层类型来自 db/repositories.ts，前端类型来自 core/subscription.ts，
 * 两者字段不同：前者暴露凭据明文，后者仅暴露是否有认证的布尔标记。
 */
function toFrontendCatalog(row: OpdsCatalogRepo.OpdsCatalog): OpdsCatalog {
  const catalog: OpdsCatalog = {
    id: row.id,
    name: row.name,
    url: row.url
  };
  if (row.username && row.password) {
    catalog.hasAuth = true;
  }
  return catalog;
}

/** 根据 catalogId 获取认证凭据（仅供 OPDS 请求内部使用，不暴露给前端） */
function getCatalogAuthById(catalogId: number): { username: string; password: string } | undefined {
  const row = OpdsCatalogRepo.getOpdsCatalogById(catalogId);
  if (row?.username && row?.password) {
    return { username: row.username, password: row.password };
  }
  return undefined;
}

/**
 * 使用统一 http-client 抓取 OPDS Feed
 *
 * 复用 fetchPage（来自 core/http-client，经 subscription.ts re-export），
 * 享受重试/超时/SSRF 防护/编码检测/代理支持，避免重复实现 HTTP 逻辑。
 */
async function fetchOpdsFeed(url: string, auth?: { username: string; password: string }): Promise<string> {
  const netConfig = getNetworkConfig();
  const headers: Record<string, string> = {
    Accept: 'application/atom+xml, application/xml, text/xml, */*',
    'User-Agent': netConfig.userAgent
  };
  // 添加自定义头（跳过空键/空值，避免覆盖默认头）
  for (const h of netConfig.customHeaders) {
    if (h.key && h.value) headers[h.key] = h.value;
  }
  if (auth) {
    const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  }
  const result = await fetchPage(url, {
    headers,
    timeout: 30000,
    noRetry: false
  });
  if (result.status === 401) {
    throw new Error('需要认证：请提供用户名和密码');
  }
  if (result.status === 404) {
    throw new Error('OPDS 目录不存在（404）');
  }
  if (result.status >= 400) {
    throw new Error(`OPDS 请求失败：HTTP ${result.status}`);
  }
  return result.body;
}

/** 注册 OPDS 相关 IPC handler */
export function registerOpdsIpc(): void {
  // 添加 OPDS 目录（走 Repository 层）
  ipcMain.handle(
    IPC_CHANNELS.OPDS_ADD_CATALOG,
    wrapHandler((_e, input: { name: string; url: string; username?: string; password?: string }) => {
      // 参数校验
      if (!input || typeof input !== 'object') {
        throw new Error('无效的 input：必须为对象');
      }
      assertNonEmptyString(input.name, 'name', 200);
      assertNonEmptyString(input.url, 'url', 2000);
      // URL 格式校验
      try {
        const parsed = new URL(input.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('仅支持 http/https 协议');
        }
      } catch (err) {
        throw new Error(`无效的 OPDS URL: ${(err as Error).message}`);
      }

      const repoInput: CreateOpdsCatalogInput = {
        name: input.name,
        url: input.url,
        username: input.username ?? null,
        password: input.password ?? null
      };
      const row = OpdsCatalogRepo.createOpdsCatalog(repoInput);
      return toFrontendCatalog(row);
    })
  );

  // 列出全部 OPDS 目录（走 Repository 层）
  ipcMain.handle(
    IPC_CHANNELS.OPDS_LIST_CATALOGS,
    wrapHandler(() => {
      const rows = OpdsCatalogRepo.listOpdsCatalogs();
      return rows.map(toFrontendCatalog);
    })
  );

  // 删除 OPDS 目录（走 Repository 层）
  ipcMain.handle(
    IPC_CHANNELS.OPDS_REMOVE_CATALOG,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      OpdsCatalogRepo.deleteOpdsCatalog(id);
    })
  );

  // 浏览 OPDS Feed
  ipcMain.handle(
    IPC_CHANNELS.OPDS_BROWSE,
    wrapHandler(async (_e, url: string, catalogId?: number) => {
      assertNonEmptyString(url, 'url', 2000);
      // URL 格式校验
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('仅支持 http/https 协议');
        }
      } catch (err) {
        throw new Error(`无效的 OPDS URL: ${(err as Error).message}`);
      }
      if (catalogId !== undefined) {
        assertPositiveInt(catalogId, 'catalogId');
      }
      const auth = catalogId ? getCatalogAuthById(catalogId) : undefined;
      const xmlText = await fetchOpdsFeed(url, auth);
      // 检测 OPDS 2.0 (JSON)
      if (isOpds2Json(xmlText)) {
        return parseOpds2Feed(xmlText, url);
      }
      return parseOpdsFeed(xmlText, url);
    })
  );

  // 搜索 OPDS 目录
  ipcMain.handle(
    IPC_CHANNELS.OPDS_SEARCH,
    wrapHandler(async (_e, catalogUrl: string, query: string, catalogId?: number) => {
      assertNonEmptyString(catalogUrl, 'catalogUrl', 2000);
      assertNonEmptyString(query, 'query', 500);
      // URL 格式校验
      try {
        const parsed = new URL(catalogUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('仅支持 http/https 协议');
        }
      } catch (err) {
        throw new Error(`无效的 OPDS URL: ${(err as Error).message}`);
      }
      if (catalogId !== undefined) {
        assertPositiveInt(catalogId, 'catalogId');
      }
      const auth = catalogId ? getCatalogAuthById(catalogId) : undefined;
      const rootXml = await fetchOpdsFeed(catalogUrl, auth);
      // 检测 OPDS 2.0 (JSON)
      const rootFeed = isOpds2Json(rootXml) ? parseOpds2Feed(rootXml, catalogUrl) : parseOpdsFeed(rootXml, catalogUrl);

      let searchUrl = rootFeed.searchUrl;

      if (!searchUrl) {
        for (const navLink of rootFeed.navigationLinks) {
          if (navLink.rel === 'search') {
            const navXml = await fetchOpdsFeed(navLink.href, auth);
            // 检测 OPDS 2.0 (JSON)
            const navFeed = isOpds2Json(navXml)
              ? parseOpds2Feed(navXml, navLink.href)
              : parseOpdsFeed(navXml, navLink.href);
            if (navFeed.searchUrl) {
              searchUrl = navFeed.searchUrl;
              break;
            }
          }
        }
      }

      if (!searchUrl) {
        throw new Error('该 OPDS 目录不支持搜索');
      }

      // 如果 searchUrl 不含 {searchTerms}，可能是 OpenSearch Description 文档
      // 需要先请求 OSD，从中解析出真正的搜索模板
      if (!searchUrl.includes('{searchTerms}')) {
        const osdXml = await fetchOpdsFeed(searchUrl, auth);
        // P2-15 修复：改用 fast-xml-parser 解析 OSD XML，替代正则匹配。
        // 正则匹配在属性顺序变化、CDATA 内容、命名空间前缀、自闭合标签等场景下脆弱易错，
        // XML 解析器能稳健地处理这些变体。项目已依赖 fast-xml-parser（file-parser.ts/subscription.ts 均在使用）。
        const osdParsed = new XMLParser({
          ignoreAttributes: false,
          attributeNamePrefix: '@_',
          removeNSPrefix: true,
          trimValues: true
        }).parse(osdXml);
        // OSD 根元素 <OpenSearchDescription> 下的 <Url> 元素：单条为对象、多条为数组，统一规整为数组
        const osdRoot = osdParsed?.OpenSearchDescription ?? osdParsed;
        const urlEls: Array<Record<string, unknown>> = [].concat(osdRoot?.Url ?? []);
        // 提取所有 template 字符串值（过滤掉非字符串）
        const templates: string[] = urlEls
          .map((u) => u?.['@_template'])
          .filter((t): t is string => typeof t === 'string');
        // 优先找 type="application/atom+xml" 的 template（OPDS 格式），其次任意含 {searchTerms} 的 template
        const atomUrl = urlEls.find((u) => u?.['@_type'] === 'application/atom+xml');
        const atomTemplate = typeof atomUrl?.['@_template'] === 'string' ? atomUrl['@_template'] : undefined;
        const osdTemplate = atomTemplate || templates.find((t) => t.includes('{searchTerms}'));
        if (osdTemplate && osdTemplate.includes('{searchTerms}')) {
          searchUrl = osdTemplate;
        } else {
          throw new Error('无法从 OpenSearch Description 中解析搜索模板');
        }
      }

      const actualSearchUrl = buildSearchUrl(searchUrl, query);
      const searchXml = await fetchOpdsFeed(actualSearchUrl, auth);
      // 检测 OPDS 2.0 (JSON)
      if (isOpds2Json(searchXml)) {
        return parseOpds2Feed(searchXml, actualSearchUrl);
      }
      return parseOpdsFeed(searchXml, actualSearchUrl);
    })
  );

  // 下载书籍并导入
  ipcMain.handle(
    IPC_CHANNELS.OPDS_DOWNLOAD,
    wrapHandler(
      async (e, downloadUrl: string, filename: string, format: string, catalogId?: number, groupId?: number | null) => {
        // 参数校验
        assertNonEmptyString(downloadUrl, 'downloadUrl', 2000);
        assertNonEmptyString(filename, 'filename', 500);
        if (typeof format !== 'string' || !format.trim()) {
          throw new Error('无效的 format：必须为非空字符串');
        }
        if (catalogId !== undefined) {
          assertPositiveInt(catalogId, 'catalogId');
        }
        if (groupId !== undefined && groupId !== null) {
          assertPositiveInt(groupId, 'groupId');
        }
        // 校验 URL：仅允许 http/https
        try {
          const parsed = new URL(downloadUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('仅支持 http/https 协议的下载链接');
          }
        } catch {
          throw new Error('无效的下载 URL');
        }
        // 校验 format：仅允许已知书籍格式
        const allowedFormats = ['epub', 'mobi', 'pdf', 'txt', 'azw3', 'fb2', 'unknown'];
        const safeFormat = allowedFormats.includes(format) ? format : 'txt';

        const auth = catalogId ? getCatalogAuthById(catalogId) : undefined;
        // R1修复：改用 downloadOpdsBook（含P2-11完整性校验），替代本地 downloadBookFile
        const downloadResult = await downloadOpdsBook(downloadUrl, filename, safeFormat, auth);
        const filePath = downloadResult.filePath;

        try {
          const result = await importFile(filePath, undefined, groupId ?? null);
          if (result.skipped) {
            await unlink(filePath).catch((e) => console.warn('[cleanup] 操作失败:', e));
            throw new Error(result.reason ?? '书籍已存在');
          }
          if (result.failed) {
            await unlink(filePath).catch((e) => console.warn('[cleanup] 操作失败:', e));
            throw new Error(result.error ?? '导入失败');
          }
          // 通知渲染进程刷新书架（新书已导入 DB）
          e.sender.send(IPC_CHANNELS.BOOKSHELF_REFRESH);
          return { success: true, bookId: result.book?.id };
        } catch (err) {
          await unlink(filePath).catch((e) => console.warn('[cleanup] 操作失败:', e));
          throw err;
        }
      }
    )
  );
}
