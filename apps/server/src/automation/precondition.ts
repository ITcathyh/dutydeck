import type { SessionAutomationService } from '../session-automation.js';
import { z } from 'zod';
import { defaultHighRiskPattern } from '../policy/high-risk.js';
import {
  CLAIM_TTL_MS,
  clipTail,
  errorCode,
  errorMessage,
  iso,
  occurrenceActorId,
  occurrenceKey,
  plus,
  scheduleKey
} from './store.js';
import {
  installationOwnerTaskActor,
  readStoredSessionSchedule,
  RuntimeError,
  SCHEDULE_PRECONDITION_DEFAULT_TIMEOUT_SECONDS,
  SCHEDULE_PRECONDITION_MAX_OUTPUT_BYTES,
  sessionScheduleOccurrenceV2Schema,
  type PublicSchedulePrecondition,
  type SchedulePreconditionInput,
  type SessionSchedule,
  type SessionScheduleOccurrenceV2
} from '@dutydeck/shared';
import { realpath } from 'node:fs/promises';
import { runIsolatedCommand } from '@dutydeck/runtime';

/**
 * 计划的前置命令单独存一条记录，计划本身仍是 `always`：切回旧版本时旧程序照常读计划，只是不跑前置命令、每次都唤醒 Agent。
 * 与计划修订号用 compareAndSetBatch 一次写入；清除时写不带命令的墓碑（配置表不支持删除这类键）。
 */
const PRECONDITION_PREFIX = 'session_automation/precondition/';
const preconditionSchema = z.object({
  version: z.literal(1), scheduleRevision: z.number().int().positive(),
  command: z.string().min(1).max(2_000).optional(), timeoutSeconds: z.number().int().positive().optional(), updatedAt: z.string()
}).strict();
type StoredPrecondition = z.infer<typeof preconditionSchema>;
/** 最近一次前置命令结果与连续跳过次数，供 Web 与 CLI 展示；运行记录里另存一句摘要。 */
const PRECONDITION_STATUS_PREFIX = 'session_automation/precondition_status/';
const preconditionStatusSchema = z.object({
  version: z.literal(1), occurrenceId: z.string().min(1), at: z.string(), outcome: z.enum(['passed', 'skipped', 'error']),
  exitCode: z.number().int().optional(), timedOut: z.boolean().optional(), output: z.string(), outputTruncated: z.boolean(),
  error: z.string().optional(), skippedInARow: z.number().int().nonnegative(),
  /** 产生这条结果的前置命令设置（其 scheduleRevision）；命令改过后旧结果不再展示。 */
  setAt: z.number().int().positive()
}).strict();
type PreconditionStatus = z.infer<typeof preconditionStatusSchema>;
/** 一次前置命令判定的结果，不含记录时补上的序号、时间和占用字段。 */
type PreconditionResult = Omit<PreconditionStatus, 'version' | 'skippedInARow' | 'setAt' | 'occurrenceId' | 'at'>;
const highRiskCommand = new RegExp(defaultHighRiskPattern, 'i');

function preconditionKey(scheduleId: string) { return `${PRECONDITION_PREFIX}${scheduleId}`; }
function preconditionStatusKey(scheduleId: string) { return `${PRECONDITION_STATUS_PREFIX}${scheduleId}`; }
/** 运行记录里的一句摘要：退出码或错误，加输出末尾。完整输出（4 KB）在前置命令状态记录里。 */
function preconditionSummary(status: Pick<PreconditionStatus, 'outcome' | 'exitCode' | 'timedOut' | 'output' | 'error'>, timeoutSeconds: number) {
  const head = status.timedOut ? `前置命令超过 ${timeoutSeconds} 秒未结束，已终止`
    : status.error ? `前置命令无法执行：${status.error.replace(/[\r\n]+/g, ' ').slice(0, 200)}`
    : `前置命令退出码 ${status.exitCode ?? '未知'}，本次不唤醒 Agent`;
  const tail = clipTail(status.output, 300).replace(/[\r\n]+/g, ' ');
  return tail ? `${head}；输出：${tail}` : head;
}

