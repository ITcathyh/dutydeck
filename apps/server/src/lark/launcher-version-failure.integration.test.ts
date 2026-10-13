import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentConfig, DriverContext, DriverFactory } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkGroupManager } from './group-management.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { LARK_LAUNCHER_RECOVERY_NOTE } from './card-renderer.js';
import { buildLarkCard } from './service.js';

/**
 * 旧会话启动器版本变化（ACP_LAUNCHER_VERSION_CHANGED）发生在任务提交前：
 * 真实 Runtime + SQLite，受控 ACP driver 在 prepareTurn（落「已提交」意图之前）抛错，
 * attempt 结算为 not_submitted/failed。验证自动换新只执行一次、卡片呈现与失败降级。
 */

const LAUNCHER_ERROR = 'ACP_LAUNCHER_VERSION_CHANGED: 旧会话启动器版本变化，无法自动核验；原会话记录已保留，发 /new 开新会话后重试。';

const components = (value: any): any[] => {
  if (Array.isArray(value)) return value.flatMap(components);
  if (!value || typeof value !== 'object') return [];
  return [...(typeof value.tag === 'string' ? [value] : []), ...Object.values(value).flatMap(components)];
};
const hasRetryButton = (input: any) => components(buildLarkCard(input)).some(el => el.tag === 'button' && el.element_id === 'retry');

