<!--
  拖拽区域组件（M4）

  功能：
  - 可拖拽放入文件或文件夹的区域
  - 拖入时高亮提示
  - 放下后通过 webUtils.getPathForFile 获取完整文件路径
  - 通过 emit('drop', filePaths) 把路径传给父组件处理

  注意：Electron 渲染进程的 File 对象不直接暴露完整路径，
  需通过 window.importApi.getFilePath(file) (webUtils.getPathForFile) 获取。
-->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { NIcon, NText, useMessage } from 'naive-ui';
import { CloudUpload } from '@lucide/vue';

/* ==================== 组件事件 ==================== */

const emit = defineEmits<{
  /** 文件拖放完成，返回文件路径数组 */
  drop: [filePaths: string[]];
}>();

const message = useMessage();
const { t } = useI18n();

/* ==================== 状态 ==================== */

/** 是否正在拖拽悬停 */
const isDragOver = ref(false);

/** 支持的文件扩展名 */
const SUPPORTED_EXTS = new Set(['.txt', '.epub', '.mobi', '.azw', '.azw3', '.pdf']);

/* ==================== 拖拽事件处理 ==================== */

/** 拖拽进入 */
function handleDragEnter(e: DragEvent): void {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
    isDragOver.value = true;
  }
}

/** 拖拽悬停（阻止默认行为以允许 drop） */
function handleDragOver(e: DragEvent): void {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy';
  }
}

/** 拖拽离开 */
function handleDragLeave(e: DragEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const related = e.relatedTarget as Node | null;
  const current = e.currentTarget as HTMLElement | null;
  if (related === null || !current?.contains(related)) {
    isDragOver.value = false;
  }
}

/** 拖放 */
function handleDrop(e: DragEvent): void {
  e.preventDefault();
  e.stopPropagation();
  isDragOver.value = false;

  if (!e.dataTransfer || !e.dataTransfer.files) return;

  const files = Array.from(e.dataTransfer.files);
  if (files.length === 0) return;

  const filePaths: string[] = [];
  const skippedNames: string[] = [];

  for (const file of files) {
    try {
      const path = window.importApi?.getFilePath(file);
      if (path) {
        const ext = path.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
        if (SUPPORTED_EXTS.has(ext)) {
          filePaths.push(path);
        } else {
          const name = path.split(/[\\/]/).pop() ?? path;
          skippedNames.push(name);
        }
      } else {
        skippedNames.push(file.name);
      }
    } catch {
      skippedNames.push(file.name);
      continue;
    }
  }

  if (skippedNames.length > 0) {
    const preview = skippedNames.slice(0, 3).join(t('shell.dropZone.listSeparator'));
    const suffix = skippedNames.length > 3 ? t('shell.dropZone.andMore', { count: skippedNames.length }) : '';
    message.warning(t('shell.dropZone.unsupportedSkipped', { names: preview, suffix }));
  }

  if (filePaths.length > 0) {
    emit('drop', filePaths);
  }
}
</script>

<template>
  <div
    class="drop-zone"
    :class="{ 'drag-over': isDragOver }"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- 拖拽高亮遮罩 -->
    <div v-if="isDragOver" class="drop-overlay">
      <n-icon :component="CloudUpload" :size="48" />
      <n-text class="drop-overlay-title">{{ t('shell.dropZone.releaseToImport') }}</n-text>
      <n-text depth="3" class="drop-overlay-hint">{{ t('shell.dropZone.supportedFormats') }}</n-text>
    </div>

    <!-- 默认插槽（正常内容） -->
    <slot v-else />
  </div>
</template>

<style scoped>
/*
  拖拽区域布局约束：
  - position:relative → 为遮罩提供定位上下文
  - width:100%, height:100% → 填满父容器
*/
.drop-zone {
  position: relative;
  width: 100%;
  height: 100%;
}

.drop-zone.drag-over {
  outline: 2px dashed var(--primary);
  outline-offset: -8px;
  background: var(--bg-primary-tag);
}

.drop-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 10;
  color: var(--primary);
}

.drop-overlay-title {
  font-size: var(--font-size-lg);
  font-weight: 500;
  margin-top: var(--spacing-sm-md);
}

.drop-overlay-hint {
  font-size: var(--font-size-sm);
  margin-top: var(--spacing-xs);
}
</style>
