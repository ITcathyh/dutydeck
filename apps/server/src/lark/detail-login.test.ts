// 卡片「查看详情」在 Web 要求登录时的行为：渲染成回调按钮，点击后只给机器人管理员私信一次性登录链接。
//
// 协调器部分用真实 DutydeckRuntime + SQLite 卡片账本，飞书 service 为内存 mock，不触网、不发真实消息。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig, ChannelMapping, TaskRecord } from '@dutydeck/shared';
import { LoginLinkStore } from '../auth/auth.js';
import {
  buildLarkCardActions,
  buildLarkCardDetailButton,
  isLarkCardActionAvailable,
  parseLarkCardActionValue,
  type LarkCardActionContext,
  type LarkCardActionState,
  type LarkCardCapabilities
} from './card-actions.js';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { LarkGroupManager } from './group-management.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { performLarkCardReconcile } from './reconciler.js';
import { buildLarkCard, LarkServiceError } from './service.js';

const components = (value: any): any[] => {
  if (Array.isArray(value)) return value.flatMap(components);
  if (!value || typeof value !== 'object') return [];
  return [...(typeof value.tag === 'string' ? [value] : []), ...Object.values(value).flatMap(components)];
};
const detailButtons = (card: unknown) => components(card).filter(element => element.tag === 'button' && element.element_id === 'detail');
const callbackValue = (button: any) => button.behaviors.find((behavior: any) => behavior.type === 'callback').value;
const openUrls = (card: unknown) => components(card).flatMap(element => (element.behaviors ?? [])
  .filter((behavior: any) => behavior.type === 'open_url').map((behavior: any) => String(behavior.default_url)));

const allStates: LarkCardActionState[] = ['queued', 'running', 'interrupting', 'completed', 'failed', 'interrupted', 'cancelled', 'reconcile_required', 'legacy_unresolved'];
const webUrl = 'https://dock.example/sessions/ses_1';
const context = (state: LarkCardActionState, capabilities: Partial<LarkCardCapabilities>, overrides: Partial<LarkCardActionContext> = {}): LarkCardActionContext => ({
  state, taskId: 'om_task', turn: 2, ...overrides,
  capabilities: { canCancelQueued: true, canInterrupt: true, canRetry: true, canRefresh: true, ...capabilities }
});

describe('card-actions：detail', () => {
  it('未开启登录、没有深链或深链非法时不可用', () => {
    for (const state of allStates) {
      expect(isLarkCardActionAvailable('detail', context(state, { webUrl }))).toBe(false);
      expect(buildLarkCardDetailButton(context(state, { webUrl }))).toBeUndefined();
    }
    expect(buildLarkCardDetailButton(context('completed', { detailLogin: true }))).toBeUndefined();
    expect(buildLarkCardDetailButton(context('completed', { detailLogin: true, webUrl: 'javascript:alert(1)' }))).toBeUndefined();
  });

  it('开启登录后任何状态（含只读收据）都给回调按钮；按钮不带 URL，也不进操作区', () => {
    for (const state of allStates) {
      const ctx = context(state, { detailLogin: true, webUrl }, { readOnly: true });
      const button = buildLarkCardDetailButton(ctx)!;
      expect(button.text.content).toBe('查看详情');
      expect(callbackValue(button)).toEqual({ action: 'detail', task_id: 'om_task', turn: '2' });
      expect(JSON.stringify(button)).not.toContain('dock.example');
      const parsed = parseLarkCardActionValue(callbackValue(button))!;
      expect(isLarkCardActionAvailable(parsed.action, ctx)).toBe(true);
      expect(buildLarkCardActions(ctx).map(element => element.element_id)).not.toContain('detail');
    }
  });
});

