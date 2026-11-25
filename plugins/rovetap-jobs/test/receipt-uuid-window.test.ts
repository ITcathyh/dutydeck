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
  calls: Array<{ uuid: string; replyTo: string; text: string }>;
  outcome: Record<string, unknown>;
  send: (arg: { uuid: string; replyTo: string; text: string }) => Promise<Record<string, unknown>>;
}

function fakeSender(idempotent = true): FakeSender {
  const sender: FakeSender = {
    idempotent,
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
        ...overrides,
      });
      // 模拟旧版本写出的、没有 firstAttemptAt 的状态记录。
      if (legacy) delete (reply as Record<string, unknown>).firstAttemptAt;
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
    const reply = store.getJob(SOURCE_KEY)!.replies.pending;
    expect(reply.status).toBe('sent');
    expect(reply.firstAttemptAt).toBe(onDiskAtSend.firstAttemptAt);
  });

  it('schedules and retries an in-window unknown reply on a terminal job with the same uuid', async () => {
    await seedReply({ status: 'unknown', firstAttemptAt: new Date(Date.now() - 60_000).toISOString() });
    const sender = fakeSender();
    const worker = workerFor(sender);
    const job = store.getJob(SOURCE_KEY)!;

    expect(worker.isActionable(job)).toBe(true);
    await worker.tick();

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].uuid).toBe('uuid-fixed-1');
    expect(sender.calls[0].replyTo).toBe('om_root');
    expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('sent');
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

  it('does not retry unknown in dutydeck-cli mode even inside the window (each CLI mints a new uuid)', async () => {
    await seedReply({ firstAttemptAt: new Date(Date.now() - 10_000).toISOString() });
    const sender = fakeSender(false);
    const worker = workerFor(sender);

    expect(worker.dueReply(store.getJob(SOURCE_KEY)!, store.getJob(SOURCE_KEY)!.replies.pending)).toBe(false);
    expect(worker.isActionable(store.getJob(SOURCE_KEY)!)).toBe(false);
    await worker.kick(SOURCE_KEY);

    expect(sender.calls).toHaveLength(0);
    expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
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

    it('requeues a sending record whose firstAttemptAt is inside the window and retries the same uuid', async () => {
      const { sender, worker } = await recover({ firstAttemptAt: new Date(Date.now() - 5 * 60_000).toISOString() });
      expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('pending');

      await worker.kick(SOURCE_KEY);
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].uuid).toBe('uuid-fixed-1');
      expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('sent');
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

    it('marks a CLI-mode sending record unknown and never respawns a send', async () => {
      const { sender, worker, reply } = await recover(
        { firstAttemptAt: new Date(Date.now() - 1000).toISOString() }, false);
      expect(reply.status).toBe('unknown');

      await worker.kick(SOURCE_KEY);
      expect(sender.calls).toHaveLength(0);
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

    it('settles a CLI sending record to unknown during flush instead of respawning', async () => {
      await seedReply({ status: 'sending', firstAttemptAt: new Date(Date.now() - 1000).toISOString() });
      const sender = fakeSender(false);
      const worker = workerFor(sender);

      await worker.flushDueReplies(SOURCE_KEY);

      expect(sender.calls).toHaveLength(0);
      expect(store.getJob(SOURCE_KEY)!.replies.pending.status).toBe('unknown');
    });
  });
});