/** 受控 ACP driver：在提交前的 prepareTurn 抛出调用方指定的错误。 */
function controlledFactory(prepare: (sessionId: string) => Promise<void>, sent: Array<{ sessionId: string; prompt: string }>): DriverFactory {
  const factory: DriverFactory = (configured, _protocol, emit, _onExit, sessionId, context) => {
    const ctx = context as DriverContext;
    return {
      start: async () => {
        if (ctx.protocol === 'controlled-v1' && ctx.native && !ctx.native.expected) {
          const expected = {
            nativeCreationId: randomUUID(), sessionKey: ctx.native.sessionKey,
            agent: configured.id, command: [process.execPath], cwd: configured.cwd ?? '/tmp', executionDomain: ctx.executionDomain
          };
          ctx.native.reserve(expected);
          ctx.native.confirmed({ ...expected, acpxRecordId: 'acp-record-1', backendSessionId: 'backend-1', defaults: {} });
        }
      },
      // markSubmissionPending 之前的准备阶段抛错：attempt 仍是 not_submitted。
      prepareTurn: async () => prepare(sessionId),
      prepareSubmission: input => ctx.prepareSubmission(input),
      send: async input => {
        const prompt = typeof input === 'string' ? input : input.prompt;
        sent.push({ sessionId, prompt });
        if (typeof input !== 'string') input.onAccepted({ submissionId: input.submissionId, kind: 'provider_accepted', provider: 'acp', receiptRef: `prompt-result:${input.submissionId}`, digest: input.inputDigest });
        emit({ type: 'text', data: { text: '请求已完成' } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      },
      interrupt: async () => {},
      resume: async () => {},
      stop: async () => {},
      isStopped: async () => true,
      configureNative: async request => {
        const prepared = ctx.prepareSubmission({
          taskId: 'configuration', attemptId: 'configuration', submissionId: request.operationId,
          prompt: '', executionOptions: { permissionMode: 'full-trust' as const }
        });
        return { context: prepared.nativeContextRef!, driverInstanceId: ctx.driverInstanceId, operationId: request.operationId, target: request.target, evidence: {} };
      }
    };
  };
  factory.controlledResources = () => true;
  return factory;
}

const groupMessage = (id: string): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', rootId: 'om_root', threadId: 'omt_topic',
  messageType: 'text', content: JSON.stringify({ text: '@_user_1 跑一下任务' }),
  senderOpenId: 'ou_alice', senderType: 'user',
  mentions: [{ key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot' }]
});

async function setup(prepareError: Error | ((sessionId: string) => Promise<void>), managedGroup = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'dd-launcher-changed-'));
  const config: StoredLarkConfig = {
    appId: 'app', appSecret: 'fixture', name: 'Dutydeck', workspace: cwd, defaultAgentId: 'launcher-fixture',
    fullTrustConfirmed: true, listening: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false,
    ...(managedGroup ? { groupReplyMode: 'shared' as const } : {}),
    groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 60_000, hideTraceOnComplete: false,
    allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off'
  };
  const agent: AgentConfig = {
    id: 'launcher-fixture', name: 'Fixture', command: 'unused', args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'full-trust', timeout: 0, capabilities: { pause: false, resume: true }, builtin: false
  };
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  const issued: any[] = [];
  const service = {
    addReaction: vi.fn(async () => ({ reactionId: 'r1' })),
    deleteReaction: vi.fn(async () => {}),
    reply: vi.fn(async (input: any) => { issued.push(input); return { messageId: `om_reply_${issued.length}` }; }),
    send: vi.fn(async (input: any) => { issued.push(input); return { messageId: `om_send_${issued.length}` }; }),
    replyText: vi.fn(async () => ({ messageId: 'om_text' })),
    update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
    getUserEmails: vi.fn(async () => ['alice@example.com']),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false }))
  };

  const prepared: string[] = [];
  const sent: Array<{ sessionId: string; prompt: string }> = [];
  const factory = controlledFactory(async sessionId => {
    prepared.push(sessionId);
    if (prepareError instanceof Error) throw prepareError;
    await prepareError(sessionId);
  }, sent);
  let groupManager: LarkGroupManager | undefined;
  const runtime = new DutydeckRuntime(repos, {
    driverIdleTimeoutMs: 0,
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: factory,
    ...(managedGroup ? { authorizeExecution: (sessionId: string, actorId?: string) => groupManager!.prepareTurn(sessionId, actorId) } : {})
  });
  await runtime.initialize([agent]);
  if (managedGroup) {
    groupManager = new LarkGroupManager(repos, { client: () => ({
      getBotInfo: async () => ({ appName: config.appId, openId: 'ou_bot' }),
      checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'synthetic-tenant' }),
      listChats: async () => ({ items: [{ chatId: 'oc_group', name: 'Launcher 群', chatMode: 'group' }], hasMore: false }),
      listChatMembers: async () => ({ items: [
        { memberId: 'ou_owner', openId: 'ou_owner', name: 'Owner', memberType: 'user' },
        { memberId: 'ou_alice', openId: 'ou_alice', name: 'Alice', memberType: 'user' },
        { memberId: 'ou_peer_bot', openId: 'ou_peer_bot', name: 'Peer bot', memberType: 'bot' }
      ], hasMore: false, securityLimited: false }),
      getUserEmails: async () => []
    }) as any });
    await groupManager.sync(config.appId);
    await groupManager.save(config.appId, 'oc_group', { expectedRevision: 0, patch: { accessOverride: { mode: 'all_chat_members' } } });
  }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinator = new LarkMessageCoordinator(runtime, service as any, log,
    Math.random, 'ou_bot', undefined, repos.channelMappings, undefined, undefined, groupManager, { store: repos.config });
  await coordinator.initializeWorkflows(config);

  const until = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('condition not reached');
  };
  return {
    cwd, config, repos, runtime, coordinator, issued, service, prepared, sent, until, factory, agent, groupManager, log,
    async teardown() { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); },
    async runTurn(id: string, patch: Partial<LarkMessageEvent> = {}) {
      await coordinator.handle({ ...groupMessage(id), ...patch }, config);
      // 结果卡自带 sessionId，等它出现后再查 runtime task，避免在会话尚未创建时读取。
      await until(() => issued.some(input => input.cardKind === 'result' && input.taskId === id));
      const resultInput = issued.filter(input => input.cardKind === 'result' && input.taskId === id).at(-1)!;
      await until(async () => (await runtime.getTasks(resultInput.sessionId)).some(task => task.status === resultInput.state));
      const task = (await runtime.getTasks(resultInput.sessionId)).find(item => item.status === resultInput.state)!;
      return { task, sessionId: resultInput.sessionId, resultInput };
    }
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each([
  { senderType: 'app', senderOpenId: 'ou_peer_bot' },
  { senderType: 'user', senderOpenId: 'ou_alice' }
])('托管群 $senderType 发送者续聊别人创建的旧会话时能自动换新', async sender => {
  let count = 0;
  const h = await setup(async () => { if (++count === 2) throw new Error(LAUNCHER_ERROR); }, true);
  cleanups.push(() => h.teardown());
  const top = { rootId: undefined, threadId: undefined };
  const old = await h.runTurn('om_owner', { ...top, senderOpenId: 'ou_owner' });
  expect((await h.groupManager!.resolved(h.config, 'oc_group')).managedGroup).toBeDefined();
  // 可以派发自己的请求，但没有操作旧会话创建者任务的权限。
  expect(await h.groupManager!.authorize('app', 'oc_group', sender.senderOpenId, 'task.create', old.sessionId)).toMatchObject({ allowed: true });
  expect(await h.groupManager!.authorize('app', 'oc_group', sender.senderOpenId, 'run.interrupt', old.sessionId)).toMatchObject({ allowed: false, code: 'operate_scope_required' });
  const authorize = vi.spyOn(h.groupManager!, 'authorize');
  const { task, resultInput } = await h.runTurn('om_managed_launcher', { ...top, ...sender });
  expect(task.status).toBe('completed');
  expect(resultInput.sessionId).not.toBe(old.sessionId);
  expect((await h.runtime.getSession(old.sessionId))?.state).toBe('stopped');
  expect(h.prepared).toEqual([old.sessionId, old.sessionId, resultInput.sessionId]);
  expect(h.sent.filter(item => item.sessionId === resultInput.sessionId)).toHaveLength(1);
  expect((await h.repos.tasks.get!(task.id))?.executionContext?.actorId).toBe(sender.senderOpenId);
  expect(authorize.mock.calls.filter(call => call[2] === sender.senderOpenId && call[3] === 'task.create' && call.length === 5)).toHaveLength(2);
  expect(h.issued.filter(input => input.cardKind === 'result' && input.taskId === 'om_managed_launcher').map(input => input.state)).toEqual(['completed']);
  expect(h.service.update.mock.calls.filter(([input]) => input.taskId === 'om_managed_launcher').some(([input]) =>
    JSON.stringify(buildLarkCard(input)).includes(LARK_LAUNCHER_RECOVERY_NOTE))).toBe(true);
});

