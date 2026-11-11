import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { RelayAskBroker, RelayCapabilityRegistry, relayAskId, type RelayAskRecord } from '@dutydeck/relay';
import type { AgentConfig, AgentDriver, DriverTurnRecovery } from '@dutydeck/shared';
import { createRelayAskStore } from './relay-ask-store.js';
import { buildApp } from './app.js';
import { createRelayContinuationChecker, isRelayCapabilityRequest } from './relay-routes.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(recoverable?: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-relay-durable-'));
  const database = join(directory, 'state.db');
  let repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  const sends: string[] = [];
  let finish: (() => void) | undefined;
  const makeRuntime = () => new DutydeckRuntime(repos, {
    probe: () => ({ protocol: recoverable === undefined ? 'acp' : 'pty-cli', available: true, pause: false, resume: true }),
    driverFactory: (_agent, _protocol, emit) => {
      let detached = false, preserve = false;
      const stop = async () => { detached = recoverable === true && preserve; if (recoverable === undefined) emit({ type: 'completed', data: { stopReason: 'cancelled' } }); finish?.(); };
      const driver: AgentDriver = { start: async () => {}, resume: async () => {}, stop, interrupt: stop, isStopped: async () => !detached,
        ...(recoverable ? { checkpoint: () => ({ kind: 'pty-jsonl-v1' as const, turnId: 'original', transcript: { offset: 0 } }),
          canRecoverTurn: async () => true, prepareForDaemonShutdown: (keep: boolean) => { preserve = keep; }, isDetachedForShutdown: () => detached,
          recover: async (_state: DriverTurnRecovery, onAttached?: () => Promise<void>) => { await onAttached?.(); await new Promise<void>(resolve => { finish = resolve; }); } } : {}),
        send: async prompt => { sends.push(prompt); emit({ type: 'text', data: { text: 'waiting' }, sourceId: 'waiting' }); await new Promise<void>(resolve => { finish = resolve; }); } };
      return driver;
    }
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: recoverable === undefined ? 'acp' : 'pty-cli', cwd: directory, env: {}, permissionMode: recoverable === undefined ? 'ask' : 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  let runtime = makeRuntime();
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });
  let allowed = true;
  const publish = vi.fn(async (id: string, input: { kind: string; text: string; askId?: string; eventId?: string }) => {
    await runtime.publishSessionEvent(id, 'text', { relay: input.kind, text: input.text, askId: input.askId }, input.eventId);
  });
  let store = createRelayAskStore(repos.config);
  const makeBroker = () => {
    const broker = new RelayAskBroker({ publish }, store);
    broker.setContinuationChecker(createRelayContinuationChecker(runtime, async () => allowed));
    return broker;
  };
  let broker = makeBroker();
  await broker.initialize();
  const capabilities = new RelayCapabilityRegistry({ get: id => runtime.getSession(id) }, 'http://localhost', 'fixture');
  let app = await buildApp(runtime, { relay: { runtime, broker, capabilities, continuation: createRelayContinuationChecker(runtime, async () => allowed) } });
  const headers = { authorization: `Bearer ${capabilities.tokenFor(session.id)}` };
  const post = (action: string, body: unknown) => app.inject({ method: 'POST', url: `/api/relay/sessions/${session.id}/${action}`, headers, payload: body as any });
  const reopen = async () => {
    broker.close(); await broker.flush(); await app.close(); await runtime.shutdown(); repos.close();
    repos = createRepositories(database);
    runtime = makeRuntime(); await runtime.initialize([agent]);
    store = createRelayAskStore(repos.config); broker = makeBroker(); await broker.initialize(); await broker.refreshPending();
    app = await buildApp(runtime, { relay: { runtime, broker, capabilities, continuation: createRelayContinuationChecker(runtime, async () => allowed) } });
  };
  cleanup.push(async () => { broker.close(); await broker.flush(); await app.close(); await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const register = (requestId = 'question', extra: Partial<RelayAskRecord> = {}, context = runtime.getActiveTaskContext(session.id) ?? {}) => broker.register({ sessionId: session.id, requestId, question: 'Proceed?', timeoutMs: 60_000, ...extra }, context);
  const pending = async () => { await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1)); return broker.listPending()[0]!; };
  return { database, get repos() { return repos; }, get store() { return store; }, get broker() { return broker; }, get runtime() { return runtime; }, get app() { return app; }, session, headers, post, register, pending, reopen, publish, sends, deny: () => { allowed = false; } };
}

