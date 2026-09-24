import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkGroupParticipation } from './group-participation.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import { resolveExplicitFinalContext } from './explicit-final.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkChatMessage } from './service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const topic = { chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root' };
const mention = (openId: string) => [{ key: '@_user_1', name: openId, openId }];
const human = (id: string, target: string, text: string): LarkMessageEvent => ({
  ...topic, messageId: id, senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text',
  content: JSON.stringify({ text }), mentions: mention(target)
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-agent-handoff-'));
  const repos = createRepositories(join(directory, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const sends: Array<{ agentId: string; prompt: string; release: () => void }> = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (agent, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      send: async prompt => {
        await new Promise<void>(release => sends.push({ agentId: agent.id, prompt, release }));
        emit({ type: 'text', data: { text: '脚本化轮次已完成' } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agents: AgentConfig[] = ['a', 'b'].map(id => ({ id, name: `Agent ${id.toUpperCase()}`, command: process.execPath,
    args: [], protocol: 'acp', cwd: directory, env: {}, permissionMode: 'ask', timeout: 10,
    capabilities: { pause: false, resume: true }, builtin: false }));
  await runtime.initialize(agents);
  const configs: StoredLarkConfig[] = ['a', 'b'].map(id => ({
    appId: `cli_${id}`, name: `Bot ${id.toUpperCase()}`, appSecret: 'fake', workspace: directory, defaultAgentId: id,
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: true, groupToolsAllowSend: true, pushIntervalMs: 1000,
    hideTraceOnComplete: false, allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], allowedEmails: [],
    allowedBots: [], peerBotsAllowed: true, highRiskAllowedUsers: [], highRiskAllowedEmails: [],
    highRiskPattern: 'dangerous', riskControlMode: 'off'
  }));
  await repos.config.set(larkBotsConfigKey, JSON.stringify(configs));
  const messages = new Map<string, LarkChatMessage>();
  const addMessage = (id: string, text: string, sender: LarkChatMessage['sender'], parentId?: string) => {
    const row: LarkChatMessage = { messageId: id, chatId: topic.chatId, messageType: 'text',
      createTime: String(Date.now()), sender, rawContent: JSON.stringify({ text }), mentions: [],
      deleted: false, updated: false, threadId: topic.threadId, rootId: topic.rootId,
      ...(parentId ? { parentId } : {}) };
    messages.set(id, row);
    return row;
  };
  addMessage(topic.rootId, '原话题', { id: 'ou_alice', type: 'user' });
  addMessage('om_alice_a', '请检查需求', { id: 'ou_alice', type: 'user' }, topic.rootId);
  addMessage('om_alice_b', '先处理我这项工作', { id: 'ou_alice', type: 'user' }, topic.rootId);
  const receipts = new Map<string, string>();
  let sequence = 0;
  const emitted: Array<{ sender: string; id: string; text: string; parentId: string; inThread: boolean; key?: string }> = [];
  const clients = configs.map(config => {
    const sender = config.appId;
    const receipt = async (input: any) => ({ messageId: `om_card_${++sequence}`, chatId: topic.chatId });
    const replyText = vi.fn(async (input: { messageId: string; text: string; replyInThread?: boolean; idempotencyKey?: string }) => {
      const key = input.idempotencyKey ? `${sender}:${input.idempotencyKey}` : undefined;
      const existing = key && receipts.get(key);
      if (existing) return { messageId: existing, chatId: topic.chatId };
      const id = `om_tool_${++sequence}`;
      addMessage(id, input.text, { type: 'app', id: sender, idType: 'app_id', name: config.name }, input.messageId);
      emitted.push({ sender, id, text: input.text, parentId: input.messageId, inThread: input.replyInThread === true, key: input.idempotencyKey });
      if (key) receipts.set(key, id);
      return { messageId: id, chatId: topic.chatId };
    });
    return {
      send: vi.fn(receipt), reply: vi.fn(receipt), sendText: vi.fn(receipt), replyText,
      update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
      getBotInfo: vi.fn(async () => ({ appName: config.name, openId: `ou_${sender.slice(4)}` })),
      getMessage: vi.fn(async (id: string) => { const row = messages.get(id); if (!row) throw new Error(`Unknown ${id}`); return row; }),
      getMessageItems: vi.fn(async () => []),
      listChatMembers: vi.fn(async (input: any) => ({ items: input.memberTypes?.includes('bot')
        ? configs.map(item => ({ memberId: `ou_${item.appId.slice(4)}`, openId: `ou_${item.appId.slice(4)}`,
            appId: item.appId, name: item.name, memberType: 'bot' }))
        : [{ memberId: 'ou_alice', openId: 'ou_alice', name: 'Alice', memberType: 'user' }], hasMore: false, securityLimited: false })),
      listChatMessages: vi.fn(async () => ({ items: [...messages.values()], hasMore: false })),
      getUserEmails: vi.fn(async () => []), addReaction: vi.fn(async () => ({ reactionId: 'reaction' })),
      deleteReaction: vi.fn(async () => {})
    };
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const participation = configs.map((config, index) => new LarkGroupParticipation({
    repository: repos.collaboration, decider: { decide: async () => ({ action: 'silent' as const, reason: '无主动回复', evidenceIds: [], updates: [] }), respond: vi.fn() },
    authorize: async () => true, readConfig: async () => config, serviceFor: () => clients[index] as any,
    debounceMs: 10_000
  }));
  const coordinators = configs.map((config, index) => new LarkMessageCoordinator(runtime, clients[index] as any, log,
    Math.random, `ou_${config.appId.slice(4)}`, async (_chatId, peerId) => peerId === `ou_${index ? 'a' : 'b'}`,
    repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, participation: participation[index] }));
  await Promise.all(coordinators.map((coordinator, index) => coordinator.initializeWorkflows(configs[index]!)));
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://localhost', 'roundtrip-secret');
  const tools = new LarkAgentToolsService(capabilities, repos.config, {
    authorizeTool: async () => {}, clientFactory: config => clients[configs.findIndex(item => item.appId === config.appId)]! as any,
    workbenchTask: id => runtime.getActiveTaskContext(id),
    finalTaskContext: async (binding, task) => resolveExplicitFinalContext(await repos.channelMappings.list(`lark-card:${binding.appId}`), binding, task)
  });
  const ready = async (appId: string, messageId: string) => vi.waitFor(async () => {
    const row = (await repos.channelMappings.list(`lark-card:${appId}`)).find(item => item.externalId === messageId);
    expect(row).toBeTruthy();
    const saved = JSON.parse(row!.extra!);
    expect(saved.runtime_task_id).toBeTruthy();
    const session = (await repos.sessions.get(row!.sessionId))!;
    const active = runtime.getActiveTaskContext(session.id);
    expect(active?.attemptId).toBeTruthy();
    expect(active?.taskId).toBe(saved.runtime_task_id);
    return { row: row!, session, active: active!, token: capabilities.environmentFor(session).dutydeck_group_tools_token!,
      turn: capabilities.finalTurnToken(session.id, active!.taskId, active!.attemptId!) };
  }, { timeout: 10_000 });
  const deliveredEvent = (id: string, target: string): LarkMessageEvent => {
    const row = messages.get(id)!;
    return { ...topic, messageId: id, parentId: row.parentId, senderOpenId: `ou_${row.sender.id!.slice(4)}`,
      senderType: 'app', messageType: 'text', content: row.rawContent, mentions: mention(target) };
  };
  cleanups.push(async () => {
    sends.forEach(send => send.release());
    coordinators.forEach(item => item.stop());
    await Promise.all(participation.map(item => item.close()));
    capabilities.close(); await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true });
  });
  return { repos, runtime, configs, clients, coordinators, tools, sends, emitted, messages, ready, deliveredEvent };
}

describe('Agent handoff A → B → A through Runtime, SQLite and both Lark coordinators', () => {
  it('queues a duplicate-safe handoff, returns the result in-thread and stops the acknowledgement loop', async () => {
    const h = await harness();
    const [a, b] = h.configs;
    await h.coordinators[0]!.handle(human('om_alice_a', 'ou_a', '请检查需求'), a!);
    const firstA = await h.ready(a!.appId, 'om_alice_a');
    await h.coordinators[1]!.handle(human('om_alice_b', 'ou_b', '先处理我这项工作'), b!);
    const firstB = await h.ready(b!.appId, 'om_alice_b');
    const handoff = await h.tools.handoff(firstA.token, { to: b!.appId, content: '核对登录需求中的权限边界', turn: firstA.turn });
    const sentAB = h.emitted.at(-1)!;
    expect(handoff.messageId).toBe(sentAB.id);
    expect(sentAB).toMatchObject({ sender: a!.appId, parentId: 'om_alice_a', inThread: true });
    expect(sentAB.text).toContain('<at user_id="ou_b">');
    expect(sentAB.text).toContain('核对登录需求中的权限边界');
    expect(h.messages.get(sentAB.id)?.sender).toMatchObject({ type: 'app', id: 'cli_a', idType: 'app_id' });
    const bEvent = h.deliveredEvent(sentAB.id, 'ou_b');
    expect(bEvent.content).toBe(JSON.stringify({ text: sentAB.text }));
    await h.coordinators[1]!.handle(bEvent, b!);
    await h.coordinators[1]!.handle(bEvent, b!);
    await vi.waitFor(async () => expect((await h.repos.config.get(`lark.inbox.${b!.appId}.${sentAB.id}`))).toContain('accepted'));
    const queuedB = (await h.runtime.getTasks(firstB.session.id)).filter(task => task.status === 'queued');
    expect(queuedB).toHaveLength(1);
    expect(h.sends.filter(send => send.agentId === 'b')).toHaveLength(1);
    h.sends.find(send => send.agentId === 'b')!.release();
    const secondB = await h.ready(b!.appId, sentAB.id);
    await vi.waitFor(() => expect(h.sends.filter(send => send.agentId === 'b')).toHaveLength(2));
    expect(h.sends.filter(send => send.agentId === 'b')[1]!.prompt).toContain('核对登录需求中的权限边界');
    expect(h.messages.get(sentAB.id)).toMatchObject({ rootId: topic.rootId, threadId: topic.threadId });
    await expect(h.tools.replyAgent(secondB.token, { content: '实质检查结果：权限边界符合需求', turn: firstB.turn }))
      .rejects.toMatchObject({ code: 'FINAL_TURN_EXPIRED' });
    const reply = await h.tools.replyAgent(secondB.token, { content: '实质检查结果：权限边界符合需求', turn: secondB.turn });
    const sentBA = h.emitted.at(-1)!;
    expect(reply.messageId).toBe(sentBA.id);
    expect(sentBA).toMatchObject({ sender: b!.appId, parentId: sentAB.id, inThread: true });
    expect(sentBA.text).toContain('<at user_id="ou_a">');
    expect(sentBA.text).toContain('实质检查结果：权限边界符合需求');
    expect(h.messages.get(sentBA.id)).toMatchObject({ rootId: topic.rootId, threadId: topic.threadId });
    await h.coordinators[0]!.handle(h.deliveredEvent(sentBA.id, 'ou_a'), a!);
    await vi.waitFor(async () => expect((await h.repos.config.get(`lark.inbox.${a!.appId}.${sentBA.id}`))).toContain('accepted'));
    expect(h.sends.filter(send => send.agentId === 'a')).toHaveLength(1);
    h.sends.find(send => send.agentId === 'a')!.release();
    const secondA = await h.ready(a!.appId, sentBA.id);
    await vi.waitFor(() => expect(h.sends.filter(send => send.agentId === 'a')).toHaveLength(2));
    const before = h.emitted.length;
    await expect(h.tools.replyAgent(secondA.token, { content: '收到', turn: secondA.turn }))
      .rejects.toMatchObject({ code: 'AGENT_REPLY_ALREADY_COMPLETED' });
    expect(h.emitted).toHaveLength(before);
    expect(h.clients.every(client => client.sendText.mock.calls.length === 0)).toBe(true);
    expect(h.emitted).toHaveLength(2);
    expect((await h.runtime.getTasks(firstA.session.id))).toHaveLength(2);
    expect((await h.runtime.getTasks(firstB.session.id))).toHaveLength(2);
    expect(h.emitted.every(item => item.inThread && item.key)).toBe(true);
  });
});
