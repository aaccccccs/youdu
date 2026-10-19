<!--
  订阅管理视图

  布局结构：
  .subscriptions-root (flex column, height:100%, overflow:hidden)
    ├── .subscriptions-header (flex-shrink:0, 琉璃质感) ← 固定 header
    └── .subscriptions-view (flex:1, overflow-y:auto) ← 内容滚动区
        └── .subscriptions-container (max-width:960px, margin:0 auto)
            ├── .subscriptions-grid (订阅源卡片网格)
            └── .update-books-section (有更新的书籍列表)

  功能：
  - 顶部：页面标题"订阅" + "添加订阅"按钮 + "全部检查"按钮（琉璃质感固定 header）
  - 主体：订阅源卡片列表（网格布局，参考书架九宫格）
  - 空状态：无订阅时显示引导文字 + 添加按钮
  - 底部：有更新的书籍列表（可点击跳转阅读）
-->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { NButton, NIcon, NSpin, useMessage, useDialog } from 'naive-ui';
import { Rss, Plus, BookOpen, ArrowRight } from '@lucide/vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useSubscriptionStore } from '@renderer/stores';
import { useBookshelfStore } from '@renderer/stores';
import type { Subscription, Book } from '@renderer/types';
import { coverPathToUrl, generateCoverDataUrl } from '@renderer/utils';
import SubscriptionCard from '@renderer/components/subscription/SubscriptionCard.vue';
import AddSubscriptionDialog from '@renderer/components/subscription/AddSubscriptionDialog.vue';

const { t } = useI18n();

const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const store = useSubscriptionStore();
const bookshelfStore = useBookshelfStore();

/* ==================== 对话框状态 ==================== */

/** 添加/编辑对话框显示状态 */
const showDialog = ref<boolean>(false);
/** 编辑模式下的订阅（null=添加模式） */
const editTarget = ref<Subscription | null>(null);

/** 当前正在检查更新的订阅 id */
const checkingId = ref<number | null>(null);

/* ==================== 计算属性 ==================== */

/** 是否有订阅 */
const hasSubscriptions = computed((): boolean => store.subscriptionCount > 0);

/** 是否有更新书籍 */
const hasUpdateBooks = computed((): boolean => store.updateBookCount > 0);

/* ==================== 对话框操作 ==================== */

/** 打开添加对话框 */
function openAddDialog(): void {
  editTarget.value = null;
  showDialog.value = true;
}

/** 打开编辑对话框 */
function openEditDialog(sub: Subscription): void {
  editTarget.value = sub;
  showDialog.value = true;
}

/** 对话框关闭 */
function handleDialogUpdateShow(value: boolean): void {
  showDialog.value = value;
}

/** 对话框提交成功 */
async function handleSubmitted(): Promise<void> {
  await store.refresh();
}

/* ==================== 订阅操作 ==================== */

/** 检查单个订阅更新 */
async function handleCheck(id: number): Promise<void> {
  if (checkingId.value !== null) return;
  checkingId.value = id;
  try {
    const result = await store.checkUpdate(id);
    if (result.success) {
      if (result.newCount > 0) {
        message.success(t('sources.foundNewItems', { name: result.subscriptionName, n: result.newCount }));
        // 有新书导入，派发书架刷新事件
        window.dispatchEvent(new CustomEvent('bookshelf:refresh'));
      } else {
        message.info(t('sources.noNewItems', { name: result.subscriptionName }));
      }
    } else {
      message.warning(t('sources.checkFailed', { error: result.error ?? t('sources.unknownError') }));
    }
  } catch (err) {
    message.error(t('sources.checkUpdateFailed', { message: (err as Error).message }));
  } finally {
    checkingId.value = null;
  }
}

/** 检查所有订阅更新 */
async function handleCheckAll(): Promise<void> {
  if (store.checking) return;
  const loadingMsg = message.loading(t('sources.checkingAll'), { duration: 0 });
  try {
    await store.checkAllUpdates();
    if (store.updateBookCount > 0) {
      message.success(t('sources.checkDoneBooks', { n: store.updateBookCount }));
      // 有新书导入，派发书架刷新事件
      window.dispatchEvent(new CustomEvent('bookshelf:refresh'));
    } else {
      message.success(t('sources.checkDoneNone'));
    }
  } catch (err) {
    message.error(t('sources.checkAllFailed', { message: (err as Error).message }));
  } finally {
    loadingMsg.destroy();
  }
}