it('reopens SQLite with a new Runtime and broker, resumes multiple waiters without republishing or dispatching', async () => {
  const f = await fixture();
  const first = f.register();
  const record = await f.pending();
  await f.reopen();
  expect(await first).toMatchObject({ status: 'cancelled' });
  expect(await f.post('ask-result', { requestId: 'question' }).then(r => r.json())).toMatchObject({ id: record.id, status: 'pending', expiresAt: record.expiresAt, continuation: 'available' });
  const one = f.post('ask-wait', { requestId: 'question' }).then(r => r.json());
  const two = f.post('ask-wait', { requestId: 'question' }).then(r => r.json());
  await new Promise(resolve => setImmediate(resolve));
  await f.broker.answer(record.id, 'yes');
  expect(await one).toMatchObject({ status: 'answered', answer: 'yes' });
  expect(await two).toMatchObject({ status: 'answered', answer: 'yes' });
  expect(f.publish.mock.calls.filter(([, input]) => input.kind === 'ask')).toHaveLength(1);
  expect(f.sends).toEqual([]);
});

it('keeps a real HTTP disconnected question, then queries and waits without another publish', async () => {
  const f = await fixture();
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const socket = request(`${address}/api/relay/sessions/${f.session.id}/ask`, { method: 'POST', headers: { ...f.headers, 'content-type': 'application/json' } });
  socket.on('error', () => {});
  socket.end(JSON.stringify({ requestId: 'disconnected', question: 'Proceed?', timeoutMs: 60_000 }));
  const record = await f.pending();
  socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(await f.store.get(record.id)).toMatchObject({ status: 'pending' });
  expect((await f.post('ask-result', { requestId: 'disconnected' })).json()).toMatchObject({ status: 'pending' });
  const waiting = f.post('ask-wait', { requestId: 'disconnected' }).then(r => r.json());
  await f.broker.answer(record.id, 'saved');
  expect(await waiting).toMatchObject({ status: 'answered', answer: 'saved' });
  expect(f.publish.mock.calls.filter(([, input]) => input.kind === 'ask')).toHaveLength(1);
});

it('preserves an answer committed before display failure and shutdown; query does not execute it', async () => {
  const f = await fixture();
  const waiting = f.register(); const record = await f.pending();
  f.publish.mockImplementationOnce(async () => { expect(await f.store.get(record.id)).toMatchObject({ status: 'answered', answer: 'saved' }); throw new Error('crash before display'); });
  await f.broker.answer(record.id, 'saved', { handledBy: 'Alice' });
  expect(await waiting).toMatchObject({ status: 'answered', answer: 'saved' });
  await f.reopen();
  expect((await f.post('ask-result', { requestId: 'question' })).json()).toMatchObject({ status: 'answered', answer: 'saved', handledBy: 'Alice' });
  expect(f.sends).toEqual([]);
  await expect(f.broker.answer(record.id, 'different')).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
});