describe('buildLarkCard：查看详情', () => {
  const base = { taskId: 'om_task', turn: 2, sessionId: 'ses_1', webBaseUrl: 'https://dock.example' };
  const loginCapabilities: LarkCardCapabilities = { canCancelQueued: false, canInterrupt: true, canRetry: true, canRefresh: false, webUrl, detailLogin: true };
  const cards = (capabilities?: LarkCardCapabilities) => [
    buildLarkCard({ ...base, cardKind: 'result', state: 'completed', readOnly: true, markdown: '已完成', ...(capabilities ? { capabilities } : {}) }),
    buildLarkCard({ ...base, cardKind: 'process', state: 'running', ...(capabilities ? { capabilities } : {}) }),
    buildLarkCard({ ...base, cardKind: 'process', state: 'failed', ...(capabilities ? { capabilities } : {}) }),
    buildLarkCard({ ...base, cardKind: 'process', state: 'completed', ...(capabilities ? { capabilities } : {}) })
  ];

  it('开启登录后结果卡与过程卡的「查看详情」都是回调按钮，整卡不出现会话深链', () => {
    for (const card of cards(loginCapabilities)) {
      const buttons = detailButtons(card);
      expect(buttons).toHaveLength(1);
      expect(callbackValue(buttons[0])).toEqual({ action: 'detail', task_id: 'om_task', turn: '2' });
      expect(JSON.stringify(card)).not.toContain('/sessions/ses_1');
    }
  });

  it('未开启登录时保持直接打开的链接', () => {
    const { detailLogin: _detailLogin, ...withoutLogin } = loginCapabilities;
    for (const card of [...cards(withoutLogin), ...cards()]) {
      expect(detailButtons(card)).toHaveLength(0);
      expect(JSON.stringify(card)).toContain('[查看详情](https://dock.example/sessions/ses_1)');
    }
  });

  it('不注入整张能力表的重绘（首帧、对账）只声明 detailLogin，也是回调按钮，其余按钮不变', () => {
    const buttonsOf = (card: unknown) => components(card).filter(element => element.tag === 'button' && element.element_id !== 'detail').map(element => element.element_id);
    const inputs = [
      { ...base, cardKind: 'process', state: 'queued', readOnly: true },
      { ...base, cardKind: 'process', state: 'queued' },
      { ...base, cardKind: 'process', state: 'running' },
      { ...base, cardKind: 'process', state: 'reconcile_required', capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false, canRelaunch: true } },
      { ...base, cardKind: 'process', state: 'completed', readOnly: true }
    ] as const;
    for (const input of inputs) {
      const withLogin = buildLarkCard({ ...input, detailLogin: true });
      const without = buildLarkCard(input);
      expect(callbackValue(detailButtons(withLogin)[0])).toEqual({ action: 'detail', task_id: 'om_task', turn: '2' });
      expect(JSON.stringify(withLogin)).not.toContain('/sessions/ses_1');
      expect(buttonsOf(withLogin)).toEqual(buttonsOf(without));
      expect(JSON.stringify(without)).toContain('[查看详情](https://dock.example/sessions/ses_1)');
    }
    // 没有会话的卡（请求未执行、Agent 启动失败等）拿不到绑定会话的登录链接，保持直链。
    const noSession = buildLarkCard({ taskId: 'om_task', webBaseUrl: 'https://dock.example', state: 'failed', readOnly: true, detailLogin: true });
    expect(detailButtons(noSession)).toHaveLength(0);
    expect(JSON.stringify(noSession)).toContain('[查看详情](https://dock.example/)');
  });

  it('超出飞书预算的硬兜底卡同样给回调按钮，不在提示里塞会话深链', () => {
    // 结果卡页脚里超长的 @、过程卡超长的失败步骤都收不进预算，只能落到硬兜底。
    const mention = [{ tag: 'markdown', element_id: 'group_mention', content: '<at id=ou_x></at>'.repeat(3000) }];
    const failureStep = [{ tag: 'markdown', element_id: 'failure_step', content: 'x'.repeat(40_000) }];
    const inputs = [
      { ...base, cardKind: 'result' as const, state: 'completed' as const, readOnly: true, elements: mention, capabilities: loginCapabilities },
      { ...base, cardKind: 'process' as const, state: 'failed' as const, elements: failureStep, detailLogin: true }
    ];
    for (const input of inputs) {
      const card = buildLarkCard(input);
      expect(components(card).some(element => element.element_id === 'dutydeck_hard_fallback_omission')).toBe(true);
      expect(callbackValue(detailButtons(card)[0])).toEqual({ action: 'detail', task_id: 'om_task', turn: '2' });
      expect(JSON.stringify(card)).not.toContain('/sessions/ses_1');
      const { detailLogin: _detailLogin, capabilities: _capabilities, ...withoutLogin } = input as typeof input & { detailLogin?: boolean; capabilities?: LarkCardCapabilities };
      expect(JSON.stringify(buildLarkCard(withoutLogin))).toContain('[查看详情](https://dock.example/sessions/ses_1)');
    }
  });
});

