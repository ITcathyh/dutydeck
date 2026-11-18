// 排队、插话与中断的协调器级回归：排队卡上的插队按钮与审批提示、同一人连发的合并、
// /new /cancel /stop /steer /queue 与卡片按钮统一的中断口径、升级排空期间的排队说明。
//
// 与 chat-commands.test.ts 同样接真实 DutydeckRuntime + SQLite，只把飞书网络层换成内存桩：
// 这些行为的价值全在「真的改了队列、真的中断了那一轮」，只 mock runtime 的测试证明不了。
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../tests/support/fast-wait-for.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { buildLarkCard } from './service.js';
import { steeringOutcomeText } from './card-renderer.js';
import { larkResultKey, larkSilentResultAnchor } from './result-delivery.js';
import { LarkTaskInbox, type LarkInboxRecord } from './task-inbox.js';
import { pendingPromptUsageKey } from './prompt-versions.js';
import { readTaskAuthorization } from '../task-authorization.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkInteraction } from './workflow-interactions.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const event = (id: string, text: string, patch: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: id, chatId: 'oc_group', chatType: 'group', threadId: 'omt_topic', rootId: 'om_root',
  senderOpenId: 'ou_alice', senderType: 'user', messageType: 'text', content: JSON.stringify({ text }),
  mentions: [{ key: '@_user_1', name: 'Dock', openId: 'ou_bot' }], ...patch
});

/** 白名单里登记了显示名：拒绝文案据此写出发起人是谁。 */
const named: Partial<StoredLarkConfig> = { allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }, { openId: 'ou_bob', name: 'Bob' }] };

async function harness(options: { configPatch?: Partial<StoredLarkConfig>; steer?: AgentDriver['steer']; permissionPrompt?: string; automation?: unknown; hold?: (prompt: string) => Promise<void> | undefined } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-queue-steer-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  let release: (() => void) | undefined;
  const gate = new Promise<void>(done => { release = done; });
  const prompts: string[] = [];
  const resolvePermission = vi.fn();
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => {
      // 每一轮一个序号：被中断的那一轮不能再替后面的轮次报完成。中断时立刻结束这一轮的 send。
      let current = 0;
      let approval: (() => void) | undefined;
      let abort: (() => void) | undefined;
      let stopped = false;
      const cancel = () => { current++; abort?.(); abort = undefined; emit({ type: 'completed', data: { stopReason: 'cancelled' } }); };
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {},
        // /new 结束旧会话要确认执行进程真的退出了。
        stop: async () => { stopped = true; cancel(); }, isStopped: async () => stopped, interrupt: async () => cancel(),
        send: async prompt => {
          const mine = ++current;
          prompts.push(prompt);
          const aborted = new Promise<void>(done => { abort = done; });
          if (options.permissionPrompt && prompt.includes(options.permissionPrompt)) {
            emit({ type: 'permission_request', data: { id: 'native_permission', title: '修改 config/app.yaml', status: 'pending', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } });
            await Promise.race([new Promise<void>(done => { approval = done; }), aborted]);
            if (mine !== current) return;
          }
          // 所有轮次默认挂在同一道闸门上，后续消息才会真的排队；按轮次覆盖可构造 A→B 翻页竞态。
          await Promise.race([options.hold?.(prompt) ?? gate, aborted]);
          if (mine !== current) return;
          emit({ type: 'text', data: { text: '已处理。' } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        },
        resolvePermission: async (id, approved) => {
          resolvePermission(id, approved);
          emit({ type: 'permission_request', data: { id, title: '修改 config/app.yaml', status: approved ? 'approved' : 'rejected', options: [{ id: 'once', label: '一次', kind: 'allow_once' }] } });
          approval?.(); approval = undefined;
          return true;
        },
        ...(options.steer ? { steer: options.steer } : {})
      };
      return driver;
    }
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock Agent', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const steerQueued = vi.spyOn(runtime, 'steerQueued');

  const config: StoredLarkConfig = { appId: 'cli_queue', appSecret: 'fake-secret', workspace: cwd, defaultAgentId: 'mock', permissionMode: 'ask', listening: true,
    fullTrustConfirmed: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false,
    pushIntervalMs: 1_000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off', ...options.configPatch };
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));

  let nextCard = 0;
  const cards: any[] = [];
  const createCard = async (input: any) => { cards.push(input); return { messageId: `om_card_${++nextCard}` }; };
  const service = {
    send: vi.fn(createCard), reply: vi.fn(createCard),
    uploadFile: vi.fn(async () => 'file_x'), replyFile: vi.fn(createCard), sendFile: vi.fn(createCard),
    update: vi.fn(async (input: any) => { cards.push(input); return { messageId: input.messageId }; }),
    addReaction: vi.fn(async (messageId: string) => ({ messageId, reactionId: `reaction_${messageId}` })),
    deleteReaction: vi.fn(async () => {}), getUserEmails: vi.fn(async () => [] as string[]),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }, { memberId: 'ou_bob' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [] as any[], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', messageType: 'text', rawContent: '{"text":""}', sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => [] as any[]),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array(), contentType: 'text/plain' })),
    readDocument: vi.fn(async (url: string) => ({ url, title: '', text: '' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const createCoordinator = () => new LarkMessageCoordinator(runtime, service as any, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined,
    { store: repos.config, ...(options.automation ? { automation: options.automation as any } : {}) });
  const coordinator = createCoordinator();
  await coordinator.initializeWorkflows(config);
  await coordinator.startReconciliation(config);
  const restarted: LarkMessageCoordinator[] = [];
  cleanups.push(async () => { coordinator.stop(); for (const item of restarted) item.stop(); release?.(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  /** 模拟服务重启：旧协调器停下（手上没做完的就此作废），新协调器从持久化状态恢复。runtime 与数据库沿用。 */
  const restart = async () => {
    coordinator.stop();
    const next = createCoordinator();
    restarted.push(next);
    await next.initializeWorkflows(config);
    await next.startReconciliation(config);
    return next;
  };

  const markdownOf = (card: any) => String(card?.markdown ?? '') + JSON.stringify(card?.elements ?? []);
  const receiptNamed = (taskName: string) => cards.filter(card => card.readOnly === true && card.taskName === taskName).at(-1);
  /** 某条消息的任务卡最新一版（首卡、派发后的排队 PATCH、心跳帧都算）。 */
  const latestCard = (taskId: string) => cards.filter(card => card.taskId === taskId && !card.taskName?.startsWith('/')).at(-1);
  /** 按渲染后的卡片取操作区按钮文案，顺序即卡上的顺序。 */
  const buttonsOf = (card: any) => {
    const labels: string[] = [];
    const walk = (node: any) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        if (node.tag === 'button' && node.behaviors?.some((behavior: any) => behavior.type === 'callback' && behavior.value?.action)) labels.push(node.text?.content);
        Object.values(node).forEach(walk);
      }
    };
    walk(buildLarkCard(card));
    return labels;
  };
  /** 等某条排队卡出现指定文字，返回那一版。 */
  const waitCard = (taskId: string, text: string) => vi.waitFor(() => {
    const found = cards.filter(card => card.taskId === taskId && markdownOf(card).includes(text)).at(-1);
    if (!found) throw new Error(`${taskId} 的卡片没有出现「${text}」`);
    return found;
  }, { timeout: 6_000, interval: 50 });
  const dispatch = async (id: string, text: string, senderOpenId = 'ou_alice', patch: Partial<LarkMessageEvent> = {}) => {
    await coordinator.handle(event(id, text, { senderOpenId, ...patch }), config);
    await vi.waitFor(async () => {
      const [session] = await runtime.listSessions();
      expect((await runtime.getTasks(session!.id)).some(task => task.prompt.includes(text))).toBe(true);
    });
  };
  const sessionId = async () => (await runtime.listSessions())[0]!.id;
  const runtimeTask = async (text: string) => (await runtime.getTasks(await sessionId())).find(task => task.prompt.includes(text));
  const interactions = async () => (await repos.config.list!(`lark.interaction.${config.appId}.`)).map(row => JSON.parse(row.value) as LarkInteraction);
  const task = (id: string) => (coordinator as any).tasks.get(id);
  const inboxRecord = async (id: string) => {
    const raw = await repos.config.get(`lark.inbox.${config.appId}.${id}`);
    return raw ? JSON.parse(raw) as LarkInboxRecord : undefined;
  };
  return { repos, runtime, config, coordinator, service, cards, prompts, steerQueued, resolvePermission, markdownOf, receiptNamed, latestCard, buttonsOf, waitCard,
    dispatch, sessionId, runtimeTask, interactions, task, inboxRecord, restart, release: () => release?.() };
}

const promoteLabel = '中断当前这一轮，先做这条';
const injectLabel = '插进当前这一轮';
const legacyInjectedNote = '已把这条内容送进正在执行的这一轮，Agent 会在这一轮里接着处理，回复出现在那一轮的结果里。';
const pendingInjectedNote = '已送进正在执行的这一轮；这一轮还有审批没处理，Agent 有没有读到以它后续的回复为准。';
const unknownInjectedNote = '已送进正在执行的这一轮；审批状态暂时没读到，Agent 有没有读到以后续回复为准。';

describe('排队卡：紧排在正在执行的那一轮后面', () => {
  it('接受后的排队 PATCH 失败仍保留任务归属，之后正常交付独立结果', async () => {
    const h = await harness();
    await h.dispatch('om_1', '先处理第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    const update = h.service.update.getMockImplementation()!;
    let failed = false;
    h.service.update.mockImplementation(async input => {
      if (input.taskId === 'om_2' && input.state === 'queued' && !failed) { failed = true; throw new Error('PATCH unavailable'); }
      return update(input);
    });
    await h.dispatch('om_2', '再处理第二件事', 'ou_bob');
    expect(failed).toBe(true);
    const queued = (await h.runtimeTask('再处理第二件事'))!;
    expect(queued.status).toBe('queued');
    expect(await h.inboxRecord('om_2')).toMatchObject({ state: 'accepted', taskId: queued.id });
    const mapping = () => h.repos.channelMappings.get(`lark-card:${h.config.appId}`, 'om_2');
    expect(JSON.parse((await mapping())!.extra!)).toMatchObject({ runtime_task_id: queued.id, state: 'queued' });
    h.release();
    await vi.waitFor(async () => expect(JSON.parse((await mapping())!.extra!)).toMatchObject({
      runtime_task_id: queued.id, state: 'completed', final_delivery_state: 'delivered', progress_frozen: true
    }));
    const saved = JSON.parse((await mapping())!.extra!);
    expect(saved.final_message_id).not.toBe(saved.card_message_id);
    expect(h.prompts.filter(prompt => prompt.includes('再处理第二件事'))).toHaveLength(1);
  });

  it('写明不会传给正在执行的那一轮，并给出中断与插话两个按钮；排在别的排队项后面不给', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事', 'ou_bob');
    await h.dispatch('om_3', '第三件事');
    const second = await h.waitCard('om_2', '要等当前这一轮结束才会处理，不会传给它');
    expect(h.buttonsOf(second)).toEqual(['取消', promoteLabel, injectLabel, '刷新']);
    const third = await vi.waitFor(() => {
      const card = h.latestCard('om_3');
      expect(card?.state).toBe('queued');
      return card;
    });
    expect(h.markdownOf(third)).not.toContain('不会传给它');
    expect(h.buttonsOf(third)).toEqual(['取消', '刷新']);
    expect(h.steerQueued).not.toHaveBeenCalled();
  });

  it('运行时不支持插话时只给中断按钮', async () => {
    const h = await harness();
    (h.runtime as any).injectQueued = undefined;
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事');
    const second = await h.waitCard('om_2', '不会传给它');
    expect(h.buttonsOf(second)).toEqual(['取消', promoteLabel, '刷新']);
  });

  it('叫停类的话把中断按钮排到最前，但不自动中断', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '先停一下！别改数据库了');
    const second = await h.waitCard('om_2', '不会传给它');
    expect(h.buttonsOf(second)[0]).toBe(promoteLabel);
    expect(h.steerQueued).not.toHaveBeenCalled();
    expect((await h.runtimeTask('第一件事'))?.status).toBe('running');
  });

  it('点「中断当前这一轮，先做这条」：提到队首并中断正在执行的那一轮，结果写回卡片', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '换个方向');
    await h.waitCard('om_2', '不会传给它');
    expect(await h.coordinator.handleAction({ action: 'steer_promote', task_id: 'om_2', turn: '1' }, 'ou_alice'))
      .toEqual({ type: 'success', content: '正在把这条提到队首' });
    const second = (await h.runtimeTask('换个方向'))!;
    const session = await h.sessionId();
    await vi.waitFor(() => expect(h.steerQueued).toHaveBeenCalledWith(session, second.id, 'ou_alice'));
    await vi.waitFor(async () => expect((await h.runtimeTask('第一件事'))?.status).toBe('interrupted'));
    await vi.waitFor(() => expect(h.prompts.at(-1)).toContain('换个方向'));
    await h.waitCard('om_2', '已把这条内容提到队首，当前正在执行的那一轮会被中断。');
  });

  it('点「插进当前这一轮」：送进正在执行的那一轮，不另起一轮', async () => {
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '顺便看下日志');
    await h.waitCard('om_2', '不会传给它');
    expect(await h.coordinator.handleAction({ action: 'steer_inject', task_id: 'om_2', turn: '1' }, 'ou_alice'))
      .toEqual({ type: 'success', content: '正在把这条插进当前这一轮' });
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    expect(steer.mock.calls[0]![0]).toContain('顺便看下日志');
    await vi.waitFor(async () => expect((await h.runtimeTask('顺便看下日志'))?.status).toBe('completed'));
    await vi.waitFor(() => expect(h.cards.map(card => h.markdownOf(card)).join('\n')).toContain('已把这条内容送进正在执行的这一轮'));
    expect(h.steerQueued).not.toHaveBeenCalled();
    expect(h.prompts).toHaveLength(1);
  });

  it('正在执行的是别人的一轮：按钮、/steer、/queue top 都按中断口径拒绝，写出发起人', async () => {
    const h = await harness({ configPatch: named });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事', 'ou_bob');
    await h.waitCard('om_2', '不会传给它');
    const denial = '只有本轮发起人 Alice 和管理员能中断正在执行的这一轮。部署者可在 Web 停止。';
    expect(await h.coordinator.handleAction({ action: 'steer_promote', task_id: 'om_2', turn: '1' }, 'ou_bob')).toEqual({ type: 'warning', content: denial });
    expect(await h.coordinator.handleAction({ action: 'steer_inject', task_id: 'om_2', turn: '1' }, 'ou_bob')).toEqual({ type: 'warning', content: denial });
    await h.coordinator.handle(event('om_steer', '/steer 改成另一个方向', { senderOpenId: 'ou_bob' }), h.config);
    expect(h.markdownOf(h.receiptNamed('/steer 未执行'))).toContain(denial);
    await h.coordinator.handle(event('om_top', '/queue top 1', { senderOpenId: 'ou_bob' }), h.config);
    expect(h.markdownOf(h.receiptNamed('/queue 未执行'))).toContain(denial);
    expect(h.steerQueued).not.toHaveBeenCalled();
    expect((await h.runtimeTask('第一件事'))?.status).toBe('running');
  });
});

