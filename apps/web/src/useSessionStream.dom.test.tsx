import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type DockEvent, type Session, type Task } from './api';
import { createEventWindow } from './event-history';
import type { MockableEventSource } from './sse';
import { useSessionStream } from './useSessionStream';
import { loadSessions, recordSessionStatusUpdates } from './sessions-query';

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
  closed = false;
  close() { this.closed = true; }
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
      return <span>{useSessionStream('s1', 'r1', true).transport}</span>;
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
      await waitFor(() => expect(taskLoader.mock.calls.length).toBeGreaterThanOrEqual(2));

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
      await waitFor(() => expect(taskLoader.mock.calls.length).toBeGreaterThanOrEqual(2));

      releaseGate();
      await waitFor(() => expect(screen.getByTestId('task-task-2').textContent).toBe('fresh task prompt:running'));
    } finally {
      releaseGate();
    }
  });
});

it('batches a burst into one frame and cancels the pending paint when leaving', async () => {
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(1)]));
  function Harness() { useSessionStream('s1', 'r1', true); return null; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  const writes = vi.spyOn(client, 'setQueryData');
  act(() => { for (let sequence = 2; sequence <= 201; sequence++) MockEventSource.instances[0]!.emit('text', event(sequence)); });
  expect(writes).not.toHaveBeenCalled(); expect(frames.size).toBe(1);
  act(() => { const callback = [...frames.values()][0]!; frames.clear(); callback(0); });
  expect(writes).toHaveBeenCalledTimes(1);
  expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events).toHaveLength(201);
  act(() => MockEventSource.instances[0]!.emit('text', event(202)));
  view.unmount(); expect(frames.size).toBe(0);
  expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events).toHaveLength(201);
});

it('retries the lowest failed gap on open even after newer live events are cached', async () => {
  const loader = vi.spyOn(api, 'events').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([event(11), event(12), event(13)]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(10)]));
  function Harness() { useSessionStream('s1', 'r1', true); return null; }
  render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  act(() => MockEventSource.instances[0]!.emit('text', event(13)));
  await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.at(-1)?.sequence).toBe(13));
  act(() => MockEventSource.instances[0]!.onopen?.(new Event('open')));
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  expect(loader).toHaveBeenLastCalledWith('s1', { after: 10, direction: 'forward', limit: 200 }, expect.any(AbortSignal));
  await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.map(event => event.sequence)).toEqual([10, 11, 12, 13]));
});

it('preserves metadata from earlier status events in the same frame', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['sessions'], [session]);
  function Harness() { useSessionStream('s1', 'r1', true); return null; }
  render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  act(() => {
    MockEventSource.instances[0]!.emit('status', { ...event(1), type: 'status', data: { state: 'thinking', model: 'new-model' } });
    MockEventSource.instances[0]!.emit('status', { ...event(2), type: 'status', data: { state: 'completed' } });
  });
  await waitFor(() => expect(client.getQueryData<Session[]>(['sessions'])?.[0]).toMatchObject({ model: 'new-model', state: 'completed' }));
});

it('refreshes tasks when a gap recovers a missed task event, without refreshing unrelated queries', async () => {
  const missed: DockEvent = { ...event(11), type: 'task', data: { task: { id: 't1', status: 'completed' } } };
  vi.spyOn(api, 'events').mockResolvedValue([missed, event(12)]);
  const task = { id: 't1', sessionId: 's1', prompt: 'fix', status: 'running', createdAt: '', updatedAt: '' };
  const taskLoader = vi.fn().mockResolvedValueOnce([task]).mockResolvedValue([{ ...task, status: 'completed' }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(10)]));
  const invalidations = vi.spyOn(client, 'invalidateQueries');
  function Harness() { useQuery({ queryKey: ['tasks', 's1'], queryFn: taskLoader }); useSessionStream('s1', 'r1', true); return null; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    await waitFor(() => expect(taskLoader).toHaveBeenCalledTimes(1));
    act(() => MockEventSource.instances[0]!.emit('text', event(12)));
    await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.map(item => item.sequence)).toEqual([10, 11, 12]));
    await waitFor(() => expect(client.getQueryData<Task[]>(['tasks', 's1'])?.[0]?.status).toBe('completed'));
    expect(taskLoader).toHaveBeenCalledTimes(2);
    expect(invalidations.mock.calls).toEqual([[{ queryKey: ['tasks', 's1'], exact: true }, { cancelRefetch: false }]]);
    act(() => MockEventSource.instances[0]!.emit('task', missed));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(invalidations).toHaveBeenCalledTimes(1);
  } finally { view.unmount(); client.clear(); }
});

