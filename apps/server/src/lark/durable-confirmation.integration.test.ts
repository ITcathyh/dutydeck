import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { RelayAskBroker } from '@dutydeck/relay';
import type { AgentConfig, AgentDriver } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { buildLarkCard, LarkServiceError } from './service.js';
import type { LarkInteraction } from './workflow-interactions.js';
import type { LarkMessageEvent } from './listener.js';
import { LarkLongConnectionListener, LarkLongConnectionListenerPool } from './listener.js';
import { LarkTaskInbox } from './task-inbox.js';
import { buildApp } from '../app.js';
import { runNativeAskHook } from '../native-ask-hook.js';
import { RelayCapabilityRegistry } from '@dutydeck/relay';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); });
const event = (messageId: string, text = '把发布会事项记到待办 A', actor = 'ou_alice'): LarkMessageEvent => ({
  messageId, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root', senderOpenId: actor,
  senderType: 'user', messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot', mentionedType: 'bot' }]
});
async function harness(options: { deliveryFailures?: number; threaded?: boolean; chatType?: string; continuation?: 'ask' | 'permission'; native?: boolean; legacy?: boolean; beforeMarkerCrash?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-durable-confirmation-'));
  let repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const sends: string[] = [];
  let finish: (() => void) | undefined;
  const createRuntime = () => new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_agent, _protocol, emit) => {
      const cancel = () => { emit({ type: 'completed', data: { stopReason: 'cancelled' } }); finish?.(); finish = undefined; };
      const driver: AgentDriver = { start: async () => {}, resume: async () => {}, interrupt: async () => cancel(), stop: async () => cancel(), isStopped: async () => true,
        resolvePermission: async () => true,
        send: async prompt => {
          sends.push(prompt);
          if (sends.length === 1) await new Promise<void>(resolve => { finish = resolve; });
          else if (options.continuation) {
            if (options.continuation === 'permission') emit({ type: 'permission_request', data: { id: 'next_permission', title: '修改文件', status: 'pending', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } });
            await new Promise<void>(resolve => { finish = resolve; });
          }
          else { emit({ type: 'text', data: { text: '已按固定对象处理' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }
        }
      };
      return driver;
    }
  });
  let runtime = createRuntime();
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd,
    env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const createBroker = () => new RelayAskBroker({ publish: async (id, input) => { await runtime.publishSessionEvent(id, 'text', { relay: input.kind, text: input.text, askId: input.askId }); } });
  let broker = createBroker();
  await broker.initialize();
  let config: StoredLarkConfig = { appId: 'cli_durable', appSecret: 'fixture', workspace: cwd, defaultAgentId: 'mock', listening: true,
    fullTrustConfirmed: true, permissionMode: 'ask', preInjectPrompt: '', structuredAskCards: false, groupCardMention: false,
    groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [],
    highRiskPattern: 'dangerous', riskControlMode: 'off', adhdMode: true };
  const save = async (patch: Partial<StoredLarkConfig>) => { config = { ...config, ...patch }; await repos.config.set(larkBotsConfigKey, JSON.stringify([config])); };
  await save({});
  let card = 0;
  let deliveryFailures = options.deliveryFailures ?? 0;
  const createCard = vi.fn(async (input: any) => {
    if (/^[a-f0-9]{24}$/.test(input.taskId ?? '') && deliveryFailures-- > 0) throw new Error('fixture delivery unavailable');
    return { messageId: `om_card_${++card}` };
  });
  const rejectedIds: string[] = [];
  const validMessageId = (id: string) => { if (!id.startsWith('om_')) { rejectedIds.push(id); throw new LarkServiceError('LARK_OPENAPI_ERROR', `invalid message_id: ${id}`, 400); } };
  const service = { send: createCard, reply: vi.fn(async (input: any) => { validMessageId(input.messageId); return createCard(input); }), update: vi.fn(async (input: any) => { validMessageId(input.messageId); return {}; }),
    addReaction: vi.fn(async (id: string) => { validMessageId(id); return { reactionId: 'r' }; }), deleteReaction: vi.fn(async (id: string) => { validMessageId(id); }),
    getUserEmails: vi.fn(async () => [] as string[]), listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_bob' }, { memberId: 'ou_eve' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })), getMessageItems: vi.fn(async (id: string) => { validMessageId(id); return []; }),
    getMessage: vi.fn(async (id: string) => { validMessageId(id); return { messageId: 'om_original', chatId: 'oc_group', messageType: 'text', rawContent: '{"text":"原任务 A"}', mentions: [] }; }) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const create = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings,
    async () => 'group', undefined, undefined, { store: repos.config, broker });
  let coordinator = create();
  await coordinator.initializeWorkflows(config);
  const interactions = async () => (await repos.config.list!(`lark.interaction.${config.appId}.`)).map(row => JSON.parse(row.value) as LarkInteraction);
  const original = event('om_original');
  if (options.chatType) original.chatType = options.chatType;
  if (options.threaded === false) { delete original.threadId; delete original.rootId; }
  await coordinator.handle(original, config);
  await vi.waitFor(() => expect(sends).toHaveLength(1));
  const sessionId = (await repos.sessions.list())[0]!.id;
  const owner = runtime.getActiveTaskContext(sessionId)!;
  const defer = () => broker.register({ sessionId, question: '确认写入 A？', choices: [{ label: '确认写入', value: 'write' }, { label: '取消', value: 'cancel' }] }, owner);
  const capabilities = new RelayCapabilityRegistry({ get: id => runtime.getSession(id) }, 'http://localhost', 'fixture');
  // Delivery-backoff tests own the fake clock; HTTP handshake coverage uses real timers.
  const app = options.deliveryFailures === undefined && !options.legacy ? await buildApp(runtime, { relay: { runtime, broker, capabilities } }) : undefined;
  const headers = { authorization: `Bearer ${capabilities.tokenFor(sessionId)}` };
  if (options.beforeMarkerCrash) vi.spyOn(runtime, 'deferTurn').mockRejectedValueOnce(new Error('crash before host marker commit'));
  let result: { status: string; askId: string };
  if (options.native) {
    const output = JSON.parse(await runNativeAskHook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{
      question: '确认写入 A？\n\n实际目标表：[待办表](https://example.com/table)', options: [{ label: '确认写入', description: '不应在卡正文里显示的说明' }]
    }] } }, { env: { dutydeck_relay_url: 'http://localhost/api/relay', dutydeck_relay_token: capabilities.tokenFor(sessionId) },
      fetcher: async (_url, init) => {
        const response = await app!.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers, payload: JSON.parse(String(init?.body)) });
        return new Response(response.body, { status: response.statusCode });
      } }));
    expect(output.continue).toBe(false);
    result = { status: 'deferred', askId: /^deferred:([^ ]+)/.exec(output.stopReason)![1]! };
  } else {
    const response = await app?.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers,
      payload: { question: '确认写入 A？', choices: [{ label: '确认写入', value: 'write' }, { label: '取消', value: 'cancel' }] } });
    if (options.beforeMarkerCrash) {
      expect(response!.statusCode).toBe(500);
      const registered = (await interactions()).find(item => item.durable)!;
      result = { status: 'deferred', askId: registered.id };
    } else result = response ? response.json() : await defer();
  }
  expect(result.status).toBe('deferred');
  const record = (await interactions()).find(item => item.durable)!;
  if (options.beforeMarkerCrash) await runtime.shutdown();
  else if (app) await app.inject({ method: 'POST', url: '/api/relay/sessions/self/deferred-ack', headers, payload: { askId: result.askId } });
  else if (options.legacy) await runtime.interrupt(sessionId, owner.taskId, 'ou_alice');
  else { await runtime.deferTurn(sessionId, owner.taskId, result.askId, false, owner.attemptId); await runtime.deferTurn(sessionId, owner.taskId, result.askId, true, owner.attemptId); }
  await vi.waitFor(() => expect(runtime.getActiveTaskContext(sessionId)).toBeUndefined());
  const click = (actor = 'ou_alice', answer = 'write') => coordinator.handleAction({ dutydeck_workflow: 'answer', request_id: record.id,
    generation: record.boot, answer }, actor, { messageId: record.cardId!, chatId: original.chatId });
  cleanups.push(async () => { await app?.close(); coordinator.stop(); broker.close(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  return { get repos() { return repos; }, get runtime() { return runtime; }, get broker() { return broker; }, service, log, rejectedIds, record, sessionId, owner, sends, save, click, defer, interactions, get config() { return config; }, get coordinator() { return coordinator; },
    restart: async () => { coordinator.stop(); coordinator = create(); await coordinator.initializeWorkflows(config); },
    restartService: async () => {
      coordinator.stop(); broker.close(); await runtime.shutdown(); repos.close();
      repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
      runtime = createRuntime(); await runtime.initialize([agent]); broker = createBroker(); await broker.initialize();
      coordinator = create(); await coordinator.initializeWorkflows(config);
    },
    waitConfirmed: () => vi.waitFor(async () => expect((await interactions()).find(item => item.id === record.id)?.state).toBe('answered')) };
}

describe('ADHD durable confirmation — actual Runtime and SQLite', () => {
  it('never redispatches a confirmation if the service exits after card registration but before its host marker', async () => {
    const h = await harness({ beforeMarkerCrash: true });
    expect((await h.runtime.getEvents(h.sessionId)).some(event => event.id.startsWith('deferred:'))).toBe(false);
    expect(h.repos.execution.getTaskExecution(h.owner.taskId)?.task.status).toBe('reconcile_required');
    await h.restartService();
    for (let count = 0; count < 3; count++) await h.coordinator.reconcile(h.config);
    expect(h.sends).toHaveLength(1);
    expect(await h.repos.config.list!(`lark.redispatch.${h.config.appId}.`)).toEqual([]);
    expect(h.repos.execution.getTaskExecution(h.owner.taskId)?.currentAttempt?.settlement).toBeUndefined();
    expect((await h.interactions()).find(item => item.id === h.record.id)?.state).toBe('pending');
    await h.click(); await h.waitConfirmed();
    const replay = await new LarkTaskInbox(h.repos.config).lookup(h.config.appId, `confirmation_${h.record.id}`);
    expect(replay?.workflowRequestId).toBe(h.record.id);
    expect(replay?.sessionId).toBe(h.sessionId);
    expect(h.repos.execution.getTaskExecution(h.owner.taskId)?.task.status).toBe('reconcile_required');
    expect(h.repos.execution.getTaskExecution(h.owner.taskId)?.currentAttempt?.settlement).toBeUndefined();
    expect(h.sends).toHaveLength(1);
  });

  it('rejects an old held replay action for an already registered confirmation', async () => {
    const h = await harness({ legacy: true });
    const mapping = (await h.repos.channelMappings.list(`lark-card:${h.config.appId}`)).find(item => item.externalId === 'om_original')!;
    const saved = JSON.parse(mapping.extra!);
    const key = `lark.redispatch.${h.config.appId}.om_original.1`;
    const held = { id: 'held_old', boot: 'old', phase: 'held', action: 'rerun_in_new_session', appId: h.config.appId, taskId: 'om_original', turn: 1,
      chatId: 'oc_group', cardMessageId: saved.card_message_id, taskName: '原请求', sessionId: h.sessionId, runtimeTaskId: h.owner.taskId, operatorOpenId: 'ou_alice',
      redispatch: { count: 0, resumed: false, auto: true, code: 'DAEMON_SHUTDOWN' } };
    await h.repos.config.set(key, JSON.stringify(held));
    const retry = await h.coordinator.handleAction({ action: 'replay_turn', task_id: 'om_original', turn: 1 }, 'ou_alice', { messageId: saved.card_message_id, chatId: 'oc_group' });
    expect(retry).toMatchObject({ type: 'warning', content: '确认已登记，请使用原确认卡。' });
    expect(JSON.parse((await h.repos.config.get(key))!).phase).toBe('held');
    expect(h.sends).toHaveLength(1);
  });

  it('rejects an old retry callback after durable registration rather than dispatching the same message as turn two', async () => {
    const h = await harness();
    await vi.waitFor(async () => {
      const mapping = await h.repos.channelMappings.get(`lark-card:${h.config.appId}`, 'om_original');
      expect(['cancelled', 'interrupted']).toContain(JSON.parse(mapping!.extra!).state);
    });
    const retry = await h.coordinator.handleAction({ action: 'retry', task_id: 'om_original', turn: 1 }, 'ou_alice', { messageId: 'om_original', chatId: 'oc_group' });
    // A successful retry response schedules dispatch asynchronously; observe its actual admission before asserting no replay.
    if (retry.type === 'success') await vi.waitFor(async () => expect(await h.runtime.getTasks(h.sessionId)).toHaveLength(2));
    expect(await h.runtime.getTasks(h.sessionId)).toHaveLength(1);
    expect(h.sends).toHaveLength(1);
    expect(retry).toMatchObject({ type: 'warning', content: '确认已登记，请使用原确认卡。' });
  });

  it('recognizes confirmations registered before host markers existed when rejecting a restored retry card', async () => {
    const h = await harness({ legacy: true });
    expect((await h.runtime.getEvents(h.sessionId)).some(event => event.id.startsWith('deferred:'))).toBe(false);
    const retry = await h.coordinator.handleAction({ action: 'retry', task_id: 'om_original', turn: 1 }, 'ou_alice', { messageId: 'om_original', chatId: 'oc_group' });
    expect(retry).toMatchObject({ type: 'warning', content: '确认已登记，请使用原确认卡。' });
    await h.restart();
    await h.coordinator.handle(event('om_retry_legacy', '/retry'), h.config);
    expect(h.sends).toHaveLength(1);
  });

  it('does not treat a later queued cancellation as the earlier task confirmation', async () => {
    const h = await harness({ continuation: 'ask' });
    await h.coordinator.handle(event('om_hold', '先处理另一项'), h.config);
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    await h.coordinator.handle(event('om_queued', '排队的独立请求'), h.config);
    await vi.waitFor(async () => expect(await h.runtime.getTasks(h.sessionId)).toHaveLength(3));
    const queued = (await h.runtime.getTasks(h.sessionId))[2]!;
    await h.runtime.cancelQueued(h.sessionId, queued.id, 'ou_alice');
    await vi.waitFor(() => expect([...h.service.send.mock.calls, ...h.service.reply.mock.calls].some(([input]: any) => input.cardKind === 'result' && input.taskId === 'om_queued' && input.state === 'cancelled')).toBe(true));
    await h.coordinator.reconcile(h.config);
    const retry = await h.coordinator.handleAction({ action: 'retry', task_id: 'om_queued', turn: 1 }, 'ou_alice', { messageId: 'om_queued', chatId: 'oc_group' });
    expect(retry).toMatchObject({ type: 'success', content: '已开始重试' });
  });
  it('keeps a native question markdown intact while excluding option descriptions from the ADHD card', async () => {
    const h = await harness({ native: true });
    const question = '确认写入 A？\n\n实际目标表：[待办表](https://example.com/table)';
    expect(h.record.question).toBe(question);
    const cardInput = h.service.reply.mock.calls.find(([input]) => input.taskId === h.record.id)![0];
    expect(cardInput.elements[0]).toEqual({ tag: 'markdown', content: question });
    const card = buildLarkCard(cardInput);
    expect(card).not.toHaveProperty('header');
    expect(JSON.stringify(card)).not.toContain('不应在卡正文里显示的说明');
    expect(cardInput.elements[1]).toMatchObject({ tag: 'button', type: 'primary' });
    expect(cardInput.elements).toHaveLength(2);
  });

  it('settles a deferred ask quietly without attributing a user interrupt, retrying or replaying the original request', async () => {
    const h = await harness();
    const tasks = await h.runtime.getTasks(h.sessionId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'cancelled' });
    expect(tasks[0]!.interruptedByActor).toBeUndefined();
    const attempt = h.repos.execution.getTaskExecution(h.owner.taskId)!.currentAttempt!;
    expect(attempt.settlement).toMatchObject({ kind: 'driver_result', outcome: 'cancelled', stopReason: `deferred:${h.record.id}` });
    await h.coordinator.reconcile(h.config);
    await h.restart();
    await h.coordinator.reconcile(h.config);
    expect(h.sends).toHaveLength(1);
    const retry = await h.coordinator.handleAction({ action: 'retry', task_id: 'om_original', turn: 1 }, 'ou_alice', { messageId: 'om_original', chatId: 'oc_group' });
    expect(retry.type).toBe('warning');
    await h.coordinator.handle(event('om_retry', '/retry'), h.config);
    expect(h.sends).toHaveLength(1);
    const results = [...h.service.send.mock.calls, ...h.service.reply.mock.calls].filter(([input]: any) => input.cardKind === 'result');
    expect(results).toEqual([]);
    expect(h.service.addReaction).not.toHaveBeenCalledWith(expect.anything(), 'THUMBSDOWN');
    expect((await h.interactions()).find(item => item.id === h.record.id)?.state).toBe('pending');
    await h.click(); await h.waitConfirmed();
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    expect(h.sends[1]).toContain(h.record.id);
  });
  it.each([true, false])('uses real reply anchors after confirmation for nested ask, permission and results (threaded=%s)', async threaded => {
    for (const continuation of ['ask', 'permission', undefined] as const) {
      const h = await harness({ threaded, continuation });
      await h.click(); await h.waitConfirmed();
      await vi.waitFor(() => expect(h.sends).toHaveLength(2));
      const syntheticId = `confirmation_${h.record.id}`;
      const anchor = threaded ? 'om_root' : h.record.cardId!;
      const inbox = await new LarkTaskInbox(h.repos.config).lookup(h.config.appId, syntheticId);
      expect(inbox?.event).toMatchObject({ messageId: syntheticId, replyMessageId: anchor });
      if (continuation === 'ask') {
        const next = await h.broker.register({ sessionId: h.sessionId, question: '再次确认 B？', choices: [{ label: '确认 B', value: 'write_b' }] }, h.runtime.getActiveTaskContext(h.sessionId)!);
        expect(next.status).toBe('deferred');
        const nested = (await h.interactions()).find(record => record.durable && record.id !== h.record.id)!;
        expect(nested.cardId).toMatch(/^om_/); expect(nested.state).toBe('pending');
        expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskId: nested.id, messageId: anchor, ...(threaded ? { replyInThread: true } : {}) }));
      } else if (continuation === 'permission') {
        await vi.waitFor(async () => expect((await h.interactions()).find(record => record.kind === 'permission')?.cardId).toMatch(/^om_/));
        const permission = (await h.interactions()).find(record => record.kind === 'permission')!;
        expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskId: permission.id, messageId: anchor }));
      } else {
        await vi.waitFor(() => expect(h.service.reply.mock.calls.some(([input]) => input.taskId === syntheticId && input.state === 'completed')).toBe(true));
        expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskId: syntheticId, messageId: anchor, state: 'completed' }));
      }
      expect(h.rejectedIds).toEqual([]);
      expect(h.service.reply.mock.calls.every(([input]) => input.messageId.startsWith('om_'))).toBe(true);
      for (const method of [h.service.addReaction, h.service.deleteReaction, h.service.getMessage, h.service.getMessageItems]) expect(method.mock.calls.every(([id]) => id.startsWith('om_'))).toBe(true);
      const mapping = await h.repos.channelMappings.get(`lark-card:${h.config.appId}`, syntheticId);
      expect(JSON.parse(mapping!.extra!).reply_message_id).toBe(anchor);
      await h.click(); expect(await h.repos.config.list!(`lark.inbox.${h.config.appId}.confirmation_`)).toHaveLength(1);

    }
  });

  it.each([true, false, 'p2p'] as const)('retains real anchors across a seed crash and full service restart, then delivers another confirmation (threaded=%s)', async threaded => {
    const h = await harness({ threaded: threaded === true, chatType: threaded === 'p2p' ? 'p2p' : 'group', continuation: 'ask' });
    const seed = LarkTaskInbox.prototype.seed;
    const spy = vi.spyOn(LarkTaskInbox.prototype, 'seed').mockImplementationOnce(async function (...args) {
      await seed.apply(this, args); throw new Error('crash after seed');
    });
    await h.click(); spy.mockRestore();
    const syntheticId = `confirmation_${h.record.id}`;
    const anchor = threaded === true ? 'om_root' : h.record.cardId!;
    expect((await new LarkTaskInbox(h.repos.config).lookup(h.config.appId, syntheticId))?.event.replyMessageId).toBe(anchor);
    await h.restartService();
    await h.waitConfirmed(); await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    await h.broker.register({ sessionId: h.sessionId, question: '重启后再次确认？', choices: [{ label: '确认', value: 'yes' }] }, h.runtime.getActiveTaskContext(h.sessionId)!);
    const nested = (await h.interactions()).find(record => record.durable && record.id !== h.record.id)!;
    expect(nested).toMatchObject({ state: 'pending', event: { messageId: syntheticId, replyMessageId: anchor } });
    expect(nested.cardId).toMatch(/^om_/);
    const saved = JSON.parse((await h.repos.channelMappings.get(`lark-card:${h.config.appId}`, syntheticId))!.extra!);
    expect(saved.reply_message_id).toBe(anchor);
    const restored = (h.coordinator as any).restoredCardTask(h.config, { externalId: syntheticId, sessionId: h.sessionId }, saved);
    expect(restored.event).toMatchObject({ messageId: syntheticId, replyMessageId: anchor });
    expect(h.rejectedIds).toEqual([]);
    expect(h.service.reply.mock.calls.every(([input]) => input.messageId.startsWith('om_'))).toBe(true);
    await h.click(); expect(await h.repos.config.list!(`lark.inbox.${h.config.appId}.confirmation_`)).toHaveLength(1);
  });
  it('has only question/buttons, survives five minutes and later same-session messages, and snapshots the original object', async () => {
    const h = await harness();
    expect(h.record.expiresAt).toBeUndefined();
    expect(h.broker.listPending()).toEqual([]);
    const card = h.service.reply.mock.calls.find(([input]) => input.taskId === h.record.id)![0];
    const json = JSON.stringify(buildLarkCard(card));
    expect(json).toContain('确认写入 A');
    expect(json).not.toContain('task_status');
    expect(json).not.toContain('回答截止时间');
    expect(json).not.toContain('可选项：');
    expect(json).not.toContain('引用本卡片');
    await h.coordinator.handle(event('om_later', '现在处理 B'), h.config);
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
    await h.coordinator.reconcile(h.config);
    expect((await h.interactions())[0]!.state).toBe('pending');
    expect(await h.click()).toMatchObject({ type: 'success' });
    await h.waitConfirmed();
    await vi.waitFor(() => expect(h.sends).toHaveLength(3));
    expect(h.sends[2]).toContain(h.record.id);
    expect(h.sends[2]).toContain('确认写入 A');
    expect(h.sends[2]).toContain('发布会事项记到待办 A');
    expect(h.sends[2]).toContain('写入前按原流程检索去重');
    expect(h.sends[2]).toContain('write');
    expect((await new LarkTaskInbox(h.repos.config).lookup(h.config.appId, `confirmation_${h.record.id}`))?.sessionId).toBe(h.sessionId);
    expect((await h.repos.sessions.list())).toHaveLength(1);
    expect(h.service.update.mock.calls.some(([input]) => JSON.stringify(input).includes('已确认写入'))).toBe(true);
  });
  it('restores pending cards after SQLite reopen and fresh Runtime/broker/coordinator restart without re-creating a waiter', async () => {
    const h = await harness();
    const cardsBefore = h.service.reply.mock.calls.length;
    await h.restartService();
    expect(h.service.reply.mock.calls.length).toBe(cardsBefore);
    expect((await h.interactions())[0]!.state).toBe('pending');
    expect(await h.click()).toMatchObject({ type: 'success' });
    await h.waitConfirmed();
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    expect(h.broker.listPending()).toEqual([]);
  });
  it.each([1, 20])('automatically retries failed durable card delivery with a five-attempt cap (%i failures)', async deliveryFailures => {
    vi.useFakeTimers();
    const h = await harness({ deliveryFailures });
    expect(h.record.cardId).toBeUndefined();
    await vi.advanceTimersByTimeAsync(deliveryFailures === 1 ? 7_000 : 85_000);
    const record = (await h.interactions())[0]!;
    if (deliveryFailures === 1) { expect(record.cardId).toBeDefined(); expect(record.state).toBe('pending'); expect(record.deliveryAttempts).toBe(2); }
    else { expect(record.cardId).toBeUndefined(); expect(record.state).toBe('expired'); expect(record.deliveryAttempts).toBe(5); }
    expect(h.sends).toHaveLength(1);
  });
  it('rejects an idle ADHD Lark ask instead of falling back to the legacy waiter', async () => {
    const h = await harness();
    await expect(h.broker.register({ sessionId: h.sessionId, question: 'stale', choices: [{ label: 'yes' }] }))
      .rejects.toMatchObject({ code: 'LARK_CONFIRMATION_ENDED' });
    expect(h.broker.listPending()).toEqual([]);
    expect(await h.interactions()).toHaveLength(1);
  });
  it('does not register a confirmation when cancellation wins a storage-list await before create', async () => {
    const h = await harness();
    const workflow = (h.coordinator as any).workflows;
    const list = h.repos.config.list!.bind(h.repos.config);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(h.repos.config, 'list').mockImplementationOnce(async prefix => { entered(); await gate; return list(prefix); });
    const controller = new AbortController();
    const deferred = workflow.defer({ appId: h.record.appId, sessionId: h.sessionId, taskId: 'task_registration_lost', turn: 1, event: h.record.event },
      { sessionId: h.sessionId, question: 'should never register', choices: [{ label: 'Y' }] }, h.record.durable!.snapshot, controller.signal);
    await started; controller.abort(); release();
    await expect(deferred).rejects.toMatchObject({ code: 'LARK_CONFIRMATION_ENDED' });
    spy.mockRestore();
    expect((await h.interactions()).filter(record => record.durable)).toHaveLength(1);
    expect(JSON.stringify(h.service.reply.mock.calls)).not.toContain('should never register');
  });
  it('CAS and durable inbox deduplicate concurrent and repeated callbacks', async () => {
    const h = await harness();
    await Promise.all([h.click(), h.click(), h.click()]);
    await h.waitConfirmed();
    await h.click();
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    const rows = await h.repos.config.list!(`lark.inbox.${h.config.appId}.confirmation_`);
    expect(rows).toHaveLength(1);
  });
  it('rejects outsiders and forged choices; current explicit high-risk list can confirm for the requester', async () => {
    const h = await harness();
    expect(await h.click('ou_eve')).toMatchObject({ type: 'error', content: '当前账号无权确认。' });
    expect(await h.click('ou_alice', 'forged')).toMatchObject({ type: 'error' });
    expect((await h.interactions())[0]!.state).toBe('pending');
    await h.save({ highRiskAllowedUsers: [{ openId: 'ou_bob', name: 'Bob' }] });
    expect(await h.click('ou_bob')).toMatchObject({ type: 'success' });
    await h.waitConfirmed();
  });
  it('immediately honors high-risk list revocation without burning the requester card', async () => {
    const h = await harness();
    await h.save({ highRiskAllowedUsers: [{ openId: 'ou_bob', name: 'Bob' }] });
    await h.save({ highRiskAllowedUsers: [] });
    expect(await h.click('ou_bob')).toMatchObject({ type: 'error' });
    expect((await h.interactions())[0]!.state).toBe('pending');
    expect(await h.click()).toMatchObject({ type: 'success' });
  });
  it.each(['archive', 'listening', 'requester'] as const)('terminates without input when original %s is withdrawn', async reason => {
    const h = await harness();
    if (reason === 'archive') await h.runtime.archive(h.sessionId);
    if (reason === 'listening') await h.save({ listening: false });
    if (reason === 'requester') await h.save({ allowedUsers: [{ openId: 'ou_bob', name: 'Bob' }] });
    expect(await h.click()).toMatchObject({ type: 'error', content: '已结束，未执行' });
    expect((await h.interactions())[0]!.state).toBe('expired');
    expect(await h.repos.config.list!(`lark.inbox.${h.config.appId}.confirmation_`)).toEqual([]);
    expect(JSON.stringify(h.service.update.mock.calls)).toContain('已结束，未执行');
    expect(h.sends).toHaveLength(1);
  });
  it.each(['before', 'after'] as const)('recovers a resolving crash %s inbox seed, retaining one original-session input', async where => {
    const h = await harness();
    const seed = LarkTaskInbox.prototype.seed;
    const spy = vi.spyOn(LarkTaskInbox.prototype, 'seed').mockImplementationOnce(async function (...args) {
      if (where === 'after') await seed.apply(this, args);
      throw new Error('simulated process crash');
    });
    expect(await h.click()).toMatchObject({ type: 'error' });
    expect((await h.interactions())[0]!.state).toBe('resolving');
    spy.mockRestore();
    await h.restart();
    await h.waitConfirmed();
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    expect(await h.repos.config.list!(`lark.inbox.${h.config.appId}.confirmation_`)).toHaveLength(1);
    expect((await h.repos.sessions.list())).toHaveLength(1);
  });
  it('pool disable persists and closes durable cards before removing HTTP/callback listening', async () => {
    const h = await harness();
    const httpClose = vi.fn(() => { expect(JSON.stringify(h.service.update.mock.calls)).toContain('已结束，未执行'); });
    const start = vi.spyOn(LarkLongConnectionListener.prototype, 'start').mockImplementation(async function (this: LarkLongConnectionListener) {
      Object.assign(this, { config: h.config, coordinator: h.coordinator, http: { close: httpClose } });
    });
    const pool = new LarkLongConnectionListenerPool(h.log);
    await pool.sync([h.config]);
    await h.save({ listening: false });
    await pool.sync([h.config]);
    expect(httpClose).toHaveBeenCalledOnce();
    expect(pool.activeAppIds).toEqual([]);
    expect((await h.interactions())[0]!.state).toBe('expired');
    expect(h.sends).toHaveLength(1);
    pool.stop(); start.mockRestore();
  });
  it.each(['recover', 'exhaust', 'shutdown'] as const)('disabled bot terminal PATCH retry can %s without retaining task/WS entry points', async mode => {
    const h = await harness();
    vi.useFakeTimers();
    let closes = 0;
    h.service.update.mockImplementation(async input => {
      if (input.taskId === h.record.id && (++closes === 1 || mode !== 'recover')) throw new LarkServiceError('LARK_OPENAPI_ERROR', 'fixture PATCH failure', 502, { upstreamCode: 230099 });
      return {};
    });
    const httpClose = vi.fn();
    const wsClose = vi.fn();
    const start = vi.spyOn(LarkLongConnectionListener.prototype, 'start').mockImplementation(async function (this: LarkLongConnectionListener) {
      Object.assign(this, { config: h.config, coordinator: h.coordinator, http: { close: httpClose }, client: { close: wsClose } });
    });
    const pool = new LarkLongConnectionListenerPool(h.log);
    await pool.sync([h.config]); await h.save({ listening: false }); await pool.sync([h.config]);
    expect(pool.activeAppIds).toEqual([]);
    expect(wsClose).toHaveBeenCalledOnce();
    expect(httpClose).not.toHaveBeenCalled();
    expect(closes).toBe(1);
    if (mode === 'shutdown') pool.stop();
    else await vi.advanceTimersByTimeAsync(mode === 'recover' ? 5_050 : 80_000);
    expect(httpClose).toHaveBeenCalled();
    expect(closes).toBe(mode === 'recover' ? 2 : mode === 'exhaust' ? 5 : 1);
    expect(h.sends).toHaveLength(1);
    expect((await h.interactions())[0]!.state).toBe('expired');
    expect(h.log.warn).toHaveBeenCalledWith(expect.objectContaining({ cardId: h.record.cardId }), expect.any(String));
    pool.stop(); start.mockRestore();
  });
  it('rechecks authorization when an inbox seed is recovered after a crash', async () => {
    const h = await harness();
    const seed = LarkTaskInbox.prototype.seed;
    const spy = vi.spyOn(LarkTaskInbox.prototype, 'seed').mockImplementationOnce(async function (...args) {
      await seed.apply(this, args); throw new Error('crash after seed');
    });
    await h.click(); spy.mockRestore();
    await h.save({ allowedUsers: [{ openId: 'ou_bob', name: 'Bob' }] });
    await h.restart();
    expect(h.sends).toHaveLength(1);
    expect((await h.interactions())[0]!.state).toBe('expired');
  });
});