describe('卡片映射提交状态与入站恢复', () => {
  it('dispatch 已接受但尚未返回时可见轮次推进，旧任务证据仍落原 runtime task 且不覆盖新轮', async () => {
    const h = await harness({ configPatch: { memoryEnabled: true } });
    const id = 'om_dispatch_turn_changed';
    const prompt = '旧轮证据不能随后轮跳过';
    const channel = `lark-card:${h.config.appId}`;
    let accepted!: () => void;
    const dispatchAccepted = new Promise<void>(done => { accepted = done; });
    let release!: () => void;
    const dispatchGate = new Promise<void>(done => { release = done; });
    const realDispatch = h.runtime.dispatch.bind(h.runtime);
    vi.spyOn(h.runtime, 'dispatch').mockImplementation(async (...args) => {
      const task = await realDispatch(...args);
      if (args[1].includes(prompt)) { accepted(); await dispatchGate; }
      return task;
    });
    const recordTurn = vi.fn(async () => {});
    (h.coordinator as any).workflowOptions.memory = { store: {
      list: async () => { throw new Error('test only needs the memory turn marker'); },
      getState: async () => { throw new Error('test only needs the memory turn marker'); }, recordTurn
    } };
    const steering = vi.spyOn(h.coordinator as any, 'steerQueuedTurn');
    try {
      const handling = h.coordinator.handle(event(id, prompt, {
        authorization: { strength: 'explicit', via: 'mention' }
      }), h.config);
      await dispatchAccepted;
      const original = (await h.runtimeTask(prompt))!;
      const live = h.task(id);
      expect(live.turn).toBe(1);
      live.steer = true;
      // 同一任务已被后继轮接手；旧 dispatch 只能补自己的证据，不能再写接受检查点或卡片归属。
      live.turn += 1;
      const successor = { ...(await h.inboxRecord(id))!, state: 'received' as const, turn: 2, taskId: 'runtime_successor' };
      await h.repos.config.set(`lark.inbox.${h.config.appId}.${id}`, JSON.stringify(successor));
      const mapping = await h.repos.channelMappings.get(channel, id);
      const successorExtra = JSON.stringify({ ...JSON.parse(mapping!.extra!), turn: 2, runtime_task_id: 'runtime_successor', state: 'queued' });
      await h.repos.channelMappings.save({ ...mapping!, extra: successorExtra });
      release();
      await handling;
      await live.group.tail;

      expect(await readTaskAuthorization(h.repos.config, original.id, original.sessionId)).toMatchObject({
        taskId: original.id, sessionId: original.sessionId, strength: 'explicit', via: 'mention', actorOpenId: 'ou_alice'
      });
      expect(JSON.parse((await h.repos.config.get(`bot_prompt_version/usage/${original.id}`))!)).toMatchObject({
        taskId: original.id, appId: h.config.appId, botPromptVersion: 0
      });
      expect(await h.repos.config.get(pendingPromptUsageKey(h.config.appId, id, 1))).toBeUndefined();
      expect(await h.inboxRecord(id)).toEqual(successor);
      expect((await h.repos.channelMappings.get(channel, id))!.extra).toBe(successorExtra);
      expect(recordTurn).not.toHaveBeenCalled();
      expect(steering).not.toHaveBeenCalled();
    } finally { release(); }
  });

  it('启动 full-scan 后延迟接回的 completed 旧轮在 terminal replay 当次补发且只补发一次', async () => {
    const h = await harness();
    const id = 'om_terminal_replay_needs_full_scan';
    const prompt = '终态重放必须全量核对';
    const channel = `lark-card:${h.config.appId}`;
    const realGet = h.repos.channelMappings.get.bind(h.repos.channelMappings);
    let failReads = true;
    const read = vi.spyOn(h.repos.channelMappings, 'get').mockImplementation(async (mappingChannel, externalId) => {
      if (failReads && mappingChannel === channel && externalId === id) throw new Error('mapping read unavailable');
      return realGet(mappingChannel, externalId);
    });
    const realGetTasks = h.runtime.getTasks.bind(h.runtime);
    let failLedger = false;
    const ledger = vi.spyOn(h.runtime, 'getTasks').mockImplementation(async sessionId => {
      if (failLedger) throw new Error('delay exact runtime task recovery');
      return realGetTasks(sessionId);
    });
    const dispatch = vi.spyOn(h.runtime, 'dispatch');
    const results = () => [...h.service.send.mock.calls, ...h.service.reply.mock.calls]
      .map(([input]) => input).filter(input => input.taskId === id && input.cardKind === 'result');
    try {
      await h.coordinator.handle(event(id, prompt), h.config);
      await h.task(id).group.tail;
      const original = (await h.runtimeTask(prompt))!;
      expect(original.status).toBe('running');
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'received', taskId: original.id });
      expect(await realGet(channel, id)).toBeUndefined();
      h.coordinator.stop();
      h.release();
      await vi.waitFor(async () => expect((await h.runtimeTask(prompt))?.status).toBe('completed'));

      // 首次精确接回读取失败，因此 initializeWorkflows 不会排队恢复；随后启动 full-scan 正常完成且没有 pending。
      failLedger = true;
      const recovered = await h.restart();
      expect((recovered as any).tasks.get(id)).toBeUndefined();
      expect((recovered as any).reconcileFullScan).toBe(false);
      expect((recovered as any).reconcilePending.size).toBe(0);
      expect(results()).toHaveLength(0);

      failLedger = false;
      failReads = false;
      await (recovered as any).recoverInbound((await h.inboxRecord(id))!, h.config);
      await (recovered as any).tasks.get(id)?.group.tail;
      expect(results()).toHaveLength(1);
      expect(JSON.parse((await h.repos.channelMappings.get(channel, id))!.extra!)).toMatchObject({
        runtime_task_id: original.id, state: 'completed', final_delivery_state: 'delivered'
      });
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'accepted', taskId: original.id });
      expect(dispatch.mock.calls.filter(call => call[1].includes(prompt))).toHaveLength(1);
      expect(h.prompts.filter(item => item.includes(prompt))).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);

      await recovered.startReconciliation(h.config);
      expect(results()).toHaveLength(1);
      expect(dispatch.mock.calls.filter(call => call[1].includes(prompt))).toHaveLength(1);
      expect(h.prompts.filter(item => item.includes(prompt))).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);
    } finally {
      failReads = false;
      failLedger = false;
      h.release();
      read.mockRestore();
      ledger.mockRestore();
    }
  });

  it('旧 accepted 记录没有材料快照时仍接回原 running 任务，不重读、不降级且只交付一次', async () => {
    const h = await harness();
    const id = 'om_legacy_accepted_without_materials';
    const prompt = '旧版本已接受任务没有材料快照';
    const channel = `lark-card:${h.config.appId}`;
    const inboxKey = `lark.inbox.${h.config.appId}.${id}`;
    const dispatch = vi.spyOn(h.runtime, 'dispatch');
    const targetDispatches = () => dispatch.mock.calls.filter(call => call[1].includes(prompt));
    const targetSends = () => h.prompts.filter(item => item.includes(prompt));
    const results = () => [...h.service.send.mock.calls, ...h.service.reply.mock.calls]
      .map(([input]) => input).filter(input => input.taskId === id && input.cardKind === 'result');
    try {
      await h.coordinator.handle(event(id, prompt), h.config);
      await h.task(id).group.tail;
      const original = (await h.runtimeTask(prompt))!;
      expect(original.status).toBe('running');
      await vi.waitFor(async () => {
        expect(await h.inboxRecord(id)).toMatchObject({ state: 'accepted', taskId: original.id, materials: expect.any(Object) });
        const mapping = await h.repos.channelMappings.get(channel, id);
        expect(JSON.parse(mapping!.extra!)).toMatchObject({ runtime_task_id: original.id, state: 'running' });
        expect(targetSends()).toHaveLength(1);
        expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);
      });
      expect(targetDispatches()).toHaveLength(1);
      expect(targetSends()).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);

      // 正常接受后只删掉旧版本原本就没有的材料字段，保留真实 runtime task、mapping 与 accepted 归属。
      const legacy = (await h.inboxRecord(id))!;
      const { materials: _materials, ...withoutMaterials } = legacy;
      const contextKey = `lark.context.${h.config.appId}.${original.sessionId}`;
      const contextBefore = await h.repos.config.get(contextKey);
      h.coordinator.stop();
      await h.repos.config.set(inboxKey, JSON.stringify(withoutMaterials));
      const materialReads = h.service.listChatMessages.mock.calls.length;

      const recovered = await h.restart();
      const resumed = (recovered as any).tasks.get(id);
      await resumed?.group.tail;
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'accepted', sessionId: original.sessionId, taskId: original.id, turn: 1 });
      expect((await h.inboxRecord(id))!.materials).toBeUndefined();
      expect(resumed).toMatchObject({ runtimeTaskId: original.id, state: 'running' });
      expect(resumed.requestUpdate).toEqual(expect.any(Function));
      expect(h.service.listChatMessages).toHaveBeenCalledTimes(materialReads);
      expect(await h.repos.config.get(contextKey)).toBe(contextBefore);
      expect(targetDispatches()).toHaveLength(1);
      expect(targetSends()).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);

      h.release();
      await vi.waitFor(async () => {
        const mapping = await h.repos.channelMappings.get(channel, id);
        expect(JSON.parse(mapping!.extra!)).toMatchObject({ runtime_task_id: original.id, state: 'completed', final_delivery_state: 'delivered' });
        expect(results()).toHaveLength(1);
      });
      await recovered.startReconciliation(h.config);
      expect(results()).toHaveLength(1);
      expect(targetDispatches()).toHaveLength(1);
      expect(targetSends()).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'accepted', taskId: original.id });
    } finally { h.release(); }
  });

  it.each(['queued', 'running', 'completed'] as const)('持续 mapping 故障后重启接回 %s 原任务，不先重试首卡或重复执行', async initialStatus => {
    const h = await harness();
    const id = `om_mapping_persistent_${initialStatus}`;
    const prompt = `持续故障仍只执行一次 ${initialStatus}`;
    const channel = `lark-card:${h.config.appId}`;
    const realGet = h.repos.channelMappings.get.bind(h.repos.channelMappings);
    let failReads = true;
    const read = vi.spyOn(h.repos.channelMappings, 'get').mockImplementation(async (mappingChannel, externalId) => {
      if (failReads && mappingChannel === channel && externalId === id) throw new Error('persistent mapping read failure');
      return realGet(mappingChannel, externalId);
    });
    const dispatch = vi.spyOn(h.runtime, 'dispatch');
    const resultCreations = () => [...h.service.send.mock.calls, ...h.service.reply.mock.calls]
      .map(([input]) => input).filter(input => input.taskId === id && input.cardKind === 'result');
    const targetDispatches = () => dispatch.mock.calls.filter(call => call[1].includes(prompt));
    const targetSends = () => h.prompts.filter(item => item.includes(prompt));
    const notRunReply = vi.fn(async () => ({ messageId: 'om_not_run' }));
    const autoVerification = initialStatus === 'completed'
      ? vi.spyOn(LarkMessageCoordinator.prototype as any, 'planAutoVerification') : undefined;
    try {
      if (initialStatus === 'queued') {
        await h.coordinator.handle(event('om_mapping_blocker', '挡住目标队列'), h.config);
        await vi.waitFor(() => expect(h.prompts.filter(item => item.includes('挡住目标队列'))).toHaveLength(1));
      }
      await h.coordinator.handle(event(id, prompt), h.config);
      await h.task(id).group.tail;
      const original = await vi.waitFor(async () => {
        const task = await h.runtimeTask(prompt);
        expect(task?.status).toBe(initialStatus === 'completed' ? 'running' : initialStatus);
        return task!;
      });
      const originalId = original.id;
      await vi.waitFor(() => expect(targetSends()).toHaveLength(initialStatus === 'queued' ? 0 : 1));
      expect(h.repos.execution.getTaskExecution(originalId)?.attempts ?? []).toHaveLength(initialStatus === 'queued' ? 0 : 1);
      expect(await realGet(channel, id)).toBeUndefined();
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'received' });

      // 仅重建 coordinator；Runtime 与 SQLite 沿用。故障在重启后仍持续，旧首卡 PATCH 明确不可用。
      h.coordinator.stop();
      if (initialStatus === 'completed') {
        h.release();
        await vi.waitFor(async () => expect((await h.runtimeTask(prompt))?.status).toBe('completed'));
        const unavailable = { reason: '当前 Agent 已登出', remedy: '重新登录', at: new Date().toISOString() };
        vi.spyOn(h.runtime, 'getAgentAvailability').mockReturnValue(unavailable);
        vi.spyOn(h.runtime, 'checkAgentAvailability').mockResolvedValue(unavailable);
      }
      const update = h.service.update.getMockImplementation()!;
      const recoveryPatches = () => h.service.update.mock.calls.map(([input]) => input)
        .filter(input => input.taskId === id && input.cardKind === 'process' && input.idempotencyKey === `task_${id}_1`);
      h.service.update.mockImplementation(async input => {
        if (input.taskId === id && input.cardKind === 'process' && input.idempotencyKey === `task_${id}_1`) throw new Error('old process card unavailable');
        return update(input);
      });
      (h.service as any).replyText = notRunReply;
      autoVerification?.mockClear();
      const recovered = await h.restart();
      await (recovered as any).tasks.get(id)?.group.tail;
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'received', sessionId: original.sessionId, turn: 1, taskId: originalId });
      expect(recoveryPatches()).toHaveLength(0);
      expect(notRunReply).not.toHaveBeenCalled();
      expect(targetDispatches()).toHaveLength(1);
      expect(targetSends()).toHaveLength(initialStatus === 'queued' ? 0 : 1);
      expect(h.repos.execution.getTaskExecution(originalId)?.attempts ?? []).toHaveLength(initialStatus === 'queued' ? 0 : 1);

      failReads = false;
      h.release();
      await recovered.startReconciliation(h.config);
      await vi.waitFor(async () => {
        const mapping = await h.repos.channelMappings.get(channel, id);
        expect(JSON.parse(mapping!.extra!)).toMatchObject({ runtime_task_id: originalId, final_delivery_state: 'delivered' });
        expect(await h.inboxRecord(id)).toMatchObject({ state: 'accepted', taskId: originalId });
      });
      expect(targetDispatches()).toHaveLength(1);
      expect(targetSends()).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(originalId)?.attempts).toHaveLength(1);
      expect(resultCreations()).toHaveLength(1);
      expect(notRunReply).not.toHaveBeenCalled();
      if (initialStatus === 'completed') {
        const saved = JSON.parse((await h.repos.channelMappings.get(channel, id))!.extra!);
        expect(resultCreations()[0].elapsedSeconds).toBe(Math.max(0, (Date.parse((await h.runtimeTask(prompt))!.updatedAt) - saved.started_at) / 1_000));
        expect(autoVerification).not.toHaveBeenCalled();
      }

      // 必须走真实 full-scan；空调用 reconcile 可能只扫描空 pending 集，不能证明结果幂等。
      await recovered.startReconciliation(h.config);
      expect(resultCreations()).toHaveLength(1);
      const mapping = await h.repos.channelMappings.get(channel, id);
      expect(JSON.parse(mapping!.extra!)).toMatchObject({ runtime_task_id: originalId, final_delivery_state: 'delivered' });
      expect(targetDispatches()).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(originalId)?.attempts).toHaveLength(1);
    } finally {
      failReads = false;
      h.release();
      read.mockRestore();
      autoVerification?.mockRestore();
    }
  });

  it('mapping 在 accepted 后恢复时，后续同轮 queued save 完成接受且只执行一次', async () => {
    const h = await harness();
    const id = 'om_mapping_late_accept';
    const prompt = '后续保存完成原轮接受';
    const channel = `lark-card:${h.config.appId}`;
    const realGet = h.repos.channelMappings.get.bind(h.repos.channelMappings);
    const realDispatch = h.runtime.dispatch.bind(h.runtime);
    let failReads = false;
    vi.spyOn(h.repos.channelMappings, 'get').mockImplementation(async (mappingChannel, externalId) => {
      if (failReads && mappingChannel === channel && externalId === id) throw new Error('acceptance mapping unavailable');
      return realGet(mappingChannel, externalId);
    });
    const dispatch = vi.spyOn(h.runtime, 'dispatch').mockImplementation(async (...args) => {
      const accepted = await realDispatch(...args);
      if (args[1].includes(prompt)) failReads = true;
      return accepted;
    });
    try {
      await h.coordinator.handle(event(id, prompt), h.config);
      await h.task(id).group.tail;
      const original = (await h.runtimeTask(prompt))!;
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'received', taskId: original.id, turn: 1 });
      expect(dispatch.mock.calls.filter(call => call[1].includes(prompt))).toHaveLength(1);
      failReads = false;
      expect(await (h.coordinator as any).saveCardTask(h.task(id), 'queued')).toBe('committed');
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'accepted', taskId: original.id, turn: 1 });
      h.release();
      await vi.waitFor(async () => expect(JSON.parse((await h.repos.channelMappings.get(channel, id))!.extra!))
        .toMatchObject({ runtime_task_id: original.id, final_delivery_state: 'delivered' }));
      expect(h.prompts.filter(item => item.includes(prompt))).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);
      expect(dispatch.mock.calls.filter(call => call[1].includes(prompt))).toHaveLength(1);
    } finally { failReads = false; h.release(); }
  });

  it('context 与 mapping 独立失败时后续保存重试原轮 cursor，且不会接受后继轮', async () => {
    const h = await harness();
    const id = 'om_context_late_accept';
    const prompt = '独立 context 故障后接受';
    const realCas = h.repos.config.compareAndSet!.bind(h.repos.config);
    let failContext = true;
    vi.spyOn(h.repos.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
      if (failContext && key.startsWith(`lark.context.${h.config.appId}.`)) throw new Error('context CAS unavailable');
      return realCas(key, expected, value);
    });
    try {
      await h.coordinator.handle(event(id, prompt), h.config);
      await h.task(id).group.tail;
      const original = (await h.runtimeTask(prompt))!;
      const pending = await h.inboxRecord(id);
      expect(pending).toMatchObject({ state: 'received', taskId: original.id, turn: 1 });
      const frozen = pending!.materials;
      expect(frozen).toBeDefined();
      failContext = false;
      expect(await (h.coordinator as any).saveCardTask(h.task(id), 'queued')).toBe('committed');
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'accepted', taskId: original.id, turn: 1 });
      const context = await h.repos.config.get(`lark.context.${h.config.appId}.${original.sessionId}`);
      expect(JSON.parse(context!)).toEqual({ cursor: frozen!.cursor, readMessageIds: frozen!.readMessageIds });

      const second = await harness();
      try {
        await second.coordinator.handle(event('om_context_successor', '旧保存不得接受新轮'), second.config);
        await second.task('om_context_successor').group.tail;
        const old = await second.inboxRecord('om_context_successor');
        const successor = { ...old!, turn: 2, taskId: 'runtime_successor' };
        await second.repos.config.set(`lark.inbox.${second.config.appId}.om_context_successor`, JSON.stringify(successor));
        await (second.coordinator as any).saveCardTask(second.task('om_context_successor'), 'queued');
        expect(await second.inboxRecord('om_context_successor')).toEqual(successor);
      } finally { second.release(); }
      h.release();
      expect(h.prompts.filter(item => item.includes(prompt))).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);
    } finally { failContext = false; h.release(); }
  });

  it('丢失结果响应超过原重试窗口后，重放只核对回执不再创建结果', async () => {
    const h = await harness();
    const id = 'om_expired_result_replay';
    const prompt = '丢失响应不得重开窗口';
    const channel = `lark-card:${h.config.appId}`;
    const realCas = h.repos.config.compareAndSet!.bind(h.repos.config);
    let failContext = true;
    vi.spyOn(h.repos.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
      if (failContext && key.startsWith(`lark.context.${h.config.appId}.`)) throw new Error('hold inbox received');
      return realCas(key, expected, value);
    });
    const reply = h.service.reply.getMockImplementation()!;
    let loseResponse = true;
    h.service.reply.mockImplementation(async input => {
      if (loseResponse && input.taskId === id && input.cardKind === 'result') {
        loseResponse = false;
        throw new Error('provider response lost');
      }
      return reply(input);
    });
    try {
      await h.coordinator.handle(event(id, prompt), h.config);
      await h.task(id).group.tail;
      h.release();
      const original = (await h.runtimeTask(prompt))!;
      await vi.waitFor(async () => {
        const saved = JSON.parse((await h.repos.channelMappings.get(channel, id))!.extra!);
        expect(saved.state).toBe('completed');
        expect(saved.final_delivery_first_failed_at).toEqual(expect.any(Number));
      });
      expect(h.service.reply.mock.calls.map(([input]) => input).filter(input => input.taskId === id && input.cardKind === 'result')).toHaveLength(1);
      const mapping = await h.repos.channelMappings.get(channel, id);
      const saved = JSON.parse(mapping!.extra!);
      saved.final_delivery_first_failed_at = Date.now() - 2 * 60 * 60_000;
      await h.repos.channelMappings.save({ ...mapping!, extra: JSON.stringify(saved) });
      h.coordinator.stop();
      const materialReads = h.service.listChatMessages.mock.calls.length;
      failContext = false;
      const recovered = await h.restart();
      await (recovered as any).tasks.get(id)?.group.tail;
      await recovered.startReconciliation(h.config);
      expect(h.service.listChatMessages).toHaveBeenCalledTimes(materialReads);
      expect(h.service.reply.mock.calls.map(([input]) => input).filter(input => input.taskId === id && input.cardKind === 'result')).toHaveLength(1);
      expect(h.prompts.filter(item => item.includes(prompt))).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);
      expect(JSON.parse((await h.repos.channelMappings.get(channel, id))!.extra!)).toMatchObject({
        runtime_task_id: original.id, final_delivery_state: 'failed', final_delivery_error: expect.stringContaining('超过 1 小时')
      });
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'accepted', taskId: original.id });
    } finally { failContext = false; h.release(); }
  });

  it('静默结果已确认后修改过程卡配置，重放保留原回执且不再次发送', async () => {
    const h = await harness({ configPatch: { silentProgress: true } });
    const id = 'om_silent_receipt_replay';
    const prompt = '静默结果不得改键重发';
    const channel = `lark-card:${h.config.appId}`;
    const realCas = h.repos.config.compareAndSet!.bind(h.repos.config);
    let failContext = true;
    vi.spyOn(h.repos.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
      if (failContext && key.startsWith(`lark.context.${h.config.appId}.`)) throw new Error('hold inbox received');
      return realCas(key, expected, value);
    });
    try {
      await h.coordinator.handle(event(id, prompt), h.config);
      await h.task(id).group.tail;
      h.release();
      const original = (await h.runtimeTask(prompt))!;
      await vi.waitFor(async () => expect(JSON.parse((await h.repos.channelMappings.get(channel, id))!.extra!))
        .toMatchObject({ state: 'completed', final_delivery_state: 'delivered', final_message_id: expect.any(String) }));
      const before = JSON.parse((await h.repos.channelMappings.get(channel, id))!.extra!);
      const results = () => [...h.service.send.mock.calls, ...h.service.reply.mock.calls]
        .map(([input]) => input).filter(input => input.taskId === id && input.cardKind === 'result');
      expect(results()).toHaveLength(1);
      h.coordinator.stop();
      failContext = false;
      h.config.silentProgress = false;
      await h.repos.config.set(larkBotsConfigKey, JSON.stringify([h.config]));
      const materialReads = h.service.listChatMessages.mock.calls.length;
      const recovered = await h.restart();
      await (recovered as any).tasks.get(id)?.group.tail;
      await recovered.startReconciliation(h.config);
      expect(h.service.listChatMessages).toHaveBeenCalledTimes(materialReads);
      expect(results()).toHaveLength(1);
      expect(results()[0].idempotencyKey).toBe(larkResultKey(larkSilentResultAnchor(id, 1)));
      expect(JSON.parse((await h.repos.channelMappings.get(channel, id))!.extra!)).toMatchObject({
        runtime_task_id: original.id, final_delivery_state: 'delivered', final_message_id: before.final_message_id
      });
      expect(h.prompts.filter(item => item.includes(prompt))).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);
    } finally { failContext = false; h.release(); }
  });

  it.each(['read_failure', 'id_conflict'] as const)('恢复账本%s时不猜测执行归属，也不进入首卡重试', async failure => {
    const h = await harness();
    const id = `om_ledger_${failure}`;
    const prompt = `账本待核对 ${failure}`;
    const channel = `lark-card:${h.config.appId}`;
    const realGet = h.repos.channelMappings.get.bind(h.repos.channelMappings);
    let failReads = true;
    vi.spyOn(h.repos.channelMappings, 'get').mockImplementation(async (mappingChannel, externalId) => {
      if (failReads && mappingChannel === channel && externalId === id) throw new Error('mapping unavailable');
      return realGet(mappingChannel, externalId);
    });
    const dispatch = vi.spyOn(h.runtime, 'dispatch');
    const realGetTasks = h.runtime.getTasks.bind(h.runtime);
    let failLedger = false;
    vi.spyOn(h.runtime, 'getTasks').mockImplementation(async sessionId => {
      if (failLedger) throw new Error('ledger read unavailable');
      return realGetTasks(sessionId);
    });
    const firstCardRetry = vi.fn(async () => ({ messageId: 'om_not_run' }));
    try {
      await h.coordinator.handle(event(id, prompt), h.config);
      await h.task(id).group.tail;
      const original = (await h.runtimeTask(prompt))!;
      await vi.waitFor(() => expect(h.prompts.filter(item => item.includes(prompt))).toHaveLength(1));
      h.coordinator.stop();
      failLedger = failure === 'read_failure';
      if (failure === 'id_conflict') {
        const record = await h.inboxRecord(id);
        await h.repos.config.set(`lark.inbox.${h.config.appId}.${id}`, JSON.stringify({ ...record!, taskId: 'conflicting_runtime_id' }));
      }
      const update = h.service.update.getMockImplementation()!;
      const recoveryPatches = () => h.service.update.mock.calls.map(([input]) => input)
        .filter(input => input.taskId === id && input.idempotencyKey === `task_${id}_1`);
      h.service.update.mockImplementation(async input => {
        if (input.taskId === id && input.idempotencyKey === `task_${id}_1`) throw new Error('must not retry first card');
        return update(input);
      });
      (h.service as any).replyText = firstCardRetry;
      const recovered = await h.restart();
      expect((recovered as any).tasks.get(id)).toBeUndefined();
      expect(recoveryPatches()).toHaveLength(0);
      expect(firstCardRetry).not.toHaveBeenCalled();
      expect(dispatch.mock.calls.filter(call => call[1].includes(prompt))).toHaveLength(1);
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'received', taskId: failure === 'id_conflict' ? 'conflicting_runtime_id' : original.id });
      expect(h.prompts.filter(item => item.includes(prompt))).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);

      failLedger = false;
      failReads = false;
      if (failure === 'id_conflict') {
        const record = await h.inboxRecord(id);
        await h.repos.config.set(`lark.inbox.${h.config.appId}.${id}`, JSON.stringify({ ...record!, taskId: original.id }));
      }
      await (recovered as any).recoverInbound((await h.inboxRecord(id))!, h.config);
      await (recovered as any).tasks.get(id)?.group.tail;
      h.release();
      await recovered.startReconciliation(h.config);
      await vi.waitFor(async () => expect(await h.inboxRecord(id)).toMatchObject({ state: 'accepted', taskId: original.id }));
      expect(dispatch.mock.calls.filter(call => call[1].includes(prompt))).toHaveLength(1);
      expect(h.prompts.filter(item => item.includes(prompt))).toHaveLength(1);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(1);
      await vi.waitFor(() => expect([...h.service.send.mock.calls, ...h.service.reply.mock.calls].map(([input]) => input)
        .filter(input => input.taskId === id && input.cardKind === 'result')).toHaveLength(1));
    } finally { failLedger = false; failReads = false; h.release(); }
  });

  it('steering 已完成旧轮由原对账恢复 outcome，不重发执行或重复结果', async () => {
    const steer = vi.fn(async () => 'injected' as const);
    const h = await harness({ steer });
    const id = 'om_steered_terminal_replay';
    const prompt = '已完成插话的旧轮';
    const channel = `lark-card:${h.config.appId}`;
    const realCas = h.repos.config.compareAndSet!.bind(h.repos.config);
    let failContext = true;
    vi.spyOn(h.repos.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
      if (failContext && expected !== undefined && key.startsWith(`lark.context.${h.config.appId}.`)) throw new Error('hold steering inbox received');
      return realCas(key, expected, value);
    });
    const dispatch = vi.spyOn(h.runtime, 'dispatch');
    try {
      await h.coordinator.handle(event('om_steering_primary', '正在执行的主任务'), h.config);
      await vi.waitFor(() => expect(h.prompts.filter(item => item.includes('正在执行的主任务'))).toHaveLength(1));
      await h.coordinator.handle(event(id, prompt), h.config);
      await h.task(id).group.tail;
      const original = (await h.runtimeTask(prompt))!;
      expect(original.status).toBe('queued');
      const attemptsBefore = h.repos.execution.getTaskExecution(original.id)?.attempts.length ?? 0;
      h.coordinator.stop();
      expect((await h.runtime.injectQueued(original.sessionId, original.id, 'ou_alice')).outcome).toBe('injected');
      await vi.waitFor(async () => expect((await h.runtimeTask(prompt))?.status).toBe('completed'));
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(attemptsBefore);
      failContext = false;
      const recovered = await h.restart();
      await (recovered as any).tasks.get(id)?.group.tail;
      await recovered.startReconciliation(h.config);
      const results = [...h.service.send.mock.calls, ...h.service.reply.mock.calls].map(([input]) => input)
        .filter(input => input.taskId === id && input.cardKind === 'result');
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results[0].elements)).toContain(steeringOutcomeText('injected'));
      expect(JSON.parse((await h.repos.channelMappings.get(channel, id))!.extra!)).toMatchObject({
        runtime_task_id: original.id, state: 'completed', final_delivery_state: 'delivered'
      });
      expect(dispatch.mock.calls.filter(call => call[1].includes(prompt))).toHaveLength(1);
      expect(h.prompts.filter(item => item.includes(prompt))).toHaveLength(0);
      expect(h.repos.execution.getTaskExecution(original.id)?.attempts).toHaveLength(attemptsBefore);
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'accepted', taskId: original.id });
    } finally { failContext = false; h.release(); }
  });

  it('派发前单次瞬时读取故障由 accepted 保存自愈，不新增 send 或 Attempt', async () => {
    const h = await harness();
    const id = 'om_mapping_transient';
    const prompt = '单次故障可以自愈';
    const channel = `lark-card:${h.config.appId}`;
    const realGet = h.repos.channelMappings.get.bind(h.repos.channelMappings);
    let failOnce = true;
    const read = vi.spyOn(h.repos.channelMappings, 'get').mockImplementation(async (mappingChannel, externalId) => {
      if (failOnce && mappingChannel === channel && externalId === id) {
        failOnce = false;
        throw new Error('transient mapping read failure');
      }
      return realGet(mappingChannel, externalId);
    });
    try {
      await h.coordinator.handle(event(id, prompt), h.config);
      await h.task(id).group.tail;
      await vi.waitFor(() => expect(h.prompts.filter(item => item.includes(prompt))).toHaveLength(1));
      const original = await h.runtimeTask(prompt);
      expect(failOnce).toBe(false);
      expect(await h.inboxRecord(id)).toMatchObject({ state: 'accepted', taskId: original!.id });
      const mapping = await h.repos.channelMappings.get(channel, id);
      expect(JSON.parse(mapping!.extra!)).toMatchObject({ runtime_task_id: original!.id });
      expect(h.repos.execution.getTaskExecution(original!.id)?.attempts).toHaveLength(1);
    } finally {
      h.release();
      read.mockRestore();
    }
  });
});

