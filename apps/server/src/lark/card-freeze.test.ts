import { describe, expect, it } from 'vitest';
import { buildLarkCard, larkCardStates } from './service.js';

// 冻结收据的硬保证：终态进度卡转为只读后，绝不允许出现任何操作按钮。
// 这是设计契约里最硬的一条（§4.3「只读卡不提供假操作」），因此在整卡装配的
// 最终产物上做结构断言，而不是只测 card-actions 单元——防止未来有人在
// service.ts 的布局层重新塞回按钮。
const collectButtons = (node: unknown, found: string[] = []): string[] => {
  if (Array.isArray(node)) node.forEach(item => collectButtons(item, found));
  else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record.tag === 'button') found.push(String(record.element_id ?? '(unnamed)'));
    Object.values(record).forEach(value => collectButtons(value, found));
  }
  return found;
};

describe('飞书卡片冻结收据', () => {
  it('只读卡在所有状态下都不渲染任何按钮，即使能力全开', () => {
    for (const state of larkCardStates) {
      const card = buildLarkCard({
        state, taskId: 't1', readOnly: true,
        webBaseUrl: 'https://web.example.com', sessionId: 'ses_1',
        capabilities: { canCancelQueued: true, canInterrupt: true, canRetry: true, canRefresh: true, webUrl: 'https://web.example.com/sessions/ses_1' }
      });
      expect(collectButtons(card), `state=${state} 的只读收据不得有按钮`).toEqual([]);
    }
  });

  it('非只读卡按状态收敛到唯一主操作', () => {
    const capabilities = { canCancelQueued: true, canInterrupt: true, canRetry: true, canRefresh: false };
    expect(collectButtons(buildLarkCard({ state: 'queued', taskId: 't1', capabilities }))).toEqual(['cancel']);
    expect(collectButtons(buildLarkCard({ state: 'running', taskId: 't1', capabilities }))).toEqual(['interrupt']);
    expect(collectButtons(buildLarkCard({ state: 'failed', taskId: 't1', capabilities }))).toEqual(['retry']);
    expect(collectButtons(buildLarkCard({ state: 'interrupted', taskId: 't1', capabilities }))).toEqual(['retry']);
    // completed 不提供操作：结果已作为 fresh final 送达，验收在 Web。
    expect(collectButtons(buildLarkCard({ state: 'completed', taskId: 't1', capabilities }))).toEqual([]);
  });

  it('能力为 false 时不渲染注定失败的按钮', () => {
    const none = { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false };
    for (const state of larkCardStates) {
      expect(collectButtons(buildLarkCard({ state, taskId: 't1', capabilities: none })), `state=${state}`).toEqual([]);
    }
  });
});
