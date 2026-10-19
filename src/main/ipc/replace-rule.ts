/**
 * 内容替换规则 IPC
 */
import { ipcMain } from 'electron';

import { invalidateReplaceRulesCache } from '../core/chapter-reader';
import * as ReplaceRuleRepo from '../db/repositories';
import type { CreateReplaceRuleInput, UpdateReplaceRuleInput } from '../db/repositories';

import { IPC_CHANNELS, wrapHandler, assertPositiveInt } from './shared';

/** 注册内容替换规则相关 IPC handler */
export function registerReplaceRuleIpc(): void {
  // 添加内容替换规则
  // 参数：(input: { pattern, replacement, scope, book_id?, is_regex? })
  // 返回：新增的替换规则
  ipcMain.handle(
    IPC_CHANNELS.REPLACE_RULE_ADD,
    wrapHandler((_e, input: CreateReplaceRuleInput) => {
      // 参数校验
      if (!input || !input.pattern) {
        throw new Error('替换规则 pattern 不能为空');
      }
      if (input.scope !== 'global' && input.scope !== 'book') {
        throw new Error('scope 必须为 global 或 book');
      }
      if (input.scope === 'book' && !input.book_id) {
        throw new Error('scope=book 时必须指定 book_id');
      }
      if (input.pattern.length > 2000) {
        throw new Error('替换规则 pattern 过长（超过 2000 字）');
      }
      if (input.replacement && input.replacement.length > 10000) {
        throw new Error('替换内容过长（超过 10000 字）');
      }
      const result = ReplaceRuleRepo.createReplaceRule({
        pattern: input.pattern,
        replacement: input.replacement ?? '',
        scope: input.scope,
        book_id: input.book_id ?? null,
        is_regex: input.is_regex ?? 0
      });
      // 替换规则变更，失效章节读取的替换规则缓存
      invalidateReplaceRulesCache();
      return result;
    })
  );

  // 查询全部内容替换规则
  // 返回：替换规则列表（按创建时间倒序）
  ipcMain.handle(
    IPC_CHANNELS.REPLACE_RULE_LIST,
    wrapHandler(() => ReplaceRuleRepo.listAllReplaceRules())
  );

  // 删除内容替换规则
  // 参数：(id: number)
  // 返回：void
  ipcMain.handle(
    IPC_CHANNELS.REPLACE_RULE_DELETE,
    wrapHandler((_e, id: number) => {
      assertPositiveInt(id, 'id');
      ReplaceRuleRepo.deleteReplaceRule(id);
      // 替换规则变更，失效章节读取的替换规则缓存
      invalidateReplaceRulesCache();
    })
  );

  // 启停内容替换规则
  // 参数：(id: number, enabled: number)  enabled: 0=禁用 1=启用
  // 返回：void
  ipcMain.handle(
    IPC_CHANNELS.REPLACE_RULE_TOGGLE,
    wrapHandler((_e, id: number, enabled: number) => {
      assertPositiveInt(id, 'id');
      if (enabled !== 0 && enabled !== 1) throw new Error('无效的 enabled：必须为 0 或 1');
      const input: UpdateReplaceRuleInput = { enabled };
      ReplaceRuleRepo.updateReplaceRule(id, input);
      // 替换规则变更，失效章节读取的替换规则缓存
      invalidateReplaceRulesCache();
    })
  );
}
