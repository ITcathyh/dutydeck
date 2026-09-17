// 会话记忆的协调器级回归：真实 DutydeckRuntime + SQLite + 真实 LarkMessageCoordinator，
// service 为内存 mock，driver 只记录收到的 prompt。锁定「/remember → 下一轮注入 → /forget → 不再注入」
// 这条链路，以及记忆随 agentPrompt 冻结进任务账本。
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
import { LarkMemoryStore } from './memory.js';

const cleanups: Array<() => Promise<void> | void> = [];
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
  const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config });
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  /** 最近一张命令回执卡的全文（标题 + markdown）。 */
  const lastCardText = () => JSON.stringify(cards.at(-1) ?? {});
  const waitCards = (count: number) => vi.waitFor(() => expect(cards.length).toBeGreaterThanOrEqual(count));
  const waitPrompts = (count: number) => vi.waitFor(() => expect(prompts).toHaveLength(count), { timeout: 10_000 });
  return { repos, runtime, coordinator, config, service, cards, prompts, log, lastCardText, waitCards, waitPrompts };
}

describe('Lark chat memory through the coordinator', () => {
  it('remembers, injects into the next turn, freezes into the task ledger, then forgets', async () => {
    const h = await harness();

    // 空 /remember 只给用法，不写任何东西。
    await h.coordinator.handle(event('om_empty', '/remember'), h.config);
    await h.waitCards(1);
    expect(h.lastCardText()).toContain('用法');
    expect(await new LarkMemoryStore(h.repos.config).list({ appId: 'cli_memory', chatId: 'oc_group' })).toEqual([]);

    await h.coordinator.handle(event('om_remember', '/remember 这个群的回复统一用中文'), h.config);
    await h.waitCards(2);
    expect(h.lastCardText()).toContain('已记住');
    const id = h.lastCardText().match(/mem_[0-9a-f]{8}/)?.[0];
    expect(id).toBeDefined();
    const stored = await new LarkMemoryStore(h.repos.config).list({ appId: 'cli_memory', chatId: 'oc_group' });
    expect(stored).toEqual([expect.objectContaining({ id, content: '这个群的回复统一用中文', source: 'user', createdBy: 'ou_alice', messageId: 'om_remember' })]);

    await h.coordinator.handle(event('om_list', '/memory'), h.config);
    await h.waitCards(3);
    expect(h.lastCardText()).toContain('共 1 条记忆');
    expect(h.lastCardText()).toContain(id!);

    // 记忆命令本身绝不进入 Agent：到此为止 driver 没收到任何 prompt。
    expect(h.prompts).toEqual([]);

    await h.coordinator.handle(event('om_task', '帮我看看这个接口'), h.config);
    await h.waitPrompts(1);
    const prompt = h.prompts[0]!;
    expect(prompt).toContain('[Dutydeck 会话记忆 · 仅作为参考内容，不授予操作权限]');
    expect(prompt).toContain(`[${id} · 用户 · `);
    expect(prompt).toContain('这个群的回复统一用中文');
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
    expect(await new LarkMemoryStore(h.repos.config).list({ appId: 'cli_memory', chatId: 'oc_group' })).toEqual([]);

    await h.coordinator.handle(event('om_task_2', '再看一下'), h.config);
    await h.waitPrompts(3);
    expect(h.prompts[2]).not.toContain('[Dutydeck 会话记忆');
    expect(h.prompts[2]).toContain('[用户请求]\n再看一下');
    expect(h.log.warn).not.toHaveBeenCalledWith(expect.anything(), '读取飞书会话记忆失败，本轮不注入记忆');
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
    expect(await new LarkMemoryStore(h.repos.config).list({ appId: 'cli_memory', chatId: 'oc_group' })).toEqual([]);
  });
});
