import { createHash, randomUUID } from 'node:crypto';
import {
  RuntimeError,
  previewNextSchedule,
  type PolicyDecision,
  type RepositoryBundle,
  type ScheduleDefinition,
  type Session,
  type TaskRecord
} from '@dutydeck/shared';
import {
  cancelCiInputSchema,
  ciSubscriptionSchema,
  createSessionScheduleInputSchema,
  sessionScheduleOccurrenceSchema,
  sessionScheduleSchema,
  subscribeCiInputSchema,
  updateSessionScheduleInputSchema,
  type CiSubscription,
  type CreateSessionScheduleInput,
  type PublicCiSubscription,
  type PublicSessionSchedule,
  type PublicSessionScheduleOccurrence,
  type SessionAutomationList,
  type SessionSchedule,
  type SessionScheduleOccurrence,
  type SubscribeCiInput,
  type UpdateSessionScheduleInput
} from '@dutydeck/shared';
import { GithubActionsClient, resolveGithubHead, type GithubWorkflowRun } from './github-actions.js';
import { z } from 'zod';

const SCHEDULE_PREFIX = 'session_automation/schedule/';
const OCCURRENCE_PREFIX = 'session_automation/occurrence/';
const CI_PREFIX = 'session_automation/ci/';
const TASK_BINDING_PREFIX = 'session_automation/task/';
const MAX_RECORDS = 1_000;
const CLAIM_TTL_MS = 30_000;
const DEFAULT_POLL_MS = 60_000;
const terminalTaskStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const failureConclusions = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

type AutomationRepositories = Pick<RepositoryBundle, 'config' | 'sessions' | 'tasks'>;
type AuthorizationResult = boolean | PolicyDecision;

export interface SessionAutomationRuntime {
  getSession(id: string): Promise<Session | undefined>;
  dispatch(
    sessionId: string,
    prompt: string,
    mode: 'queue',
    agentPrompt: string,
    riskPolicy: undefined,
    actorId: string | undefined,
    idempotencyKey: string
  ): Promise<{ id: string; status: string }>;
}

