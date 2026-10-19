/**
 * 订阅源 IPC
 */
import { ipcMain } from 'electron';

import * as SubscriptionManager from '../core/subscription';
import type { CreateSubscriptionInput, UpdateSubscriptionInput } from '../db/repositories';

import { IPC_CHANNELS, wrapHandler, assertPositiveInt } from './shared';

/** 注册订阅相关 IPC handler */
export function registerSubscriptionIpc(): void {
  // 添加订阅
  // 参数：(input: CreateSubscriptionInput)
  // 返回：新订阅 id
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_ADD,
    wrapHandler((_e, input: CreateSubscriptionInput) => {
      return SubscriptionManager.addSubscription(input);
    })
  );

  // 移除订阅
  // 参数：(id: number)
  // 返回：void
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_REMOVE,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      return SubscriptionManager.removeSubscription(id);
    })
  );

  // 列出全部订阅
  // 返回：Subscription[]
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_LIST,
    wrapHandler(() => SubscriptionManager.listSubscriptions())
  );

  // 获取单个订阅
  // 参数：(id: number)
  // 返回：Subscription | undefined
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_GET,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      return SubscriptionManager.getSubscription(id);
    })
  );

  // 更新订阅配置
  // 参数：(id: number, input: UpdateSubscriptionInput)
  // 返回：void
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_UPDATE,
    wrapHandler((_e, id: number, input: UpdateSubscriptionInput) => {
      assertPositiveInt(id, 'id');
      return SubscriptionManager.updateSubscription(id, input);
    })
  );

  // 手动检查单个订阅更新
  // 参数：(id: number)
  // 返回：UpdateResult
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_CHECK_UPDATE,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      return SubscriptionManager.checkUpdate(id);
    })
  );

  // 手动检查所有订阅更新
  // 返回：void
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_CHECK_ALL_UPDATES,
    wrapHandler(() => SubscriptionManager.checkAllUpdates())
  );

  // 获取有更新的书籍列表（书架徽章用）
  // 返回：Book[]
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_GET_UPDATES,
    wrapHandler(() => SubscriptionManager.listUpdatedBooks())
  );

  // 获取某订阅关联的书籍
  // 参数：(subscriptionId: number)
  // 返回：Book[]
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_GET_BOOKS,
    wrapHandler((_e, subscriptionId: number) => {
      assertPositiveInt(subscriptionId, 'subscriptionId');
      return SubscriptionManager.getBooksBySubscription(subscriptionId);
    })
  );

  // 标记书籍更新状态（清除/设置徽章）
  // 参数：(bookId: number, hasUpdate: boolean)
  // 返回：void
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_MARK_BOOK_UPDATE,
    wrapHandler((_e, bookId: number, hasUpdate: boolean) => {
      SubscriptionManager.markBookUpdate(bookId, hasUpdate);
    })
  );

  // 清除所有书籍更新标记
  // 返回：void
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_CLEAR_ALL_UPDATES,
    wrapHandler(() => SubscriptionManager.clearAllBookUpdates())
  );

  // 智能添加网络源（v14 新增）
  // 参数：(url: string, name?: string)
  // 返回：AddSmartResult
  // 自动检测格式：XML→内容订阅
  ipcMain.handle(
    IPC_CHANNELS.SUBSCRIPTION_ADD_SMART,
    wrapHandler((_e, url: string, name?: string) => {
      return SubscriptionManager.addSmartSource(url, name);
    })
  );
}
