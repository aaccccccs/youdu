<!--
  OPDS 书库浏览页面

  布局结构：
  .opds-root (flex column, height:100%, overflow:hidden)
    ├── .opds-header (flex-shrink:0, 琉璃质感) ← 固定 header
    └── .opds-view (flex:1, overflow-y:auto) ← 内容滚动区
        └── .opds-container (max-width:960px, margin:0 auto)
            ├── .opds-sidebar (左侧：目录列表)
            ├── .opds-content (右侧：书籍列表/分类浏览)
            └── .opds-search-bar (顶部搜索框)

  功能：
  - 左侧：已添加的 OPDS 目录列表 + 添加新目录按钮
  - 右侧：当前目录的书籍列表/分类浏览
  - 顶部：搜索框
  - 书籍卡片：封面+标题+作者+格式+下载按钮
  - 下载后自动导入到收藏
-->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, h, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { NButton, NIcon, NInput, NModal, NSpin, NTag, NEmpty, useMessage, useDialog, useNotification } from 'naive-ui';
import { Library, Plus, Download, Trash2, ChevronRight, ChevronLeft, BookOpen, Globe } from '@lucide/vue';
import { generateCoverDataUrl } from '@renderer/utils';

/* ==================== 类型定义 ==================== */

interface OpdsCatalog {
  id: number;
  name: string;
  url: string;
  hasAuth?: boolean;
}

interface OpdsNavigationLink {
  title: string;
  href: string;
  rel: string;
  isNavigation: boolean;
}

interface OpdsEntry {
  title: string;
  author: string;
  summary: string;
  coverUrl?: string;
  downloadUrl: string;
  format: string;
  categories: string[];
  id?: string;
}

interface OpdsFeed {
  title: string;
  navigationLinks: OpdsNavigationLink[];
  entries: OpdsEntry[];
  nextLink?: string;
  previousLink?: string;
  searchUrl?: string;
  selfLink?: string;
}

/* ==================== Props ==================== */

/** Sources.vue 传入的外部搜索关键词 */
const props = defineProps<{ externalSearch?: string }>();

/* ==================== 状态管理 ==================== */

const { t } = useI18n();
const message = useMessage();
const dialog = useDialog();
const notification = useNotification();
const router = useRouter();

/** OPDS 目录列表 */
const catalogs = ref<OpdsCatalog[]>([]);

/** 当前选中的目录 */
const currentCatalog = ref<OpdsCatalog | null>(null);

/** 当前浏览的 feed 数据 */
const currentFeed = ref<OpdsFeed | null>(null);

/** 浏览历史栈（用于返回上一级） */
const browseHistory = ref<string[]>([]);

/** 加载状态 */
const loading = ref<boolean>(false);
const searching = ref<boolean>(false);

/**
 * 搜索竞态保护序号。
 *
 * 问题：用户快速连续搜索时，先发起的搜索可能后完成，覆盖后发起的搜索结果。
 * 修复：每次搜索递增 seq，完成后检查 seq 是否仍为最新，否则丢弃过期结果。
 */
let searchSeq = 0;

/** 搜索关键词 */
const searchQuery = ref<string>('');

/** 添加目录对话框 */
const showAddDialog = ref<boolean>(false);
const newCatalogName = ref<string>('');
const newCatalogUrl = ref<string>('');
const newCatalogUsername = ref<string>('');
const newCatalogPassword = ref<string>('');
const addingCatalog = ref<boolean>(false);

/** 下载中的书籍标题集合 */
const downloadingBooks = ref<Set<string>>(new Set());

/** 封面加载失败的书籍标题集合 */
const failedCovers = ref<Set<string>>(new Set());

/**
 * 内置推荐源（已验证可访问，2026-09-24）
 *
 * P2-18 修复说明：
 * 原先标注为"中文源"的 3 个条目实际是 gutenberg.org 的搜索接口
 * （通过 query=chinese/china/petry+chinese 关键词搜索英文站点的中文相关书籍），
 * 并非独立的中文 OPDS 书库。此处修正描述以如实反映其性质，
 * 并补充真正提供中文公版书的 OPDS 源（维基文库、中华典籍等）。
 */