it('失败事件先于 dispatch 返回时先缓存，取得任务号后仍能自动换新', async () => {
  let count = 0;
  const h = await setup(async () => { if (++count === 1) throw new Error(LAUNCHER_ERROR); });
  cleanups.push(() => h.teardown());
  const dispatch = h.runtime.dispatch.bind(h.runtime);
  let failedTaskId: string | undefined;
  vi.spyOn(h.runtime, 'dispatch').mockImplementationOnce(async (...args) => {
    let failed!: (taskId: string) => void;
    const failure = new Promise<string>(resolve => { failed = resolve; });
    const unsubscribe = h.runtime.subscribe(args[0], event => {
      const task = event.type === 'task' ? (event.data as any)?.task : undefined;
      if (task?.status === 'failed') failed(task.id);
    });
    try {
      const accepted = await dispatch(...args);
      failedTaskId = await failure;
      expect(failedTaskId).toBe(accepted.id);
      expect(h.issued.some(input => input.cardKind === 'result')).toBe(false);
      return accepted;
    } finally { unsubscribe(); }
  });
  const { task, resultInput } = await h.runTurn('om_early_failure');
  expect(failedTaskId).toBeDefined();
  expect(task.status).toBe('completed');
  expect(h.prepared).toHaveLength(2);
  expect(h.prepared[0]).not.toBe(h.prepared[1]);
  expect(h.sent).toHaveLength(1);
  expect(h.issued.filter(input => input.cardKind === 'result')).toEqual([resultInput]);
});