describe('排队卡：当前这一轮被审批挡住', () => {
  const waitApproval = async (h: Awaited<ReturnType<typeof harness>>) => vi.waitFor(async () => {
    const record = (await h.interactions()).find(item => item.kind === 'permission' && item.state === 'pending' && item.cardId);
    expect(record).toBeDefined();
    return record!;
  });
  const mockPendingFor = async (h: Awaited<ReturnType<typeof harness>>, prompt: string) => {
    const current = (await h.runtimeTask(prompt))!;
    vi.spyOn(h.runtime, 'getPendingPermissions').mockReturnValue([{ id: 'native_current', title: '当前任务审批', status: 'pending' }]);
    vi.spyOn(h.runtime, 'getLatestPermissionRequest').mockImplementation(async (_sessionId, taskId, nativeId) => taskId === current.id
      ? { type: 'permission_request', taskId, attemptId: current.currentAttemptId, data: { id: nativeId, title: '当前任务审批', status: 'pending' } } as any : undefined);
    return current;
  };
  /** 排队卡上审批按钮的回调值。 */
  const approvalValue = (card: any, action: 'approve' | 'reject') => {
    const actions = card.elements.find((element: any) => element.element_id === 'queued_approval_actions');
    return actions.columns.flatMap((column: any) => column.elements).find((button: any) => button.element_id === `queued_${action}`).behaviors[0].value;
  };

  it('发起人打「可以，继续」：排队卡说明文字不算批准；点「允许本次」后这条不再单独执行', async () => {
    const h = await harness({ permissionPrompt: '改超时配置' });
    await h.dispatch('om_1', '改超时配置');
    await waitApproval(h);
    await h.dispatch('om_2', '可以，继续');
    const queued = await h.waitCard('om_2', '上面的操作还在等你确认：修改 config/app.yaml。文字回复不算批准。');
    expect(approvalValue(queued, 'approve')).toMatchObject({ dutydeck_workflow: 'approve', dutydeck_queued_task: 'om_2', queued_turn: '1' });
    // 决议提交给执行端的那一刻，确认词必须已经取消：先放行的话 Agent 做完就会接着跑它。
    const resolve = h.runtime.resolvePermission.bind(h.runtime);
    let confirmationAtSubmit: string | undefined;
    vi.spyOn(h.runtime, 'resolvePermission').mockImplementation(async (...args: Parameters<typeof resolve>) => {
      confirmationAtSubmit = (await h.runtimeTask('可以，继续'))?.status;
      return resolve(...args);
    });
    const result = await h.coordinator.handleAction(approvalValue(queued, 'approve'), 'ou_alice', { messageId: h.task('om_2').cardMessageId, chatId: 'oc_group' });
    expect(result.type).toBe('success');
    expect(confirmationAtSubmit).toBe('cancelled');
    await vi.waitFor(() => expect(h.resolvePermission).toHaveBeenCalledWith('native_permission', true));
    await vi.waitFor(async () => expect((await h.runtimeTask('可以，继续'))?.status).toBe('cancelled'));
    await h.waitCard('om_2', '已按按钮批准，这条确认消息不再单独执行。');
    h.release();
    await vi.waitFor(async () => expect((await h.runtimeTask('改超时配置'))?.status).toBe('completed'));
    expect(h.prompts.some(prompt => prompt.includes('可以，继续'))).toBe(false);
    // 已就地改成说明，不再另发一张「已取消」结果卡。
    expect(h.cards.filter(card => card.taskId === 'om_2' && card.state === 'cancelled' && card.messageId === undefined)).toEqual([]);
  });

  it('不是确认词的消息批准后照常执行，排队卡恢复普通说明；别人的消息不显示审批提示', async () => {
    const h = await harness({ permissionPrompt: '改超时配置' });
    await h.dispatch('om_1', '改超时配置');
    await waitApproval(h);
    await h.dispatch('om_2', '顺便看下日志', 'ou_bob');
    await h.dispatch('om_3', '顺便补一条测试');
    const bob = await h.waitCard('om_2', '不会传给它');
    expect(h.markdownOf(bob)).not.toContain('文字回复不算批准');
    const alice = await h.waitCard('om_3', '文字回复不算批准');
    const approve = approvalValue(alice, 'approve');
    expect((await h.coordinator.handleAction(approve, 'ou_alice', { messageId: h.task('om_3').cardMessageId, chatId: 'oc_group' })).type).toBe('success');
    await vi.waitFor(() => expect(h.resolvePermission).toHaveBeenCalledWith('native_permission', true));
    // 审批有了结果，排队卡重绘成普通的排队说明（第一轮还挂在闸门上，这条仍在排队）。
    await vi.waitFor(() => {
      const card = h.latestCard('om_3');
      expect(card?.state).toBe('queued');
      expect(h.markdownOf(card)).not.toContain('文字回复不算批准');
    }, { timeout: 6_000 });
    expect((await h.runtimeTask('顺便补一条测试'))?.status).toBe('queued');
    h.release();
    await vi.waitFor(() => expect(h.prompts.some(prompt => prompt.includes('顺便补一条测试'))).toBe(true));
  });

  it('伪造回调值指向别人的排队任务：只处理审批，不取消任何任务', async () => {
    const h = await harness({ permissionPrompt: '改超时配置' });
    await h.dispatch('om_1', '改超时配置');
    await waitApproval(h);
    await h.dispatch('om_2', '可以', 'ou_bob');
    await h.dispatch('om_3', '顺便补一条测试');
    const alice = await h.waitCard('om_3', '文字回复不算批准');
    // Alice 在自己的排队卡上批准，却把 value 里的排队任务改成 Bob 那条「可以」。
    const forged = { ...approvalValue(alice, 'approve'), dutydeck_queued_task: 'om_2', queued_turn: '1' };
    expect((await h.coordinator.handleAction(forged, 'ou_alice', { messageId: h.task('om_3').cardMessageId, chatId: 'oc_group' })).type).toBe('success');
    await vi.waitFor(() => expect(h.resolvePermission).toHaveBeenCalledWith('native_permission', true));
    expect((await h.runtimeTask('可以'))?.status).toBe('queued');
    expect((await h.runtimeTask('顺便补一条测试'))?.status).toBe('queued');
    expect(h.cards.some(card => h.markdownOf(card).includes('已按按钮批准'))).toBe(false);
  });

  it('点的人不是这条确认消息的发起人、或审批值已失效：不取消这条确认消息', async () => {
    const h = await harness({ permissionPrompt: '改超时配置' });
    await h.dispatch('om_1', '改超时配置');
    await waitApproval(h);
    await h.dispatch('om_2', '可以');
    const queued = await h.waitCard('om_2', '文字回复不算批准');
    const context = { messageId: h.task('om_2').cardMessageId, chatId: 'oc_group' };
    const stale = await h.coordinator.handleAction({ ...approvalValue(queued, 'approve'), generation: 'stale_boot' }, 'ou_alice', context);
    expect(stale.type).not.toBe('success');
    expect((await h.runtimeTask('可以'))?.status).toBe('queued');
    // 把 Bob 当成能批准的管理员（直接放行审批授权）：批准照常生效，但 Alice 的确认消息不由他替她取消。
    vi.spyOn(h.coordinator as any, 'authorizeInteraction').mockResolvedValue(true);
    expect((await h.coordinator.handleAction(approvalValue(queued, 'approve'), 'ou_bob', context)).type).toBe('success');
    await vi.waitFor(() => expect(h.resolvePermission).toHaveBeenCalledWith('native_permission', true));
    await vi.waitFor(() => expect(h.markdownOf(h.latestCard('om_2'))).not.toContain('文字回复不算批准'));
    expect((await h.runtimeTask('可以'))?.status).toBe('queued');
    expect(h.cards.some(card => card.taskId === 'om_2' && h.markdownOf(card).includes('已按按钮批准'))).toBe(false);
  });

  it('审批没提交成功：确认消息已取消，卡上写明要重新点按钮或重新发送', async () => {
    const h = await harness({ permissionPrompt: '改超时配置' });
    await h.dispatch('om_1', '改超时配置');
    await waitApproval(h);
    await h.dispatch('om_2', '好的，继续');
    const queued = await h.waitCard('om_2', '文字回复不算批准');
    vi.spyOn(h.runtime, 'resolvePermission').mockRejectedValueOnce(new Error('执行端暂时不可用'));
    const result = await h.coordinator.handleAction(approvalValue(queued, 'approve'), 'ou_alice', { messageId: h.task('om_2').cardMessageId, chatId: 'oc_group' });
    expect(result.type).toBe('error');
    expect((await h.runtimeTask('好的，继续'))?.status).toBe('cancelled');
    const card = await h.waitCard('om_2', '审批没有成功，这条确认消息已取消，请重新点按钮或重新发送。');
    expect(card).toMatchObject({ state: 'cancelled', statusLabel: '审批没有成功' });
    expect(h.resolvePermission).not.toHaveBeenCalled();
  });

  it('当前任务仍有审批时，steerQueuedTurn 的派发 note 不承诺 Agent 已读', async () => {
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '顺便看下日志');
    await mockPendingFor(h, '第一件事');
    const target = (await h.runtimeTask('顺便看下日志'))!;
    const steering = await (h.coordinator as any).steerQueuedTurn(h.config, event('om_steer', '/steer 顺便看下日志'), await h.sessionId(), target, 'inject');
    expect(steering).toEqual({ steered: 'injected', note: pendingInjectedNote });
  });

  it('/queue steer 的即时回执只在当前任务仍有审批时换成不承诺已读的文案', async () => {
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '顺便看下日志');
    await mockPendingFor(h, '第一件事');
    await h.coordinator.handle(event('om_queue_steer', '/queue steer 1'), h.config);
    const receipt = h.receiptNamed('已插话');
    expect(h.markdownOf(receipt)).toContain(pendingInjectedNote);
    expect(h.markdownOf(receipt)).not.toContain(legacyInjectedNote);
  });

  it('injected 返回后审批已解决时，/queue steer 逐字保留旧回执', async () => {
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '顺便看下日志');
    let pending = [{ id: 'native_current', title: '当前任务审批', status: 'pending' as const }];
    vi.spyOn(h.runtime, 'getPendingPermissions').mockImplementation(() => pending);
    const injectQueued = h.runtime.injectQueued.bind(h.runtime);
    vi.spyOn(h.runtime, 'injectQueued').mockImplementation(async (...args) => {
      const result = await injectQueued(...args);
      pending = [];
      return result;
    });
    await h.coordinator.handle(event('om_queue_steer', '/queue steer 1'), h.config);
    const receipt = h.receiptNamed('已插话');
    expect(h.markdownOf(receipt)).toContain(legacyInjectedNote);
    expect(h.markdownOf(receipt)).not.toContain(pendingInjectedNote);
  });

  it('injected 成功后审批诊断查询失败，回执如实说明状态未知且不改变成功结算', async () => {
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事');
    let injected = false;
    const injectQueued = h.runtime.injectQueued.bind(h.runtime);
    vi.spyOn(h.runtime, 'injectQueued').mockImplementation(async (...args) => {
      const result = await injectQueued(...args);
      expect(result.outcome).toBe('injected');
      injected = true;
      return result;
    });
    vi.spyOn(h.runtime, 'getLatestPermissionRequest').mockImplementation(async () => {
      expect(injected).toBe(true);
      throw new Error('permission diagnostic unavailable');
    });
    // 即使当前没有 pending，也让诊断本身失败，验证异常不能折叠成 confirmed-none。
    vi.spyOn(h.runtime, 'getPendingPermissions').mockReturnValue([{ id: 'native_current', title: '当前任务审批', status: 'pending' }]);
    await h.coordinator.handle(event('om_queue_steer', '/queue steer 1'), h.config);
    const receipt = h.receiptNamed('已插话');
    expect(h.markdownOf(receipt)).toContain(unknownInjectedNote);
    expect(h.markdownOf(receipt)).not.toContain(legacyInjectedNote);
    expect(h.markdownOf(receipt)).not.toContain(pendingInjectedNote);
    expect(h.receiptNamed('/queue 执行失败')).toBeUndefined();
  });

  it('无关任务 pending 和其他 outcome 都不改变既有回执', async () => {
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事');
    vi.spyOn(h.runtime, 'getPendingPermissions').mockReturnValue([{ id: 'unrelated', title: '其他任务审批', status: 'pending' }]);
    await h.coordinator.handle(event('om_queue_steer', '/queue steer 1'), h.config);
    expect(h.markdownOf(h.receiptNamed('已插话'))).toContain(legacyInjectedNote);
    expect(h.markdownOf(h.receiptNamed('已插话'))).not.toContain(pendingInjectedNote);

    const other = await harness({ steer: vi.fn(async (_prompt: string) => 'startedNewTurn' as const) });
    await other.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(other.prompts).toHaveLength(1));
    await other.dispatch('om_2', '第二件事');
    await mockPendingFor(other, '第一件事');
    await other.coordinator.handle(event('om_queue_steer', '/queue steer 1'), other.config);
    const receipt = other.receiptNamed('已插话');
    expect(other.markdownOf(receipt)).toContain('Agent 已用这条内容另起了一轮；那一轮不在 Dutydeck 的执行记录里，结果不会回到这张卡片。');
    expect(other.markdownOf(receipt)).not.toContain(pendingInjectedNote);
  });

  const invokeSteeringEntry = async (h: Awaited<ReturnType<typeof harness>>, entry: 'dispatch' | 'queue') => {
    const target = (await h.runtimeTask('task-C'))!;
    const inject = h.runtime.injectQueued.bind(h.runtime);
    let injected = false;
    vi.spyOn(h.runtime, 'injectQueued').mockImplementation(async (...args) => {
      const result = await inject(...args);
      injected = true;
      return result;
    });
    // /queue steer 旧实现会在注入后另查 running。让它失效，防止把“碰巧查到同一个任务”当成 target 修复。
    const getTasks = h.runtime.getTasks.bind(h.runtime);
    const postInjectionTasks = vi.spyOn(h.runtime, 'getTasks').mockImplementation(async (...args) => {
      if (injected) throw new Error('post-injection running diagnostic unavailable');
      return getTasks(...args);
    });
    try {
      if (entry === 'queue') {
        await h.coordinator.handle(event('om_queue_steer', '/queue steer 2'), h.config);
        return { taskId: target.id, note: h.markdownOf(h.receiptNamed('已插话')) };
      }
      const steering = await (h.coordinator as any).steerQueuedTurn(h.config, event('om_steer', '/steer task-C'), await h.sessionId(), target, 'inject');
      return { taskId: target.id, note: String(steering.note) };
    } finally {
      postInjectionTasks.mockRestore();
    }
  };

  const flipFromAToB = async (h: Awaited<ReturnType<typeof harness>>, releaseA: () => void, waitForApproval: boolean) => {
    vi.spyOn(h.coordinator as any, 'currentTurnInterruptDenial').mockImplementation(async () => {
      releaseA();
      await vi.waitFor(async () => expect((await h.runtimeTask('task-B'))?.status).toBe('running'));
      await vi.waitFor(() => expect(h.prompts.some(prompt => prompt.includes('task-B'))).toBe(true));
      if (waitForApproval) await vi.waitFor(async () => expect(h.runtime.getPendingPermissions(await h.sessionId())).toHaveLength(1));
      return undefined;
    });
  };

  it.each(['dispatch', 'queue'] as const)('A→B 翻页后实际注入 B，%s 只查询 B 的待审批', async entry => {
    let releaseA!: () => void, releaseB!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const gateB = new Promise<void>(resolve => { releaseB = resolve; });
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer, permissionPrompt: 'task-B', hold: prompt => prompt.includes('task-A') ? gateA : prompt.includes('task-B') ? gateB : undefined });
    cleanups.push(async () => {
      releaseA(); releaseB();
      const session = await h.sessionId();
      for (const permission of h.runtime.getPendingPermissions(session)) await h.runtime.resolvePermission(session, permission.id, true);
    });
    await h.dispatch('om_1', 'task-A');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', 'task-B', 'ou_bob');
    await h.dispatch('om_3', 'task-C');
    const a = (await h.runtimeTask('task-A'))!, b = (await h.runtimeTask('task-B'))!;
    const receiptQueries: string[] = [];
    const latest = h.runtime.getLatestPermissionRequest.bind(h.runtime);
    vi.spyOn(h.runtime, 'getLatestPermissionRequest').mockImplementation(async (...args) => {
      receiptQueries.push(args[1]);
      return latest(...args);
    });
    await flipFromAToB(h, releaseA, true);
    const { taskId, note } = await invokeSteeringEntry(h, entry);
    const operation = h.repos.execution.getTaskExecution(taskId)!.steering!;
    expect(operation.target.taskId).toBe(b.id);
    expect(operation.target.taskId).not.toBe(a.id);
    expect(receiptQueries.length).toBeGreaterThan(0);
    expect(new Set(receiptQueries)).toEqual(new Set([b.id]));
    expect(note).toContain(pendingInjectedNote);
    expect(note).not.toContain(legacyInjectedNote);
    expect(note).not.toContain(unknownInjectedNote);
  });

  it.each(['dispatch', 'queue'] as const)('A→B 翻页后 B 没有待审批，%s 不读取 A 的旧审批而误加警告', async entry => {
    let releaseA!: () => void, releaseB!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const gateB = new Promise<void>(resolve => { releaseB = resolve; });
    const steer = vi.fn(async (_prompt: string) => 'injected' as const);
    const h = await harness({ steer, hold: prompt => prompt.includes('task-A') ? gateA : prompt.includes('task-B') ? gateB : undefined });
    cleanups.push(() => { releaseA(); releaseB(); });
    await h.dispatch('om_1', 'task-A');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', 'task-B', 'ou_bob');
    await h.dispatch('om_3', 'task-C');
    const a = (await h.runtimeTask('task-A'))!, b = (await h.runtimeTask('task-B'))!;
    const receiptQueries: string[] = [];
    vi.spyOn(h.runtime, 'getPendingPermissions').mockReturnValue([{ id: 'stale-A', title: 'A 的旧审批', status: 'pending' }]);
    vi.spyOn(h.runtime, 'getLatestPermissionRequest').mockImplementation(async (_sessionId, taskId) => {
      receiptQueries.push(taskId);
      return taskId === a.id ? { type: 'permission_request', taskId, data: { id: 'stale-A', status: 'pending' } } as any : undefined;
    });
    await flipFromAToB(h, releaseA, false);
    const { taskId, note } = await invokeSteeringEntry(h, entry);
    const projection = h.repos.execution.getTaskExecution(taskId)!;
    expect(projection.steering, JSON.stringify({ note, status: projection.task.status })).toBeDefined();
    const operation = projection.steering!;
    expect(operation.target.taskId).toBe(b.id);
    expect(receiptQueries).toEqual([b.id]);
    expect(note).toContain(legacyInjectedNote);
    expect(note).not.toContain(pendingInjectedNote);
    expect(note).not.toContain(unknownInjectedNote);
  });
});

