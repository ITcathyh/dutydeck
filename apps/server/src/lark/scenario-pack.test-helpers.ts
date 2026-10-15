// 告警场景的隔离组装：真实 DutydeckRuntime + SQLite + LarkMessageCoordinator + LarkGroupParticipation + LarkGroupManager，
// 飞书 service 是内存实现（记录全部调用、维护消息与话题），Agent 是 mock driver。
// 不依赖 vitest：告警集成测试（scenario-pack.integration.test.ts）和仓库外的隔离回放脚本（场景包设计 9.2）共用这一份组装。
// 不连飞书，不启动 daemon；数据库在临时目录，close() 删除。
// P3：关联行取卡片映射里存好的 scenario_recall.line（旧映射的 alert_recall 由 scenario-legacy.ts 按旧格式画出）。

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver, type RuntimeOptions } from '@dutydeck/runtime';
import { RelayAskBroker } from '@dutydeck/relay';
import { scenarioRecordOf, type AgentConfig, type CollaborationAction, type CollaborationSnapshot, type CollaborationDecision, type CollaborationDuty, type CollaborationParticipationMode, type CollaborationScope } from '@dutydeck/shared';
import { createRelayAskStore } from '../relay-ask-store.js';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { larkCardChannel } from './coordinator-core.js';
import { LarkGroupManager } from './group-management.js';
import { LarkGroupParticipation } from './group-participation.js';
import { larkBotsConfigKey, readLarkConfig, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard, type LarkChatMessage } from './service.js';
import type { ParticipationDecider } from './readonly-decider.js';
import type { ScenarioRegistry } from '../plugins/scenario-registry.js';
import { persistedRecallLine } from './scenario-legacy.js';
import { builtinScenarioRegistry } from '../plugins/builtin-scenarios.test-helpers.js';
import { LarkTaskInbox, type LarkInboxRecord } from './task-inbox.js';

export const SCENARIO_BOT = { appId: 'cli_scenario_bot', openId: 'ou_scenario_bot', name: 'Dock' } as const;
export const SCENARIO_CHAT = 'oc_scenario_group';
export const SCENARIO_REQUESTER = 'ou_scenario_requester';
export const SCENARIO_MEMBER = 'ou_scenario_member';

export interface ScenarioSource { appId: string; openId: string; name: string }
/** 告警订阅：P3 起是告警包（alarm）的绑定参数加确认人。 */
export interface AlarmSubscriptionInput { enabled?: boolean; sources: Array<{ appId: string; name?: string }>; levels?: string[]; dedupeHours?: number; maxPerHour?: number; requesterId?: string }
export interface ScenarioCall { method: string; input: unknown }

export interface AlarmHarnessOptions {
  /** 本群参与模式；off 配合 mentionPolicy always 就是「只在 @ 时」档。 */
  participation?: CollaborationParticipationMode;
  mentionPolicy?: StoredLarkConfig['mentionPolicy'];
  /** 群里的机器人（除本机器人外），群成员接口按它返回。 */
  bots?: Array<{ appId: string; name: string }>;
  /** 判定和确认卡用的时钟；不给就用真实时间。 */
  now?: () => Date;
  /** Agent 对一轮 prompt 的回答（结果卡的 final_output）。 */
  answer?: (prompt: string) => string;
  configPatch?: Partial<StoredLarkConfig>;
  /** 用这个目录放数据库并在 close() 时保留（旧库构造和重开用）；不给就用临时目录，close() 删除。 */
  directory?: string;
  /** 加载的场景包；不给就只有内置包。 */
  scenarios?: ScenarioRegistry;
  /** 参与判定的模型桩；不给就恒为 silent。 */
  decide?: ParticipationDecider['decide'];
  /** 回复生成的桩；不给就返回空串。 */
  respond?: ParticipationDecider['respond'];
  /** 接到 runtime 的宿主入口（插件 hook 的接线同 service.ts）。 */
  runtimeOptions?: Pick<RuntimeOptions, 'prepareTaskPrompt' | 'reviewPermission'>;
  /** 对这一轮 prompt 先发一个待审批的权限请求（不等审批结果就作答）。 */
  permissionRequest?: (prompt: string) => { id: string; title: string } | undefined;
  /** 本机器人所在的其他群（同样登记、同样的参与模式），消息用 chatId 指定。 */
  extraChats?: string[];
}

const defaultAnswer = () => '**判断**：待确认，样例数据不足以判断。\n\n证据：没查到。';

