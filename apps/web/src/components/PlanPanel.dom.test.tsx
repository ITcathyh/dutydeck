import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlanPanel } from './PlanPanel';
import { api, type PlanState, type Session, type Task } from '../api';
import { toastStore } from '../useToasts';

afterEach(() => { cleanup(); vi.restoreAllMocks(); toastStore.clear(); });
const session: Session = { id: 's1', agentId: 'claude', cwd: '/project', state: 'idle', runId: 'r', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' };
const task = (prompt: string, status = 'completed'): Task => ({ id: 'task_1', sessionId: 's1', prompt, status, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' });
function mount(tasks: Task[], state: PlanState, target: Session = session) {
  const load = vi.spyOn(api, 'planState').mockResolvedValue(state);
  const decide = vi.spyOn(api, 'decidePlan').mockResolvedValue({ state: 'approved' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PlanPanel session={target} tasks={tasks}/></QueryClientProvider>);
  return { load, decide };
}
const pending: PlanState = { state: 'pending', taskId: 'task_1', expiresAt: '2026-10-14T00:00:00Z', operable: true };

describe('plan approval in the task detail', () => {
  it('approves, cancels and sends revision feedback for the latest plan', async () => {
    const user = userEvent.setup();
    const { decide } = mount([task('/plan 把登录页报错改成中文')], pending);
    const card = await screen.findByRole('region', { name: '执行计划待批准' });
    expect(within(card).getByText(/Agent 还没有改任何东西/)).toBeTruthy();
    const revise = within(card).getByRole('button', { name: '提修改意见' }) as HTMLButtonElement;
    expect(revise.disabled).toBe(true);
    await user.type(within(card).getByLabelText('修改意见'), '只改文案');
    await user.click(revise);
    await waitFor(() => expect(decide).toHaveBeenCalledWith('s1', 'task_1', 'revise', '只改文案'));
    await user.click(within(card).getByRole('button', { name: '批准执行' }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('s1', 'task_1', 'approve', undefined));
    await user.click(within(card).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('s1', 'task_1', 'cancel', undefined));
  });

  it('points Feishu plans back to the Feishu card without action buttons', async () => {
    mount([task('/plan 整理依赖')], { ...pending, operable: false }, { ...session, source: 'lark' });
    const card = await screen.findByRole('region', { name: '执行计划待批准' });
    expect(within(card).getByText(/在飞书的计划卡上/)).toBeTruthy();
    expect(within(card).queryAllByRole('button')).toEqual([]);
  });

  it('says a plan is being made while the plan turn runs', async () => {
    mount([task('/plan 整理依赖', 'running')], { state: 'planning', taskId: 'task_1' });
    expect(await screen.findByText(/正在出计划/)).toBeTruthy();
  });

  it('does not ask the server when the latest turn is not a plan', async () => {
    const { load } = mount([task('普通任务')], pending);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: '执行计划待批准' })).toBeNull();
  });
});