describe('同一人紧接着连发的排队消息合并成一轮', () => {
  it('合并收据与仍在途的排队刷新共用队列，迟到刷新不能覆盖最终说明', async () => {
    const h = await harness();
    await h.dispatch('om_1', '处理主任务');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第一段补充');
    const update = h.service.update.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    h.service.update.mockImplementation(async input => {
      if (input.taskId === 'om_2' && input.state === 'queued' && !waiting) { waiting = true; await gate; }
      return update(input);
    });
    const refresh = h.coordinator.handleAction({ action: 'refresh', task_id: 'om_2' }, 'ou_alice');
    await vi.waitFor(() => expect(waiting).toBe(true));
    const merged = h.dispatch('om_3', '第二段补充');
    try {
      await vi.waitFor(async () => expect((await h.runtimeTask('第一段补充'))?.status).toBe('cancelled'));
      expect(h.service.update.mock.calls.some(([input]) => input.taskId === 'om_2' && input.statusLabel === '已并入下一条')).toBe(false);
    } finally { release(); }
    await refresh;
    await merged;
    const receipt = await h.waitCard('om_2', '已并入下一条');
    expect(h.latestCard('om_2')).toBe(receipt);
    const mapping = await h.repos.channelMappings.get(`lark-card:${h.config.appId}`, 'om_2');
    expect(JSON.parse(mapping!.extra!)).toMatchObject({ state: 'cancelled', card_message_id: receipt.messageId,
      final_message_id: receipt.messageId, final_delivery_state: 'delivered', progress_frozen: true });
    expect(h.cards.some(card => card.taskId === 'om_2' && card.cardKind === 'result')).toBe(false);
  });

  it('前一条排队卡改成「已并入下一条」，合并后只执行一轮，被并入的那条重启后不会重放', async () => {
    const h = await harness();
    await h.dispatch('om_1', '看下登录为什么失败');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '是 staging 环境');
    await h.dispatch('om_3', '日志在 /tmp/x.log');
    const merged = (await h.runtimeTask('日志在 /tmp/x.log'))!;
    expect(merged.prompt).toContain('是 staging 环境\n\n日志在 /tmp/x.log');
    expect((await h.runtime.getTasks(await h.sessionId())).filter(task => task.status === 'queued').map(task => task.id)).toEqual([merged.id]);
    const absorbed = await h.waitCard('om_2', '已并入下一条');
    expect(absorbed).toMatchObject({ state: 'cancelled', statusLabel: '已并入下一条' });
    const mapping = await h.repos.channelMappings.get(`lark-card:${h.config.appId}`, 'om_2');
    expect(JSON.parse(mapping!.extra!)).toMatchObject({ state: 'cancelled', card_message_id: absorbed.messageId,
      final_message_id: absorbed.messageId, final_delivery_state: 'delivered', progress_frozen: true });
    // 重启后能被重放的只有还没交给 runtime 的消息：被并入的那条不在其中。
    expect((await new LarkTaskInbox(h.repos.config).recoverable(h.config.appId)).map(record => record.event.messageId)).not.toContain('om_2');
    h.release();
    await vi.waitFor(async () => expect((await h.runtimeTask('日志在 /tmp/x.log'))?.status).toBe('completed'));
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
    expect(h.prompts[1]).toContain('是 staging 环境\n\n日志在 /tmp/x.log');
    // 被并入的那条没有自己的结果卡。
    expect(h.cards.some(card => card.taskId === 'om_2' && card.state === 'completed')).toBe(false);
  });

  it('前一条取消失败（恰好开始执行）时不合并，两条各自执行，不丢也不重复', async () => {
    const h = await harness();
    await h.dispatch('om_1', '看下登录为什么失败');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '是 staging 环境');
    const cancelQueued = vi.spyOn(h.runtime, 'cancelQueued').mockRejectedValueOnce(new Error('queued task already started'));
    await h.dispatch('om_3', '日志在 /tmp/x.log');
    await vi.waitFor(() => expect(cancelQueued).toHaveBeenCalledTimes(1));
    expect((await h.runtimeTask('日志在 /tmp/x.log'))!.prompt).not.toContain('staging');
    expect((await h.runtimeTask('是 staging 环境'))?.status).toBe('queued');
    // 合并前已写进入站记录的合并原文恢复成这条自己的原文。
    expect((await h.inboxRecord('om_3'))?.request?.prompt).not.toContain('staging');
    h.release();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(await h.sessionId())).every(task => task.status === 'completed')).toBe(true));
    expect(h.prompts).toHaveLength(3);
    expect(h.prompts.filter(prompt => prompt.includes('是 staging 环境'))).toHaveLength(1);
    expect(h.cards.some(card => card.taskId === 'om_2' && h.markdownOf(card).includes('已并入下一条'))).toBe(false);
    // 撤回了「本轮已交付」的预设：这条照常收到自己的完成收口。
    await vi.waitFor(() => expect(h.cards.some(card => card.taskId === 'om_2' && card.state === 'completed')).toBe(true));
  });
});

