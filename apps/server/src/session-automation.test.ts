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
  settleAttempt1UnknownThenAttempt2Completes(taskId: string, text?: string, retry?: boolean): void;
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
    settleAttempt1UnknownThenAttempt2Completes(taskId: string, text = 'second attempt result', retry = true) {
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
      if (!retry) return;
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

async function fixture(options: { database?: string; clock?: Date; status?: StatusMock; providerId?: string; crashAfterAcceptance?: boolean; deliver?: (sessionId: string, result: AttemptResultV1, occurrenceId: string, sourceId: string, context?: AutomationDeliveryContext) => Promise<void>; onScheduleDisabled?: (schedule: any, reason: string) => Promise<void>; onScheduleOverdue?: (schedule: any, notice: any) => Promise<void | 'not_requested'> } = {}) {
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
    onScheduleDisabled: options.onScheduleDisabled,
    onScheduleOverdue: options.onScheduleOverdue
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
  const list = vi.spyOn(h.repositories.config, 'list');
  const candidates = vi.spyOn(h.repositories.config, 'listByJsonField');
  try {
    await h.service.tick();
    expect(parse.mock.calls.filter(([raw]) => raws.has(raw))).toHaveLength(100);
    expect(schemaParse).toHaveBeenCalledTimes(100);
    expect(list.mock.calls.filter(([prefix]) => prefix === 'session_automation/occurrence/')).toHaveLength(1);
    expect(candidates.mock.calls.filter(([prefix]) => prefix === 'session_automation/occurrence/')).toHaveLength(2);
    expect(get.mock.calls.filter(([key]) => key.startsWith('session_automation/schedule/'))).toHaveLength(0);
    expect(h.dispatches).toHaveLength(0);
    expect(deliver).not.toHaveBeenCalled();
    parse.mockClear();
    await h.service.tick();
    expect(parse.mock.calls.filter(([raw]) => raws.has(raw))).toHaveLength(100);
  } finally {
    parse.mockRestore(); schemaParse.mockRestore(); get.mockRestore(); list.mockRestore(); candidates.mockRestore();
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
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, name: `${scheduleInput.name} ${index}`, trigger: { kind: 'at', localDateTime: '2026-09-12T08:01:00' } }, 'ou_owner');
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
    const second = await h.service.createSchedule(h.session.id, { ...scheduleInput, name: 'Second', trigger: { kind: 'at', localDateTime: '2026-09-12T08:02:00' } }, 'ou_owner');
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
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 2, prompt: 'Changed execution content' }, 'ou_owner');
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
    expect(state.occurrences.filter(item => item.scheduleId === enabled.id)).toHaveLength(0);
    expect(disabled?.disabledReason).toBe('Session is no longer active');
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
      'Session is no longer active', expect.any(Function)
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

  it('settles a source from an audited manual successor and preserves the original unknown attempt', async () => {
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
    expect(occurrence.runStatus).toBe('completed');
    expect(h.repositories.execution.getTaskExecution(task!.id)!.attempts[0]?.outcome).toBe('unknown');
    expect((occurrence as { blockReason?: string }).blockReason).toBeUndefined();
    // Explicit audited recovery lets the next scheduled occurrence proceed.
    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).occurrences).toHaveLength(2);
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
    const conditional = await h.service.createSchedule(h.session.id, { ...scheduleInput, name: 'Conditional', condition: { kind: 'ci_new_failure' } }, 'ou_owner');
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
    h.settleAttempt1UnknownThenAttempt2Completes(first.taskId!, undefined, false);
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
    const bad = await h.service.createSchedule(h.session.id, { ...scheduleInput, name: 'Bad calendar' }, 'ou_owner');
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