it('托管群已有别人的下一轮在执行时不换会话，并记录拒绝原因', async () => {
  let fail!: () => void;
  const failureGate = new Promise<void>(resolve => { fail = resolve; });
  let finishOther!: () => void;
  const otherGate = new Promise<void>(resolve => { finishOther = resolve; });
  let otherStarted!: () => void;
  const otherRunning = new Promise<void>(resolve => { otherStarted = resolve; });
  let count = 0;
  const h = await setup(async () => {
    if (++count === 2) { await failureGate; throw new Error(LAUNCHER_ERROR); }
    if (count === 3) { otherStarted(); await otherGate; }
  }, true);
  cleanups.push(() => h.teardown());
  cleanups.push(async () => { fail(); otherStarted(); finishOther(); });
  const top = { rootId: undefined, threadId: undefined };
  const old = await h.runTurn('om_guard_owner', { ...top, senderOpenId: 'ou_owner' });
  const stop = vi.spyOn(h.runtime, 'stop');
  // 暂停终态读事件，等下一条真正开始执行，再检查能否换会话。
  const getRecentEvents = h.runtime.getRecentEvents.bind(h.runtime);
  vi.spyOn(h.runtime, 'getRecentEvents').mockImplementationOnce(async (...args) => {
    await otherRunning; return getRecentEvents(...args);
  });
  await h.coordinator.handle({ ...groupMessage('om_guard_failed'), ...top }, h.config);
  await h.coordinator.handle({ ...groupMessage('om_guard_running'), ...top, senderOpenId: 'ou_owner' }, h.config);
  await h.until(async () => (await h.runtime.getTasks(old.sessionId)).some(task => task.status === 'queued'));
  fail();
  await h.until(() => h.issued.some(input => input.cardKind === 'result' && input.taskId === 'om_guard_failed'));
  expect(stop).not.toHaveBeenCalled();
  expect((await h.runtime.getTasks(old.sessionId)).some(task => task.status === 'running')).toBe(true);
  expect(h.log.info).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'om_guard_failed', reason: 'current_turn_interrupt_denied' }), '未自动更换旧启动器会话');
  expect(h.issued.find(input => input.cardKind === 'result' && input.taskId === 'om_guard_failed').state).toBe('failed');
  finishOther();
  await h.until(() => h.issued.some(input => input.cardKind === 'result' && input.taskId === 'om_guard_running'));
});

it('新会话仍因启动器失败：只自动换一次，结果无错误码和重试，回调仍拒绝', async () => {
  const h = await setup(new Error(LAUNCHER_ERROR));
  cleanups.push(() => h.teardown());

  const { task, resultInput } = await h.runTurn('om_launcher');

  const execution = h.repos.execution.getTaskExecution(task.id)!;
  expect(execution.currentAttempt?.state).toBe('settled');
  expect(execution.currentAttempt?.outcome).toBe('failed');
  expect(execution.currentAttempt?.submissionState).toBe('not_submitted');

  // 自动换一次后仍失败，结果卡只保留人话和 /new 指引。
  expect(h.prepared).toHaveLength(2);
  expect(new Set(h.prepared).size).toBe(2);
  expect(h.sent).toHaveLength(0);
  expect(h.issued.filter(input => input.cardKind === 'result')).toHaveLength(1);
  expect(h.log.info).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'om_launcher', reason: 'already_attempted' }), '未自动更换旧启动器会话');
  expect(resultInput.state).toBe('failed');
  expect(resultInput.capabilities.canRetry).toBe(false);
  expect(hasRetryButton(resultInput)).toBe(false);
  const card = JSON.stringify(buildLarkCard(resultInput));
  expect(card).toContain('这个对话的运行环境更新了，旧对话接不上');
  expect(card).toContain('发送 /new 开一个新对话后再发一次请求');
  expect(card).not.toContain('ACP_LAUNCHER_VERSION_CHANGED');

  // 回调端同样拒绝，不在旧会话上再跑。
  const response = await h.coordinator.handleAction(
    { action: 'retry', task_id: 'om_launcher', turn: String(resultInput.turn) },
    'ou_alice', { messageId: 'om_card', chatId: 'oc_group' }
  );
  expect(response).toMatchObject({ type: 'warning', content: '这个任务不能在当前对话重试，请按卡片上的说明处理' });
});

