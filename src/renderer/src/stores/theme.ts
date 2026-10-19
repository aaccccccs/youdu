import { THEME_COLORS } from '../../../shared';
import type { ThemeType, ThemeColors } from '../../../shared';
/**
 * 获取指定主题的颜色配置（不含 custom，custom 需从 store.customThemeColors 读取）
 * 用于在 UI 中动态生成主题预览色块，避免在组件中硬编码主题颜色。
 */
export function getThemeColors(theme: ThemeType): ThemeColors {
  return { ...THEME_COLORS[theme] };
}
/**
 * 判断键盘事件是否匹配快捷键组合字符串
 *
 * 组合格式与设置页捕获逻辑（Settings.vue handleKeyCapture）完全一致：
 * "Ctrl+ArrowRight"、"Alt+B"、"Shift+F"、"F11"、"Escape"。
 * 修饰键精确匹配（按下组合之外的多余修饰键不算匹配），避免 Ctrl+B 也误触发 B。
 */
export function matchKeyboardShortcut(event: KeyboardEvent, combo: string | null | undefined): boolean {
  if (!combo) return false;
  const parts = combo
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1];
  if (event.key !== key) return false;
  if (event.ctrlKey !== parts.includes('Ctrl')) return false;
  if (event.altKey !== parts.includes('Alt')) return false;
  if (event.shiftKey !== parts.includes('Shift')) return false;
  if (event.metaKey !== parts.includes('Meta')) return false;
  return true;
}
