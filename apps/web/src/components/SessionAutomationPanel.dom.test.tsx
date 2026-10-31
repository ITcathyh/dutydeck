import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicCiProvider, PublicCiSubscription, PublicSessionSchedule, PublicSessionScheduleOccurrence } from '@dutydeck/shared';
import { api, ApiError, type Session } from '../api';
import { setInstance } from '../instance';
import { SessionAutomationPanel, scheduleRule } from './SessionAutomationPanel';

const session: Session = { id: 's1', agentId: 'a', cwd: '/project/worktree', state: 'completed', runId: 'r', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
const schedule: PublicSessionSchedule = { schemaVersion: 1, id: 'plan1', revision: 3, generation: 1, sessionId: session.id, name: '巡检', prompt: '检查构建', trigger: { kind: 'cron', expression: '*/17 3-9 * 2,7 1-5' }, timezone: 'America/New_York', dstPolicy: { gap: 'shift_forward', overlap: 'second' }, condition: { kind: 'always' }, enabled: false, createdAt: session.createdAt, updatedAt: session.updatedAt };
const clients: QueryClient[] = [];
afterEach(() => { setInstance(undefined); cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.restoreAllMocks(); });
const testCi: PublicCiProvider = { id: 'test-ci', displayName: 'Test CI', polling: true, webhook: false };
function mount(schedules: PublicSessionSchedule[] = [], providers: PublicCiProvider[] = [testCi], subscriptions: PublicCiSubscription[] = [], currentSession = session) {
  const read = vi.spyOn(api, 'automation').mockResolvedValue({ schedules, subscriptions, occurrences: [], deliveryTargets: Object.fromEntries(schedules.map(item => [item.id, { kind: 'task' as const, sessionId: session.id }])) });
  vi.spyOn(api, 'automationHistory').mockImplementation(async (_sessionId, scheduleId, offset = 0, limit = 20) => {
    const data = await read.mock.results.at(-1)?.value;
    const occurrences = (data?.occurrences ?? []).filter((item: PublicSessionScheduleOccurrence) => item.scheduleId === scheduleId).slice().reverse();
    return { occurrences: occurrences.slice(offset, offset + limit), total: occurrences.length, offset, limit };
  });
  vi.spyOn(api, 'ciProviders').mockResolvedValue({ providers });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><SessionAutomationPanel session={currentSession}/></QueryClientProvider>);
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
    await user.click(screen.getByText('此计划的运行历史'));
    await screen.findByRole('link', { name: /查看本次运行/ });
    expect(screen.getByRole('link', { name: /查看本次运行/ }).getAttribute('href')).toBe('/?nav=automation&automationSession=s1&schedule=plan1&run=o1');
    await user.click(screen.getByRole('button', { name: '立即执行' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    expect(run.mock.calls[2]![2].idempotencyKey).not.toBe(run.mock.calls[1]![2].idempotencyKey);
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText('巡检 · 已停用')).toBeTruthy();
  });

  it('runs immediately on a plain HTTP LAN page without crypto.randomUUID and keeps the key for a retry', async () => {
    const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      mount([schedule]);
      const run = vi.spyOn(api, 'runSchedule').mockRejectedValueOnce(new Error('网络断开')).mockResolvedValue({ occurrence: {} as PublicSessionScheduleOccurrence });
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: '立即执行' }));
      await screen.findByText('网络断开');
      expect(screen.queryByText(/randomUUID/)).toBeNull();
      await user.click(screen.getByRole('button', { name: '立即执行' }));
      await screen.findByText('已提交立即执行，可在最近触发记录中查看结果；原计划时间保持不变。');
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[0]![2]).toEqual({ expectedRevision: 3, idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
      expect(run.mock.calls[1]![2]).toEqual(run.mock.calls[0]![2]);
    } finally {
      if (original) Object.defineProperty(crypto, 'randomUUID', original); else delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
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
    await clients[0]!.invalidateQueries({ queryKey: ['automation', 'bot-1', session.id] });
    await userEvent.click(await screen.findByText('此计划的运行历史'));
    await screen.findAllByRole('link', { name: /查看本次运行/ });
    const links = screen.getAllByRole('link', { name: /查看本次运行/ });
    expect(links).toHaveLength(20);
    expect(links[0]!.getAttribute('href')).toContain('run=o24');
    expect(links[19]!.getAttribute('href')).toContain('run=o5');
    expect(links[0]!.getAttribute('href')).toBe('/instances/bot-1/?nav=automation&automationSession=s1&schedule=plan1&run=o24');
    expect(links.some(link => link.getAttribute('href')?.endsWith('run=o0'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '较早记录' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: /查看本次运行/ })).toHaveLength(5));
    expect(screen.getAllByRole('link', { name: /查看本次运行/ })[4]!.getAttribute('href')).toContain('run=o0');
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
    await user.click(screen.getByText('历史计划 plan1 的运行记录（UTC）'));
    await screen.findByRole('link', { name: /查看本次运行/ });
    expect(screen.getByText(/执行失败/)).toBeTruthy();
    expect(screen.getByText('执行退出')).toBeTruthy();
    expect(screen.getByRole('link', { name: /查看本次运行/ })).toBeTruthy();
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
    await waitFor(() => expect(update).toHaveBeenCalledWith('s1', 'plan1', { expectedRevision: 3, name: '巡检修改' }));
  });

  it('rereads enable and disable state and formats next execution in the plan timezone', async () => {
    const read = mount([schedule]);
    const update = vi.spyOn(api, 'updateSchedule').mockResolvedValue({ schedule });
    const enabled = { ...schedule, enabled: true, revision: 4, nextDueAt: '2026-09-13T13:00:00Z' };
    const user = userEvent.setup();
    await screen.findByText('巡检 · 已停用');
    read.mockResolvedValue({ schedules: [enabled], subscriptions: [], occurrences: [] });
    await user.click(screen.getByRole('button', { name: '启用' }));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: '确认启用计划' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认启用' }));
    await screen.findByText('巡检 · 已启用');
    expect(await screen.findByText('原定执行（已逾期，等待处理）：2026/9/13 09:00:00 · America/New_York')).toBeTruthy();
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
    await clients[0]!.invalidateQueries({ queryKey: ['automation', null, session.id] });
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

describe('automation enable confirmation', () => {
  it('shows exact frozen Lark destination and the full instruction before enabling', async () => {
    const read = mount([schedule]);
    const update = vi.spyOn(api, 'updateSchedule').mockResolvedValue({ schedule });
    await screen.findByText('巡检 · 已停用');
    read.mockResolvedValue({ schedules: [schedule], subscriptions: [], occurrences: [], deliveryTargets: { plan1: { kind: 'lark', appId: 'cli_saved', chatId: 'oc_saved', replyMessageId: 'om_saved_topic', replyInThread: true } } });
    await clients[0]!.invalidateQueries({ queryKey: ['automation', null, session.id] });
    await userEvent.click(screen.getByRole('button', { name: '启用' }));
    const dialog = screen.getByRole('alertdialog', { name: '确认启用计划' });
    expect(dialog.textContent).toContain('检查构建');
    expect(dialog.textContent).toContain('*/17 3-9 * 2,7 1-5');
    expect(dialog.textContent).toContain('America/New_York');
    expect(dialog.textContent).toContain('oc_saved');
    expect(dialog.textContent).toContain('话题内回复 om_saved_topic');
    expect(dialog.textContent).toContain('cli_saved');
    expect(update).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '暂不启用' }));
    expect(update).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '启用' }));
    await userEvent.click(screen.getByRole('button', { name: '确认启用' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('s1', 'plan1', { expectedRevision: 3, enabled: true }));
  });

  it('keeps old-instance plans readable but blocks enabling without a verified destination', async () => {
    const read = mount([schedule]);
    const update = vi.spyOn(api, 'updateSchedule');
    await screen.findByText('巡检 · 已停用');
    read.mockResolvedValue({ schedules: [schedule], subscriptions: [], occurrences: [] });
    await clients[0]!.invalidateQueries({ queryKey: ['automation', null, session.id] });
    await userEvent.click(screen.getByRole('button', { name: '启用' }));
    expect((screen.getByRole('button', { name: '确认启用' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alertdialog').textContent).toContain('未能核实保存的投递位置');
    expect(update).not.toHaveBeenCalled();
  });

  it('translates ordinary calendar rules while preserving advanced Cron expressions', () => {
    expect(scheduleRule({ ...schedule, trigger: { kind: 'cron', expression: '30 18 * * 1-5' } })).toBe('每个工作日 18:30 · America/New_York');
    expect(scheduleRule(schedule)).toContain('Cron */17 3-9 * 2,7 1-5');
  });
});

describe('schedule management and execution policy', () => {
  it.each(['stopped', 'failed', 'archived'])('retains safe disable and delete controls for %s source tasks', async state => {
    const inactive = { ...session, state: state === 'archived' ? 'completed' : state, ...(state === 'archived' ? { archivedAt: session.updatedAt } : {}) };
    mount([{ ...schedule, enabled: true, disabledReason: '来源任务已结束', disableNotification: { status: 'unknown', attempts: 1, updatedAt: session.updatedAt } }], [testCi], [], inactive);
    const update = vi.spyOn(api, 'updateSchedule').mockResolvedValue({ schedule });
    await screen.findByText('巡检 · 已启用');
    expect(screen.queryByRole('button', { name: '立即执行' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
    expect(screen.getByText(/发送结果未知，等待核对/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '停用' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('s1', 'plan1', { expectedRevision: 3, enabled: false }));
  });

  it('sends explicit independent mode and bounded coalescing without enabling on save', async () => {
    mount();
    const create = vi.spyOn(api, 'createSchedule').mockResolvedValue({ schedule });
    const user = await fill('daily');
    await user.selectOptions(screen.getByLabelText('运行模式'), 'independent');
    await user.type(screen.getByLabelText('补跑有效期（分钟，可选）'), '30');
    expect(screen.getByText(/资源协调仅覆盖当前实例数据库/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('s1', expect.objectContaining({ mode: 'independent', misfirePolicy: 'coalesce', maxLatenessSeconds: 1800 })));
    expect(create.mock.calls[0]![1]).not.toHaveProperty('enabled');
  });

  it('creates a fresh-session schedule and switches an existing plan between session and fresh', async () => {
    mount([schedule]);
    const create = vi.spyOn(api, 'createSchedule').mockResolvedValue({ schedule });
    const update = vi.spyOn(api, 'updateSchedule').mockResolvedValue({ schedule });
    const user = await fill('daily');
    await user.selectOptions(screen.getByLabelText('运行模式'), 'fresh');
    expect(screen.getByText(/不带聊天历史，适合固定的更新、部署、巡检/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('s1', expect.objectContaining({ mode: 'fresh' })));
    await user.click(await screen.findByRole('button', { name: '编辑' }));
    const select = screen.getByLabelText('运行模式') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect([...select.options].map(option => option.value)).toEqual(['session', 'fresh']);
    await user.selectOptions(select, 'fresh');
    await user.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('s1', 'plan1', { expectedRevision: 3, mode: 'fresh' }));
  });

  it('keeps independent schedules manageable and executable after the source task stops', async () => {
    mount([{ ...schedule, mode: 'independent', executionContext: { cwd: '/managed/plan', agentId: 'frozen-agent', contextMode: 'prompt_only' } }], [testCi], [], { ...session, state: 'stopped' });
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    expect((screen.getByLabelText('运行模式') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(/目录 \/managed\/plan/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即执行' })).toBeTruthy();
  });

  it('sends only the changed execution field and preserves the default policy on existing plans', async () => {
    mount([schedule]);
    const update = vi.spyOn(api, 'updateSchedule').mockResolvedValue({ schedule });
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await userEvent.type(screen.getByLabelText('执行指令'), '新的要求');
    await userEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('s1', 'plan1', { expectedRevision: 3, prompt: '检查构建新的要求' }));
  });
});
