import type { SessionAutomationService } from '../session-automation.js';
import { z } from 'zod';
import {
  canonicalExecutionJson,
  ciSubscriptionSchema,
  previewSessionSchedule,
  readStoredSessionSchedule,
  RuntimeError,
  sessionScheduleOccurrenceSchema,
  type AttemptResultV1,
  type CiSubscriptionV2,
  type SessionSchedule,
  type SessionScheduleOccurrenceV2
} from '@dutydeck/shared';
import {
  CI_PREFIX,
  ciKey,
  CLAIM_TTL_MS,
  errorMessage,
  iso,
  migrateCi,
  migrateOccurrence,
  NOTICE_MAX_ATTEMPTS,
  OCCURRENCE_PREFIX,
  occurrenceKey,
  openRunStatuses,
  plus,
  scheduleKey,
  streakKey,
  streakSchema,
  type AutomationDeliveryContext,
  type RunStreak,
  type SessionAutomationServiceOptions,
  type TickParseCache
} from './store.js';
import { randomUUID } from 'node:crypto';

const OVERDUE_PREFIX = 'session_automation/overdue/';
/** 一次触发卡住后的提醒进度：每次卡住（按触发编号）只提醒一次，发送失败最多重试到 OVERDUE_MAX_ATTEMPTS 次。 */
const overdueNoticeSchema = z.object({
  version: z.literal(1), status: z.enum(['sending', 'sent', 'error']), attempts: z.number().int().positive(),
  nextAttemptAt: z.string().optional(), updatedAt: z.string()
}).strict();
const OVERDUE_MIN_MS = 10 * 60_000;
const OVERDUE_MAX_ATTEMPTS = 3;
const OVERDUE_SENDING_TIMEOUT_MS = 10 * 60_000;

const MAX_DELIVERIES = 4;

type DeliveryRecord = SessionScheduleOccurrenceV2 | CiSubscriptionV2;

function overdueKey(occurrenceId: string) { return `${OVERDUE_PREFIX}${occurrenceId}`; }

/** 结果投递已有结论：送达、本就不投递，或已用完重试次数仍失败（不会再自动重发）。 */
export function deliverySettled(delivery: DeliveryRecord['delivery']): boolean {
  return delivery.status === 'delivered' || delivery.status === 'not_requested' || delivery.status === 'error' && delivery.attempts >= NOTICE_MAX_ATTEMPTS;
}

/**
 * 结果投递最多 NOTICE_MAX_ATTEMPTS 次。backoff（本实例失败过）时按 1、2 分钟退避，从上次失败的 updatedAt 算；
 * 上一个进程留下的失败（含关闭、重启打断的那次）不退避。
 */
function deliveryRetryDue(value: DeliveryRecord, now: Date, backoff: boolean): boolean {
  const { status, attempts, updatedAt } = value.delivery;
  return status !== 'error' || attempts < NOTICE_MAX_ATTEMPTS && (!backoff || new Date(updatedAt).getTime() + 60_000 * attempts <= now.getTime());
}

function sameResult(a?: AttemptResultV1, b?: AttemptResultV1): boolean {
  if (!a || !b) return false;
  return a.taskId === b.taskId
    && a.attemptId === b.attemptId
    && a.settlementId === b.settlementId
    && a.throughSequence === b.throughSequence
    && a.output.digest === b.output.digest;
}

type Dependencies = Pick<SessionAutomationService['scheduler'],
  'applyScheduleStops' | 'clock' | 'closed' | 'options' | 'store' | 'warn'>;

export class AutomationDelivery {
  readonly deliveries = new Map<string, { controller: AbortController; run: Promise<void> }>();
  private lastDeliveryKey?: string;

  /** 本实例投递失败过的来源：只对它们退避；上一个进程（关闭、重启前）记下的失败，打开后立刻补发一次。 */
  private readonly failedDeliveries = new Set<string>();

  constructor(private readonly automation: Dependencies) {}

  /** 重置为待投递，保留已用次数。 */
  undelivered(delivery: { attempts: number }) {
    return { status: 'not_requested' as const, attempts: delivery.attempts, updatedAt: iso(this.automation.clock()) };
  }

