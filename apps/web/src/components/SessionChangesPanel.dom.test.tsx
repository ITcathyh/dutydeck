import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type Session, type TurnDiff } from '../api';
import { setInstance } from '../instance';
import { SessionChangesPanel } from './SessionChangesPanel';

const session: Session = { id: 's1', agentId: 'a', state: 'completed', cwd: '/repo', runId: 'r', createdAt: '', updatedAt: '' };
const diff = (taskId: string, text = 'const value = 1'): TurnDiff => ({ sessionId: 's1', taskId, title: `指令 ${taskId}`, access: 'owner', finishedAt: '2026-10-21T00:00:00Z', truncated: false, summary: { files: 1, additions: 1, deletions: 0 }, files: [{ path: 'src/a.ts', status: 'added', additions: 1, deletions: 0, hunks: [{ header: '@@ -0,0 +1 @@', lines: [{ kind: 'add', newLine: 1, text }] }] }] });
const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><SessionChangesPanel session={session}/></QueryClientProvider>);
  return { ...view, client };
};
const turns = () => {
  vi.spyOn(api, 'turnDiffs').mockResolvedValue(['t1', 't2'].map(taskId => ({ taskId, summary: { files: 1, additions: 1, deletions: 0 } })));
  return vi.spyOn(api, 'turnDiff').mockImplementation(async (_session, task) => diff(task));
};
const comment = async (body: string) => {
  fireEvent.click(await screen.findByRole('button', { name: '评论 src/a.ts 第 1 行' }));
  fireEvent.change(screen.getByLabelText('src/a.ts 第 1 行的评论'), { target: { value: body } });
  fireEvent.click(screen.getByRole('button', { name: '添加评论' }));
};
afterEach(() => { cleanup(); sessionStorage.clear(); setInstance(undefined); vi.restoreAllMocks(); });

describe('任务主标签中的真实轮次改动', () => {
  it('默认最新轮次，可切到历史轮次并保留各自批注，发送使用被审阅轮次和当前任务', async () => {
    const read = turns();
    const submit = vi.spyOn(api, 'submitTurnDiffComments').mockResolvedValue({ delivery: 'dispatched' });
    mount();
    await screen.findByRole('heading', { name: '指令 t2' });
    await comment('先保留在最新轮次');
    fireEvent.change(screen.getByLabelText('改动轮次'), { target: { value: 't1' } });
    await screen.findByRole('heading', { name: '指令 t1' });
    expect(screen.queryByText('先保留在最新轮次')).toBeNull();
    await comment('为历史版本补一个测试');
    fireEvent.click(screen.getByRole('button', { name: '提交评论' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('s1', 't1', [{ path: 'src/a.ts', side: 'new', line: 1, body: '为历史版本补一个测试' }]));
    fireEvent.change(screen.getByLabelText('改动轮次'), { target: { value: 't2' } });
    expect(await screen.findByText('先保留在最新轮次')).toBeTruthy();
    expect(read).toHaveBeenCalledWith('s1', 't1');
    expect(screen.getByText(/本轮快照 · t2/)).toBeTruthy();
    expect(document.querySelector('.min-h-\[100dvh\]')).toBeNull();
  });

  it('已查看只适用于原文件版本；代码快照改变后重新显示未查看', async () => {
    turns();
    const { client } = mount();
    const check = await screen.findByRole('checkbox', { name: '已查看 src/a.ts' });
    fireEvent.click(check);
    expect((check as HTMLInputElement).checked).toBe(true);
    client.setQueryData(['turnDiff', 's1', 't2'], diff('t2', 'const value = 2'));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: '已查看 src/a.ts' }) as HTMLInputElement).checked).toBe(false));
  });

  it.each(['other', 'local'])('主实例与实例 %s 的相同任务编号分别保留批注和已查看版本', async instance => {
    turns();
    let view = mount();
    await comment('尚未发回当前任务');
    fireEvent.click(screen.getByRole('checkbox', { name: '已查看 src/a.ts' }));
    view.unmount();
    view = mount();
    expect(await screen.findByText('尚未发回当前任务')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: '已查看 src/a.ts' }) as HTMLInputElement).checked).toBe(true);
    view.unmount();
    setInstance(instance);
    view = mount();
    await screen.findByRole('heading', { name: '指令 t2' });
    expect(screen.queryByText('尚未发回当前任务')).toBeNull();
    expect((screen.getByRole('checkbox', { name: '已查看 src/a.ts' }) as HTMLInputElement).checked).toBe(false);
    await comment('另一个实例的批注');
    view.unmount();
    setInstance(undefined);
    mount();
    expect(await screen.findByText('尚未发回当前任务')).toBeTruthy();
    expect(screen.queryByText('另一个实例的批注')).toBeNull();
    expect((screen.getByRole('checkbox', { name: '已查看 src/a.ts' }) as HTMLInputElement).checked).toBe(true);
  });

  it('读取失败给重试，成功后不把错误当作无改动', async () => {
    vi.spyOn(api, 'turnDiffs').mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue([]);
    mount();
    expect(await screen.findByText(/读取改动失败/)).toBeTruthy();
    expect(screen.queryByText('尚无本轮改动')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('尚无本轮改动')).toBeTruthy();
  });
});
