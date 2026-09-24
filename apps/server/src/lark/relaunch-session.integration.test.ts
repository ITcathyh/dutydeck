import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { PtyCliDriver } from '@dutydeck/pty-driver';
import type { AgentConfig } from '@dutydeck/shared';
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
const callbackButtonCount = (card: any) => (JSON.stringify(buildLarkCard(card)).match(/"type":"callback"/g) ?? []).length;

async function blockedTopic() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-lark-relaunch-'));
  const path = join(cwd, 'state.db');
  const agent: AgentConfig = { id: 'relaunch-fixture', name: 'Fixture', command: 'unused', args: [], protocol: 'pty-cli', cwd, env: {},
    permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
  const config: StoredLarkConfig = { appId: 'app', appSecret: 'fixture', workspace: cwd, defaultAgentId: agent.id,
    fullTrustConfirmed: true, listening: true, preInjectPrompt: '', structuredAskCards: false, groupCardMention: false,
    groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 60_000, hideTraceOnComplete: false,
    allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'danger', riskControlMode: 'off' };
  const submissions: Array<{ sessionId: string; prompt: string }> = [];
  let oldSessionId = '';
  const factory = (reject: boolean) => (driverConfig: AgentConfig, _protocol: unknown, onEvent: any, onExit: any, sessionId: string) => {
    if (reject && sessionId === oldSessionId) throw new Error('unknown execution must not be replayed');
    let feed!: (data: string) => void, exit!: (code: number) => void;
    return new PtyCliDriver({ agent: driverConfig,
      adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], readyPattern: /READY/,
        writeInput: (_backend: unknown, prompt: string) => { submissions.push({ sessionId, prompt }); feed('\x1b[2J\x1b[HWORKING'); } },
      backend: { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() { exit(0); }, interrupt() {}, onData(cb: (data: string) => void) { feed = cb; }, onExit(cb: (code: number) => void) { exit = cb; } },
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
  await first.handle(message('om_first', '详细排查下报警'), config);
  await until(() => submissions.length === 1);
  await first.handle(message('om_queued', '看不懂'), config);
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
      undefined, liveRepos.channelMappings, undefined, undefined, undefined, { store: liveRepos.config });
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
  return { config, oldSessionId, submissions, start, mapping, tasks, blockers, sessions, lastUpdate, repos: liveRepos };
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
});