describe('schedule management and recovery contracts', () => {
  it('authorizes before counting and paginating plans, including the service actor check', async () => {
    const h = await fixture();
    for (let i = 0; i < 3; i++) await h.service.createSchedule(h.session.id, { ...scheduleInput, name: 'Plan ' + i }, 'ou_owner');
    const other = { ...h.session, id: 'private', runId: 'private-run' };
    bound(h.repositories).createSession(other);
    await h.service.createSchedule(other.id, { ...scheduleInput, name: 'Secret' }, 'ou_owner');
    const authorize = vi.fn(async (id: string) => id === h.session.id ? { actorId: 'ou_owner' } : false);
    const first = await h.service.listSchedules({ limit: 1 }, authorize);
    expect(first.total).toBe(3);
    expect(first.counts.disabled).toBe(3);
    expect(first.items).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain('Secret');
    h.allowed.value = false;
    const denied = await h.service.listSchedules({}, async () => ({ actorId: 'ou_owner' }));
    expect(denied.total).toBe(0);
    expect(denied.counts.disabled).toBe(0);
  });

  it('keeps due, generation, captured actor and queued input on a name-only edit', async () => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const enabled = await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:10.000Z');
    const renamed = await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 2, name: 'New label' }, 'ou_editor');
    expect(renamed).toMatchObject({ revision: 3, generation: enabled.generation, nextDueAt: enabled.nextDueAt });
    await h.service.tick();
    const task = h.dispatches[0]!;
    const before = h.repositories.execution.getAcceptedTask(task.id)!.request;
    const current = await h.service.getScheduleDefinition(h.session.id, created.id, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: current.revision, name: 'Queued label' }, 'ou_editor');
    await expect(h.service.authorizeTask(task)).resolves.toBeUndefined();
    expect(h.repositories.execution.getAcceptedTask(task.id)!.request).toEqual(before);
    expect(before?.actor).toEqual({ kind: 'channel', id: 'ou_owner', appId: 'cli_app' });
    await expect(h.service.updateSchedule(h.session.id, created.id, { expectedRevision: current.revision, name: 'stale' }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_REVISION_CONFLICT' });
  });

  it('isolates corrupt pending records while preserving their reservation and serving healthy plans', async () => {
    const h = await fixture();
    const broken = await h.service.createSchedule(h.session.id, { ...scheduleInput, name: 'Broken' }, 'ou_owner');
    const healthy = await h.service.createSchedule(h.session.id, { ...scheduleInput, name: 'Healthy' }, 'ou_owner');
    for (const schedule of [broken, healthy]) await h.service.updateSchedule(h.session.id, schedule.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    const key = 'session_automation/schedule/' + broken.id;
    const saved = JSON.parse((await h.repositories.config.get(key))!);
    await h.repositories.config.set(key, JSON.stringify({ ...saved, pendingOccurrence: { id: 'corrupt', generation: saved.generation, scheduledForUtc: saved.nextDueAt } }));
    await h.repositories.config.set('session_automation/occurrence/corrupt', '{bad json');
    await h.repositories.config.set('session_automation/ci/corrupt', '{bad json');
    await h.repositories.config.set('session_automation/schedule/corrupt', '{bad json');
    h.now.value = new Date('2026-09-12T00:05:00.000Z');
    await h.service.tick(); await h.service.tick();
    expect(h.dispatches).toHaveLength(1);
    expect((await h.service.getScheduleHistory(h.session.id, healthy.id)).length).toBe(1);
    expect((await h.service.getScheduleHistory(h.session.id, broken.id)).length).toBe(0);
    expect(JSON.parse((await h.repositories.config.get(key))!).pendingOccurrence.id).toBe('corrupt');
    expect((await h.service.listSchedules({}, async () => true)).total).toBe(2);
  });

  it.each([
    { policy: 'skip' as const, at: '00:02:00.000', count: 1, status: 'accepted' },
    { policy: 'skip' as const, at: '00:02:00.001', count: 0, status: 'skipped' },
    { policy: 'coalesce' as const, at: '00:10:00.000', count: 1, status: 'accepted' },
    { policy: 'coalesce' as const, at: '00:01:30.000', max: 30, count: 1, status: 'accepted' },
    { policy: 'coalesce' as const, at: '00:01:30.001', max: 30, count: 0, status: 'skipped' }
  ])('makes one bounded misfire decision at $at for $policy', async test => {
    const h = await fixture();
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, misfirePolicy: test.policy, ...(test.max ? { maxLatenessSeconds: test.max } : {}) }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T' + test.at + 'Z');
    await h.service.tick();
    expect(h.dispatches).toHaveLength(test.count);
    const history = await h.service.getScheduleHistory(h.session.id, created.id);
    expect(history).toHaveLength(1); expect(history[0]?.runStatus).toBe(test.status);
    if (test.status === 'skipped') expect(history[0]).toMatchObject({ misfire: { from: '2026-09-12T00:01:00.000Z', to: h.now.value.toISOString() } });
  });

  it('paginates one plan with stable equal-time ordering and scopes run details', async () => {
    const h = await fixture();
    const first = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const second = await h.service.createSchedule(h.session.id, { ...scheduleInput, name: 'Second' }, 'ou_owner');
    const at = h.now.value.toISOString();
    for (const schedule of [first, second]) for (let i = 0; i < 25; i++) {
      const id = schedule.id + '-' + String(i).padStart(2, '0');
      await h.repositories.config.set('session_automation/occurrence/' + id, JSON.stringify({
        schemaVersion: 2, id, revision: 1, scheduleId: schedule.id, sessionId: h.session.id, generation: 1,
        scheduledForUtc: at, createdAt: at, updatedAt: at, conditionStatus: 'skipped', runStatus: 'skipped',
        delivery: { status: 'not_requested', attempts: 0, updatedAt: at }
      }));
    }
    const page1 = await h.service.getScheduleHistoryPage(h.session.id, first.id, 0, 20);
    const page2 = await h.service.getScheduleHistoryPage(h.session.id, first.id, 20, 20);
    expect(page1.total).toBe(25); expect(page2.occurrences).toHaveLength(5);
    expect(new Set([...page1.occurrences, ...page2.occurrences].map(item => item.id)).size).toBe(25);
    expect(page1.occurrences[0]?.id).toBe(first.id + '-24');
    const detail = await h.service.getScheduleRun(h.session.id, first.id, page2.occurrences[0]!.id);
    expect(detail.occurrence.id).toBe(first.id + '-04');
    await expect(h.service.getScheduleRun(h.session.id, second.id, detail.occurrence.id)).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_RUN_NOT_FOUND' });
  });

  it.each(['before', 'after', 'receipt', 'local'] as const)('persists disable notification outcome %s without unsafe resend', async failure => {
    const h = await fixture();
    let sends = 0, confirmed = false;
    const notice = vi.fn(async (_schedule, _reason, beforeSend) => {
      if (failure === 'local') return 'not_requested' as const;
      if (failure === 'before' && sends++ === 0) throw new Error('before provider');
      await beforeSend!();
      sends++;
      if (failure === 'after' || failure === 'receipt') { confirmed = failure === 'receipt'; throw new Error('response lost'); }
    });
    const service = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true,
      clock: () => h.now.value, onScheduleDisabled: notice, reconcileDisabledNotification: async () => confirmed });
    cleanups.push(() => service.close());
    const created = await service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    bound(h.repositories).patchSession({ sessionId: h.session.id, runId: h.session.runId }, { state: 'stopped' });
    await service.tick();
    expect((await service.getScheduleHistory(h.session.id, created.id))).toHaveLength(0);
    expect((await service.getScheduleDefinition(h.session.id, created.id)).disableNotification?.status).toBe(failure === 'before' ? 'error' : failure === 'local' ? 'not_requested' : 'unknown');
    h.now.value = new Date(h.now.value.getTime() + 61_000);
    await service.tick(); await service.tick();
    expect(notice).toHaveBeenCalledTimes(failure === 'before' ? 2 : 1);
    expect((await service.getScheduleDefinition(h.session.id, created.id)).disableNotification?.status).toBe(failure === 'after' ? 'unknown' : failure === 'local' ? 'not_requested' : 'delivered');
  });
});

it('uses completion and lifecycle events through the same single-flight tick and unsubscribes on close', async () => {
  const h = await fixture();
  const listeners = new Map<string, (event: any) => void>();
  const unsub = vi.fn();
  const deliver = vi.fn(async () => {});
  const runtime = { ...h, subscribe: (id: string, listener: (event: any) => void) => { listeners.set(id, listener); return () => { listeners.delete(id); unsub(); }; } };
  const service = new SessionAutomationService({ repositories: h.repositories, runtime, authorize: async () => true, clock: () => h.now.value, deliver });
  cleanups.push(() => service.close());
  const created = await service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
  await service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
  h.now.value = new Date('2026-09-12T00:01:01.000Z');
  await service.tick();
  h.settleTask(h.dispatches[0]!.id, 'completed', 'event-driven result');
  const attempt = h.repositories.execution.getTaskExecution(h.dispatches[0]!.id)!.currentAttempt!;
  const event = h.repositories.execution.getAttemptEvents(attempt.attemptId).find(item => item.type === 'completed')!;
  listeners.get(h.session.id)!(event); listeners.get(h.session.id)!(event);
  await service.tick();
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
  bound(h.repositories).patchSession({ sessionId: h.session.id, runId: h.session.runId }, { state: 'stopped' });
  listeners.get(h.session.id)!({ type: 'status', data: { state: 'stopped' } });
  await service.tick();
  expect((await service.getScheduleDefinition(h.session.id, created.id)).enabled).toBe(false);
  await service.close();
  expect(listeners.size).toBe(0); expect(unsub).toHaveBeenCalledOnce();
  await service.tick(); expect(h.dispatches).toHaveLength(1);
});

it('keeps independent execution identity after origin stop and workspace-intent recovery, and rechecks origin permission', async () => {
  const h = await fixture();
  const managedCwd = await gitRepository();
  let worker: BoundRuntime | undefined;
  const runtime: SessionAutomationRuntime = {
    getSession: id => h.repositories.sessions.get(id),
    startScheduleSession: vi.fn(async (input, id, beforeStart) => {
      await beforeStart();
      const existing = await h.repositories.sessions.get(id);
      if (existing) return existing;
      const session: Session = { ...h.session, id, runId: 'independent-run', source: 'schedule', sourceId: input.sourceId, cwd: managedCwd, workspaceSourceCwd: input.cwd, workspaceMode: 'worktree' };
      bound(h.repositories).createSession(session);
      worker = ledgerRuntime(h.repositories, session);
      return session;
    }),
    dispatchRequest: request => worker!.dispatchRequest(request)
  };
  const service = new SessionAutomationService({ repositories: h.repositories, runtime, authorize: async (id, actor) => h.allowed.value && id === h.session.id && ['ou_owner', 'installation_owner'].includes(actor ?? ''), clock: () => h.now.value });
  cleanups.push(() => service.close());
  const created = await service.createSchedule(h.session.id, { ...scheduleInput, mode: 'independent' }, 'ou_owner');
  expect(created.executionContext?.cwd).toBe(managedCwd);
  const id = created.executionSessionId!;
  // Simulate process loss after runtime session creation but before storing its prepared cwd.
  const key = 'session_automation/schedule/' + created.id;
  const saved = JSON.parse((await h.repositories.config.get(key))!);
  await h.repositories.config.set(key, JSON.stringify({ ...saved, executionContext: { ...saved.executionContext, cwd: h.cwd } }));
  bound(h.repositories).patchSession({ sessionId: h.session.id, runId: h.session.runId }, { state: 'stopped', archivedAt: h.now.value.toISOString() });
  await service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'installation_owner');
  h.now.value = new Date('2026-09-12T00:01:01.000Z');
  await service.tick();
  expect(worker!.dispatches).toHaveLength(1);
  const task = worker!.dispatches[0]!;
  expect(task.sessionId).toBe(id);
  expect(h.repositories.execution.getAcceptedTask(task.id)?.request).toMatchObject({ actor: { kind: 'channel', id: 'ou_owner', appId: 'cli_app' }, prompt: scheduleInput.prompt, sources: [] });
  expect((await service.getScheduleDefinition(h.session.id, created.id, 'ou_owner')).executionContext?.cwd).toBe(managedCwd);
  await expect(service.authorizeExecutionSession(id, 'ou_owner')).resolves.toBe(true);
  await expect(service.authorizeExecutionSession(id, 'installation_owner')).rejects.toMatchObject({ code: 'INDEPENDENT_SCHEDULE_REVOKED' });
  h.allowed.value = false;
  await expect(service.authorizeTask(task)).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_TASK_REVOKED' });
  expect(worker!.dispatches).toHaveLength(1);
});

