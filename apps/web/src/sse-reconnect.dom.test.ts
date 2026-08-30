import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStream, type MockableEventSource, type StreamStatus } from './sse';
import type { DockEvent } from './api';

// 已有的 sse.test.ts 覆盖了退避的基本递增；这里补的是重连**时序**上的边界：
// 定时器串行性、退避封顶、close 竞态、事件在重连后继续投递。
// 这些回归的典型症状是「断线后疯狂重连打爆服务端」或「重连后事件丢失」，
// 单看 nextBackoffDelay 的纯函数测试是发现不了的。

class MockEventSource implements MockableEventSource {
  static instances: MockEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
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

  fail(): void {
    this.onerror?.(new Event('error'));
  }

  open(): void {
    this.onopen?.(new Event('open'));
  }

  close(): void {
    this.closed = true;
  }
}

const latest = () => MockEventSource.instances.at(-1)!;
const afterParam = (url: string) => Number(new URL(url, 'http://localhost').searchParams.get('after'));

describe('SessionStream 重连时序', () => {
  let statuses: StreamStatus[];
  let events: DockEvent[];
  let after: number;

  const makeStream = () => new SessionStream({
    sessionId: 's1',
    getAfter: () => after,
    onEvent: event => { events.push(event); after = Math.max(after, event.sequence); },
    onStatus: status => statuses.push(status)
  });

  beforeEach(() => {
    MockEventSource.instances = [];
    statuses = [];
    events = [];
    after = 0;
    vi.stubGlobal('EventSource', MockEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('完整退避序列 1s→2s→4s→8s→16s→30s→30s，且封顶后不再增长', () => {
    const stream = makeStream();
    stream.start();
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];
    for (const [index, delay] of expected.entries()) {
      latest().fail();
      // 差 1ms 时还不能重连——否则说明退避被缩短了
      vi.advanceTimersByTime(delay - 1);
      expect(MockEventSource.instances).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(MockEventSource.instances).toHaveLength(index + 2);
    }
    stream.close();
  });

  it('每次失败只排一个重连定时器：推进很长时间也只多出一条连接', () => {
    const stream = makeStream();
    stream.start();
    latest().fail();
    vi.advanceTimersByTime(120_000);
    expect(MockEventSource.instances).toHaveLength(2);
    stream.close();
  });

  it('失败的连接被显式 close，不泄漏旧 EventSource', () => {
    const stream = makeStream();
    stream.start();
    const first = latest();
    first.fail();
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(latest()).not.toBe(first);
    expect(latest().closed).toBe(false);
    stream.close();
  });

  it('重连成功（onopen）后退避归零，下一次断线仍从 1s 起', () => {
    const stream = makeStream();
    stream.start();
    latest().fail();
    vi.advanceTimersByTime(1_000);
    latest().fail();
    vi.advanceTimersByTime(2_000);
    // 此时退避已到 4s；一次成功连接后应重新从 1s 开始
    latest().open();
    latest().fail();
    vi.advanceTimersByTime(999);
    expect(MockEventSource.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(4);
    stream.close();
  });

  it('状态序列：open → 断线 reconnecting → 重连成功再 open', () => {
    const stream = makeStream();
    stream.start();
    latest().open();
    latest().fail();
    vi.advanceTimersByTime(1_000);
    latest().open();
    expect(statuses).toEqual(['open', 'reconnecting', 'open']);
    stream.close();
  });

  it('重连 URL 带上重连前收到的最大 sequence，避免重复拉取已有事件', () => {
    const stream = makeStream();
    stream.start();
    expect(afterParam(latest().url)).toBe(0);
    latest().open();
    latest().emit('text', JSON.stringify({ id: 'e1', sequence: 12, type: 'text', timestamp: '', data: {} }));
    latest().fail();
    vi.advanceTimersByTime(1_000);
    expect(afterParam(latest().url)).toBe(12);
    stream.close();
  });

  it('重连后新连接继续投递事件（监听器在每次 connect 都重新注册）', () => {
    const stream = makeStream();
    stream.start();
    latest().fail();
    vi.advanceTimersByTime(1_000);
    latest().emit('completed', JSON.stringify({ id: 'e2', sequence: 20, type: 'completed', timestamp: '', data: {} }));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('completed');
    stream.close();
  });

  it('close 会清掉已排队的重连定时器：之后不再产生任何连接', () => {
    const stream = makeStream();
    stream.start();
    latest().fail();
    vi.advanceTimersByTime(500);
    stream.close();
    vi.advanceTimersByTime(600_000);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('close 之后到达的 onerror 不会重新排定时器（关闭竞态）', () => {
    const stream = makeStream();
    stream.start();
    const source = latest();
    stream.close();
    source.fail();
    vi.advanceTimersByTime(60_000);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(statuses).not.toContain('reconnecting');
  });

  it('close 之后的 onopen 不会上报 open 状态', () => {
    const stream = makeStream();
    stream.start();
    const source = latest();
    stream.close();
    source.open();
    expect(statuses).toEqual([]);
  });

  it('start 幂等：重复调用不会开出第二条连接', () => {
    const stream = makeStream();
    stream.start();
    stream.start();
    stream.start();
    expect(MockEventSource.instances).toHaveLength(1);
    stream.close();
  });

  it('close 后 start 不再重新连接', () => {
    const stream = makeStream();
    stream.close();
    stream.start();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('所有 STREAM_EVENT_TYPES 在每条连接上都注册了监听器', () => {
    const stream = makeStream();
    stream.start();
    for (const type of ['text', 'thinking', 'tool_call', 'tool_result', 'permission_request', 'status', 'task', 'error', 'completed', 'raw_terminal']) {
      latest().emit(type, JSON.stringify({ id: `e-${type}`, sequence: 1, type, timestamp: '', data: {} }));
    }
    expect(events.map(event => event.type)).toEqual(['text', 'thinking', 'tool_call', 'tool_result', 'permission_request', 'status', 'task', 'error', 'completed', 'raw_terminal']);
    stream.close();
  });
});
