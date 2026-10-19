/**
 * utils.ts — 工具函数合并模块
 *
 * 合并自原 utils/ 目录下的 5 个文件：
 * - encoding.ts（编码检测与转换）
 * - html-semantic.ts（HTML语义化标记转换）
 * - paths.ts（数据目录路径管理）
 * - t2s.ts（繁简转换）
 * - text-format.ts（智能排版）
 */

// ============== 外部依赖 ==============
import { promises as fsPromises } from 'fs';
import * as jschardet from 'jschardet';
import * as iconv from 'iconv-lite';
import { app } from 'electron';
import { join, dirname, isAbsolute, resolve, sep } from 'path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  accessSync,
  constants,
  renameSync,
  cpSync,
  rmSync,
  readdirSync
} from 'fs';

// ================================================================
// encoding.ts — 文件编码检测与转换
// ================================================================

/** 检测时读取的文件头字节数（4KB 足以识别编码特征） */
const DETECT_BUFFER_SIZE = 4096;

/** 置信度阈值：低于此值时使用默认编码 */
const CONFIDENCE_THRESHOLD = 0.5;

/** 中文小说默认编码（置信度低或检测失败时兜底） */
const DEFAULT_ENCODING = 'GBK';

/**
 * 规范化编码名称为 iconv-lite 可识别的格式
 */
export function normalizeEncoding(encoding: string): string {
  const upper = encoding.toUpperCase().replace(/_/g, '-');

  const aliasMap: Record<string, string> = {
    ASCII: 'UTF-8',
    'US-ASCII': 'UTF-8',
    UTF8: 'UTF-8',
    'UTF-8-SIG': 'UTF-8',
    GB2312: 'GBK',
    'ISO-8859-1': 'LATIN1',
    'WINDOWS-1252': 'LATIN1',
    // 日文编码别名统一
    'SHIFT-JIS': 'Shift_JIS',
    SHIFTJIS: 'Shift_JIS',
    SJIS: 'Shift_JIS',
    'EUC-JP': 'EUC-JP',
    EUCJP: 'EUC-JP',
    // 韩文编码别名统一（CP949 是 EUC-KR 的超集，韩文 Windows 默认编码）
    'EUC-KR': 'EUC-KR',
    EUCKR: 'EUC-KR',
    CP949: 'CP949',
    'KS-C-5601-1987': 'CP949',
    KSC5601: 'CP949',
    'WINDOWS-949': 'CP949',
    'X-CP949': 'CP949'
  };

  return aliasMap[upper] ?? encoding;
}

/**
 * 检测文件头是否有 BOM（Byte Order Mark），有则直接返回对应编码
 */
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

/**
 * 检测文件编码
 *
 * @param filePath 文件绝对路径
 * @returns iconv-lite 可识别的编码名称
 * @throws 文件不存在或读取失败时抛出 Error
 */
