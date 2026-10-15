import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicCiProvider, PublicCiSubscription, PublicSessionSchedule, PublicSessionScheduleOccurrence } from '@dutydeck/shared';
import { api, ApiError, type Session } from '../api';
import { setInstance } from '../instance';
import { SessionAutomationPanel } from './SessionAutomationPanel';

const session: Session = { id: 's1', agentId: 'a', cwd: '/project/worktree', state: 'completed', runId: 'r', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
const schedule: PublicSessionSchedule = { schemaVersion: 1, id: 'plan1', revision: 3, generation: 1, sessionId: session.id, name: '巡检', prompt: '检查构建', trigger: { kind: 'cron', expression: '*/17 3-9 * 2,7 1-5' }, timezone: 'America/New_York', dstPolicy: { gap: 'shift_forward', overlap: 'second' }, condition: { kind: 'always' }, enabled: false, createdAt: session.createdAt, updatedAt: session.updatedAt };
const clients: QueryClient[] = [];
afterEach(() => { setInstance(undefined); cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.restoreAllMocks(); });
const testCi: PublicCiProvider = { id: 'test-ci', displayName: 'Test CI', polling: true, webhook: false };
function mount(schedules: PublicSessionSchedule[] = [], providers: PublicCiProvider[] = [testCi], subscriptions: PublicCiSubscription[] = []) {
  const read = vi.spyOn(api, 'automation').mockResolvedValue({ schedules, subscriptions, occurrences: [] });
  vi.spyOn(api, 'ciProviders').mockResolvedValue({ providers });
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
  it('retries immediate execution with the same operation key, then starts a fresh operation after success', async () => {
    const read = mount([schedule]);
    const occurrence: PublicSessionScheduleOccurrence = { schemaVersion: 2, id: 'o1', revision: 1, scheduleId: schedule.id, sessionId: session.id, generation: 1, scheduledForUtc: session.createdAt, conditionStatus: 'passed', runStatus: 'completed', taskId: 't1', delivery: { status: 'not_requested', attempts: 0, updatedAt: session.createdAt }, createdAt: session.createdAt, updatedAt: session.updatedAt };
    const run = vi.spyOn(api, 'runSchedule').mockRejectedValueOnce(new Error('网络断开')).mockResolvedValue({ occurrence });
    const update = vi.spyOn(api, 'updateSchedule');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '立即执行' }));
    await screen.findByText('网络断开');
    read.mockResolvedValue({ schedules: [schedule], subscriptions: [], occurrences: [occurrence] });
    await user.click(screen.getByRole('button', { name: '立即执行' }));
    await screen.findByText('已提交立即执行，可在最近触发记录中查看结果；原计划时间保持不变。');
    expect(run.mock.calls[0]![2]).toEqual(run.mock.calls[1]![2]);
    expect(run.mock.calls[0]![2]).toEqual({ expectedRevision: 3, idempotencyKey: expect.any(String) });
    await user.click(screen.getByText('最近触发记录'));
    expect(screen.getByText(/已完成 · 条件满足/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '查看执行任务 · t1' }).getAttribute('href')).toBe('/sessions/s1');
    await user.click(screen.getByRole('button', { name: '立即执行' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(run.mock.calls[2]![2].idempotencyKey).not.toBe(run.mock.calls[1]![2].idempotencyKey);
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText('巡检 · 已停用')).toBeTruthy();
  });

  it('refreshes a definitive revision conflict before a fresh immediate-execution request', async () => {
    const read = mount([schedule]);
    const run = vi.spyOn(api, 'runSchedule').mockRejectedValueOnce(new ApiError('计划已更新，请重试', 'CONFLICT', 409)).mockResolvedValue({ occurrence: {} as PublicSessionScheduleOccurrence });
    const user = userEvent.setup();
    await screen.findByRole('button', { name: '立即执行' });
    read.mockResolvedValue({ schedules: [{ ...schedule, revision: 4 }], subscriptions: [], occurrences: [] });
    await user.click(screen.getByRole('button', { name: '立即执行' }));
    await screen.findByText('计划已更新，请重试');
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: '立即执行' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]![2].expectedRevision).toBe(4);
    expect(run.mock.calls[1]![2].idempotencyKey).not.toBe(run.mock.calls[0]![2].idempotencyKey);
  });

  it('shows the newest twenty executions first and keeps result links in the owning instance', async () => {
    setInstance('bot-1');
    const read = mount([schedule]);
    await screen.findByText('巡检 · 已停用');
    const occurrences = Array.from({ length: 25 }, (_, index): PublicSessionScheduleOccurrence => ({ schemaVersion: 2, id: `o${index}`, revision: 1, scheduleId: schedule.id, sessionId: session.id, generation: 1, scheduledForUtc: session.createdAt, conditionStatus: 'passed', runStatus: 'completed', taskId: `t${index}`, delivery: { status: 'not_requested', attempts: 0, updatedAt: session.createdAt }, createdAt: session.createdAt, updatedAt: session.updatedAt }));
    read.mockResolvedValue({ schedules: [schedule], subscriptions: [], occurrences });
    await clients[0]!.invalidateQueries({ queryKey: ['automation', session.id] });
    await userEvent.click(await screen.findByText('最近触发记录'));
    const links = screen.getAllByRole('link', { name: /查看执行任务/ });
    expect(links).toHaveLength(20);
    expect(links[0]!.textContent).toBe('查看执行任务 · t24');
    expect(links[19]!.textContent).toBe('查看执行任务 · t5');
    expect(links[0]!.getAttribute('href')).toBe('/instances/bot-1/sessions/s1');
    expect(screen.queryByRole('link', { name: '查看执行任务 · t0' })).toBeNull();
  });

  it('confirms deletion, retains execution history, and reports delete failures for retry', async () => {
    const read = mount([schedule]);
    const occurrence: PublicSessionScheduleOccurrence = { schemaVersion: 2, id: 'o1', revision: 1, scheduleId: schedule.id, sessionId: session.id, generation: 1, scheduledForUtc: session.createdAt, conditionStatus: 'passed', runStatus: 'failed', taskId: 't1', error: '执行退出', delivery: { status: 'not_requested', attempts: 0, updatedAt: session.createdAt }, createdAt: session.createdAt, updatedAt: session.updatedAt };
    const remove = vi.spyOn(api, 'deleteSchedule').mockRejectedValueOnce(new ApiError('删除失败', 'CONFLICT', 409)).mockResolvedValue({ schedule });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '删除' }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: '删除定时计划' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '删除' }));
    read.mockResolvedValue({ schedules: [{ ...schedule, revision: 4 }], subscriptions: [], occurrences: [] });
    await user.click(screen.getByRole('button', { name: '删除计划' }));
    await screen.findByText('删除失败');
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    read.mockResolvedValue({ schedules: [], subscriptions: [], occurrences: [occurrence] });
    await user.click(screen.getByRole('button', { name: '删除计划' }));
    await screen.findByText('计划已删除，触发记录已保留；正在运行的任务会继续。');
    expect(remove).toHaveBeenLastCalledWith('s1', 'plan1', 4);
    expect(screen.queryByRole('button', { name: '立即执行' })).toBeNull();
    await user.click(screen.getByText('最近触发记录'));
    expect(screen.getByText(/历史计划 plan1.*执行失败/)).toBeTruthy();
    expect(screen.getByText('执行退出')).toBeTruthy();
    expect(screen.getByRole('link', { name: '查看执行任务 · t1' })).toBeTruthy();
  });

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

  it('展示所属任务时优先展示 session.name，无 name 时使用 taskTitle，最后使用 fallback', () => {
    vi.spyOn(api, 'automation').mockResolvedValue({ schedules: [], subscriptions: [], occurrences: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);

    const { rerender } = render(
      <QueryClientProvider client={client}>
        <SessionAutomationPanel session={{ ...session, name: '自动化巡检总控' }} taskTitle="原始任务指令"/>
      </QueryClientProvider>
    );
    expect(screen.getByText(/所属任务：自动化巡检总控/)).toBeTruthy();

    rerender(
      <QueryClientProvider client={client}>
        <SessionAutomationPanel session={session} taskTitle="原始任务指令"/>
      </QueryClientProvider>
    );
    expect(screen.getByText(/所属任务：原始任务指令/)).toBeTruthy();

    rerender(
      <QueryClientProvider client={client}>
        <SessionAutomationPanel session={session}/>
      </QueryClientProvider>
    );
    expect(screen.getByText(/所属任务：a · \/project\/worktree/)).toBeTruthy();
  });
});

