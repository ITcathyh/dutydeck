import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepositories } from '@dockmux/storage';
import { RelayAskBroker, type RelayAskRecord } from '@dockmux/relay';
import { createRelayAskStore } from './relay-ask-store.js';

describe('persistent relay questions', () => {
  it('expires abandoned waiters on restart without restoring permission to answer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dockmux-relay-restart-'));
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