it('普通的提交前失败仍可重试（防回归）', async () => {
  const h = await setup(new Error('prepare phase blew up'));
  cleanups.push(() => h.teardown());

  const { task, resultInput } = await h.runTurn('om_other');

  const execution = h.repos.execution.getTaskExecution(task.id)!;
  expect(execution.currentAttempt?.submissionState).toBe('not_submitted');
  expect(resultInput.state).toBe('failed');
  expect(resultInput.capabilities.canRetry).toBe(true);
  expect(hasRetryButton(resultInput)).toBe(true);
});

it('自动换新后普通失败再手动重试，不再显示或持久化换新提示', async () => {
  let count = 0;
  const h = await setup(async () => {
    if (++count === 1) throw new Error(LAUNCHER_ERROR);
    if (count === 2) throw new Error('prepare phase blew up');
  });
  cleanups.push(() => h.teardown());
  const { resultInput } = await h.runTurn('om_manual_retry');
  expect(resultInput.turn).toBe(2);
  expect(hasRetryButton(resultInput)).toBe(true);
  const saved = async () => JSON.parse((await h.repos.channelMappings.get('lark-card:app', 'om_manual_retry'))!.extra!);
  await h.until(async () => Boolean((await saved()).final_message_id));
  expect((await saved()).launcher_recovery_note).toBe(true);
  expect(h.service.update.mock.calls.some(([input]) => input.turn === 2
    && JSON.stringify(buildLarkCard(input)).includes(LARK_LAUNCHER_RECOVERY_NOTE))).toBe(true);

  const response = await h.coordinator.handleAction(
    { action: 'retry', task_id: 'om_manual_retry', turn: String(resultInput.turn) },
    'ou_alice', { messageId: (await saved()).final_message_id, chatId: 'oc_group' }
  );
  expect(response).toMatchObject({ type: 'success', content: '已开始重试' });
  await h.until(async () => { const record = await saved(); return record.turn === 3 && record.final_delivery_state === 'delivered'; });
  const frames = [...h.issued, ...h.service.update.mock.calls.map(([input]) => input)]
    .filter(input => input.cardKind === 'process' && input.turn === 3);
  expect(frames.length).toBeGreaterThan(1);
  for (const frame of frames) expect(JSON.stringify(buildLarkCard(frame))).not.toContain(LARK_LAUNCHER_RECOVERY_NOTE);
  expect(await saved()).not.toHaveProperty('launcher_recovery_note');
  expect(h.issued.find(input => input.cardKind === 'result' && input.turn === 3)?.state).toBe('completed');
  expect(h.prepared).toHaveLength(3);
  expect(h.prepared[2]).toBe(h.prepared[1]);
});


it.each(['topic', 'top'] as const)('%s 启动器失败后复用过程卡换新会话，原请求只提交一次，过程到结束一直带提示', async scope => {
  let count = 0;
  const h = await setup(async () => { if (++count === 1) throw new Error(LAUNCHER_ERROR); });
  cleanups.push(() => h.teardown());
  const { task, resultInput } = await h.runTurn('om_success', scope === 'top' ? { rootId: undefined, threadId: undefined } : {});
  expect(task.status).toBe('completed');
  expect(h.prepared).toHaveLength(2);
  expect(h.prepared[0]).not.toBe(h.prepared[1]);
  expect((await h.runtime.getSession(h.prepared[0]!))?.state).toBe('stopped');
  const oldTasks = await h.runtime.getTasks(h.prepared[0]!);
  expect(oldTasks).toHaveLength(1);
  expect(h.repos.execution.getTaskExecution(oldTasks[0]!.id)?.currentAttempt?.submissionState).toBe('not_submitted');
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]!.sessionId).toBe(resultInput.sessionId);
  expect(task.prompt).toContain('跑一下任务');
  expect(h.sent[0]!.prompt).toContain('跑一下任务');
  expect(h.issued.filter(input => input.cardKind === 'result').map(input => input.state)).toEqual(['completed']);
  const processes = h.issued.filter(input => input.cardKind === 'process');
  expect(processes).toHaveLength(1);
  const updates = h.service.update.mock.calls.map(([input]) => input).filter(input => input.cardKind === 'process');
  expect(updates.some(input => input.state === 'failed')).toBe(false);
  const replacement = updates.filter(input => input.turn === 2);
  expect(replacement.length).toBeGreaterThan(1);
  for (const frame of replacement) {
    expect(frame.messageId).toBe('om_reply_1');
    expect(JSON.stringify(buildLarkCard(frame))).toContain(LARK_LAUNCHER_RECOVERY_NOTE);
  }
  expect(replacement.at(-1).state).toBe('completed');
  const final = buildLarkCard(replacement.at(-1)) as any;
  expect(final.body.elements.some((el: any) => el.content === LARK_LAUNCHER_RECOVERY_NOTE)).toBe(true);
});

