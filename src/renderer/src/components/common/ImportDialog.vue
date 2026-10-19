<!--
  导入对话框组件（M4）

  功能：
  - 选择文件 / 选择文件夹 / 拖拽导入三种入口
  - 导入开始后显示进度，用户可选择"等完"或"隐藏到后台"
  - 隐藏到后台后导入继续，每本成功通过 IPC 事件增量显示到书架
  - 导入完成后 Bookshelf.vue 监听 IMPORT_COMPLETE 显示通知

  设计（2026-09-24）：
  - 模态框不强制锁定，导入中可点"隐藏到后台"关闭模态框
  - 导入 IPC 调用不 await，fire-and-forget 后台运行
  - 每本书导入成功 → IMPORT_BOOK_ADDED 事件 → Bookshelf 节流刷新
  - 全部完成 → IMPORT_COMPLETE 事件 → Bookshelf 显示完成通知
-->
<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { NModal, NButton, NIcon, NSpace, NText, NProgress, NTag, useMessage } from 'naive-ui';
import { Upload, Folder, CheckCircle, EyeOff } from '@lucide/vue';

/* ==================== 组件属性 ==================== */

const props = defineProps<{
  /** 是否显示 */
  show: boolean;
  /** 导入到指定分组（null=未分组，undefined=不指定） */
  groupId?: number | null;
}>();

/* ==================== 组件事件 ==================== */

const emit = defineEmits<{
  /** 关闭对话框 */
  'update:show': [value: boolean];
  /** 导入完成（用于通知父组件刷新书架） */
  imported: [];
}>();

const message = useMessage();
const { t } = useI18n();

/* ==================== 导入状态 ==================== */

type Phase = 'idle' | 'importing' | 'done';

const phase = ref<Phase>('idle');
const progressCurrent = ref(0);
const progressTotal = ref(0);
const progressFileName = ref('');
const progressStatus = ref<'hashing' | 'parsing' | 'importing' | 'done' | 'skipped' | 'failed'>('hashing');
const successCount = ref(0);
const skippedCount = ref(0);
const failedCount = ref(0);
const failedFiles = ref<string[]>([]);

/* ==================== 进度监听 ==================== */

function handleProgress(data: any): void {
  progressCurrent.value = data.current;
  progressTotal.value = data.total;
  progressFileName.value = data.fileName;
  progressStatus.value = data.status;

  if (data.status === 'done') {
    successCount.value++;
  } else if (data.status === 'skipped') {
    skippedCount.value++;
  } else if (data.status === 'failed') {
    failedCount.value++;
    if (data.reason) {
      failedFiles.value.push(`${data.fileName}: ${data.reason}`);
    }
  }
}

function startProgressListener(): void {
  window.importApi?.onProgress(handleProgress);
}

function stopProgressListener(): void {
  window.importApi?.offProgress();
}

/* ==================== 导入操作 ==================== */

/** 选择文件导入 */
async function handleSelectFiles(): Promise<void> {
  if (!window.importApi) return;
  try {
    const paths = await window.importApi.selectFiles();
    if (paths.length === 0) return;
    startImport(paths, false);
  } catch (err) {
    message.error(t('importDlg.messages.selectFilesFailed', { message: (err as Error).message }));
  }
}

/** 选择文件夹导入 */
async function handleSelectDirectory(): Promise<void> {
  if (!window.importApi) return;
  try {
    const dirPath = await window.importApi.selectDirectory();
    if (!dirPath) return;
    startImport([dirPath], true);
  } catch (err) {
    message.error(t('importDlg.messages.selectDirectoryFailed', { message: (err as Error).message }));
  }
}

/**
 * 启动导入：显示进度，fire-and-forget 后台运行
 */