type Dependencies = Pick<SessionAutomationService['scheduler'],
  'advanceSchedule' | 'clock' | 'closed' | 'disableSchedule' | 'occurrences' | 'options' | 'ownerId' | 'store'
  | 'warn'>;

export class AutomationPreconditions {
  /** 关闭时终止正在跑的前置命令；那次触发留在待执行，租约过期后由下次启动重新判定。 */
  readonly preconditionAbort = new AbortController();

  /** 本实例正在后台跑的前置命令，按触发编号；close 时等它们收尾。 */
  readonly preconditionRuns = new Map<string, Promise<void>>();

  constructor(private readonly automation: Dependencies) {}

  /**
   * 前置命令判定：没设或这次已判定通过时返回 true，继续开会话或启动模板。否则在后台跑命令并返回 false：
   * 退出码 0 记下通过后由 runPrecondition 接着处理；非 0 记 skipped（不通知、不计连续没做成）；
   * 超时、无法执行或进程组没收干净记 error，计入连续没做成（连续 STREAK_PAUSE 次自动停用）。
   */
  async preconditionGate(scheduleStored: { raw: string; value: SessionSchedule }, stored: { raw: string; value: SessionScheduleOccurrenceV2 }): Promise<boolean> {
    const schedule = scheduleStored.value;
    const occurrence = stored.value;
    if (occurrence.conditionStatus !== 'pending') return true;
    const precondition = (await this.readPrecondition(schedule.id))?.value;
    if (!precondition?.command) return true;
    const manual = occurrence.triggerSource === 'manual';
    const timeoutSeconds = precondition.timeoutSeconds ?? SCHEDULE_PRECONDITION_DEFAULT_TIMEOUT_SECONDS;
    try { await this.automation.store.requireAuthorized(schedule.sessionId, occurrenceActorId(schedule, occurrence)); }
    catch (error) {
      await this.automation.disableSchedule(scheduleStored);
      await this.automation.occurrences.finishOccurrence(stored, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
      return false;
    }
    const settle = async (target: { raw: string; value: SessionScheduleOccurrenceV2 }, status: PreconditionResult) => {
      const summary = preconditionSummary(status, timeoutSeconds);
      if (!await this.automation.occurrences.finishOccurrence(target, status.outcome === 'skipped' ? { conditionStatus: 'skipped', runStatus: 'skipped', error: summary } : { conditionStatus: 'error', runStatus: 'error', error: summary })) return undefined;
      await this.notePrecondition(schedule.id, precondition, { occurrenceId: occurrence.id, at: iso(this.automation.clock()), ...status });
      if (manual) return undefined;
      if (status.outcome === 'error') await this.automation.occurrences.recordOutcome(target.value, { key: 'precondition:error', kind: 'error', reason: status.timedOut ? `前置命令超过 ${timeoutSeconds} 秒未结束` : `前置命令无法执行：${(status.error ?? '未知错误').slice(0, 160)}` });
      await this.automation.advanceSchedule(schedule, occurrence.scheduledForUtc);
      return undefined;
    };
    let cwd: string;
    try { cwd = await realpath(schedule.executionContext?.cwd ?? (await this.automation.store.requireSession(schedule.sessionId)).cwd); }
    catch (error) { await settle(stored, { outcome: 'error', output: '', outputTruncated: false, error: `执行目录不可用：${errorMessage(error)}` }); return false; }
    // 同一实例里同一次触发只跑一份；跨实例和后续 tick 靠租约挡住。
    if (this.preconditionRuns.has(occurrence.id)) return false;
    const leased = await this.automation.occurrences.renewOccurrenceLease(stored);
    if (!leased || this.preconditionRuns.has(occurrence.id)) return false;
    // 命令在后台跑，不占定时器主循环；结束后接着走这次触发的后续流程。
    const run = this.runPrecondition(schedule, precondition, leased, cwd, timeoutSeconds, settle)
      .catch(error => { this.automation.warn({ scheduleId: schedule.id, occurrenceId: occurrence.id, code: errorCode(error) }, '前置命令后续处理失败'); })
      .finally(() => { this.preconditionRuns.delete(occurrence.id); });
    this.preconditionRuns.set(occurrence.id, run);
    return false;
  }

  /**
   * 跑前置命令期间每 CLAIM_TTL_MS/3 续一次租；续租失败（这次触发已被改动或接手）就终止命令。
   * 通过后先把 conditionStatus=passed 写进这次触发，再接着处理：之后崩溃恢复直接开会话或启动模板，不重跑命令。
   */
  private async runPrecondition(schedule: SessionSchedule, precondition: StoredPrecondition, leased: { raw: string; value: SessionScheduleOccurrenceV2 }, cwd: string, timeoutSeconds: number,
    settle: (target: { raw: string; value: SessionScheduleOccurrenceV2 }, status: PreconditionResult) => Promise<undefined>) {
    const occurrence = leased.value;
    const manual = occurrence.triggerSource === 'manual';
    const controller = new AbortController();
    const onClose = () => controller.abort();
    this.preconditionAbort.signal.addEventListener('abort', onClose, { once: true });
    if (this.preconditionAbort.signal.aborted) controller.abort();
    let current = leased;
    let renewing = Promise.resolve();
    const timer = setInterval(() => {
      renewing = renewing.then(async () => {
        if (controller.signal.aborted) return;
        const renewed = await this.automation.occurrences.renewOccurrenceLease(current);
        if (renewed) current = renewed;
        else controller.abort();
      }).catch(() => { controller.abort(); });
    }, CLAIM_TTL_MS / 3);
    let result: Awaited<ReturnType<typeof runIsolatedCommand>>;
    try { result = await runIsolatedCommand(precondition.command!, cwd, { timeoutMs: timeoutSeconds * (this.automation.options.preconditionSecondMs ?? 1_000), maxOutputBytes: SCHEDULE_PRECONDITION_MAX_OUTPUT_BYTES, signal: controller.signal }); }
    finally {
      clearInterval(timer);
      this.preconditionAbort.signal.removeEventListener('abort', onClose);
      await renewing;
    }
    // 关闭或丢了租约：这次触发留在待执行，租约过期后重新判定。
    if (result.interrupted || controller.signal.aborted) return;
    const latest = await this.automation.store.getRecord(scheduleKey(schedule.id), readStoredSessionSchedule);
    if (!latest || latest.value.generation !== occurrence.generation || latest.value.deletedAt || !latest.value.enabled && !manual) {
      await this.automation.occurrences.finishOccurrence(current, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed while its pre-check command ran' });
      return;
    }
    const error = result.cleanupError ?? result.error;
    const outcome = result.timedOut || error || result.exitCode === undefined ? 'error' as const : result.exitCode === 0 ? 'passed' as const : 'skipped' as const;
    const status = { outcome, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}), ...(result.timedOut ? { timedOut: true } : {}),
      output: result.output, outputTruncated: result.outputTruncated,
      ...(outcome === 'error' && !result.timedOut ? { error: error ?? '进程被信号终止' } : {}) };
    if (outcome !== 'passed') { await settle(current, status); return; }
    const now = this.automation.clock();
    const passed = sessionScheduleOccurrenceV2Schema.parse({ ...current.value, revision: current.value.revision + 1, conditionStatus: 'passed',
      leaseOwner: this.automation.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    if (!await this.automation.store.replace(occurrenceKey(occurrence.id), current.raw, passed)) return;
    await this.notePrecondition(schedule.id, precondition, { occurrenceId: occurrence.id, at: iso(this.automation.clock()), ...status });
    if (this.automation.closed) return;
    await this.automation.occurrences.processOccurrence({ raw: JSON.stringify(passed), value: passed });
  }

  readPrecondition(scheduleId: string) {
    return this.automation.store.getRecord(preconditionKey(scheduleId), value => preconditionSchema.parse(value));
  }

  private async readPreconditionStatus(scheduleId: string) {
    try { return await this.automation.store.getRecord(preconditionStatusKey(scheduleId), value => preconditionStatusSchema.parse(value)); }
    catch { return undefined; }
  }

  private async notePrecondition(scheduleId: string, precondition: StoredPrecondition, entry: Omit<PreconditionStatus, 'version' | 'skippedInARow' | 'setAt'>) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const prior = await this.readPreconditionStatus(scheduleId);
      const carried = prior?.value.setAt === precondition.scheduleRevision ? prior.value.skippedInARow : 0;
      const next = preconditionStatusSchema.parse({ version: 1, ...entry, setAt: precondition.scheduleRevision,
        skippedInARow: entry.outcome === 'skipped' ? carried + 1 : entry.outcome === 'passed' ? 0 : carried });
      if (await (prior ? this.automation.store.replace(preconditionStatusKey(scheduleId), prior.raw, next) : this.automation.store.createRecord(preconditionStatusKey(scheduleId), next))) return;
    }
  }

