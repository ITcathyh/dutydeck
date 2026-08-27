import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockEvent, Session, Task } from './api';
import { Backoff, SessionStream, applyStatusEvent, maxSequence, mergeDockEvent, nextBackoffDelay, upsertTask, type MockableEventSource, type StreamStatus } from './sse';

const makeEvent = (sequence: number, type = 'text', data: unknown = {}): DockEvent => ({ id: `e${sequence}`, sequence, type, timestamp: '', data });
const makeSession = (overrides: Partial<Session> = {}): Session => ({ id: 's1', agentId: 'a1', state: 'idle', cwd: '/tmp', runId: 'r1', createdAt: '', updatedAt: '', ...overrides });
const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({ id, sessionId: 's1', prompt: `p-${id}`, status: 'queued', createdAt: '', updatedAt: '', ...overrides });

describe('nextBackoffDelay', () => {
  it('按 1000 * 2^attempt 增长并封顶 30000', () => {
    expect(nextBackoffDelay(0)).toBe(1000);
    expect(nextBackoffDelay(1)).toBe(2000);
    expect(nextBackoffDelay(3)).toBe(8000);
    expect(nextBackoffDelay(6)).toBe(30000);
  });

  it('支持自定义 base / max', () => {
    expect(nextBackoffDelay(2, 500, 5000)).toBe(2000);
    expect(nextBackoffDelay(10, 500, 5000)).toBe(5000);
  });
});

describe('Backoff', () => {
  it('next 序列递增、attempt 同步增长、reset 归零', () => {
    const backoff = new Backoff();
    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(1000);
    expect(backoff.attempt).toBe(1);
    expect(backoff.next()).toBe(2000);
    expect(backoff.next()).toBe(4000);
    expect(backoff.attempt).toBe(3);
    backoff.reset();
    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(1000);
  });

  it('支持自定义 base / max 并封顶', () => {
    const backoff = new Backoff(500, 5000);
    expect(backoff.next()).toBe(500);
    expect(backoff.next()).toBe(1000);
    expect(backoff.next()).toBe(2000);
    expect(backoff.next()).toBe(4000);
    expect(backoff.next()).toBe(5000);
  });
});

describe('maxSequence', () => {
  it('空缓存 / undefined → 0', () => {
    expect(maxSequence(undefined)).toBe(0);
    expect(maxSequence([])).toBe(0);
  });

  it('取最大 sequence', () => {
    expect(maxSequence([makeEvent(5), makeEvent(12), makeEvent(3)])).toBe(12);
  });
});

describe('mergeDockEvent', () => {
  it('空缓存 → [event]', () => {
    expect(mergeDockEvent(undefined, makeEvent(1))).toEqual([makeEvent(1)]);
    expect(mergeDockEvent([], makeEvent(1))).toEqual([makeEvent(1)]);
  });

  it('新 sequence → 追加', () => {
    expect(mergeDockEvent([makeEvent(1), makeEvent(3)], makeEvent(2))).toEqual([makeEvent(1), makeEvent(3), makeEvent(2)]);
  });

  it('同 sequence → 替换（长度不变）', () => {
    const merged = mergeDockEvent([makeEvent(1), makeEvent(2)], makeEvent(2));
    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual(makeEvent(2));
  });

  it('同 sequence 不同内容 → 替换为新内容', () => {
    const updated = makeEvent(2, 'text', { text: 'new' });
    const merged = mergeDockEvent([makeEvent(1), makeEvent(2, 'text', { text: 'old' })], updated);
    expect(merged[1]).toEqual(updated);
  });
});

describe('applyStatusEvent', () => {
  it('合法 state → 更新 state，保留其它字段', () => {
    const result = applyStatusEvent(makeSession({ model: 'gpt-x' }), makeEvent(1, 'status', { state: 'thinking' }));
    expect(result.state).toBe('thinking');
    expect(result.model).toBe('gpt-x');
  });

  it('model 为 string → 覆盖', () => {
    const result = applyStatusEvent(makeSession({ model: 'gpt-x' }), makeEvent(1, 'status', { state: 'idle', model: 'gpt-y' }));
    expect(result.model).toBe('gpt-y');
  });

  it('model 为非 string → 不覆盖', () => {
    const result = applyStatusEvent(makeSession({ model: 'gpt-x' }), makeEvent(1, 'status', { state: 'idle', model: 42 }));
    expect(result.model).toBe('gpt-x');
  });

  it('reasoningEffort 为 string → 覆盖', () => {
    const result = applyStatusEvent(makeSession(), makeEvent(1, 'status', { state: 'idle', reasoningEffort: 'high' }));
    expect(result.reasoningEffort).toBe('high');
  });

  it('非 status 事件 → 原样返回（同一引用）', () => {
    const original = makeSession();
    expect(applyStatusEvent(original, makeEvent(1, 'text', { state: 'thinking' }))).toBe(original);
  });

  it('不认识的 state → 原样返回（同一引用）', () => {
    const original = makeSession();
    expect(applyStatusEvent(original, makeEvent(1, 'status', { state: 'bogus' }))).toBe(original);
  });
});

