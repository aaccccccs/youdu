<!--
  RSS 文章阅读视图

  与 Reader.vue（小说阅读器）不同，本视图专为 RSS 文章设计：
  - 获取章节 HTML 内容（subscription.ts 存储的 HTML），用 DOMPurify 消毒后 v-html 渲染
  - 链接可点击：调 shellApi.openExternal 打开系统浏览器
  - 顶部工具栏有"查看原文"按钮，打开 book.source_url
  - 简单上下滚动，无翻页/章节导航/书签/TTS

  布局结构：
  .article-root (flex column, height 100%, overflow hidden)
    ├── .article-toolbar (flex-shrink:0, 40px, 琉璃质感)
    │   ├── 返回按钮 (左)
    │   ├── 文章标题 (中, ellipsis)
    │   ├── "查看原文"按钮 (右, 仅 source_url 存在时显示)
    │   └── "阅读设置"按钮 (右, 打开 ReadSettings 抽屉)
    └── .article-scroll (flex:1, overflow-y:auto, 右键菜单)
        └── .article-container (max-width:800px, margin:0 auto, padding:24px)

            └── .article-content (v-html 渲染 sanitized HTML, 字号/行距跟随 settings store)
-->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NButton, NIcon, NSpin, NDropdown, type DropdownOption } from 'naive-ui';
import { ExternalLink, Settings, Copy, Settings as SettingsIcon } from '@lucide/vue';
import DOMPurify from 'dompurify';

import { useSettingsStore } from '@renderer/stores';
import { useContextMenu, useDropdownIcon } from '@renderer/composables';
import ReadSettings from '@renderer/components/reader/ReadSettings.vue';

const route = useRoute();
const { t } = useI18n();

/**
 * 当前文章的 bookId（响应路由参数变化）
 *
 * 原实现为 `const bookId = Number(route.params.bookId)`，仅初始化时计算一次。
 * 当用户从 /article/1 导航到 /article/2 时，组件被复用，bookId 不更新，onMounted 不重新触发，
 * 导致显示的还是旧文章内容。改为 computed 后配合 watch 监听即可响应路由变化。
 */
const bookId = computed<number>(() => Number(route.params.bookId));

const loading = ref(true);
const book = ref<any>(null);
const sanitizedHtml = ref('');

// 阅读设置抽屉显示状态
const showSettings = ref(false);

// 阅读设置 store：提供 fontSize / lineHeight / 主题等
const settings = useSettingsStore();

// 右键菜单状态
const { contextMenuShow, contextMenuX, contextMenuY, openContextMenu, closeContextMenu } = useContextMenu();
const currentSelectedText = ref('');
const renderIcon = useDropdownIcon();

/**
 * 加载文章内容：获取书籍详情 → 清除更新徽章 → 读取章节内容 → 解析标记 → DOMPurify 消毒 → 绑定链接
 *
 * 提取为独立函数以支持路由参数变化时重新加载（原 onMounted 内联逻辑）。
 */
