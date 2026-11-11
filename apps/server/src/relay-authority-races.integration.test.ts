import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema, RuntimeError } from '@dutydeck/shared';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { RelayAskBroker, RelayCapabilityRegistry, relayAskId } from '@dutydeck/relay';
import { LarkGroupManager } from './lark/group-management.js';
import { readLarkConfig, saveLarkConfig } from './lark/config.js';
import { createRelayContinuationChecker } from './relay-routes.js';
import { createRelayAskStore } from './relay-ask-store.js';
import { buildApp } from './app.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function httpFixture(owned = false, status: 'pending' | 'answered' = 'answered') {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-relay-race-'));
  const repos = createRepositories(join(dir, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const agent = agentConfigSchema.parse({ id: 'fixture', name: 'fixture', command: process.execPath, cwd: dir, protocol: 'acp' });
  let finish: (() => void) | undefined;
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0,
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: false }),
    driverFactory: (_agent, _protocol, emit) => {
      const stop = async () => { emit({ type: 'completed', data: { stopReason: 'cancelled' } }); finish?.(); };
      return { start: async () => {}, send: async () => { emit({ type: 'text', data: { text: 'waiting' } }); await new Promise<void>(resolve => { finish = resolve; }); }, stop, interrupt: stop, resume: async () => {}, isStopped: async () => true };
    } });
  await runtime.initialize([agent]);
  let member = true;
  let memberships = 0, holdAt = 0, reached!: () => void, release = () => {};
  let blocked = Promise.resolve();
  await saveLarkConfig(repos.config, repos.agents, { appId: 'fixture-app', appSecret: 'synthetic-secret', defaultAgentId: agent.id, workspace: dir, fullTrustConfirmed: true });
  const manager = new LarkGroupManager(repos, { client: config => ({
    getBotInfo: async () => ({ appName: config.appId, openId: 'fixture-bot' }),
    checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'synthetic-tenant' }),
    listChats: async () => ({ items: [{ chatId: 'fixture-chat', name: 'fixture', external: false }], hasMore: false }),
    listChatMembers: async () => {
      if (++memberships === holdAt) { reached(); await blocked; }
      return { items: member ? [{ memberId: 'alice', openId: 'alice', memberType: 'user' }] : [], hasMore: false };
    },
    getUserEmails: async () => ['alice@example.test'],
  }) as any });
  await manager.sync('fixture-app');
  await manager.save('fixture-app', 'fixture-chat', { expectedRevision: 0, patch: {} });
  const session = await runtime.start({ agentId: agent.id, cwd: dir, source: 'lark', sourceId: 'fixture-app:fixture-chat:group:thread:fixture-root' });
  const config = await manager.resolved((await readLarkConfig(repos.config, 'fixture-app'))!, 'fixture-chat');
  await manager.recordRun(session, config, { chatId: 'fixture-chat', chatType: 'group', senderOpenId: 'alice' }, 'thread:fixture-root');
  await manager.beginTurn(session.id, 'alice');
  if (owned) {
    await runtime.dispatch(session.id, 'original', 'queue', 'original', undefined, 'alice');
    await vi.waitFor(() => expect(runtime.getActiveTaskContext(session.id)?.attemptId).toBeDefined());
  }
  const store = createRelayAskStore(repos.config), id = relayAskId(session.id, 'saved');
  await store.compareAndSet(undefined, { id, version: 1, mode: 'return-answer', requestId: 'saved', sessionId: session.id, question: 'Continue?',
    status, ...(status === 'answered' ? { answer: 'yes' } : {}), ...runtime.getActiveTaskContext(session.id), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const broker = new RelayAskBroker({ publish: async () => {} }, store);
  const continuation = createRelayContinuationChecker(runtime, async sid => (await manager.authorizeSession(sid, 'turn.append', false, false, { propagateRefreshErrors: true }))?.allowed !== false);
  broker.setContinuationChecker(continuation); await broker.initialize();
  const capabilities = new RelayCapabilityRegistry({ get: sid => runtime.getSession(sid) }, 'http://localhost', 'fixture');
  const app = await buildApp(runtime, { relay: { runtime, broker, capabilities, continuation, authorizeResult: async sid => {
    const decision = await manager.authorizeSession(sid, 'task.view_result', false, false, { propagateRefreshErrors: true });
    if (decision?.allowed === false) throw new RuntimeError(decision.code, decision.reason, 403);
  } } });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  const post = (action: 'ask-result' | 'ask-wait', signal?: AbortSignal) => fetch(`${origin}/api/relay/sessions/${session.id}/${action}`, {
    signal, method: 'POST', headers: { authorization: `Bearer ${capabilities.tokenFor(session.id)}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'saved' }) });
  cleanups.push(async () => { release(); broker.close(); await broker.flush(); await app.close(); await runtime.shutdown(); repos.close(); await rm(dir, { recursive: true, force: true }); });
  return { runtime, session, store, id, post, broker, manager, origin, capabilities, removeMember: () => { member = false; },
    disableGroup: async () => { await manager.save('fixture-app', 'fixture-chat', { expectedRevision: 1, patch: { accessOverride: { mode: 'disabled', principalIds: [] } } }); },
    holdMembership(n: number) {
    memberships = 0; holdAt = n;
    blocked = new Promise<void>(resolve => { release = resolve; });
    return { entered: new Promise<void>(resolve => { reached = resolve; }), release: () => release() };
  } };
}

it.each([false, true].flatMap(owned => (['stop', 'archive'] as const).flatMap(change =>
  (['saved answer', 'pending answer', 'history'] as const).map(path => ({ owned, change, path })))))
  ('rejects $path after $change during final group authorization (owned=$owned)', async ({ owned, change, path }) => {
  const f = await httpFixture(owned, path === 'pending answer' ? 'pending' : 'answered');
  const action = path === 'history' ? 'ask-result' : 'ask-wait';
  let response: Promise<Response>;
  let gate: ReturnType<typeof f.holdMembership>;
  if (path === 'pending answer') {
    response = f.post(action);
    await vi.waitFor(() => expect((f.broker as any).durable.pending.get(f.id).waiters.size).toBe(1));
    gate = f.holdMembership(1);
    const previous = (await f.store.get(f.id))!;
    await f.store.compareAndSet(previous, { ...previous, status: 'answered', answer: 'yes' });
    await f.broker.refreshPending();
  } else {
    gate = f.holdMembership(path === 'history' ? 2 : 3);
    response = f.post(action);
  }
  await gate.entered;
  if (owned) await f.runtime.interrupt(f.session.id, undefined, 'alice');
  await f.runtime[change](f.session.id, { kind: 'channel', id: 'alice', appId: 'fixture-app' });
  const current = (await f.runtime.getSession(f.session.id))!;
  expect(current.state).toBe('stopped');
  if (change === 'archive') expect(current.archivedAt).toBeDefined();
  gate.release();
  const result = await response;
  const body = await result.json();
  expect(result.status).toBe(path === 'history' ? 401 : 200);
  if (path !== 'history') expect(body.status).toBe('cancelled');
  expect(body).not.toHaveProperty('answer');
  expect((await f.post(action)).status).toBe(401);
  expect(await f.store.get(f.id)).toMatchObject({ status: 'answered', answer: 'yes' });
});

it.each(['member removed', 'group disabled'] as const)('checks history access after loading the result: %s', async change => {
  const f = await httpFixture();
  const read = f.broker.result.bind(f.broker);
  vi.spyOn(f.broker, 'result').mockImplementationOnce(async (...args) => {
    if (change === 'member removed') f.removeMember(); else await f.disableGroup();
    return read(...args);
  });
  const response = await f.post('ask-result');
  expect(response.status).toBe(403);
  expect(await response.json()).not.toHaveProperty('answer');
  expect((await f.manager.authorizeSession(f.session.id, 'task.view_result'))?.allowed).toBe(false);
  expect(await f.store.get(f.id)).toMatchObject({ status: 'answered', answer: 'yes' });
});

it('allows historical answers for an ended task while the session and read permission remain valid', async () => {
  const f = await httpFixture(true);
  await f.runtime.interrupt(f.session.id, undefined, 'alice');
  await vi.waitFor(() => expect(f.runtime.getActiveTaskContext(f.session.id)).toBeUndefined());
  expect((await f.runtime.getSession(f.session.id))!.state).not.toBe('stopped');
  const response = await f.post('ask-result');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'answered', answer: 'yes', continuation: 'ended' });
  expect(await f.store.get(f.id)).toMatchObject({ status: 'answered', answer: 'yes' });
});

it.each(['first', 'pre-subscription', 'subscribed'] as const)('returns promptly for unknown authority at %s and preserves reconnection', async phase => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const store = createRelayAskStore(repos.config), id = relayAskId('fixture', 'pending');
  const record = { id, version: 1 as const, mode: 'return-answer' as const, requestId: 'pending', sessionId: 'fixture', question: 'Continue?',
    status: 'pending' as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  await store.compareAndSet(undefined, record);
  const broker = new RelayAskBroker({ publish: async () => {} }, store); await broker.initialize();
  let checks = 0, unknown = phase === 'first';
  broker.setContinuationChecker(async () => {
    if (++checks >= 2 && phase === 'pre-subscription') unknown = true;
    return unknown ? 'unknown' : 'available';
  });
  try {
    let settled = false;
    const waiting = broker.wait('fixture', 'pending').then(value => { settled = true; return value; });
    if (phase === 'subscribed') {
      await vi.waitFor(() => expect((broker as any).durable.pending.get(id).waiters.size).toBe(1));
      unknown = true; await broker.refreshPending();
    }
    // No refresh is needed for the first or pre-subscription cases.
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(await waiting).toMatchObject({ status: 'cancelled' });
    expect((broker as any).durable.pending.get(id).waiters.size).toBe(0);
    expect(await store.get(id)).toEqual(record);
    broker.setContinuationChecker(async () => 'available');
    const resumed = broker.wait('fixture', 'pending');
    await broker.answer(id, 'yes');
    expect(await resumed).toMatchObject({ status: 'answered', answer: 'yes' });
  } finally { broker.close(); await broker.flush(); repos.close(); }
});

it.each([false, true].flatMap(owned => (['saved', 'pending'] as const).flatMap(status =>
  (['disconnect', 'broker close'] as const).map(change => ({ owned, status, change })))))
  ('does not return an answer after $change during final authorization ($status, owned=$owned)', async ({ owned, status, change }) => {
  const f = await httpFixture(owned, status === 'pending' ? 'pending' : 'answered');
  const wait = vi.spyOn(f.broker, 'wait');
  const disconnect = new AbortController();
  const gate = status === 'saved' ? f.holdMembership(3) : undefined;
  const response = f.post('ask-wait', disconnect.signal).catch(error => error);
  let finalGate = gate;
  if (status === 'pending') {
    await vi.waitFor(() => expect((f.broker as any).durable.pending.get(f.id).waiters.size).toBe(1));
    finalGate = f.holdMembership(1);
    const previous = (await f.store.get(f.id))!;
    await f.store.compareAndSet(previous, { ...previous, status: 'answered', answer: 'yes' });
    await f.broker.refreshPending();
  }
  await finalGate!.entered;
  if (change === 'disconnect') {
    disconnect.abort(); await response;
    await vi.waitFor(() => expect(wait.mock.calls[0]![2]!.aborted).toBe(true));
  } else f.broker.close();
  finalGate!.release();
  expect(await wait.mock.results[0]!.value).toMatchObject({ status: 'cancelled' });
  expect(await f.store.get(f.id)).toMatchObject({ status: 'answered', answer: 'yes' });
  if (change === 'disconnect') expect(await (await f.post('ask-wait')).json()).toMatchObject({ status: 'answered', answer: 'yes' });
  else expect(await (await response).json()).toMatchObject({ status: 'cancelled' });
});

it.each(['stop', 'archive'] as const)('keeps the history lifecycle guard through the final capability lookup: %s', async change => {
  const f = await httpFixture();
  const lookup = f.runtime.getSession.bind(f.runtime);
  let calls = 0, entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.runtime, 'getSession').mockImplementation(async id => {
    const session = await lookup(id);
    // Initial capability, two continuation reads, then the final capability read.
    if (++calls === 4) { entered(); await blocked; }
    return session;
  });
  try {
    const pending = f.post('ask-result');
    await reached;
    await f.runtime[change](f.session.id);
    expect((await lookup(f.session.id))!.state).toBe('stopped');
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty('answer');
    expect((await f.post('ask-result')).status).toBe(401);
    expect(await f.store.get(f.id)).toMatchObject({ status: 'answered', answer: 'yes' });
  } finally { release(); }
});