  /**
   * 防重叠规则下，一次触发卡住（一直排队不开始，或一直不结束）就不再生成后续触发，而且不会有任何动静。
   * 它超过一个周期（至少 10 分钟，从这次触发建出算起）仍未结束时，在计划的回报位置提醒一次；周期按计划自己的触发规则算，一次性计划没有周期，不提醒。
   */
  async remindOverdue(schedule: SessionSchedule) {
    const pending = schedule.pendingOccurrence;
    if (!this.automation.options.onScheduleOverdue || !pending || !schedule.enabled || schedule.deletedAt) return;
    let next: string | undefined;
    try { next = previewSessionSchedule(schedule, new Date(pending.scheduledForUtc))?.scheduledForUtc; }
    catch { return; }
    if (!next) return;
    const now = this.automation.clock();
    const period = Math.max(new Date(next).getTime() - new Date(pending.scheduledForUtc).getTime(), OVERDUE_MIN_MS);
    // 触发建出不会早于计划时间：没到这个点的不必读记录。
    if (now.getTime() < new Date(pending.scheduledForUtc).getTime() + period) return;
    const occurrence = await this.automation.store.getRecord(occurrenceKey(pending.id), value => sessionScheduleOccurrenceSchema.parse(value));
    if (!occurrence || !openRunStatuses.has(occurrence.value.runStatus)) return;
    if (now.getTime() < new Date(occurrence.value.createdAt).getTime() + period) return;
    const key = overdueKey(pending.id);
    const prior = await this.automation.store.getRecord(key, value => overdueNoticeSchema.parse(value));
    const staleSending = prior?.value.status === 'sending' && now.getTime() - Date.parse(prior.value.updatedAt) >= OVERDUE_SENDING_TIMEOUT_MS;
    if (prior && (prior.value.status !== 'error' && !staleSending || prior.value.attempts >= OVERDUE_MAX_ATTEMPTS || prior.value.nextAttemptAt && prior.value.nextAttemptAt > iso(now))) return;
    const attempts = (prior?.value.attempts ?? 0) + 1;
    const sending = { version: 1, status: 'sending', attempts, updatedAt: iso(now) };
    if (!await (prior ? this.automation.store.replace(key, prior.raw, sending) : this.automation.store.createRecord(key, sending))) return;
    let failed = false;
    try { await this.automation.options.onScheduleOverdue(schedule, { occurrenceId: pending.id, scheduledForUtc: pending.scheduledForUtc, reason: await this.overdueReason(migrateOccurrence(occurrence.value)) }); }
    catch { failed = true; }
    await this.automation.store.replace(key, JSON.stringify(sending), overdueNoticeSchema.parse({
      version: 1, status: failed ? 'error' : 'sent', attempts, updatedAt: iso(this.automation.clock()),
      ...(failed ? { nextAttemptAt: plus(this.automation.clock(), 60_000 * attempts) } : {})
    }));
  }

  /** 从触发记录和任务状态取卡点；取不到就只说还没开始或还没结束。 */
  private async overdueReason(occurrence: SessionScheduleOccurrenceV2) {
    const unknown = '上一轮结果未知，等人确认处理';
    if (occurrence.runStatus === 'blocked') return occurrence.blockReason === 'admission_conflict' ? '任务受理冲突，等人处理' : unknown;
    const task = occurrence.taskId ? await this.automation.options.repositories.tasks.get?.(occurrence.taskId) : undefined;
    if (occurrence.taskId && this.automation.store.execution.getTaskExecutionState(occurrence.taskId)?.attempts.some(attempt => attempt.state === 'reconcile_required' || attempt.state === 'legacy_unresolved')) return unknown;
    if (task?.status === 'queued') return '任务一直在排队，还没开始（可能被同一工作区里未结束的任务挡住）';
    if (occurrence.runStatus === 'pending') return `还没开始${occurrence.error ? `：${occurrence.error.slice(0, 120)}` : ''}`;
    return task?.status === 'running' ? '任务还在执行，还没结束' : '还没结束';
  }

  /** 这一串没做成的第一条是结果卡时，记下它的消息编号，之后同因的说明改这条。 */
  private async noteResultMessage(scheduleId: string, occurrenceId: string, messageId: string) {
    const stored = await this.automation.store.readStreak(scheduleId);
    if (!stored || stored.value.occurrenceId !== occurrenceId || !stored.value.count || stored.value.messageId) return;
    await this.automation.store.replace(streakKey(scheduleId), stored.raw, streakSchema.parse({ ...stored.value, messageId, updatedAt: iso(this.automation.clock()) }));
  }

  private problemText(schedule: SessionSchedule, streak: RunStreak) {
    const next = schedule.enabled && schedule.nextDueAt
      ? `下次 ${new Date(schedule.nextDueAt).toLocaleString('zh-CN', { timeZone: schedule.timezone, hour12: false })} 再跑。` : '';
    return streak.count > 1
      ? `定时计划『${schedule.name}』已连续 ${streak.count} 次没做成：${streak.reason}。${next}`
      : `定时计划『${schedule.name}』这次没跑起来：${streak.reason}。${next}`;
  }

