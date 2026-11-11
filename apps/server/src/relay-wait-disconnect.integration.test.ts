import Fastify from 'fastify';
import { request } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { RelayAskBroker, RelayCapabilityRegistry, relayAskId } from '@dutydeck/relay';
import { createRelayAskStore } from './relay-ask-store.js';
import { registerRelayRoutes } from './relay-routes.js';

it.each(['session lookup', 'result lookup'] as const)('detaches a waiter disconnected during %s and allows reconnection', async phase => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const store = createRelayAskStore(repos.config);
  const id = relayAskId('fixture', 'request');
  await store.compareAndSet(undefined, { id, version: 1, mode: 'return-answer', requestId: 'request', sessionId: 'fixture',
    question: 'Continue?', status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const broker = new RelayAskBroker({ publish: async () => {} }, store);
  await broker.initialize();
  let release!: () => void, resolving!: () => void, closed!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { resolving = resolve; });
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const capabilities = new RelayCapabilityRegistry({ get: async () => { if (phase === 'session lookup') { resolving(); await blocked; } return { id: 'fixture', state: 'idle' }; } }, 'http://localhost', 'fixture-secret');
  if (phase === 'result lookup') broker.setContinuationChecker(async () => { resolving(); await blocked; return 'available'; });
  const app = Fastify();
  app.addHook('onRequest', async (_request, reply) => { reply.raw.once('close', closed); });
  registerRelayRoutes(app, { broker, capabilities, service: new (await import('@dutydeck/relay')).RelayService(capabilities, { publish: async () => {} }, broker) });
  const wait = vi.spyOn(broker, 'wait');
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = request(`${address}/api/relay/sessions/fixture/ask-wait`, { method: 'POST', headers: {
      authorization: `Bearer ${capabilities.tokenFor('fixture')}`, 'content-type': 'application/json',
    } });
    socket.on('error', () => {});
    socket.end(JSON.stringify({ requestId: 'request' }));
    await entered; socket.destroy(); await disconnected; release();
    await vi.waitFor(() => expect(wait.mock.results[0]?.type).toBe('return'));
    expect(await wait.mock.results[0]!.value).toMatchObject({ status: 'cancelled' });
    expect((broker as any).durable.pending.get(id).waiters.size).toBe(0);
    expect(await store.get(id)).toMatchObject({ status: 'pending' });
    const resumed = app.inject({ method: 'POST', url: '/api/relay/sessions/fixture/ask-wait', headers: { authorization: `Bearer ${capabilities.tokenFor('fixture')}` }, payload: { requestId: 'request' } });
    await broker.answer(id, 'yes');
    expect((await resumed).json()).toMatchObject({ status: 'answered', answer: 'yes' });
  } finally { release(); broker.close(); await broker.flush(); await app.close(); repos.close(); }
});
