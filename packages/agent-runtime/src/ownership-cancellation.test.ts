import { expect, it, vi } from 'vitest';
import { owner, SessionMutations } from './ownership.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(['child', 'parent', 'ancestor'] as const)('cancels a pending wait when its %s is revoked and observes late rejection', async level => {
  const mutations = new SessionMutations();
  const ancestor = owner('ancestor'), parent = owner('parent', ancestor), child = owner('child', parent);
  const pending = deferred<number>();
  const waiting = mutations.run(child, () => mutations.wait(() => pending.promise));
  const cancelled = expect(waiting).rejects.toMatchObject({ code: 'OPERATION_REVOKED' });
  ({ child, parent, ancestor })[level].revoke();
  await cancelled;
  pending.reject(new Error('late failure'));
  await new Promise<void>(resolve => setImmediate(resolve));
});

it('keeps sibling waits live after a child is revoked and cancels all remaining waits on parent revocation', async () => {
  const mutations = new SessionMutations(), parent = owner('parent');
  const child = owner('child', parent), sibling = owner('sibling', parent);
  const first = mutations.run(child, () => mutations.wait(() => new Promise<never>(() => {})));
  const second = mutations.run(sibling, () => mutations.wait(() => new Promise<never>(() => {})));
  const firstCancelled = expect(first).rejects.toMatchObject({ code: 'OPERATION_REVOKED' });
  const secondCancelled = expect(second).rejects.toMatchObject({ code: 'OPERATION_REVOKED' });
  let siblingFinished = false;
  void second.then(() => { siblingFinished = true; }, () => { siblingFinished = true; });
  child.revoke(); await firstCancelled;
  expect(siblingFinished).toBe(false);
  parent.revoke(); parent.revoke();
  await secondCancelled;
  expect(siblingFinished).toBe(true);
});

it('does not start a thunk under a revoked parent', async () => {
  const mutations = new SessionMutations(), parent = owner('parent'), child = owner('child', parent);
  parent.revoke();
  const operation = vi.fn(async () => 1);
  await expect(mutations.run(child, () => mutations.wait(operation))).rejects.toMatchObject({ code: 'OPERATION_REVOKED' });
  expect(operation).not.toHaveBeenCalled();
});

it('observes late rejection when the thunk synchronously revokes its parent', async () => {
  const mutations = new SessionMutations(), parent = owner('parent'), child = owner('child', parent);
  const pending = deferred<number>();
  await expect(mutations.run(child, () => mutations.wait(() => { parent.revoke(); return pending.promise; })))
    .rejects.toMatchObject({ code: 'OPERATION_REVOKED' });
  pending.reject(new Error('late failure'));
  await new Promise<void>(resolve => setImmediate(resolve));
});

it('preserves the original operation error when rejection precedes cancellation', async () => {
  const mutations = new SessionMutations(), parent = owner('parent');
  const failure = new Error('operation failed');
  const waiting = mutations.run(owner('child', parent), () => mutations.wait(() => Promise.reject(failure)));
  parent.revoke();
  await expect(waiting).rejects.toBe(failure);
});

it('rechecks owner and control after successful completion before returning its result', async () => {
  const controlFailure = new Error('control replaced');
  let controlled = true;
  const mutations = new SessionMutations(() => { if (!controlled) throw controlFailure; });
  const token = owner('session');
  const revoked = mutations.run(token, () => mutations.wait(() => Promise.resolve(1)));
  token.revoke();
  await expect(revoked).rejects.toMatchObject({ code: 'OPERATION_REVOKED' });
  const replaced = mutations.wait(() => Promise.resolve(1));
  controlled = false;
  await expect(replaced).rejects.toBe(controlFailure);
  const operation = vi.fn(async () => 1);
  await expect(mutations.wait(operation)).rejects.toBe(controlFailure);
  expect(operation).not.toHaveBeenCalled();
});
