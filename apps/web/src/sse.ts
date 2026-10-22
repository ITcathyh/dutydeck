import { eventTypes, sessionStates } from '@dutydeck/shared';
import { withShareToken, type DockEvent, type Session } from './api';
import { instanceApiUrl } from './instance';

export const STREAM_EVENT_TYPES = eventTypes;

// SSE 连接状态：首次连接中 / 已连接 / 断线重连中
export type StreamStatus = 'connecting' | 'open' | 'reconnecting';

const validSessionStates = new Set<string>(sessionStates);

// 指数退避延迟：baseMs * 2^attempt，封顶 maxMs
export function nextBackoffDelay(attempt: number, baseMs = 1000, maxMs = 30000): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

// 已缓存事件中的最大 sequence（空缓存 / undefined → 0）
export function maxSequence(events: DockEvent[] | undefined): number {
  return (events ?? []).reduce((sequence, event) => Math.max(sequence, event.sequence), 0);
}

// 事件写入 events 缓存：空缓存 → [event]；新 sequence → 追加；同 sequence → 替换
export function mergeDockEvent(events: DockEvent[] | undefined, event: DockEvent): DockEvent[] {
  if (!events?.length) return [event];
  const existing = events.findIndex(item => item.sequence === event.sequence);
  if (existing < 0) return [...events, event];
  const next = [...events];
  next[existing] = event;
  return next;
}

// status 事件写入 session：仅合法 state 才更新；model / reasoningEffort 仅在为 string 时覆盖
export function applyStatusEvent(session: Session, event: DockEvent): Session {
  if (event.type !== 'status' || !validSessionStates.has(event.data.state)) return session;
  return {
    ...session,
    state: event.data.state,
    updatedAt: event.timestamp || session.updatedAt,
    ...(typeof event.data.model === 'string' ? { model: event.data.model } : {}),
    ...(typeof event.data.reasoningEffort === 'string' ? { reasoningEffort: event.data.reasoningEffort } : {})
  };
}

// 退避状态机：next() 返回当前 attempt 的延迟并把 attempt + 1；连接成功后 reset()
export class Backoff {
  private attemptCount = 0;
  constructor(private readonly baseMs = 1000, private readonly maxMs = 30000) {}

  next(): number {
    const delay = nextBackoffDelay(this.attemptCount, this.baseMs, this.maxMs);
    this.attemptCount += 1;
    return delay;
  }

  reset(): void {
    this.attemptCount = 0;
  }

  get attempt(): number {
    return this.attemptCount;
  }
}

// 可注入的 EventSource 形状（默认实现就是浏览器原生 EventSource；
// 回调保留 Event 参数以便与原生 onopen/onerror 类型兼容，实现侧可忽略该参数）
export type MockableEventSource = {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void;
  close(): void;
};

