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
// 飞书同一个 uuid 只在首次尝试后的 1 小时内去重（与 server reconciler 的投递窗口一致）：
// 超窗再发，前一次若已送达就会在群里出现两条回执。
const UUID_DEDUP_WINDOW_MS = 60 * 60_000;
const MATERIAL_CHOICES_TTL_MS = 24 * 60 * 60_000;

function replyDeadlineAt(firstAttemptAt) {
  const time = typeof firstAttemptAt === 'number' ? firstAttemptAt : Date.parse(firstAttemptAt);
  return time + UUID_DEDUP_WINDOW_MS;
}

function submitWasNotSent(outcome) {
  return outcome === 'not_spawned' || outcome === 'unreachable';
}

export class JobWorker {
  constructor({ config, store, sender, lark, logger = console }) {
    this.config = config;
    this.store = store;
    this.sender = sender;
    this.lark = lark;
    this.log = logger;
    this.locks = new Map();
    this.timer = null;
    this.stopping = false;
    this.stopPromise = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.config.pollMs);
    this.timer.unref?.();
  }

  /**
   * Stop polling and resolve once every kicked chain has settled, so callers
   * can close the store without cutting a durable write. Kicks arriving after
   * stop begins are ignored: their inbox record is already durable and the
   * next generation recovers it. Idempotent; concurrent calls share one wait.
   */
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopPromise = (async () => {
      // A concurrent kick replaces the per-key chain with a chained promise,
      // so re-check until the map actually drains. The stopping flag prevents
      // fresh registrations.
      while (this.locks.size > 0) {
        await Promise.allSettled([...this.locks.values()]);
      }
    })();
    return this.stopPromise;
  }

  /** Serialize all work for one source key; never let one kick reject loudly. */
  kick(sourceKey) {
    if (this.stopping) return Promise.resolve();
    const previous = this.locks.get(sourceKey) ?? Promise.resolve();
    const run = previous
      .then(() => this.processLocked(sourceKey))
      .catch((error) => { try { this.log.warn?.({ sourceKey, error: String(error?.message ?? error) }, 'rovetap job failed'); } catch { /* noop */ } });
    this.locks.set(sourceKey, run);
    run.finally(() => { if (this.locks.get(sourceKey) === run) this.locks.delete(sourceKey); });
    return run;
  }

  async tick() {
    if (this.stopping) return;
    let jobs = [];
    try { jobs = this.store.listJobs(); } catch { return; }
    for (const job of jobs) {
      if (this.stopping) return;
      if (this.isActionable(job)) await this.kick(job.sourceKey);
    }
  }

  isActionable(job) {
    if (ACTIVE_STAGES.has(job.stage)) return true;
    // 终局任务（done/failed/…）的回执也可能在退避重试：按 dueReply 判定是否真的到期。
    return Object.values(job.replies ?? {}).some((reply) => this.dueReply(job, reply));
  }

  get replyBackend() {
    return this.sender.mode ?? (this.sender.idempotent ? 'lark-api' : 'dutydeck-cli');
  }

  /**
   * An uncertain delivery can be retried only with the original backend and
   * its durable UUID, within that UUID's Feishu deduplication window.
   */
  attemptedReplyRetryable(reply) {
    const remaining = replyDeadlineAt(reply.firstAttemptAt) - Date.now();
    return reply.firstUuidHeld === true
      && reply.firstBackend === this.replyBackend
      && this.sender.idempotent === true
      && typeof reply.uuid === 'string' && reply.uuid.length > 0
      && (reply.attempts ?? 0) < MAX_IDEMPOTENT_RETRIES
      && remaining > 0 && remaining <= UUID_DEDUP_WINDOW_MS;
  }

  /** After a restart, 'sending' records may or may not have been delivered. */
  async recoverInFlightReplies() {
    await this.store.mutate((state) => {
      for (const job of Object.values(state.jobs)) {
        for (const reply of Object.values(job.replies ?? {})) {
          // 旧版本恢复过一次的在途 pending 也带 attempts>0，同样可能已经发出。
          const inFlight = reply.status === 'sending'
            || (reply.status === 'pending' && (reply.attempts ?? 0) > 0);
          if (!inFlight) continue;
          const redirectQueued = reply.status === 'pending' && reply.targetFallbackFrom;
          if (!redirectQueued || !this.attemptedReplyRetryable(reply)) reply.status = 'unknown';
          reply.recoveredAt = new Date().toISOString();
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
        // Older persisted jobs could be queued behind a proven-unsent submit.
        if (job.material && submitWasNotSent(job.submit.state)) return this.submitStep(sourceKey);
        return this.resolveMaterialStep(sourceKey);
      case 'ready':
        return this.submitStep(sourceKey);
      case 'submitting':
      case 'unknown':
        // nextRunAt is the durable reconcile backoff; ticks, kicks and a fresh
        // post-restart worker all wait for it before another status lookup.
        if (job.nextRunAt && Date.now() < job.nextRunAt) return;
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
      chatId: job.chatId, threadId: job.threadId,
      rootId: job.rootId, parentId: job.parentId, messageId: job.messageId,
      selectedMaterialId: job.selectedMaterialId,
      commandCreateTime: job.commandCreateTime ?? null,
    };

    const result = await resolveMaterial({
      client: this.lark,
      event,
      maxChars: this.config.limits.maxMaterialChars,
      scanLimit: this.config.limits.threadScan,
    });

    if (result.status === 'ok') {
      await this.mutateJob(sourceKey, (j) => {
        j.material = result.material;
        j.threadId = result.threadId ?? j.threadId;
        j.rootId = result.rootId ?? j.rootId;
        j.stage = 'ready';
        j.reasonCode = null;
        j.materialChoices = [];
        j.materialChoicesExpireAt = null;
      });
      return this.submitStep(sourceKey);
    }

    if (result.status === 'need') {
      await this.mutateJob(sourceKey, (j, state) => {
        j.stage = 'needs_input';
        j.reasonCode = j.selectedMaterialId ? 'selected_material_unavailable' : result.reason;
        j.reasonDetail = result.detail ?? null;
        j.threadId = result.threadId ?? j.threadId;
        j.rootId = result.rootId ?? j.rootId;
        j.commandCreateTime = result.commandCreateTime ?? j.commandCreateTime;
        j.materialChoices = result.choices ?? [];
        j.materialChoicesExpireAt = j.materialChoices.length ? Date.now() + MATERIAL_CHOICES_TTL_MS : null;
        this.store.outbound(state, sourceKey, j.selectedMaterialId ? 'need:selected' : 'need').status = 'pending';
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

  #pairfobOptions(job) {
    const { bin, project, socket, tokenFile, env, timeoutMs } = this.config.pairfob;
    return { bin, project: job.alias || project, socket, tokenFile, extraEnv: env, timeoutMs };
  }

  async submitStep(sourceKey) {
    const job = this.store.getJob(sourceKey);
    if (job?.nextRunAt && Date.now() < job.nextRunAt) return;
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
      j.nextRunAt = 0;
      j.fingerprint = fingerprint;
      j.submit.state = 'spawning';
      j.submit.attempts += 1;
      j.submit.at = new Date().toISOString();
    });

    const result = await submitProjectJob({ ...this.#pairfobOptions(job), payload });

    if (result.outcome === 'ok') {
      await this.mutateJob(sourceKey, (j, state) => {
        j.submit.state = 'ok';
        j.submit.code = null; j.submit.message = null;
        // Same atomic adoption as poll/reconcile: a submit receipt can already
        // carry a terminal phase, and its completion notice must commit with it.
        this.commitStatusAdoption(sourceKey, j, state, {
          taskId: result.taskId,
          leaderId: result.leaderId,
          phase: result.phase ?? 'todo',
        });
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

    if (submitWasNotSent(result.outcome)) {
      // Both are proven never written: a spawn-level ENOENT/EACCES, or the real
      // pairfob CLI's 'unreachable' envelope, which cmd/pairfob/project.go
      // emits only when dialing the socket failed before any byte was sent.
      // Keep the resolved material and back off to a safe resubmission.
      await this.mutateJob(sourceKey, (j) => {
        j.stage = 'ready';
        j.submit.state = result.outcome;
        j.submit.message = result.message ?? result.error ?? result.code ?? result.outcome;
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
    if (!job) return;
    // Same schedule gate for direct callers. The immediate call after a real
    // unknown submit persists nextRunAt=0 and therefore still runs at once.
    if (job.nextRunAt && Date.now() < job.nextRunAt) return;
    const status = await getProjectStatus({ ...this.#pairfobOptions(job), sourceKey });

    if (status.outcome === 'ok') {
      await this.adoptStatus(sourceKey, status);
      await this.flushDueReplies(sourceKey);
      return;
    }

    if (status.outcome === 'not_found') {
      await this.mutateJob(sourceKey, (j, state) => {
        j.stage = 'unknown';
        j.reconcileAttempts = (j.reconcileAttempts ?? 0) + 1;
        // The "still checking" reminder is one durable outbound record. Only
        // outbound()'s first creation arms it (as 'pending'); an existing
        // record is NEVER reset to pending here — not 'sent' (would
        // re-notify), 'unknown' (would bypass same-uuid backoff), 'failed'
        // (definitive send rejection) nor 'sending' (its retry is governed by
        // the durable firstAttemptAt/UUID window in flushDueReplies).
        this.store.outbound(state, sourceKey, 'pending');
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
    const status = await getProjectStatus({ ...this.#pairfobOptions(job), sourceKey });
    if (status.outcome !== 'ok') {
      await this.mutateJob(sourceKey, (j) => { j.nextPollAt = Date.now() + this.backoff(j.reconcileAttempts ?? 1); });
      return;
    }
    await this.adoptStatus(sourceKey, status);
    await this.flushDueReplies(sourceKey);
  }

  /**
   * Atomically adopt one verified project status inside the caller's
   * store.mutate transaction: identity, terminal/live stage, next poll time,
   * the accepted receipt and the deduped visible-phase receipt are all part of
   * the same durable commit. A crash right after commit therefore always leaves
   * a terminal job with its completion notice already queued. Must be invoked
   * inside a mutate callback with its live `state`; do not await or do I/O here.
   */
  commitStatusAdoption(sourceKey, j, state, status) {
    const firstConfirmed = !j.pairfob?.taskId;
    const rawPhase = status.phase ?? '';
    j.pairfob = {
      project: j.alias || this.config.pairfob.project,
      taskId: status.taskId,
      leaderId: status.leaderId || j.pairfob?.leaderId || '',
      phase: rawPhase,
      checkedAt: new Date().toISOString(),
    };
    const lowerPhase = String(rawPhase).toLowerCase();
    if (DONE_PHASES.has(lowerPhase)) j.stage = 'done';
    else if (BAD_PHASES.has(lowerPhase)) j.stage = lowerPhase.includes('cancel') ? 'cancelled' : 'failed';
    else j.stage = 'live';
    j.nextPollAt = Date.now() + (this.config.phasePollMs ?? 5000);

    if (firstConfirmed) {
      this.store.outbound(state, sourceKey, 'accepted').status = 'pending';
      if (QUIET_PHASES.has(lowerPhase) && !j.sentPhases.includes(rawPhase)) j.sentPhases.push(rawPhase);
    }
    this.queuePhaseReceipt(sourceKey, j, state, rawPhase);
  }

  /**
   * Dedup and enqueue a visible phase receipt inside the adoption transaction.
   * Quiet phases (todo/open/…) make no thread noise. Must run in store.mutate.
   */
  queuePhaseReceipt(sourceKey, j, state, rawPhase) {
    if (!rawPhase) return;
    const phase = String(rawPhase);
    if (QUIET_PHASES.has(phase.toLowerCase())) return;
    if (j.sentPhases.includes(phase)) return;
    j.sentPhases.push(phase);
    this.store.outbound(state, sourceKey, `phase:${phase}`).status = 'pending';
  }

  async adoptStatus(sourceKey, status) {
    await this.mutateJob(sourceKey, (j, state) => {
      this.commitStatusAdoption(sourceKey, j, state, status);
    });
  }

  // ---- outbound -----------------------------------------------------------

  dueReply(job, reply) {
    if (reply.supersededAt) return false;
    // 没有任何发送痕迹的 pending 确定未发出，可以首发（firstAttemptAt 与后端归属在发送前持久化）。
    const untouchedPending = reply.status === 'pending'
      && (reply.attempts ?? 0) === 0 && reply.firstAttemptAt == null;
    if (untouchedPending) return true;
    if (reply.status !== 'pending' && reply.status !== 'sending' && reply.status !== 'unknown') return false;
    // 其余记录都意味着可能已经发出去过：按首发后端证明的幂等归属与 1 小时窗口判定，
    // 后端切换、CLI 首发、超窗或旧记录都不重发，保守保持 unknown。
    if (!this.attemptedReplyRetryable(reply)) return false;
    return !reply.retryAt || Date.now() >= reply.retryAt;
  }

  async flushDueReplies(sourceKey) {
    let job = this.store.getJob(sourceKey);
    if (!job) return;
    for (const kind of Object.keys(job.replies)) {
      job = this.store.getJob(sourceKey);
      const reply = job.replies[kind];
      if (!reply || reply.supersededAt) continue;
      if (!this.dueReply(job, reply)) {
        // 没经过启动恢复就调度到时，被 CLI/窗口挡住的在途记录也要落为 unknown，不能一直停在 sending。
        const inFlight = reply.status === 'sending'
          || (reply.status === 'pending' && (reply.attempts ?? 0) > 0);
        if (inFlight && !this.attemptedReplyRetryable(reply)) {
          await this.mutateJob(sourceKey, (j) => { j.replies[kind].status = 'unknown'; });
        }
        continue;
      }

      const text = replyText(kind, job, this.config);
      if (!text) continue;
      // A prior definitive 230072-style rejection may have persisted a one-time
      // redirect to the original /job command message; honour it on every retry.
      const replyTo = reply.targetMessageId || job.replyAnchor || job.rootId || job.messageId;
      const priorOutcomeUnknown = reply.status === 'unknown' || reply.status === 'sending'
        || ((reply.attempts ?? 0) > 0 && !reply.targetFallbackFrom);

      const firstAttemptAt = await this.mutateJob(sourceKey, (j) => {
        const r = j.replies[kind];
        if (r.supersededAt) return null;
        r.status = 'sending';
        r.attempts = (r.attempts ?? 0) + 1;
        r.lastAttemptAt = new Date().toISOString();
        // 必须在真正发送前随事务落盘：重启后靠它证明仍在飞书 uuid 的 1 小时窗口内。
        if (r.firstAttemptAt == null) {
          r.firstAttemptAt = r.lastAttemptAt;
          // 首发实际使用的后端，以及它是否把我们的持久 uuid 放上了请求：
          // 日后切换 dutydeck-cli / lark-api 时，只按这份首发幂等证据判定能否重发。
          r.firstBackend = this.replyBackend;
          r.firstUuidHeld = this.sender.idempotent === true;
        }
        return r.firstAttemptAt;
      });
      if (!firstAttemptAt || this.store.getJob(sourceKey)?.replies[kind]?.supersededAt) continue;
      const deadlineAt = replyDeadlineAt(firstAttemptAt);
      const result = await this.sender.send({ uuid: reply.uuid, replyTo, text, deadlineAt });

      let redirected = null;
      await this.mutateJob(sourceKey, (j) => {
        const r = j.replies[kind];
        if (result.outcome === 'sent') {
          r.status = 'sent';
          r.providerMessageId = result.messageId ?? null;
          r.sentAt = new Date().toISOString();
        } else if (result.outcome === 'unknown' || priorOutcomeUnknown) {
          // A later refusal cannot rule out delivery of an earlier attempt.
          // Keep the original target and durable UUID for any retries.
          r.status = 'unknown';
          r.error = result.reason ?? 'unknown';
          r.retryAt = Date.now() + this.backoff(r.attempts);
        } else if (result.replyTargetUnavailable === true && replyTo !== j.messageId) {
          // Definitive “anchor cannot be replied to” (e.g. 230072 on a
          // merge_forward topic root). Redirect exactly once to the original
          // /job text message in the same topic/chat; reusing the durable uuid
          // keeps dedup. A second rejection against /job ends as 'failed'.
          redirected = { from: replyTo, to: j.messageId, code: result.code ?? null };
          r.targetMessageId = j.messageId;
          r.targetFallbackFrom = replyTo;
          r.status = 'pending';
          r.error = result.reason ?? 'reply target unavailable';
          r.code = result.code ?? null;
          r.retryAt = 0;
        } else {
          r.status = 'failed';
          r.error = result.reason ?? 'failed';
          r.code = result.code ?? null;
        }
      });
      if (redirected) {
        this.log.warn?.(
          { sourceKey, kind, ...redirected },
          'reply anchor unavailable; redirecting receipt to the original /job message',
        );
      }
    }
  }
}
