/**
 * shared.ts 单元测试（P2-8）
 *
 * 覆盖主题颜色派生系统
 */
import { describe, it, expect } from 'vitest';
import { deriveThemeColors, THEME_COLORS, HIGHLIGHT_COLORS } from '../src/shared';

describe('deriveThemeColors', () => {
  it('从3个基础值派生22个语义令牌', () => {
    const colors = deriveThemeColors({ bg: '#ffffff', text: '#333333', primary: '#8b5cf6' });
    expect(colors.bg).toBe('#ffffff');
    expect(colors.text).toBe('#333333');
    expect(colors.primary).toBe('#8b5cf6');
    expect(colors.bgTitlebar).toBeDefined();
    expect(colors.cardBg).toBeDefined();
    expect(colors.borderDefault).toBeDefined();
    expect(colors.textSecondary).toBeDefined();
    expect(colors.colorDanger).toBe('#f56565');
  });

  it('深色主题背景层次向上提亮', () => {
    const dark = deriveThemeColors({ bg: '#16151f', text: '#e6e6e6', primary: '#6366f1' });
    expect(dark.bgTitlebar).not.toBe(dark.bg);
    expect(dark.cardBg).not.toBe(dark.bg);
  });

  it('浅色主题背景层次向下压暗', () => {
    const light = deriveThemeColors({ bg: '#f5f3f0', text: '#333333', primary: '#8b5cf6' });
    expect(light.bgTitlebar).not.toBe(light.bg);
    expect(light.cardBg).not.toBe(light.bg);
  });

  it('边框使用rgba透明度', () => {
    const dark = deriveThemeColors({ bg: '#000000', text: '#ffffff', primary: '#6366f1' });
    expect(dark.borderSubtle).toMatch(/^rgba\(255,255,255/);
    expect(dark.borderDefault).toMatch(/^rgba\(255,255,255/);
  });
});

describe('THEME_COLORS', () => {
  it('包含5个预定义主题', () => {
    expect(THEME_COLORS.day).toBeDefined();
    expect(THEME_COLORS.night).toBeDefined();
    expect(THEME_COLORS.eye).toBeDefined();
    expect(THEME_COLORS.parchment).toBeDefined();
    expect(THEME_COLORS.custom).toBeDefined();
  });

  it('每个主题都有完整的22个令牌', () => {
    for (const [name, colors] of Object.entries(THEME_COLORS)) {
      expect(colors.bg).toBeDefined();
      expect(colors.text).toBeDefined();
      expect(colors.primary).toBeDefined();
      expect(colors.bgTitlebar).toBeDefined();
      expect(colors.cardBg).toBeDefined();
      expect(colors.borderDefault).toBeDefined();
      expect(colors.textSecondary).toBeDefined();
      expect(colors.colorDanger).toBeDefined();
    }
  });
});

describe('HIGHLIGHT_COLORS', () => {
  it('包含6种高亮颜色', () => {
    expect(HIGHLIGHT_COLORS).toHaveLength(6);
  });

  it('每种颜色有key/label/swatch/markBg', () => {
    for (const c of HIGHLIGHT_COLORS) {
      expect(c.key).toBeDefined();
      expect(c.label).toBeDefined();
      expect(c.swatch).toMatch(/^#/);
      expect(c.markBg).toMatch(/^rgba\(/);
    }
  });
});
