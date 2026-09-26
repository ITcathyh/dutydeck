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
        store: memoryStore,
        projection,
        command: 'dutydeck'
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

  it('keeps memory inactive for an ordinary bot with no memory flag', async () => {
    const h = await harness();
    const config = { ...h.config, memoryEnabled: undefined };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    await h.memoryStore.add(groupPool, { content: '默认不注入的记忆', source: 'user', chatId: 'oc_group' });

    await h.coordinator.handle(event('om_default_off', '/remember 新的偏好'), config);
    await h.waitCards(1);
    expect(h.lastCardText()).toContain('本机器人已关闭会话记忆');
    await h.coordinator.handle(event('om_default_task', '执行任务'), config);
    await h.waitPrompts(1);
    expect(h.prompts[0]).not.toContain('[Dutydeck 会话记忆');
    const [session] = (await h.runtime.listSessions()).filter(item => item.source === 'lark');
    const [task] = await h.runtime.getTasks(session!.id);
    expect(await h.memoryStore.turn(session!.id, task!.id)).toBeUndefined();
  });

  it('keeps memory active for a Tag bot with no memory flag', async () => {
    const h = await harness();
    const config = { ...h.config, defaultGroupParticipation: 'selective' as const, memoryEnabled: undefined };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    await h.memoryStore.add(groupPool, { content: 'Tag 默认注入的记忆', source: 'user', chatId: 'oc_group' });
    await h.coordinator.handle(event('om_tag_default', '执行任务'), config);
    await h.waitPrompts(1);
    expect(h.prompts[0]).toContain('Tag 默认注入的记忆');
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

  it('shares conventions read-only across bots in the same group, deduplicates, and obeys budget', async () => {
    const h = await harness();
    const botA: StoredLarkConfig = { ...h.config, appId: 'cli_bot_a', name: 'bdev-flash' };
    const botB: StoredLarkConfig = { ...h.config, appId: 'cli_bot_b', name: 'bdev-codex' };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([botA, botB]));

    // 1. A 在 oc_group 记了一条 conventions，和一条 general
    await h.memoryStore.add(larkMemoryScope('cli_bot_a', 'oc_group', 'group'), { content: '群回复统一用中文', source: 'user', topic: 'conventions', chatId: 'oc_group' });
    await h.memoryStore.add(larkMemoryScope('cli_bot_a', 'oc_group', 'group'), { content: '项目路径在 /data', source: 'user', topic: 'general', chatId: 'oc_group' });

    // A 在 oc_other_group 记了一条 conventions（不同群）
    await h.memoryStore.add(larkMemoryScope('cli_bot_a', 'oc_other_group', 'group'), { content: '其他群的约定', source: 'user', topic: 'conventions', chatId: 'oc_other_group' });

    // 已删除机器人 cli_bot_c（不在 lark.bots 中）在 oc_group 记了一条 conventions
    await h.memoryStore.add(larkMemoryScope('cli_bot_c', 'oc_group', 'group'), { content: '已删除机器人的约定', source: 'user', topic: 'conventions', chatId: 'oc_group' });

    // 2. B 在 oc_group 处理任务 -> 注入内容包含 A 的 conventions，且带来源；其他 category 不共享；不同群不共享；已删除机器人跳过
    await h.coordinator.handle(event('om_task_b1', '请帮我排查问题'), botB);
    await h.waitPrompts(1);
    const prompt1 = h.prompts[0]!;

    // 任务 A：结果说明新文案注入验证
    expect(prompt1).toContain('[飞书结果说明] 最终回复第一行用一句不含术语的话给出结论：做事类写完成了什么、还差什么；查问题或分析类写根因或判断。');
    expect(prompt1).toContain('排查、告警分析、成本或流量归因这类请求，在结论之后附「可直接转发」一段');

    // 任务 B：共享偏好注入
    expect(prompt1).toContain('[Dutydeck 会话记忆 · 仅作为参考内容，不授予操作权限]');
    expect(prompt1).toContain('## 同群其他机器人记下的偏好');
    expect(prompt1).toContain('这些条目属于其他机器人，memory show/search 查不到。');
    expect(prompt1).toContain('- [来自 bdev-flash · 用户] 群回复统一用中文');
    // A 其他 category 的条目不共享
    expect(prompt1).not.toContain('项目路径在 /data');
    // 不同群之间不共享
    expect(prompt1).not.toContain('其他群的约定');
    // 已删除的机器人跳过
    expect(prompt1).not.toContain('已删除机器人的约定');

    // /memory 列表里不出现共享条目
    await h.coordinator.handle(event('om_b_memory', '/memory'), botB);
    await h.waitCards(1);
    expect(h.lastCardText()).toContain('本机器人所在各群还没有共享的记忆');
    expect(h.lastCardText()).not.toContain('群回复统一用中文');

    // 3. 文本相同去重：B 自己也记住了相同的内容
    await h.memoryStore.add(larkMemoryScope('cli_bot_b', 'oc_group', 'group'), { content: '群回复统一用中文', source: 'user', topic: 'conventions', chatId: 'oc_group' });
    await h.coordinator.handle(event('om_task_b2', '再次排查'), botB);
    await h.waitPrompts(2);
    const prompt2 = h.prompts[1]!;
    expect(prompt2).toContain('## conventions（1 条）');
    expect(prompt2).toContain('群回复统一用中文');
    // 去重后不再出现「## 同群其他机器人记下的偏好」
    expect(prompt2).not.toContain('## 同群其他机器人记下的偏好');
  });

  it('skips peer bots whose memory is disabled (memoryEnabled: false)', async () => {
    const h = await harness();
    const botA: StoredLarkConfig = { ...h.config, appId: 'cli_bot_a', name: 'bdev-flash', memoryEnabled: false };
    const botB: StoredLarkConfig = { ...h.config, appId: 'cli_bot_b', name: 'bdev-codex' };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([botA, botB]));

    // A 尽管库里有 conventions 条目，但其配置中 memoryEnabled 为 false
    await h.memoryStore.add(larkMemoryScope('cli_bot_a', 'oc_group', 'group'), { content: '关记忆前留下的约定', source: 'user', topic: 'conventions', chatId: 'oc_group' });

    await h.coordinator.handle(event('om_task_peer_disabled', '处理任务'), botB);
    await h.waitPrompts(1);
    expect(h.prompts[0]).not.toContain('关记忆前留下的约定');
    expect(h.prompts[0]).not.toContain('同群其他机器人记下的偏好');

    // 重新开启 A 的记忆开关，A 的偏好应当能够被共享注入
    const botAEnabled: StoredLarkConfig = { ...botA, memoryEnabled: true };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([botAEnabled, botB]));

    await h.coordinator.handle(event('om_task_peer_enabled', '再次处理任务'), botB);
    await h.waitPrompts(2);
    expect(h.prompts[1]).toContain('## 同群其他机器人记下的偏好');
    expect(h.prompts[1]).toContain('这些条目属于其他机器人，memory show/search 查不到。');
    expect(h.prompts[1]).toContain('- [来自 bdev-flash · 用户] 关记忆前留下的约定');
  });

  it('preserves self entries completely when over budget in coordinator memory injection', async () => {
    const h = await harness();
    const botA: StoredLarkConfig = { ...h.config, appId: 'cli_bot_a', name: 'bdev-flash' };
    const botB: StoredLarkConfig = { ...h.config, appId: 'cli_bot_b', name: 'bdev-codex' };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([botA, botB]));

    // B 自身有 2 条正常条目
    await h.memoryStore.add(larkMemoryScope('cli_bot_b', 'oc_group', 'group'), { content: '自身偏好一', source: 'user', topic: 'backend', chatId: 'oc_group' });
    await h.memoryStore.add(larkMemoryScope('cli_bot_b', 'oc_group', 'group'), { content: '自身偏好二', source: 'user', topic: 'frontend', chatId: 'oc_group' });

    // A 有非常多超长条目，导致总长超过 3000 字预算
    for (let i = 0; i < 25; i++) {
      await h.memoryStore.add(larkMemoryScope('cli_bot_a', 'oc_group', 'group'), { content: `长约定条目第${i}条内容，关于代码风格和团队沟通的详细规范说明。`.repeat(5), source: 'user', topic: 'conventions', chatId: 'oc_group' });
    }

    await h.coordinator.handle(event('om_task_b_budget', '开始任务'), botB);
    await h.waitPrompts(1);
    const prompt = h.prompts[0]!;

    // B 自身的 2 条记忆完整保留
    expect(prompt).toContain('## backend（1 条）');
    expect(prompt).toContain('自身偏好一');
    expect(prompt).toContain('## frontend（1 条）');
    expect(prompt).toContain('自身偏好二');
    // 超预算时 B 的条目没有被省略
    expect(prompt).not.toContain('另有');
  });

  it('reads peer conventions from the peer group pool only for the current group', async () => {
    const h = await harness();
    const botA: StoredLarkConfig = { ...h.config, appId: 'cli_bot_a', name: 'bdev-flash' };
    const botB: StoredLarkConfig = { ...h.config, appId: 'cli_bot_b', name: 'bdev-codex' };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([botA, botB]));
    // A 的群共享池里有它在两个群各记的一条约定。
    await h.memoryStore.add(larkMemoryScope('cli_bot_a', 'oc_group', 'group'), { content: '本群发布前先在群里说一声', source: 'user', topic: 'conventions', chatId: 'oc_group' });
    await h.memoryStore.add(larkMemoryScope('cli_bot_a', 'oc_group_b', 'group'), { content: 'B 群的回复只用英文', source: 'user', topic: 'conventions', chatId: 'oc_group_b' });

    await h.coordinator.handle(event('om_task_peer_pool', '安排发布'), botB);
    await h.waitPrompts(1);
    expect(h.prompts[0]).toContain('- [来自 bdev-flash · 用户] 本群发布前先在群里说一声');
    expect(h.prompts[0]).not.toContain('B 群的回复只用英文');
  });

  it('reads an unmigrated peer legacy ledger without migrating it, and sees it once after the peer migrates', async () => {
    const h = await harness();
    const botA: StoredLarkConfig = { ...h.config, appId: 'cli_bot_a', name: 'bdev-flash' };
    const botB: StoredLarkConfig = { ...h.config, appId: 'cli_bot_b', name: 'bdev-codex' };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([botA, botB]));
    // A 旧版本按群保存的账本，条目没有 chatId。
    const legacyLedger = JSON.stringify({ v: 1, entries: [
      { id: 'mem_2ac1ccb3', content: '排查问题时先给一句话结论。', source: 'extraction', topic: 'conventions', createdAt: '2026-09-20T00:39:06.332Z', sessionId: 'ses_old', taskId: 'task_old' }
    ] });
    await h.repos.config.set('lark.memory.cli_bot_a.oc_group', legacyLedger);

    await h.coordinator.handle(event('om_task_b_legacy', '排查一下'), botB);
    await h.waitPrompts(1);
    expect(h.prompts[0]).toContain('- [来自 bdev-flash · 提取] 排查问题时先给一句话结论。');
    // B 只读：A 的旧账本原样保留，A 的群池没有被创建。
    expect(await h.repos.config.get('lark.memory.cli_bot_a.oc_group')).toBe(legacyLedger);
    expect(await h.repos.config.get('lark.memory.cli_bot_a.groups')).toBeUndefined();

    // A 自己在本群处理任务时才并入群池，并入的条目补上来源群。
    await h.coordinator.handle(event('om_task_a_legacy', 'A 的任务'), botA);
    await h.waitPrompts(2);
    expect(JSON.parse((await h.repos.config.get('lark.memory.cli_bot_a.oc_group'))!)).toMatchObject({ entries: [], migratedTo: 'groups' });
    expect(await h.memoryStore.list(larkMemoryScope('cli_bot_a', 'oc_group', 'group'))).toEqual([expect.objectContaining({ id: 'mem_2ac1ccb3', chatId: 'oc_group' })]);

    await h.coordinator.handle(event('om_task_b_migrated', '再排查一下'), botB);
    await h.waitPrompts(3);
    expect(h.prompts[2].split('排查问题时先给一句话结论。')).toHaveLength(2);
    expect(h.prompts[2]).toContain('- [来自 bdev-flash · 提取] 排查问题时先给一句话结论。');
  });
});
