import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  canonicalExecutionJson,
  previewSessionSchedule,
  sessionScheduleOccurrenceSchema,
  type AttemptResultV1,
  type CiPipelineStatus,
  type RepositoryBundle,
  type RuntimeControlClaim,
  type Session,
  type TaskRecord,
  type TaskRequestV1
} from '@dutydeck/shared';
import { createRepositories, executionTaskId } from '@dutydeck/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ciProviders, ciStatus, TEST_CI_REMOTE, type StatusMock } from './ci-provider.test-helpers.js';
import { SessionAutomationService, type SessionAutomationRuntime, type AutomationDeliveryContext } from './session-automation.js';

const run = promisify(execFile);
const cleanups: Array<() => void | Promise<void>> = [];

async function gitRepository() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-automation-git-'));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  await run('git', ['init', '-q', cwd]);
  await run('git', ['-C', cwd, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', cwd, 'config', 'user.name', 'Test']);
  await run('git', ['-C', cwd, 'commit', '--allow-empty', '-qm', 'initial']);
  await run('git', ['-C', cwd, 'remote', 'add', 'origin', TEST_CI_REMOTE]);
  return cwd;
}

type Repos = ReturnType<typeof createRepositories>;
interface HarnessSession { id: string; runId: string }
interface BoundRuntime extends SessionAutomationRuntime {
  dispatches: TaskRecord[];
  /** 经真实账本领取并结算 number=1 Attempt；不通过遗留 tasks.save 伪造状态。 */
  settleTask(taskId: string, outcome?: 'completed' | 'failed' | 'interrupted', text?: string): void;
  /** 首次领取前经账本取消一个仍 queued（无 Attempt）的任务。 */
  cancelQueuedTask(taskId: string): void;
  /** number=1 以 unknown 结算后 retry，number=2 成功；用于验证来源仍固定 number=1。 */
  settleAttempt1UnknownThenAttempt2Completes(taskId: string, text?: string): void;
}

const claims = new WeakMap<Repos, RuntimeControlClaim>();
function bound(repos: Repos) {
  let claim = claims.get(repos);
  if (!claim) { claim = repos.control.attachRuntime('automation-test'); claims.set(repos, claim); }
  return repos.execution.bind(claim);
}

function ledgerRuntime(repos: Repos, harnessSession: HarnessSession, options: { crashAfterAcceptance?: boolean } = {}): BoundRuntime {
  const dispatches: TaskRecord[] = [];
  const acceptedInput = (request: TaskRequestV1) => {
    const actorId = request.actor.kind === 'unspecified' ? undefined : request.actor.id;
    const executionContext: Record<string, unknown> = {
      agentPrompt: (request.sourcePayload as { agentPrompt?: string }).agentPrompt ?? request.prompt,
      ...(actorId ? { actorId } : {})
    };
    const content: any = {
      version: 2 as const,
      prompt: request.prompt,
      executionContext,
      contentSources: [],
      executionOptions: request.options.permissionMode ? { permissionMode: request.options.permissionMode } : {}
    };
    const { digest: _digest, ...unsigned } = content;
    content.digest = createHash('sha256').update(canonicalExecutionJson(unsigned)).digest('hex');
    return content;
  };
  const runtime: BoundRuntime = {
    dispatches,
    async getSession(id) { return repos.sessions.get(id); },
    async dispatchRequest(supplied) {
      if (!supplied) throw new Error('Automation dispatch must reuse the frozen request');
      const sessionId = supplied.sessionId;
      const x = bound(repos);
      const committed = x.acceptTask({ sessionId, runId: harnessSession.runId }, supplied, acceptedInput(supplied), 'back');
      dispatches.push(committed.task!);
      if (options.crashAfterAcceptance) throw new Error('process crashed after acceptance');
      return { id: committed.task!.id, status: committed.task!.status };
    },
    settleTask(taskId, outcome = 'completed', text = 'target result') {
      const task = repos.execution.getTaskExecution(taskId)!.task;
      const x = bound(repos);
      const accepted = repos.execution.getAcceptedTask(taskId)!;
      const runId = harnessSession.runId;
      const claimed = task.currentAttemptId ? undefined : x.claimNext({ sessionId: task.sessionId, runId });
      const attempt = claimed?.attempt ?? repos.execution.getTaskExecution(taskId)!.attempts.find(item => item.attemptId === task.currentAttemptId)!;
      let fence: any = { sessionId: task.sessionId, runId, taskId, attemptId: attempt.attemptId, expectedRevision: attempt.revision };
      x.appendEvent(fence, { id: `out:${taskId}`, type: 'text', data: { role: 'assistant', text } });
      x.markSubmissionPending(fence, { submissionId: `sub:${taskId}`, inputDigest: (accepted.input as { digest: string }).digest, resourceRefs: [], authorizationRefs: [] });
      const current = repos.execution.getTaskExecution(taskId)!.attempts.find(item => item.attemptId === attempt.attemptId)!;
      fence = { ...fence, expectedRevision: current.revision };
      const digest = createHash('sha256').update(text, 'utf8').digest('hex');
      x.settleAttempt(fence, `set:${taskId}`, { kind: 'driver_result', submissionId: `sub:${taskId}`, outcome, outputDigest: digest, stopReason: 'end_turn', complete: true });
    },
    cancelQueuedTask(taskId) {
      const task = repos.execution.getTaskExecution(taskId)!.task;
      bound(repos).cancelQueued(
        { sessionId: task.sessionId, runId: harnessSession.runId },
        taskId,
        task.revision,
        { decisionId: `cancel:${taskId}`, actor: { kind: 'channel', id: 'ou_owner', appId: 'cli_app' }, action: 'cancel', evidenceRefs: ['test'], resourceChecks: [] }
      );
    },
    /** 把 number=1 Attempt 以 driver_result unknown 结算（reconcile_required），再经 retry 让 number=2 成功。 */
    settleAttempt1UnknownThenAttempt2Completes(taskId: string, text = 'second attempt result') {
      const x = bound(repos);
      const runId = harnessSession.runId;
      const claim1 = x.claimNext({ sessionId: harnessSession.id, runId })!;
      const a1 = claim1.attempt!;
      let fence: any = { sessionId: harnessSession.id, runId, taskId, attemptId: a1.attemptId, expectedRevision: a1.revision };
      x.appendEvent(fence, { id: `think:${taskId}`, type: 'thinking', data: { text: 'no final text' } });
      // unknown：manual confirm_result 决策固化 unknown outcome（number=1 缺可靠输出边界）。
      x.settleAttempt(fence, `unknown:${taskId}`, {
        kind: 'manual',
        outcome: 'unknown',
        decision: { decisionId: `decision-unknown:${taskId}`, actor: { kind: 'channel', id: 'ou_owner', appId: 'cli_app' }, action: 'confirm_result', evidenceRefs: ['operator'], resourceChecks: [] }
      });
      const settled1 = repos.execution.getTaskExecution(taskId)!.attempts.find(i => i.attemptId === a1.attemptId)!;
      fence = { ...fence, expectedRevision: settled1.revision };
      // retry 创建 number=2（suspended/not_submitted），再领取并成功结算。
      x.retryAttempt(fence, { decisionId: `retry:${taskId}`, actor: { kind: 'channel', id: 'ou_owner', appId: 'cli_app' }, action: 'retry', allowDuplicateEffects: true, evidenceRefs: ['operator'], resourceChecks: [] }, []);
      const claim2 = x.claimNext({ sessionId: harnessSession.id, runId })!;
      const a2 = claim2.attempt!;
      expect(a2.number).toBe(2);
      let fence2: any = { sessionId: harnessSession.id, runId, taskId, attemptId: a2.attemptId, expectedRevision: a2.revision };
      const accepted = repos.execution.getAcceptedTask(taskId)!;
      x.appendEvent(fence2, { id: `out2:${taskId}`, type: 'text', data: { role: 'assistant', text } });
      x.markSubmissionPending(fence2, { submissionId: `sub2:${taskId}`, inputDigest: (accepted.input as { digest: string }).digest, resourceRefs: [], authorizationRefs: [] });
      const cur2 = repos.execution.getTaskExecution(taskId)!.attempts.find(i => i.attemptId === a2.attemptId)!;
      fence2 = { ...fence2, expectedRevision: cur2.revision };
      const digest = createHash('sha256').update(text, 'utf8').digest('hex');
      x.settleAttempt(fence2, `set2:${taskId}`, { kind: 'driver_result', submissionId: `sub2:${taskId}`, outcome: 'completed', outputDigest: digest, stopReason: 'end_turn', complete: true });
    }
  };
  return runtime;
}

async function fixture(options: { database?: string; clock?: Date; status?: StatusMock; providerId?: string; crashAfterAcceptance?: boolean; deliver?: (sessionId: string, result: AttemptResultV1, occurrenceId: string, sourceId: string, context?: AutomationDeliveryContext) => Promise<void>; onScheduleDisabled?: (schedule: any, reason: string) => Promise<void> } = {}) {
  const directory = options.database ? undefined : await mkdtemp(join(tmpdir(), 'dutydeck-automation-db-'));
  if (directory) cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const database = options.database ?? join(directory!, 'dutydeck.db');
  const repositories = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  cleanups.push(() => { const claim = claims.get(repositories); claim?.release(); repositories.close(); });
  const cwd = await gitRepository();
  // 平台 actor 必须带可核对 App 域：使用真实 lark 来源会话，禁止伪造安装者。
  const claim = repositories.control.attachRuntime('automation-test');
  claims.set(repositories, claim);
  const nowIso = '2026-09-12T00:00:00.000Z';
  const session: Session = { id: `ses_${Math.random()}`, agentId: 'codex', state: 'idle', cwd, runId: 'run_1', source: 'lark', sourceId: 'cli_app:oc_chat:group', permissionMode: 'ask', createdAt: nowIso, updatedAt: nowIso };
  repositories.execution.bind(claim).createSession({ id: session.id, runId: session.runId, agentId: session.agentId, cwd, state: 'idle', source: 'lark', sourceId: session.sourceId, permissionMode: 'ask', createdAt: nowIso, updatedAt: nowIso });
  const now = { value: options.clock ?? new Date('2026-09-12T00:00:00.000Z') };
  const mocked = ledgerRuntime(repositories, { id: session.id, runId: session.runId }, { crashAfterAcceptance: options.crashAfterAcceptance });
  const allowed = { value: true };
  const service = new SessionAutomationService({
    repositories,
    runtime: mocked,
    authorize: async () => allowed.value,
    ciProviders: ciProviders(options.status ?? (vi.fn(async () => ciStatus((await run('git', ['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim())) as StatusMock), options.providerId),
    clock: () => new Date(now.value),
    deliver: options.deliver,
    onScheduleDisabled: options.onScheduleDisabled
  });
  cleanups.push(() => service.close());
  return { database, repositories, cwd, session, now, allowed, service, ...mocked };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const scheduleInput = {
  name: 'Every minute',
  prompt: 'Continue scheduled work',
  trigger: { kind: 'interval' as const, everySeconds: 60, anchorAt: '2026-09-12T00:00:00.000Z' },
  timezone: 'Asia/Shanghai',
  dstPolicy: { gap: 'skip' as const, overlap: 'first' as const },
  condition: { kind: 'always' as const }
};

it('parses unchanged occurrence history once per tick and batches schedule lookup for recovery', async () => {
  const deliver = vi.fn(async () => {});
  const h = await fixture({ deliver });
  const timestamp = h.now.value.toISOString();
  const raws = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const id = `history_${i}`;
    const raw = JSON.stringify(sessionScheduleOccurrenceSchema.parse({
      schemaVersion: 2, id, revision: 1, scheduleId: `removed_${i}`, sessionId: h.session.id, generation: 1,
      scheduledForUtc: timestamp, conditionStatus: 'skipped', runStatus: 'skipped',
      delivery: { status: 'not_requested', attempts: 0, updatedAt: timestamp }, createdAt: timestamp, updatedAt: timestamp
    }));
    raws.add(raw);
    await h.repositories.config.set(`session_automation/occurrence/${id}`, raw);
  }
  const parse = vi.spyOn(JSON, 'parse');
  const schemaParse = vi.spyOn(sessionScheduleOccurrenceSchema, 'parse');
  const get = vi.spyOn(h.repositories.config, 'get');
  try {
    await h.service.tick();
    expect(parse.mock.calls.filter(([raw]) => raws.has(raw))).toHaveLength(100);
    expect(schemaParse).toHaveBeenCalledTimes(100);
    expect(get.mock.calls.filter(([key]) => key.startsWith('session_automation/schedule/'))).toHaveLength(0);
    expect(h.dispatches).toHaveLength(0);
    expect(deliver).not.toHaveBeenCalled();
    parse.mockClear();
    await h.service.tick();
    expect(parse.mock.calls.filter(([raw]) => raws.has(raw))).toHaveLength(100);
  } finally {
    parse.mockRestore(); schemaParse.mockRestore(); get.mockRestore();
  }
});

describe('recurring schedule watermark recovery', () => {
  async function enabledWithoutWatermark(h: Awaited<ReturnType<typeof fixture>>, patch = {}) {
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, timezone: 'UTC', ...patch }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    const key = `session_automation/schedule/${created.id}`;
    const legacy = JSON.parse((await h.repositories.config.get(key))!);
    delete legacy.nextDueAt;
    const raw = JSON.stringify(legacy);
    await h.repositories.config.set(key, raw);
    return { key, raw, legacy, id: created.id };
  }

  it('restores a legacy enabled leap-day schedule and continues execution and delivery after reopening the service', async () => {
    const deliver = vi.fn(async () => {});
    const h = await fixture({ clock: new Date('2026-01-01T00:00:00.000Z') });
    const stored = await enabledWithoutWatermark(h, { trigger: { kind: 'cron', expression: '0 9 29 2 *' } });
    expect(previewSessionSchedule(stored.legacy, h.now.value)?.scheduledForUtc).toBe('2028-02-29T09:00:00.000Z');
    await h.service.tick();
    expect(JSON.parse((await h.repositories.config.get(stored.key))!)).toEqual({ ...stored.legacy, nextDueAt: '2028-02-29T09:00:00.000Z' });
    expect(h.dispatches).toHaveLength(0);
    await h.service.close();
    const reopened = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, clock: () => h.now.value, deliver });
    cleanups.push(() => reopened.close());
    h.now.value = new Date('2028-02-29T09:00:00.000Z');
    await reopened.tick(); await reopened.tick();
    expect(h.dispatches).toHaveLength(1);
    expect((await reopened.getScheduleDefinition(h.session.id, stored.id, 'ou_owner')).nextDueAt).toBe('2032-02-29T09:00:00.000Z');
    h.settleTask(h.dispatches[0]!.id, 'completed', 'leap-day result');
    await reopened.tick();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    await reopened.tick(); expect(deliver).toHaveBeenCalledOnce();
  });

  it('restores an every-minute schedule using its original anchor without firing during repair', async () => {
    const h = await fixture({ clock: new Date('2026-01-01T00:00:30.000Z') });
    const stored = await enabledWithoutWatermark(h, { trigger: { kind: 'interval', everySeconds: 60, anchorAt: '2026-01-01T00:00:00.000Z' } });
    await h.service.tick();
    expect(JSON.parse((await h.repositories.config.get(stored.key))!)).toEqual({ ...stored.legacy, nextDueAt: '2026-01-01T00:01:00.000Z' });
    expect(h.dispatches).toHaveLength(0);
    h.now.value = new Date('2026-01-01T00:01:00.000Z');
    await h.service.tick(); await h.service.tick();
    expect(h.dispatches).toHaveLength(1);
    expect((await h.service.getScheduleDefinition(h.session.id, stored.id, 'ou_owner')).nextDueAt).toBe('2026-01-01T00:02:00.000Z');
  });

  it.each(['at', 'disabled', 'deleted', 'invalid-cron', 'invalid-timezone', 'impossible-date'] as const)('does not revive a %s schedule without a watermark', async kind => {
    const h = await fixture({ clock: new Date('2026-01-01T00:00:00.000Z') });
    const stored = await enabledWithoutWatermark(h, { trigger: { kind: 'interval', everySeconds: 60, anchorAt: '2026-01-01T00:00:00.000Z' } });
    const value = { ...stored.legacy };
    if (kind === 'at') { value.trigger = { kind: 'at', localDateTime: '2025-12-31T23:00:00' }; value.taskStartOccurrenceId = 'completed-once'; }
    if (kind === 'disabled') value.enabled = false;
    if (kind === 'deleted') value.deletedAt = '2025-12-31T23:00:00.000Z';
    if (kind === 'invalid-cron') value.trigger = { kind: 'cron', expression: '99 9 * * *' };
    if (kind === 'invalid-timezone') value.timezone = 'Invalid/Timezone';
    if (kind === 'impossible-date') value.trigger = { kind: 'cron', expression: '0 9 31 2 *' };
    const raw = JSON.stringify(value); await h.repositories.config.set(stored.key, raw);
    await h.service.tick();
    expect(await h.repositories.config.get(stored.key)).toBe(raw);
    expect(h.dispatches).toHaveLength(0);
  });

  it.each(['disable', 'edit'] as const)('keeps a concurrent %s when recovery loses the source CAS', async change => {
    const h = await fixture({ clock: new Date('2026-01-01T00:00:00.000Z') });
    const stored = await enabledWithoutWatermark(h, { trigger: { kind: 'cron', expression: '0 9 29 2 *' } });
    const compare = h.repositories.config.compareAndSet!.bind(h.repositories.config);
    let edited: string | undefined;
    vi.spyOn(h.repositories.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
      if (key === stored.key && expected === stored.raw) {
        edited = JSON.stringify({ ...stored.legacy, revision: stored.legacy.revision + 1, generation: stored.legacy.generation + 1,
          ...(change === 'disable' ? { enabled: false } : { prompt: 'concurrent edit', nextDueAt: '2028-03-01T09:00:00.000Z' }) });
        await h.repositories.config.set(key, edited);
      }
      return compare(key, expected, value);
    });
    await h.service.tick();
    expect(edited).toBeDefined();
    expect(await h.repositories.config.get(stored.key)).toBe(edited);
    expect(h.dispatches).toHaveLength(0);
  });

  it('keeps an unresolved occurrence slot when a legacy recurring schedule has no watermark', async () => {
    const h = await fixture({ clock: new Date('2026-01-01T00:00:00.000Z') });
    const stored = await enabledWithoutWatermark(h, { trigger: { kind: 'cron', expression: '0 9 29 2 *' } });
    const occurrence = sessionScheduleOccurrenceSchema.parse({ schemaVersion: 2, id: 'unresolved', revision: 1, scheduleId: stored.id,
      sessionId: h.session.id, generation: stored.legacy.generation, scheduledForUtc: '2024-02-29T09:00:00.000Z', conditionStatus: 'passed', runStatus: 'blocked',
      delivery: { status: 'not_requested', attempts: 0, updatedAt: '2024-02-29T09:00:00.000Z' }, createdAt: '2024-02-29T09:00:00.000Z', updatedAt: '2024-02-29T09:00:00.000Z' });
    await h.repositories.config.set('session_automation/occurrence/unresolved', JSON.stringify(occurrence));
    await h.service.tick();
    expect(await h.repositories.config.get(stored.key)).toBe(stored.raw);
    expect(h.dispatches).toHaveLength(0);
    const { pendingOccurrence: _pending, ...withoutReservation } = JSON.parse((await h.repositories.config.get(stored.key))!);
    await h.repositories.config.set(stored.key, JSON.stringify({ ...withoutReservation, pendingOccurrence: { id: 'unresolved', generation: stored.legacy.generation, scheduledForUtc: occurrence.scheduledForUtc } }));
    const reserved = await h.repositories.config.get(stored.key);
    await h.service.tick(); expect(await h.repositories.config.get(stored.key)).toBe(reserved);
  });
});

async function completedSchedules(h: Awaited<ReturnType<typeof fixture>>, count = 1) {
  for (let index = 0; index < count; index++) {
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, trigger: { kind: 'at', localDateTime: '2026-09-12T08:01:00' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
  }
  h.now.value = new Date('2026-09-12T00:01:01.000Z');
  await h.service.tick();
  for (const task of h.dispatches) h.settleTask(task.id);
}

describe('scheduled self stop', () => {
  async function activeSchedule(h: Awaited<ReturnType<typeof fixture>>) {
    const schedule = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await h.service.updateSchedule(h.session.id, schedule.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z'); await h.service.tick();
    const task = h.dispatches[0]!;
    const claim = bound(h.repositories).claimNext({ sessionId: h.session.id, runId: h.session.runId })!;
    return { schedule, task, attempt: claim.attempt! };
  }
  it.each(['completed', 'failed', 'unknown', 'revoked'] as const)('only disables its own bound schedule after confirmed successful delivery (%s)', async outcome => {
    const deliver = vi.fn(async () => { if (outcome === 'unknown') throw new Error('unknown delivery'); });
    const h = await fixture({ deliver }); const { schedule, task, attempt } = await activeSchedule(h);
    await expect(h.service.requestScheduleStop(h.session.id, task.id, attempt.attemptId, 'ou_other')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_TASK_REVOKED' });
    const requests = await Promise.all([h.service.requestScheduleStop(h.session.id, task.id, attempt.attemptId, 'ou_owner'), h.service.requestScheduleStop(h.session.id, task.id, attempt.attemptId, 'ou_owner')]);
    expect(requests[0]).toEqual(requests[1]);
    expect((await h.service.listBySession(h.session.id)).schedules[0]?.enabled).toBe(true);
    h.settleTask(task.id, outcome === 'failed' ? 'failed' : 'completed');
    if (outcome === 'revoked') h.allowed.value = false;
    await h.service.tick();
    await vi.waitFor(async () => expect((await h.repositories.config.list!('session_automation/occurrence/')).some(row => ['delivered', 'error'].includes(JSON.parse(row.value).delivery.status))).toBe(true));
    await h.service.tick();
    const stored = JSON.parse((await h.repositories.config.get(`session_automation/schedule/${schedule.id}`))!);
    expect(stored.enabled).toBe(outcome !== 'completed');
    if (outcome === 'completed') expect(stored.stopRequestId).toBeTruthy();
  });
  it('recovers a schedule CAS committed before stop acknowledgment and never disables an edited generation', async () => {
    const h = await fixture({ deliver: async () => {} }); const { schedule, task, attempt } = await activeSchedule(h);
    await h.service.requestScheduleStop(h.session.id, task.id, attempt.attemptId, 'ou_owner');
    const key = `session_automation/stop_request/${task.id}`;
    const request = JSON.parse((await h.repositories.config.get(key))!);
    const cas = h.repositories.config.compareAndSet!.bind(h.repositories.config);
    let failAck = true;
    const write = vi.spyOn(h.repositories.config, 'compareAndSet').mockImplementation(async (target, expected, value) => {
      if (target === key && value && JSON.parse(value).status === 'applied' && failAck) { failAck = false; throw new Error('stop ack disk failed'); }
      return cas(target, expected, value);
    });
    h.settleTask(task.id); await h.service.tick();
    await vi.waitFor(async () => expect(JSON.parse((await h.repositories.config.get(`session_automation/schedule/${schedule.id}`))!).enabled).toBe(false));
    await vi.waitFor(() => expect(failAck).toBe(false));
    write.mockRestore();
    expect(JSON.parse((await h.repositories.config.get(key))!).status).toBe('pending');
    const restored = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, clock: () => h.now.value });
    try { await restored.tick(); } finally { await restored.close(); }
    expect(JSON.parse((await h.repositories.config.get(key))!).status).toBe('applied');
    const saved = JSON.parse((await h.repositories.config.get(`session_automation/schedule/${schedule.id}`))!);
    await h.service.updateSchedule(h.session.id, schedule.id, { expectedRevision: saved.revision, enabled: true }, 'ou_owner');
    await h.repositories.config.set(key, JSON.stringify({ ...request, status: 'pending' }));
    await h.service.tick();
    expect(JSON.parse((await h.repositories.config.get(`session_automation/schedule/${schedule.id}`))!).enabled).toBe(true);
  });
});

describe('SessionAutomationService schedules', () => {
  it('plans another due occurrence while an earlier result delivery remains pending', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sending = new Promise<void>(resolve => { entered = resolve; });
    const h = await fixture({ deliver: async () => { entered(); await gate; } });
    const first = await h.service.createSchedule(h.session.id, { ...scheduleInput, trigger: { kind: 'at', localDateTime: '2026-09-12T08:01:00' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, first.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await h.service.tick(); h.settleTask(h.dispatches[0]!.id);
    const second = await h.service.createSchedule(h.session.id, { ...scheduleInput, trigger: { kind: 'at', localDateTime: '2026-09-12T08:02:00' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, second.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    const ticking = h.service.tick();
    try {
      await sending;
      await vi.waitFor(() => expect(h.dispatches).toHaveLength(2));
      await ticking;
    } finally { release(); await ticking; }
  });

  it('stays disabled until explicit enable and two services sharing one runtime ledger claim one occurrence', async () => {
    const first = await fixture();
    // 多个自动化服务共享同一个 runtime 账本连接（执行账本只允许一个 runtime owner）；
    // 第二服务仍通过 Config CAS 竞争领取，只有一个 occurrence 被处理。
    const second = new SessionAutomationService({ repositories: first.repositories, runtime: first, authorize: async () => true, clock: () => new Date(first.now.value) });
    cleanups.push(() => second.close());

    const created = await first.service.createSchedule(first.session.id, scheduleInput, 'ou_owner');
    expect(created.enabled).toBe(false);
    expect(created.prompt).toBe(scheduleInput.prompt);
    expect(created).not.toHaveProperty('dispatchPrompt');
    first.now.value = new Date('2026-09-12T00:00:01.000Z');
    const enabled = await first.service.updateSchedule(first.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    expect(enabled.nextDueAt).toBe('2026-09-12T00:01:00.000Z');
    first.now.value = new Date('2026-09-12T00:01:01.000Z');
    await Promise.all([first.service.tick(), second.tick()]);

    const tasks = await first.repositories.tasks.listBySession(first.session.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.executionContext?.actorId).toBe('ou_owner');
    expect((await first.service.listBySession(first.session.id)).occurrences).toEqual([
      expect.objectContaining({ scheduleId: created.id, conditionStatus: 'passed', runStatus: 'accepted', taskId: tasks[0]?.id })
    ]);
  });

  it('bounds downtime catch-up to one and resumes after restart without overlapping its active task', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-15T00:00:00.000Z');
    await h.service.tick();
    await h.service.tick();
    expect(await h.repositories.tasks.listBySession(h.session.id)).toHaveLength(1);

    const [task] = await h.repositories.tasks.listBySession(h.session.id);
    h.settleTask(task!.id);
    const restored = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, clock: () => new Date(h.now.value) });
    cleanups.push(() => restored.close());
    await restored.tick();
    expect(await h.repositories.tasks.listBySession(h.session.id)).toHaveLength(1);
    h.now.value = new Date('2026-09-15T00:01:01.000Z');
    await restored.tick();
    expect(await h.repositories.tasks.listBySession(h.session.id)).toHaveLength(2);
  });

  it('records CI condition skip and error without dispatching', async () => {
    const responses: Array<CiPipelineStatus | Error> = [];
    const request = vi.fn(async () => {
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return value!;
    }) as StatusMock;
    const h = await fixture({ status: request });
    const head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'success' }]));
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'ci_new_failure' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    responses.push(ciStatus(head, [{ id: 11, conclusion: 'success' }]));
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).occurrences[0]).toMatchObject({ conditionStatus: 'skipped', runStatus: 'skipped' });
    expect(h.dispatches).toHaveLength(0);

    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    responses.push(new Error('network unavailable'));
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).occurrences.find(item => item.scheduledForUtc === '2026-09-12T00:02:00.000Z')).toMatchObject({ conditionStatus: 'error', runStatus: 'error' });
    expect(h.dispatches).toHaveLength(0);
  });

  it('OCR-07 dispatches a failed rerun once and remembers its attempt across reconstruction', async () => {
    const responses: CiPipelineStatus[] = [];
    const request = vi.fn(async () => responses.shift()!) as StatusMock;
    const h = await fixture({ status: request });
    const head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'success', attempt: 1 }]));
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'ci_new_failure' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'failure', attempt: 2 }]));
    await h.service.tick();
    expect(h.dispatches).toHaveLength(1);
    h.settleTask(h.dispatches[0]!.id);
    await h.service.tick();
    await h.service.close();
    const restored = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, ciProviders: ciProviders(request), clock: () => new Date(h.now.value) });
    cleanups.push(() => restored.close());
    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'failure', attempt: 2 }]));
    await restored.tick();
    expect(h.dispatches).toHaveLength(1);
    expect((await restored.listBySession(h.session.id)).occurrences.at(-1)).toMatchObject({ conditionStatus: 'skipped', runStatus: 'skipped' });
  });

  it('OCR-07 baselines legacy run IDs without replaying existing failures, then detects the next attempt', async () => {
    const responses: CiPipelineStatus[] = [];
    const request = vi.fn(async () => responses.shift()!) as StatusMock;
    const h = await fixture({ status: request });
    const head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'success' }]));
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'ci_new_failure' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    const key = `session_automation/schedule/${created.id}`;
    const legacy = JSON.parse((await h.repositories.config.get(key))!);
    delete legacy.condition.observedRunAttempts;
    await h.repositories.config.set(key, JSON.stringify(legacy));
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'failure', attempt: 5 }]));
    await h.service.tick();
    expect(h.dispatches).toHaveLength(0);
    expect(JSON.parse((await h.repositories.config.get(key))!).condition).toMatchObject({ observedRunIds: [10], observedRunAttempts: [{ id: 10, attempt: 5 }] });
    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'failure', attempt: 6 }]));
    await h.service.tick();
    expect(h.dispatches).toHaveLength(1);
  });

  it('OCR-07 treats missing attempts as attempt one and never replays a lower attempt', async () => {
    const responses: CiPipelineStatus[] = [];
    const request = vi.fn(async () => responses.shift()!) as StatusMock;
    const h = await fixture({ status: request });
    const head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'success', attempt: null }]));
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'ci_new_failure' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'failure', attempt: null }]));
    await h.service.tick();
    expect(h.dispatches).toHaveLength(0);
    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'failure', attempt: 2 }]));
    await h.service.tick();
    expect(h.dispatches).toHaveLength(1);
    h.settleTask(h.dispatches[0]!.id);
    await h.service.tick();
    for (const [index, attempt] of [null, 2].entries()) {
      h.now.value = new Date(`2026-09-12T00:0${index + 3}:01.000Z`);
      responses.push(ciStatus(head, [{ id: 10, conclusion: 'failure', attempt }]));
      await h.service.tick();
    }
    expect(h.dispatches).toHaveLength(1);
  });

  it('detects a newly completed failure even when its run ID predates an observed success', async () => {
    const responses: CiPipelineStatus[] = [];
    const request = vi.fn(async () => responses.shift()!) as StatusMock;
    const h = await fixture({ status: request });
    const head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    responses.push(ciStatus(head, [{ id: 11, conclusion: 'success' }]));
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'ci_new_failure' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    responses.push(ciStatus(head, [{ id: 11, conclusion: 'success' }, { id: 10, conclusion: 'failure' }]));
    await h.service.tick();
    expect(h.dispatches).toHaveLength(1);
    expect((await h.service.listBySession(h.session.id)).occurrences[0]).toMatchObject({ conditionStatus: 'passed', runStatus: 'accepted' });
  });

  it('recovers a durable dispatch acceptance when the caller crashes before bookkeeping', async () => {
    const h = await fixture({ crashAfterAcceptance: true });
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await h.service.tick();
    const list = await h.service.listBySession(h.session.id);
    expect(list.occurrences[0]).toMatchObject({ conditionStatus: 'passed', runStatus: 'accepted' });
    expect(await h.repositories.tasks.listBySession(h.session.id)).toHaveLength(1);
  });

  it('fences a slow condition evaluator after another service takes over its expired lease', async () => {
    let resolveSlow!: (response: CiPipelineStatus) => void;
    const slow = new Promise<CiPipelineStatus>(resolve => { resolveSlow = resolve; });
    let calls = 0;
    let head = '';
    const request = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return ciStatus(head);
      if (calls === 2) return slow;
      return ciStatus(head, [{ id: 20, conclusion: 'failure' }]);
    }) as StatusMock;
    const first = await fixture({ status: request });
    head = (await run('git', ['-C', first.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const created = await first.service.createSchedule(first.session.id, { ...scheduleInput, condition: { kind: 'ci_new_failure' } }, 'ou_owner');
    await first.service.updateSchedule(first.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    first.now.value = new Date('2026-09-12T00:01:01.000Z');
    const firstTick = first.service.tick();
    await vi.waitFor(() => expect(calls).toBe(2));

    const second = new SessionAutomationService({ repositories: first.repositories, runtime: first, authorize: async () => true, ciProviders: ciProviders(request), clock: () => new Date(first.now.value) });
    cleanups.push(() => second.close());
    first.now.value = new Date('2026-09-12T00:01:32.000Z');
    await second.tick();
    resolveSlow(ciStatus(head, [{ id: 20, conclusion: 'failure' }]));
    await firstTick;

    expect(await first.repositories.tasks.listBySession(first.session.id)).toHaveLength(1);
    expect((await first.service.listBySession(first.session.id)).occurrences).toEqual([
      expect.objectContaining({ conditionStatus: 'passed', runStatus: 'accepted', conditionObservedRunIds: [20] })
    ]);
  });

  it('invalidates a slow condition result when the schedule generation changes', async () => {
    let resolveSlow!: (response: CiPipelineStatus) => void;
    const slow = new Promise<CiPipelineStatus>(resolve => { resolveSlow = resolve; });
    let calls = 0;
    let head = '';
    const request = vi.fn(async () => ++calls === 1 ? ciStatus(head) : slow) as StatusMock;
    const h = await fixture({ status: request });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'ci_new_failure' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    const ticking = h.service.tick();
    await vi.waitFor(() => expect(calls).toBe(2));
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 2, name: 'Changed generation' }, 'ou_owner');
    resolveSlow(ciStatus(head, [{ id: 21, conclusion: 'failure' }]));
    await ticking;
    expect(h.dispatches).toHaveLength(0);
    expect((await h.service.listBySession(h.session.id)).occurrences[0]).toMatchObject({ conditionStatus: 'invalidated', runStatus: 'invalidated' });
  });

  it('scans beyond 1,000 records to reconcile terminal work and preserve no-overlap', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    const timestamp = '2026-09-12T00:00:00.000Z';
    for (let index = 0; index < 1_001; index += 1) {
      const id = `dummy_${String(index).padStart(4, '0')}`;
      await h.repositories.config.set(`session_automation/occurrence/${id}`, JSON.stringify(sessionScheduleOccurrenceSchema.parse({
        schemaVersion: 1, id, revision: 1, scheduleId: 'other', sessionId: 'other', generation: 1,
        scheduledForUtc: timestamp, conditionStatus: 'skipped', runStatus: 'skipped',
        delivery: { status: 'not_requested', attempts: 0, updatedAt: timestamp }, createdAt: timestamp, updatedAt: timestamp
      })));
    }
    // 经真实账本接受两条任务：一条结算完成，一条仍 queued；occurrence 不带 admission，由 refresh 固定 legacy_partial。
    const accept = (key: string) => {
      const id = executionTaskId('schedule', h.session.id, key);
      const x = bound(h.repositories);
      const request: TaskRequestV1 = { version: 1, namespace: 'schedule', key, sessionId: h.session.id, actor: { kind: 'channel', id: 'ou_owner', appId: 'cli_app' }, prompt: 'x', mode: 'queue', skills: [], options: { permissionMode: 'ask' }, sources: [], sourcePayload: { agentPrompt: 'x', skills: [] } };
      const input: any = { version: 2, prompt: 'x', executionContext: { agentPrompt: 'x', actorId: 'ou_owner' }, contentSources: [], executionOptions: { permissionMode: 'ask' } };
      const { digest: _digest, ...unsigned } = input;
      input.digest = createHash('sha256').update(canonicalExecutionJson(unsigned)).digest('hex');
      x.acceptTask({ sessionId: h.session.id, runId: 'run_1' }, request, input, 'back');
      return id;
    };
    const terminalId = accept('session-automation:schedule:zzzy_terminal');
    const activeId = accept('session-automation:schedule:zzzz_active');
    h.settleTask(terminalId);
    for (const [id, taskId] of [['zzzy_terminal', terminalId], ['zzzz_active', activeId]] as const) {
      await h.repositories.config.set(`session_automation/occurrence/${id}`, JSON.stringify(sessionScheduleOccurrenceSchema.parse({
        schemaVersion: 1, id, revision: 1, scheduleId: created.id, sessionId: h.session.id, generation: 2,
        scheduledForUtc: timestamp, conditionStatus: 'passed', runStatus: 'accepted', taskId,
        delivery: { status: 'not_requested', attempts: 0, updatedAt: timestamp }, createdAt: timestamp, updatedAt: timestamp
      })));
    }
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await h.service.tick();
    expect(h.dispatches).toHaveLength(0);
    expect(JSON.parse((await h.repositories.config.get('session_automation/occurrence/zzzy_terminal'))!).runStatus).toBe('completed');
  });

  it('rejects creation or enablement for inactive sessions and disables an active schedule after archival', async () => {
    const h = await fixture();
    const enabledCandidate = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const disabledCandidate = await h.service.createSchedule(h.session.id, { ...scheduleInput, name: 'Cannot enable later' }, 'ou_owner');
    const enabled = await h.service.updateSchedule(h.session.id, enabledCandidate.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    const boundX = bound(h.repositories);
    boundX.patchSession({ sessionId: h.session.id, runId: 'run_1' }, { state: 'stopped', archivedAt: '2026-09-12T00:00:30.000Z' });
    await expect(h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    await expect(h.service.updateSchedule(h.session.id, disabledCandidate.id, { expectedRevision: 1, enabled: true }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await h.service.tick();
    h.now.value = new Date('2026-09-12T01:01:01.000Z');
    await h.service.tick();
    const state = await h.service.listBySession(h.session.id);
    const disabled = state.schedules.find(item => item.id === enabled.id);
    expect(disabled).toMatchObject({
      enabled: false,
      revision: enabled.revision + 1,
      generation: enabled.generation + 1,
      updatedAt: '2026-09-12T00:01:01.000Z'
    });
    expect(state.occurrences.filter(item => item.scheduleId === enabled.id)).toHaveLength(1);
    expect(state.occurrences.find(item => item.scheduleId === enabled.id)).toMatchObject({ conditionStatus: 'error', runStatus: 'error' });
    await expect(h.service.updateSchedule(h.session.id, enabled.id, {
      expectedRevision: enabled.revision,
      enabled: false
    }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_REVISION_CONFLICT' });
  });

  it('calls onScheduleDisabled exactly once when an active schedule is disabled due to stopped session', async () => {
    const onScheduleDisabled = vi.fn(async () => {});
    const h = await fixture({ onScheduleDisabled });
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const enabled = await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    const boundX = bound(h.repositories);
    boundX.patchSession({ sessionId: h.session.id, runId: 'run_1' }, { state: 'stopped' });
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await h.service.tick();
    expect(onScheduleDisabled).toHaveBeenCalledTimes(1);
    expect(onScheduleDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ id: enabled.id, name: 'Every minute' }),
      'Session is no longer active'
    );
    // 第二次到点时不应重复调用
    h.now.value = new Date('2026-09-12T01:01:01.000Z');
    await h.service.tick();
    expect(onScheduleDisabled).toHaveBeenCalledTimes(1);
  });

  it('advances revision and generation when revoked authorization disables a due schedule', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const enabled = await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.allowed.value = false;
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await h.service.tick();
    h.allowed.value = true;

    const state = await h.service.listBySession(h.session.id);
    expect(state.schedules.find(item => item.id === enabled.id)).toMatchObject({
      enabled: false,
      revision: enabled.revision + 1,
      generation: enabled.generation + 1,
      updatedAt: '2026-09-12T00:01:01.000Z'
    });
    expect(state.occurrences.find(item => item.scheduleId === enabled.id)).toMatchObject({ conditionStatus: 'error', runStatus: 'error' });
    expect(h.dispatches).toHaveLength(0);
    await expect(h.service.updateSchedule(h.session.id, enabled.id, {
      expectedRevision: enabled.revision,
      enabled: false
    }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_REVISION_CONFLICT' });
  });

  it('reconciles an externally cancelled queued occurrence and lets the interval continue', async () => {
    const deliver = vi.fn(async () => undefined);
    const h = await fixture({ deliver });
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await h.service.tick();
    const [cancelledTask] = await h.repositories.tasks.listBySession(h.session.id);
    h.cancelQueuedTask(cancelledTask!.id);

    await h.service.tick();
    const cancelledOccurrence = (await h.service.listBySession(h.session.id)).occurrences[0];
    expect(cancelledOccurrence).toMatchObject({ runStatus: 'interrupted', delivery: { status: 'not_requested', attempts: 0 } });
    expect(deliver).not.toHaveBeenCalled();

    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    await h.service.tick();
    expect(await h.repositories.tasks.listBySession(h.session.id)).toHaveLength(2);
    expect(h.dispatches).toHaveLength(2);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('rejects final submission when a schedule changes after prepare preflight', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const enabled = await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await h.service.tick();
    const [task] = await h.repositories.tasks.listBySession(h.session.id);
    await h.service.authorizeTask(task!, 'prepare');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: enabled.revision, enabled: false }, 'ou_owner');
    await expect(h.service.authorizeTask(task!, 'submit')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_TASK_REVOKED' });
  });

  it('keeps a source blocked on the number=1 unknown attempt even when a later attempt succeeds', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await h.service.tick();
    const [task] = await h.repositories.tasks.listBySession(h.session.id);
    // number=1 unknown，retry 后 number=2 成功。
    h.settleAttempt1UnknownThenAttempt2Completes(task!.id);
    await h.service.tick();
    const occurrence = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    expect(occurrence.runStatus).toBe('blocked');
    expect((occurrence as { blockReason?: string }).blockReason).toBe('reconcile_required');
    // blocked 来源持续挡下一次触发：推进到下一分钟也不创建新 occurrence。
    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).occurrences).toHaveLength(1);
  });
});