describe('upsertTask', () => {
  it('空缓存 → [task]', () => {
    expect(upsertTask(undefined, makeTask('t1'))).toEqual([makeTask('t1')]);
    expect(upsertTask([], makeTask('t1'))).toEqual([makeTask('t1')]);
  });

  it('同 id → 替换（去重后追加到末尾，与 App.tsx 原逻辑一致）', () => {
    const updated = makeTask('t1', { status: 'running' });
    const result = upsertTask([makeTask('t1'), makeTask('t2')], updated);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(makeTask('t2'));
    expect(result[1]).toEqual(updated);
  });

  it('不同 id → 追加', () => {
    expect(upsertTask([makeTask('t1')], makeTask('t2'))).toEqual([makeTask('t1'), makeTask('t2')]);
  });
});

// 模拟 EventSource（node 环境没有原生实现）；默认工厂走全局 EventSource，用 stubGlobal 注入
class MockEventSource implements MockableEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, (message: MessageEvent<string>) => void>();

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: string): void {
    this.listeners.get(type)?.({ data } as MessageEvent<string>);
  }

  close(): void {
    this.closed = true;
  }
}

describe('SessionStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const makeStream = (overrides: { getAfter?: () => number; onEvent?: (event: DockEvent) => void } = {}) => {
    const statuses: StreamStatus[] = [];
    const events: DockEvent[] = [];
    const stream = new SessionStream({
      sessionId: 's1',
      getAfter: overrides.getAfter ?? (() => 7),
      onEvent: overrides.onEvent ?? (event => events.push(event)),
      onStatus: status => statuses.push(status)
    });
    return { stream, statuses, events };
  };

  it('首次连接 URL 含 after，onopen 后状态变 open 并收到事件', () => {
    const { stream, statuses, events } = makeStream();
    stream.start();
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/sessions/s1/stream?after=7');
    MockEventSource.instances[0].onopen?.();
    expect(statuses).toEqual(['open']);
    MockEventSource.instances[0].emit('text', JSON.stringify(makeEvent(8)));
    expect(events).toEqual([makeEvent(8)]);
    stream.close();
  });

  it('忽略无法解析的帧', () => {
    const { stream, events } = makeStream();
    stream.start();
    MockEventSource.instances[0].emit('text', 'not-json');
    MockEventSource.instances[0].emit('text', '');
    expect(events).toHaveLength(0);
    stream.close();
  });

  it('onerror 后状态 reconnecting，退避 1000ms 后重连', () => {
    const { stream, statuses } = makeStream();
    stream.start();
    const first = MockEventSource.instances[0];
    first.onerror?.();
    expect(first.closed).toBe(true);
    expect(statuses).toEqual(['reconnecting']);
    expect(MockEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(MockEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].url).toBe('/api/sessions/s1/stream?after=7');
    stream.close();
  });

  it('连续断线退避递增（1000 → 2000 → 4000），重连成功后 reset', () => {
    const { stream } = makeStream();
    stream.start();
    MockEventSource.instances[0].onerror?.();
    vi.advanceTimersByTime(1000);
    expect(MockEventSource.instances).toHaveLength(2);
    MockEventSource.instances[1].onerror?.();
    vi.advanceTimersByTime(1999);
    expect(MockEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(3);
    MockEventSource.instances[2].onerror?.();
    vi.advanceTimersByTime(4000);
    expect(MockEventSource.instances).toHaveLength(4);
    // 重连成功 → 退避归零，下一次断线仍从 1000ms 起
    MockEventSource.instances[3].onopen?.();
    MockEventSource.instances[3].onerror?.();
    vi.advanceTimersByTime(1000);
    expect(MockEventSource.instances).toHaveLength(5);
    stream.close();
  });

  it('重连时重新计算 after', () => {
    let after = 7;
    const { stream } = makeStream({ getAfter: () => after });
    stream.start();
    after = 42;
    MockEventSource.instances[0].onerror?.();
    vi.advanceTimersByTime(1000);
    expect(MockEventSource.instances[1].url).toBe('/api/sessions/s1/stream?after=42');
    stream.close();
  });

  it('close 后不再重连', () => {
    const { stream } = makeStream();
    stream.start();
    MockEventSource.instances[0].onerror?.();
    stream.close();
    vi.advanceTimersByTime(60_000);
    expect(MockEventSource.instances).toHaveLength(1);
  });
});
