import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  canonicalExecutionJson,
  sessionScheduleOccurrenceSchema,
  type AttemptResultV1,
  type RepositoryBundle,
  type RuntimeControlClaim,
  type Session,
  type TaskRecord,
  type TaskRequestV1
} from '@dutydeck/shared';
import { createRepositories, executionTaskId } from '@dutydeck/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionAutomationService, type SessionAutomationRuntime } from './session-automation.js';

const run = promisify(execFile);
const cleanups: Array<() => void | Promise<void>> = [];

async function gitRepository() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-automation-git-'));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  await run('git', ['init', '-q', cwd]);
  await run('git', ['-C', cwd, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', cwd, 'config', 'user.name', 'Test']);
  await run('git', ['-C', cwd, 'commit', '--allow-empty', '-qm', 'initial']);
  await run('git', ['-C', cwd, 'remote', 'add', 'origin', 'git@github.com:octo/repo.git']);
  return cwd;
}

function githubResponse(headSha: string, runs: Array<{ id: number; conclusion?: string; name?: string; status?: string }> = []) {
  return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs.map(item => ({
    id: item.id,
    name: item.name ?? 'CI',
    workflow_id: 9,
    head_sha: headSha,
    status: item.status ?? 'completed',
    conclusion: item.conclusion ?? null,
    run_attempt: 1,
    html_url: `https://github.com/octo/repo/actions/runs/${item.id}`,
    created_at: '2026-09-12T00:00:00Z',
    updated_at: '2026-09-12T00:01:00Z'
  })) }), { status: 200, headers: { 'content-type': 'application/json' } });
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
    async dispatch(sessionId, prompt, _mode, _agentPrompt, _risk, _actorId, _idempotencyKey, _skills, supplied) {
      if (!supplied) throw new Error('Automation dispatch must reuse the frozen request');
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
      const claimed = x.claimNext({ sessionId: task.sessionId, runId });
      const attempt = claimed!.attempt!;
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

async function fixture(options: { database?: string; clock?: Date; fetch?: typeof fetch; crashAfterAcceptance?: boolean; deliver?: (sessionId: string, result: AttemptResultV1, occurrenceId: string, sourceId: string) => Promise<void> } = {}) {
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
    githubFetch: options.fetch ?? (vi.fn(async () => githubResponse((await run('git', ['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim())) as typeof fetch),
    clock: () => new Date(now.value),
    deliver: options.deliver
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

describe('SessionAutomationService schedules', () => {
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

  it('records GitHub condition skip and error without dispatching', async () => {
    const responses: Array<Response | Error> = [];
    const request = vi.fn(async () => {
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return value!;
    }) as typeof fetch;
    const h = await fixture({ fetch: request });
    const head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    responses.push(githubResponse(head, [{ id: 10, conclusion: 'success' }]));
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'github_new_failure' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    responses.push(githubResponse(head, [{ id: 11, conclusion: 'success' }]));
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).occurrences[0]).toMatchObject({ conditionStatus: 'skipped', runStatus: 'skipped' });
    expect(h.dispatches).toHaveLength(0);

    h.now.value = new Date('2026-09-12T00:02:01.000Z');
    responses.push(new Error('network unavailable'));
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).occurrences.find(item => item.scheduledForUtc === '2026-09-12T00:02:00.000Z')).toMatchObject({ conditionStatus: 'error', runStatus: 'error' });
    expect(h.dispatches).toHaveLength(0);
  });

  it('detects a newly completed failure even when its run ID predates an observed success', async () => {
    const responses: Response[] = [];
    const request = vi.fn(async () => responses.shift()!) as typeof fetch;
    const h = await fixture({ fetch: request });
    const head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    responses.push(githubResponse(head, [{ id: 11, conclusion: 'success' }]));
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'github_new_failure' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    responses.push(githubResponse(head, [{ id: 11, conclusion: 'success' }, { id: 10, conclusion: 'failure' }]));
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
    let resolveSlow!: (response: Response) => void;
    const slow = new Promise<Response>(resolve => { resolveSlow = resolve; });
    let calls = 0;
    let head = '';
    const request = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return githubResponse(head);
      if (calls === 2) return slow;
      return githubResponse(head, [{ id: 20, conclusion: 'failure' }]);
    }) as typeof fetch;
    const first = await fixture({ fetch: request });
    head = (await run('git', ['-C', first.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const created = await first.service.createSchedule(first.session.id, { ...scheduleInput, condition: { kind: 'github_new_failure' } }, 'ou_owner');
    await first.service.updateSchedule(first.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    first.now.value = new Date('2026-09-12T00:01:01.000Z');
    const firstTick = first.service.tick();
    await vi.waitFor(() => expect(calls).toBe(2));

    const second = new SessionAutomationService({ repositories: first.repositories, runtime: first, authorize: async () => true, githubFetch: request, clock: () => new Date(first.now.value) });
    cleanups.push(() => second.close());
    first.now.value = new Date('2026-09-12T00:01:32.000Z');
    await second.tick();
    resolveSlow(githubResponse(head, [{ id: 20, conclusion: 'failure' }]));
    await firstTick;

    expect(await first.repositories.tasks.listBySession(first.session.id)).toHaveLength(1);
    expect((await first.service.listBySession(first.session.id)).occurrences).toEqual([
      expect.objectContaining({ conditionStatus: 'passed', runStatus: 'accepted', conditionObservedRunIds: [20] })
    ]);
  });

  it('invalidates a slow condition result when the schedule generation changes', async () => {
    let resolveSlow!: (response: Response) => void;
    const slow = new Promise<Response>(resolve => { resolveSlow = resolve; });
    let calls = 0;
    let head = '';
    const request = vi.fn(async () => ++calls === 1 ? githubResponse(head) : slow) as typeof fetch;
    const h = await fixture({ fetch: request });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const created = await h.service.createSchedule(h.session.id, { ...scheduleInput, condition: { kind: 'github_new_failure' } }, 'ou_owner');
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    const ticking = h.service.tick();
    await vi.waitFor(() => expect(calls).toBe(2));
    await h.service.updateSchedule(h.session.id, created.id, { expectedRevision: 2, name: 'Changed generation' }, 'ou_owner');
    resolveSlow(githubResponse(head, [{ id: 21, conclusion: 'failure' }]));
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

describe('SessionAutomationService GitHub CI subscriptions', () => {
  it('prepares an immutable delivery destination before saving a new automation record', async () => {
    const h = await fixture();
    const prepared: string[] = [];
    const service = new SessionAutomationService({
      repositories: h.repositories,
      runtime: h,
      authorize: async () => true,
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
    const request = vi.fn(async () => githubResponse(head, [{ id: 41, conclusion: 'success', name: 'lint' }, { id: 42, conclusion: 'failure', name: 'test' }])) as typeof fetch;
    const h = await fixture({ fetch: request, crashAfterAcceptance: true });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const subscription = await h.service.subscribeCi(h.session.id, { workflow: 'ci.yml', ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const task = (await h.repositories.tasks.listBySession(h.session.id))[0]!;
    expect(task.prompt).toContain('lint: success');
    expect(task.prompt).toContain('test: failure');
    expect(task.executionContext?.actorId).toBe('ou_owner');
    const listed = (await h.service.listBySession(h.session.id)).subscriptions[0]!;
    expect(listed).toMatchObject({ id: subscription.id, prompt: 'Review the completed GitHub Actions result and continue the task.', status: 'accepted', completedRunIds: [41, 42], taskId: task.id });
    expect(listed).not.toHaveProperty('dispatchPrompt');
  });

  it('recovers a dispatching subscription with its exact persisted prompt after restart', async () => {
    let head = '';
    const request = vi.fn(async () => githubResponse(head, [{ id: 50, conclusion: 'failure', name: 'original result' }])) as typeof fetch;
    const h = await fixture({ fetch: request });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const subscription = await h.service.subscribeCi(h.session.id, { prompt: 'Continue exactly once', ttlSeconds: 600 }, 'ou_owner');
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const hangingRuntime: SessionAutomationRuntime = {
      getSession: id => h.repositories.sessions.get(id),
      async dispatch() { await blocked; throw new Error('old process stopped'); }
    };
    const first = new SessionAutomationService({ repositories: h.repositories, runtime: hangingRuntime, authorize: async () => true, githubFetch: request, clock: () => new Date(h.now.value) });
    cleanups.push(() => first.close());
    const firstTick = first.tick();
    await vi.waitFor(async () => {
      const raw = await h.repositories.config.get(`session_automation/ci/${subscription.id}`);
      expect(JSON.parse(raw!).status).toBe('dispatching');
    });
    const persisted = JSON.parse((await h.repositories.config.get(`session_automation/ci/${subscription.id}`))!) as { dispatchPrompt: string };

    h.now.value = new Date('2026-09-12T00:00:31.000Z');
    const restored = new SessionAutomationService({ repositories: h.repositories, runtime: h, authorize: async () => true, githubFetch: vi.fn(async () => githubResponse(head, [{ id: 999, conclusion: 'success', name: 'different later result' }])) as typeof fetch, clock: () => new Date(h.now.value) });
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
    const responses: Response[] = [];
    const request = vi.fn(async () => responses.shift()!) as typeof fetch;
    const h = await fixture({ fetch: request });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const subscription = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    responses.push(githubResponse(head, [
      { id: 60, status: 'completed', conclusion: 'success', name: 'lint' },
      { id: 61, status: 'in_progress', name: 'test' }
    ]));
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).subscriptions.find(item => item.id === subscription.id)?.status).toBe('waiting');
    expect(h.dispatches).toHaveLength(0);

    h.now.value = new Date('2026-09-12T00:01:01.000Z');
    responses.push(githubResponse(head, [
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
    const request = vi.fn(async () => githubResponse(head, [{ id: 1, conclusion: 'success' }])) as typeof fetch;
    const h = await fixture({ fetch: request });
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
    const h = await fixture({ fetch: vi.fn(async () => githubResponse(head, [{ id: 4, conclusion: 'success' }])) as typeof fetch });
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
    const h = await fixture({ fetch: vi.fn(async () => githubResponse(head, [{ id: 7, conclusion: 'success' }])) as typeof fetch });
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
      fetch: vi.fn(async () => githubResponse(head, [{ id: 8, conclusion: 'success' }])) as typeof fetch,
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
    const h = await fixture({ fetch: vi.fn(async () => githubResponse(head, [{ id: 5, conclusion: 'success' }])) as typeof fetch, deliver });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const subscription = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const [task] = await h.repositories.tasks.listBySession(h.session.id);
    h.settleTask(task!.id);
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).subscriptions[0]?.delivery).toMatchObject({ status: 'error', attempts: 1 });
    await h.service.tick();
    expect((await h.service.listBySession(h.session.id)).subscriptions[0]?.delivery).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenLastCalledWith(h.session.id, expect.objectContaining({ taskId: task?.id }), subscription.id, subscription.id);
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
