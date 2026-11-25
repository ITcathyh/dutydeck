import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { RelayAskBroker, RelayCapabilityRegistry } from '@dutydeck/relay';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import { recordRiskDenial } from '@dutydeck/shared/secret-guard';
import { buildApp } from '../app.js';
import { defaultDriverProviders } from '../driver-providers.js';
import { TestLarkCoordinator } from './coordinator-test-fixture.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkGroupManager } from './group-management.js';
import { capturedRiskPolicy, workItemRiskPolicy } from '../work-item-policy.js';
import { resolveExplicitFinalContext } from './explicit-final.js';
import { installLarkHook } from './security-hooks.js';
import type { LarkMessageEvent } from './listener.js';

async function approvedTurn(options: { structured?: boolean; durable?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'lark-approved-turn-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const group = new LarkGroupManager(repos);
  const prompts: string[] = [];
  let finish: (() => void) | undefined;
  let background: boolean | undefined;
  const steer = vi.fn();
  const runtime: DutydeckRuntime = new DutydeckRuntime(repos, {
    providers: defaultDriverProviders(),
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    resolveRiskPolicy: (id, fallback) => {
      const active = runtime.getActiveTaskContext(id);
      return group.riskPolicy(id, fallback, active?.attemptId ? { ...active, token: active.attemptId, command: 'dutydeck', url: 'http://localhost/example' } : undefined);
    },
    driverFactory: (_agent, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => { finish?.(); }, interrupt: async () => { finish?.(); },
      isStopped: async () => true, isIdle: () => !finish, hasBackgroundWork: () => background === true, backgroundWorkCleared: () => background === false, steer,
      send: async prompt => {
        prompts.push(prompt);
        await new Promise<void>(resolve => { finish = resolve; });
        finish = undefined;
        emit({ type: 'text', data: { text: 'Reviewed' } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    })
  });
  const appId = 'cli_example';
  const actor = 'ou_requester';
  const config = { appId, appSecret: 'fixture', workspace: cwd, defaultAgentId: 'cursor', listening: true, permissionMode: 'full-trust',
    fullTrustConfirmed: true, structuredAskCards: options.structured ?? false, adhdMode: options.durable ?? false, groupToolsEnabled: true, highRiskAllowedUsers: [{ openId: 'ou_admin', name: 'Admin' }], highRiskAllowedEmails: [],
    allowedUsers: [], allowedEmails: [], allowedBots: [], highRiskPattern: 'publish', riskControlMode: 'enforced', pushIntervalMs: 1000 } as StoredLarkConfig;
  const original: LarkMessageEvent = { messageId: 'om_original', chatId: 'oc_example', chatType: 'group', threadId: 'omt_thread',
    rootId: 'om_root', senderType: 'user', senderOpenId: actor, messageType: 'text',
    content: '{"text":"@_bot publish reviewed files"}', mentions: [{ key: '@_bot', name: 'Bot', openId: 'ou_bot', mentionedType: 'bot' }] };
  let n = 0;
  const send = vi.fn(async (_input: { messageId?: string; taskId?: string; replyInThread?: boolean }) => ({ messageId: 'om_progress_' + ++n }));
  const service = { send, reply: send, update: vi.fn(), addReaction: vi.fn(async () => ({ reactionId: 'example' })), deleteReaction: vi.fn(),
    getUserEmails: async () => [], getContactUser: async () => ({ name: 'Requester' }), getChatPreflightInfo: async () => ({ name: 'Group' }),
    getMessageLink: async () => 'https://example.com/message', callOpenApi: vi.fn(async () => ({ data: { message_id: 'om_approval' } })),
    listChatMembers: async () => ({ items: [{ memberId: actor }, { memberId: 'ou_other' }], hasMore: false }), listChatMessages: async () => ({ items: [], hasMore: false }), getMessageItems: async () => [] };
  const broker = new RelayAskBroker({ publish: async (id, input) => {
    await runtime.publishSessionEvent(id, 'text', { relay: input.kind, text: input.text, askId: input.askId });
  } });
  await broker.initialize();
  const coordinator = new TestLarkCoordinator(runtime, service as any, { warn: vi.fn(), info: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot', undefined,
    repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, broker });
  onTestFinished(async () => { coordinator.stop(); broker.close(); finish?.(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  await installLarkHook('cursor', cwd);
  await runtime.initialize([{ id: 'cursor', name: 'Example', protocol: 'acp', cwd, command: process.execPath, args: [], env: {},
    timeout: 30, permissionMode: 'full-trust', capabilities: { pause: false, resume: true }, builtin: false }]);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  await coordinator.initializeWorkflows(config);
  await coordinator.handle(original, config);
  const wait = async (count: number) => vi.waitFor(() => expect(prompts.length).toBe(count), { timeout: 5000 });
  await wait(1);
  const [session] = await repos.sessions.list();
  const policy = async () => JSON.parse(await readFile(join(session!.cwd, '.dutydeck/security/sessions', session!.id + '.json'), 'utf8'));
  const origin = runtime.getActiveTaskContext(session!.id)!;
  const command = 'publish example';
  recordRiskDenial(session!.cwd, session!.id, await policy(), { tool_name: 'Bash', tool_input: { command } });
  await coordinator.requestRiskApproval({ sessionId: session!.id, actorId: actor, taskId: origin.taskId, turnToken: origin.attemptId!, command, summary: 'Publish reviewed files' });
  const click = await coordinator.handleAction({ risk_request: origin.taskId, decision: 'approve' }, 'ou_admin', { messageId: 'om_approval' });
  expect(click.content).toContain('已批准');
  expect(await policy()).not.toHaveProperty('approvedAttempt');
  finish!();
  await vi.waitFor(() => expect(runtime.getActiveTaskContext(session!.id)).toBeUndefined());
  background = true;
  await coordinator.reconcile(config);
  expect(await runtime.riskContinuationReady(session!.id)).toBe(false);
  expect(prompts).toHaveLength(1);
  background = false;
  await vi.waitFor(async () => expect(await runtime.riskContinuationReady(session!.id)).toBe(true));
  await coordinator.reconcile(config);
  await wait(2);
  const continuationInbox = (await repos.config.list!('lark.inbox.' + appId + '.risk_approval_')).map(row => JSON.parse(row.value));
  expect(continuationInbox).toHaveLength(1);
  expect(continuationInbox[0]).toMatchObject({ sessionId: session!.id, event: { replyMessageId: original.messageId, threadId: original.threadId } });
  const approved = runtime.getActiveTaskContext(session!.id)!;
  return { session: session!, approved, actor, original, appId, config, runtime, coordinator, service, broker, repos, prompts, steer, wait, policy,
    finish: () => finish!() };
}

it('queues other input around an exclusive approved attempt and replaces the workspace policy on settlement', async () => {
  const { session, approved, actor, original, appId, config, runtime, coordinator, broker, prompts, steer, wait, policy, finish } = await approvedTurn();
  expect(approved.actorId).toBe(actor);
  expect(prompts[1]).toContain('管理员 Admin 已批准本次请求中的高危操作');
  expect(prompts[1]).toContain('不读取、不输出、不复制、不发送凭据和 Agent 会话记录');
  expect(prompts[1]).toContain('不要去查找、阅读或试探这些限制的实现和配置');
  for (const rule of ['[Dutydeck 安全策略 · 自动注入]', '匹配以下正则', 'risk request --summary']) expect(prompts[1]).not.toContain(rule);
  expect(await policy()).toMatchObject({ authorized: false, approvedAttempt: approved.attemptId });
  expect(await runtime.isRiskApprovalActive(session.id, approved.taskId, approved.attemptId!)).toBe(true);
  const answer = broker.register({ sessionId: session.id, question: 'Which directory contains the reviewed files?' }, approved);
  const ask = await vi.waitFor(async () => {
    const [question] = await coordinator.parts.core.workflows.pendingAsks(appId, session.id);
    expect(question).toMatchObject({ taskId: approved.taskId, cardId: expect.any(String) });
    return question!;
  }, { timeout: 5000 });
  for (const [suffix, sender] of [['other','ou_other'],['next',actor]]) {
    await coordinator.handle({ ...original, senderOpenId: sender, parentId: sender === actor ? undefined : ask.cardId, messageId: 'om_' + suffix, content: JSON.stringify({ text: '@_bot request ' + suffix }) },config);
  }
  await vi.waitFor(async () => expect((await runtime.getTasks(session.id)).filter(t => t.status === 'queued')).toHaveLength(2));
  expect(broker.get(ask.nativeId)?.status).toBe('pending');
  await coordinator.handle({ ...original, parentId: ask.cardId, messageId: 'om_requester_answer', mentions: [],
    content: JSON.stringify({ text: '/examples' }) }, config);
  await expect(answer).resolves.toMatchObject({ status: 'answered', answer: '/examples' });
  expect((await runtime.getTasks(session.id)).filter(t => t.status === 'queued')).toHaveLength(2);
  const queued = (await runtime.getTasks(session.id)).find(t => t.status === 'queued')!;
  expect((await runtime.injectQueued(session.id, queued.id, 'ou_other')).outcome).toBe('incompatible');
  await runtime.steerQueued(session.id, queued.id,'ou_other');
  const other = runtime.getAcceptedTask(queued.id)!;
  const added = await runtime.dispatchRequest({ ...other.request!, key: 'interrupt_example', mode: 'interrupt', prompt: 'later input' },
    { riskPolicy: other.input!.executionContext.riskPolicy });
  expect(added.status).toBe('queued');
  expect(steer).not.toHaveBeenCalled();
  expect(runtime.getActiveTaskContext(session.id)).toEqual(approved);
  finish(); await wait(3);
  expect(await runtime.isRiskApprovalActive(session.id, approved.taskId, approved.attemptId!)).toBe(false);
  expect(await policy()).toMatchObject({ authorized: false });
  expect(await policy()).not.toHaveProperty('approvedAttempt');
  finish(); await wait(4);
  expect(await policy()).not.toHaveProperty('approvedAttempt');
  finish(); await wait(5);
  expect(await policy()).not.toHaveProperty('approvedAttempt');
}, 30_000);

it.each([false, true])('restricts structured button and form answers to the approved requester (multiple=%s)', async multiple => {
  const h = await approvedTurn({ structured: true });
  // This group permits other members to operate tasks. The exclusive turn still owns its input.
  vi.spyOn(h.coordinator.parts.core, 'currentAccess').mockResolvedValue(true);
  const answer = h.broker.register({ sessionId: h.session.id, question: 'Select files', choices: [{ label: 'Examples', value: 'examples' }], multiple }, h.approved);
  const ask = await vi.waitFor(async () => {
    const [item] = await h.coordinator.parts.core.workflows.pendingAsks(h.appId, h.session.id);
    expect(item).toMatchObject({ taskId: h.approved.taskId, structured: true, cardId: expect.any(String) });
    return item!;
  });
  const click = (actor: string) => h.coordinator.handleAction({ dutydeck_workflow: 'answer', request_id: ask.id, generation: ask.boot,
    ...(multiple ? { multiple: true, form_value: { answer: ['examples'] } } : { answer: 'examples' }) }, actor,
    { messageId: ask.cardId!, chatId: h.original.chatId });
  expect(await click('ou_other')).toMatchObject({ type: 'error', content: expect.stringContaining('只有原请求发起人') });
  expect((await h.coordinator.parts.core.workflows.pendingAsks(h.appId, h.session.id))[0]).toEqual(ask);
  expect(h.broker.get(ask.nativeId)?.status).toBe('pending');
  expect(await click(h.actor)).toMatchObject({ type: 'success' });
  await expect(answer).resolves.toMatchObject({ status: 'answered', answer: 'examples' });
});

it('resolves status, group tools, deferred session ask and confirmation replay to the original Lark topic', async () => {
  const h = await approvedTurn({ durable: true });
  const { session, approved, original, appId } = h;
  expect(await h.coordinator.agentView({ sessionId: session.id, taskId: approved.taskId, actorId: h.actor, view: 'status' }))
    .toMatchObject({ sessionId: session.id, running: 1 });
  const rows = await h.repos.channelMappings.list('lark-card:' + appId);
  const binding = { appId, sessionId: session.id, chatType: 'group' as const, chatId: original.chatId, threadId: original.threadId };
  const final = await resolveExplicitFinalContext(rows, binding, approved);
  expect(final?.scope).toMatchObject({ origin_message_id: original.messageId, reply_message_id: original.messageId,
    reply_in_thread: true, runtime_task_id: approved.taskId, lark_task_id: expect.stringMatching(/^risk_approval_/) });
  const capabilities = new RelayCapabilityRegistry({ get: id => h.runtime.getSession(id) }, 'http://localhost', 'fixture');
  const app = await buildApp(h.runtime, { relay: { runtime: h.runtime, broker: h.broker, capabilities } });
  onTestFinished(() => app.close());
  const headers = { authorization: 'Bearer ' + capabilities.tokenFor(session.id) };
  const response = await app.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers,
    payload: { question: 'Continue with the reviewed files?', choices: [{ label: 'Continue', value: 'continue' }] } });
  expect(response.statusCode).toBe(200);
  const result = response.json();
  expect(result.status).toBe('deferred');
  const ask = (await h.coordinator.parts.core.workflows.list(appId)).find(record => record.id === result.askId)!;
  expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskId: ask.id, messageId: original.messageId, replyInThread: true }));
  const ack = await app.inject({ method: 'POST', url: '/api/relay/sessions/self/deferred-ack', headers, payload: { askId: ask.id } });
  expect(ack.statusCode).toBe(200);
  await vi.waitFor(() => expect(h.runtime.getActiveTaskContext(session.id)).toBeUndefined());
  expect(await h.coordinator.handleAction({ dutydeck_workflow: 'answer', request_id: ask.id, generation: ask.boot, answer: 'continue' },
    h.actor, { messageId: ask.cardId!, chatId: original.chatId })).toMatchObject({ type: 'success' });
  await h.wait(3);
  const replay = await h.coordinator.parts.core.inbox.lookup(appId, 'confirmation_' + ask.id);
  expect(replay).toMatchObject({ sessionId: session.id, event: { replyMessageId: original.messageId, threadId: original.threadId, rootId: original.rootId } });
  expect(h.prompts[2]).toContain('持久确认记录 ID：' + ask.id);
  expect(await h.policy()).not.toHaveProperty('approvedAttempt');
});

it('captures own-runs permission for the new requester and their work item in a shared session', async () => {
  const h = await approvedTurn();
  h.finish();
  await vi.waitFor(() => expect(h.runtime.getActiveTaskContext(h.session.id)).toBeUndefined());
  const owner = h.original.senderOpenId;
  const actor = 'ou_admin';
  const manager = { resolved: async (config: StoredLarkConfig) => ({ ...config, managedGroup: { bindingId: 'example', revision: 1 } }),
    recordRun: vi.fn(), authorize: vi.fn(async (_app, _chat, id, action, _session, options) =>
      ({ allowed: action !== 'high_risk.execute' || id === (options?.taskRequesterOpenId ?? owner) })) };
  Object.assign(h.coordinator.parts.state, { groupManager: manager });
  await h.coordinator.handle({ ...h.original, messageId: 'om_own_task', senderOpenId: actor }, h.config);
  await h.wait(3);
  const task = h.runtime.getActiveTaskContext(h.session.id)!;
  expect(task.actorId).toBe(actor);
  expect(manager.authorize).toHaveBeenCalledWith(h.appId, h.original.chatId, actor, 'high_risk.execute', h.session.id, { taskRequesterOpenId: actor });
  const captured = capturedRiskPolicy(h.repos, task.taskId);
  expect(captured).toMatchObject({ enabled: true, authorized: true });
  expect(await workItemRiskPolicy(h.repos, manager as unknown as LarkGroupManager, h.session.id, actor, undefined, {}, fetch, captured))
    .toMatchObject({ enabled: true, authorized: true });
});
