// P0 飞书命令 UX 优化的协调器级端到端回归（S2/S3/S4/S6/S8/P0-1/P0-4/P0-6/P0-7）。
//
// 纯模块（reaction-records、queue-summary、protocol-hints、recovery-notes、repair、
// card-mentions）与 workflow-interactions 层各有单测；这里只锁定「coordinator 真实接线」：
// 真实 DutydeckRuntime + SQLite 持久化 + 真实 LarkWorkflowInteractions，service 为内存 mock。
// /repair 的外部发布绝不真实发生：open-platform-session 整体被 mock，client 为测试桩。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { RelayAskBroker } from '@dutydeck/relay';
import type { AgentConfig } from '@dutydeck/shared';
import { createRelayAskStore } from '../relay-ask-store.js';
import { LarkMessageCoordinator, larkTaskTitle } from './coordinator.js';
import { LarkGroupManager } from './group-management.js';
import { LarkGroupParticipation } from './group-participation.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkInteraction } from './workflow-interactions.js';
import { buildLarkCard, larkCardSafeLimits, type LarkChatMessage } from './service.js';
import { buildRepairConfirmCard } from './repair.js';
import { TERMINAL_PROTOCOL_NOTE } from './protocol-hints.js';
import { replayedRecoveryNote } from './recovery-notes.js';
import { reactionDedupeKey } from './reaction-records.js';
import { LARK_COMMON_TENANT_SCOPES, LARK_REQUIRED_EVENTS } from './open-platform-configurator.js';

// /repair 唯一的外部依赖（扫码会话 + 开放平台 client）整体 mock，测试不触网、不真实发布。
vi.mock('./open-platform-session.js', () => ({ connectLarkOpenPlatformSession: vi.fn() }));
import { connectLarkOpenPlatformSession } from './open-platform-session.js';

const connectMock = vi.mocked(connectLarkOpenPlatformSession);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});

type HarnessMode = 'normal' | 'permission' | 'hang';