it('rejects independent creation outside Git before creating an execution session', async () => {
  const h = await fixture();
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-non-git-'));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const startScheduleSession = vi.fn();
  const service = new SessionAutomationService({ repositories: h.repositories, runtime: { ...h, getSession: async () => ({ ...h.session, cwd }), startScheduleSession }, authorize: async () => true });
  cleanups.push(() => service.close());
  await expect(service.createSchedule(h.session.id, { ...scheduleInput, mode: 'independent' }, 'ou_owner')).rejects.toMatchObject({ code: 'INDEPENDENT_WORKSPACE_UNSUPPORTED' });
  expect(startScheduleSession).not.toHaveBeenCalled();
});

it('drains an event queued between tick loop exit and promise cleanup', async () => {
  const h = await fixture();
  const runTick = vi.spyOn(h.service as any, 'runTick').mockResolvedValue(undefined);
  const first = h.service.tick();
  queueMicrotask(() => { void h.service.tick(); });
  await first;
  await Promise.resolve();
  expect(runTick).toHaveBeenCalledTimes(2);
  expect((h.service as any).tickRequested).toBe(false);
  expect((h.service as any).currentTick).toBeUndefined();
});

it('name-only edit at submit CAS preserves the pending occurrence and new display name', async () => {
  const h = await fixture();
  const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
  await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
  h.now.value = new Date('2026-09-12T00:01:01.000Z');
  await h.service.tick();
  const task = h.dispatches[0]!;
  const key = 'session_automation/schedule/' + created.id;
  const original = h.repositories.config.compareAndSet!.bind(h.repositories.config);
  let raced = false;
  const compare = vi.spyOn(h.repositories.config, 'compareAndSet').mockImplementation(async (target, expected, value) => {
    if (target === key && JSON.parse(value).taskStartOccurrenceId && !raced) {
      raced = true;
      const current = await h.service.getScheduleDefinition(h.session.id, created.id, 'ou_owner');
      await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: current.revision, name: 'Renamed just before submit' }, 'ou_editor');
    }
    return original(target, expected, value);
  });
  try {
    await expect(h.service.authorizeTask(task, 'submit')).resolves.toBeUndefined();
    expect(raced).toBe(true);
    expect(await h.service.getScheduleDefinition(h.session.id, created.id, 'ou_owner')).toMatchObject({ name: 'Renamed just before submit', generation: 2, revision: 3 });
    expect(JSON.parse((await h.repositories.config.get(key))!).actorId).toBe('ou_owner');
    const occurrence = (await h.service.getScheduleHistory(h.session.id, created.id))[0]!;
    expect((await h.service.getScheduleRun(h.session.id, created.id, occurrence.id)).times.startedAt).toBe(h.now.value.toISOString());
    expect((await h.service.getScheduleHistory(h.session.id, created.id))[0]!.runStatus).toBe('accepted');
  } finally { compare.mockRestore(); }
});

it.each(['prompt', 'disable', 'stop', 'identity'] as const)('rejects %s changes racing with the submission marker', async change => {
  const h = await fixture();
  const created = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
  await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
  h.now.value = new Date('2026-09-12T00:01:01.000Z');
  await h.service.tick();
  const task = h.dispatches[0]!;
  const key = 'session_automation/schedule/' + created.id;
  const original = h.repositories.config.compareAndSet!.bind(h.repositories.config);
  let raced = false;
  const compare = vi.spyOn(h.repositories.config, 'compareAndSet').mockImplementation(async (target, expected, value) => {
    if (target === key && JSON.parse(value).taskStartOccurrenceId && !raced) {
      raced = true;
      const current = await h.service.getScheduleDefinition(h.session.id, created.id, 'ou_owner');
      if (change === 'identity') {
        const stored = JSON.parse((await h.repositories.config.get(key))!);
        await h.repositories.config.set(key, JSON.stringify({ ...stored, actorId: 'ou_other' }));
      } else {
        await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: current.revision,
          ...(change === 'prompt' ? { prompt: 'Changed execution' } : change === 'disable' ? { enabled: false } : { name: 'Renamed while stopping' }) }, 'ou_owner');
        if (change === 'stop') bound(h.repositories).patchSession({ sessionId: h.session.id, runId: h.session.runId }, { state: 'stopped' });
      }
    }
    return original(target, expected, value);
  });
  try {
    await expect(h.service.authorizeTask(task, 'submit')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_TASK_REVOKED' });
    expect(raced).toBe(true);
    expect((await h.service.getScheduleHistory(h.session.id, created.id))[0]).toMatchObject({ runStatus: 'invalidated', conditionStatus: 'invalidated' });
    const occurrence = (await h.service.getScheduleHistory(h.session.id, created.id))[0]!;
    expect((await h.service.getScheduleRun(h.session.id, created.id, occurrence.id)).times.startedAt).toBeUndefined();
    expect(JSON.parse((await h.repositories.config.get(key))!).taskStartOccurrenceId).toBeUndefined();
  } finally { compare.mockRestore(); }
});

it('expired skip decision survives a lost occurrence creation response', async () => {
  const h = await fixture();
  const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, misfirePolicy: 'skip' }, 'ou_owner');
  await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
  h.now.value = new Date('2026-09-12T00:05:00.000Z');
  const original = h.repositories.config.compareAndSet!.bind(h.repositories.config);
  let lost = false;
  const compare = vi.spyOn(h.repositories.config, 'compareAndSet').mockImplementation(async (target, expected, value) => {
    const result = await original(target, expected, value);
    if (target.startsWith('session_automation/occurrence/') && expected === undefined && result && !lost) { lost = true; throw new Error('crash after occurrence commit'); }
    return result;
  });
  await h.service.tick(); compare.mockRestore();
  expect(lost).toBe(true); expect(h.dispatches).toHaveLength(0);
  h.now.value = new Date('2026-09-12T00:06:01.000Z');
  await h.service.tick();
  expect(h.dispatches).toHaveLength(0);
  expect((await h.service.getScheduleHistory(h.session.id, created.id))[0]!.runStatus).toBe('skipped');
});