it('applies recovered status metadata without regressing a newer live status', async () => {
  const earlier: DockEvent = { ...event(11), type: 'status', data: { state: 'thinking', model: 'new-model' } };
  let recover!: (events: DockEvent[]) => void;
  vi.spyOn(api, 'events').mockImplementation(() => new Promise(resolve => { recover = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(10)]));
  client.setQueryData(['sessions'], [session]);
  const invalidations = vi.spyOn(client, 'invalidateQueries');
  function Harness() { useSessionStream('s1', 'r1', true); return null; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    act(() => MockEventSource.instances[0]!.emit('text', event(12)));
    act(() => MockEventSource.instances[0]!.emit('status', { ...event(13), type: 'status', data: { state: 'completed' } }));
    await waitFor(() => expect(client.getQueryData<Session[]>(['sessions'])?.[0]?.state).toBe('completed'));
    await act(async () => recover([earlier, event(12)]));
    await waitFor(() => expect(client.getQueryData<Session[]>(['sessions'])?.[0]).toMatchObject({ state: 'completed', model: 'new-model' }));
    act(() => MockEventSource.instances[0]!.emit('status', earlier));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(client.getQueryData<Session[]>(['sessions'])?.[0]?.state).toBe('completed');
    expect(invalidations).not.toHaveBeenCalled();
  } finally { view.unmount(); client.clear(); }
});


it.each([
  { name: 'short hidden interval retains the stream', duration: 30_000, fail: false, sources: 1 },
  { name: 'long hidden interval suspends the stream', duration: 60_000, fail: false, sources: 2 },
  { name: 'error while hidden closes the stream', duration: 30_000, fail: true, sources: 2 }
])('foreground recovery calibrates once before any new open: $name', async ({ duration, fail, sources }) => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const eventLoader = vi.spyOn(api, 'events').mockResolvedValueOnce([]).mockResolvedValueOnce([event(2)]).mockResolvedValue([]);
  const taskLoader = vi.fn(async () => []);
  const sessionLoader = vi.fn(async () => [session]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(1)]));
  function Harness() {
    useQuery({ queryKey: ['tasks', 's1'], queryFn: taskLoader });
    useQuery({ queryKey: ['sessions'], queryFn: sessionLoader });
    useSessionStream('s1', 'r1', true);
    return null;
  }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { MockEventSource.instances[0]!.onopen?.(new Event('open')); await vi.advanceTimersByTimeAsync(0); });
    const tasksBefore = taskLoader.mock.calls.length;
    const sessionsBefore = sessionLoader.mock.calls.length;
    const eventsBefore = eventLoader.mock.calls.length;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange')); });
    expect(taskLoader).toHaveBeenCalledTimes(tasksBefore);
    expect(sessionLoader).toHaveBeenCalledTimes(sessionsBefore);
    expect(eventLoader).toHaveBeenCalledTimes(eventsBefore);
    act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    if (fail) act(() => MockEventSource.instances[0]!.onerror?.(new Event('error')));
    await act(async () => { await vi.advanceTimersByTimeAsync(duration); });
    expect(MockEventSource.instances[0]!.closed).toBe(sources === 2);
    expect(taskLoader).toHaveBeenCalledTimes(tasksBefore);
    expect(sessionLoader).toHaveBeenCalledTimes(sessionsBefore);
    expect(eventLoader).toHaveBeenCalledTimes(eventsBefore);
    await act(async () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(MockEventSource.instances).toHaveLength(sources);
    expect(eventLoader).toHaveBeenCalledTimes(eventsBefore + 1);
    expect(taskLoader.mock.calls.length).toBe(tasksBefore + 1);
    expect(sessionLoader.mock.calls.length).toBe(sessionsBefore + 1);
    expect(eventLoader).toHaveBeenLastCalledWith('s1', { after: 1, limit: 200, direction: 'forward' }, expect.any(AbortSignal));
    expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.map(item => item.sequence)).toEqual([1, 2]);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(taskLoader).toHaveBeenCalledTimes(tasksBefore + 1);
    expect(sessionLoader).toHaveBeenCalledTimes(sessionsBefore + 1);
    expect(eventLoader).toHaveBeenCalledTimes(eventsBefore + 1);
    if (sources === 2) {
      // 新 HTTP 订阅建立后仍保留原有 open 校准，关闭订阅建立之前的竞态窗口。
      await act(async () => { MockEventSource.instances[1]!.onopen?.(new Event('open')); await vi.advanceTimersByTimeAsync(0); });
      expect(taskLoader).toHaveBeenCalledTimes(tasksBefore + 2);
      expect(sessionLoader).toHaveBeenCalledTimes(sessionsBefore + 2);
      expect(eventLoader).toHaveBeenCalledTimes(eventsBefore + 2);
      expect(eventLoader).toHaveBeenLastCalledWith('s1', { after: 2, limit: 200, direction: 'forward' }, expect.any(AbortSignal));
    }
  } finally { view.unmount(); client.clear(); vi.useRealTimers(); }
});