  async publicPrecondition(scheduleId: string): Promise<PublicSchedulePrecondition | undefined> {
    let precondition: StoredPrecondition | undefined;
    try { precondition = (await this.readPrecondition(scheduleId))?.value; }
    catch { return undefined; }
    if (!precondition?.command) return undefined;
    const status = (await this.readPreconditionStatus(scheduleId))?.value;
    const current = status?.setAt === precondition.scheduleRevision ? status : undefined;
    return {
      command: precondition.command, timeoutSeconds: precondition.timeoutSeconds ?? SCHEDULE_PRECONDITION_DEFAULT_TIMEOUT_SECONDS,
      ...(current ? { last: {
        occurrenceId: current.occurrenceId, at: current.at, outcome: current.outcome,
        ...(current.exitCode !== undefined ? { exitCode: current.exitCode } : {}), ...(current.timedOut ? { timedOut: true } : {}),
        output: current.output, outputTruncated: current.outputTruncated, ...(current.error ? { error: current.error } : {})
      } } : {}),
      skippedInARow: current?.skippedInARow ?? 0
    };
  }

  /** 前置命令只接受安装管理员（Web 计划面板与本机 CLI）；默认高危规则只防手误，不是安全边界。 */
  assertPreconditionInput(input: SchedulePreconditionInput | null | undefined, actorId: string | undefined) {
    if (input === undefined) return;
    if (actorId !== installationOwnerTaskActor) throw new RuntimeError('SESSION_AUTOMATION_PRECONDITION_FORBIDDEN', 'Pre-check commands can only be set from the Web schedule panel or the local dutydeck schedule CLI', 403);
    if (!input) return;
    if (process.platform !== 'linux') throw new RuntimeError('SESSION_AUTOMATION_PRECONDITION_UNAVAILABLE', 'Pre-check commands currently require Linux', 503);
    if (highRiskCommand.test(input.command)) throw new RuntimeError('SESSION_AUTOMATION_PRECONDITION_HIGH_RISK', 'The pre-check command matches the default high-risk command rules; use a read-only check instead', 400);
  }