/** 删除订阅（同时删除关联书籍和分组，需用户确认） */
async function handleDelete(id: number): Promise<void> {
  dialog.warning({
    title: t('sources.deleteConfirmTitle'),
    content: t('sources.deleteConfirmContent'),
    positiveText: t('sources.confirmDelete'),
    negativeText: t('common.actions.cancel'),
    onPositiveClick: async () => {
      try {
        await store.removeSubscription(id);
        message.success(t('sources.deleteSuccess'));
      } catch (err) {
        message.error(t('sources.deleteFailed', { message: (err as Error).message }));
      }
    }
  });
}

/** 正在切换状态的订阅源 ID 集合（防重复点击） */
const togglingIds = ref<Set<number>>(new Set());

/** 切换启用/禁用 */
async function handleToggleEnabled(id: number): Promise<void> {
  if (togglingIds.value.has(id)) return;
  togglingIds.value.add(id);
  try {
    await store.toggleEnabled(id);
  } catch (err) {
    message.error(t('sources.toggleFailed', { message: (err as Error).message }));
  } finally {
    togglingIds.value.delete(id);
  }
}

/* ==================== 更新书籍操作 ==================== */

/** 封面加载失败的书籍 id 集合（加载失败后回退到 SVG 占位封面） */
const failedCovers = ref<Set<number>>(new Set());

/** 获取书籍封面 URL：优先用真实封面（coverPathToUrl 转换本地路径），无封面或加载失败则生成 SVG 占位封面 */
function getCoverSrc(book: Book): string {
  const coverPath: string | null = book.cover;
  if (coverPath && !failedCovers.value.has(book.id)) {
    const url: string | null = coverPathToUrl(coverPath);
    if (url) return url;
  }
  return generateCoverDataUrl(book.title, book.author);
}

/** 封面加载失败回调：标记该书 id 失败，触发回退到 SVG 占位封面 */
function handleCoverError(bookId: number): void {
  failedCovers.value.add(bookId);
  failedCovers.value = new Set(failedCovers.value);
}

/** 打开书籍（RSS 文章跳转文章视图，漫画跳转漫画阅读器，其他跳转小说阅读器） */
async function openBook(book: Book): Promise<void> {
  await bookshelfStore.touchRead(book.id);
  // 统一阅读器：所有类型都用Reader
  if (book.file_type === 'rss') {
    router.push(`/article/${book.id}`);
  } else {
    router.push(`/reader/${book.id}`);
  }
}

/** 查看书籍详情 */
function openBookDetail(book: Book): void {
  router.push(`/book/${book.id}`);
}

/** 清除单本书的更新标记 */
async function handleClearUpdate(book: Book): Promise<void> {
  try {
    await store.markBookUpdate(book.id, false);
    message.success(t('sources.markedRead'));
  } catch (err) {
    message.error(t('sources.clearMarkFailed', { message: (err as Error).message }));
  }
}

/** 清除所有更新标记 */
async function handleClearAllUpdates(): Promise<void> {
  try {
    await store.clearAllUpdates();
    message.success(t('sources.clearedAllMarks'));
  } catch (err) {
    message.error(t('sources.clearMarkFailed', { message: (err as Error).message }));
  }
}

/* ==================== 生命周期 ==================== */

onMounted(() => {
  if (store.initialized) {
    void store.refresh().catch((e) => console.error('store.refresh 失败:', e));
  } else {
    void store.init().catch((e) => console.error('store.init 失败:', e));
  }
});

/** 暴露给 Sources.vue 的方法和状态 */
defineExpose({
  hasSubscriptions,
  checking: computed(() => store.checking),
  handleCheckAll,
  openAddDialog
});
</script>

