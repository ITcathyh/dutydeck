import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { ConfigRepository } from '@dutydeck/shared';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkLongConnectionListener, type LarkMessageEvent } from './listener.js';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkTaskInbox } from './task-inbox.js';
import { LarkGroupParticipation } from './group-participation.js';

const sdk = vi.hoisted(() => ({ handlers: {} as Record<string, (event: any) => Promise<unknown>> }));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  EventDispatcher: class { register(handlers: typeof sdk.handlers) { sdk.handlers = handlers; return this; } },
  WSClient: class { constructor(private options: { onReady: () => void }) {} async start() { this.options.onReady(); } close() {} }
}));
const config: StoredLarkConfig = {
  appId: 'cli_durable', appSecret: 'synthetic', workspace: '/tmp', defaultAgentId: 'codex', permissionMode: 'ask',
  fullTrustConfirmed: true, listening: true, preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false,
  pushIntervalMs: 1000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [],
  highRiskAllowedEmails: [], highRiskPattern: 'rm\\b', riskControlMode: 'off'
};
const message = (patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: 'om_original', chatId: 'oc_group', chatType: 'group', messageType: 'text',
  content: '{"text":"@bot original"}', senderOpenId: 'ou_author', senderType: 'user',
  mentions: [{ key: '@bot', name: 'bot', openId: 'ou_bot' }], ...patch
});
const notification = (event: LarkMessageEvent) => ({ sender: { sender_id: { open_id: event.senderOpenId }, sender_type: event.senderType },
  message: { message_id: event.messageId, chat_id: event.chatId, chat_type: event.chatType, message_type: event.messageType,
    content: event.content, mentions: event.mentions.map(mention => ({ ...mention, id: { open_id: mention.openId } })) } });
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-durable-'));
  const filename = join(directory, 'state.db');
  let repositories = createRepositories(filename);
  await repositories.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const session = { id: 'ses_durable', agentId: 'codex', state: 'idle', cwd: directory, protocol: 'acp', permissionMode: 'ask', createdAt: '', updatedAt: '' };
  const runtime = { start: vi.fn(async () => session), getSession: vi.fn(async () => session), subscribe: vi.fn(() => vi.fn()),
    dispatch: vi.fn(async (..._args: unknown[]) => ({ id: 'task_durable', sessionId: session.id, status: 'queued', queuedAhead: 0 })) };
  const service = { send: vi.fn(async () => ({ messageId: 'om_card' })), reply: vi.fn(async () => ({ messageId: 'om_card' })),
    update: vi.fn(async () => ({ messageId: 'om_card' })), addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })), getMessageItems: vi.fn(async () => []) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinators: LarkMessageCoordinator[] = [];
  const createCoordinator = (options: { groupManager?: any; executionPolicy?: any; participation?: any } = {}) => {
    const coordinator = new LarkMessageCoordinator(runtime as any, service as any, log, Math.random, 'ou_bot', undefined, undefined,
      async () => 'group', options.executionPolicy, options.groupManager ? { recordRun: vi.fn(async () => {}), ...options.groupManager } : undefined, { store: repositories.config, participation: options.participation });
    coordinators.push(coordinator); return coordinator;
  };
  cleanups.push(async () => { coordinators.forEach(coordinator => coordinator.stop()); repositories.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, filename, get repositories() { return repositories; }, runtime, service, log, createCoordinator,
    reopen: () => { repositories.close(); repositories = createRepositories(filename); },
    inbox: (id = 'om_original') => new LarkTaskInbox(repositories.config).lookup(config.appId, id) };
}

it('the registered SDK handler returns after SQLite receipt while slow permissions remain outside ACK', async () => {
  const h = await harness();
  let release!: () => void;
  const permission = new Promise<void>(resolve => { release = resolve; });
  const groupManager = { resolved: vi.fn(async () => { await permission; return config; }), authorize: vi.fn(async () => undefined) };
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const data = url.includes('/tenant_access_token/') ? { code: 0, tenant_access_token: 'synthetic', expire: 7200 }
      : url.includes('/bot/v3/info') ? { code: 0, bot: { open_id: 'ou_bot' } }
      : { code: 0, data: { message_id: 'om_card', reaction_id: 'reaction', items: [], has_more: false } };
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  });
  const listener = new LarkLongConnectionListener(h.log, { runtime: h.runtime as any, workflowStore: h.repositories.config,
    groupManager: groupManager as any, fetcher: fetcher as typeof fetch, chatModeResolver: async () => 'group' });
  cleanups.push(() => { release(); listener.stop(); });
  await listener.start(config);
  const started = performance.now();
  await sdk.handlers['im.message.receive_v1']!(notification(message()));
  expect(await h.inbox()).toMatchObject({ state: 'unrouted', event: message() });
  expect(groupManager.resolved).not.toHaveBeenCalled();
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
  expect(performance.now() - started).toBeLessThan(500);
  await vi.waitFor(() => expect(groupManager.resolved).toHaveBeenCalledOnce());
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
  listener.stop(); release();
});

