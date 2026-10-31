import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DockEvent, Session } from '../api';
import { SessionTraceView } from './SessionTraceView';

const session: Session = { id: 's1', agentId: 'codex', state: 'thinking', cwd: '/repo/project', runId: 'run1', createdAt: '', updatedAt: '' };
const event = (sequence: number, type: string, data: unknown = {}): DockEvent => ({ id: `e${sequence}`, sequence, type, timestamp: `2026-10-28T00:00:${String(sequence % 60).padStart(2, '0')}Z`, data });
const source = [event(1, 'text', { role: 'user', taskId: 't1', text: 'find trace bug' }), event(2, 'tool_call', { id: 'read', name: 'Read', input: { path: 'README.md' } }), event(3, 'tool_result', { id: 'read', name: 'Read', status: 'completed', output: 'result canary' }), event(4, 'text', { text: 'fixed answer' })];
const props = { session, events: source, loading: false, historyLoaded: true, streamStatus: 'open' as const, onRetry: vi.fn(), onClose: vi.fn() };

const table = () => screen.getByRole('table', { name: '追踪事件' });
describe('SessionTraceView', () => {
  it('filters, sorts, groups, expands details and locates the corresponding timeline event', async () => {
    const user = userEvent.setup();
    render(<SessionTraceView {...props}/>);
    expect(screen.getByText('已加载序列 1–4')).toBeTruthy();
    expect(within(table()).getAllByRole('row')[2]!.textContent).toContain('fixed answer');
    await user.click(screen.getByRole('button', { name: '切换事件排序' }));
    expect(within(table()).getAllByRole('row')[2]!.textContent).toContain('find trace bug');
    await user.click(screen.getByRole('button', { name: '按轮次分组' }));
    expect(within(table()).queryByRole('button', { name: /轮次 t1/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '定位事件 #3：工具结果' }));
    expect(screen.getByLabelText('事件 #3 数据').textContent).toContain('result canary');
    expect(screen.getByRole('button', { name: '事件 #3 工具结果' }).getAttribute('aria-expanded')).toBe('true');
    await user.click(screen.getByRole('button', { name: '事件 #3 工具结果' }));
    expect(screen.queryByLabelText('事件 #3 数据')).toBeNull();
    await user.click(screen.getByRole('button', { name: '工具 2' }));
    expect(within(table()).queryByText('fixed answer')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索追踪事件' }), { target: { value: 'README' } });
    expect(within(table()).getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索追踪事件' }), { target: { value: 'absent' } });
    expect(screen.getByText('没有匹配的事件')).toBeTruthy();
  });

  it('shows partial/loading/errors and retries without hiding already loaded events; accepts live additions', async () => {
    const user = userEvent.setup(); const retry = vi.fn();
    const { rerender } = render(<SessionTraceView {...props} historyLoaded={false} loading onRetry={retry}/>);
    expect(screen.getByText('正在读取完整历史')).toBeTruthy();
    expect(table()).toBeTruthy();
    rerender(<SessionTraceView {...props} historyLoaded={false} error="network failed" onRetry={retry}/>);
    expect(screen.getByText('当前为部分记录')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('network failed');
    await user.click(screen.getByRole('button', { name: '重试读取' }));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<SessionTraceView {...props} events={[...source, event(5, 'error', { message: 'late failure' })]}/>);
    await user.click(screen.getByRole('button', { name: '错误 1' }));
    expect(within(table()).getByText('late failure')).toBeTruthy();
  });

  it('bounds table and timeline DOM while every loaded event remains searchable', async () => {
    const user = userEvent.setup();
    render(<SessionTraceView {...props} events={Array.from({ length: 250 }, (_, i) => event(i + 1, 'text', { text: `message-${i + 1}` }))}/>);
    expect(within(table()).getAllByRole('button', { name: /^事件 #/ })).toHaveLength(100);
    expect(screen.getAllByRole('button', { name: /^定位事件 #/ })).toHaveLength(100);
    expect(within(table()).getByText('message-250')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(within(table()).getByText('message-150')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索追踪事件' }), { target: { value: 'message-1' } });
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(within(table()).getByText('message-199')).toBeTruthy();
  });

  it('handles empty history and untimed events, collapses rounds and closes on Escape', async () => {
    const user = userEvent.setup(); const close = vi.fn();
    const { rerender } = render(<SessionTraceView {...props} events={[]} onClose={close}/>);
    expect(screen.getByText('暂无追踪事件')).toBeTruthy();
    expect(screen.getByText('没有可用的事件时间')).toBeTruthy();
    rerender(<SessionTraceView {...props} events={[{ ...source[0]!, timestamp: '' }]} onClose={close}/>);
    expect(within(table()).getByText('find trace bug')).toBeTruthy();
    await user.click(within(table()).getByRole('button', { name: /轮次 t1/ }));
    expect(within(table()).queryByText('find trace bug')).toBeNull();
    await user.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