  assertPreconditionCondition(condition: { kind: string }, hasPrecondition: boolean) {
    if (hasPrecondition && condition.kind === 'ci_new_failure') throw new RuntimeError('SESSION_AUTOMATION_PRECONDITION_CONFLICT', 'A pre-check command cannot be combined with the CI new-failure condition', 400);
  }

  /** 计划与前置命令记录一次写入：任一方在读之后变过就整体不写。 */
  async saveWithPrecondition(id: string, expected: string | undefined, schedule: SessionSchedule, input: SchedulePreconditionInput | null) {
    const store = this.automation.options.repositories.config;
    if (!store.compareAndSetBatch) throw new RuntimeError('SESSION_AUTOMATION_STORAGE_UNAVAILABLE', 'Pre-check commands require atomic batch storage', 503);
    const current = await store.get(preconditionKey(id));
    const record = preconditionSchema.parse({ version: 1, scheduleRevision: schedule.revision,
      ...(input ? { command: input.command, timeoutSeconds: input.timeoutSeconds ?? SCHEDULE_PRECONDITION_DEFAULT_TIMEOUT_SECONDS } : {}), updatedAt: iso(this.automation.clock()) });
    return store.compareAndSetBatch([{ key: scheduleKey(id), expected }, { key: preconditionKey(id), expected: current }],
      [{ key: scheduleKey(id), value: JSON.stringify(schedule) }, { key: preconditionKey(id), value: JSON.stringify(record) }]);
  }
}
