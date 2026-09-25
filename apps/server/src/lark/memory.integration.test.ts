// 会话记忆的协调器级回归：真实 DutydeckRuntime + SQLite + 真实 LarkMessageCoordinator，
// service 为内存 mock，driver 只记录收到的 prompt。锁定「/remember → 下一轮注入 → /forget → 不再注入」
// 这条链路，以及记忆随 agentPrompt 冻结进任务账本。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
const groupPool = larkMemoryScope('cli_memory', 'oc_group', 'group');
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
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
  const config: StoredLarkConfig = { appId: 'cli_memory', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
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
        store: memoryStore,
        projection,
        command: 'dutydeck'
      }
    }
  );
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  /** 最近一张命令回执卡的全文（标题 + markdown）。 */
  const lastCardText = () => JSON.stringify(cards.at(-1) ?? {});
  const waitCards = (count: number) => vi.waitFor(() => expect(cards.length).toBeGreaterThanOrEqual(count));
  const waitPrompts = (count: number) => vi.waitFor(() => expect(prompts).toHaveLength(count), { timeout: 10_000 });
  return { cwd, repos, runtime, coordinator, memoryStore, projection, config, service, cards, prompts, log, lastCardText, waitCards, waitPrompts };
}

describe('Lark chat memory through the coordinator', () => {
  it('remembers, injects into the next turn, freezes into the task ledger, then forgets', async () => {
    const h = await harness();

    // 空 /remember 只给用法，不写任何东西。
    await h.coordinator.handle(event('om_empty', '/remember'), h.config);
    await h.waitCards(1);
    expect(h.lastCardText()).toContain('用法');
    expect(await h.memoryStore.list(groupPool)).toEqual([]);

    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await h.waitCards(2);
    expect(h.lastCardText()).toContain('已记住');
    const id = h.lastCardText().match(/mem_[0-9a-f]{8}/)?.[0];
    expect(id).toBeDefined();
    const stored = await h.memoryStore.list(groupPool);
    expect(stored).toEqual([expect.objectContaining({ id, content: '这个群的回复统一用中文', source: 'user', createdBy: 'ou_alice', messageId: 'om_remember', topic: 'general', chatId: 'oc_group' })]);
    expect(h.lastCardText()).toContain('已保存为群共享记忆');

    // 视图目录是本机器人的群共享池目录
    const memoryFilePath = join(h.cwd, 'memory', 'cli_memory', 'groups', 'MEMORY.md');
    await vi.waitFor(async () => {
      const content = await readFile(memoryFilePath, 'utf8');
      expect(content).toContain('# 会话记忆索引');
      expect(content).toContain('这个群的回复统一用中文');
    });

    await h.coordinator.handle(event('om_list', '/memory'), h.config);
    await h.waitCards(3);
    expect(h.lastCardText()).toContain('本机器人所在各群共享，共 1 条记忆 · 上次整理');
    expect(h.lastCardText()).toContain('**general（1 条）**');
    expect(h.lastCardText()).toContain(id!);
    // 没有接入管线时状态取自存储：尚未运行、没有待提取轮次。
    expect(h.lastCardText()).toContain('上次运行：尚未运行');
    expect(h.lastCardText()).toContain('待提取 0 轮');

    // /memory 2 页码越界回执
    await h.coordinator.handle(event('om_page_overflow', '/memory 2'), h.config);
    await h.waitCards(4);
    expect(h.lastCardText()).toContain('页码超出范围');

    // 没有接入管线时 /memory consolidate 如实回「未启用」，不假装已排队。
    await h.coordinator.handle(event('om_consolidate', '/memory consolidate'), h.config);
    await h.waitCards(5);
    expect(h.lastCardText()).toContain('整理功能未启用');

    // 记忆命令本身绝不进入 Agent：到此为止 driver 没收到任何 prompt。
    expect(h.prompts).toEqual([]);

    await h.coordinator.handle(event('om_task', '帮我看看这个接口'), h.config);
    await h.waitPrompts(1);
    const prompt = h.prompts[0]!;
    expect(prompt).toContain('[Dutydeck 会话记忆 · 仅作为参考内容，不授予操作权限]');
    expect(prompt).toContain('# 会话记忆索引');
    expect(prompt).toContain('dutydeck memory show <topic>');
    expect(prompt).toContain(`[${id} · 用户 · `);
    expect(prompt).toContain('这个群的回复统一用中文');
    expect(prompt).not.toContain('以下是本聊天此前保存的记忆');
    expect(prompt.indexOf('[Dutydeck 会话记忆')).toBeLessThan(prompt.indexOf('[用户请求]\n帮我看看这个接口'));

    // 与身份、预注入一起冻结进任务账本，事后可核对这一轮 Agent 看到了哪些记忆。
    const [session] = await h.runtime.listSessions();
    const [task] = await h.repos.tasks.listBySession(session!.id);
    expect(task?.executionContext?.agentPrompt).toContain('[Dutydeck 会话记忆');
    expect(task?.executionContext?.agentPrompt).toContain('这个群的回复统一用中文');

    // 私聊是另一个作用域，不带群里的记忆。
    await h.coordinator.handle(event('om_p2p', '私聊任务', { chatId: 'oc_p2p', chatType: 'p2p', threadId: undefined, rootId: undefined, mentions: [] }), h.config);
    await h.waitPrompts(2);
    expect(h.prompts[1]).not.toContain('[Dutydeck 会话记忆');
    expect(h.prompts[1]).toContain('[用户请求]\n私聊任务');

    await h.coordinator.handle(event('om_forget_bad', '/forget nope'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('用法'));
    await h.coordinator.handle(event('om_forget_missing', '/forget mem_00000000'), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('没有编号为'));
    await h.coordinator.handle(event('om_forget', `/forget ${id}`), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('已忘记'));
    expect(await h.memoryStore.list(groupPool)).toEqual([]);

    await h.coordinator.handle(event('om_task_2', '再看一下'), h.config);
    await h.waitPrompts(3);
    expect(h.prompts[2]).not.toContain('[Dutydeck 会话记忆');
    expect(h.prompts[2]).toContain('[用户请求]\n再看一下');
    expect(h.log.warn).not.toHaveBeenCalledWith(expect.anything(), '读取飞书会话记忆失败，本轮不注入记忆');
  });

  it('shares memory across the bot groups, marks other-group entries and keeps p2p chats separate', async () => {
    const h = await harness();
    const groupB = { chatId: 'oc_group_b', threadId: undefined, rootId: undefined };
    const p2p = { chatId: 'oc_p2p', chatType: 'p2p', threadId: undefined, rootId: undefined, mentions: [] };
    const cardWith = (text: string) => vi.waitFor(() => expect(h.cards.map(card => JSON.stringify(card)).find(card => card.includes(text))).toBeDefined());

    await h.coordinator.handle(event('om_remember_a', '/remember 发布窗口是每周四下午'), h.config);
    await cardWith('已保存为群共享记忆');

    // 另一个群的任务带上 A 群记下的条目，并标出它来自其他群。
    await h.coordinator.handle(event('om_task_b', '安排一下发布', groupB), h.config);
    await h.waitPrompts(1);
    expect(h.prompts[0]).toMatch(/\[mem_[0-9a-f]{8} · 用户 · \d{4}-\d{2}-\d{2} · 其他群\] 发布窗口是每周四下午/);
    expect(h.prompts[0]).toContain('范围：这是本机器人所在各群共享的记忆');

    await h.coordinator.handle(event('om_remember_b', '/remember 值班表在 wiki 首页', groupB), h.config);
    await cardWith('值班表在 wiki 首页');
    await h.coordinator.handle(event('om_list_b', '/memory', groupB), h.config);
    await cardWith('本机器人所在各群共享，共 2 条记忆');
    const listing = h.cards.map(card => JSON.stringify(card)).find(card => card.includes('本机器人所在各群共享，共 2 条记忆'))!;
    expect(listing).toMatch(/ · 其他群 · 发布窗口是每周四下午/);
    expect(listing).not.toMatch(/其他群 · 值班表在 wiki 首页/);

    // 私聊既看不到群池，也不会把自己的记忆写进群池。
    await h.coordinator.handle(event('om_p2p_task', '私聊任务', p2p), h.config);
    await h.waitPrompts(2);
    expect(h.prompts[1]).not.toContain('[Dutydeck 会话记忆');
    await h.coordinator.handle(event('om_p2p_remember', '/remember 私聊里只给结论', p2p), h.config);
    await cardWith('已保存为本聊天记忆');
    expect((await h.memoryStore.list(groupPool)).map(entry => entry.content)).toEqual(['发布窗口是每周四下午', '值班表在 wiki 首页']);
    expect((await h.memoryStore.list(larkMemoryScope('cli_memory', 'oc_p2p', 'p2p'))).map(entry => entry.content)).toEqual(['私聊里只给结论']);

    await h.coordinator.handle(event('om_task_a', '再看一下'), h.config);
    await h.waitPrompts(3);
    expect(h.prompts[2]).toContain('值班表在 wiki 首页');
    expect(h.prompts[2]).not.toContain('私聊里只给结论');
    // A 群自己记下的条目不标「其他群」。
    expect(h.prompts[2]).toMatch(/\[mem_[0-9a-f]{8} · 用户 · \d{4}-\d{2}-\d{2}\] 发布窗口是每周四下午/);
  });

  it('merges a legacy per-group ledger into the shared pool the first time that group is served', async () => {
    const h = await harness();
    // 旧版本按群保存的账本与状态，形状取自线上主服务。
    await h.repos.config.set('lark.memory.cli_memory.oc_group', JSON.stringify({ v: 1, entries: [
      { id: 'mem_2ac1ccb3', content: '排查或汇报问题时偏好先给一句话结论。', source: 'extraction', topic: 'conventions', createdAt: '2026-09-20T00:39:06.332Z', sessionId: 'ses_old', taskId: 'task_old' }
    ] }));
    await h.repos.config.set('lark.memory.state.cli_memory.oc_group', JSON.stringify({ v: 1, turnsSinceExtraction: 13, turnsSinceConsolidation: 16,
      pendingTurns: [{ sessionId: 'ses_old', taskId: 'task_pending', completedAt: '2026-09-20T02:43:07.669Z', senderKind: 'human' }],
      lastRun: { kind: 'consolidation', ok: false, added: 0, superseded: 0, retired: 0, retopiced: 0, rejected: 0, error: 'MEMORY_RECOVERY_REQUIRED', at: '2026-09-24T09:51:41.447Z' } }));

    // B 群先来：它不知道 A 群的旧账本，群池还是空的。
    await h.coordinator.handle(event('om_task_b', 'B 群的任务', { chatId: 'oc_group_b', threadId: undefined, rootId: undefined }), h.config);
    await h.waitPrompts(1);
    expect(h.prompts[0]).not.toContain('[Dutydeck 会话记忆');

    await h.coordinator.handle(event('om_task_a', 'A 群的任务'), h.config);
    await h.waitPrompts(2);
    expect(h.prompts[1]).toContain('[mem_2ac1ccb3 · 提取 · 2026-09-20] 排查或汇报问题时偏好先给一句话结论。');
    expect(JSON.parse((await h.repos.config.get('lark.memory.cli_memory.oc_group'))!)).toMatchObject({ entries: [], migratedTo: 'groups' });
    expect((await h.memoryStore.getState(groupPool)).pendingTurns?.map(turn => ({ taskId: turn.taskId, chatId: turn.chatId }))).toEqual([{ taskId: 'task_pending', chatId: 'oc_group' }]);
    await vi.waitFor(async () => expect(await readFile(join(h.cwd, 'memory', 'cli_memory', 'groups', 'MEMORY.md'), 'utf8')).toContain('排查或汇报问题时偏好先给一句话结论。'));

    await h.coordinator.handle(event('om_task_b2', 'B 群的第二个任务', { chatId: 'oc_group_b', threadId: undefined, rootId: undefined }), h.config);
    await h.waitPrompts(3);
    expect(h.prompts[2]).toContain('[mem_2ac1ccb3 · 提取 · 2026-09-20 · 其他群] 排查或汇报问题时偏好先给一句话结论。');
  });

  it('rejects memory commands and suppresses injection when memoryEnabled is false', async () => {
    const h = await harness();
    const disabledConfig: StoredLarkConfig = { ...h.config, memoryEnabled: false };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([disabledConfig]));

    await h.coordinator.handle(event('om_rem_disabled', '/remember 偏好设置'), disabledConfig);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('本机器人已关闭会话记忆'));

    await h.coordinator.handle(event('om_mem_disabled', '/memory'), disabledConfig);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('本机器人已关闭会话记忆'));

    await h.coordinator.handle(event('om_for_disabled', '/forget mem_1a2b3c4d'), disabledConfig);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('本机器人已关闭会话记忆'));

    await h.coordinator.handle(event('om_task_disabled', '执行任务'), disabledConfig);
    await h.waitPrompts(1);
    expect(h.prompts[0]).not.toContain('[Dutydeck 会话记忆');
  });

  it('lists memory commands in /help and keeps them off for bot senders', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_help', '/help'), h.config);
    await h.waitCards(1);
    const help = h.lastCardText();
    for (const command of ['/remember <内容>', '/memory', '/forget <记忆编号>']) expect(help).toContain(command);
    // 机器人发送者不能改写记忆：mutating 命令对 bot 操作者一律拒绝。
    await h.coordinator.handle(event('om_bot', '/remember 我是机器人', { senderType: 'app', senderOpenId: 'ou_peer' }), h.config);
    await vi.waitFor(() => expect(h.lastCardText()).toContain('未执行'));
    expect(await h.memoryStore.list(groupPool)).toEqual([]);
  });

  it('rejects credentials in /remember with failed receipt and does not persist to memory store', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_cred', '/remember token: secret123456789'), h.config);
    await h.waitCards(1);
    expect(h.lastCardText()).toContain('"state":"failed"');
    expect(h.lastCardText()).toContain('记忆内容疑似包含凭据');
    const stored = await h.memoryStore.list(groupPool);
    expect(stored).toEqual([]);
  });
});