it('continues recovery when a second gap arrives during a short page request', async () => {
  let release!: (events: DockEvent[]) => void;
  const loader = vi.spyOn(api, 'events')
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValueOnce(Array.from({ length: 7 }, (_, index) => event(14 + index)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(10)]));
  function Harness() { useSessionStream('s1', 'r1', true); return null; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    act(() => MockEventSource.instances[0]!.emit('text', event(13)));
    act(() => MockEventSource.instances[0]!.emit('text', event(20)));
    await act(async () => release([event(11), event(12), event(13)]));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(loader).toHaveBeenLastCalledWith('s1', { after: 13, limit: 200, direction: 'forward' }, expect.any(AbortSignal));
    await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.map(item => item.sequence)).toEqual(Array.from({ length: 11 }, (_, index) => index + 10)));
  } finally { view.unmount(); client.clear(); }
});

it('keeps in-flight SSE status updates when an older sessions snapshot arrives', async () => {
  const initial = { ...session, model: 'old-model', updatedAt: '2026-10-22T00:00:00.000Z' };
  let release!: (sessions: Session[]) => void;
  vi.spyOn(api, 'sessions').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['sessions'], [initial]);
  function Harness() {
    useQuery({ queryKey: ['sessions'], queryFn: ({ signal }) => loadSessions(client, signal) });
    useSessionStream('s1', 'r1', true);
    return null;
  }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    act(() => MockEventSource.instances[0]!.emit('status', { ...event(1), type: 'status', timestamp: '2026-10-22T00:00:10.000Z', data: { state: 'thinking', reasoningEffort: 'high' } }));
    await waitFor(() => expect(client.getQueryData<Session[]>(['sessions'])?.[0]?.state).toBe('thinking'));
    await act(async () => release([{ ...initial, name: 'renamed', model: 'snapshot-model' }]));
    await waitFor(() => expect(client.getQueryState(['sessions'])?.fetchStatus).toBe('idle'));
    expect(client.getQueryData<Session[]>(['sessions'])?.[0]).toMatchObject({ state: 'thinking', updatedAt: '2026-10-22T00:00:10.000Z', name: 'renamed', model: 'snapshot-model', reasoningEffort: 'high' });
    const refreshed = client.refetchQueries({ queryKey: ['sessions'], exact: true });
    await act(async () => { release([{ ...initial, state: 'completed', updatedAt: '2026-10-22T00:00:20.000Z' }]); await refreshed; });
    expect(client.getQueryData<Session[]>(['sessions'])?.[0]).toMatchObject({ state: 'completed', updatedAt: '2026-10-22T00:00:20.000Z', model: 'old-model' });
  } finally { view.unmount(); client.clear(); }
});


it.each([
  { name: 'empty', page: [] },
  { name: 'non-advancing full', page: Array.from({ length: 200 }, () => event(10)) },
  { name: 'permanently sparse', page: [event(11)] }
])('stops bounded recovery on a $name page and retains its cursor for reconnect', async ({ page }) => {
  let release!: (events: DockEvent[]) => void;
  const loader = vi.spyOn(api, 'events')
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue(page);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(10)]));
  function Harness() { useSessionStream('s1', 'r1', true); return null; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    act(() => MockEventSource.instances[0]!.emit('text', event(13)));
    act(() => MockEventSource.instances[0]!.emit('text', event(20)));
    await act(async () => release(page));
    // A progressing short page gets one follow-up for the new gap; stationary
    // responses stop immediately even when another gap arrived in flight.
    const calls = page.length === 1 ? 2 : 1;
    expect(loader).toHaveBeenCalledTimes(calls);
    await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.at(-1)?.sequence).toBe(20));
    expect(loader).toHaveBeenCalledTimes(calls);
    act(() => MockEventSource.instances[0]!.onopen?.(new Event('open')));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(calls + 1));
    expect(loader).toHaveBeenLastCalledWith('s1', { after: page.length === 1 ? 11 : 10, limit: 200, direction: 'forward' }, expect.any(AbortSignal));
  } finally { view.unmount(); client.clear(); }
});

