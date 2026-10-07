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
import { claimLarkTaskDispatches, __testOnly_resetLarkTaskAgentNotices, larkTaskAgentLedgerKey, larkTaskAgentMessageId, larkTaskAgentPaths } from './task-agent.js';

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
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot',
    undefined, repos.channelMappings, async () => 'p2p', undefined, undefined, { store: repos.config });
  const coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  cleanups.push(async () => { coordinator.stop(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });

  const enable = () => {
    vi.stubEnv('LARK_TASK_AGENT_ENABLED', 'true');
    vi.stubEnv('LARK_TASK_AGENT_CHAT_ID', 'oc_dispatch');
  };
  const steps = () => openApiCalls.filter(call => call.path === larkTaskAgentPaths.appendTaskSteps)
    .flatMap(call => ((call.body as any)?.task_steps ?? []).map((step: any) => step.content as string));
  return { repos, runtime, config, coordinator, createCoordinator, service, cards, log, openApiCalls, enable, steps };
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

  it('stopping after A releases unhanded B and a fresh coordinator handles only B', async () => {
    const h = await harness({ tasks: [assignedTask('guid_a'), assignedTask('guid_b')] });
    h.enable();
    const handle = h.coordinator.handle.bind(h.coordinator);
    vi.spyOn(h.coordinator, 'handle').mockImplementation(async (...args) => {
      await handle(...args);
      await vi.waitFor(async () => expect(JSON.parse((await h.repos.config.get(`lark.inbox.${h.config.appId}.${args[0].messageId}`))!).state).toBe('accepted'));
      h.coordinator.stop();
    });
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(1);
    expect(await h.repos.config.get(larkTaskAgentLedgerKey(h.config.appId, 'guid_b'))).toBe('');
    const restarted = h.createCoordinator();
    const nextHandle = vi.spyOn(restarted, 'handle');
    try {
      expect(await restarted.pollLarkTaskDispatches(h.config)).toBe(1);
      expect(nextHandle).toHaveBeenCalledTimes(1);
      expect(nextHandle.mock.calls[0]![0].messageId).toBe(larkTaskAgentMessageId('guid_b'));
      expect(await restarted.pollLarkTaskDispatches(h.config)).toBe(0);
      for (const guid of ['guid_a', 'guid_b']) {
        await vi.waitFor(async () => {
          const raw = await h.repos.config.get(`lark.inbox.${h.config.appId}.${larkTaskAgentMessageId(guid)}`);
          expect(JSON.parse(raw!).state).toBe('accepted');
        });
      }
    } finally { restarted.stop(); }
  });

  it('recovers old claims left before inbox handoff while preserving A already in the inbox', async () => {
    const h = await harness({ tasks: [assignedTask('guid_crash_a'), assignedTask('guid_crash_b')] });
    h.enable();
    const intake = await claimLarkTaskDispatches({ appId: h.config.appId, client: h.service, store: h.repos.config, botConfig: h.config });
    expect(intake.status).toBe('ready');
    if (intake.status !== 'ready') throw new Error('intake disabled');
    await h.coordinator.handle(intake.dispatches[0]!.event, h.config);
    // Both claims have the legacy shape; B has no inbox because the process died before handle.
    expect(JSON.parse((await h.repos.config.get(intake.dispatches[1]!.ledgerKey))!).claimedAt).toBeTruthy();
    h.coordinator.stop();
    const restarted = h.createCoordinator();
    const handle = vi.spyOn(restarted, 'handle');
    try {
      expect(await restarted.pollLarkTaskDispatches(h.config)).toBe(1);
      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle.mock.calls[0]![0].messageId).toBe(larkTaskAgentMessageId('guid_crash_b'));
      expect(await restarted.pollLarkTaskDispatches(h.config)).toBe(0);
    } finally { restarted.stop(); }
  });

  it('does not steal another coordinator claim while its inbox handoff is in flight', async () => {
    const h = await harness({ tasks: [assignedTask('guid_inflight')] });
    h.enable();
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const handle = h.coordinator.handle.bind(h.coordinator);
    const firstHandle = vi.spyOn(h.coordinator, 'handle').mockImplementation(async (...args) => { await gate; await handle(...args); });
    const first = h.coordinator.pollLarkTaskDispatches(h.config);
    await vi.waitFor(() => expect(firstHandle).toHaveBeenCalledTimes(1));
    const other = h.createCoordinator();
    const otherHandle = vi.spyOn(other, 'handle');
    try {
      expect(await other.pollLarkTaskDispatches(h.config)).toBe(0);
      expect(otherHandle).not.toHaveBeenCalled();
    } finally { resume(); other.stop(); }
    expect(await first).toBe(1);
  });

  it('reclaims a prior process claim only when it has no durable inbox receipt', async () => {
    const h = await harness({ tasks: [assignedTask('guid_previous_boot')] });
    h.enable();
    const key = larkTaskAgentLedgerKey(h.config.appId, 'guid_previous_boot');
    await h.repos.config.set(key, JSON.stringify({ taskGuid: 'guid_previous_boot',
      messageId: larkTaskAgentMessageId('guid_previous_boot'), claimedAt: new Date().toISOString(), boot: 'previous-process' }));
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(1);
    const current = JSON.parse((await h.repos.config.get(key))!);
    expect(current.boot).not.toBe('previous-process');
    // Simulate another restart after successful handoff: the older owner must not cause redispatch.
    await h.repos.config.set(key, JSON.stringify({ ...current, boot: 'previous-process' }));
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(0);
  });

  it('releases a partial batch when persistent claiming fails before handoff', async () => {
    const h = await harness({ tasks: [assignedTask('guid_partial_a'), assignedTask('guid_partial_b')] });
    h.enable();
    const compareAndSet = h.repos.config.compareAndSet!.bind(h.repos.config);
    const claim = vi.spyOn(h.repos.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
      if (key === larkTaskAgentLedgerKey(h.config.appId, 'guid_partial_b')) throw new Error('claim write failed');
      return compareAndSet(key, expected, value);
    });
    await expect(h.coordinator.pollLarkTaskDispatches(h.config)).rejects.toThrow('claim write failed');
    expect(await h.repos.config.get(larkTaskAgentLedgerKey(h.config.appId, 'guid_partial_a'))).toBe('');
    claim.mockRestore();
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(2);
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

describe('飞书任务指派人变更事件触发即时认领', () => {
  it('收到含 task_assignees_update 的事件后立即走认领流程，不必等轮询', async () => {
    const h = await harness({ tasks: [assignedTask('guid_event_1')] });
    h.enable();
    h.coordinator.handleTaskAssigneesUpdate(h.config);
    await vi.waitFor(() => {
      expect([...h.cards.values()].some(card => card.cardKind === 'result')).toBe(true);
    }, { timeout: 10_000 });
    // 认领查询确实被事件触发（此前没有任何轮询调用过出网）。
    expect(h.openApiCalls.some(call => call.path.startsWith(larkTaskAgentPaths.listTasks))).toBe(true);
  });

  it('重复事件不重复认领：同一任务只交接一次', async () => {
    const h = await harness({ tasks: [assignedTask('guid_event_repeat')] });
    h.enable();
    const handle = vi.spyOn(h.coordinator, 'handle');
    for (let i = 0; i < 3; i += 1) h.coordinator.handleTaskAssigneesUpdate(h.config);
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(handle).toHaveBeenNthCalledWith(1, expect.objectContaining({ messageId: larkTaskAgentMessageId('guid_event_repeat') }), h.config);
  });

  it('通道未激活时事件不发出网请求', async () => {
    const h = await harness({ tasks: [assignedTask('guid_event_off')] });
    h.coordinator.handleTaskAssigneesUpdate(h.config);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.service.callOpenApi).not.toHaveBeenCalled();
  });
});

