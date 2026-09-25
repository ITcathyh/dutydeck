import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { PtyCliDriver } from '@dutydeck/pty-driver';
import type { AgentConfig } from '@dutydeck/shared';
import { LoginLinkStore } from '../auth/auth.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator, type PersistedLarkCardTask } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';
import { buildLarkCard } from './service.js';

/**
 * 卡住的任务在飞书里转到新会话（P0-1）。
 *
 * 场景与 09-23 事故一致：话题里第一条请求执行到一半守护进程重启，原执行进程无法确认安全停止
 * （DRIVER_RESOURCE_UNSAFE / DRIVER_STOP_BLOCKED），它变成「需要核对」；同一话题的第二条请求排在
 * 它后面「排队受阻」。全程使用真实 Runtime + SQLite + PtyCliDriver（后端是假的 PTY），
 * 重启后的 driverFactory 对旧会话一律抛错：旧执行绝不能被重放。
 */

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('condition not reached');
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const silentLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** 按 idempotencyKey 去重的卡片服务替身，与飞书的消息幂等一致；每次实例化用不同前缀区分进程。 */
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
    reply: vi.fn(deliver),
    send: vi.fn(deliver),
    update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
    getUserEmails: vi.fn(async () => ['alice@example.com']),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice', memberType: 'user', name: 'Alice' }, { memberId: 'ou_bob', memberType: 'user', name: 'Bob' }], hasMore: false })),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false }))
  };
}

