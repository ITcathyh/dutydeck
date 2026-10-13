import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UnknownTasksPanel } from './UnknownTasksPanel';
import { api, ApiError, type Session, type Task, type UnknownTask } from '../api';
import { toastStore } from '../useToasts';

afterEach(() => { cleanup(); vi.restoreAllMocks(); toastStore.clear(); });
const session: Session = { id: 's1', agentId: 'a', cwd: '/project', state: 'idle', source: 'lark', runId: 'r', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' };
const task = (status: string): Task => ({ id: 'task_1', sessionId: 's1', prompt: '整理本周报警并回复群里', status, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' });
const unknown: UnknownTask = {
  taskId: 'task_1', status: 'reconcile_required', actionable: true, kind: 'attempt', target: 'attempt_1', submission: 'intent_recorded',
  reasonCode: 'PREVIOUS_RUNTIME_RESULT_UNKNOWN', prompt: '整理本周报警并回复群里',
  factLines: ['最后状态：结果未知，服务重启切断了这一轮', '是否已提交给 Agent：已提交，Agent 已开始执行并有输出', '最后输出：2026/10/13 08:00:00（北京时间）']
};
function mount(tasks: Task[], load: () => Promise<UnknownTask[]> = async () => [unknown]) {
  const list = vi.spyOn(api, 'unknownTasks').mockImplementation(load);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={qc}><UnknownTasksPanel session={session} tasks={tasks}/></QueryClientProvider>);
  return { list, view };
}

describe('result-unknown tasks in the task detail', () => {
  it('shows the facts and the three actions for a result-unknown turn, in place of contacting an admin', async () => {
    mount([task('reconcile_required')]);
    const card = await screen.findByRole('region', { name: '结果未知：整理本周报警并回复群里' });
    for (const line of unknown.factLines) expect(within(card).getByText(line)).toBeTruthy();
    expect(within(card).getByText(/不会自动重发/)).toBeTruthy();
    expect(within(card).getAllByRole('button').map(button => button.textContent)).toEqual(['重新执行', '标为已完成', '标为失败']);
    expect(card.textContent).not.toContain('管理员');
  });

  it('does not ask the server when no turn is result-unknown', async () => {
    const { list, view } = mount([task('completed')]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(list).not.toHaveBeenCalled();
    expect(view.container.innerHTML).toBe('');
  });

  it('retries only after the duplicate-effects warning is confirmed', async () => {
    mount([task('reconcile_required')]);
    const resolve = vi.spyOn(api, 'resolveUnknownTask').mockResolvedValue({ replayed: false, status: 'queued', decisionId: 'manual:attempt_1:retry:web:installation_owner' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '重新执行' }));
    const dialog = await screen.findByRole('alertdialog', { name: '确认重新执行？' });
    expect(dialog.textContent).toContain('可能被重复执行');
    expect(resolve).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(resolve).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '重新执行' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '重新执行' }));
    expect(resolve).toHaveBeenCalledExactlyOnceWith('s1', 'task_1', { target: 'attempt_1', action: 'retry', allowDuplicateEffects: true });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(toastStore.getSnapshot().find(toast => toast.key === 'unknown-task-task_1')?.title).toBe('已重新执行'));
  });

  it('marks completed or failed in one click without the duplicate-effects acknowledgement', async () => {
    const { list } = mount([task('reconcile_required')]);
    const resolve = vi.spyOn(api, 'resolveUnknownTask').mockResolvedValue({ replayed: false, status: 'failed', decisionId: 'manual:attempt_1:failed:web:installation_owner' });
    await userEvent.setup().click(await screen.findByRole('button', { name: '标为失败' }));
    expect(resolve).toHaveBeenCalledExactlyOnceWith('s1', 'task_1', { target: 'attempt_1', action: 'failed' });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(toastStore.getSnapshot().find(toast => toast.key === 'unknown-task-task_1')).toMatchObject({ kind: 'success', title: '已标为失败' });
  });

  it('says who already handled it when someone else got there first', async () => {
    mount([task('reconcile_required')]);
    vi.spyOn(api, 'resolveUnknownTask').mockRejectedValue(new ApiError('这一轮已经处理过：飞书用户 ou_alice 于 2026/10/13 08:01:00（北京时间） 已标为失败。', 'UNKNOWN_TASK_ALREADY_RESOLVED', 409));
    await userEvent.setup().click(await screen.findByRole('button', { name: '标为已完成' }));
    await waitFor(() => expect(toastStore.getSnapshot().find(toast => toast.key === 'unknown-task-task_1')).toMatchObject({ kind: 'error', description: expect.stringContaining('飞书用户 ou_alice') }));
  });

  it('hides the actions from viewers who may not handle recovery, and reports other read failures', async () => {
    const hidden = mount([task('reconcile_required')], async () => { throw new ApiError('forbidden', 'FORBIDDEN', 403); });
    await waitFor(() => expect(hidden.list).toHaveBeenCalled());
    expect(hidden.view.container.innerHTML).toBe('');
    cleanup();
    mount([task('reconcile_required')], async () => { throw new ApiError('boom', 'INTERNAL_ERROR', 500); });
    await screen.findByText('结果未知的任务读取失败：boom');
  });
});
