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
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { NModal, NButton, NIcon, NSpace, NText, NProgress, NTag, NRadioGroup, NRadio, useMessage } from 'naive-ui';
import { Upload, Folder, CheckCircle, EyeOff, Info } from '@lucide/vue';
import { useSettingsStore } from '@renderer/stores/settings';
import type { ImportMode } from '../../../../shared';

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
const settingsStore = useSettingsStore();

/* ==================== 导入状态 ==================== */

type Phase = 'idle' | 'confirm' | 'importing' | 'done';

/* ==================== 导入模式确认（批次 v54 导入三模式） ==================== */

/** 待确认的导入任务（选定文件/目录后先弹模式确认，再执行） */
const pendingTargets = ref<string[]>([]);
const pendingIsDirectory = ref(false);

/** 选中的导入模式（打开确认相时初始化为用户设置的默认模式） */
const selectedMode = ref<ImportMode>('copy');


/**
 * 本次导入使用的默认模式（问题3修复）：非 null 表示因"跳过导入方式选择"设置
 * 直接以默认模式启动导入（未弹确认相），进度相展示提示、指引到设置页更改。
 */
const usedDefaultMode = ref<ImportMode | null>(null);


/** 进入模式确认相：填充默认选中并切换 phase */
function enterConfirm(targets: string[], isDirectory: boolean): void {
  pendingTargets.value = targets;
  pendingIsDirectory.value = isDirectory;
  // 问题3修复：设置"跳过导入方式选择"时不弹确认相，直接以默认模式启动导入
  // （用户想改模式时去 设置 → 数据 → 关闭"跳过导入方式选择"开关）
  if (settingsStore.skipImportModeDialog) {
    startImport(targets, isDirectory, settingsStore.defaultImportMode);
    usedDefaultMode.value = settingsStore.defaultImportMode;
    return;
  }
  usedDefaultMode.value = null;
  // 默认选中用户设置的默认导入模式（批次 v54；未设置时为 'copy'）。
  // v57：移除"设为默认导入模式"复选框（用户定稿：该选择框冗余无意义）——
  // 想改默认模式去 设置 → 数据 → 默认导入模式
  selectedMode.value = settingsStore.defaultImportMode;
  phase.value = 'confirm';
}

/**
 * 选定即执行（无二次确认）：直接启动导入。
 * 复制模式不问是否删源文件（"复制就复制"）——move/link 的后果在选项说明里已写清楚。
 */
function confirmImport(): void {
  startImport(pendingTargets.value, pendingIsDirectory.value, selectedMode.value);
}

/** 从确认相返回选择界面 */
function backToIdle(): void {
  phase.value = 'idle';
}

const phase = ref<Phase>('idle');
const progressCurrent = ref(0);
const progressTotal = ref(0);
const progressFileName = ref('');
const progressStatus = ref<'hashing' | 'parsing' | 'importing' | 'done' | 'skipped' | 'failed'>('hashing');
const successCount = ref(0);
const skippedCount = ref(0);
const failedCount = ref(0);
const failedFiles = ref<string[]>([]);
/** C-5修复：跳过明细（文件名 + reason）——done 相展示，用户可见跳过原因 */
const skippedFiles = ref<string[]>([]);

/** 是否全部跳过（问题2修复）：successCount=0 且 skippedCount>0，完成相专属展示 */
const allSkipped = computed(() => successCount.value === 0 && skippedCount.value > 0);

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
    // C-5修复：收集跳过明细（如"书库已有此书（当前为复制模式）…"）——
    // 原 done 相只显示计数，用户不知道为何被跳、如何处理
    if (data.reason) {
      skippedFiles.value.push(`${data.fileName}: ${data.reason}`);
    }
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

/** 选择文件导入（选定后先弹模式确认） */
async function handleSelectFiles(): Promise<void> {
  if (!window.importApi) return;
  try {
    const paths = await window.importApi.selectFiles();
    if (paths.length === 0) return;
    enterConfirm(paths, false);
  } catch (err) {
    message.error(t('importDlg.messages.selectFilesFailed', { message: (err as Error).message }));
  }
}

/** 选择文件夹导入（选定后先弹模式确认，整目录逐文件用同一模式） */
async function handleSelectDirectory(): Promise<void> {
  if (!window.importApi) return;
  try {
    const dirPath = await window.importApi.selectDirectory();
    if (!dirPath) return;
    enterConfirm([dirPath], true);
  } catch (err) {
    message.error(t('importDlg.messages.selectDirectoryFailed', { message: (err as Error).message }));
  }
}

/**
 * 启动导入：显示进度，fire-and-forget 后台运行
 *
 * @param targets 文件路径数组或单目录路径
 * @param isDirectory targets 是否为目录导入
 * @param mode 导入模式（批次 v54）：copy=复制 / move=移入 / link=引用原路径
 */
