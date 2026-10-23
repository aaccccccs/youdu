<!--
  漫画图片全屏查看器（v56 P0 竞品对标：Calibre 式双击插图独立查看）

  功能：
  - Teleport to body 的全屏 overlay（深黑背景，不挤占阅读区）
  - 图片按原始尺寸居中显示（无 max-width/max-height 约束，超出屏幕可平移查看）
  - 鼠标拖拽平移（任意缩放状态均可拖；原尺寸大图超屏直接拖看）
  - Ctrl+滚轮缩放（0.25x~4x，缩放中心跟随鼠标——锚定数学与
    ComicPageMode.setZoom 一致：scale() translate() + 鼠标位置保持公式）
  - 双击图片 1x↔2x（原页内双击放大行为迁移至此，锚定双击位置）
  - Esc / 点击背景关闭；点击图片本身不关闭（避免误触）
  - 底部信息栏：原图尺寸 × 当前缩放百分比（如 1920×1080 · 125%）
  - 底部操作提示（双击缩放/Ctrl+滚轮缩放/拖拽/Esc）

  入口：ComicViewer 统一挂载——
  - ComicScrollMode/ComicPageMode 双击图片 emit view-image → 打开
  - Reader 右键菜单"全屏查看原图"经 ComicViewer.openLightbox 打开
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { coverPathToUrl } from '@renderer/utils';
import { bindOverlayLightboxVisible } from '@renderer/stores';
import type { ChapterImage } from '../../../../shared';

const props = withDefaults(
  defineProps<{
    /** 是否显示 */
    show: boolean;
    /** 待查看的图片（path 为磁盘绝对路径；pending 占位条目由调用方过滤） */
    image: ChapterImage | null;
  }>(),
  {
    show: false,
    image: null
  }
);

const emit = defineEmits<{
  (e: 'update:show', show: boolean): void;
}>();

const { t } = useI18n();

/* ==================== 缩放与平移状态（数学与 ComicPageMode.setZoom 同构） ==================== */

/** 缩放上下限：1x=原始尺寸；0.25x 可缩小看全超大图，4x 看细节 */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const scale = ref<number>(1);
/** 平移偏移 X/Y（px，translate 在 scale 之后应用） */
const offsetX = ref<number>(0);
const offsetY = ref<number>(0);

/** 图片元素引用（锚定计算 + 尺寸兜底） */
const imgEl = ref<HTMLImageElement | null>(null);
/** 图片自然尺寸（onload 兜底补充，ChapterImage 无尺寸数据时仍能显示信息） */
const naturalWidth = ref<number>(0);
const naturalHeight = ref<number>(0);

/** 重置缩放/平移（打开、切换图片时调用） */
function resetView(): void {
  scale.value = 1;
  offsetX.value = 0;
  offsetY.value = 0;
  naturalWidth.value = 0;
  naturalHeight.value = 0;
}

/**
 * 设置缩放（支持以鼠标位置为锚定点，保持鼠标指向内容点视觉不动）。
 * 数学与 ComicPageMode.setZoom / ComicScrollMode.setGlobalZoom 完全一致：
 * 取 img 当前（变换后）getBoundingClientRect 中心，按新旧比例换算 translate 偏移。
 */
function setZoom(newScale: number, mouseX?: number, mouseY?: number): void {
  const oldScale = scale.value;
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newScale));
  let newOffsetX = oldScale > 0 ? (offsetX.value * oldScale) / clamped : 0;
  let newOffsetY = oldScale > 0 ? (offsetY.value * oldScale) / clamped : 0;
  if (mouseX !== undefined && mouseY !== undefined && imgEl.value && oldScale > 0) {
    const rect = imgEl.value.getBoundingClientRect();
    const cxScreen = rect.left + rect.width / 2;
    const cyScreen = rect.top + rect.height / 2;
    newOffsetX = (mouseX - cxScreen) * (1 / clamped - 1 / oldScale) + (offsetX.value * oldScale) / clamped;
    newOffsetY = (mouseY - cyScreen) * (1 / clamped - 1 / oldScale) + (offsetY.value * oldScale) / clamped;
  }
  // 缩放回 1x 时重置偏移（回到居中原始尺寸状态）
  if (clamped === 1) {
    newOffsetX = 0;
    newOffsetY = 0;
  }
  scale.value = clamped;
  offsetX.value = newOffsetX;
  offsetY.value = newOffsetY;
}

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey) return;
  event.preventDefault();
  const delta = event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
  setZoom(scale.value + delta, event.clientX, event.clientY);
}

/* ==================== 拖拽平移（鼠标） ==================== */

const isDragging = ref<boolean>(false);
let dragStartX = 0;
let dragStartY = 0;
let dragStartOffsetX = 0;
let dragStartOffsetY = 0;
/** 本次拖拽是否产生实际位移（区分"平移拖拽"与"点击背景"，防拖拽松手误关） */
let dragMoved = false;

function onDragStart(event: MouseEvent): void {
  isDragging.value = true;
  dragMoved = false;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  dragStartOffsetX = offsetX.value;
  dragStartOffsetY = offsetY.value;
  event.preventDefault();
}

function onDragMove(event: MouseEvent): void {
  if (!isDragging.value) return;
  const dx = event.clientX - dragStartX;
  const dy = event.clientY - dragStartY;
  // 位移超过阈值视为平移拖拽（松手后的 click 不再关闭）
  if (!dragMoved && Math.abs(dx) + Math.abs(dy) > 3) {
    dragMoved = true;
  }
  offsetX.value = dragStartOffsetX + dx;
  offsetY.value = dragStartOffsetY + dy;
}

function onDragEnd(): void {
  isDragging.value = false;
}