it('cancels a short recovery page with a queued gap when unmounted', async () => {
  let release!: (events: DockEvent[]) => void;
  const loader = vi.spyOn(api, 'events').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(10)]));
  function Harness() { useSessionStream('s1', 'r1', true); return null; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  act(() => MockEventSource.instances[0]!.emit('text', event(13)));
  act(() => MockEventSource.instances[0]!.emit('text', event(20)));
  view.unmount();
  expect(loader.mock.calls[0]?.[2]?.aborted).toBe(true);
  await act(async () => release([event(11), event(12), event(13)]));
  expect(loader).toHaveBeenCalledTimes(1);
  expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.map(item => item.sequence)).toEqual([10]);
  client.clear();
});

it('merges status fields per session while keeping newer snapshots, deletions and run changes authoritative', async () => {
  const at = (second: number) => `2026-10-22T00:00:${String(second).padStart(2, '0')}.000Z`;
  const initial = ['s1', 's2', 's3', 's4', 's5'].map(id => ({ ...session, id, model: 'old-model', reasoningEffort: 'low', updatedAt: at(0) }));
  let release!: (sessions: Session[]) => void;
  vi.spyOn(api, 'sessions').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['sessions'], initial);
  function Harness() {
    useQuery({ queryKey: ['sessions'], queryFn: ({ signal }) => loadSessions(client, signal) });
    useSessionStream('s1', 'r1', true);
    useSessionStream('s2', 'r1', true);
    useSessionStream('s3', 'r1', true);
    useSessionStream('s4', 'r1', true);
    useSessionStream('s5', 'r1', true);
    return null;
  }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    act(() => MockEventSource.instances.forEach(source => source.emit('status', { ...event(1), type: 'status', timestamp: at(10), data: { state: 'thinking', model: 'live-model', reasoningEffort: 'high' } })));
    await waitFor(() => expect(client.getQueryData<Session[]>(['sessions'])?.every(session => session.state === 'thinking')).toBe(true));
    await act(async () => release([
      { ...initial[0]!, name: 'new name', archivedAt: at(5), permissionMode: 'full-trust' },
      { ...initial[1]!, state: 'completed', model: 'newer-model', updatedAt: at(20) },
      { ...initial[3]!, runId: 'r2', state: 'starting' },
      { ...initial[4]!, state: 'idle', updatedAt: at(10) }
    ]));
    await waitFor(() => expect(client.getQueryState(['sessions'])?.fetchStatus).toBe('idle'));
    const rows = client.getQueryData<Session[]>(['sessions'])!;
    expect(rows.map(session => session.id)).toEqual(['s1', 's2', 's4', 's5']);
    expect(rows[0]).toMatchObject({ state: 'thinking', model: 'live-model', reasoningEffort: 'high', updatedAt: at(10), name: 'new name', archivedAt: at(5), permissionMode: 'full-trust' });
    expect(rows[1]).toMatchObject({ state: 'completed', model: 'newer-model', reasoningEffort: 'low', updatedAt: at(20) });
    expect(rows[2]).toMatchObject({ runId: 'r2', state: 'starting', model: 'old-model', reasoningEffort: 'low' });
    expect(rows[3]).toMatchObject({ state: 'thinking', updatedAt: at(10) });
  } finally { view.unmount(); client.clear(); }
});