export async function createAlarmHarness(options: AlarmHarnessOptions = {}) {
  const cwd = options.directory ?? await mkdtemp(join(tmpdir(), 'dutydeck-scenario-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const scope: CollaborationScope = { appId: SCENARIO_BOT.appId, chatId: SCENARIO_CHAT };
  const calls: ScenarioCall[] = [];
  const prompts: string[] = [];
  const dispatched: LarkMessageEvent[] = [];
  const authorizations: Array<{ actor?: string; action: string; memberObserved?: boolean }> = [];
  const decideCalls: string[] = [];
  /** 每次模型判定拿到的快照。 */
  const decideSnapshots: CollaborationSnapshot[] = [];
  /** 每次派发时这条告警判定记录的状态（派发前应为 candidate）。 */
  const statusAtDispatch: string[] = [];
  /** driver 收到的审批结果：宿主代为决定或有人审批时才有。 */
  const permissionResolutions: Array<{ id: string; approved: boolean }> = [];
  let dispatchFailure: string | undefined;
  const answer = options.answer ?? defaultAnswer;

  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => {
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isStopped: async () => true,
        send: async (prompt: unknown) => {
          const text = typeof prompt === 'string' ? prompt : String((prompt as { prompt?: string }).prompt ?? '');
          prompts.push(text);
          const permission = options.permissionRequest?.(text);
          if (permission) emit({ type: 'permission_request', data: { ...permission, status: 'pending' } });
          emit({ type: 'text', data: { text: answer(text) } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        },
        resolvePermission: async (id: string, approved: boolean) => { permissionResolutions.push({ id, approved }); return true; }
      };
      return driver;
    },
    ...options.runtimeOptions
  });
  const broker = new RelayAskBroker({ publish: async () => {} }, createRelayAskStore(repos.config));
  await broker.initialize();
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10,
    capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);

  const config: StoredLarkConfig = { appId: SCENARIO_BOT.appId, appSecret: 'synthetic', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false,
    pushIntervalMs: 1_000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [],
    highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off', memoryEnabled: false, urgentEnabled: false,
    pinLongTasks: false, completionReactionOnly: false, silentProgress: false,
    mentionPolicy: options.mentionPolicy ?? (options.participation === 'off' ? 'always' : 'topic'), ...options.configPatch };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  // 内存版飞书：消息、话题、卡片都存在这里，调用按顺序记进 calls。
  const messages = new Map<string, LarkChatMessage>();
  const idempotent = new Map<string, string>();
  let sequence = 0;
  let clockMs = Date.parse('2026-10-15T00:00:00.000Z');
  const nextTime = () => String(clockMs += 1_000);
  const store = (message: LarkChatMessage) => { messages.set(message.messageId, message); return message; };
  const botSender = { id: SCENARIO_BOT.appId, idType: 'app_id', type: 'app' };
  const replyTo = (target: string, replyInThread: boolean | undefined, rawContent: string, messageType: string, key?: string) => {
    if (key && idempotent.has(key)) return { messageId: idempotent.get(key)! };
    const parent = messages.get(target);
    const messageId = `om_reply_${++sequence}`;
    let threadId = parent?.threadId;
    if (replyInThread && parent && !threadId) { threadId = `omt_${target}`; parent.threadId = threadId; parent.rootId ??= target; }
    store({ messageId, chatId: parent?.chatId ?? SCENARIO_CHAT, messageType, createTime: nextTime(), sender: botSender, rawContent, mentions: [], deleted: false, updated: false,
      parentId: target, rootId: parent?.rootId ?? target, ...(threadId ? { threadId } : {}) });
    if (key) idempotent.set(key, messageId);
    return { messageId };
  };
  const cardContent = (input: unknown) => JSON.stringify({ card: input });
  const record = (method: string, input: unknown) => { calls.push({ method, input }); };
  const failingThreads = new Set<string>();
  const chats = [SCENARIO_CHAT, ...options.extraChats ?? []];
  const members = () => [
    { memberId: SCENARIO_REQUESTER, openId: SCENARIO_REQUESTER, name: '确认人', memberType: 'user' as const },
    { memberId: SCENARIO_MEMBER, openId: SCENARIO_MEMBER, name: '成员', memberType: 'user' as const },
    ...(options.bots ?? []).map(bot => ({ memberId: bot.appId, name: bot.name, appId: bot.appId, memberType: 'bot' as const })),
    { memberId: SCENARIO_BOT.appId, name: SCENARIO_BOT.name, appId: SCENARIO_BOT.appId, memberType: 'bot' as const }
  ];
  const service = {
    replyText: async (input: { messageId: string; replyInThread?: boolean; text: string; idempotencyKey?: string }) => {
      record('replyText', input);
      return replyTo(input.messageId, input.replyInThread, JSON.stringify({ text: input.text }), 'text', input.idempotencyKey);
    },
    sendText: async (input: { chatId: string; text: string; idempotencyKey?: string }) => {
      record('sendText', input);
      if (input.idempotencyKey && idempotent.has(input.idempotencyKey)) return { messageId: idempotent.get(input.idempotencyKey)! };
      const messageId = `om_send_${++sequence}`;
      store({ messageId, chatId: input.chatId, messageType: 'text', createTime: nextTime(), sender: botSender, rawContent: JSON.stringify({ text: input.text }), mentions: [], deleted: false, updated: false });
      if (input.idempotencyKey) idempotent.set(input.idempotencyKey, messageId);
      return { messageId };
    },
    reply: async (input: { messageId: string; replyInThread?: boolean; idempotencyKey?: string }) => {
      record('reply', input);
      const result = replyTo(input.messageId, input.replyInThread, cardContent(input), 'interactive', input.idempotencyKey);
      return { messageId: result.messageId };
    },
    send: async (input: { chatId: string; idempotencyKey?: string }) => {
      record('send', input);
      const messageId = `om_card_${++sequence}`;
      store({ messageId, chatId: input.chatId, messageType: 'interactive', createTime: nextTime(), sender: botSender, rawContent: cardContent(input), mentions: [], deleted: false, updated: false });
      return { messageId };
    },
    update: async (input: { messageId: string }) => { record('update', input); return { messageId: input.messageId }; },
    addReaction: async (messageId: string, emojiType = 'OK') => { record('addReaction', { messageId, emojiType }); return { messageId, reactionId: `reaction_${messageId}_${emojiType}` }; },
    deleteReaction: async (messageId: string, reactionId: string) => { record('deleteReaction', { messageId, reactionId }); },
    listOwnReactions: async () => [] as Array<{ messageId: string; reactionId: string; emojiType: string }>,
    getMessage: async (messageId: string) => {
      const message = messages.get(messageId);
      if (!message) throw Object.assign(new Error(`Message ${messageId} not found`), { code: 'LARK_MESSAGE_NOT_FOUND', status: 404 });
      return { ...message };
    },
    getMessageItems: async (messageId: string) => { const message = messages.get(messageId); return message ? [{ ...message }] : []; },
    listChatMessages: async (input: { chatId?: string; threadId?: string; order?: 'asc' | 'desc'; pageSize?: number }) => {
      if (input.threadId && failingThreads.has(input.threadId)) throw Object.assign(new Error('读取话题消息失败（场景注入）'), { code: 'LARK_RATE_LIMITED', status: 429 });
      const items = [...messages.values()].filter(item => input.threadId ? item.threadId === input.threadId : item.chatId === (input.chatId ?? SCENARIO_CHAT))
        .sort((a, b) => Number(a.createTime) - Number(b.createTime));
      if (input.order === 'desc') items.reverse();
      return { items: items.slice(0, input.pageSize ?? 50).map(item => ({ ...item })), hasMore: false };
    },
    listChatMembers: async () => ({ items: members(), hasMore: false, securityLimited: false }),
    getUserEmails: async () => [] as string[],
    uploadFile: async () => 'file_scenario',
    replyFile: async (input: { messageId: string }) => replyTo(input.messageId, false, '{}', 'file'),
    sendFile: async () => ({ messageId: `om_file_${++sequence}` }),
    downloadMessageResource: async () => ({ data: new Uint8Array(), contentType: 'text/plain' }),
    readDocument: async (url: string) => ({ url, title: '文档', text: '文档正文' })
  };

  const groupManager = new LarkGroupManager(repos, { client: () => ({
    getBotInfo: async () => ({ appName: SCENARIO_BOT.name, openId: SCENARIO_BOT.openId }),
    checkApplicationIdentity: async () => ({ verified: true, reportedAppId: SCENARIO_BOT.appId, tenantKey: 'synthetic-tenant' }),
    listChats: async () => ({ items: chats.map((chatId, index) => ({ chatId, name: index ? `场景群 ${index + 1}` : '告警场景群', chatMode: 'group' })), hasMore: false }),
    listChatMembers: async () => ({ items: members().filter(item => item.memberType === 'user'), hasMore: false, securityLimited: false }),
    getUserEmails: async () => []
  }) as any });
  await groupManager.sync(SCENARIO_BOT.appId);
  // 重开已有的库时群已经登记过，再登记会因版本号冲突失败，忽略即可。
  for (const chatId of chats) await groupManager.save(SCENARIO_BOT.appId, chatId, { expectedRevision: 0, patch: {} }).catch(error => { if (!options.directory) throw error; });
  // 记录授权身份：告警初筛按确认人重新鉴权（memberObserved=false）。
  const authorize = groupManager.authorize.bind(groupManager);
  groupManager.authorize = (async (...args: Parameters<typeof authorize>) => {
    authorizations.push({ actor: args[2], action: String(args[3]), memberObserved: (args[5] as { memberObserved?: boolean } | undefined)?.memberObserved });
    return authorize(...args);
  }) as typeof groupManager.authorize;

  const participation = new LarkGroupParticipation({
    repository: repos.collaboration,
    decider: {
      decide: async (config, snapshot, triggerId, facts) => {
        decideCalls.push(String(triggerId ?? snapshot.observations.at(-1)?.id ?? ''));
        decideSnapshots.push(structuredClone(snapshot));
        return options.decide ? options.decide(config, snapshot, triggerId, facts) : { action: 'silent', reason: '桩：不接', evidenceIds: [], updates: [] };
      },
      respond: options.respond ?? (async () => '')
    },
    authorize: async () => true,
    canOperate: async () => true,
    readConfig: appId => readLarkConfig(repos.config, appId),
    serviceFor: () => service as any,
    listScopes: async () => chats.map(chatId => ({ appId: SCENARIO_BOT.appId, chatId })),
    readGroupDescription: async () => '告警场景群',
    scenarios: options.scenarios ?? await builtinScenarioRegistry(),
    debounceMs: 10,
    ...(options.now ? { now: options.now } : {})
  });
  for (const chatId of chats) {
    const chatScope = { appId: SCENARIO_BOT.appId, chatId };
    const settings = await repos.collaboration.getSettings(chatScope);
    if (options.participation && settings.participation !== options.participation) await repos.collaboration.updateSettings(chatScope, { expectedRevision: settings.revision, participation: options.participation }, 'owner');
  }

  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, SCENARIO_BOT.openId, undefined, repos.channelMappings,
    async () => 'group', undefined, groupManager, { store: repos.config, broker, participation });
  await coordinator.initializeWorkflows(config);
  // 与 listener.ts 的接线相同，另外记下派发事件和派发时判定记录的状态；failNextDispatch() 让下一次派发抛错。
  participation.setDispatcher(config.appId, async (event, current) => {
    statusAtDispatch.push((await harness.alarmDecisionFor(event.messageId))?.status ?? 'none');
    if (dispatchFailure) { const message = dispatchFailure; dispatchFailure = undefined; throw new Error(message); }
    dispatched.push(structuredClone(event));
    return coordinator.adopt(event, current);
  });

  const inbox = new LarkTaskInbox(repos.config);
  const harness = {
    cwd, repos, runtime, coordinator, participation, groupManager, config, scope, service, messages,
    calls, prompts, dispatched, authorizations, decideCalls, decideSnapshots, statusAtDispatch, permissionResolutions,
    failNextDispatch(message = '派发失败（场景注入）') { dispatchFailure = message; },
    /** 之后读这个话题的消息都失败。 */
    failThreadReads(threadId: string) { failingThreads.add(threadId); },
    async subscribe(alarm: AlarmSubscriptionInput) {
      const duty = await repos.collaboration.getDuty(scope);
      const value = { enabled: true, levels: [], dedupeHours: 6, maxPerHour: 3, requesterId: SCENARIO_REQUESTER, ...alarm };
      await repos.collaboration.updateDuty(scope, { expectedRevision: duty.revision, scenarios: { alarm: { enabled: value.enabled,
        params: { sources: value.sources, levels: value.levels, dedupeHours: value.dedupeHours, maxPerHour: value.maxPerHour }, requesterId: value.requesterId, packVersion: '1.0.0' } } }, SCENARIO_REQUESTER);
    },
    async setResponder(responder: 'self' | { appId: string; name: string } | null) {
      const duty = await repos.collaboration.getDuty(scope);
      const value = responder === 'self' ? { appId: SCENARIO_BOT.appId, name: SCENARIO_BOT.name, since: new Date(0).toISOString() }
        : responder ? { ...responder, since: new Date(0).toISOString() } : null;
      await repos.collaboration.updateDuty(scope, { expectedRevision: duty.revision, responder: value }, 'owner');
    },
    /** 来源机器人发的一条消息：存进内存飞书（消息详情按 app_id 报发送者），返回实时事件（只带 open_id）。 */
    fromBot(source: Pick<ScenarioSource, 'appId' | 'openId'>, input: { messageId: string; content: string; messageType?: string; threadId?: string; rootId?: string; createTime?: string; chatId?: string }): LarkMessageEvent {
      const createTime = input.createTime ?? nextTime();
      const chatId = input.chatId ?? SCENARIO_CHAT;
      store({ messageId: input.messageId, chatId, messageType: input.messageType ?? 'text', createTime, sender: { id: source.appId, idType: 'app_id', type: 'app' },
        rawContent: input.content, mentions: [], deleted: false, updated: false, ...(input.threadId ? { threadId: input.threadId, rootId: input.rootId ?? input.messageId } : {}) });
      return { messageId: input.messageId, chatId, chatType: 'group', messageType: input.messageType ?? 'text', content: input.content, createTime,
        senderOpenId: source.openId, senderType: 'app', mentions: [], ...(input.threadId ? { threadId: input.threadId, rootId: input.rootId ?? input.messageId } : {}) };
    },
    /** 真人发的一条消息；mentionBot 时 @ 本机器人，parentId 是引用回复的消息，inThread 时在它的话题里回复（没有话题就开一个）。 */
    fromUser(input: { messageId: string; text: string; sender?: string; mentionBot?: boolean; parentId?: string; inThread?: boolean; threadId?: string; rootId?: string; chatId?: string }): LarkMessageEvent {
      const chatId = input.chatId ?? SCENARIO_CHAT;
      const parent = input.parentId ? messages.get(input.parentId) : undefined;
      if (input.inThread && parent && !parent.threadId) { parent.threadId = `omt_${parent.messageId}`; parent.rootId ??= parent.messageId; }
      const threadId = input.threadId ?? parent?.threadId;
      const rootId = input.rootId ?? (threadId ? parent?.rootId ?? input.parentId : undefined);
      const text = input.mentionBot ? `@_user_1 ${input.text}` : input.text;
      const mentions = input.mentionBot ? [{ key: '@_user_1', name: SCENARIO_BOT.name, openId: SCENARIO_BOT.openId }] : [];
      const createTime = nextTime();
      store({ messageId: input.messageId, chatId, messageType: 'text', createTime, sender: { id: input.sender ?? SCENARIO_MEMBER, idType: 'open_id', type: 'user' },
        rawContent: JSON.stringify({ text }), mentions: input.mentionBot ? [{ key: '@_user_1', id: SCENARIO_BOT.appId, idType: 'app_id', name: SCENARIO_BOT.name }] : [],
        deleted: false, updated: false, ...(input.parentId ? { parentId: input.parentId } : {}), ...(threadId ? { threadId } : {}), ...(rootId ? { rootId } : {}) });
      return { messageId: input.messageId, chatId, chatType: 'group', messageType: 'text', content: JSON.stringify({ text }), createTime,
        senderOpenId: input.sender ?? SCENARIO_MEMBER, senderType: 'user', mentions,
        ...(input.parentId ? { parentId: input.parentId } : {}), ...(threadId ? { threadId } : {}), ...(rootId ? { rootId } : {}) };
    },
    /** 线上入口：listener 收到事件后调用 coordinator.receive（先落入站记录再路由）。 */
    receive(event: LarkMessageEvent) { return coordinator.receive(event, config); },
    inboxRecord(messageId: string): Promise<LarkInboxRecord | undefined> { return inbox.lookup(config.appId, messageId); },
    /** 某条来源消息的判定记录。记录多于一页时按记录 id 公式（第②类不变量）直接取。 */
    async alarmDecisionFor(messageId: string): Promise<AlarmDecisionView | undefined> {
      const listed = (await harness.alarmDecisions()).find(item => item.triggerMessageId === messageId);
      if (listed) return listed;
      const decision = await repos.collaboration.getDecision(scope, alarmDecisionId(scope, messageId));
      return decision && isAlarmDecision(decision) ? alarmDecisionView(decision) : undefined;
    },
    async duty(): Promise<DutyView> { return dutyView(await repos.collaboration.getDuty(scope)); },
    async alarmConfirms(): Promise<AlarmConfirmView[]> { return (await repos.collaboration.listActions(scope)).filter(isAlarmConfirm).map(alarmConfirmView); },
    async alarmDecisions(): Promise<AlarmDecisionView[]> {
      return [...await repos.collaboration.listDecisions(scope, 500)].filter(isAlarmDecision).map(alarmDecisionView)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },
    async mappings(): Promise<Array<{ externalId: string; sessionId: string; saved: PersistedLarkCardTask }>> {
      return (await repos.channelMappings.list(larkCardChannel(config.appId))).map(item => ({ externalId: item.externalId, sessionId: item.sessionId, saved: JSON.parse(item.extra ?? '{}') as PersistedLarkCardTask }));
    },
    /** 等这条消息处理完：入站记录离开 unrouted/received；起了任务的等结果卡送达。 */
    async settle(messageId: string, timeoutMs = 10_000) {
      await waitFor(async () => {
        const record = await inbox.lookup(config.appId, messageId);
        // receive() 返回前已经落了入站记录；没有记录说明这条没被接收（例如本机器人自己的消息），无需再等。
        if (!record) return true;
        if (record.state === 'unrouted' || record.state === 'received') return false;
        if (record.state !== 'accepted') return true;
        const mapping = (await harness.mappings()).find(item => item.externalId === messageId);
        return mapping?.saved.final_delivery_state === 'delivered';
      }, timeoutMs, `message ${messageId} did not settle`);
      for (const chatId of chats) await participation.flush({ appId: SCENARIO_BOT.appId, chatId });
    },
    async close() {
      coordinator.stop();
      await participation.close();
      broker.close();
      await broker.flush();
      await runtime.shutdown();
      repos.close();
      if (!options.directory) await rm(cwd, { recursive: true, force: true });
    }
  };
  return harness;
}
export type AlarmHarness = Awaited<ReturnType<typeof createAlarmHarness>>;