it.each([
  { policy: 'skip' as const, max: undefined, boundary: 'reservation', within: false },
  { policy: 'skip' as const, max: undefined, boundary: 'occurrence', within: false },
  { policy: 'coalesce' as const, max: 30, boundary: 'reservation', within: false },
  { policy: 'coalesce' as const, max: 30, boundary: 'occurrence', within: false },
  { policy: 'skip' as const, max: undefined, boundary: 'occurrence', within: true },
  { policy: 'coalesce' as const, max: 90, boundary: 'occurrence', within: true }
])('recovers frozen $policy/$max decision after $boundary commit (within window=$within)', async test => {
  const h = await fixture();
  const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, misfirePolicy: test.policy,
    ...(test.max ? { maxLatenessSeconds: test.max } : {}) }, 'ou_owner');
  await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
  h.now.value = new Date(test.within ? '2026-09-12T00:01:01.000Z' : '2026-09-12T00:05:00.000Z');
  const original = h.repositories.config.compareAndSet!.bind(h.repositories.config);
  let lost = false;
  const compare = vi.spyOn(h.repositories.config, 'compareAndSet').mockImplementation(async (target, expected, value) => {
    const result = await original(target, expected, value);
    const boundary = test.boundary === 'reservation'
      ? target === 'session_automation/schedule/' + created.id && Boolean(JSON.parse(value).pendingOccurrence)
      : target.startsWith('session_automation/occurrence/') && expected === undefined;
    if (result && boundary && !lost) { lost = true; throw new Error('lost response after durable commit'); }
    return result;
  });
  await h.service.tick(); compare.mockRestore();
  expect(lost).toBe(true); expect(h.dispatches).toHaveLength(0);
  const saved = JSON.parse((await h.repositories.config.get('session_automation/schedule/' + created.id))!);
  expect(saved.pendingOccurrence.misfireDecision.action).toBe(test.within ? 'run' : 'skip');
  const beforeRecovery = await h.service.getScheduleHistory(h.session.id, created.id);
  if (!test.within && test.boundary === 'occurrence') {
    expect(beforeRecovery[0]).toMatchObject({ runStatus: 'skipped', conditionStatus: 'skipped', delivery: { status: 'not_requested' },
      misfire: { reason: test.max ? 'lateness_window_expired' : 'missed_time_skipped', from: '2026-09-12T00:01:00.000Z' } });
  }
  h.now.value = new Date(test.within ? '2026-09-12T00:01:32.000Z' : '2026-09-12T00:06:01.000Z');
  await h.service.tick(); await h.service.tick();
  expect(h.dispatches).toHaveLength(test.within ? 1 : 0);
  expect((await h.service.getScheduleHistory(h.session.id, created.id))[0]!.runStatus).toBe(test.within ? 'accepted' : 'skipped');
  if (test.within) {
    const occurrence = (await h.service.getScheduleHistory(h.session.id, created.id))[0]!;
    h.settleAttempt1UnknownThenAttempt2Completes(occurrence.taskId!, undefined, false);
    await h.service.tick();
    h.now.value = new Date('2026-09-16T00:00:00.000Z');
    await h.service.tick();
    expect(h.dispatches).toHaveLength(1);
    expect((await h.service.getScheduleHistory(h.session.id, created.id))).toEqual([expect.objectContaining({ runStatus: 'blocked', blockReason: 'reconcile_required' })]);
  }
});

it('keeps explicit manual execution independent of automatic misfire expiry', async () => {
  const h = await fixture();
  const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, misfirePolicy: 'skip', maxLatenessSeconds: 1 }, 'ou_owner');
  h.now.value = new Date('2026-09-16T00:00:00.000Z');
  const occurrence = await h.service.runSchedule(h.session.id, created.id, { expectedRevision: 1, idempotencyKey: 'manual-after-expiry' }, 'ou_owner');
  expect(occurrence.runStatus).toBe('accepted');
  expect(h.dispatches).toHaveLength(1);
  expect(occurrence.misfire).toBeUndefined();
});

