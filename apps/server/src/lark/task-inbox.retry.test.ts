import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator } from './coordinator.js';
import type { LarkMessageEvent } from './listener.js';
import { LarkServiceError } from './service.js';

// 真实 coordinator 与 SQLite 入站记录；飞书发送与 runtime 用替身，按脚本让首卡失败几次。
const config: StoredLarkConfig = {
  appId: 'cli_first_card', appSecret: 'synthetic', workspace: '/tmp', defaultAgentId: 'codex', permissionMode: 'ask',
  fullTrustConfirmed: true, listening: true, preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false,
  pushIntervalMs: 1000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [],
  highRiskAllowedEmails: [], highRiskPattern: 'rm\\b', riskControlMode: 'off'
};
const message = (messageId = 'om_request', text = '整理今天的告警'): LarkMessageEvent => ({
  messageId, chatId: 'oc_p2p', chatType: 'p2p', messageType: 'text', content: JSON.stringify({ text }),
  senderOpenId: 'ou_requester', senderType: 'user', mentions: []
});
const image = (messageId: string): LarkMessageEvent => ({ ...message(messageId), messageType: 'image', content: JSON.stringify({ image_key: `img_${messageId}` }) });
const jitter = () => new LarkServiceError('LARK_OPENAPI_ERROR', 'Lark OpenAPI request failed: request trigger frequency limit (code: 230020)', 502, { upstreamCode: 230020 });
// SQLite 是同步的，推进 0 毫秒让入站处理的 Promise 链跑完，不挪动假时钟。
const settle = async () => { for (let index = 0; index < 50; index++) await vi.advanceTimersByTimeAsync(0); };

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(firstCardFailures: number) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-first-card-retry-'));
  const repositories = createRepositories(join(directory, 'state.db'));
  await repositories.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const session = { id: 'ses_first_card', agentId: 'codex', state: 'idle', cwd: '/tmp', protocol: 'acp', permissionMode: 'ask', createdAt: '', updatedAt: '' };
  const listeners: Array<(event: AgentEvent) => void> = [];
  const runtime = {
    start: vi.fn(async () => session), getSession: vi.fn(async () => session),
    subscribe: vi.fn((_id: string, listener: (event: AgentEvent) => void) => { listeners.push(listener); return vi.fn(); }),
    dispatch: vi.fn(async (..._args: unknown[]) => ({ id: 'task_runtime', sessionId: session.id, status: 'queued', queuedAhead: 0 })),
    send: vi.fn(), interrupt: vi.fn(), stop: vi.fn(async (..._args: unknown[]) => {})
  };
  let failures = firstCardFailures;
  const delivered: any[] = [];
  const send = vi.fn(async (input: any) => {
    if (input.cardKind === 'process' && failures > 0) { failures -= 1; throw jitter(); }
    delivered.push(input);
    return { messageId: `om_card_${delivered.length}` };
  });
  const service = {
    send, update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
    replyText: vi.fn(async (..._args: unknown[]) => ({ messageId: 'om_text_reply' })),
    addReaction: vi.fn(async (..._args: unknown[]) => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })), getMessageItems: vi.fn(async () => []),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array([137, 80, 78, 71]), contentType: 'image/png' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const coordinators: LarkMessageCoordinator[] = [];
  const createCoordinator = () => {
    const coordinator = new LarkMessageCoordinator(runtime as any, service as any, log, Math.random, 'ou_bot',
      undefined, undefined, undefined, undefined, undefined, { store: repositories.config });
    coordinators.push(coordinator);
    return coordinator;
  };
  cleanups.push(async () => { for (const coordinator of coordinators) coordinator.stop(); repositories.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    runtime, service, delivered, listeners, createCoordinator, store: repositories.config,
    inbox: async (id = 'om_request') => JSON.parse((await repositories.config.get(`lark.inbox.${config.appId}.${id}`))!),
    processCards: () => send.mock.calls.map(([input]) => input).filter(input => input.cardKind === 'process')
  };
}