export async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 10_000, message = 'condition not met') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timeout: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// ---- 第②类公式：P3 不改 ----
// 记录 id 和 intro 幂等键必须逐字节不变（场景包设计 9.2 第②类），测试按这两个公式算期望值。

export const scenarioDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const alarmDecisionId = (scope: CollaborationScope, messageId: string) => `decision_alarm_${scenarioDigest([scope, messageId])}`;
export const alarmIntroKey = (scope: CollaborationScope, messageId: string) => `alarm_${scenarioDigest([scope, messageId])}`.slice(0, 50);

// ---- 第①类结构映射 ----
// 告警判定记录、派发事件、入站收养、订阅、确认单、卡片映射、执行 prompt 的结构在 P3 会改（alarm_triage → scenario 等，见场景包设计 9.2）。
// 集成测试和回放基线只比较下面这些视图；P3 改结构时只改这些投影函数，让新结构投影出同样的视图，断言和基线文件不动。
// 第③类有意变化只落在视图的这几个字段上：初筛指令的 lastLine、告警原文的 location、关联的 prompt 和 conclusionLocation；P3 为它们写新预期。

export interface AlarmDecisionView {
  id: string;
  action: string;
  status: string;
  reason: string;
  /** 旧名：triaged / level / duplicate / rate_limited / not_responder / no_requester。 */
  outcome: string;
  dedupeKey: string;
  sourceAppId: string;
  /** 旧值 alarm-triage；P3 起的 scenario:alarm@<版本> 映射回这里（P5 升到 1.1.0）。 */
  policyVersion: string;
  /** 旧值 alarm_<outcome>；P3 的 scenario_<新 outcome> 映射回这里。 */
  rule?: string;
  triggerMessageId?: string;
  createdAt: string;
}
/** P3 的结果名映射回旧名；window_incomplete、abstained 是新增的结果，原样保留。 */
const legacyOutcome = (outcome: string | undefined) => outcome === 'started' ? 'triaged' : outcome === 'filtered' ? 'level' : String(outcome);
export function alarmDecisionView(decision: CollaborationDecision): AlarmDecisionView {
  const scenario = scenarioRecordOf(decision);
  const snapshot = decision.inputSnapshot as { decider?: { rule?: string; trigger?: { messageId?: string } } };
  const rule = snapshot.decider?.rule?.startsWith('scenario_') ? `alarm_${legacyOutcome(snapshot.decider.rule.slice('scenario_'.length))}` : snapshot.decider?.rule;
  return { id: decision.id, action: decision.action, status: decision.status, reason: decision.reason, outcome: legacyOutcome(scenario?.outcome),
    dedupeKey: String(scenario?.dedupeKey), sourceAppId: String(scenario?.sourceAppId), policyVersion: decision.policyVersion.startsWith('scenario:alarm@') ? 'alarm-triage' : decision.policyVersion,
    ...(rule ? { rule } : {}),
    ...(snapshot.decider?.trigger?.messageId ? { triggerMessageId: snapshot.decider.trigger.messageId } : {}), createdAt: decision.createdAt };
}
/** 告警判定记录：P3 起是 gate 为 scenario、packId 为 alarm 的场景记录（旧库的 alarm_triage 记录读出时已映射成这样）。 */
export const isAlarmDecision = (decision: CollaborationDecision) => scenarioRecordOf(decision)?.packId === 'alarm';

