import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicSessionSchedule, AutomationScheduleSummary, AutomationSchedulePage } from '@dutydeck/shared';
import { api, ApiError, type Agent, type RunSummary, type Session } from '../api';
import { AutomationOverview } from './AutomationOverview';
import { EXPERIMENTAL_STORAGE_KEY } from '../experimental';

const session: Session = { id: 's1', agentId: 'claude', cwd: '/project/worktree', state: 'completed', runId: 'r', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
const schedule: PublicSessionSchedule = { schemaVersion: 1, id: 'plan1', revision: 3, generation: 1, sessionId: session.id, name: '巡检', prompt: '检查构建', trigger: { kind: 'cron', expression: '0 9 * * *' }, timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }, enabled: false, createdAt: session.createdAt, updatedAt: session.updatedAt };
const item: AutomationScheduleSummary = { engine: 'session', schedule, session: { id: session.id, title: '巡检所属任务', agentId: session.agentId, state: session.state }, health: 'disabled' };
const pageData: AutomationSchedulePage = { engine: 'session', items: [item], offset: 0, limit: 20, total: 1, counts: { blocked: 7, queued: 2, running: 0, delivery: 0, disabled: 1, ready: 0, error: 0 } };
beforeEach(() => {
  vi.spyOn(api, 'instances').mockResolvedValue({ instances: [] });
  vi.spyOn(api, 'automationSchedules').mockResolvedValue(pageData);
});
const empty = { schedules: [], subscriptions: [], occurrences: [] };
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); window.localStorage.removeItem(EXPERIMENTAL_STORAGE_KEY); clients.forEach(client => client.clear()); clients.length = 0; vi.restoreAllMocks(); vi.useRealTimers(); });
function mount(sessions = [session], summaries: Record<string, RunSummary> = {}, agents: Agent[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const onSelectSession = vi.fn();
  const rendered = render(<QueryClientProvider client={client}><AutomationOverview agents={agents} sessions={sessions} summaries={summaries} onSelectSession={onSelectSession}/></QueryClientProvider>);
  return Object.assign(onSelectSession, rendered, { client });
}

async function advancePolling(ms = 10_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
  });
}