it('reconnect cancels an older sessions GET and a late response cannot replace the new request', async () => {
  const initial = { ...session, updatedAt: '2026-10-22T00:00:00.000Z' };
  const releases: Array<(sessions: Session[]) => void> = [];
  const loader = vi.spyOn(api, 'sessions').mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
  vi.spyOn(api, 'events').mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['sessions'], [initial]);
  function Harness() {
    useQuery({ queryKey: ['sessions'], queryFn: ({ signal }) => loadSessions(client, signal) });
    useSessionStream('s1', 'r1', true);
    return null;
  }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    expect(loader).toHaveBeenCalledTimes(1);
    act(() => MockEventSource.instances[0]!.onopen?.(new Event('open')));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls[0]?.[0]?.aborted).toBe(true);
    expect(loader.mock.calls[1]?.[0]?.aborted).toBe(false);
    act(() => MockEventSource.instances[0]!.emit('status', { ...event(1), type: 'status', timestamp: '2026-10-22T00:00:10.000Z', data: { state: 'thinking' } }));
    await waitFor(() => expect(client.getQueryData<Session[]>(['sessions'])?.[0]?.state).toBe('thinking'));
    await act(async () => releases[0]!([initial]));
    expect(client.getQueryData<Session[]>(['sessions'])?.[0]?.state).toBe('thinking');
    await act(async () => releases[1]!([{ ...initial, name: 'latest name' }]));
    await waitFor(() => expect(client.getQueryState(['sessions'])?.fetchStatus).toBe('idle'));
    expect(client.getQueryData<Session[]>(['sessions'])?.[0]).toMatchObject({ state: 'thinking', name: 'latest name', updatedAt: '2026-10-22T00:00:10.000Z' });
    const refresh = client.refetchQueries({ queryKey: ['sessions'], exact: true });
    expect(loader).toHaveBeenCalledTimes(3);
    await act(async () => { await client.cancelQueries({ queryKey: ['sessions'], exact: true }); await refresh; });
    expect(loader.mock.calls[2]?.[0]?.aborted).toBe(true);
    await act(async () => releases[2]!([initial]));
    expect(client.getQueryData<Session[]>(['sessions'])?.[0]).toMatchObject({ state: 'thinking', name: 'latest name' });
  } finally { view.unmount(); client.clear(); }
});


it.each([['thinking', 'idle'], ['idle']])('preserves a live status that finishes in the initial state: %j', async (...states) => {
  const initial = { ...session, model: 'old-model', updatedAt: '2026-10-22T00:00:00.000Z' };
  let release!: (sessions: Session[]) => void;
  vi.spyOn(api, 'sessions').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['sessions'], [initial]);
  function Harness() {
    useQuery({ queryKey: ['sessions'], queryFn: ({ signal }) => loadSessions(client, signal) });
    useSessionStream('s1', 'r1', true);
    return null;
  }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    act(() => states.forEach((state, index) => MockEventSource.instances[0]!.emit('status', { ...event(index + 1), type: 'status', timestamp: '2026-10-22T00:00:10.000Z', data: { state, ...(index === 0 ? { model: 'live-model' } : { reasoningEffort: 'high' }) } })));
    await waitFor(() => expect(client.getQueryData<Session[]>(['sessions'])?.[0]?.model).toBe('live-model'));
    await act(async () => release([{ ...initial, state: 'thinking', name: 'latest name' }]));
    await waitFor(() => expect(client.getQueryState(['sessions'])?.fetchStatus).toBe('idle'));
    expect(client.getQueryData<Session[]>(['sessions'])?.[0]).toMatchObject({ state: 'idle', model: 'live-model', name: 'latest name', updatedAt: '2026-10-22T00:00:10.000Z' });
  } finally { view.unmount(); client.clear(); }
});


it.each([
  { delivery: 'separate frames', values: ['model-b', 'model-a'] },
  { delivery: 'same frame', values: ['model-b', 'model-a'] },
  { delivery: 'same explicit value', values: ['model-a'] }
])('keeps explicit model/effort updates returning to their initial values: $delivery', async ({ delivery, values }) => {
  const initial = { ...session, model: 'model-a', reasoningEffort: 'low', updatedAt: '2026-10-22T00:00:00.000Z' };
  let release!: (sessions: Session[]) => void;
  vi.spyOn(api, 'sessions').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['sessions'], [initial]);
  function Harness() {
    useQuery({ queryKey: ['sessions'], queryFn: ({ signal }) => loadSessions(client, signal) });
    useSessionStream('s1', 'r1', true);
    return null;
  }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  const status = (model: string, index: number): DockEvent => ({ ...event(index + 1), type: 'status', timestamp: `2026-10-22T00:00:0${index + 2}.000Z`, data: { state: 'idle', model, reasoningEffort: model === 'model-a' ? 'low' : 'high' } });
  try {
    for (const [index, model] of values.entries()) {
      act(() => MockEventSource.instances[0]!.emit('status', status(model, index)));
      if (delivery === 'separate frames') await waitFor(() => expect(client.getQueryData<Session[]>(['sessions'])?.[0]?.updatedAt).toBe(status(model, index).timestamp));
    }
    await waitFor(() => expect(client.getQueryData<Session[]>(['sessions'])?.[0]?.updatedAt).toBe(status('model-a', values.length - 1).timestamp));
    await act(async () => release([{ ...initial, model: 'model-b', reasoningEffort: 'high', updatedAt: '2026-10-22T00:00:01.000Z' }]));
    await waitFor(() => expect(client.getQueryState(['sessions'])?.fetchStatus).toBe('idle'));
    expect(client.getQueryData<Session[]>(['sessions'])?.[0]).toMatchObject({ model: 'model-a', reasoningEffort: 'low', updatedAt: status('model-a', values.length - 1).timestamp });
  } finally { view.unmount(); client.clear(); }
});

