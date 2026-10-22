import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { RelayAskBroker, type RelayAskRecord } from '@dutydeck/relay';
import { createRelayAskStore } from './relay-ask-store.js';

describe('persistent relay questions', () => {
  it('expires abandoned waiters on restart without restoring permission to answer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-relay-restart-'));
    const filename = join(directory, 'state.db');
    let repos = createRepositories(filename);
    try {
      await repos.config.set('relayXask.unrelated', 'not a question');
      const firstStore = createRelayAskStore(repos.config);
      const pending: RelayAskRecord = { id: 'ask_one', sessionId: 'ses_one', question: '采用哪个方案？', status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
      expect(await firstStore.compareAndSet(undefined, pending)).toBe(true);
      expect(await firstStore.compareAndSet(undefined, pending)).toBe(false);
      const answering: RelayAskRecord = { ...pending, id: 'ask_two', status: 'answering' };
      await firstStore.compareAndSet(undefined, answering);
      repos.close();
      repos = createRepositories(filename);
      const broker = new RelayAskBroker({ publish: async () => { throw new Error('Recovered questions must not publish answers'); } }, createRelayAskStore(repos.config));
      await broker.initialize();
      expect(broker.listPending()).toEqual([]);
      expect(broker.get('ask_one')).toMatchObject({ status: 'cancelled', reason: expect.stringContaining('重启') });
      expect(broker.get('ask_two')).toMatchObject({ status: 'cancelled' });
      await expect(broker.answer('ask_one', 'A', { sessionId: 'ses_one' })).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
      expect(await createRelayAskStore(repos.config).get('ask_one')).toMatchObject({ status: 'cancelled' });
      expect(await repos.config.get('relayXask.unrelated')).toBe('not a question');
    } finally {
      repos.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});


it('cancels registration during the real SQLite CAS microtask without publishing and allows the next question', async () => {
  const repos = createRepositories(':memory:');
  const store = createRelayAskStore(repos.config);
  const publish = vi.fn(async () => {});
  const broker = new RelayAskBroker({ publish }, store);
  try {
    await broker.initialize();
    const outcome = broker.register({ sessionId: 'session', question: 'old', timeoutMs: 60_000 });
    queueMicrotask(() => broker.cancelSession('session', 'stopped during registration'));
    await new Promise(resolve => setImmediate(resolve));
    expect(broker.listPending()).toEqual([]);
    const cancelled = await outcome;
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(await store.get(cancelled.askId)).toMatchObject({ status: 'cancelled', reason: 'stopped during registration' });
    expect(publish).not.toHaveBeenCalled();
    const next = broker.register({ sessionId: 'session', question: 'new', timeoutMs: 60_000 });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    await broker.answer(broker.listPending()[0]!.id, 'yes');
    expect(await next).toMatchObject({ status: 'answered' });
  } finally { broker.close(); await broker.flush(); repos.close(); }
});

it('keeps durable terminal history out of memory, restores only unsettled records and reads old IDs synchronously', async () => {
  const repos = createRepositories(':memory:');
  const store = createRelayAskStore(repos.config);
  const now = new Date().toISOString();
  const record = (id: string): RelayAskRecord => ({ id, sessionId: 's', question: 'q'.repeat(4000), status: 'answered', answer: 'answer', choices: [{ label: 'A', value: 'a' }], multiple: true, createdAt: now, expiresAt: now });
  for (let i = 0; i < 1000; i++) await store.compareAndSet(undefined, record('old-' + i));
  await store.compareAndSet(undefined, { ...record('abandoned'), status: 'pending' });
  const list = vi.spyOn(store, 'list');
  const recover = vi.spyOn(store, 'listUnsettled');
  const sync = vi.spyOn(store, 'getSync');
  let broker!: RelayAskBroker;
  const publish = vi.fn(async (_session: string, input: { kind: string; askId?: string }) => {
    if (input.kind === 'ask') {
      expect(broker.get(input.askId!)).toMatchObject({ status: 'pending' });
      expect(sync).not.toHaveBeenCalled();
    }
  });
  broker = new RelayAskBroker({ publish }, store);
  try {
    await broker.initialize();
    expect(list).not.toHaveBeenCalled(); expect(recover).toHaveBeenCalledTimes(1);
    expect((broker as any).history.size).toBe(0);
    expect(broker.get('old-0')).toEqual(record('old-0'));
    expect(broker.get('abandoned')).toMatchObject({ status: 'cancelled', reason: expect.stringContaining('重启') });
    expect((broker as any).history.size).toBe(0);
    await expect(broker.answer('old-0', 'again')).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
    sync.mockClear();
    const waiting = broker.register({ sessionId: 's', question: 'new' });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    expect(sync).not.toHaveBeenCalled();
    const id = broker.listPending()[0]!.id;
    expect(await broker.answer(id, 'yes')).toMatchObject({ status: 'answered', answer: 'yes' });
    expect(await waiting).toMatchObject({ status: 'answered', answer: 'yes' });
    expect(sync).not.toHaveBeenCalled();
    expect((broker as any).history.size).toBe(0);
    expect(broker.get(id)).toMatchObject({ status: 'answered', answer: 'yes' });
  } finally { broker.close(); await broker.flush(); repos.close(); }
});

it('retains failed terminal writes until a durable terminal record can be read', async () => {
  const repos = createRepositories(':memory:');
  const store = createRelayAskStore(repos.config);
  const broker = new RelayAskBroker({ publish: async () => {} }, store);
  try {
    await broker.initialize();
    const waiting = broker.register({ sessionId: 's', question: 'save?' });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    const initial = broker.listPending()[0]!;
    const cas = vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('write failed'));
    broker.cancelSession('s');
    await expect(waiting).rejects.toThrow('write failed');
    await expect(broker.flush()).rejects.toMatchObject({ name: 'AggregateError' });
    expect(broker.listPending()).toEqual([]);
    expect((broker as any).history.size).toBe(1);
    expect(broker.get(initial.id)).toEqual(initial);
    const read = vi.spyOn(store, 'getSync').mockImplementationOnce(() => { throw new Error('read failed'); });
    expect(broker.get(initial.id)).toEqual(initial);
    read.mockRestore(); cas.mockRestore();
    await store.compareAndSet(initial, { ...initial, status: 'cancelled', reason: 'recovered' });
    expect(broker.get(initial.id)).toMatchObject({ status: 'cancelled', reason: 'recovered' });
    expect((broker as any).history.size).toBe(0);
  } finally { broker.close(); await broker.flush(); repos.close(); }
});