it('keeps the request pending after the first card fails and delivers exactly one card when the 30s retry succeeds', async () => {
  const h = await harness(1);
  const coordinator = h.createCoordinator();
  await coordinator.handle(message(), config);
  await settle();
  // 失败后不标 failed、不发兜底，入站记录保持 received 并交还认领
  expect(await h.inbox()).toMatchObject({ state: 'received', boot: '' });
  expect(h.service.replyText).not.toHaveBeenCalled();
  expect(h.runtime.dispatch).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(29_000);
  await settle();
  expect(h.processCards()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  await settle();

  expect(h.processCards()).toHaveLength(2);
  expect(new Set(h.processCards().map(input => input.idempotencyKey))).toEqual(new Set(['task_om_request_1']));
  expect(h.delivered.filter(input => input.cardKind === 'process')).toHaveLength(1);
  expect(h.runtime.dispatch).toHaveBeenCalledOnce();
  expect(await h.inbox()).toMatchObject({ state: 'accepted', taskId: 'task_runtime', cardId: 'om_card_1' });
  expect(h.service.replyText).not.toHaveBeenCalled();
});

it('replies in plain text and marks the request failed after both retries fail', async () => {
  const h = await harness(3);
  const coordinator = h.createCoordinator();
  await coordinator.handle(message(), config);
  await settle();
  await vi.advanceTimersByTimeAsync(30_000);
  await settle();
  expect(h.processCards()).toHaveLength(2);
  expect(await h.inbox()).toMatchObject({ state: 'received', boot: '' });
  await vi.advanceTimersByTimeAsync(119_000);
  await settle();
  expect(h.processCards()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1_000);
  await settle();

  expect(h.processCards()).toHaveLength(3);
  expect(h.service.replyText).toHaveBeenCalledOnce();
  expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_request', text: '这条请求没有执行，请重发。' }));
  expect(await h.inbox()).toMatchObject({ state: 'failed' });
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
  expect(h.delivered).toEqual([]);
  // 不再有排定的重试
  await vi.advanceTimersByTimeAsync(600_000);
  await settle();
  expect(h.processCards()).toHaveLength(3);
});

it('keeps the existing handling for failures after the runtime has accepted the task', async () => {
  const h = await harness(0);
  const coordinator = h.createCoordinator();
  await coordinator.handle(message(), config);
  await settle();
  expect(await h.inbox()).toMatchObject({ state: 'accepted', taskId: 'task_runtime' });
  // 接受之后飞书开始抖动，runtime 又报这一轮失败
  h.service.send.mockImplementation(async () => { throw jitter(); });
  for (const listener of h.listeners) {
    listener({ id: 'e_failed', sessionId: 'ses_first_card', sequence: 1, type: 'task', timestamp: '', data: { task: { id: 'task_runtime', status: 'failed' } } } as AgentEvent);
  }
  await settle();
  await vi.advanceTimersByTimeAsync(180_000);
  await settle();

  expect(h.runtime.dispatch).toHaveBeenCalledOnce();
  expect(h.processCards()).toHaveLength(1);
  expect(h.service.replyText).not.toHaveBeenCalled();
  expect(await h.inbox()).toMatchObject({ state: 'accepted', taskId: 'task_runtime' });
});

it('leaves the pending request to restart recovery when the process exits during the wait', async () => {
  const h = await harness(1);
  const first = h.createCoordinator();
  await first.handle(message(), config);
  await settle();
  first.stop();

  const restarted = h.createCoordinator();
  await restarted.initializeWorkflows(config);
  await settle();
  expect(await h.inbox()).toMatchObject({ state: 'accepted', taskId: 'task_runtime' });
  // 旧进程排定的重试不会再跑
  await vi.advanceTimersByTimeAsync(180_000);
  await settle();
  expect(h.runtime.dispatch).toHaveBeenCalledOnce();
  expect(h.processCards().map(input => input.idempotencyKey)).toEqual(['task_om_request_1', 'task_om_request_1']);
});

it('drops the retry when the user has already resent the same request', async () => {
  const h = await harness(1);
  const coordinator = h.createCoordinator();
  await coordinator.handle(message(), config);
  await settle();
  await coordinator.handle(message('om_resent'), config);
  await settle();
  expect(await h.inbox('om_resent')).toMatchObject({ state: 'accepted' });

  await vi.advanceTimersByTimeAsync(180_000);
  await settle();
  expect(h.runtime.dispatch).toHaveBeenCalledOnce();
  expect(await h.inbox()).toMatchObject({ state: 'failed', error: '用户已重新发送同一请求' });
  expect(h.service.replyText).not.toHaveBeenCalled();
});

it('cancels the pending retry and drops the old request when the user sends /new during the wait', async () => {
  const h = await harness(1);
  const coordinator = h.createCoordinator();
  await coordinator.handle(message(), config);
  await settle();
  await coordinator.handle(message('om_new', '/new'), config);
  await settle();
  // /new 自己照常受理，不因为旧请求的认领对不上而报错
  expect(h.delivered.map(input => input.taskName)).toContain('/new 已受理');
  expect(await h.inbox()).toMatchObject({ state: 'failed', error: '请求在执行前被 /new 作废' });

  await vi.advanceTimersByTimeAsync(180_000);
  await settle();
  expect(h.processCards()).toHaveLength(1);
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
  expect(h.service.replyText).not.toHaveBeenCalled();
});

it('drops the old request when /new arrives after the retry has reclaimed it but before the task is built', async () => {
  const h = await harness(1);
  const coordinator = h.createCoordinator();
  await coordinator.handle(message(), config);
  await settle();
  // 重试重新认领之后，卡在确认表情这一步，此时用户发 /new
  let resume!: () => void;
  const reactionGate = new Promise<void>(resolve => { resume = resolve; });
  h.service.addReaction.mockImplementation(async (messageId: unknown) => {
    if (messageId === 'om_request') await reactionGate;
    return { reactionId: 'reaction' };
  });
  const runTurn = vi.spyOn(coordinator as any, 'runTurn');
  await vi.advanceTimersByTimeAsync(30_000);
  await settle();
  expect((await h.inbox()).boot).not.toBe('');
  await coordinator.handle(message('om_new', '/new'), config);
  await settle();
  expect(h.delivered.map(input => input.taskName)).toContain('/new 已受理');
  // /new 用重新认领的那份记录作废，不用等重试自己发现
  expect(await h.inbox()).toMatchObject({ state: 'failed', error: '请求在执行前被 /new 作废' });
  resume();
  await settle();

  expect(runTurn).not.toHaveBeenCalled();
  expect(h.runtime.dispatch).not.toHaveBeenCalled();
  expect(await h.inbox()).toMatchObject({ state: 'failed', error: '请求在执行前被 /new 作废' });
  await vi.advanceTimersByTimeAsync(180_000);
  await settle();
  expect(h.processCards()).toHaveLength(1);
  expect(h.service.replyText).not.toHaveBeenCalled();
});

it('keeps /new working when it lands between the retry reclaiming the record and handing the claim to the task', async () => {
  const h = await harness(1);
  const coordinator = h.createCoordinator();
  await coordinator.handle(message(), config);
  await settle();
  // 重新认领的 CAS 已落库、认领还没交回入站处理时，停住等 /new
  let proceed!: () => void;
  const gate = new Promise<void>(resolve => { proceed = resolve; });
  const compareAndSet = h.store.compareAndSet!.bind(h.store);
  vi.spyOn(h.store, 'compareAndSet').mockImplementation(async (key, expected, value) => {
    const written = await compareAndSet(key, expected, value);
    const reclaim = key.endsWith('.om_request') && JSON.parse(expected ?? '{}').boot === '' && JSON.parse(value).boot !== '';
    if (written && reclaim) await gate;
    return written;
  });
  await vi.advanceTimersByTimeAsync(30_000);
  await settle();
  await coordinator.handle(message('om_new', '/new'), config);
  await settle();
  expect(h.delivered.map(input => input.taskName)).toContain('/new 已受理');
  proceed();
  await settle();

  expect(h.runtime.dispatch).not.toHaveBeenCalled();
  expect(h.processCards()).toHaveLength(1);
  expect(await h.inbox()).toMatchObject({ state: 'failed', error: '请求在执行前被 /new 作废' });
});

it('reports /new as failed when invalidating the waiting request hits a non-conflict write error', async () => {
  const h = await harness(1);
  const coordinator = h.createCoordinator();
  await coordinator.handle(message(), config);
  await settle();
  const compareAndSet = h.store.compareAndSet!.bind(h.store);
  vi.spyOn(h.store, 'compareAndSet').mockImplementation(async (key, expected, value) => {
    if (key.endsWith('.om_request') && JSON.parse(value).state === 'failed') throw new Error('database is locked');
    return compareAndSet(key, expected, value);
  });
  await coordinator.handle(message('om_new', '/new'), config);
  await settle();

  const receipts = h.delivered.map(input => input.taskName);
  expect(receipts).toContain('/new 执行失败');
  expect(receipts).not.toContain('/new 已受理');
});

it('still retries an image request after the same user sends a different image', async () => {
  const h = await harness(1);
  const first = `om_image_${randomUUID()}`;
  const second = `om_image_${randomUUID()}`;
  cleanups.push(async () => { for (const id of [first, second]) await rm(join(tmpdir(), 'dutydeck', 'lark-resources', id), { recursive: true, force: true }); });
  const coordinator = h.createCoordinator();
  // 图片下载后要真实写盘，推进假时钟等不到它，按条件轮询（waitFor 每轮也会推进一点假时钟）。
  const until = (assertion: () => Promise<void> | void) => vi.waitFor(assertion, { timeout: 5_000 });
  await coordinator.handle(image(first), config);
  // 第一张的首卡先失败并排定重试，第二张才进来
  await until(async () => expect(await h.inbox(first)).toMatchObject({ state: 'received', boot: '' }));
  await coordinator.handle(image(second), config);
  await until(async () => expect(await h.inbox(second)).toMatchObject({ state: 'accepted' }));

  await vi.advanceTimersByTimeAsync(30_000);
  // 两张图的文字摘要一样，但不算重发：第一张照常重试并执行
  await until(async () => {
    expect(h.runtime.dispatch).toHaveBeenCalledTimes(2);
    expect(await h.inbox(first)).toMatchObject({ state: 'accepted' });
  });
}, 30_000);
