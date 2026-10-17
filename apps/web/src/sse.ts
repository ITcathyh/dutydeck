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
  eventSourceFactory?: (url: string) => MockableEventSource;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

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
  private source: MockableEventSource | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(opts: SessionStreamOptions) {
    this.sessionId = opts.sessionId;
    this.getAfter = opts.getAfter;
    this.onEvent = opts.onEvent;
    this.onStatus = opts.onStatus;
    this.eventSourceFactory = opts.eventSourceFactory ?? (url => new EventSource(url));
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  }

  // 首次连接（重复调用无效果）
  start(): void {
    if (this.closed || this.source) return;
    this.connect();
  }

  // 关 source + 清 timer，之后不再重连
  close(): void {
    this.closed = true;
    if (this.timer !== undefined) this.clearTimeoutFn(this.timer);
    this.source?.close();
    this.source = undefined;
    this.timer = undefined;
  }

  private connect(): void {
    if (this.closed) return;
    // 重连时重新取缓存最新 maxSequence（双保险；原生 EventSource 同时会自动带 Last-Event-ID header）
    const after = this.getAfter();
    const source = this.eventSourceFactory(withShareToken(instanceApiUrl(`/api/sessions/${this.sessionId}/stream?after=${after}`)));
    this.source = source;
    source.onopen = () => {
      if (this.closed) return;
      this.backoff.reset();
      this.onStatus('open');
    };
    source.onerror = () => {
      if (this.closed) return;
      source.close();
      this.onStatus('reconnecting');
      this.timer = this.setTimeoutFn(() => this.connect(), this.backoff.next());
    };
    for (const type of STREAM_EVENT_TYPES) source.addEventListener(type, this.receive);
  }

  // 与 App.tsx receive() 的解析逻辑一致：非字符串 / 空串 / JSON 解析失败的帧直接忽略
  private receive = (message: MessageEvent<string>): void => {
    if (typeof message.data !== 'string' || !message.data) return;
    try {
      this.onEvent(JSON.parse(message.data) as DockEvent);
    } catch {
      // 忽略无法解析的帧
    }
  };
}
