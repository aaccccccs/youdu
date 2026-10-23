import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Book, Subscription, SubscriptionType, CheckUpdateResult } from '@renderer/types';
import type { SubscriptionStat } from './types';

// ═══════════════════════════════════════════════════════════════════════
// 3. Subscription Store
// ═══════════════════════════════════════════════════════════════════════

/**
 * 订阅状态管理（Pinia Store）
 *
 * 维护订阅列表、有更新的书籍列表等状态，
 * 通过 window.subscriptionApi 与主进程交互。
 *
 * 设计要点：
 * - subscriptions：全部订阅源列表
 * - updateBooks：有更新的书籍列表（has_update=1），用于书架徽章和订阅页底部展示
 * - 各订阅关联书籍数和有更新数通过 getBooks 异步加载，缓存在 subscriptionStats 映射中
 * - 检查更新操作会刷新 updateBooks，供书架徽章响应
 */

export const useSubscriptionStore = defineStore('subscription', () => {
  // ─── State ───
  const subscriptions = ref<Subscription[]>([]);
  const updateBooks = ref<Book[]>([]);
  const loading = ref<boolean>(false);
  const checking = ref<boolean>(false);
  /** 各订阅统计信息映射（subscription id → stat） */
  const subscriptionStats = ref<Record<number, SubscriptionStat>>({});
  /** 是否已初始化 */
  const initialized = ref<boolean>(false);

  // ─── Getters ───
  /** 订阅总数 */
  const subscriptionCount = computed<number>(() => subscriptions.value.length);

  /** 是否为空 */
  const isEmpty = computed<boolean>(() => !loading.value && subscriptions.value.length === 0);

  /** 有更新的书籍总数 */
  const updateBookCount = computed<number>(() => updateBooks.value.length);

  /** 启用的订阅数 */
  const enabledCount = computed<number>(() => subscriptions.value.filter((s) => s.enabled === 1).length);

  // ─── Actions：数据加载 ───

  /** 加载订阅列表 */
  async function loadSubscriptions(): Promise<void> {
    loading.value = true;
    try {
      const list = await window.subscriptionApi.list();
      subscriptions.value = list as Subscription[];
      // 加载各订阅的统计信息
      await loadAllStats();
    } catch (err) {
      console.error('[subscription] 加载订阅列表失败:', err);
      subscriptions.value = [];
    } finally {
      loading.value = false;
    }
  }

  /** 加载有更新的书籍列表 */
  async function loadUpdateBooks(): Promise<void> {
    try {
      const books = await window.subscriptionApi.getUpdates();
      updateBooks.value = books as Book[];
    } catch (err) {
      console.error('[subscription] 加载更新书籍列表失败:', err);
      updateBooks.value = [];
    }
  }

  /** 加载单个订阅的统计信息（关联书籍数 + 有更新数） */
  async function loadStat(subscriptionId: number): Promise<void> {
    try {
      const books = await window.subscriptionApi.getBooks(subscriptionId);
      const bookList = books as Book[];
      subscriptionStats.value = {
        ...subscriptionStats.value,
        [subscriptionId]: {
          bookCount: bookList.length,
          updateCount: bookList.filter((b) => b.has_update === 1).length
        }
      };
    } catch (err) {
      console.warn(`[subscription] 加载订阅 ${subscriptionId} 统计失败:`, err);
    }
  }

  /** 加载所有订阅的统计信息 */
  async function loadAllStats(): Promise<void> {
    const ids = subscriptions.value.map((s) => s.id);
    await Promise.all(ids.map((id) => loadStat(id)));
  }

  /** 初始化（加载订阅列表 + 更新书籍列表） */
  async function init(): Promise<void> {
    if (initialized.value) return;
    await Promise.all([loadSubscriptions(), loadUpdateBooks()]);
    initialized.value = true;
  }

  /** 刷新（重新加载订阅列表 + 更新书籍列表） */
  async function refresh(): Promise<void> {
    await Promise.all([loadSubscriptions(), loadUpdateBooks()]);
  }

  // ─── Actions：订阅管理 ───

  /** 添加订阅 */
  async function addSubscription(input: {
    name: string;
    type: SubscriptionType;
    url: string;
    config?: string | null;
    checkInterval?: number;
    enabled?: number;
    autoImport?: number;
  }): Promise<number> {
    try {
      const id = await window.subscriptionApi.add({
        name: input.name,
        type: input.type,
        url: input.url,
        config: input.config ?? null,
        check_interval: input.checkInterval,
        enabled: input.enabled,
        auto_import: input.autoImport
      });
      await loadSubscriptions();
      return id;
    } catch (err) {
      console.error('[subscription] 添加订阅失败:', err);
      throw err;
    }
  }

  /** 移除订阅（不删除关联书籍） */
  async function removeSubscription(id: number): Promise<void> {
    try {
      await window.subscriptionApi.remove(id);
      // 从本地列表移除，避免重新加载
      subscriptions.value = subscriptions.value.filter((s) => s.id !== id);
      // 清除统计
      const nextStats = { ...subscriptionStats.value };
      delete nextStats[id];
      subscriptionStats.value = nextStats;
      // 刷新更新书籍列表
      await loadUpdateBooks();
    } catch (err) {
      console.error('[subscription] 移除订阅失败:', err);
      throw err;
    }
  }

  /** 更新订阅配置 */
  async function updateSubscription(
    id: number,
    input: {
      name?: string;
      url?: string;
      config?: string | null;
      checkInterval?: number;
      enabled?: number;
      autoImport?: number;
    }
  ): Promise<void> {
    try {
      await window.subscriptionApi.update(id, {
        name: input.name,
        url: input.url,
        config: input.config,
        check_interval: input.checkInterval,
        enabled: input.enabled,
        auto_import: input.autoImport
      });
      await loadSubscriptions();
    } catch (err) {
      console.error('[subscription] 更新订阅失败:', err);
      throw err;
    }
  }

  /** 切换订阅启用/禁用 */
  async function toggleEnabled(id: number): Promise<void> {
    const sub = subscriptions.value.find((s) => s.id === id);
    if (!sub) return;
    const newEnabled = sub.enabled === 1 ? 0 : 1;
    try {
      await window.subscriptionApi.update(id, { enabled: newEnabled });
      sub.enabled = newEnabled;
      await loadStat(id);
    } catch (err) {
      console.error('[subscription] 切换订阅状态失败:', err);
      throw err;
    }
  }

  // ─── Actions：检查更新 ───

  /** 检查单个订阅更新 */
  async function checkUpdate(id: number): Promise<CheckUpdateResult> {
    checking.value = true;
    try {
      const result = await window.subscriptionApi.checkUpdate(id);
      // 刷新统计和更新书籍列表
      await Promise.all([loadStat(id), loadUpdateBooks()]);
      return result as CheckUpdateResult;
    } catch (err) {
      console.error('[subscription] 检查更新失败:', err);
      throw err;
    } finally {
      checking.value = false;
    }
  }

  /** 检查所有订阅更新 */
  async function checkAllUpdates(): Promise<void> {
    checking.value = true;
    try {
      await window.subscriptionApi.checkAllUpdates();
      await refresh();
    } catch (err) {
      console.error('[subscription] 检查所有更新失败:', err);
      throw err;
    } finally {
      checking.value = false;
    }
  }

  // ─── Actions：更新标记 ───

  /** 标记书籍更新状态 */
  async function markBookUpdate(bookId: number, hasUpdate: boolean): Promise<void> {
    try {
      await window.subscriptionApi.markBookUpdate(bookId, hasUpdate);
      await loadUpdateBooks();
    } catch (err) {
      console.error('[subscription] 标记书籍更新状态失败:', err);
      throw err;
    }
  }

  /** 清除所有书籍更新标记 */
  async function clearAllUpdates(): Promise<void> {
    try {
      await window.subscriptionApi.clearAllUpdates();
      updateBooks.value = [];
      // 刷新所有订阅统计
      await loadAllStats();
    } catch (err) {
      console.error('[subscription] 清除所有更新标记失败:', err);
      throw err;
    }
  }

  /** 获取某订阅关联的书籍 */
  async function getBooks(subscriptionId: number): Promise<Book[]> {
    try {
      const books = await window.subscriptionApi.getBooks(subscriptionId);
      return books as Book[];
    } catch (err) {
      console.error('[subscription] 获取订阅书籍失败:', err);
      return [];
    }
  }

  return {
    // state
    subscriptions,
    updateBooks,
    loading,
    checking,
    subscriptionStats,
    initialized,
    // getters
    subscriptionCount,
    isEmpty,
    updateBookCount,
    enabledCount,
    // actions
    loadSubscriptions,
    loadUpdateBooks,
    loadStat,
    loadAllStats,
    init,
    refresh,
    addSubscription,
    removeSubscription,
    updateSubscription,
    toggleEnabled,
    checkUpdate,
    checkAllUpdates,
    markBookUpdate,
    clearAllUpdates,
    getBooks
  };
});