export type SessionStreamOptions = {
  sessionId: string;
  // 每次连接前调用，返回当前已缓存的最大 sequence 作为 after 参数
  getAfter(): number;
  onEvent(event: DockEvent): void;
  onStatus(status: StreamStatus): void;
  // 重连或恢复前台时先校准查询，不等待可能被代理缓冲的 open。
  onReconnect?(): void;
  eventSourceFactory?: (url: string) => MockableEventSource;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

export const SSE_STALE_MS = 45_000;
export const SSE_BOOTSTRAP_STALE_MS = 120_000;
export const SSE_HIDDEN_SUSPEND_MS = 60_000;
const SSE_WATCHDOG_TICK_MS = 5_000;

// SSE 连接 + 指数退避重连的核心循环（与 React 解耦，便于单测）
export class SessionStream {
  private readonly sessionId: string;
  private readonly getAfter: () => number;
  private readonly onEvent: (event: DockEvent) => void;
  private readonly onStatus: (status: StreamStatus) => void;
  private readonly eventSourceFactory: (url: string) => MockableEventSource;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly backoff = new Backoff();
  private readonly onReconnect: () => void;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private suspendTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private wasHidden = false;
  private source: MockableEventSource | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(opts: SessionStreamOptions) {
    this.sessionId = opts.sessionId;
    this.getAfter = opts.getAfter;
    this.onEvent = opts.onEvent;
    this.onStatus = opts.onStatus;
    this.onReconnect = opts.onReconnect ?? (() => {});
    this.eventSourceFactory = opts.eventSourceFactory ?? (url => new EventSource(url));
    this.setTimeoutFn = opts.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = opts.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  }

  // 首次连接（重复调用无效果）
  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.wasHidden = this.hidden();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.connect();
    this.onVisibilityChange();
  }

  close(): void {
    this.closed = true;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.clearReconnect();
    if (this.suspendTimer !== undefined) this.clearTimeoutFn(this.suspendTimer);
    this.suspendTimer = undefined;
    this.disconnect();
  }

  private hidden(): boolean {
    return typeof document !== 'undefined' && document.hidden;
  }

  private clearReconnect(): void {
    if (this.timer !== undefined) this.clearTimeoutFn(this.timer);
    this.timer = undefined;
  }

  private disconnect(): void {
    // 先撤销所有权，再关闭：close 期间或之后的迟到回调也不能生效。
    const source = this.source;
    this.source = undefined;
    source?.close();
    if (this.watchdog !== undefined) this.clearTimeoutFn(this.watchdog);
    this.watchdog = undefined;
  }

  private reconnect(): void {
    this.disconnect();
    this.onStatus('reconnecting');
    if (this.closed || this.hidden() || this.timer !== undefined) return;
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined;
      if (this.closed || this.hidden()) return;
      this.connect();
      this.onReconnect();
    }, this.backoff.next());
  }

  private onVisibilityChange = (): void => {
    if (this.closed) return;
    const hidden = this.hidden();
    const returnedToForeground = this.wasHidden && !hidden;
    this.wasHidden = hidden;
    if (hidden) {
      this.clearReconnect();
      if (this.source && this.suspendTimer === undefined) this.suspendTimer = this.setTimeoutFn(() => {
        this.suspendTimer = undefined;
        if (this.hidden()) this.disconnect();
      }, SSE_HIDDEN_SUSPEND_MS);
      return;
    }
    if (!returnedToForeground) return;
    if (this.suspendTimer !== undefined) this.clearTimeoutFn(this.suspendTimer);
    this.suspendTimer = undefined;
    if (!this.source) {
      this.clearReconnect();
      this.connect();
    }
    this.onReconnect();
  };

  private connect(): void {
    if (this.closed || this.source) return;
    const after = this.getAfter();
    const source = this.eventSourceFactory(withShareToken(instanceApiUrl(`/api/sessions/${this.sessionId}/stream?after=${after}`)));
    this.source = source;
    const current = () => !this.closed && this.source === source;
    let lastFrameAt = Date.now();
    let lastHeartbeat: { ts: number; at: number } | undefined;
    let cadence: 'unknown' | 'realtime' | 'buffered' = 'unknown';
    const watch = () => {
      if (!current()) return;
      const staleMs = cadence === 'realtime' ? SSE_STALE_MS : SSE_BOOTSTRAP_STALE_MS;
      // 两帧已证明批量缓冲的流不能用静默判死。零/一帧仍需有界恢复。
      if (!this.hidden() && cadence !== 'buffered' && Date.now() - lastFrameAt >= staleMs) {
        this.reconnect();
        return;
      }
      this.watchdog = this.setTimeoutFn(watch, SSE_WATCHDOG_TICK_MS);
    };
    source.onopen = () => {
      if (!current()) return;
      this.backoff.reset();
      lastFrameAt = Date.now();
      lastHeartbeat = undefined;
      cadence = 'unknown';
      if (this.watchdog !== undefined) this.clearTimeoutFn(this.watchdog);
      this.watchdog = this.setTimeoutFn(watch, SSE_WATCHDOG_TICK_MS);
      this.onStatus('open');
    };
    source.onerror = () => { if (current()) this.reconnect(); };
    source.addEventListener('heartbeat', message => {
      if (!current()) return;
      try {
        const { ts } = JSON.parse(message.data);
        if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
        const at = Date.now();
        if (lastHeartbeat && ts > lastHeartbeat.ts) {
          const serverDelta = ts - lastHeartbeat.ts;
          const arrivalDelta = at - lastHeartbeat.at;
          cadence = serverDelta >= 5_000 && arrivalDelta >= serverDelta / 2 && arrivalDelta <= serverDelta * 2 ? 'realtime' : 'buffered';
        }
        lastHeartbeat = { ts, at };
        lastFrameAt = at;
      } catch { /* 忽略无法解析的帧 */ }
    });
    for (const type of STREAM_EVENT_TYPES) source.addEventListener(type, message => {
      if (!current() || typeof message.data !== 'string' || !message.data) return;
      try {
        const event = JSON.parse(message.data) as DockEvent;
        lastFrameAt = Date.now();
        this.onEvent(event);
      } catch { /* 忽略无法解析的帧 */ }
    });
  }
}