it('旧会话进程未确认停止时保留原记录，自动换新且原请求只提交一次', async () => {
  let count = 0;
  const stopBlock = (sessionId: string) => JSON.stringify({ sessionId, runId: 'old-run', reason: 'old process stop unconfirmed' });
  const h = await setup(async sessionId => {
    if (++count !== 2) return;
    // 当前轮已进入准备阶段再补入旧进程的持久化阻塞，确保本轮仍触发启动器错误。
    await h.repos.config.set(`runtime_driver_stop_block:${sessionId}`, stopBlock(sessionId));
    throw new Error(LAUNCHER_ERROR);
  });
  cleanups.push(() => h.teardown());
  const old = await h.runTurn('om_retained_history');
  const oldRecord = await h.repos.tasks.get!(old.task.id);
  const oldAttempts = h.repos.execution.getTaskExecution(old.task.id)!.attempts;
  const stop = vi.spyOn(h.runtime, 'stop');
  const { task, resultInput } = await h.runTurn('om_retained_launcher');
  expect(task.status).toBe('completed');
  expect(resultInput.sessionId).not.toBe(old.sessionId);
  expect(stop).not.toHaveBeenCalled();
  expect((await h.runtime.getSession(old.sessionId))?.state).not.toBe('stopped');
  expect(await h.repos.tasks.get!(old.task.id)).toEqual(oldRecord);
  expect(h.repos.execution.getTaskExecution(old.task.id)!.attempts).toEqual(oldAttempts);
  expect(await h.repos.config.get(`runtime_driver_stop_block:${old.sessionId}`)).toBe(stopBlock(old.sessionId));
  expect((await h.runtime.getTaskRecovery(old.sessionId, old.task.id)).blockers).toContainEqual({ code: 'DRIVER_STOP_BLOCKED' });
  expect(JSON.parse((await h.repos.config.get(`lark.relaunch_retained.app.${old.sessionId}`))!)).toEqual({ message_id: 'om_retained_launcher' });
  expect(h.log.info).toHaveBeenCalledWith(expect.objectContaining({ reason: 'session_retained', taskId: 'om_retained_launcher', sessionId: old.sessionId }), '旧启动器会话已保留未停止，继续自动换新');
  expect(h.prepared).toEqual([old.sessionId, old.sessionId, resultInput.sessionId]);
  expect(await h.runtime.getTasks(resultInput.sessionId)).toHaveLength(1);
  expect(h.sent.filter(item => item.sessionId === resultInput.sessionId)).toEqual([{ sessionId: resultInput.sessionId, prompt: expect.stringContaining('跑一下任务') }]);
  expect(h.issued.filter(input => input.cardKind === 'result' && input.taskId === 'om_retained_launcher').map(input => input.state)).toEqual(['completed']);
  const process = h.issued.filter(input => input.cardKind === 'process' && input.taskId === 'om_retained_launcher');
  expect(process).toHaveLength(1);
  const updates = h.service.update.mock.calls.map(([input]) => input).filter(input => input.cardKind === 'process' && input.taskId === 'om_retained_launcher');
  expect(updates.some(input => input.state === 'failed')).toBe(false);
  const replacement = updates.filter(input => input.turn === 2);
  expect(replacement.length).toBeGreaterThan(1);
  for (const frame of replacement) {
    expect(frame.messageId).toBe(updates[0].messageId);
    expect(JSON.stringify(buildLarkCard(frame))).toContain(LARK_LAUNCHER_RECOVERY_NOTE);
  }
  expect(replacement.at(-1).state).toBe('completed');
});

