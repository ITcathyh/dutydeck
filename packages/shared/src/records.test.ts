import { expect, it } from 'vitest';
import { serialByKey } from './records.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

it('runs work for the same key in order and retains a newer queued promise', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const firstGate = deferred<void>(), secondGate = deferred<void>();
  const firstStarted = deferred<void>(), secondStarted = deferred<void>();
  const order: string[] = [];
  const first = serialByKey(locks, 'key', async () => {
    order.push('first:start');
    firstStarted.resolve();
    await firstGate.promise;
    order.push('first:end');
    return 'first';
  });
  await firstStarted.promise;
  const second = serialByKey(locks, 'key', async () => {
    order.push('second:start');
    secondStarted.resolve();
    await secondGate.promise;
    order.push('second:end');
    return 'second';
  });
  expect(order).toEqual(['first:start']);
  firstGate.resolve();
  await expect(first).resolves.toBe('first');
  await secondStarted.promise;
  expect(locks.size).toBe(1);
  secondGate.resolve();
  await expect(second).resolves.toBe('second');
  expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  expect(locks.size).toBe(0);
});

it('continues queued work after the previous rejection and returns the original error', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const gate = deferred<void>(), started = deferred<void>();
  const error = new Error('failed');
  const first = serialByKey(locks, 'key', async () => {
    started.resolve();
    await gate.promise;
  });
  await started.promise;
  const second = serialByKey(locks, 'key', async () => 'continued');
  gate.reject(error);
  await expect(first).rejects.toBe(error);
  await expect(second).resolves.toBe('continued');
  expect(locks.size).toBe(0);
});

it('runs different keys concurrently', async () => {
  const locks = new Map<string, Promise<unknown>>();
  const firstGate = deferred<void>(), secondGate = deferred<void>();
  const firstStarted = deferred<void>(), secondStarted = deferred<void>();
  const first = serialByKey(locks, 'first', async () => {
    firstStarted.resolve();
    await firstGate.promise;
    return 1;
  });
  const second = serialByKey(locks, 'second', async () => {
    secondStarted.resolve();
    await secondGate.promise;
    return 2;
  });
  await Promise.all([firstStarted.promise, secondStarted.promise]);
  expect(locks.size).toBe(2);
  secondGate.resolve();
  await expect(second).resolves.toBe(2);
  expect(locks.has('first')).toBe(true);
  firstGate.resolve();
  await expect(first).resolves.toBe(1);
  expect(locks.size).toBe(0);
});

it('cleans completed and rejected work from the map', async () => {
  const locks = new Map<string, Promise<unknown>>();
  await expect(serialByKey(locks, 'done', async () => 'value')).resolves.toBe('value');
  expect(locks.size).toBe(0);
  await expect(serialByKey(locks, 'failed', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
  expect(locks.size).toBe(0);
});