export async function detectEncoding(filePath: string): Promise<string> {
  // Windows 上文件刚复制完可能被系统（Defender 等）短暂锁定，
  // 导致 fsPromises.open 抛出 EBUSY。添加重试机制规避此竞态。
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 200;
  let handle;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      handle = await fsPromises.open(filePath, 'r');
      break;
    } catch (err: any) {
      if (err.code === 'EBUSY' && attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  if (!handle) throw new Error(`无法打开文件: ${filePath}`);
  try {
    const buffer = Buffer.alloc(DETECT_BUFFER_SIZE);
    const { bytesRead } = await handle.read(buffer, 0, DETECT_BUFFER_SIZE, 0);
    const headBuf = buffer.subarray(0, bytesRead);

    if (headBuf.length === 0) {
      return DEFAULT_ENCODING;
    }

    // 1. BOM 优先检测（最可靠）
    const bomEncoding = detectBOM(headBuf);
    if (bomEncoding) {
      return bomEncoding;
    }

    // 2. jschardet 统计推断
    const result = jschardet.detect(headBuf);

    if (!result || !result.encoding || result.confidence < CONFIDENCE_THRESHOLD) {
      // jschardet 检测失败时，对中文TXT文件回退到GBK而非UTF-8
      //   见于27txt.com制作的TXT文件：头部全是ASCII(===分隔线+网站信息)，
      //   jschardet返回null/低置信度，但文件内容实际是GBK编码
      //   GBK是ASCII的超集，ASCII头部用GBK解码完全正确，
      //   且GBK是中文TXT最常见的编码，作为回退比UTF-8更合理
      return 'gbk';
    }

    return normalizeEncoding(result.encoding);
  } finally {
    await handle.close();
  }
}

/**
 * 将 Buffer 按指定编码解码为 UTF-8 字符串
 */
export function decodeBuffer(buf: Buffer, encoding: string): string {
  const text = iconv.decode(buf, encoding);
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

/**
 * 将 UTF-8 字符串编码为指定编码的 Buffer
 */
export function encodeBuffer(content: string, encoding: string): Buffer {
  return iconv.encode(content, encoding);
}

// ================================================================
// html-semantic.ts — HTML 语义标签 → 富文本标记转换
// ================================================================

/**
 * 将语义 HTML 标签转为富文本特殊标记（在去所有 HTML 标签前调用）。
 */
export function convertSemanticHtmlToMarkers(html: string): string {
  let text = html;

  // 1. <pre>...</pre> → [CODE]内容[/CODE]
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, content: string) => {
    const codeText = content.replace(/<[^>]+>/g, '');
    if (codeText.trim()) {
      return `\n[CODE]${codeText}[/CODE]\n`;
    }
    return '';
  });

  // 2. <blockquote>...</blockquote> → [QUOTE]内容[/QUOTE]
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, content: string) => {
    const quoteText = content.replace(/<[^>]+>/g, '');
    if (quoteText.trim()) {
      return `\n[QUOTE]${quoteText}[/QUOTE]\n`;
    }
    return '';
  });

  // 3. <table>...</table> → [TABLE]原始HTML[/TABLE]
  text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_match, content: string) => {
    let cleanHtml = content
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
      .replace(/<object[\s\S]*?<\/object>/gi, '')
      .replace(/<embed[^>]*>/gi, '')
      .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');
    cleanHtml = `<table>${cleanHtml}</table>`;
    return `\n[TABLE]${cleanHtml}[/TABLE]\n`;
  });

  // 4. <h1>~<h6> → [H1]~[/H1] ... [H6]~[/H6]
  for (let level = 1; level <= 6; level++) {
    text = text.replace(
      new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, 'gi'),
      (_match: string, content: string) => {
        const headingText = content.replace(/<[^>]+>/g, '').trim();
        if (headingText) {
          return `\n[H${level}]${headingText}[/H${level}]\n`;
        }
        return '';
      }
    );
  }

  // 5. <li>...</li> → [LI]文本[/LI]
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, content: string) => {
    const itemText = content.replace(/<[^>]+>/g, '').trim();
    if (itemText) {
      return `\n[LI]${itemText}[/LI]\n`;
    }
    return '';
  });

  // 6. <strong>...</strong> / <b>...</b> → **文本**
  text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_match, content: string) => {
    if (content.trim()) {
      return `**${content}**`;
    }
    return '';
  });

  // 7. <em>...</em> / <i>...</i> → *文本*
  text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_match, content: string) => {
    if (content.trim()) {
      return `*${content}*`;
    }
    return '';
  });

  // 8. <a href="url">文本</a> → [LINK:url]文本[/LINK]
  text = text.replace(
    /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, content: string) => {
      if (!/^https?:\/\//i.test(href)) {
        return content;
      }
      if (content.trim()) {
        return `[LINK:${href}]${content}[/LINK]`;
      }
      return '';
    }
  );

  // 9. 行内语义标签 → 标记格式（在去所有 HTML 标签前处理）
  //    EPUB/MOBI 不止纯文字小说，还有技术文档/学术书籍/杂志等，
  //    <sub>/<sup>/<u>/<del>/<mark>/<code>/<q>/<kbd>/<cite> 等标签有语义价值，不能被步骤5移除
  //    转为不含尖括号的标记，不受后续 text.replace(/<[^>]+>/g, '') 影响

  // <sub> → [SUB]，<sup> → [SUP]（数学/化学公式：H₂O, x²）
  text = text.replace(/<sub[^>]*>([\s\S]*?)<\/sub>/gi, (_m, c: string) => (c.trim() ? `[SUB]${c}[/SUB]` : ''));
  text = text.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, (_m, c: string) => (c.trim() ? `[SUP]${c}[/SUP]` : ''));

  // <u> → [U]（下划线）
  text = text.replace(/<u[^>]*>([\s\S]*?)<\/u>/gi, (_m, c: string) => (c.trim() ? `[U]${c}[/U]` : ''));

  // <del>/<s>/<strike> → [DEL]（删除线）
  text = text.replace(/<(?:del|s|strike)[^>]*>([\s\S]*?)<\/(?:del|s|strike)>/gi, (_m, c: string) =>
    c.trim() ? `[DEL]${c}[/DEL]` : ''
  );

  // <mark> → [MARK]（高亮）
  text = text.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, (_m, c: string) => (c.trim() ? `[MARK]${c}[/MARK]` : ''));

  // <code> → [ICODE]（行内代码，区别于 <pre> 的块级代码 [CODE]）
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c: string) => (c.trim() ? `[ICODE]${c}[/ICODE]` : ''));

  // <q> → [Q]（行内引用），<kbd> → [KBD]（键盘输入），<cite> → [CITE]（引用来源）
  text = text.replace(/<q[^>]*>([\s\S]*?)<\/q>/gi, (_m, c: string) => (c.trim() ? `[Q]${c}[/Q]` : ''));
  text = text.replace(/<kbd[^>]*>([\s\S]*?)<\/kbd>/gi, (_m, c: string) => (c.trim() ? `[KBD]${c}[/KBD]` : ''));
  text = text.replace(/<cite[^>]*>([\s\S]*?)<\/cite>/gi, (_m, c: string) => (c.trim() ? `[CITE]${c}[/CITE]` : ''));

  // 10. 列表/定义列表容器及补充块级/行内语义标签
  //    ol/ul 容器内已有 [LI] 标记（步骤5处理），此处只保留容器结构
  //    dt/dd 内容需去 HTML 标签，避免内嵌标签干扰

  // <hr> → [HR]（水平线）
  text = text.replace(/<hr\s*\/?>/gi, '\n[HR]\n');

  // <ol>...</ol> → [OL]...[/OL]（有序列表容器）
  text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_match, content: string) => {
    if (content.trim()) return `\n[OL]${content}[/OL]\n`;
    return '';
  });

  // <ul>...</ul> → [UL]...[/UL]（无序列表容器）
  text = text.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_match, content: string) => {
    if (content.trim()) return `\n[UL]${content}[/UL]\n`;
    return '';
  });

  // <dl>...</dl> → [DL]...[/DL]（定义列表）
  text = text.replace(/<dl[^>]*>([\s\S]*?)<\/dl>/gi, (_match, content: string) => {
    if (content.trim()) return `\n[DL]${content}[/DL]\n`;
    return '';
  });

  // <dt>...</dt> → [DT]...[/DT]（定义术语）
  text = text.replace(/<dt[^>]*>([\s\S]*?)<\/dt>/gi, (_match, content: string) => {
    const dtText = content.replace(/<[^>]+>/g, '').trim();
    if (dtText) return `\n[DT]${dtText}[/DT]\n`;
    return '';
  });

  // <dd>...</dd> → [DD]...[/DD]（定义描述）
  text = text.replace(/<dd[^>]*>([\s\S]*?)<\/dd>/gi, (_match, content: string) => {
    const ddText = content.replace(/<[^>]+>/g, '').trim();
    if (ddText) return `\n[DD]${ddText}[/DD]\n`;
    return '';
  });

  // <abbr>...</abbr> → [ABBR]...[/ABBR]（缩写）
  text = text.replace(/<abbr[^>]*>([\s\S]*?)<\/abbr>/gi, (_match, content: string) => {
    if (content.trim()) return `[ABBR]${content}[/ABBR]`;
    return '';
  });

  // <dfn>...</dfn> → [DFN]...[/DFN]（定义）
  text = text.replace(/<dfn[^>]*>([\s\S]*?)<\/dfn>/gi, (_match, content: string) => {
    if (content.trim()) return `[DFN]${content}[/DFN]`;
    return '';
  });

  // <samp>...</samp> → [SAMP]...[/SAMP]（样本输出）
  text = text.replace(/<samp[^>]*>([\s\S]*?)<\/samp>/gi, (_match, content: string) => {
    if (content.trim()) return `[SAMP]${content}[/SAMP]`;
    return '';
  });

  // <var>...</var> → [VAR]...[/VAR]（变量）
  text = text.replace(/<var[^>]*>([\s\S]*?)<\/var>/gi, (_match, content: string) => {
    if (content.trim()) return `[VAR]${content}[/VAR]`;
    return '';
  });

  return text;
}

/**
 * 判断段落是否为富文本块级标记行（不缩进）。
 */
export function isRichTextBlockMarker(para: string): boolean {
  return /^\[(CODE|QUOTE|TABLE|H[1-6]|LI|HR|OL|UL|DL|DT|DD)\]/.test(para);
}