it('结束旧会话失败时不重发，仍交付无重试的 /new 指引', async () => {
  const h = await setup(new Error(LAUNCHER_ERROR));
  cleanups.push(() => h.teardown());
  vi.spyOn(h.runtime, 'stop').mockRejectedValueOnce(new Error('stop unavailable'));
  const { resultInput } = await h.runTurn('om_cannot_replace');
  expect(h.prepared).toHaveLength(1);
  expect(h.log.info).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'om_cannot_replace', reason: 'recovery_error' }), '未自动更换旧启动器会话');
  expect(hasRetryButton(resultInput)).toBe(false);
  const card = JSON.stringify(buildLarkCard(resultInput));
  expect(card).toContain('发送 /new');
  expect(card).not.toContain('ACP_LAUNCHER_VERSION_CHANGED');
});


it('新轮按原发送人重新检查权限，不能复用上一轮的授权', async () => {
  const h = await setup(new Error(LAUNCHER_ERROR));
  cleanups.push(() => h.teardown());
  h.config.allowedUsers = [];
  h.config.allowedEmails = ['alice@example.com'];
  await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
  h.service.getUserEmails.mockResolvedValueOnce(['alice@example.com']).mockResolvedValue(['revoked@example.com']);
  const { resultInput } = await h.runTurn('om_recheck');
  expect(h.service.getUserEmails).toHaveBeenCalledTimes(2);
  expect(h.service.getUserEmails).toHaveBeenNthCalledWith(2, 'ou_alice');
  expect(h.prepared).toHaveLength(1);
  expect(h.sent).toHaveLength(0);
  expect(hasRetryButton(resultInput)).toBe(false);
  expect(JSON.stringify(buildLarkCard(resultInput))).toContain('发送 /new');
});

it('旧会话里其他发送人的排队请求明确取消，不迁移或静默丢掉', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let oldSession: string | undefined;
  const h = await setup(async sessionId => {
    oldSession ??= sessionId;
    if (sessionId === oldSession) { await gate; throw new Error(LAUNCHER_ERROR); }
  });
  cleanups.push(() => h.teardown());
  h.config.allowedUsers = [];
  await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
  cleanups.push(async () => { release(); });
  await h.coordinator.handle(groupMessage('om_first'), h.config);
  await h.until(() => h.prepared.length === 1);
  await h.coordinator.handle({ ...groupMessage('om_bob'), senderOpenId: 'ou_bob', content: JSON.stringify({ text: '@_user_1 Bob 的任务' }) }, h.config);
  await h.until(async () => (await h.runtime.getTasks(oldSession!)).some(task => task.status === 'queued'));
  // 暂停领取队列，确保验证的是换会话时仍排队的请求，避免下一条先领取并同样报错。
  h.runtime.setQueueHeld(true);
  release();
  await h.until(async () => (await h.runtime.getTasks(oldSession!)).some(task => task.status === 'cancelled'));
  h.runtime.setQueueHeld(false);
  await h.until(() => h.issued.filter(input => input.cardKind === 'result').length === 2);
  const bob = (await h.runtime.getTasks(oldSession!)).find(task => task.prompt.includes('Bob'))!;
  expect(bob.status).toBe('cancelled');
  const receipt = h.issued.find(input => input.cardKind === 'result' && input.taskId === 'om_bob');
  expect(receipt.state).toBe('cancelled');
  expect(JSON.stringify(buildLarkCard(receipt))).toContain('取消');
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]!.prompt).not.toContain('Bob');
});

