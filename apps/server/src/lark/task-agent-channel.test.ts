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

async function harness(options: { tasks?: unknown[]; completionReactionOnly?: boolean; holdTurn?: Promise<void>; holdList?: Promise<void> } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-taskagent-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      send: async () => {
        await options.holdTurn;
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
    completionReactionOnly: options.completionReactionOnly === true, silentProgress: false, urgentEnabled: false, pinLongTasks: false,
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
      if (path.startsWith(larkTaskAgentPaths.listTasks)) {
        await options.holdList;
        return { code: 0, data: { items: options.tasks ?? [], has_more: false } };
      }
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
    const empty = { ...h.config, allowedUsers: [], allowedEmails: [] };
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([empty]));
    expect(await h.coordinator.pollLarkTaskDispatches(empty)).toBe(0);
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

// 任务通道没有可贴表情的原消息：结果卡在实时发出前进程退出，重启补发也必须照常发卡，开了「完成时只贴表情」也一样。
describe('任务通道的结果在重启补发时送达', () => {
  it.each([false, true])('结果卡发出前重启，补发把结果送到落地单聊且只发一次（completionReactionOnly: %s）', async completionReactionOnly => {
    let finish!: () => void;
    const h = await harness({ tasks: [assignedTask('guid_restart')], completionReactionOnly, holdTurn: new Promise<void>(resolve => { finish = resolve; }) });
    h.enable();
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(1);
    const runtimeTask = async () => {
      const [session] = await h.runtime.listSessions();
      return session ? (await h.runtime.getTasks(session.id))[0] : undefined;
    };
    const mappings = () => h.repos.channelMappings.list(`lark-card:${h.config.appId}`);
    await vi.waitFor(async () => {
      expect((await runtimeTask())?.status).toBe('running');
      expect(await mappings()).toHaveLength(1);
    }, { timeout: 10_000 });
    h.coordinator.stop();
    finish();
    await vi.waitFor(async () => expect((await runtimeTask())?.status).toBe('completed'), { timeout: 10_000 });
    const results = () => [...h.cards.values()].filter(card => card.cardKind === 'result');
    expect(results()).toEqual([]);

    const restored = h.createCoordinator();
    try {
      await restored.initializeWorkflows(h.config);
      await restored.startReconciliation(h.config);
      await vi.waitFor(() => expect(results()).toHaveLength(1), { timeout: 10_000 });
      expect(results()[0]).toMatchObject({ state: 'completed' });
      expect(JSON.stringify(results()[0].elements)).toContain('登录报错已修复');
      expect(h.service.send.mock.calls.every(([input]: any[]) => input.chatId === 'oc_dispatch')).toBe(true);
      expect(h.service.addReaction).not.toHaveBeenCalled();
      expect(JSON.parse((await mappings())[0]!.extra!)).toMatchObject({ final_delivery_state: 'delivered' });
      await restored.reconcile(h.config);
      expect(results()).toHaveLength(1);
    } finally { restored.stop(); }
  });
});

// 定时器与事件回调带的是启动或上次热更新时的配置；通道开关和白名单门必须按当前保存的配置判断。
describe('运行中修改白名单与监听后，任务通道按当前配置开关', () => {
  const bobTask = () => ({ ...assignedTask('guid_bob', 'Bob 的任务'), creator: { id: 'ou_bob', name: 'Bob', type: 'user' } });
  const saveConfig = (h: Awaited<ReturnType<typeof harness>>, patch: Partial<StoredLarkConfig>) =>
    h.repos.config.set(larkBotsConfigKey, JSON.stringify([{ ...h.config, ...patch }]));
  const listCalls = (h: Awaited<ReturnType<typeof harness>>) => h.openApiCalls.filter(call => call.path.startsWith(larkTaskAgentPaths.listTasks));
  const pollEvery = (h: Awaited<ReturnType<typeof harness>>, ms: number) => {
    (h.coordinator as unknown as { taskAgentIntervalMs: number }).taskAgentIntervalMs = ms;
  };

  it('清空白名单后，仍带旧名单的定时轮询不再认领，名单外的人指派的任务不会执行', async () => {
    const h = await harness({ tasks: [bobTask()] });
    h.enable();
    pollEvery(h, 20);
    await saveConfig(h, { allowedUsers: [], allowedEmails: [] });
    const bobInbox = () => h.repos.config.get(`lark.inbox.${h.config.appId}.${larkTaskAgentMessageId('guid_bob')}`);
    const closedNotice = () => h.log.warn.mock.calls.some(([, message]) => String(message).includes('发起人白名单'));
    // 定时器按启动时的旧名单（只有 Alice）布下。
    await h.coordinator.startReconciliation(h.config);
    await vi.waitFor(async () => expect(closedNotice() || Boolean(await bobInbox())).toBe(true), { timeout: 2_000 });
    h.coordinator.handleTaskAssigneesUpdate(h.config);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await bobInbox()).toBeUndefined();
    expect(await h.runtime.listSessions()).toEqual([]);
    expect(await h.repos.config.get(larkTaskAgentLedgerKey(h.config.appId, 'guid_bob'))).toBeUndefined();
    expect(listCalls(h)).toEqual([]);
    expect(closedNotice()).toBe(true);
  });

  it('原本没有白名单，运行中补上后不用重启就开始接单', async () => {
    const h = await harness({ tasks: [assignedTask('guid_after_allowlist')] });
    h.enable();
    pollEvery(h, 20);
    const empty = { ...h.config, allowedUsers: [], allowedEmails: [] };
    await saveConfig(h, empty);
    await h.coordinator.startReconciliation(empty);
    await vi.waitFor(() => expect(h.log.warn.mock.calls.some(([, message]) => String(message).includes('发起人白名单'))).toBe(true), { timeout: 2_000 });
    expect(listCalls(h)).toEqual([]);
    await saveConfig(h, {});
    await vi.waitFor(() => expect([...h.cards.values()].some(card => card.cardKind === 'result')).toBe(true), { timeout: 10_000 });
    expect(h.service.send.mock.calls.every(([input]: any[]) => input.chatId === 'oc_dispatch')).toBe(true);
  });

  it('白名单换人照常生效：旧成员的任务被拒绝不执行，新成员的任务正常执行', async () => {
    const h = await harness({ tasks: [assignedTask('guid_alice_old'), { ...assignedTask('guid_carol', 'Carol 的任务'), creator: { id: 'ou_carol', name: 'Carol', type: 'user' } }] });
    h.enable();
    await saveConfig(h, { allowedUsers: [{ openId: 'ou_carol', name: 'Carol' }] });
    const handle = vi.spyOn(h.coordinator, 'handle');
    // 调用方仍带旧名单（Alice）。
    await h.coordinator.pollLarkTaskDispatches(h.config);
    expect(handle).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      const raw = await h.repos.config.get(`lark.inbox.${h.config.appId}.${larkTaskAgentMessageId('guid_alice_old')}`);
      expect(JSON.parse(raw!).state).toBe('failed');
    });
    await vi.waitFor(() => expect([...h.cards.values()].some(card => card.cardKind === 'result')).toBe(true), { timeout: 10_000 });
    const sessions = await h.runtime.listSessions();
    expect(sessions).toHaveLength(1);
    const tasks = await h.runtime.getTasks(sessions[0]!.id);
    expect(tasks.map(task => task.prompt)).toEqual([expect.stringContaining('Carol 的任务')]);
  });

  it('停止监听后既不查询也不认领；协调器停止后定时器不再轮询', async () => {
    const h = await harness({ tasks: [assignedTask('guid_paused')] });
    h.enable();
    await saveConfig(h, { listening: false });
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(0);
    expect(listCalls(h)).toEqual([]);
    expect(await h.repos.config.get(larkTaskAgentLedgerKey(h.config.appId, 'guid_paused'))).toBeUndefined();

    await saveConfig(h, {});
    pollEvery(h, 20);
    await h.coordinator.startReconciliation(h.config);
    h.coordinator.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(listCalls(h)).toEqual([]);
    expect(await h.runtime.listSessions()).toEqual([]);
  });

  // 认领前的门只看到这一轮开始时的设置。任务列表请求在途、或认领后交给消息处理之前改了设置，
  // 交接时按当时的设置再判一次；通道已关的任务不能落进普通私聊「空名单对所有人开放」。
  const runs = async (h: Awaited<ReturnType<typeof harness>>) =>
    (await Promise.all((await h.runtime.listSessions()).map(session => h.runtime.getTasks(session.id)))).flat();
  const bobInbox = async (h: Awaited<ReturnType<typeof harness>>) => {
    const raw = await h.repos.config.get(`lark.inbox.${h.config.appId}.${larkTaskAgentMessageId('guid_bob')}`);
    return raw ? JSON.parse(raw) : undefined;
  };
  const bobLedger = (h: Awaited<ReturnType<typeof harness>>) => h.repos.config.get(larkTaskAgentLedgerKey(h.config.appId, 'guid_bob'));
  /** list：任务列表请求在途时改设置；handoff：认领完成、交给消息处理之前改设置。轮询带的仍是旧名单（Alice）。 */
  const changeDuringPoll = async (boundary: 'list' | 'handoff', patch: Partial<StoredLarkConfig>) => {
    let releaseList!: () => void;
    const h = await harness({ tasks: [bobTask()], holdList: new Promise<void>(resolve => { releaseList = resolve; }) });
    h.enable();
    if (boundary === 'handoff') {
      releaseList();
      const handle = h.coordinator.handle.bind(h.coordinator);
      vi.spyOn(h.coordinator, 'handle').mockImplementationOnce(async (...args) => { await saveConfig(h, patch); return handle(...args); });
    }
    const poll = h.coordinator.pollLarkTaskDispatches(h.config);
    if (boundary === 'list') {
      await vi.waitFor(() => expect(listCalls(h)).toHaveLength(1));
      await saveConfig(h, patch);
      releaseList();
    }
    return { h, dispatched: await poll };
  };

  it.each(['list', 'handoff'] as const)('清空名单发生在 %s 边界：认领退回、不建入站记录，Bob 的任务不执行；重新开放后照常派发且只执行一次', async boundary => {
    const { h, dispatched } = await changeDuringPoll(boundary, { allowedUsers: [], allowedEmails: [] });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await runs(h)).toEqual([]);
    expect(await bobInbox(h)).toBeUndefined();
    expect(await bobLedger(h)).toBe('');
    expect(dispatched).toBe(0);

    // 被拦下的任务没有被吞掉：通道重新开放（这次名单里有 Bob）后照常派发，重复轮询不再执行。
    await saveConfig(h, { allowedUsers: [{ openId: 'ou_bob', name: 'Bob' }] });
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(1);
    await vi.waitFor(async () => expect((await runs(h)).map(task => task.status)).toEqual(['completed']), { timeout: 10_000 });
    expect(await h.coordinator.pollLarkTaskDispatches(h.config)).toBe(0);
    expect(await runs(h)).toHaveLength(1);
  });

  it('列表请求在途时停止监听：认领退回、不执行', async () => {
    const { h, dispatched } = await changeDuringPoll('list', { listening: false });
    expect(dispatched).toBe(0);
    expect(await bobInbox(h)).toBeUndefined();
    expect(await bobLedger(h)).toBe('');
    expect(await runs(h)).toEqual([]);
  });

  it.each([
    ['名单不变', {}],
    ['名单换成 Carol', { allowedUsers: [{ openId: 'ou_carol', name: 'Carol' }] }]
  ])('列表请求在途时%s：Bob 照常被白名单拒绝、不执行', async (_name, patch) => {
    const { h } = await changeDuringPoll('list', patch);
    await vi.waitFor(async () => expect((await bobInbox(h))?.state).toBe('failed'));
    expect(await runs(h)).toEqual([]);
  });

  it('普通私聊的空名单仍对所有人开放：名单清空后 Bob 直接私聊照常执行', async () => {
    const h = await harness();
    h.enable();
    await saveConfig(h, { allowedUsers: [], allowedEmails: [] });
    await h.coordinator.handle({ messageId: 'om_dm_bob', chatId: 'oc_dm_bob', chatType: 'p2p', messageType: 'text',
      content: JSON.stringify({ text: '帮我看看登录报错' }), senderOpenId: 'ou_bob', senderType: 'user', mentions: [] }, h.config);
    await vi.waitFor(async () => expect((await runs(h)).map(task => task.status)).toEqual(['completed']), { timeout: 10_000 });
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