it('a blocked group does not delay routing another chat, while its own messages retain intake order', async () => {
  const h = await harness();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const resolvedIds: string[] = [];
  const groupManager = { resolved: vi.fn(async (_config: StoredLarkConfig, chatId: string) => {
    resolvedIds.push(chatId); if (chatId === 'oc_blocked') await blocked; return config;
  }), authorize: vi.fn(async () => undefined) };
  const coordinator = h.createCoordinator({ groupManager }); cleanups.push(() => { coordinator.stop(); release(); });
  await coordinator.receive(message({ messageId: 'blocked_1', chatId: 'oc_blocked', mentions: [] }), config);
  await coordinator.receive(message({ messageId: 'blocked_2', chatId: 'oc_blocked', mentions: [] }), config);
  await coordinator.receive(message({ messageId: 'free', chatId: 'oc_free' }), config);
  await vi.waitFor(async () => expect(await h.inbox('free')).toMatchObject({ state: 'accepted' }));
  expect(resolvedIds.filter(id => id === 'oc_blocked')).toHaveLength(1);
  expect(await h.inbox('blocked_2')).toMatchObject({ state: 'unrouted' });
  release(); await vi.waitFor(async () => expect(await h.inbox('blocked_2')).toMatchObject({ state: 'ignored' }));
  expect(resolvedIds).toEqual(['oc_blocked', 'oc_free', 'oc_blocked']);
});

it('batches ignored cleanup outside ACK and measures local SQLite intake latency', async () => {
  const h = await harness(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate'] });
  const list = vi.spyOn(h.repositories.config, 'list');
  const coordinator = h.createCoordinator();
  const durations: number[] = [];
  for (let index = 0; index < 200; index++) {
    const started = performance.now();
    await coordinator.receive(message({ messageId: `chatter_${index}`, mentions: [] }), config);
    durations.push(performance.now() - started);
  }
  expect(list).not.toHaveBeenCalled();
  expect(await h.inbox('chatter_199')).toMatchObject({ state: 'unrouted' });
  await vi.advanceTimersByTimeAsync(200);
  expect(await h.inbox('chatter_199')).toMatchObject({ state: 'ignored' });
  expect(list.mock.calls.filter(([prefix]) => prefix.startsWith('lark.inbox.'))).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(list.mock.calls.filter(([prefix]) => prefix.startsWith('lark.inbox.'))).toHaveLength(1);
  durations.sort((a, b) => a - b);
  console.info(`SQLite durable intake n=${durations.length} p50_ms=${durations[99]!.toFixed(3)} p95_ms=${durations[189]!.toFixed(3)} max_ms=${durations.at(-1)!.toFixed(3)}; cleanup scans=1/200 receipts`);
  expect(durations.at(-1)).toBeLessThan(500);
});

it.each(['throw', 'reject'] as const)('a local storage %s rejects the registered SDK handler and prevents routing', async mode => {
  const h = await harness();
  const fetcher = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes('/bot/v3/info')
    ? { code: 0, bot: { open_id: 'ou_bot' } } : { code: 0, tenant_access_token: 'synthetic', expire: 7200 })));
  const store: ConfigRepository = { ...h.repositories.config, compareAndSet: vi.fn(() => {
    if (mode === 'throw') throw new Error('disk failed');
    return Promise.reject(new Error('disk failed'));
  }) };
  const listener = new LarkLongConnectionListener(h.log, { runtime: h.runtime as any, workflowStore: store, fetcher: fetcher as typeof fetch });
  cleanups.push(() => listener.stop()); await listener.start(config);
  await expect(sdk.handlers['im.message.receive_v1']!(notification(message()))).rejects.toThrow('disk failed');
  expect(await h.inbox()).toBeUndefined(); expect(h.runtime.dispatch).not.toHaveBeenCalled();
});

