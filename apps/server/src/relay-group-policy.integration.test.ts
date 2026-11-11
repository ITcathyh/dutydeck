import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema, RuntimeError } from '@dutydeck/shared';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { RelayAskBroker, RelayCapabilityRegistry } from '@dutydeck/relay';
import { LarkGroupManager } from './lark/group-management.js';
import { readLarkConfig, saveLarkConfig } from './lark/config.js';
import { createRelayContinuationChecker } from './relay-routes.js';
import { createRelayAskStore } from './relay-ask-store.js';
import { buildApp } from './app.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture(emailOnly = false) {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-relay-policy-'));
  const repos = createRepositories(join(dir, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const agent = agentConfigSchema.parse({ id: 'fixture', name: 'fixture', command: process.execPath, cwd: dir, protocol: 'pipe' });
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0, probe: () => ({ protocol: 'pipe', available: true, pause: false, resume: false }),
    driverFactory: () => ({ start: async () => {}, send: async () => {}, stop: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true }) });
  await runtime.initialize([agent]);
  let time = new Date();
  let member = true, unavailable = false;
  await saveLarkConfig(repos.config, repos.agents, { appId: 'fixture-app', appSecret: 'synthetic-secret', defaultAgentId: agent.id, workspace: dir,
    fullTrustConfirmed: true, ...(emailOnly ? { allowedEmails: ['alice@example.test'] } : {}) });
  const manager = new LarkGroupManager(repos, { now: () => time, client: config => ({
    getBotInfo: async () => ({ appName: config.appId, openId: 'fixture-bot' }),
    checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'synthetic-tenant' }),
    listChats: async () => { if (unavailable) throw new Error('platform unavailable'); return { items: [{ chatId: 'fixture-chat', name: 'fixture', external: false }], hasMore: false }; },
    listChatMembers: async () => ({ items: member ? [{ memberId: 'alice', openId: 'alice', memberType: 'user' }] : [], hasMore: false }),
    getUserEmails: async () => ['alice@example.test'],
  }) as any });
  await manager.sync('fixture-app');
  await manager.save('fixture-app', 'fixture-chat', { expectedRevision: 0, patch: {} });
  const session = await runtime.start({ agentId: agent.id, cwd: dir, source: 'lark', sourceId: 'fixture-app:fixture-chat:group:thread:fixture-root' });
  const config = await manager.resolved((await readLarkConfig(repos.config, 'fixture-app'))!, 'fixture-chat');
  await manager.recordRun(session, config, { chatId: 'fixture-chat', chatType: 'group', senderOpenId: 'alice' }, 'thread:fixture-root');
  await manager.beginTurn(session.id, 'alice');
  const publish = vi.fn(async () => {});
  const broker = new RelayAskBroker({ publish }, createRelayAskStore(repos.config));
  const continuation = createRelayContinuationChecker(runtime, async id => (await manager.authorizeSession(id, 'turn.append', false, false, { propagateRefreshErrors: true }))?.allowed !== false);
  broker.setContinuationChecker(continuation);
  await broker.initialize();
  const capabilities = new RelayCapabilityRegistry({ get: id => runtime.getSession(id) }, 'http://localhost', 'fixture');
  const app = await buildApp(runtime, { relay: { runtime, broker, capabilities, continuation, authorizeResult: async id => {
    const decision = await manager.authorizeSession(id, 'task.view_result', false, false, { propagateRefreshErrors: true });
    if (decision?.allowed === false) throw new RuntimeError(decision.code, decision.reason, 403);
  } } });
  const result = (requestId: string) => app.inject({ method: 'POST', url: `/api/relay/sessions/${session.id}/ask-result`, headers: { authorization: `Bearer ${capabilities.tokenFor(session.id)}` }, payload: { requestId } });
  cleanups.push(async () => { broker.close(); await broker.flush(); await app.close(); await runtime.shutdown(); repos.close(); await rm(dir, { recursive: true, force: true }); });
  return { manager, broker, session, publish, result, repos, unavailable: (value: boolean) => { unavailable = value; }, removeMember: () => { member = false; }, advance: () => { time = new Date(time.getTime() + 3_600_001); } };
}