describe('fresh-session schedules', () => {
  /** 模拟 Runtime 的稳定 schedule 会话入口：同一编号只建一次，每个会话独立账本 worker。 */
  function freshRuntime(h: Awaited<ReturnType<typeof fixture>>) {
    const workers = new Map<string, BoundRuntime>();
    const created: string[] = [];
    const runtime = {
      getSession: (id: string) => h.repositories.sessions.get(id),
      startScheduleSession: vi.fn(async (input: Parameters<NonNullable<SessionAutomationRuntime['startScheduleSession']>>[0], id: string, beforeStart: () => Promise<void>) => {
        await beforeStart();
        const existing = await h.repositories.sessions.get(id);
        if (existing) return existing;
        const session: Session = { ...h.session, id, runId: `run_${created.length}`, source: 'schedule', sourceId: input.sourceId, cwd: input.cwd!, workspaceMode: input.workspaceMode,
          agentId: input.agentId, permissionMode: input.permissionMode };
        bound(h.repositories).createSession(session);
        workers.set(id, ledgerRuntime(h.repositories, session));
        created.push(id);
        return session;
      }),
      archive: vi.fn(async (id: string) => {
        const session = (await h.repositories.sessions.get(id))!;
        bound(h.repositories).patchSession({ sessionId: id, runId: session.runId }, { archivedAt: h.now.value.toISOString() });
      }),
      dispatchRequest: (request: TaskRequestV1) => workers.get(request.sessionId)!.dispatchRequest(request)
    } satisfies SessionAutomationRuntime;
    const settle = (taskId: string, text?: string) => {
      const sessionId = h.repositories.execution.getTaskExecution(taskId)!.task.sessionId;
      workers.get(sessionId)!.settleTask(taskId, 'completed', text);
    };
    return { runtime, created, workers, settle, dispatches: () => [...workers.values()].flatMap(worker => worker.dispatches) };
  }
  const occurrences = async (h: Awaited<ReturnType<typeof fixture>>, scheduleId: string) =>
    (await h.repositories.config.list('session_automation/occurrence/')).map(row => JSON.parse(row.value)).filter(item => item.scheduleId === scheduleId)
      .sort((a, b) => a.scheduledForUtc.localeCompare(b.scheduledForUtc));

  it('runs every occurrence in its own new session with the origin configuration, delivers to the origin, and archives the previous session', async () => {
    const h = await fixture();
    const fresh = freshRuntime(h);
    const deliver = vi.fn(async () => {});
    const service = new SessionAutomationService({ repositories: h.repositories, runtime: fresh.runtime, authorize: async () => true, clock: () => h.now.value, deliver });
    cleanups.push(() => service.close());
    const created = await service.createSchedule(h.session.id, { ...scheduleInput, mode: 'fresh' }, 'ou_owner');
    expect(created).toMatchObject({ mode: 'fresh', executionContext: { cwd: h.cwd, agentId: 'codex', permissionMode: 'ask', contextMode: 'prompt_only' } });
    expect(created.executionSessionId).toBeUndefined();
    expect(fresh.runtime.startScheduleSession).not.toHaveBeenCalled();
    await service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');

    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await service.tick();
    expect(fresh.created).toHaveLength(1);
    const [first] = fresh.created;
    expect(first).toMatch(/^ses_schedule_[a-f0-9]{64}$/);
    expect(fresh.runtime.startScheduleSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: 'codex', cwd: h.cwd, permissionMode: 'ask', source: 'schedule', sourceId: created.id, workspaceMode: 'shared' }), first, expect.any(Function));
    const task = fresh.dispatches()[0]!;
    expect(task.sessionId).toBe(first);
    expect(h.repositories.execution.getAcceptedTask(task.id)?.request).toMatchObject({ sessionId: first, prompt: scheduleInput.prompt, actor: { kind: 'channel', id: 'ou_owner', appId: 'cli_app' } });
    expect(h.dispatches).toHaveLength(0);
    const [occurrence] = await occurrences(h, created.id);
    expect(occurrence).toMatchObject({ sessionId: h.session.id, executionSessionId: first });
    await expect(service.authorizeExecutionSession(first!, 'ou_owner')).resolves.toBe(true);
    await expect(service.sourceSessionId(first!)).resolves.toBe(h.session.id);

    fresh.settle(task.id, 'fresh result');
    await service.tick();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    expect(deliver).toHaveBeenCalledWith(h.session.id, expect.objectContaining({ taskId: task.id, output: expect.objectContaining({ text: 'fresh result' }) }), occurrence.id, created.id, expect.anything());

    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    await service.tick();
    expect(fresh.created).toHaveLength(2);
    const second = fresh.created[1]!;
    expect(second).not.toBe(first);
    expect(fresh.dispatches()[1]!.sessionId).toBe(second);
    expect(fresh.runtime.archive).toHaveBeenCalledWith(first);
    expect((await h.repositories.sessions.get(first!))?.archivedAt).toBeTruthy();
    expect((await h.repositories.sessions.get(second))?.archivedAt).toBeFalsy();
    await expect(service.authorizeExecutionSession(first!, 'ou_owner')).rejects.toMatchObject({ code: 'INDEPENDENT_SCHEDULE_REVOKED' });
    await expect(service.authorizeExecutionSession(second, 'ou_owner')).resolves.toBe(true);
    expect((await occurrences(h, created.id)).map(item => item.executionSessionId)).toEqual([first, second]);
  });

  it('reuses the same derived session when an occurrence is retried after a crash before acceptance', async () => {
    const h = await fixture();
    const fresh = freshRuntime(h);
    let crashed = false;
    let service!: SessionAutomationService;
    const crashing = { ...fresh.runtime, dispatchRequest: async (request: TaskRequestV1) => {
      if (!crashed) { crashed = true; (service as unknown as { closed: boolean }).closed = true; throw new Error('process exited before acceptance'); }
      return fresh.runtime.dispatchRequest(request);
    } };
    service = new SessionAutomationService({ repositories: h.repositories, runtime: crashing, authorize: async () => true, clock: () => h.now.value });
    cleanups.push(() => service.close());
    const created = await service.createSchedule(h.session.id, { ...scheduleInput, mode: 'fresh' }, 'ou_owner');
    await service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await service.tick();
    expect(fresh.created).toHaveLength(1);
    expect(fresh.dispatches()).toHaveLength(0);
    const [pending] = await occurrences(h, created.id);
    expect(pending).toMatchObject({ runStatus: 'pending', executionSessionId: fresh.created[0] });

    // 重启后的新实例在租约过期后接手同一次触发：不再开第二个会话，任务落在同一会话。
    const reopened = new SessionAutomationService({ repositories: h.repositories, runtime: crashing, authorize: async () => true, clock: () => h.now.value });
    cleanups.push(() => reopened.close());
    h.now.value = new Date('2026-09-12T00:01:40.000Z');
    await reopened.tick();
    expect(fresh.created).toHaveLength(1);
    expect(fresh.runtime.startScheduleSession).toHaveBeenCalledTimes(2);
    expect(fresh.runtime.startScheduleSession.mock.calls.map(call => call[1])).toEqual([fresh.created[0], fresh.created[0]]);
    expect(fresh.dispatches()).toHaveLength(1);
    expect(fresh.dispatches()[0]!.sessionId).toBe(fresh.created[0]);
    const after = await occurrences(h, created.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: pending.id, runStatus: 'accepted', executionSessionId: fresh.created[0] });
    expect(fresh.runtime.archive).not.toHaveBeenCalled();
  });

  it('keeps a previous fresh session with unfinished user work and archives it on a later occurrence', async () => {
    const h = await fixture();
    const fresh = freshRuntime(h);
    const service = new SessionAutomationService({ repositories: h.repositories, runtime: fresh.runtime, authorize: async () => true, clock: () => h.now.value });
    cleanups.push(() => service.close());
    const created = await service.createSchedule(h.session.id, { ...scheduleInput, mode: 'fresh' }, 'ou_owner');
    await service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await service.tick();
    const [first] = fresh.created;
    const firstTask = fresh.dispatches()[0]!;
    fresh.settle(firstTask.id);
    // 用户在上一次的会话里追加了一轮对话，还在排队。
    const scheduled = h.repositories.execution.getAcceptedTask(firstTask.id)!.request;
    const userTask = await fresh.workers.get(first!)!.dispatchRequest({ ...scheduled, namespace: 'runtime', key: 'user-follow-up', prompt: 'Explain the result', sources: [], sourcePayload: {} });
    expect(userTask.status).toBe('queued');
    await service.tick();

    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    await service.tick();
    expect(fresh.created).toHaveLength(2);
    expect(fresh.runtime.archive).not.toHaveBeenCalled();
    expect((await h.repositories.sessions.get(first!))?.archivedAt).toBeFalsy();
    // 保留下来的旧会话仍按计划身份执行排队的工作，风险策略也仍取自来源任务。
    await expect(service.authorizeExecutionSession(first!, 'ou_owner')).resolves.toBe(true);
    await expect(service.sourceSessionId(first!)).resolves.toBe(h.session.id);

    fresh.settle(userTask.id);
    fresh.settle(fresh.workers.get(fresh.created[1]!)!.dispatches[0]!.id);
    await service.tick();
    h.now.value = new Date('2026-09-12T00:03:01.000Z');
    await service.tick();
    expect(fresh.created).toHaveLength(3);
    expect(fresh.runtime.archive.mock.calls.map(call => call[0]).sort()).toEqual([first, fresh.created[1]].sort());
    expect((await h.repositories.sessions.get(first!))?.archivedAt).toBeTruthy();
    expect((await h.repositories.sessions.get(fresh.created[2]!))?.archivedAt).toBeFalsy();
    await expect(service.authorizeExecutionSession(first!, 'ou_owner')).rejects.toMatchObject({ code: 'INDEPENDENT_SCHEDULE_REVOKED' });
    await expect(service.sourceSessionId(first!)).resolves.toBeUndefined();
  });

  it('limits a retained fresh session to its recorded occurrence, the schedule actor and current owner access', async () => {
    const h = await fixture();
    const fresh = freshRuntime(h);
    const service = new SessionAutomationService({ repositories: h.repositories, runtime: fresh.runtime, authorize: async () => h.allowed.value, clock: () => h.now.value });
    cleanups.push(() => service.close());
    const created = await service.createSchedule(h.session.id, { ...scheduleInput, mode: 'fresh' }, 'ou_owner');
    await service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await service.tick();
    const [first] = fresh.created;
    const firstTask = fresh.dispatches()[0]!;
    fresh.settle(firstTask.id);
    const scheduled = h.repositories.execution.getAcceptedTask(firstTask.id)!.request;
    await fresh.workers.get(first!)!.dispatchRequest({ ...scheduled, namespace: 'runtime', key: 'user-follow-up', prompt: 'Explain the result', sources: [], sourcePayload: {} });
    await service.tick();
    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    await service.tick();
    expect(fresh.created).toHaveLength(2);
    const second = fresh.created[1]!;

    // 带同一计划标记、但没有触发记录证明由该计划建出的会话，不能借用计划授权。
    const forged = `ses_schedule_${'f'.repeat(64)}`;
    bound(h.repositories).createSession({ ...h.session, id: forged, runId: 'run_forged', source: 'schedule', sourceId: created.id, workspaceMode: 'shared' });
    await expect(service.authorizeExecutionSession(forged, 'ou_owner')).rejects.toMatchObject({ code: 'INDEPENDENT_SCHEDULE_REVOKED' });
    await expect(service.sourceSessionId(forged)).resolves.toBeUndefined();
    // 计划身份以外的执行者仍被拒绝。
    await expect(service.authorizeExecutionSession(first!, 'installation_owner')).rejects.toMatchObject({ code: 'INDEPENDENT_SCHEDULE_REVOKED' });
    // 发起人失去来源任务权限时，新旧会话都不能执行；恢复后旧会话随之恢复。
    h.allowed.value = false;
    await expect(service.authorizeExecutionSession(first!, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_FORBIDDEN' });
    await expect(service.authorizeExecutionSession(second, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_FORBIDDEN' });
    h.allowed.value = true;
    await expect(service.authorizeExecutionSession(first!, 'ou_owner')).resolves.toBe(true);
    // 删除计划后，保留的旧会话不再有授权。
    const latest = await service.getScheduleDefinition(h.session.id, created.id, 'ou_owner');
    await service.deleteSchedule(h.session.id, created.id, { expectedRevision: latest.revision }, 'ou_owner');
    await expect(service.authorizeExecutionSession(first!, 'ou_owner')).rejects.toMatchObject({ code: 'INDEPENDENT_SCHEDULE_REVOKED' });
    await expect(service.sourceSessionId(first!)).resolves.toBeUndefined();
  });

  it('archives the previous fresh session when a reservation is recovered after a restart', async () => {
    const h = await fixture();
    const fresh = freshRuntime(h);
    // 模拟进程在“预留写入成功”之后、归档上一会话之前退出。
    let crashOnReservation = false;
    const config = new Proxy(h.repositories.config, { get(target, property, receiver) {
      if (property !== 'compareAndSet') return Reflect.get(target, property, receiver);
      return async (key: string, expected: string | null, next: string) => {
        const written = await target.compareAndSet!(key, expected, next);
        const reserved = JSON.parse(next).pendingOccurrence?.id;
        if (written && crashOnReservation && key.startsWith('session_automation/schedule/') && reserved && reserved !== JSON.parse(expected ?? '{}').pendingOccurrence?.id) {
          crashOnReservation = false;
          throw new Error('process exited after reservation');
        }
        return written;
      };
    } });
    const crashing = new SessionAutomationService({ repositories: { ...h.repositories, config }, runtime: fresh.runtime, authorize: async () => true, clock: () => h.now.value });
    cleanups.push(() => crashing.close());
    const created = await crashing.createSchedule(h.session.id, { ...scheduleInput, mode: 'fresh' }, 'ou_owner');
    await crashing.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await crashing.tick();
    const [first] = fresh.created;
    fresh.settle(fresh.dispatches()[0]!.id);
    await crashing.tick();

    // 手动执行：预留后崩溃，用同一幂等键重试走恢复分支。
    crashOnReservation = true;
    const latest = await crashing.getScheduleDefinition(h.session.id, created.id);
    const manual = { expectedRevision: latest.revision, idempotencyKey: 'manual-after-restart' };
    await expect(crashing.runSchedule(h.session.id, created.id, manual, 'ou_owner')).rejects.toThrow('process exited after reservation');
    expect(fresh.created).toHaveLength(1);
    const reopened = new SessionAutomationService({ repositories: h.repositories, runtime: fresh.runtime, authorize: async () => true, clock: () => h.now.value });
    cleanups.push(() => reopened.close());
    await reopened.runSchedule(h.session.id, created.id, manual, 'ou_owner');
    expect(fresh.created).toHaveLength(2);
    expect(fresh.runtime.archive).toHaveBeenCalledWith(first);
    expect((await h.repositories.sessions.get(first!))?.archivedAt).toBeTruthy();

    // 定时触发：预留后崩溃，下一次 tick 从预留恢复。
    fresh.settle(fresh.dispatches()[1]!.id);
    await reopened.tick();
    const second = fresh.created[1]!;
    crashOnReservation = true;
    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    await crashing.tick();
    expect(crashOnReservation).toBe(false);
    expect(fresh.created).toHaveLength(2);
    expect((await h.repositories.sessions.get(second))?.archivedAt).toBeFalsy();
    await reopened.tick();
    expect(fresh.created).toHaveLength(3);
    expect(fresh.runtime.archive).toHaveBeenCalledWith(second);
    expect((await h.repositories.sessions.get(second))?.archivedAt).toBeTruthy();
  });

  it('keeps the default and legacy records in the origin session', async () => {
    const h = await fixture();
    const startScheduleSession = vi.fn();
    const service = new SessionAutomationService({ repositories: h.repositories, runtime: { ...h, startScheduleSession }, authorize: async () => true, clock: () => h.now.value });
    cleanups.push(() => service.close());
    const created = await service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    expect(created.mode).toBe('session');
    expect(created.executionContext).toBeUndefined();
    // 旧版本写下的记录没有 mode 字段：照常读取，按沿用来源会话执行。
    const key = `session_automation/schedule/${created.id}`;
    const { mode: _mode, ...legacy } = JSON.parse((await h.repositories.config.get(key))!);
    await h.repositories.config.set(key, JSON.stringify(legacy));
    expect((await service.getScheduleDefinition(h.session.id, created.id)).mode).toBeUndefined();
    await service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await service.tick();
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]!.sessionId).toBe(h.session.id);
    expect(startScheduleSession).not.toHaveBeenCalled();
  });

  it('switches between session and fresh only when no occurrence is unfinished', async () => {
    const h = await fixture();
    const fresh = freshRuntime(h);
    const service = new SessionAutomationService({ repositories: h.repositories, runtime: { ...fresh.runtime, dispatchRequest: request => request.sessionId === h.session.id ? h.dispatchRequest(request) : fresh.runtime.dispatchRequest(request) },
      authorize: async () => true, clock: () => h.now.value });
    cleanups.push(() => service.close());
    const created = await service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const switched = await service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, mode: 'fresh', enabled: true }, 'ou_owner');
    expect(switched).toMatchObject({ mode: 'fresh', generation: 2, executionContext: { cwd: h.cwd, agentId: 'codex' } });
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    await service.tick();
    const freshTask = fresh.dispatches()[0]!;
    await expect(service.updateSchedule(h.session.id, created.id, { expectedRevision: switched.revision, mode: 'session' }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_SCHEDULE_BUSY' });
    fresh.settle(freshTask.id);
    await service.tick();
    const latest = await service.getScheduleDefinition(h.session.id, created.id);
    const back = await service.updateSchedule(h.session.id, created.id, { expectedRevision: latest.revision, mode: 'session' }, 'ou_owner');
    expect(back.mode).toBe('session');
    expect(back.executionSessionId).toBeUndefined();
    expect(back.executionContext).toBeUndefined();
    expect(fresh.runtime.archive).toHaveBeenCalledWith(freshTask.sessionId);
    h.now.value = new Date('2026-09-12T00:03:01.000Z');
    await service.tick();
    expect(h.dispatches.at(-1)!.sessionId).toBe(h.session.id);
  });

  it('refuses an independent schedule switching mode', async () => {
    const h = await fixture();
    const service = new SessionAutomationService({ repositories: h.repositories, runtime: { ...h, startScheduleSession: vi.fn() }, authorize: async () => true, clock: () => h.now.value });
    cleanups.push(() => service.close());
    const created = await service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    const key = `session_automation/schedule/${created.id}`;
    await h.repositories.config.set(key, JSON.stringify({ ...JSON.parse((await h.repositories.config.get(key))!), mode: 'independent' }));
    await expect(service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, mode: 'fresh' }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_MODE_IMMUTABLE' });
  });
});

