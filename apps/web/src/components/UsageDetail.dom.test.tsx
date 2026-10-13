import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usageUnknownModel, type UsageGroup, type UsageReport, type UsageTaskRow, type UsageTotals } from '@dutydeck/shared';
import { api, type LarkBotConfig, type UsageSummary } from '../api';
import { UsageOverview } from './UsageOverview';

const totals = (patch: Partial<UsageTotals> = {}): UsageTotals => ({ entries: 0, costUsd: 0, estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unavailable: 0, unpriced: 0, pricedEntries: 0, unknownCostEntries: 0, costCoverage: null, ...patch });
const group = (patch: Partial<UsageGroup>): UsageGroup => ({ ...totals({ entries: 1, costUsd: 1, pricedEntries: 1, costCoverage: 1 }), ...patch });
const bots = [{ configured: true, appId: 'cli_a', name: '值班 Bot', tabLabel: '值班 Bot', setupComplete: true }] as LarkBotConfig[];

// 三天范围：09-23 有已知费用，09-24 没有记录，09-25 只有未知费用（一次未定价 + 一次无用量）。
const report: UsageReport = {
  timezone: { name: 'Asia/Shanghai', offsetMinutes: 480 },
  range: { from: '2026-09-23', to: '2026-09-25', since: '2026-09-22T16:00:00.000Z', until: '2026-09-25T16:00:00.000Z' },
  filter: {},
  totals: totals({ entries: 3, costUsd: 4, pricedEntries: 1, unpriced: 1, unavailable: 1, unknownCostEntries: 2, costCoverage: 1 / 3, inputTokens: 1010 }),
  daily: [group({ day: '2026-09-23', costUsd: 4 }), group({ day: '2026-09-25', entries: 2, costUsd: 0, pricedEntries: 0, unpriced: 1, unavailable: 1, unknownCostEntries: 2, costCoverage: 0 })],
  models: [group({ model: 'claude-opus-5-5', costUsd: 4 }), group({ model: 'gemini-3.8-flash', costUsd: 0, pricedEntries: 0, unpriced: 1, unknownCostEntries: 1, costCoverage: 0 }), group({ costUsd: 0, pricedEntries: 0, unavailable: 1, unknownCostEntries: 1, costCoverage: 0 })],
  agents: [group({ agentId: 'claude-pty', entries: 3, costUsd: 4 })], bots: [group({ appId: 'cli_a', entries: 3, costUsd: 4 })], origins: [group({ origin: 'lark_group', entries: 3, costUsd: 4 })],
  options: { models: ['claude-opus-5-5', 'gemini-3.8-flash', null], agentIds: ['claude-pty'], appIds: ['cli_a'], origins: ['lark_group'] }
};
const task = (patch: Partial<UsageTaskRow>): UsageTaskRow => ({ ...totals({ entries: 1, costUsd: 4, pricedEntries: 1, costCoverage: 1 }), taskId: 'task_1', sessionId: 'ses_1', appId: 'cli_a', agentId: 'claude-pty', origin: 'lark_group', models: ['claude-opus-5-5'], firstRecordedAt: '2026-09-23T02:00:00.000Z', lastRecordedAt: '2026-09-23T02:00:00.000Z', subStepEntries: 0, ...patch });
const summary: UsageSummary = { backgroundBudget: { month: '2026-09', usage: [] }, caps: [{ scope: 'bot', appId: 'cli_a', monthlyCostUsd: 10, updatedAt: '2026-09-25T00:00:00Z' }],
  month: { since: '2026-08-31T16:00:00.000Z', totals: totals({ entries: 3, costUsd: 4, unknownCostEntries: 2, unpriced: 1, unavailable: 1 }), bots: [], chats: [], actors: [], categories: [] },
  week: { since: '2026-09-18T00:00:00.000Z', totals: totals(), bots: [], chats: [], actors: [], categories: [] } };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenTask = vi.fn();
  render(<QueryClientProvider client={client}><UsageOverview bots={bots} onOpenTask={onOpenTask}/></QueryClientProvider>);
  return { onOpenTask };
}
const openDetail = async () => { await userEvent.setup().click(await screen.findByRole('tab', { name: '明细' })); };

