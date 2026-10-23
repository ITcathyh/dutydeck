import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSE_BOOTSTRAP_STALE_MS, SSE_HIDDEN_SUSPEND_MS, SSE_STALE_MS, SessionStream, type MockableEventSource, type StreamStatus } from './sse';
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

  const makeStream = (onReconnect?: () => void) => new SessionStream({
    sessionId: 's1',
    getAfter: () => after,
    onEvent: event => { events.push(event); after = Math.max(after, event.sequence); },
    onStatus: status => statuses.push(status),
    onReconnect
  });

  beforeEach(() => {
    MockEventSource.instances = [];
    statuses = [];
    events = [];
    after = 0;
    vi.stubGlobal('EventSource', MockEventSource);
    vi.useFakeTimers();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it.each([false, true])('握手无 open/error 时在启动宽限后恢复（重连=%s）', retry => {
    const onReconnect = vi.fn();
    const stream = makeStream(onReconnect);
    stream.start();
    if (retry) { latest().fail(); vi.advanceTimersByTime(1_000); }
    const first = latest();
    const count = MockEventSource.instances.length;
    vi.advanceTimersByTime(SSE_BOOTSTRAP_STALE_MS - 1);
    expect(first.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(first.closed).toBe(true);
    first.open(); first.fail();
    first.emit('text', JSON.stringify({ sequence: 99 }));
    expect(statuses).not.toContain('open');
    expect(events).toEqual([]);
    const delay = retry ? 2_000 : 1_000;
    vi.advanceTimersByTime(delay - 1);
    expect(MockEventSource.instances).toHaveLength(count);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(count + 1);
    expect(onReconnect).toHaveBeenCalledTimes(retry ? 2 : 1);
    stream.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('握手后 open 重置启动宽限，且仅保留一个 watchdog', () => {
    const stream = makeStream();
    stream.start();
    vi.advanceTimersByTime(SSE_BOOTSTRAP_STALE_MS - 5_000);
    latest().open();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(SSE_BOOTSTRAP_STALE_MS - 1);
    expect(latest().closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(latest().closed).toBe(true);
    stream.close();
  });

  it('close 清除尚未 open 的握手 watchdog', () => {
    const stream = makeStream();
    stream.start();
    expect(vi.getTimerCount()).toBe(1);
    stream.close();
    expect(vi.getTimerCount()).toBe(0);
    latest().open(); latest().fail();
    vi.advanceTimersByTime(SSE_BOOTSTRAP_STALE_MS * 2);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(statuses).toEqual([]);
  });

  it('尚未 open 的连接在后台暂停，回前台只恢复和校准一次', () => {
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const onReconnect = vi.fn();
    const stream = makeStream(onReconnect);
    stream.start();
    const first = latest();
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(SSE_HIDDEN_SUSPEND_MS);
    expect(first.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    first.open(); first.fail();
    vi.advanceTimersByTime(SSE_BOOTSTRAP_STALE_MS * 2);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(onReconnect).not.toHaveBeenCalled();
    hidden = false; document.dispatchEvent(new Event('visibilitychange'));
    expect(MockEventSource.instances).toHaveLength(2);
    expect(onReconnect).toHaveBeenCalledOnce();
    stream.close();
    expect(vi.getTimerCount()).toBe(0);
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


describe('SessionStream 心跳与可见性', () => {
  let stream: SessionStream;
  let onEvent: ReturnType<typeof vi.fn>;
  let onStatus: ReturnType<typeof vi.fn>;
  let onReconnect: ReturnType<typeof vi.fn>;
  let hidden = false;
  const heartbeat = (ts = Date.now()) => latest().emit('heartbeat', JSON.stringify({ ts }));
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', MockEventSource);
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    onEvent = vi.fn(); onStatus = vi.fn(); onReconnect = vi.fn();
    stream = new SessionStream({ sessionId: 's1', getAfter: () => 7, onEvent, onStatus, onReconnect });
    stream.start();
    latest().open();
  });
  afterEach(() => { stream.close(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const visibility = (value: boolean) => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };

  it.each([0, 1])('在只收到 %i 帧心跳后静默的启动流上有界恢复', count => {
    if (count) heartbeat();
    vi.advanceTimersByTime(SSE_BOOTSTRAP_STALE_MS - 1);
    expect(latest().closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(latest().closed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(afterParam(latest().url)).toBe(7);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('证明实时节奏后在静默 45 秒时关闭并恢复', () => {
    heartbeat(); vi.advanceTimersByTime(15_000); heartbeat();
    vi.advanceTimersByTime(SSE_STALE_MS - 1);
    expect(latest().closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(latest().closed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it('新连接重新证明实时性，不继承旧连接的心跳证据', () => {
    heartbeat(); vi.advanceTimersByTime(15_000); heartbeat();
    latest().fail(); vi.advanceTimersByTime(1_000); latest().open();
    vi.advanceTimersByTime(SSE_STALE_MS);
    expect(latest().closed).toBe(false);
    vi.advanceTimersByTime(SSE_BOOTSTRAP_STALE_MS - SSE_STALE_MS);
    expect(latest().closed).toBe(true);
  });

  it('持续心跳保持单条连接，且心跳不进入事件缓存', () => {
    for (let i = 0; i < 40; i++) { heartbeat(); vi.advanceTimersByTime(15_000); }
    expect(MockEventSource.instances).toHaveLength(1);
    expect(latest().closed).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('服务端时间戳静止不能证明实时节奏', () => {
    heartbeat(1);
    vi.advanceTimersByTime(15_000); heartbeat(1);
    vi.advanceTimersByTime(SSE_STALE_MS);
    expect(latest().closed).toBe(false);
    vi.advanceTimersByTime(SSE_BOOTSTRAP_STALE_MS - SSE_STALE_MS);
    expect(latest().closed).toBe(true);
  });

  it('批量心跳撤销实时证明，批次间静默不触发重连', () => {
    heartbeat(); vi.advanceTimersByTime(15_000); heartbeat();
    const now = Date.now();
    heartbeat(now + 15_000); heartbeat(now + 30_000);
    vi.advanceTimersByTime(SSE_BOOTSTRAP_STALE_MS * 3);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(latest().closed).toBe(false);
  });

  it('旧 source 的事件、open、error、心跳都无副作用；重复 error 仅有一条重连', () => {
    const first = latest(); first.fail(); first.fail();
    first.open(); first.emit('text', JSON.stringify({ sequence: 99 })); first.emit('heartbeat', JSON.stringify({ ts: Date.now() }));
    expect(onStatus.mock.calls.map(([value]) => value)).toEqual(['open', 'reconnecting']);
    expect(onEvent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(MockEventSource.instances).toHaveLength(2);
    first.fail(); first.open();
    vi.advanceTimersByTime(5_000);
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it.each([
    { name: '短暂隐藏保留连接', duration: 30_000, fail: false, sources: 1 },
    { name: '长时间隐藏释放连接', duration: SSE_HIDDEN_SUSPEND_MS, fail: false, sources: 2 },
    { name: '隐藏期间连接出错', duration: 30_000, fail: true, sources: 2 }
  ])('$name：真实回前台只校准一次，重复 visible/start 不额外校准', ({ duration, fail, sources }) => {
    const first = latest();
    stream.start(); visibility(false); visibility(false);
    expect(onReconnect).not.toHaveBeenCalled();
    visibility(true);
    if (fail) first.fail();
    vi.advanceTimersByTime(duration);
    expect(onReconnect).not.toHaveBeenCalled();
    visibility(false);
    expect(MockEventSource.instances).toHaveLength(sources);
    expect(first.closed).toBe(sources === 2);
    expect(onReconnect).toHaveBeenCalledOnce();
    visibility(false); visibility(false); stream.start();
    expect(MockEventSource.instances).toHaveLength(sources);
    expect(onReconnect).toHaveBeenCalledOnce();
    visibility(true); vi.advanceTimersByTime(1_000); visibility(false);
    expect(MockEventSource.instances).toHaveLength(sources);
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it('隐藏延时释放连接，后台零重连，前台立即恢复并校准', () => {
    visibility(true);
    vi.advanceTimersByTime(SSE_HIDDEN_SUSPEND_MS - 1);
    expect(latest().closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(latest().closed).toBe(true);
    latest().fail(); vi.advanceTimersByTime(600_000);
    expect(MockEventSource.instances).toHaveLength(1);
    visibility(false);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('后台连接错误不重试，前台恢复时只连一条', () => {
    visibility(true); latest().fail(); latest().fail();
    vi.advanceTimersByTime(600_000);
    expect(MockEventSource.instances).toHaveLength(1);
    visibility(false); visibility(false);
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it('切到后台取消已排重连，短暂隐藏后保留健康连接', () => {
    visibility(true); vi.advanceTimersByTime(1_000); visibility(false);
    vi.advanceTimersByTime(SSE_HIDDEN_SUSPEND_MS);
    expect(latest().closed).toBe(false);
    latest().fail(); visibility(true);
    vi.advanceTimersByTime(600_000);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('close 清除所有计时器、可见性监听与迟到投递', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const first = latest(); visibility(true); stream.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    first.emit('text', JSON.stringify({ sequence: 9 })); first.open(); first.fail(); visibility(false);
    vi.advanceTimersByTime(600_000);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(1);
  });
});
