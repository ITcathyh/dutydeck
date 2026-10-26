// 群记忆范围的协调器级回归：真实 DutydeckRuntime + SQLite + 真实 LarkMessageCoordinator。
// 锁定 shared 下 A 群 /remember 的内容在 B 群可见、per-group 下不可见，以及切换范围不丢数据。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { larkMemoryScope, LarkMemoryStore } from './memory.js';
import { LarkMemoryProjection } from './memory-view.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_a', chatType: 'group', threadId: `omt_${id}`, rootId: `om_root_${id}`,
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-memory-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => {
      const driver: AgentDriver = {
        isIdle: () => true, hasBackgroundWork: () => false,
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
        send: async prompt => {
          prompts.push(prompt);
          emit({ type: 'text', data: { text: '工作已完成' } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      };
      return driver;
    }
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_memory', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true, memoryEnabled: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  let nextCard = 0;
  const cards: Array<Record<string, unknown>> = [];
  const createCard = async (input: Record<string, unknown>) => { cards.push(input); return { messageId: `om_card_${++nextCard}` }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: { messageId: string }) => ({ messageId: input.messageId })),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `reaction_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as unknown[], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', threadId: 'omt_topic', messageType: 'text', rawContent: JSON.stringify({ text: '引用' }), sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => [] as unknown[]),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array(), contentType: 'text/plain' })),
    readDocument: vi.fn(async (url: string) => ({ url, title: '文档', text: '' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const memoryRoot = join(cwd, 'memory');
  let projection!: LarkMemoryProjection;
  const memoryStore = new LarkMemoryStore(repos.config, {
    onChange: scope => projection.write(scope)
  });
  projection = new LarkMemoryProjection(memoryStore, memoryRoot, log);

  const coordinator = new LarkMessageCoordinator(
    runtime,
    service as any,
    log,
    Math.random,
    'ou_bot',
    undefined,
    repos.channelMappings,
    async () => 'group',
    undefined,
    undefined,
    {
      store: repos.config,
      memory: {
        store: memoryStore
      }
    }
  );
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => {
    coordinator.stop();
    await runtime.shutdown();
    repos.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  });
  /** 最近一张命令回执卡的全文（标题 + markdown）。 */
  const lastCardText = () => JSON.stringify(cards.at(-1) ?? {});
  const waitCards = (count: number) => vi.waitFor(() => expect(cards.length).toBeGreaterThanOrEqual(count));
  const waitPrompts = (count: number) => vi.waitFor(() => expect(prompts).toHaveLength(count), { timeout: 10_000 });
  return { cwd, repos, runtime, coordinator, memoryStore, projection, config, service, cards, prompts, log, lastCardText, waitCards, waitPrompts };
}

describe('Lark group memory scope through the coordinator', () => {
  const remembered = '部署前必须先跑 smoke 测试';
  // 命令与注入链路读存储里的机器人配置，切换范围要写回存储，handle 的 config 参数只是入口快照。
  const useScope = async (h: Awaited<ReturnType<typeof harness>>, groupMemoryScope: 'shared' | 'per-group') => {
    const config = { ...h.config, groupMemoryScope };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    return config;
  };

  it('shared: group B sees what group A remembered, in /memory and in the injected prompt', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_r', `/remember ${remembered}`), h.config);
    await h.waitCards(1);
    expect(h.lastCardText()).toContain('已保存为群共享记忆');

    await h.coordinator.handle(event('om_list_b', '/memory', { chatId: 'oc_b' }), h.config);
    await h.waitCards(2);
    expect(h.lastCardText()).toContain('本机器人所在各群共享，共 1 条记忆');
    expect(h.lastCardText()).toContain(remembered);

    await h.coordinator.handle(event('om_ask_b', '继续', { chatId: 'oc_b' }), h.config);
    await h.waitPrompts(1);
    expect(h.prompts[0]).toContain(remembered);
  });

  it('per-group: group B cannot see, inject or forget what group A remembered', async () => {
    const h = await harness();
    const perGroup = await useScope(h, 'per-group');
    await h.coordinator.handle(event('om_r', `/remember ${remembered}`), perGroup);
    await h.waitCards(1);
    expect(h.lastCardText()).toContain('已保存为本群独立记忆');
    const id = h.lastCardText().match(/mem_[0-9a-f]{8}/)?.[0]!;
    expect((await h.memoryStore.list(larkMemoryScope('cli_memory', 'oc_a', 'group', 'per-group'))).map(entry => entry.content)).toEqual([remembered]);
    expect(await h.memoryStore.list(larkMemoryScope('cli_memory', 'oc_a', 'group'))).toEqual([]);

    // /memory：A 群看得到并标明范围，B 群是空的。
    await h.coordinator.handle(event('om_list_a', '/memory'), perGroup);
    await h.waitCards(2);
    expect(h.lastCardText()).toContain('本群独立记忆（各群记忆互不可见），共 1 条');
    await h.coordinator.handle(event('om_list_b', '/memory', { chatId: 'oc_b' }), perGroup);
    await h.waitCards(3);
    expect(h.lastCardText()).toContain('本群还没有保存的记忆');
    expect(h.lastCardText()).not.toContain(remembered);

    // /forget：B 群用 A 群的编号删不掉。
    await h.coordinator.handle(event('om_forget_b', `/forget ${id}`, { chatId: 'oc_b' }), perGroup);
    await h.waitCards(4);
    expect(h.lastCardText()).toContain('/forget 未执行');
    expect(await h.memoryStore.list(larkMemoryScope('cli_memory', 'oc_a', 'group', 'per-group'))).toHaveLength(1);

    // 注入：B 群的任务不带 A 群的记忆，A 群的带。
    await h.coordinator.handle(event('om_ask_b', '继续', { chatId: 'oc_b' }), perGroup);
    await h.waitPrompts(1);
    expect(h.prompts[0]).not.toContain(remembered);
    await h.coordinator.handle(event('om_ask_a', '继续'), perGroup);
    await h.waitPrompts(2);
    expect(h.prompts[1]).toContain(remembered);

    // 视图目录按群分开。
    await vi.waitFor(async () => {
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(join(h.cwd, 'memory', 'cli_memory', 'group_oc_a', 'MEMORY.md'), 'utf8')).toContain(remembered);
    });
  });

  it('switching scope keeps both pools: old shared memory is not migrated or deleted and returns when switched back', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_shared', '/remember 共享池里的旧记忆'), h.config);
    await h.waitCards(1);
    const perGroup = await useScope(h, 'per-group');

    // 切到 per-group：本群从空开始，旧共享池不进 /memory 也不进任务注入。
    await h.coordinator.handle(event('om_list_1', '/memory'), perGroup);
    await h.waitCards(2);
    expect(h.lastCardText()).toContain('本群还没有保存的记忆');
    await h.coordinator.handle(event('om_own', '/remember 本群自己的新记忆'), perGroup);
    await h.waitCards(3);
    await h.coordinator.handle(event('om_ask', '继续'), perGroup);
    await h.waitPrompts(1);
    expect(h.prompts[0]).toContain('本群自己的新记忆');
    expect(h.prompts[0]).not.toContain('共享池里的旧记忆');
    expect((await h.memoryStore.list(larkMemoryScope('cli_memory', 'oc_a', 'group'))).map(entry => entry.content)).toEqual(['共享池里的旧记忆']);

    // 切回 shared：继续用旧池，按群池的内容不混入。
    const shared = await useScope(h, 'shared');
    await h.coordinator.handle(event('om_list_2', '/memory', { chatId: 'oc_b' }), shared);
    await h.waitCards(5);
    expect(h.lastCardText()).toContain('本机器人所在各群共享，共 1 条记忆');
    expect(h.lastCardText()).toContain('共享池里的旧记忆');
    expect(h.lastCardText()).not.toContain('本群自己的新记忆');
    expect((await h.memoryStore.list(larkMemoryScope('cli_memory', 'oc_a', 'group', 'per-group'))).map(entry => entry.content)).toEqual(['本群自己的新记忆']);
  });
});