describe('同一人连发合并：顺序与不合并的情形', () => {
  it('先写入新消息的入站记录，再取消前一条，最后改前一条的卡', async () => {
    const h = await harness();
    await h.dispatch('om_1', '看下登录为什么失败');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '是 staging 环境');
    const cancel = h.runtime.cancelQueued.bind(h.runtime);
    const atCancel: Array<{ inbox?: string; patched: boolean }> = [];
    vi.spyOn(h.runtime, 'cancelQueued').mockImplementation(async (...args: Parameters<typeof cancel>) => {
      atCancel.push({ inbox: (await h.inboxRecord('om_3'))?.request?.prompt, patched: h.cards.some(card => card.taskId === 'om_2' && h.markdownOf(card).includes('已并入下一条')) });
      return cancel(...args);
    });
    await h.dispatch('om_3', '日志在 /tmp/x.log');
    await h.waitCard('om_2', '已并入下一条');
    expect(atCancel).toHaveLength(1);
    expect(atCancel[0]!.inbox).toContain('是 staging 环境\n\n日志在 /tmp/x.log');
    expect(atCancel[0]!.patched).toBe(false);
  });

  it.each([
    ['前一条是引用回复', { om_2: { parentId: 'om_quoted' } }],
    ['后一条是引用回复', { om_3: { parentId: 'om_quoted' } }],
    ['前一条是富文本', { om_2: { messageType: 'post', content: JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'text', text: '是 staging 环境' }]] } }) } }]
  ] as const)('%s时不合并，两条各自排队', async (_name, patches) => {
    const h = await harness();
    await h.dispatch('om_1', '看下登录为什么失败');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    const patchOf = (id: 'om_2' | 'om_3') => (patches as Record<string, Partial<LarkMessageEvent>>)[id] ?? {};
    await h.dispatch('om_2', '是 staging 环境', 'ou_alice', patchOf('om_2'));
    await h.dispatch('om_3', '日志在 /tmp/x.log', 'ou_alice', patchOf('om_3'));
    expect((await h.runtimeTask('日志在 /tmp/x.log'))!.prompt).not.toContain('staging');
    expect((await h.runtime.getTasks(await h.sessionId())).filter(task => task.status === 'queued')).toHaveLength(2);
    expect(h.cards.some(card => card.taskId === 'om_2' && h.markdownOf(card).includes('已并入下一条'))).toBe(false);
  });
});