describe('对账重绘：查看详情', () => {
  const reconcileConfig = { appId: 'cli_detail', appSecret: 'fake-secret', workspace: '/workspace', defaultAgentId: 'mock', fullTrustConfirmed: true, listening: true,
    webBaseUrl: 'https://dock.example', preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off' } as StoredLarkConfig;
  const reconcileOnce = async (detailLogin: boolean, saved: Partial<PersistedLarkCardTask>, status?: string, rejectFirst = false) => {
    const now = new Date().toISOString();
    const persisted: PersistedLarkCardTask = { app_id: 'cli_detail', chat_id: 'oc_group', card_message_id: 'om_card', runtime_task_id: 'task_1',
      task_name: '检查构建', prompt: '检查构建', started_at: Date.now() - 5_000, turn: 1, state: 'running', ...saved };
    const rows: ChannelMapping[] = [{ id: 'lark-card:cli_detail:om_task', channel: 'lark-card:cli_detail', externalId: 'om_task', sessionId: 'ses_1', createdAt: now, extra: JSON.stringify(persisted) }];
    const cardMappings = {
      list: async () => rows.map(row => ({ ...row })),
      get: async (_channel: string, externalId: string) => rows.find(row => row.externalId === externalId),
      save: async () => {},
      compareAndSetExtra: async (id: string, expected: string | null | undefined, extra: string) => {
        const row = rows.find(item => item.id === id);
        if (!row || (row.extra ?? null) !== (expected ?? null)) return false;
        row.extra = extra;
        return true;
      }
    };
    const task = status ? { id: 'task_1', sessionId: 'ses_1', prompt: '检查构建', status, createdAt: now, updatedAt: now } as unknown as TaskRecord : undefined;
    const runtime = {
      getTasks: async () => task ? [task] : [],
      getEvents: async () => [{ id: 'evt_1', sessionId: 'ses_1', sequence: 1, type: 'text', timestamp: now, data: { text: '工作已完成', taskId: 'task_1' } }],
      getTaskRecovery: async () => ({ status, blockers: [{ code: 'DRIVER_RESOURCE_UNSAFE' }] })
    };
    const service = {
      update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
      reply: vi.fn(async () => ({ messageId: 'om_result' })), send: vi.fn(async () => ({ messageId: 'om_result' }))
    };
    if (rejectFirst) service.update.mockRejectedValueOnce(new LarkServiceError('LARK_OPENAPI_ERROR', 'rejected', 400, { upstreamCode: 230028 }));
    await performLarkCardReconcile({ runtime: runtime as any, service: service as any, cardMappings: cardMappings as any,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, config: reconcileConfig, channel: 'lark-card:cli_detail', ...(detailLogin ? { detailLogin: true } : {}) });
    const processUpdates = service.update.mock.calls.map(([input]) => input).filter(input => input.cardKind === 'process' && input.messageId === 'om_card');
    expect(processUpdates).toHaveLength(rejectFirst ? 2 : 1);
    return processUpdates.at(-1);
  };
  // 过程卡的四条重绘：结果已交付后冻结回执、排队受阻/需要核对、终态收敛、内容被拒后原地修补。
  const scenarios: Array<[string, Partial<PersistedLarkCardTask>, string | undefined, boolean]> = [
    ['结果已交付后冻结过程回执', { state: 'completed', final_delivery_state: 'delivered', final_message_id: 'om_final' }, undefined, false],
    ['需要核对的卡', {}, 'reconcile_required', false],
    ['排队受阻的卡', {}, 'queued', false],
    ['终态收敛', {}, 'completed', false],
    ['内容被拒后原地修补', { last_successful_elements: [{ tag: 'markdown', element_id: 'previous', content: '上次成功的内容' }] }, 'completed', true]
  ];

  it.each(scenarios)('%s：Web 要求登录时页脚是回调按钮，否则仍是直链', async (_name, saved, status, rejectFirst) => {
    const card = buildLarkCard(await reconcileOnce(true, saved, status, rejectFirst));
    expect(callbackValue(detailButtons(card)[0])).toEqual({ action: 'detail', task_id: 'om_task', turn: '1' });
    expect(JSON.stringify(card)).not.toContain('/sessions/ses_1');
    const without = buildLarkCard(await reconcileOnce(false, saved, status, rejectFirst));
    expect(detailButtons(without)).toHaveLength(0);
    expect(JSON.stringify(without)).toContain('[查看详情](https://dock.example/sessions/ses_1)');
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text',
  content: JSON.stringify({ text }), mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }]
});
const principalId = (appId: string, openId: string) => `principal_${createHash('sha256').update(`${appId}\0${openId}`).digest('hex')}`;

async function harness(options: { loginLinks?: boolean; managedGroup?: boolean; allowedUsers?: StoredLarkConfig['allowedUsers']; failFirst?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-detail-login-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let sends = 0;
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => {
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
        send: async () => {
          // 收尾活动不是文本时 Runtime 判为失败，失败卡上才有「重试」。
          if (options.failFirst && sends++ === 0) emit({ type: 'tool_call', data: { id: 'tool_1', name: 'Bash', input: {}, status: 'running' } });
          else emit({ type: 'text', data: { text: '工作已完成' } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      };
      return driver;
    }
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_detail', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
    webBaseUrl: 'https://dock.example', fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false,
    pushIntervalMs: 1000, hideTraceOnComplete: false, compactTrace: false, completionReactionOnly: false, silentProgress: false,
    allowedUsers: options.allowedUsers ?? [{ openId: 'ou_alice', name: 'Alice' }], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' } as StoredLarkConfig;
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const members = async () => ({ items: [{ memberId: 'ou_alice', openId: 'ou_alice', name: 'Alice', memberType: 'user' }, { memberId: 'ou_bob', openId: 'ou_bob', name: 'Bob', memberType: 'user' }], hasMore: false, securityLimited: false });
  let groupManager: LarkGroupManager | undefined;
  if (options.managedGroup) {
    groupManager = new LarkGroupManager(repos, { client: () => ({
      getBotInfo: async () => ({ appName: config.appId, openId: 'ou_bot' }),
      checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'synthetic-tenant' }),
      listChats: async () => ({ items: [{ chatId: 'oc_group', name: '详情群', chatMode: 'group' }], hasMore: false }),
      listChatMembers: members, getUserEmails: async () => []
    }) as any });
    await groupManager.sync(config.appId);
    await groupManager.save(config.appId, 'oc_group', { expectedRevision: 0, patch: {} });
  }
  let nextCard = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextCard}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string) => ({ reactionId: `reaction_${messageId}` })), deleteReaction: vi.fn(async () => {}),
    getUserEmails: vi.fn(async () => []), listChatMembers: vi.fn(members), listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessageItems: vi.fn(async () => [])
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const links = new LoginLinkStore();
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, groupManager,
    { store: repos.config, ...(options.loginLinks === false ? {} : { loginLinks: links }) });
  const coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  const saved = async () => {
    const [mapping] = await repos.channelMappings.list(`lark-card:${config.appId}`);
    return { sessionId: mapping!.sessionId, extra: JSON.parse(mapping!.extra!) as PersistedLarkCardTask };
  };
  const runTask = async () => {
    await coordinator.handle(event('om_task', '检查构建'), config);
    await vi.waitFor(async () => expect((await saved()).extra.final_delivery_state).toBe('delivered'), { timeout: 10_000 });
    return saved();
  };
  // 群里的消息都走 reply（回复触发消息）或带 chatId 的 send；私信是带 receiveId 的 send。
  const groupMessages = () => service.reply.mock.calls.length + service.update.mock.calls.length
    + service.send.mock.calls.filter(([input]: any[]) => input.chatId).length;
  const privateMessages = () => service.send.mock.calls.map(([input]: any[]) => input).filter(input => input.receiveId);
  return { repos, config, service, log, links, cards, coordinator, createCoordinator, groupManager, saved, runTask, groupMessages, privateMessages };
}