async function loadArticle(id: number): Promise<void> {
  loading.value = true;
  try {
    // 获取书籍详情
    book.value = await window.dbApi.book.get(id);

    // 清除订阅更新徽章：用户已打开此文章，不再显示红点
    // 与 Reader.vue（stores.ts 第2562行）逻辑一致
    if (book.value?.has_update === 1) {
      try {
        await window.subscriptionApi.markBookUpdate(id, false);
        book.value = { ...book.value, has_update: 0 };
      } catch {
        // 非致命：清除红点失败不影响阅读
      }
    }

    // 获取章节内容（RSS 文章只有一个章节，index=0）
    // 内容可能是 HTML（新导入）或纯文本（旧数据），需要兼容处理
    let content = await window.dbApi.chapter.getContent(id, 0);
    content = content || '';

    // 检测内容格式：是否包含 HTML 标签
    const hasHtmlTags = /<(?:p|div|h[1-6]|ul|ol|li|table|blockquote|pre|img|a|br|span|strong|em|figure)\b/i.test(
      content
    );

    if (!hasHtmlTags) {
      // 纯文本格式（旧数据）：HTML 转义（< > &）防止 XSS
      // [H1] 等方括号标记不受转义影响，后续统一解析
      content = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // 无论 HTML 还是纯文本，都解析 RSS 自定义标记 → HTML 标签
    // 原因：subscription.ts 的 convertSemanticHtmlToMarkers 会把部分标签转为标记
    // （<h2>→[H2], <a>→[LINK], <blockquote>→[QUOTE] 等），但保留 <p>/<img>/<strong> 等，
    // 导致 hasHtmlTags=true 但内容仍含 [H1]/[LINK:url]/[QUOTE] 等标记。
    // 标记正则足够特异，不会误匹配正常 HTML 标签。
    content = content
      // [H1]...[/H1] → <h1>...</h1>（支持 H1-H6）
      .replace(/\[H([1-6])\]([\s\S]*?)\[\/H\1\]/gi, '<h$1>$2</h$1>')
      // [LINK:url]text[/LINK] → <a href="url">text</a>
      .replace(/\[LINK:([^\]]+)\]([\s\S]*?)\[\/LINK\]/gi, '<a href="$1">$2</a>')
      // [QUOTE]...[/QUOTE] → <blockquote>...</blockquote>
      .replace(/\[QUOTE\]([\s\S]*?)\[\/QUOTE\]/gi, '<blockquote>$1</blockquote>')
      // [CODE]...[/CODE] → <pre><code>...</code></pre>
      .replace(/\[CODE\]([\s\S]*?)\[\/CODE\]/gi, '<pre><code>$1</code></pre>')
      // [TABLE]<table>...</table>[/TABLE] → 直接解包（内容已是 HTML）
      .replace(/\[TABLE\]([\s\S]*?)\[\/TABLE\]/gi, '$1')
      // [LI]...[/LI] → <li>...</li>
      .replace(/\[LI\]([\s\S]*?)\[\/LI\]/gi, '<li>$1</li>')
      // [OL]...[/OL] → <ol>...</ol>
      .replace(/\[OL\]([\s\S]*?)\[\/OL\]/gi, '<ol>$1</ol>')
      // [UL]...[/UL] → <ul>...</ul>
      .replace(/\[UL\]([\s\S]*?)\[\/UL\]/gi, '<ul>$1</ul>')
      // [DL]...[/DL] → <dl>...</dl>
      .replace(/\[DL\]([\s\S]*?)\[\/DL\]/gi, '<dl>$1</dl>')
      // [DT]...[/DT] → <dt>...</dt>
      .replace(/\[DT\]([\s\S]*?)\[\/DT\]/gi, '<dt>$1</dt>')
      // [DD]...[/DD] → <dd>...</dd>
      .replace(/\[DD\]([\s\S]*?)\[\/DD\]/gi, '<dd>$1</dd>')
      // [HR] → <hr>
      .replace(/\[HR\]/gi, '<hr>')
      // Markdown 粗体 **text** → <strong>text</strong>
      .replace(/\*\*([^\s][\s\S]*?[^\s])\*\*/g, '<strong>$1</strong>')
      // Markdown 斜体 *text* → <em>text</em>（要求两侧 * 不相邻其他 *，避免误匹配）
      .replace(/(?<!\*)\*([^\s*][\s\S]*?[^\s*])\*(?!\*)/g, '<em>$1</em>')
      // [B]...[/B] → <strong>...</strong>
      .replace(/\[B\]([\s\S]*?)\[\/B\]/gi, '<strong>$1</strong>')
      // [I]...[/I] → <em>...</em>
      .replace(/\[I\]([\s\S]*?)\[\/I\]/gi, '<em>$1</em>')
      // [ABBR]...[/ABBR] → <abbr>...</abbr>
      .replace(/\[ABBR\]([\s\S]*?)\[\/ABBR\]/gi, '<abbr>$1</abbr>')
      // [SUB]...[/SUB] → <sub>...</sub>
      .replace(/\[SUB\]([\s\S]*?)\[\/SUB\]/gi, '<sub>$1</sub>')
      // [SUP]...[/SUP] → <sup>...</sup>
      .replace(/\[SUP\]([\s\S]*?)\[\/SUP\]/gi, '<sup>$1</sup>')
      // [U]...[/U] → <u>...</u>
      .replace(/\[U\]([\s\S]*?)\[\/U\]/gi, '<u>$1</u>')
      // [DEL]...[/DEL] → <del>...</del>
      .replace(/\[DEL\]([\s\S]*?)\[\/DEL\]/gi, '<del>$1</del>')
      // [MARK]...[/MARK] → <mark>...</mark>
      .replace(/\[MARK\]([\s\S]*?)\[\/MARK\]/gi, '<mark>$1</mark>')
      // [ICODE]...[/ICODE] → <code>...</code>
      .replace(/\[ICODE\]([\s\S]*?)\[\/ICODE\]/gi, '<code>$1</code>')
      // [Q]...[/Q] → <q>...</q>
      .replace(/\[Q\]([\s\S]*?)\[\/Q\]/gi, '<q>$1</q>')
      // [KBD]...[/KBD] → <kbd>...</kbd>
      .replace(/\[KBD\]([\s\S]*?)\[\/KBD\]/gi, '<kbd>$1</kbd>')
      // [CITE]...[/CITE] → <cite>...</cite>
      .replace(/\[CITE\]([\s\S]*?)\[\/CITE\]/gi, '<cite>$1</cite>')
      // [DFN]...[/DFN] → <dfn>...</dfn>
      .replace(/\[DFN\]([\s\S]*?)\[\/DFN\]/gi, '<dfn>$1</dfn>')
      // [SAMP]...[/SAMP] → <samp>...</samp>
      .replace(/\[SAMP\]([\s\S]*?)\[\/SAMP\]/gi, '<samp>$1</samp>')
      // [VAR]...[/VAR] → <var>...</var>
      .replace(/\[VAR\]([\s\S]*?)\[\/VAR\]/gi, '<var>$1</var>')
      // [IMG:url] → <img>
      .replace(
        /\[IMG:([^\]]+)\]/g,
        '<img src="$1" alt="" style="max-width:100%;height:auto;border-radius:8px;margin:1em 0">'
      );

    if (!hasHtmlTags) {
      // 纯文本格式：\n → <br> 保留换行（HTML 内容已有 <p>/<br>，不需要）
      content = content.replace(/\n/g, '<br>');
    }

    // DOMPurify 消毒：限制允许的标签和属性，防止 XSS
    // 关键：ALLOWED_URI_REGEXP 必须允许 file: 协议，否则本地下载的图片（file:/// 路径）会被过滤掉
    sanitizedHtml.value = DOMPurify.sanitize(content, {
      ALLOWED_TAGS: [
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'p',
        'a',
        'img',
        'ul',
        'ol',
        'li',
        'blockquote',
        'pre',
        'code',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'div',
        'span',
        'br',
        'hr',
        'strong',
        'em',
        'b',
        'i',
        'u',
        's',
        'del',
        'sup',
        'sub',
        'figure',
        'figcaption',
        'video',
        'source',
        'mark',
        'q',
        'kbd',
        'cite',
        'dfn',
        'samp',
        'var',
        'dl',
        'dt',
        'dd'
      ],
      ALLOWED_ATTR: [
        'href',
        'src',
        'alt',
        'title',
        'width',
        'height',
        'style',
        'class',
        'id',
        'controls',
        'target',
        'rel'
      ],
      // 允许 file:（本地图片）、http/https（远程链接/图片）、data:（内联图）
      ALLOWED_URI_REGEXP: /^(?:(?:file|https?|data):|#)/i
    });
    // 等待 DOM 渲染后绑定链接点击
    await nextTick();
    bindLinks();
  } catch (err) {
    console.error('加载文章失败:', err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadArticle(bookId.value).catch((e) => console.error('loadArticle 失败:', e));
});

/**
 * 监听路由 bookId 变化：当用户从 /article/1 导航到 /article/2 时重新加载文章。
 * 组件被复用时 onMounted 不会重新触发，必须用 watch 响应参数变化。
 */
watch(bookId, (newId, oldId) => {
  if (newId !== oldId && !Number.isNaN(newId)) {
    void loadArticle(newId).catch((e) => console.error('loadArticle 失败:', e));
  }
});

/**
 * 用事件委托方式处理文章内容中的链接点击：
 * 在容器上监听 click，如果点击源是 <a> 或在 <a> 内，阻止默认跳转，
 * 对 http/https 链接调 shellApi.openExternal 打开系统默认浏览器。
 * 事件委托比逐个 addEventListener 更可靠，不受 DOM 重渲染影响。
 *
 * P2 修复：原实现每次 bindLinks 调用都新增一个匿名监听器且从不移除，
 * 路由参数变化或重新加载时会累积监听器导致内存泄漏与多次触发。
 * 现提取为命名函数，每次绑定前先移除旧监听器，并在组件卸载时清理。
 */
function handleLinkClick(e: Event): void {
  const target = e.target as HTMLElement;
  const anchor = target.closest('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href');
  if (href && /^https?:\/\//i.test(href)) {
    e.preventDefault();
    e.stopPropagation();
    window.shellApi.openExternal(href);
  }
}

function bindLinks(): void {
  const container = document.querySelector('.article-content');
  if (!container) return;
  // 先移除旧监听器，避免重复绑定导致多次触发与内存泄漏
  container.removeEventListener('click', handleLinkClick);
  container.addEventListener('click', handleLinkClick);
}

/**
 * 清理文章内容容器上的链接点击监听器。
 * 在组件卸载或重新加载文章前调用，防止内存泄漏。
 */
function unbindLinks(): void {
  const container = document.querySelector('.article-content');
  if (container) {
    container.removeEventListener('click', handleLinkClick);
  }
}

onBeforeUnmount(() => {
  unbindLinks();
});

/** 查看原文：打开 source_url */
function openOriginal(): void {
  if (book.value?.source_url) {
    window.shellApi.openExternal(book.value.source_url);
  }
}

/**
 * 文章正文动态样式：字号 / 行距跟随 settings store
 * 替代原硬编码 font-size:16px / line-height:1.8
 */
const articleContentStyle = computed(() => ({
  fontSize: `${settings.fontSize}px`,
  lineHeight: settings.lineHeight
}));

/**
 * 文章区背景/文字颜色：优先使用阅读器主题 CSS 变量
 * --reader-bg / --reader-text 由 App.vue 根据 settings.readerTheme 注入
 * 不存在时回退到全局基础变量
 */
const articleBgStyle = computed(() => ({
  background: 'var(--reader-bg, var(--bg-base))',
  color: 'var(--reader-text, var(--text-primary))'
}));

/**
 * 右键菜单选项：
 * - 选中文字时：仅显示"复制"
 * - 未选中时：显示"查看原文"（如有 source_url）+ "阅读设置"
 */
const contextMenuOptions = computed<DropdownOption[]>(() => {
  if (currentSelectedText.value) {
    return [{ label: t('common.actions.copy'), key: 'copy', icon: renderIcon(Copy) }];
  }
  const opts: DropdownOption[] = [];
  if (book.value?.source_url) {
    opts.push({ label: t('article.actions.openOriginal'), key: 'open-original', icon: renderIcon(ExternalLink) });
  }
  opts.push({ label: t('article.actions.readSettings'), key: 'show-settings', icon: renderIcon(SettingsIcon) });
  return opts;
});

/** 右键菜单触发：记录当前选中文本并打开菜单 */
function handleContextMenu(event: MouseEvent): void {
  event.preventDefault();
  const selection = window.getSelection();
  currentSelectedText.value = selection ? selection.toString().trim() : '';
  openContextMenu(event.clientX, event.clientY);
}

/** 右键菜单选项点击处理 */
function handleContextMenuSelect(key: string | number): void {
  closeContextMenu();
  if (key === 'copy') {
    if (currentSelectedText.value) {
      navigator.clipboard.writeText(currentSelectedText.value).catch(console.error);
    }
  } else if (key === 'open-original') {
    openOriginal();
  } else if (key === 'show-settings') {
    showSettings.value = true;
  }
}
</script>

<template>
  <div class="article-root" :style="articleBgStyle">
    <!-- 顶部工具栏 — 琉璃质感 -->
    <header class="article-toolbar">
      <!-- 文章标题（居中，溢出省略） -->
      <h1 class="article-title">{{ book?.title ?? t('article.title') }}</h1>

      <!-- 查看原文按钮（仅 source_url 存在时显示） -->
      <n-button
        v-if="book?.source_url"
        quaternary
        size="small"
        @click="openOriginal"
        :title="t('article.actions.openOriginal')"
      >
        <template #icon>
          <n-icon :component="ExternalLink" :size="14" />
        </template>
        {{ t('article.actions.openOriginal') }}
      </n-button>

      <!-- 阅读设置按钮 -->
      <n-button quaternary circle size="small" @click="showSettings = true" :title="t('article.actions.readSettings')">
        <template #icon>
          <n-icon :component="Settings" :size="16" />
        </template>
      </n-button>
    </header>

    <!-- 内容滚动区 -->
    <div class="article-scroll" :style="articleBgStyle" @contextmenu="handleContextMenu">
      <!-- 加载中 -->
      <div v-if="loading" class="article-loading">
        <n-spin size="large" />
      </div>

      <!-- 文章内容 -->
      <div v-else class="article-container">
        <!-- 文章正文（v-html 渲染消毒后的 HTML） -->
        <div v-if="sanitizedHtml" class="article-content" :style="articleContentStyle" v-html="sanitizedHtml"></div>

        <!-- 空内容 fallback -->
        <div v-else class="article-empty">
          <p>{{ t('article.empty.contentPending') }}</p>
          <n-button v-if="book?.source_url" type="primary" @click="openOriginal">
            <template #icon><n-icon :component="ExternalLink" :size="14" /></template>
            {{ t('article.actions.openOriginal') }}
          </n-button>
        </div>
      </div>
    </div>

    <!-- 阅读设置抽屉 -->
    <ReadSettings :show="showSettings" @update:show="(v: boolean) => (showSettings = v)" />

    <!-- 正文区右键菜单 -->
    <n-dropdown
      placement="bottom-start"
      trigger="manual"
      :show="contextMenuShow"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextMenuOptions"
      @select="handleContextMenuSelect"
      @clickoutside="closeContextMenu"
    />
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════
   布局结构 — 容器固定跟随窗口，内容区滚动
   ═══════════════════════════════════════════════════════════════ */

.article-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
}

