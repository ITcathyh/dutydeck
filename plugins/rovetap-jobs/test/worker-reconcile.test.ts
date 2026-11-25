// Independent regression tests for the unknown-submit reconcile scheduler.
//
// The pairfob CLI boundary is mocked so every status/submit call is observed
// with its exact arguments; JobStore is real and persists to a temp directory,
// so "restart" is simulated by reopening the JSON state file with a new worker.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pf = vi.hoisted(() => ({
  submitProjectJob: vi.fn(),
  getProjectStatus: vi.fn(),
}));

vi.mock('../service/pairfob.mjs', () => ({
  submitProjectJob: pf.submitProjectJob,
  getProjectStatus: pf.getProjectStatus,
}));

import { JobWorker } from '../service/worker.mjs';
import { JobStore, newJobRecord, STATE_FILE_NAME } from '../service/store.mjs';

const APP = 'cli_reconcile_unit';
const MESSAGE = 'om_reconcile_1';
const KEY = `lark/${APP}/${MESSAGE}`;

interface Ctx {
  dir: string;
  store: JobStore;
  sender: { idempotent: boolean; calls: any[]; send: ReturnType<typeof vi.fn> };
  worker: JobWorker;
  config: any;
}

let ctx: Ctx | undefined;

async function setup(options: { idempotent?: boolean; sendResult?: any; lark?: object } = {}): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), 'rvj-reconcile-'));
  const store = await JobStore.open(dir);
  const config: any = {
    appId: APP,
    webBaseUrl: 'https://rove.example.com',
    pairfob: { bin: '/bin/true', project: 'rovetap', socket: '', tokenFile: '', timeoutMs: 500, env: {} },
    limits: { maxMaterialChars: 4_000, threadScan: 5 },
    // Large base gives every backoff a multi-second margin, so a blocked call
    // cannot slip through merely because the test machine was slow.
    retryBaseMs: 1_000,
    phasePollMs: 60_000,
    pollMs: 5,
  };
  const calls: any[] = [];
  const result = options.sendResult ?? { outcome: 'sent', messageId: 'om_provider' };
  const sender = {
    idempotent: options.idempotent ?? true,
    calls,
    send: vi.fn(async (arg: any) => {
      calls.push(arg);
      return typeof result === 'function' ? result(arg) : result;
    }),
  };
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const worker = new JobWorker({ config, store, sender, lark: options.lark ?? {}, logger: silent });
  ctx = { dir, store, sender, worker, config };
  return ctx;
}

afterEach(async () => {
  if (ctx) {
    ctx.worker.stop();
    await ctx.store.close().catch(() => {});
    await rm(ctx.dir, { recursive: true, force: true });
    ctx = undefined;
  }
  vi.resetAllMocks();
  vi.useRealTimers();
});

function seedJob(store: JobStore, stage = 'ready') {
  return store.mutate((state) => {
    const job: any = newJobRecord({ sourceKey: KEY, appId: APP, eventId: 'ev_reconcile', messageId: MESSAGE });
    job.chatId = 'oc_dispatch';
    job.rootId = 'om_root';
    job.threadId = 'omt_1';
    job.commanderOpenId = 'ou_boss';
    job.instruction = '跟进这条反馈';
    job.parentId = 'om_material';
    job.material = stage === 'queued' ? null : { messageId: 'om_material', text: '材料正文' };
    job.stage = stage;
    if (stage === 'unknown') job.submit.state = 'unknown';
    state.jobs[KEY] = job;
  });
}

async function makeReconcileDue(store: JobStore) {
  await store.mutate((state) => { state.jobs[KEY].nextRunAt = 0; });
}