async function harness(
  mode: HarnessMode = 'normal',
  options: { protocol?: 'acp' | 'pty-cli'; configPatch?: Partial<StoredLarkConfig>; answerChunks?: string[]; managedGroup?: boolean; executionPolicy?: ConstructorParameters<typeof LarkMessageCoordinator>[8]; participation?: LarkGroupParticipation | ((repos: ReturnType<typeof createRepositories>) => LarkGroupParticipation);
    authorizeTask?: NonNullable<ConstructorParameters<typeof DutydeckRuntime>[1]>['authorizeTask']; sendOnly?: boolean } = {}
) {
  const protocol = options.protocol ?? 'acp';
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-uxp0-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let broker!: RelayAskBroker;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(done => { release = done; });
  const send = vi.fn(); const resolvePermission = vi.fn(); const interrupt = vi.fn();
  const runtime = new DutydeckRuntime(repos, {
    ...(options.authorizeTask ? { authorizeTask: options.authorizeTask } : {}),
    probe: () => ({ protocol, available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit, _exit, _sessionId) => {
      // 每次 send 都是独立的一轮：permission 模式重新发审批并等待本轮 release；
      // interrupt/stop 在当前轮上发所属 completed(cancelled) 并让 send 收口，
      // 不短路后续新任务（与真实 transport 收到取消后事件驱动结算一致）。
      let currentRelease: (() => void) | undefined;
      let currentCancelled = false;
      const cancelCurrent = () => {
        // 中断后真实 CLI 会把待决审批回成非 pending（这里 resolved/rejected），
        // Runtime 据此清掉 pending permission；否则下一轮因旧审批未决无法申领 driver。
        emit({ type: 'permission_request', data: { id: 'native_permission', title: '修改文件', status: 'rejected', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } });
        currentCancelled = true;
        emit({ type: 'completed', data: { stopReason: 'cancelled' } });
        currentRelease?.();
        currentRelease = undefined;
      };
      const driver: AgentDriver = {
        start: async () => {},
        resume: async () => {},
        stop: async () => cancelCurrent(),
        interrupt: async () => cancelCurrent(),
        send: async prompt => {
          send(prompt);
          currentCancelled = false;
          if (mode === 'permission') {
            emit({ type: 'permission_request', data: { id: 'native_permission', title: '修改文件', status: 'pending', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } });
            await new Promise<void>(done => { currentRelease = done; });
            if (currentCancelled) return;
            currentRelease = undefined;
            emit({ type: 'text', data: { text: '审批处理完成' } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          } else if (mode === 'hang') {
            emit({ type: 'text', data: { text: '执行中' } });
            await gate;
            emit({ type: 'text', data: { text: '工作已完成' } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          } else if (options.answerChunks) {
            for (const text of options.answerChunks) emit({ type: 'text', data: { text } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          } else {
            emit({ type: 'text', data: { text: '工作已完成' } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          }
        },
        resolvePermission: async (id, approved) => {
          resolvePermission(id, approved);
          // 批准同样回一条非 pending 审批事件，清除待决记录后再放 send 续跑。
          emit({ type: 'permission_request', data: { id, title: '修改文件', status: approved ? 'approved' : 'rejected', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } });
          currentRelease?.();
          currentRelease = undefined;
          return true;
        }
      };
      return driver;
    }
  });
  broker = new RelayAskBroker({ publish: async (sessionId: string, input: any) => { await runtime.publishSessionEvent(sessionId, 'text', { text: input.text, relay: input.kind, askId: input.askId }); } }, createRelayAskStore(repos.config));
  await broker.initialize();
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol, cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  // 包装（而非替换）真实 runtime.interrupt：既保留 actor 落库、状态流转的真实路径，
  // 又能断言 coordinator 透传了 (sessionId, runtimeTaskId, actor) 三参。
  const realInterrupt = runtime.interrupt.bind(runtime);
  runtime.interrupt = (async (sessionId: string, runtimeTaskId?: string, actor?: string) => {
    interrupt(sessionId, runtimeTaskId, actor);
    return realInterrupt(sessionId, runtimeTaskId, actor);
  }) as typeof runtime.interrupt;
  const config: StoredLarkConfig = { appId: 'cli_uxp0', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off',
    ...options.configPatch };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  let nextCard = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextCard}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    uploadFile: vi.fn(async () => `file_${Math.random()}`), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `reaction_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async (_openIds?: string[]) => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_bob' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', threadId: 'omt_topic', messageType: 'text', rawContent: JSON.stringify({ text: '已核实的引用材料' }), sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => [] as any[]),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array([65, 66, 67]), contentType: 'text/plain' })),
    readDocument: vi.fn(async (url: string) => ({ url, title: '需求', text: '文档中的明确验收条件' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let groupManager: LarkGroupManager | undefined;
  if (options.managedGroup) {
    // 默认 access 模式即 all_chat_members：两名人类成员都能发言，但动态角色不带任何 actionGates。
    groupManager = new LarkGroupManager(repos, { client: () => ({
      getBotInfo: async () => ({ appName: config.appId, openId: 'ou_bot' }),
      checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'synthetic-tenant' }),
      listChats: async () => ({ items: [{ chatId: 'oc_group', name: 'UXP0 群', chatMode: 'topic' }], hasMore: false }),
      listChatMembers: async () => ({ items: [
        { memberId: 'ou_alice', openId: 'ou_alice', name: 'Alice', memberType: 'user' },
        { memberId: 'ou_bob', openId: 'ou_bob', name: 'Bob', memberType: 'user' }
      ], hasMore: false, securityLimited: false }),
      getUserEmails: async () => []
    }) as any });
    await groupManager.sync(config.appId);
    await groupManager.save(config.appId, 'oc_group', { expectedRevision: 0, patch: {} });
  }
  const participation = typeof options.participation === 'function' ? options.participation(repos) : options.participation;
  // sendOnly：让 coordinator 看不到 dispatch，走同步 send 分支。
  const coordinatorRuntime = options.sendOnly ? new Proxy(runtime, { get: (target, key) => {
    if (key === 'dispatch') return undefined;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) : runtime;
  const createCoordinator = () => new LarkMessageCoordinator(coordinatorRuntime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', options.executionPolicy, groupManager, { store: repos.config, broker, participation });
  const coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config);
  const stopAll = async () => { coordinator.stop(); release?.(); broker.close(); await broker.flush(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); };
  cleanups.push(stopAll);
  const interactions = async () => (await repos.config.list!(`lark.interaction.${config.appId}.`)).map(row => JSON.parse(row.value) as LarkInteraction);
  const storedConfig = async () => JSON.parse((await repos.config.get(larkBotsConfigKey)) ?? '[]') as StoredLarkConfig[];
  const saveConfig = async (patch: Partial<StoredLarkConfig>) => {
    await repos.config.set(larkBotsConfigKey, JSON.stringify([{ ...config, ...patch }]));
  };
  const channel = `lark-card:${config.appId}`;
  const waitDelivered = async (count: number) => vi.waitFor(async () => expect((await repos.channelMappings.list(channel))
    .filter(mapping => JSON.parse(mapping.extra ?? '{}').final_delivery_state === 'delivered')).toHaveLength(count));
  const releaseGate = () => release?.();
  return { repos, runtime, broker, config, coordinator, createCoordinator, service, cards, log, send, resolvePermission, interrupt, groupManager,
    interactions, storedConfig, saveConfig, channel, waitDelivered, releaseGate };
}

type H = Awaited<ReturnType<typeof harness>>;

/** 深度收集卡片内所有 callback 按钮的 value。 */
function callbackValues(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) for (const item of node) callbackValues(item, out);
  else if (node && typeof node === 'object') {
    const record = node as Record<string, any>;
    for (const behavior of record.behaviors ?? []) if (behavior?.type === 'callback' && behavior.value) out.push(behavior.value);
    for (const value of Object.values(record)) if (value && typeof value === 'object') callbackValues(value, out);
  }
  return out;
}

const cardUpdates = (h: H, predicate: (input: any) => boolean) =>
  h.service.update.mock.calls.map(([input]) => input).filter(predicate);

// 移植自 create-cli.test.ts 的开放平台桩：覆盖 configurator 成功发布所需全部端点。
function repairClient() {
  let scopes = false; let events = false; let callbacks = false; let callbackMode = 0; let published = false;
  const postJson = vi.fn(async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
    if (path.includes('/secret/')) return { data: { secret: 'SECRET' } };
    if (path.includes('/scope/all/')) return { data: { appScopeList: LARK_COMMON_TENANT_SCOPES.map((scopeName, i) => ({ scopeId: `s-${i}`, scopeName, status: published ? 5 : scopes ? 1 : 0 })) } };
    if (path.includes('/scope/update/')) { scopes = true; return { code: 0 }; }
    if (path.includes('/robot/switch/') || path.includes('/event/switch/')) return { code: 0 };
    if (path.includes('/event/update/')) { events = true; return { code: 0 }; }
    if (path === '/developers/v1/event/cli_uxp0') return { data: { eventMode: 4, appEvents: events ? [...LARK_REQUIRED_EVENTS] : [] } };
    if (path.includes('/callback/switch/')) { callbackMode = 4; return { code: 0 }; }
    if (path.includes('/callback/update/')) { callbacks = true; return { code: 0 }; }
    if (path === '/developers/v1/callback/cli_uxp0') return { data: { callbackMode, callbacks: callbacks ? ['card.action.trigger'] : [] } };
    // repair 走 configureLarkOpenPlatformApp 且不带 creatorUserId：首次发版前需回读可见范围。
    if (path.includes('/visible/online/')) return { data: {
      whiteList: { departments: [], members: [], groups: [], isAll: 0 },
      blackList: { departments: [], members: [], groups: [], isAll: 0 }
    } };
    if (path.includes('/app_version/list/')) return { data: { versions: published ? [{ versionId: 'v-1', appVersion: '0.0.1', versionStatus: 2 }] : [] } };
    if (path.includes('/app_version/create/')) { expect(body).toBeTruthy(); return { data: { versionId: 'v-1' } }; }
    if (path.includes('/publish/commit/')) { published = true; return { code: 0 }; }
    throw new Error(`Unexpected endpoint: ${path}`);
  });
  const postForm = vi.fn(async () => ({ data: { url: 'https://example.invalid/icon.png' } }));
  return { client: { apiOrigin: 'https://open.feishu.cn', postJson, postForm } };
}

const confirmValue = (appId = 'cli_uxp0') => buildRepairConfirmCard(appId).elements
  .flatMap((element: any) => element.behaviors ?? []).find((behavior: any) => behavior.type === 'callback')!.value as Record<string, unknown>;

describe('P0-1 他人操作二次确认 / overflow 门 / 行内审批反伪造', () => {
  it.each(['unrestricted', 'allowlisted', 'managed_member', 'managed_operator', 'managed_missing_requester', 'missing_identity'] as const)(
    '中断权限拒绝 %s，重复点击也不确认或改变任务', async kind => {
      const h = await harness('permission', { managedGroup: kind.startsWith('managed'),
        ...(kind === 'allowlisted' ? { configPatch: { allowedUsers: [{ openId: 'ou_alice' }, { openId: 'ou_bob' }] } } : {}) });
      if (kind === 'managed_operator') {
        const bot = (await h.groupManager!.groups()).groups[0]!.bots[0]!;
        const bob = (await h.groupManager!.members(h.config.appId, 'oc_group')).members.find(member => member.openId === 'ou_bob')!;
        await h.groupManager!.save(h.config.appId, 'oc_group', { expectedRevision: bot.binding!.revision, patch: {}, roleChanges: [
          { kind: 'create', principalId: bob.principalId, role: 'can_operate', operateScope: 'group_runs',
            actionGates: { terminalWrite: false, highRisk: true, groupToolsSend: false } }
        ] });
      }
      await h.coordinator.handle(event('om_task', '等待批准'), h.config);
      await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'permission' && item.state === 'pending')).toBe(true));
      const task = (h.coordinator as any).tasks.get('om_task');
      if (kind === 'managed_missing_requester') task.event = { ...task.event, senderOpenId: undefined };
      const update = vi.spyOn(task, 'requestUpdate');
      const value = { action: 'interrupt', task_id: 'om_task', turn: '1' };
      for (let click = 0; click < 2; click++) {
        expect(await h.coordinator.handleAction(value, kind === 'missing_identity' ? undefined : 'ou_bob'))
          .toEqual({ type: 'warning', content: '没有权限中断此任务，仅任务发起人和管理员可操作。' });
      }
      expect(h.interrupt).not.toHaveBeenCalled();
      expect(task.state).toBe('running');
      expect(task.interruptRequested).toBeFalsy();
      expect(update).not.toHaveBeenCalled();
      expect((h.coordinator as any).foreignActionConfirmations.size).toBe(0);
    });

  it('管理员中断他人任务先确认，60 秒内二点放行并落传 actor；本人首点即执行', async () => {
    const h = await harness('permission', { managedGroup: true });
    const bot = (await h.groupManager!.groups()).groups[0]!.bots[0]!;
    const bob = (await h.groupManager!.members(h.config.appId, 'oc_group')).members.find(member => member.openId === 'ou_bob')!;
    await h.repos.roleAssignments.create({ id: 'bob_admin', channelBotId: bot.binding!.channelBotId,
      groupBindingId: bot.binding!.id, principalId: bob.principalId, role: 'admin', operateScope: 'none',
      actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: false } });
    await h.coordinator.handle(event('om_task', '等待批准'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'permission' && item.state === 'pending')).toBe(true));
    const [session] = await h.runtime.listSessions();
    const [runtimeTask] = await h.runtime.getTasks(session!.id);
    const value = { action: 'interrupt', task_id: 'om_task', turn: '1' };

    expect(await h.coordinator.handleAction(value, 'ou_bob', { messageId: 'om_card_1', chatId: 'oc_group' }))
      .toMatchObject({ type: 'warning', content: '该任务由他人发起，再次点击同一按钮以确认操作' });
    expect(h.interrupt).not.toHaveBeenCalled();
    // 超过 60 秒的确认必须作废：下一次点击仍是警告，而不是直接放行。
    vi.setSystemTime(Date.now() + 61_000);
    expect(await h.coordinator.handleAction(value, 'ou_bob', { messageId: 'om_card_1', chatId: 'oc_group' }))
      .toMatchObject({ type: 'warning' });
    expect(h.interrupt).not.toHaveBeenCalled();
    vi.useRealTimers();
    expect(await h.coordinator.handleAction(value, 'ou_bob', { messageId: 'om_card_1', chatId: 'oc_group' }))
      .toMatchObject({ type: 'success' });
    await vi.waitFor(() => expect(h.interrupt).toHaveBeenCalledOnce());
    expect(h.interrupt).toHaveBeenCalledWith(session!.id, runtimeTask!.id, 'ou_bob');

    // 发起人本人点击不拦：另起一个等待中的任务，首点即执行，actor 是本人。
    // 必须等到 om_self 自己的 pending 审批出现：被中断任务的审批记录仍留在 kv，
    // 只数 pending 总数会在新任务尚在排队（无 runtimeTaskId）时提前放行。
    await h.coordinator.handle(event('om_self', '自己的任务'), h.config);
    await vi.waitFor(async () => expect((await h.interactions())
      .filter(item => item.kind === 'permission' && item.state === 'pending' && item.event.messageId === 'om_self')).toHaveLength(1));
    const selfValue = { action: 'interrupt', task_id: 'om_self', turn: '1' };
    expect(await h.coordinator.handleAction(selfValue, 'ou_alice', { messageId: 'om_card_x', chatId: 'oc_group' }))
      .toMatchObject({ type: 'success' });
    await vi.waitFor(() => expect(h.interrupt).toHaveBeenCalledTimes(2));
    const selfSessionId = h.interrupt.mock.calls[1]![0];
    expect(h.interrupt.mock.calls[1]![2]).toBe('ou_alice');
    expect(selfSessionId).toBeTruthy();
  });

  it('overflow 只放行 reject+option=reject，其余点选与伪造卡一律拒绝且不触达执行端', async () => {
    const h = await harness('permission');
    await h.coordinator.handle(event('om_task', '等待批准'), h.config);
    const request = await vi.waitFor(async () => {
      const found = (await h.interactions()).find(item => item.kind === 'permission' && item.state === 'pending');
      if (!found) throw new Error('pending permission not ready');
      return found;
    });
    const reject = { dutydeck_workflow: 'reject', request_id: request.id, generation: request.boot };
    const approve = { dutydeck_workflow: 'approve', request_id: request.id, generation: request.boot };

    expect(await h.coordinator.handleAction(approve, 'ou_alice', { messageId: 'om_card_x', chatId: 'oc_group', actionTag: 'overflow', option: 'reject' }))
      .toMatchObject({ type: 'error', content: '该菜单不支持此操作。' });
    expect(await h.coordinator.handleAction(reject, 'ou_alice', { messageId: 'om_card_x', chatId: 'oc_group', actionTag: 'overflow', option: 'approve' }))
      .toMatchObject({ type: 'error' });
    // 不带 overflow 标记、又不是原审批卡：必须命中 kv 反伪造门。
    expect(await h.coordinator.handleAction(reject, 'ou_alice', { messageId: 'om_forged', chatId: 'oc_group' }))
      .toMatchObject({ type: 'error', content: '请在最新的审批卡片或 /tasks 卡片上操作。' });
    expect(h.resolvePermission).not.toHaveBeenCalled();
  });

  it('/tasks 行内审批走 kv 登记门 + 世代校验 + 一次性 CAS；overflow 拒绝同路径', async () => {
    const h = await harness('permission');
    await h.coordinator.handle(event('om_task', '第一个待批任务'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'permission' && item.state === 'pending')).toBe(true));

    await h.coordinator.handle(event('om_tasks', '/tasks'), h.config);
    const [dashboardId, dashboard] = [...h.cards].find(([, card]) => card.taskId === 'om_tasks')!;
    const inlineApprove = callbackValues(dashboard).find(value => value.dutydeck_workflow === 'approve')!;
    expect(inlineApprove).toBeTruthy();

    // 未登记的 messageId 上点行内审批 = 伪造回调。
    expect(await h.coordinator.handleAction(inlineApprove, 'ou_alice', { messageId: 'om_forged', chatId: 'oc_group' }))
      .toMatchObject({ type: 'error' });
    expect(h.resolvePermission).not.toHaveBeenCalled();
    // 世代失配只警告刷新，不执行。
    expect(await h.coordinator.handleAction({ ...inlineApprove, generation: 'stale_boot' }, 'ou_alice', { messageId: dashboardId, chatId: 'oc_group' }))
      .toMatchObject({ type: 'warning', content: '审批已失效，请刷新 /tasks 后重试。' });
    expect(h.resolvePermission).not.toHaveBeenCalled();
    // 正确路径：决议只执行一次。
    expect(await h.coordinator.handleAction(inlineApprove, 'ou_alice', { messageId: dashboardId, chatId: 'oc_group' }))
      .toMatchObject({ type: 'success' });
    expect(h.resolvePermission).toHaveBeenCalledExactlyOnceWith('native_permission', true);
    expect(await h.coordinator.handleAction(inlineApprove, 'ou_alice', { messageId: dashboardId, chatId: 'oc_group' }))
      .toMatchObject({ type: 'error' });
    expect(h.resolvePermission).toHaveBeenCalledOnce();
    await h.waitDelivered(1);

    // 第二个任务：行内 overflow 拒绝走同一批门，执行端收到 false。
    await h.coordinator.handle(event('om_task2', '第二个待批任务'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'permission' && item.state === 'pending' && item.event.messageId === 'om_task2')).toBe(true));
    await h.coordinator.handle(event('om_tasks2', '/tasks'), h.config);
    const dashboard2 = h.cards.get([...h.cards].find(([id]) => id !== dashboardId && false)?.[0] ?? '');
    const [dashboard2Id, dashboard2Card] = [...h.cards].filter(([, card]) => card.taskId === 'om_tasks2').at(-1)!;
    expect(dashboard2Card).toBeTruthy();
    const inlineReject = callbackValues(dashboard2Card).find(value => value.dutydeck_workflow === 'reject')!;
    expect(inlineReject).toBeTruthy();
    expect(await h.coordinator.handleAction(inlineReject, 'ou_alice', { messageId: dashboard2Id, chatId: 'oc_group', actionTag: 'overflow', option: 'reject' }))
      .toMatchObject({ type: 'success' });
    expect(h.resolvePermission).toHaveBeenLastCalledWith('native_permission', false);
    expect(dashboard2).toBeUndefined();
  });
});

describe('S2 /help 只读翻页鉴权', () => {
  it('翻页成功 PATCH；停用/非白名单/非法页码分别拒绝', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_help', '/help'), h.config);
    const helpCard = [...h.cards.values()].find(card => card.taskId === 'om_help')!;
    const nextPage = callbackValues(helpCard).find(value => 'dutydeck_help_page' in value)!;
    expect(nextPage).toBeTruthy();
    const context = { messageId: 'om_help', chatId: 'oc_group' };
    const before = h.service.update.mock.calls.length;

    expect(await h.coordinator.handleAction(nextPage, 'ou_alice', context)).toMatchObject({ type: 'success' });
    expect(h.service.update).toHaveBeenCalledTimes(before + 1);
    // 只断言翻到了第 2 页；总页数随注册表里可用命令数变化（当前 13 条、每页 6 条）。
    expect(String(h.service.update.mock.calls.at(-1)![0].markdown)).toMatch(/第 2\/\d+ 页/);

    await h.saveConfig({ listening: false });
    expect(await h.coordinator.handleAction(nextPage, 'ou_alice', context)).toMatchObject({ type: 'warning' });
    await h.saveConfig({ listening: true, allowedUsers: [{ openId: 'ou_carol', name: 'Carol' }] });
    expect(await h.coordinator.handleAction(nextPage, 'ou_alice', context)).toMatchObject({ type: 'warning', content: '当前账号无权使用命令帮助。' });
    await h.saveConfig({ allowedUsers: [] });
    expect(await h.coordinator.handleAction({ dutydeck_help_page: '1', page: 'x' }, 'ou_alice', context)).toMatchObject({ type: 'error' });
  });
});

describe('S4 文件型结果验收 reaction：先查 kv 后写、重启不重复、内联结果/同卡不加', () => {
  async function fileHarness() {
    const h = await harness('normal', { answerChunks: [`开头\n${'完整结果🙂'.repeat(5000)}\n末尾`] });
    await h.coordinator.handle(event('om_file', '生成长结果'), h.config);
    await h.waitDelivered(1);
    expect(h.service.replyFile).toHaveBeenCalledOnce();
    const [mapping] = await h.repos.channelMappings.list(h.channel);
    const saved = JSON.parse(mapping!.extra!);
    expect(saved.final_elements).toEqual(expect.arrayContaining([expect.objectContaining({ element_id: 'result_attachment' })]));
    expect(saved.final_attachment_message_id).toBeTruthy();
    const id = createHash('sha256').update([h.config.appId, mapping!.sessionId, saved.runtime_task_id, saved.turn, 'result', saved.runtime_task_id, ''].join('\0')).digest('hex').slice(0, 24);
    const record: LarkInteraction = {
      appId: h.config.appId, sessionId: mapping!.sessionId, taskId: saved.runtime_task_id, turn: saved.turn,
      event: event(mapping!.externalId, saved.prompt, { chatId: saved.chat_id, chatType: saved.chat_type, threadId: saved.thread_id, senderOpenId: saved.sender_open_id, mentions: [] }),
      id, boot: 'legacy_boot', kind: 'result', nativeId: saved.runtime_task_id, question: '结果验收', state: 'pending',
      cardId: saved.final_message_id, relatedCardIds: [saved.final_attachment_message_id], updatedAt: new Date().toISOString()
    };
    await h.repos.config.set(`lark.interaction.${h.config.appId}.${id}`, JSON.stringify(record));
    return { h, record, fileMessageId: saved.final_attachment_message_id as string };
  }

  it('引用文件消息「验收通过」补一次 CheckMark 并落 kv，二次对账不重复', async () => {
    const { h, fileMessageId } = await fileHarness();
    await h.coordinator.handle(event('om_accept', '验收通过', { parentId: fileMessageId, mentions: [] }), h.config);
    await vi.waitFor(() => expect(h.service.addReaction.mock.calls
      .filter(([messageId, emojiType]) => messageId === fileMessageId && emojiType === 'CheckMark')).toHaveLength(1));
    expect(h.service.addReaction).toHaveBeenCalledWith(fileMessageId, 'CheckMark');
    expect(await h.repos.config.get(reactionDedupeKey(h.config.appId, fileMessageId, 'CheckMark'))).toBeTruthy();
    // 重启后对账循环会反复刷新验收状态：kv 命中，绝不重复打表情。
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      expect(await restored.reconcile(h.config)).toBe(0);
      expect(await restored.reconcile(h.config)).toBe(0);
      expect(h.service.addReaction.mock.calls.filter(([id]) => id === fileMessageId)).toHaveLength(1);
    } finally { restored.stop(); }
  });

  it('「需要修改」补 Typing；内联结果与 final_message_id 同卡两种形态均不加 reaction', async () => {
    const changes = await fileHarness();
    expect(await changes.h.coordinator.handleAction(
      { dutydeck_workflow: 'changes', request_id: changes.record.id, generation: changes.record.boot },
      'ou_alice', { messageId: changes.record.cardId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    await vi.waitFor(() => expect(changes.h.service.addReaction.mock.calls
      .filter(([messageId, emojiType]) => messageId === changes.fileMessageId && emojiType === 'Typing')).toHaveLength(1));

    // 内联（卡片内元素）结果：验收只 PATCH 卡片，不打 reaction。
    const inline = await harness();
    await inline.coordinator.handle(event('om_inline', '生成短结果'), inline.config);
    await inline.waitDelivered(1);
    const [inlineMapping] = await inline.repos.channelMappings.list(inline.channel);
    const inlineSaved = JSON.parse(inlineMapping!.extra!);
    expect(inlineSaved.final_elements).toBeTruthy();
    const inlineId = createHash('sha256').update([inline.config.appId, inlineMapping!.sessionId, inlineSaved.runtime_task_id, inlineSaved.turn, 'result', inlineSaved.runtime_task_id, ''].join('\0')).digest('hex').slice(0, 24);
    await inline.repos.config.set(`lark.interaction.${inline.config.appId}.${inlineId}`, JSON.stringify({
      appId: inline.config.appId, sessionId: inlineMapping!.sessionId, taskId: inlineSaved.runtime_task_id, turn: inlineSaved.turn,
      event: event(inlineMapping!.externalId, inlineSaved.prompt, { chatId: inlineSaved.chat_id, chatType: inlineSaved.chat_type, threadId: inlineSaved.thread_id, senderOpenId: inlineSaved.sender_open_id, mentions: [] }),
      id: inlineId, boot: 'legacy_boot', kind: 'result', nativeId: inlineSaved.runtime_task_id, question: '结果验收', state: 'pending',
      cardId: inlineSaved.final_message_id, updatedAt: new Date().toISOString()
    } satisfies LarkInteraction));
    expect(await inline.coordinator.handleAction(
      { dutydeck_workflow: 'accept', request_id: inlineId, generation: 'legacy_boot' },
      'ou_alice', { messageId: inlineSaved.final_message_id, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    expect(inline.service.addReaction.mock.calls.filter(([id]) => id === inlineSaved.final_message_id)).toHaveLength(0);
    // 结果反馈 PATCH 的是独立结果卡，必须标 result；过程卡冻结帧仍是 process。
    await vi.waitFor(() => expect(inline.service.update).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: inlineSaved.final_message_id, cardKind: 'result' })));
    expect(inline.service.update.mock.calls
      .filter(([input]) => input.messageId === inlineSaved.card_message_id)
      .every(([input]) => input.cardKind === 'process')).toBe(true);

    // final_message_id === card_message_id（终态 PATCH 在过程卡自身的旧形态）：不加 reaction。
    const same = await harness();
    await same.coordinator.handle(event('om_same', '生成短结果'), same.config);
    await same.waitDelivered(1);
    const [sameMapping] = await same.repos.channelMappings.list(same.channel);
    const sameSaved = JSON.parse(sameMapping!.extra!);
    const patched = { ...sameSaved, final_message_id: sameSaved.card_message_id };
    delete patched.final_elements;
    await same.repos.channelMappings.save({ ...sameMapping!, extra: JSON.stringify(patched) });
    const sameId = createHash('sha256').update([same.config.appId, sameMapping!.sessionId, patched.runtime_task_id, patched.turn, 'result', patched.runtime_task_id, ''].join('\0')).digest('hex').slice(0, 24);
    await same.repos.config.set(`lark.interaction.${same.config.appId}.${sameId}`, JSON.stringify({
      appId: same.config.appId, sessionId: sameMapping!.sessionId, taskId: patched.runtime_task_id, turn: patched.turn,
      event: event(sameMapping!.externalId, patched.prompt, { chatId: patched.chat_id, chatType: patched.chat_type, senderOpenId: patched.sender_open_id, mentions: [] }),
      id: sameId, boot: 'legacy_boot', kind: 'result', nativeId: patched.runtime_task_id, question: '结果验收', state: 'pending',
      cardId: patched.card_message_id, updatedAt: new Date().toISOString()
    } satisfies LarkInteraction));
    expect(await same.coordinator.handleAction(
      { dutydeck_workflow: 'accept', request_id: sameId, generation: 'legacy_boot' },
      'ou_alice', { messageId: patched.card_message_id, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    expect(same.service.addReaction.mock.calls.filter(([id]) => id === patched.card_message_id)).toHaveLength(0);
  });
});

describe('P0-4 群卡 @ 发起人：默认关字节不变，开启只在审批/终态新消息，排队/心跳/私聊不 @', () => {
  it('默认关闭时审批卡与结果卡均无 @', async () => {
    const h = await harness('permission');
    await h.coordinator.handle(event('om_task', '等待批准'), h.config);
    await vi.waitFor(async () => expect((await h.interactions()).some(item => item.kind === 'permission' && item.state === 'pending')).toBe(true));
    const approvalCard = [...h.cards.values()].find(card => card.awaitingHuman)!;
    expect(JSON.stringify(approvalCard)).not.toContain('group_mention');
    expect(JSON.stringify(approvalCard)).not.toContain('<at');
  });

  it('开启后群审批卡与终态新消息 @ 发起人；过程卡 PATCH、排队/心跳帧不 @；私聊不 @', async () => {
    const h = await harness('normal', { configPatch: { groupCardMention: true } });
    await h.coordinator.handle(event('om_task', '完成目标'), h.config);
    await h.waitDelivered(1);
    const resultCard = [...h.cards.values()].find(card => card.state === 'completed' && Array.isArray(card.elements)
      && card.elements.some((element: any) => element.element_id === 'final_output'))!;
    expect(resultCard).toBeTruthy();
    const mention = resultCard.elements.find((element: any) => element.element_id === 'group_mention');
    expect(mention).toMatchObject({ tag: 'markdown', content: '<at id=ou_alice></at>' });
    expect(resultCard.elements.at(-1)?.element_id).toBe('group_mention');
    // 过程卡的每一帧 PATCH（含排队/运行）都不得携带 @。
    for (const [input] of h.service.update.mock.calls) {
      expect(JSON.stringify(input)).not.toContain('group_mention');
      expect(JSON.stringify(input)).not.toContain('<at');
    }

    // 审批卡同口径。
    const p = await harness('permission', { configPatch: { groupCardMention: true } });
    await p.coordinator.handle(event('om_perm', '等待批准'), p.config);
    await vi.waitFor(async () => expect((await p.interactions()).some(item => item.kind === 'permission' && item.state === 'pending')).toBe(true));
    const approvalCard = [...p.cards.values()].find(card => card.awaitingHuman)!;
    const approvalMention = approvalCard.elements.find((element: any) => element.element_id === 'group_mention');
    expect(approvalMention).toMatchObject({ tag: 'markdown', content: '<at id=ou_alice></at>' });
    expect(approvalCard.elements[0]?.element_id).toBe('group_mention');

    // 私聊即使开启也不 @。
    const dm = await harness('normal', { configPatch: { groupCardMention: true } });
    await dm.coordinator.handle(event('om_dm', '完成目标', { chatType: 'p2p', chatId: 'oc_dm', threadId: undefined }), dm.config);
    await dm.waitDelivered(1);
    expect(JSON.stringify([...dm.cards.values()])).not.toContain('<at');
  });

  it('发起人是机器人时终态卡不 @ 回去，发送方类型落库供重启对账同口径判断', async () => {
    // 机器人之间互相 @ 正是刷屏回路的燃料：回执卡不该再往回路里添一次 @。
    const h = await harness('normal', { configPatch: { groupCardMention: true } });
    await h.coordinator.handle(event('om_bot_task', '完成目标', { senderOpenId: 'ou_peer_bot', senderType: 'app' }), h.config);
    await h.waitDelivered(1);
    expect(JSON.stringify([...h.cards.values()])).not.toContain('group_mention');
    expect(JSON.stringify([...h.cards.values()])).not.toContain('<at');
    // 重启对账补发走的是持久化记录，没有 sender_type 就只能凭 open_id 判断，@ 会重新漏出去。
    const mapping = (await h.repos.channelMappings.list(h.channel)).find(item => item.externalId === 'om_bot_task')!;
    expect(JSON.parse(mapping.extra!).sender_type).toBe('app');
  });

  it('重启对账补发不重复：终态消息保持恰好一枚 @，且不新发结果卡', async () => {
    const h = await harness('normal', { configPatch: { groupCardMention: true } });
    await h.coordinator.handle(event('om_task', '完成目标'), h.config);
    await h.waitDelivered(1);
    const before = structuredClone([...h.cards]);
    const replies = h.service.reply.mock.calls.length;
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      expect(await restored.reconcile(h.config)).toBe(0);
      expect(await restored.reconcile(h.config)).toBe(0);
      expect(h.service.reply).toHaveBeenCalledTimes(replies);
      expect([...h.cards]).toEqual(before);
      const mentions = JSON.stringify(before).match(/element_id":"group_mention"/g) ?? [];
      expect(mentions).toHaveLength(1);
    } finally { restored.stop(); }
  });
});

describe('P0-6 /repair 二次确认回调：串应用/监听/白名单/人类四道门，发布走注入 client', () => {
  it('应用不匹配/停用/机器人身份/非白名单均不建立会话；人类确认执行完整发布 PATCH', async () => {
    const h = await harness();
    const context = { messageId: 'om_repair_card', chatId: 'oc_group' };

    expect(await h.coordinator.handleAction({ ...confirmValue('cli_uxp0'), app_id: 'cli_other' }, 'ou_alice', context))
      .toMatchObject({ type: 'error', content: '确认卡与当前飞书应用不匹配，请重新发送 /repair。' });
    expect(connectMock).not.toHaveBeenCalled();

    await h.saveConfig({ listening: false });
    expect(await h.coordinator.handleAction(confirmValue(), 'ou_alice', context)).toMatchObject({ type: 'warning' });
    expect(connectMock).not.toHaveBeenCalled();
    await h.saveConfig({ listening: true });

    // service.getUserEmails 默认空：模拟 bot（230001 兜底后无邮箱），挡在发布前。
    expect(await h.coordinator.handleAction(confirmValue(), 'ou_bot', context)).toMatchObject({ type: 'warning', content: '/repair 只能由人类成员执行。' });
    expect(connectMock).not.toHaveBeenCalled();

    await h.saveConfig({ allowedUsers: [{ openId: 'ou_carol', name: 'Carol' }] });
    expect(await h.coordinator.handleAction(confirmValue(), 'ou_alice', context)).toMatchObject({ type: 'warning', content: '当前账号无权执行 /repair：需要安装管理员权限。' });
    expect(connectMock).not.toHaveBeenCalled();
    await h.saveConfig({ allowedUsers: [] });

    // 人类 + 有权限 + 已监听：门禁同步通过后回调立即受理（3 秒 SLA），发布在后台跑完 PATCH 结果卡。
    h.service.getUserEmails.mockResolvedValue(['alice@example.com']);
    connectMock.mockResolvedValue(repairClient() as any);
    const accepted = await h.coordinator.handleAction(confirmValue(), 'ou_alice', context);
    expect(accepted).toMatchObject({ type: 'success', content: expect.stringContaining('已开始执行修复') });
    // 受理时发布尚未必然完成，但随后在后台建立会话、跑完整发布并把完成态 PATCH 回原确认卡。
    await vi.waitFor(() => expect(connectMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.service.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'om_repair_card', state: 'completed' })));
    const patched = h.service.update.mock.calls.at(-1)![0];
    expect(JSON.stringify(patched)).toContain('v-1');
  });

  it('同一张确认卡发布进行中再次点击只警告、不重复发布；回调受理不等待发布完成', async () => {
    const h = await harness();
    connectMock.mockClear();
    const context = { messageId: 'om_repair_card', chatId: 'oc_group' };
    h.service.getUserEmails.mockResolvedValue(['alice@example.com']);
    let releaseConnect!: () => void;
    connectMock.mockImplementation(() => new Promise<any>(resolve => { releaseConnect = () => resolve(repairClient()); }));

    const started = Date.now();
    const accepted = await h.coordinator.handleAction(confirmValue(), 'ou_alice', context);
    // 发布连接被 gate 挂住，回调仍必须立即返回（远小于 3 秒 SLA）。
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(accepted).toMatchObject({ type: 'success' });
    await vi.waitFor(() => expect(connectMock).toHaveBeenCalledOnce());
    // 进行中再次点击：warning 且不建立第二个会话。
    expect(await h.coordinator.handleAction(confirmValue(), 'ou_alice', context))
      .toMatchObject({ type: 'warning', content: expect.stringContaining('修复正在执行中') });
    expect(connectMock).toHaveBeenCalledOnce();

    releaseConnect();
    await vi.waitFor(() => expect(h.service.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'om_repair_card', state: 'completed' })));
  });
});

describe('控制命令纠错不执行', () => {
  it.each(['/mew', '/cancle'])('%s 明确拼错时只提示纠正', async typo => {
    const h = await harness();
    await h.coordinator.handle(event('om_typo', typo), h.config);
    expect(h.send).not.toHaveBeenCalled();
    expect(await h.runtime.listSessions()).toHaveLength(0);
    const card = h.service.reply.mock.calls.map(([input]) => input).find(input => input.taskId === 'om_typo')!;
    expect(card.markdown).toContain('未执行');
    expect(card.markdown).toContain('请确认后重新发送');
  });
});

describe('S6/S8/P0-7 帧注记纪律：只在非终态帧，终态帧与结果新消息一律不带', () => {
  it('P0-7 飞书里的 pty-cli 任务只以 full-trust 运行（ask 会被拒绝启动），首卡与心跳都不标注终端提示；acp 同样不标注', async () => {
    // full-trust 下 CLI 跳过权限确认启动，没有需要在电脑前响应的工具确认，写这句就是误报。
    const pty = await harness('normal', { protocol: 'pty-cli', configPatch: { permissionMode: 'full-trust' } });
    await pty.coordinator.handle(ptyEvent('om_pty', '跑一下'), pty.config);
    await pty.waitDelivered(1);
    expect(String(pty.service.reply.mock.calls[0]![0].markdown)).not.toContain(TERMINAL_PROTOCOL_NOTE);
    expect(cardUpdates(pty, input => Array.isArray(input.elements)).length).toBeGreaterThan(0);
    expect(cardUpdates(pty, input => JSON.stringify(input).includes('protocol_hint'))).toHaveLength(0);
    expect(JSON.stringify([...pty.cards.values()])).not.toContain(TERMINAL_PROTOCOL_NOTE);

    const acp = await harness('normal', { protocol: 'acp' });
    await acp.coordinator.handle(acpEvent('om_acp', '跑一下'), acp.config);
    await acp.waitDelivered(1);
    expect(JSON.stringify([...acp.cards.values()])).not.toContain(TERMINAL_PROTOCOL_NOTE);

    function ptyEvent(...args: Parameters<typeof event>) { return event(...args); }
    function acpEvent(...args: Parameters<typeof event>) { return event(...args); }
  });

  it('S8 守护进程重连的 replayed 任务：恢复后非终态帧带注记，终态帧与结果卡不带', async () => {
    const h = await harness('hang');
    await h.coordinator.handle(event('om_hang', '长任务'), h.config);
    await vi.waitFor(() => expect(cardUpdates(h, input => input.state === 'running').length).toBeGreaterThan(0));
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await vi.waitFor(() => expect(cardUpdates(h, input => JSON.stringify(input).includes('recovery_note')).length).toBeGreaterThan(0));
      const noted = cardUpdates(h, input => Array.isArray(input.elements)
        && input.elements.some((element: any) => element.element_id === 'recovery_note')).at(-1)!;
      expect(noted.elements.find((element: any) => element.element_id === 'recovery_note').content).toBe(replayedRecoveryNote());
      expect(noted.state).not.toMatch(/completed|failed|interrupted/);

      h.releaseGate();
      await h.waitDelivered(1);
      const terminal = cardUpdates(h, input => ['completed', 'failed', 'interrupted'].includes(input.state));
      expect(terminal.some(input => JSON.stringify(input).includes('recovery_note'))).toBe(false);
      const resultCard = [...h.cards.values()].find(card => card.readOnly && card.state === 'completed'
        && Array.isArray(card.elements) && card.elements.some((element: any) => element.element_id === 'final_output'))!;
      expect(JSON.stringify(resultCard)).not.toContain('recovery_note');
    } finally { restored.stop(); }
  });

  it('结果卡用时从开始运行算起，运行中的状态刷新不会把它清零', async () => {
    const h = await harness('hang');
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    try {
      await h.coordinator.handle(event('om_elapsed', '长任务'), h.config);
      await vi.waitFor(() => expect(cardUpdates(h, input => input.state === 'running').length).toBeGreaterThan(0));
      skew = 90_000;
      h.releaseGate();
      await h.waitDelivered(1);
      const resultCard = [...h.cards.values()].find(card => card.readOnly && card.state === 'completed'
        && Array.isArray(card.elements) && card.elements.some((element: any) => element.element_id === 'final_output'))!;
      expect(resultCard.elapsedSeconds).toBeGreaterThanOrEqual(90);
    } finally { now.mockRestore(); }
  });

  it('S6 运行卡心跳携带排队摘要（不 @、不新消息），终态帧与结果卡不带；6+ 长队守 24KB/180', async () => {
    const h = await harness('hang');
    await h.coordinator.handle(event('om_a', '第一个任务'), h.config);
    await vi.waitFor(() => expect(cardUpdates(h, input => input.state === 'running' && input.taskId === 'om_a').length).toBeGreaterThan(0));
    await h.coordinator.handle(event('om_b', '第二个任务'), h.config);
    await h.coordinator.handle(event('om_c', '第三个任务'), h.config);
    const summaryInput = await vi.waitFor(() => {
      const found = cardUpdates(h, input => Array.isArray(input.elements)
        && input.elements.some((element: any) => element.element_id === 'queue_summary' && String(element.content).includes('排队 2 条'))).at(-1);
      if (!found) throw new Error('queue summary not rendered');
      return found;
    }, { timeout: 6_000, interval: 200 });
    // 心跳帧只 PATCH：绝不新发消息、绝不 @ 人。
    expect(h.service.send).not.toHaveBeenCalled();
    expect(JSON.stringify(summaryInput)).not.toContain('<at');
    const summary = summaryInput.elements.find((element: any) => element.element_id === 'queue_summary');
    expect(summary.content.length).toBeLessThanOrEqual(500);

    h.releaseGate();
    await h.waitDelivered(3);
    const terminal = cardUpdates(h, input => ['completed', 'failed', 'interrupted'].includes(input.state));
    expect(terminal.some(input => JSON.stringify(input).includes('queue_summary'))).toBe(false);
    const resultCalls = [...h.service.reply.mock.calls, ...h.service.send.mock.calls].map(([input]) => input);
    expect(resultCalls.some(input => JSON.stringify(input).includes('queue_summary'))).toBe(false);
  });

  it('6 个超长排队项：摘要 5 条 + 溢出提示，整卡不超 24KB/180 组件', async () => {
    const h = await harness('hang');
    const longPrompt = `超长任务 <数据 & 明细> ${'甲乙丙丁'.repeat(40)}`;
    await h.coordinator.handle(event('om_a', '主任务'), h.config);
    await vi.waitFor(() => expect(cardUpdates(h, input => input.state === 'running' && input.taskId === 'om_a').length).toBeGreaterThan(0));
    for (let i = 0; i < 6; i++) await h.coordinator.handle(event(`om_q${i}`, longPrompt), h.config);
    const summaryInput = await vi.waitFor(() => {
      const found = cardUpdates(h, input => Array.isArray(input.elements)
        && input.elements.some((element: any) => element.element_id === 'queue_summary' && String(element.content).includes('排队 6 条'))).at(-1);
      if (!found) throw new Error('long queue summary not rendered');
      return found;
    }, { timeout: 6_000, interval: 200 });
    const summary = summaryInput.elements.find((element: any) => element.element_id === 'queue_summary');
    expect(summary.content).toContain('…其余 1 条可在 /tasks 查看');
    expect(summary.content.length).toBeLessThanOrEqual(500);
    const built = buildLarkCard(summaryInput);
    expect(Buffer.byteLength(JSON.stringify(built), 'utf8')).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    const countComponents = (node: unknown): number => {
      if (Array.isArray(node)) return node.reduce((sum, item) => sum + countComponents(item), 0);
      if (!node || typeof node !== 'object') return 0;
      const record = node as Record<string, unknown>;
      return (typeof record.tag === 'string' ? 1 : 0) + Object.values(record).reduce<number>((sum, item) => sum + countComponents(item), 0);
    };
    expect(countComponents(built)).toBeLessThanOrEqual(larkCardSafeLimits.components);
    // 摘要必须在预算试算后仍然存活（没有被 buildLarkCard 的超限兜底换掉）。
    expect(JSON.stringify(built)).toContain('queue_summary');
    h.releaseGate();
    await h.waitDelivered(7);
  });
});

describe('复核回归：托管群 /repair 必须过安装管理员门（all_chat_members 普通成员不可触发应用发布）', () => {
  it('普通人类成员的 /repair 命令与确认回调均被拒；授予 high_risk 门的 can_operate 角色后才放行', async () => {
    const h = await harness('normal', { managedGroup: true });
    connectMock.mockClear();
    const context = { messageId: 'om_repair_card', chatId: 'oc_group' };

    // 命令侧：Bob 在 all_chat_members 群可发言、也有 own_runs，但安装级发布不认这两者。
    await h.coordinator.handle(event('om_repair_bob', '/repair', { senderOpenId: 'ou_bob' }), h.config);
    const bobCard = h.service.reply.mock.calls.map(([input]) => input).at(-1)!;
    expect(String(bobCard.markdown)).toContain('需要安装管理员权限');
    expect(JSON.stringify(bobCard)).not.toContain('dutydeck_repair');
    expect(connectMock).not.toHaveBeenCalled();

    // 回调侧：即便确认卡被转发给 Bob，门禁同样拦截，不建立开放平台会话。
    expect(await h.coordinator.handleAction(confirmValue(), 'ou_bob', context))
      .toMatchObject({ type: 'warning', content: '当前账号无权执行 /repair：需要安装管理员权限。' });
    expect(connectMock).not.toHaveBeenCalled();

    // 放行对照：显式 can_operate + highRisk 门（own_runs 即可，安装级动作与任务归属无关）。
    const bot = (await h.groupManager!.groups()).groups[0]!.bots[0]!;
    const aliceMember = (await h.groupManager!.members(h.config.appId, 'oc_group')).members
      .find(member => member.openId === 'ou_alice')!;
    await h.groupManager!.save(h.config.appId, 'oc_group', { expectedRevision: bot.binding!.revision, patch: {}, roleChanges: [
      { kind: 'create', principalId: aliceMember.principalId, role: 'can_operate', operateScope: 'own_runs',
        actionGates: { terminalWrite: false, highRisk: true, groupToolsSend: false } }
    ] });
    h.service.getUserEmails.mockResolvedValue(['alice@example.com']);
    await h.coordinator.handle(event('om_repair_alice', '/repair'), h.config);
    const aliceCard = h.service.reply.mock.calls.map(([input]) => input).at(-1)!;
    expect(JSON.stringify(aliceCard)).toContain('dutydeck_repair');
    connectMock.mockResolvedValue(repairClient() as any);
    expect(await h.coordinator.handleAction(confirmValue(), 'ou_alice', context))
      .toMatchObject({ type: 'success', content: expect.stringContaining('已开始执行修复') });
    await vi.waitFor(() => expect(connectMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(h.service.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'om_repair_card', state: 'completed' })));
  });
});

describe('复核回归：queue_summary 是瞬态读数，不冻结进 last_successful_elements，重启对账不重放', () => {
  it('运行帧带排队摘要并落库后，持久化元素剥除摘要；新守护进程首轮对账的恢复 PATCH 不含陈旧排队', async () => {
    const h = await harness('hang');
    await h.coordinator.handle(event('om_a', '主任务'), h.config);
    await vi.waitFor(() => expect(cardUpdates(h, input => input.state === 'running' && input.taskId === 'om_a').length).toBeGreaterThan(0));
    await h.coordinator.handle(event('om_b', '排队任务'), h.config);
    await vi.waitFor(() => {
      const found = cardUpdates(h, input => Array.isArray(input.elements)
        && input.elements.some((element: any) => element.element_id === 'queue_summary' && String(element.content).includes('排队 1 条'))).at(-1);
      if (!found) throw new Error('queue summary not rendered');
    }, { timeout: 6_000, interval: 200 });

    // 修复证据：崩溃前最后一帧成功 PATCH 后，落库的成功元素不含 queue_summary。
    let frozenElements: any[] = [];
    await vi.waitFor(async () => {
      const [mappingA] = (await h.repos.channelMappings.list(h.channel)).filter(item => item.externalId === 'om_a');
      const extra = mappingA?.extra ? JSON.parse(mappingA.extra) : null;
      frozenElements = extra?.last_successful_elements;
      expect(Array.isArray(frozenElements)).toBe(true);
      expect(frozenElements.length).toBeGreaterThan(0);
    }, { timeout: 3_000, interval: 50 });
    expect(frozenElements.some(element => element.element_id === 'queue_summary')).toBe(false);

    // 模拟守护进程重启：新 coordinator 尚未 adopt 任务时首轮对账先跑（reconciler.ts 的冻结元素重放路径）。
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      const before = h.service.update.mock.calls.length;
      await restored.reconcile(h.config);
      const replayed = h.service.update.mock.calls.slice(before).map(([input]) => input);
      // 恢复重绘只允许当前恢复事实（markdown 注记），绝不重放冻结 trace，也不带陈旧排队摘要。
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed.some(input => Array.isArray(input.elements))).toBe(false);
      expect(replayed.some(input => JSON.stringify(input).includes('queue_summary'))).toBe(false);
    } finally { restored.stop(); }
  });
});

describe('飞书输入明确反馈与提问生命周期', () => {
  it('真实 broker 超时后一个心跳内关闭卡；点击与引用旧卡均不新建任务', async () => {
    const h = await harness('hang', { configPatch: { structuredAskCards: true } });
    await h.coordinator.handle(event('om_expiry_task', '等我的回答'), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    const [session] = await h.runtime.listSessions();
    const waiting = h.broker.register({ sessionId: session!.id, question: '选哪个？', choices: [{ label: '继续' }], timeoutMs: 1_000 });
    let record!: LarkInteraction;
    await vi.waitFor(async () => {
      record = (await h.interactions()).find(item => item.kind === 'ask')!;
      expect(record?.cardId).toBeTruthy();
    });
    expect(JSON.stringify(h.cards.get(record.cardId!))).toContain('回答截止时间');
    const value = callbackValues(h.cards.get(record.cardId!)).find(item => item.dutydeck_workflow === 'answer')!;
    expect(await waiting).toMatchObject({ status: 'expired' });
    await vi.waitFor(() => expect(h.cards.get(record.cardId!)).toMatchObject({ statusLabel: '已失效', readOnly: true }), { timeout: 1_500 });
    expect(callbackValues(h.cards.get(record.cardId!))).toHaveLength(0);
    expect(JSON.stringify(h.cards.get(record.cardId!))).toContain('/status');
    expect(JSON.stringify(h.cards.get(record.cardId!))).not.toContain('重新提问');
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: record.cardId!, chatId: 'oc_group' })).toMatchObject({ type: 'error', content: expect.stringContaining('失效') });
    await h.coordinator.handle(event('om_expired_reply', '继续', { parentId: record.cardId }), h.config);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(await h.runtime.getTasks(session!.id)).toHaveLength(1);
  });

  it.each(['denied', 'disabled'] as const)('%s 群明确人类请求给原因和下一步；闲聊及其他机器人静默，重复和重启去重', async mode => {
    const h = await harness('normal', { managedGroup: true });
    const bot = (await h.groupManager!.groups()).groups[0]!.bots[0]!;
    const bob = (await h.groupManager!.members(h.config.appId, 'oc_group')).members.find(item => item.openId === 'ou_bob')!;
    await h.groupManager!.save(h.config.appId, 'oc_group', { expectedRevision: bot.binding!.revision,
      patch: mode === 'disabled' ? { state: 'disabled' } : { accessOverride: { mode: 'allowlist', principalIds: [bob.principalId] } } });
    const request = event(`om_${mode}`, '开始任务');
    await Promise.all([h.coordinator.handle(request, h.config), h.coordinator.handle(request, h.config)]);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.service.reply).toHaveBeenCalledTimes(1);
    expect(h.service.reply.mock.calls[0]![0].markdown).toContain('请求未执行');
    expect(h.service.reply.mock.calls[0]![0].markdown).toContain('管理员');
    await h.coordinator.handle(event('om_chatter', '普通聊天', { mentions: [] }), h.config);
    await h.coordinator.handle(event('om_other_bot', '其他机器人请求', { senderType: 'app' }), h.config);
    await h.coordinator.handle(event('om_wrong_target', '开始', { mentions: [{ key: '@_user_1', name: 'Other', openId: 'ou_other_bot', mentionedType: 'bot' }] }), h.config);
    expect(h.service.reply).toHaveBeenCalledTimes(1);
    const restarted = h.createCoordinator();
    try { await restarted.handle(request, h.config); } finally { restarted.stop(); }
    expect(h.service.reply).toHaveBeenCalledTimes(1);
  });

  it('只读/help无需执行能力，发起任务仍被执行门拒绝', async () => {
    const h = await harness('normal', { executionPolicy: { integrationMode: 'legacy_unmanaged',
      authorize: async (_boundary, action) => ({ allowed: false, action, code: 'test_denied', reason: '机器人运行权限尚未确认。', source: 'explicit_deny' }) } });
    await h.coordinator.handle(event('om_view_help', '/help'), h.config);
    expect(JSON.stringify(h.service.reply.mock.calls)).toContain('/help');
    expect(JSON.stringify(h.service.reply.mock.calls)).not.toContain('请求未执行');
    await h.coordinator.handle(event('om_view_task', '执行任务'), h.config);
    expect(h.service.reply.mock.calls.at(-1)![0].markdown).toContain('请求未执行');
    expect(h.service.reply.mock.calls.at(-1)![0].markdown).toContain('运行权限尚未确认');
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('话题内引用自己的请求后补 @', () => {
  const request = '总结下这个文档要做的事情（包括子文档），按主题聚合：https://example.larkoffice.com/docx/test';
  const original: LarkChatMessage = {
    messageId: 'om_request', chatId: 'oc_group', messageType: 'text', createTime: '1790232625764',
    sender: { id: 'ou_alice', idType: 'open_id', type: 'user' }, rawContent: JSON.stringify({ text: request }),
    mentions: [], deleted: false, updated: false
  };
  const wake = (patch: Partial<LarkMessageEvent> = {}) => event('om_wake', '@_user_1', {
    rootId: 'om_request', parentId: 'om_request', createTime: '1790233043511', ...patch
  });

  it.each(['parent', 'root'] as const)('uses the verified %s request without forcing another confirmation', async reference => {
    const h = await harness();
    h.service.getMessage.mockResolvedValue(original as any);
    await h.coordinator.handle(wake(reference === 'root' ? { parentId: undefined } : {}), h.config);
    await h.waitDelivered(1);
    const prompt = h.send.mock.calls[0]?.[0] as string;
    expect(h.service.getMessage).toHaveBeenCalledWith('om_request');
    expect(prompt).toContain(request);
    expect(prompt).toContain('用户通过本次 @ 请求你处理下面自己发出的原消息');
    expect(prompt).toContain('原消息没有明确请求或指代仍不清楚时，才询问缺少的信息');
    expect(prompt).not.toContain('必须先复述你对用户意图的理解并询问确认');
    const sessions = await h.repos.sessions.list();
    const tasks = await h.repos.tasks.listBySession(sessions[0]!.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'completed', prompt: expect.stringContaining(request) });
  });

  it.each([
    ['another user', { sender: { id: 'ou_bob', idType: 'open_id', type: 'user' } }],
    ['bot author', { sender: { id: 'ou_alice', idType: 'open_id', type: 'app' } }],
    ['unknown author', { sender: {} }],
    ['another chat', { chatId: 'oc_other' }],
    ['unknown chat', { chatId: undefined }],
    ['another message', { messageId: 'om_other' }],
    ['deleted message', { deleted: true }],
    ['empty text', { rawContent: '{"text":""}' }],
    ['forwarded material', { messageType: 'merge_forward' }]
  ] satisfies Array<[string, Partial<LarkChatMessage>]>)('keeps confirmation for %s', async (_name, patch) => {
    const h = await harness();
    h.service.getMessage.mockResolvedValue({ ...original, ...patch } as any);
    await h.coordinator.handle(wake(), h.config);
    await h.waitDelivered(1);
    const prompt = h.send.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('必须先复述你对用户意图的理解并询问确认');
    expect(prompt).not.toContain('用户通过本次 @ 请求你处理下面自己发出的原消息');
  });

  it('does not fall back to an old own root request when replying to someone else', async () => {
    const h = await harness();
    h.service.getMessage.mockImplementation(async id => id === 'om_request' ? original as any
      : { ...original, messageId: id, sender: { id: 'ou_bob', type: 'user' } } as any);
    h.service.listChatMessages.mockResolvedValue({ items: [original], hasMore: false });
    await h.coordinator.handle(wake({ parentId: 'om_bob_reply' }), h.config);
    await h.waitDelivered(1);
    expect(h.send.mock.calls[0]?.[0]).toContain('必须先复述你对用户意图的理解并询问确认');
  });

  it('keeps confirmation when the referenced message cannot be fetched', async () => {
    const h = await harness();
    h.service.getMessage.mockRejectedValue(new Error('message unavailable'));
    h.service.listChatMessages.mockResolvedValue({ items: [original], hasMore: false });
    await h.coordinator.handle(wake(), h.config);
    await h.waitDelivered(1);
    expect(h.send.mock.calls[0]?.[0]).toContain(request);
    expect(h.send.mock.calls[0]?.[0]).toContain('必须先复述你对用户意图的理解并询问确认');
  });
});

describe('执行前上下文读取超时', () => {
  it('reports a stalled thread read and lets the next request in that thread run', async () => {
    const h = await harness();
    h.service.listChatMessages.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    await h.coordinator.handle(event('om_stalled', '@_user_1 处理第一件事'), h.config);
    for (let i = 0; i < 100 && !h.service.listChatMessages.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(1);
    expect(h.service.listChatMessages).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_001);
    vi.useRealTimers();
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', markdown: expect.stringContaining('上下文读取超时')
    })));
    expect(h.send).not.toHaveBeenCalled();
    await h.coordinator.handle(event('om_next', '@_user_1 处理第二件事'), h.config);
    await h.waitDelivered(1);
    expect(h.send.mock.calls[0]?.[0]).toContain('处理第二件事');
  });

  it('bounds an empty @ reference lookup and releases the thread', async () => {
    const h = await harness();
    h.service.getMessage.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    await h.coordinator.handle(event('om_empty_stalled', '@_user_1', { parentId: 'om_parent' }), h.config);
    for (let i = 0; i < 100 && !h.service.getMessage.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(1);
    expect(h.service.getMessage).toHaveBeenCalledWith('om_parent');
    await vi.advanceTimersByTimeAsync(15_001);
    vi.useRealTimers();
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({
      state: 'failed', markdown: expect.stringContaining('上下文读取超时')
    })));
    expect(h.send).not.toHaveBeenCalled();
    await h.coordinator.handle(event('om_after_empty', '@_user_1 下一条'), h.config);
    await h.waitDelivered(1);
    expect(h.send.mock.calls[0]?.[0]).toContain('下一条');
  });

  it('does not send a stale context failure after /new supersedes the waiting turn', async () => {
    const h = await harness();
    h.service.listChatMessages.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    await h.coordinator.handle(event('om_before_new', '@_user_1 旧请求'), h.config);
    for (let i = 0; i < 100 && !h.service.listChatMessages.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(1);
    expect(h.service.listChatMessages).toHaveBeenCalledOnce();
    await h.coordinator.handle(event('om_new', '/new'), h.config);
    await vi.advanceTimersByTimeAsync(15_001);
    vi.useRealTimers();
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskName: '请求未执行' })));
    expect(h.service.reply).not.toHaveBeenCalledWith(expect.objectContaining({ taskName: '上下文读取失败' }));
    expect(h.send).not.toHaveBeenCalled();
  });

  it('closes an existing process card when /new supersedes a stalled group context read', async () => {
    let release!: () => void;
    const taskContext = vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => { release = () => resolve(''); }))
      .mockResolvedValue('');
    const participation = { handle: async () => ({ enabled: false }), guardBotTurn: async () => undefined,
      taskContext, instructions: async () => '' } as unknown as LarkGroupParticipation;
    const h = await harness('normal', { participation });
    vi.spyOn(h.runtime, 'stop').mockImplementation(async () => undefined as any);
    vi.useFakeTimers();
    await h.coordinator.handle(event('om_prepared', '@_user_1 旧请求'), h.config);
    try {
      for (let i = 0; i < 100 && !taskContext.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(1);
      expect(taskContext).toHaveBeenCalledOnce();
      expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'om_prepared', cardKind: 'process' }));
      await h.coordinator.handle(event('om_new_prepared', '/new'), h.config);
      await vi.advanceTimersByTimeAsync(15_001);
      vi.useRealTimers();
      await vi.waitFor(() => expect(h.service.update).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'om_prepared', state: 'interrupted' })));
      await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'om_prepared', cardKind: 'result', state: 'interrupted' })));
      expect(JSON.stringify(h.service.reply.mock.calls)).toContain('这条请求没有执行：期间收到了 /new');
      expect(JSON.parse((await h.repos.config.get('lark.inbox.cli_uxp0.om_prepared'))!)).toMatchObject({ state: 'failed' });
      expect(h.send).not.toHaveBeenCalled();
      release();
      await Promise.resolve();
      expect(h.send).not.toHaveBeenCalled();
      await h.coordinator.handle(event('om_after_prepared', '@_user_1 新请求'), h.config);
      await h.waitDelivered(2);
      expect(h.send).toHaveBeenCalledOnce();
      expect(h.send.mock.calls[0]?.[0]).toContain('新请求');
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it('does not send a context failure after coordinator shutdown', async () => {
    const h = await harness();
    h.service.listChatMessages.mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    await h.coordinator.handle(event('om_before_stop', '@_user_1 等待读取'), h.config);
    for (let i = 0; i < 100 && !h.service.listChatMessages.mock.calls.length; i++) await vi.advanceTimersByTimeAsync(1);
    expect(h.service.listChatMessages).toHaveBeenCalledOnce();
    h.coordinator.stop();
    await vi.advanceTimersByTimeAsync(15_001);
    vi.useRealTimers();
    expect(h.service.reply).not.toHaveBeenCalledWith(expect.objectContaining({ taskName: '上下文读取失败' }));
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('顶层补 @ 沿用自己刚发的请求', () => {
  const request = '总结下这个文档要做的事情（包括子文档），按主题聚合：https://example.larkoffice.com/docx/test';
  const own: LarkChatMessage = {
    messageId: 'om_request', chatId: 'oc_group', messageType: 'text', createTime: '1790232625764',
    sender: { id: 'ou_alice', idType: 'open_id', type: 'user' }, rawContent: JSON.stringify({ text: request }),
    mentions: [], deleted: false, updated: false
  };
  const run = async (items: LarkChatMessage[]) => {
    const h = await harness();
    h.service.listChatMessages.mockResolvedValue({ items, hasMore: false });
    await h.coordinator.handle(event('om_wake', '@_user_1', { threadId: undefined, rootId: undefined, createTime: '1790233043511' }), h.config);
    await h.waitDelivered(1);
    return h.send.mock.calls[0]?.[0] as string;
  };

  it.each([
    ['no later messages', [own]],
    ['a bot message posted after the bare mention', [own, { ...own, messageId: 'om_bot_later', createTime: '1790233100000', sender: { id: 'cli_uxp0', idType: 'app_id', type: 'app' } }]]
  ] satisfies Array<[string, LarkChatMessage[]]>)('runs the request without another confirmation round with %s', async (_name, items) => {
    const prompt = await run(items);
    expect(prompt).toContain('[Dutydeck 空 @ 沿用请求]');
    expect(prompt).toContain(request);
    expect(prompt).not.toContain('必须先复述你对用户意图的理解并询问确认');
  });

  it.each([
    ['a request older than ten minutes', [{ ...own, createTime: String(1790233043511 - 11 * 60 * 1000) }]],
    ['a request this bot already answered', [own, { ...own, messageId: 'om_bot', createTime: '1790232700000', sender: { id: 'cli_uxp0', idType: 'app_id', type: 'app' } }]],
    ['a request addressed to someone else', [{ ...own, mentions: [{ key: '@_user_2', id: 'ou_bob', idType: 'open_id', name: 'Bob' }] }]],
    ['another member request', [{ ...own, sender: { id: 'ou_bob', idType: 'open_id', type: 'user' } }]],
    ['a slash command', [{ ...own, rawContent: JSON.stringify({ text: '/status' }) }]]
  ] satisfies Array<[string, LarkChatMessage[]]>)('keeps confirmation for %s', async (_name, items) => {
    const prompt = await run(items);
    expect(prompt).toContain('必须先复述你对用户意图的理解并询问确认');
    expect(prompt).not.toContain('[Dutydeck 空 @ 沿用请求]');
  });
});

describe('群参与开启时的话题续问与转交执行', () => {
  const root: LarkChatMessage = {
    messageId: 'om_root', chatId: 'oc_group', messageType: 'text', createTime: '1790232625764',
    sender: { id: 'ou_alice', idType: 'open_id', type: 'user' }, rawContent: JSON.stringify({ text: '@_user_1 先整理一版方案' }),
    // 与真实消息读取接口一致：被 @ 的机器人以 app_id 返回。
    mentions: [{ key: '@_user_1', id: 'cli_uxp0', idType: 'app_id', name: 'Dock' }], deleted: false, updated: false
  };
  const tag = (mode: 'off' | 'selective' = 'selective') => {
    const handle = vi.fn(async (_event: LarkMessageEvent, _config: StoredLarkConfig, _input: { explicit: boolean }) => ({ enabled: mode !== 'off', instructions: '' }));
    const participation = { handle, mode: async () => mode, guardBotTurn: async () => undefined, taskContext: async () => '', instructions: async () => '',
      describe: async () => '**群参与**：Tag 按需参与' } as unknown as LarkGroupParticipation;
    return { handle, participation };
  };
  const botCard = (id: string) => ({ ...root, messageId: id, sender: { id: 'cli_uxp0', idType: 'app_id', type: 'app' }, mentions: [] });
  const start = async (mode?: 'off' | 'selective', rootPatch: Partial<LarkMessageEvent> = {}) => {
    const { handle, participation } = tag(mode);
    const h = await harness('normal', { managedGroup: true, participation });
    // 根消息是 Alice @ 机器人的请求，om_card_* 是机器人自己发的卡片，其他消息都来自 Alice。
    h.service.getMessage.mockImplementation(async (id: string) => (id === 'om_root' ? root : id.startsWith('om_card_') ? botCard(id) : { ...root, messageId: id, mentions: [] }) as any);
    await h.coordinator.handle(event('om_root', '@_user_1 先整理一版方案', rootPatch), h.config);
    await h.waitDelivered(1);
    return { h, handle };
  };
  const followUp = (patch: Partial<LarkMessageEvent> = {}) => event('om_follow', '再补充一下兼容旧配置', { mentions: [], parentId: 'om_root', ...patch });
  const inputFor = (handle: ReturnType<typeof tag>['handle'], messageId: string) => handle.mock.calls.find(([item]) => item.messageId === messageId)?.[2];

  it('continues the requester own topic without another @', async () => {
    const { h, handle } = await start();
    await h.coordinator.handle(followUp(), h.config);
    await h.waitDelivered(2);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1]?.[0]).toContain('再补充一下兼容旧配置');
    expect(inputFor(handle, 'om_follow')).toMatchObject({ explicit: true });
  });

  it('continues a plain reply to the bot card in an ordinary group', async () => {
    const { h, handle } = await start('selective', { threadId: undefined, rootId: undefined });
    await h.coordinator.handle(followUp({ threadId: undefined, parentId: 'om_card_1' }), h.config);
    await h.waitDelivered(2);
    expect(h.send.mock.calls[1]?.[0]).toContain('再补充一下兼容旧配置');
    expect(inputFor(handle, 'om_follow')).toMatchObject({ explicit: true });
  });

  it.each([
    ['another member', { senderOpenId: 'ou_bob' }],
    ['a message addressed to someone else', { mentions: [{ key: '@_user_2', name: 'Bob', openId: 'ou_bob' }] }],
    ['a reply to a member message in the topic', { parentId: 'om_other' }],
    ['a top-level message without a reply target', { threadId: undefined, rootId: undefined, parentId: undefined }]
  ] satisfies Array<[string, Partial<LarkMessageEvent>]>)('leaves %s to the participation decider', async (_name, patch) => {
    const { h, handle } = await start();
    await h.coordinator.handle(followUp(patch), h.config);
    expect(inputFor(handle, 'om_follow')).toMatchObject({ explicit: false });
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.service.addReaction).not.toHaveBeenCalledWith('om_follow', expect.anything());
  });

  it('continues a topic the bot already works in even when its root had no @', async () => {
    const { h, handle } = await start();
    h.service.getMessage.mockImplementation(async (id: string) => ({ ...root, messageId: id, mentions: [] }) as any);
    await h.coordinator.handle(followUp(), h.config);
    await h.waitDelivered(2);
    expect(inputFor(handle, 'om_follow')).toMatchObject({ explicit: true });
  });

  it('does not continue an ordinary-group reply whose root did not ask this bot', async () => {
    const { h, handle } = await start('selective', { threadId: undefined, rootId: undefined });
    h.service.getMessage.mockImplementation(async (id: string) => ({ ...root, messageId: id, mentions: [] }) as any);
    await h.coordinator.handle(followUp({ threadId: undefined }), h.config);
    expect(inputFor(handle, 'om_follow')).toMatchObject({ explicit: false });
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('keeps the mention rule when group participation is off', async () => {
    const { h } = await start('off');
    await h.coordinator.handle(followUp(), h.config);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.service.addReaction).not.toHaveBeenCalledWith('om_follow', expect.anything());
  });

  it('runs an adopted act message through the ordinary explicit path', async () => {
    const { participation } = tag();
    const h = await harness('normal', { managedGroup: true, participation });
    await h.coordinator.adopt(event('om_act', 'Dock 帮我读一下需求文档', { mentions: [], threadId: undefined, rootId: undefined }), h.config);
    await h.waitDelivered(1);
    expect(h.send.mock.calls[0]?.[0]).toContain('帮我读一下需求文档');
    expect(h.service.addReaction).toHaveBeenCalledWith('om_act', 'OK');
  });

  it('shows the group participation mode in /status', async () => {
    const { h } = await start();
    await h.coordinator.handle(event('om_status', '@_user_1 /status'), h.config);
    await vi.waitFor(() => expect(JSON.stringify(h.service.reply.mock.calls)).toContain('群参与'));
  });
});

describe('Tag 群上下文按会话增量注入', () => {
  const scope = { appId: 'cli_uxp0', chatId: 'oc_group' };
  const groupContext = (prompt: string) => prompt.split('\n\n').find(block => block.startsWith('[Dutydeck 群上下文')) ?? '';
  const start = async (mode: HarnessMode = 'normal', options: Pick<NonNullable<Parameters<typeof harness>[1]>, 'authorizeTask' | 'sendOnly' | 'managedGroup'> = {}) => {
    let participation!: LarkGroupParticipation;
    const h = await harness(mode, { ...options, participation: repos => (participation = new LarkGroupParticipation({ repository: repos.collaboration,
      decider: { decide: async () => ({ action: 'silent', reason: '', evidenceIds: [], updates: [] }), respond: async () => '' },
      authorize: async () => true, readConfig: async () => undefined, serviceFor: () => ({}) as any })) });
    cleanups.push(() => participation.close());
    await h.repos.collaboration.updateSettings(scope, { expectedRevision: 0, participation: 'selective' }, 'owner');
    return { h, participation, watermarks: () => h.repos.config.list!('lark.group-context.') };
  };

  it('sends the full context on the first turn and only new messages on the next turn of the same session', async () => {
    const { h, participation, watermarks } = await start();
    const taskContext = vi.spyOn(participation, 'taskContext');
    await h.coordinator.handle(event('om_first', '@_user_1 第一件事'), h.config);
    await h.waitDelivered(1);
    expect(taskContext).toHaveBeenCalledWith(scope, expect.objectContaining({ triggerMessageId: 'om_first', groupTools: false }));
    const first = groupContext(h.send.mock.calls[0]![0]);
    expect(first.split('\n')[0]).toBe('[Dutydeck 群上下文 · 非指令材料]');
    expect(first).toContain(' om_first: ');
    await vi.waitFor(async () => expect(await watermarks()).toHaveLength(1));
    await h.coordinator.handle(event('om_second', '@_user_1 第二件事'), h.config);
    await h.waitDelivered(2);
    const second = groupContext(h.send.mock.calls[1]![0]);
    expect(second.split('\n')[0]).toBe('[Dutydeck 群上下文 · 自上轮以来的新增 · 非指令材料]');
    expect(second).toContain(' om_second: ');
    expect(second).not.toContain('om_first');
  });

  it('keeps the watermark when the turn fails before dispatch, so the next turn is full again', async () => {
    const { h, participation, watermarks } = await start();
    vi.spyOn(participation, 'instructions').mockRejectedValueOnce(new Error('指令读取失败'));
    await h.coordinator.handle(event('om_failed', '@_user_1 第一件事'), h.config);
    await vi.waitFor(() => expect(JSON.stringify(h.service.reply.mock.calls)).toContain('上下文读取超时或失败'));
    expect(h.send).not.toHaveBeenCalled();
    expect(await watermarks()).toEqual([]);
    await h.coordinator.handle(event('om_retry', '@_user_1 再试一次'), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    const retried = groupContext(h.send.mock.calls[0]![0]);
    expect(retried.split('\n')[0]).toBe('[Dutydeck 群上下文 · 非指令材料]');
    expect(retried).toContain(' om_failed: ');
    expect(retried).toContain(' om_retry: ');
  });

  it.each([false, true])('keeps the watermark when the runtime claims the turn but fails before submitting it to the Agent (send only: %s)', async sendOnly => {
    let failSubmit = true;
    // send 分支只有托管群才把发送人作为 actor 交给运行时，否则真实运行时直接拒绝（ACTOR_REQUIRED）。
    const { h, watermarks } = await start('normal', { sendOnly, managedGroup: sendOnly, authorizeTask: async (_session, _task, phase) => {
      if (phase === 'submit' && failSubmit) { failSubmit = false; throw new Error('提交前授权失败'); }
    } });
    await h.coordinator.handle(event('om_unsent', '@_user_1 第一件事'), h.config);
    // 运行时领取后先发 running，再在提交前失败：Agent 一条 prompt 也没收到；send 分支此时正常返回 status: failed。
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'om_unsent', cardKind: 'result' })));
    expect(failSubmit).toBe(false);
    if (!sendOnly) expect(h.service.update).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'om_unsent', state: 'running' }));
    expect(h.send).not.toHaveBeenCalled();
    expect(await watermarks()).toEqual([]);
    await h.coordinator.handle(event('om_next', '@_user_1 第二件事'), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    const next = groupContext(h.send.mock.calls[0]![0]);
    expect(next.split('\n')[0]).toBe('[Dutydeck 群上下文 · 非指令材料]');
    expect(next).toContain(' om_unsent: ');
    expect(next).toContain(' om_next: ');
  });

  it('merges the watermark of a turn queued behind another so the next turn skips what both already received', async () => {
    const { h, watermarks } = await start('hang');
    await h.coordinator.handle(event('om_a', '@_user_1 第一件事'), h.config);
    await vi.waitFor(() => expect(cardUpdates(h, input => input.taskId === 'om_a' && input.state === 'running').length).toBeGreaterThan(0));
    // B 在 A 执行期间读上下文并排队：两轮都从同一个（空）水位出发。
    await h.coordinator.handle(event('om_b', '@_user_1 第二件事'), h.config);
    await vi.waitFor(async () => expect((await h.runtime.getTasks((await h.runtime.listSessions())[0]!.id)).filter(task => task.status === 'queued')).toHaveLength(1));
    const afterB = (await h.repos.collaboration.snapshot(scope, 1)).contextRevision;
    h.releaseGate();
    await h.waitDelivered(2);
    // A 先写回；B 的 CAS 基于旧值必然冲突，合并后水位应推进到 B 读到的位置。
    await vi.waitFor(async () => expect(JSON.parse((await watermarks())[0]!.value).contextRevision).toBe(afterB));
    await h.coordinator.handle(event('om_c', '@_user_1 第三件事'), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
    const third = groupContext(h.send.mock.calls[2]![0]);
    expect(third.split('\n')[0]).toBe('[Dutydeck 群上下文 · 自上轮以来的新增 · 非指令材料]');
    expect(third).toContain(' om_c: ');
    expect(third).not.toContain('om_b');
    expect(third).not.toContain('om_a');
  });

  it('does not advance the watermark when a restart only reattaches the already dispatched turn', async () => {
    const { h, watermarks } = await start('hang');
    await h.coordinator.handle(event('om_hang', '@_user_1 长任务'), h.config);
    await vi.waitFor(() => expect(cardUpdates(h, input => input.state === 'running').length).toBeGreaterThan(0));
    h.coordinator.stop();
    const at = new Date().toISOString();
    await h.repos.collaboration.observe({ scope, source: 'lark.message', eventId: 'om_restart', occurredAt: at, receivedAt: at, senderId: 'ou_bob', senderKind: 'human',
      messageId: 'om_restart', text: '重启期间的新消息', refs: ['om_restart'], origin: 'live', missing: [] });
    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await vi.waitFor(() => expect(cardUpdates(h, input => JSON.stringify(input).includes('recovery_note')).length).toBeGreaterThan(0));
      h.releaseGate();
      await h.waitDelivered(1);
      // 重连的那一轮仍是重启前派发的 prompt，没见过重启期间的新消息。
      expect(await watermarks()).toEqual([]);
      await restored.handle(event('om_after', '@_user_1 下一件事'), h.config);
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
      const next = groupContext(h.send.mock.calls[1]![0]);
      expect(next.split('\n')[0]).toBe('[Dutydeck 群上下文 · 非指令材料]');
      expect(next).toContain(' om_restart: ');
    } finally { restored.stop(); }
  });
});

describe('卡片标题', () => {
  it('去掉开头对本机器人的 @，@ 别的机器人和正文里的 @ 保留', () => {
    expect(larkTaskTitle('@bdev-flash 详细总结下群聊', 'bdev-flash')).toBe('详细总结下群聊');
    expect(larkTaskTitle('@bdev-flash @bdev-flash  重跑一次', 'bdev-flash')).toBe('重跑一次');
    expect(larkTaskTitle('@other-bot 帮我看下', 'bdev-flash')).toBe('@other-bot 帮我看下');
    expect(larkTaskTitle('@bdev-flashy 帮我看下', 'bdev-flash')).toBe('@bdev-flashy 帮我看下');
    expect(larkTaskTitle('请 @bdev-flash 看下', 'bdev-flash')).toBe('请 @bdev-flash 看下');
    // 只有 @ 没有正文时保留原话，标题不能是空的；没有机器人名时不动。
    expect(larkTaskTitle('@bdev-flash', 'bdev-flash')).toBe('@bdev-flash');
    expect(larkTaskTitle('@bdev-flash 做事')).toBe('@bdev-flash 做事');
    expect(larkTaskTitle(`@bdev-flash ${'长'.repeat(100)}`, 'bdev-flash')).toHaveLength(80);
  });
});