// ================================================================
// paths.ts — 数据目录路径管理
// ================================================================

/** 书籍文件类型 */
export type BookFileType = 'txt' | 'epub' | 'mobi' | 'pdf' | 'comic';

/** 数据根目录 */
let _dataRoot: string | null = null;

/**
 * youdu-config.json 结构（存于 Electron userData 目录）
 *
 * 该文件是自定义数据根目录的唯一入口，必须固定放在 app.getPath('userData')：
 * 自定义 dataRoot 尚未生效（或配置指向的目录被删）时，仍能在这里找到配置。
 */
interface YouduConfig {
  /** 自定义数据根目录（绝对路径） */
  dataRoot?: string;
}

/** youdu-config.json 固定路径：Electron userData 目录（不随 dataRoot 变化） */
function getYouduConfigFile(): string {
  return join(app.getPath('userData'), 'youdu-config.json');
}

/**
 * 读取配置文件中的自定义数据根目录
 *
 * @returns 有效的自定义路径（非空绝对路径且目录存在），否则 null
 */
export function getConfigDataRoot(): string | null {
  try {
    const configFile = getYouduConfigFile();
    if (!existsSync(configFile)) return null;
    const parsed = JSON.parse(readFileSync(configFile, 'utf-8')) as Partial<YouduConfig>;
    const root = parsed?.dataRoot;
    if (typeof root !== 'string' || !root.trim() || !isAbsolute(root)) return null;
    return root;
  } catch (err) {
    console.warn('[paths] 读取 youdu-config.json 失败（忽略自定义数据目录）:', err);
    return null;
  }
}

/**
 * 写入自定义数据根目录到 youdu-config.json（合并保留其他字段），并同步更新内存缓存
 *
 * 调用方需先确保新目录已存在且数据已复制完成——本函数只写配置不搬数据。
 * 同时刷新 _dataRoot 缓存，使后续 getUserDataRoot()/getDbPath()/getBooksRoot()
 * 立即返回新路径——这对数据迁移后 initDatabase() 重新打开新路径的 youdu.db
 * 至关重要，否则 _dataRoot 仍指向旧目录，当前会话继续写旧库，重启后丢失。
 */
export function setDataRoot(dataRoot: string): void {
  const configFile = getYouduConfigFile();
  let existing: YouduConfig = {};
  try {
    if (existsSync(configFile)) {
      existing = JSON.parse(readFileSync(configFile, 'utf-8')) as YouduConfig;
    }
  } catch {
    // 现有配置损坏时从空对象开始，避免写入失败
    existing = {};
  }
  writeFileSync(configFile, JSON.stringify({ ...existing, dataRoot }, null, 2), 'utf-8');
  // 同步内存缓存：让 getUserDataRoot() 立即返回新路径
  _dataRoot = dataRoot;
}

export function getUserDataRoot(): string {
  if (_dataRoot) return _dataRoot;

  // 优先使用 youdu-config.json 中配置的自定义数据根目录。
  // 配置文件固定在 Electron userData 目录，自定义目录未生效前也能找到；
  // 仅当配置为非空绝对路径且目录存在时生效，否则回退默认逻辑（不创建、不覆盖）。
  const configured = getConfigDataRoot();
  if (configured && existsSync(configured)) {
    _dataRoot = configured;
    return _dataRoot;
  }

  if (app.isPackaged) {
    // 默认数据目录按平台选择（解决 Linux/Mac 下 exe/data 不可写或升级丢失问题）：
    //   Win:   exe 同级 data/（安装到用户目录可写，便携版与安装版路径逻辑统一）
    //   Linux: ~/.local/share/youdu/（XDG_DATA_HOME 优先；/opt 不可写、/tmp/.mount 只读）
    //   Mac:   ~/Library/Application Support/youdu/（= app.getPath('userData')，
    //          .app 内部升级时被覆盖会丢数据，故用 Apple 标准应用数据目录）
    // 不可写位置会 fallback 到 app.getPath('userData')（见 resolveWritableDataRoot）。
    let candidate: string;
    if (process.platform === 'win32') {
      // Windows: exe 同级 data/（便携版与安装版路径逻辑统一）
      candidate = join(dirname(process.execPath), 'data');
    } else if (process.platform === 'linux') {
      // Linux: XDG 数据目录（~/.local/share/youdu/）
      // 不用 exe/data：/opt 不可写（deb），/tmp/.mount 只读（AppImage）
      // XDG_DATA_HOME 环境变量优先，默认 ~/.local/share/youdu/
      const xdgData = process.env.XDG_DATA_HOME || join(app.getPath('home'), '.local', 'share');
      candidate = join(xdgData, 'youdu');
    } else if (process.platform === 'darwin') {
      // macOS: ~/Library/Application Support/youdu/
      // 不用 .app 内部：升级时整个 .app 被覆盖，数据会丢失
      // app.getPath('userData') 在 Mac 上默认就是此路径
      candidate = app.getPath('userData');
    } else {
      // 其他平台 fallback：exe 同级 data/
      candidate = join(dirname(process.execPath), 'data');
    }
    _dataRoot = resolveWritableDataRoot(candidate);
    // 首次升级到本版本：把旧 AppData/youdu 书库剪切迁移到新平台默认目录，
    // 并在 Linux/Mac 上把旧 exe/data 书库也迁移过来（Windows 仍用 exe/data 不需迁移）。
    // 数据库此时尚未打开（getUserDataRoot 在 initDatabase 之前调用），无需
    // closeDatabase；任何失败都不阻断启动（继续用空目录，用户可在设置页手动迁移）。
    migrateLegacyAppDataRoot(_dataRoot);
  } else {
    // 开发模式：项目根目录 data/
    _dataRoot = join(process.cwd(), 'data');
  }

  if (!existsSync(_dataRoot)) {
    mkdirSync(_dataRoot, { recursive: true });
  }

  return _dataRoot;
}

/**
 * 解析可写数据根目录：优先用 candidate，不可写时 fallback 到 Electron userData。
 *
 * candidate 由 getUserDataRoot 按平台选择（Win=exe/data、Linux=~/.local/share/youdu/、
 * Mac=app.getPath('userData')）。Program Files、/opt、只读挂载等位置无法写入，
 * 需回退到 app.getPath('userData')（=%APPDATA%/youdu，已在 index.ts 启动期固定），
 * 否则书库初始化会因 EPERM 失败导致应用无法启动。fallback 时打印 warn 便于用户排查。
 */
