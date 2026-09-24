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
import type { AgentConfig } from '@dutydeck/shared';
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
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text',
  content: JSON.stringify({ text }), mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }]
});
const principalId = (appId: string, openId: string) => `principal_${createHash('sha256').update(`${appId}\0${openId}`).digest('hex')}`;

async function harness(options: { loginLinks?: boolean; managedGroup?: boolean; allowedUsers?: StoredLarkConfig['allowedUsers'] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-detail-login-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => {
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
        send: async () => {
          emit({ type: 'text', data: { text: '工作已完成' } });
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
  return { repos, config, service, log, links, cards, coordinator, createCoordinator, groupManager, runTask, groupMessages, privateMessages };
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
    const resultCard = buildLarkCard(h.cards.get(extra.final_message_id!));
    expect(detailButtons(resultCard)).toHaveLength(0);
    expect(JSON.stringify(resultCard)).toContain(`[查看详情](https://dock.example/sessions/${sessionId})`);
    expect(await h.coordinator.handleAction({ action: 'detail', task_id: 'om_task', turn: String(extra.turn) }, 'ou_alice', { messageId: extra.final_message_id, chatId: 'oc_group' }))
      .toMatchObject({ type: 'error' });
    expect(h.privateMessages()).toHaveLength(0);
  });
});