describe('合并写入之后、取消前一条之前进程退出', () => {
  /** 合并停在取消前一条那一步（模拟进程在这里退出）：合并原文与合并意图已落库，前一条还在排队。 */
  const crashBeforeCancel = async (h: Awaited<ReturnType<typeof harness>>) => {
    await h.dispatch('om_1', '看下登录为什么失败');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '是 staging 环境');
    const hang = vi.spyOn(h.runtime, 'cancelQueued').mockImplementationOnce(() => new Promise(() => {}));
    await h.coordinator.handle(event('om_3', '日志在 /tmp/x.log'), h.config);
    await vi.waitFor(() => expect(hang).toHaveBeenCalledTimes(1));
    expect(await h.inboxRecord('om_3')).toMatchObject({ state: 'received', request: { prompt: expect.stringContaining('是 staging 环境\n\n日志在 /tmp/x.log') },
      mergeFrom: { messageId: 'om_2', ownPrompt: '日志在 /tmp/x.log' } });
    expect((await h.inboxRecord('om_2'))?.mergedInto).toBe('om_3');
    expect((await h.runtimeTask('是 staging 环境'))?.status).toBe('queued');
  };

  it('前一条还在排队：重启后只执行一次合并后的原文，前一条不单独执行', async () => {
    const h = await harness();
    await crashBeforeCancel(h);
    await h.restart();
    h.release();
    await vi.waitFor(() => expect(h.prompts.some(prompt => prompt.includes('日志在 /tmp/x.log'))).toBe(true));
    await vi.waitFor(async () => expect((await h.runtime.getTasks(await h.sessionId())).some(task => task.status === 'queued' || task.status === 'running')).toBe(false));
    expect(h.prompts.filter(prompt => prompt.includes('是 staging 环境'))).toEqual([expect.stringContaining('是 staging 环境\n\n日志在 /tmp/x.log')]);
    const staging = (await h.runtime.getTasks(await h.sessionId())).filter(task => task.prompt.includes('是 staging 环境'));
    expect(staging.map(task => task.status).sort()).toEqual(['cancelled', 'completed']);
  });

  it('前一条已经执行过：重启后这条只执行自己的原文', async () => {
    const h = await harness();
    await crashBeforeCancel(h);
    h.release();
    await vi.waitFor(async () => expect((await h.runtimeTask('是 staging 环境'))?.status).toBe('completed'));
    await h.restart();
    await vi.waitFor(() => expect(h.prompts.some(prompt => prompt.includes('日志在 /tmp/x.log'))).toBe(true));
    expect(h.prompts.filter(prompt => prompt.includes('是 staging 环境'))).toHaveLength(1);
    expect(h.prompts.find(prompt => prompt.includes('日志在 /tmp/x.log'))).not.toContain('staging');
    expect((await h.inboxRecord('om_3'))?.mergeFrom).toBeUndefined();
  });
});

