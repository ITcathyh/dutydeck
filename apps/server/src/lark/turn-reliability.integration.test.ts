import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentConfig, DriverFactory, NormalizedDriverEvent } from '@dutydeck/shared';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import { larkControlPhrase } from './coordinator-inbound.js';
import { larkAgentAvailabilityLine } from './commands.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard } from './service.js';

/**
 * 执行可靠性（真实 Runtime + SQLite，只替换飞书服务）：
 * - A2：不是重启切断的「结果未知」一轮，Agent 已停下且没有对外操作时自动结束；否则停下给「在原对话继续」「重新执行」「放弃」。
 * - 「在原对话继续」：不重放原请求，在原会话里发接续说明；无进展超时停下的结果卡、排在结果未知后面的排队卡上同样可用。
 * - A1：Agent 没登录时不开新一轮，直接在话题里说清楚怎么修。
 * - C2：话题里的「继续」「停」「重来」。
 */

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('condition not reached');
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Step = { kind: 'ok' } | { kind: 'unconfirmed'; tools?: NormalizedDriverEvent[] } | { kind: 'idle_timeout'; unconfirmed?: boolean } | { kind: 'login' };

function feishu() {
  let issued = 0;
  const byKey = new Map<string, string>();
  const deliver = async (input: any) => {
    const existing = input.idempotencyKey ? byKey.get(input.idempotencyKey) : undefined;
    if (existing) return { messageId: existing };
    const messageId = `om_bot_${++issued}`;
    if (input.idempotencyKey) byKey.set(input.idempotencyKey, messageId);
    return { messageId };
  };
  return {
    addReaction: vi.fn(async () => ({ messageId: 'om_any', reactionId: 'reaction', emojiType: 'OK' })),
    deleteReaction: vi.fn(async () => {}),
    reply: vi.fn(deliver),
    send: vi.fn(deliver),
    replyText: vi.fn(deliver),
    update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
    getUserEmails: vi.fn(async () => ['alice@example.com']),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice', memberType: 'user', name: 'Alice' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false }))
  };
}

const message = (messageId: string, text: string): LarkMessageEvent => ({
  messageId, chatId: 'oc_group', chatType: 'group', rootId: 'om_root', threadId: 'omt_topic', messageType: 'text',
  content: JSON.stringify({ text: `@_user_1 ${text}` }), senderOpenId: 'ou_alice', senderType: 'user',
  mentions: [{ key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot' }]
});

const callbackValueOf = (card: any, elementId: string) => {
  const found: any[] = [];
  const visit = (node: any) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.element_id === elementId && node.tag === 'button') found.push(node);
    Object.values(node).forEach(visit);
  };
  visit(buildLarkCard(card));
  return found[0]?.behaviors?.find((behavior: any) => behavior.type === 'callback')?.value;
};
const buttonTexts = (card: any) => [...JSON.stringify(buildLarkCard(card)).matchAll(/"tag":"plain_text","content":"([^"]+)"/g)].map(match => match[1]);
const push: NormalizedDriverEvent = { type: 'tool_call', data: { id: 'call_push', name: 'Bash', status: 'running', input: { command: 'git push origin master' } } };