/* ═══════════════════════════════════════════════════════════════
   顶部工具栏 — 琉璃质感（参考 BookDetail.vue 的 detail-header）
   ═══════════════════════════════════════════════════════════════ */

.article-toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  height: 40px;
  flex-shrink: 0;
  padding: 0 var(--spacing-lg);
  background: color-mix(in srgb, var(--bg-card) 75%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border-color);
}

/* 工具栏标题（居中弹性，溢出省略） */
.article-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-lg);
  font-weight: 500;
  color: var(--text-primary);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ═══════════════════════════════════════════════════════════════
   内容滚动区
   ═══════════════════════════════════════════════════════════════ */

.article-scroll {
  flex: 1;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg-base);
}

/* 加载状态 */
.article-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 300px;
}

/* 文章容器 — 限宽 800px 居中 */
.article-container {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px;
}

/* ═══════════════════════════════════════════════════════════════

   文章正文排版
   ═══════════════════════════════════════════════════════════════ */

.article-content {
  /* font-size / line-height 由 inline style (articleContentStyle) 动态注入，
     跟随 settings.fontSize / settings.lineHeight */
  color: var(--text-primary);
  word-wrap: break-word;
  overflow-wrap: break-word;
  /* 覆盖 body { user-select: none }，允许选中复制文章正文 */
  user-select: text;
  -webkit-user-select: text;
}

