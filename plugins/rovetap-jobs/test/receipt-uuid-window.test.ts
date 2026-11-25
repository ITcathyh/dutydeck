import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore, freshState, newJobRecord } from '../service/store.mjs';
import { JobWorker } from '../service/worker.mjs';

const HOUR_MS = 60 * 60_000;
const SOURCE_KEY = 'lark/cli_window/om_window';

interface FakeSender {
  idempotent: boolean;
  mode: string;
  calls: Array<{ uuid: string; replyTo: string; text: string; deadlineAt?: number }>;
  outcome: Record<string, unknown>;
  send: (arg: { uuid: string; replyTo: string; text: string; deadlineAt?: number }) => Promise<Record<string, unknown>>;
}

function fakeSender(idempotent = true, mode?: string): FakeSender {
  const sender: FakeSender = {
    idempotent,
    mode: mode ?? (idempotent ? 'lark-api' : 'dutydeck-cli'),
    calls: [],
    outcome: { outcome: 'sent', messageId: 'om_fake_sent' },
    async send(arg) {
      sender.calls.push(arg);
      return sender.outcome;
    },
  };
  return sender;
}

describe('rovetap-jobs outbound receipt uuid 1h window', () => {
  let dir: string;
  let store: JobStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rvj-window-'));
    store = new JobStore(join(dir, 'rovetap-jobs-state.json'), freshState());
    await store.mutate((state) => {
      const job = newJobRecord({ sourceKey: SOURCE_KEY, appId: 'cli_window', eventId: 'ev_window', messageId: 'om_window' });
      // 终局任务：调度不能再靠 ACTIVE_STAGES。
      job.stage = 'done';
      job.replyAnchor = 'om_root';
      state.jobs[SOURCE_KEY] = job;
    });
  });

  afterEach(async () => {
    await store.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  async function seedReply(patch: Record<string, unknown> = {}, kind = 'pending') {
    const { legacy, ...overrides } = patch as { legacy?: boolean } & Record<string, unknown>;
    await store.mutate((state) => {
      const reply = store.outbound(state, SOURCE_KEY, kind);
      Object.assign(reply, {
        uuid: 'uuid-fixed-1',
        status: 'unknown',
        attempts: 1,
        retryAt: 0,
        firstAttemptAt: new Date(Date.now() - 60_000).toISOString(),
        // Current-version records prove the first POST rode the durable uuid over lark-api.
        firstBackend: 'lark-api',
        firstUuidHeld: true,
        ...overrides,
      });
      // 模拟旧版本写出的、没有 firstAttemptAt/首发后端归属的状态记录。
      if (legacy) {
        delete (reply as Record<string, unknown>).firstAttemptAt;
        delete (reply as Record<string, unknown>).firstBackend;
        delete (reply as Record<string, unknown>).firstUuidHeld;
      }
    });
    return store.getJob(SOURCE_KEY)!.replies[kind];
  }

  function workerFor(sender: FakeSender) {
    return new JobWorker({ config: { retryBaseMs: 1, pollMs: 5 }, store, sender, lark: null, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  }

  it('durably persists firstAttemptAt before the first network send', async () => {
    await store.mutate((state) => {
      store.outbound(state, SOURCE_KEY, 'pending').status = 'pending';
    });
    const sender = fakeSender();
    let onDiskAtSend: any;
    sender.send = async (arg) => {
      sender.calls.push(arg);
      const raw = JSON.parse(await readFile(store.file, 'utf8'));
      onDiskAtSend = raw.jobs[SOURCE_KEY].replies.pending;
      return { outcome: 'sent', messageId: 'om_disk_1' };
    };
    const worker = workerFor(sender);

    await worker.kick(SOURCE_KEY);

    expect(sender.calls).toHaveLength(1);
    expect(onDiskAtSend.status).toBe('sending');
    expect(onDiskAtSend.firstAttemptAt).toEqual(expect.any(String));
    expect(Number.isFinite(Date.parse(onDiskAtSend.firstAttemptAt))).toBe(true);
    // 首发后端及其“确实持有持久 uuid”的证据在发送前同事务落盘。
    expect(onDiskAtSend.firstBackend).toBe('lark-api');
    expect(onDiskAtSend.firstUuidHeld).toBe(true);
    // 传给后端的绝对截止时刻 = 首次发送 + 1 小时，误差容忍测试执行的几秒。
    const expectedDeadline = Date.parse(onDiskAtSend.firstAttemptAt) + HOUR_MS;
    expect(Math.abs((sender.calls[0].deadlineAt ?? 0) - expectedDeadline)).toBeLessThan(5_000);
    const reply = store.getJob(SOURCE_KEY)!.replies.pending;
    expect(reply.status).toBe('sent');
    expect(reply.firstAttemptAt).toBe(onDiskAtSend.firstAttemptAt);
  });

  it('schedules and retries a proven in-window unknown reply on a terminal job with the same uuid', async () => {
    const firstAt = Date.now() - 60_000;
    await seedReply({ status: 'unknown', firstAttemptAt: new Date(firstAt).toISOString() });
    const sender = fakeSender();
    const worker = workerFor(sender);
    const job = store.getJob(SOURCE_KEY)!;

    expect(worker.isActionable(job)).toBe(true);
    await worker.tick();

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].uuid).toBe('uuid-fixed-1');
    expect(sender.calls[0].replyTo).toBe('om_root');
    // 截止时刻仍从“首次发送”起算，不会因为重试而顺延一小时。
    expect(Math.abs((sender.calls[0].deadlineAt ?? 0) - (firstAt + HOUR_MS))).toBeLessThan(2_000);
    expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('sent');
  });

  it.each([
    { firstBackend: undefined },
    { firstUuidHeld: undefined },
    { uuid: undefined },
  ])('blocks a recent unknown reply with missing provenance %j', async (missing) => {
    await seedReply(missing);
    const sender = fakeSender();
    const worker = workerFor(sender);

    expect(worker.dueReply(store.getJob(SOURCE_KEY)!, store.getJob(SOURCE_KEY)!.replies.pending)).toBe(false);
    expect(worker.isActionable(store.getJob(SOURCE_KEY)!)).toBe(false);
    await worker.kick(SOURCE_KEY);

    expect(sender.calls).toHaveLength(0);
    expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
  });

  it('does not retry an unknown reply older than the 1h Feishu uuid dedup window; stays unknown', async () => {
    await seedReply({ firstAttemptAt: new Date(Date.now() - HOUR_MS - 5_000).toISOString() });
    const sender = fakeSender();
    const worker = workerFor(sender);

    expect(worker.isActionable(store.getJob(SOURCE_KEY)!)).toBe(false);
    await worker.kick(SOURCE_KEY);

    expect(sender.calls).toHaveLength(0);
    const reply = store.getJob(SOURCE_KEY)!.replies.pending;
    expect(reply.status).toBe('unknown');
    expect(reply.uuid).toBe('uuid-fixed-1');
  });

  it('never retries a legacy unknown record without firstAttemptAt because the window is unprovable', async () => {
    await seedReply({ legacy: true, attempts: 2 });
    const sender = fakeSender();
    const worker = workerFor(sender);

    expect(worker.isActionable(store.getJob(SOURCE_KEY)!)).toBe(false);
    await worker.kick(SOURCE_KEY);

    expect(sender.calls).toHaveLength(0);
    expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
  });

  it('blocks an API-first unknown reply after switching the backend to dutydeck-cli', async () => {
    // 记录证明首发走 lark-api 且持有 uuid，但重启后配置切成 CLI：CLI 无法复用同一 uuid。
    await seedReply({ firstAttemptAt: new Date(Date.now() - 10_000).toISOString() });
    const sender = fakeSender(false);
    const worker = workerFor(sender);

    expect(worker.dueReply(store.getJob(SOURCE_KEY)!, store.getJob(SOURCE_KEY)!.replies.pending)).toBe(false);
    expect(worker.isActionable(store.getJob(SOURCE_KEY)!)).toBe(false);
    await worker.kick(SOURCE_KEY);

    expect(sender.calls).toHaveLength(0);
    expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
  });

  it('never retries a CLI-first unknown reply even after switching back to lark-api', async () => {
    // CLI 首发时 uuid 由子进程自铸、我们不持有；切回 API 用的是另一个 uuid，重发可能双帖。
    await seedReply({
      firstAttemptAt: new Date(Date.now() - 10_000).toISOString(),
      firstBackend: 'dutydeck-cli',
      firstUuidHeld: false,
    });
    const sender = fakeSender(true, 'lark-api');
    const worker = workerFor(sender);

    expect(worker.dueReply(store.getJob(SOURCE_KEY)!, store.getJob(SOURCE_KEY)!.replies.pending)).toBe(false);
    await worker.kick(SOURCE_KEY);

    expect(sender.calls).toHaveLength(0);
    expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
  });

  it('still performs the first send through dutydeck-cli, then protects its unknown outcome across a backend switch', async () => {
    await store.mutate((state) => {
      store.outbound(state, SOURCE_KEY, 'need').status = 'pending';
    });
    const cliSender = fakeSender(false, 'dutydeck-cli');
    cliSender.outcome = { outcome: 'unknown', reason: 'dutydeck_unknown_outcome' };
    const cliWorker = workerFor(cliSender);

    await cliWorker.kick(SOURCE_KEY);
    expect(cliSender.calls).toHaveLength(1); // untouched pending is allowed its first CLI send
    let reply = store.getJob(SOURCE_KEY)!.replies.need;
    expect(reply.status).toBe('unknown');
    expect(reply.firstBackend).toBe('dutydeck-cli');
    expect(reply.firstUuidHeld).toBe(false);

    // “重启”为 lark-api 后端：同一份持久状态仍不能证明持有线上那个 CLI uuid。
    const apiSender = fakeSender(true, 'lark-api');
    const apiWorker = workerFor(apiSender);
    expect(apiWorker.isActionable(store.getJob(SOURCE_KEY)!)).toBe(false);
    await apiWorker.kick(SOURCE_KEY);
    expect(apiSender.calls).toHaveLength(0);
    reply = store.getJob(SOURCE_KEY)!.replies.need;
    expect(reply.status).toBe('unknown');
  });

  it('stops after MAX_IDEMPOTENT_RETRIES while keeping unknown', async () => {
    await seedReply({ attempts: 6, retryAt: 0, firstAttemptAt: new Date(Date.now() - 10_000).toISOString() });
    const sender = fakeSender();
    const worker = workerFor(sender);

    expect(worker.dueReply(store.getJob(SOURCE_KEY)!, store.getJob(SOURCE_KEY)!.replies.pending)).toBe(false);
    await worker.kick(SOURCE_KEY);
    expect(sender.calls).toHaveLength(0);
    expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
  });

  describe('restart recovery of sending records', () => {
    async function recover(patch: Record<string, unknown>, idempotent = true) {
      await seedReply({ status: 'sending', attempts: 1, retryAt: undefined, ...patch });
      const sender = fakeSender(idempotent);
      const worker = workerFor(sender);
      await worker.recoverInFlightReplies();
      return { sender, worker, reply: store.getJob(SOURCE_KEY)!.replies.pending };
    }

    it('recovers an interrupted send as unknown and retries the same uuid within the window', async () => {
      const { sender, worker } = await recover({ firstAttemptAt: new Date(Date.now() - 5 * 60_000).toISOString() });
      expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');

      await worker.kick(SOURCE_KEY);
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].uuid).toBe('uuid-fixed-1');
      expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('sent');
    });

    it('keeps a sixth attempt interrupted by a restart unknown without spawning a seventh', async () => {
      const { sender, worker, reply } = await recover({ attempts: 6 });
      expect(reply.status).toBe('unknown');
      await worker.kick(SOURCE_KEY);
      expect(sender.calls).toHaveLength(0);
    });

    it('marks an over-window sending record unknown and never resends it', async () => {
      const { sender, worker, reply } = await recover({ firstAttemptAt: new Date(Date.now() - HOUR_MS - 1000).toISOString() });
      expect(reply.status).toBe('unknown');

      await worker.kick(SOURCE_KEY);
      expect(sender.calls).toHaveLength(0);
      expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
    });

    it('marks a legacy sending record without firstAttemptAt unknown instead of re-sending', async () => {
      const { sender, worker, reply } = await recover({ legacy: true });
      expect(reply.status).toBe('unknown');

      await worker.kick(SOURCE_KEY);
      expect(sender.calls).toHaveLength(0);
      expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
    });

    it('marks an API-first sending record unknown after restarting with dutydeck-cli (backend switch)', async () => {
      const { sender, worker, reply } = await recover(
        { firstAttemptAt: new Date(Date.now() - 1000).toISOString() }, false);
      expect(reply.status).toBe('unknown');

      await worker.kick(SOURCE_KEY);
      expect(sender.calls).toHaveLength(0);
    });

    it('keeps a CLI-first sending record unknown even when the restarted backend is lark-api', async () => {
      const { sender, worker, reply } = await recover({
        firstAttemptAt: new Date(Date.now() - 1000).toISOString(),
        firstBackend: 'dutydeck-cli',
        firstUuidHeld: false,
      }, true);
      expect(reply.status).toBe('unknown');

      await worker.kick(SOURCE_KEY);
      expect(sender.calls).toHaveLength(0);
      expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
    });
  });

  describe('scheduling without boot recovery', () => {
    it('settles an over-window sending record to unknown during flush and never sends', async () => {
      await seedReply({ status: 'sending', firstAttemptAt: new Date(Date.now() - HOUR_MS - 1000).toISOString() });
      const sender = fakeSender();
      const worker = workerFor(sender);

      await worker.flushDueReplies(SOURCE_KEY);

      expect(sender.calls).toHaveLength(0);
      expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
    });

    it('settles an in-flight record to unknown during flush when the backend has switched to CLI', async () => {
      await seedReply({ status: 'sending', firstAttemptAt: new Date(Date.now() - 1000).toISOString() });
      const sender = fakeSender(false);
      const worker = workerFor(sender);

      await worker.flushDueReplies(SOURCE_KEY);

      expect(sender.calls).toHaveLength(0);
      expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
    });
  });
});
