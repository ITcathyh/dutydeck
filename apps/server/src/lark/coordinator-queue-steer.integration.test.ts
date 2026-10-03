// 排队、插话与中断的协调器级回归：排队卡上的插队按钮与审批提示、同一人连发的合并、
// /new /cancel /stop /steer /queue 与卡片按钮统一的中断口径、升级排空期间的排队说明。
//
// 与 chat-commands.test.ts 同样接真实 DutydeckRuntime + SQLite，只把飞书网络层换成内存桩：
// 这些行为的价值全在「真的改了队列、真的中断了那一轮」，只 mock runtime 的测试证明不了。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { buildLarkCard } from './service.js';
import { LarkTaskInbox, type LarkInboxRecord } from './task-inbox.js';
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

async function harness(options: { configPatch?: Partial<StoredLarkConfig>; steer?: AgentDriver['steer']; permissionPrompt?: string; automation?: unknown } = {}) {
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
          // 所有轮次都挂在同一道闸门上，后续消息才会真的排队；释放闸门后所有轮次立刻收口。
          await Promise.race([gate, aborted]);
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

describe('排队卡：当前这一轮被审批挡住', () => {
  const waitApproval = async (h: Awaited<ReturnType<typeof harness>>) => vi.waitFor(async () => {
    const record = (await h.interactions()).find(item => item.kind === 'permission' && item.state === 'pending' && item.cardId);
    expect(record).toBeDefined();
    return record!;
  });
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
  it('前一条已被合并取消、读它的入站记录出错：按合并后的原文执行，保留合并意图', async () => {
    const h = await harness();
    await h.dispatch('om_1', '看下登录为什么失败');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await h.dispatch('om_2', '是 staging 环境');
    // 合并停在改前一条的卡那一步（模拟进程在这里退出）：前一条已被这次合并取消，这条还没交给 runtime。
    const update = h.service.update.getMockImplementation()!;
    h.service.update.mockImplementation(async (input: any) => input.statusLabel === '已并入下一条' ? new Promise(() => {}) : update(input));
    await h.coordinator.handle(event('om_3', '日志在 /tmp/x.log'), h.config);
    await vi.waitFor(async () => expect((await h.runtimeTask('是 staging 环境'))?.status).toBe('cancelled'));
    expect((await h.inboxRecord('om_3'))?.state).toBe('received');
    // 重启后读前一条的入站记录出错：读不到不等于没标记。
    const get = h.repos.config.get.bind(h.repos.config);
    vi.spyOn(h.repos.config, 'get').mockImplementation(async (key: string) => {
      if (key === `lark.inbox.${h.config.appId}.om_2`) throw new Error('store unavailable');
      return get(key);
    });
    await h.restart();
    h.release();
    await vi.waitFor(() => expect(h.prompts.some(prompt => prompt.includes('日志在 /tmp/x.log'))).toBe(true));
    expect(h.prompts.filter(prompt => prompt.includes('是 staging 环境'))).toEqual([expect.stringContaining('是 staging 环境\n\n日志在 /tmp/x.log')]);
    expect((await h.inboxRecord('om_3'))?.mergeFrom).toMatchObject({ messageId: 'om_2', ownPrompt: '日志在 /tmp/x.log' });
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
