// End-to-end complement to worker-reconcile.test.ts: real service timer, real
// pairfob executable spawned with the argument array (asserting the status
// lookup hits the original source key), and the fake Lark reply endpoint.

import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { setupHarness, waitFor, APP, type Harness } from './helpers/harness';
import { newJobRecord } from '../service/store.mjs';

let h: Harness | undefined;
afterEach(async () => { if (h) await h.cleanup(); h = undefined; });

const KEY = `lark/${APP}/om_e2e_reconcile`;
const PENDING_TEXT = '接单结果暂时未知';

async function seedUnknownJob(harness: Harness, nextRunAt: number) {
  await harness.svc.store.mutate((state: any) => {
    const job: any = newJobRecord({ sourceKey: KEY, appId: APP, eventId: 'ev_e2e_rec', messageId: 'om_e2e_reconcile' });
    job.chatId = 'oc_dispatch';
    job.rootId = 'om_e2e_root';
    job.threadId = 'omt_e2e';
    job.stage = 'unknown';
    job.submit.state = 'unknown';
    job.nextRunAt = nextRunAt;
    state.jobs[KEY] = job;
  });
}

describe('rovetap reconcile scheduling through the real service', () => {
  it('持久化的 nextRunAt 未到时，真实 tick 不查 status；到期后按原 key 查回并 accepted，且绝不重新 submit', async () => {
    h = await setupHarness();
    await seedUnknownJob(h, Date.now() + 600_000);

    // Many pollMs=8 ticks pass while the backoff is active.
    await new Promise((r) => setTimeout(r, 140));
    expect(h.hub()?.statusCalls ?? 0).toBe(0);
    expect(h.lark.replies.some((r) => r.text.includes(PENDING_TEXT))).toBe(false);

    // The task commits upstream in the meantime; the hub record is keyed by
    // the same stable source key the CLI must pass via `status --key`.
    writeFileSync(h.hubPath, JSON.stringify({
      seq: 1, submitCount: 0, statusCalls: 0,
      keys: { [KEY]: { taskId: 'pt_e2e_0001', leaderId: 'pl_e2e', phase: 'todo' } },
    }));

    await h.svc.store.mutate((state: any) => { state.jobs[KEY].nextRunAt = 0; });
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('项目已接单') && r.text.includes('pt_e2e_0001')), {
      label: 'accepted via original-key status',
    });

    const hub = h.hub();
    expect(hub.statusCalls).toBeGreaterThanOrEqual(1);
    expect(hub.submitCount).toBe(0); // unknown write is never re-issued
    const job = h.svc.store.getJob(KEY);
    expect(job.stage).toBe('live');
    expect(job.pairfob.taskId).toBe('pt_e2e_0001');
  });

  it('连续多轮 NOT_FOUND 只发出一条 pending 提醒', async () => {
    h = await setupHarness(); // default fast backoff retryBaseMs=2, pollMs=8
    await seedUnknownJob(h, 0);

    // Wait until several real reconcile rounds have happened.
    await waitFor(() => (h!.svc.store.getJob(KEY)?.reconcileAttempts ?? 0) >= 4, {
      timeout: 5_000, label: 'several not_found reconciles',
    });
    // Let one more tick land to prove the count stays stable.
    await new Promise((r) => setTimeout(r, 60));

    const pendingReplies = h.lark.replies.filter((r) => r.text.includes(PENDING_TEXT));
    expect(pendingReplies).toHaveLength(1);
    expect(h.lark.replies.some((r) => r.text.includes('项目已接单'))).toBe(false);
    expect(h.hub().submitCount).toBe(0);
  });
});