  /** 把计划最近一次没做成的说明发到原话题；有上一条就改它。发送失败按 1、2 分钟退避，最多 NOTICE_MAX_ATTEMPTS 次。 */
  async sendRunNotice(snapshot: SessionSchedule) {
    if (!this.automation.options.onScheduleProblem) return;
    const stored = await this.automation.store.readStreak(snapshot.id);
    const notice = stored?.value.notice;
    const now = this.automation.clock();
    if (!stored || !notice || notice.status === 'sent' || notice.attempts >= NOTICE_MAX_ATTEMPTS || notice.nextAttemptAt && notice.nextAttemptAt > iso(now)) return;
    const attempts = notice.attempts + 1;
    // 先记成失败再发：中途退出时按退避重发；同一触发的消息有幂等键，改消息本身可重复。
    const claimed = streakSchema.parse({ ...stored.value, notice: { ...notice, status: 'error', attempts, nextAttemptAt: plus(now, 60_000 * attempts), updatedAt: iso(now) } });
    if (!await this.automation.store.replace(streakKey(snapshot.id), stored.raw, claimed)) return;
    const schedule = await this.automation.store.getRecord(scheduleKey(snapshot.id), readStoredSessionSchedule);
    if (!schedule) return;
    let sent: Awaited<ReturnType<NonNullable<SessionAutomationServiceOptions['onScheduleProblem']>>>;
    try {
      sent = await this.automation.options.onScheduleProblem(schedule.value, { occurrenceId: notice.occurrenceId, text: this.problemText(schedule.value, stored.value),
        ...(stored.value.messageId ? { messageId: stored.value.messageId } : {}) });
    } catch (error) {
      this.automation.warn({ scheduleId: snapshot.id, occurrenceId: notice.occurrenceId, attempts, code: error instanceof RuntimeError ? error.code : 'UNEXPECTED_ERROR' }, '定时计划没做成的说明发送失败');
      return;
    }
    const latest = await this.automation.store.readStreak(snapshot.id);
    if (latest?.raw !== JSON.stringify(claimed)) return;
    const messageId = typeof sent === 'object' && sent.messageId ? sent.messageId : stored.value.messageId;
    await this.automation.store.replace(streakKey(snapshot.id), latest.raw, streakSchema.parse({ ...claimed, ...(messageId ? { messageId } : {}),
      notice: { ...notice, status: 'sent', attempts, updatedAt: iso(this.automation.clock()) } }));
  }

  private async readDelivery(key: string) {
    return key.startsWith(OCCURRENCE_PREFIX)
      ? this.automation.store.getRecord(key, input => migrateOccurrence(sessionScheduleOccurrenceSchema.parse(input)))
      : this.automation.store.getRecord(key, input => migrateCi(ciSubscriptionSchema.parse(input)));
  }

  private deliverable(value: DeliveryRecord): boolean {
    return ['pending', 'error'].includes(value.delivery.status) && Boolean(value.result && value.admission && value.runtimeAttemptId)
      && ('runStatus' in value ? ['completed', 'failed', 'interrupted'].includes(value.runStatus) : value.status === 'completed');
  }

  private ownsDelivery(current: DeliveryRecord, expected: DeliveryRecord): boolean {
    return this.deliverable(current) && current.leaseOwner === expected.leaseOwner
      && Boolean(current.leaseExpiresAt && new Date(current.leaseExpiresAt) > this.automation.clock())
      && current.sessionId === expected.sessionId && sameResult(current.result, expected.result)
      && canonicalExecutionJson(current.admission ?? null) === canonicalExecutionJson(expected.admission ?? null)
      && canonicalExecutionJson(current.actor ?? null) === canonicalExecutionJson(expected.actor ?? null)
      && (!('scheduleId' in expected) || 'scheduleId' in current && current.scheduleId === expected.scheduleId && current.generation === expected.generation);
  }