it.each(['retire', 'start'] as const)('换会话的 %s 阶段重启：只恢复失败卡，不自动重发', async stage => {
  const h = await setup(new Error(LAUNCHER_ERROR));
  cleanups.push(() => h.teardown());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  if (stage === 'retire') {
    const stop = h.runtime.stop.bind(h.runtime);
    vi.spyOn(h.runtime, 'stop').mockImplementationOnce(async (...args) => {
      await stop(...args); entered = true; await gate;
    });
  } else {
    const start = h.runtime.start.bind(h.runtime);
    let starts = 0;
    vi.spyOn(h.runtime, 'start').mockImplementation(async (...args) => {
      const session = await start(...args);
      if (++starts === 2) { entered = true; await gate; }
      return session;
    });
  }
  await h.coordinator.handle(groupMessage(`om_restart_${stage}`), h.config);
  await h.until(() => entered);
  await h.coordinator.reconcile(h.config);
  expect(h.issued.filter(input => input.cardKind === 'result')).toHaveLength(0);
  const tasks = [...(h.coordinator as any).tasks.values()];
  h.coordinator.stop();
  release();
  await h.until(() => tasks.every((task: any) => !task.launcherRecoveryPending));
  expect(h.log.info).toHaveBeenCalledWith(expect.objectContaining({ taskId: `om_restart_${stage}`, reason: 'coordinator_stopped' }), '未自动更换旧启动器会话');
  await h.runtime.shutdown();
  const runtime = new DutydeckRuntime(h.repos, { driverIdleTimeoutMs: 0,
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: h.factory });
  const recovered = new LarkMessageCoordinator(runtime, h.service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    Math.random, 'ou_bot', undefined, h.repos.channelMappings, undefined, undefined, undefined, { store: h.repos.config });
  cleanups.push(async () => { recovered.stop(); await runtime.shutdown(); });
  await runtime.initialize([h.agent]);
  await recovered.initializeWorkflows(h.config);
  await recovered.reconcile(h.config);
  await recovered.reconcile(h.config);
  expect(h.prepared).toHaveLength(1);
  expect(h.sent).toHaveLength(0);
  const results = h.issued.filter(input => input.cardKind === 'result');
  expect(results).toHaveLength(1);
  expect(results[0].state).toBe('failed');
  expect(hasRetryButton(results[0])).toBe(false);
  const card = JSON.stringify(buildLarkCard(results[0]));
  expect(card).toContain('发送 /new');
  expect(card).not.toContain('ACP_LAUNCHER_VERSION_CHANGED');
});


it('同一旧会话的请求接连失败时，不会重复结束绑定或悄悄丢掉请求', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let oldSession: string | undefined;
  const h = await setup(async sessionId => {
    oldSession ??= sessionId;
    if (sessionId === oldSession) { await gate; throw new Error(LAUNCHER_ERROR); }
  });
  cleanups.push(() => h.teardown());
  cleanups.push(async () => { release(); });
  h.config.allowedUsers = [];
  await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
  const stop = vi.spyOn(h.runtime, 'stop');
  await h.coordinator.handle(groupMessage('om_race_a'), h.config);
  await h.until(() => h.prepared.length === 1);
  await h.coordinator.handle({ ...groupMessage('om_race_b'), senderOpenId: 'ou_bob' }, h.config);
  await h.until(async () => (await h.runtime.getTasks(oldSession!)).some(task => task.status === 'queued'));
  release();
  await h.until(() => h.issued.filter(input => input.cardKind === 'result').length === 2);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(new Set(h.prepared).size).toBe(2);
  expect(h.sent).toHaveLength(1);
  expect(h.issued.filter(input => input.cardKind === 'result').map(input => input.taskId).sort()).toEqual(['om_race_a', 'om_race_b']);
});


it('终态回调读取事件时遇到对账，不会抢先交付旧轮失败卡', async () => {
  let count = 0;
  const h = await setup(async () => { if (++count === 1) throw new Error(LAUNCHER_ERROR); });
  cleanups.push(() => h.teardown());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(async () => { release(); });
  let entered = false;
  const getRecentEvents = h.runtime.getRecentEvents.bind(h.runtime);
  vi.spyOn(h.runtime, 'getRecentEvents').mockImplementationOnce(async (...args) => {
    entered = true; await gate; return getRecentEvents(...args);
  });
  await h.coordinator.handle(groupMessage('om_reconcile_race'), h.config);
  await h.until(() => entered);
  await h.coordinator.reconcile(h.config);
  expect(h.issued.filter(input => input.cardKind === 'result')).toHaveLength(0);
  expect(h.service.update.mock.calls.some(([input]) => input.state === 'failed')).toBe(false);
  release();
  await h.until(() => h.issued.some(input => input.cardKind === 'result'));
  expect(h.issued.filter(input => input.cardKind === 'result').map(input => input.state)).toEqual(['completed']);
  expect(h.sent).toHaveLength(1);
});
