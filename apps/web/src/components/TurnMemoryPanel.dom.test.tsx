import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TurnMemoryPanel } from './TurnMemoryPanel';
import { api, ApiError, type LarkTurnMemory, type Session } from '../api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const session: Session = { id: 's1', agentId: 'a', cwd: '/project', state: 'completed', source: 'lark', runId: 'r', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' };
const turn: LarkTurnMemory = {
  taskId: 'task_1', at: '2026-09-25T08:00:00Z', shared: true,
  injected: [
    { id: 'mem_00000001', content: '回复统一用中文', topic: 'general', source: 'user', createdAt: '2026-09-20T00:00:00Z' },
    { id: 'mem_00000002', content: '部署脚本在 scripts/deploy.sh', topic: 'environment', source: 'extraction', createdAt: '2026-09-21T00:00:00Z', deletedAt: '2026-09-24T00:00:00Z' }
  ],
  written: [{ id: 'mem_00000003', content: '发布窗口是周四', topic: 'conventions', source: 'agent', createdAt: '2026-09-25T08:00:00Z' }]
};
function mount(load: () => Promise<{ turns: LarkTurnMemory[] }>) {
  const sessionMemory = vi.spyOn(api, 'sessionMemory').mockImplementation(load);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={qc}><TurnMemoryPanel session={session}/></QueryClientProvider>);
  return { sessionMemory, view };
}

describe('turn memory in the task detail', () => {
  it('lists injected and written memories with counts, deleted ones without a delete button', async () => {
    mount(async () => ({ turns: [turn] }));
    await screen.findByRole('complementary', { name: '本轮记忆' });
    expect(screen.getByText('用到的记忆（2 条）')).toBeTruthy();
    expect(screen.getByText('新记下的记忆（1 条）')).toBeTruthy();
    expect(screen.getByText('回复统一用中文')).toBeTruthy();
    expect(screen.getByText('发布窗口是周四')).toBeTruthy();
    expect(screen.getByText(/群共享记忆/)).toBeTruthy();
    expect(screen.getByText('已删除')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '删除记忆 mem_00000002' })).toBeNull();
    expect(screen.getByRole('button', { name: '删除记忆 mem_00000001' })).toBeTruthy();
  });
  it('deletes one memory with the turn it belongs to and refetches', async () => {
    const { sessionMemory } = mount(async () => ({ turns: [turn] }));
    const forget = vi.spyOn(api, 'forgetSessionMemory').mockResolvedValue({ removed: { id: 'mem_00000003' } });
    await userEvent.setup().click(await screen.findByRole('button', { name: '删除记忆 mem_00000003' }));
    expect(forget).toHaveBeenCalledWith('s1', 'task_1', 'mem_00000003');
    await waitFor(() => expect(sessionMemory).toHaveBeenCalledTimes(2));
  });
  it('keeps the list when deletion is rejected', async () => {
    mount(async () => ({ turns: [turn] }));
    const forget = vi.spyOn(api, 'forgetSessionMemory').mockRejectedValue(new ApiError('无权删除', 'POLICY_DENIED', 403));
    await userEvent.setup().click(await screen.findByRole('button', { name: '删除记忆 mem_00000001' }));
    expect(forget).toHaveBeenCalledOnce();
    expect(screen.getByText('回复统一用中文')).toBeTruthy();
  });
  it('renders nothing when no turn recorded any memory', async () => {
    const { sessionMemory, view } = mount(async () => ({ turns: [] }));
    await waitFor(() => expect(sessionMemory).toHaveBeenCalled());
    await waitFor(() => expect(view.container.innerHTML).toBe(''));
  });
  it('says the records could not be read instead of hiding a failure', async () => {
    mount(async () => { throw new ApiError('boom', 'INTERNAL_ERROR', 500); });
    await screen.findByText('记忆记录读取失败');
  });
});
