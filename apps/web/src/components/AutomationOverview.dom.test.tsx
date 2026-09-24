import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicSessionSchedule } from '@dutydeck/shared';
import { api, ApiError, scheduleApi, type RunSummary, type Session } from '../api';
import { AutomationOverview } from './AutomationOverview';

const session: Session = { id: 's1', agentId: 'claude', cwd: '/project/worktree', state: 'completed', runId: 'r', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
const schedule: PublicSessionSchedule = { schemaVersion: 1, id: 'plan1', revision: 3, generation: 1, sessionId: session.id, name: '巡检', prompt: '检查构建', trigger: { kind: 'cron', expression: '0 9 * * *' }, timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }, enabled: false, createdAt: session.createdAt, updatedAt: session.updatedAt };
const empty = { schedules: [], subscriptions: [], occurrences: [] };
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.restoreAllMocks(); vi.useRealTimers(); });
function mount(sessions = [session], summaries: Record<string, RunSummary> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const onSelectSession = vi.fn();
  const rendered = render(<QueryClientProvider client={client}><AutomationOverview sessions={sessions} summaries={summaries} onSelectSession={onSelectSession}/></QueryClientProvider>);
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
  it('opens the same plan editor and refreshes the shared list after saving', async () => {
    const read = vi.spyOn(api, 'automation').mockResolvedValue({ ...empty, schedules: [schedule] });
    const update = vi.spyOn(api, 'updateSchedule').mockResolvedValue({ schedule });
    const capabilities = vi.spyOn(scheduleApi, 'capabilities');
    const onSelect = mount([session], { s1: { sessionId: 's1', taskId: 't1', prompt: '修复构建错误', status: 'completed', queuedCount: 0, updatedAt: session.updatedAt } });
    const user = userEvent.setup();
    await screen.findByText('巡检 · 已停用');
    expect(screen.getByRole('heading', { name: '修复构建错误' })).toBeTruthy();
    expect(screen.getByText('claude · 目录：/project/worktree')).toBeTruthy();
    expect(screen.getByText('Asia/Shanghai · 沿用任务上下文')).toBeTruthy();
    expect(capabilities).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '查看 / 编辑计划' }));
    expect(screen.getByText('所属任务：修复构建错误 · 目录：/project/worktree')).toBeTruthy();
    expect((await screen.findByLabelText('计划名称') as HTMLInputElement).value).toBe('巡检');
    await user.clear(screen.getByLabelText('计划名称'));
    await user.type(screen.getByLabelText('计划名称'), '新版巡检');
    read.mockResolvedValue({ ...empty, schedules: [{ ...schedule, name: '新版巡检', revision: 4 }] });
    await user.click(screen.getByRole('button', { name: '保存计划' }));
    await screen.findByText('计划已更新。');
    expect(update).toHaveBeenCalledWith('s1', 'plan1', expect.objectContaining({ name: '新版巡检', expectedRevision: 3 }));
    await user.click(screen.getByRole('button', { name: '打开所属任务' }));
    expect(onSelect).toHaveBeenCalledWith('s1');
    await user.click(screen.getByRole('button', { name: '返回任务计划' }));
    expect(await screen.findByText('新版巡检 · 已停用')).toBeTruthy();
  });

  it('does not expose denied session data and distinguishes failed queries from empty plans', async () => {
    const read = vi.spyOn(api, 'automation').mockImplementation(async id => {
      if (id === 'secret') throw new ApiError('denied', 'FORBIDDEN', 403);
      if (id === 's1') throw new ApiError('offline', 'UNAVAILABLE', 503);
      return empty;
    });
    mount([session, { ...session, id: 'secret', cwd: '/private' }]);
    await screen.findByText('计划读取失败，无法确认当前状态。');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'claude · /private' })).toBeNull());
    expect(screen.queryByText(/\/private/)).toBeNull();
    expect(screen.queryByText('此任务暂无定时计划。')).toBeNull();
    read.mockResolvedValue(empty);
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('此任务暂无定时计划。');
  });

  it('limits reads to the current task page and keeps draft management separate', async () => {
    const read = vi.spyOn(api, 'automation').mockResolvedValue(empty);
    const capabilities = vi.spyOn(scheduleApi, 'capabilities').mockResolvedValue({ schemaVersion: 1, repositoriesWired: false, permissionEvaluatorWired: false, writesEnabled: false, executorWired: false, uiEntryReady: true, readiness: 'repository_unwired', blockers: [] });
    mount(Array.from({ length: 9 }, (_, index) => ({ ...session, id: `s${index + 1}` })));
    const user = userEvent.setup();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(8));
    expect(read).not.toHaveBeenCalledWith('s9');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(read).toHaveBeenCalledWith('s9'));
    expect(read).toHaveBeenCalledTimes(9);
    expect(capabilities).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '管理草稿' }));
    await screen.findByText('定时任务草稿');
    expect(capabilities).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '启用' })).toBeNull();
  });

  it('refreshes schedule status every 10 seconds without user interaction', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(api, 'automation').mockResolvedValue({ ...empty, schedules: [schedule] });
    mount([session]);
    await advancePolling(0);
    expect(screen.getByText('巡检 · 已停用')).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(1);

    read.mockResolvedValue({ ...empty, schedules: [{ ...schedule, enabled: true, revision: 4 }] });
    await advancePolling(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByText('巡检 · 已启用')).toBeTruthy();
  });

  it('polls only current page and stops polling previous page after pagination', async () => {
    vi.useFakeTimers();
    const sessions = Array.from({ length: 9 }, (_, index) => ({ ...session, id: `s${index + 1}` }));
    const read = vi.spyOn(api, 'automation').mockResolvedValue(empty);
    mount(sessions);
    await advancePolling(0);
    expect(read).toHaveBeenCalledTimes(8);
    expect(read).not.toHaveBeenCalledWith('s9');

    // After 10s on page 1, s1-s8 should be polled again (16 calls total)
    await advancePolling(10_000);
    expect(read).toHaveBeenCalledTimes(16);
    expect(read).not.toHaveBeenCalledWith('s9');

    // Switch to page 2
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await advancePolling(0);
    expect(read).toHaveBeenCalledWith('s9');
    expect(read).toHaveBeenCalledTimes(17);

    // After 10s on page 2, only s9 should be polled; page 1 sessions must not be polled
    await advancePolling(10_000);
    expect(read).toHaveBeenCalledTimes(18);
    const s9Calls = read.mock.calls.filter(call => call[0] === 's9').length;
    expect(s9Calls).toBe(2);
    const page1Calls = read.mock.calls.filter(call => call[0] !== 's9').length;
    expect(page1Calls).toBe(16);
  });

  it('stops polling on failure and hides cached data, restoring on manual retry', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(api, 'automation').mockResolvedValue({ ...empty, schedules: [schedule] });
    mount([session]);
    await advancePolling(0);
    expect(screen.getByText('巡检 · 已停用')).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(1);

    // Subsequent poll fails with 503
    read.mockRejectedValue(new ApiError('offline', 'UNAVAILABLE', 503));
    await advancePolling(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    // Old cached schedule data must not be displayed
    expect(screen.queryByText('巡检 · 已停用')).toBeNull();
    expect(screen.getByText('计划读取失败，无法确认当前状态。')).toBeTruthy();

    // Must stop periodic polling on error
    await advancePolling(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    await advancePolling(20_000);
    expect(read).toHaveBeenCalledTimes(2);

    // Manual retry should recover
    read.mockResolvedValue({ ...empty, schedules: [schedule] });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await advancePolling(0);
    expect(read).toHaveBeenCalledTimes(3);
    expect(screen.getByText('巡检 · 已停用')).toBeTruthy();

    // Polling resumes after recovery
    await advancePolling(10_000);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('stops polling on authorization revocation (403) and hides cached sensitive data', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(api, 'automation').mockResolvedValue({ ...empty, schedules: [schedule] });
    mount([session]);
    await advancePolling(0);
    expect(screen.getByText('巡检 · 已停用')).toBeTruthy();
    expect(screen.getByText(/claude · 目录：\/project\/worktree/)).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(1);

    // Revocation returns 403 Forbidden
    read.mockRejectedValue(new ApiError('denied', 'FORBIDDEN', 403));
    await advancePolling(10_000);
    expect(read).toHaveBeenCalledTimes(2);

    // Cached data and sensitive session details must be hidden
    expect(screen.queryByText('巡检 · 已停用')).toBeNull();
    expect(screen.queryByText(/claude · 目录：\/project\/worktree/)).toBeNull();

    // Polling stops
    await advancePolling(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    await advancePolling(20_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stops polling when unmounted', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(api, 'automation').mockResolvedValue({ ...empty, schedules: [schedule] });
    const { unmount } = mount([session]);
    await advancePolling(0);
    expect(read).toHaveBeenCalledTimes(1);

    unmount();
    await advancePolling(10_000);
    await advancePolling(20_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('suspends overview queries when task detail is opened and resumes upon return', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(api, 'automation').mockResolvedValue({ ...empty, schedules: [schedule] });
    mount([session]);
    await advancePolling(0);
    expect(read).toHaveBeenCalledTimes(1);

    // Open task details
    fireEvent.click(screen.getByRole('button', { name: '查看 / 编辑计划' }));
    await advancePolling(0);
    expect(screen.getByText('所属任务：claude · /project/worktree · 目录：/project/worktree')).toBeTruthy();
    const callsInDetail = read.mock.calls.length;

    // Advance 10 seconds while in detail: SessionAutomationPanel polls, but overview queries remain disabled
    await advancePolling(10_000);
    expect(read.mock.calls.length).toBe(callsInDetail + 1);

    // Return to overview
    fireEvent.click(screen.getByRole('button', { name: '返回任务计划' }));
    await advancePolling(0);
    expect(screen.getByText('巡检 · 已停用')).toBeTruthy();

    // Advance 10 seconds back in overview: overview polls again
    const callsBeforeOverviewPoll = read.mock.calls.length;
    await advancePolling(10_000);
    expect(read.mock.calls.length).toBe(callsBeforeOverviewPoll + 1);
  });

  it('优先展示自定义会话名称作为任务标题', async () => {
    vi.spyOn(api, 'automation').mockResolvedValue(empty);
    mount([{ ...session, name: '自动化巡检任务' }], { s1: { sessionId: 's1', taskId: 't1', prompt: '原始指令', status: 'completed', queuedCount: 0, updatedAt: session.updatedAt } });
    expect(await screen.findByRole('heading', { name: '自动化巡检任务' })).toBeTruthy();
  });
});