describe('rovetap unknown submit: reconcile key and nextRunAt schedule', () => {
  beforeEach(() => {
    pf.submitProjectJob.mockResolvedValue({ outcome: 'unknown', reason: 'timeout_or_signal' });
    pf.getProjectStatus.mockResolvedValue({ outcome: 'not_found', code: 'not_found' });
  });

  it('真实 submit 返回 unknown 后，立即只按原始 source key 核对一次 status', async () => {
    const c = await setup();
    await seedJob(c.store, 'ready');

    await c.worker.kick(KEY);

    expect(pf.submitProjectJob).toHaveBeenCalledTimes(1);
    expect(pf.submitProjectJob.mock.calls[0][0].payload.source_key).toBe(KEY);

    expect(pf.getProjectStatus).toHaveBeenCalledTimes(1);
    const statusOptions = pf.getProjectStatus.mock.calls[0][0];
    expect(statusOptions.sourceKey).toBe(KEY);
    expect(statusOptions.project).toBe('rovetap');

    const job: any = c.store.getJob(KEY);
    expect(job.stage).toBe('unknown');
    expect(job.reconcileAttempts).toBe(1);
    expect(job.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('nextRunAt 未到时，连续 kick、tick 甚至直接调 reconcileStep 都不再查 status / submit', async () => {
    const c = await setup();
    await seedJob(c.store, 'ready');
    await c.worker.kick(KEY);
    expect(pf.getProjectStatus).toHaveBeenCalledTimes(1);

    await c.worker.kick(KEY);
    await c.worker.kick(KEY);
    await c.worker.tick();
    await c.worker.tick();
    await c.worker.reconcileStep(KEY);

    expect(pf.getProjectStatus).toHaveBeenCalledTimes(1);
    expect(pf.submitProjectJob).toHaveBeenCalledTimes(1);
  });

  it('暂时查不到（status error）同样写入退避并阻止连续 tick 打 status', async () => {
    pf.getProjectStatus.mockReset();
    pf.getProjectStatus.mockResolvedValue({ outcome: 'error', reason: 'timeout' });
    const c = await setup();
    await seedJob(c.store, 'unknown');

    await c.worker.kick(KEY);
    expect(pf.getProjectStatus).toHaveBeenCalledTimes(1);
    const firstNextRunAt: number = c.store.getJob(KEY).nextRunAt;
    expect(firstNextRunAt).toBeGreaterThan(Date.now());

    await c.worker.kick(KEY);
    await c.worker.tick();
    await c.worker.tick();
    expect(pf.getProjectStatus).toHaveBeenCalledTimes(1);

    await makeReconcileDue(c.store);
    await c.worker.kick(KEY);
    expect(pf.getProjectStatus).toHaveBeenCalledTimes(2);
    expect(c.store.getJob(KEY).nextRunAt).toBeGreaterThan(firstNextRunAt - 1);
  });

  it('重启后新 worker 仍遵守磁盘上的 nextRunAt，到期才再次核对', async () => {
    const c = await setup();
    await seedJob(c.store, 'ready');
    await c.worker.kick(KEY); // submit unknown -> not_found, nextRunAt in the future
    expect(pf.getProjectStatus).toHaveBeenCalledTimes(1);
    await c.store.close();

    const store2 = await JobStore.open(c.dir);
    const sender2 = { idempotent: true, calls: [] as any[], send: vi.fn(async (arg: any) => { sender2.calls.push(arg); return { outcome: 'sent', messageId: 'om_p2' }; }) };
    const worker2 = new JobWorker({ config: c.config, store: store2, sender: sender2, lark: {}, logger: { info() {}, warn() {}, error() {}, debug() {} } });
    await worker2.recoverInFlightReplies();

    pf.getProjectStatus.mockClear();
    await worker2.tick();
    await worker2.kick(KEY);
    await worker2.reconcileStep(KEY);
    expect(pf.getProjectStatus).not.toHaveBeenCalled();

    // Backoff elapsed: the persisted timestamp becoming due is the only trigger.
    await store2.mutate((state) => { state.jobs[KEY].nextRunAt = 0; });
    pf.getProjectStatus.mockResolvedValue({ outcome: 'ok', taskId: 'pt_000009', leaderId: 'pl_1', phase: 'todo' });
    await worker2.kick(KEY);

    expect(pf.getProjectStatus).toHaveBeenCalledTimes(1);
    expect(pf.getProjectStatus.mock.calls[0][0].sourceKey).toBe(KEY);
    const job: any = store2.getJob(KEY);
    expect(job.stage).toBe('live');
    expect(job.pairfob.taskId).toBe('pt_000009');
    expect(job.replies.pending.status).toBe('sent'); // old reminder untouched by restart
    expect(job.replies.accepted.status).toBe('sent');
    expect(sender2.calls).toHaveLength(1);
    expect(sender2.calls[0].text).toContain('pt_000009');
    worker2.stop();
    await store2.close();
  });
});

describe('rovetap pending reminder is armed once and delivery state is protected', () => {
  beforeEach(() => {
    pf.submitProjectJob.mockResolvedValue({ outcome: 'unknown', reason: 'timeout_or_signal' });
    pf.getProjectStatus.mockResolvedValue({ outcome: 'not_found', code: 'not_found' });
  });

  it('已发送的 pending 提醒不会被后续 NOT_FOUND 核对重置或重发', async () => {
    const c = await setup();
    await seedJob(c.store, 'ready');
    await c.worker.kick(KEY);

    let pending: any = c.store.getJob(KEY).replies.pending;
    expect(pending.status).toBe('sent');
    expect(c.sender.calls).toHaveLength(1);
    const uuid = pending.uuid;

    for (let i = 0; i < 3; i += 1) {
      await makeReconcileDue(c.store);
      await c.worker.kick(KEY);
    }

    pending = c.store.getJob(KEY).replies.pending;
    expect(pending.status).toBe('sent');
    expect(pending.uuid).toBe(uuid); // still one durable record
    expect(c.sender.calls).toHaveLength(1);
    expect(pf.getProjectStatus).toHaveBeenCalledTimes(4); // initial + 3 due re-checks
  });

  it('NOT_FOUND 核对不把已 failed 的提醒记录重置为 pending，也不重发', async () => {
    const c = await setup();
    await seedJob(c.store, 'unknown');
    await c.store.mutate((state) => {
      const reply = c.store.outbound(state, KEY, 'pending');
      reply.status = 'failed';
      reply.attempts = 4;
      reply.error = 'definitive 400';
    });

    await c.worker.kick(KEY);

    const reply: any = c.store.getJob(KEY).replies.pending;
    expect(reply.status).toBe('failed');
    expect(reply.attempts).toBe(4);
    expect(c.sender.calls).toHaveLength(0);
  });

  it.each([false, true])('NOT_FOUND 保留投递状态、UUID 和退避时间（恢复=%s）', async (recover) => {
    const c = await setup({ idempotent: true });
    await seedJob(c.store, 'unknown');
    const uuid = 'fixed-sending-uuid';
    const retryAt = Date.now() + 60_000;
    await c.store.mutate((state) => {
      const reply = c.store.outbound(state, KEY, 'pending');
      reply.uuid = uuid;
      reply.status = 'sending';
      reply.attempts = 1;
      reply.firstAttemptAt = new Date().toISOString();
      reply.firstBackend = 'lark-api';
      reply.firstUuidHeld = true;
      reply.retryAt = retryAt;
    });

    if (recover) await c.worker.recoverInFlightReplies();
    await c.worker.kick(KEY);

    expect(c.store.getJob(KEY).replies.pending).toMatchObject({
      status: recover ? 'unknown' : 'sending', uuid, attempts: 1, retryAt,
    });
    expect(c.sender.calls).toHaveLength(0);
  });

  it('幂等通道送达结果 unknown 时，核对不会把它打回 pending；重试仍走同一 uuid', async () => {    const c = await setup({ sendResult: { outcome: 'unknown', reason: 'server:500' }, idempotent: true });
    await seedJob(c.store, 'ready');
    await c.worker.kick(KEY);

    let pending: any = c.store.getJob(KEY).replies.pending;
    expect(pending.status).toBe('unknown');
    expect(pending.retryAt).toBeGreaterThan(Date.now());
    expect(c.sender.calls).toHaveLength(1);

    // Reconcile schedule becomes due first: must not resurrect the reply to
    // pending or bypass its delivery retryAt.
    await makeReconcileDue(c.store);
    await c.worker.kick(KEY);
    pending = c.store.getJob(KEY).replies.pending;
    expect(pending.status).toBe('unknown');
    expect(c.sender.calls).toHaveLength(1);

    // Once the delivery retryAt is due, flush retries the SAME durable uuid.
    await c.store.mutate((state) => { state.jobs[KEY].replies.pending.retryAt = 0; });
    await c.worker.kick(KEY);
    expect(c.sender.calls).toHaveLength(2);
    expect(c.sender.calls[1].uuid).toBe(c.sender.calls[0].uuid);
    expect(c.store.getJob(KEY).replies.pending.status).toBe('unknown');
  });

  it('非幂等通道的 unknown 提醒既不被重置为 pending，也不自动重发', async () => {
    const c = await setup({ sendResult: { outcome: 'unknown', reason: 'exit_5' }, idempotent: false });
    await seedJob(c.store, 'ready');
    await c.worker.kick(KEY);
    expect(c.store.getJob(KEY).replies.pending.status).toBe('unknown');

    await makeReconcileDue(c.store);
    await c.worker.kick(KEY);
    let pending: any = c.store.getJob(KEY).replies.pending;
    expect(pending.status).toBe('unknown');
    expect(c.sender.calls).toHaveLength(1);

    await c.store.mutate((state) => { state.jobs[KEY].replies.pending.retryAt = 0; });
    await c.worker.kick(KEY);
    pending = c.store.getJob(KEY).replies.pending;
    expect(pending.status).toBe('unknown');
    expect(c.sender.calls).toHaveLength(1);
  });

  it('多次 NOT_FOUND 后查回成功：正常建立 pairfob 并发一次 accepted', async () => {
    const c = await setup();
    await seedJob(c.store, 'ready');
    await c.worker.kick(KEY); // submit unknown + first not_found
    await makeReconcileDue(c.store);
    await c.worker.kick(KEY); // second not_found
    expect(c.store.getJob(KEY).replies.pending.status).toBe('sent');

    await makeReconcileDue(c.store);
    pf.getProjectStatus.mockResolvedValueOnce({ outcome: 'ok', taskId: 'pt_000077', leaderId: 'pl_9', phase: 'doing' });
    await c.worker.kick(KEY);

    const job: any = c.store.getJob(KEY);
    expect(job.pairfob).toMatchObject({ taskId: 'pt_000077', leaderId: 'pl_9', phase: 'doing' });
    // doing is a noisy phase, but accepted must still be delivered once.
    expect(job.replies.accepted.status).toBe('sent');
    const acceptedSends = c.sender.calls.filter((call) => call.text.includes('已接单'));
    expect(acceptedSends).toHaveLength(1);
    expect(acceptedSends[0].text).toContain('pt_000077');
    expect(job.replies.pending.status).toBe('sent');
  });
});

describe('阶段/去重/回执与终态同事务提交，重启后原话题收齐回执', () => {
  it('adoptStatus(done) 一次落库同时包含终态、sentPhases 去重和待发完成回执，随后只发一次', async () => {
    const c = await setup();
    await seedJob(c.store, 'live');
    await c.store.mutate((state) => {
      const j: any = state.jobs[KEY];
      j.pairfob = { taskId: 'pt_1', leaderId: 'pl_1', phase: 'doing', checkedAt: '' };
      j.sentPhases = ['doing'];
    });

    await c.worker.adoptStatus(KEY, { taskId: 'pt_1', leaderId: 'pl_1', phase: 'done' });

    const job: any = c.store.getJob(KEY);
    expect(job.stage).toBe('done');
    expect(job.sentPhases).toContain('done');
    expect(job.replies['phase:done']).toMatchObject({ status: 'pending' });

    // 已 fsync+rename 的磁盘状态必须同时具备三者：旧实现的完成通知在第二次
    // mutate 才入队，adoptStatus 返回后的磁盘上没有 phase:done。
    const onDisk = JSON.parse(await readFile(join(c.dir, STATE_FILE_NAME), 'utf8'));
    const diskJob = onDisk.jobs[KEY];
    expect(diskJob.stage).toBe('done');
    expect(diskJob.sentPhases).toContain('done');
    expect(diskJob.replies['phase:done'].status).toBe('pending');

    await c.worker.kick(KEY);
    const doneSends = c.sender.calls.filter((call: any) => call.text.includes('任务已完成'));
    expect(doneSends).toHaveLength(1);
    expect(c.store.getJob(KEY).replies['phase:done'].status).toBe('sent');
  });

  it('终态事务提交后、回执发送前崩溃：重开 store + 新 worker 仍把接单与完成回执各发一次', async () => {
    const c = await setup();
    await seedJob(c.store, 'unknown');

    // 同一事务内首次确认身份：accepted 与 phase:done 一起 pending。
    await c.worker.adoptStatus(KEY, { taskId: 'pt_2', leaderId: 'pl_2', phase: 'done' });
    await c.store.close(); // 模拟提交后立即崩溃，未执行任何 flush

    const store2 = await JobStore.open(c.dir);
    const sender2 = {
      idempotent: true,
      calls: [] as any[],
      send: vi.fn(async (arg: any) => { sender2.calls.push(arg); return { outcome: 'sent', messageId: 'om_p3' }; }),
    };
    const worker2 = new JobWorker({ config: c.config, store: store2, sender: sender2, lark: {}, logger: { info() {}, warn() {}, error() {}, debug() {} } });
    await worker2.recoverInFlightReplies();
    await worker2.kick(KEY);

    const texts = sender2.calls.map((call: any) => call.text);
    expect(texts.some((t: string) => t.includes('项目已接单') && t.includes('pt_2'))).toBe(true);
    expect(texts.filter((t: string) => t.includes('任务已完成'))).toHaveLength(1);
    expect(sender2.calls).toHaveLength(2);
    const job: any = store2.getJob(KEY);
    expect(job.stage).toBe('done');
    expect(job.replies.accepted.status).toBe('sent');
    expect(job.replies['phase:done'].status).toBe('sent');
    worker2.stop();
    await store2.close();
  });

  it('submit 首次回执已是终态 done：接受与完成通知同事务入队并在本轮都发出', async () => {
    pf.submitProjectJob.mockResolvedValueOnce({ outcome: 'ok', taskId: 'pt_t', leaderId: 'pl_t', phase: 'done' });
    const c = await setup();
    await seedJob(c.store, 'ready');

    await c.worker.kick(KEY);

    const job: any = c.store.getJob(KEY);
    expect(job.stage).toBe('done');
    expect(job.replies.accepted.status).toBe('sent');
    expect(job.replies['phase:done'].status).toBe('sent');
    const texts = c.sender.calls.map((call: any) => call.text);
    expect(texts.some((t: string) => t.includes('已接单') && t.includes('pt_t'))).toBe(true);
    expect(texts.filter((t: string) => t.includes('任务已完成'))).toHaveLength(1);
  });
});

describe('submit 明确错误的退避重试与终局反馈', () => {
  it.each([
    { outcome: 'unreachable', change: 'edited', restart: false },
    { outcome: 'unreachable', change: 'deleted', restart: true },
    { outcome: 'not_spawned', change: 'edited', restart: true },
  ])('retries a proven unsent submit with the saved payload ($outcome, $change, restart=$restart)', async ({ outcome, change, restart }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const material = {
      messageId: 'om_material', chatId: 'oc_dispatch', threadId: 'omt_1',
      messageType: 'text', content: JSON.stringify({ text: '最初的引用内容' }),
    };
    const getMessageItems = vi.fn().mockResolvedValue([material]);
    const lark = { getMessageItems };
    const c = await setup({ lark });
    pf.submitProjectJob
      .mockResolvedValueOnce({ outcome, message: 'request never sent' })
      .mockResolvedValueOnce({ outcome: 'ok', taskId: 'pt_u', leaderId: 'pl_u', phase: 'todo' });
    await seedJob(c.store, 'queued');
    await c.worker.kick(KEY);

    const job = c.store.getJob(KEY);
    const retryAt = job.nextRunAt;
    const firstPayload = pf.submitProjectJob.mock.calls[0][0].payload;
    expect(job.submit.state).toBe(outcome);
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(firstPayload.materials).toEqual([{ message_id: 'om_material', text: '最初的引用内容' }]);
    getMessageItems.mockResolvedValue(change === 'edited'
      ? [{ ...material, content: JSON.stringify({ text: '后来编辑的内容' }) }]
      : [{ ...material, deleted: true }]);

    if (restart) {
      await c.worker.stop();
      await c.store.close();
      c.store = await JobStore.open(c.dir);
      c.worker = new JobWorker({ config: c.config, store: c.store, sender: c.sender, lark });
      await c.worker.recoverInFlightReplies();
    }

    vi.setSystemTime(retryAt - 1);
    await c.worker.kick(KEY);
    expect(pf.submitProjectJob).toHaveBeenCalledTimes(1);
    vi.setSystemTime(retryAt);
    await c.worker.kick(KEY);

    expect(getMessageItems).toHaveBeenCalledTimes(1);
    expect(pf.getProjectStatus).not.toHaveBeenCalled();
    expect(pf.submitProjectJob).toHaveBeenCalledTimes(2);
    const secondPayload = pf.submitProjectJob.mock.calls[1][0].payload;
    expect(JSON.stringify(secondPayload)).toBe(JSON.stringify(firstPayload));
    expect(c.store.getJob(KEY).pairfob.taskId).toBe('pt_u');
  });

  it('a retry with an unknown outcome reconciles the original key without submitting again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    pf.submitProjectJob
      .mockResolvedValueOnce({ outcome: 'unreachable', code: 'unreachable' })
      .mockResolvedValueOnce({ outcome: 'unknown', reason: 'reply lost' });
    pf.getProjectStatus.mockResolvedValue({ outcome: 'not_found', code: 'not_found' });
    const c = await setup();
    await seedJob(c.store);
    await c.worker.kick(KEY);

    vi.setSystemTime(c.store.getJob(KEY).nextRunAt);
    await c.worker.kick(KEY);
    expect(c.store.getJob(KEY).stage).toBe('unknown');
    expect(pf.getProjectStatus).toHaveBeenCalledTimes(1);

    vi.setSystemTime(c.store.getJob(KEY).nextRunAt);
    await c.worker.kick(KEY);
    expect(pf.submitProjectJob).toHaveBeenCalledTimes(2);
    expect(pf.getProjectStatus).toHaveBeenCalledTimes(2);
    expect(pf.getProjectStatus.mock.calls.map(([options]) => options.sourceKey)).toEqual([KEY, KEY]);
  });

  it('recovers the saved material in a queued retry written by the previous version', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const getMessageItems = vi.fn();
    const c = await setup({ lark: { getMessageItems } });
    await c.store.mutate((state) => {
      const job = newJobRecord({ sourceKey: KEY, appId: APP, eventId: 'ev_legacy', messageId: MESSAGE });
      Object.assign(job, {
        material: { messageId: 'om_material', text: '已保存的原文' },
        instruction: '跟进这条反馈',
        nextRunAt: Date.now(),
      });
      Object.assign(job.submit, { state: 'unreachable', attempts: 1 });
      state.jobs[KEY] = job;
    });
    pf.submitProjectJob.mockResolvedValueOnce({ outcome: 'ok', taskId: 'pt_u', leaderId: 'pl_u', phase: 'todo' });

    await c.worker.recoverInFlightReplies();
    await c.worker.kick(KEY);
    expect(getMessageItems).not.toHaveBeenCalled();
    expect(pf.submitProjectJob).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      payload: expect.objectContaining({
        source_key: KEY, materials: [{ message_id: 'om_material', text: '已保存的原文' }],
      }),
    }));
  });

  it.each(['configuration_error', 'not_found', 'conflict'])(
    '%s 是明确终局：stage=failed、原话题收到带码反馈，且不做 status 核对',
    async (code) => {
      pf.submitProjectJob.mockResolvedValueOnce({ outcome: 'rejected', code, message: 'hub verdict' });
      const c = await setup();
      await seedJob(c.store, 'ready');

      await c.worker.kick(KEY);

      const job: any = c.store.getJob(KEY);
      expect(job.stage).toBe('failed');
      expect(job.submit.code).toBe(code);
      expect(job.replies.rejected.status).toBe('sent');
      expect(c.sender.calls[0].text).toContain(code);
      expect(pf.getProjectStatus).not.toHaveBeenCalled();
    },
  );
});