function resolveWritableDataRoot(candidate: string): string {
  try {
    mkdirSync(candidate, { recursive: true });
    accessSync(candidate, constants.W_OK);
    return candidate;
  } catch {
    // candidate 不可写（如装在 Program Files、/opt、只读挂载）——回退到 Electron userData
    const fallback = app.getPath('userData');
    console.warn(`[paths] 默认数据目录不可写，回退到 Electron userData: ${candidate} -> ${fallback}`);
    if (!existsSync(fallback)) {
      mkdirSync(fallback, { recursive: true });
    }
    return fallback;
  }
}

/**
 * 启动迁移待重写的路径信息。
 *
 * migrateLegacyAppDataRoot 在实际执行迁移后设置此标志，
 * 由 index.ts 在 initDatabase 之后读取并调用 rewriteBookPaths 重写数据库中的绝对路径，
 * 重写完成后由 clearPendingPathRewrite 清空。
 *
 * 只在迁移实际发生时设置（不是每次调用都设置），避免误重写。
 */
let _pendingPathRewrite: { oldRoot: string; newRoot: string } | null = null;

/**
 * 获取待重写的路径信息（供 index.ts 在 initDatabase 后检查）。
 * 返回 null 表示无待重写（未发生迁移或已处理）。
 */
export function getPendingPathRewrite(): { oldRoot: string; newRoot: string } | null {
  return _pendingPathRewrite;
}

/**
 * 清除待重写标志（重写完成后调用，避免下次启动重复重写）。
 */
export function clearPendingPathRewrite(): void {
  _pendingPathRewrite = null;
}

/**
 * 从旧书库剪切迁移到新数据根目录（平台默认目录或 fallback 目标）。
 *
 * 按顺序尝试两个来源（任一成功后 target 已有 youdu.db 即停止）：
 * 1. 旧 AppData/youdu（0.x~1.x 版本默认书库在 Electron userData=%APPDATA%/youdu）
 * 2. 旧 exe/data（仅 Linux/Mac；旧版本用 exe/data，Windows 仍用 exe/data 不需迁移）
 *
 * 和设置页"更改数据目录"（ipc/app.ts APP_MIGRATE_DATA）一致采用剪切语义
 * （rename，跨磁盘 EXDEV 时 cp+rm），移动后清理旧目录残留数据文件。
 *
 * 触发条件：target 不含 youdu.db 且旧目录含 youdu.db（一次性）。
 *
 * 关键约束：
 * - 数据库此时尚未打开，无需 closeDatabase（与 app.ts 迁移不同）
 * - 不写 youdu-config.json（这是默认目录变更，不是用户自定义）
 * - 不发 IPC 事件（窗口尚未创建）
 * - 移动 books/covers/youdu.db + WAL 侧车（-wal/-shm）
 * - 不删 AppData/youdu 目录本身（Electron 仍需它存 youdu-config.json 等配置），
 *   只删其下 books/covers/youdu.db*
 * - 路径重叠时跳过（如 fallback 到 userData 时 target===legacy）
 * - 任何失败都不阻断启动（继续用空目录，用户可在设置页手动迁移）
 */
/**
 * 同步删除并重试（Windows 上文件可能被短暂占用，如杀软扫描）。
 * 用 Atomics.wait 做同步延迟（Node.js 主线程可用，会阻塞事件循环，
 * 但此函数仅在启动迁移时调用，总等待 ≤1.2s 可接受）。
 */
function rmSyncWithRetry(target: string, maxRetries = 3): void {
  for (let i = 0; i < maxRetries; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1));
    }
  }
}

function migrateLegacyAppDataRoot(targetRoot: string): void {
  if (existsSync(join(targetRoot, 'youdu.db'))) return; // 目标已有书库，无需迁移

  const resolvedTarget = resolve(targetRoot);

  // 1. 从旧 AppData/youdu 迁移（0.x~1.x 版本默认书库在 Electron userData）
  const legacyRoot = app.getPath('userData');
  const legacyDb = join(legacyRoot, 'youdu.db');
  if (existsSync(legacyDb)) {
    // 防重叠：target 不能等于/包含/被包含于 legacy（如 fallback 到 userData 时）
    const resolvedLegacy = resolve(legacyRoot);
    if (
      resolvedTarget !== resolvedLegacy &&
      !resolvedTarget.startsWith(resolvedLegacy + sep) &&
      !resolvedLegacy.startsWith(resolvedTarget + sep)
    ) {
      try {
        mkdirSync(targetRoot, { recursive: true });
        // 移动旧目录下所有内容到新目录（除了 youdu-config.json 配置指针）。
        // 用 readdirSync 动态列举，确保不遗漏任何子目录（rss-images/images/logs 等）。
        for (const entry of readdirSync(legacyRoot)) {
          if (entry === 'youdu-config.json') continue; // 保留配置指针
          moveEntrySync(join(legacyRoot, entry), join(targetRoot, entry));
        }
        console.info('[migration] 书库已从 AppData 剪切迁移到平台默认目录:', legacyRoot, '->', targetRoot);

        // 标记待重写路径：迁移后数据库中的绝对路径仍指向旧目录，
        // 由 index.ts 在 initDatabase 后调用 rewriteBookPaths 重写。
        _pendingPathRewrite = { oldRoot: legacyRoot, newRoot: targetRoot };

        // 清理旧目录残留（rename 已移走，这里兜底删未被列入的残留文件）。
        // 不删 legacyRoot 本身（Electron 仍需它存 youdu-config.json）。
        for (const entry of readdirSync(legacyRoot)) {
          if (entry === 'youdu-config.json') continue;
          const oldEntry = join(legacyRoot, entry);
          if (existsSync(oldEntry)) {
            try {
              rmSyncWithRetry(oldEntry);
            } catch (rmErr) {
              console.warn(`[migration] 清理旧目录残留 ${entry} 失败:`, rmErr);
            }
          }
        }
      } catch (err) {
        // 迁移失败不阻断启动：继续用空 targetRoot，用户可在设置页手动迁移
        console.warn('[migration] AppData -> 平台默认目录 迁移失败（继续用空目录启动）:', err);
      }
    }
  }

  // 2. 仅 Linux/Mac：从旧 exe/data 迁移到新平台默认目录
  //    Windows 仍然用 exe/data，不需要迁移
  //    AppData 迁移成功后 target 已有 db，此处跳过（一次性）
  if (process.platform !== 'win32' && !existsSync(join(targetRoot, 'youdu.db'))) {
    const exeDataDir = join(dirname(process.execPath), 'data');
    const exeDb = join(exeDataDir, 'youdu.db');
    if (existsSync(exeDb)) {
      // 防重叠：exe/data 不能等于/包含/被包含于 target
      const resolvedExeData = resolve(exeDataDir);
      if (
        resolvedExeData !== resolvedTarget &&
        !resolvedExeData.startsWith(resolvedTarget + sep) &&
        !resolvedTarget.startsWith(resolvedExeData + sep)
      ) {
        try {
          mkdirSync(targetRoot, { recursive: true });
          for (const entry of readdirSync(exeDataDir)) {
            moveEntrySync(join(exeDataDir, entry), join(targetRoot, entry));
          }
          console.info('[migration] 书库已从 exe/data 迁移到平台默认目录:', exeDataDir, '->', targetRoot);
          // 标记待重写路径：迁移后数据库中的绝对路径仍指向旧 exe/data，
          // 由 index.ts 在 initDatabase 后调用 rewriteBookPaths 重写。
          _pendingPathRewrite = { oldRoot: exeDataDir, newRoot: targetRoot };
          // 清理旧 exe/data：先删其下所有残留条目，再删 exe/data 目录本身。
          // 语义：剪切——旧目录无论空不空都删除，避免用户看到旧目录以为迁移没成功。
          for (const entry of readdirSync(exeDataDir)) {
            const oldEntry = join(exeDataDir, entry);
            if (existsSync(oldEntry)) {
              try {
                rmSyncWithRetry(oldEntry);
              } catch (rmErr) {
                console.warn(`[migration] 清理旧 exe/data 残留 ${entry} 失败:`, rmErr);
              }
            }
          }
          // 删除 exe/data 目录本身（与 AppData 不同，exe/data 不是 Electron 管理的目录，可安全删除）
          try {
            rmSyncWithRetry(exeDataDir);
          } catch (rmErr) {
            console.warn('[migration] 删除旧 exe/data 目录本身失败（可忽略）:', rmErr);
          }
        } catch (err) {
          console.warn('[migration] exe/data -> 平台默认目录 迁移失败（可忽略）:', err);
        }
      }
    }
  }
}

