/**
 * utils.ts 单元测试（P2-8）
 *
 * 覆盖核心纯函数：时间格式化、颜色工具、HTML 转义、封面生成等
 */
import { describe, it, expect, vi } from 'vitest';
import {
  formatRelativeTime,
  formatDate,
  formatDateTime,
  formatDuration,
  hexToRgb,
  rgbToHex,

  clamp,
  escapeHtml,
  escapeHtmlAttr,
  generateCoverDataUrl,
  coverPathToUrl,
  splitParagraphs,
  renderRichTextBlock,
  renderParagraphWithHighlights,
  stripOrphanSupSubMarkers
} from '../src/renderer/src/utils';

// src/main/utils.ts 顶层 import electron（数据目录路径管理），vitest node 环境
// 无 Electron 运行时，需 mock 后才能引入其中的 convertSemanticHtmlToMarkers。
// 仅 mock 测试用到的 app.getPath，不影响本文件其他 renderer 侧用例。
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
import { convertSemanticHtmlToMarkers } from '../src/main/utils';

/* ==================== 时间格式化 ==================== */

describe('formatRelativeTime', () => {
  it('null/undefined/NaN 返回"未读"', () => {
    expect(formatRelativeTime(null)).toBe('未读');
    expect(formatRelativeTime(undefined as unknown as null)).toBe('未读');
    expect(formatRelativeTime(NaN)).toBe('未读');
    expect(formatRelativeTime(Infinity)).toBe('未读');
  });

  it('刚刚（< 60秒）', () => {
    const now = Date.now();
    expect(formatRelativeTime(now)).toBe('刚刚');
    expect(formatRelativeTime(now - 30 * 1000)).toBe('刚刚');
  });

  it('分钟前', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 5 * 60 * 1000)).toBe('5 分钟前');
  });

  it('小时前', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 3 * 60 * 60 * 1000)).toBe('3 小时前');
  });

  it('天前', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 5 * 24 * 60 * 60 * 1000)).toBe('5 天前');
  });

  it('周前', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 14 * 24 * 60 * 60 * 1000)).toBe('2 周前');
  });

  it('月前', () => {
    const now = Date.now();
    expect(formatRelativeTime(now - 60 * 24 * 60 * 60 * 1000)).toBe('2 个月前');
  });

  it('未来时间返回 formatDate', () => {
    const future = Date.now() + 100000;
    const result = formatRelativeTime(future);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatDate', () => {
  it('格式化为 YYYY-MM-DD', () => {
    const ts = new Date(2026, 0, 5).getTime();
    expect(formatDate(ts)).toBe('2026-01-05');
  });

  it('补零', () => {
    const ts = new Date(2026, 10, 15).getTime();
    expect(formatDate(ts)).toBe('2026-11-15');
  });
});

describe('formatDateTime', () => {
  it('格式化为 YYYY-MM-DD HH:mm', () => {
    const ts = new Date(2026, 0, 5, 9, 8).getTime();
    expect(formatDateTime(ts)).toBe('2026-01-05 09:08');
  });
});

describe('formatDuration', () => {
  it('null/undefined 返回"未读"', () => {
    expect(formatDuration(null)).toBe('未读');
    expect(formatDuration(undefined)).toBe('未读');
  });

  it('秒', () => {
    expect(formatDuration(30 * 1000)).toBe('30 秒');
  });

  it('分钟', () => {
    expect(formatDuration(90 * 1000)).toBe('1 分钟');
  });

  it('小时+分钟', () => {
    expect(formatDuration(3725 * 1000)).toBe('1 小时 2 分');
  });
});

/* ==================== 颜色工具 ==================== */

