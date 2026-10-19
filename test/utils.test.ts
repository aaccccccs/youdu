/**
 * utils.ts 单元测试（P2-8）
 *
 * 覆盖核心纯函数：时间格式化、颜色工具、HTML 转义、封面生成等
 */
import { describe, it, expect } from 'vitest';
import {
  formatRelativeTime,
  formatDate,
  formatDateTime,
  formatDuration,
  hexToRgb,
  rgbToHex,
  hexToRgba,
  isDarkBg,
  adjustBg,
  clamp,
  escapeHtml,
  escapeHtmlAttr,
  generateCoverDataUrl,
  coverPathToUrl,
  splitParagraphs
} from '../src/renderer/src/utils';

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

describe('hexToRgba', () => {
  it('hex+alpha转rgba', () => {
    expect(hexToRgba('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
    expect(hexToRgba('#00ff00', 1)).toBe('rgba(0, 255, 0, 1)');
  });
});

describe('isDarkBg', () => {
  it('深色背景', () => {
    expect(isDarkBg('#000000')).toBe(true);
    expect(isDarkBg('#16151f')).toBe(true);
  });

  it('浅色背景', () => {
    expect(isDarkBg('#ffffff')).toBe(false);
    expect(isDarkBg('#f5f3f0')).toBe(false);
  });
});

describe('adjustBg', () => {
  it('提亮 10%', () => {
    const result = adjustBg('#000000', 0.1);
    expect(result).toBe('#1a1a1a');
  });

  it('压暗 10%', () => {
    const result = adjustBg('#ffffff', -0.1);
    expect(result).toBe('#e6e6e6');
  });

  it('clamp不超出0-255', () => {
    const result = adjustBg('#ffffff', 0.5);
    expect(result).toBe('#ffffff');
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
