import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { Session } from '@dutydeck/shared';
import type { SessionNotice } from '@dutydeck/runtime';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import { createLarkCardService, LarkServiceError } from './service.js';
import { deliverLarkSessionNotice } from './session-notice.js';
import { larkUnknownTaskNoticeKey, larkUnknownTaskNoticeRecordKey } from './task-recovery.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const config: StoredLarkConfig = { appId: 'app', appSecret: 'fixture', workspace: '/tmp', defaultAgentId: 'fixture', fullTrustConfirmed: true, listening: true,
  preInjectPrompt: '', structuredAskCards: false, groupCardMention: false, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 60_000,
  hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false, highRiskAllowedUsers: [], highRiskAllowedEmails: [],
  highRiskPattern: 'danger', riskControlMode: 'off', webBaseUrl: 'https://dutydeck.example' };
async function fixture() {
  const repos = createRepositories(':memory:'); cleanups.push(() => repos.close());
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const client = { sendText: vi.fn(async () => ({ messageId: 'om_sent' })), replyText: vi.fn(async () => ({ messageId: 'om_reply' })) };
  const card = (id: string, sessionId: string, extra: Record<string, unknown>, createdAt: string) => repos.channelMappings.save({ id, channel: 'lark-card:app', externalId: `om_${id}`, sessionId, createdAt,
    extra: JSON.stringify({ app_id: 'app', chat_id: 'oc_chat', chat_type: 'group', turn: 1, state: 'completed', ...extra }) });
  const log = { warn: vi.fn() };
  return { repos, client, card, log, deliver: (session: Session, notice: SessionNotice) => deliverLarkSessionNotice(repos, () => client, session, notice, log) };
}
const session = (input: Partial<Session>): Session => ({ id: 'ses_one', agentId: 'fixture', state: 'idle', cwd: '/tmp', runId: 'run', createdAt: '', updatedAt: '', ...input } as Session);
// 与 service.ts request() 抛出的真实形态一致：业务码和上游 HTTP 状态都在 details 里。
const withdrawn = () => new LarkServiceError('LARK_OPENAPI_ERROR', 'Lark OpenAPI request failed: The message was withdrawn. (code: 230011)', 502, { upstreamCode: 230011, upstreamHttpStatus: 400 });
const notice = (input: Partial<SessionNotice>): SessionNotice => ({ id: 'notice_1', kind: 'unknown_task_overdue', taskId: 'task_unknown', message: '这一轮的结果未知。', sessionIds: ['ses_one'], ...input });

