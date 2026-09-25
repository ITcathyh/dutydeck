import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UsageGroup, UsageTotals } from '@dutydeck/shared';
import { api, ApiError, type LarkBotConfig, type UsageSummary } from '../api';
import { UsageOverview } from './UsageOverview';

const totals = (patch: Partial<UsageTotals> = {}): UsageTotals => ({ entries: 0, costUsd: 0, estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unavailable: 0, ...patch });
const row = (patch: Partial<UsageGroup>): UsageGroup => ({ ...totals({ entries: 2, costUsd: 1.2, estimatedCostUsd: 0.2, inputTokens: 1000, outputTokens: 50 }), ...patch });
const window = (costUsd: number, since: string) => ({
  since, totals: totals({ entries: 2, costUsd, estimatedCostUsd: 0.2, inputTokens: 1000, outputTokens: 50 }),
  bots: [row({ appId: 'cli_a', costUsd })], chats: [row({ appId: 'cli_a', chatId: 'oc_1', costUsd })], actors: [row({ actorId: 'ou_1', costUsd })], categories: [row({ category: 'proactive', costUsd })]
});
const summary: UsageSummary = { month: window(3, '2026-08-31T16:00:00.000Z'), week: window(1.2, '2026-09-18T00:00:00.000Z'), caps: [{ scope: 'group', appId: 'cli_a', chatId: 'oc_1', monthlyCostUsd: 4, updatedAt: '2026-09-25T00:00:00Z' }] };
const bots = [{ configured: true, appId: 'cli_a', name: '值班 Bot', tabLabel: '值班 Bot', setupComplete: true }] as LarkBotConfig[];

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><UsageOverview bots={bots}/></QueryClientProvider>);
}

describe('usage overview', () => {
  it('summarises this month and the last 7 days by bot, group, actor and source, marking estimates', async () => {
    vi.spyOn(api, 'usageSummary').mockResolvedValue(summary);
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [{ key: 'g1', chatId: 'oc_1', name: '研发群', bots: [{ appId: 'cli_a' }] as any }] });
    const user = userEvent.setup();
    mount();
    const byBot = await screen.findByRole('region', { name: '按机器人' });
    expect(within(byBot).getByText('值班 Bot')).toBeTruthy();
    expect(within(byBot).getByText(/\$3\.00（含估算 \$0\.20）/)).toBeTruthy();
    expect(await within(screen.getByRole('region', { name: '按群' })).findByText('研发群 · 值班 Bot')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '按触发人' })).getByText('ou_1')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '按来源' })).getByText('主动介入')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '月度成本上限' })).getByText('本月 $3.00 / 上限 $4.00（75%）')).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: '近 7 天' }));
    expect(within(screen.getByRole('region', { name: '按机器人' })).getByText(/\$1\.20（含估算 \$0\.20）/)).toBeTruthy();
  });

  it('saves and deletes caps, then refreshes the summary', async () => {
    const read = vi.spyOn(api, 'usageSummary').mockResolvedValue(summary);
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    const save = vi.spyOn(api, 'setUsageCap').mockResolvedValue({ scope: 'bot', appId: 'cli_a', monthlyCostUsd: 20, updatedAt: '2026-09-25T00:00:00Z' });
    const remove = vi.spyOn(api, 'deleteUsageCap').mockResolvedValue({ deleted: true });
    const user = userEvent.setup();
    mount();
    const caps = await screen.findByRole('region', { name: '月度成本上限' });
    const submit = within(caps).getByRole('button', { name: '保存上限' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(within(caps).getByLabelText('每月上限（美元）'), '20');
    await user.click(submit);
    expect(save).toHaveBeenCalledWith({ scope: 'bot', appId: 'cli_a', monthlyCostUsd: 20 });
    await user.click(within(caps).getByRole('button', { name: '删除' }));
    expect(remove.mock.calls[0]![0]).toMatchObject({ scope: 'group', appId: 'cli_a', chatId: 'oc_1' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  });

  it('explains when only the installation owner may read usage', async () => {
    vi.spyOn(api, 'usageSummary').mockRejectedValue(new ApiError('安装管理员授权后才能查看用量汇总和设置上限', 'USAGE_OWNER_REQUIRED', 403));
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    mount();
    expect(await screen.findByText(/安装管理员授权后才能查看用量汇总和设置上限/)).toBeTruthy();
  });
});