.article-content :deep(h1) {
  font-size: 24px;
  font-weight: bold;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  line-height: 1.3;
}

.article-content :deep(h2) {
  font-size: 20px;
  font-weight: bold;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  line-height: 1.3;
}

.article-content :deep(h3) {
  font-size: 18px;
  font-weight: bold;
  margin-top: 1.2em;
  margin-bottom: 0.4em;
  line-height: 1.4;
}

.article-content :deep(h4),
.article-content :deep(h5),
.article-content :deep(h6) {
  font-weight: bold;
  margin-top: 1em;
  margin-bottom: 0.4em;
}

.article-content :deep(p) {
  margin: 0.8em 0;
}

.article-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  margin: 1em 0;
}

.article-content :deep(a) {
  color: var(--primary);
  text-decoration: underline;
  cursor: pointer;
}

.article-content :deep(blockquote) {
  border-left: 3px solid var(--border-color);
  padding-left: 16px;
  color: var(--text-tertiary);
  margin: 1em 0;
}

.article-content :deep(pre) {
  background: var(--bg-elevated);
  padding: 16px;
  border-radius: 8px;
  overflow-x: auto;
  font-family: var(--font-mono);
  margin: 1em 0;
}

.article-content :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
}

.article-content :deep(ul) {
  padding-left: 24px;
  list-style: disc;
  margin: 0.8em 0;
}