function startImport(targets: string[], isDirectory: boolean, mode: ImportMode = 'copy'): void {
  // 重置状态
  phase.value = 'importing';
  progressCurrent.value = 0;
  progressTotal.value = 0;
  progressFileName.value = '';
  successCount.value = 0;
  skippedCount.value = 0;
  failedCount.value = 0;
  failedFiles.value = [];
  skippedFiles.value = [];
  usedDefaultMode.value = null;

  startProgressListener();

  // fire-and-forget：不 await，导入在后台运行（mode 透传主进程）
  const promise = isDirectory
    ? window.importApi!.importDirectory(targets[0], props.groupId, mode)
    : window.importApi!.importFiles(targets, props.groupId, undefined, mode);

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

/** 拖拽导入（同样先弹模式确认：拖拽与按钮入口行为一致，一次确认即执行） */
async function doImport(filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) return;
  enterConfirm(filePaths, false);
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

    <!-- 导入模式确认（批次 v54：三选一卡片 + 记住默认，选定即执行无二次确认） -->
    <div v-else-if="phase === 'confirm'" class="mode-confirm">
      <n-space vertical :size="16">
        <n-text depth="2" class="mode-title">{{ t('import.mode.title') }}</n-text>
        <n-radio-group v-model:value="selectedMode" name="import-mode" class="mode-group">
          <n-space vertical :size="12" class="mode-cards">
            <div class="mode-card" :class="{ selected: selectedMode === 'copy' }">
              <n-radio value="copy">
                <span class="mode-name">{{ t('import.mode.copy') }}</span>
              </n-radio>
              <n-text depth="3" class="mode-desc">{{ t('import.mode.copyDesc') }}</n-text>
            </div>
            <div class="mode-card" :class="{ selected: selectedMode === 'move' }">
              <n-radio value="move">
                <span class="mode-name">{{ t('import.mode.move') }}</span>
              </n-radio>
              <n-text depth="3" class="mode-desc">{{ t('import.mode.moveDesc') }}</n-text>
            </div>
            <div class="mode-card" :class="{ selected: selectedMode === 'link' }">
              <n-radio value="link">
                <span class="mode-name">{{ t('import.mode.link') }}</span>
              </n-radio>
              <n-text depth="3" class="mode-desc">{{ t('import.mode.linkDesc') }}</n-text>
            </div>
          </n-space>
        </n-radio-group>

        <n-space justify="space-between">
          <n-button size="small" quaternary @click="backToIdle">{{ t('common.actions.back') }}</n-button>
          <n-button type="primary" @click="confirmImport">{{ t('import.mode.confirm') }}</n-button>
        </n-space>
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

        <!-- 问题3修复：因"跳过导入方式选择"设置直接使用默认模式时的提示 -->
        <n-text v-if="usedDefaultMode" depth="3" style="font-size: 12px">
          {{ t('importDlg.usingDefaultMode', { mode: t(`import.mode.${usedDefaultMode}`) }) }}
        </n-text>

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
          <!-- 问题2修复：全部跳过（success=0 且 skipped>0）时用信息图标 + 专属标题，非成功对勾 -->
          <n-icon
            :component="allSkipped ? Info : CheckCircle"
            size="24"
            :color="allSkipped ? 'var(--warning-color, #f0a020)' : 'var(--success-color)'"
          />
          <n-text style="font-size: 16px; font-weight: 500">
            {{ allSkipped ? t('importDlg.done.allSkippedTitle') : t('importDlg.doneTitle') }}
          </n-text>
        </div>
        <!-- 问题2修复：全部跳过时副文案明确说明（替代"成功导入 0 本"的困惑） -->
        <n-text v-if="allSkipped" depth="3" style="font-size: 13px">
          {{ t('importDlg.done.allSkippedDesc', { n: skippedCount }) }}
        </n-text>
        <div class="done-stats">
          <!-- 全部跳过时隐藏"成功导入 0 本"成功 tag（跳过明细见下方 skippedFiles 列表） -->
          <n-tag v-if="!allSkipped" type="success" :bordered="false">{{
            t('importDlg.done.success', { n: successCount })
          }}</n-tag>
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
        <!-- C-5修复：跳过明细列表（复用 failedFiles 展示样式）——用户可见跳过原因
             （如 link 模式去重：书库已有同 hash 的 copy 书）与处理引导 -->
        <div v-if="skippedFiles.length > 0" class="skipped-list">
          <n-text depth="3" style="font-size: 12px">{{ t('importDlg.skippedDetails') }}</n-text>
          <div v-for="s in skippedFiles.slice(0, 5)" :key="s" class="skipped-item">
            <n-text depth="3" style="font-size: 11px">{{ s }}</n-text>
          </div>
          <n-text v-if="skippedFiles.length > 5" depth="3" style="font-size: 11px">
            {{ t('importDlg.moreSkipped', { n: skippedFiles.length - 5 }) }}
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

/* ─── 导入模式确认相（批次 v54） ─── */
.mode-confirm {
  padding: var(--spacing-sm) 0;
}

.mode-title {
  font-size: var(--font-size-md);
  font-weight: 500;
}

.mode-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--spacing-sm-md) var(--spacing-md);
  border: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.2));
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.mode-card.selected {
  border-color: var(--primary);
}

.mode-name {
  font-weight: 500;
}

.mode-desc {
  font-size: var(--font-size-sm);
  line-height: 1.5;
  display: block;
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

/* C-5：跳过明细（对齐 failed-item 布局，警告色调） */
.skipped-list {
  margin-top: 8px;
}

.skipped-item {
  margin-top: 4px;
  padding: 4px 8px;
  background: var(--warning-color-suppl, rgba(240, 160, 32, 0.12));
  border-radius: 4px;
}
</style>