<template>
  <div class="subscriptions-root">
    <!-- 内容滚动区 -->
    <div class="subscriptions-view">
      <div class="subscriptions-container">
        <!-- 加载中 -->
        <div v-if="store.loading && !hasSubscriptions" class="loading-state">
          <n-spin size="large" />
        </div>

        <!-- 空状态 -->
        <div v-else-if="store.isEmpty" class="empty-state">
          <div class="empty-icon-wrap">
            <n-icon :component="Rss" :size="56" />
          </div>
          <p class="empty-title">{{ t('sources.empty.title') }}</p>
          <n-button type="primary" size="large" @click="openAddDialog" class="empty-action">
            <template #icon>
              <n-icon :component="Plus" />
            </template>
            {{ t('sources.empty.addFirst') }}
          </n-button>
          <p class="empty-hint">{{ t('sources.empty.hint') }}</p>
        </div>

        <!-- 订阅卡片网格 -->
        <div v-else class="subscriptions-grid">
          <SubscriptionCard
            v-for="sub in store.subscriptions"
            :key="sub.id"
            :subscription="sub"
            :stat="store.subscriptionStats[sub.id]"
            :checking="checkingId === sub.id"
            @check="handleCheck"
            @edit="openEditDialog"
            @delete="handleDelete"
            @toggle-enabled="handleToggleEnabled"
          />
        </div>

        <!-- 有更新的书籍列表 -->
        <section v-if="hasUpdateBooks" class="update-books-section">
          <div class="section-header">
            <div class="section-title-area">
              <n-icon :component="BookOpen" :size="18" class="section-icon" />
              <h2 class="section-title">{{ t('sources.updatedBooksTitle') }}</h2>
              <span class="section-count">{{ t('sources.bookCount', { n: store.updateBookCount }) }}</span>
            </div>
            <n-button size="small" quaternary @click="handleClearAllUpdates">
              {{ t('sources.markAllRead') }}
            </n-button>
          </div>

          <div class="update-books-list">
            <div v-for="book in store.updateBooks" :key="book.id" class="update-book-item">
              <!-- 封面 -->
              <div class="update-book-cover" @click="openBook(book as Book)">
                <img
                  :src="getCoverSrc(book as Book)"
                  :alt="t('sources.coverAlt')"
                  class="cover-img"
                  loading="lazy"
                  @error="handleCoverError((book as Book).id)"
                />
                <!-- 更新红点 -->
                <span class="update-dot" />
              </div>

              <!-- 信息 -->
              <div class="update-book-info" @click="openBook(book as Book)">
                <div class="update-book-title" :title="book.title">{{ book.title }}</div>
                <div class="update-book-author">{{ book.author || t('sources.unknownAuthor') }}</div>
              </div>

              <!-- 操作 -->
              <div class="update-book-actions">
                <n-button
                  size="tiny"
                  quaternary
                  @click="openBookDetail(book as Book)"
                  :title="t('common.actions.detail')"
                >
                  <template #icon>
                    <n-icon :component="ArrowRight" :size="14" />
                  </template>
                </n-button>
                <n-button
                  size="tiny"
                  quaternary
                  @click="handleClearUpdate(book as Book)"
                  :title="t('sources.markRead')"
                >
                  {{ t('sources.markRead') }}
                </n-button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- 添加/编辑订阅对话框 -->
    <AddSubscriptionDialog
      :show="showDialog"
      :edit-subscription="editTarget"
      @update:show="handleDialogUpdateShow"
      @submitted="handleSubmitted"
    />
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════════════
   布局结构 — 容器固定跟随窗口，内容区滚动
   ═══════════════════════════════════════════════════════════════ */

.subscriptions-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
}

/* subscriptions-view：唯一可滚动区域（操作按钮已移到 Sources.vue toolbar） */
.subscriptions-view {
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

/* 整体限宽 960px 居中 */
.subscriptions-container {
  width: 100%;
  max-width: 800px;
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

/* ═══════════════════════════════════════════════════════════════
   订阅卡片网格
   ═══════════════════════════════════════════════════════════════ */

.subscriptions-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-xl);
}

/* ═══════════════════════════════════════════════════════════════
   有更新的书籍列表
   ═══════════════════════════════════════════════════════════════ */

.update-books-section {
  margin-top: var(--spacing-xl);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-md);
  padding-bottom: var(--spacing-sm);
  border-bottom: 1px solid var(--border-color);
}

.section-title-area {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.section-icon {
  color: var(--primary);
}

.section-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}

.section-count {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.update-books-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.update-book-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--border-radius);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  transition:
    background 0.2s ease,
    transform 0.2s ease;
}

.update-book-item:hover {
  background: var(--bg-hover);
  transform: translateX(2px);
}

/* 封面 */
.update-book-cover {
  position: relative;
  width: 40px;
  height: 56px;
  flex-shrink: 0;
  border-radius: var(--border-radius-sm);
  overflow: hidden;
  background: var(--bg-active);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 更新红点 */
.update-dot {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-danger);
  box-shadow: 0 0 4px color-mix(in srgb, var(--color-danger) 50%, transparent);
}

/* 信息 */
.update-book-info {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.update-book-title {
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.update-book-author {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
  margin-top: 2px;
}

/* 操作 */
.update-book-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-2xs);
  flex-shrink: 0;
}
</style>