.article-content :deep(ol) {
  padding-left: 24px;
  list-style: decimal;
  margin: 0.8em 0;
}

.article-content :deep(li) {
  margin: 0.4em 0;
}

.article-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
}

.article-content :deep(th) {
  border: 1px solid var(--border-color);
  padding: 8px;
  font-weight: bold;
}

.article-content :deep(td) {
  border: 1px solid var(--border-color);
  padding: 8px;
}

.article-content :deep(figure) {
  margin: 1em 0;
}

.article-content :deep(figcaption) {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  text-align: center;
  margin-top: 0.5em;
}

.article-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 1.5em 0;
}

.article-content :deep(mark) {
  background: color-mix(in srgb, var(--primary) 20%, transparent);
  padding: 0 2px;
  border-radius: 2px;
}

.article-content :deep(kbd) {
  background: var(--bg-elevated);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 0.85em;
}

.article-content :deep(sub) {
  font-size: 0.75em;
  vertical-align: sub;
}

.article-content :deep(sup) {
  font-size: 0.75em;
  vertical-align: super;
}

.article-content :deep(dl) {
  margin: 1em 0;
}

.article-content :deep(dt) {
  font-weight: bold;
  margin-top: 0.5em;
}

.article-content :deep(dd) {
  margin-left: 24px;
}

.article-content :deep(video) {
  max-width: 100%;
  border-radius: 8px;
  margin: 1em 0;
}

/* 空内容状态 */
.article-empty {
  text-align: center;
  padding: 48px 24px;
  color: var(--text-tertiary);
}

.article-empty p {
  margin-bottom: 16px;
}
</style>
