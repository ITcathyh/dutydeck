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