/** 初筛指令按行拆开；最后一行（现在是「[告警原文]」）是第③类会改的部分。 */
export interface AlarmInstructionView { lines: string[]; lastLine: string }
const instructionView = (text: string): AlarmInstructionView => { const lines = text.split('\n'); return { lines: lines.slice(0, -1), lastLine: lines.at(-1)! }; };

export interface AlarmDispatchView { messageId: string; rootId?: string; threadId?: string; parentId?: string; senderOpenId?: string; senderType?: string; instruction?: AlarmInstructionView }
/** 派发事件：P3 起初筛指令在 event.scenario.instruction（旧入站记录是 event.triage）。 */
export function alarmDispatchView(event: LarkMessageEvent): AlarmDispatchView {
  return { messageId: event.messageId, ...(event.rootId ? { rootId: event.rootId } : {}), ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.parentId ? { parentId: event.parentId } : {}), ...(event.senderOpenId ? { senderOpenId: event.senderOpenId } : {}),
    ...(event.senderType ? { senderType: event.senderType } : {}), ...(instructionOf(event) ? { instruction: instructionView(instructionOf(event)!) } : {}) };
}

const instructionOf = (event: LarkMessageEvent) => event.scenario && 'instruction' in event.scenario ? event.scenario.instruction : event.triage;
/** 入站记录里的收养信息：P3 起是 event.scenario（旧记录是 event.triage）加确认人身份。 */
export interface InboxAdoptionView { state: string; senderOpenId?: string; senderType?: string; rootId?: string; threadId?: string; adopted: boolean }
export function inboxAdoptionView(record: LarkInboxRecord): InboxAdoptionView {
  const event = record.event;
  return { state: record.state, ...(event.senderOpenId ? { senderOpenId: event.senderOpenId } : {}), ...(event.senderType ? { senderType: event.senderType } : {}),
    ...(event.rootId ? { rootId: event.rootId } : {}), ...(event.threadId ? { threadId: event.threadId } : {}), adopted: Boolean(event.scenario ?? event.triage) };
}