describe('hexToRgb', () => {
  it('6位hex', () => {
    expect(hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('#00ff00')).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb('#0000ff')).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('3位hex', () => {
    expect(hexToRgb('#f00')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('#0f0')).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('无效输入返回null', () => {
    expect(hexToRgb('#gggggg')).toBeNull();
    expect(hexToRgb('invalid')).toBeNull();
  });
});

describe('rgbToHex', () => {
  it('RGB转hex', () => {
    expect(rgbToHex(255, 0, 0)).toBe('#ff0000');
    expect(rgbToHex(0, 255, 0)).toBe('#00ff00');
    expect(rgbToHex(0, 0, 255)).toBe('#0000ff');
  });

  it('补零', () => {
    expect(rgbToHex(0, 0, 0)).toBe('#000000');
    expect(rgbToHex(1, 2, 3)).toBe('#010203');
  });
});


describe('clamp', () => {
  it('限制在0-255范围', () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(256)).toBe(255);
    expect(clamp(128)).toBe(128);
  });
});

/* ==================== HTML 转义 ==================== */

describe('escapeHtml', () => {
  it('转义特殊字符', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('转义 & < > " \'', () => {
    expect(escapeHtml('a & b < c > d " e \' f')).toBe('a &amp; b &lt; c &gt; d &quot; e &#39; f');
  });

  it('空字符串', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('无特殊字符不变', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('escapeHtmlAttr', () => {
  it('转义双引号', () => {
    expect(escapeHtmlAttr('a"b')).toBe('a&quot;b');
  });
});

/* ==================== 封面生成 ==================== */

describe('generateCoverDataUrl', () => {
  it('生成SVG data URL', () => {
    const result = generateCoverDataUrl('测试书名', '测试作者');
    expect(result).toMatch(/^data:image\/svg\+xml/);
  });

  it('无作者时也能生成', () => {
    const result = generateCoverDataUrl('测试书名');
    expect(result).toMatch(/^data:image\/svg\+xml/);
  });
});

/* ==================== 封面路径转URL ==================== */

describe('coverPathToUrl', () => {
  it('null返回null', () => {
    expect(coverPathToUrl(null)).toBeNull();
  });

  it('file://协议路径', () => {
    const result = coverPathToUrl('C:\\Users\\test\\covers\\abc.png');
    expect(result).toMatch(/^file:\/\//);
  });
});

/* ==================== 段落分割 ==================== */

describe('splitParagraphs', () => {
  it('按空行分割', () => {
    const result = splitParagraphs('第一段\n\n第二段\n\n第三段');
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('第一段');
    expect(result[1]).toBe('第二段');
    expect(result[2]).toBe('第三段');
  });

  it('单个段落', () => {
    const result = splitParagraphs('只有一段');
    expect(result).toHaveLength(1);
  });

  it('空字符串', () => {
    const result = splitParagraphs('');
    expect(result).toHaveLength(0);
  });
});
/* ==================== renderRichTextBlock [HR] 分隔线 ==================== */

describe('renderRichTextBlock [HR] 分隔线', () => {
  it('纯 [HR] 段落渲染为水平线（回归保护）', () => {
    expect(renderRichTextBlock('[HR]')).toBe('<hr class="rich-hr">');
  });

  it('存量数据：[HR] 与文字混在 UL 内 → 转为列表内分隔线，不裸露', () => {
    const out = renderRichTextBlock('[UL]　　[HR]　　姓名：纪宁[/UL]');
    expect(out).toContain('<ul class="rich-ul">');
    expect(out).toContain('<li class="rich-hr-item"');
    expect(out).toContain('姓名：纪宁');
    expect(out).not.toContain('[HR]');
  });

  it('存量数据：多个 [HR]（独立行形态）混在 UL 内全部转换', () => {
    const out = renderRichTextBlock('[UL]\n[HR]\n　　姓名：纪宁\n[HR]\n　　道号：北冥[/UL]');
    expect(out).toContain('<ul class="rich-ul">');
    expect((out?.match(/rich-hr-item/g) ?? []).length).toBe(2);
    expect(out).toContain('姓名：纪宁');
    expect(out).toContain('道号：北冥');
    expect(out).not.toContain('[HR]');
  });

  it('UL 内 [LI] 与 [HR] 共存：列表项与分隔线同时正确渲染', () => {
    const out = renderRichTextBlock('[UL][LI]甲[/LI]\n[HR]\n[LI]乙[/LI][/UL]');
    expect(out).toContain('<li class="rich-list-item">甲</li>');
    expect(out).toContain('<li class="rich-list-item">乙</li>');
    expect(out).toContain('<li class="rich-hr-item"');
    expect(out).not.toContain('[HR]');
  });

  it('OL/DL 分支同样转换混入的 [HR]', () => {
    const ol = renderRichTextBlock('[OL][LI]一[/LI]\n[HR]\n[LI]二[/LI][/OL]');
    expect(ol).toContain('<ol class="rich-ol">');
    expect(ol).toContain('<li class="rich-list-item">一</li>');
    expect(ol).toContain('<li class="rich-hr-item"');
    expect(ol).not.toContain('[HR]');

    const dl = renderRichTextBlock('[DL][DT]术语[/DT]\n[HR]\n[DD]描述[/DD][/DL]');
    expect(dl).toContain('<dl class="rich-dl">');
    expect(dl).toContain('<dt class="rich-dt">术语</dt>');
    expect(dl).toContain('<dd class="rich-dd">描述</dd>');
    expect(dl).toContain('<li class="rich-hr-item"');
    expect(dl).not.toContain('[HR]');
  });

  it('主进程切割后形态：splitParagraphs 分段后各自正确渲染', () => {
    const paras = splitParagraphs('[UL]A[/UL]\n\n[HR]\n\n[UL]B[/UL]');
    expect(paras).toHaveLength(3);
    expect(renderRichTextBlock(paras[0])).toBe('<ul class="rich-ul">A</ul>');
    expect(renderRichTextBlock(paras[1])).toBe('<hr class="rich-hr">');
    expect(renderRichTextBlock(paras[2])).toBe('<ul class="rich-ul">B</ul>');
  });

  it('非列表段落不受影响：普通文本返回 null', () => {
    expect(renderRichTextBlock('普通段落文字')).toBeNull();
  });
});

/* ==================== convertSemanticHtmlToMarkers 容器内 <hr> 切割 ==================== */

describe('convertSemanticHtmlToMarkers 容器内 <hr> 切割', () => {
  it('<ul> 内 <hr> 切割为多个 [UL] 块，[HR] 独立保留在块间', () => {
    const out = convertSemanticHtmlToMarkers('<ul><li>甲</li><hr><li>乙</li></ul>');
    // 切成两个列表块，[LI] 各归其块
    expect((out.match(/\[UL\]/g) ?? []).length).toBe(2);
    expect(out).toContain('[LI]甲[/LI]');
    expect(out).toContain('[LI]乙[/LI]');
    // [HR] 保留在块间（前后仅空白），不被吞进 [UL] 内部
    expect(out).toMatch(/\[\/UL\]\s*\[HR\]\s*\[UL\]/);
    expect(out).not.toMatch(/\[UL\]\s*\[HR\]/);
    expect(out).not.toMatch(/\[HR\]\s*\[\/UL\]/);
  });

  it('<ol>/<dl> 容器同样按 [HR] 切割', () => {
    const ol = convertSemanticHtmlToMarkers('<ol><li>一</li><hr><li>二</li></ol>');
    expect((ol.match(/\[OL\]/g) ?? []).length).toBe(2);
    expect(ol).toMatch(/\[\/OL\]\s*\[HR\]\s*\[OL\]/);

    const dl = convertSemanticHtmlToMarkers('<dl><dt>甲</dt><hr><dt>乙</dt></dl>');
    expect((dl.match(/\[DL\]/g) ?? []).length).toBe(2);
    expect(dl).toMatch(/\[\/DL\]\s*\[HR\]\s*\[DL\]/);
  });

  it('出版社人物卡形态：<hr> 前后带全角空格文本，[HR] 不被吞进容器', () => {
    const out = convertSemanticHtmlToMarkers('<ul>　　<hr>　　姓名： 纪宁</ul>');
    expect(out).toContain('姓名： 纪宁');
    expect(out).toContain('[HR]');
    expect(out).not.toMatch(/\[UL\]\s*\[HR\]/);
    // [HR] 前后由空行包裹，独立成段
    expect(out).toMatch(/\n\n\[HR\]\n\n/);
  });

  it('不含 <hr> 的普通 <ul> 保持原有单块转换（回归保护）', () => {
    const out = convertSemanticHtmlToMarkers('<ul><li>甲</li><li>乙</li></ul>');
    expect((out.match(/\[UL\]/g) ?? []).length).toBe(1);
    expect(out).toContain('[LI]甲[/LI]');
    expect(out).toContain('[LI]乙[/LI]');
    expect(out).not.toContain('[HR]');
  });

  it('空内容容器仍被过滤（回归保护）', () => {
    expect(convertSemanticHtmlToMarkers('<ul>   </ul>')).not.toContain('[UL]');
    expect(convertSemanticHtmlToMarkers('<ol></ol>')).not.toContain('[OL]');
  });
});
/* ==================== [SUP]/[SUB] 跨段裸露修复 ==================== */

describe('convertSemanticHtmlToMarkers sup/sub 防拆散', () => {
  it('sup 内容嵌 IMG 占位标记（mobi 实测形态）：不生成 [SUP] 标记，IMG 独立成段', () => {
    // 模拟 mobi-parser htmlToText 链路：<img> 先被提取为 \n\n[IMG:src]\n\n，再进语义转换
    const out = convertSemanticHtmlToMarkers('<sup>\n\n[IMG:img001.png]\n\n</sup>');
    expect(out).not.toContain('[SUP]');
    expect(out).not.toContain('[/SUP]');
    // IMG 两侧空行包裹，独立成段渲染
    expect(out).toMatch(/\n\n\[IMG:img001\.png\]\n\n/);
  });

  it('sup 内容为文字+IMG 混合：IMG 两侧恢复空行分隔，不包 SUP 标记', () => {
    const out = convertSemanticHtmlToMarkers('<sup>注解\n\n[IMG:img002.png]\n\n后续</sup>');
    expect(out).not.toContain('[SUP]');
    expect(out).not.toContain('[/SUP]');
    expect(out).toContain('注解');
    expect(out).toContain('后续');
    expect(out).toMatch(/注解\n\n\[IMG:img002\.png\]\n\n后续/);
  });

  it('sup 内容含换行（跨块标签转换产生）：归一化为单空格，配对不被分段拆散', () => {
    const out = convertSemanticHtmlToMarkers('<sup>注1\n注2</sup>');
    expect(out).toBe('[SUP]注1 注2[/SUP]');
    // 空行分段/单换行分段都不会拆散
    expect(splitParagraphs(`正文${out}结尾`)).toHaveLength(1);
  });

  it('正常 sup/sub 配对（回归保护）：x² / H₂O 不受影响', () => {
    expect(convertSemanticHtmlToMarkers('<sup>2</sup>')).toBe('[SUP]2[/SUP]');
    expect(convertSemanticHtmlToMarkers('<sub>2</sub>')).toBe('[SUB]2[/SUB]');
    expect(convertSemanticHtmlToMarkers('H<sub>2</sub>O')).toBe('H[SUB]2[/SUB]O');
  });

  it('空内容 sup/sub 仍被丢弃（回归保护）', () => {
    expect(convertSemanticHtmlToMarkers('<sup>   </sup>')).toBe('');
    expect(convertSemanticHtmlToMarkers('<sub></sub>')).toBe('');
  });

  it('sub 内容嵌 IMG 占位标记：同样降级不包标记', () => {
    const out = convertSemanticHtmlToMarkers('<sub>\n\n[IMG:img003.png]\n\n</sub>');
    expect(out).not.toContain('[SUB]');
    expect(out).toMatch(/\n\n\[IMG:img003\.png\]\n\n/);
  });
});

describe('stripOrphanSupSubMarkers 孤立标记容错', () => {
  it('孤立开标记被移除，正文保留', () => {
    expect(stripOrphanSupSubMarkers('春来发几枝？\n[SUP]')).toBe('春来发几枝？\n');
    expect(stripOrphanSupSubMarkers('前文[SUP]')).toBe('前文');
  });

  it('孤立闭标记被移除，整段只剩闭标记时清空', () => {
    expect(stripOrphanSupSubMarkers('[/SUP]')).toBe('');
    expect(stripOrphanSupSubMarkers('[/SUB]')).toBe('');
  });

  it('正常配对不受影响（不误伤）', () => {
    expect(stripOrphanSupSubMarkers('x[SUP]2[/SUP]')).toBe('x[SUP]2[/SUP]');
    expect(stripOrphanSupSubMarkers('H[SUB]2[/SUB]O')).toBe('H[SUB]2[/SUB]O');
    // 配对与孤立共存：只删孤立的
    expect(stripOrphanSupSubMarkers('[SUP]a[/SUP] 前[SUP]')).toBe('[SUP]a[/SUP] 前');
  });

  it('无 SUP/SUB 标记时原样返回（快速路径）', () => {
    expect(stripOrphanSupSubMarkers('普通文本')).toBe('普通文本');
  });
});

describe('renderParagraphWithHighlights 孤立 [SUP]/[SUB] 渲染容错', () => {
  it('孤立 [SUP] 段落渲染后无裸露标记文本，正文保留', () => {
    const html = renderParagraphWithHighlights('春来发几枝？\n[SUP]', []);
    expect(html).not.toContain('[SUP]');
    expect(html).toContain('春来发几枝？');
  });

  it('孤立 [/SUP] 整段渲染为空串', () => {
    expect(renderParagraphWithHighlights('[/SUP]', [])).toBe('');
    expect(renderParagraphWithHighlights('[/SUB]', [])).toBe('');
  });

  it('正常配对 [SUP]x[/SUP] 渲染为上标（不误伤）', () => {
    const html = renderParagraphWithHighlights('x[SUP]2[/SUP]', []);
    expect(html).toContain('<sup>2</sup>');
    expect(html).not.toContain('[SUP]');
  });

  it('书716 实测形态端到端：分段后各段渲染均无标记裸露，IMG 正常渲染', () => {
    // 存量正文形态：正文行内孤立 [SUP]，空行后 IMG 独立成段，再空行后孤立 [/SUP]
    const paras = splitParagraphs('春来发几枝？\n[SUP]\n\n[IMG:file:///tmp/a.png]\n\n[/SUP]');
    expect(paras.length).toBeGreaterThanOrEqual(3);
    for (const para of paras) {
      const html = renderParagraphWithHighlights(para, []);
      expect(html).not.toContain('[SUP]');
      expect(html).not.toContain('[/SUP]');
    }
    // IMG 段正常渲染为图片
    const imgHtml = renderParagraphWithHighlights(
      paras.find((p) => p.startsWith('[IMG:')) ?? '',
      []
    );
    expect(imgHtml).toContain('<img');
  });

  it('孤立标记与 IMG 混在同段（单换行未分段形态）：同样不裸露', () => {
    const html = renderParagraphWithHighlights('说明文字\n[SUP]\n[IMG:file:///tmp/b.png]', []);
    expect(html).not.toContain('[SUP]');
    expect(html).toContain('说明文字');
    expect(html).toContain('<img');
  });
});