async function topic(options: { agentStatusCheck?: () => Promise<'logged_in' | 'logged_out' | 'unknown'> } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-reliability-'));
  const agent: AgentConfig = { id: 'reliability-fixture', name: 'Fixture', command: 'unused', args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
  const config: StoredLarkConfig = { appId: 'app', appSecret: 'fixture', workspace: cwd, defaultAgentId: agent.id,
    fullTrustConfirmed: true, listening: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false,
    groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 60_000, hideTraceOnComplete: false,
    allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off' };
  const prompts: Array<{ sessionId: string; prompt: string }> = [];
  const steps: Step[] = [];
  const agentState = { idle: true };
  const factory: DriverFactory = (_agent, _protocol, emit, _exit, sessionId) => ({
    start: async () => {}, resume: async () => {}, interrupt: async () => {}, isStopped: async () => true, stop: async () => {},
    isIdle: () => agentState.idle,
    send: async (input: any) => {
      prompts.push({ sessionId, prompt: typeof input === 'string' ? input : input.prompt });
      const step = steps.shift() ?? { kind: 'ok' };
      if (step.kind === 'unconfirmed') {
        for (const event of step.tools ?? []) emit(event);
        throw Object.assign(new Error('Agent 没确认收到消息'), { code: 'DRIVER_INPUT_UNCONFIRMED' });
      }
      if (step.kind === 'idle_timeout') {
        emit({ type: 'error', data: { message: '3 分钟没有任何输出，已停止', code: 'AGENT_IDLE_TIMEOUT', timeoutMinutes: 3, retryable: true } });
        // 取消没确认：这一轮进入结果未知，原因码同样是 AGENT_IDLE_TIMEOUT。
        if (step.unconfirmed) throw Object.assign(new Error('3 分钟没有任何输出，取消未确认'), { code: 'AGENT_IDLE_TIMEOUT' });
        emit({ type: 'completed', data: { stopReason: 'idle_timeout' } });
        return;
      }
      if (step.kind === 'login') {
        emit({ type: 'error', data: { message: 'Agent 未登录，没有处理这条消息', code: 'AGENT_LOGIN_REQUIRED', retryable: false } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        return;
      }
      emit({ type: 'text', data: { text: '已完成' } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    }
  }) as any;
  const probe = () => ({ protocol: 'acp' as const, available: true, pause: false, resume: true });
  /** 一个服务进程；restart 按守护进程重启的顺序关停再打开，跑一次启动对账。 */
  const boot = async (first: boolean) => {
    const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
    if (first) await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe, driverFactory: factory,
      ...(options.agentStatusCheck ? { agentStatusCheck: options.agentStatusCheck } : {}) } as any);
    await runtime.initialize([agent]);
    const service = feishu();
    const coordinator = new LarkMessageCoordinator(runtime, service as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any, Math.random, 'ou_bot',
      undefined, repos.channelMappings, undefined, undefined, undefined, { store: repos.config });
    await coordinator.initializeWorkflows(config);
    await coordinator.reconcile(config);
    return { repos, runtime, service, coordinator };
  };
  let daemon: Awaited<ReturnType<typeof boot>> | undefined = await boot(true);
  const shutdown = async () => {
    if (!daemon) return;
    daemon.coordinator.stop(); await daemon.runtime.shutdown(); daemon.repos.close(); daemon = undefined;
  };
  const restart = async () => { await shutdown(); daemon = await boot(false); };
  cleanups.push(async () => { await shutdown(); await rm(cwd, { recursive: true, force: true }); });
  const d = () => daemon!;

  const mapping = async (id = 'om_first') => {
    const row = await d().repos.channelMappings.get('lark-card:app', id);
    return { sessionId: row!.sessionId, saved: JSON.parse(row!.extra!) as PersistedLarkCardTask };
  };
  const tasks = async (id = 'om_first') => d().runtime.getTasks((await mapping(id)).sessionId);
  const calls = () => [...d().service.reply.mock.calls, ...d().service.send.mock.calls, ...d().service.update.mock.calls].map(([input]) => input as any);
  const lastUpdate = (messageId: string) => d().service.update.mock.calls.map(([input]) => input as any).filter(input => input.messageId === messageId).at(-1);
  /** 某条消息这一轮的结果卡（结果卡与它的 messageId）。 */
  const resultCard = async (id = 'om_first') => {
    const { saved } = await mapping(id);
    const card = calls().filter(input => input.cardKind === 'result' && input.taskId === id && input.turn === saved.turn).at(-1);
    return card && { card, messageId: saved.final_message_id! };
  };
  const texts = () => d().service.replyText.mock.calls.map(([input]) => (input as any).text as string);
  const send = async (id: string, text: string) => { await d().coordinator.handle(message(id, text), config); };
  return { config, prompts, steps, agentState, mapping, tasks, calls, lastUpdate, resultCard, texts, send, restart,
    get runtime() { return d().runtime; }, get repos() { return d().repos; }, get service() { return d().service; }, get coordinator() { return d().coordinator; } };
}
type Topic = Awaited<ReturnType<typeof topic>>;

/** 第一条消息停在「结果未知」（原因码 DRIVER_INPUT_UNCONFIRMED），然后跑一次对账。 */
async function unconfirmedTurn(h: Topic, tools: NormalizedDriverEvent[] = []) {
  h.steps.push({ kind: 'unconfirmed', tools });
  await h.send('om_first', '整理本周报警并回复群里');
  await until(async () => (await h.repos.channelMappings.get('lark-card:app', 'om_first')) !== undefined
    && (await h.tasks()).some(task => task.status === 'reconcile_required'));
  await h.coordinator.reconcile(h.config);
}

describe('结果未知的一轮不锁住话题（A2）', () => {
  it('Agent 已停下、没有对外操作：自动按中断结束，结果卡写明原因并给「在原对话继续」；点了只发接续说明，不重放原请求', async () => {
    const h = await topic();
    await unconfirmedTurn(h);
    const { sessionId, saved } = await h.mapping();
    await until(async () => (await h.tasks())[0]?.status === 'interrupted');
    expect(JSON.parse(await h.repos.config.get('lark.settled.app.om_first.1') ?? '{}')).toEqual({ code: 'DRIVER_INPUT_UNCONFIRMED', agent: 'Fixture' });
    await until(async () => Boolean(await h.resultCard()));
    const result = (await h.resultCard())!;
    expect(JSON.stringify(result.card.elements)).toContain('上一轮 Fixture 没确认收到消息，可能没开始执行。Agent 已经停下，这一轮也没有做过可能对外生效的操作，已自动结束。');
    expect(result.card.capabilities).toMatchObject({ canContinueInPlace: true });
    expect(buttonTexts(result.card)).toContain('在原对话继续');

    // 会话没被锁住：下一条消息照常执行。
    await h.send('om_second', '看一下今天的发布');
    await until(() => h.prompts.length === 2);
    await until(async () => (await h.tasks('om_second')).some(task => task.status === 'completed'));

    const value = callbackValueOf(result.card, 'continue_in_place');
    expect(value).toEqual({ action: 'continue_in_place', task_id: 'om_first', turn: String(saved.turn) });
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: result.messageId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    await until(() => h.prompts.length === 3);
    expect(h.prompts[2]!.sessionId).toBe(sessionId);
    expect(h.prompts[2]!.prompt).toContain('[Dutydeck 系统说明]\n上一轮的消息可能没有送到你这里。请先确认上一轮做到了哪一步');
    expect(h.prompts[2]!.prompt).not.toContain('整理本周报警并回复群里');
    expect(h.texts()).toContain('「在原对话继续」继续');
    // 同一张卡再点只回执，不再发第二次。
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: result.messageId, chatId: 'oc_group' })).toMatchObject({ type: 'success', content: expect.stringContaining('已经「在原对话继续」了') });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.prompts).toHaveLength(3);
  });

  it('执行过 git push：停下给三个按钮；后面的消息立刻收到排队受阻说明和「在原对话继续」；点旧卡的「在原对话继续」按没做完处理并在原会话接着做', async () => {
    const h = await topic();
    await unconfirmedTurn(h, [push]);
    const { sessionId, saved } = await h.mapping();
    const cardId = saved.card_message_id!;
    await until(() => h.lastUpdate(cardId)?.statusLabel === '结果未知');
    const card = h.lastUpdate(cardId);
    expect(card.markdown).toContain('上一轮 Fixture 没确认收到消息，可能没开始执行。这一轮执行过 git push，可能已经对外生效，所以没有自动继续。');
    expect(card.capabilities).toMatchObject({ canReplay: true, canContinueInPlace: true });
    expect(buttonTexts(card)).toEqual(expect.arrayContaining(['在原对话继续', '重新执行', '放弃']));
    expect((await h.tasks())[0]).toMatchObject({ status: 'reconcile_required' });
    expect(JSON.parse(await h.repos.config.get('lark.redispatch.app.om_first.1') ?? '{}')).toMatchObject({ phase: 'held',
      redispatch: { code: 'DRIVER_INPUT_UNCONFIRMED', unsafeReason: '执行过 git push' } });

    // 话题被挡住时再发消息：排队卡立刻说明原因并给「在原对话继续」，不会一声不响地排着。
    await h.send('om_second', '看一下今天的发布');
    await until(async () => (await h.repos.channelMappings.get('lark-card:app', 'om_second')) !== undefined
      && h.calls().some(input => input.taskId === 'om_second' && input.capabilities?.canContinueInPlace));
    const queued = h.calls().filter(input => input.taskId === 'om_second' && input.capabilities?.canContinueInPlace).at(-1);
    expect(queued.markdown).toContain('上一轮还不确定是否做完，为避免重复执行，不会自动开始。');
    expect(queued.markdown).toContain('也可以点「在原对话继续」');
    expect(h.prompts).toHaveLength(1);

    const value = callbackValueOf(card, 'continue_in_place');
    expect(await h.coordinator.handleAction(value, 'ou_mallory', { messageId: cardId, chatId: 'oc_group' })).toMatchObject({ type: 'warning' });
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: cardId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    // 旧一轮按结果未知收口（不是失败），排着的消息先跑，接续说明随后在同一会话里跑。
    expect(h.repos.execution.getTaskExecution(saved.runtime_task_id!)!.currentAttempt).toMatchObject({ state: 'settled', outcome: 'unknown' });
    await until(() => h.prompts.length === 3);
    expect(h.prompts.map(item => item.sessionId)).toEqual([sessionId, sessionId, sessionId]);
    expect(h.prompts[1]!.prompt).toContain('看一下今天的发布');
    expect(h.prompts[2]!.prompt).toContain('上一轮的消息可能没有送到你这里');
    expect(h.prompts[2]!.prompt).not.toContain('整理本周报警并回复群里');
    await until(() => h.lastUpdate(cardId)?.markdown?.includes('**已在原对话继续**'));
    expect(buttonTexts(h.lastUpdate(cardId)).filter(text => ['在原对话继续', '重新执行', '放弃'].includes(text))).toEqual([]);
    expect(JSON.parse(await h.repos.config.get('lark.redispatch.app.om_first.1') ?? '{}')).toMatchObject({ phase: 'moved' });
    // 对账不再停在这一轮，旧卡上的「重新执行」也随之失效。
    await h.coordinator.reconcile(h.config);
    expect(await h.coordinator.handleAction(callbackValueOf(card, 'replay_turn'), 'ou_alice', { messageId: cardId, chatId: 'oc_group' })).toMatchObject({ type: 'warning' });
    expect(h.prompts).toHaveLength(3);
  });

  it('排队卡上的「在原对话继续」：只把挡在前面的那一轮按没做完处理，这条排队消息接着在原对话里执行', async () => {
    const h = await topic();
    await unconfirmedTurn(h, [push]);
    await h.send('om_second', '看一下今天的发布');
    await until(async () => h.calls().some(input => input.taskId === 'om_second' && input.capabilities?.canContinueInPlace));
    const queued = h.calls().filter(input => input.taskId === 'om_second' && input.capabilities?.canContinueInPlace).at(-1);
    const { saved } = await h.mapping('om_second');
    const value = callbackValueOf(queued, 'continue_in_place');
    expect(value).toEqual({ action: 'continue_in_place', task_id: 'om_second', turn: '1' });
    expect(await h.coordinator.handleAction(value, 'ou_alice', { messageId: saved.card_message_id!, chatId: 'oc_group' }))
      .toMatchObject({ type: 'success', content: '上一轮已按没做完处理，这条消息接着在原对话里执行' });
    await until(async () => (await h.tasks('om_second')).some(task => task.status === 'completed'));
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]!.prompt).toContain('看一下今天的发布');
    const held = (await h.mapping()).saved;
    await until(() => h.lastUpdate(held.card_message_id!)?.markdown?.includes('**已在原对话继续**'));
    // 对账再跑也不会把收尾改回去。
    await h.coordinator.reconcile(h.config);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.lastUpdate(held.card_message_id!).markdown).toContain('**已在原对话继续**');
  });

  it('Agent 当时没确认停下：先停下给三个按钮，说明还没停；之后对账发现已经停下就自动结束', async () => {
    const h = await topic();
    h.agentState.idle = false;
    await unconfirmedTurn(h);
    const { saved } = await h.mapping();
    await until(() => h.lastUpdate(saved.card_message_id!)?.statusLabel === '结果未知');
    expect(h.lastUpdate(saved.card_message_id!).markdown).toContain('Agent 还没确认停下，所以没有自动结束这一轮。');
    expect(JSON.parse(await h.repos.config.get('lark.redispatch.app.om_first.1') ?? '{}')).toMatchObject({ phase: 'held', redispatch: { running: true } });
    await h.coordinator.reconcile(h.config);
    expect((await h.tasks())[0]!.status).toBe('reconcile_required');

    h.agentState.idle = true;
    await h.coordinator.reconcile(h.config);
    await until(async () => (await h.tasks())[0]?.status === 'interrupted');
    expect(JSON.parse(await h.repos.config.get('lark.redispatch.app.om_first.1') ?? '{}')).toMatchObject({ phase: 'moved' });
    expect(await h.coordinator.handleAction(callbackValueOf(h.lastUpdate(saved.card_message_id!), 'replay_turn') ?? { action: 'replay_turn', task_id: 'om_first', turn: '1' },
      'ou_alice', { messageId: saved.card_message_id!, chatId: 'oc_group' })).toMatchObject({ type: 'warning' });
    expect(h.prompts).toHaveLength(1);
  });
});

