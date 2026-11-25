// Background state machine. The HTTP layer only commits an inbox record and
// returns stop within the 2s deadline; all network/CLI work happens here.
//
// Invariants:
//  - one async chain per source key (concurrent kicks collapse safely);
//  - a submit whose outcome is unknown is NEVER re-issued: we reconcile with
//    `pairfob project status --key <source_key>`;
//  - task/leader/phase used in receipts come from a persisted verified envelope;
//  - outbound messages own a durable uuid and unknown delivery is protected.

import { createHash } from 'node:crypto';
import { resolveMaterial } from './materials.mjs';
import { submitProjectJob, getProjectStatus } from './pairfob.mjs';
import { replyText } from './messages.mjs';

const ACTIVE_STAGES = new Set(['queued', 'resolving', 'ready', 'submitting', 'unknown', 'live']);
const QUIET_PHASES = new Set(['', 'todo', 'accepted', 'open', 'pending', 'new']);
const DONE_PHASES = new Set(['done', 'succeeded', 'completed', 'complete', 'verified', 'closed']);
const BAD_PHASES = new Set(['failed', 'error', 'cancelled', 'canceled', 'rejected']);
const MAX_IDEMPOTENT_RETRIES = 6;

export class JobWorker {
  constructor({ config, store, sender, lark, logger = console }) {
    this.config = config;
    this.store = store;
    this.sender = sender;
    this.lark = lark;
    this.log = logger;
    this.locks = new Map();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.config.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Serialize all work for one source key; never let one kick reject loudly. */
  kick(sourceKey) {
    const previous = this.locks.get(sourceKey) ?? Promise.resolve();
    const run = previous
      .then(() => this.processLocked(sourceKey))
      .catch((error) => { try { this.log.warn?.({ sourceKey, error: String(error?.message ?? error) }, 'rovetap job failed'); } catch { /* noop */ } });
    this.locks.set(sourceKey, run);
    run.finally(() => { if (this.locks.get(sourceKey) === run) this.locks.delete(sourceKey); });
    return run;
  }

  async tick() {
    let jobs = [];
    try { jobs = this.store.listJobs(); } catch { return; }
    for (const job of jobs) {
      if (this.isActionable(job)) await this.kick(job.sourceKey);
    }
  }

  isActionable(job) {
    if (ACTIVE_STAGES.has(job.stage)) return true;
    return Object.values(job.replies ?? {}).some((r) => r.status === 'pending' || r.status === 'sending');
  }

  /** After a restart, 'sending' records may or may not have been delivered. */
  async recoverInFlightReplies() {
    await this.store.mutate((state) => {
      for (const job of Object.values(state.jobs)) {
        for (const reply of Object.values(job.replies ?? {})) {
          if (reply.status === 'sending') {
            reply.status = this.sender.idempotent ? 'pending' : 'unknown';
            reply.recoveredAt = new Date().toISOString();
          }
        }
        // A submit interrupted mid-spawn is treated as an uncertain write.
        if (job.stage === 'submitting') job.stage = 'unknown';
        if (job.stage === 'resolving') job.stage = 'queued';
      }
    });
  }

  async processLocked(sourceKey) {
    // Always drain due receipts first so denials/guidance are delivered.
    await this.flushDueReplies(sourceKey);
    let job = this.store.getJob(sourceKey);
    if (!job) return;

    switch (job.stage) {
      case 'denied':
      case 'needs_input':
      case 'done':
      case 'failed':
      case 'cancelled':
        return;
      case 'queued':
      case 'resolving':
        return this.resolveMaterialStep(sourceKey);
      case 'ready':
        return this.submitStep(sourceKey);
      case 'submitting':
      case 'unknown':
        await this.mutateJob(sourceKey, (j) => { j.stage = 'unknown'; });
        return this.reconcileStep(sourceKey);
      case 'live':
        return this.pollPhaseStep(sourceKey);
      default:
        return;
    }
  }

  async mutateJob(sourceKey, fn) {
    return this.store.mutate((state) => {
      const job = state.jobs[sourceKey];
      if (!job) return undefined;
      const result = fn(job, state);
      job.updatedAt = new Date().toISOString();
      return result;
    });
  }

  backoff(attempt) {
    const base = this.config.retryBaseMs ?? 500;
    return Math.min(base * 2 ** Math.min(Math.max(0, attempt), 5), 30_000);
  }

  // ---- material -----------------------------------------------------------

  async resolveMaterialStep(sourceKey) {
    const job = this.store.getJob(sourceKey);
    if (job.nextRunAt && Date.now() < job.nextRunAt) return;
    await this.mutateJob(sourceKey, (j) => { j.stage = 'resolving'; });

    const event = {
      chatId: job.chatId, threadId: job.threadId?.startsWith?.('omt_') ? job.threadId : (job.threadId ?? null),
      rootId: job.rootId, parentId: job.parentId, messageId: job.messageId,
    };
    // threadId stored may be root om_ when no omt_; materials falls back to chat scan + root filter.
    if (job.threadId && !job.threadId.startsWith('omt_')) event.threadId = null;

    const result = await resolveMaterial({
      client: this.lark,
      event,
      maxChars: this.config.limits.maxMaterialChars,
      scanLimit: this.config.limits.threadScan,
    });

    if (result.status === 'ok') {
      await this.mutateJob(sourceKey, (j) => { j.material = result.material; j.stage = 'ready'; j.reasonCode = null; });
      return this.submitStep(sourceKey);
    }

    if (result.status === 'need') {
      await this.mutateJob(sourceKey, (j, state) => {
        j.stage = 'needs_input';
        j.reasonCode = result.reason;
        j.reasonDetail = result.detail ?? null;
        this.store.outbound(state, sourceKey, 'need').status = 'pending';
      });
      await this.flushDueReplies(sourceKey);
      return;
    }

    // Transient read failure: back off and retry; never submit without material
    // resolution when material is expected (zero-material is itself a verdict).
    await this.mutateJob(sourceKey, (j) => {
      j.stage = 'queued';
      j.materialAttempts = (j.materialAttempts ?? 0) + 1;
      j.reasonDetail = result.error;
      j.nextRunAt = Date.now() + this.backoff(j.materialAttempts);
    });
  }

  // ---- submit -------------------------------------------------------------

  buildPayload(job) {
    return {
      source_key: job.sourceKey,
      actor: { app_id: job.appId, open_id: job.commanderOpenId },
      thread_id: job.threadId || job.rootId || job.messageId,
      instruction: job.instruction,
      materials: job.material ? [{ message_id: job.material.messageId, text: job.material.text }] : [],
    };
  }

  async submitStep(sourceKey) {
    const job = this.store.getJob(sourceKey);
    if (!job?.material) {
      await this.mutateJob(sourceKey, (j) => { j.stage = 'queued'; });
      return;
    }
    if (!this.config.pairfob.bin) {
      await this.mutateJob(sourceKey, (j) => { j.stage = 'failed'; j.reasonCode = 'pairfob_bin_missing'; });
      this.log.error?.('pairfob.bin 未配置，无法建单');
      return;
    }

    const payload = this.buildPayload(job);
    const fingerprint = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
    await this.mutateJob(sourceKey, (j) => {
      j.stage = 'submitting';
      j.fingerprint = fingerprint;
      j.submit.state = 'spawning';
      j.submit.attempts += 1;
      j.submit.at = new Date().toISOString();
    });

    const result = await submitProjectJob({
      bin: this.config.pairfob.bin,
      project: job.alias || this.config.pairfob.project,
      payload,
      socket: this.config.pairfob.socket,
      tokenFile: this.config.pairfob.tokenFile,
      extraEnv: this.config.pairfob.env,
      timeoutMs: this.config.pairfob.timeoutMs,
    });

    if (result.outcome === 'ok') {
      await this.mutateJob(sourceKey, (j, state) => {
        j.pairfob = {
          project: job.alias || this.config.pairfob.project,
          taskId: result.taskId, leaderId: result.leaderId, phase: result.phase ?? 'todo',
          checkedAt: new Date().toISOString(),
        };
        j.stage = 'live';
        j.submit.state = 'ok';
        j.submit.code = null; j.submit.message = null;
        const reply = this.store.outbound(state, sourceKey, 'accepted');
        if (!reply.status || reply.status === 'pending') reply.status = 'pending';
        if (QUIET_PHASES.has(String(j.pairfob.phase).toLowerCase())) {
          if (!j.sentPhases.includes(j.pairfob.phase)) j.sentPhases.push(j.pairfob.phase);
        }
        j.nextPollAt = Date.now() + (this.config.phasePollMs ?? 5000);
      });
      await this.flushDueReplies(sourceKey);
      return;
    }

    if (result.outcome === 'rejected') {
      await this.mutateJob(sourceKey, (j, state) => {
        j.stage = 'failed';
        j.submit.state = 'rejected';
        j.submit.code = result.code;
        j.submit.message = result.message;
        this.store.outbound(state, sourceKey, 'rejected').status = 'pending';
      });
      await this.flushDueReplies(sourceKey);
      return;
    }

    if (result.outcome === 'not_spawned') {
      // Definitely never wrote: safe to retry after backoff.
      await this.mutateJob(sourceKey, (j) => {
        j.stage = 'queued';
        j.submit.state = 'not_spawned';
        j.submit.message = result.error;
        j.nextRunAt = Date.now() + this.backoff(j.submit.attempts);
      });
      return;
    }

    // outcome 'unknown': a write may have committed. Never resubmit.
    await this.mutateJob(sourceKey, (j) => {
      j.stage = 'unknown';
      j.submit.state = 'unknown';
      j.submit.message = result.reason;
      j.nextRunAt = 0;
    });
    await this.reconcileStep(sourceKey);
  }

  // ---- reconcile / poll ---------------------------------------------------

  async reconcileStep(sourceKey) {
    const job = this.store.getJob(sourceKey);
    const status = await getProjectStatus({
      bin: this.config.pairfob.bin,
      project: job.alias || this.config.pairfob.project,
      sourceKey,
      socket: this.config.pairfob.socket,
      tokenFile: this.config.pairfob.tokenFile,
      extraEnv: this.config.pairfob.env,
      timeoutMs: this.config.pairfob.timeoutMs,
    });

    if (status.outcome === 'ok') {
      await this.adoptStatus(sourceKey, status);
      await this.maybeQueuePhaseReply(sourceKey, status.phase);
      await this.flushDueReplies(sourceKey);
      return;
    }

    if (status.outcome === 'not_found') {
      await this.mutateJob(sourceKey, (j, state) => {
        j.stage = 'unknown';
        j.reconcileAttempts = (j.reconcileAttempts ?? 0) + 1;
        // After the first unsuccessful read, tell the user we are still checking.
        if (j.reconcileAttempts >= 1) this.store.outbound(state, sourceKey, 'pending').status = 'pending';
        j.nextRunAt = Date.now() + this.backoff(j.reconcileAttempts);
      });
      await this.flushDueReplies(sourceKey);
      return;
    }

    await this.mutateJob(sourceKey, (j) => {
      j.stage = 'unknown';
      j.reconcileAttempts = (j.reconcileAttempts ?? 0) + 1;
      j.nextRunAt = Date.now() + this.backoff(j.reconcileAttempts);
    });
  }

  async pollPhaseStep(sourceKey) {
    const job = this.store.getJob(sourceKey);
    if (job.nextPollAt && Date.now() < job.nextPollAt) return;
    const status = await getProjectStatus({
      bin: this.config.pairfob.bin,
      project: job.alias || this.config.pairfob.project,
      sourceKey,
      socket: this.config.pairfob.socket,
      tokenFile: this.config.pairfob.tokenFile,
      extraEnv: this.config.pairfob.env,
      timeoutMs: this.config.pairfob.timeoutMs,
    });
    if (status.outcome !== 'ok') {
      await this.mutateJob(sourceKey, (j) => { j.nextPollAt = Date.now() + this.backoff(j.reconcileAttempts ?? 1); });
      return;
    }
    await this.adoptStatus(sourceKey, status);
    await this.maybeQueuePhaseReply(sourceKey, status.phase);
    await this.flushDueReplies(sourceKey);
  }

  async adoptStatus(sourceKey, status) {
    await this.mutateJob(sourceKey, (j, state) => {
      const firstConfirmed = !j.pairfob?.taskId;
      j.pairfob = {
        project: j.alias || this.config.pairfob.project,
        taskId: status.taskId,
        leaderId: status.leaderId || j.pairfob?.leaderId || '',
        phase: status.phase,
        checkedAt: new Date().toISOString(),
      };
      const phase = String(status.phase ?? '').toLowerCase();
      if (DONE_PHASES.has(phase)) j.stage = 'done';
      else if (BAD_PHASES.has(phase)) j.stage = phase.includes('cancel') ? 'cancelled' : 'failed';
      else j.stage = 'live';
      j.nextPollAt = Date.now() + (this.config.phasePollMs ?? 5000);
      if (firstConfirmed) {
        this.store.outbound(state, sourceKey, 'accepted').status = 'pending';
        if (QUIET_PHASES.has(phase) && !j.sentPhases.includes(status.phase)) j.sentPhases.push(status.phase);
      }
    });
  }

  async maybeQueuePhaseReply(sourceKey, rawPhase) {
    if (!rawPhase) return;
    const phase = String(rawPhase);
    const lower = phase.toLowerCase();
    if (QUIET_PHASES.has(lower)) return;
    await this.mutateJob(sourceKey, (j, state) => {
      if (j.sentPhases.includes(phase)) return;
      j.sentPhases.push(phase);
      this.store.outbound(state, sourceKey, `phase:${phase}`).status = 'pending';
    });
  }

  // ---- outbound -----------------------------------------------------------

  dueReply(job, reply) {
    if (reply.status === 'pending') return true;
    if (reply.status === 'sending') return true; // recovered only at boot; safety
    if (reply.status === 'unknown' && this.sender.idempotent && (reply.attempts ?? 0) < MAX_IDEMPOTENT_RETRIES) {
      return !reply.retryAt || Date.now() >= reply.retryAt;
    }
    return false;
  }

  async flushDueReplies(sourceKey) {
    let job = this.store.getJob(sourceKey);
    if (!job) return;
    for (const kind of Object.keys(job.replies)) {
      job = this.store.getJob(sourceKey);
      const reply = job.replies[kind];
      if (!reply || !this.dueReply(job, reply)) continue;

      const text = replyText(kind, job, this.config);
      if (!text) continue;
      const replyTo = job.replyAnchor || job.rootId || job.messageId;

      await this.mutateJob(sourceKey, (j) => {
        const r = j.replies[kind];
        r.status = 'sending';
        r.attempts = (r.attempts ?? 0) + 1;
        r.lastAttemptAt = new Date().toISOString();
      });

      const result = await this.sender.send({ uuid: reply.uuid, replyTo, text });

      await this.mutateJob(sourceKey, (j) => {
        const r = j.replies[kind];
        if (result.outcome === 'sent') {
          r.status = 'sent';
          r.providerMessageId = result.messageId ?? null;
          r.sentAt = new Date().toISOString();
        } else if (result.outcome === 'unknown') {
          // Protected: durable status; idempotent senders may retry same uuid later.
          r.status = 'unknown';
          r.error = result.reason ?? 'unknown';
          r.retryAt = Date.now() + this.backoff(r.attempts);
        } else {
          r.status = 'failed';
          r.error = result.reason ?? 'failed';
        }
      });
    }
  }
}