describe('schedule names are unique within a session', () => {
  it('rejects creating or renaming into a live or disabled same-name schedule, but not a deleted one or another session', async () => {
    const h = await fixture();
    const first = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    expect(first.enabled).toBe(false);
    await expect(h.service.createSchedule(h.session.id, { ...scheduleInput, prompt: 'Slightly different' }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_SCHEDULE_NAME_CONFLICT', statusCode: 409, message: expect.stringContaining(first.id) });
    await h.service.updateSchedule(h.session.id, first.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    await expect(h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_SCHEDULE_NAME_CONFLICT' });
    const other = await h.service.createSchedule(h.session.id, { ...scheduleInput, name: 'Other' }, 'ou_owner');
    await expect(h.service.updateSchedule(h.session.id, other.id, { expectedRevision: 1, name: scheduleInput.name }, 'ou_owner')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_SCHEDULE_NAME_CONFLICT' });
    await expect(h.service.updateSchedule(h.session.id, other.id, { expectedRevision: 1, name: 'Other', prompt: 'Same name kept' }, 'ou_owner')).resolves.toMatchObject({ name: 'Other' });
    const current = await h.service.getScheduleDefinition(h.session.id, first.id);
    await h.service.deleteSchedule(h.session.id, first.id, { expectedRevision: current.revision }, 'ou_owner');
    await expect(h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner')).resolves.toMatchObject({ name: scheduleInput.name });
  });

  it('turns an Agent request for an existing name into an update that waits for confirmation again', async () => {
    const fixtureState = await fixture();
    const service = new SessionAutomationService({ repositories: fixtureState.repositories, runtime: { ...fixtureState, startScheduleSession: vi.fn() }, authorize: async () => true, clock: () => fixtureState.now.value });
    cleanups.push(() => service.close());
    const h = { ...fixtureState, service };
    const receipt = (key: string) => ({ key, prepareDelivery: vi.fn(async () => {}) });
    const original = await h.service.requestSchedule(h.session.id, scheduleInput, 'ou_owner', receipt('turn-1'));
    expect(original.updated).toBeUndefined();
    await h.service.updateSchedule(h.session.id, original.schedule.id, { expectedRevision: 1, enabled: true }, 'ou_owner');

    // 同一请求重试：拿回自己建的那条，不算更新。
    const retried = await h.service.requestSchedule(h.session.id, scheduleInput, 'ou_owner', receipt('turn-1'));
    expect(retried.schedule.id).toBe(original.schedule.id);
    expect(retried.updated).toBeUndefined();
    // 间隔相同、只是锚点不同：没有改动，保持启用。
    const unchanged = await h.service.requestSchedule(h.session.id, { ...scheduleInput, trigger: { ...scheduleInput.trigger, anchorAt: '2026-09-12T00:00:30.000Z' } }, 'ou_owner', receipt('turn-2'));
    expect(unchanged).toMatchObject({ schedule: { id: original.schedule.id, enabled: true, revision: 2 }, updated: { changed: false, wasEnabled: true } });

    const changedReceipt = receipt('turn-3');
    const changed = await h.service.requestSchedule(h.session.id, { ...scheduleInput, prompt: 'Rebase and deploy', trigger: { kind: 'cron', expression: '0 2 * * *' }, mode: 'fresh' }, 'ou_owner', changedReceipt);
    expect(changed).toMatchObject({ schedule: { id: original.schedule.id, enabled: false, prompt: 'Rebase and deploy', trigger: { kind: 'cron', expression: '0 2 * * *' }, mode: 'fresh' }, updated: { changed: true, wasEnabled: true } });
    expect(changedReceipt.prepareDelivery).not.toHaveBeenCalled();
    expect((await h.service.listBySession(h.session.id)).schedules).toHaveLength(1);

    // 已停用的同名计划同样更新，不新建。
    const disabled = await h.service.requestSchedule(h.session.id, { ...scheduleInput, prompt: 'Rebase only', trigger: { kind: 'cron', expression: '0 2 * * *' } }, 'ou_owner', receipt('turn-4'));
    expect(disabled).toMatchObject({ schedule: { id: original.schedule.id, enabled: false, prompt: 'Rebase only', mode: 'fresh' }, updated: { changed: true, wasEnabled: false } });
    expect((await h.service.listBySession(h.session.id)).schedules).toHaveLength(1);

    // 删除后的同名请求重新新建。
    const latest = await h.service.getScheduleDefinition(h.session.id, original.schedule.id);
    await h.service.deleteSchedule(h.session.id, original.schedule.id, { expectedRevision: latest.revision }, 'ou_owner');
    const recreated = await h.service.requestSchedule(h.session.id, scheduleInput, 'ou_owner', receipt('turn-5'));
    expect(recreated.updated).toBeUndefined();
    expect(recreated.schedule.id).not.toBe(original.schedule.id);
  });

  it('applies the requested default mode only to a new schedule and never switches an existing one', async () => {
    const fixtureState = await fixture();
    const service = new SessionAutomationService({ repositories: fixtureState.repositories, runtime: { ...fixtureState, startScheduleSession: vi.fn() }, authorize: async () => true, clock: () => fixtureState.now.value });
    cleanups.push(() => service.close());
    const receipt = (key: string, newMode?: 'fresh') => ({ key, newMode, prepareDelivery: vi.fn(async () => {}) });
    const fresh = await service.requestSchedule(fixtureState.session.id, { ...scheduleInput, name: 'New one' }, 'ou_owner', receipt('turn-1', 'fresh'));
    expect(fresh.schedule.mode).toBe('fresh');
    const asked = await service.requestSchedule(fixtureState.session.id, { ...scheduleInput, name: 'Continue chat', mode: 'session' }, 'ou_owner', receipt('turn-2', 'fresh'));
    expect(asked.schedule.mode).toBe('session');
    const plain = await service.requestSchedule(fixtureState.session.id, { ...scheduleInput, name: 'Plain' }, 'ou_owner', receipt('turn-3'));
    expect(plain.schedule.mode).toBe('session');

    // 同名更新：原来是 session 的计划不会被缺省改成 fresh，只更新写明的内容。
    const updated = await service.requestSchedule(fixtureState.session.id, { ...scheduleInput, name: 'Continue chat', prompt: 'Changed prompt' }, 'ou_owner', receipt('turn-4', 'fresh'));
    expect(updated).toMatchObject({ schedule: { id: asked.schedule.id, prompt: 'Changed prompt', mode: 'session' }, updated: { changed: true } });
  });

  it('updates the enabled one first when legacy data already holds duplicates', async () => {
    const h = await fixture();
    const kept = await h.service.createSchedule(h.session.id, { ...scheduleInput, name: 'Old copy' }, 'ou_owner');
    const live = await h.service.createSchedule(h.session.id, { ...scheduleInput, name: 'Live copy' }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, live.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    // 旧版本留下的两条同名计划。
    for (const id of [kept.id, live.id]) {
      const key = `session_automation/schedule/${id}`;
      await h.repositories.config.set(key, JSON.stringify({ ...JSON.parse((await h.repositories.config.get(key))!), name: 'rebase-agent-context-mac' }));
    }
    const result = await h.service.requestSchedule(h.session.id, { ...scheduleInput, name: 'rebase-agent-context-mac', prompt: 'New prompt' }, 'ou_owner', { key: 'turn-dup' });
    expect(result).toMatchObject({ schedule: { id: live.id, prompt: 'New prompt' }, updated: { changed: true, wasEnabled: true } });
    expect((await h.service.getScheduleDefinition(h.session.id, kept.id)).prompt).toBe(scheduleInput.prompt);
  });
});

describe('overdue schedule reminders', () => {
  it('recovers interrupted sending after ten minutes across restarts without exceeding the attempt limit', async () => {
    const onScheduleOverdue = vi.fn(async () => {});
    const h = await fixture({ onScheduleOverdue });
    await enable(h);
    at(h, '00:30:01'); await h.service.tick();
    const [occurrence] = (await h.service.listBySession(h.session.id)).occurrences;
    const key = `session_automation/overdue/${occurrence!.id}`;
    const sending = (attempts: number, time: string) => h.repositories.config.set(key, JSON.stringify({
      version: 1, status: 'sending', attempts, updatedAt: `2026-09-12T${time}.000Z`
    }));
    let current = h.service;
    const reopen = async () => {
      await current.close();
      const reopened = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true,
        clock: () => new Date(h.now.value), onScheduleOverdue });
      current = reopened; cleanups.push(() => reopened.close());
    };
    at(h, '01:00:02'); await sending(1, '01:00:02'); await reopen();
    at(h, '01:09:59'); await current.tick();
    expect(onScheduleOverdue).not.toHaveBeenCalled();
    at(h, '01:10:03'); await current.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await h.repositories.config.get(key))!)).toMatchObject({ status: 'sent', attempts: 2 });
    at(h, '01:11:00'); await current.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(1);
    await sending(2, '01:10:03'); await reopen();
    at(h, '01:20:04'); await current.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(2);
    expect(onScheduleOverdue).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ occurrenceId: occurrence!.id }));
    expect(JSON.parse((await h.repositories.config.get(key))!)).toMatchObject({ status: 'sent', attempts: 3 });
    await sending(3, '01:20:04'); await reopen();
    at(h, '03:00:00'); await current.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(2);
    expect(JSON.parse((await h.repositories.config.get(key))!)).toMatchObject({ status: 'sending', attempts: 3 });
  });

  const slow = { ...scheduleInput, name: 'Half hourly', trigger: { kind: 'interval' as const, everySeconds: 1800, anchorAt: '2026-09-12T00:00:00.000Z' } };
  const at = (h: Awaited<ReturnType<typeof fixture>>, time: string) => { h.now.value = new Date(`2026-09-12T${time}.000Z`); };
  async function enable(h: Awaited<ReturnType<typeof fixture>>, input: typeof scheduleInput = slow) {
    const created = await h.service.createSchedule(h.session.id, input, 'ou_owner');
    return h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
  }

  it('reminds once, with the reason, when a run is still queued after one period, and not again after a restart', async () => {
    const onScheduleOverdue = vi.fn(async () => {});
    const h = await fixture({ onScheduleOverdue });
    const schedule = await enable(h);
    at(h, '00:30:01');
    await h.service.tick();
    const [task] = await h.repositories.tasks.listBySession(h.session.id);
    expect(task).toMatchObject({ status: 'queued' });
    at(h, '00:59:00');
    await h.service.tick();
    expect(onScheduleOverdue).not.toHaveBeenCalled();

    at(h, '01:00:02');
    await h.service.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(1);
    const [overdueSchedule, notice] = onScheduleOverdue.mock.calls[0] as unknown as [{ id: string }, { occurrenceId: string; scheduledForUtc: string; reason: string }];
    expect(overdueSchedule.id).toBe(schedule.id);
    expect(notice).toMatchObject({ scheduledForUtc: '2026-09-12T00:30:00.000Z', reason: expect.stringContaining('排队') });
    expect((await h.service.listBySession(h.session.id)).occurrences.map(item => item.id)).toContain(notice.occurrenceId);

    at(h, '01:10:00');
    await h.service.tick();
    const restarted = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, clock: () => new Date(h.now.value), onScheduleOverdue });
    cleanups.push(() => restarted.close());
    await restarted.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(1);
    // 防重叠规则仍在：卡住期间没有新的触发。
    expect(await h.repositories.tasks.listBySession(h.session.id)).toHaveLength(1);
  });

  it('names the unknown-result block, and a finished run is never reminded', async () => {
    const onScheduleOverdue = vi.fn(async () => {});
    const h = await fixture({ onScheduleOverdue });
    await enable(h);
    at(h, '00:30:01');
    await h.service.tick();
    const [task] = await h.repositories.tasks.listBySession(h.session.id);
    h.settleAttempt1UnknownThenAttempt2Completes(task!.id, 'unused', false);
    at(h, '01:00:02');
    await h.service.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(1);
    expect((onScheduleOverdue.mock.calls[0] as unknown as [unknown, { reason: string }])[1].reason).toContain('结果未知');

    const doneNotice = vi.fn(async () => {});
    const done = await fixture({ onScheduleOverdue: doneNotice });
    await enable(done);
    at(done, '00:30:01');
    await done.service.tick();
    done.settleTask((await done.repositories.tasks.listBySession(done.session.id))[0]!.id);
    at(done, '01:00:02');
    await done.service.tick();
    at(done, '01:20:00');
    await done.service.tick();
    expect(doneNotice).not.toHaveBeenCalled();
  });

  it('never reminds sooner than ten minutes for short periods, and skips one-off and disabled schedules', async () => {
    const onScheduleOverdue = vi.fn(async () => {});
    const h = await fixture({ onScheduleOverdue });
    await enable(h, scheduleInput);
    at(h, '00:01:01');
    await h.service.tick();
    at(h, '00:09:00');
    await h.service.tick();
    expect(onScheduleOverdue).not.toHaveBeenCalled();
    at(h, '00:11:30');
    await h.service.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(1);

    const onceNotice = vi.fn(async () => {});
    const once = await fixture({ onScheduleOverdue: onceNotice });
    await enable(once, { ...scheduleInput, name: 'Once', trigger: { kind: 'at' as any, localDateTime: '2026-09-12T08:01' } as any });
    at(once, '00:01:01');
    await once.service.tick();
    at(once, '03:00:00');
    await once.service.tick();
    expect((await once.repositories.tasks.listBySession(once.session.id))).toHaveLength(1);
    expect(onceNotice).not.toHaveBeenCalled();

    const disabledNotice = vi.fn(async () => {});
    const disabled = await fixture({ onScheduleOverdue: disabledNotice });
    const running = await enable(disabled);
    at(disabled, '00:30:01');
    await disabled.service.tick();
    await disabled.service.updateSchedule(disabled.session.id, running.id, { expectedRevision: running.revision, enabled: false }, 'ou_owner');
    at(disabled, '02:00:00');
    await disabled.service.tick();
    expect(disabledNotice).not.toHaveBeenCalled();
  });

  it('retries a failed reminder with backoff up to three attempts, and treats no reporting location as sent', async () => {
    const onScheduleOverdue = vi.fn(async () => { throw new Error('send failed'); });
    const h = await fixture({ onScheduleOverdue });
    await enable(h);
    at(h, '00:30:01');
    await h.service.tick();
    at(h, '01:00:02');
    await h.service.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(1);
    at(h, '01:00:30');
    await h.service.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(1);
    at(h, '01:01:10');
    await h.service.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(2);
    at(h, '01:05:00');
    await h.service.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(3);
    at(h, '02:00:00');
    await h.service.tick();
    expect(onScheduleOverdue).toHaveBeenCalledTimes(3);

    const quiet = vi.fn(async () => 'not_requested' as const);
    const web = await fixture({ onScheduleOverdue: quiet });
    await enable(web);
    at(web, '00:30:01');
    await web.service.tick();
    at(web, '01:00:02');
    await web.service.tick();
    at(web, '03:00:00');
    await web.service.tick();
    expect(quiet).toHaveBeenCalledTimes(1);
  });
});