function startImport(targets: string[], isDirectory: boolean): void {
  // 重置状态
  phase.value = 'importing';
  progressCurrent.value = 0;
  progressTotal.value = 0;
  progressFileName.value = '';
  successCount.value = 0;
  skippedCount.value = 0;
  failedCount.value = 0;
  failedFiles.value = [];

  startProgressListener();

  // fire-and-forget：不 await，导入在后台运行
  const promise = isDirectory
    ? window.importApi!.importDirectory(targets[0], props.groupId)
    : window.importApi!.importFiles(targets, props.groupId);

  promise
    .then((result) => {
      stopProgressListener();
      // 如果模态框仍然打开，显示完成界面
      if (props.show) {
        phase.value = 'done';
      }
      // 通知父组件刷新
      if (result?.summary?.success > 0) {
        emit('imported');
      }
    })
    .catch((err) => {
      stopProgressListener();
      if (props.show) {
        phase.value = 'done';
        failedCount.value = (failedCount.value || 0) + 1;
      }
      message.error(t('importDlg.messages.importFailed', { message: (err as Error).message }));
    });
}

/** 隐藏到后台：关闭模态框，导入继续 */
function hideToBackground(): void {
  emit('update:show', false);
  message.info(t('importDlg.backgroundInfo'));
}

/** 拖拽导入 */
async function doImport(filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) return;
  startImport(filePaths, false);
}

/** 暴露给父组件 */
defineExpose({
  importByPaths: doImport
});

/* ==================== 对话框控制 ==================== */

watch(
  () => props.show,
  (newVal) => {
    if (newVal) {
      // 打开时重置到选择界面
      phase.value = 'idle';
    } else {
      // 关闭时停止进度监听
      stopProgressListener();
    }
  }
);

onBeforeUnmount(() => {
  stopProgressListener();
});

/* ==================== 计算属性 ==================== */

/** 进度百分比 */
function progressPercent(): number {
  if (progressTotal.value === 0) return 0;
  return Math.round((progressCurrent.value / progressTotal.value) * 100);
}

/** 状态标签类型 */
function statusTagType(): 'success' | 'warning' | 'error' | 'info' | 'default' {
  switch (progressStatus.value) {
    case 'done':
      return 'success';
    case 'skipped':
      return 'warning';
    case 'failed':
      return 'error';
    case 'hashing':
      return 'info';
    case 'parsing':
      return 'info';
    default:
      return 'default';
  }
}

/** 状态标签文字 */
function statusText(): string {
  switch (progressStatus.value) {
    case 'hashing':
      return t('importDlg.status.hashing');
    case 'parsing':
      return t('importDlg.status.parsing');
    case 'done':
      return t('importDlg.status.success');
    case 'skipped':
      return t('importDlg.status.skipped');
    case 'failed':
      return t('importDlg.status.failed');
    default:
      return '';
  }
}
</script>

