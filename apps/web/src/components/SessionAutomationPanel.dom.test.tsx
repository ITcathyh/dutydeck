import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicSessionSchedule } from '@dutydeck/shared';
import { api, ApiError, type Session } from '../api';
import { SessionAutomationPanel } from './SessionAutomationPanel';

const session: Session = { id: 's1', agentId: 'a', cwd: '/project/worktree', state: 'completed', runId: 'r', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
const schedule: PublicSessionSchedule = { schemaVersion: 1, id: 'plan1', revision: 3, generation: 1, sessionId: session.id, name: '巡检', prompt: '检查构建', trigger: { kind: 'cron', expression: '*/17 3-9 * 2,7 1-5' }, timezone: 'America/New_York', dstPolicy: { gap: 'shift_forward', overlap: 'second' }, condition: { kind: 'always' }, enabled: false, createdAt: session.createdAt, updatedAt: session.updatedAt };
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.restoreAllMocks(); });
function mount(schedules: PublicSessionSchedule[] = []) {
  const read = vi.spyOn(api, 'automation').mockResolvedValue({ schedules, subscriptions: [], occurrences: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><SessionAutomationPanel session={session}/></QueryClientProvider>);
  return read;
}
async function fill(kind: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByText('为此任务创建计划'));
  await user.type(screen.getByLabelText('计划名称'), '日常检查');
  await user.type(screen.getByLabelText('执行指令'), '检查测试结果');
  await user.selectOptions(screen.getByLabelText('触发方式'), kind);
  await user.clear(screen.getByLabelText('时区'));
  await user.type(screen.getByLabelText('时区'), 'Asia/Shanghai');
  return user;
}

describe('session automation schedules', () => {
  it.each([['daily', '35 8 * * *'], ['weekly', '35 8 * * 5']])('creates %s using the selected timezone and existing Cron contract', async (kind, expression) => {
    const read = mount();
    const create = vi.spyOn(api, 'createSchedule').mockResolvedValue({ schedule });
    const user = await fill(kind!);
    fireEvent.change(screen.getByLabelText('执行时间'), { target: { value: '08:35' } });
    if (kind === 'weekly') await user.selectOptions(screen.getByLabelText('星期'), '5');
    await user.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('s1', expect.objectContaining({ timezone: 'Asia/Shanghai', trigger: { kind: 'cron', expression }, dstPolicy: { gap: 'skip', overlap: 'first' } })));
    await screen.findByText('计划已保存，点击「启用」后才会运行。');
    expect(read).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]![1]).not.toHaveProperty('enabled');
  });

  it('saves a one-off local time without applying the browser timezone', async () => {
    mount();
    const create = vi.spyOn(api, 'createSchedule').mockResolvedValue({ schedule });
    const user = await fill('at');
    fireEvent.change(screen.getByLabelText('指定时区的本地时间'), { target: { value: '2026-10-01T11:20' } });
    await user.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('s1', expect.objectContaining({ timezone: 'Asia/Shanghai', trigger: { kind: 'at', localDateTime: '2026-10-01T11:20' } })));
  });

  it.each([schedule, { ...schedule, trigger: { kind: 'interval' as const, everySeconds: 5400, anchorAt: '2026-09-01T04:15:00Z' } }])('preserves old trigger and DST semantics during a name edit ($trigger.kind)', async old => {
    mount([old]);
    const update = vi.spyOn(api, 'updateSchedule').mockResolvedValue({ schedule: old });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '编辑' }));
    if (old.trigger.kind === 'cron') expect((screen.getByLabelText('Cron 表达式') as HTMLInputElement).value).toBe(old.trigger.expression);
    await user.type(screen.getByLabelText('计划名称'), '修改');
    await user.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('s1', 'plan1', expect.objectContaining({ expectedRevision: 3, trigger: old.trigger, timezone: old.timezone, dstPolicy: old.dstPolicy })));
  });

  it('rereads enable and disable state and formats next execution in the plan timezone', async () => {
    const read = mount([schedule]);
    const update = vi.spyOn(api, 'updateSchedule').mockResolvedValue({ schedule });
    const enabled = { ...schedule, enabled: true, revision: 4, nextDueAt: '2026-09-13T13:00:00Z' };
    const user = userEvent.setup();
    await screen.findByText('巡检 · 已停用');
    read.mockResolvedValue({ schedules: [enabled], subscriptions: [], occurrences: [] });
    await user.click(screen.getByRole('button', { name: '启用' }));
    await screen.findByText('巡检 · 已启用');
    expect(await screen.findByText('下一次执行：2026/9/13 09:00:00 · America/New_York')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: '停用' }) as HTMLButtonElement).disabled).toBe(false));
    read.mockResolvedValue({ schedules: [{ ...schedule, revision: 5 }], subscriptions: [], occurrences: [] });
    await user.click(screen.getByRole('button', { name: '停用' }));
    await screen.findByText('未启用，暂无下一次执行');
    expect(update.mock.calls.map(call => call[2])).toEqual([{ expectedRevision: 3, enabled: true }, { expectedRevision: 4, enabled: false }]);
  });

  it('hides cached plans and writes after permission is revoked, then supports retry', async () => {
    const read = mount([schedule]);
    await screen.findByText('巡检 · 已停用');
    read.mockRejectedValue(new ApiError('无权限', 'FORBIDDEN', 403));
    await clients[0]!.invalidateQueries({ queryKey: ['automation', session.id] });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('巡检 · 已停用')).toBeNull();
    expect(screen.queryByText('为此任务创建计划')).toBeNull();
    read.mockResolvedValue({ schedules: [], subscriptions: [], occurrences: [] });
    await userEvent.click(screen.getByRole('button', { name: '重新读取' }));
    await screen.findByText('为此任务创建计划');
  });
});