describe('服务启动时按同样规则处理已有记录', () => {
  it('停下时 Agent 没确认停下的一轮：重启后执行进程已退出、没有对外操作，启动对账自动结束，结果卡写明原因', async () => {
    const h = await topic();
    h.agentState.idle = false;
    await unconfirmedTurn(h);
    expect(JSON.parse(await h.repos.config.get('lark.redispatch.app.om_first.1') ?? '{}')).toMatchObject({ phase: 'held', redispatch: { running: true } });
    await h.restart();
    await until(async () => (await h.tasks())[0]?.status === 'interrupted');
    await h.coordinator.reconcile(h.config);
    await until(async () => Boolean(await h.resultCard()));
    const result = (await h.resultCard())!;
    expect(JSON.stringify(result.card.elements)).toContain('Agent 已经停下，这一轮也没有做过可能对外生效的操作，已自动结束。');
    expect(result.card.capabilities).toMatchObject({ canContinueInPlace: true });
    expect(h.prompts).toHaveLength(1);
  });
});

describe('无进展超时（A4）', () => {
  it('失败的结果卡给「在原对话继续」，接续说明写明几分钟没有输出', async () => {
    const h = await topic();
    h.steps.push({ kind: 'idle_timeout' });
    await h.send('om_first', '整理本周报警并回复群里');
    await until(async () => Boolean(await h.repos.channelMappings.get('lark-card:app', 'om_first')) && Boolean(await h.resultCard()));
    expect((await h.tasks())[0]!.status).toBe('failed');
    const result = (await h.resultCard())!;
    expect(result.card).toMatchObject({ state: 'failed', capabilities: expect.objectContaining({ canContinueInPlace: true }) });
    const ids = JSON.stringify(buildLarkCard(result.card)).match(/"element_id":"continue_in_place"/g) ?? [];
    expect(ids).toHaveLength(1);
    expect(buttonTexts(result.card).filter(text => text === '在原对话继续')).toHaveLength(1);
    expect(await h.coordinator.handleAction(callbackValueOf(result.card, 'continue_in_place'), 'ou_alice', { messageId: result.messageId, chatId: 'oc_group' }))
      .toMatchObject({ type: 'success' });
    await until(() => h.prompts.length === 2);
    expect(h.prompts[1]!.prompt).toContain('上一轮因 3 分钟无输出被系统停止。');
    expect(h.prompts[1]!.prompt).not.toContain('整理本周报警并回复群里');
  });
});