it('preserves model/effort mutation responses returning to initial values during a GET', async () => {
  const initial = { ...session, model: 'model-a', reasoningEffort: 'low', updatedAt: '2026-10-22T00:00:00.000Z' };
  let release!: (sessions: Session[]) => void;
  vi.spyOn(api, 'sessions').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const client = new QueryClient();
  client.setQueryData(['sessions'], [initial]);
  const pending = loadSessions(client, new AbortController().signal);
  client.setQueryData(['sessions'], [{ ...initial, model: 'model-b', reasoningEffort: 'high', updatedAt: '2026-10-22T00:00:01.000Z' }]);
  const latest = { ...initial, updatedAt: '2026-10-22T00:00:02.000Z' };
  client.setQueryData(['sessions'], [latest]);
  release([{ ...initial, model: 'model-b', reasoningEffort: 'high', updatedAt: '2026-10-22T00:00:01.000Z' }]);
  expect((await pending)[0]).toMatchObject({ model: 'model-a', reasoningEffort: 'low', updatedAt: latest.updatedAt });
  client.clear();
});


describe('sessions request observer cleanup', () => {
  const initial = { ...session, model: 'model-a', reasoningEffort: 'low', updatedAt: '2026-10-22T00:00:02.000Z' };
  const intermediate = { ...initial, model: 'model-b', reasoningEffort: 'high', updatedAt: '2026-10-22T00:00:01.000Z' };
  const sameValue: DockEvent = { ...event(1), type: 'status', timestamp: initial.updatedAt, data: { state: 'idle', model: 'model-a', reasoningEffort: 'low' } };
  function trackSubscriptions(client: QueryClient) {
    const cache = client.getQueryCache();
    const subscribe = cache.subscribe.bind(cache);
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(cache, 'subscribe').mockImplementation(listener => {
      const stop = vi.fn(subscribe(listener));
      stops.push(stop);
      return stop;
    });
    return stops;
  }

  it('unsubscribes immediately on cancel and an old late response leaves the next request observer active', async () => {
    const releases: Array<(sessions: Session[]) => void> = [];
    vi.spyOn(api, 'sessions').mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
    const client = new QueryClient();
    client.setQueryData(['sessions'], [initial]);
    const stops = trackSubscriptions(client);
    const controller = new AbortController();
    const oldRequest = loadSessions(client, controller.signal);
    const rejected = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    expect(stops[0]).toHaveBeenCalledTimes(1);
    const newRequest = loadSessions(client, new AbortController().signal);
    releases[0]!([intermediate]);
    await rejected;
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();
    // All values equal the cached row: only the explicit-field observer can
    // protect this update, independent of Query's structural sharing.
    recordSessionStatusUpdates(client, initial, [sameValue]);
    releases[1]!([intermediate]);
    expect((await newRequest)[0]).toMatchObject({ model: 'model-a', reasoningEffort: 'low' });
    expect(stops[1]).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('unsubscribes on failure and never carries the failed request fields into the next GET', async () => {
    let fail!: (error: Error) => void;
    vi.spyOn(api, 'sessions')
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValueOnce([intermediate]);
    const client = new QueryClient();
    client.setQueryData(['sessions'], [initial]);
    const stops = trackSubscriptions(client);
    const failed = loadSessions(client, new AbortController().signal);
    recordSessionStatusUpdates(client, initial, [sameValue]);
    fail(new Error('offline'));
    await expect(failed).rejects.toThrow('offline');
    expect(stops[0]).toHaveBeenCalledTimes(1);
    const result = await loadSessions(client, new AbortController().signal);
    expect(result[0]).toMatchObject({ model: 'model-b', reasoningEffort: 'high' });
    expect(stops[1]).toHaveBeenCalledTimes(1);
    client.clear();
  });
});

it.each(['open', 'task'])('retains a lone %s refresh while the initial tasks GET is pending', async trigger => {
  vi.spyOn(api, 'events').mockResolvedValue([]);
  let release!: (tasks: Task[]) => void;
  const task: Task = { id: 't1', sessionId: 's1', prompt: 'repair', status: 'running', createdAt: '', updatedAt: '' };
  const latest = { ...task, status: 'completed' };
  const loader = vi.fn().mockImplementationOnce(() => new Promise<Task[]>(resolve => { release = resolve; })).mockResolvedValue([latest]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() { useQuery({ queryKey: ['tasks', 's1'], queryFn: loader }); useSessionStream('s1', 'r1', true); return null; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    act(() => {
      if (trigger === 'open') MockEventSource.instances[0]!.onopen?.(new Event('open'));
      else MockEventSource.instances[0]!.emit('task', { ...event(1), type: 'task', data: { task: { id: task.id, status: latest.status } } });
    });
    if (trigger === 'task') await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events).toHaveLength(1));
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => release([task]));
    await waitFor(() => expect(client.getQueryData(['tasks', 's1'])).toEqual([latest]));
    expect(loader).toHaveBeenCalledTimes(2);
  } finally { view.unmount(); client.clear(); }
});

