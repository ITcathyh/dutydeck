// 群级呈现开关 completionReactionOnly / silentProgress 的协调器级回归。
//
// 这两个开关改变的是「发不发消息」，所以断言一律打在 service 的 send/reply/addReaction 上，
// 而不是内部状态：真实 DutydeckRuntime + SQLite 持久化 + 真实 LarkWorkflowInteractions，
// 只有飞书 service 是内存 mock。默认（两个都关）的既有行为必须逐条保持不变。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { RelayAskBroker } from '@dutydeck/relay';
import type { AgentConfig } from '@dutydeck/shared';
import { createRelayAskStore } from '../relay-ask-store.js';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { COMPLETION_REACTION_EMOJI } from './reaction-records.js';
import type { LarkMessageEvent } from './listener.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});

/** normal = 正常完成；unresolved = 工具没回结果，终态按失败处理；permission = 发一张待决审批卡后挂住。 */
type HarnessMode = 'normal' | 'unresolved' | 'permission';

async function harness(mode: HarnessMode = 'normal', configPatch: Partial<StoredLarkConfig> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-presentation-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let release: (() => void) | undefined;
  const gate = new Promise<void>(done => { release = done; });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => {
      const driver: AgentDriver = {
        start: async () => {},
        resume: async () => {},
        stop: async () => {},
        interrupt: async () => {},
        send: async () => {
          if (mode === 'permission') {
            emit({ type: 'permission_request', data: { id: 'native_permission', title: '修改文件', status: 'pending', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } });
            await gate;
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
            return;
          }
          if (mode === 'unresolved') {
            emit({ type: 'tool_call', data: { id: 'call_1', title: '写文件', status: 'in_progress' } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
            return;
          }
          emit({ type: 'text', data: { text: '工作已完成' } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        },
        resolvePermission: async () => true
      };
      return driver;
    }
  });
  const broker = new RelayAskBroker({ publish: async (sessionId: string, input: any) => {
    await runtime.publishSessionEvent(sessionId, 'text', { text: input.text, relay: input.kind, askId: input.askId });
  } }, createRelayAskStore(repos.config));
  await broker.initialize();
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_present', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock',
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    completionReactionOnly: false, silentProgress: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [],
    highRiskPattern: 'dangerous', riskControlMode: 'off', ...configPatch };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  let nextCard = 0;
  const createCard = async (_input: any) => ({ messageId: `om_card_${++nextCard}` });
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `reaction_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', messageType: 'text', rawContent: '{}', sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => [] as any[]),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array(), contentType: 'text/plain' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
    undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, broker });
  const coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => {
    coordinator.stop(); release?.(); broker.close(); await broker.flush();
    await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true });
  });

  const channel = `lark-card:${config.appId}`;
  /** 所有新消息（群里过程卡与结果卡都走 reply，回退时才走 send）。 */
  const sentCards = () => [...service.reply.mock.calls, ...service.send.mock.calls].map(([input]) => input as any);
  const cardsOfKind = (kind: 'process' | 'result') => sentCards().filter(input => input?.cardKind === kind);
  const completionReactions = () => service.addReaction.mock.calls.filter(([, emoji]) => emoji === COMPLETION_REACTION_EMOJI);
  const mappings = async () => (await repos.channelMappings.list(channel))
    .map(mapping => JSON.parse(mapping.extra ?? '{}') as PersistedLarkCardTask);
  const settled = async (messageId: string) => vi.waitFor(async () => {
    const saved = (await mappings()).find(item => item.final_delivery_state);
    expect(saved).toBeTruthy();
    expect(saved!.state).not.toBe('running');
    return saved!;
  }, { timeout: 5_000 }).then(saved => { void messageId; return saved; });

  return { repos, runtime, config, coordinator, createCoordinator, service, log, channel,
    sentCards, cardsOfKind, completionReactions, mappings, settled, releaseGate: () => release?.() };
}

describe('完成时只贴表情（completionReactionOnly）', () => {
  it('默认关闭时逐条保持既有行为：过程卡 + 结果卡，且不贴完成表情', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_default', '做一件事'), h.config);
    await h.settled('om_default');

    expect(h.cardsOfKind('process')).toHaveLength(1);
    expect(h.cardsOfKind('result')).toHaveLength(1);
    expect(h.completionReactions()).toHaveLength(0);
  });

  it('开启后成功终态只贴一个表情、不发结果卡，过程卡仍冻结成完成态', async () => {
    const h = await harness('normal', { completionReactionOnly: true });
    await h.coordinator.handle(event('om_react', '做一件事'), h.config);
    const saved = await h.settled('om_react');

    expect(h.cardsOfKind('process')).toHaveLength(1);
    expect(h.cardsOfKind('result')).toHaveLength(0);
    expect(h.completionReactions()).toEqual([['om_react', COMPLETION_REACTION_EMOJI]]);
    expect(saved.state).toBe('completed');
    expect(saved.final_delivery_state).toBe('reaction');
    expect(saved.final_message_id).toBeUndefined();
    // 终态帧仍然写进过程卡，卡片不会停在「执行中」。
    expect(h.service.update.mock.calls.some(([input]) => (input as any).state === 'completed')).toBe(true);
  });

  it('失败终态照发结果卡，不允许用一个表情把失败藏起来', async () => {
    const h = await harness('unresolved', { completionReactionOnly: true });
    await h.coordinator.handle(event('om_fail', '做一件事'), h.config);
    const saved = await h.settled('om_fail');

    expect(saved.state).toBe('failed');
    expect(h.cardsOfKind('result')).toHaveLength(1);
    expect(h.cardsOfKind('result')[0]).toMatchObject({ state: 'failed' });
    expect(h.completionReactions()).toHaveLength(0);
  });
});

describe('中间进展静默（silentProgress）', () => {
  it('开启后不发过程卡，最终结果卡照发', async () => {
    const h = await harness('normal', { silentProgress: true });
    await h.coordinator.handle(event('om_silent', '做一件事'), h.config);
    const saved = await h.settled('om_silent');

    expect(h.cardsOfKind('process')).toHaveLength(0);
    expect(h.cardsOfKind('result')).toHaveLength(1);
    expect(saved.card_message_id).toBeUndefined();
    expect(saved.final_message_id).toBeTruthy();
    expect(saved.final_delivery_state).toBe('delivered');
  });

  it('开启后权限审批卡照发：静默的是进展，不是「正在等人」', async () => {
    const h = await harness('permission', { silentProgress: true });
    await h.coordinator.handle(event('om_ask', '需要审批'), h.config);

    await vi.waitFor(async () => {
      const pending = (await h.repos.config.list!(`lark.interaction.${h.config.appId}.`))
        .map(row => JSON.parse(row.value))
        .filter(item => item.kind === 'permission' && item.state === 'pending');
      expect(pending).toHaveLength(1);
    }, { timeout: 5_000 });
    // 审批卡是独立新消息，不是过程卡。
    expect(h.sentCards().some(input => input?.cardKind === 'process')).toBe(false);
    expect(h.sentCards().length).toBeGreaterThan(0);
  });

  it('两个开关同时开启时只剩一个表情：既无过程卡也无结果卡', async () => {
    const h = await harness('normal', { silentProgress: true, completionReactionOnly: true });
    await h.coordinator.handle(event('om_both', '做一件事'), h.config);
    const saved = await h.settled('om_both');

    expect(h.cardsOfKind('process')).toHaveLength(0);
    expect(h.cardsOfKind('result')).toHaveLength(0);
    expect(h.completionReactions()).toEqual([['om_both', COMPLETION_REACTION_EMOJI]]);
    expect(saved.final_delivery_state).toBe('reaction');
    // 没有过程卡也必须留下映射，否则重启后这条任务彻底失联。
    expect(saved.state).toBe('completed');
  });

  it('两个都开时失败终态仍然发结果卡', async () => {
    const h = await harness('unresolved', { silentProgress: true, completionReactionOnly: true });
    await h.coordinator.handle(event('om_both_fail', '做一件事'), h.config);
    const saved = await h.settled('om_both_fail');

    expect(saved.state).toBe('failed');
    expect(h.cardsOfKind('process')).toHaveLength(0);
    expect(h.cardsOfKind('result')).toHaveLength(1);
    expect(h.completionReactions()).toHaveLength(0);
  });
});