describe('无进展超时、取消没确认（A4）', () => {
  it('停在结果未知等人选；「在原对话继续」的接续说明同样写明几分钟没有输出', async () => {
    const h = await topic();
    h.agentState.idle = false;
    h.steps.push({ kind: 'idle_timeout', unconfirmed: true });
    await h.send('om_first', '整理本周报警并回复群里');
    await until(async () => Boolean(await h.repos.channelMappings.get('lark-card:app', 'om_first')) && (await h.tasks())[0]?.status === 'reconcile_required');
    await h.coordinator.reconcile(h.config);
    const { saved } = await h.mapping();
    await until(() => h.lastUpdate(saved.card_message_id!)?.statusLabel === '结果未知');
    const card = h.lastUpdate(saved.card_message_id!);
    expect(card.markdown).toContain('上一轮 Fixture 长时间没有任何输出，已停止等待，不确定是否做完。Agent 还没确认停下');
    h.agentState.idle = true;
    expect(await h.coordinator.handleAction(callbackValueOf(card, 'continue_in_place'), 'ou_alice', { messageId: saved.card_message_id!, chatId: 'oc_group' }))
      .toMatchObject({ type: 'success' });
    await until(() => h.prompts.length === 2);
    expect(h.prompts[1]!.prompt).toContain('上一轮因 3 分钟无输出被系统停止。');
  });
});