  async startPendingDeliveries(parsed: TickParseCache) {
    if (this.automation.closed || !this.automation.options.deliver || this.deliveries.size >= MAX_DELIVERIES) return;
    const [occurrences, subscriptions] = await Promise.all([
      this.automation.store.listRecords(OCCURRENCE_PREFIX, input => sessionScheduleOccurrenceSchema.parse(input), parsed.occurrences, { field: 'delivery.status', values: ['pending', 'error'] }),
      this.automation.store.listRecords(CI_PREFIX, input => ciSubscriptionSchema.parse(input), parsed.subscriptions, { field: 'delivery.status', values: ['pending', 'error'] })
    ]);
    const candidates = [
      ...occurrences.map(item => ({ key: occurrenceKey(item.value.id), raw: item.raw, value: migrateOccurrence(item.value) })),
      ...subscriptions.map(item => ({ key: ciKey(item.value.id), raw: item.raw, value: migrateCi(item.value) }))
    ].filter(item => this.deliverable(item.value) && deliveryRetryDue(item.value, this.automation.clock(), this.failedDeliveries.has(item.key))).sort((a, b) => a.key.localeCompare(b.key));
    const start = candidates.findIndex(item => item.key > (this.lastDeliveryKey ?? ''));
    for (const candidate of [...candidates.slice(start < 0 ? 0 : start), ...candidates.slice(0, start < 0 ? 0 : start)]) {
      if (this.automation.closed || this.deliveries.size >= MAX_DELIVERIES) break;
      this.lastDeliveryKey = candidate.key;
      if (this.deliveries.has(candidate.key)) continue;
      const stored = await this.readDelivery(candidate.key);
      if (!stored || !this.deliverable(stored.value) || !deliveryRetryDue(stored.value, this.automation.clock(), this.failedDeliveries.has(candidate.key)) || stored.value.leaseExpiresAt && new Date(stored.value.leaseExpiresAt) > this.automation.clock()) continue;
      const claimed = { ...stored.value, revision: stored.value.revision + 1,
        leaseOwner: `automation_delivery_${randomUUID()}`, leaseExpiresAt: plus(this.automation.clock(), CLAIM_TTL_MS), updatedAt: iso(this.automation.clock()) };
      if (this.automation.closed || !await this.automation.store.replace(candidate.key, stored.raw, claimed)) continue;
      const controller = new AbortController();
      // Reserve before any outbound continuation; the same source cannot reenter on the next tick.
      const run = Promise.resolve().then(() => this.runDelivery(candidate.key, claimed, controller))
        .catch(() => { /* A storage failure leaves the durable lease to expire and retry. */ })
        .finally(() => { this.deliveries.delete(candidate.key); });
      this.deliveries.set(candidate.key, { controller, run });
      if (this.automation.closed) controller.abort();
    }
  }

  private async runDelivery(key: string, claimed: DeliveryRecord, controller: AbortController) {
    const stale = () => new RuntimeError('SESSION_AUTOMATION_DELIVERY_STALE', 'Automatic result delivery no longer owns its source lease', 409);
    const context: AutomationDeliveryContext = {
      signal: controller.signal,
      assertCurrent: async () => {
        controller.signal.throwIfAborted();
        const current = await this.readDelivery(key);
        if (!current || !this.ownsDelivery(current.value, claimed)) throw stale();
        controller.signal.throwIfAborted();
      }
    };
    let renewing: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewing || controller.signal.aborted) return;
      renewing = (async () => {
        const current = await this.readDelivery(key);
        if (!current || !this.ownsDelivery(current.value, claimed)) throw stale();
        const renewed = { ...current.value, revision: current.value.revision + 1, leaseExpiresAt: plus(this.automation.clock(), CLAIM_TTL_MS), updatedAt: iso(this.automation.clock()) };
        if (!await this.automation.store.replace(key, current.raw, renewed)) throw stale();
      })().catch(error => { controller.abort(error); }).finally(() => { renewing = undefined; });
    }, CLAIM_TTL_MS / 3);
    heartbeat.unref();
    let deliveryError: string | undefined;
    let sent: void | { messageId?: string } = undefined;
    try {
      await context.assertCurrent();
      sent = await this.automation.options.deliver!(claimed.sessionId, claimed.result!, claimed.id, 'scheduleId' in claimed ? claimed.scheduleId : claimed.id, context);
      await context.assertCurrent();
    } catch (cause) { deliveryError = errorMessage(cause); }
    finally { clearInterval(heartbeat); await renewing; }
    const current = await this.readDelivery(key);
    if (!current || !this.ownsDelivery(current.value, claimed)) return;
    const attempts = current.value.delivery.attempts + 1;
    const updated = { ...current.value, revision: current.value.revision + 1,
      delivery: { status: deliveryError ? 'error' as const : 'delivered' as const, attempts,
        ...(deliveryError ? { error: attempts >= NOTICE_MAX_ATTEMPTS ? `${deliveryError}（已尝试 ${attempts} 次，不再自动重发）` : deliveryError } : {}), updatedAt: iso(this.automation.clock()) },
      leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: iso(this.automation.clock()) };
    if (!await this.automation.store.replace(key, current.raw, updated)) return;
    if (deliveryError && attempts < NOTICE_MAX_ATTEMPTS) this.failedDeliveries.add(key);
    else this.failedDeliveries.delete(key);
    if (!deliveryError && 'scheduleId' in claimed && sent?.messageId) await this.noteResultMessage(claimed.scheduleId, claimed.id, sent.messageId);
    await this.automation.applyScheduleStops();
  }
}
