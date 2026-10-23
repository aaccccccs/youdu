/**
 * 主进程国际化模块（不依赖 vue-i18n）
 *
 * 主进程（Electron main）无法使用 vue-i18n（其依赖 Vue 运行时），
 * 因此这里实现一个极简的键值翻译器，覆盖右键菜单、原生对话框、
 * 系统通知等主进程 UI 文案。
 *
 * 导出接口：
 *   - tMain(key, params?)        翻译函数，支持 {name}/{n}/{msg} 插值
 *   - setMainLocale(locale)      设置当前语言
 *   - refreshMainLocale()        从 config/locale.json 读取已保存语言（避免循环依赖）
 *
 * 翻译键与渲染进程语义对齐，但消息表独立维护（主进程仅需 31 个键）。
 */

/** 受支持的语言 */
type Locale = 'zh-CN' | 'en';

/** 当前激活语言 */
let currentLocale: Locale = 'zh-CN';

/** 31 个主进程消息键的翻译表 */
const messages: Record<Locale, Record<string, string>> = {
  'zh-CN': {
    'article.untitled': '无标题',
    'dialog.chooseBookFiles': '选择书籍文件',
    'dialog.chooseBookFolder': '选择书籍文件夹',
    'dialog.chooseCover': '选择封面图片',
    'dialog.chooseExportDir': '选择导出目录',
    'dialog.chooseTxtExportDir': '选择 TXT 导出目录',
    'dialog.dbInitBody': '数据库初始化失败：{msg}',
    'dialog.dbInitTitle': '数据库初始化失败',
    'dialog.saveImage': '保存图片',
    'dialog.filters.all': '所有文件',
    'dialog.filters.books': '书籍文件',
    'dialog.filters.comic': '漫画文件',
    'dialog.filters.epub': 'EPUB 电子书',
    'dialog.filters.images': '图片文件',
    'dialog.filters.mobi': 'MOBI 电子书',
    'dialog.filters.pdf': 'PDF 文档',
    'dialog.filters.txt': '文本文件',
    'menu.copy': '复制',
    'menu.copyImage': '复制图片',
    'menu.copyImageUrl': '复制图片地址',
    'menu.copyLink': '复制链接',
    'menu.cut': '剪切',
    'menu.delete': '删除',
    'menu.openLink': '打开链接',
    'menu.paste': '粘贴',
    'menu.redo': '重做',
    'menu.selectAll': '全选',
    'menu.undo': '撤销',
    'notification.readingReminderBody': '好久没读了，来读一会儿吧',
    'notification.readingReminderTitle': '阅读提醒',
    'notification.rssUpdateBody': 'RSS 源「{name}」有 {n} 篇新文章',
    'notification.rssUpdateTitle': 'RSS 更新'
  },
  en: {
    'article.untitled': 'Untitled',
    'dialog.chooseBookFiles': 'Choose Book Files',
    'dialog.chooseBookFolder': 'Choose Book Folder',
    'dialog.chooseCover': 'Choose Cover Image',
    'dialog.chooseExportDir': 'Choose Export Directory',
    'dialog.chooseTxtExportDir': 'Choose TXT Export Directory',
    'dialog.dbInitBody': 'Database initialization failed: {msg}',
    'dialog.dbInitTitle': 'Database Initialization Failed',
    'dialog.saveImage': 'Save Image',
    'dialog.filters.all': 'All Files',
    'dialog.filters.books': 'Books',
    'dialog.filters.comic': 'Comics',
    'dialog.filters.epub': 'EPUB eBooks',
    'dialog.filters.images': 'Images',
    'dialog.filters.mobi': 'MOBI eBooks',
    'dialog.filters.pdf': 'PDF Documents',
    'dialog.filters.txt': 'Text Files',
    'menu.copy': 'Copy',
    'menu.copyImage': 'Copy Image',
    'menu.copyImageUrl': 'Copy Image URL',
    'menu.copyLink': 'Copy Link',
    'menu.cut': 'Cut',
    'menu.delete': 'Delete',
    'menu.openLink': 'Open Link',
    'menu.paste': 'Paste',
    'menu.redo': 'Redo',
    'menu.selectAll': 'Select All',
    'menu.undo': 'Undo',
    'notification.readingReminderBody': "You haven't read for a while, come read a bit.",
    'notification.readingReminderTitle': 'Reading Reminder',
    'notification.rssUpdateBody': 'RSS feed "{name}" has {n} new articles',
    'notification.rssUpdateTitle': 'RSS Update'
  }
};

/**
 * 主进程翻译函数
 *
 * @param key    消息键（如 `menu.copy`）
 * @param params 插值参数，键名对应消息中的 `{key}` 占位符
 * @returns 翻译文本；缺失时回退到 zh-CN，仍缺失则返回键名本身
 */
export function tMain(key: string, params?: Record<string, unknown>): string {
  let text: string = messages[currentLocale][key] ?? messages['zh-CN'][key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

/**
 * 设置主进程当前语言
 *
 * @param locale 语言标识，仅接受 'zh-CN' 与 'en'，其余忽略以保持默认
 */
export function setMainLocale(locale: string): void {
  if (locale === 'zh-CN' || locale === 'en') {
    currentLocale = locale;
    // 持久化到统一数据目录 config/locale.json，供下次启动 refreshMainLocale 读取
    try {
      const { getConfigFile } = require('./utils') as typeof import('./utils');
      const fs = require('node:fs') as typeof import('node:fs');
      const file = getConfigFile('locale.json');
      fs.writeFileSync(file, JSON.stringify({ locale }, null, 2), 'utf8');
    } catch {
      /* 写入失败不阻断语言切换 */
    }
  }
}

/**
 * 从 config/locale.json 读取已保存语言并应用
 *
 * 刻意不依赖数据库 Repository（避免循环依赖：Repository → ipc → i18n）。
 * 渲染进程启动后会通过 IPC SETTING_SET('app.locale') 同步语言到主进程，
 * 因此此处仅为"尽早设置首屏语言"的尽力尝试；文件不存在或读取失败时
 * 静默回退到默认 zh-CN。
 */
export function refreshMainLocale(): void {
  try {
    // 动态 require，避免在非 Electron 环境（如单测）下顶层 import 报错
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getConfigFile } = require('./utils') as typeof import('./utils');
    const fs = require('node:fs') as typeof import('node:fs');
    const file = getConfigFile('locale.json');
    const raw = fs.readFileSync(file, 'utf8') as string;
    const data = JSON.parse(raw) as { locale?: unknown };
    if (typeof data.locale === 'string') {
      setMainLocale(data.locale);
    }
  } catch {
    /* 无 locale.json 或读取失败：保持默认 zh-CN */
  }
}