describe('合并恢复时读不到前一条的状态', () => {
  it('前一条已被合并取消、一次读错期间不派发；恢复读取后按合并原文执行一次', async () => {
    const h = await harness();
    await h.dispatch('om_1', '看下登录为什么失败');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '是 staging 环境');
    const update = h.service.update.getMockImplementation()!;
    h.service.update.mockImplementation(async (input: any) => input.statusLabel === '已并入下一条' ? new Promise(() => {}) : update(input));
    await h.coordinator.handle(event('om_3', '日志在 /tmp/x.log'), h.config);
    await vi.waitFor(async () => expect((await h.runtimeTask('是 staging 环境'))?.status).toBe('cancelled'));
    expect(await h.inboxRecord('om_3')).toMatchObject({ state: 'received', mergeFrom: { messageId: 'om_2', ownPrompt: '日志在 /tmp/x.log' } });

    const get = h.repos.config.get.bind(h.repos.config);
    let failRead = true;
    const read = vi.spyOn(h.repos.config, 'get').mockImplementation(async (key: string) => {
      if (failRead && key === `lark.inbox.${h.config.appId}.om_2`) throw new Error('store unavailable');
      return get(key);
    });
    const recovered = await h.restart();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.prompts.some(prompt => prompt.includes('日志在 /tmp/x.log'))).toBe(false);
    expect(await h.inboxRecord('om_3')).toMatchObject({ state: 'received', mergeFrom: { messageId: 'om_2', ownPrompt: '日志在 /tmp/x.log' } });

    failRead = false;
    await (recovered as any).recoverInbound(await h.inboxRecord('om_3'), h.config);
    h.release();
    await vi.waitFor(() => expect(h.prompts.some(prompt => prompt.includes('日志在 /tmp/x.log'))).toBe(true), { timeout: 6_000 });
    expect(h.prompts.filter(prompt => prompt.includes('是 staging 环境'))).toEqual([expect.stringContaining('是 staging 环境\n\n日志在 /tmp/x.log')]);
    expect(read).toHaveBeenCalled();
  });

  it('前一条已完成、一次状态读错期间不重发前文；恢复读取后只派自己的原文', async () => {
    const h = await harness();
    await h.dispatch('om_1', 'main request');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', 'perform first write');
    const hang = vi.spyOn(h.runtime, 'cancelQueued').mockImplementationOnce(() => new Promise(() => {}));
    await h.coordinator.handle(event('om_3', 'perform second write'), h.config);
    await vi.waitFor(() => expect(hang).toHaveBeenCalledTimes(1));
    h.release();
    await vi.waitFor(async () => expect((await h.runtimeTask('perform first write'))?.status).toBe('completed'));

    const getTasks = h.runtime.getTasks.bind(h.runtime);
    let failRead = true;
    vi.spyOn(h.runtime, 'getTasks').mockImplementation(async (...args) => {
      if (failRead && new Error().stack?.includes('resumeMergedInbox')) { failRead = false; throw new Error('synthetic transient storage read failure'); }
      return getTasks(...args);
    });
    const recovered = await h.restart();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.prompts.some(prompt => prompt.includes('perform second write'))).toBe(false);
    expect(h.prompts.filter(prompt => prompt.includes('perform first write'))).toHaveLength(1);
    expect(await h.inboxRecord('om_3')).toMatchObject({ state: 'received', mergeFrom: { messageId: 'om_2', ownPrompt: 'perform second write' } });

    await (recovered as any).recoverInbound(await h.inboxRecord('om_3'), h.config);
    await vi.waitFor(() => expect(h.prompts.some(prompt => prompt.includes('perform second write'))).toBe(true), { timeout: 6_000 });
    expect(h.prompts.filter(prompt => prompt.includes('perform first write'))).toHaveLength(1);
    expect(h.prompts.find(prompt => prompt.includes('perform second write'))).not.toContain('perform first write');
    expect((await h.inboxRecord('om_3'))?.mergeFrom).toBeUndefined();
  });
});

