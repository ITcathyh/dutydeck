// Agent 代用户发飞书命令（dutydeck command）：查看类直接出结果卡，会改东西的先发确认卡，点「确认」后以点击人身份执行。
// 真实 DutydeckRuntime + SQLite + 真实确认卡，飞书接口用替身。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { larkBotsConfigKey, readLarkConfig, type StoredLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard } from './service.js';
import { LarkConfirmCards } from './confirm-cards.js';
import { agentCommandHelp, agentCommandPlan } from './agent-command.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string, mentions: LarkMessageEvent['mentions'] = []): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }, ...mentions]
});

async function harness() {
  const state = await mkdtemp(join(tmpdir(), 'dutydeck-lark-agent-command-'));
  const repos = createRepositories(join(state, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isStopped: async () => true,
      send: async prompt => {
        prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
        emit({ type: 'text', data: { text: `第 ${prompts.length} 轮做完了` } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: state, env: {},
    permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const config: StoredLarkConfig = { appId: 'cli_agent_command', appSecret: 'fake-secret', name: 'Dock', workspace: state, defaultAgentId: 'mock',
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    completionReactionOnly: false, silentProgress: false, urgentEnabled: false, pinLongTasks: false,
    allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }] as any, allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextMessage = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextMessage}`; cards.set(id, input); return { messageId: id }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    replyText: vi.fn(async () => ({ messageId: `om_echo_${++nextMessage}` })),
    uploadFile: vi.fn(async () => 'file_1'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.set(input.messageId, input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string, emojiType = 'OK') => ({ messageId, reactionId: `r_${messageId}_${emojiType}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_mallory' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessageItems: vi.fn(async () => [] as any[])
  };
  const confirmations = new LarkConfirmCards({ repository: repos.collaboration, readConfig: appId => readLarkConfig(repos.config, appId), serviceFor: () => service as any });
  const participation = { confirmations, mode: async () => 'off', handle: async () => ({ handled: false, enabled: false }), guardBotTurn: async () => undefined,
    taskContext: async () => undefined, instructions: async () => '', describe: async () => undefined } as any;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
    undefined, repos.channelMappings, async () => 'group', undefined, undefined, { store: repos.config, participation });
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config, 60_000);
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(state, { recursive: true, force: true }); });
  const result = (taskId: string) => vi.waitFor(async () => {
    const mapping = await repos.channelMappings.get(`lark-card:${config.appId}`, taskId);
    const saved = { sessionId: mapping!.sessionId, ...JSON.parse(mapping!.extra!) as PersistedLarkCardTask };
    expect(saved.final_message_id).toBeTruthy();
    return saved;
  }, { timeout: 10_000 });
  // 跑完一轮普通请求，Agent 在这一轮里代发命令。
  const turn = async (request = event('om_1', '帮我看看'), command: string) => {
    if (!await repos.channelMappings.get(`lark-card:${config.appId}`, request.messageId)) await coordinator.handle(request, config);
    const saved = await result(request.messageId);
    return coordinator.agentCommand({ sessionId: saved.sessionId, taskId: saved.runtime_task_id!, actorId: 'ou_alice', command });
  };
  const repliesTo = (messageId: string) => service.reply.mock.calls.map(call => call[0]).filter(input => input.messageId === messageId);
  return { repos, config, service, cards, prompts, coordinator, result, turn, repliesTo };
}

const findElement = (node: unknown, id: string): Record<string, any> | undefined => {
  if (Array.isArray(node)) { for (const item of node) { const found = findElement(item, id); if (found) return found; } return undefined; }
  if (!node || typeof node !== 'object') return undefined;
  const record = node as Record<string, any>;
  if (record.element_id === id) return record;
  for (const value of Object.values(record)) { const found = findElement(value, id); if (found) return found; }
  return undefined;
};