describe('coordinator：查看详情私信一次性登录链接', () => {
  it('管理员点击后只收到私信；链接绑定会话、只能兑换一次，且不进日志', async () => {
    const h = await harness();
    const { sessionId, extra } = await h.runTask();
    const resultCard = buildLarkCard(h.cards.get(extra.final_message_id!));
    const [button] = detailButtons(resultCard);
    expect(button, '结果卡的「查看详情」应为回调按钮').toBeDefined();
    expect(JSON.stringify(resultCard)).not.toContain(`/sessions/${sessionId}`);
    const groupBefore = h.groupMessages();

    const result = await h.coordinator.handleAction(callbackValue(button), 'ou_alice', { messageId: extra.final_message_id, chatId: 'oc_group' });
    expect(result).toEqual({ type: 'success', content: '已私信你一个 10 分钟内有效的登录链接' });
    expect(h.groupMessages()).toBe(groupBefore);
    const [dm, ...extraDms] = h.privateMessages();
    expect(extraDms).toHaveLength(0);
    expect(dm).toMatchObject({ receiveId: 'ou_alice', receiveIdType: 'open_id' });
    expect(dm.chatId).toBeUndefined();
    const [url, ...otherUrls] = openUrls(buildLarkCard(dm));
    expect(otherUrls).toHaveLength(0);
    expect(url).toMatch(/^https:\/\/dock\.example\/api\/auth\/link\?code=[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(dm)).toContain('10 分钟内有效、只能用一次，不要转发');
    const code = new URL(url!).searchParams.get('code')!;
    expect(JSON.stringify([h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls])).not.toContain(code);
    expect(h.links.redeem(code)).toBe(sessionId);
    expect(h.links.redeem(code)).toBeUndefined();

    // 过程卡上的按钮同样受理；账本只认本机器人、本群、本卡的 message_id。
    expect((await h.coordinator.handleAction(callbackValue(button), 'ou_alice', { messageId: extra.card_message_id, chatId: 'oc_group' })).type).toBe('success');
    for (const context of [{ messageId: 'om_forged', chatId: 'oc_group' }, { messageId: extra.final_message_id, chatId: 'oc_other' }]) {
      expect(await h.coordinator.handleAction(callbackValue(button), 'ou_alice', context)).toMatchObject({ type: 'warning' });
    }
    expect(h.privateMessages()).toHaveLength(2);

    // 只读账本，不依赖内存任务：重启后的新协调器照样受理老卡片。
    h.coordinator.stop();
    const restored = h.createCoordinator();
    await restored.initializeWorkflows(h.config);
    try {
      expect((await restored.handleAction(callbackValue(button), 'ou_alice', { messageId: extra.final_message_id, chatId: 'oc_group' })).type).toBe('success');
      expect(h.privateMessages()).toHaveLength(3);
    } finally { restored.stop(); }
    expect(h.groupMessages()).toBe(groupBefore);
  });

  it('过程卡首帧就是回调按钮，不等第一次心跳重绘', async () => {
    const h = await harness();
    const { sessionId } = await h.runTask();
    const firstFrame = h.service.reply.mock.calls.map(([input]: any[]) => input).find(input => input.cardKind === 'process');
    const card = buildLarkCard(firstFrame);
    expect(detailButtons(card)).toHaveLength(1);
    expect(JSON.stringify(card)).not.toContain(`/sessions/${sessionId}`);
  });

  it('重试开了新一轮后，旧一轮的卡片照样拿到链接，指向任务当前所在的会话', async () => {
    const h = await harness({ failFirst: true });
    await h.coordinator.handle(event('om_task', '检查构建'), h.config);
    await vi.waitFor(async () => expect((await h.saved()).extra).toMatchObject({ state: 'failed', final_delivery_state: 'delivered' }), { timeout: 10_000 });
    const first = (await h.saved()).extra;
    expect(await h.coordinator.handleAction({ action: 'retry', task_id: 'om_task', turn: String(first.turn) }, 'ou_alice',
      { messageId: first.card_message_id, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    await vi.waitFor(async () => expect((await h.saved()).extra).toMatchObject({ turn: first.turn! + 1, state: 'completed', final_delivery_state: 'delivered' }), { timeout: 10_000 });
    const current = await h.saved();
    expect([current.extra.card_message_id, current.extra.final_message_id]).not.toContain(first.card_message_id);

    const clickOld = async (messageId: string, chatId = 'oc_group') => {
      const [button] = detailButtons(buildLarkCard(h.cards.get(messageId)));
      expect(button, `旧卡 ${messageId} 上应有回调式「查看详情」`).toBeDefined();
      return h.coordinator.handleAction(callbackValue(button), 'ou_alice', { messageId, chatId });
    };
    const lastCode = () => /code=([A-Za-z0-9_-]{43})/.exec(JSON.stringify(h.privateMessages().at(-1)))![1]!;
    for (const messageId of [first.card_message_id!, first.final_message_id!]) {
      expect(await clickOld(messageId)).toEqual({ type: 'success', content: '已私信你一个 10 分钟内有效的登录链接' });
      expect(h.links.redeem(lastCode())).toBe(current.sessionId);
    }
    // 群号仍要对得上；非管理员在旧卡上也拿不到。
    expect(await clickOld(first.final_message_id!, 'oc_other')).toMatchObject({ type: 'warning' });
    expect(await h.coordinator.handleAction({ action: 'detail', task_id: 'om_task', turn: String(first.turn) }, 'ou_bob',
      { messageId: first.final_message_id, chatId: 'oc_group' })).toMatchObject({ type: 'warning', content: expect.stringContaining('仅机器人管理员') });
    expect(h.privateMessages()).toHaveLength(2);

    // 任务转到别的会话后（账本换了会话），旧卡的链接跟着任务走。
    const [row] = await h.repos.channelMappings.list('lark-card:cli_detail');
    await h.repos.channelMappings.save({ ...row!, sessionId: 'ses_moved' });
    expect(await clickOld(first.card_message_id!)).toMatchObject({ type: 'success' });
    expect(h.links.redeem(lastCode())).toBe('ses_moved');
  });

  it('非管理员点击不发私信，只提示去导出执行记录', async () => {
    const h = await harness();
    const { extra } = await h.runTask();
    const value = { action: 'detail', task_id: 'om_task', turn: String(extra.turn) };
    const groupBefore = h.groupMessages();
    expect(await h.coordinator.handleAction(value, 'ou_bob', { messageId: extra.final_message_id, chatId: 'oc_group' }))
      .toEqual({ type: 'warning', content: 'Web 详情仅机器人管理员可打开；完整执行记录可点「导出执行记录」获取' });
    expect(h.privateMessages()).toHaveLength(0);
    expect(h.groupMessages()).toBe(groupBefore);
  });

  it('没设成员名单时按安装级门原有口径：能用机器人的人都能拿到链接，且只发给点击人本人', async () => {
    const h = await harness({ allowedUsers: [] });
    const { extra } = await h.runTask();
    const value = { action: 'detail', task_id: 'om_task', turn: String(extra.turn) };
    const groupBefore = h.groupMessages();
    expect(await h.coordinator.handleAction(value, 'ou_bob', { messageId: extra.final_message_id, chatId: 'oc_group' }))
      .toEqual({ type: 'success', content: '已私信你一个 10 分钟内有效的登录链接' });
    expect(h.privateMessages()).toMatchObject([{ receiveId: 'ou_bob', receiveIdType: 'open_id' }]);
    expect(h.groupMessages()).toBe(groupBefore);
  });

  it('私信发送失败时 toast 说明原因，群里也不补发链接', async () => {
    const h = await harness();
    const { extra } = await h.runTask();
    const value = { action: 'detail', task_id: 'om_task', turn: String(extra.turn) };
    const groupBefore = h.groupMessages();
    h.service.send.mockRejectedValueOnce(new LarkServiceError('LARK_OPENAPI_ERROR', 'Lark OpenAPI request failed: Bot has NO availability to this user. (code: 230013)', 502, { upstreamCode: 230013 }));
    const result = await h.coordinator.handleAction(value, 'ou_alice', { messageId: extra.final_message_id, chatId: 'oc_group' });
    expect(result).toMatchObject({ type: 'error', content: expect.stringContaining('可用范围') });
    expect(h.groupMessages()).toBe(groupBefore);
    const attempted = JSON.stringify(h.service.send.mock.calls.at(-1));
    const code = /code=([A-Za-z0-9_-]{43})/.exec(attempted)![1]!;
    expect(JSON.stringify([h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls])).not.toContain(code);
  });

  it('托管群按安装级门判定：显式授予高风险权限的成员才算管理员', async () => {
    const h = await harness({ managedGroup: true });
    const { extra } = await h.runTask();
    const value = { action: 'detail', task_id: 'om_task', turn: String(extra.turn) };
    const click = () => h.coordinator.handleAction(value, 'ou_alice', { messageId: extra.final_message_id, chatId: 'oc_group' });
    expect(await click()).toMatchObject({ type: 'warning', content: expect.stringContaining('仅机器人管理员') });
    const access = (await h.groupManager!.groupAccess(h.config.appId, 'oc_group'))!;
    await h.groupManager!.save(h.config.appId, 'oc_group', { expectedRevision: access.revision, patch: {}, roleChanges: [{ kind: 'create', principalId: principalId(h.config.appId, 'ou_alice'),
      role: 'can_operate', operateScope: 'group_runs', actionGates: { terminalWrite: false, highRisk: true, groupToolsSend: false } }] });
    expect(await click()).toMatchObject({ type: 'success' });
    expect(h.privateMessages()).toHaveLength(1);
  });

  it('未开启 Web 登录时卡片保持直接打开的链接，回调也不发链接', async () => {
    const h = await harness({ loginLinks: false });
    const { sessionId, extra } = await h.runTask();
    const firstFrame = h.service.reply.mock.calls.map(([input]: any[]) => input).find(input => input.cardKind === 'process');
    for (const card of [buildLarkCard(h.cards.get(extra.final_message_id!)), buildLarkCard(firstFrame)]) {
      expect(detailButtons(card)).toHaveLength(0);
      expect(JSON.stringify(card)).toContain(`[查看详情](https://dock.example/sessions/${sessionId})`);
    }
    expect(await h.coordinator.handleAction({ action: 'detail', task_id: 'om_task', turn: String(extra.turn) }, 'ou_alice', { messageId: extra.final_message_id, chatId: 'oc_group' }))
      .toMatchObject({ type: 'error' });
    expect(h.privateMessages()).toHaveLength(0);
  });
});