describe('Agent 不可用（A1）', () => {
  it('没登录：之后的消息不开新一轮，直接说明怎么修；/status 显示不可用；状态命令确认登录后照常执行', async () => {
    const states: Array<'logged_in' | 'logged_out'> = ['logged_out', 'logged_in'];
    const agentStatusCheck = vi.fn(async () => states.shift() ?? 'logged_in');
    const h = await topic({ agentStatusCheck });
    h.steps.push({ kind: 'login' });
    await h.send('om_first', '整理本周报警并回复群里');
    await until(async () => Boolean(await h.repos.channelMappings.get('lark-card:app', 'om_first')) && (await h.tasks())[0]?.status === 'failed');
    expect(h.runtime.getAgentAvailability('reliability-fixture')).toMatchObject({ reason: expect.any(String), at: expect.any(String) });

    await h.send('om_status', '/status');
    await until(() => h.calls().some(input => JSON.stringify(input).includes('Agent 状态')));
    expect(JSON.stringify(h.calls().find(input => JSON.stringify(input).includes('Agent 状态')))).toContain('**Agent 状态**：不可用（');

    await h.send('om_second', '看一下今天的发布');
    await until(() => h.texts().some(text => text.includes('现在用不了')));
    expect(h.texts().find(text => text.includes('现在用不了'))).toMatch(/^Dutydeck 现在用不了：.+。.+。修好后重发这条消息即可。$/);
    expect(agentStatusCheck).toHaveBeenCalledTimes(1);
    expect(h.prompts).toHaveLength(1);
    expect(JSON.parse(await h.repos.config.get('lark.inbox.app.om_second') ?? '{}')).toMatchObject({ state: 'failed' });

    await h.send('om_third', '看一下今天的发布');
    await until(() => h.prompts.length === 2);
    expect(h.runtime.getAgentAvailability('reliability-fixture')).toBeUndefined();
  });
});

