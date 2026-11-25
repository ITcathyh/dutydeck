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

async function setup(options: { idempotent?: boolean; sendResult?: any } = {}): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), 'rvj-reconcile-'));
  const store = await JobStore.open(dir);
  const config: any = {
    appId: APP,
    webBaseUrl: 'https://rove.example.com',
    pairfob: { bin: '/bin/true', project: 'rovetap', socket: '', tokenFile: '', timeoutMs: 500, env: {} },
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
  const worker = new JobWorker({ config, store, sender, lark: {}, logger: silent });
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
});

function seedJob(store: JobStore, stage = 'ready') {
  return store.mutate((state) => {
    const job: any = newJobRecord({ sourceKey: KEY, appId: APP, eventId: 'ev_reconcile', messageId: MESSAGE });
    job.chatId = 'oc_dispatch';
    job.rootId = 'om_root';
    job.threadId = 'omt_1';
    job.commanderOpenId = 'ou_boss';
    job.instruction = '跟进这条反馈';
    job.material = { messageId: 'om_material', text: '材料正文' };
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

  it('NOT_FOUND 核对不把窗口内等待 retryAt 的 sending 记录重置为 pending', async () => {
    const c = await setup({ idempotent: true });
    await seedJob(c.store, 'unknown');
    const uuid = 'fixed-sending-uuid';
    await c.store.mutate((state) => {
      const reply = c.store.outbound(state, KEY, 'pending');
      reply.uuid = uuid;
      reply.status = 'sending';
      reply.attempts = 1;
      reply.firstAttemptAt = new Date().toISOString();
      reply.retryAt = Date.now() + 60_000; // backoff not due: flush must not touch it
    });

    await c.worker.kick(KEY);

    const reply: any = c.store.getJob(KEY).replies.pending;
    expect(reply.status).toBe('sending'); // not downgraded to 'pending' by reconcile
    expect(reply.uuid).toBe(uuid);
    expect(reply.attempts).toBe(1);
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
  it('unreachable（拨号失败、未写字节）：材料保留、退回 queued 退避，到期可用同一 payload 再提交', async () => {
    pf.submitProjectJob.mockResolvedValueOnce({ outcome: 'unreachable', code: 'unreachable', message: 'no socket' });
    const c = await setup();
    await seedJob(c.store, 'ready');

    await c.worker.kick(KEY);
    let job: any = c.store.getJob(KEY);
    expect(job.stage).toBe('queued');
    expect(job.submit.state).toBe('unreachable');
    expect(job.nextRunAt).toBeGreaterThan(Date.now());
    expect(job.material).toMatchObject({ messageId: 'om_material' });
    expect(pf.submitProjectJob).toHaveBeenCalledTimes(1);
    const firstPayload = pf.submitProjectJob.mock.calls[0][0].payload;

    // 不经过会重新读 Lark 材料的 queued 步骤，直接在材料已就绪的 ready 态安全重提。
    await c.store.mutate((state) => { state.jobs[KEY].stage = 'ready'; state.jobs[KEY].nextRunAt = 0; });
    pf.submitProjectJob.mockResolvedValueOnce({ outcome: 'ok', taskId: 'pt_u', leaderId: 'pl_u', phase: 'todo' });
    await c.worker.submitStep(KEY);

    expect(pf.submitProjectJob).toHaveBeenCalledTimes(2);
    const secondOptions = pf.submitProjectJob.mock.calls[1][0];
    expect(secondOptions.payload).toEqual(firstPayload); // 原消息与已解析材料不变
    expect(c.store.getJob(KEY).pairfob.taskId).toBe('pt_u');
  });

  it.each(['configuration_error', 'not_found', 'project_closed'])(
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