/** 本群分工：P3 起订阅是 duty.scenarios.alarm 绑定。 */
export interface DutyView {
  alarm: { enabled: boolean; sources: Array<{ appId: string; name?: string }>; levels: string[]; dedupeHours: number; maxPerHour: number; requesterId?: string } | null;
  responder: { appId: string; name?: string } | null;
}
export function dutyView(duty: CollaborationDuty): DutyView {
  const alarm = duty.scenarios?.alarm;
  const params = alarm?.params as { sources: Array<{ appId: string; name?: string }>; levels: string[]; dedupeHours: number; maxPerHour: number } | undefined;
  return {
    alarm: alarm && params ? { enabled: alarm.enabled, sources: params.sources.map(item => ({ appId: item.appId, ...(item.name ? { name: item.name } : {}) })), levels: [...params.levels],
      dedupeHours: params.dedupeHours, maxPerHour: params.maxPerHour, ...(alarm.requesterId ? { requesterId: alarm.requesterId } : {}) } : null,
    responder: duty.responder ? { appId: duty.responder.appId, ...(duty.responder.name ? { name: duty.responder.name } : {}) } : null
  };
}

/** 告警开关确认单：P3 起 kind 是 confirm.scenario:alarm，payload.payload.params 是参数的 JSON；旧单是 confirm.alarm_subscription，sources、levels 是 JSON 字符串。 */
export interface AlarmConfirmView {
  id: string; status: string; requesterId: string; replyToMessageId?: string; cardMessageId?: string; title: string; summary: string; enabled: boolean;
  subscription?: { sources: Array<{ appId: string; name?: string }>; levels: string[]; dedupeHours: number; maxPerHour: number };
}
export const isAlarmConfirm = (action: CollaborationAction) => action.kind === 'confirm.scenario:alarm' || action.kind === 'confirm.alarm_subscription';
export function alarmConfirmView(action: CollaborationAction): AlarmConfirmView {
  const payload = action.payload as { title?: string; summary?: string; replyTo?: { messageId?: string }; payload?: Record<string, string | number | boolean> };
  const value = payload.payload ?? {};
  const params = (value.params === undefined ? { sources: JSON.parse(String(value.sources ?? '[]')), levels: JSON.parse(String(value.levels ?? '[]')), dedupeHours: value.dedupeHours, maxPerHour: value.maxPerHour }
    : JSON.parse(String(value.params))) as { sources: Array<{ appId: string; name?: string }>; levels: string[]; dedupeHours: number; maxPerHour: number };
  return { id: action.id, status: action.status, requesterId: action.requesterId, ...(payload.replyTo?.messageId ? { replyToMessageId: payload.replyTo.messageId } : {}),
    ...(action.receipt ? { cardMessageId: action.receipt } : {}), title: payload.title ?? '', summary: payload.summary ?? '', enabled: value.enabled === true,
    ...(value.enabled === true ? { subscription: { sources: params.sources, levels: params.levels, dedupeHours: Number(params.dedupeHours), maxPerHour: Number(params.maxPerHour) } } : {}) };
}

