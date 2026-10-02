import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UsageHud } from './UsageHud';
const totals = { entries: 1, tokenEntries: 1, costUsd: 1, estimatedCostUsd: 0, inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, unavailable: 0 };
describe('task usage HUD', () => {
  it('shows context, zero quota, independent missing windows and own plus child tokens', () => {
    render(<UsageHud usage={{ own: totals, subSteps: totals, snapshot: { context: { used: 1000, size: 10000, observedAt: new Date().toISOString() }, rateLimits: { fiveHour: { usedPercent: 0, resetsAt: Date.now() / 1000 + 3600, observedAt: new Date().toISOString() } } } }}/>);
    expect(screen.getByRole('progressbar', { name: '上下文已用' }).getAttribute('aria-valuenow')).toBe('10');
    expect(screen.getByRole('progressbar', { name: '5h额度已用' }).getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByText('未提供')).toBeTruthy();
    expect(screen.getByText('310')).toBeTruthy();
    expect(screen.getByText('账户5h额度')).toBeTruthy();
    expect(screen.getByText(/上报于/)).toBeTruthy();
    expect(screen.getByText(/输入 200 · 输出 40 · 缓存读 60 · 缓存写 10/)).toBeTruthy();
    expect(screen.getByText(/含子步骤/)).toBeTruthy();
  });
  it('labels expired data, loading and failures and clears readings on a session switch', () => {
    const { rerender } = render(<UsageHud usage={{ own: totals, subSteps: totals, snapshot: { rateLimits: { sevenDay: { usedPercent: 45, resetsAt: 1, observedAt: '2026-10-01T00:00:00Z' } } } }}/>);
    expect(screen.getByText('45%（已过期）')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    rerender(<UsageHud loading/>);
    expect(screen.getAllByText('加载中…')).toHaveLength(4);
    expect(screen.queryByText('310')).toBeNull();
    rerender(<UsageHud error/>);
    expect(screen.getAllByText('加载失败')).toHaveLength(4);
    expect(screen.getByRole('status').textContent).toContain('用量刷新失败');
  });
  it('does not turn cost-only or partial records into complete zero token measurements', () => {
    const { rerender } = render(<UsageHud usage={{ own: { ...totals, tokenEntries: 0 }, subSteps: { ...totals, entries: 0, tokenEntries: 0 } }}/>);
    expect(screen.getByText('暂无数据')).toBeTruthy();
    rerender(<UsageHud usage={{ own: { ...totals, entries: 2, partialTokenEntries: 1 }, subSteps: { ...totals, entries: 0, tokenEntries: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }}/>);
    expect(screen.getByText('≥ 155')).toBeTruthy();
    expect(screen.getByText('1 次执行无 token 数据')).toBeTruthy();
    expect(screen.getByText('1 次执行仅有部分 token 数据')).toBeTruthy();
  });
});