it('survives SIGKILL after durable intake and before routing, then recovers the original exactly once', async () => {
  const h = await harness();
  const original = message({ chatType: 'p2p' });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', fileURLToPath(new URL('./durable-intake-child.mts', import.meta.url)),
      h.filename, JSON.stringify(config), JSON.stringify(original)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  expect(exit, exit.stderr).toMatchObject({ code: null, signal: 'SIGKILL', stderr: '' });
  h.reopen();
  expect(await h.inbox()).toMatchObject({ state: 'unrouted', event: original });
  const coordinator = h.createCoordinator(); await coordinator.initializeWorkflows(config);
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted' }));
  await coordinator.receive({ ...original, content: '{"text":"forged replacement"}' }, config);
  await coordinator.handle({ ...original, content: '{"text":"forged replacement"}' }, config);
  expect(h.runtime.dispatch).toHaveBeenCalledOnce(); expect(await h.inbox()).toMatchObject({ event: original });
});

it('canonicalizes concurrent modified redelivery before wake and authorization and routes only once', async () => {
  const h = await harness();
  const groupManager = { resolved: vi.fn(async () => config), authorize: vi.fn(async () => undefined) };
  const coordinator = h.createCoordinator({ groupManager }); const original = message();
  await Promise.all([coordinator.receive(original, config), coordinator.receive({ ...original, content: '{"text":"/new"}', senderOpenId: 'ou_forged' }, config)]);
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted' }));
  expect(groupManager.resolved).toHaveBeenCalledOnce(); expect(groupManager.authorize.mock.calls[0]?.[2]).toBe('ou_author');
  expect(h.runtime.dispatch).toHaveBeenCalledOnce(); expect(await h.inbox()).toMatchObject({ event: original });
});

it.each(['disabled', 'unmentioned', 'bot', 'revoked'] as const)('raw recovery rechecks %s without forcing adoption', async reason => {
  const h = await harness();
  const event = message(reason === 'unmentioned' ? { mentions: [] } : reason === 'bot' ? { senderType: 'app', mentions: [] } : {});
  await new LarkTaskInbox(h.repositories.config).capture(config.appId, event);
  if (reason === 'disabled') await h.repositories.config.set(larkBotsConfigKey, JSON.stringify([{ ...config, listening: false }]));
  const groupManager = { resolved: vi.fn(async () => config), authorize: vi.fn(async () => reason === 'revoked' ? { allowed: false, reason: 'revoked' } : undefined) };
  const coordinator = h.createCoordinator({ groupManager }); await coordinator.initializeWorkflows(config);
  expect(h.runtime.start).not.toHaveBeenCalled(); expect(h.runtime.dispatch).not.toHaveBeenCalled();
  expect(await h.inbox()).toMatchObject({ state: reason === 'revoked' ? 'failed' : 'ignored' });
});

it('keeps transient pre-route failure retryable instead of converting it to ignored', async () => {
  const h = await harness(); vi.useFakeTimers();
  const groupManager = { resolved: vi.fn().mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue(config), authorize: vi.fn(async () => undefined) };
  await new LarkTaskInbox(h.repositories.config).capture(config.appId, message());
  const coordinator = h.createCoordinator({ groupManager }); await coordinator.initializeWorkflows(config);
  expect(await h.inbox()).toMatchObject({ state: 'unrouted', boot: '' });
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_001);
  vi.useRealTimers();
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted' }));
  expect(h.runtime.dispatch).toHaveBeenCalledOnce();
});

it('allows a validated edit after ignored termination while receive redeliveries stay suppressed', async () => {
  const h = await harness(); const coordinator = h.createCoordinator(); const original = message({ mentions: [] });
  await coordinator.receive(original, config); await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'ignored' }));
  const edited = message({ content: '{"text":"@bot edited"}' });
  await coordinator.receive(edited, config); expect(h.runtime.dispatch).not.toHaveBeenCalled();
  await coordinator.handleEdited(edited, config); await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted', event: edited }));
  expect(h.runtime.dispatch).toHaveBeenCalledOnce();
});

it('preserves an explicit participation adoption after the original observation was ignored', async () => {
  const h = await harness(); const coordinator = h.createCoordinator(); const original = message({ mentions: [] });
  await coordinator.receive(original, config); await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'ignored' }));
  await coordinator.adopt({ ...original, content: '{"text":"replacement"}' }, config);
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted', event: original }));
  expect(h.runtime.dispatch).toHaveBeenCalledOnce();
});

