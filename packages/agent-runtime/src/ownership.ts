import { AsyncLocalStorage } from 'node:async_hooks';
import { RuntimeError } from '@dutydeck/shared';

export type RevocationReason = { code: string; by: string };

export class RevokedOperation extends RuntimeError {
  declare readonly details?: RevocationReason;
  constructor(token?: Owner) {
    const reason = revokedOwner(token)?.revokedBy;
    super('OPERATION_REVOKED', reason ? `The session operation was revoked (${reason.code} by ${reason.by})` : 'The session operation was revoked', 409, reason);
  }
}
export interface Owner {
  readonly sessionId: string;
  readonly parent?: Owner;
  revoked: boolean;
  readonly revokedBy?: RevocationReason;
  onCancel(listener: () => void): () => void;
  revoke(reason?: RevocationReason): void;
}
function revokedOwner(token?: Owner): Owner | undefined {
  for (let current = token; current; current = current.parent) if (current.revoked) return current;
}
export function owner(sessionId: string, parent?: Owner): Owner {
  const listeners = new Set<() => void>();
  let revokedBy: RevocationReason | undefined;
  const token: Owner = {
    sessionId, parent, revoked: false,
    get revokedBy() { return revokedBy; },
    onCancel(listener) {
      if (token.revoked) listener(); else listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    revoke(reason) {
      if (token.revoked) return;
      revokedBy = reason && { ...reason };
      token.revoked = true;
      for (const listener of listeners) listener();
      listeners.clear();
    }
  };
  return token;
}

/** Only local fact commits enter this sequence. Driver and network waits stay outside it. */
export class SessionMutations {
  constructor(private readonly assertControl: () => void = () => {}) {}
  private readonly scope = new AsyncLocalStorage<Owner | undefined>();
  private readonly lease = new AsyncLocalStorage<{ sessionId: string; active: boolean; owner?: Owner }>();
  private readonly tails = new Map<string, Promise<void>>();
  current() { return this.scope.getStore(); }
  valid(token = this.current()): boolean { return !revokedOwner(token); }
  check(token = this.current()) { this.assertControl(); if (!this.valid(token)) throw new RevokedOperation(token); }
  run<T>(token: Owner | undefined, operation: () => T): T { return this.scope.run(token, operation); }
  async wait<T>(operation: Promise<T> | (() => Promise<T>)): Promise<T> {
    if (typeof operation === 'function') this.check();
    const pending = typeof operation === 'function' ? operation() : operation;
    // Already-started operations must remain observed even when their owner was revoked.
    void pending.catch(() => {});
    this.check();
    const unsubscribe: Array<() => void> = [];
    const current = this.current();
    const cancelled = new Promise<never>((_resolve, reject) => {
      for (let token = current; token; token = token.parent) {
        unsubscribe.push(token.onCancel(() => reject(new RevokedOperation(current))));
      }
    });
    try {
      const result = await Promise.race([pending, cancelled]);
      this.check();
      return result;
    } finally {
      // A long-lived parent must not retain completed waits or their async context.
      for (const remove of unsubscribe) remove();
    }
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