describe('usage detail tab', () => {
  it('states the daemon time zone, trends by day and shows unknown and unpriced usage apart from zero', async () => {
    vi.spyOn(api, 'usageSummary').mockResolvedValue(summary);
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'usageReport').mockResolvedValue(report);
    vi.spyOn(api, 'usageTasks').mockResolvedValue({ total: 1, tasks: [task({})] });
    mount();
    await openDetail();
    expect(await screen.findByText(/Asia\/Shanghai（UTC\+08:00），与浏览器时区无关/)).toBeTruthy();
    const trend = screen.getByRole('region', { name: '日趋势' });
    const days = within(trend).getAllByRole('listitem').map(item => item.textContent);
    expect(days).toEqual([expect.stringContaining('2026-09-23$4.00'), expect.stringContaining('2026-09-24无记录'), expect.stringContaining('2026-09-25费用未知')]);
    expect(trend.textContent).not.toContain('$0.00');
    const models = screen.getByRole('region', { name: '按型号' });
    expect(within(models).getByText('gemini-3.8-flash').parentElement?.textContent).toContain('未定价');
    expect(within(models).getByText('未记录型号')).toBeTruthy();
    expect(within(models).getByText('claude-opus-5-5').parentElement?.textContent).not.toContain('未定价');
    expect(screen.getByText(/部分用量未知：2 次任务的费用算不出来（1 次缺单价、1 次无用量数据）.*不等于 0.*上限只按已知费用判断，可能不准/)).toBeTruthy();
  });

  it('re-queries with the chosen range and filters, offers unknown model as its own option, and resets paging', async () => {
    vi.spyOn(api, 'usageSummary').mockResolvedValue(summary);
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    const read = vi.spyOn(api, 'usageReport').mockResolvedValue(report);
    const tasks = vi.spyOn(api, 'usageTasks').mockResolvedValue({ total: 45, tasks: [task({})] });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: '明细' }));
    const form = await screen.findByRole('form', { name: '明细筛选' });
    expect((within(form).getByLabelText('开始日期') as HTMLInputElement).value).toBe('2026-09-23');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(tasks).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, offset: 20 })));
    await user.selectOptions(within(form).getByLabelText('型号'), usageUnknownModel);
    await waitFor(() => expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ model: usageUnknownModel })));
    await waitFor(() => expect(tasks).toHaveBeenLastCalledWith(expect.objectContaining({ model: usageUnknownModel, offset: 0 })));
    expect(within(form).getByRole('option', { name: '未记录型号' })).toBeTruthy();
    await user.selectOptions(within(form).getByLabelText('Agent'), 'claude-pty');
    await user.selectOptions(within(form).getByLabelText('来源'), 'lark_group');
    await user.selectOptions(within(form).getByLabelText('机器人'), 'cli_a');
    await waitFor(() => expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ model: usageUnknownModel, agentId: 'claude-pty', origin: 'lark_group', appId: 'cli_a' })));
    fireEvent.change(within(form).getByLabelText('结束日期'), { target: { value: '2026-09-24' } });
    await waitFor(() => expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ to: '2026-09-24' })));
  });

  it('lists the tasks behind the range, merges sub-steps into the root task and jumps to the task detail session', async () => {
    vi.spyOn(api, 'usageSummary').mockResolvedValue(summary);
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'usageReport').mockResolvedValue(report);
    vi.spyOn(api, 'usageTasks').mockResolvedValue({ total: 2, tasks: [
      task({ taskId: 'task_1', sessionId: 'ses_root', entries: 2, subStepEntries: 1, models: ['claude-opus-5-5', 'gpt-5-codex'] }),
      task({ taskId: 'task_2', sessionId: 'ses_2', costUsd: 0, pricedEntries: 0, unavailable: 1, unknownCostEntries: 1, costCoverage: 0, models: [] })] });
    const { onOpenTask } = mount();
    await openDetail();
    const list = await screen.findByRole('region', { name: '任务明细' });
    expect(within(list).getByText(/共 2 个根任务，编排子步骤已并入发起它的任务/)).toBeTruthy();
    expect(within(list).getByText(/含 1 条子步骤记录/)).toBeTruthy();
    expect(within(list).getByText(/费用未知 · 1 次/)).toBeTruthy();
    expect(within(list).queryByRole('button', { name: '下一页' })).toBeNull();
    await userEvent.setup().click(within(list).getByRole('button', { name: '打开任务 task_1' }));
    expect(onOpenTask).toHaveBeenCalledWith('ses_root');
  });

  it('explains an empty range instead of drawing zeros', async () => {
    vi.spyOn(api, 'usageSummary').mockResolvedValue(summary);
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'usageReport').mockResolvedValue({ ...report, totals: totals(), daily: [], models: [], agents: [], bots: [], origins: [] });
    vi.spyOn(api, 'usageTasks').mockResolvedValue({ total: 0, tasks: [] });
    mount();
    await openDetail();
    expect(await screen.findByText('这个范围内没有用量记录')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '日趋势' })).toBeNull();
  });
});

describe('cost tab cap warning', () => {
  it('warns that caps may be inaccurate when part of this month is unknown, and stays quiet otherwise', async () => {
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    vi.spyOn(api, 'usageSummary').mockResolvedValue(summary);
    mount();
    const caps = await screen.findByRole('region', { name: '月度成本上限' });
    expect(within(caps).getByText(/部分用量未知，上限可能不准：本月有 2 次任务的费用算不出来/)).toBeTruthy();
    cleanup();
    vi.spyOn(api, 'usageSummary').mockResolvedValue({ ...summary, month: { ...summary.month, totals: totals({ entries: 3, costUsd: 4 }) } });
    mount();
    expect(within(await screen.findByRole('region', { name: '月度成本上限' })).queryByText(/部分用量未知/)).toBeNull();
  });
});