describe('automation overview', () => {
  it('creates an idle session from an empty overview and opens schedule setup without sending a prompt', async () => {
    vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
    vi.spyOn(api, 'automation').mockResolvedValue(empty);
    vi.spyOn(api, 'ciProviders').mockResolvedValue({ providers: [] });
    const create = vi.spyOn(api, 'create').mockRejectedValueOnce(new Error('创建失败')).mockResolvedValueOnce({ ...session, state: 'idle' });
    const send = vi.spyOn(api, 'send');
    const save = vi.spyOn(api, 'createSchedule').mockRejectedValueOnce(new Error('计划保存失败')).mockResolvedValueOnce({ schedule });
    const update = vi.spyOn(api, 'updateSchedule');
    const view = mount([], {}, [{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'ask' }]);
    const invalidate = vi.spyOn(view.client, 'invalidateQueries');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '创建定时任务' }));
    expect(screen.queryByLabelText('任务目标')).toBeNull();
    await user.click(screen.getByRole('button', { name: '下一步：设置计划' }));
    expect(await screen.findByText('创建失败')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '下一步：设置计划' }));
    await user.type(await screen.findByLabelText('计划名称'), '巡检');
    await user.type(screen.getByLabelText('执行指令'), '检查构建');
    fireEvent.change(screen.getByLabelText('指定时区的本地时间'), { target: { value: '2027-10-01T11:20' } });
    await user.click(screen.getByRole('button', { name: '保存计划' }));
    expect(await screen.findByText('计划保存失败')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存计划' }));
    await screen.findByText('计划已保存，点击「启用」后才会运行。');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith({ agentId: 'codex', permissionMode: 'ask', workspaceMode: 'worktree' });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]![0]).toBe('s1');
    expect(save.mock.calls[0]![1]).not.toHaveProperty('enabled');
    expect(send).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] });
  });


  it('queries plans directly, preserves complete authorized counts across pagination, and keeps CI accessible', async () => {
    const read = vi.spyOn(api, 'automationSchedules').mockImplementation(async params => ({
      ...pageData, total: 25, offset: Number(params.get('offset')), items: [{ ...item, schedule: { ...schedule, name: params.get('offset') === '20' ? 'older plan' : 'current plan' } }]
    }));
    const legacyRead = vi.spyOn(api, 'automation');
    mount(Array.from({ length: 41 }, (_, index) => ({ ...session, id: `s${index}` })));
    await screen.findByText('current plan · 已停用');
    expect(legacyRead).not.toHaveBeenCalled();
    expect(screen.getByText(/按异常优先显示定时任务，仅汇总已配置且有权访问的实例/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '群聊管理' }).getAttribute('href')).toBe('/?nav=groups');
    expect(screen.getByText(/^已读取实例的全部计划（不随筛选变化）/)).toBeTruthy();
    expect(screen.getByText(/等待人工核对 7/)).toBeTruthy();
    expect(screen.getByText('现有任务的 CI 等待与自动化')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('older plan · 已停用');
    expect(screen.getByText(/等待人工核对 7/)).toBeTruthy();
    expect(read.mock.calls.at(-1)![0].get('offset')).toBe('20');
    expect(read.mock.calls.at(-1)![0].get('sort')).toBe('attention');
  });

  it('shows partial coverage for offline, forbidden and unsupported instances instead of zero', async () => {
    vi.spyOn(api, 'instances').mockResolvedValue({ instances: [{ id: 'offline', name: '断开实例' }, { id: 'denied', name: '受限实例' }, { id: 'old', name: '旧版实例' }] });
    vi.spyOn(api, 'automationSchedules').mockImplementation(async (_params, instance) => {
      if (instance === 'offline') throw new Error('network down');
      if (instance === 'denied') throw new ApiError('denied', 'FORBIDDEN', 403);
      if (instance === 'old') throw new ApiError('old', 'NOT_FOUND', 404);
      return pageData;
    });
    mount();
    await screen.findByText('巡检 · 已停用');
    await screen.findByText(/无权限（forbidden）/);
    expect(screen.getByText(/未连通（unavailable）/)).toBeTruthy();
    expect(screen.getByText(/版本不支持（unsupported）/)).toBeTruthy();
    expect(screen.getByText(/^覆盖：/).textContent).toContain('partial');
    expect(screen.getByText(/^覆盖：/).textContent).toContain('失败范围不是零计划');
  });

  it('uses separate instance caches for identical plan ids and sends filters to each server', async () => {
    vi.spyOn(api, 'instances').mockResolvedValue({ instances: [{ id: 'bot', name: '机器人实例' }] });
    const read = vi.spyOn(api, 'automationSchedules').mockImplementation(async (_params, instance) => ({ ...pageData, items: [{ ...item, schedule: { ...schedule, name: instance === 'bot' ? '机器人计划' : '主计划' } }] }));
    const view = mount();
    await screen.findByText('主计划 · 已停用');
    await screen.findByText('机器人计划 · 已停用');
    expect(view.client.getQueryCache().findAll({ queryKey: ['automation-schedules'] })).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('计划名称'), { target: { value: 'report' } });
    fireEvent.change(screen.getByLabelText('启用状态'), { target: { value: 'true' } });
    fireEvent.change(screen.getByLabelText('健康状态'), { target: { value: 'blocked' } });
    await waitFor(() => expect(read.mock.calls.some(([params, instance]) => instance === 'bot' && params.get('name') === 'report' && params.get('enabled') === 'true' && params.get('health') === 'blocked')).toBe(true));
  });

  it('explains overdue unknown blockers and links to the exact recovery task', async () => {
    vi.spyOn(api, 'automationSchedules').mockResolvedValue({ ...pageData, items: [{ ...item, health: 'blocked', schedule: { ...schedule, enabled: true, nextDueAt: '2026-10-23T00:00:00Z' }, blocker: { sessionId: 's1', taskId: 'unknown1', attemptId: 'attempt1', status: 'reconcile_required', waitingSince: '2026-10-22T00:00:00Z' }, overdue: { from: '2026-10-23T00:00:00Z', to: '2026-10-26T00:00:00Z' } }] });
    mount();
    await screen.findByText(/原执行结果未知/);
    expect(screen.getByText(/原定执行（已逾期，等待处理）/)).toBeTruthy();
    expect(screen.getByText(/并非这些时点已经执行失败/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '查看阻塞证据并核对' }).getAttribute('href')).toBe('/sessions/s1?reconcileTask=unknown1#unknown-task-unknown1');
  });

  it('does not invent a recovery link or expose identifiers for a restricted resource blocker', async () => {
    vi.spyOn(api, 'automationSchedules').mockResolvedValue({ ...pageData, items: [{ ...item, health: 'blocked', blocker: { status: 'resource_blocked', waitingSince: session.createdAt, restricted: true } }] });
    mount();
    await screen.findByText(/无权查看的执行正在占用所需资源/);
    expect(screen.queryByRole('link', { name: '查看阻塞证据并核对' })).toBeNull();
  });

  it('hides cached sensitive plans after denial, stops polling, and restores on explicit retry', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(api, 'automationSchedules').mockResolvedValue(pageData);
    const view = mount();
    await advancePolling(1);
    expect(screen.getByText('巡检 · 已停用')).toBeTruthy();
    read.mockRejectedValue(new ApiError('revoked', 'FORBIDDEN', 403));
    await advancePolling();
    expect(screen.queryByText('巡检 · 已停用')).toBeNull();
    const afterFailure = read.mock.calls.length;
    await advancePolling(30_000);
    expect(read).toHaveBeenCalledTimes(afterFailure);
    read.mockResolvedValue(pageData);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await advancePolling(1);
    expect(screen.getByText('巡检 · 已停用')).toBeTruthy();
    view.unmount();
    const afterUnmount = read.mock.calls.length;
    await advancePolling(30_000);
    expect(read).toHaveBeenCalledTimes(afterUnmount);
  });

  it('suspends overview reads in plan detail and resumes on return', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(api, 'automationSchedules').mockResolvedValue(pageData);
    vi.spyOn(api, 'automation').mockResolvedValue({ ...empty, schedules: [schedule] });
    vi.spyOn(api, 'ciProviders').mockResolvedValue({ providers: [] });
    mount();
    await advancePolling(1);
    fireEvent.click(screen.getByRole('button', { name: '查看 / 管理计划' }));
    await advancePolling(1);
    const afterOpen = read.mock.calls.length;
    await advancePolling(30_000);
    expect(read).toHaveBeenCalledTimes(afterOpen);
    fireEvent.click(screen.getByRole('button', { name: '返回计划中心' }));
    await advancePolling();
    expect(read.mock.calls.length).toBeGreaterThan(afterOpen);
  });

  it('opens a stable run URL without reading overview or substituting another run', async () => {
    window.history.replaceState({}, '', '/?nav=automation&automationSession=s1&schedule=plan1&run=missing');
    const read = vi.spyOn(api, 'automationSchedules');
    const detail = vi.spyOn(api, 'automationRun').mockRejectedValue(new ApiError('missing', 'NOT_FOUND', 404));
    mount();
    await screen.findByText('这次运行不存在或已无法定位，未跳转到最新聊天。');
    expect(detail).toHaveBeenCalledWith('s1', 'plan1', 'missing');
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps experimental import drafts hidden by default', async () => {
    mount();
    await screen.findByText('巡检 · 已停用');
    expect(screen.queryByText('导入与管理草稿')).toBeNull();
  });
});