describe('bounded automatic result delivery', () => {
  it('waits for a claim crossing close and never starts its outbound send', async () => {
    const deliver = vi.fn(async () => {});
    const h = await fixture({ deliver }); await completedSchedules(h);
    let entered!: () => void, release!: () => void;
    const claimed = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = h.repositories.config.compareAndSet!.bind(h.repositories.config);
    const cas = vi.spyOn(h.repositories.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
      const changed = await original(key, expected, value);
      if (changed && JSON.parse(value).leaseOwner?.startsWith('automation_delivery_')) { entered(); await gate; }
      return changed;
    });
    const ticking = h.service.tick(); await claimed;
    let closed = false;
    const closing = h.service.close().then(() => { closed = true; });
    try {
      expect(closed).toBe(false); expect(deliver).not.toHaveBeenCalled();
      release(); await Promise.all([ticking, closing, h.service.close()]);
      expect(deliver).not.toHaveBeenCalled();
      const occurrence = (await h.service.listBySession(h.session.id)).occurrences[0]!;
      expect(occurrence.delivery).toMatchObject({ status: 'error', attempts: 1 });
      expect(JSON.parse((await h.repositories.config.get(`session_automation/occurrence/${occurrence.id}`))!).leaseOwner).toBeUndefined();
    } finally { release(); cas.mockRestore(); }
  });

  it('holds at most four sends across ticks and gives later sources a turn after failures', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const h = await fixture({ deliver: async (_session, _result, id) => { sent.push(id); await gate; throw new Error('temporary'); } });
    await completedSchedules(h, 6);
    try {
      await h.service.tick(); await vi.waitFor(() => expect(sent).toHaveLength(4));
      await h.service.tick(); await h.service.tick();
      expect(sent).toHaveLength(4); expect(new Set(sent).size).toBe(4);
      release();
      await vi.waitFor(async () => expect((await h.service.listBySession(h.session.id)).occurrences.filter(item => item.delivery.status === 'error')).toHaveLength(4));
      await h.service.tick();
      await vi.waitFor(() => expect(new Set(sent).size).toBe(6));
      expect(h.dispatches).toHaveLength(6);
    } finally { release(); }
  });

  it('renews a long send, prevents a second instance claim, and aborts a lost lease without stale settlement', async () => {
    let context!: AutomationDeliveryContext;
    const h = await fixture({ deliver: async (_session, _result, _id, _source, control) => {
      context = control!;
      await new Promise<void>((_resolve, reject) => control!.signal.addEventListener('abort', () => reject(control!.signal.reason), { once: true }));
    } });
    await completedSchedules(h);
    let heartbeat!: () => void;
    const originalInterval = globalThis.setInterval;
    const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, ms: number) => {
      if (ms === 10_000) heartbeat = handler;
      return originalInterval(handler, 1_000_000);
    }) as typeof setInterval);
    cleanups.push(() => timer.mockRestore());
    await h.service.tick(); await vi.waitFor(() => expect(context).toBeDefined());
    const occurrence = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    const key = `session_automation/occurrence/${occurrence.id}`;
    const first = JSON.parse((await h.repositories.config.get(key))!);
    h.now.value = new Date(h.now.value.getTime() + 20_000); heartbeat();
    await vi.waitFor(async () => expect(JSON.parse((await h.repositories.config.get(key))!).leaseExpiresAt).toBe(new Date(h.now.value.getTime() + 30_000).toISOString()));
    h.now.value = new Date(h.now.value.getTime() + 15_000);
    const send = vi.fn(async () => {});
    const second = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, clock: () => new Date(h.now.value), deliver: send });
    cleanups.push(() => second.close());
    await second.tick(); expect(send).not.toHaveBeenCalled();
    const raw = (await h.repositories.config.get(key))!;
    await h.repositories.config.compareAndSet!(key, raw, JSON.stringify({ ...JSON.parse(raw), revision: first.revision + 10, leaseOwner: 'new-owner' }));
    heartbeat(); await vi.waitFor(() => expect(context.signal.aborted).toBe(true));
    await h.service.close();
    const after = JSON.parse((await h.repositories.config.get(key))!);
    expect(after.leaseOwner).toBe('new-owner'); expect(after.delivery).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('lets another instance reclaim an expired delivery and rejects the original late receipt', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sending = vi.fn(async () => { await gate; });
    const h = await fixture({ deliver: sending }); await completedSchedules(h);
    await h.service.tick(); await vi.waitFor(() => expect(sending).toHaveBeenCalledOnce());
    const occurrence = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    const key = `session_automation/occurrence/${occurrence.id}`;
    const firstOwner = JSON.parse((await h.repositories.config.get(key))!).leaseOwner;
    h.now.value = new Date(h.now.value.getTime() + 31_000);
    const other = vi.fn(async () => {});
    const second = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, clock: () => new Date(h.now.value), deliver: other });
    cleanups.push(() => second.close());
    try {
      await second.tick();
      await vi.waitFor(async () => expect(JSON.parse((await h.repositories.config.get(key))!).delivery).toMatchObject({ status: 'delivered', attempts: 1 }));
      expect(other).toHaveBeenCalledOnce();
      expect(JSON.parse((await h.repositories.config.get(key))!).leaseOwner).not.toBe(firstOwner);
      release(); await h.service.close();
      expect(JSON.parse((await h.repositories.config.get(key))!).delivery).toMatchObject({ status: 'delivered', attempts: 1 });
    } finally { release(); }
  });
});