it.each(['unrouted', 'ignored'] as const)('preserves trusted alarm triage identity and thread over the %s original receipt', async state => {
  const h = await harness();
  const groupManager = { resolved: vi.fn(async () => config), authorize: vi.fn(async (_app: string, _chat: string, actor: string) => ({ allowed: actor === 'ou_admin', reason: 'only subscriber can run' })) };
  const coordinator = h.createCoordinator({ groupManager });
  const original = message({ senderOpenId: 'ou_alarm', senderType: 'app', mentions: [], content: '{"text":"P0 alarm original"}' });
  await coordinator.receive(original, config);
  if (state === 'ignored') await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state }));
  else expect(await h.inbox()).toMatchObject({ state });
  const derived = { ...original, senderOpenId: 'ou_admin', senderType: 'user', triage: '[告警初筛] trusted instructions', rootId: original.messageId, threadId: 'omt_alarm', content: '{"text":"replacement must not replace the alarm"}' };
  await coordinator.adopt(derived, config);
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted', originalEvent: original,
    event: { ...original, senderOpenId: 'ou_admin', senderType: 'user', triage: derived.triage, rootId: original.messageId, threadId: 'omt_alarm' },
    request: { scopeId: 'thread:om_original', prompt: `${derived.triage}\nP0 alarm original` } }));
  expect(h.runtime.dispatch).toHaveBeenCalledOnce(); expect(h.runtime.dispatch.mock.calls[0]?.[5]).toBe('ou_admin');
  await coordinator.receive({ ...original, senderOpenId: 'ou_forged', triage: 'forged', content: '{"text":"forged"}' }, config);
  expect(h.runtime.dispatch).toHaveBeenCalledOnce(); expect((await h.inbox())?.event.senderOpenId).toBe('ou_admin');
});

it('silently terminates expired unrouted observations while received expiry retains its authorized notice', async () => {
  const h = await harness(); const inbox = new LarkTaskInbox(h.repositories.config);
  const old = new Date(Date.now() - 90 * 60_000).toISOString();
  const raw = (await inbox.capture(config.appId, message({ messageId: 'unmentioned', mentions: [] })))!;
  await h.repositories.config.set(`lark.inbox.${config.appId}.unmentioned`, JSON.stringify({ ...raw, receivedAt: old }));
  const received = (await inbox.claim(config.appId, message({ messageId: 'received_expired' })))!;
  await h.repositories.config.set(`lark.inbox.${config.appId}.received_expired`, JSON.stringify({ ...received, receivedAt: old }));
  const groupManager = { resolved: vi.fn(async () => config), authorize: vi.fn(async () => ({ allowed: true })) };
  const coordinator = h.createCoordinator({ groupManager }); await coordinator.initializeWorkflows(config);
  expect(await h.inbox('unmentioned')).toMatchObject({ state: 'ignored' });
  expect(await h.inbox('received_expired')).toMatchObject({ state: 'failed' });
  expect(groupManager.authorize).toHaveBeenCalledOnce();
  expect(h.service.reply).toHaveBeenCalledOnce(); expect(h.service.reply.mock.calls[0]?.[0]).toMatchObject({ messageId: 'received_expired', taskName: '请求未执行' });
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
});

it.each(['before_route', 'slow_route'] as const)('queues a validated edit after its unmentioned original %s, then executes the edit once', async phase => {
  const h = await harness();
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const groupManager = { resolved: vi.fn(async () => { if (phase === 'slow_route') await pending; return config; }), authorize: vi.fn(async () => undefined) };
  const coordinator = h.createCoordinator({ groupManager }); cleanups.push(() => { coordinator.stop(); release(); });
  const original = message({ mentions: [], content: '{"text":"unmentioned original"}' });
  await coordinator.receive(original, config);
  const edited = message({ content: '{"text":"@bot verified edit"}' });
  const edit = coordinator.handleEdited(edited, config);
  if (phase === 'slow_route') {
    await vi.waitFor(() => expect(groupManager.resolved).toHaveBeenCalledOnce());
    expect(await h.inbox()).toMatchObject({ state: 'unrouted', event: original });
    expect(h.runtime.dispatch).not.toHaveBeenCalled(); release();
  }
  await edit;
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted', event: edited }));
  expect(h.runtime.dispatch).toHaveBeenCalledOnce();
});