it('coalesces task bursts into one follow-up per in-flight GET without cancelling it', async () => {
  const releases: Array<(tasks: Task[]) => void> = [];
  const signals: AbortSignal[] = [];
  const loader = vi.fn(({ signal }: { signal: AbortSignal }) => {
    signals.push(signal);
    return new Promise<Task[]>(resolve => { releases.push(resolve); });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() { useQuery({ queryKey: ['tasks', 's1'], queryFn: loader }); useSessionStream('s1', 'r1', true); return null; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  const burst = async (start: number) => {
    act(() => {
      for (let sequence = start; sequence < start + 10; sequence += 1) {
        MockEventSource.instances[0]!.emit('task', { ...event(sequence), type: 'task', data: { task: { id: 't1', status: 'completed', revision: sequence } } });
      }
    });
    await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.at(-1)?.sequence).toBe(start + 9));
  };
  try {
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    await burst(1);
    await burst(11);
    expect(loader).toHaveBeenCalledTimes(1);
    await act(async () => releases[0]!([]));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await burst(21);
    await burst(31);
    expect(loader).toHaveBeenCalledTimes(2);
    await act(async () => releases[1]!([]));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
    await act(async () => releases[2]!([]));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(loader).toHaveBeenCalledTimes(3);
    expect(signals.every(signal => !signal.aborted)).toBe(true);
  } finally { view.unmount(); client.clear(); }
});

it('stops after a failed follow-up and retries on a later task event', async () => {
  let reject!: (error: Error) => void;
  const loader = vi.fn().mockImplementationOnce(() => new Promise<Task[]>((_resolve, fail) => { reject = fail; }))
    .mockRejectedValueOnce(new Error('still offline')).mockResolvedValue([]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() { useQuery({ queryKey: ['tasks', 's1'], queryFn: loader }); useSessionStream('s1', 'r1', true); return null; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  const emit = (sequence: number) => act(() => MockEventSource.instances[0]!.emit('task', { ...event(sequence), type: 'task', data: { task: { id: 't1', status: 'completed' } } }));
  try {
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    emit(1);
    await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events).toHaveLength(1));
    await act(async () => reject(new Error('offline')));
    await waitFor(() => expect(client.getQueryState(['tasks', 's1'])?.error?.message).toBe('still offline'));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(client.isFetching()).toBe(0);
    emit(2);
    await waitFor(() => expect(client.getQueryState(['tasks', 's1'])?.status).toBe('success'));
    expect(loader).toHaveBeenCalledTimes(3);
  } finally { view.unmount(); client.clear(); }
});

it.each(['unmount', 'switch'])('discards queued task refreshes on %s', async action => {
  vi.spyOn(api, 'events').mockResolvedValue([]);
  let release!: (tasks: Task[]) => void;
  const loader = vi.fn().mockImplementation((id: string) => id === 's1' ? new Promise<Task[]>(resolve => { release = resolve; }) : Promise.resolve([]));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness({ id }: { id: string }) { useQuery({ queryKey: ['tasks', id], queryFn: () => loader(id) }); useSessionStream(id, 'r1', true); return null; }
  const renderSession = (id: string) => <QueryClientProvider client={client}><Harness id={id}/></QueryClientProvider>;
  const view = render(renderSession('s1'));
  try {
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    act(() => MockEventSource.instances[0]!.onopen?.(new Event('open')));
    if (action === 'unmount') view.unmount();
    else {
      view.rerender(renderSession('s2'));
      await waitFor(() => expect(loader).toHaveBeenCalledWith('s2'));
      act(() => MockEventSource.instances[1]!.onopen?.(new Event('open')));
    }
    await act(async () => release([]));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(loader.mock.calls.filter(([id]) => id === 's1')).toHaveLength(1);
    if (action === 'switch') expect(client.getQueryData(['tasks', 's2'])).toEqual([]);
  } finally { view.unmount(); client.clear(); }
});

it('does not report ready until pages and both authoritative snapshots have been applied', async () => {
  let releaseEvents!: (events: DockEvent[]) => void, releaseTasks!: (tasks: Task[]) => void, releaseSessions!: (sessions: Session[]) => void;
  vi.spyOn(api, 'events').mockImplementationOnce(() => new Promise(resolve => { releaseEvents = resolve; }));
  const taskLoader = vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(() => new Promise<Task[]>(resolve => { releaseTasks = resolve; }));
  const sessionLoader = vi.fn().mockResolvedValueOnce([session]).mockImplementationOnce(() => new Promise<Session[]>(resolve => { releaseSessions = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(10)]));
  function Harness() { useQuery({ queryKey: ['tasks', 's1'], queryFn: taskLoader }); useQuery({ queryKey: ['sessions'], queryFn: sessionLoader }); const state = useSessionStream('s1', 'r1', true); return <span>{state.transport}:{state.content}</span>; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  await waitFor(() => expect(client.isFetching()).toBe(0));
  act(() => MockEventSource.instances[0]!.onopen?.(new Event('open')));
  await screen.findByText('open:catching_up');
  await act(async () => releaseEvents([event(11)]));
  expect(screen.getByText('open:catching_up')).toBeTruthy();
  await act(async () => releaseTasks([]));
  expect(screen.getByText('open:catching_up')).toBeTruthy();
  await act(async () => releaseSessions([session]));
  await screen.findByText('open:ready');
  view.unmount(); client.clear();
});

it('retries without a new SSE event, bounds automatic attempts and lets the user retry the preserved cursor', async () => {
  vi.useFakeTimers();
  const loader = vi.spyOn(api, 'events').mockRejectedValue(new Error('offline'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(10)]));
  function Harness() { const state = useSessionStream('s1', 'r1', true); return <button onClick={state.retry}>{state.transport}:{state.content}:{String(state.retrying)}</button>; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    await act(async () => { MockEventSource.instances[0]!.onopen?.(new Event('open')); await vi.advanceTimersByTimeAsync(0); });
    expect(loader).toHaveBeenCalledTimes(1);
    for (const delay of [1000, 2000, 4000, 8000, 16000]) await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    expect(loader).toHaveBeenCalledTimes(6);
    expect(screen.getByText('open:failed:false')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(loader).toHaveBeenCalledTimes(6);
    loader.mockResolvedValue([event(11)]);
    await act(async () => screen.getByRole('button').click());
    expect(loader).toHaveBeenLastCalledWith('s1', { after: 10, limit: 200, direction: 'forward' }, expect.any(AbortSignal));
    expect(screen.getByText('open:ready:false')).toBeTruthy();
    expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.map(item => item.sequence)).toEqual([10, 11]);
  } finally { view.unmount(); client.clear(); vi.useRealTimers(); }
});

it('keeps a gap unready when a sparse response reaches the maximum but skips a required sequence', async () => {
  vi.useFakeTimers();
  const loader = vi.spyOn(api, 'events').mockResolvedValue([event(11), event(13)]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(10)]));
  function Harness() { const state = useSessionStream('s1', 'r1', true); return <span>{state.content}</span>; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    await act(async () => { MockEventSource.instances[0]!.emit('text', event(13)); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('failed')).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(1);
    loader.mockResolvedValue([event(11), event(12), event(13)]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('ready')).toBeTruthy();
    expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.map(item => item.sequence)).toEqual([10, 11, 12, 13]);
  } finally { view.unmount(); client.clear(); vi.useRealTimers(); }
});

it('discards a hidden generation response before applying the foreground calibration', async () => {
  let hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  let release!: (events: DockEvent[]) => void;
  const loader = vi.spyOn(api, 'events').mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue([event(2)]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['events', 's1'], createEventWindow([event(1)]));
  function Harness() { const state = useSessionStream('s1', 'r1', true); return <span>{state.content}</span>; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  try {
    act(() => MockEventSource.instances[0]!.onopen?.(new Event('open')));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    expect(loader.mock.calls[0]?.[2]?.aborted).toBe(true);
    act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => release([event(2), event(3)]));
    await screen.findByText('ready');
    expect(loader).toHaveBeenCalledTimes(2);
    expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.map(item => item.sequence)).toEqual([1, 2]);
  } finally { view.unmount(); client.clear(); }
});