/**
 * 同步移动文件/目录：先 rename（同磁盘原子操作最快），EXDEV（跨磁盘）时
 * fallback 到 cp + rm（复制后删除源）。其他错误直接抛出，由上层捕获。
 */
function moveEntrySync(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    // 跨磁盘：先复制再删除源（recursive 支持目录）
    cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
    rmSync(src, { recursive: true, force: true });
  }
}

/**
 * 启动时确保创建所有子目录
 */
export function ensureUserDataDirs(): void {
  const root = getUserDataRoot();
  const subDirs = [
    join(root, 'books', 'txt'),
    join(root, 'books', 'epub'),
    join(root, 'books', 'mobi'),
    join(root, 'books', 'pdf'),
    join(root, 'books', 'comic'),
    join(root, 'covers'),
    join(root, 'cache'),
    join(root, 'config'),
    join(root, 'rss-images'),
    join(root, 'images', 'chapter'),
    join(root, 'images', 'comic'),
    join(root, 'logs')
  ];
  for (const dir of subDirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/** 配置目录（settings.json、window-state.json 等） */
export function getConfigPath(): string {
  return join(getUserDataRoot(), 'config');
}

/** 配置文件路径：config/<filename> */
export function getConfigFile(filename: string): string {
  return join(getConfigPath(), filename);
}

/** 书籍文件根目录：books */
export function getBooksRoot(): string {
  return join(getUserDataRoot(), 'books');
}

/** 指定类型书籍目录：books/<type> */
export function getBooksPath(type: BookFileType): string {
  return join(getBooksRoot(), type);
}

/** 封面目录：covers */
export function getCoversRoot(): string {
  return join(getUserDataRoot(), 'covers');
}

/**
 * 指定书籍封面路径：covers/<bookId>.<ext>
 */
export function getCoverPath(bookId: string | number, ext: string = 'jpg'): string {
  const allowedExts = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
  const normalizedExt = ext.toLowerCase().replace(/^\./, '');
  const safeExt = allowedExts.includes(normalizedExt) ? normalizedExt : 'jpg';
  return join(getCoversRoot(), `${bookId}.${safeExt}`);
}

/** 缓存目录：cache */
export function getCachePath(): string {
  return join(getUserDataRoot(), 'cache');
}

/** SQLite 数据库文件路径：<userData>/youdu.db */
export function getDbPath(): string {
  return join(getUserDataRoot(), 'youdu.db');
}

/** 窗口状态文件路径：config/window-state.json */
export function getWindowStateFile(): string {
  return getConfigFile('window-state.json');
}

// ================================================================
// t2s.ts — 繁简转换工具
// ================================================================

/**
 * 繁体 → 简体 映射表（500+ 常用字）
 */
const T2S_MAP: Record<string, string> = {
  // ─── A-B ───
  愛: '爱',
  礙: '碍',
  閒: '闲',
  罷: '罢',
  壩: '坝',
  備: '备',
  筆: '笔',
  畢: '毕',
  幣: '币',
  邊: '边',
  變: '变',
  標: '标',
  錶: '表',
  別: '别',
  賓: '宾',
  補: '补',
  佈: '布',
  併: '并',
  辦: '办',
  闆: '板',
  幫: '帮',
  寶: '宝',
  報: '报',
  // ─── C-D ───
  長: '长',
  場: '场',
  廠: '厂',
  車: '车',
  陳: '陈',
  誠: '诚',
  遲: '迟',
  衝: '冲',
  醜: '丑',
  廚: '厨',
  處: '处',
  觸: '触',
  辭: '辞',
  竄: '窜',
  嘗: '尝',
  稱: '称',
  懲: '惩',
  齒: '齿',
  儲: '储',
  達: '达',
  帶: '带',
  貸: '贷',
  單: '单',
  當: '当',
  黨: '党',
  導: '导',
  島: '岛',
  燈: '灯',
  敵: '敌',
  點: '点',
  電: '电',
  東: '东',
  動: '动',
  獨: '独',
  斷: '断',
  隊: '队',
  對: '对',
  噸: '吨',
  奪: '夺',
  墊: '垫',
  釣: '钓',
  疊: '叠',
  澱: '淀',
  檔: '档',
  搗: '捣',
  禱: '祷',
  鄧: '邓',
  調: '调',
  諜: '谍',
  釘: '钉',
  頂: '顶',
  訂: '订',
  錠: '锭',
  丟: '丢',
  鬥: '斗',
  讀: '读',
  篤: '笃',
  鍍: '镀',
  頓: '顿',
  墮: '堕',
  // ─── E-F ───
  發: '发',
  煩: '烦',
  範: '范',
  飛: '飞',
  費: '费',
  墳: '坟',
  奮: '奋',
  糞: '粪',
  風: '风',
  鳳: '凤',
  膚: '肤',
  婦: '妇',
  復: '复',
  負: '负',
  豐: '丰',
  鋒: '锋',
  縫: '缝',
  訌: '讧',
  蓋: '盖',
  幹: '干',
  岡: '冈',
  綱: '纲',
  鋼: '钢',
  個: '个',
  給: '给',
  鞏: '巩',
  宮: '宫',
  貢: '贡',
  溝: '沟',
  構: '构',
  購: '购',
  穀: '谷',
  顧: '顾',
  關: '关',
  觀: '观',
  廣: '广',
  歸: '归',
  龜: '龟',
  國: '国',
  過: '过',
  掛: '挂',
  鍋: '锅',
  蝸: '蜗',
  漢: '汉',
  號: '号',
  賀: '贺',
  轟: '轰',
  後: '后',
  鬍: '胡',
  壺: '壶',
  滬: '沪',
  護: '护',
  華: '华',
  畫: '画',
  懷: '怀',
  壞: '坏',
  歡: '欢',
  環: '环',
  還: '还',
  匯: '汇',
  會: '会',
  夥: '伙',
  獲: '获',
  穫: '获',
  機: '机',
  積: '积',
  極: '极',
  際: '际',
  計: '计',
  記: '记',
  濟: '济',
  繼: '继',
  紀: '纪',
  夾: '夹',
  價: '价',
  堅: '坚',
  間: '间',
  監: '监',
  見: '见',
  節: '节',
  盡: '尽',
  進: '进',
  經: '经',
  莖: '茎',
  驚: '惊',
  競: '竞',
  舊: '旧',
  據: '据',
  劇: '剧',
  決: '决',
  覺: '觉',
  軍: '军',
  儉: '俭',
  薦: '荐',
  鑑: '鉴',
  踐: '践',
  漸: '渐',
  將: '将',
  獎: '奖',
  漿: '浆',
  醬: '酱',
  膠: '胶',
  階: '阶',
  癤: '疖',
  潔: '洁',
  結: '结',
  勁: '劲',
  逕: '径',
  糾: '纠',
  鳩: '鸠',
  鬮: '阄',
  開: '开',
  凱: '凯',
  殼: '壳',
  懇: '恳',
  墾: '垦',
  摳: '抠',
  庫: '库',
  塊: '块',
  寬: '宽',
  況: '况',
  虧: '亏',
  誇: '夸',
  曠: '旷',
  貺: '贶',
  // ─── L-M ───
  來: '来',
  賴: '赖',
  蘭: '兰',
  攔: '拦',
  欄: '栏',
  覽: '览',
  懶: '懒',
  爛: '烂',
  撈: '捞',
  勞: '劳',
  樂: '乐',
  類: '类',
  裡: '里',
  禮: '礼',
  裏: '里',
  歷: '历',
  兩: '两',
  憐: '怜',
  連: '连',
  蓮: '莲',
  聯: '联',
  練: '练',
  糧: '粮',
  涼: '凉',
  遼: '辽',
  療: '疗',
  獵: '猎',
  臨: '临',
  鄰: '邻',
  靈: '灵',
  領: '领',
  嶺: '岭',
  劉: '刘',
  龍: '龙',
  樓: '楼',
  婁: '娄',
  盧: '卢',
  蘆: '芦',
  錄: '录',
  陸: '陆',
  驢: '驴',
  輪: '轮',
  論: '论',
  羅: '罗',
  蘿: '萝',
  駱: '骆',
  慮: '虑',
  屢: '屡',
  縷: '缕',
  綠: '绿',
  掄: '抡',
  倫: '伦',
  淪: '沦',
  媽: '妈',
  馬: '马',
  罵: '骂',
  買: '买',
  賣: '卖',
  麥: '麦',
  邁: '迈',
  脈: '脉',
  蠻: '蛮',
  滿: '满',
  貓: '猫',
  貿: '贸',
  門: '门',
  們: '们',
  悶: '闷',
  夢: '梦',
  彌: '弥',
  冪: '幂',
  麵: '面',
  廟: '庙',
  滅: '灭',
  閩: '闽',
  銘: '铭',
  謬: '谬',
  畝: '亩',
  惱: '恼',
  腦: '脑',
  鬧: '闹',
  釀: '酿',
  麼: '么',
  沒: '没',
  難: '难',
  內: '内',
  餒: '馁',
  擬: '拟',
  紐: '纽',
  農: '农',
  鳥: '鸟',
  諾: '诺',
  餘: '余',
  歐: '欧',
  毆: '殴',
  盤: '盘',
  龐: '庞',
  拋: '抛',
  賠: '赔',
  噴: '喷',
  鵬: '鹏',
  騙: '骗',
  蘋: '苹',
  憑: '凭',
  評: '评',
  頗: '颇',
  撲: '扑',
  舖: '铺',
  樸: '朴',
  譜: '谱',
  潑: '泼',
  齊: '齐',
  騎: '骑',
  啟: '启',
  氣: '气',
  棄: '弃',
  遷: '迁',
  籤: '签',
  謙: '谦',
  錢: '钱',
  潛: '潜',
  淺: '浅',
  強: '强',
  搶: '抢',
  牆: '墙',
  橋: '桥',
  僑: '侨',
  翹: '翘',
  親: '亲',
  欽: '钦',
  輕: '轻',
  傾: '倾',
  窮: '穷',
  瓊: '琼',
  區: '区',
  軀: '躯',
  趨: '趋',
  權: '权',
  勸: '劝',
  卻: '却',
  確: '确',
  讓: '让',
  擾: '扰',
  熱: '热',
  認: '认',
  紉: '纫',
  饒: '饶',
  灑: '洒',
  賽: '赛',
  傘: '伞',
  喪: '丧',
  掃: '扫',
  澀: '涩',
  殺: '杀',
  曬: '晒',
  陝: '陕',
  賞: '赏',
  燒: '烧',
  紹: '绍',
  賒: '赊',
  設: '设',
  審: '审',
  聲: '声',
  勝: '胜',
  聖: '圣',
  師: '师',
  濕: '湿',
  詩: '诗',
  時: '时',
  識: '识',
  實: '实',
  駛: '驶',
  勢: '势',
  適: '适',
  釋: '释',
  獸: '兽',
  書: '书',
  術: '术',
  樹: '树',
  雙: '双',
  誰: '谁',
  順: '顺',
  説: '说',
  絲: '丝',
  鬆: '松',
  訟: '讼',
  誦: '诵',
  蘇: '苏',
  肅: '肃',
  雖: '虽',
  隨: '随',
  孫: '孙',
  損: '损',
  鎖: '锁',
  歲: '岁',
  蓫: '蓑',
  態: '态',
  貪: '贪',
  攤: '摊',
  灘: '滩',
  壇: '坛',
  歎: '叹',
  湯: '汤',
  燙: '烫',
  濤: '涛',
  討: '讨',
  騰: '腾',
  謄: '誊',
  題: '题',
  條: '条',
  貼: '贴',
  鐵: '铁',
  廳: '厅',
  聽: '听',
  銅: '铜',
  統: '统',
  頭: '头',
  圖: '图',
  塗: '涂',
  團: '团',
  頹: '颓',
  蛻: '蜕',
  託: '托',
  籠: '笼',
  駝: '驼',
  橢: '椭',
  萬: '万',
  網: '网',
  衛: '卫',
  穩: '稳',
  問: '问',
  甕: '瓮',
  烏: '乌',
  無: '无',
  蕪: '芜',
  吳: '吴',
  誤: '误',
  務: '务',
  霧: '雾',
  襪: '袜',
  習: '习',
  戲: '戏',
  細: '细',
  蝦: '虾',
  軄: '职',
  峽: '峡',
  狹: '狭',
  嚇: '吓',
  獻: '献',
  鄉: '乡',
  詳: '详',
  響: '响',
  項: '项',
  嚮: '向',
  梟: '枭',
  協: '协',
  寫: '写',
  瀉: '泻',
  攜: '携',
  興: '兴',
  洶: '汹',
  鏽: '锈',
  須: '须',
  許: '许',
  續: '续',
  軒: '轩',
  懸: '悬',
  選: '选',
  鏇: '旋',
  學: '学',
  壓: '压',
  鴉: '鸦',
  鴨: '鸭',
  啞: '哑',
  亞: '亚',
  嚴: '严',
  顏: '颜',
  驗: '验',
  豔: '艳',
  鹹: '咸',
  現: '现',
  綫: '线',
  嚀: '咛',
  揚: '扬',
  陽: '阳',
  養: '养',
  樣: '样',
  搖: '摇',
  堯: '尧',
  遙: '遥',
  藥: '药',
  業: '业',
  爺: '爷',
  葉: '叶',
  頁: '页',
  醫: '医',
  億: '亿',
  藝: '艺',
  憶: '忆',
  異: '异',
  譯: '译',
  陰: '阴',
  銀: '银',
  飲: '饮',
  隱: '隐',
  應: '应',
  櫻: '樱',
  嬰: '婴',
  瑩: '莹',
  營: '营',
  蠅: '蝇',
  傭: '佣',
  優: '优',
  郵: '邮',
  憂: '忧',
  猶: '犹',
  遊: '游',
  魚: '鱼',
  漁: '渔',
  與: '与',
  語: '语',
  籲: '吁',
  譽: '誉',
  預: '预',
  馭: '驭',
  鴛: '鸳',
  淵: '渊',
  遠: '远',
  園: '园',
  圓: '圆',
  緣: '缘',
  閲: '阅',
  雲: '云',
  隕: '陨',
  運: '运',
  蘊: '蕴',
  韻: '韵',
  雜: '杂',
  災: '灾',
  載: '载',
  暫: '暂',
  贊: '赞',
  髒: '脏',
  鑿: '凿',
  棗: '枣',
  責: '责',
  戰: '战',
  張: '张',
  趙: '赵',
  貞: '贞',
  針: '针',
  偵: '侦',
  陣: '阵',
  證: '证',
  織: '织',
  職: '职',
  執: '执',
  紙: '纸',
  摯: '挚',
  質: '质',
  滯: '滞',
  鐘: '钟',
  終: '终',
  種: '种',
  眾: '众',
  皺: '皱',
  驟: '骤',
  諸: '诸',
  豬: '猪',
  燭: '烛',
  囑: '嘱',
  駐: '驻',
  貯: '贮',
  鑄: '铸',
  築: '筑',
  專: '专',
  莊: '庄',
  裝: '装',
  壯: '壮',
  狀: '状',
  墜: '坠',
  綴: '缀',
  諄: '谆',
  準: '准',
  濁: '浊',
  茲: '兹',
  資: '资',
  漬: '渍',
  蹤: '踪',
  總: '总',
  縱: '纵',
  鄒: '邹',
  詘: '诎',
  組: '组',
  鑽: '钻',
  為: '为',
  麗: '丽',
  靂: '雳',
  壟: '垄',
  攏: '拢',
  壚: '卢',
  擄: '掳',
  鹵: '卤',
  鏝: '链',
  鞨: '羯',
  櫛: '栉',
  攄: '摅',
  蘧: '蕖',
  閡: '阂',
  閾: '阈',
  閿: '阗',
  陘: '陉',
  鄶: '郐',
  鄖: '郓',
  鄴: '郾',
  鄲: '鄣',
  醞: '酝',
  醴: '醴',
  鈸: '钹',
  鈦: '钛',
  鈧: '钪',
  鈮: '铌',
  鈹: '铍',
  鉬: '钼',
  鉕: '钋',
  鉛: '铅',
  鉀: '钾',
  鉑: '铂',
  銫: '铯',
  銣: '铷',
  銥: '铱',
  鋌: '锃',
  鋰: '锂',
  鋅: '锌',
  鋮: '钲',
  鋯: '锆',
  鋱: '铽',
  鋲: '锫',
  鋳: '镅',
  鋴: '锔',
  鋵: '锫',
  鋶: '锶',
  錇: '锫',
  錈: '锩',
  錋: '锫',
  錌: '锩',
  錍: '锩',
  錏: '锕',
  錐: '锥',
  錒: '锕',
  錕: '锟',
  錙: '锱',
  錚: '铮',
  錛: '锛',
  錟: '锬',
  錡: '锜',
  錣: '锩',
  錥: '锬',
  錦: '锦',
  錨: '锚',
  錫: '锡',
  錭: '锬',
  錮: '锢',
  錯: '错',
  錰: '锊',
  錱: '镃',
  録: '镃',
  錳: '锰',
  錴: '锬',
  錵: '锬',
  錷: '锷',
  錸: '锸',
  錹: '锹',
  錾: '锾',
  鍀: '锝',
  鍛: '锻',
  鍵: '键',
  鍼: '针',
  鍾: '钟',
  鎂: '镁',
  鎓: '镅',
  鎬: '镬',
  鏈: '链',
  鏃: '镃',
  鏄: '镄',
  鏆: '镆',
  鐮: '镰',
  鑒: '鉴',
  // ─── 补充缺失的常用繁体字（2026-09-24 修复 t2s 无法使用问题） ───
  體: '体',
  轉: '转',
  換: '换',
  測: '测',
  試: '试',
  說: '说',
  話: '话',
  請: '请',
  產: '产',
  員: '员',
  訊: '讯',
  檢: '检',
  視: '视',
  冊: '册',
  碼: '码',
  參: '参',
  數: '数',
  傳: '传',
  尋: '寻',
  濾: '滤',
  輸: '输',
  圍: '围',
  縮: '缩',
  閉: '闭',
  徑: '径',
  編: '编',
  規: '规',
  則: '则',
  層: '层',
  級: '级',
  緩: '缓',
  佇: '伫',
  誌: '志',
  簽: '签',
  鑰: '钥',
  訓: '训',
  訪: '访',
  訣: '诀',
  詠: '咏',
  詢: '询',
  詣: '诣',
  詫: '诧',
  詬: '诟',
  詭: '诡',
  詮: '诠',
  詰: '诘',
  詵: '诜',
  詼: '诙',
  誑: '诳',
  誒: '诶',
  誡: '诫',
  誥: '诰',
  課: '课',
  誹: '诽',
  謂: '谓',
  講: '讲',
  議: '议',
  財: '财',
  貧: '贫',
  貨: '货',
  販: '贩',
  貫: '贯',
  貴: '贵',
  貶: '贬',
  貽: '贻',
  賂: '赂',
  賃: '赁',
  賄: '贿',
  賅: '赅',
  賆: '赆',
  賈: '赈',
  賉: '赉',
  賊: '贼',
  賍: '赍',
  賑: '赑',
  賕: '赕',
  賗: '赗',
  賙: '赙',
  賢: '贤',
  贏: '赢',
  贓: '赃',
  贖: '赎',
  贅: '赘'
};

/**
 * 简体 → 繁体 映射表（由 T2S_MAP 反向自动生成）
 *
 * 多对一映射处理：
 * T2S_MAP 中存在多对一映射（多个繁体字对应同一简体字），这是繁简转换的
 * 固有特性——简体中文将多个繁体异体字/同音字合并为一个简体字。已知 17 组：
 *   获←獲/穫、鉴←鑑/鑒、径←逕/徑、里←裡/裏、卢←盧/壚、签←籤/簽、
 *   说←説/說、针←針/鍼、钟←鐘/鍾、链←鏝/鏈、锫←鋲/鋵/錇/錋、
 *   镅←鋳/鎓、锩←錈/錌/錍/錣、锕←錏/錒、锬←錟/錥/錭/錴/錵、镃←錱/録/鏃
 *
 * 反向生成 S2T_MAP 时，对多对一映射保留 T2S_MAP 中首次出现的繁体字
 * （通常为更常用义），避免后列的生僻义覆盖常用义。
 * 例如"获"保留"獲"（获得，常用）而非"穫"（收割，生僻），
 * 避免"获得"被错误转为"穫得"。如需精确还原需上下文分词，超出本工具范围。
 */
const S2T_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [trad, simp] of Object.entries(T2S_MAP)) {
    // 多对一映射：保留首次出现的繁体字（通常为更常用义），不覆盖
    if (map[simp] === undefined) {
      map[simp] = trad;
    }
  }
  return map;
})();