describe('SessionAutomationService CI subscriptions', () => {
  it('prepares an immutable delivery destination before saving a new automation record', async () => {
    const h = await fixture();
    const prepared: string[] = [];
    const service = new SessionAutomationService({
      repositories: h.repositories,
      runtime: h,
      authorize: async () => true,
      ciProviders: ciProviders(),
      prepareDelivery: async (sessionId, id) => {
        expect(sessionId).toBe(h.session.id);
        expect(await h.repositories.config.get(`session_automation/${id.startsWith('ci_') ? 'ci' : 'schedule'}/${id}`)).toBeUndefined();
        prepared.push(id);
      }
    });
    cleanups.push(() => service.close());
    const schedule = await service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const subscription = await service.subscribeCi(h.session.id, {}, 'ou_owner');
    expect(prepared).toEqual([schedule.id, subscription.id]);
  });

  it('coalesces completed results into one durable continuation and preserves the actor', async () => {
    let head = '';
    const request = vi.fn(async () => ciStatus(head, [{ id: 41, conclusion: 'success', name: 'lint' }, { id: 42, conclusion: 'failure', name: 'test' }])) as StatusMock;
    const h = await fixture({ status: request, crashAfterAcceptance: true });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const subscription = await h.service.subscribeCi(h.session.id, { workflow: 'ci.yml', ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const task = (await h.repositories.tasks.listBySession(h.session.id))[0]!;
    expect(task.prompt).toContain('lint: success');
    expect(task.prompt).toContain('test: failure');
    expect(task.executionContext?.actorId).toBe('ou_owner');
    const listed = (await h.service.listBySession(h.session.id)).subscriptions[0]!;
    expect(listed).toMatchObject({ id: subscription.id, prompt: 'Review the completed Test CI result and continue the task.', status: 'accepted', completedRunIds: [41, 42], taskId: task.id });
    expect(listed).not.toHaveProperty('dispatchPrompt');
  });

  it('recovers a dispatching subscription with its exact persisted prompt after restart', async () => {
    let head = '';
    const request = vi.fn(async () => ciStatus(head, [{ id: 50, conclusion: 'failure', name: 'original result' }])) as StatusMock;
    const h = await fixture({ status: request });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const subscription = await h.service.subscribeCi(h.session.id, { prompt: 'Continue exactly once', ttlSeconds: 600 }, 'ou_owner');
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const hangingRuntime: SessionAutomationRuntime = {
      getSession: id => h.repositories.sessions.get(id),
      async dispatchRequest() { await blocked; throw new Error('old process stopped'); }
    };
    const first = new SessionAutomationService({ repositories: h.repositories, runtime: hangingRuntime, authorize: async () => true, ciProviders: ciProviders(request), clock: () => new Date(h.now.value) });
    cleanups.push(() => first.close());
    const firstTick = first.tick();
    await vi.waitFor(async () => {
      const raw = await h.repositories.config.get(`session_automation/ci/${subscription.id}`);
      expect(JSON.parse(raw!).status).toBe('dispatching');
    });
    const persisted = JSON.parse((await h.repositories.config.get(`session_automation/ci/${subscription.id}`))!) as { dispatchPrompt: string };

    h.now.value = new Date('2026-09-12T00:00:31.000Z');
    const restored = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, ciProviders: ciProviders(vi.fn(async () => ciStatus(head, [{ id: 999, conclusion: 'success', name: 'different later result' }])) as StatusMock), clock: () => new Date(h.now.value) });
    cleanups.push(() => restored.close());
    await restored.tick();
    release();
    await firstTick;

    const [task] = await h.repositories.tasks.listBySession(h.session.id);
    expect(task?.prompt).toBe(persisted.dispatchPrompt);
    expect(task?.prompt).toContain('original result');
    expect(task?.prompt).not.toContain('different later result');
    expect(request).toHaveBeenCalledTimes(1);
    expect((await h.service.listBySession(h.session.id)).subscriptions[0]).toMatchObject({ status: 'accepted', taskId: task?.id });
  });

  it('waits while any matching HEAD workflow is still running, then coalesces all terminal runs', async () => {
    let head = '';
    const responses: CiPipelineStatus[] = [];
    const request = vi.fn(async () => responses.shift()!) as StatusMock;
    const h = await fixture({ status: request });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const subscription = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    responses.push(ciStatus(head, [
      { id: 60, status: 'completed', conclusion: 'success', name: 'lint' },
      { id: 61, status: 'in_progress', name: 'test' }
    ]));
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).subscriptions.find(item => item.id === subscription.id)?.status).toBe('waiting');
    expect(h.dispatches).toHaveLength(0);

    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    responses.push(ciStatus(head, [
      { id: 60, status: 'completed', conclusion: 'success', name: 'lint' },
      { id: 61, status: 'completed', conclusion: 'failure', name: 'test' }
    ]));
    await h.service.tick();
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]?.prompt).toContain('lint: success');
    expect(h.dispatches[0]?.prompt).toContain('test: failure');
  });

  it('prevents wake for old HEAD, expired, cancelled, and revoked subscriptions', async () => {
    let head = '';
    const request = vi.fn(async () => ciStatus(head, [{ id: 1, conclusion: 'success' }])) as StatusMock;
    const h = await fixture({ status: request });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const stale = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await run('git', ['-C', h.cwd, 'commit', '--allow-empty', '-qm', 'next']);
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).subscriptions.find(item => item.id === stale.id)?.status).toBe('stale_head');
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();

    const cancelled = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await h.service.cancelCi(h.session.id, cancelled.id, { expectedRevision: cancelled.revision }, 'ou_owner');
    const expiring = await h.service.subscribeCi(h.session.id, { ttlSeconds: 60 }, 'ou_owner');
    h.allowed.value = false;
    const revoked = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner').catch(() => undefined);
    expect(revoked).toBeUndefined();
    h.allowed.value = true;
    const revokeAfterCreate = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    h.allowed.value = false;
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await h.service.tick();
    h.allowed.value = true;
    const statuses = (await h.service.listBySession(h.session.id)).subscriptions;
    expect(statuses.find(item => item.id === cancelled.id)?.status).toBe('cancelled');
    expect(statuses.find(item => item.id === expiring.id)?.status).toBe('expired');
    expect(statuses.find(item => item.id === revokeAfterCreate.id)?.status).toBe('revoked');
    expect(h.dispatches).toHaveLength(0);
  });

  it('cancels an accepted queued task at the Runtime execution fence', async () => {
    let head = '';
    const h = await fixture({ status: vi.fn(async () => ciStatus(head, [{ id: 4, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const created = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const accepted = (await h.service.listBySession(h.session.id)).subscriptions[0]!;
    const task = (await h.repositories.tasks.listBySession(h.session.id))[0]!;
    await h.service.authorizeTask(task, 'prepare');
    await h.service.cancelCi(h.session.id, created.id, { expectedRevision: accepted.revision }, 'ou_owner');
    await expect(h.service.authorizeTask(task, 'submit')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_TASK_REVOKED' });
  });

  it('linearizes CI submission before cancellation and preserves the started turn', async () => {
    let head = '';
    const h = await fixture({ status: vi.fn(async () => ciStatus(head, [{ id: 7, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const created = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const task = (await h.repositories.tasks.listBySession(h.session.id))[0]!;
    await h.service.authorizeTask(task, 'submit');
    const current = (await h.service.listBySession(h.session.id)).subscriptions[0]!;
    await expect(h.service.cancelCi(h.session.id, created.id, { expectedRevision: current.revision }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_CI_ALREADY_STARTED' });
    await expect(h.service.authorizeTask(task, 'submit')).resolves.toBeUndefined();
  });

  it('reconciles an externally cancelled queued CI continuation without delivery', async () => {
    let head = '';
    const deliver = vi.fn(async () => undefined);
    const h = await fixture({
      status: vi.fn(async () => ciStatus(head, [{ id: 8, conclusion: 'success' }])) as StatusMock,
      deliver
    });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const created = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const [task] = await h.repositories.tasks.listBySession(h.session.id);
    h.cancelQueuedTask(task!.id);

    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).subscriptions.find(item => item.id === created.id)).toMatchObject({
      status: 'cancelled',
      delivery: { status: 'not_requested', attempts: 0 }
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(h.dispatches).toHaveLength(1);
  });

  it('retries only failed result delivery and never dispatches the prompt again', async () => {
    let head = '';
    const deliver = vi.fn().mockRejectedValueOnce(new Error('delivery unavailable')).mockResolvedValue(undefined);
    const h = await fixture({ status: vi.fn(async () => ciStatus(head, [{ id: 5, conclusion: 'success' }])) as StatusMock, deliver });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const subscription = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const [task] = await h.repositories.tasks.listBySession(h.session.id);
    h.settleTask(task!.id);
    await h.service.tick();
    await vi.waitFor(async () => expect((await h.service.listBySession(h.session.id)).subscriptions[0]?.delivery).toMatchObject({ status: 'error', attempts: 1 }));
    await h.service.tick();
    await vi.waitFor(async () => {
      await h.service.tick();
      expect((await h.service.listBySession(h.session.id)).subscriptions[0]?.delivery).toMatchObject({ status: 'delivered', attempts: 2 });
    });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenLastCalledWith(h.session.id, expect.objectContaining({ taskId: task?.id }), subscription.id, subscription.id, expect.objectContaining({ signal: expect.any(AbortSignal), assertCurrent: expect.any(Function) }));
    expect(h.dispatches).toHaveLength(1);
  });

  it('rejects protected reads and writes when no service authorizer is wired', async () => {
    const h = await fixture();
    const service = new SessionAutomationService({ repositories: h.repositories, runtime: h });
    cleanups.push(() => service.close());
    await expect(service.listBySession(h.session.id)).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_AUTH_UNWIRED' });
    await expect(service.subscribeCi(h.session.id, {})).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_AUTH_UNWIRED' });
  });
});


describe('CI 插件化之前保存的记录', () => {
  it('旧的 github_new_failure 条件读成 ci_new_failure，并由 github 提供方继续判断', async () => {
    const responses: CiPipelineStatus[] = [];
    const request = vi.fn(async () => responses.shift()!) as StatusMock;
    const h = await fixture({ status: request, providerId: 'github' });
    const head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'success' }]));
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'ci_new_failure' } }, 'ou_owner');
    const key = `session_automation/schedule/${created.id}`;
    const stored = JSON.parse((await h.repositories.config.get(key))!);
    expect(stored.condition).toMatchObject({ kind: 'ci_new_failure', provider: 'github', observedRunIds: [10] });
    const { provider: _provider, ...condition } = stored.condition;
    await h.repositories.config.set(key, JSON.stringify({ ...stored, condition: { ...condition, kind: 'github_new_failure' } }));
    expect((await h.service.listBySession(h.session.id)).schedules[0]).toMatchObject({ condition: { kind: 'ci_new_failure', provider: 'github', observedRunIds: [10] } });
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    responses.push(ciStatus(head, [{ id: 10, conclusion: 'success' }, { id: 11, conclusion: 'failure' }]));
    await h.service.tick();
    expect(h.dispatches).toHaveLength(1);
    expect((await h.service.listBySession(h.session.id)).occurrences[0]).toMatchObject({ conditionStatus: 'passed', conditionObservedRunIds: [10, 11] });
  });

  it('没有 provider 字段的 CI 订阅按 github 提供方轮询并续作', async () => {
    let head = '';
    const request = vi.fn(async () => ciStatus(head, [{ id: 5, conclusion: 'failure', name: 'test' }])) as StatusMock;
    const h = await fixture({ status: request, providerId: 'github' });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const subscription = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    const key = `session_automation/ci/${subscription.id}`;
    const { provider, ...legacy } = JSON.parse((await h.repositories.config.get(key))!);
    expect(provider).toBe('github');
    await h.repositories.config.set(key, JSON.stringify(legacy));
    await h.service.tick();
    expect(request).toHaveBeenCalledWith({ repository: { owner: 'octo', name: 'repo', slug: 'octo/repo' }, sha: head });
    const [task] = await h.repositories.tasks.listBySession(h.session.id);
    expect(task?.prompt).toContain('test: failure');
    expect((await h.service.listBySession(h.session.id)).subscriptions[0]).toMatchObject({ id: subscription.id, status: 'accepted' });
  });
});

describe('没有安装 CI 插件', () => {
  it('普通定时任务照常工作；CI 条件和等待 CI 给出明确提示，不写入记录', async () => {
    const h = await fixture();
    const service = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, clock: () => new Date(h.now.value) });
    cleanups.push(() => service.close());
    expect(service.ciConfigured).toBe(false);
    expect(service.ciWebhook).toBeUndefined();
    expect(service.listCiProviders()).toEqual([]);
    await expect(service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner')).rejects.toMatchObject({ code: 'CI_REMOTE_UNSUPPORTED', message: '还没有安装 CI 插件' });
    await expect(service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'ci_new_failure' } }, 'ou_owner')).rejects.toMatchObject({ code: 'CI_REMOTE_UNSUPPORTED' });
    expect((await service.listBySession(h.session.id)).subscriptions).toEqual([]);
    const created = await service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await service.tick();
    expect(h.dispatches).toHaveLength(1);
  });
});

describe('manual schedule execution and deletion', () => {
  it('runs a paused schedule idempotently without changing its cadence, and blocks competing runs', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const input = { expectedRevision: created.revision, idempotencyKey: 'manual-1' };
    const attempts = await Promise.all([
      h.service.runSchedule(h.session.id, created.id, input, 'ou_owner'),
      h.service.runSchedule(h.session.id, created.id, input, 'ou_owner')
    ]);
    expect(attempts[0].id).toBe(attempts[1].id);
    expect(attempts[0].triggerSource).toBe('manual');
    expect(h.dispatches).toHaveLength(1);
    const schedule = (await h.service.listBySession(h.session.id)).schedules[0]!;
    expect(schedule).toEqual(created);
    expect(schedule).not.toHaveProperty('pendingOccurrence');
    await expect(h.service.runSchedule(h.session.id, created.id, { ...input, idempotencyKey: 'manual-2' }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_SCHEDULE_BUSY' });
    await h.service.authorizeTask(h.dispatches[0]!, 'submit');
    h.settleTask(h.dispatches[0]!.id);
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).schedules[0]).toEqual(created);
    const replay = await h.service.runSchedule(h.session.id, created.id, input, 'ou_owner');
    expect(replay.runStatus).toBe('completed');
    expect(h.dispatches).toHaveLength(1);
  });

  it('reserves one slot across concurrent manual keys and a due timed trigger', async () => {
    const h = await fixture();
    const competing = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, clock: () => new Date(h.now.value) });
    cleanups.push(() => competing.close());
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const enabled = await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await Promise.allSettled([
      h.service.runSchedule(h.session.id, created.id, { expectedRevision: enabled.revision, idempotencyKey: 'first' }, 'ou_owner'),
      competing.runSchedule(h.session.id, created.id, { expectedRevision: enabled.revision, idempotencyKey: 'second' }, 'ou_owner'),
      h.service.tick()
    ]);
    expect(h.dispatches).toHaveLength(1);
    const first = (await h.service.listBySession(h.session.id)).occurrences;
    expect(first).toHaveLength(1);
    h.settleTask(h.dispatches[0]!.id);
    await h.service.tick();
    expect(h.dispatches).toHaveLength(first[0]!.triggerSource === 'manual' ? 2 : 1);
  });

  it('keeps nextDueAt unchanged for an enabled manual run, including a skipped condition', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const enabled = await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    await h.service.runSchedule(h.session.id, created.id, { expectedRevision: enabled.revision, idempotencyKey: 'run' }, 'ou_owner');
    expect((await h.service.listBySession(h.session.id)).schedules[0]).toEqual(enabled);
    h.settleTask(h.dispatches[0]!.id);
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).schedules[0]).toEqual(enabled);
    const conditional = await h.service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'ci_new_failure' } }, 'ou_owner');
    const skipped = await h.service.runSchedule(h.session.id, conditional.id, { expectedRevision: 1, idempotencyKey: 'conditional' }, 'ou_owner');
    expect(skipped).toMatchObject({ conditionStatus: 'skipped', runStatus: 'skipped' });
    expect((await h.service.listBySession(h.session.id)).schedules.find(item => item.id === conditional.id)).toEqual(conditional);
  });

  it('recovers a crash between reservation and occurrence insertion without duplicating accepted work', async () => {
    const h = await fixture({ crashAfterAcceptance: true });
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const compare = h.repositories.config.compareAndSet!.bind(h.repositories.config);
    const spy = vi.spyOn(h.repositories.config, 'compareAndSet').mockImplementation(async (key, previous, value) => {
      if (key.startsWith('session_automation/occurrence/')) throw new Error('crash before occurrence insertion');
      return compare(key, previous, value);
    });
    const input = { expectedRevision: 1, idempotencyKey: 'recover' };
    await expect(h.service.runSchedule(h.session.id, created.id, input, 'ou_owner')).rejects.toThrow('crash before occurrence insertion');
    spy.mockRestore();
    await h.service.close();
    const recovered = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, clock: () => new Date(h.now.value) });
    cleanups.push(() => recovered.close());
    await recovered.tick();
    expect(h.dispatches).toHaveLength(1);
    const replay = await recovered.runSchedule(h.session.id, created.id, input, 'ou_owner');
    expect(replay).toMatchObject({ runStatus: 'accepted', triggerSource: 'manual' });
    await recovered.tick();
    expect(h.dispatches).toHaveLength(1);
  });

  it('blocks new runs after an unknown attempt instead of starting a replacement task', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const first = await h.service.runSchedule(h.session.id, created.id, { expectedRevision: 1, idempotencyKey: 'first' }, 'ou_owner');
    h.settleAttempt1UnknownThenAttempt2Completes(first.taskId!);
    await h.service.tick();
    await expect(h.service.runSchedule(h.session.id, created.id, { expectedRevision: 1, idempotencyKey: 'replacement' }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_SCHEDULE_BUSY' });
    expect(h.dispatches).toHaveLength(1);
  });

  it('soft deletes definitions, invalidates unsubmitted tasks, and retains their history', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const manual = await h.service.runSchedule(h.session.id, created.id, { expectedRevision: 1, idempotencyKey: 'first' }, 'ou_owner');
    await expect(h.service.deleteSchedule(h.session.id, created.id, { expectedRevision: 2 }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_REVISION_CONFLICT' });
    const deleted = await h.service.deleteSchedule(h.session.id, created.id, { expectedRevision: 1 }, 'ou_owner');
    expect(deleted).toMatchObject({ enabled: false, generation: 2, deletedAt: h.now.value.toISOString() });
    await expect(h.service.authorizeTask(h.dispatches[0]!, 'submit')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_TASK_REVOKED' });
    expect((await h.service.listBySession(h.session.id)).schedules).toEqual([]);
    expect((await h.service.listBySession(h.session.id)).occurrences).toEqual([expect.objectContaining({ id: manual.id, runStatus: 'invalidated' })]);
    expect(await h.service.getScheduleDefinition(h.session.id, created.id, 'ou_owner')).toEqual(deleted);
    await expect(h.service.runSchedule(h.session.id, created.id, { expectedRevision: 2, idempotencyKey: 'new' }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_SCHEDULE_DELETED' });
    await expect(h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 2, enabled: true }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_SCHEDULE_DELETED' });
  });

  it('lets an already submitted task settle after deletion, without issuing another turn', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await h.service.runSchedule(h.session.id, created.id, { expectedRevision: 1, idempotencyKey: 'run' }, 'ou_owner');
    await h.service.authorizeTask(h.dispatches[0]!, 'submit');
    await h.service.deleteSchedule(h.session.id, created.id, { expectedRevision: 1 }, 'ou_owner');
    await expect(h.service.authorizeTask(h.dispatches[0]!, 'submit')).resolves.toBeUndefined();
    h.settleTask(h.dispatches[0]!.id);
    await h.service.tick();
    const records = await h.service.listBySession(h.session.id);
    expect(records.schedules).toEqual([]);
    expect(records.occurrences[0]).toMatchObject({ runStatus: 'completed', resultBoundary: 'verified' });
    expect(h.dispatches).toHaveLength(1);
  });

  it('requires authorization for new actions and refuses dispatch after shutdown', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    h.allowed.value = false;
    await expect(h.service.runSchedule(h.session.id, created.id, { expectedRevision: 1, idempotencyKey: 'x' }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_FORBIDDEN' });
    await expect(h.service.deleteSchedule(h.session.id, created.id, { expectedRevision: 1 }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_FORBIDDEN' });
    h.allowed.value = true;
    await h.service.close();
    await expect(h.service.runSchedule(h.session.id, created.id, { expectedRevision: 1, idempotencyKey: 'x' }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_CLOSED' });
  });

  it('waits for an in-flight manual admission when closing', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const compare = h.repositories.config.compareAndSet!.bind(h.repositories.config);
    const spy = vi.spyOn(h.repositories.config, 'compareAndSet').mockImplementation(async (key, previous, value) => {
      if (key.startsWith('session_automation/occurrence/') && previous === undefined) { enter(); await gate; }
      return compare(key, previous, value);
    });
    const running = h.service.runSchedule(h.session.id, created.id, { expectedRevision: 1, idempotencyKey: 'closing' }, 'ou_owner');
    await entered;
    let closed = false;
    const closing = h.service.close().then(() => { closed = true; });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(h.dispatches).toHaveLength(0);
    } finally { release(); await running; await closing; spy.mockRestore(); }
    expect(closed).toBe(true);
    expect(h.dispatches).toHaveLength(1);
  });
});

it('keeps the latest 1000 occurrences of one deleted schedule independently of other plan traffic', async () => {
  const h = await fixture();
  const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
  const original = await h.service.runSchedule(h.session.id, created.id, { expectedRevision: 1, idempotencyKey: 'old' }, 'ou_owner');
  h.settleTask(original.taskId!);
  await h.service.tick();
  await h.service.deleteSchedule(h.session.id, created.id, { expectedRevision: 1 }, 'ou_owner');
  const timestamp = '2026-09-13T00:00:00.000Z';
  const storeOccurrence = async (id: string, scheduleId: string, scheduledForUtc: string) => {
    await h.repositories.config.set(`session_automation/occurrence/${id}`, JSON.stringify(sessionScheduleOccurrenceSchema.parse({
      schemaVersion: 1, id, revision: 1, scheduleId, sessionId: h.session.id, generation: 1, scheduledForUtc,
      conditionStatus: 'skipped', runStatus: 'skipped', delivery: { status: 'not_requested', attempts: 0, updatedAt: timestamp }, createdAt: timestamp, updatedAt: timestamp
    })));
  };
  for (let i = 0; i < 1001; i++) await storeOccurrence(`other_occ_${i}`, 'other-schedule', timestamp);
  expect((await h.service.listBySession(h.session.id)).occurrences.some(item => item.id === original.id)).toBe(false);
  const retained = await h.service.getScheduleHistory(h.session.id, created.id, 'ou_owner');
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({ id: original.id, runStatus: 'completed', result: { output: { text: 'target result' } } });
  for (let i = 0; i < 1001; i++) await storeOccurrence(`own_occ_${i}`, created.id, new Date(Date.parse(timestamp) + i * 60_000).toISOString());
  const history = await h.service.getScheduleHistory(h.session.id, created.id, 'ou_owner');
  expect(history).toHaveLength(1000);
  expect(history[0]!.id).toBe('own_occ_1000');
  expect(history.at(-1)!.id).toBe('own_occ_1');
  bound(h.repositories).createSession({ ...h.session, id: 'ses_other' });
  await expect(h.service.getScheduleHistory('ses_other', created.id, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_SCHEDULE_NOT_FOUND' });
  h.allowed.value = false;
  await expect(h.service.getScheduleHistory(h.session.id, created.id, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_FORBIDDEN' });
});


describe('schedule calendar validation and legacy reads', () => {
  it('keeps invalid historical dates visible but disabled, isolates ticks, and allows repair', async () => {
    const h = await fixture({ clock: new Date('2026-10-16T09:00:00Z') });
    const good = await h.service.createSchedule(h.session.id, { ...scheduleInput, timezone: 'UTC', trigger: { kind: 'cron', expression: '0 9 */1 * 1-5' } }, 'ou_owner');
    const enabled = await h.service.updateSchedule(h.session.id, good.id, { expectedRevision: good.revision, enabled: true }, 'ou_owner');
    expect(enabled.nextDueAt).toBe('2026-10-19T09:00:00.000Z');
    const bad = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const key = `session_automation/schedule/${bad.id}`;
    const raw = JSON.parse((await h.repositories.config.get(key))!);
    raw.trigger = { kind: 'at', localDateTime: '2026-02-30T09:00' };
    raw.enabled = true;
    raw.nextDueAt = '2026-03-02T09:01:00.000Z';
    raw.dstPolicy.gap = 'shift_forward';
    await h.repositories.config.set(key, JSON.stringify(raw));
    const listed = await h.service.listBySession(h.session.id, 'ou_owner');
    expect(listed.schedules).toHaveLength(2);
    expect(listed.schedules.find(item => item.id === bad.id)).toMatchObject({ enabled: false, trigger: raw.trigger });
    expect((await h.service.getScheduleDefinition(h.session.id, bad.id, 'ou_owner')).nextDueAt).toBeUndefined();
    await h.service.tick();
    expect(h.dispatches).toHaveLength(0);
    await expect(h.service.runSchedule(h.session.id, bad.id, { expectedRevision: bad.revision, idempotencyKey: 'invalid-manual' }, 'ou_owner')).rejects.toThrow();
    await expect(h.service.updateSchedule(h.session.id, bad.id, { expectedRevision: bad.revision, enabled: true }, 'ou_owner')).rejects.toThrow();
    const repaired = await h.service.updateSchedule(h.session.id, bad.id, { expectedRevision: bad.revision, trigger: { kind: 'at', localDateTime: '2026-10-20T09:00' } }, 'ou_owner');
    expect(repaired).toMatchObject({ enabled: false, revision: 2 });
    expect((await h.service.updateSchedule(h.session.id, bad.id, { expectedRevision: 2, enabled: true }, 'ou_owner')).nextDueAt).toBe('2026-10-20T01:00:00.000Z');
  });
});

describe('schedule frozen delivery projection', () => {
  it('reads only this session schedules and allowlists saved destinations without mutating them', async () => {
    const h = await fixture();
    const schedule = await h.service.createSchedule(h.session.id, scheduleInput);
    const key = `automation.delivery-target.${schedule.id}`;
    const raw = JSON.stringify({ appId: 'cli_app', chatId: 'oc_chat', replyMessageId: 'om_saved', replyInThread: true, token: 'never-public', secret: 'never-public' });
    await h.repositories.config.set(key, raw);
    await h.repositories.config.set('automation.delivery-target.unrelated', JSON.stringify({ appId: 'cli_other', chatId: 'oc_other', replyMessageId: 'om_private', replyInThread: false }));
    const response = await h.service.listBySession(h.session.id);
    expect(response.deliveryTargets).toEqual({ [schedule.id]: { kind: 'lark', appId: 'cli_app', chatId: 'oc_chat', replyMessageId: 'om_saved', replyInThread: true } });
    expect(JSON.stringify(response)).not.toContain('never-public');
    expect(JSON.stringify(response)).not.toContain('om_private');
    expect(await h.repositories.config.get(key)).toBe(raw);
    h.allowed.value = false;
    await expect(h.service.listBySession(h.session.id)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('marks missing, malformed, or mismatched destinations unavailable', async () => {
    const h = await fixture();
    const schedule = await h.service.createSchedule(h.session.id, scheduleInput);
    const key = `automation.delivery-target.${schedule.id}`;
    for (const raw of [undefined, '{bad json', JSON.stringify({ appId: 'cli_wrong', chatId: 'oc_chat', replyMessageId: 'om_saved', replyInThread: true })]) {
      if (raw) await h.repositories.config.set(key, raw);
      expect((await h.service.listBySession(h.session.id)).deliveryTargets).toEqual({ [schedule.id]: { kind: 'unavailable' } });
    }
  });

  it('projects web schedules to their actual owning task', async () => {
    const h = await fixture();
    const { sourceId: _sourceId, ...base } = h.session;
    const webSession = { ...base, id: 'web-session', source: 'web' };
    bound(h.repositories).createSession(webSession);
    const schedule = await h.service.createSchedule(webSession.id, scheduleInput);
    expect((await h.service.listBySession(webSession.id)).deliveryTargets).toEqual({ [schedule.id]: { kind: 'task', sessionId: webSession.id } });
  });
});