const builtinCatalogs = computed((): Array<{ name: string; url: string; description?: string }> => [
  // ─── 真正的中文 OPDS 源 ───
  // 维基文库：收录大量中文公版古籍，提供 OPDS 订阅
  {
    name: t('opds.builtin.wikisourceZh.name'),
    url: 'https://wsexport.wikimedia.org/opds/zh',
    description: t('opds.builtin.wikisourceZh.description')
  },
  // 中华典籍网：专注中国古典文学，提供 OPDS 接口
  {
    name: t('opds.builtin.chinaBook.name'),
    url: 'https://opds.chinabook.org/catalog',
    description: t('opds.builtin.chinaBook.description')
  },

  // ─── 古腾堡计划·中文相关搜索接口（非独立中文书库） ───
  // 说明：以下 3 条是 gutenberg.org 的搜索接口，
  // 通过关键词在英文站点中检索中文相关书籍，结果可能有限且以英文元数据为主。
  {
    name: t('opds.builtin.gutenbergChinese.name'),
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=chinese',
    description: t('opds.builtin.gutenbergChinese.description')
  },
  {
    name: t('opds.builtin.gutenbergChina.name'),
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=china',
    description: t('opds.builtin.gutenbergChina.description')
  },
  {
    name: t('opds.builtin.gutenbergPoetry.name'),
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=poetry+chinese',
    description: t('opds.builtin.gutenbergPoetry.description')
  },

  // ─── 英文源 ───
  {
    name: t('opds.builtin.gutenbergAll.name'),
    url: 'https://m.gutenberg.org/ebooks.opds/',
    description: t('opds.builtin.gutenbergAll.description')
  },
  {
    name: t('opds.builtin.gutenbergClassical.name'),
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=classical',
    description: t('opds.builtin.gutenbergClassical.description')
  },
  {
    name: t('opds.builtin.gutenbergPhilosophy.name'),
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=philosophy',
    description: t('opds.builtin.gutenbergPhilosophy.description')
  },
  {
    name: t('opds.builtin.gutenbergSciFi.name'),
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=science+fiction',
    description: t('opds.builtin.gutenbergSciFi.description')
  },
  {
    name: t('opds.builtin.gutenbergHistory.name'),
    url: 'https://m.gutenberg.org/ebooks/search.opds/?query=history',
    description: t('opds.builtin.gutenbergHistory.description')
  }
]);

/* ==================== 计算属性 ==================== */

/** 是否有目录 */
const hasCatalogs = computed((): boolean => catalogs.value.length > 0);

/** 当前是否有书籍条目 */
const hasEntries = computed((): boolean => {
  return currentFeed.value !== null && currentFeed.value.entries.length > 0;
});

/**
 * 渲染用的书籍条目（去重保险）
 *
 * 主进程解析时已做去重，这里再做一次前端去重，
 * 防止因 IPC 传输或状态更新导致重复条目出现在界面上。
 * 去重键：id 优先，否则用 title|author|downloadUrl。
 */