/**
 * 繁体转简体
 */
export function toSimplified(text: string): string {
  if (!text) return text;
  let result = '';
  for (const ch of text) {
    result += T2S_MAP[ch] ?? ch;
  }
  return result;
}

/**
 * 简体转繁体
 */
export function toTraditional(text: string): string {
  if (!text) return text;
  let result = '';
  for (const ch of text) {
    result += S2T_MAP[ch] ?? ch;
  }
  return result;
}

// ================================================================
// text-format.ts — 智能排版工具
// ================================================================

/** 全角空格（用于段落首行缩进） */
const FULLWIDTH_SPACE = '\u3000';

/** 引号字符集合（对话行识别） */
const QUOTE_CHARS = new Set([
  '\u201C',
  '\u201D',
  '"',
  '"',
  '\u2018',
  '\u2019',
  '\u2018',
  '\u2019',
  '\u300C',
  '\u300D',
  '\u300E',
  '\u300F'
]);

/** 场景分隔装饰符 */
const SCENE_SEPARATOR_CHARS = new Set(['*', '－', '—', '★', '☆', '·', '•', '○', '●', '◆', '◇', '※', '✦', '✧']);

/**
 * 判断段落是否以引号开头（对话行）
 */
function isQuoteLine(para: string): boolean {
  if (!para) return false;
  return QUOTE_CHARS.has(para[0]);
}