/** 默认发在同一个话题里（会话按话题共用）；thread: false 是普通群的顶层消息，会话按发送人隔离。 */
const message = (messageId: string, text: string, { sender = 'ou_alice', thread = true } = {}): LarkMessageEvent => ({
  messageId, chatId: 'oc_group', chatType: 'group', ...(thread ? { rootId: 'om_root', threadId: 'omt_topic' } : {}), messageType: 'text',
  content: JSON.stringify({ text: `@_user_1 ${text}` }), senderOpenId: sender, senderType: 'user',
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
const callbackButtonCount = (card: any) => (JSON.stringify(buildLarkCard(card)).match(/"type":"callback"/g) ?? []).length;

/** web: 配置 Web 地址并要求登录，页脚「查看详情」渲染成登录回调按钮。 */
async function blockedTopic({ thread = true, web = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-relaunch-'));
  const path = join(cwd, 'state.db');
  const agent: AgentConfig = { id: 'relaunch-fixture', name: 'Fixture', command: 'unused', args: [], protocol: 'pty-cli', cwd, env: {},
    permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
  const config: StoredLarkConfig = { appId: 'app', appSecret: 'fixture', workspace: cwd, defaultAgentId: agent.id,
    fullTrustConfirmed: true, listening: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false,
    groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 60_000, hideTraceOnComplete: false,
    allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }, { openId: 'ou_bob', name: 'Bob' }], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off',
    ...(web ? { webBaseUrl: 'https://dutydeck.example.com' } : {}) };
  const loginLinks = new LoginLinkStore();
  const submissions: Array<{ sessionId: string; prompt: string }> = [];
  /** 置 true 后，重启后新建的会话启动 Agent 时失败。 */
  const agentStart = { fails: false };
  let oldSessionId = '';
  const factory = (reject: boolean) => (driverConfig: AgentConfig, _protocol: unknown, onEvent: any, onExit: any, sessionId: string) => {
    if (reject && sessionId === oldSessionId) throw new Error('unknown execution must not be replayed');
    if (reject && agentStart.fails) throw new Error('agent failed to start');
    let feed!: (data: string) => void, exit!: (code: number) => void, killed = false;
    // 假后端没有真实进程，PtyCliDriver 按 pid 确认不了退出。重启后新建的会话按「kill 之后进程就没了」处理，
    // /new 能正常停掉它；重启前的旧会话保持停不掉，阻塞才留得下来。
    const Driver = reject ? class extends PtyCliDriver { override async isStopped() { return killed; } } : PtyCliDriver;
    return new Driver({ agent: driverConfig,
      adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], readyPattern: /READY/,
        writeInput: (_backend: unknown, prompt: string) => { submissions.push({ sessionId, prompt }); feed('\x1b[2J\x1b[HWORKING'); } },
      backend: { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() { killed = true; exit(0); }, interrupt() {}, onData(cb: (data: string) => void) { feed = cb; }, onExit(cb: (code: number) => void) { exit = cb; } },
      sessionId, onEvent, onExit } as any);
  };
  const probe = () => ({ protocol: 'pty-cli' as const, available: true, pause: false, resume: true });

  // 第一个进程：两条请求进同一个话题会话，第一条执行中、第二条排队。
  let repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  let runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe, driverFactory: factory(false) as any });
  await runtime.initialize([agent]);
  const first = new LarkMessageCoordinator(runtime as any, cardService('p1') as any, silentLog(), Math.random, 'ou_bot',
    undefined, repos.channelMappings, undefined, undefined, undefined, { store: repos.config });
  await first.initializeWorkflows(config);
  const inboxState = async (id: string) => JSON.parse(await repos.config.get(`lark.inbox.app.${id}`) ?? '{}').state;
  await first.handle(message('om_first', '详细排查下报警', { thread }), config);
  await until(() => submissions.length === 1);
  await first.handle(message('om_queued', '看不懂', { thread }), config);
  await until(async () => await inboxState('om_first') === 'accepted' && await inboxState('om_queued') === 'accepted');
  oldSessionId = (await repos.sessions.list())[0]!.id;
  first.stop();
  await runtime.shutdown();
  repos.close();

  // 守护进程重启：旧执行无法确认安全停止，重启后的 driverFactory 对旧会话一律拒绝。
  repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe, driverFactory: factory(true) as any });
  await runtime.initialize([agent]);
  const coordinators: LarkMessageCoordinator[] = [];
  const liveRepos = repos, liveRuntime = runtime;
  cleanups.push(async () => {
    for (const coordinator of coordinators) coordinator.stop();
    await liveRuntime.shutdown(); liveRepos.close(); await rm(cwd, { recursive: true, force: true });
  });
  const start = async (prefix: string) => {
    const service = cardService(prefix);
    const coordinator = new LarkMessageCoordinator(liveRuntime as any, service as any, silentLog(), Math.random, 'ou_bot',
      undefined, liveRepos.channelMappings, undefined, undefined, undefined, { store: liveRepos.config, ...(web ? { loginLinks } : {}) });
    coordinators.push(coordinator);
    await coordinator.initializeWorkflows(config);
    await coordinator.reconcile(config);
    return { coordinator, service };
  };
  const mapping = async (id: string) => {
    const row = await liveRepos.channelMappings.get('lark-card:app', id);
    return { sessionId: row!.sessionId, saved: JSON.parse(row!.extra!) as PersistedLarkCardTask };
  };
  const tasks = (sessionId: string) => liveRuntime.getTasks(sessionId);
  const blockers = () => liveRepos.execution.getSessionResourceBlockers(oldSessionId).map(item => item.code).sort();
  const sessions = () => liveRepos.sessions.list();
  /** 发给某张卡的最后一次 PATCH。 */
  const lastUpdate = (service: ReturnType<typeof cardService>, messageId: string) =>
    service.update.mock.calls.map(([input]) => input as any).filter(input => input.messageId === messageId).at(-1);
  /** 等某张卡重绘出转交按钮，返回按钮的回调值与点击上下文。 */
  const relaunchButton = async (service: ReturnType<typeof cardService>, id: string, action: 'run_in_new_session' | 'rerun_in_new_session') => {
    const cardId = (await mapping(id)).saved.card_message_id!;
    await until(() => Boolean(lastUpdate(service, cardId)?.capabilities?.canRelaunch));
    return { value: callbackValueOf(lastUpdate(service, cardId), action), context: { messageId: cardId, chatId: 'oc_group' }, cardId };
  };
  const claims = () => liveRepos.config.list('lark.relaunch.');
  return { config, oldSessionId, submissions, start, mapping, tasks, blockers, sessions, lastUpdate, relaunchButton, claims, repos: liveRepos, runtime: liveRuntime, agentStart, loginLinks };
}

