<!--
  重新定位对话框（批次 v54 导入三模式）

  触发场景：link 模式导入的书籍原文件失效（被移动/重命名/删除或存储设备未连接），
  阅读器 loadChapter 收到主进程 [FILE_MISSING] 结构化错误 → reader store 记录
  fileMissing → Reader.vue watch 后打开本对话框。

  恢复闭环：选择新文件 → dbApi.book.relocate（主进程流式算 xxhash64 与
  books.file_hash 比对，双哈希兼容旧 SHA-256）→ 一致则静默更新 local_file_path
  并 emit relocated（Reader.vue 清空 fileMissing 并自动重试打开）；
  不一致提示"所选文件与原书不一致"，可重选。
-->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NModal, NButton, NIcon, NSpace, NText, NAlert, useMessage } from 'naive-ui';
import { FileSearch, FolderSearch } from '@lucide/vue';

/* ==================== 组件属性 ==================== */

const props = defineProps<{
  /** 是否显示 */
  show: boolean;
  /** 失效信息（reader store 的 fileMissing：bookId/原路径/hash） */
  data: { bookId: number; path: string; hash: string | null } | null;
}>();

/* ==================== 组件事件 ==================== */

const emit = defineEmits<{
  'update:show': [value: boolean];
  /** 恢复成功（Reader.vue 清空 fileMissing 并自动重试打开当前章节） */
  relocated: [];
}>();

const message = useMessage();
const { t } = useI18n();

/* ==================== 状态 ==================== */

/** 校验中（relocate 哈希计算进行时禁用按钮） */
const checking = ref(false);

/** 最近一次校验失败原因（HASH_MISMATCH 时显示，选择新文件后清除） */
const mismatch = ref(false);

/** 深度搜索执行中（P2：目录递归按哈希查找原文件） */
const searching = ref(false);

/* ==================== 操作 ==================== */

/** 选择新文件并校验（复用导入文件选择对话框，多选取第一个） */
async function handleSelectAndVerify(): Promise<void> {
  if (!props.data || !window.importApi || checking.value) return;
  mismatch.value = false;
  try {
    const paths = await window.importApi.selectFiles();
    if (paths.length === 0) return;
    const newPath = paths[0];

    checking.value = true;
    const result = await window.dbApi.book.relocate(props.data.bookId, newPath);
    checking.value = false;

    if (result.success) {
      message.success(t('bookDetail.relocate.recovered'));
      emit('relocated');
      emit('update:show', false);
      return;
    }
    if (result.error === 'HASH_MISMATCH') {
      // 所选文件与原书内容不一致：保留对话框让用户重选
      mismatch.value = true;
      return;
    }
    if (result.error === 'FILE_NOT_FOUND') {
      message.error(t('bookDetail.relocate.fileNotFound'));
      return;
    }
    message.error(t('bookDetail.relocate.failed', { msg: result.error ?? '' }));
  } catch (err) {
    checking.value = false;
    message.error(t('bookDetail.relocate.failed', { msg: (err as Error).message }));
  }
}

/**
 * 在目录中深度搜索（P2 导入三模式，设计文档第二节第 3 层深度恢复）：
 * 选目录 → 主进程按 file_hash 递归查找（深度≤6/大小过滤/xxhash64）→
 * 找到自动 relocate 恢复；未找到/超时给出对应提示，对话框保留可重试。
 */
async function handleDeepSearch(): Promise<void> {
  if (!props.data || !window.importApi || searching.value) return;
  try {
    const dir = await window.importApi.selectDirectory();
    if (!dir) return;
    searching.value = true;
    const result = await window.dbApi.book.searchFile(props.data.bookId, dir);
    searching.value = false;

    if (result.success && result.path) {
      // 命中：自动重新定位落库（searchFile 已按哈希校验，relocate 双保险）
      const reloc = await window.dbApi.book.relocate(props.data.bookId, result.path);
      if (reloc.success) {
        message.success(t('bookDetail.search.found', { path: result.path }));
        emit('relocated');
        emit('update:show', false);
        return;
      }
      message.error(t('bookDetail.relocate.failed', { msg: reloc.error ?? '' }));
      return;
    }
    if (result.error === 'TIMEOUT') {
      message.warning(t('bookDetail.search.timeout'));
      return;
    }
    if (result.error === 'NO_HASH') {
      message.warning(t('bookDetail.search.noHash'));
      return;
    }
    if (result.error === 'INVALID_DIR') {
      message.error(t('bookDetail.search.invalidDir'));
      return;
    }
    message.warning(t('bookDetail.search.notFound'));
  } catch (err) {
    searching.value = false;
    message.error(t('bookDetail.search.failed', { msg: (err as Error).message }));
  }
}

/* ==================== 对话框控制 ==================== */

watch(
  () => props.show,
  (v) => {
    if (v) mismatch.value = false;
  }
);
</script>

<template>
  <n-modal
    :show="props.show"
    @update:show="(v: boolean) => emit('update:show', v)"
    preset="card"
    :title="t('bookDetail.relocate.title')"
    class="relocate-modal"
    :bordered="false"
    :mask-closable="false"
  >
    <n-space vertical :size="16">
      <!-- 失联说明（原路径帮助用户回忆文件去向） -->
      <n-alert type="warning" :show-icon="true">
        {{ t('bookDetail.relocate.body') }}
      </n-alert>
      <div v-if="props.data" class="relocate-path">
        <n-text depth="3" class="path-label">{{ t('bookDetail.relocate.pathLabel') }}</n-text>
        <n-text code class="path-value">{{ props.data.path }}</n-text>
      </div>

      <!-- 哈希不一致提示（可重选） -->
      <n-alert v-if="mismatch" type="error" :show-icon="true">
        {{ t('bookDetail.relocate.mismatch') }}
      </n-alert>

      <n-space justify="end">
        <n-button quaternary :loading="searching" :disabled="checking" @click="handleDeepSearch">
          <template #icon>
            <n-icon :component="FolderSearch" />
          </template>
          {{ t('bookDetail.search.title') }}
        </n-button>
        <n-button quaternary @click="emit('update:show', false)">
          {{ t('common.actions.cancel') }}
        </n-button>
        <n-button type="primary" :loading="checking" :disabled="searching" @click="handleSelectAndVerify">
          <template #icon>
            <n-icon :component="FileSearch" />
          </template>
          {{ t('bookDetail.relocate.select') }}
        </n-button>
      </n-space>
    </n-space>
  </n-modal>
</template>

<style>
/* NModal preset="card" teleport 到 body，需全局样式控制宽度（同 ImportDialog 惯例） */
.relocate-modal {
  width: 520px;
  max-width: 90vw;
}
</style>

<style scoped>
.relocate-path {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.path-label {
  font-size: var(--font-size-sm);
}

.path-value {
  font-size: var(--font-size-sm);
  word-break: break-all;
}
</style>