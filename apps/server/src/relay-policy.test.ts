import { describe, expect, it, vi } from 'vitest';
import { RelayAskBroker, RelayCapabilityRegistry, type RelayAskStore } from '@dutydeck/relay';
import { type Session } from '@dutydeck/shared';
import { buildApp } from './app.js';

vi.mock('node:crypto', async importOriginal => ({ ...await importOriginal<typeof import('node:crypto')>(), randomUUID: () => 'policy-question' }));
const owner = { authorization: 'Bearer owner' };
async function harness(store?: RelayAskStore, source?: string) {
  const session = { id: 'session', state: 'idle', source } as Session;
  const events: Array<{ kind: string }> = [];
  const runtime = { getSession: async () => session, subscribe: () => () => {}, publishSessionEvent: async () => {} };
  const broker = new RelayAskBroker({ publish: async (_session, input) => { events.push(input); } }, store);
  const capabilities = new RelayCapabilityRegistry({ get: async () => session }, 'http://127.0.0.1', 'test-secret');
  let allowed = true;
  const authorize = vi.fn(async (_request, _session, _boundary, action) => ({ allowed, action, code: 'GROUP_DISABLED', reason: 'Group disabled', source: 'integration' as const }));
  const app = await buildApp(runtime as any, {
    auth: { mode: 'token', localOnly: false, getToken: async () => 'owner' },
    executionPolicy: { authorize }, relay: { runtime: runtime as any, broker, capabilities },
  });
  const answer = () => app.inject({ method: 'POST', url: '/api/relay/sessions/session/asks/ask_policy-question/answer', headers: owner, payload: { answer: 'yes' } });
  return { app, broker, capabilities, authorize, events, answer, deny: () => { allowed = false; } };
}

describe('relay session execution policy', () => {
  it('denies list and answer through the same session gate without settling the question or replacing HMAC auth', async () => {
    const h = await harness();
    const pending = h.broker.register({ sessionId: 'session', question: 'Proceed?' });
    await vi.waitFor(() => expect(h.broker.listPending()).toHaveLength(1));
    h.deny();
    try {
      expect((await h.app.inject({ method: 'GET', url: '/api/relay/sessions/session/asks' })).statusCode).toBe(401);
      expect((await h.app.inject({ method: 'GET', url: '/api/relay/sessions/session/asks', headers: owner })).statusCode).toBe(403);
      expect((await h.answer()).statusCode).toBe(403);
      expect(h.authorize.mock.calls.map(call => call[3])).toEqual(['task.view_result', 'turn.append']);
      expect(h.broker.listPending()).toHaveLength(1);
      expect(h.events.filter(event => event.kind === 'answer')).toEqual([]);
      const sent = await h.app.inject({ method: 'POST', url: '/api/relay/sessions/self/send', headers: { authorization: `Bearer ${h.capabilities.tokenFor('session')}` }, payload: { text: 'progress' } });
      expect(sent.statusCode).toBe(200);
    } finally { await h.app.close(); await pending; }
  });

  it('rechecks current policy after broker readiness rather than using the earlier visible question', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const records = new Map<string, any>();
    const store: RelayAskStore = { list: async () => { await gate; return []; }, get: async id => records.get(id), compareAndSet: async (_previous, record) => { records.set(record.id, record); return true; } };
    const h = await harness(store);
    const pending = h.broker.register({ sessionId: 'session', question: 'Proceed?' });
    try {
      const request = h.answer(); void request.then(() => {});
      await new Promise(resolve => setImmediate(resolve));
      expect(h.authorize).not.toHaveBeenCalled();
      h.deny(); release();
      expect((await request).statusCode).toBe(403);
      expect(h.authorize).toHaveBeenCalledWith(expect.anything(), 'session', 'session', 'turn.append');
      expect(h.broker.listPending()).toHaveLength(1);
      expect(h.events.filter(event => event.kind === 'answer')).toEqual([]);
    } finally { release(); await h.app.close(); await pending; }
  });

  it('retains the work_item exclusive answer entry even for an installation owner', async () => {
    const h = await harness(undefined, 'work_item');
    try {
      expect((await h.app.inject({ method: 'GET', url: '/api/relay/sessions/session/asks', headers: owner })).statusCode).toBe(403);
      expect((await h.answer()).statusCode).toBe(403);
      expect(h.authorize).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });

  it('does not publish if a cancellation wins while the final authorization is waiting', async () => {
    const broker = new RelayAskBroker({ publish: async () => {} });
    const pending = broker.register({ sessionId: 'session', question: 'Proceed?' });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const answer = broker.answer(broker.listPending()[0]!.id, 'yes', { beforeClaim: async () => { await gate; } });
    await Promise.resolve(); broker.cancelSession('session'); release();
    await expect(answer).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
    await expect(pending).resolves.toMatchObject({ status: 'cancelled' });
  });
});