describe('自然终态保存与公开重试的归属', () => {
  it('Runtime interrupt 的旧终态保存晚于公开 retry 完成时，持久记录仍保留新轮次和新 runtime task', async () => {
    const h = await harness();
    await h.dispatch('om_natural', 'review checkpoint natural');
    await vi.waitFor(() => expect(h.task('om_natural').state).toBe('running'));
    const task = h.task('om_natural');
    const oldTaskId = task.runtimeTaskId;
    const get = h.repos.channelMappings.get.bind(h.repos.channelMappings);
    let blocked = false;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(h.repos.channelMappings, 'get').mockImplementation(async (...args) => {
      const stack = new Error().stack ?? '';
      const value = await get(...args);
      if (!blocked && args[1] === 'om_natural' && task.turn === 1 && task.finalMessageId && stack.includes('persistCardTask')) {
        blocked = true;
        await barrier;
      }
      return value;
    });
    try {
      await h.runtime.interrupt(await h.sessionId(), oldTaskId, 'ou_alice');
      await vi.waitFor(() => expect(blocked).toBe(true), { timeout: 6_000 });
      // Runtime 的 interrupt intent 与驱动 stopReason=cancelled 都可能先成为终态；这里保护的是同一条旧终态保存，不能写死其中一个标签。
      expect(['interrupted', 'cancelled']).toContain(task.state);
      expect(task.finalMessageId).toBeTruthy();
      const oldTail = task.group.tail;
      expect(await h.coordinator.handleAction({ action: 'retry', task_id: 'om_natural', turn: '1' }, 'ou_alice')).toMatchObject({ type: 'success' });
      await vi.waitFor(async () => expect(JSON.parse((await get(`lark-card:${h.config.appId}`, 'om_natural'))!.extra!).turn).toBe(2));
      await vi.waitFor(() => expect(task.state).toBe('running'));
      await task.group.tail;
      const before = JSON.parse((await get(`lark-card:${h.config.appId}`, 'om_natural'))!.extra!);
      expect(task.turn).toBe(2);
      expect(before.runtime_task_id).toBe(task.runtimeTaskId);
      expect(task.runtimeTaskId).not.toBe(oldTaskId);

      release();
      await oldTail;
      const after = JSON.parse((await get(`lark-card:${h.config.appId}`, 'om_natural'))!.extra!);
      expect(after).toMatchObject({ turn: 2, state: 'running', runtime_task_id: task.runtimeTaskId });
      expect(task.turn).toBe(2);
      expect(task.runtimeTaskId).not.toBe(oldTaskId);
    } finally { release(); spy.mockRestore(); }
  });
});

describe('/new 统一中断口径并写清停掉了什么', () => {
  it('正在执行的是别人的一轮时拒绝，写出发起人与 Web 停止', async () => {
    const h = await harness({ configPatch: named });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.coordinator.handle(event('om_new', '/new', { senderOpenId: 'ou_bob' }), h.config);
    expect(h.markdownOf(h.receiptNamed('/new 未执行'))).toContain('只有本轮发起人 Alice 和管理员能中断正在执行的这一轮。部署者可在 Web 停止。');
    expect((await h.runtimeTask('第一件事'))?.status).toBe('running');
    expect(h.receiptNamed('/new 已受理')).toBeUndefined();
  });

  it('中断自己的这一轮：回执写标题、运行时长、取消的排队条数和随旧会话停用的定时计划', async () => {
    const automation = { listBySession: vi.fn(async () => ({ schedules: [{ name: '每日巡检', enabled: true }, { name: '已暂停的计划', enabled: false }], subscriptions: [], occurrences: [] })) };
    const h = await harness({ automation });
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事', 'ou_bob');
    await h.coordinator.handle(event('om_new', '/new'), h.config);
    const receipt = h.markdownOf(h.receiptNamed('/new 已受理'));
    expect(receipt).toContain('已中断『第一件事』（已运行不到 1 分钟），取消 1 条排队。');
    expect(receipt).toContain('以下定时计划随旧会话停用：每日巡检');
    expect(receipt).not.toContain('已暂停的计划');
    // 回执说的与事实一致：那一轮确实停了，排队的那条也不会再执行。
    await vi.waitFor(async () => expect((await h.runtimeTask('第一件事'))?.status).not.toBe('running'));
    expect((await h.runtimeTask('第二件事'))?.status).toBe('cancelled');
  });
});

describe('/cancel 与 /stop：中断正在执行的那一轮，并只取消自己的排队', () => {
  it('有正在执行的一轮：中断它并取消发送人自己的排队，别人的排队不动', async () => {
    const h = await harness();
    await h.dispatch('om_1', '第一件事');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事');
    await h.dispatch('om_3', '第三件事', 'ou_bob');
    await h.dispatch('om_4', '第四件事');
    await h.coordinator.handle(event('om_cancel', '/cancel'), h.config);
    expect(h.markdownOf(h.receiptNamed('/cancel 已受理'))).toContain('已请求中断『第一件事』，并取消你的 2 条排队。');
    await vi.waitFor(async () => expect((await h.runtimeTask('第一件事'))?.status).toBe('interrupted'));
    expect((await h.runtimeTask('第二件事'))?.status).toBe('cancelled');
    expect((await h.runtimeTask('第四件事'))?.status).toBe('cancelled');
    await vi.waitFor(() => expect(h.prompts.at(-1)).toContain('第三件事'));
    await h.waitCard('om_2', '这条请求不会再执行');
  });

  it('/stop 遇到别人的这一轮：不中断它，只取消自己的排队，并说明原因', async () => {
    const h = await harness({ configPatch: named });
    await h.dispatch('om_1', '第一件事', 'ou_bob');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '第二件事');
    await h.coordinator.handle(event('om_stop', '/stop'), h.config);
    const receipt = h.markdownOf(h.receiptNamed('/cancel 已受理'));
    expect(receipt).toContain('已取消你的 1 条排队。');
    expect(receipt).toContain('没有中断『第一件事』：只有本轮发起人 Bob 和管理员能中断正在执行的这一轮。部署者可在 Web 停止。');
    expect((await h.runtimeTask('第一件事'))?.status).toBe('running');
    expect((await h.runtimeTask('第二件事'))?.status).toBe('cancelled');
  });

  it('没有正在执行的一轮：只取消自己的排队', async () => {
    const h = await harness();
    h.runtime.setQueueHeld(true);
    await h.dispatch('om_1', '第一件事');
    await h.dispatch('om_2', '第二件事', 'ou_bob');
    await h.coordinator.handle(event('om_cancel', '/cancel'), h.config);
    expect(h.markdownOf(h.receiptNamed('/cancel 已受理'))).toContain('已取消你的 1 条排队。');
    expect((await h.runtimeTask('第一件事'))?.status).toBe('cancelled');
    expect((await h.runtimeTask('第二件事'))?.status).toBe('queued');
  });
});

describe('服务升级排空期间的排队说明', () => {
  it('排队卡写明正在升级、无需重发，也不给插队按钮；排空结束后照常执行', async () => {
    const h = await harness();
    h.runtime.setQueueHeld(true);
    await h.dispatch('om_1', '第一件事');
    const queued = await h.waitCard('om_1', '服务正在升级，完成后会自动执行，无需重发。');
    expect(h.buttonsOf(queued)).toEqual(['取消', '刷新']);
    h.runtime.setQueueHeld(false);
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
  });
});
