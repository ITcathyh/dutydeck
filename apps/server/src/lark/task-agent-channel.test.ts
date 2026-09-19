// 飞书任务智能体通道的接线回归。
//
// 模块本身（task-agent.ts）有 28 条测试，但此前在生产代码里零调用方：配好 env 重启，
// 什么都不会发生。本文件锁住接线这一层——轮询、交接、失败退回、进度回写，以及
// 「合成事件不去给一条不存在的消息贴表情」。
//
// 真实 Runtime + 真实 SQLite 持久化；只有飞书出网是替身，任何用例都不触达真实接口。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { __testOnly_resetLarkTaskAgentNotices, larkTaskAgentLedgerKey, larkTaskAgentMessageId, larkTaskAgentPaths } from './task-agent.js';

const assignedTask = (guid: string, summary = '修一下登录报错') => ({
  guid, summary, description: '线上登录接口偶发 500，请定位并修复。',
  url: `https://example.feishu.cn/client/todo/detail?guid=${guid}`,
  creator: { id: 'ou_alice', name: '张明德', type: 'user' }
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
beforeEach(() => { __testOnly_resetLarkTaskAgentNotices(); vi.unstubAllEnvs(); });

async function harness(options: { tasks?: unknown[] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-taskagent-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      send: async () => {
        emit({ type: 'text', data: { text: '登录报错已修复' } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);

  const config: StoredLarkConfig = { appId: 'cli_taskagent', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock',
    permissionMode: 'ask', listening: true, fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false,
    groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
    completionReactionOnly: false, silentProgress: false, urgentEnabled: false, pinLongTasks: false,
    allowedUsers: [{ openId: 'ou_alice', name: '张明德' }], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off' };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextCard = 0;
  const cards = new Map<string, any>();
  const createCard = async (input: any) => { const id = `om_card_${++nextCard}`; cards.set(id, input); return { messageId: id }; };
  const openApiCalls: Array<{ path: string; body?: unknown }> = [];
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
    callOpenApi: vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
      openApiCalls.push({ path, body: init?.body });
      if (path.startsWith(larkTaskAgentPaths.listTasks)) return { code: 0, data: { items: options.tasks ?? [], has_more: false } };
      return { code: 0, data: {} };
    })
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinator = new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
    undefined, repos.channelMappings, async () => 'p2p', undefined, undefined, { store: repos.config });
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });

  const enable = () => {
    vi.stubEnv('LARK_TASK_AGENT_ENABLED', 'true');
    vi.stubEnv('LARK_TASK_AGENT_CHAT_ID', 'oc_dispatch');
  };
  const steps = () => openApiCalls.filter(call => call.path === larkTaskAgentPaths.appendTaskSteps)
    .flatMap(call => ((call.body as any)?.task_steps ?? []).map((step: any) => step.content as string));
  return { repos, runtime, config, coordinator, service, cards, log, openApiCalls, enable, steps };
}

describe('飞书任务智能体通道接线', () => {
  it('通道关闭时一个出网请求都不发，也不派任何活', async () => {
    const h = await harness({ tasks: [assignedTask('guid_off')] });
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(0);
    expect(h.service.callOpenApi).not.toHaveBeenCalled();
    expect(h.service.send).not.toHaveBeenCalled();
  });

  it('白名单为空时通道保持关闭，并在日志里说明原因', async () => {
    const h = await harness({ tasks: [assignedTask('guid_no_allowlist')] });
    h.enable();
    expect(await h.coordinator.pollLarkTaskDispatches({ ...h.config, allowedUsers: [], allowedEmails: [] })).toBe(0);
    expect(h.service.callOpenApi).not.toHaveBeenCalled();
    expect(h.log.warn.mock.calls.some(([, message]) => String(message).includes('发起人白名单'))).toBe(true);
  });

  it('启用后把分配给机器人的任务派成一轮真任务，并把进度写回任务记录', async () => {
    const h = await harness({ tasks: [assignedTask('guid_1')] });
    h.enable();
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(1);

    // 结果卡真的发到了配置的落地单聊。
    await vi.waitFor(() => {
      const result = [...h.cards.values()].find(card => card.cardKind === 'result');
      expect(result).toBeTruthy();
    }, { timeout: 10_000 });
    expect(h.service.send.mock.calls.every(([input]: any[]) => input.chatId === 'oc_dispatch')).toBe(true);

    // 合成事件背后没有真实消息：不去给它贴「已接收」表情，也就不制造每条任务一条 warn。
    expect(h.service.addReaction).not.toHaveBeenCalled();
    expect(h.log.warn.mock.calls.some(([, message]) => String(message).includes('确认表情'))).toBe(false);

    // 进度以任务记录写回飞书任务，终态必须在里面。
    await vi.waitFor(() => expect(h.steps().some(content => content.includes('完成'))).toBe(true), { timeout: 10_000 });
    const appended = h.openApiCalls.filter(call => call.path === larkTaskAgentPaths.appendTaskSteps);
    expect(appended.every(call => (call.body as any).task_guid === 'guid_1')).toBe(true);
    expect(appended.every(call => typeof (call.body as any).idempotent_key === 'string')).toBe(true);
  });

  it('重复轮询不重复派活：幂等键落在持久化账本上', async () => {
    const h = await harness({ tasks: [assignedTask('guid_repeat')] });
    h.enable();
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(1);
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(0);
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(0);
  });

  it('交接失败必须退回认领，下一轮重新派发，而不是把任务永久当成已派发', async () => {
    const h = await harness({ tasks: [assignedTask('guid_handoff')] });
    h.enable();
    const handle = vi.spyOn(h.coordinator, 'handle').mockRejectedValueOnce(new Error('交接失败'));
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(0);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ messageId: larkTaskAgentMessageId('guid_handoff') }), h.config);

    // 认领已退回：账本里是退回标记，而不是一条「已派发」记录。
    const ledgerKey = larkTaskAgentLedgerKey(h.config.appId, 'guid_handoff');
    expect(await h.repos.config.get(ledgerKey)).toBe('');

    handle.mockRestore();
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(1);
    await vi.waitFor(() => expect([...h.cards.values()].some(card => card.cardKind === 'result')).toBe(true), { timeout: 10_000 });
  });
});