/** 点击背景关闭（拖拽平移松手触发的 click 不关闭——消费位移标记） */
function onBackgroundClick(): void {
  if (dragMoved) {
    dragMoved = false;
    return;
  }
  close();
}

/* ==================== 双击 1x ↔ 2x（原页内行为迁移至此） ==================== */

function onImageDoubleClick(event: MouseEvent): void {
  if (scale.value > 1) {
    setZoom(1);
  } else {
    setZoom(2, event.clientX, event.clientY);
  }
}

/* ==================== 关闭与键盘 ==================== */

function close(): void {
  emit('update:show', false);
}

/** Esc 关闭（焦点在输入框时不拦截，与阅读器键盘惯例一致） */
function onKeyDown(event: KeyboardEvent): void {
  if (!props.show) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;
  }
  if (event.key === 'Escape') {
    // P1-1 兜底（主守卫见 stores/ui.ts 的 overlayLightboxOpen）：阻止同一
    // Escape 继续派发给 Reader.handleKeydown 等后续 window 监听。当前注册
    // 顺序（子组件先于 Reader mounted）保证本监听先执行，未来顺序变化时
    // 由 Reader 侧守卫兜底，双保险。
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }
}

/* ==================== 图片加载（尺寸信息兜底） ==================== */

function onImageLoad(event: Event): void {
  const img = event.target as HTMLImageElement | null;
  if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
    naturalWidth.value = img.naturalWidth;
    naturalHeight.value = img.naturalHeight;
  }
}

/** 信息栏展示尺寸：ChapterImage 元数据优先，onload 自然尺寸兜底 */
const infoWidth = computed<number>(() => props.image?.width || naturalWidth.value);
const infoHeight = computed<number>(() => props.image?.height || naturalHeight.value);

/** 信息栏文本：原图尺寸 · 当前缩放百分比 */
const sizeInfoText = computed<string>(() => {
  if (infoWidth.value <= 0 || infoHeight.value <= 0) return `${Math.round(scale.value * 100)}%`;
  return `${infoWidth.value} × ${infoHeight.value} · ${Math.round(scale.value * 100)}%`;
});

/** 图片 URL（show 时不渲染空 src） */
const imageUrl = computed<string | null>(() =>
  props.show && props.image?.path ? coverPathToUrl(props.image.path) : null
);

/* ==================== 状态重置时机 ==================== */

// P1-1：将灯箱打开状态上报全局覆盖层计数（Reader.handleKeydown 开头守卫用，
// 防止 Esc 关灯箱的同时被 Reader 的"逐级关闭"消费成退出阅读器）
bindOverlayLightboxVisible(() => props.show);

// 打开/切换图片时重置缩放与尺寸信息
watch(
  () => [props.show, props.image?.path] as const,
  ([show]) => {
    if (show) resetView();
  }
);

/* ==================== 生命周期（全局事件常驻，show 时才响应） ==================== */

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="lightbox-fade">
      <div
        v-if="show && image && imageUrl"
        class="comic-lightbox"
        :class="{ dragging: isDragging }"
        @wheel="onWheel"
        @click.self="onBackgroundClick"
        @contextmenu.prevent
        @mousedown="onDragStart"
      >
        <img
          ref="imgEl"
          :src="imageUrl"
          :alt="t('comic.viewer.fullscreenImage')"
          :style="{
            transform:
              scale !== 1 || offsetX !== 0 || offsetY !== 0
                ? `scale(${scale}) translate(${offsetX}px, ${offsetY}px)`
                : 'none',
            cursor: isDragging ? 'grabbing' : 'grab'
          }"
          draggable="false"
          @load="onImageLoad"
          @click.stop
          @dblclick.stop="onImageDoubleClick"
        />
        <!-- 尺寸信息（左下） -->
        <div class="lightbox-info">{{ sizeInfoText }}</div>
        <!-- 操作提示（底部居中） -->
        <div class="lightbox-hint">{{ t('comic.viewer.hint') }}</div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.comic-lightbox {
  /* 全屏覆盖（Teleport to body，脱离阅读区层级） */
  position: fixed;
  inset: 0;
  z-index: 3000;
  /* Calibre 式深黑背景：隔绝阅读区视觉干扰，突出图片本身。
   * 该场景为「有意的独立深色空间」，其遮罩与浮层色统一走跨主题固定令牌
   * （--scrim-opaque / --overlay-*），刻意不随浅色/深色主题切换。 */
  background: var(--scrim-opaque);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  user-select: none;
}

/* 原始尺寸显示：不加 max-width/max-height 约束（超屏部分拖拽查看） */
.comic-lightbox img {
  display: block;
  max-width: none;
  max-height: none;
  width: auto;
  height: auto;
  transform-origin: center center;
  transition: transform 0.15s ease;
  -webkit-user-drag: none;
}

/* 拖拽中禁用过渡，保证平移跟手（与阅读模式组件同款处理） */
.comic-lightbox.dragging img {
  transition: none;
}

/* 尺寸信息（左下角，半透明胶囊） */
.lightbox-info {
  position: absolute;
  left: 16px;
  bottom: 16px;
  padding: 5px 14px;
  border-radius: 4px;
  background: var(--overlay-surface);
  color: var(--overlay-text);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.5px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--overlay-border);
}

/* 操作提示（底部居中，弱化存在感） */
.lightbox-hint {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 16px;
  padding: 5px 16px;
  border-radius: 4px;
  background: var(--overlay-surface-soft);
  color: var(--overlay-text-muted);
  font-size: 12px;
  letter-spacing: 1px;
  pointer-events: none;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

/* 淡入淡出 */
.lightbox-fade-enter-active,
.lightbox-fade-leave-active {
  transition: opacity 0.2s ease;
}

.lightbox-fade-enter-from,
.lightbox-fade-leave-to {
  opacity: 0;
}
</style>