/** 发出或刷新的确认卡：标题、状态、正文（element_id confirm_body）和按钮文字。不是确认卡时返回 undefined。 */
export interface ConfirmCardView { title?: string; statusLabel?: string; state?: string; body: string; buttons: string[] }
export function confirmCardView(input: unknown): ConfirmCardView | undefined {
  type Element = { element_id?: string; content?: string; columns?: Array<{ elements?: Array<{ text?: { content?: string } }> }> };
  const card = input as { taskName?: string; statusLabel?: string; state?: string; elements?: Element[] };
  const body = card.elements?.find(element => element.element_id === 'confirm_body')?.content;
  if (body === undefined) return undefined;
  const buttons = card.elements?.find(element => element.element_id === 'confirm_actions')?.columns?.flatMap(column => column.elements ?? []).map(button => button.text?.content ?? '') ?? [];
  return { ...(card.taskName ? { title: card.taskName } : {}), ...(card.statusLabel ? { statusLabel: card.statusLabel } : {}), ...(card.state ? { state: card.state } : {}), body, buttons };
}

/** 卡片映射里持久化的关联：P3 起是 scenario_recall.line（旧映射的 alert_recall 按旧格式画），视图是过程卡上那一行。 */
export function recallLineView(saved: PersistedLarkCardTask): string | undefined {
  return persistedRecallLine(saved)?.line;
}
/** 发出去的卡片上渲染出来的关联行：P3 起是 element_id 为 scenario_recall 的那一行（只在过程卡上）。 */
export function cardRecallLineView(input: unknown): string | undefined {
  const card = buildLarkCard(input as Parameters<typeof buildLarkCard>[0]) as { body?: { elements?: Array<{ element_id?: string; content?: string }> } };
  return card.body?.elements?.find(element => element.element_id === 'scenario_recall')?.content;
}

