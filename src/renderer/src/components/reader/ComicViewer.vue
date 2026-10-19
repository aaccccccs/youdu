<!--
  漫画阅读器外壳组件（精简版）

  功能：
  - 根据 mode 渲染 ComicScrollMode 或 ComicPageMode
  - 转发子组件的事件
  - 向父组件暴露统一的方法接口

  基于13个平台调研结论，只保留核心体验：滚动模式 + 翻页模式
-->
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettingsStore } from '@renderer/stores';
import ComicScrollMode from './ComicScrollMode.vue';
import ComicPageMode from './ComicPageMode.vue';

const props = withDefaults(
  defineProps<{
    /** 图片文件路径列表 */
    images: string[];
    /** 阅读模式：'scroll'=垂直滚动，'page'=翻页 */
    mode?: 'scroll' | 'page';
  }>(),
  {
    images: () => [],
    mode: 'scroll'
  }
);

const emit = defineEmits<{
  /** 阅读模式切换 */
  (e: 'update:mode', mode: 'scroll' | 'page'): void;
  /** 滚动进度变化（0~1），仅滚动模式触发 */
  (e: 'scroll-progress', progress: number): void;
  /** 请求加载下一章 */
  (e: 'request-next-chapter'): void;
  /** 请求加载上一章 */
  (e: 'request-prev-chapter'): void;
  /** 切换工具栏显示/隐藏（翻页模式中间区域点击时触发） */
  (e: 'toggle-toolbar'): void;
  /** 当前页码变化（1-based），供父组件响应式跟踪 */
  (e: 'page-change', page: number): void;
}>();

const settings = useSettingsStore();
const { t } = useI18n();

/* ==================== 子组件引用 ==================== */

const scrollRef = ref<InstanceType<typeof ComicScrollMode> | null>(null);
const pageRef = ref<InstanceType<typeof ComicPageMode> | null>(null);

/* ==================== 当前页码上下文 ==================== */

/** 当前页码（1-based），用于 getCurrentPageContext */
const currentPage = ref<number>(1);

/** 总页数 */
const totalPages = computed<number>(() => props.images.length || 1);

function onPageChange(page: number): void {
  currentPage.value = page;
  emit('page-change', page);
}

/* ==================== 暴露方法 ==================== */

defineExpose({
  /** 翻到下一页（仅翻页模式有效） */
  nextPage(): void {
    pageRef.value?.nextPage();
  },
  /** 翻到上一页（仅翻页模式有效） */
  prevPage(): void {
    pageRef.value?.prevPage();
  },
  /** 跳转到指定页（1-based） */
  goToPage(page: number): void {
    if (props.mode === 'scroll') {
      scrollRef.value?.goToPage(page);
    } else {
      pageRef.value?.goToPage(page - 1);
    }
  },
  /** 跳转到归一化位置（0~1），用于恢复阅读进度 */
  goToPosition(position: number): void {
    if (props.mode === 'page') {
      // 翻页模式：position 转为页码
      const page = Math.round(position * (totalPages.value - 1));
      pageRef.value?.goToPage(page);
    } else if (props.mode === 'scroll') {
      // 滚动模式：用页码估算滚动位置
      const page = Math.max(1, Math.min(totalPages.value, Math.ceil(position * totalPages.value)));
      scrollRef.value?.goToPage(page);
    }
  },
  /** 获取当前归一化位置（0~1） */
  getCurrentPosition(): number {
    if (props.mode === 'page') {
      if (totalPages.value <= 1) return 0;
      return (currentPage.value - 1) / (totalPages.value - 1);
    }
    if (scrollRef.value) {
      return scrollRef.value.getCurrentPosition();
    }
    return 0;
  },
  /** 获取当前页码上下文（"3 / 30" 格式） */
  getCurrentPageContext(): string {
    const total = totalPages.value;
    if (total === 0) return '';
    return t('comic.page.ofTotal', { current: currentPage.value, total });
  }
});
</script>

<template>
  <div class="comic-viewer">
    <ComicScrollMode
      v-if="mode === 'scroll'"
      ref="scrollRef"
      :images="images"
      @scroll-progress="$emit('scroll-progress', $event)"
      @request-next-chapter="$emit('request-next-chapter')"
      @request-prev-chapter="$emit('request-prev-chapter')"
      @page-change="onPageChange"
    />
    <ComicPageMode
      v-else
      ref="pageRef"
      :images="images"
      :read-direction="settings.comicReadDirection"
      @page-change="onPageChange"
      @request-next-chapter="$emit('request-next-chapter')"
      @request-prev-chapter="$emit('request-prev-chapter')"
      @toggle-toolbar="$emit('toggle-toolbar')"
    />
  </div>
</template>

<style scoped>
.comic-viewer {
  width: 100%;
  height: 100%;
  background: var(--reader-bg, #000);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}
</style>