it('keeps an email-only authorized question pending and returns its answer', async () => {
  const f = await fixture(true);
  expect((await f.manager.authorizeSession(f.session.id, 'turn.append'))?.allowed).toBe(true);
  const waiting = f.broker.register({ sessionId: f.session.id, requestId: 'email', question: 'Continue?', timeoutMs: 86_400_000 });
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
  const record = f.broker.listPending()[0]!;
  expect((await f.result('email')).json()).toMatchObject({ status: 'pending', continuation: 'available' });
  await f.broker.answer(record.id, 'yes');
  expect(await waiting).toMatchObject({ status: 'answered', answer: 'yes' });
});

it('refreshes expired group facts without cancelling a question whose 24-hour deadline remains valid', async () => {
  const f = await fixture();
  const waiting = f.broker.register({ sessionId: f.session.id, requestId: 'stale', question: 'Continue?', timeoutMs: 86_400_000 });
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
  const record = f.broker.listPending()[0]!;
  f.advance();
  await f.broker.refreshPending();
  expect(await f.broker.result(f.session.id, 'stale')).toMatchObject({ status: 'pending', continuation: 'available', expiresAt: record.expiresAt });
  await f.broker.answer(record.id, 'yes');
  expect(await waiting).toMatchObject({ status: 'answered', answer: 'yes' });
});

it('blocks continued execution and historical HTTP access after the requester leaves the group', async () => {
  const f = await fixture();
  const waiting = f.broker.register({ sessionId: f.session.id, requestId: 'revoked-member', question: 'Continue?' });
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
  await f.broker.answer(f.broker.listPending()[0]!.id, 'yes');
  expect(await waiting).toMatchObject({ status: 'answered' });
  f.removeMember();
  expect(await f.broker.wait(f.session.id, 'revoked-member')).toMatchObject({ status: 'cancelled' });
  const denied = await f.result('revoked-member');
  expect(denied.statusCode).toBe(403);
  expect(denied.json()).not.toHaveProperty('answer');
  // Denied reads leave the historical evidence intact.
  expect(await f.broker.result(f.session.id, 'revoked-member')).toMatchObject({ status: 'answered', answer: 'yes', continuation: 'ended' });
});

it('cancels a still-pending question when current membership is revoked', async () => {
  const f = await fixture();
  const waiting = f.broker.register({ sessionId: f.session.id, requestId: 'revoked-pending', question: 'Continue?' });
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
  const record = f.broker.listPending()[0]!;
  f.removeMember();
  await f.broker.refreshPending();
  expect(await waiting).toMatchObject({ status: 'cancelled' });
  expect(await f.broker.result(f.session.id, 'revoked-pending')).toMatchObject({ status: 'cancelled', continuation: 'ended' });
  await expect(f.broker.answer(record.id, 'yes')).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
});

it('does not turn a temporary refresh failure into permanent cancellation or permission to answer', async () => {
  const f = await fixture();
  const waiting = f.broker.register({ sessionId: f.session.id, requestId: 'outage', question: 'Continue?', timeoutMs: 86_400_000 });
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
  const record = f.broker.listPending()[0]!;
  f.advance(); f.unavailable(true);
  await f.broker.refreshPending();
  expect(await f.broker.result(f.session.id, 'outage')).toMatchObject({ status: 'pending', continuation: 'unknown' });
  expect(await f.broker.wait(f.session.id, 'outage')).toMatchObject({ status: 'cancelled' });
  await expect(f.broker.answer(record.id, 'no')).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED' });
  expect((await f.result('outage')).statusCode).toBe(500);
  expect(await waiting).toMatchObject({ status: 'cancelled' });
  f.unavailable(false);
  const resumed = f.broker.wait(f.session.id, 'outage');
  await f.broker.answer(record.id, 'yes');
  expect(await resumed).toMatchObject({ status: 'answered', answer: 'yes' });
});

it('queries history without changing the saved question, republishing or admitting a new task', async () => {
  const f = await fixture();
  const waiting = f.broker.register({ sessionId: f.session.id, requestId: 'query', question: 'Continue?' });
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
  const record = f.broker.listPending()[0]!;
  const before = await f.repos.config.list!('relay.ask.');
  const tasks = await f.repos.tasks.listBySession(f.session.id);
  expect((await f.result('query')).json()).toMatchObject({ status: 'pending', continuation: 'available' });
  expect(await f.repos.config.list!('relay.ask.')).toEqual(before);
  expect(await f.repos.tasks.listBySession(f.session.id)).toEqual(tasks);
  expect(f.publish).toHaveBeenCalledOnce();
  await f.broker.answer(record.id, 'yes'); await waiting;
});
