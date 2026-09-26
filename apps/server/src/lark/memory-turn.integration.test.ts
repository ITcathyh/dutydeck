// 本轮记忆的协调器级回归：真实 DutydeckRuntime + SQLite + 真实 LarkMessageCoordinator，service 为内存 mock。
// 锁定「派发时记下注入了哪些记忆 → 结果卡不展示记忆 → 旧卡按钮仍走 /forget 同一道门」，
// 以及 /memory ignore 的增删查。
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
const groupPool = larkMemoryScope('cli_memory', 'oc_group', 'group');
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});

async function harness(patch: Partial<StoredLarkConfig> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-memory-turn-'));
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
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off', ...patch };
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
  let projection!: LarkMemoryProjection;
  const memoryStore = new LarkMemoryStore(repos.config, { onChange: scope => projection.write(scope) });
  projection = new LarkMemoryProjection(memoryStore, join(cwd, 'memory'), log);
  const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings,
    async () => 'group', undefined, undefined, { store: repos.config, memory: { store: memoryStore, projection, command: 'dutydeck' } });
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => {
    coordinator.stop();
    await runtime.shutdown();
    repos.close();
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  });
  const lastCardText = () => JSON.stringify(cards.at(-1) ?? {});
  const waitCards = (count: number) => vi.waitFor(() => expect(cards.length).toBeGreaterThanOrEqual(count));
  /** 最近一张结果卡及其消息编号（createCard 按发送顺序编号）。 */
  const resultCard = () => {
    const index = cards.map(card => card.cardKind).lastIndexOf('result');
    return index < 0 ? undefined : { card: cards[index]!, messageId: `om_card_${index + 1}` };
  };
  const remember = async (id: string, text: string) => {
    const before = cards.length;
    await coordinator.handle(event(id, `/remember ${text}`), config);
    await waitCards(before + 1);
    return lastCardText().match(/mem_[0-9a-f]{8}/)![0];
  };
  const runTask = async (id: string, text: string) => {
    await coordinator.handle(event(id, text), config);
    await vi.waitFor(() => expect(resultCard()?.card.taskId).toBe(id), { timeout: 10_000 });
    const [session] = (await runtime.listSessions()).filter(item => item.source === 'lark');
    const tasks = await runtime.getTasks(session!.id);
    return { ...resultCard()!, runtimeTaskId: tasks.at(-1)!.id, sessionId: session!.id };
  };
  return { repos, runtime, coordinator, memoryStore, config, service, cards, prompts, lastCardText, waitCards, resultCard, remember, runTask };
}

describe('memory of each turn', () => {
  it('records injected memories without listing them on the result card, and accepts old-card forget callbacks', async () => {
    const h = await harness({ allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }] });
    const first = await h.remember('om_r1', '回复统一用中文');
    const second = await h.remember('om_r2', '先给一句话结论');

    const result = await h.runTask('om_task', '帮我看看这个接口');
    const view = await h.memoryStore.turn(result.sessionId, result.runtimeTaskId);
    expect(view?.record).toMatchObject({ sessionId: result.sessionId, chatId: 'oc_group', pool: 'groups' });
    expect(view!.injected.map(entry => entry.id).sort()).toEqual([first, second].sort());

    const elements = result.card.elements as Array<Record<string, any>>;
    expect(JSON.stringify(elements)).not.toContain('memory_turn');
    expect(JSON.stringify(elements)).not.toContain(first);
    const value = { dutydeck_memory_forget: first, task_id: result.runtimeTaskId, session_id: result.sessionId };
    expect(value).toEqual({ dutydeck_memory_forget: first, task_id: result.runtimeTaskId, session_id: result.sessionId });
    // Simulate an older delivered card still carrying a memory row. Its callback must clear that row.
    const liveTask = [...(h.coordinator as any).tasks.values()].find((task: any) => task.runtimeTaskId === result.runtimeTaskId);
    liveTask.finalElements.push({ tag: 'markdown', element_id: 'memory_turn', content: '**本轮记忆**' });

    const context = { messageId: result.messageId, chatId: 'oc_group' };
    // 与 /forget 同一道门：不在白名单里的人点了不生效。
    expect(await h.coordinator.handleAction(value, 'ou_mallory', context)).toMatchObject({ type: 'warning', content: expect.stringContaining('白名单') });
    // 聊天以平台回调为准：换一个聊天点同一个按钮不生效。
    expect((await h.coordinator.handleAction(value, 'ou_alice', { ...context, chatId: 'oc_other' }))?.type).toBe('warning');
    // 只删这一轮列出过的条目。
    expect((await h.coordinator.handleAction({ ...value, dutydeck_memory_forget: 'mem_ffffffff' }, 'ou_alice', context))?.type).toBe('warning');
    // 记录已被修剪的旧卡片：提示改用 /forget。
    expect(await h.coordinator.handleAction({ ...value, task_id: 'task_gone' }, 'ou_alice', context)).toMatchObject({ type: 'warning', content: expect.stringContaining('已过期') });
    expect((await h.memoryStore.list(groupPool)).map(entry => entry.id).sort()).toEqual([first, second].sort());

    expect(await h.coordinator.handleAction(value, 'ou_alice', context)).toEqual({ type: 'success', content: `已删除记忆 ${first}，之后的任务不再带上这条记忆。` });
    expect((await h.memoryStore.list(groupPool)).map(entry => entry.id)).toEqual([second]);
    expect((await h.memoryStore.listAll(groupPool)).find(entry => entry.id === first)).toMatchObject({ deletedBy: 'ou_alice' });
    const redraw = h.service.update.mock.calls.map(([input]) => input as Record<string, any>).filter(input => input.messageId === result.messageId).at(-1)!;
    expect(JSON.stringify(redraw.elements)).not.toContain('memory_turn');
    // 结论本身原样保留。
    expect(JSON.stringify(redraw.elements)).toContain('工作已完成');

    expect(await h.coordinator.handleAction(value, 'ou_alice', context)).toMatchObject({ type: 'warning', content: `记忆 ${first} 已经删除过了。` });
  });

  it('keeps the result card free of memory details even when many memories were used', async () => {
    const h = await harness();
    const empty = await h.runTask('om_empty', '第一个任务');
    expect(JSON.stringify(empty.card.elements)).not.toContain('memory_turn');
    for (let index = 0; index < 7; index++) await h.remember(`om_r${index}`, `第 ${index} 条约定`);
    const result = await h.runTask('om_task', '第二个任务');
    const elements = result.card.elements as Array<Record<string, any>>;
    expect(JSON.stringify(elements)).not.toContain('memory_turn');
    expect((await h.memoryStore.turn(result.sessionId, result.runtimeTaskId))?.injected).toHaveLength(7);
  });
});