/**
 * 判断段落是否为场景分隔行
 */
function isSceneSeparator(para: string): boolean {
  if (!para) return false;
  let separatorCount = 0;
  for (const ch of para) {
    if (ch === ' ' || ch === FULLWIDTH_SPACE) continue;
    if (SCENE_SEPARATOR_CHARS.has(ch)) {
      separatorCount++;
      continue;
    }
    return false;
  }
  return separatorCount >= 2;
}

/**
 * 中英文之间加半角空格
 */
function addCjkLatinSpacing(text: string): string {
  let result = text.replace(/([\u4e00-\u9fff\u3000-\u303f])([a-zA-Z0-9])/g, '$1 $2');
  result = result.replace(/([a-zA-Z0-9])([\u4e00-\u9fff\u3000-\u303f])/g, '$1 $2');
  return result;
}

/**
 * 智能排版
 */
export function smartFormat(text: string, options: { addCjkLatinSpace?: boolean } = {}): string {
  if (!text) return text;

  // 1. 统一换行符
  let normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 2. 可选：中英文加空格
  if (options.addCjkLatinSpace) {
    normalized = addCjkLatinSpacing(normalized);
  }

  // 3. 去多余空行
  normalized = normalized.replace(/\n{3,}/g, '\n\n');

  // 4. 按空行切分段落
  const paragraphs = normalized.split(/\n\n+/);

  // 5. 逐段处理
  const processed: string[] = [];
  for (let para of paragraphs) {
    para = para.replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');
    if (!para) continue;

    const lines = para.split('\n');
    const trimmedLines = lines.map((line) => {
      return line.replace(/[\s\u3000]+$/, '');
    });
    para = trimmedLines.join('\n');

    if (para.startsWith('[IMG:')) {
      processed.push(para);
    } else if (isRichTextBlockMarker(para)) {
      processed.push(para);
    } else if (isSceneSeparator(para)) {
      processed.push(para);
    } else if (isQuoteLine(para)) {
      processed.push(para);
    } else {
      if (!para.startsWith(FULLWIDTH_SPACE) && !para.startsWith(' ')) {
        para = FULLWIDTH_SPACE + FULLWIDTH_SPACE + para;
      }
      processed.push(para);
    }
  }

  // 6. 段落用空行重新拼接
  return processed.join('\n\n');
}
