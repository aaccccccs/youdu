import { ref, computed, watch, onScopeDispose } from 'vue';

/**
 * 全局 UI 覆盖层状态（非持久化、跨组件模块级单例）。
 *
 * P1-1 修复背景（导航审计 #1）：图片模式 ComicLightbox / 文本插图
 * useInlineImageLightbox 的 Esc 关闭监听与 Reader.handleKeydown 是两个独立的
 * window keydown listener——preventDefault 无法阻止后者继续消费同一 Escape，
 * 导致"看大图按 Esc 关图的同时整个阅读器被退出"。
 *
 * 解法（审计推荐方案 a）：把灯箱打开状态提升为全局可见的模块级计数，
 * Reader.handleKeydown 开头检查——灯箱是最高层 UI，打开期间阅读器快捷键
 * 全部旁路（Escape 只关灯箱，由灯箱自身的监听处理）。
 *
 * 用计数而非布尔：灯箱有两个互斥入口（图片/文本），但注册方可能随模式切换
 * 先后挂载，计数天然支持多实例叠加与解绑清理，避免"后来者覆盖先来者"的
 * 布尔竞态。
 */
const overlayLightboxCount = ref<number>(0);

/** 是否有任意灯箱（ComicLightbox / 文本插图 lightbox）处于打开状态 */
export const overlayLightboxOpen = computed<boolean>(() => overlayLightboxCount.value > 0);

/**
 * 将一个灯箱的可见状态（getter/ref 均可）绑定到全局覆盖层计数。
 *
 * 绑定时机与语义：
 * - watch 默认 pre flush：keydown 事件序列中灯箱监听器先（同步）置 false，
 *   Reader 监听器随后执行时计数尚未 flush 递减 → 守卫仍拦截本次 Escape
 *   （单次按键只关灯箱，正是期望语义）；事件结束后微任务 flush 修正计数。
 * - onScopeDispose：灯箱打开期间宿主组件被卸载（阅读模式切换等）时回收计数，
 *   防止计数泄漏导致阅读器快捷键永久旁路。
 *
 * @param visible 灯箱可见状态（返回 boolean 的 getter；props 解包与内部 ref 均适用）
 */
export function bindOverlayLightboxVisible(visible: () => boolean): void {
  watch(
    visible,
    (v, old) => {
      if (v === old) return;
      overlayLightboxCount.value = Math.max(0, overlayLightboxCount.value + (v ? 1 : -1));
    }
  );
  onScopeDispose(() => {
    if (visible()) {
      overlayLightboxCount.value = Math.max(0, overlayLightboxCount.value - 1);
    }
  });
}