describe('/memory ignore', () => {
  it('adds, lists and removes the rules of the shared pool, and keeps bot senders from changing them', async () => {
    const h = await harness();
    await h.coordinator.handle(event('om_i0', '/memory ignore'), h.config);
    await h.waitCards(1);
    expect(h.lastCardText()).toContain('还没有「不许记」规则');

    await h.coordinator.handle(event('om_i1', '/memory ignore 不要记任何人的薪资'), h.config);
    await h.waitCards(2);
    expect(h.lastCardText()).toContain('已添加不许记规则');
    expect(h.lastCardText()).toContain('对本机器人所在各群都生效');
    const [rule] = await h.memoryStore.listIgnoreRules(groupPool);
    expect(rule).toMatchObject({ text: '不要记任何人的薪资', createdBy: 'ou_alice', chatId: 'oc_group' });

    // 其他群看到的是同一份规则；私聊是另一个池。
    await h.coordinator.handle(event('om_i2', '/memory ignore list', { chatId: 'oc_group_b', threadId: undefined, rootId: undefined }), h.config);
    await h.waitCards(3);
    expect(h.lastCardText()).toContain(rule!.id);
    await h.coordinator.handle(event('om_i3', '/memory ignore list', { chatId: 'oc_p2p', chatType: 'p2p', threadId: undefined, rootId: undefined, mentions: [] }), h.config);
    await h.waitCards(4);
    expect(h.lastCardText()).toContain('还没有「不许记」规则');

    await h.coordinator.handle(event('om_i4', `/memory ignore remove ${rule!.id}`, { senderType: 'app', senderOpenId: 'ou_peer' }), h.config);
    await h.waitCards(5);
    expect(h.lastCardText()).toContain('机器人发送者不能修改');
    await h.coordinator.handle(event('om_i5', '/memory ignore remove nope'), h.config);
    await h.waitCards(6);
    expect(h.lastCardText()).toContain('用法');
    await h.coordinator.handle(event('om_i6', '/memory ignore remove ign_00000000'), h.config);
    await h.waitCards(7);
    expect(h.lastCardText()).toContain('没有编号为');
    expect(await h.memoryStore.listIgnoreRules(groupPool)).toHaveLength(1);

    await h.coordinator.handle(event('om_i7', `/memory ignore remove ${rule!.id}`), h.config);
    await h.waitCards(8);
    expect(h.lastCardText()).toContain('已删除不许记规则');
    expect(await h.memoryStore.listIgnoreRules(groupPool)).toEqual([]);
    // 规则命令不进入 Agent。
    expect(h.prompts).toEqual([]);
  });
});
