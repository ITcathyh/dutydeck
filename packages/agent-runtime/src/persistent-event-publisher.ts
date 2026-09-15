import type { AgentEvent } from '@dutydeck/shared';

export interface PersistentEventSource {
  highWaterMark(sessionId: string): number;
  listWindow(
    sessionId: string,
    options: { afterSequence: number; limit: number }
  ): Promise<AgentEvent[]>;
}

export interface SubscribeOptions {
  afterSequence?: number;
}

export type EventListener = (event: AgentEvent) => void | Promise<void>;
export type ErrorHandler = (error: unknown, sessionId: string) => void;

interface Subscription {
  readonly sessionId: string;
  readonly listener: EventListener;
  cursor: number;
  active: boolean;
  draining: boolean;
  pendingWake: boolean;
}

function cloneEvent<T>(event: AgentEvent<T>): AgentEvent<T> {
  if (typeof structuredClone === 'function') {
    return structuredClone(event);
  }
  return JSON.parse(JSON.stringify(event));
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

const PAGE_SIZE = 200;
const POLL_INTERVAL_MS = 1000;

export class PersistentEventPublisher {
  private readonly subscriptionsBySession = new Map<string, Set<Subscription>>();
  private readonly inFlightDrains = new Set<Promise<void>>();
  private pollTimer?: NodeJS.Timeout;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly source: PersistentEventSource,
    private readonly onError?: ErrorHandler
  ) {}

  subscribe(
    sessionId: string,
    listener: EventListener,
    options?: SubscribeOptions
  ): () => void {
    if (this.closed) {
      throw new Error('PersistentEventPublisher is closed');
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new TypeError('sessionId must be a non-empty string');
    }
    if (typeof listener !== 'function') {
      throw new TypeError('listener must be a function');
    }

    let cursor: number;
    if (options?.afterSequence !== undefined) {
      const afterSeq = options.afterSequence;
      if (typeof afterSeq !== 'number' || !Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        throw new RangeError('options.afterSequence must be a non-negative safe integer');
      }
      cursor = afterSeq;
    } else {
      cursor = this.source.highWaterMark(sessionId);
      if (this.closed) {
        throw new Error('PersistentEventPublisher is closed');
      }
    }

    const sub: Subscription = {
      sessionId,
      listener,
      cursor,
      active: true,
      draining: false,
      pendingWake: false
    };

    let sessionSubs = this.subscriptionsBySession.get(sessionId);
    if (!sessionSubs) {
      sessionSubs = new Set<Subscription>();
      this.subscriptionsBySession.set(sessionId, sessionSubs);
    }
    sessionSubs.add(sub);

    this.ensurePollTimer();

    if (options?.afterSequence !== undefined) {
      this.wakeSubscription(sub);
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      sub.active = false;
      this.removeSubscription(sub);
    };
  }

  wake(sessionId: string): void {
    if (this.closed) return;
    if (typeof sessionId !== 'string' || !sessionId) return;
    const subs = this.subscriptionsBySession.get(sessionId);
    if (!subs || subs.size === 0) return;

    for (const sub of subs) {
      if (sub.active) {
        this.wakeSubscription(sub);
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    this.closePromise = (async () => {
      while (this.inFlightDrains.size > 0) {
        await Promise.allSettled([...this.inFlightDrains]);
      }
      this.subscriptionsBySession.clear();
    })();

    return this.closePromise;
  }

  private ensurePollTimer(): void {
    if (this.pollTimer !== undefined || this.closed || this.subscriptionsBySession.size === 0) {
      return;
    }
    this.pollTimer = setInterval(() => this.pollActiveSessions(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  private removeSubscription(sub: Subscription): void {
    const sessionSubs = this.subscriptionsBySession.get(sub.sessionId);
    if (sessionSubs) {
      sessionSubs.delete(sub);
      if (sessionSubs.size === 0) {
        this.subscriptionsBySession.delete(sub.sessionId);
      }
    }

    if (this.subscriptionsBySession.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private pollActiveSessions(): void {
    if (this.closed || this.subscriptionsBySession.size === 0) return;
    const sessionIds = Array.from(this.subscriptionsBySession.keys());
    for (const sessionId of sessionIds) {
      this.wake(sessionId);
    }
  }

  private wakeSubscription(sub: Subscription): void {
    if (!sub.active || this.closed) return;

    if (sub.draining) {
      sub.pendingWake = true;
      return;
    }

    sub.draining = true;

    let drainResolve!: () => void;
    const drainPromise = new Promise<void>((resolve) => {
      drainResolve = resolve;
    });
    this.inFlightDrains.add(drainPromise);

    (async () => {
      try {
        await this.drainSubscription(sub);
      } catch (err) {
        this.safeReportError(err, sub.sessionId);
      } finally {
        sub.draining = false;
        this.inFlightDrains.delete(drainPromise);
        drainResolve();
        if (sub.pendingWake && sub.active && !this.closed) {
          sub.pendingWake = false;
          this.wakeSubscription(sub);
        }
      }
    })().catch((err) => {
      this.safeReportError(err, sub.sessionId);
    });
  }

  private async drainSubscription(sub: Subscription): Promise<void> {
    while (sub.active && !this.closed) {
      let events: AgentEvent[];
      try {
        events = await this.source.listWindow(sub.sessionId, {
          afterSequence: sub.cursor,
          limit: PAGE_SIZE
        });
      } catch (err) {
        this.safeReportError(err, sub.sessionId);
        sub.pendingWake = false;
        break;
      }

      if (!sub.active || this.closed) {
        break;
      }

      if (!events || events.length === 0) {
        if (sub.pendingWake) {
          sub.pendingWake = false;
          await yieldEventLoop();
          continue;
        }
        break;
      }

      const sortedEvents = events.slice().sort((a, b) => a.sequence - b.sequence);
      let listenerFailed = false;

      for (const event of sortedEvents) {
        if (!sub.active || this.closed) {
          break;
        }

        const deliveredEvent = cloneEvent(event);
        try {
          const result = sub.listener(deliveredEvent);
          if (result && typeof (result as Promise<void>).then === 'function') {
            await result;
          }
        } catch (listenerError) {
          this.safeReportError(listenerError, sub.sessionId);
          listenerFailed = true;
          break;
        }

        sub.cursor = event.sequence;
      }

      if (listenerFailed) {
        sub.pendingWake = false;
        break;
      }

      if (!sub.active || this.closed) {
        break;
      }

      await yieldEventLoop();

      if (sortedEvents.length < PAGE_SIZE) {
        if (sub.pendingWake) {
          sub.pendingWake = false;
          continue;
        }
        break;
      } else {
        if (sub.pendingWake) {
          sub.pendingWake = false;
        }
      }
    }
  }

  private safeReportError(error: unknown, sessionId: string): void {
    if (!this.onError) return;
    try {
      const maybePromise = this.onError(error, sessionId) as any;
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
    } catch {
      // Ignore synchronous exceptions from onError
    }
  }
}
