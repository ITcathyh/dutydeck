import { afterEach, describe, expect, it } from 'vitest';
import { setupHarness, makeEnvelope, waitFor, type Harness } from './helpers/harness';

let h: Harness | undefined;
afterEach(async () => { if (h) await h.cleanup(); h = undefined; });

describe('rovetap-jobs 230072 merge_forward topic-root receipt fallback (real HTTP stack)', () => {
  it('delivers the accepted receipt to the original /job message after root returns 230072, with one order', async () => {
    h = await setupHarness();
    // The topic root itself is a merged-forward message with readable children.
    h.lark.messages.set('om_root', apiMfRoot());
    h.lark.messages.set('om_child', {
      message_id: 'om_child', chat_id: 'oc_dispatch', thread_id: 'omt_1', root_id: 'om_root',
      upper_message_id: 'om_root', msg_type: 'text', create_time: '1764000001000',
      body: { content: JSON.stringify({ text: '合并转发根里的反馈正文' }) },
    });
    // Feishu explicitly rejects thread replies against a merge_forward root.
    h.lark.replyErrorTargets.set('om_root', { status: 400, code: 230072, msg: 'merge forward reply unsupported' });

    const res = await h.post(makeEnvelope({
      eventId: 'ev_230072', messageId: 'om_job_230072',
      parentId: 'om_root', threadId: 'omt_1', rootId: 'om_root',
      text: '/job rovetap 跟进合并转发话题',
    }));
    expect(res.body.decision).toBe('stop');

    await waitFor(() => h!.hub()?.submitCount === 1, { label: 'one submit' });
    // The already-created order must still get its accepted receipt, redirected.
    await waitFor(
      () => h!.lark.replies.some((r) => r.to === 'om_job_230072' && r.text.includes('项目已接单')),
      { timeout: 8_000, label: 'receipt redirected to /job message' },
    );

    // It first tried the topic root and was deterministically rejected.
    const rootAttempts = h.lark.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages/om_root/reply'));
    expect(rootAttempts.length).toBeGreaterThanOrEqual(1);

    // Every successful recorded receipt landed on the /job command anchor in topic.
    const sentReceipts = h.lark.replies.filter((r) => r.text.includes('项目已接单'));
    expect(sentReceipts.every((r) => r.to === 'om_job_230072')).toBe(true);
    expect(sentReceipts).toHaveLength(1);

    // Same durable uuid across the rejected-root attempt and the redirected send.
    const jobAttempts = h.lark.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages/om_job_230072/reply'));
    expect(jobAttempts.length).toBeGreaterThanOrEqual(1);
    const rootUuid = rootAttempts[0].body.uuid;
    expect(jobAttempts.some((r) => r.body.uuid === rootUuid)).toBe(true);

    // Never falls back to a brand-new chat message endpoint.
    const newMessagePosts = h.lark.requests
      .filter((r) => r.method === 'POST')
      .filter((r) => /\/open-apis\/im\/v1\/messages$/.test(r.path));
    expect(newMessagePosts).toHaveLength(0);

    // Dedup/order count is unaffected by the delivery redirect.
    expect(h.hub().submitCount).toBe(1);
    expect(h.svc.store.listJobs()).toHaveLength(1);
  });
});

function apiMfRoot() {
  return {
    message_id: 'om_root',
    chat_id: 'oc_dispatch',
    thread_id: 'omt_1',
    root_id: 'om_root',
    msg_type: 'merge_forward',
    create_time: '1764000000000',
    body: { content: JSON.stringify({}) },
  };
}