it('only one CAS answer wins across two repositories and never publishes the losing answer', async () => {
  const f = await fixture();
  const waiting = f.register(); const record = await f.pending();
  const otherRepos = createRepositories(f.database);
  const second = new RelayAskBroker({ publish: async () => {} }, createRelayAskStore(otherRepos.config));
  second.setContinuationChecker(createRelayContinuationChecker(f.runtime)); await second.initialize();
  try {
    const results = await Promise.allSettled([f.broker.answer(record.id, 'one'), second.answer(record.id, 'two')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    await f.broker.refreshPending();
    const saved = await f.store.get(record.id);
    expect(await waiting).toMatchObject({ status: 'answered', answer: saved!.answer });
    expect((await f.broker.result(f.session.id, 'question')).answer).toBe(saved!.answer);
  } finally { second.close(); await second.flush(); otherRepos.close(); }
});

it.each([
  { question: 'different' }, { questionBody: 'different body' }, { choices: [{ label: 'A' }] }, { timeoutMs: 61_000 }, { multiple: true, choices: [{ label: 'A' }] }
])('rejects request identity reuse with changed intent: %j', async changed => {
  const f = await fixture(); const waiting = f.register(); const record = await f.pending();
  await expect(f.register('question', changed)).rejects.toMatchObject({ code: 'RELAY_ASK_CONFLICT' });
  await expect(f.register('question', {}, { taskId: 'another', attemptId: 'another-attempt' })).rejects.toMatchObject({ code: 'RELAY_ASK_CONFLICT' });
  expect(await f.store.get(record.id)).toEqual(record);
  await f.broker.answer(record.id, 'yes'); await waiting;
});

it('never extends the original deadline, accepts 24 hours only for persistent requests', async () => {
  const f = await fixture();
  const waiting = f.register('day', { timeoutMs: 86_400_000 }); const record = await f.pending();
  const retry = f.register('day', { timeoutMs: 86_400_000 });
  await new Promise(resolve => setImmediate(resolve));
  expect(await f.store.get(record.id)).toEqual(record);
  await expect(f.register('too-long', { timeoutMs: 86_400_001 })).rejects.toMatchObject({ code: 'RELAY_INVALID_TIMEOUT' });
  await expect(f.broker.register({ sessionId: f.session.id, question: 'legacy', timeoutMs: 86_400_000 })).rejects.toMatchObject({ code: 'RELAY_INVALID_TIMEOUT' });
  await f.broker.answer(record.id, 'yes'); await waiting; await retry;
});

it.each(['reconcile_required', 'completed', 'replaced', 'revoked'] as const)('preserves history but blocks continuation after owner becomes %s', async state => {
  const f = await fixture();
  await f.runtime.dispatch(f.session.id, 'original');
  await vi.waitFor(() => expect(f.runtime.getActiveTaskContext(f.session.id)?.attemptId).toBeDefined());
  const waiting = f.register(); const record = await f.pending();
  await f.broker.answer(record.id, 'yes'); expect(await waiting).toMatchObject({ status: 'answered' });
  if (state === 'revoked') f.deny();
  else if (state === 'replaced') vi.spyOn(f.runtime, 'getActiveTaskContext').mockReturnValue({ taskId: record.taskId!, attemptId: 'new-attempt' });
  else vi.spyOn(f.runtime, 'getTaskRecovery').mockResolvedValue({ status: state, resolvedUnknown: false, blockers: [] });
  const result = (await f.post('ask-result', { requestId: 'question' })).json();
  expect(result).toMatchObject({ status: 'answered', answer: 'yes', continuation: state === 'reconcile_required' ? 'unknown' : 'ended' });
  expect((await f.post('ask-wait', { requestId: 'question' })).json()).toMatchObject({ status: 'cancelled' });
  expect(await f.store.get(record.id)).toMatchObject({ status: 'answered', answer: 'yes' });
  expect(f.sends).toHaveLength(1);
});

it.each(['stop', 'archive'] as const)('cancels an ownerless pending request on session %s with no HTTP waiter', async action => {
  const f = await fixture(); const waiting = f.register(); const record = await f.pending();
  await f.runtime[action](f.session.id);
  expect(await waiting).toMatchObject({ status: 'cancelled' });
  await expect(f.broker.answer(record.id, 'late')).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
  expect(await f.store.get(record.id)).toMatchObject({ status: 'cancelled' });
});

it('checks current permission after a blocked answer authorization and before returning a committed answer', async () => {
  const f = await fixture(); const waiting = f.register(); const record = await f.pending();
  await expect(f.broker.answer(record.id, 'late', { beforeClaim: async () => { f.deny(); } })).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
  expect(await waiting).toMatchObject({ status: 'cancelled' });
  expect(f.publish.mock.calls.filter(([, input]) => input.kind === 'answer')).toEqual([]);
});

it('keeps HMAC exemptions exact and rejects cross-session or access-token queries', async () => {
  const f = await fixture();
  for (const action of ['ask-result', 'ask-wait']) {
    expect(isRelayCapabilityRequest('POST', `/api/relay/sessions/self/${action}`)).toBe(true);
    expect(isRelayCapabilityRequest('GET', `/api/relay/sessions/self/${action}`)).toBe(false);
    expect(isRelayCapabilityRequest('POST', `/api/relay/sessions/self/${action}/extra`)).toBe(false);
    const response = await f.app.inject({ method: 'POST', url: `/api/relay/sessions/foreign/${action}`, headers: f.headers, payload: { requestId: 'question' } });
    expect(response.statusCode).toBe(401);
    const access = await f.app.inject({ method: 'POST', url: `/api/relay/sessions/self/${action}`, headers: { authorization: 'Bearer access-token' }, payload: { requestId: 'question' } });
    expect(access.statusCode).toBe(401);
  }
  expect(relayAskId('one', 'same')).not.toBe(relayAskId('two', 'same'));
});

it.each([true, false])('reopens the real execution ledger and never resends the original prompt (verified recovery: %s)', async recoverable => {
  const f = await fixture(recoverable);
  await f.runtime.dispatch(f.session.id, 'original prompt');
  await vi.waitFor(() => expect(f.sends).toEqual(['original prompt']));
  const owner = f.runtime.getActiveTaskContext(f.session.id)!;
  const waiting = f.register(); const record = await f.pending();
  await f.reopen(); await waiting;
  const result = await f.broker.result(f.session.id, 'question');
  expect(result).toMatchObject({ taskId: owner.taskId, attemptId: owner.attemptId, continuation: recoverable ? 'available' : 'unknown' });
  if (recoverable) {
    expect(f.runtime.getActiveTaskContext(f.session.id)).toMatchObject(owner);
    const reconnected = f.broker.wait(f.session.id, 'question');
    await f.broker.answer(record.id, 'continued');
    expect(await reconnected).toMatchObject({ status: 'answered', answer: 'continued' });
  } else {
    expect((await f.runtime.getTaskRecovery(f.session.id, owner.taskId)).status).toBe('reconcile_required');
    expect(await f.broker.wait(f.session.id, 'question')).toMatchObject({ status: 'cancelled' });
    await expect(f.broker.answer(record.id, 'late')).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
  }
  expect(f.sends).toEqual(['original prompt']);
  expect(f.publish.mock.calls.filter(([, input]) => input.kind === 'ask')).toHaveLength(1);
});

it('listing pending questions does not wake a waiter or renew its deadline, and expiry cannot be answered', async () => {
  const f = await fixture();
  let settled = false;
  const waiting = f.register().then(result => { settled = true; return result; });
  const record = await f.pending();
  await f.broker.refreshPending();
  await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(record.expiresAt) + 1);
  expect(await f.broker.wait(f.session.id, 'question')).toMatchObject({ status: 'expired' });
  expect(await waiting).toMatchObject({ status: 'expired' });
  await expect(f.broker.answer(record.id, 'late')).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
  expect((await f.store.get(record.id))!.expiresAt).toBe(record.expiresAt);
});

it('does not return success when permission is revoked during the durable answer CAS', async () => {
  const f = await fixture(); const waiting = f.register(); const record = await f.pending();
  const cas = f.store.compareAndSet.bind(f.store);
  vi.spyOn(f.store, 'compareAndSet').mockImplementation(async (previous, next) => {
    const saved = await cas(previous, next);
    if (next.status === 'answered') f.deny();
    return saved;
  });
  await f.broker.answer(record.id, 'historical');
  expect(await waiting).toMatchObject({ status: 'cancelled' });
  expect(await f.broker.result(f.session.id, 'question')).toMatchObject({ status: 'answered', answer: 'historical', continuation: 'ended' });
});

it('does not publish an answer when saving it fails, and retains the original question for an explicit retry', async () => {
  const f = await fixture(); const waiting = f.register(); const record = await f.pending();
  vi.spyOn(f.store, 'compareAndSet').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(f.broker.answer(record.id, 'unsaved')).rejects.toThrow('disk unavailable');
  expect(await f.store.get(record.id)).toEqual(record);
  expect(f.publish.mock.calls.filter(([, input]) => input.kind === 'answer')).toEqual([]);
  await f.broker.answer(record.id, 'saved');
  expect(await waiting).toMatchObject({ status: 'answered', answer: 'saved' });
});

it('keeps a new owner question when an old attempt completion arrives late', async () => {
  const f = await fixture();
  await f.runtime.dispatch(f.session.id, 'old');
  await vi.waitFor(() => expect(f.runtime.getActiveTaskContext(f.session.id)?.attemptId).toBeDefined());
  const old = f.runtime.getActiveTaskContext(f.session.id)!;
  await f.runtime.interrupt(f.session.id);
  await vi.waitFor(() => expect(f.runtime.getActiveTaskContext(f.session.id)).toBeUndefined());
  await f.runtime.dispatch(f.session.id, 'new');
  await vi.waitFor(() => expect(f.runtime.getActiveTaskContext(f.session.id)?.attemptId).toBeDefined());
  const listeners: Array<Parameters<typeof f.runtime.subscribe>[1]> = [];
  const subscribe = f.runtime.subscribe.bind(f.runtime);
  vi.spyOn(f.runtime, 'subscribe').mockImplementation((id, listener, options) => { listeners.push(listener); return subscribe(id, listener, options); });
  const waiting = f.register(); const record = await f.pending();
  const oldEvent = (await f.runtime.getEvents(f.session.id)).find(event => event.type === 'task' && event.taskId === old.taskId)!;
  for (const listener of listeners) listener({ ...oldEvent, data: { task: { id: old.taskId, status: 'completed' } }, attemptId: old.attemptId });
  await f.broker.flush();
  expect(await f.store.get(record.id)).toMatchObject({ status: 'pending', taskId: record.taskId, attemptId: record.attemptId });
  await f.broker.answer(record.id, 'new answer');
  expect(await waiting).toMatchObject({ status: 'answered', answer: 'new answer' });
});

it('closes the HTTP waiter without cancelling the saved question while publication is stuck', async () => {
  const f = await fixture();
  f.publish.mockImplementationOnce(() => new Promise<void>(() => {}));
  const waiting = f.register(); const record = await f.pending();
  f.broker.close(); await f.broker.flush();
  expect(await waiting).toMatchObject({ status: 'cancelled' });
  expect(await f.store.get(record.id)).toMatchObject({ status: 'pending' });
});

it('uses one stable ledger event ID for a durable answer display', async () => {
  const f = await fixture(); const waiting = f.register(); const record = await f.pending();
  await f.broker.answer(record.id, 'saved'); await waiting;
  const input = f.publish.mock.calls.find(([, item]) => item.kind === 'answer')![1];
  expect(input.eventId).toBe(`relay_answer_${record.id}`);
  await f.publish(f.session.id, input);
  expect((await f.runtime.getEvents(f.session.id)).filter(event => event.id === input.eventId)).toHaveLength(1);
});

it('honors an explicit cancellation while the initial SQLite insert is awaiting', async () => {
  const f = await fixture();
  const cas = f.store.compareAndSet.bind(f.store);
  vi.spyOn(f.store, 'compareAndSet').mockImplementation(async (previous, record) => {
    const changed = await cas(previous, record);
    if (!previous) f.broker.cancelSession(f.session.id, 'explicit cancellation');
    return changed;
  });
  const result = await f.register();
  expect(result).toMatchObject({ status: 'cancelled' });
  expect(await f.store.get(result.askId)).toMatchObject({ status: 'cancelled', reason: 'explicit cancellation' });
  expect(f.publish).not.toHaveBeenCalled();
});