describe('话题里的短控制语（C2）', () => {
  it('去掉 @、空白和标点后整条就是控制语才算', () => {
    expect(larkControlPhrase('继续')).toBe('continue');
    expect(larkControlPhrase('@Dutydeck 接着做！')).toBe('continue');
    expect(larkControlPhrase(' 停一下。')).toBe('stop');
    expect(larkControlPhrase('别做了!!')).toBe('stop');
    expect(larkControlPhrase('再来一次～')).toBe('restart');
    expect(larkControlPhrase('继续写测试')).toBeUndefined();
    expect(larkControlPhrase('停止发布流程')).toBeUndefined();
    expect(larkControlPhrase('toString')).toBeUndefined();
  });

  it('「继续」：前面那一轮结果未知时按没做完处理，在原对话里接着做，回一句确认', async () => {
    const h = await topic();
    await unconfirmedTurn(h, [push]);
    const { sessionId, saved } = await h.mapping();
    await h.send('om_go', '继续');
    await until(() => h.prompts.length === 2);
    expect(h.prompts[1]).toMatchObject({ sessionId, prompt: expect.stringContaining('上一轮的消息可能没有送到你这里') });
    expect(h.prompts[1]!.prompt).not.toContain('整理本周报警并回复群里');
    expect(h.texts()).toContain('好，上一轮按没做完处理，接着在原对话里做。');
    expect(h.repos.execution.getTaskExecution(saved.runtime_task_id!)!.currentAttempt).toMatchObject({ state: 'settled', outcome: 'unknown' });
  });

  it('「重来」：停在结果未知等人选的那一轮同「重新执行」，回一句确认', async () => {
    const h = await topic();
    await unconfirmedTurn(h, [push]);
    const { sessionId } = await h.mapping();
    await h.send('om_again', '@Dutydeck 重来');
    await until(() => h.prompts.length === 2);
    expect(h.prompts[1]!.sessionId).toBe(sessionId);
    expect(h.prompts[1]!.prompt).toContain('整理本周报警并回复群里');
    expect(h.prompts[1]!.prompt).toContain('上一轮被中断了，用户选择重新执行');
    expect(h.texts()).toContain('好，重新执行上一条请求。');
  });

  it('「停」同 /cancel；没有可停的一轮时如实回执，不发给 Agent', async () => {
    const h = await topic();
    await h.send('om_first', '整理本周报警并回复群里');
    await until(async () => Boolean(await h.repos.channelMappings.get('lark-card:app', 'om_first')) && (await h.tasks())[0]?.status === 'completed');
    await h.send('om_stop', '停一下');
    await until(() => h.calls().some(input => input.taskName === '/cancel 未执行'));
    expect(h.prompts).toHaveLength(1);
  });

  it('上一轮已经完成时「继续」是普通消息；不在机器人话题里的控制语也是普通消息', async () => {
    const h = await topic();
    await h.send('om_first', '整理本周报警并回复群里');
    await until(async () => Boolean(await h.repos.channelMappings.get('lark-card:app', 'om_first')) && (await h.tasks())[0]?.status === 'completed');
    await h.send('om_go', '继续');
    await until(() => h.prompts.length === 2);
    expect(h.prompts[1]!.prompt).not.toContain('[Dutydeck 系统说明]');
    expect(h.texts()).toEqual([]);
  });
});

describe('/status 的 Agent 状态行', () => {
  it('可用 / 不可用（原因，北京时间）', () => {
    expect(larkAgentAvailabilityLine()).toBe('**Agent 状态**：可用');
    expect(larkAgentAvailabilityLine({ reason: 'Claude Code 未登录', at: '2026-10-07T02:05:00.000Z' })).toBe('**Agent 状态**：不可用（Claude Code 未登录，10-07 10:05）');
  });
});