describe('Agent 代发飞书命令', () => {
  it('分出哪些直接执行、哪些先确认、哪些只能由用户做', () => {
    expect(agentCommandPlan('/status').confirm).toBe(false);
    expect(agentCommandPlan('/queue').confirm).toBe(false);
    expect(agentCommandPlan('/pr 修复登录').confirm).toBe(false);
    expect(agentCommandPlan('/queue cancel 2').confirm).toBe(true);
    expect(agentCommandPlan('/new --agent codex -- 修复登录').confirm).toBe(true);
    expect(agentCommandPlan('/schedule disable sch_1').confirm).toBe(true);
    for (const command of ['/stop', '/cancel', '/approve req_1', '/answer q_1 好', '/remember x']) {
      expect(() => agentCommandPlan(command)).toThrow(expect.objectContaining({ code: 'AGENT_COMMAND_USER_ONLY' }));
    }
    expect(() => agentCommandPlan('/schedule every 15 看看')).toThrow(expect.objectContaining({ code: 'AGENT_COMMAND_UNSUPPORTED' }));
    expect(() => agentCommandPlan('/foo')).toThrow(expect.objectContaining({ code: 'AGENT_COMMAND_UNKNOWN' }));
    expect(() => agentCommandPlan('看看状态')).toThrow(expect.objectContaining({ code: 'AGENT_COMMAND_UNKNOWN' }));
    expect(agentCommandHelp()).toContain('/new');
    expect(agentCommandHelp()).not.toContain('/cancel');
  });

  it('查看类以发起人身份直接执行，结果卡回在这一轮的请求消息下', async () => {
    const h = await harness();
    expect(await h.turn(undefined, '/status')).toMatchObject({ executed: true });
    expect(h.repliesTo('om_1').map(input => input.taskName)).toContain('任务状态');
    expect(h.prompts).toHaveLength(1);
  });

  it('/new 先发确认卡；没权限的人点被拒，发起人点确认后在新会话里执行，新一轮挂在确认卡下', async () => {
    const h = await harness();
    const first = await h.result((await h.coordinator.handle(event('om_1', '帮我看看'), h.config), 'om_1'));
    expect(await h.turn(undefined, '/new --agent mock -- 重新从头查一遍')).toMatchObject({ pendingConfirmation: true });
    const confirmCall = h.repliesTo('om_1').find(input => input.taskName === '待确认的操作')!;
    expect(confirmCall).toMatchObject({ replyInThread: true, statusLabel: '待确认' });
    expect(findElement(buildLarkCard(confirmCall), 'confirm_body')!.content).toContain('`/new --agent mock -- 重新从头查一遍`');
    const confirmCardId = [...h.cards].find(([, input]) => input === confirmCall)![0];
    // 同一轮里重复调用不再发第二张。
    await h.turn(undefined, '/new --agent mock -- 重新从头查一遍');
    expect(h.repliesTo('om_1').filter(input => input.taskName === '待确认的操作')).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);

    const value = findElement(buildLarkCard(confirmCall), 'confirm_confirm')!.behaviors[0].value;
    expect(await h.coordinator.handleAction(value, 'ou_mallory', { messageId: confirmCardId, chatId: 'oc_group' }))
      .toMatchObject({ type: 'warning', content: '只有发起人或有权限的人能确认。' });
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: confirmCardId, chatId: 'oc_group' }))
      .toMatchObject({ type: 'success', content: expect.stringContaining('已确认执行 /new') });
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2), { timeout: 10_000 });
    expect(h.prompts[1]).toContain('重新从头查一遍');
    const next = await h.result(confirmCardId);
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(h.service.update.mock.calls.map(call => call[0]).find(input => input.messageId === confirmCardId)).toMatchObject({ statusLabel: '已确认' });
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: confirmCardId, chatId: 'oc_group' })).toMatchObject({ content: '这张卡已经处理过了。' });
  });

  it('点取消不执行；Agent 编号填错、找不到这一轮时直接报错给 Agent；/grant 带上用户消息里 @ 过的成员', async () => {
    const h = await harness();
    await expect(h.turn(undefined, '/new --agent nope -- 重做')).rejects.toMatchObject({ code: 'AGENT_COMMAND_INVALID', message: expect.stringContaining('mock（Mock）') });
    await expect(h.coordinator.agentCommand({ sessionId: 'ses_unknown', taskId: 'task_x', actorId: 'ou_alice', command: '/status' })).rejects.toMatchObject({ code: 'AGENT_COMMAND_ORIGIN_MISSING' });

    expect(await h.turn(undefined, '/new')).toMatchObject({ pendingConfirmation: true });
    const confirmCall = h.repliesTo('om_1').find(input => input.taskName === '待确认的操作')!;
    const confirmCardId = [...h.cards].find(([, input]) => input === confirmCall)![0];
    const cancel = findElement(buildLarkCard(confirmCall), 'confirm_cancel')!.behaviors[0].value;
    expect(await h.coordinator.handleAction(cancel, 'ou_alice', { messageId: confirmCardId, chatId: 'oc_group' })).toMatchObject({ content: '已取消，没有改动。' });
    expect(h.service.update.mock.calls.map(call => call[0]).find(input => input.messageId === confirmCardId)).toMatchObject({ statusLabel: '已取消' });
    expect(h.repliesTo(confirmCardId)).toHaveLength(0);

    const grantRequest = event('om_2', '给 @_user_2 开权限', [{ key: '@_user_2', name: 'Bob', openId: 'ou_bob' }]);
    expect(await h.turn(grantRequest, '/grant @Bob')).toMatchObject({ pendingConfirmation: true });
    const actions = await h.repos.collaboration.listActions({ appId: h.config.appId, chatId: 'oc_group' });
    const grant = actions.find(action => (action.payload as any).payload?.command === '/grant @Bob')!;
    expect(JSON.parse((grant.payload as any).payload.mentions)).toEqual([{ key: '@_user_2', name: 'Bob', openId: 'ou_bob' }]);
  });
});