describe('runtime session notices in Lark', () => {
  it.each([true, false])('keeps the existing master unknown-result notice (delivered=%s) and only adds missing notice kinds', async delivered => {
    const h = await fixture(), lark = session({ source: 'lark', sourceId: 'app:oc_chat:group:thread:om_root' });
    const attemptId = 'attempt_one';
    const key = larkUnknownTaskNoticeRecordKey(larkUnknownTaskNoticeKey('app', lark.id, 'task_unknown', attemptId));
    const saved = JSON.stringify({ target: { chatId: 'oc_chat' }, markdown: 'master reminder', ...(delivered ? { messageId: 'om_master' } : {}) });
    await h.repos.config.set(key, saved);
    await h.deliver(lark, notice({ attemptId }));
    expect(h.client.sendText).not.toHaveBeenCalled();
    expect(h.client.replyText).not.toHaveBeenCalled();
    expect(await h.repos.config.get(key)).toBe(saved);
    await h.deliver(lark, notice({ id: 'notice_closed', kind: 'unknown_task_abandoned', attemptId }));
    expect(h.client.sendText).toHaveBeenCalledTimes(1);
    await h.deliver(lark, notice({ id: 'notice_missing', attemptId: 'attempt_without_master_notice' }));
    expect(h.client.sendText).toHaveBeenCalledTimes(2);
  });

  it('replies in the thread of the task card, falls back to the latest card, and links the Web session', async () => {
    const h = await fixture(), lark = session({ source: 'lark', sourceId: 'app:oc_chat:group:thread:om_root' });
    await h.card('old', lark.id, { runtime_task_id: 'task_old', reply_message_id: 'om_old_request', reply_in_thread: true }, '2026-10-01T00:00:00.000Z');
    await h.card('own', lark.id, { runtime_task_id: 'task_unknown', reply_message_id: 'om_own_request', reply_in_thread: true }, '2026-09-01T00:00:00.000Z');
    await h.deliver(lark, notice({}));
    expect(h.client.replyText).toHaveBeenCalledWith({ messageId: 'om_own_request', replyInThread: true, idempotencyKey: 'session_notice_notice_1',
      text: '这一轮的结果未知。\n\nWeb 处理入口：https://dutydeck.example/sessions/ses_one' });
    await h.deliver(lark, notice({ id: 'notice_2', taskId: 'task_without_card' }));
    expect(h.client.replyText).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'om_old_request', idempotencyKey: 'session_notice_notice_2' }));
    expect(h.client.sendText).not.toHaveBeenCalled();
  });

  it('leaves a blocked task with its own card to that card, and posts schedule notices to the schedule report target', async () => {
    const h = await fixture(), lark = session({ source: 'lark', sourceId: 'app:oc_chat:group:thread:om_root' });
    await h.card('own', lark.id, { runtime_task_id: 'task_blocked', reply_message_id: 'om_request' }, '2026-09-01T00:00:00.000Z');
    await h.deliver(lark, notice({ kind: 'workspace_blocked', taskId: 'task_blocked', sessionIds: ['ses_holder'] }));
    expect(h.client.replyText).not.toHaveBeenCalled();
    await h.repos.config.set('automation.delivery-target.schedule-1', JSON.stringify({ appId: 'app', chatId: 'oc_report', replyMessageId: 'om_schedule', replyInThread: true }));
    await h.deliver(session({ id: 'ses_schedule', source: 'schedule', sourceId: 'schedule-1' }), notice({ id: 'notice_3', kind: 'workspace_blocked', taskId: 'task_scheduled', sessionIds: ['ses_holder'] }));
    expect(h.client.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_schedule', replyInThread: true, text: expect.stringContaining('/sessions/ses_holder') }));
    await h.deliver(session({ id: 'ses_web' }), notice({ id: 'notice_4' }));
    await h.deliver(session({ id: 'ses_unbound_schedule', source: 'schedule', sourceId: 'schedule-unknown' }), notice({ id: 'notice_5' }));
    expect(h.client.replyText).toHaveBeenCalledTimes(1); expect(h.client.sendText).not.toHaveBeenCalled();
  });
  it('posts in the group when the reply target was withdrawn, keeping the idempotency key and logging the fallback', async () => {
    const h = await fixture(), lark = session({ source: 'lark', sourceId: 'app:oc_chat:group:thread:om_root' });
    await h.card('own', lark.id, { runtime_task_id: 'task_unknown', reply_message_id: 'om_withdrawn', reply_in_thread: true }, '2026-09-01T00:00:00.000Z');
    h.client.replyText.mockRejectedValueOnce(withdrawn());
    await h.deliver(lark, notice({ kind: 'queue_expired' }));
    expect(h.client.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_withdrawn', replyInThread: true, idempotencyKey: 'session_notice_notice_1' }));
    expect(h.client.sendText).toHaveBeenCalledWith({ chatId: 'oc_chat', idempotencyKey: 'session_notice_notice_1',
      text: '这一轮的结果未知。\n\nWeb 处理入口：https://dutydeck.example/sessions/ses_one' });
    expect(h.log.warn).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_withdrawn', chatId: 'oc_chat' }), '回复会话提醒失败，回退为会话内发送');
  });

  it('falls back to the private chat of a p2p anchor', async () => {
    const h = await fixture(), p2p = session({ source: 'lark', sourceId: 'app:oc_p2p:p2p' });
    // 私聊卡片记录不写 reply_message_id，externalId 就是那条请求消息。
    await h.repos.channelMappings.save({ id: 'p2p', channel: 'lark-card:app', externalId: 'om_p2p_request', sessionId: p2p.id, createdAt: '2026-09-01T00:00:00.000Z',
      extra: JSON.stringify({ app_id: 'app', chat_id: 'oc_p2p', chat_type: 'p2p', turn: 1, state: 'completed', runtime_task_id: 'task_unknown' }) });
    h.client.replyText.mockRejectedValueOnce(withdrawn());
    await h.deliver(p2p, notice({}));
    expect(h.client.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_p2p_request' }));
    expect(h.client.replyText.mock.calls[0]![0]).not.toHaveProperty('replyInThread', true);
    expect(h.client.sendText).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_p2p', idempotencyKey: 'session_notice_notice_1' }));
  });

  it('rethrows timeouts without posting a second copy', async () => {
    const h = await fixture(), lark = session({ source: 'lark', sourceId: 'app:oc_chat:group:thread:om_root' });
    await h.card('own', lark.id, { runtime_task_id: 'task_unknown', reply_message_id: 'om_request' }, '2026-09-01T00:00:00.000Z');
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    h.client.replyText.mockRejectedValueOnce(timeout);
    await expect(h.deliver(lark, notice({}))).rejects.toBe(timeout);
    expect(h.client.sendText).not.toHaveBeenCalled(); expect(h.log.warn).not.toHaveBeenCalled();
  });

  it('keeps schedule session notices on the frozen report target when it was withdrawn', async () => {
    const h = await fixture();
    await h.repos.config.set('automation.delivery-target.schedule-1', JSON.stringify({ appId: 'app', chatId: 'oc_report', replyMessageId: 'om_schedule', replyInThread: true }));
    const error = withdrawn();
    h.client.replyText.mockRejectedValueOnce(error);
    await expect(h.deliver(session({ id: 'ses_schedule', source: 'schedule', sourceId: 'schedule-1' }), notice({ kind: 'queue_expired' }))).rejects.toBe(error);
    expect(h.client.sendText).not.toHaveBeenCalled(); expect(h.log.warn).not.toHaveBeenCalled();
  });
  it('recognises the withdrawn reply returned by the Lark HTTP client and posts once to the chat', async () => {
    const h = await fixture(), lark = session({ source: 'lark', sourceId: 'app:oc_chat:group:thread:om_root' });
    await h.card('own', lark.id, { runtime_task_id: 'task_unknown', reply_message_id: 'om_withdrawn', reply_in_thread: true }, '2026-09-01T00:00:00.000Z');
    const writes: Array<{ path: string; body: any }> = [];
    const service = createLarkCardService({ LARK_APP_ID: 'app', LARK_APP_SECRET: 'synthetic' }, (async (url, init) => {
      if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 });
      const path = new URL(String(url)).pathname, body = JSON.parse(String(init?.body)); writes.push({ path, body });
      return path.endsWith('/reply') ? Response.json({ code: 230011, msg: 'The message was withdrawn.' }, { status: 400 })
        : Response.json({ code: 0, data: { message_id: 'om_posted' } });
    }) as typeof fetch);
    cleanups.push(() => service.close());
    await deliverLarkSessionNotice(h.repos, () => service, lark, notice({ kind: 'queue_expired' }), h.log);
    expect(writes.map(write => write.path)).toEqual(['/open-apis/im/v1/messages/om_withdrawn/reply', '/open-apis/im/v1/messages']);
    expect(writes[1]!.body).toMatchObject({ receive_id: 'oc_chat', msg_type: 'text', uuid: writes[0]!.body.uuid });
    expect(h.log.warn).toHaveBeenCalledTimes(1);
  });
});
