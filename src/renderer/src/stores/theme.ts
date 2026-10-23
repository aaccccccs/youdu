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
 * "Ctrl+ArrowRight"、"Alt+B"、"Shift+F"、"F11"、"Escape"、"Space"。
 * 修饰键精确匹配（按下组合之外的多余修饰键不算匹配），避免 Ctrl+B 也误触发 B。
 *
 * P2-4（导航审计 #4）：Space 键双侧归一化——事件侧 event.key === ' ' 转为
 * 字面 'Space'（存储/捕获侧同样归一）；combo 侧各段 trim 后空串段同样归一为
 * 'Space'。原实现 `' '.trim()===''` 被 filter(Boolean) 剔除 → parts 为空 →
 * 永不匹配：用户把动作绑定为空格后 UI 显示"已设置"但运行时静默失效。
 */
export function matchKeyboardShortcut(event: KeyboardEvent, combo: string | null | undefined): boolean {
  if (!combo) return false;
  const parts = combo
    .split('+')
    .map((s) => s.trim())
    // P2-4：空段归一为 'Space'（裸空格 ' ' 或 'Ctrl+ ' 的尾段），保留字面
    // 'Space' 段原样通过（trim 不影响非空段）
    .map((s) => (s === '' ? 'Space' : s))
    .filter(Boolean);
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1];
  // P2-4：事件侧空格键归一化（Chromium 的空格 event.key 为 ' '）
  const eventKey = event.key === ' ' ? 'Space' : event.key;
  if (eventKey !== key) return false;
  if (event.ctrlKey !== parts.includes('Ctrl')) return false;
  if (event.altKey !== parts.includes('Alt')) return false;
  if (event.shiftKey !== parts.includes('Shift')) return false;
  if (event.metaKey !== parts.includes('Meta')) return false;
  return true;
}
