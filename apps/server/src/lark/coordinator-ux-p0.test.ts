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
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkGroupManager } from './group-management.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkInteraction } from './workflow-interactions.js';
import { buildLarkCard, larkCardSafeLimits } from './service.js';
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
  options: { protocol?: 'acp' | 'pty-cli'; configPatch?: Partial<StoredLarkConfig>; answerChunks?: string[]; managedGroup?: boolean } = {}
) {
  const protocol = options.protocol ?? 'acp';
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-uxp0-'));
  const repos = createRepositories(join(cwd, 'state.db'));
  let broker!: RelayAskBroker;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(done => { release = done; });
  const send = vi.fn(); const resolvePermission = vi.fn(); const interrupt = vi.fn();
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol, available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit, _exit, _sessionId) => {
      const driver: AgentDriver = {
        start: async () => {},
        stop: async () => { if (mode !== 'hang') release?.(); },
        interrupt: async () => { release?.(); },
        send: async prompt => {
          send(prompt);
          if (mode === 'permission') {
            const waiting = new Promise<void>(done => { release = done; });
            emit({ type: 'permission_request', data: { id: 'native_permission', title: '修改文件', status: 'pending', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } });
            await waiting;
            emit({ type: 'text', data: { text: '审批处理完成' } });
          } else if (mode === 'hang') {
            emit({ type: 'text', data: { text: '执行中' } });
            await gate;
            emit({ type: 'text', data: { text: '工作已完成' } });
          } else if (options.answerChunks) {
            for (const text of options.answerChunks) emit({ type: 'text', data: { text } });
          } else emit({ type: 'text', data: { text: '工作已完成' } });
        },
        resolvePermission: async (id, approved) => { resolvePermission(id, approved); release?.(); return true; }
      };
      return driver;
    }
  });
  broker = new RelayAskBroker({ publish: async (sessionId, input) => { await runtime.publishSessionEvent(sessionId, 'text', { text: input.text, relay: input.kind, askId: input.askId }); } }, createRelayAskStore(repos.config));
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
    fullTrustConfirmed: true, preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
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
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => []),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_bob' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', threadId: 'omt_topic', messageType: 'text', rawContent: JSON.stringify({ text: '已核实的引用材料' }), sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => []),
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
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, groupManager, { store: repos.config, broker });
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
  it('他人中断先警告不执行，60 秒内二点放行并落传 actor；本人首点即执行', async () => {
    const h = await harness('permission');
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
    expect(String(h.service.update.mock.calls.at(-1)![0].markdown)).toContain('第 2/2 页');

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
    expect(saved.final_elements).toBeUndefined();
    const id = createHash('sha256').update([h.config.appId, mapping!.sessionId, saved.runtime_task_id, saved.turn, 'result', saved.runtime_task_id, ''].join('\0')).digest('hex').slice(0, 24);
    const record: LarkInteraction = {
      appId: h.config.appId, sessionId: mapping!.sessionId, taskId: saved.runtime_task_id, turn: saved.turn,
      event: event(mapping!.externalId, saved.prompt, { chatId: saved.chat_id, chatType: saved.chat_type, threadId: saved.thread_id, senderOpenId: saved.sender_open_id, mentions: [] }),
      id, boot: 'legacy_boot', kind: 'result', nativeId: saved.runtime_task_id, question: '结果验收', state: 'pending',
      cardId: saved.final_message_id, updatedAt: new Date().toISOString()
    };
    await h.repos.config.set(`lark.interaction.${h.config.appId}.${id}`, JSON.stringify(record));
    return { h, record, fileMessageId: saved.final_message_id as string };
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
      'ou_alice', { messageId: changes.fileMessageId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
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
    expect(mention).toMatchObject({ tag: 'markdown', content: '<at user_id="ou_alice">成员</at>' });
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
    expect(approvalMention).toMatchObject({ tag: 'markdown', content: '<at user_id="ou_alice">成员</at>' });

    // 私聊即使开启也不 @。
    const dm = await harness('normal', { configPatch: { groupCardMention: true } });
    await dm.coordinator.handle(event('om_dm', '完成目标', { chatType: 'p2p', chatId: 'oc_dm', threadId: undefined }), dm.config);
    await dm.waitDelivered(1);
    expect(JSON.stringify([...dm.cards.values()])).not.toContain('<at');
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

describe('S3 未知命令近似建议只上卡面，原文不改写进入 Agent', () => {
  it('/mew 提示 /new，但 runtime.send 收到的仍是 /mew', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_typo', '/mew'), h.config);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalled());
    // 进 Agent 的是经统一包装的「非命令原文」材料：必须保留 /mew 原文，绝不改写成建议的 /new。
    const agentPrompt = String(h.send.mock.calls[0]![0]);
    expect(agentPrompt).toContain('/mew');
    expect(agentPrompt).toContain('不是 Dutydeck 命令');
    expect(agentPrompt).not.toMatch(/^\s*\/new\b/m);
    const card = h.service.reply.mock.calls.map(([input]) => input).find(input => input.taskId === 'om_typo')!;
    expect(card).toBeTruthy();
    expect(String(card.markdown)).toContain('你是不是想用');
    expect(String(card.markdown)).toContain('/new');
    expect(String(card.markdown)).toContain('原文仍会作为普通请求执行');
  });
});

describe('S6/S8/P0-7 帧注记纪律：只在非终态帧，终态帧与结果新消息一律不带', () => {
  it('P0-7 pty-cli 首卡与心跳标注终端模式，acp 全程不标注；终态不带', async () => {
    const pty = await harness('normal', { protocol: 'pty-cli', configPatch: { permissionMode: 'full-trust' } });
    await pty.coordinator.handle(ptyEvent('om_pty', '跑一下'), pty.config);
    await pty.waitDelivered(1);
    // 首张卡随后会被同 messageId 的 running 帧 PATCH 覆盖（帧只有 elements），
    // 断言首卡 markdown 必须从 reply 调用入参取，不能读 cards Map 的最终值。
    const firstCard = pty.service.reply.mock.calls[0]![0];
    expect(String(firstCard.markdown)).toContain(TERMINAL_PROTOCOL_NOTE);
    await vi.waitFor(() => expect(cardUpdates(pty, input => Array.isArray(input.elements)
      && input.elements.some((element: any) => element.element_id === 'protocol_hint')).length).toBeGreaterThan(0));
    const terminalUpdates = cardUpdates(pty, input => ['completed', 'failed', 'interrupted'].includes(input.state));
    expect(terminalUpdates.some(input => JSON.stringify(input).includes('protocol_hint'))).toBe(false);
    expect(JSON.stringify([...pty.cards.values()].filter(card => card.state === 'completed' && card.readOnly))).not.toContain(TERMINAL_PROTOCOL_NOTE);

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
    // 心跳间隔 1s：再等两拍确保含摘要的帧已完成 PATCH 与 saveCardTask（修复前此时期望必含摘要）。
    await new Promise(resolve => setTimeout(resolve, 2_200));
    const [mappingA] = (await h.repos.channelMappings.list(h.channel)).filter(item => item.externalId === 'om_a');
    const frozenElements = JSON.parse(mappingA!.extra!).last_successful_elements as any[];
    expect(Array.isArray(frozenElements)).toBe(true);
    expect(frozenElements.length).toBeGreaterThan(0);
    expect(frozenElements.some(element => element.element_id === 'queue_summary')).toBe(false);

    // 模拟守护进程重启：新 coordinator 尚未 adopt 任务时首轮对账先跑（reconciler.ts 的冻结元素重放路径）。
    h.coordinator.stop();
    const restored = h.createCoordinator();
    try {
      const before = h.service.update.mock.calls.length;
      await restored.reconcile(h.config);
      const replayed = h.service.update.mock.calls.slice(before).map(([input]) => input)
        .filter(input => Array.isArray(input.elements));
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed.some(input => JSON.stringify(input).includes('queue_summary'))).toBe(false);
    } finally { restored.stop(); }
  });
});