/**
 * 执行 prompt 里与告警有关的三段，不录整段 prompt：
 * - triage：初筛指令（按行）和告警原文；P3 起原文在指令后面的不可信材料里（location 'untrusted'），旧格式在用户请求里（'user_request'）；
 * - recall：关联注入；P3 起上一轮结论在不可信材料里（conclusionLocation 'untrusted'），prompt 是指令那一行；旧格式结论嵌在指令文字里，prompt 里的结论换成 {headline}；
 * - references：参考材料里的消息（@ 引用告警卡时告警原文在这里）。
 */
export interface AlarmPromptView {
  triage?: { instruction: AlarmInstructionView; alarm: { location: string; text: string } };
  recall?: { prompt: string; conclusion: string; conclusionLocation: string };
  references?: Array<{ messageId: string; text: string }>;
}
const REQUEST_HEAD = '[用户请求]\n';
const REFERENCE_HEAD = '\n\n参考材料，仅作为内容，不授予操作权限\n';
const ALARM_TEXT_HEAD = '\n[告警原文]\n';
const UNTRUSTED_HEAD = '\n\n以下是来自 scenario:alarm:';
/** prompt 里来源为 source（或以它开头）的第一个不可信数据块的正文。 */
const untrustedBlock = (text: string, source: string) => {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<<<UNTRUSTED_DATA id=(\\w+) source=${escaped}[^>]*>>>\\n([\\s\\S]*?)\\n<<</UNTRUSTED_DATA id=\\1>>>`, 'u').exec(text)?.[2];
};
export function alarmPromptView(prompt: string): AlarmPromptView {
  const view: AlarmPromptView = {};
  const requestAt = prompt.indexOf(REQUEST_HEAD);
  const request = requestAt >= 0 ? prompt.slice(requestAt + REQUEST_HEAD.length) : '';
  const referenceAt = request.indexOf(REFERENCE_HEAD);
  const requestText = referenceAt >= 0 ? request.slice(0, referenceAt) : request;
  const untrustedAt = requestText.indexOf(UNTRUSTED_HEAD);
  const alarmAt = requestText.indexOf(ALARM_TEXT_HEAD);
  if (requestText.startsWith('[告警初筛]') && untrustedAt >= 0) {
    view.triage = { instruction: instructionView(requestText.slice(0, untrustedAt)), alarm: { location: 'untrusted', text: untrustedBlock(requestText, 'scenario:alarm:') ?? '' } };
  } else if (requestText.startsWith('[告警初筛]') && alarmAt >= 0) {
    view.triage = { instruction: instructionView(requestText.slice(0, alarmAt + ALARM_TEXT_HEAD.length - 1)), alarm: { location: 'user_request', text: requestText.slice(alarmAt + ALARM_TEXT_HEAD.length) } };
  }
  const legacyRecall = /\[Dutydeck 上次同一告警规则\] [^\n]*?在这个群查过同一条告警规则：(.*?)。先核对[^\n]*/u.exec(prompt);
  const recallLine = /\[Dutydeck 上次同一告警规则\] [^\n]*/u.exec(prompt)?.[0];
  if (legacyRecall) view.recall = { prompt: legacyRecall[0].replace(legacyRecall[1]!, '{headline}'), conclusion: legacyRecall[1]!, conclusionLocation: 'instruction' };
  else if (recallLine) view.recall = { prompt: recallLine, conclusion: untrustedBlock(prompt, 'dutydeck:previous-conclusion') ?? '', conclusionLocation: 'untrusted' };
  if (referenceAt >= 0) {
    view.references = [...request.slice(referenceAt + REFERENCE_HEAD.length).matchAll(/【消息 ([^】]+)】\n([\s\S]*?)(?=\n+【消息 |$)/gu)].map(match => ({ messageId: match[1]!, text: match[2]!.trimEnd() }));
  }
  return view;
}