const displayEntries = computed((): OpdsEntry[] => {
  const entries = currentFeed.value?.entries ?? [];
  const seen = new Set<string>();
  const result: OpdsEntry[] = [];
  for (const entry of entries) {
    const key = entry.id?.trim() || `${entry.title}|${entry.author}|${entry.downloadUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
});

/** 当前是否有导航链接 */
const hasNavigationLinks = computed((): boolean => {
  return currentFeed.value !== null && currentFeed.value.navigationLinks.length > 0;
});

/** 是否可以返回上一级 */
const canGoBack = computed((): boolean => browseHistory.value.length > 0);

/** 是否有下一页 */
const hasNextPage = computed((): boolean => {
  return currentFeed.value?.nextLink !== undefined && currentFeed.value.nextLink !== '';
});

/** 是否有上一页 */
const hasPreviousPage = computed((): boolean => {
  return currentFeed.value?.previousLink !== undefined && currentFeed.value.previousLink !== '';
});

/** 当前 feed 标题 */
const currentFeedTitle = computed((): string => {
  if (currentFeed.value?.title) return currentFeed.value.title;
  if (currentCatalog.value) return currentCatalog.value.name;
  return t('opds.title');
});

/* ==================== API 调用 ==================== */

/** 获取 OPDS API */
function getOpdsApi(): typeof window.opdsApi {
  return window.opdsApi;
}

/** 加载目录列表 */
async function loadCatalogs(): Promise<void> {
  try {
    catalogs.value = await getOpdsApi().listCatalogs();
  } catch (err) {
    message.error(t('opds.messages.loadFailed', { msg: (err as Error).message }));
  }
}

/** 添加 OPDS 目录 */
async function handleAddCatalog(): Promise<void> {
  if (addingCatalog.value) return;
  if (!newCatalogName.value.trim() || !newCatalogUrl.value.trim()) {
    message.warning(t('opds.messages.nameRequired'));
    return;
  }

  // 前端去重：检查 URL 是否已存在
  const url = newCatalogUrl.value.trim();
  const exists = catalogs.value.some((c: OpdsCatalog) => c.url === url);
  if (exists) {
    message.warning(t('opds.messages.urlExists'));
    return;
  }

  addingCatalog.value = true;
  try {
    const input: { name: string; url: string; username?: string; password?: string } = {
      name: newCatalogName.value.trim(),
      url: newCatalogUrl.value.trim()
    };
    if (newCatalogUsername.value.trim()) {
      input.username = newCatalogUsername.value.trim();
      input.password = newCatalogPassword.value.trim();
    }
    await getOpdsApi().addCatalog(input);
    message.success(t('opds.messages.catalogAdded'));
    showAddDialog.value = false;
    newCatalogName.value = '';
    newCatalogUrl.value = '';
    newCatalogUsername.value = '';
    newCatalogPassword.value = '';
    await loadCatalogs();
  } catch (err) {
    message.error(t('opds.messages.addFailed', { msg: (err as Error).message }));
  } finally {
    addingCatalog.value = false;
  }
}

/** 删除 OPDS 目录 */
function handleRemoveCatalog(catalog: OpdsCatalog): void {
  dialog.warning({
    title: t('opds.dialog.deleteTitle'),
    content: t('opds.dialog.deleteContent', { name: catalog.name }),
    positiveText: t('common.actions.confirm'),
    negativeText: t('common.actions.cancel'),
    onPositiveClick: async () => {
      try {
        await getOpdsApi().removeCatalog(catalog.id);
        message.success(t('opds.messages.catalogDeleted'));
        if (currentCatalog.value?.id === catalog.id) {
          currentCatalog.value = null;
          currentFeed.value = null;
          browseHistory.value = [];
        }
        await loadCatalogs();
      } catch (err) {
        message.error(t('opds.messages.deleteFailed', { msg: (err as Error).message }));
      }
    }
  });
}

/** browseFeed 请求序号，防止快速切换目录时旧请求覆盖新请求 */
let browseSeq = 0;

/** 浏览 OPDS feed */
async function browseFeed(url: string, pushHistory: boolean = true): Promise<void> {
  const seq = ++browseSeq;
  loading.value = true;
  try {
    const catalogId = currentCatalog.value?.id;
    const feed = await getOpdsApi().browse(url, catalogId);
    if (seq !== browseSeq) return;
    currentFeed.value = feed;
    if (pushHistory && currentFeed.value?.selfLink) {
      browseHistory.value.push(currentFeed.value.selfLink);
    }
  } catch (err) {
    if (seq !== browseSeq) return;
    message.error(t('opds.messages.browseFailed', { msg: (err as Error).message }));
    currentFeed.value = null;
  } finally {
    if (seq === browseSeq) loading.value = false;
  }
}

/** 选择目录并浏览 */
async function selectCatalog(catalog: OpdsCatalog): Promise<void> {
  currentCatalog.value = catalog;
  browseHistory.value = [];
  searchQuery.value = '';
  await browseFeed(catalog.url, false);
}

/** 点击导航链接 */
async function handleNavigationClick(link: OpdsNavigationLink): Promise<void> {
  searchQuery.value = '';
  await browseFeed(link.href);
}

/** 返回上一级 */
async function handleGoBack(): Promise<void> {
  if (browseHistory.value.length === 0) return;
  browseHistory.value.pop();
  const previousUrl = browseHistory.value[browseHistory.value.length - 1];
  if (previousUrl) {
    await browseFeed(previousUrl, false);
  } else if (currentCatalog.value) {
    await browseFeed(currentCatalog.value.url, false);
  }
}

/** 下一页 */
async function handleNextPage(): Promise<void> {
  if (currentFeed.value?.nextLink) {
    await browseFeed(currentFeed.value.nextLink);
  }
}

/** 上一页 */
async function handlePreviousPage(): Promise<void> {
  if (currentFeed.value?.previousLink) {
    await browseFeed(currentFeed.value.previousLink);
  }
}

/** 搜索书籍 */
async function handleSearch(externalQuery?: string): Promise<void> {
  const query = (externalQuery !== undefined ? externalQuery : searchQuery.value).trim();
  if (!query || !currentCatalog.value) return;
  // 递增序号并捕获本次搜索的序号，用于完成后竞态检查
  const mySeq = ++searchSeq;
  searching.value = true;
  try {
    const feed = await getOpdsApi().search(currentCatalog.value.url, query, currentCatalog.value.id);
    // 竞态保护：如果期间又发起了新搜索（seq 已变），丢弃本次过期结果
    if (mySeq !== searchSeq) return;
    currentFeed.value = feed;
    browseHistory.value = [];
  } catch (err) {
    // 过期搜索的错误也不处理
    if (mySeq !== searchSeq) return;
    message.error(t('opds.messages.searchFailed', { msg: (err as Error).message }));
  } finally {
    // 仅当本次搜索是最新一次时才重置 loading（避免过早清除新搜索的 loading 状态）
    if (mySeq === searchSeq) {
      searching.value = false;
    }
  }
}

/** 下载书籍并导入 */
async function handleDownload(entry: OpdsEntry): Promise<void> {
  if (!entry.downloadUrl) {
    message.warning(t('opds.messages.noDownloadLink'));
    return;
  }

  downloadingBooks.value.add(entry.title);
  try {
    const catalogId = currentCatalog.value?.id;
    const filename = entry.title.replace(/[<>:"/\\|?*]/g, '_');

    // 以当前 OPDS 目录名作为分组名，查找或创建分组
    let groupId: number | null = null;
    const groupName = currentCatalog.value?.name?.trim();
    if (groupName) {
      try {
        const groups = (await window.dbApi.group.list()) as Array<{ id: number; name: string }>;
        const existing = groups.find((g) => g.name === groupName);
        if (existing) {
          groupId = existing.id;
        } else {
          const nextOrder =
            groups.length > 0 ? Math.max(...groups.map((g) => (g as { sort_order?: number }).sort_order ?? 0)) + 1 : 0;
          const created = (await window.dbApi.group.create({ name: groupName, sort_order: nextOrder })) as {
            id: number;
          };
          groupId = created.id;
        }
      } catch (err) {
        console.warn('[opds] 查找/创建分组失败，将导入到未分组:', err);
        groupId = null;
      }
    }

    const result = await getOpdsApi().download(entry.downloadUrl, filename, entry.format, catalogId, groupId);
    if (result.success) {
      // 派发书架刷新事件（如果用户正在收藏页面，立即刷新显示新书）
      window.dispatchEvent(new CustomEvent('bookshelf:refresh'));
      notification.success({
        title: groupId
          ? t('opds.notify.importedToGroup', { name: entry.title, group: groupName })
          : t('opds.notify.importedToLibrary', { name: entry.title }),
        duration: 5000,
        action: () =>
          h(
            NButton,
            {
              size: 'small',
              type: 'primary',
              onClick: () => {
                router.push('/').then(async () => {
                  // 修复：等待 nextTick 确保 Bookshelf.vue 已挂载且事件监听器已注册，
                  // 否则 dispatchEvent 可能在 onMounted 之前执行导致事件丢失
                  await nextTick();
                  window.dispatchEvent(new CustomEvent('bookshelf:refresh'));
                });
              }
            },
            () => t('opds.notify.goToLibrary')
          )
      });
    } else {
      message.warning(t('opds.messages.importFailed', { msg: result.error ?? t('opds.messages.unknownError') }));
    }
  } catch (err) {
    message.error(t('opds.messages.downloadFailed', { msg: (err as Error).message }));
  } finally {
    downloadingBooks.value.delete(entry.title);
  }
}

/** 快速添加内置推荐源 */
async function handleAddBuiltinCatalog(builtin: { name: string; url: string; description?: string }): Promise<void> {
  // 前端去重：检查 URL 是否已存在
  const exists = catalogs.value.some((c: OpdsCatalog) => c.url === builtin.url);
  if (exists) {
    message.warning(t('opds.messages.builtinExists', { name: builtin.name }));
    return;
  }
  try {
    await getOpdsApi().addCatalog({ name: builtin.name, url: builtin.url });
    message.success(t('opds.messages.builtinAdded', { name: builtin.name }));
    await loadCatalogs();
  } catch (err) {
    message.error(t('opds.messages.addBuiltinFailed', { msg: (err as Error).message }));
  }
}

/* ==================== 生命周期 ==================== */

/**
 * P2 修复：监听 OPDS 目录变更事件，刷新目录列表。
 * AddSubscriptionDialog 添加 OPDS 目录后派发 'opds:catalogs-changed'，
 * 若不监听则用户需手动刷新才能看到新添加的目录。
 */
function onCatalogsChanged(): void {
  void loadCatalogs().catch((e) => console.error('loadCatalogs 失败:', e));
}

onMounted(() => {
  void loadCatalogs().catch((e) => console.error('loadCatalogs 失败:', e));
  window.addEventListener('opds:catalogs-changed', onCatalogsChanged);
});

onBeforeUnmount(() => {
  window.removeEventListener('opds:catalogs-changed', onCatalogsChanged);
});

/* 监听目录列表变化，自动选中第一个目录 */
watch(catalogs, (newCatalogs) => {
  if (newCatalogs.length > 0 && !currentCatalog.value) {
    void selectCatalog(newCatalogs[0]).catch((e) => console.error('selectCatalog 失败:', e));
  }
});

/** 同步外部搜索关键词到内部 */
watch(
  () => props.externalSearch,
  (val) => {
    if (val !== undefined) searchQuery.value = val;
  }
);

/** 暴露给 Sources.vue 的方法和状态 */
defineExpose({
  currentCatalog,
  searchQuery,
  handleSearch,
  showAddDialog
});
</script>

<template>
  <div class="opds-root">
    <!-- 内容区 -->
    <div class="opds-view">
      <div class="opds-container">
        <!-- 加载中 -->
        <div v-if="loading && !currentFeed" class="loading-state">
          <n-spin size="large" />
        </div>

        <!-- 空状态：没有目录 -->
        <div v-else-if="!hasCatalogs" class="empty-state">
          <div class="empty-icon-wrap">
            <n-icon :component="Library" :size="56" />
          </div>
          <p class="empty-title">{{ t('opds.empty.noCatalogs') }}</p>
          <n-button type="primary" size="large" @click="showAddDialog = true" class="empty-action">
            <template #icon>
              <n-icon :component="Plus" />
            </template>
            {{ t('opds.empty.addFirst') }}
          </n-button>

          <!-- 内置推荐源 -->
          <div class="builtin-sources">
            <p class="builtin-title">{{ t('opds.empty.recommendedSources') }}</p>
            <div class="builtin-list">
              <div
                v-for="builtin in builtinCatalogs"
                :key="builtin.url"
                class="builtin-item"
                @click="handleAddBuiltinCatalog(builtin)"
              >
                <n-icon :component="Globe" :size="16" class="builtin-icon" />
                <div class="builtin-text">
                  <span class="builtin-name">{{ builtin.name }}</span>
                  <span v-if="builtin.description" class="builtin-desc">{{ builtin.description }}</span>
                </div>
                <n-icon :component="Plus" :size="14" class="builtin-add-icon" />
              </div>
            </div>
          </div>

          <p class="empty-hint">{{ t('opds.empty.hint') }}</p>
        </div>

        <!-- 主内容区：左侧目录 + 右侧浏览 -->
        <div v-else class="opds-main">
          <!-- 左侧：目录列表 -->
          <aside class="opds-sidebar">
            <div class="sidebar-header">
              <span class="sidebar-title">{{ t('opds.sidebar.catalogList') }}</span>
            </div>
            <div class="catalog-list">
              <button
                v-for="catalog in catalogs"
                :key="catalog.id"
                class="catalog-item"
                :class="{ active: currentCatalog?.id === catalog.id }"
                @click="selectCatalog(catalog)"
              >
                <n-icon :component="Globe" :size="16" class="catalog-icon" />
                <span class="catalog-name" :title="catalog.name">{{ catalog.name }}</span>
                <button
                  class="catalog-delete-btn"
                  @click.stop="handleRemoveCatalog(catalog)"
                  :title="t('opds.sidebar.deleteCatalog')"
                >
                  <n-icon :component="Trash2" :size="12" />
                </button>
              </button>
            </div>
          </aside>

          <!-- 右侧：浏览内容 -->
          <div class="opds-content">
            <!-- 浏览路径面包屑 -->
            <div class="breadcrumb-bar">
              <n-button v-if="canGoBack" size="tiny" quaternary @click="handleGoBack">
                <template #icon>
                  <n-icon :component="ChevronLeft" :size="14" />
                </template>
                {{ t('common.actions.back') }}
              </n-button>
              <span class="breadcrumb-title">{{ currentFeedTitle }}</span>
            </div>

            <!-- 加载中 -->
            <div v-if="loading" class="content-loading">
              <n-spin size="medium" />
            </div>

            <!-- 搜索中 -->
            <div v-else-if="searching" class="content-loading">
              <n-spin size="medium" />
              <p class="loading-text">{{ t('opds.searching') }}</p>
            </div>

            <!-- 无数据 -->
            <n-empty
              v-else-if="!hasNavigationLinks && !hasEntries"
              :description="t('opds.empty.noContent')"
              size="medium"
            />

            <!-- 导航链接 -->
            <div v-if="hasNavigationLinks" class="navigation-section">
              <div class="nav-grid">
                <button
                  v-for="link in currentFeed?.navigationLinks"
                  :key="link.href"
                  class="nav-card"
                  @click="handleNavigationClick(link)"
                >
                  <n-icon :component="BookOpen" :size="18" class="nav-card-icon" />
                  <span class="nav-card-title">{{ link.title }}</span>
                  <n-icon :component="ChevronRight" :size="14" class="nav-card-arrow" />
                </button>
              </div>
            </div>

            <!-- 书籍列表 -->
            <div v-if="hasEntries" class="entries-section">
              <div class="entries-grid">
                <div v-for="entry in displayEntries" :key="entry.id ?? entry.title" class="entry-card">
                  <!-- 封面 -->
                  <div class="entry-cover">
                    <img
                      v-if="entry.coverUrl && !failedCovers.has(entry.title)"
                      :src="entry.coverUrl"
                      :alt="entry.title"
                      class="cover-img"
                      loading="lazy"
                      @error="
                        failedCovers.add(entry.title);
                        failedCovers = new Set(failedCovers);
                      "
                    />
                    <img
                      v-else
                      :src="generateCoverDataUrl(entry.title, entry.author)"
                      :alt="entry.title"
                      class="cover-img"
                    />
                  </div>

                  <!-- 信息 -->
                  <div class="entry-info">
                    <div class="entry-title" :title="entry.title">{{ entry.title }}</div>
                    <div class="entry-author">{{ entry.author || t('opds.entry.unknownAuthor') }}</div>
                    <div v-if="entry.summary" class="entry-summary" :title="entry.summary">
                      {{ entry.summary.substring(0, 120) }}{{ entry.summary.length > 120 ? '...' : '' }}
                    </div>
                    <div class="entry-meta">
                      <n-tag v-if="entry.format && entry.format !== 'unknown'" size="tiny" type="info" round>
                        {{ entry.format }}
                      </n-tag>
                      <n-tag v-for="cat in entry.categories.slice(0, 2)" :key="cat" size="tiny" round>
                        {{ cat }}
                      </n-tag>
                    </div>
                  </div>

                  <!-- 下载按钮 -->
                  <div class="entry-actions">
                    <n-button
                      v-if="entry.downloadUrl"
                      size="small"
                      type="primary"
                      :loading="downloadingBooks.has(entry.title)"
                      @click="handleDownload(entry)"
                    >
                      <template #icon>
                        <n-icon :component="Download" :size="14" />
                      </template>
                      {{ t('common.actions.download') }}
                    </n-button>
                    <span v-else class="no-download-hint">{{ t('opds.entry.noDownload') }}</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 分页控制 -->
            <div v-if="hasNextPage || hasPreviousPage" class="pagination-bar">
              <n-button v-if="hasPreviousPage" size="small" quaternary @click="handlePreviousPage">
                <template #icon>
                  <n-icon :component="ChevronLeft" :size="14" />
                </template>
                {{ t('opds.pagination.previous') }}
              </n-button>
              <n-button v-if="hasNextPage" size="small" quaternary @click="handleNextPage">
                {{ t('opds.pagination.next') }}
                <template #icon>
                  <n-icon :component="ChevronRight" :size="14" />
                </template>
              </n-button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 添加目录对话框 -->
    <n-modal
      v-model:show="showAddDialog"
      preset="card"
      :title="t('opds.dialog.addTitle')"
      style="width: 480px; max-width: 90vw"
      :bordered="false"
    >
      <div class="add-dialog-content">
        <div class="form-field">
          <label class="form-label">{{ t('opds.dialog.nameLabel') }}</label>
          <n-input v-model:value="newCatalogName" :placeholder="t('opds.dialog.namePlaceholder')" clearable />
        </div>
        <div class="form-field">
          <label class="form-label">{{ t('opds.dialog.urlLabel') }}</label>
          <n-input v-model:value="newCatalogUrl" :placeholder="t('opds.dialog.urlPlaceholder')" clearable />
        </div>
        <div class="form-field">
          <label class="form-label">{{ t('opds.dialog.usernameLabel') }}</label>
          <n-input v-model:value="newCatalogUsername" :placeholder="t('opds.dialog.usernamePlaceholder')" clearable />
        </div>
        <div class="form-field">
          <label class="form-label">{{ t('opds.dialog.passwordLabel') }}</label>
          <n-input
            v-model:value="newCatalogPassword"
            type="password"
            :placeholder="t('opds.dialog.passwordPlaceholder')"
            clearable
          />
        </div>

        <!-- 内置推荐源快速添加 -->
        <div class="builtin-quick-add">
          <p class="quick-add-title">{{ t('opds.dialog.quickAddTitle') }}</p>
          <div class="quick-add-list">
            <n-button
              v-for="builtin in builtinCatalogs"
              :key="builtin.url"
              size="small"
              quaternary
              @click="handleAddBuiltinCatalog(builtin)"
            >
              <template #icon>
                <n-icon :component="Globe" :size="14" />
              </template>
              {{ builtin.name }}
            </n-button>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <n-button @click="showAddDialog = false">{{ t('common.actions.cancel') }}</n-button>
          <n-button type="primary" :loading="addingCatalog" :disabled="addingCatalog" @click="handleAddCatalog">
            <template #icon>
              <n-icon :component="Plus" :size="16" />
            </template>
            {{ t('common.actions.add') }}
          </n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════
   布局结构 — 容器固定跟随窗口，内容区滚动
   ═══════════════════════════════════════════════════════════════ */

.opds-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
}

/* opds-view：唯一可滚动区域（操作按钮已移到 Sources.vue toolbar） */
.opds-view {
  flex: 1;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-md) var(--spacing-lg);
  display: flex;
  justify-content: center;
  min-width: 0;
  background: var(--bg-base);
}

/* 整体限宽居中 */
.opds-container {
  width: 100%;
  max-width: 960px;
  min-width: 0;
}

/* ═══════════════════════════════════════════════════════════════
     操作按钮区
     ═══════════════════════════════════════════════════════════════ */

.header-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-shrink: 0;
}

/* ═══════════════════════════════════════════════════════════════
   加载状态
   ═══════════════════════════════════════════════════════════════ */

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
}

.content-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl) 0;
  gap: var(--spacing-sm);
}

.loading-text {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin: 0;
}

/* ═══════════════════════════════════════════════════════════════
   空状态
   ═══════════════════════════════════════════════════════════════ */

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl) 0;
  gap: var(--spacing-md);
}

.empty-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: var(--bg-active);
  color: var(--text-tertiary);
  margin-bottom: var(--spacing-sm);
}

.empty-title {
  font-size: var(--font-size-lg);
  font-weight: 500;
  color: var(--text-secondary);
  margin: 0;
}

.empty-action {
  margin-top: var(--spacing-xs);
}

.empty-hint {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin: var(--spacing-xs) 0 0;
  text-align: center;
  max-width: 400px;
  line-height: 1.6;
}

/* 内置推荐源 */
.builtin-sources {
  margin-top: var(--spacing-lg);
  width: 100%;
  max-width: 400px;
}

.builtin-title {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-secondary);
  margin: 0 0 var(--spacing-sm);
  text-align: center;
}

.builtin-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.builtin-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--border-radius);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.builtin-item:hover {
  background: var(--bg-hover);
  border-color: var(--primary);
}

.builtin-icon {
  color: var(--primary);
  flex-shrink: 0;
}

.builtin-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.builtin-name {
  font-size: var(--font-size-base);
  color: var(--text-primary);
  line-height: 1.3;
}

.builtin-desc {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.builtin-add-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

/* ═══════════════════════════════════════════════════════════════
   主内容区：左侧目录 + 右侧浏览
   ═══════════════════════════════════════════════════════════════ */

.opds-main {
  display: flex;
  gap: var(--spacing-md);
  height: 100%;
  min-height: 0;
}

/* 左侧目录列表 */
.opds-sidebar {
  width: 200px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.sidebar-header {
  padding: var(--spacing-xs) var(--spacing-sm);
}

.sidebar-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.catalog-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2xs);
}

.catalog-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-sm);
  border-radius: var(--border-radius);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
  text-align: left;
  width: 100%;
}

.catalog-item:hover {
  background: var(--bg-hover);
}

.catalog-item.active {
  background: var(--bg-active);
  border-color: var(--primary);
}

.catalog-icon {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.catalog-item.active .catalog-icon {
  color: var(--primary);
}

.catalog-name {
  flex: 1;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catalog-delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--border-radius-sm);
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-tertiary);
  flex-shrink: 0;
  transition:
    background 0.2s ease,
    color 0.2s ease;
}

.catalog-delete-btn:hover {
  background: var(--color-danger);
  color: var(--text-on-primary);
}

/* 右侧浏览内容 */
.opds-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

/* 面包屑导航 */
.breadcrumb-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) 0;
}

.breadcrumb-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ═══════════════════════════════════════════════════════════════
   导航链接（分类/子目录）
   ═══════════════════════════════════════════════════════════════ */

.navigation-section {
  margin-bottom: var(--spacing-md);
}

.nav-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--spacing-sm);
}

.nav-card {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--border-radius);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition:
    background 0.2s ease,
    transform 0.2s ease;
  text-align: left;
  width: 100%;
}

.nav-card:hover {
  background: var(--bg-hover);
  transform: translateX(2px);
}

.nav-card-icon {
  color: var(--primary);
  flex-shrink: 0;
}

.nav-card-title {
  flex: 1;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-card-arrow {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

/* ═══════════════════════════════════════════════════════════════
   书籍条目列表
   ═══════════════════════════════════════════════════════════════ */

.entries-section {
  flex: 1;
}

.entries-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--spacing-md);
}

.entry-card {
  display: flex;
  gap: var(--spacing-sm);
  padding: var(--spacing-md);
  border-radius: var(--border-radius);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
  height: 130px;
  overflow: hidden;
}

.entry-card:hover {
  background: var(--bg-hover);
  border-color: color-mix(in srgb, var(--primary) 30%, var(--border-color));
}

/* 封面 */
.entry-cover {
  width: 60px;
  height: 84px;
  flex-shrink: 0;
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  background: var(--bg-active);
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 信息 */
.entry-info {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2xs);
  overflow: hidden;
}

.entry-title {
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.entry-author {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.entry-summary {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
}

.entry-meta {
  display: flex;
  flex-wrap: nowrap;
  gap: var(--spacing-2xs);
  margin-top: auto;
  overflow: hidden;
  white-space: nowrap;
}

/* 下载按钮 */
.entry-actions {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
}

.no-download-hint {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  font-style: italic;
}

/* ═══════════════════════════════════════════════════════════════
   分页控制
   ═══════════════════════════════════════════════════════════════ */

.pagination-bar {
  display: flex;
  justify-content: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md) 0;
}

/* ═══════════════════════════════════════════════════════════════
   添加目录对话框
   ═══════════════════════════════════════════════════════════════ */

.add-dialog-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2xs);
}

.form-label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-secondary);
}

.builtin-quick-add {
  margin-top: var(--spacing-sm);
  padding-top: var(--spacing-sm);
  border-top: 1px solid var(--border-color);
}

.quick-add-title {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0 0 var(--spacing-sm);
}

.quick-add-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
}
</style>
