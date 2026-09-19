// 加急与置顶两个打扰型能力的接线回归。
//
// 两个模块此前都已实现却零接线：加急管理器因为 coordinator 不传第 6 个参数而恒不构造，
// 置顶管理器全仓没有实例化点。本文件锁住的是「配置能打开它、默认必须是关的」，
// 以及置顶的生命周期：跑够长才置顶、终态撤销、启动对账撤掉僵尸置顶。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkInteraction } from './workflow-interactions.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text = '跑一个长任务'): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }]
});

async function harness(patch: Partial<StoredLarkConfig> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-reminder-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let release: (() => void) | undefined;
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      send: async () => {
        emit({ type: 'text', data: { text: '正在跑一个长任务' } });
        await new Promise<void>(done => { release = done; });
        emit({ type: 'text', data: { text: '长任务结束' } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);

  const config: StoredLarkConfig = { appId: 'cli_reminder', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock',
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 20, hideTraceOnComplete: false,
    completionReactionOnly: false, silentProgress: false, urgentEnabled: false, pinLongTasks: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off', ...patch };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextCard = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextCard}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `r_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessageItems: vi.fn(async () => [] as any[]),
    pin: vi.fn(async (messageId: string) => ({ messageId })), unpin: vi.fn(async () => {}),
    urgentApp: vi.fn(async () => ({ invalidUserIdList: [] as string[] })),
    callOpenApi: vi.fn(async () => ({ code: 0, data: {} }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
    undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config });
  const coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { release?.(); coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  return { repos, runtime, config, coordinator, createCoordinator, service, cards, log, finish: () => release?.() };
}

/** 一条挂着的待审批记录：只用来驱动加急判定，不牵动运行时。 */
async function seedPendingPermission(h: Awaited<ReturnType<typeof harness>>, ageMs: number) {
  const record: LarkInteraction = {
    appId: h.config.appId, sessionId: 'ses_pending', taskId: 'task_pending', turn: 1,
    event: event('om_trigger'), id: 'req_pending', boot: 'boot_1', kind: 'permission',
    nativeId: 'native_1', question: '执行受控操作', state: 'pending', cardId: 'om_pending_card',
    cardCreatedAt: new Date(Date.now() - ageMs).toISOString(), updatedAt: new Date(Date.now() - ageMs).toISOString()
  };
  await h.repos.config.set(`lark.interaction.${h.config.appId}.${record.id}`, JSON.stringify(record));
  return record;
}

const urgePending = (h: Awaited<ReturnType<typeof harness>>) =>
  (h.coordinator as any).workflows.checkAndUrgePending(h.config.appId);

describe('卡片加急的配置开关', () => {
  it('默认关闭：挂了很久的审批卡也不发强提醒', async () => {
    const h = await harness();
    await seedPendingPermission(h, 30 * 60 * 1000);
    expect((await urgePending(h)).urged).toEqual([]);
    expect(h.service.urgentApp).not.toHaveBeenCalled();
  });

  it('配置打开后按配置的阈值加急，只加急该回答的人', async () => {
    const h = await harness({ urgentEnabled: true, urgentThresholdMs: 3 * 60 * 1000 });
    await seedPendingPermission(h, 5 * 60 * 1000);
    expect((await urgePending(h)).urged).toEqual(['req_pending']);
    expect(h.service.urgentApp).toHaveBeenCalledExactlyOnceWith({
      messageId: 'om_pending_card', userIdList: ['ou_alice'], userIdType: 'open_id'
    });
  });

  it('打开但不调阈值时沿用 10 分钟默认，没到点不打扰', async () => {
    const h = await harness({ urgentEnabled: true });
    await seedPendingPermission(h, 5 * 60 * 1000);
    expect((await urgePending(h)).urged).toEqual([]);
    expect(h.service.urgentApp).not.toHaveBeenCalled();
  });

  it('配置改回关闭后立刻不再加急，不必等进程重启', async () => {
    const h = await harness({ urgentEnabled: true, urgentThresholdMs: 3 * 60 * 1000 });
    await seedPendingPermission(h, 5 * 60 * 1000);
    await h.coordinator.startReconciliation({ ...h.config, urgentEnabled: false });
    expect((await urgePending(h)).urged).toEqual([]);
    expect(h.service.urgentApp).not.toHaveBeenCalled();
  });
});

describe('长任务进度卡置顶', () => {
  it('默认关闭：跑多久都不改写别人的会话列表', async () => {
    const h = await harness({ pinAfterMs: 60_000 });
    await h.coordinator.handle(event('om_task'), h.config);
    await vi.waitFor(() => expect(h.service.update).toHaveBeenCalled(), { timeout: 10_000 });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(h.service.pin).not.toHaveBeenCalled();
    h.finish();
  });

  it('开启后跑够时长才置顶，终态撤销置顶', async () => {
    const h = await harness({ pinLongTasks: true, pinAfterMs: 60_000 });
    await h.coordinator.handle(event('om_task'), h.config);
    await vi.waitFor(() => expect(h.service.update).toHaveBeenCalled(), { timeout: 10_000 });
    // 还没跑够 pinAfterMs：不置顶。
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(h.service.pin).not.toHaveBeenCalled();
  });

  it('跑够时长置顶，任务结束后撤销并落到持久化账本', async () => {
    const h = await harness({ pinLongTasks: true, pinAfterMs: 1_000 });
    await h.coordinator.handle(event('om_task'), h.config);
    await vi.waitFor(() => expect(h.service.pin).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const [pinnedCard] = h.service.pin.mock.calls[0]!;
    expect(h.cards.get(pinnedCard).cardKind).toBe('process');
    const pinRecords = await h.repos.config.list!(`lark.pin.${h.config.appId}.`);
    expect(JSON.parse(pinRecords[0]!.value)).toMatchObject({ messageId: pinnedCard, status: 'pinned' });

    h.finish();
    await vi.waitFor(() => expect(h.service.unpin).toHaveBeenCalledWith(pinnedCard), { timeout: 10_000 });
    await vi.waitFor(async () => {
      const after = await h.repos.config.list!(`lark.pin.${h.config.appId}.`);
      expect(JSON.parse(after[0]!.value)).toMatchObject({ status: 'unpinned' });
    }, { timeout: 10_000 });
  });

  it('进程崩在长任务中间留下的僵尸置顶，由启动对账撤掉', async () => {
    const h = await harness({ pinLongTasks: true, pinAfterMs: 60_000 });
    await h.repos.config.set(`lark.pin.${h.config.appId}.om_zombie`, JSON.stringify({
      messageId: 'om_zombie', appId: h.config.appId, taskId: 'om_dead_task', chatId: 'oc_group',
      pinnedAt: new Date(Date.now() - 3_600_000).toISOString(), status: 'pinned'
    }));
    const restarted = h.createCoordinator();
    try {
      await restarted.initializeWorkflows(h.config);
      await restarted.startReconciliation(h.config);
      expect(h.service.unpin).toHaveBeenCalledWith('om_zombie');
      const [record] = await h.repos.config.list!(`lark.pin.${h.config.appId}.`);
      expect(JSON.parse(record!.value)).toMatchObject({ status: 'unpinned' });
    } finally { restarted.stop(); }
  });
});