it('does not replace or replay an accepted request when a validated edit is queued', async () => {
  const h = await harness(); const coordinator = h.createCoordinator(); const original = message();
  await coordinator.receive(original, config);
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted' }));
  await coordinator.handleEdited({ ...original, content: '{"text":"@bot another request"}' }, config);
  expect(await h.inbox()).toMatchObject({ state: 'accepted', event: original }); expect(h.runtime.dispatch).toHaveBeenCalledOnce();
});

it.each([1, 3])('keeps the verified edit authoritative through %i transient original/edited route failures and stale retry timers', async failures => {
  const h = await harness(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let reads = 0;
  const groupManager = { resolved: vi.fn(async () => { if (++reads <= failures) throw new Error('temporary network error'); return config; }), authorize: vi.fn(async () => undefined) };
  const coordinator = h.createCoordinator({ groupManager });
  const original = message({ mentions: [], content: '{"text":"unmentioned original"}' });
  const edited = message({ content: '{"text":"@bot verified edit"}' });
  await coordinator.receive(original, config); await coordinator.handleEdited(edited, config);
  if (failures > 1) {
    expect(await h.inbox()).toMatchObject({ state: 'unrouted', boot: '', event: edited, originalEvent: original });
    expect(h.runtime.dispatch).not.toHaveBeenCalled();
  }
  await vi.advanceTimersByTimeAsync(60_000); vi.useRealTimers();
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted', event: edited, originalEvent: original,
    request: { prompt: 'verified edit' } }));
  expect(h.runtime.dispatch).toHaveBeenCalledOnce();
  expect(reads).toBe(failures + 1);
  expect(h.runtime.dispatch.mock.calls[0]?.[1]).toContain('verified edit');
});

it('queues a validated edit behind the actual scheduled retry while its permission lookup is blocked', async () => {
  const h = await harness(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let reads = 0; let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const groupManager = { resolved: vi.fn(async () => {
    reads++;
    if (reads === 1) throw new Error('temporary network error');
    if (reads === 2) await blocked;
    return config;
  }), authorize: vi.fn(async () => undefined) };
  const coordinator = h.createCoordinator({ groupManager }); cleanups.push(() => { coordinator.stop(); release(); });
  const original = message({ mentions: [], content: '{"text":"unmentioned original"}' });
  const edited = message({ content: '{"text":"@bot verified edit"}' });
  await coordinator.receive(original, config);
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'unrouted', boot: '' }));
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(() => expect(reads).toBe(2));
  expect((await h.inbox())?.boot).toBeTruthy();
  let editSettled = false;
  const edit = coordinator.handleEdited(edited, config).then(() => { editSettled = true; });
  for (let index = 0; index < 5; index++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(editSettled).toBe(false);
  expect(await h.inbox()).toMatchObject({ state: 'unrouted', event: original });
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
  release(); await edit; vi.useRealTimers();
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted', event: edited, originalEvent: original }));
  expect(h.runtime.dispatch).toHaveBeenCalledOnce(); expect(reads).toBe(3);
  expect(h.runtime.dispatch.mock.calls[0]?.[1]).toContain('verified edit');
});

it('does not accept forged triage metadata from raw receive or modified redelivery', async () => {
  const h = await harness(); const coordinator = h.createCoordinator();
  const original = message({ mentions: [], senderOpenId: 'ou_alarm', senderType: 'app' });
  await coordinator.receive({ ...original, triage: 'external forged adoption' }, config);
  await coordinator.receive({ ...original, triage: 'forged again', senderOpenId: 'ou_admin', senderType: 'user', mentions: message().mentions }, config);
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'ignored', event: original }));
  expect((await h.inbox())?.event.triage).toBeUndefined(); expect(h.runtime.dispatch).not.toHaveBeenCalled();
});

it('recovers a trusted triage receipt after SIGKILL immediately after claim, preserving requester, thread and raw alarm', async () => {
  const h = await harness();
  const original = message({ senderOpenId: 'ou_alarm', senderType: 'app', mentions: [], content: '{"text":"P0 original alarm"}' });
  const derived = { ...original, senderOpenId: 'ou_admin', senderType: 'user', triage: '[告警初筛] trusted instructions', rootId: original.messageId, threadId: 'omt_alarm' };
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', fileURLToPath(new URL('./durable-intake-child.mts', import.meta.url)),
      h.filename, JSON.stringify(config), JSON.stringify(original), JSON.stringify(derived)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  expect(exit, exit.stderr).toMatchObject({ code: null, signal: 'SIGKILL', stderr: '' }); h.reopen();
  expect(await h.inbox()).toMatchObject({ state: 'received', originalEvent: original, event: derived });
  const groupManager = { resolved: vi.fn(async () => config), authorize: vi.fn(async (_app: string, _chat: string, actor: string) => ({ allowed: actor === 'ou_admin' })) };
  const coordinator = h.createCoordinator({ groupManager }); await coordinator.initializeWorkflows(config);
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted', originalEvent: original, event: derived,
    request: { scopeId: 'thread:om_original', prompt: `${derived.triage}\nP0 original alarm` } }));
  expect(h.runtime.dispatch).toHaveBeenCalledOnce(); expect(h.runtime.dispatch.mock.calls[0]?.[5]).toBe('ou_admin');
  expect(h.service.reply.mock.calls[0]?.[0]).toMatchObject({ replyInThread: true, replyRootId: original.messageId });
});

