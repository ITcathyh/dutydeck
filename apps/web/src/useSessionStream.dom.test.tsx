import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type DockEvent, type Session, type Task } from './api';
import { createEventWindow } from './event-history';
import type { MockableEventSource } from './sse';
import { useSessionStream } from './useSessionStream';

const event = (sequence: number): DockEvent => ({ id: `e${sequence}`, sequence, type: 'text', timestamp: '', data: { text: String(sequence) } });
const session: Session = { id: 's1', agentId: 'codex', state: 'idle', cwd: '/repo', runId: 'r1', createdAt: '', updatedAt: '' };

class MockEventSource implements MockableEventSource {
  static instances: MockEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, (message: MessageEvent<string>) => void>();
  constructor(readonly url: string) { MockEventSource.instances.push(this); }
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  emit(type: string, value: DockEvent) { this.listeners.get(type)?.({ data: JSON.stringify(value) } as MessageEvent<string>); }
  close() {}
}

beforeEach(() => { MockEventSource.instances = []; vi.stubGlobal('EventSource', MockEventSource); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('useSessionStream reconciliation', () => {
  it('open/reconnect 校准 tasks，并在 sequence gap 时拉取缺失事件', async () => {
    const taskLoader = vi.fn(async () => []); const sessionLoader = vi.fn(async () => [session]);
    const eventLoader = vi.spyOn(api, 'events').mockResolvedValueOnce([event(11)]).mockResolvedValueOnce([event(12), event(13)]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['events', 's1'], createEventWindow([event(10)]));
    function Harness() {
      useQuery({ queryKey: ['tasks', 's1'], queryFn: taskLoader });
      useQuery({ queryKey: ['sessions'], queryFn: sessionLoader });
      return <span>{useSessionStream('s1', 'r1', true)}</span>;
    }
    render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(taskLoader).toHaveBeenCalledTimes(1));
    act(() => MockEventSource.instances[0]!.onopen?.(new Event('open')));
    await waitFor(() => expect(screen.getByText('open')).toBeTruthy());
    await waitFor(() => expect(taskLoader.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(eventLoader).toHaveBeenCalledWith('s1', { after: 10, limit: 200, direction: 'forward' }, expect.any(AbortSignal)));
    await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.at(-1)?.sequence).toBe(11));
    act(() => MockEventSource.instances[0]!.emit('text', event(13)));
    await waitFor(() => expect(eventLoader).toHaveBeenCalledWith('s1', { after: 11, limit: 200, direction: 'forward' }, expect.any(AbortSignal)));
    await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.map(item => item.sequence)).toEqual([10, 11, 12, 13]));
  });

  it('reconnect loads every missed page without dropping the existing history', async () => {
    const loader = vi.spyOn(api, 'events')
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, index) => event(index + 1_001)))
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, index) => event(index + 1_201)))
      .mockResolvedValueOnce([event(1_401)]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['events', 's1'], createEventWindow(Array.from({ length: 1_000 }, (_, index) => event(index + 1))));
    function Harness() { useSessionStream('s1', 'r1', true); return null; }
    render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
    act(() => MockEventSource.instances[0]!.onopen?.(new Event('open')));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
    expect(loader).toHaveBeenLastCalledWith('s1', { after: 1_400, limit: 200, direction: 'forward' }, expect.any(AbortSignal));
    await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.map(item => item.sequence)).toEqual(Array.from({ length: 1_401 }, (_, index) => index + 1)));
  });

  it('leaving a session aborts reconciliation and prevents late cache writes', async () => {
    let release!: (events: DockEvent[]) => void;
    const loader = vi.spyOn(api, 'events').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['events', 's1'], createEventWindow([event(1)]));
    function Harness() { useSessionStream('s1', 'r1', true); return null; }
    const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
    act(() => MockEventSource.instances[0]!.onopen?.(new Event('open')));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    const signal = loader.mock.calls[0]?.[2];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => release(Array.from({ length: 200 }, (_, index) => event(index + 2))));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events).toEqual([event(1)]);
  });

  it('已有 Task 收到局部状态事件期间原 prompt/metadata 仍可渲染，回读后更新 status', async () => {
    const existingTask: Task = {
      id: 'task-1',
      sessionId: 's1',
      prompt: '  fix startup bug  ',
      status: 'running',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
    };
    const partialTaskEvent: DockEvent = {
      id: 'evt-task-1',
      sequence: 1,
      type: 'task',
      timestamp: '2026-09-15T00:00:01.000Z',
      data: { task: { id: 'task-1', status: 'completed', revision: 2 } },
    };

    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    let fetchCount = 0;
    const taskLoader = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return [existingTask];
      }
      await gate;
      return [{ ...existingTask, status: 'completed' }];
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
      useSessionStream('s1', 'r1', true);
      const { data: tasks = [] } = useQuery({ queryKey: ['tasks', 's1'], queryFn: taskLoader });
      return (
        <div>
          {tasks.map(t => (
            <span key={t.id} data-testid={`task-${t.id}`}>
              {t.prompt.trim()}:{t.status}
            </span>
          ))}
        </div>
      );
    }

    try {
      render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>
      );

      await waitFor(() => expect(screen.getByTestId('task-task-1').textContent).toBe('fix startup bug:running'));

      act(() => {
        MockEventSource.instances[0]!.emit('task', partialTaskEvent);
      });

      // 回读 gate 尚未释放期间，旧缓存依然保持完整，渲染 prompt.trim 绝不白屏崩溃
      expect(screen.getByTestId('task-task-1').textContent).toBe('fix startup bug:running');
      expect(taskLoader.mock.calls.length).toBeGreaterThanOrEqual(2);

      releaseGate();
      await waitFor(() => expect(screen.getByTestId('task-task-1').textContent).toBe('fix startup bug:completed'));
    } finally {
      releaseGate();
    }
  });

  it('未知新 Task 或空缓存收到局部事件，不插入不完整对象，回读完整列表后新 Task 可见', async () => {
    const newTask: Task = {
      id: 'task-2',
      sessionId: 's1',
      prompt: '  fresh task prompt  ',
      status: 'running',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
    };
    const unknownTaskEvent: DockEvent = {
      id: 'evt-task-2',
      sequence: 1,
      type: 'task',
      timestamp: '2026-09-15T00:00:01.000Z',
      data: { task: { id: 'task-2', status: 'running', revision: 1 } },
    };

    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    let fetchCount = 0;
    const taskLoader = vi.fn(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return [];
      }
      await gate;
      return [newTask];
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
      useSessionStream('s1', 'r1', true);
      const { data: tasks = [] } = useQuery({ queryKey: ['tasks', 's1'], queryFn: taskLoader });
      return (
        <div>
          {tasks.map(t => (
            <span key={t.id} data-testid={`task-${t.id}`}>
              {t.prompt.trim()}:{t.status}
            </span>
          ))}
        </div>
      );
    }

    try {
      render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>
      );

      await waitFor(() => expect(taskLoader).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId('task-task-2')).toBeNull();

      act(() => {
        MockEventSource.instances[0]!.emit('task', unknownTaskEvent);
      });

      // 回读完成前，绝不向缓存插入缺失 prompt 的残缺对象，渲染 prompt.trim 绝不抛错
      expect(screen.queryByTestId('task-task-2')).toBeNull();
      expect(taskLoader.mock.calls.length).toBeGreaterThanOrEqual(2);

      releaseGate();
      await waitFor(() => expect(screen.getByTestId('task-task-2').textContent).toBe('fresh task prompt:running'));
    } finally {
      releaseGate();
    }
  });
});