<template>
  <n-modal
    :show="props.show"
    @update:show="(v: boolean) => emit('update:show', v)"
    :mask-closable="phase !== 'importing'"
    :close-on-esc="phase !== 'importing'"
    preset="card"
    :title="t('importDlg.title')"
    class="import-modal"
    :bordered="false"
  >
    <!-- 选择导入方式 -->
    <div v-if="phase === 'idle'" class="import-actions">
      <n-space vertical :size="16">
        <n-button type="primary" size="large" block @click="handleSelectFiles">
          <template #icon>
            <n-icon :component="Upload" />
          </template>
          {{ t('importDlg.selectFiles') }}
        </n-button>
        <n-button size="large" block @click="handleSelectDirectory">
          <template #icon>
            <n-icon :component="Folder" />
          </template>
          {{ t('importDlg.selectDirectory') }}
        </n-button>
        <n-text depth="3" class="import-hint">
          {{ t('importDlg.hint') }}
        </n-text>
      </n-space>
    </div>

    <!-- 导入进度 -->
    <div v-else-if="phase === 'importing'" class="import-progress">
      <n-space vertical :size="12">
        <!-- 进度条 -->
        <n-progress
          type="line"
          :percentage="progressPercent()"
          :height="8"
          :indicator-placement="'inside'"
          processing
        />

        <!-- 当前文件信息 -->
        <div class="progress-info">
          <n-text depth="2" class="progress-file">
            {{
              t('importDlg.currentFile', {
                current: progressCurrent,
                total: progressTotal,
                name: progressFileName
              })
            }}
          </n-text>
          <n-tag :type="statusTagType()" size="small" round>
            {{ statusText() }}
          </n-tag>
        </div>

        <!-- 统计 -->
        <div class="progress-stats">
          <n-tag type="success" size="small" :bordered="false">{{
            t('importDlg.tags.success', { n: successCount })
          }}</n-tag>
          <n-tag type="warning" size="small" :bordered="false" v-if="skippedCount > 0">{{
            t('importDlg.tags.skipped', { n: skippedCount })
          }}</n-tag>
          <n-tag type="error" size="small" :bordered="false" v-if="failedCount > 0">{{
            t('importDlg.tags.failed', { n: failedCount })
          }}</n-tag>
        </div>

        <!-- 隐藏到后台按钮 -->
        <div class="progress-actions">
          <n-button size="small" @click="hideToBackground" secondary>
            <template #icon>
              <n-icon :component="EyeOff" />
            </template>
            {{ t('importDlg.hideToBackground') }}
          </n-button>
          <n-text depth="3" style="font-size: 12px"> {{ t('importDlg.backgroundHint') }} </n-text>
        </div>
      </n-space>
    </div>

    <!-- 导入完成 -->
    <div v-else-if="phase === 'done'" class="import-done">
      <n-space vertical :size="12">
        <div class="done-summary">
          <n-icon :component="CheckCircle" size="24" color="var(--success-color)" />
          <n-text style="font-size: 16px; font-weight: 500"> {{ t('importDlg.doneTitle') }} </n-text>
        </div>
        <div class="done-stats">
          <n-tag type="success" :bordered="false">{{ t('importDlg.done.success', { n: successCount }) }}</n-tag>
          <n-tag type="warning" :bordered="false" v-if="skippedCount > 0">{{
            t('importDlg.done.skipped', { n: skippedCount })
          }}</n-tag>
          <n-tag type="error" :bordered="false" v-if="failedCount > 0">{{
            t('importDlg.done.failed', { n: failedCount })
          }}</n-tag>
        </div>
        <div v-if="failedFiles.length > 0" class="failed-list">
          <n-text depth="3" style="font-size: 12px">{{ t('importDlg.failedDetails') }}</n-text>
          <div v-for="f in failedFiles.slice(0, 5)" :key="f" class="failed-item">
            <n-text depth="3" style="font-size: 11px">{{ f }}</n-text>
          </div>
          <n-text v-if="failedFiles.length > 5" depth="3" style="font-size: 11px">
            {{ t('importDlg.moreFailed', { n: failedFiles.length - 5 }) }}
          </n-text>
        </div>
        <n-button type="primary" block @click="emit('update:show', false)">{{ t('common.actions.confirm') }}</n-button>
      </n-space>
    </div>
  </n-modal>
</template>

<style>
/* NModal preset="card" 时，class="import-modal" 传递给 NCard，但 NModal teleport
   到 body 后，NCard 脱离了 ImportDialog 的 DOM 树，scoped CSS（包括 :deep()）
   无法匹配。必须使用全局样式（非 scoped）才能匹配 NCard。 */
.import-modal {
  width: 480px;
  max-width: 90vw;
}

.import-modal .n-card__content {
  max-height: 70vh;
  overflow-y: auto;
  padding: var(--spacing-md) var(--spacing-lg);
}

.import-modal .n-card-header {
  padding: var(--spacing-sm-md) var(--spacing-lg);
}
</style>

<style scoped>
.import-actions {
  padding: var(--spacing-md) 0;
}

.import-hint {
  font-size: var(--font-size-sm);
  display: block;
  text-align: center;
}

.import-progress {
  padding: var(--spacing-sm) 0;
}

.progress-info {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}

.progress-file {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.progress-stats {
  display: flex;
  gap: 8px;
}

.progress-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}

.import-done {
  padding: var(--spacing-md) 0;
}

.done-summary {
  display: flex;
  align-items: center;
  gap: 8px;
}

.done-stats {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.failed-list {
  margin-top: 8px;
}

.failed-item {
  margin-top: 4px;
  padding: 4px 8px;
  background: var(--error-color-suppl);
  border-radius: 4px;
}
</style>