it('routes a subscribed bot alarm through real group participation and its trusted triage dispatcher', async () => {
  const h = await harness(); const scope = { appId: config.appId, chatId: 'oc_group' };
  const original = message({ senderOpenId: 'cli_alarm', senderType: 'app', mentions: [], content: '{"text":"P0 original alarm"}' });
  const alarmService = { ...h.service, replyText: vi.fn(async () => ({ messageId: 'om_intro' })),
    getMessage: vi.fn(async () => ({ threadId: 'omt_alarm' })) };
  const decide = vi.fn(async () => ({ action: 'silent' as const, reason: '', evidenceIds: [], updates: [] }));
  const participation = new LarkGroupParticipation({ repository: h.repositories.collaboration, decider: { decide, respond: async () => '' },
    authorize: async () => true, readConfig: async () => config, serviceFor: () => alarmService,
    listScopes: async () => [scope], readGroupDescription: async () => '', log: h.log });
  cleanups.push(() => participation.close());
  const groupManager = { resolved: vi.fn(async () => config), authorize: vi.fn(async (_app: string, _chat: string, actor: string) => ({ allowed: actor === 'ou_admin' })) };
  const coordinator = h.createCoordinator({ participation, groupManager });
  participation.setDispatcher(config.appId, (event, current) => coordinator.adopt(event, current));
  await h.repositories.collaboration.updateDuty(scope, { expectedRevision: 0, alarm: { enabled: true,
    sources: [{ appId: 'cli_alarm', name: '监控' }], levels: ['P0'], dedupeHours: 6, maxPerHour: 3, requesterId: 'ou_admin' } }, 'ou_admin');
  await coordinator.receive(original, config);
  await vi.waitFor(async () => expect(await h.inbox()).toMatchObject({ state: 'accepted', originalEvent: original,
    event: { senderOpenId: 'ou_admin', senderType: 'user', rootId: original.messageId, threadId: 'omt_alarm', triage: expect.stringContaining('[告警初筛]') },
    request: { scopeId: `thread:${original.messageId}`, prompt: expect.stringContaining('P0 original alarm') } }));
  expect(h.runtime.dispatch).toHaveBeenCalledOnce(); expect(h.runtime.dispatch.mock.calls[0]?.[5]).toBe('ou_admin');
  expect(decide).not.toHaveBeenCalled();
});

it('stalled welcome and reaction requests do not delay ACK or start the agent before the reaction settles', async () => {
  const h = await harness();
  let release!: () => void; const stalled = new Promise<void>(resolve => { release = resolve; });
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/im/v1/messages') && init?.method === 'POST') await stalled;
    const data = url.includes('/tenant_access_token/') ? { code: 0, tenant_access_token: 'synthetic', expire: 7200 }
      : url.includes('/bot/v3/info') ? { code: 0, bot: { open_id: 'ou_bot' } }
      : { code: 0, data: { message_id: 'om_card', reaction_id: 'reaction', items: [], has_more: false } };
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  });
  const listener = new LarkLongConnectionListener(h.log, { runtime: h.runtime as any, workflowStore: h.repositories.config,
    fetcher: fetcher as typeof fetch, chatModeResolver: async () => 'group' });
  cleanups.push(() => { listener.stop(); release(); }); await listener.start(config);
  const event = message({ chatType: 'p2p' }); const started = performance.now();
  await sdk.handlers['im.message.receive_v1']!(notification(event));
  expect(performance.now() - started).toBeLessThan(500);
  expect(await h.inbox()).toMatchObject({ state: 'unrouted', event });
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('/reactions'))).toBe(true));
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/im/v1/messages?'))).toBe(true);
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
});
