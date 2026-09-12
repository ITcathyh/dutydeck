import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicSessionSchedule } from '@dutydeck/shared';
import { api, ApiError, scheduleApi, type RunSummary, type Session } from '../api';
import { AutomationOverview } from './AutomationOverview';

const session: Session = { id: 's1', agentId: 'claude', cwd: '/project/worktree', state: 'completed', runId: 'r', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
const schedule: PublicSessionSchedule = { schemaVersion: 1, id: 'plan1', revision: 3, generation: 1, sessionId: session.id, name: '巡检', prompt: '检查构建', trigger: { kind: 'cron', expression: '0 9 * * *' }, timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }, enabled: false, createdAt: session.createdAt, updatedAt: session.updatedAt };
const empty = { schedules: [], subscriptions: [], occurrences: [] };
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.restoreAllMocks(); });
function mount(sessions = [session], summaries: Record<string, RunSummary> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const onSelectSession = vi.fn();
  render(<QueryClientProvider client={client}><AutomationOverview sessions={sessions} summaries={summaries} onSelectSession={onSelectSession}/></QueryClientProvider>);
  return onSelectSession;
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
});
