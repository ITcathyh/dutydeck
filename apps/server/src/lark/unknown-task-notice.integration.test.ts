import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentConfig, DriverFactory, NormalizedDriverEvent } from '@dutydeck/shared';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard } from './service.js';

/**
 * 结果未知的一轮：提醒卡（真实 Runtime + SQLite，按守护进程重启的顺序关停再打开）。
 * 第一轮执行过 git push 后被服务重启切断：不自动重投，停在结果未知，对账发一张带「重新执行」「标为已完成」「标为失败」的提醒卡。
 */

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('condition not reached');
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const silentLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function cardService(prefix: string) {
  let issued = 0;
  const byKey = new Map<string, string>();
  const deliver = async (input: any) => {
    const existing = input.idempotencyKey ? byKey.get(input.idempotencyKey) : undefined;
    if (existing) return { messageId: existing };
    const messageId = `${prefix}_card_${++issued}`;
    if (input.idempotencyKey) byKey.set(input.idempotencyKey, messageId);
    return { messageId };
  };
  return {
    addReaction: vi.fn(async () => ({ messageId: 'om_any', reactionId: 'reaction', emojiType: 'OK' })),
    deleteReaction: vi.fn(async () => {}),
    reply: vi.fn(deliver), send: vi.fn(deliver),
    update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
    getUserEmails: vi.fn(async () => ['alice@example.com']),
    listChatMembers: vi.fn(async () => ({ items: [], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    urgentApp: vi.fn(async () => ({ invalidUserIdList: [] as string[] }))
  };
}

const message = (messageId: string, text: string): LarkMessageEvent => ({
  messageId, chatId: 'oc_group', chatType: 'group', rootId: 'om_root', threadId: 'omt_topic', messageType: 'text',
  content: JSON.stringify({ text: `@_user_1 ${text}` }), senderOpenId: 'ou_alice', senderType: 'user',
  mentions: [{ key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot' }]
});
const buttonsOf = (card: any) => {
  const found: any[] = [];
  const visit = (node: any) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'button') found.push(node);
    Object.values(node).forEach(visit);
  };
  visit(buildLarkCard(card));
  return found;
};
const valueOf = (card: any, elementId: string) => buttonsOf(card).find(button => button.element_id === elementId)?.behaviors?.find((item: any) => item.type === 'callback')?.value;
const isNotice = (input: any) => input?.elements?.some((element: any) => element.element_id === 'unknown_task_notice');

async function unknownTopic(patch: Partial<StoredLarkConfig> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-unknown-'));
  const path = join(cwd, 'state.db');
  const agent: AgentConfig = { id: 'unknown-fixture', name: 'Fixture', command: 'unused', args: [], protocol: 'acp', cwd, env: {},
    permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
  const config: StoredLarkConfig = { appId: 'app', appSecret: 'fixture', workspace: cwd, defaultAgentId: agent.id, webBaseUrl: 'https://deck.example',
    fullTrustConfirmed: true, listening: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false,
    groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 60_000, hideTraceOnComplete: false,
    allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }, { openId: 'ou_bob', name: 'Bob' }], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off', ...patch };
  const prompts: Array<{ sessionId: string; prompt: string }> = [];
  const agentState = { hang: true };
  const pending = new Set<() => void>();
  let script: NormalizedDriverEvent[] = [{ type: 'tool_call', data: { id: 'call_push', name: 'Bash', status: 'running', input: { command: 'git push origin master', description: 'Push' } } }];
  const factory: DriverFactory = (_agent, _protocol, emit, _exit, sessionId) => ({
    start: async () => {}, resume: async () => {}, interrupt: async () => {}, isStopped: async () => true,
    stop: async () => { for (const release of pending) release(); pending.clear(); },
    send: async (input: any) => {
      prompts.push({ sessionId, prompt: typeof input === 'string' ? input : input.prompt });
      if (agentState.hang) {
        for (const event of script) emit(event);
        script = [];
        await new Promise<void>(resolve => pending.add(resolve));
        return;
      }
      emit({ type: 'text', data: { text: '重新做完了' } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    }
  }) as any;
  const probe = () => ({ protocol: 'acp' as const, available: true, pause: false, resume: true });
  type Daemon = { repos: ReturnType<typeof createRepositories>; runtime: DutydeckRuntime; coordinator: LarkMessageCoordinator; service: ReturnType<typeof cardService> };
  let daemon: Daemon | undefined;
  let boots = 0;
  const boot = async (): Promise<Daemon> => {
    const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
    if (!boots) await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe, driverFactory: factory });
    await runtime.initialize([agent]);
    const service = cardService(`p${++boots}`);
    const coordinator = new LarkMessageCoordinator(runtime, service as any, silentLog(), Math.random, 'ou_bot',
      undefined, repos.channelMappings, undefined, undefined, undefined, { store: repos.config });
    await coordinator.initializeWorkflows(config);
    return { repos, runtime, coordinator, service };
  };
  const shutdown = async () => {
    if (!daemon) return;
    daemon.coordinator.stop();
    await daemon.runtime.shutdown();
    daemon.repos.close();
    daemon = undefined;
  };
  cleanups.push(async () => { await shutdown(); await rm(cwd, { recursive: true, force: true }); });
  const current = () => daemon!;
  const mapping = async () => {
    const row = await current().repos.channelMappings.get('lark-card:app', 'om_first');
    return { sessionId: row!.sessionId, saved: JSON.parse(row!.extra!) as PersistedLarkCardTask };
  };
  const restart = async () => {
    await shutdown();
    daemon = await boot();
    await daemon.coordinator.reconcile(config);
    return daemon;
  };
  const notices = () => current().service.reply.mock.calls.map(([input]) => input as any).filter(isNotice);
  const status = async () => { const { sessionId, saved } = await mapping(); return (await current().runtime.getTasks(sessionId)).find(task => task.id === saved.runtime_task_id)?.status; };
  const lastUpdate = (messageId: string) => current().service.update.mock.calls.map(([input]) => input as any).filter(input => input.messageId === messageId).at(-1);

  daemon = await boot();
  await daemon.coordinator.handle(message('om_first', '整理本周报警并回复群里'), config);
  await until(() => prompts.length === 1);
  await until(async () => {
    const row = await current().repos.channelMappings.get('lark-card:app', 'om_first');
    return Boolean(row?.extra && JSON.parse(row.extra).runtime_task_id);
  });
  agentState.hang = false;
  await restart();
  await until(() => notices().length === 1);
  const notice = notices()[0];
  const noticeId = (await current().service.reply.mock.results.find((_result, index) => isNotice(current().service.reply.mock.calls[index]![0]))!.value).messageId as string;
  return { config, prompts, current, mapping, restart, notices, notice, noticeId, status, lastUpdate, context: { messageId: noticeId, chatId: 'oc_group' } };
}

describe('结果未知提醒卡（真实 Runtime + SQLite）', () => {
  it('进入结果未知时在原话题发一张带三个按钮和详情链接的提醒卡；重复对账、再次重启都不重发', async () => {
    const h = await unknownTopic();
    const { sessionId, saved } = await h.mapping();
    const attempt = h.current().repos.execution.getTaskExecution(saved.runtime_task_id!)!.currentAttempt!;
    expect(h.notice).toMatchObject({ messageId: saved.reply_message_id ?? expect.any(String), state: 'reconcile_required', statusLabel: '结果未知', sessionId, taskId: 'om_first' });
    const markdown = h.notice.elements[0].content as string;
    for (const phrase of ['最后状态：结果未知，服务重启切断了这一轮', '是否已提交给 Agent：', '最后输出：', '可能被重复执行', '本轮发起人和管理员可以操作']) expect(markdown).toContain(phrase);
    expect(buttonsOf(h.notice).map(button => button.text?.content)).toEqual(expect.arrayContaining(['重新执行', '标为已完成', '标为失败']));
    expect(valueOf(h.notice, 'resolve_failed')).toEqual({ action: 'resolve_failed', task_id: 'om_first', turn: '1', target: attempt.attemptId });
    // 「查看详情」沿用页脚的会话详情链接。
    expect(JSON.stringify(buildLarkCard(h.notice))).toContain(`https://deck.example/sessions/${encodeURIComponent(sessionId)}`);

    await h.current().coordinator.reconcile(h.config);
    await h.current().coordinator.reconcile(h.config);
    expect(h.notices()).toHaveLength(1);
    await h.restart();
    await h.current().coordinator.reconcile(h.config);
    expect(h.notices()).toHaveLength(0);
    expect(h.current().service.send.mock.calls.filter(([input]) => isNotice(input))).toHaveLength(0);
    expect(h.prompts).toHaveLength(1);
  });

  it('群里 @ 发起人放在提醒卡卡首；两档开关关闭或免打扰时段内的「需要你操作」档仍 @', async () => {
    const mentioned = await unknownTopic({ groupCardMention: true });
    expect(mentioned.notice.elements.map((element: any) => element.element_id)).toEqual(['group_mention', 'unknown_task_notice']);
    expect(mentioned.notice.elements[0].content).toBe('<at id=ou_alice></at>');

    const quiet = new Date(Date.now() - 3_600_000), quietEnd = new Date(Date.now() + 3_600_000);
    const hhmm = (time: Date) => `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    const night = await unknownTopic({ groupCardMention: true, notifyQuietHours: `${hhmm(quiet)}-${hhmm(quietEnd)}` });
    expect(night.notice.elements[0].element_id).toBe('group_mention');

    const off = await unknownTopic({ groupCardMention: true, notifyMentionAction: false });
    expect(off.notice.elements.map((element: any) => element.element_id)).toEqual(['unknown_task_notice']);
  });

  it('提醒卡挂过加急阈值仍没人处理，加急发起人一次；对账再跑、重启都不重发', async () => {
    const h = await unknownTopic({ urgentEnabled: true, urgentThresholdMs: 60_000 });
    await h.current().coordinator.reconcile(h.config);
    expect(h.current().service.urgentApp).not.toHaveBeenCalled();

    // 把提醒卡的发出时间拨到 2 分钟前，模拟挂了一阵。
    const [row] = await h.current().repos.config.list('lark.unknown_task.');
    await h.current().repos.config.set(row!.key, JSON.stringify({ ...JSON.parse(row!.value), sentAt: Date.now() - 120_000 }));
    await h.current().coordinator.reconcile(h.config);
    await h.current().coordinator.reconcile(h.config);
    expect(h.current().service.urgentApp).toHaveBeenCalledExactlyOnceWith({ messageId: h.noticeId, userIdList: ['ou_alice'], userIdType: 'open_id' });
    expect(JSON.parse((await h.current().repos.config.get(row!.key))!).urgentAt).toEqual(expect.any(String));

    await h.restart();
    await h.current().coordinator.reconcile(h.config);
    expect(h.current().service.urgentApp).not.toHaveBeenCalled();
  });

  it('免打扰时段内提醒卡超时也不加急；加急没开则从不加急', async () => {
    const hhmm = (time: number) => `${String(new Date(time).getHours()).padStart(2, '0')}:${String(new Date(time).getMinutes()).padStart(2, '0')}`;
    const quiet = await unknownTopic({ urgentEnabled: true, urgentThresholdMs: 60_000, notifyQuietHours: `${hhmm(Date.now() - 3_600_000)}-${hhmm(Date.now() + 3_600_000)}` });
    const off = await unknownTopic();
    for (const h of [quiet, off]) {
      const [row] = await h.current().repos.config.list('lark.unknown_task.');
      await h.current().repos.config.set(row!.key, JSON.stringify({ ...JSON.parse(row!.value), sentAt: Date.now() - 120_000 }));
      await h.current().coordinator.reconcile(h.config);
      expect(h.current().service.urgentApp).not.toHaveBeenCalled();
    }
  });

  it('非发起人、非管理员的点击被拒，任务不动', async () => {
    const h = await unknownTopic();
    const value = valueOf(h.notice, 'resolve_failed');
    for (const operator of ['ou_bob', 'ou_mallory']) {
      expect(await h.current().coordinator.handleAction(value, operator, h.context)).toMatchObject({ type: 'warning', content: expect.stringContaining('只有本轮发起人') });
    }
    expect(await h.current().coordinator.handleAction(value, 'ou_alice', { messageId: 'om_forged', chatId: 'oc_group' })).toMatchObject({ type: 'warning', content: expect.stringContaining('已失效') });
    expect(await h.status()).toBe('reconcile_required');
  });

  it('标为失败：并发重复点击只结算一次，记下操作人与时间，提醒卡收尾，之后的点击写明谁已处理', async () => {
    const h = await unknownTopic();
    const { saved } = await h.mapping();
    const value = valueOf(h.notice, 'resolve_failed');
    const results = await Promise.all([1, 2, 3].map(() => h.current().coordinator.handleAction(value, 'ou_alice', h.context)));
    expect(results.some(result => result.type === 'success')).toBe(true);
    expect(await h.status()).toBe('failed');
    const execution = h.current().repos.execution.getTaskExecution(saved.runtime_task_id!)!;
    expect(execution.attempts).toHaveLength(1);
    expect(execution.currentAttempt!.settlement).toMatchObject({ kind: 'manual', outcome: 'failed',
      decision: { decisionId: expect.stringMatching(/:failed:lark:ou_alice$/), evidenceRefs: ['manual_resolution', 'operator:lark:ou_alice', expect.stringMatching(/^at:/)] } });
    await until(() => h.lastUpdate(h.noticeId)?.statusLabel === '已标为失败');
    expect(h.lastUpdate(h.noticeId).markdown).toContain('<at id=ou_alice></at> 于 ');
    expect(buttonsOf(h.lastUpdate(h.noticeId)).filter(button => button.behaviors?.some((item: any) => item.type === 'callback'))).toHaveLength(0);
    expect(await h.current().coordinator.handleAction(valueOf(h.notice, 'resolve_completed'), 'ou_alice', h.context))
      .toMatchObject({ type: 'warning', content: expect.stringMatching(/^这一轮已经处理过：飞书用户 ou_alice 于 .+ 已标为失败$/) });
    expect(await h.status()).toBe('failed');
    expect(h.prompts).toHaveLength(1);
  });

  it('标为已完成：人工结算为完成，不再重发', async () => {
    const h = await unknownTopic();
    expect(await h.current().coordinator.handleAction(valueOf(h.notice, 'resolve_completed'), 'ou_alice', h.context)).toMatchObject({ type: 'success' });
    expect(await h.status()).toBe('completed');
    await h.current().coordinator.reconcile(h.config);
    expect(h.prompts).toHaveLength(1);
  });

  it('重新执行要再点一次确认；确认后按原请求在原会话再执行一次，进程卡上停下等人选的按钮随之失效', async () => {
    const h = await unknownTopic();
    const { sessionId } = await h.mapping();
    const value = valueOf(h.notice, 'resolve_retry');
    expect(await h.current().coordinator.handleAction(value, 'ou_alice', h.context)).toMatchObject({ type: 'warning', content: expect.stringContaining('可能被重复执行') });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.prompts).toHaveLength(1);
    expect(await h.status()).toBe('reconcile_required');
    expect(await h.current().coordinator.handleAction(value, 'ou_alice', h.context)).toMatchObject({ type: 'success' });
    await until(() => h.prompts.length === 2);
    expect(h.prompts[1]).toEqual({ sessionId, prompt: h.prompts[0]!.prompt });
    await until(async () => await h.status() === 'completed');
    expect(JSON.parse(await h.current().repos.config.get('lark.redispatch.app.om_first.1') ?? '{}')).toMatchObject({ phase: 'moved' });
    await until(() => h.lastUpdate(h.noticeId)?.statusLabel === '已重新执行');
    // 旧卡再点：这次执行已经换掉，不会作用到新的执行上。
    expect(await h.current().coordinator.handleAction(valueOf(h.notice, 'resolve_failed'), 'ou_alice', h.context)).toMatchObject({ type: 'warning', content: expect.stringContaining('已经处理过') });
    expect(await h.status()).toBe('completed');
    expect(h.prompts).toHaveLength(2);
  });
});