describe('卡住的任务在飞书里转到新会话（真实 Runtime + SQLite）', () => {
  it('排队受阻的请求：取消原排队、在新会话执行原文，旧会话原样保留，重复点击与重启后的重复回调都只执行一次', async () => {
    const h = await blockedTopic();
    const [firstTask, queuedTask] = await h.tasks(h.oldSessionId);
    expect([firstTask!.status, queuedTask!.status]).toEqual(['reconcile_required', 'queued']);
    const blockersBefore = h.blockers();
    expect(blockersBefore).toEqual(expect.arrayContaining(['DRIVER_RESOURCE_UNSAFE', 'DRIVER_STOP_BLOCKED']));

    const { coordinator, service } = await h.start('p2');
    const queuedCardId = (await h.mapping('om_queued')).saved.card_message_id!;
    await until(() => Boolean(h.lastUpdate(service, queuedCardId)?.capabilities?.canRelaunch));
    const card = h.lastUpdate(service, queuedCardId);
    const rendered = JSON.stringify(buildLarkCard(card));
    expect(card).toMatchObject({ state: 'queued', statusLabel: '排队受阻' });
    expect(rendered).toContain('在新会话中执行');
    expect(rendered).toContain('原任务已保留');
    for (const phrase of ['将继续跟踪执行进度', '请勿直接重试', '请联系管理员']) expect(rendered).not.toContain(phrase);
    const value = callbackValueOf(card, 'run_in_new_session');
    expect(value).toEqual({ action: 'run_in_new_session', task_id: 'om_queued', turn: '1' });
    const context = { messageId: queuedCardId, chatId: 'oc_group' };

    // 白名单外的点击：回提示，什么都不做。
    expect(await coordinator.handleAction(value, 'ou_mallory', context)).toMatchObject({ type: 'warning' });
    expect(await h.repos.config.list('lark.relaunch.')).toHaveLength(0);
    expect((await h.tasks(h.oldSessionId)).map(task => task.status)).toEqual(['reconcile_required', 'queued']);

    // 同一张卡被连点三次：只有一次被受理。
    const results = await Promise.all([1, 2, 3].map(() => coordinator.handleAction(value, 'ou_alice', context)));
    expect(results.filter(result => result?.type === 'success')).toHaveLength(1);
    await until(() => h.submissions.some(item => item.sessionId !== h.oldSessionId));

    const all = await h.sessions();
    expect(all).toHaveLength(2);
    const fresh = all.find(item => item.id !== h.oldSessionId)!;
    expect(fresh.sourceId).toBe(all.find(item => item.id === h.oldSessionId)!.sourceId);
    const freshSubmissions = h.submissions.filter(item => item.sessionId === fresh.id);
    expect(freshSubmissions).toHaveLength(1);
    expect(freshSubmissions[0]!.prompt).toContain('看不懂');
    expect((await h.tasks(fresh.id)).map(task => task.prompt)).toEqual(['看不懂']);
    // 旧会话：阻塞原样、需要核对的任务原样，只有从未执行过的排队请求被取消。
    expect((await h.tasks(h.oldSessionId)).map(task => task.status)).toEqual(['reconcile_required', 'cancelled']);
    expect(h.blockers()).toEqual(blockersBefore);
    // 新进度卡回复在原话题里；卡片映射转到新会话。
    await until(async () => (await h.mapping('om_queued')).sessionId === fresh.id);
    expect(service.reply).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_queued', replyInThread: true, taskName: '看不懂' }));
    // 旧卡收尾为「已在新会话中执行」并去掉按钮；旧轮次没有补发「已取消」结果卡。
    await until(() => h.lastUpdate(service, queuedCardId)?.statusLabel === '已在新会话中执行');
    const retiredCard = h.lastUpdate(service, queuedCardId);
    expect(retiredCard).toMatchObject({ readOnly: true, sessionId: h.oldSessionId });
    expect(callbackButtonCount(retiredCard)).toBe(0);
    expect(service.reply).not.toHaveBeenCalledWith(expect.objectContaining({ cardKind: 'result', state: 'cancelled' }));
    await coordinator.reconcile(h.config);
    expect(h.lastUpdate(service, queuedCardId)?.statusLabel).toBe('已在新会话中执行');

    // 回调重复投递：只回执。
    expect(await coordinator.handleAction(value, 'ou_alice', context)).toMatchObject({ type: 'success', content: expect.stringContaining('已在新会话中执行') });

    // 服务重启后收到重复回调：同样只回执，不新建会话、不再提交。
    const restarted = await h.start('p3');
    expect(await restarted.coordinator.handleAction(value, 'ou_alice', context)).toMatchObject({ type: 'success', content: expect.stringContaining('已在新会话中执行') });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await h.sessions()).toHaveLength(2);
    expect(h.submissions.filter(item => item.sessionId === fresh.id)).toHaveLength(1);
    expect(await h.tasks(fresh.id)).toHaveLength(1);

    // 重启后的话题续聊进入新会话，旧会话不再收到任何请求。
    await restarted.coordinator.handle(message('om_followup', '继续'), h.config);
    await until(async () => (await h.tasks(fresh.id)).length === 2);
    expect((await h.tasks(fresh.id)).map(task => task.prompt)).toEqual(['看不懂', '继续']);
    expect(await h.tasks(h.oldSessionId)).toHaveLength(2);
  });

  it('需要核对的任务：在新会话中重新执行原请求，旧任务状态与阻塞不变，续聊进入新会话', async () => {
    const h = await blockedTopic();
    const blockersBefore = h.blockers();
    const { coordinator, service } = await h.start('p2');
    const firstCardId = (await h.mapping('om_first')).saved.card_message_id!;
    await until(() => Boolean(h.lastUpdate(service, firstCardId)?.capabilities?.canRelaunch));
    const card = h.lastUpdate(service, firstCardId);
    const rendered = JSON.stringify(buildLarkCard(card));
    expect(card).toMatchObject({ state: 'reconcile_required', statusLabel: '需要核对', readOnly: false });
    expect(rendered).toContain('在新会话中重新执行');
    expect(rendered).toContain('重新执行可能把已经做过的操作再做一次');
    for (const phrase of ['请勿直接重试', '请联系管理员']) expect(rendered).not.toContain(phrase);
    const value = callbackValueOf(card, 'rerun_in_new_session');
    expect(value).toEqual({ action: 'rerun_in_new_session', task_id: 'om_first', turn: '1' });

    expect(await coordinator.handleAction(value, 'ou_alice', { messageId: firstCardId, chatId: 'oc_group' })).toMatchObject({ type: 'success' });
    await until(() => h.submissions.some(item => item.sessionId !== h.oldSessionId));
    const fresh = (await h.sessions()).find(item => item.id !== h.oldSessionId)!;
    expect(h.submissions.filter(item => item.sessionId === fresh.id).map(item => item.prompt).join('')).toContain('详细排查下报警');
    expect((await h.tasks(fresh.id)).map(task => task.prompt)).toEqual(['详细排查下报警']);
    // 原任务仍待核对，排队请求也没被动过（它有自己的卡和按钮），阻塞原样。
    expect((await h.tasks(h.oldSessionId)).map(task => task.status)).toEqual(['reconcile_required', 'queued']);
    expect(h.blockers()).toEqual(blockersBefore);
    await until(() => h.lastUpdate(service, firstCardId)?.statusLabel === '已在新会话中重新执行');
    expect(callbackButtonCount(h.lastUpdate(service, firstCardId))).toBe(0);

    // 同一进程内的话题续聊进入新会话。
    await coordinator.handle(message('om_followup', '继续'), h.config);
    await until(async () => (await h.tasks(fresh.id)).length === 2);
    expect((await h.tasks(fresh.id)).map(task => task.prompt)).toEqual(['详细排查下报警', '继续']);
    expect(await h.tasks(h.oldSessionId)).toHaveLength(2);
  });

  it('同一话题第二次转交：复用上一次转交建出的正常会话，排在它已有的任务后面，不再新建会话', async () => {
    const h = await blockedTopic();
    const first = await h.start('p2');
    const rerun = await h.relaunchButton(first.service, 'om_first', 'rerun_in_new_session');
    expect(await first.coordinator.handleAction(rerun.value, 'ou_alice', rerun.context)).toMatchObject({ type: 'success' });
    await until(() => h.submissions.some(item => item.sessionId !== h.oldSessionId));
    const fresh = (await h.sessions()).find(item => item.id !== h.oldSessionId)!;
    // 重启：内存里的话题绑定与作废集合都没了，第二次转交只能按账本判断哪个会话卡住。
    const restarted = await h.start('p3');
    const run = await h.relaunchButton(restarted.service, 'om_queued', 'run_in_new_session');
    expect(await restarted.coordinator.handleAction(run.value, 'ou_alice', run.context)).toMatchObject({ type: 'success' });
    await until(async () => (await h.tasks(fresh.id)).length === 2);
    expect(await h.sessions()).toHaveLength(2);
    expect((await h.tasks(fresh.id)).map(task => [task.prompt, task.status])).toEqual([['详细排查下报警', 'running'], ['看不懂', 'queued']]);
    expect(h.submissions.filter(item => item.sessionId === fresh.id)).toHaveLength(1);
    expect((await h.tasks(h.oldSessionId)).map(task => task.status)).toEqual(['reconcile_required', 'cancelled']);
    await restarted.coordinator.handle(message('om_followup', '继续'), h.config);
    await until(async () => (await h.tasks(fresh.id)).length === 3);
    expect(await h.sessions()).toHaveLength(2);
  });

  it('按发送人隔离的会话：只有发起人本人能转到新会话，别人连点也只回提示', async () => {
    const h = await blockedTopic({ thread: false });
    expect((await h.mapping('om_queued')).saved.scope_id).toBe('user:ou_alice');
    const { coordinator, service } = await h.start('p2');
    const run = await h.relaunchButton(service, 'om_queued', 'run_in_new_session');
    for (let click = 0; click < 2; click++) {
      expect(await coordinator.handleAction(run.value, 'ou_bob', run.context)).toMatchObject({ type: 'warning', content: expect.stringContaining('发起人本人') });
    }
    expect(await h.claims()).toHaveLength(0);
    expect((await h.tasks(h.oldSessionId)).map(task => task.status)).toEqual(['reconcile_required', 'queued']);
    expect(await h.sessions()).toHaveLength(1);
    expect(await coordinator.handleAction(run.value, 'ou_alice', run.context)).toMatchObject({ type: 'success' });
    await until(() => h.submissions.some(item => item.sessionId !== h.oldSessionId));
  });

  it('共享话题里他人发起的任务：与取消、重试他人任务一样再点一次才执行，执行身份是点击人', async () => {
    const h = await blockedTopic();
    const { coordinator, service } = await h.start('p2');
    const run = await h.relaunchButton(service, 'om_queued', 'run_in_new_session');
    expect(await coordinator.handleAction(run.value, 'ou_bob', run.context)).toEqual({ type: 'warning', content: '该任务由他人发起，再次点击同一按钮以确认操作' });
    expect(await h.claims()).toHaveLength(0);
    expect((await h.tasks(h.oldSessionId)).map(task => task.status)).toEqual(['reconcile_required', 'queued']);
    expect(await h.sessions()).toHaveLength(1);
    expect(await coordinator.handleAction(run.value, 'ou_bob', run.context)).toMatchObject({ type: 'success' });
    await until(() => h.submissions.some(item => item.sessionId !== h.oldSessionId));
    expect(JSON.parse((await h.repos.config.get('lark.inbox.app.om_queued'))!).event.senderOpenId).toBe('ou_bob');
  });

  it('入站记录没受理或与卡片映射对不上的任务：卡上不画转交按钮，回调也不受理', async () => {
    const h = await blockedTopic();
    const inbox = async (id: string) => JSON.parse((await h.repos.config.get(`lark.inbox.app.${id}`))!);
    // 待对账：受理没落库；错位：记录指向别的会话。两种都转不了，按钮就不该出现。
    await h.repos.config.set('lark.inbox.app.om_queued', JSON.stringify({ ...await inbox('om_queued'), state: 'failed' }));
    await h.repos.config.set('lark.inbox.app.om_first', JSON.stringify({ ...await inbox('om_first'), sessionId: 'ses_elsewhere' }));
    const { coordinator, service } = await h.start('p2');
    for (const [id, label, action] of [['om_queued', '排队受阻', 'run_in_new_session'], ['om_first', '需要核对', 'rerun_in_new_session']] as const) {
      const cardId = (await h.mapping(id)).saved.card_message_id!;
      await until(() => h.lastUpdate(service, cardId)?.statusLabel === label);
      const card = h.lastUpdate(service, cardId);
      expect(card.capabilities, id).not.toHaveProperty('canRelaunch');
      expect(JSON.stringify(buildLarkCard(card)), id).not.toContain('在新会话中');
      expect(await coordinator.handleAction({ action, task_id: id, turn: '1' }, 'ou_alice', { messageId: cardId, chatId: 'oc_group' }), id)
        .toMatchObject({ type: 'warning' });
    }
    expect(await h.claims()).toHaveLength(0);
    expect(await h.sessions()).toHaveLength(1);
  });

  it('转交之后在话题里发 /new：保留给管理员的旧会话不去停，照常开新会话，不出现「请联系管理员」', async () => {
    const h = await blockedTopic();
    const blockersBefore = h.blockers();
    const first = await h.start('p2');
    const rerun = await h.relaunchButton(first.service, 'om_first', 'rerun_in_new_session');
    expect(await first.coordinator.handleAction(rerun.value, 'ou_alice', rerun.context)).toMatchObject({ type: 'success' });
    await until(() => h.submissions.some(item => item.sessionId !== h.oldSessionId));
    const fresh = (await h.sessions()).find(item => item.id !== h.oldSessionId)!;
    // 重启后内存里的作废记录没了，只能靠持久化的保留标记认出旧会话。
    const restarted = await h.start('p3');
    const stop = vi.spyOn(h.runtime, 'stop');
    await restarted.coordinator.handle(message('om_new', '/new'), h.config);
    await until(() => JSON.stringify(restarted.service.reply.mock.calls).includes('/new'));
    const replies = JSON.stringify(restarted.service.reply.mock.calls);
    expect(replies).toContain('/new 已受理');
    expect(replies).not.toContain('请联系管理员');
    // 只停了转交建出的会话；旧会话一次都没去停，阻塞与任务原样留给管理员。
    expect(stop.mock.calls.map(([id]) => id)).toEqual([fresh.id]);
    expect(h.blockers()).toEqual(blockersBefore);
    expect((await h.tasks(h.oldSessionId)).map(task => task.status)).toEqual(['reconcile_required', 'queued']);
    await restarted.coordinator.handle(message('om_after_new', '重新开始'), h.config);
    await until(async () => (await h.sessions()).length === 3);
    const third = (await h.sessions()).find(item => item.id !== h.oldSessionId && item.id !== fresh.id)!;
    await until(async () => (await h.tasks(third.id)).length === 1);
    expect((await h.tasks(third.id)).map(task => task.prompt)).toEqual(['重新开始']);
  });

  it('旧卡收尾后页脚「查看详情」仍是登录回调按钮，不退回直链', async () => {
    const h = await blockedTopic({ web: true });
    const { coordinator, service } = await h.start('p2');
    const run = await h.relaunchButton(service, 'om_queued', 'run_in_new_session');
    expect(await coordinator.handleAction(run.value, 'ou_alice', run.context)).toMatchObject({ type: 'success' });
    await until(() => h.lastUpdate(service, run.cardId)?.statusLabel === '已在新会话中执行');
    const retired = h.lastUpdate(service, run.cardId);
    expect(callbackButtonCount(retired)).toBe(1);
    const detail = callbackValueOf(retired, 'detail');
    expect(detail).toEqual({ action: 'detail', task_id: 'om_queued', turn: '1' });
    // 登录链接绑定原会话：留给管理员核对的原任务在那里。
    expect(retired.capabilities).toMatchObject({ detailLogin: true, webUrl: `https://dutydeck.example.com/sessions/${h.oldSessionId}` });
  });

  it('真实转交后在旧卡上点「查看详情」：管理员私信里的登录链接兑换出原会话，非管理员被拒且不发私信', async () => {
    const h = await blockedTopic({ web: true });
    const { coordinator, service } = await h.start('p2');
    const run = await h.relaunchButton(service, 'om_queued', 'run_in_new_session');
    expect(await coordinator.handleAction(run.value, 'ou_alice', run.context)).toMatchObject({ type: 'success' });
    await until(() => h.lastUpdate(service, run.cardId)?.statusLabel === '已在新会话中执行');
    const fresh = (await h.sessions()).find(item => item.id !== h.oldSessionId)!;
    // 回调值取旧卡页脚按钮上的，context 是旧卡本身。
    const detail = callbackValueOf(h.lastUpdate(service, run.cardId), 'detail');
    const privateMessages = () => service.send.mock.calls.map(([input]) => input as any).filter(input => input.receiveId);

    expect(await coordinator.handleAction(detail, 'ou_mallory', run.context)).toMatchObject({ type: 'warning', content: expect.stringContaining('仅机器人管理员') });
    expect(privateMessages()).toHaveLength(0);

    expect(await coordinator.handleAction(detail, 'ou_alice', run.context)).toEqual({ type: 'success', content: '已私信你一个 10 分钟内有效的登录链接' });
    const [dm, ...others] = privateMessages();
    expect(others).toHaveLength(0);
    expect(dm).toMatchObject({ receiveId: 'ou_alice', receiveIdType: 'open_id' });
    const code = /code=([A-Za-z0-9_-]{43})/.exec(JSON.stringify(dm))![1]!;
    // 链接绑定原会话（留给管理员核对的原任务在那里），不是转交建出的新会话。
    expect(fresh.id).not.toBe(h.oldSessionId);
    expect(h.loginLinks.redeem(code)).toBe(h.oldSessionId);
  });

  it('没转交过的卡住会话直接发 /new：不去停它、写保留标记，照常开新会话，回执说明原任务已保留', async () => {
    const h = await blockedTopic();
    const blockersBefore = h.blockers();
    const { coordinator, service } = await h.start('p2');
    const stop = vi.spyOn(h.runtime, 'stop');
    await coordinator.handle(message('om_new', '/new'), h.config);
    await until(() => JSON.stringify(service.reply.mock.calls).includes('/new'));
    const replies = JSON.stringify(service.reply.mock.calls);
    expect(replies).toContain('/new 已受理');
    expect(replies).toContain('原任务已保留，管理员可以用 `dutydeck recovery` 命令核对');
    expect(replies).not.toContain('请联系管理员');
    // 旧会话没去停：阻塞、待核对的任务与它后面的排队请求都原样留给管理员。
    expect(stop).not.toHaveBeenCalled();
    expect(h.blockers()).toEqual(blockersBefore);
    expect((await h.tasks(h.oldSessionId)).map(task => task.status)).toEqual(['reconcile_required', 'queued']);
    expect(await h.repos.config.get(`lark.relaunch_retained.app.${h.oldSessionId}`)).toBeTruthy();
    await coordinator.handle(message('om_after_new', '重新开始'), h.config);
    await until(async () => (await h.sessions()).length === 2);
    const fresh = (await h.sessions()).find(item => item.id !== h.oldSessionId)!;
    await until(async () => (await h.tasks(fresh.id)).length === 1);
    expect((await h.tasks(fresh.id)).map(task => task.prompt)).toEqual(['重新开始']);
    expect(await h.tasks(h.oldSessionId)).toHaveLength(2);
  });

  it('/new 之后建出的会话失败了：重启后的续聊跳过保留给管理员的旧会话，另开新会话', async () => {
    const h = await blockedTopic();
    const first = await h.start('p2');
    await first.coordinator.handle(message('om_new', '/new'), h.config);
    await until(() => JSON.stringify(first.service.reply.mock.calls).includes('/new 已受理'));
    // 下一条消息建出的新会话启动 Agent 失败。
    h.agentStart.fails = true;
    await first.coordinator.handle(message('om_after_new', '重新开始'), h.config);
    await until(async () => (await h.sessions()).some(item => item.id !== h.oldSessionId && item.state === 'failed'));
    h.agentStart.fails = false;
    const failed = (await h.sessions()).find(item => item.id !== h.oldSessionId)!;
    // 重启后内存里的作废集合没了：按「最新的可用会话」只剩那个卡住的旧会话。
    const restarted = await h.start('p3');
    await restarted.coordinator.handle(message('om_followup', '继续'), h.config);
    await until(async () => (await h.sessions()).length === 3);
    const third = (await h.sessions()).find(item => item.id !== h.oldSessionId && item.id !== failed.id)!;
    // 启动失败的那条请求没被受理，重启后按入站记录重放：它和续聊都进了新会话，旧会话一条都没收到。
    await until(async () => (await h.tasks(third.id)).length === 2);
    expect((await h.tasks(third.id)).map(task => task.prompt)).toEqual(['重新开始', '继续']);
    expect(await h.tasks(h.oldSessionId)).toHaveLength(2);
  });

  it('原排队请求已取消、但交给新会话失败：失败卡说明可再点一次，旧卡按钮保留，再点一次接着做完且只执行一次', async () => {
    const h = await blockedTopic();
    const { coordinator, service } = await h.start('p2');
    const run = await h.relaunchButton(service, 'om_queued', 'run_in_new_session');
    // 取消之后、把原请求交给入站记录的那一次写入失败。
    const write = h.repos.config.compareAndSet!.bind(h.repos.config);
    let failed = false;
    vi.spyOn(h.repos.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
      if (!failed && key === 'lark.inbox.app.om_queued' && JSON.parse(value).state === 'received') { failed = true; return false; }
      return write(key, expected, value);
    });
    expect(await coordinator.handleAction(run.value, 'ou_alice', run.context)).toMatchObject({ type: 'success' });
    await until(() => JSON.stringify(service.reply.mock.calls).includes('未能在新会话中执行'));
    const notice = service.reply.mock.calls.map(([input]) => input as any).find(input => input.taskName === '未能在新会话中执行');
    expect(notice.markdown).toContain('原排队请求已取消，但新会话没有开始执行');
    expect(notice.markdown).toContain('可以稍后在原任务卡上再点一次「在新会话中执行」');
    expect((await h.tasks(h.oldSessionId)).map(task => task.status)).toEqual(['reconcile_required', 'cancelled']);
    expect(JSON.parse((await h.claims()).find(row => row.key.endsWith('.om_queued.1'))!.value).phase).toBe('failed');
    // 对账不把旧卡改成「已取消」：卡上的按钮还在。
    await coordinator.reconcile(h.config);
    expect(h.lastUpdate(service, run.cardId)).toMatchObject({ statusLabel: '排队受阻' });
    expect(callbackValueOf(h.lastUpdate(service, run.cardId), 'run_in_new_session')).toEqual(run.value);
    expect(service.reply).not.toHaveBeenCalledWith(expect.objectContaining({ cardKind: 'result', state: 'cancelled' }));

    expect(await coordinator.handleAction(run.value, 'ou_alice', run.context)).toMatchObject({ type: 'success' });
    await until(() => h.submissions.some(item => item.sessionId !== h.oldSessionId));
    await until(() => h.lastUpdate(service, run.cardId)?.statusLabel === '已在新会话中执行');
    const all = await h.sessions();
    expect(all).toHaveLength(2);
    const fresh = all.find(item => item.id !== h.oldSessionId)!;
    expect(h.submissions.filter(item => item.sessionId === fresh.id).map(item => item.prompt)).toEqual([expect.stringContaining('看不懂')]);
    expect((await h.tasks(fresh.id)).map(task => task.prompt)).toEqual(['看不懂']);
  });
});
