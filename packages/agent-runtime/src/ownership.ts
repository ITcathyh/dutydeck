import { AsyncLocalStorage } from 'node:async_hooks';
import { RuntimeError } from '@dutydeck/shared';

export class RevokedOperation extends RuntimeError {
  constructor() { super('OPERATION_REVOKED', 'The session operation was revoked', 409); }
}
export interface Owner {
  readonly sessionId: string;
  readonly parent?: Owner;
  revoked: boolean;
  readonly cancelled: Promise<never>;
  revoke(): void;
}
export function owner(sessionId: string, parent?: Owner): Owner {
  let reject!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, no) => { reject = no; });
  void cancelled.catch(() => {});
  const token: Owner = { sessionId, parent, revoked: false, cancelled, revoke() { token.revoked = true; reject(new RevokedOperation()); } };
  return token;
}

/** Only local fact commits enter this sequence. Driver and network waits stay outside it. */
export class SessionMutations {
  constructor(private readonly assertControl: () => void = () => {}) {}
  private readonly scope = new AsyncLocalStorage<Owner | undefined>();
  private readonly lease = new AsyncLocalStorage<{ sessionId: string; active: boolean; owner?: Owner }>();
  private readonly tails = new Map<string, Promise<void>>();
  current() { return this.scope.getStore(); }
  valid(token = this.current()): boolean { for (let current = token; current; current = current.parent) if (current.revoked) return false; return true; }
  check(token = this.current()) { this.assertControl(); if (!this.valid(token)) throw new RevokedOperation(); }
  run<T>(token: Owner | undefined, operation: () => T): T { return this.scope.run(token, operation); }
  async wait<T>(operation: Promise<T> | (() => Promise<T>)): Promise<T> {
    if (typeof operation === 'function') this.check();
    const pending = typeof operation === 'function' ? operation() : operation;
    // Already-started operations must remain observed even when their owner was revoked.
    void pending.catch(() => {});
    this.check();
    const cancellations: Promise<never>[] = [];
    for (let token = this.current(); token; token = token.parent) cancellations.push(token.cancelled);
    const result = await Promise.race([pending, ...cancellations]);
    this.check();
    return result;
  }
  write<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const inherited = this.lease.getStore();
    if (inherited?.active && inherited.sessionId === sessionId && inherited.owner === this.current()) {
      this.check(); return operation();
    }
    const token = this.current();
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(() => this.run(token, async () => {
      this.check();
      const lease = { sessionId, active: true, owner: token };
      try { return await this.lease.run(lease, operation); }
      finally { lease.active = false; }
    }));
    const tail = result.then(() => {}, () => {});
    this.tails.set(sessionId, tail);
    void tail.then(() => { if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId); });
    return result;
  }
  async barrier(sessionId?: string) {
    if (sessionId) await this.tails.get(sessionId);
    else while (this.tails.size) await Promise.all([...this.tails.values()]);
  }
}