export interface SessionAutomationServiceOptions {
  repositories: AutomationRepositories;
  runtime: SessionAutomationRuntime;
  authorize?: (sessionId: string, actorId?: string) => AuthorizationResult | Promise<AuthorizationResult>;
  prepareDelivery?: (sessionId: string, automationId: string) => Promise<void>;
  deliver?: (sessionId: string, taskId: string, occurrenceId: string, sourceId: string) => Promise<void>;
  githubToken?: string;
  githubFetch?: typeof fetch;
  clock?: () => Date;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function scheduleKey(id: string) { return `${SCHEDULE_PREFIX}${id}`; }
function occurrenceKey(id: string) { return `${OCCURRENCE_PREFIX}${id}`; }
function ciKey(id: string) { return `${CI_PREFIX}${id}`; }
function taskBindingKey(taskId: string) { return `${TASK_BINDING_PREFIX}${taskId}`; }
function iso(date: Date) { return date.toISOString(); }
function plus(date: Date, milliseconds: number) { return new Date(date.getTime() + milliseconds).toISOString(); }
function occurrenceId(schedule: SessionSchedule, scheduledForUtc: string) {
  return `occ_${createHash('sha256').update(`${schedule.id}\0${schedule.generation}\0${scheduledForUtc}`).digest('hex')}`;
}
function expectedTaskId(sessionId: string, idempotencyKey: string) {
  return `task_${createHash('sha256').update(`${sessionId}\0${idempotencyKey}`).digest('hex')}`;
}
function isSessionRunnable(session: Session | undefined) {
  return Boolean(session && !session.archivedAt && !['stopped', 'failed'].includes(session.state));
}
function isAllowed(result: AuthorizationResult) { return result === true || typeof result === 'object' && result.allowed; }

function publicSchedule(value: SessionSchedule): PublicSessionSchedule {
  const { actorId: _actorId, taskStartOccurrenceId: _taskStartOccurrenceId, ...record } = value;
  return record;
}
function publicOccurrence(value: SessionScheduleOccurrence): PublicSessionScheduleOccurrence {
  const { taskStartedAt: _taskStartedAt, leaseOwner: _leaseOwner, leaseExpiresAt: _leaseExpiresAt, ...record } = value;
  return record;
}
function publicSubscription(value: CiSubscription): PublicCiSubscription {
  const { actorId: _actorId, dispatchPrompt: _dispatchPrompt, taskStartedAt: _taskStartedAt, leaseOwner: _leaseOwner, leaseExpiresAt: _leaseExpiresAt, ...record } = value;
  return record;
}

const taskBindingSchema = z.discriminatedUnion('kind', [
  z.object({ schemaVersion: z.literal(1), kind: z.literal('schedule'), sessionId: z.string().min(1), occurrenceId: z.string().min(1) }).strict(),
  z.object({ schemaVersion: z.literal(1), kind: z.literal('ci'), sessionId: z.string().min(1), subscriptionId: z.string().min(1) }).strict()
]);
type TaskBinding = z.infer<typeof taskBindingSchema>;

function asPreviewDefinition(schedule: Pick<SessionSchedule, 'id' | 'name' | 'trigger' | 'timezone' | 'dstPolicy'>): ScheduleDefinition {
  return {
    schemaVersion: 1,
    id: schedule.id,
    revision: 1,
    channelBotId: 'session_automation',
    name: schedule.name,
    trigger: schedule.trigger,
    timezone: schedule.timezone,
    dstPolicy: schedule.dstPolicy,
    delivery: { mode: 'chat', chatRef: 'session', continuation: 'chat_root' },
    payloadRef: 'session_prompt',
    sourceOwnership: 'dutydeck',
    sourceNamespace: 'session_automation',
    sourceEnabled: false,
    state: 'disabled',
    desiredExecutorState: 'disabled',
    currentGeneration: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function nextDue(schedule: Pick<SessionSchedule, 'id' | 'name' | 'trigger' | 'timezone' | 'dstPolicy'>, after: Date) {
  return previewNextSchedule(asPreviewDefinition(schedule), after)?.scheduledForUtc;
}

function formatCiPrompt(basePrompt: string, repository: string, headSha: string, runs: GithubWorkflowRun[]): string {
  const lines = runs.map(run => `- ${run.name.slice(0, 80)}: ${(run.conclusion ?? 'completed').slice(0, 40)} (run ${run.id}, ${run.htmlUrl.slice(0, 400)})`);
  return `${basePrompt}\n\nGitHub Actions completed for ${repository} at ${headSha}:\n${lines.join('\n')}`;
}

export class SessionAutomationService {
  private readonly ownerId = `automation_${randomUUID()}`;
  private readonly clock: () => Date;
  private readonly github: GithubActionsClient;
  private readonly pollIntervalMs: number;
  private closed = false;
  private currentTick?: Promise<void>;

  constructor(private readonly options: SessionAutomationServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.pollIntervalMs = Math.max(60_000, Math.min(60 * 60_000, options.pollIntervalMs ?? DEFAULT_POLL_MS));
    this.github = new GithubActionsClient({ token: options.githubToken, fetch: options.githubFetch, requestTimeoutMs: options.requestTimeoutMs });
  }

  private requireStore() {
    if (!this.options.repositories.config.compareAndSet || !this.options.repositories.config.list) {
      throw new RuntimeError('SESSION_AUTOMATION_STORAGE_UNAVAILABLE', 'Session automation requires durable list and compare-and-set storage', 503);
    }
    return this.options.repositories.config as Required<Pick<typeof this.options.repositories.config, 'compareAndSet' | 'list'>> & typeof this.options.repositories.config;
  }

  private async requireAuthorized(sessionId: string, actorId?: string) {
    if (!this.options.authorize) throw new RuntimeError('SESSION_AUTOMATION_AUTH_UNWIRED', 'Session automation authorization is not configured', 403);
    if (!isAllowed(await this.options.authorize(sessionId, actorId))) throw new RuntimeError('SESSION_AUTOMATION_FORBIDDEN', 'Session automation access was denied', 403);
  }

  private async requireSession(sessionId: string) {
    const session = await this.options.runtime.getSession(sessionId);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    return session;
  }

  private async listRecords<T>(prefix: string, parse: (input: unknown) => T): Promise<Array<{ raw: string; value: T }>> {
    const rows = await this.requireStore().list(prefix);
    const parsed: Array<{ raw: string; value: T }> = [];
    for (const row of rows) {
      try { parsed.push({ raw: row.value, value: parse(JSON.parse(row.value)) }); }
      catch { throw new RuntimeError('SESSION_AUTOMATION_RECORD_INVALID', 'Stored session automation record is invalid', 500); }
    }
    return parsed;
  }

  private async getRecord<T>(key: string, parse: (input: unknown) => T): Promise<{ raw: string; value: T } | undefined> {
    const raw = await this.options.repositories.config.get(key);
    if (!raw) return undefined;
    try { return { raw, value: parse(JSON.parse(raw)) }; }
    catch { throw new RuntimeError('SESSION_AUTOMATION_RECORD_INVALID', 'Stored session automation record is invalid', 500); }
  }

  private async replace(key: string, raw: string, value: unknown) {
    return this.requireStore().compareAndSet(key, raw, JSON.stringify(value));
  }

  private async createRecord(key: string, value: unknown) {
    return this.requireStore().compareAndSet(key, undefined, JSON.stringify(value));
  }

  private async ensureTaskBinding(taskId: string, binding: TaskBinding) {
    if (await this.createRecord(taskBindingKey(taskId), binding)) return;
    const existing = await this.getRecord(taskBindingKey(taskId), value => taskBindingSchema.parse(value));
    if (!existing || JSON.stringify(existing.value) !== JSON.stringify(binding)) throw new RuntimeError('SESSION_AUTOMATION_TASK_BINDING_CONFLICT', 'Automation task binding changed', 409);
  }

  async listBySession(sessionId: string, actorId?: string): Promise<SessionAutomationList> {
    await this.requireAuthorized(sessionId, actorId);
    await this.requireSession(sessionId);
    const [schedules, subscriptions, occurrences] = await Promise.all([
      this.listRecords(SCHEDULE_PREFIX, value => sessionScheduleSchema.parse(value)),
      this.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value)),
      this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value))
    ]);
    return {
      schedules: schedules.map(item => item.value).filter(item => item.sessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_RECORDS).map(publicSchedule),
      subscriptions: subscriptions.map(item => item.value).filter(item => item.sessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_RECORDS).map(publicSubscription),
      occurrences: occurrences.map(item => item.value).filter(item => item.sessionId === sessionId).sort((a, b) => a.scheduledForUtc.localeCompare(b.scheduledForUtc)).slice(-MAX_RECORDS).map(publicOccurrence)
    };
  }

  private async githubCondition(session: Session, input: { kind: 'github_new_failure'; workflow?: string }) {
    const resolved = await resolveGithubHead(session.cwd);
    const runs = await this.github.listCompletedRuns(resolved.repository, resolved.headSha, input.workflow);
    return {
      kind: 'github_new_failure' as const,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      repository: resolved.repository,
      headSha: resolved.headSha,
      observedRunIds: runs.map(run => run.id)
    };
  }

  async createSchedule(sessionId: string, rawInput: CreateSessionScheduleInput, actorId?: string): Promise<PublicSessionSchedule> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
    if (!isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    const input = createSessionScheduleInputSchema.parse(rawInput);
    const now = iso(this.clock());
    const condition = input.condition.kind === 'always' ? input.condition : await this.githubCondition(session, input.condition);
    const id = `schedule_${randomUUID()}`;
    await this.options.prepareDelivery?.(sessionId, id);
    const schedule = sessionScheduleSchema.parse({
      schemaVersion: 1,
      id,
      revision: 1,
      generation: 1,
      sessionId,
      ...(actorId ? { actorId } : {}),
      name: input.name,
      prompt: input.prompt,
      trigger: input.trigger,
      timezone: input.timezone,
      dstPolicy: input.dstPolicy,
      condition,
      enabled: false,
      createdAt: now,
      updatedAt: now
    });
    nextDue(schedule, this.clock());
    if (!await this.createRecord(scheduleKey(schedule.id), schedule)) throw new RuntimeError('SESSION_AUTOMATION_CONFLICT', 'Schedule identifier already exists', 409);
    return publicSchedule(schedule);
  }

  async updateSchedule(sessionId: string, id: string, rawInput: UpdateSessionScheduleInput, actorId?: string): Promise<PublicSessionSchedule> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
    const input = updateSessionScheduleInputSchema.parse(rawInput);
    const stored = await this.getRecord(scheduleKey(id), value => sessionScheduleSchema.parse(value));
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_SCHEDULE_NOT_FOUND', 'Session schedule not found', 404);
    if (stored.value.revision !== input.expectedRevision) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    if (input.enabled === true && !isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    let condition = stored.value.condition;
    if (input.condition) condition = input.condition.kind === 'always' ? input.condition : await this.githubCondition(session, input.condition);
    const now = this.clock();
    const candidate = {
      ...stored.value,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.dstPolicy !== undefined ? { dstPolicy: input.dstPolicy } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      condition,
      revision: stored.value.revision + 1,
      generation: stored.value.generation + 1,
      ...(actorId ? { actorId } : {}),
      updatedAt: iso(now)
    };
    const schedule = sessionScheduleSchema.parse({
      ...candidate,
      nextDueAt: candidate.enabled ? nextDue(candidate, now) : undefined
    });
    if (!await this.replace(scheduleKey(id), stored.raw, schedule)) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'Session schedule revision changed', 409);
    return publicSchedule(schedule);
  }

  async subscribeCi(sessionId: string, rawInput: SubscribeCiInput, actorId?: string): Promise<PublicCiSubscription> {
    await this.requireAuthorized(sessionId, actorId);
    const session = await this.requireSession(sessionId);
    if (!isSessionRunnable(session)) throw new RuntimeError('SESSION_NOT_ACTIVE', 'Session is not active', 409);
    const input = subscribeCiInputSchema.parse(rawInput);
    const resolved = await resolveGithubHead(session.cwd);
    const now = this.clock();
    const id = `ci_${randomUUID()}`;
    await this.options.prepareDelivery?.(sessionId, id);
    const record = ciSubscriptionSchema.parse({
      schemaVersion: 1,
      id,
      revision: 1,
      sessionId,
      ...(actorId ? { actorId } : {}),
      repository: resolved.repository,
      headSha: resolved.headSha,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      prompt: input.prompt ?? 'Review the completed GitHub Actions result and continue the task.',
      status: 'waiting',
      expiresAt: plus(now, input.ttlSeconds * 1_000),
      nextPollAt: iso(now),
      delivery: { status: this.options.deliver ? 'pending' : 'not_requested', attempts: 0, updatedAt: iso(now) },
      createdAt: iso(now),
      updatedAt: iso(now)
    });
    if (!await this.createRecord(ciKey(record.id), record)) throw new RuntimeError('SESSION_AUTOMATION_CONFLICT', 'CI subscription identifier already exists', 409);
    return publicSubscription(record);
  }

  async cancelCi(sessionId: string, id: string, rawInput: { expectedRevision: number }, actorId?: string): Promise<PublicCiSubscription> {
    await this.requireAuthorized(sessionId, actorId);
    await this.requireSession(sessionId);
    const input = cancelCiInputSchema.parse(rawInput);
    const stored = await this.getRecord(ciKey(id), value => ciSubscriptionSchema.parse(value));
    if (!stored || stored.value.sessionId !== sessionId) throw new RuntimeError('SESSION_AUTOMATION_CI_NOT_FOUND', 'CI subscription not found', 404);
    if (stored.value.taskStartedAt) throw new RuntimeError('SESSION_AUTOMATION_CI_ALREADY_STARTED', 'CI continuation has already started', 409);
    if (stored.value.revision !== input.expectedRevision) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'CI subscription revision changed', 409);
    if (!['waiting', 'dispatching', 'accepted'].includes(stored.value.status)) return publicSubscription(stored.value);
    const now = iso(this.clock());
    const cancelled = ciSubscriptionSchema.parse({
      ...stored.value,
      revision: stored.value.revision + 1,
      status: 'cancelled',
      nextPollAt: undefined,
      delivery: { status: 'not_requested', attempts: stored.value.delivery.attempts, updatedAt: now },
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now
    });
    if (!await this.replace(ciKey(id), stored.raw, cancelled)) throw new RuntimeError('SESSION_AUTOMATION_REVISION_CONFLICT', 'CI subscription revision changed', 409);
    return publicSubscription(cancelled);
  }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.currentTick) return this.currentTick;
    const operation = this.runTick().finally(() => { if (this.currentTick === operation) this.currentTick = undefined; });
    this.currentTick = operation;
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.currentTick;
  }

  async authorizeTask(task: TaskRecord, phase: 'prepare' | 'submit' = 'prepare'): Promise<void> {
    const binding = await this.getRecord(taskBindingKey(task.id), value => taskBindingSchema.parse(value));
    if (!binding) return;
    if (binding.value.sessionId !== task.sessionId) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Automation task binding does not match its session', 403);
    if (binding.value.kind === 'schedule') {
      const occurrenceStored = await this.getRecord(occurrenceKey(binding.value.occurrenceId), value => sessionScheduleOccurrenceSchema.parse(value));
      const occurrence = occurrenceStored?.value;
      if (!occurrenceStored || !occurrence || expectedTaskId(occurrence.sessionId, `session-automation:schedule:${occurrence.id}`) !== task.id) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task binding is invalid', 403);
      }
      const schedule = await this.getRecord(scheduleKey(occurrence.scheduleId), value => sessionScheduleSchema.parse(value));
      if (!schedule) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task definition is missing', 403);
      const started = Boolean(occurrence.taskStartedAt || schedule.value.taskStartOccurrenceId === occurrence.id);
      if (!started && (schedule.value.generation !== occurrence.generation || !schedule.value.enabled || occurrence.conditionStatus !== 'passed' || !['pending', 'accepted'].includes(occurrence.runStatus))) {
        await this.finishOccurrence(occurrenceStored, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed before task execution' });
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task is no longer authorized to run', 403);
      }
      const session = await this.options.runtime.getSession(task.sessionId);
      if (!isSessionRunnable(session)) {
        if (!started) {
          await this.disableSchedule(schedule);
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'error', runStatus: 'error', error: 'Session is no longer active' });
        }
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task session is no longer active', 403);
      }
      try { await this.requireAuthorized(task.sessionId, schedule.value.actorId); }
      catch (error) {
        if (!started) {
          await this.disableSchedule(schedule);
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
        }
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task authorization was revoked', 403);
      }
      if (!started && schedule.value.condition.kind === 'github_new_failure') {
        let resolved: Awaited<ReturnType<typeof resolveGithubHead>>;
        try { resolved = await resolveGithubHead(session!.cwd); }
        catch (error) {
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: errorMessage(error) });
          throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'Scheduled task GitHub HEAD is unavailable before execution', 409);
        }
        if (resolved.repository.slug.toLowerCase() !== schedule.value.condition.repository.slug.toLowerCase() || resolved.headSha !== schedule.value.condition.headSha) {
          await this.finishOccurrence(occurrenceStored, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Scheduled task GitHub HEAD changed before execution' });
          throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'Scheduled task GitHub HEAD changed before execution', 409);
        }
      }
      if (phase === 'submit' && !started) {
        const startedSchedule = sessionScheduleSchema.parse({
          ...schedule.value,
          taskStartOccurrenceId: occurrence.id,
          ...(!schedule.value.nextDueAt ? { enabled: false } : {})
        });
        if (!await this.replace(scheduleKey(schedule.value.id), schedule.raw, startedSchedule)) {
          const latestSchedule = await this.getRecord(scheduleKey(schedule.value.id), value => sessionScheduleSchema.parse(value));
          if (latestSchedule?.value.taskStartOccurrenceId !== occurrence.id) {
            const latest = await this.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
            if (latest) await this.finishOccurrence(latest, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed before submission' });
            throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled task changed before submission', 409);
          }
        }
        const currentOccurrence = await this.getRecord(occurrenceKey(occurrence.id), value => sessionScheduleOccurrenceSchema.parse(value));
        if (!currentOccurrence || currentOccurrence.value.conditionStatus !== 'passed' || !['pending', 'accepted'].includes(currentOccurrence.value.runStatus)) {
          throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'Scheduled occurrence changed before submission', 409);
        }
        const marked = sessionScheduleOccurrenceSchema.parse({ ...currentOccurrence.value, revision: currentOccurrence.value.revision + 1, taskStartedAt: iso(this.clock()), updatedAt: iso(this.clock()) });
        await this.replace(occurrenceKey(occurrence.id), currentOccurrence.raw, marked);
      }
      return;
    }
    const subscriptionStored = await this.getRecord(ciKey(binding.value.subscriptionId), value => ciSubscriptionSchema.parse(value));
    const subscription = subscriptionStored?.value;
    if (!subscriptionStored || !subscription || expectedTaskId(subscription.sessionId, `session-automation:ci:${subscription.id}`) !== task.id) {
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation task binding is invalid', 403);
    }
    const started = Boolean(subscription.taskStartedAt);
    if (!started && (!['dispatching', 'accepted'].includes(subscription.status) || new Date(subscription.expiresAt) <= this.clock())) {
      if (['dispatching', 'accepted'].includes(subscription.status) && new Date(subscription.expiresAt) <= this.clock()) await this.finishCi(subscriptionStored, 'expired', 'CI continuation expired before execution');
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation is no longer authorized to run', 403);
    }
    const session = await this.options.runtime.getSession(task.sessionId);
    if (!isSessionRunnable(session)) {
      if (!started) await this.finishCi(subscriptionStored, 'session_inactive', 'Session is no longer active');
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation session is no longer active', 403);
    }
    try { await this.requireAuthorized(task.sessionId, subscription.actorId); }
    catch (error) {
      if (!started) await this.finishCi(subscriptionStored, 'revoked', errorMessage(error));
      throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation authorization was revoked', 403);
    }
    if (!started) {
      let resolved: Awaited<ReturnType<typeof resolveGithubHead>>;
      try { resolved = await resolveGithubHead(session!.cwd); }
      catch (error) {
        await this.finishCi(subscriptionStored, 'stale_head', errorMessage(error));
        throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'CI continuation GitHub HEAD is unavailable before execution', 409);
      }
      if (resolved.repository.slug.toLowerCase() !== subscription.repository.slug.toLowerCase() || resolved.headSha !== subscription.headSha) {
        await this.finishCi(subscriptionStored, 'stale_head', 'CI continuation GitHub HEAD changed before execution');
        throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'CI continuation GitHub HEAD changed before execution', 409);
      }
    }
    if (phase === 'submit' && !started) {
      const current = await this.getRecord(ciKey(subscription.id), value => ciSubscriptionSchema.parse(value));
      if (!current || current.value.taskStartedAt || !['dispatching', 'accepted'].includes(current.value.status) || new Date(current.value.expiresAt) <= this.clock()) {
        throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation changed before submission', 409);
      }
      const marked = ciSubscriptionSchema.parse({ ...current.value, revision: current.value.revision + 1, taskStartedAt: iso(this.clock()), updatedAt: iso(this.clock()) });
      if (!await this.replace(ciKey(subscription.id), current.raw, marked)) {
        const latest = await this.getRecord(ciKey(subscription.id), value => ciSubscriptionSchema.parse(value));
        if (!latest?.value.taskStartedAt) throw new RuntimeError('SESSION_AUTOMATION_TASK_REVOKED', 'CI continuation changed before submission', 409);
      }
    }
  }

  private async runTick() {
    this.requireStore();
    await this.refreshAcceptedWork();
    if (this.closed) return;
    const [schedules, occurrences, subscriptions] = await Promise.all([
      this.listRecords(SCHEDULE_PREFIX, value => sessionScheduleSchema.parse(value)),
      this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value)),
      this.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value))
    ]);
    for (const item of occurrences) {
      if (this.closed) return;
      if (item.value.runStatus === 'pending' && (!item.value.leaseExpiresAt || new Date(item.value.leaseExpiresAt) <= this.clock())) await this.claimAndProcessOccurrence(item);
    }
    const occurrencesBySchedule = new Map<string, SessionScheduleOccurrence[]>();
    for (const item of occurrences) {
      const grouped = occurrencesBySchedule.get(item.value.scheduleId) ?? [];
      grouped.push(item.value);
      occurrencesBySchedule.set(item.value.scheduleId, grouped);
    }
    for (const item of schedules) {
      if (this.closed) return;
      await this.planSchedule(item.value, occurrencesBySchedule.get(item.value.id) ?? []);
    }
    for (const item of subscriptions) {
      if (this.closed) return;
      if (item.value.status === 'waiting' && (!item.value.nextPollAt || new Date(item.value.nextPollAt) <= this.clock())) await this.claimAndPollCi(item);
      else if (item.value.status === 'dispatching' && (!item.value.leaseExpiresAt || new Date(item.value.leaseExpiresAt) <= this.clock())) await this.recoverDispatchingCi(item);
      else if (item.value.status === 'accepted' && new Date(item.value.expiresAt) <= this.clock() && item.value.taskId) {
        const task = await this.options.repositories.tasks.get?.(item.value.taskId);
        if (task?.status === 'queued' && !item.value.taskStartedAt) await this.finishCi(item, 'expired', 'CI continuation expired before execution');
      }
    }
  }

  private async planSchedule(schedule: SessionSchedule, existing: SessionScheduleOccurrence[]) {
    if (!schedule.enabled || !schedule.nextDueAt || new Date(schedule.nextDueAt) > this.clock()) return;
    for (const occurrence of existing) {
      if (!occurrence.taskId) continue;
      const task = await this.options.repositories.tasks.get?.(occurrence.taskId);
      if (task && !terminalTaskStatuses.has(task.status)) return;
    }
    const id = occurrenceId(schedule, schedule.nextDueAt);
    const already = await this.getRecord(occurrenceKey(id), value => sessionScheduleOccurrenceSchema.parse(value));
    if (already) {
      if (already.value.runStatus !== 'pending') await this.advanceSchedule(schedule, schedule.nextDueAt);
      return;
    }
    const now = this.clock();
    const occurrence = sessionScheduleOccurrenceSchema.parse({
      schemaVersion: 1,
      id,
      revision: 1,
      scheduleId: schedule.id,
      sessionId: schedule.sessionId,
      generation: schedule.generation,
      scheduledForUtc: schedule.nextDueAt,
      conditionStatus: 'pending',
      runStatus: 'pending',
      delivery: { status: this.options.deliver ? 'pending' : 'not_requested', attempts: 0, updatedAt: iso(now) },
      leaseOwner: this.ownerId,
      leaseExpiresAt: plus(now, CLAIM_TTL_MS),
      createdAt: iso(now),
      updatedAt: iso(now)
    });
    if (await this.createRecord(occurrenceKey(id), occurrence)) {
      existing.push(occurrence);
      await this.processOccurrence({ raw: JSON.stringify(occurrence), value: occurrence });
    }
  }

  private async claimAndProcessOccurrence(stored: { raw: string; value: SessionScheduleOccurrence }) {
    const now = this.clock();
    const claimed = sessionScheduleOccurrenceSchema.parse({ ...stored.value, revision: stored.value.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    if (await this.replace(occurrenceKey(stored.value.id), stored.raw, claimed)) await this.processOccurrence({ raw: JSON.stringify(claimed), value: claimed });
  }

  private async renewOccurrenceLease(stored: { raw: string; value: SessionScheduleOccurrence }) {
    const now = this.clock();
    const renewed = sessionScheduleOccurrenceSchema.parse({ ...stored.value, revision: stored.value.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    return await this.replace(occurrenceKey(stored.value.id), stored.raw, renewed) ? { raw: JSON.stringify(renewed), value: renewed } : undefined;
  }

  private async processOccurrence(stored: { raw: string; value: SessionScheduleOccurrence }) {
    const occurrence = stored.value;
    const scheduleStored = await this.getRecord(scheduleKey(occurrence.scheduleId), value => sessionScheduleSchema.parse(value));
    if (!scheduleStored || scheduleStored.value.generation !== occurrence.generation || !scheduleStored.value.enabled) {
      await this.finishOccurrence(stored, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule generation changed before dispatch' });
      return;
    }
    let schedule = scheduleStored.value;
    const session = await this.options.runtime.getSession(schedule.sessionId);
    if (!isSessionRunnable(session)) {
      await this.disableSchedule(scheduleStored);
      await this.finishOccurrence(stored, { conditionStatus: 'error', runStatus: 'error', error: 'Session is no longer active' });
      return;
    }
    try { await this.requireAuthorized(schedule.sessionId, schedule.actorId); }
    catch (error) {
      await this.disableSchedule(scheduleStored);
      await this.finishOccurrence(stored, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
      return;
    }

    let working = stored;
    let conditionStatus: SessionScheduleOccurrence['conditionStatus'] = occurrence.conditionStatus === 'pending' ? 'passed' : occurrence.conditionStatus;
    let conditionError = occurrence.error;
    if (occurrence.conditionStatus === 'pending' && schedule.condition.kind === 'github_new_failure') {
      let observed: number[] | undefined;
      try {
        const condition = schedule.condition;
        const resolved = await resolveGithubHead(session!.cwd);
        if (resolved.repository.slug.toLowerCase() !== condition.repository.slug.toLowerCase() || resolved.headSha !== condition.headSha) {
          throw new Error('GitHub repository or HEAD changed after the schedule generation was created');
        }
        const runs = await this.github.listCompletedRuns(condition.repository, condition.headSha, condition.workflow);
        const seen = new Set(condition.observedRunIds);
        const newRuns = runs.filter(run => !seen.has(run.id));
        conditionStatus = newRuns.some(run => run.conclusion && failureConclusions.has(run.conclusion)) ? 'passed' : 'skipped';
        observed = runs.map(run => run.id);
      } catch (error) {
        conditionStatus = 'error';
        conditionError = errorMessage(error);
      }
      const renewed = await this.renewOccurrenceLease(working);
      if (!renewed) return;
      working = renewed;
      const currentSchedule = await this.getRecord(scheduleKey(schedule.id), value => sessionScheduleSchema.parse(value));
      if (!currentSchedule || currentSchedule.raw !== scheduleStored.raw || currentSchedule.value.generation !== occurrence.generation || !currentSchedule.value.enabled) {
        await this.finishOccurrence(working, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed while its condition was evaluated' });
        return;
      }
      const evaluated = sessionScheduleOccurrenceSchema.parse({
        ...working.value,
        revision: working.value.revision + 1,
        conditionStatus,
        ...(observed !== undefined ? { conditionObservedRunIds: observed } : {}),
        ...(conditionError ? { error: conditionError } : {}),
        updatedAt: iso(this.clock())
      });
      if (!await this.replace(occurrenceKey(occurrence.id), working.raw, evaluated)) return;
      working = { raw: JSON.stringify(evaluated), value: evaluated };
    }
    const persistedCondition = schedule.condition;
    if (persistedCondition.kind === 'github_new_failure' && working.value.conditionObservedRunIds?.some(id => !persistedCondition.observedRunIds.includes(id))) {
      const observedRunIds = [...new Set([...persistedCondition.observedRunIds, ...working.value.conditionObservedRunIds])].sort((a, b) => a - b).slice(-100);
      const updated = sessionScheduleSchema.parse({ ...schedule, condition: { ...persistedCondition, observedRunIds } });
      if (!await this.replace(scheduleKey(schedule.id), scheduleStored.raw, updated)) {
        await this.finishOccurrence(working, { conditionStatus: 'invalidated', runStatus: 'invalidated', error: 'Schedule changed while its condition was evaluated' });
        return;
      }
      schedule = updated;
    }
    try { await this.requireAuthorized(schedule.sessionId, schedule.actorId); }
    catch (error) {
      const currentSchedule = await this.getRecord(scheduleKey(schedule.id), value => sessionScheduleSchema.parse(value));
      if (currentSchedule?.value.generation === schedule.generation) await this.disableSchedule(currentSchedule);
      await this.finishOccurrence(working, { conditionStatus: 'error', runStatus: 'error', error: errorMessage(error) });
      return;
    }
    if (conditionStatus !== 'passed') {
      await this.finishOccurrence(working, { conditionStatus, runStatus: conditionStatus === 'skipped' ? 'skipped' : conditionStatus === 'invalidated' ? 'invalidated' : 'error', ...(conditionError ? { error: conditionError } : {}) });
      await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
      return;
    }

    const accepted = sessionScheduleOccurrenceSchema.parse({ ...working.value, revision: working.value.revision + 1, conditionStatus: 'passed', updatedAt: iso(this.clock()) });
    if (!await this.replace(occurrenceKey(occurrence.id), working.raw, accepted)) return;
    const idempotencyKey = `session-automation:schedule:${occurrence.id}`;
    const taskId = expectedTaskId(schedule.sessionId, idempotencyKey);
    await this.ensureTaskBinding(taskId, { schemaVersion: 1, kind: 'schedule', sessionId: schedule.sessionId, occurrenceId: occurrence.id });
    try {
      const task = await this.options.runtime.dispatch(schedule.sessionId, schedule.prompt, 'queue', schedule.prompt, undefined, schedule.actorId, idempotencyKey);
      await this.markOccurrenceAccepted(accepted, task.id);
    } catch (error) {
      const taskId = expectedTaskId(schedule.sessionId, idempotencyKey);
      const durable = await this.options.repositories.tasks.get?.(taskId);
      if (durable) await this.markOccurrenceAccepted(accepted, taskId);
      else await this.finishOccurrence({ raw: JSON.stringify(accepted), value: accepted }, { conditionStatus: 'passed', runStatus: 'error', error: errorMessage(error) });
    }
    await this.advanceSchedule(schedule, occurrence.scheduledForUtc);
  }

  private async markOccurrenceAccepted(value: SessionScheduleOccurrence, taskId: string) {
    const current = await this.getRecord(occurrenceKey(value.id), input => sessionScheduleOccurrenceSchema.parse(input));
    if (!current || current.value.runStatus !== 'pending') return;
    const updated = sessionScheduleOccurrenceSchema.parse({ ...current.value, revision: current.value.revision + 1, runStatus: 'accepted', taskId, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: iso(this.clock()) });
    await this.replace(occurrenceKey(value.id), current.raw, updated);
  }

  private async finishOccurrence(stored: { raw: string; value: SessionScheduleOccurrence }, patch: Partial<SessionScheduleOccurrence>) {
    const noTask = !stored.value.taskId && patch.runStatus && !['pending', 'accepted'].includes(patch.runStatus);
    const updated = sessionScheduleOccurrenceSchema.parse({
      ...stored.value,
      ...patch,
      revision: stored.value.revision + 1,
      ...(noTask ? { delivery: { status: 'not_requested', attempts: stored.value.delivery.attempts, updatedAt: iso(this.clock()) } } : {}),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.clock())
    });
    await this.replace(occurrenceKey(stored.value.id), stored.raw, updated);
  }

  private async advanceSchedule(schedule: SessionSchedule, due: string) {
    const current = await this.getRecord(scheduleKey(schedule.id), value => sessionScheduleSchema.parse(value));
    if (!current || current.value.generation !== schedule.generation || current.value.nextDueAt !== due) return;
    const upcoming = nextDue(current.value, this.clock());
    const updated = sessionScheduleSchema.parse({ ...current.value, enabled: current.value.enabled, nextDueAt: upcoming, updatedAt: current.value.updatedAt });
    await this.replace(scheduleKey(schedule.id), current.raw, updated);
  }

  private async disableSchedule(stored: { raw: string; value: SessionSchedule }) {
    if (!stored.value.enabled) return;
    const disabled = sessionScheduleSchema.parse({
      ...stored.value,
      revision: stored.value.revision + 1,
      generation: stored.value.generation + 1,
      enabled: false,
      nextDueAt: undefined,
      updatedAt: iso(this.clock())
    });
    await this.replace(scheduleKey(stored.value.id), stored.raw, disabled);
  }

  private async claimAndPollCi(stored: { raw: string; value: CiSubscription }) {
    const now = this.clock();
    if (new Date(stored.value.expiresAt) <= now) {
      const expired = ciSubscriptionSchema.parse({ ...stored.value, revision: stored.value.revision + 1, status: 'expired', nextPollAt: undefined, updatedAt: iso(now) });
      await this.replace(ciKey(stored.value.id), stored.raw, expired);
      return;
    }
    if (stored.value.leaseExpiresAt && new Date(stored.value.leaseExpiresAt) > now) return;
    const claimed = ciSubscriptionSchema.parse({ ...stored.value, revision: stored.value.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    if (!await this.replace(ciKey(stored.value.id), stored.raw, claimed)) return;
    await this.pollCi({ raw: JSON.stringify(claimed), value: claimed });
  }

  private async pollCi(stored: { raw: string; value: CiSubscription }) {
    let runs: GithubWorkflowRun[];
    try { runs = await this.github.listRuns(stored.value.repository, stored.value.headSha, stored.value.workflow); }
    catch (error) {
      await this.returnCiToWaiting(stored, errorMessage(error));
      return;
    }
    if (runs.length === 0 || runs.some(run => run.status !== 'completed')) {
      await this.returnCiToWaiting(stored);
      return;
    }
    const current = await this.getRecord(ciKey(stored.value.id), value => ciSubscriptionSchema.parse(value));
    if (!current || current.value.status !== 'waiting' || current.value.leaseOwner !== this.ownerId) return;
    const session = await this.options.runtime.getSession(current.value.sessionId);
    if (!isSessionRunnable(session)) {
      await this.finishCi(current, 'session_inactive', 'Session is no longer active');
      return;
    }
    let resolved: Awaited<ReturnType<typeof resolveGithubHead>>;
    try { resolved = await resolveGithubHead(session!.cwd); }
    catch (error) { await this.finishCi(current, 'stale_head', errorMessage(error)); return; }
    if (resolved.repository.slug.toLowerCase() !== current.value.repository.slug.toLowerCase() || resolved.headSha !== current.value.headSha) {
      await this.finishCi(current, 'stale_head', 'Session repository or HEAD changed while waiting for CI');
      return;
    }
    try { await this.requireAuthorized(current.value.sessionId, current.value.actorId); }
    catch (error) { await this.finishCi(current, 'revoked', errorMessage(error)); return; }
    const dispatching = ciSubscriptionSchema.parse({
      ...current.value,
      revision: current.value.revision + 1,
      status: 'dispatching',
      completedRunIds: runs.map(run => run.id),
      dispatchPrompt: formatCiPrompt(current.value.prompt, current.value.repository.slug, current.value.headSha, runs),
      nextPollAt: undefined,
      updatedAt: iso(this.clock())
    });
    if (!await this.replace(ciKey(current.value.id), current.raw, dispatching)) return;
    await this.dispatchCi(dispatching);
  }

  private async recoverDispatchingCi(stored: { raw: string; value: CiSubscription }) {
    if (!stored.value.dispatchPrompt) {
      await this.finishCi(stored, 'error', 'Persisted CI continuation prompt is missing');
      return;
    }
    const now = this.clock();
    if (new Date(stored.value.expiresAt) <= now) { await this.finishCi(stored, 'expired'); return; }
    const claimed = ciSubscriptionSchema.parse({ ...stored.value, revision: stored.value.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(now, CLAIM_TTL_MS), updatedAt: iso(now) });
    if (!await this.replace(ciKey(stored.value.id), stored.raw, claimed)) return;
    const session = await this.options.runtime.getSession(claimed.sessionId);
    if (!isSessionRunnable(session)) { await this.finishCi({ raw: JSON.stringify(claimed), value: claimed }, 'session_inactive', 'Session is no longer active'); return; }
    try {
      await this.requireAuthorized(claimed.sessionId, claimed.actorId);
      const resolved = await resolveGithubHead(session!.cwd);
      if (resolved.repository.slug.toLowerCase() !== claimed.repository.slug.toLowerCase() || resolved.headSha !== claimed.headSha) throw new Error('Session repository or HEAD changed while waiting for CI');
    } catch (error) {
      await this.finishCi({ raw: JSON.stringify(claimed), value: claimed }, 'revoked', errorMessage(error));
      return;
    }
    await this.dispatchCi(claimed);
  }

  private async dispatchCi(dispatching: CiSubscription) {
    const prompt = dispatching.dispatchPrompt;
    if (!prompt) throw new RuntimeError('SESSION_AUTOMATION_CI_PROMPT_MISSING', 'Persisted CI continuation prompt is missing', 500);
    const idempotencyKey = `session-automation:ci:${dispatching.id}`;
    const taskId = expectedTaskId(dispatching.sessionId, idempotencyKey);
    await this.ensureTaskBinding(taskId, { schemaVersion: 1, kind: 'ci', sessionId: dispatching.sessionId, subscriptionId: dispatching.id });
    try {
      const task = await this.options.runtime.dispatch(dispatching.sessionId, prompt, 'queue', prompt, undefined, dispatching.actorId, idempotencyKey);
      await this.markCiAccepted(dispatching.id, task.id);
    } catch (error) {
      const taskId = expectedTaskId(dispatching.sessionId, idempotencyKey);
      const durable = await this.options.repositories.tasks.get?.(taskId);
      if (durable) await this.markCiAccepted(dispatching.id, taskId);
      else {
        const latest = await this.getRecord(ciKey(dispatching.id), value => ciSubscriptionSchema.parse(value));
        if (latest) await this.finishCi(latest, 'error', errorMessage(error));
      }
    }
  }

  private async returnCiToWaiting(stored: { raw: string; value: CiSubscription }, error?: string) {
    const now = this.clock();
    const waiting = ciSubscriptionSchema.parse({
      ...stored.value,
      revision: stored.value.revision + 1,
      status: 'waiting',
      nextPollAt: plus(now, this.pollIntervalMs),
      ...(error ? { error } : { error: undefined }),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(now)
    });
    await this.replace(ciKey(stored.value.id), stored.raw, waiting);
  }

  private async finishCi(stored: { raw: string; value: CiSubscription }, status: CiSubscription['status'], error?: string) {
    const noDelivery = !['waiting', 'dispatching', 'accepted', 'completed'].includes(status);
    const updated = ciSubscriptionSchema.parse({
      ...stored.value,
      revision: stored.value.revision + 1,
      status,
      nextPollAt: undefined,
      ...(error ? { error } : { error: undefined }),
      ...(noDelivery ? { delivery: { status: 'not_requested', attempts: stored.value.delivery.attempts, updatedAt: iso(this.clock()) } } : {}),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.clock())
    });
    await this.replace(ciKey(stored.value.id), stored.raw, updated);
  }

  private async markCiAccepted(id: string, taskId: string) {
    const current = await this.getRecord(ciKey(id), value => ciSubscriptionSchema.parse(value));
    if (!current || current.value.status !== 'dispatching') return;
    const accepted = ciSubscriptionSchema.parse({ ...current.value, revision: current.value.revision + 1, status: 'accepted', taskId, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: iso(this.clock()) });
    await this.replace(ciKey(id), current.raw, accepted);
  }

  private async refreshAcceptedWork() {
    const [occurrences, subscriptions] = await Promise.all([
      this.listRecords(OCCURRENCE_PREFIX, value => sessionScheduleOccurrenceSchema.parse(value)),
      this.listRecords(CI_PREFIX, value => ciSubscriptionSchema.parse(value))
    ]);
    for (const item of occurrences) {
      if (!item.value.taskId) continue;
      const task = await this.options.repositories.tasks.get?.(item.value.taskId);
      if (!task || !terminalTaskStatuses.has(task.status)) continue;
      if (item.value.runStatus === 'accepted') {
        const cancelled = task.status === 'cancelled';
        const runStatus = cancelled ? 'interrupted' : task.status as 'completed' | 'failed' | 'interrupted';
        const now = iso(this.clock());
        const updated = sessionScheduleOccurrenceSchema.parse({
          ...item.value,
          revision: item.value.revision + 1,
          runStatus,
          ...(cancelled ? { delivery: { status: 'not_requested', attempts: item.value.delivery.attempts, updatedAt: now } } : {}),
          updatedAt: now
        });
        if (await this.replace(occurrenceKey(item.value.id), item.raw, updated) && !cancelled) await this.attemptOccurrenceDelivery(updated, task);
      } else if (terminalTaskStatuses.has(item.value.runStatus) && ['pending', 'error'].includes(item.value.delivery.status)) {
        await this.attemptOccurrenceDelivery(item.value, task);
      }
    }
    for (const item of subscriptions) {
      if (!item.value.taskId) continue;
      const task = await this.options.repositories.tasks.get?.(item.value.taskId);
      if (!task || !terminalTaskStatuses.has(task.status)) continue;
      if (item.value.status === 'accepted') {
        if (task.status === 'cancelled') {
          await this.finishCi(item, 'cancelled');
          continue;
        }
        const completed = ciSubscriptionSchema.parse({ ...item.value, revision: item.value.revision + 1, status: 'completed', updatedAt: iso(this.clock()) });
        if (await this.replace(ciKey(item.value.id), item.raw, completed)) await this.attemptCiDelivery(completed, task);
      } else if (item.value.status === 'completed' && ['pending', 'error'].includes(item.value.delivery.status)) {
        await this.attemptCiDelivery(item.value, task);
      }
    }
  }

  private async attemptOccurrenceDelivery(value: SessionScheduleOccurrence, task: TaskRecord) {
    if (!this.options.deliver || !['pending', 'error'].includes(value.delivery.status)) return;
    const before = await this.getRecord(occurrenceKey(value.id), input => sessionScheduleOccurrenceSchema.parse(input));
    if (!before || before.value.delivery.status === 'delivered' || before.value.leaseExpiresAt && new Date(before.value.leaseExpiresAt) > this.clock()) return;
    const claimed = sessionScheduleOccurrenceSchema.parse({ ...before.value, revision: before.value.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(this.clock(), CLAIM_TTL_MS), updatedAt: iso(this.clock()) });
    if (!await this.replace(occurrenceKey(value.id), before.raw, claimed)) return;
    let error: string | undefined;
    try { await this.options.deliver(value.sessionId, task.id, value.id, value.scheduleId); }
    catch (cause) { error = errorMessage(cause); }
    const current = await this.getRecord(occurrenceKey(value.id), input => sessionScheduleOccurrenceSchema.parse(input));
    if (!current || current.value.delivery.status === 'delivered' || current.value.leaseOwner !== this.ownerId) return;
    const updated = sessionScheduleOccurrenceSchema.parse({
      ...current.value,
      revision: current.value.revision + 1,
      delivery: { status: error ? 'error' : 'delivered', attempts: current.value.delivery.attempts + 1, ...(error ? { error } : {}), updatedAt: iso(this.clock()) },
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.clock())
    });
    await this.replace(occurrenceKey(value.id), current.raw, updated);
  }

  private async attemptCiDelivery(value: CiSubscription, task: TaskRecord) {
    if (!this.options.deliver || !['pending', 'error'].includes(value.delivery.status)) return;
    const before = await this.getRecord(ciKey(value.id), input => ciSubscriptionSchema.parse(input));
    if (!before || before.value.delivery.status === 'delivered' || before.value.leaseExpiresAt && new Date(before.value.leaseExpiresAt) > this.clock()) return;
    const claimed = ciSubscriptionSchema.parse({ ...before.value, revision: before.value.revision + 1, leaseOwner: this.ownerId, leaseExpiresAt: plus(this.clock(), CLAIM_TTL_MS), updatedAt: iso(this.clock()) });
    if (!await this.replace(ciKey(value.id), before.raw, claimed)) return;
    let error: string | undefined;
    try { await this.options.deliver(value.sessionId, task.id, value.id, value.id); }
    catch (cause) { error = errorMessage(cause); }
    const current = await this.getRecord(ciKey(value.id), input => ciSubscriptionSchema.parse(input));
    if (!current || current.value.delivery.status === 'delivered' || current.value.leaseOwner !== this.ownerId) return;
    const updated = ciSubscriptionSchema.parse({
      ...current.value,
      revision: current.value.revision + 1,
      delivery: { status: error ? 'error' : 'delivered', attempts: current.value.delivery.attempts + 1, ...(error ? { error } : {}), updatedAt: iso(this.clock()) },
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: iso(this.clock())
    });
    await this.replace(ciKey(value.id), current.raw, updated);
  }
}