describe('session automation CI providers', () => {
  it('没有安装 CI 插件时提示「未安装 CI 插件」，不能发起等待，也不能选 CI 条件', async () => {
    mount([], []);
    const subscribe = vi.spyOn(api, 'subscribeCi');
    const user = userEvent.setup();
    await user.click(await screen.findByText('等待 CI 完成'));
    expect(await screen.findByText(/^未安装 CI 插件。/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '开始等待' })).toBeNull();
    await user.click(screen.getByText('为此任务创建计划'));
    const option = screen.getByRole('option', { name: 'CI 出现新的失败构建时执行（未安装 CI 插件）' }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('等待记录和提示用插件给的名字，CI 条件按 ci_new_failure 保存', async () => {
    const waiting = { schemaVersion: 2, id: 'ci_1', revision: 1, sessionId: 's1', provider: 'test-ci', repository: { owner: 'octo', name: 'repo', slug: 'octo/repo' }, headSha: 'a'.repeat(40), prompt: 'p', status: 'waiting', expiresAt: '2026-09-13T00:00:00Z', delivery: { status: 'not_requested', attempts: 0, updatedAt: session.createdAt }, createdAt: session.createdAt, updatedAt: session.updatedAt } as unknown as PublicCiSubscription;
    mount([], [testCi], [waiting]);
    expect(await screen.findByText(/Test CI · octo\/repo · aaaaaaaaaaaa/)).toBeTruthy();
    const subscribe = vi.spyOn(api, 'subscribeCi').mockResolvedValue({ subscription: { ...waiting, id: 'ci_2' } as never });
    const user = userEvent.setup();
    await user.click(screen.getByText('等待 CI 完成'));
    expect(screen.getByText('由 Test CI 查询构建结果。')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '开始等待' }));
    await waitFor(() => expect(subscribe).toHaveBeenCalledWith('s1', { ttlSeconds: 86400 }));
    expect(await screen.findByText('已开始等待当前提交的 Test CI；续作开始前可取消等待。')).toBeTruthy();
    const create = vi.spyOn(api, 'createSchedule').mockResolvedValue({ schedule });
    await fill('at');
    fireEvent.change(screen.getByLabelText('指定时区的本地时间'), { target: { value: '2026-10-01T11:20' } });
    await user.selectOptions(screen.getByLabelText('执行条件'), 'ci_new_failure');
    await user.type(screen.getByLabelText('检查的工作流（可选）'), 'ci.yml');
    await user.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('s1', expect.objectContaining({ condition: { kind: 'ci_new_failure', workflow: 'ci.yml' } })));
  });
});
