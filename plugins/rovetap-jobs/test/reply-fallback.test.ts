import { describe, expect, it } from 'vitest';
import { JobWorker } from '../service/worker.mjs';

// Drives flushDueReplies against an in-memory store to pin the anchor fallback:
// definitive 230072-style rejection -> one redirect to the original /job
// message; unknown outcomes keep both target and durable uuid.

function makeHarness(script: any[]) {
  const job: any = {
    sourceKey: 'k1',
    stage: 'live', // already-created RoveTap order must still receive receipts
    messageId: 'om_job_cmd',
    rootId: 'om_merge_root',
    replyAnchor: 'om_merge_root',
    threadId: 'omt_1',
    pairfob: { taskId: 'pt_1' },
    replies: { accepted: { uuid: 'uuid-1', status: 'pending', attempts: 0 } },
  };
  const state: any = { jobs: { k1: job } };
  const store = {
    getJob: (id: string) => state.jobs[id],
    mutate: async (fn: (s: any) => unknown) => fn(state),
  };
  const calls: Array<{ uuid: string; replyTo: string; text: string }> = [];
  let n = 0;
  const sender = {
    idempotent: true,
    async send(arg: any) {
      calls.push(arg);
      const result = script[Math.min(n, script.length - 1)];
      n += 1;
      return typeof result === 'function' ? result() : result;
    },
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const worker = new JobWorker({ config: { retryBaseMs: 1 }, store, sender, lark: {}, logger });
  return { worker, store, job, calls };
}

const unavailable = { outcome: 'failed', code: 230072, replyTargetUnavailable: true, reason: 'bad_request' };
const sent = { outcome: 'sent', messageId: 'om_reply_1' };
const unknown = { outcome: 'unknown', reason: 'network:timeout' };

describe('worker receipt anchor fallback (230072 merge_forward root)', () => {
  it('redirects once from the dead root to the original /job message with the same uuid', async () => {
    const h = makeHarness([unavailable, sent]);

    await h.worker.flushDueReplies('k1');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].replyTo).toBe('om_merge_root');
    expect(h.calls[0].uuid).toBe('uuid-1');
    // Persisted one-time redirect; reply stays pending so the next flush sends it.
    let reply = h.job.replies.accepted;
    expect(reply.status).toBe('pending');
    expect(reply.targetMessageId).toBe('om_job_cmd');
    expect(reply.targetFallbackFrom).toBe('om_merge_root');

    await h.worker.flushDueReplies('k1');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].replyTo).toBe('om_job_cmd'); // same topic, original command anchor
    expect(h.calls[1].uuid).toBe('uuid-1'); // dedup key preserved
    reply = h.job.replies.accepted;
    expect(reply.status).toBe('sent');
    expect(reply.providerMessageId).toBe('om_reply_1');
  });

  it('does not switch target on unknown delivery outcome and retries the SAME anchor/uuid', async () => {
    const h = makeHarness([unknown, sent]);

    await h.worker.flushDueReplies('k1');
    let reply = h.job.replies.accepted;
    expect(reply.status).toBe('unknown');
    expect(reply.targetMessageId).toBeUndefined();
    expect(h.calls[0].replyTo).toBe('om_merge_root');

    reply.retryAt = 0; // skip backoff window deterministically
    await h.worker.flushDueReplies('k1');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].replyTo).toBe('om_merge_root'); // target unchanged
    expect(h.calls[1].uuid).toBe('uuid-1');
    expect(h.job.replies.accepted.status).toBe('sent');
  });

  it('ends as failed when a non-target definitive rejection arrives', async () => {
    const h = makeHarness([{ outcome: 'failed', code: 230099, reason: 'content rejected' }]);
    await h.worker.flushDueReplies('k1');
    const reply = h.job.replies.accepted;
    expect(reply.status).toBe('failed');
    expect(reply.targetMessageId).toBeUndefined();
  });

  it('ends as failed without any redirect on 230071 (whole chat does not support topics)', async () => {
    const threadUnsupported = { outcome: 'failed', code: 230071, reason: 'bad_request' };
    const h = makeHarness([threadUnsupported]);

    await h.worker.flushDueReplies('k1');

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].replyTo).toBe('om_merge_root');
    const reply = h.job.replies.accepted;
    expect(reply.status).toBe('failed');
    expect(reply.code).toBe(230071);
    expect(reply.targetMessageId).toBeUndefined();
  });

  it('keeps the original anchor when 230072 arrives after a possibly successful send', async () => {
    const h = makeHarness([unknown, unavailable, sent]);
    await h.worker.flushDueReplies('k1');
    h.job.replies.accepted.retryAt = 0;
    await h.worker.flushDueReplies('k1');
    expect(h.job.replies.accepted.status).toBe('unknown');
    expect(h.job.replies.accepted.targetMessageId).toBeUndefined();
    h.job.replies.accepted.retryAt = 0;
    await h.worker.flushDueReplies('k1');
    expect(h.calls.map(({ replyTo, uuid }) => [replyTo, uuid])).toEqual(
      Array(3).fill(['om_merge_root', 'uuid-1']),
    );
    expect(h.job.replies.accepted.status).toBe('sent');
  });

  it('does not loop when the redirect target itself is unavailable', async () => {
    const h = makeHarness([unavailable, unavailable]);
    await h.worker.flushDueReplies('k1');
    await h.worker.flushDueReplies('k1');
    expect(h.calls.map((c) => c.replyTo)).toEqual(['om_merge_root', 'om_job_cmd']);
    expect(h.job.replies.accepted.status).toBe('failed'); // second definitive rejection is terminal
  });

  it('keeps an already-created (live) job actionable while its receipt is pending', () => {
    const h = makeHarness([unavailable]);
    h.job.stage = 'live';
    h.job.replies.accepted.status = 'pending';
    expect(h.worker.isActionable(h.job)).toBe(true);
    // processLocked drains due replies before the live phase poll, so the accepted
    // receipt of a created order reaches the redirected target on later kicks.
  });
});
