<!--
  漫画阅读器外壳组件（精简版）

  功能：
  - 根据 mode 渲染 ComicScrollMode 或 ComicPageMode
  - 转发子组件的事件
  - 向父组件暴露统一的方法接口
  - v56 P0 对标 Calibre：双击图片全屏原尺寸查看（ComicLightbox）——
    子组件 emit view-image 时打开；Reader 右键菜单经 openLightbox 打开

  基于13个平台调研结论，只保留核心体验：滚动模式 + 翻页模式
-->
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChapterImage } from '../../../../shared';
import { useSettingsStore } from '@renderer/stores';
import ComicScrollMode from './ComicScrollMode.vue';
import ComicPageMode from './ComicPageMode.vue';
import ComicLightbox from './ComicLightbox.vue';

const props = withDefaults(
  defineProps<{
    /** 图片列表（v49 起含真实尺寸） */
    images: ChapterImage[];
    /** 阅读模式：'scroll'=垂直滚动，'page'=翻页 */
    mode?: 'scroll' | 'page';
    /** 自动滚动开关（仅滚动模式生效，对齐文字 ScrollView） */
    autoScroll?: boolean;
  }>(),
  {
    images: () => [],
    mode: 'scroll',
    autoScroll: false
  }
);

const emit = defineEmits<{
  /** 阅读模式切换 */
  (e: 'update:mode', mode: 'scroll' | 'page'): void;
  /** 滚动进度变化（0~1，v54 起为视口所在章的章内进度），仅滚动模式触发 */
  (e: 'scroll-progress', progress: number): void;
  /** 请求加载下一章 */
  (e: 'request-next-chapter'): void;
  /** v55 章节模式：末尾"下一章"转场卡点击 → 请求进入下一章（手动跳章语义） */
  (e: 'go-next-chapter'): void;
  /** 请求加载上一章（翻页模式章首回翻 → 手动跳章语义） */
  (e: 'request-prev-chapter'): void;
  /**
   * P1-2：滚动模式触顶 → 请求前插拼接上一章（参数=拼接首章的前一章绝对索引，
   * 视口位置保持；与 request-prev-chapter 的手动跳章语义区分）
   */
  (e: 'request-prepend-prev-chapter', targetChapterIndex: number): void;
  /** 切换工具栏显示/隐藏（翻页模式中间区域点击时触发） */
  (e: 'toggle-toolbar'): void;
  /** 当前页码变化（1-based），供父组件响应式跟踪 */
  (e: 'page-change', page: number): void;
  /** 视口所在章变化（v54：绝对章索引，滚动跨界时触发，仅滚动模式） */
  (e: 'current-chapter-change', chapterIndex: number): void;
}>();

const settings = useSettingsStore();
const { t } = useI18n();

/**
 * v57：漫画背景色可设置（用户投诉固定黑底不能换）。
 * dark=#000（默认，保持 A5 修复的竞品黑底范式）、light=#fff、theme=跟随阅读主题。
 * 滚动/翻页子组件容器背景透明化，统一由本外壳透出。
 */
const comicBgClass = computed<string>(() => `comic-bg-${settings.comicBackground}`);

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

/* ==================== v56 全屏原尺寸查看（Calibre 式 ComicLightbox） ==================== */

/** lightbox 显示状态 */
const lightboxShow = ref<boolean>(false);
/** lightbox 当前查看的图片 */
const lightboxImage = ref<ChapterImage | null>(null);

/** 打开全屏查看（pending 占位条目忽略——无图可看） */
function openLightbox(image: ChapterImage): void {
  if (!image || image.pending || !image.path) return;
  lightboxImage.value = image;
  lightboxShow.value = true;
}

/* ==================== 暴露方法 ==================== */

defineExpose({
  /** v48：手动跳章标记（仅滚动模式有效：清空拼接、回新章顶部） */
  markManualJump(): void {
    if (props.mode === 'scroll') {
      scrollRef.value?.markManualJump();
    }
  },
  /**
   * A4修复：滚动到章节首页的页内偏移（0~1），目录小节书签定位用。
   * 仅滚动模式实现（页面粒度偏移对翻页模式无意义，翻页模式留在章首即可）。
   */
  scrollToAnchor(ratio: number): void {
    if (props.mode === 'scroll') {
      scrollRef.value?.scrollToAnchor(ratio);
    }
  },
  /**
   * 翻到下一页：翻页模式→下一张；滚动模式→向下滚一屏（v57 修复：原仅翻页模式
   * 实现，滚动模式下按 → 毫无反应；现语义对齐文本阅读器的 readerNextPage——
   * 文本滚动模式 ←/→ = 上一屏/下一屏，图片滚动模式同样按屏滚动）
   * v58：RTL 翻页方向统一在此层反转（原 ComicPageMode 硬编码 window ←/→ 监听
   * 才反转，用户自定义快捷键/Reader 统一路径不反转，行为不一致且绕过用户配置
   * ——已删组件级监听，←/→ 全部走 Reader 快捷键系统经此方法，反转后物理键
   * 方向与视觉翻页方向一致，竞品 Mihon 同款语义）
   */
  nextPage(): void {
    if (props.mode === 'scroll') {
      scrollRef.value?.scrollPageDown();
      return;
    }
    if (settings.comicReadDirection === 'rtl') {
      pageRef.value?.prevPage();
    } else {
      pageRef.value?.nextPage();
    }
  },
  /**
   * 翻到上一页：翻页模式→上一张；滚动模式→向上滚一屏（v57，同 nextPage；
   * v58 RTL 反转同 nextPage 说明）
   */
  prevPage(): void {
    if (props.mode === 'scroll') {
      scrollRef.value?.scrollPageUp();
      return;
    }
    if (settings.comicReadDirection === 'rtl') {
      pageRef.value?.nextPage();
    } else {
      pageRef.value?.prevPage();
    }
  },
  /** 跳转到指定页（1-based） */
  goToPage(page: number): void {
    if (props.mode === 'scroll') {
      scrollRef.value?.goToPage(page);
    } else {
      pageRef.value?.goToPage(page - 1);
    }
  },
  /**
   * v56 缩略图面板跳页：当前数据源章的章内页码（1-based）。
   * 滚动模式拼接后章内页码 ≠ 拼接列表全局槽位，由子组件按章边界换算；
   * 翻页模式无拼接概念，页码即章内页码。
   */
  goToChapterPage(page: number): void {
    if (props.mode === 'scroll') {
      scrollRef.value?.goToChapterPage(page);
    } else {
      pageRef.value?.goToPage(page - 1);
    }
  },
  /** v56 缩略图面板：当前数据源章的章内页码（1-based，高亮"当前页"用） */
  getCurrentChapterLocalPage(): number {
    if (props.mode === 'scroll') {
      return scrollRef.value?.getCurrentChapterLocalPage() ?? 1;
    }
    return currentPage.value;
  },
  /**
   * 根因④（进度 chapter_offset 持久化）：视口所在章的章内页码（1-based）。
   * 滚动模式拼接下与 getCurrentChapterLocalPage（数据源章）不同：进度链的
   * 章号是视口章，页码必须同源；翻页模式无拼接，页码即视口章页码。
   */
  getViewportChapterLocalPage(): number {
    if (props.mode === 'scroll') {
      return scrollRef.value?.getViewportChapterLocalPage() ?? 1;
    }
    return currentPage.value;
  },
  /** v56 P0 对标 Calibre：打开全屏原尺寸查看（右键菜单"全屏查看原图"入口） */
  openLightbox,
  /**
   * A-5修复：清除子组件"正在追加下一章"意图（Reader 拼接早退路径调用，
   * 防标志永久挂起后被无 mark 的重载误判为追加）。
   */
  resetAppendIntent(): void {
    if (props.mode === 'scroll') {
      scrollRef.value?.resetAppendIntent();
    }
  },
  /**
   * P1-2：清除子组件"正在前插上一章"意图（对称于 resetAppendIntent，
   * Reader 的 prepend 早退路径调用，防挂起后被无 mark 的重载误判为前插）。
   */
  resetPrependIntent(): void {
    if (props.mode === 'scroll') {
      scrollRef.value?.resetPrependIntent();
    }
  },
  /** 跳转到归一化位置（0~1），用于恢复阅读进度 */
  goToPosition(position: number): void {
    if (props.mode === 'page') {
      // 翻页模式：position 转为页码（page 模式无拼接，comicImages 恒为当前章单章）
      const page = Math.round(position * (totalPages.value - 1));
      pageRef.value?.goToPage(page);
    } else if (props.mode === 'scroll') {
      // 滚动模式：用页码估算滚动位置。
      // A-2修复：拼接态下 totalPages 是"最后拼接章"的长度，换算出的 page 是
      // 该章的章内页码而非拼接列表全局槽位——改调 goToChapterLocalPage 由
      // ComicScrollMode 按 chapterBoundaries 换算全局槽位（单章时等价 goToPage）
      const page = Math.max(1, Math.min(totalPages.value, Math.ceil(position * totalPages.value)));
      scrollRef.value?.goToChapterLocalPage(page);
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
  },
  /** A7：获取当前页码（1-based），供图片型书签生成「第 N 页」预览 */
  getCurrentPage(): number {
    return currentPage.value;
  }
});
</script>

<template>
  <div class="comic-viewer" :class="comicBgClass">
    <ComicScrollMode
      v-if="mode === 'scroll'"
      ref="scrollRef"
      :images="images"
      :auto-scroll="autoScroll"
      @scroll-progress="$emit('scroll-progress', $event)"
      @request-next-chapter="$emit('request-next-chapter')"
      @go-next-chapter="$emit('go-next-chapter')"
      @request-prepend-prev-chapter="$emit('request-prepend-prev-chapter', $event)"
      @page-change="onPageChange"
      @current-chapter-change="$emit('current-chapter-change', $event)"
      @view-image="openLightbox"
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
      @view-image="openLightbox"
    />

    <!-- v56 P0 对标 Calibre：双击图片全屏原尺寸查看（Teleport to body，不挤占阅读区） -->
    <ComicLightbox v-model:show="lightboxShow" :image="lightboxImage" />
  </div>
</template>

<style scoped>
.comic-viewer {
  width: 100%;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}

/*
 * v57 背景三选一（原 A5 修复固定 #000 不可换；子组件容器背景透明由此外壳统一透出）：
 * - dark：深黑（默认）。竞品 SumatraPDF/Mihon 默认黑底，白页边界清晰
 * - light：浅白。白底扫描页与背景融合更整体，但页边界可能模糊
 * - theme：跟随阅读主题（--reader-bg），与文字阅读器观感统一
 * v57 滚动条黑边修复：各背景分支同时提供 --comic-scrollbar-thumb 变量——
 * 全局 thumb 为黑色半透明（浅色界面设计），黑底上不可见且 6px 占位条在
 * 居中布局下形成死黑边；变量供 ComicScrollMode 的滚动条样式继承使用。
 * v58 漫画文字色变量：子组件（ComicScrollMode/ComicPageMode）内章末预告卡、
 * 加载占位、错误重试等白色硬编码文字在浅色背景（comicBackground='light'）下
 * 不可见（用户投诉根因）。各背景分支提供 --comic-text 完整颜色值，使用方以
 * color-mix(in srgb, var(--comic-text) X%, transparent) 计算透明度，
 * 兼容 #rrggbb / rgb() / 自定义色值等任意颜色格式（--reader-text 为十六进制）。
 */
.comic-viewer.comic-bg-dark {
  background: #000; /* 有意固定色：漫画 dark 背景（用户可选），非主题漂移 */
  --comic-scrollbar-thumb: rgba(255, 255, 255, 0.22);
  --comic-scrollbar-thumb-hover: rgba(255, 255, 255, 0.4);
  /* 黑底 → 白字（与原有硬编码视觉完全一致） */
  --comic-text: rgba(255, 255, 255, 1);
}

.comic-viewer.comic-bg-light {
  background: #fff; /* 有意固定色：漫画 light 背景（用户可选），非主题漂移 */
  --comic-scrollbar-thumb: rgba(0, 0, 0, 0.15);
  --comic-scrollbar-thumb-hover: rgba(0, 0, 0, 0.3);
  /* 浅底 → 黑字（修复原白字在浅色背景不可见的问题） */
  --comic-text: rgba(0, 0, 0, 1);
}

.comic-viewer.comic-bg-theme {
  background: var(--reader-bg, #000);
  /* 跟随应用主题滚动条变量（浅色主题黑 thumb / 未来暗色主题自动适配），
     兜底取白系——阅读主题默认深色场景居多 */
  --comic-scrollbar-thumb: var(--scrollbar-thumb, rgba(255, 255, 255, 0.22));
  --comic-scrollbar-thumb-hover: var(--scrollbar-thumb-hover, rgba(255, 255, 255, 0.4));
  /* 跟随阅读主题文字色（与 --reader-bg 背景配对，保证对比度） */
  --comic-text: var(--reader-text, rgba(255, 255, 255, 1));
}
</style>
