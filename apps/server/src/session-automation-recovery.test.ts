import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import {
  canonicalExecutionJson,
  type AttemptFence,
  type AttemptResultV1,
  type RuntimeControlClaim,
  type Session,
  type TaskRecord,
  type TaskRequestV1
} from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ciProviders, ciStatus, TEST_CI_REMOTE, type StatusMock } from './ci-provider.test-helpers.js';
import { SessionAutomationService, type SessionAutomationRuntime } from './session-automation.js';
import { readAttemptResult } from './task-results.js';

const run = promisify(execFile);
const cleanups: Array<() => void | Promise<void>> = [];

async function gitRepository() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-automation-recovery-git-'));
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

const claims = new WeakMap<Repos, RuntimeControlClaim>();
function bound(repos: Repos) {
  let claim = claims.get(repos);
  if (!claim) { claim = repos.control.attachRuntime('automation-recovery-test'); claims.set(repos, claim); }
  return repos.execution.bind(claim);
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

interface RecoveryRuntime extends SessionAutomationRuntime {
  dispatches: TaskRecord[];
  settleTask(taskId: string, outcome?: 'completed' | 'failed' | 'interrupted', text?: string): AttemptResultV1;
  settleTaskWithEvents(taskId: string, chunks: string[]): AttemptResultV1;
}

function ledgerRuntime(repos: Repos, harnessSession: HarnessSession): RecoveryRuntime {
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
  const finish = (taskId: string, attemptId: string, fenceRevision: { value: number }, status: 'completed' | 'failed' | 'interrupted', text: string, settlementId: string) => {
    const x = bound(repos);
    let fence: any = { sessionId: harnessSession.id, runId: harnessSession.runId, taskId, attemptId, expectedRevision: fenceRevision.value };
    x.markSubmissionPending(fence, { submissionId: `sub:${settlementId}`, inputDigest: (repos.execution.getAcceptedTask(taskId)!.input as { digest: string }).digest, resourceRefs: [], authorizationRefs: [] });
    fenceRevision.value = repos.execution.getTaskExecution(taskId)!.attempts.find(item => item.attemptId === attemptId)!.revision;
    fence = { ...fence, expectedRevision: fenceRevision.value };
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    x.settleAttempt(fence, settlementId, { kind: 'driver_result', submissionId: `sub:${settlementId}`, outcome: status, outputDigest: digest, stopReason: 'end_turn', complete: true });
  };
  const runtime: RecoveryRuntime = {
    dispatches,
    async getSession(id) { return repos.sessions.get(id); },
    async dispatchRequest(supplied) {
      if (!supplied) throw new Error('Automation dispatch must reuse the frozen request');
      const sessionId = supplied.sessionId;
      const committed = bound(repos).acceptTask({ sessionId, runId: harnessSession.runId }, supplied, acceptedInput(supplied), 'back');
      dispatches.push(committed.task!);
      return { id: committed.task!.id, status: committed.task!.status };
    },
    settleTask(taskId, outcome = 'completed', text = 'target result') {
      const x = bound(repos);
      const claimed = x.claimNext({ sessionId: harnessSession.id, runId: harnessSession.runId })!;
      const attempt = claimed.attempt!;
      const revision = { value: attempt.revision };
      let fence: any = { sessionId: harnessSession.id, runId: harnessSession.runId, taskId, attemptId: attempt.attemptId, expectedRevision: revision.value };
      x.appendEvent(fence, { id: `out:${taskId}`, type: 'text', data: { role: 'assistant', text } });
      const settlementId = `set:${taskId}`;
      finish(taskId, attempt.attemptId, revision, outcome, text, settlementId);
      const events = repos.execution.getAttemptEvents(attempt.attemptId);
      const throughSequence = events.filter(event => event.type === 'completed' && event.settlementId === settlementId).at(-1)!.sequence;
      const digest = createHash('sha256').update(text, 'utf8').digest('hex');
      return { version: 1, taskId, attemptId: attempt.attemptId, settlementId, throughSequence, outcome, output: { text, digest } };
    },
    settleTaskWithEvents(taskId, chunks) {
      const x = bound(repos);
      const claimed = x.claimNext({ sessionId: harnessSession.id, runId: harnessSession.runId })!;
      const attempt = claimed.attempt!;
      const revision = { value: attempt.revision };
      let fence: any = { sessionId: harnessSession.id, runId: harnessSession.runId, taskId, attemptId: attempt.attemptId, expectedRevision: revision.value };
      chunks.forEach((text, index) => {
        x.appendEvent(fence, { id: `out:${taskId}:${index}`, type: 'text', data: { role: 'assistant', text } });
      });
      const text = chunks.join('');
      const settlementId = `set:${taskId}:long`;
      finish(taskId, attempt.attemptId, revision, 'completed', text, settlementId);
      const events = repos.execution.getAttemptEvents(attempt.attemptId, { limit: 1000 });
      const throughSequence = events.filter(event => event.type === 'completed' && event.settlementId === settlementId).at(-1)!.sequence;
      const digest = createHash('sha256').update(text, 'utf8').digest('hex');
      return { version: 1, taskId, attemptId: attempt.attemptId, settlementId, throughSequence, outcome: 'completed' as const, output: { text, digest } };
    }
  };
  return runtime;
}

async function fixture(options: { status?: StatusMock; deliver?: (sessionId: string, result: AttemptResultV1, occurrenceId: string, sourceId: string) => Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-automation-recovery-db-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'dutydeck.db');
  const repositories = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  cleanups.push(() => { const claim = claims.get(repositories); claim?.release(); repositories.close(); });
  const cwd = await gitRepository();
  const claim = repositories.control.attachRuntime('automation-recovery-test');
  claims.set(repositories, claim);
  const nowIso = '2026-09-12T00:00:00.000Z';
  const session: Session = { id: `ses_${Math.random()}`, agentId: 'codex', state: 'idle', cwd, runId: 'run_1', source: 'lark', sourceId: 'cli_app:oc_chat:group', permissionMode: 'ask', createdAt: nowIso, updatedAt: nowIso };
  repositories.execution.bind(claim).createSession({ id: session.id, runId: session.runId, agentId: session.agentId, cwd, state: 'idle', source: 'lark', sourceId: session.sourceId, permissionMode: 'ask', createdAt: nowIso, updatedAt: nowIso });
  const now = { value: new Date(nowIso) };
  const mocked = ledgerRuntime(repositories, { id: session.id, runId: session.runId });
  const service = new SessionAutomationService({
    repositories,
    runtime: mocked,
    authorize: async () => true,
    ciProviders: ciProviders(options.status ?? (vi.fn(async () => ciStatus((await run('git', ['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim())) as StatusMock)),
    clock: () => new Date(now.value),
    deliver: options.deliver
  });
  cleanups.push(() => service.close());
  /** ConfigRepository 无 delete 接口；双 KV 崩溃模拟需要直接删除绑定行，仅测试夹具使用。 */
  const deleteConfig = (key: string) => {
    const db = new Database(database);
    try { db.prepare('DELETE FROM configs WHERE key = ?').run(key); } finally { db.close(); }
  };
  return { database, repositories, cwd, session, now, service, runtime: mocked, deleteConfig, ...mocked };
}

const scheduleInput = {
  name: 'Every minute',
  prompt: 'Continue scheduled work',
  trigger: { kind: 'interval' as const, everySeconds: 60, anchorAt: '2026-09-12T00:00:00.000Z' },
  timezone: 'Asia/Shanghai',
  dstPolicy: { gap: 'skip' as const, overlap: 'first' as const },
  condition: { kind: 'always' as const }
};

const occKey = (id: string) => `session_automation/occurrence/${id}`;

async function scheduled(h: Awaited<ReturnType<typeof fixture>>) {
  const s = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
  await h.service.updateSchedule(h.session.id, s.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
  h.now.value = new Date('2026-09-12T00:01:01Z');
  return s;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('SessionAutomation independent-review regression fixes', () => {
  it('A: close awaits the real tick tail beyond the removed one-second escape and starts no new work', async () => {
    const h = await fixture();
    await scheduled(h);
    const entered = deferred();
    const gate = deferred();
    let firstAuthorize = true;
    (h.service as unknown as { options: { authorize: () => Promise<boolean> } }).options.authorize = async () => {
      if (firstAuthorize) { firstAuthorize = false; entered.resolve(); await gate.promise; }
      return true;
    };
    const ticking = h.service.tick();
    await entered.promise;

    vi.useFakeTimers();
    let closed = false;
    const closing = h.service.close().then(() => { closed = true; });
    try {
      // 跨越旧 1 秒 (1000ms) 超时分支：推进 1150ms，停点未释放，close 仍未返回！
      await vi.advanceTimersByTimeAsync(1150);
      expect(closed).toBe(false);
      expect(h.dispatches).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      gate.resolve();
      await closing;
      await ticking;
    }
    expect(closed).toBe(true);
    expect(h.dispatches).toHaveLength(1);

    // close 返回后 closed 阻新 tick，不产生任何新工作。
    await h.service.tick();
    expect(h.dispatches).toHaveLength(1);
  });

  it('B1 schedule: a frozen ask admission is not overwritten by current full-trust defaults on recovery', async () => {
    const h = await fixture();
    await scheduled(h);
    const entered = deferred();
    const gate = deferred();
    const original = (h.service as unknown as { options: { runtime: SessionAutomationRuntime } }).options.runtime.dispatchRequest;
    (h.service as unknown as { options: { runtime: SessionAutomationRuntime } }).options.runtime = {
      ...(h.service as unknown as { options: { runtime: SessionAutomationRuntime } }).options.runtime,
      dispatchRequest: async () => { entered.resolve(); await gate.promise; throw new Error('old dispatch stopped'); }
    };
    const ticking = h.service.tick();
    await entered.promise;
    const first = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    const before = JSON.parse((await h.repositories.config.get(occKey(first.id)))!);
    expect(before.admission.request.options.permissionMode).toBe('ask');

    await h.repositories.sessions.save({ ...(await h.repositories.sessions.get(h.session.id))!, permissionMode: 'full-trust' });
    h.now.value = new Date('2026-09-12T00:02:01Z');
    const restored = new SessionAutomationService({
      repositories: h.repositories,
      runtime: { getSession: async (id: string) => h.repositories.sessions.get(id), dispatchRequest: original },
      authorize: async () => true,
      clock: () => h.now.value
    });
    cleanups.push(() => restored.close());

    try {
      await restored.tick();
      const after = JSON.parse((await h.repositories.config.get(occKey(first.id)))!);
      expect(after.admission.request.options.permissionMode).toBe('ask');
      const accepted = h.repositories.execution.getAcceptedTask(after.admission.taskId);
      expect(accepted?.request?.options.permissionMode).toBe('ask');
    } finally {
      gate.resolve();
      await ticking.catch(() => {});
    }
  });

  it('B1 CI: recovery dispatches the frozen ask envelope even though session defaults are now full-trust', async () => {
    let head = '';
    const h = await fixture({ status: vi.fn(async () => ciStatus(head, [{ id: 12, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const sub = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    const entered = deferred();
    const gate = deferred();
    const serviceOptions = h.service as unknown as { options: { runtime: SessionAutomationRuntime } };
    const original = serviceOptions.options.runtime.dispatchRequest;
    serviceOptions.options.runtime = {
      ...serviceOptions.options.runtime,
      dispatchRequest: async () => { entered.resolve(); await gate.promise; throw new Error('old dispatch stopped'); }
    };
    const ticking = h.service.tick();
    await entered.promise;
    try {
      await h.repositories.sessions.save({ ...(await h.repositories.sessions.get(h.session.id))!, permissionMode: 'full-trust' });
      h.now.value = new Date('2026-09-12T00:00:31Z');
      const restored = new SessionAutomationService({
        repositories: h.repositories,
        runtime: { getSession: async (id: string) => h.repositories.sessions.get(id), dispatchRequest: original },
        authorize: async () => true,
        ciProviders: ciProviders(vi.fn(async () => ciStatus(head, [{ id: 12, conclusion: 'success' }])) as StatusMock),
        clock: () => h.now.value
      });
      cleanups.push(() => restored.close());
      await restored.tick();
      const stored = JSON.parse((await h.repositories.config.get(`session_automation/ci/${sub.id}`))!);
      expect(stored.admission.request.options.permissionMode).toBe('ask');
      const accepted = h.repositories.execution.getAcceptedTask(stored.admission.taskId);
      expect(accepted?.request?.options.permissionMode).toBe('ask');
    } finally {
      gate.resolve();
      await ticking.catch(() => {});
    }
  });

  it('B2: a same-key acceptance carrying a different request binds the source as blocked/admission_conflict', async () => {
    const h = await fixture();
    await scheduled(h);
    const serviceOptions = h.service as unknown as { options: { runtime: SessionAutomationRuntime } };
    const original = serviceOptions.options.runtime.dispatchRequest;
    serviceOptions.options.runtime = {
      ...serviceOptions.options.runtime,
      dispatchRequest: async request => {
        await original({ ...request, prompt: 'OTHER-PRODUCER', sourcePayload: { ...(request.sourcePayload as object), agentPrompt: 'OTHER-PRODUCER' } });
        return original(request);
      }
    };
    await h.service.tick();
    const source = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    expect(source.runStatus).toBe('blocked');
    expect(source.blockReason).toBe('admission_conflict');
    const record = JSON.parse((await h.repositories.config.get(occKey(source.id)))!);
    expect(record.admission.request.prompt).toBe(scheduleInput.prompt);
    expect(h.repositories.execution.getAcceptedTask(record.admission.taskId)?.request?.prompt).toBe('OTHER-PRODUCER');
  });

  it('B3: a V2 binding mismatch on occurrence/schedule/generation/id-version is rejected, not silently accepted', async () => {
    const h = await fixture();
    await scheduled(h);
    await h.service.tick();
    const task = h.dispatches[0]!;
    const actualKey = (await h.repositories.config.list!('session_automation/')).find(r => r.key.includes(task.id))!.key;
    const binding = JSON.parse((await h.repositories.config.get(actualKey))!);
    await expect((h.service as unknown as {
      ensureTaskBinding(taskId: string, binding: unknown): Promise<void>;
    }).ensureTaskBinding(task.id, {
      ...binding,
      occurrenceId: 'wrong-occurrence',
      scheduleId: 'wrong-schedule',
      generation: binding.generation + 100,
      taskIdVersion: 'legacy'
    })).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_TASK_BINDING_CONFLICT' });
  });

  it('B3 legacy: an old-hash accepted task is recovered as legacy_partial with its original id and no duplicate task', async () => {
    const h = await fixture();
    const schedule = await scheduled(h);
    const scheduleKey = `session_automation/schedule/${schedule.id}`;
    const scheduleRaw = (await h.repositories.config.get(scheduleKey))!;
    const storedSchedule = JSON.parse(scheduleRaw);
    const scheduledForUtc = storedSchedule.nextDueAt;
    const id = `occ_${createHash('sha256').update(`${schedule.id}\0${storedSchedule.generation}\0${scheduledForUtc}`).digest('hex')}`;
    const oldKey = `session-automation:schedule:${id}`;
    const oldId = `task_${createHash('sha256').update(`${h.session.id}\0${oldKey}`).digest('hex')}`;

    // 独立 legacy 库：旧 hash Task（无 V2 request 行）+ 无 taskId 的 V1 occurrence（接受响应丢失）+ V1 binding。
    const legacyRepos = createRepositories(':memory:');
    cleanups.push(() => { claims.get(legacyRepos)?.release(); legacyRepos.close(); });
    await legacyRepos.sessions.save(h.session);
    await legacyRepos.config.set(scheduleKey, scheduleRaw);
    await legacyRepos.tasks.save({
      id: oldId,
      sessionId: h.session.id,
      prompt: scheduleInput.prompt,
      status: 'queued',
      executionContext: { agentPrompt: scheduleInput.prompt, actorId: 'ou_owner' },
      createdAt: h.now.value.toISOString(),
      updatedAt: h.now.value.toISOString()
    });
    await legacyRepos.config.set(occKey(id), JSON.stringify({
      schemaVersion: 1,
      id,
      revision: 1,
      scheduleId: schedule.id,
      sessionId: h.session.id,
      generation: storedSchedule.generation,
      scheduledForUtc,
      conditionStatus: 'passed',
      runStatus: 'pending',
      delivery: { status: 'not_requested', attempts: 0, updatedAt: h.now.value.toISOString() },
      createdAt: h.now.value.toISOString(),
      updatedAt: h.now.value.toISOString()
    }));
    await legacyRepos.config.set(`session_automation/task/${oldId}`, JSON.stringify({
      schemaVersion: 1,
      kind: 'schedule',
      sessionId: h.session.id,
      occurrenceId: id
    }));
    legacyRepos.execution.upgradeLegacy();
    expect(legacyRepos.execution.getAcceptedTask(oldId)).toBeDefined();

    const legacyRuntime = ledgerRuntime(legacyRepos, { id: h.session.id, runId: h.session.runId });
    const restored = new SessionAutomationService({
      repositories: legacyRepos,
      runtime: legacyRuntime,
      authorize: async () => true,
      clock: () => h.now.value
    });
    cleanups.push(() => restored.close());
    await restored.tick();

    const tasks = await legacyRepos.tasks.listBySession(h.session.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(oldId);
    const source = JSON.parse((await legacyRepos.config.get(occKey(id)))!);
    expect(source.taskId).toBe(oldId);
    expect(source.admission).toMatchObject({ kind: 'legacy_partial', taskId: oldId });
    // 旧 queued Task 只有 V1 输入、不可透明提交：保留原 ID/legacy_partial 且不生成第二 Task，
    // 但持久 blocked/legacy_input_unresolved 挡下一触发（旧代码此处是普通 error 且 taskId 丢失、canonical 指向不存在 Task）。
    expect(source.runStatus).toBe('blocked');
    expect(source.blockReason).toBe('legacy_input_unresolved');
  });

  it('B4 CI: a stale/unreadable HEAD before first submit rejects authorization', async () => {
    let head = '';
    const h = await fixture({ status: vi.fn(async () => ciStatus(head, [{ id: 11, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const task = h.dispatches[0]!;
    expect(h.repositories.execution.getAcceptedTask(task.id)).toBeDefined();
    const headRef = (await run('git', ['-C', h.cwd, 'symbolic-ref', 'HEAD'])).stdout.trim();
    await run('git', ['-C', h.cwd, 'update-ref', '-d', headRef]);
    await expect(run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).rejects.toBeDefined();
    await expect(h.service.authorizeTask(task, 'submit')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_TASK_STALE_HEAD' });
  });

  it('B4 CI: a cancellation winning the taskStarted CAS rejects the submit authorization', async () => {
    let head = '';
    const h = await fixture({ status: vi.fn(async () => ciStatus(head, [{ id: 19, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const sub = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const task = h.dispatches[0]!;
    const key = `session_automation/ci/${sub.id}`;
    type CasStore = {
      get(k: string): Promise<string | undefined>;
      set(k: string, v: string): Promise<void>;
      compareAndSet(k: string, expected: string | undefined, value: string): Promise<boolean>;
    };
    const casStore = h.repositories.config as unknown as CasStore;
    const cas = casStore.compareAndSet.bind(casStore);
    let raced = false;
    vi.spyOn(casStore, 'compareAndSet').mockImplementation(async (k, expected, next) => {
      if (k === key && JSON.parse(next).taskStartedAt && !raced) {
        raced = true;
        const current = JSON.parse((await casStore.get(key))!);
        await casStore.set(key, JSON.stringify({ ...current, status: 'cancelled', revision: current.revision + 1 }));
        return false;
      }
      return cas(k, expected, next);
    });
    await expect(h.service.authorizeTask(task, 'submit')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_TASK_REVOKED' });
    expect(raced).toBe(true);
    expect(JSON.parse((await h.repositories.config.get(key))!).status).toBe('cancelled');
  });

  it('C2: a historical V1 completed/delivered occurrence keeps its delivered state', async () => {
    const h = await fixture();
    await scheduled(h);
    await h.service.tick();
    const task = h.dispatches[0]!;
    h.settleTask(task.id);
    const item = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    const stored = JSON.parse((await h.repositories.config.get(occKey(item.id)))!);
    const { admission, actor, runtimeAttemptId, result, resultBoundary, blockReason, actorId, ...legacy } = stored;
    void admission; void actor; void runtimeAttemptId; void result; void resultBoundary; void blockReason; void actorId;
    await h.repositories.config.set(occKey(item.id), JSON.stringify({
      ...legacy,
      schemaVersion: 1,
      runStatus: 'completed',
      delivery: { status: 'delivered', attempts: 1, updatedAt: h.now.value.toISOString() }
    }));
    await h.service.tick();
    const after = JSON.parse((await h.repositories.config.get(occKey(item.id)))!);
    expect(after.runStatus).toBe('completed');
    expect(after.delivery.status).toBe('delivered');
    expect(after.delivery.attempts).toBe(1);
  });

  it('C2: after reconcile_required, a manual confirmation of the original number=1 attempt settles the same source', async () => {
    const h = await fixture();
    await scheduled(h);
    await h.service.tick();
    const task = h.dispatches[0]!;
    const x = bound(h.repositories);
    const sf = { sessionId: h.session.id, runId: h.session.runId };
    const claimed = x.claimNext(sf)!;
    const a = claimed.attempt!;
    let fence: any = { ...sf, taskId: task.id, attemptId: a.attemptId, expectedRevision: a.revision };
    x.markSubmissionPending(fence, { submissionId: 'manual-sub', inputDigest: 'a'.repeat(64), resourceRefs: [], authorizationRefs: [] });
    fence = { ...fence, expectedRevision: h.repositories.execution.getTaskExecution(task.id)!.currentAttempt!.revision };
    x.markReconcileRequired(fence, { reasonId: 'unknown', code: 'DRIVER_RESULT_UNKNOWN', evidenceRefs: [] });
    await h.service.tick();
    const blocked = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    expect(blocked.runStatus).toBe('blocked');
    expect(blocked.blockReason).toBe('reconcile_required');

    fence = { ...fence, expectedRevision: h.repositories.execution.getTaskExecution(task.id)!.currentAttempt!.revision };
    x.settleAttempt(fence, 'manual-result', {
      kind: 'manual',
      outcome: 'completed',
      decision: { decisionId: 'confirm-original', actor: { kind: 'channel', id: 'ou_owner', appId: 'cli_app' }, action: 'confirm_result', evidenceRefs: ['test'], resourceChecks: [] }
    });
    expect(h.repositories.execution.getTaskExecution(task.id)!.currentAttempt).toMatchObject({ number: 1, state: 'settled', outcome: 'completed' });
    await h.service.tick();
    const settled = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    expect(settled.runStatus).toBe('completed');
    expect(settled.resultBoundary).toBe('verified');
    expect(settled.result?.attemptId).toBe(a.attemptId);
  });

  it('C3: public occurrences never expose actorId even when a historical record carries it', async () => {
    const h = await fixture();
    await scheduled(h);
    await h.service.tick();
    const item = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    const value = JSON.parse((await h.repositories.config.get(occKey(item.id)))!);
    await h.repositories.config.set(occKey(item.id), JSON.stringify({ ...value, actorId: 'private-actor-canary' }));
    const listed = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    expect(listed).not.toHaveProperty('actorId');
    expect(JSON.stringify(listed)).not.toContain('private-actor-canary');
  });

  it('dual-KV schedule: admission/binding cutpoint survives actual SQLite close/new connection and recovers same binding', async () => {
    let head = '';
    const h = await fixture({ status: vi.fn(async () => ciStatus(head, [{ id: 66, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const s = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await h.service.updateSchedule(h.session.id, s.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01Z');
    type CasStore = {
      get(k: string): Promise<string | undefined>;
      set(k: string, v: string): Promise<void>;
      compareAndSet(k: string, expected: string | undefined, value: string): Promise<boolean>;
    };
    const casStore = h.repositories.config as unknown as CasStore;
    const cas = casStore.compareAndSet.bind(casStore);
    let reached = false;
    vi.spyOn(casStore, 'compareAndSet').mockImplementation(async (k: string, e: string | undefined, v: string) => {
      if (k.startsWith('session_automation/task/')) {
        reached = true;
        throw new Error('cutpoint-after-admission-before-binding');
      }
      return cas(k, e, v);
    });
    await expect(h.service.tick()).rejects.toThrow('cutpoint-after-admission-before-binding');
    expect(reached).toBe(true);
    const sourceKey = (await h.repositories.config.list!('session_automation/occurrence/'))[0]!.key;
    const before = JSON.parse((await h.repositories.config.get(sourceKey))!);
    expect(before.admission).toBeDefined();
    expect(h.repositories.execution.getAcceptedTask(before.admission.taskId)).toBeUndefined();
    expect(await h.repositories.config.list!('session_automation/task/')).toHaveLength(0);

    // 真正 SQLite 关闭与释放
    await h.service.close();
    claims.get(h.repositories)!.release();
    claims.delete(h.repositories);
    h.repositories.close();

    // 以全新 connection 与新 service 实例重开
    const repos = createRepositories(h.database, { newDatabaseAuthority: 'ledger_v1' });
    cleanups.push(() => { claims.get(repos)?.release(); repos.close(); });
    const rt = ledgerRuntime(repos, { id: h.session.id, runId: h.session.runId });
    const service = new SessionAutomationService({
      repositories: repos,
      runtime: rt,
      authorize: async () => true,
      clock: () => new Date('2026-09-12T00:02:01Z'),
      ciProviders: ciProviders(vi.fn(async () => { throw new Error('recovery must not reread material'); }) as StatusMock)
    });
    cleanups.push(() => service.close());
    await service.tick();

    const after = JSON.parse((await repos.config.get(sourceKey))!);
    expect(after.admission).toEqual(before.admission);
    expect(repos.execution.getAcceptedTask(before.admission.taskId)?.request).toEqual(before.admission.request);
    expect(await repos.tasks.listBySession(h.session.id)).toHaveLength(1);
    const taskBindingRows = await repos.config.list!('session_automation/task/');
    expect(taskBindingRows).toHaveLength(1);
    expect(JSON.parse(taskBindingRows[0]!.value)).toMatchObject({
      schemaVersion: 2,
      kind: 'schedule',
      sessionId: h.session.id,
      occurrenceId: before.id,
      scheduleId: s.id,
      taskId: before.admission.taskId,
      taskIdVersion: 'v1',
      generation: before.generation
    });
  });

  it('dual-KV CI: admission/binding cutpoint survives actual SQLite close/new connection and recovers same binding', async () => {
    let head = '';
    const h = await fixture({ status: vi.fn(async () => ciStatus(head, [{ id: 67, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const sub = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    type CasStore = {
      get(k: string): Promise<string | undefined>;
      set(k: string, v: string): Promise<void>;
      compareAndSet(k: string, expected: string | undefined, value: string): Promise<boolean>;
    };
    const casStore = h.repositories.config as unknown as CasStore;
    const cas = casStore.compareAndSet.bind(casStore);
    let reached = false;
    vi.spyOn(casStore, 'compareAndSet').mockImplementation(async (k: string, e: string | undefined, v: string) => {
      if (k.startsWith('session_automation/task/')) {
        reached = true;
        throw new Error('cutpoint-after-admission-before-binding');
      }
      return cas(k, e, v);
    });
    await expect(h.service.tick()).rejects.toThrow('cutpoint-after-admission-before-binding');
    expect(reached).toBe(true);
    const sourceKey = (await h.repositories.config.list!('session_automation/ci/'))[0]!.key;
    const before = JSON.parse((await h.repositories.config.get(sourceKey))!);
    expect(before.admission).toBeDefined();
    expect(h.repositories.execution.getAcceptedTask(before.admission.taskId)).toBeUndefined();
    expect(await h.repositories.config.list!('session_automation/task/')).toHaveLength(0);

    // 真正关闭与释放
    await h.service.close();
    claims.get(h.repositories)!.release();
    claims.delete(h.repositories);
    h.repositories.close();

    // 以全新 connection 与新 service 实例重开
    const repos = createRepositories(h.database, { newDatabaseAuthority: 'ledger_v1' });
    cleanups.push(() => { claims.get(repos)?.release(); repos.close(); });
    const rt = ledgerRuntime(repos, { id: h.session.id, runId: h.session.runId });
    const service = new SessionAutomationService({
      repositories: repos,
      runtime: rt,
      authorize: async () => true,
      clock: () => new Date('2026-09-12T00:01:01Z'),
      ciProviders: ciProviders(vi.fn(async () => { throw new Error('recovery must not reread material'); }) as StatusMock)
    });
    cleanups.push(() => service.close());
    await service.tick();

    const after = JSON.parse((await repos.config.get(sourceKey))!);
    expect(after.admission).toEqual(before.admission);
    expect(repos.execution.getAcceptedTask(before.admission.taskId)?.request).toEqual(before.admission.request);
    expect(await repos.tasks.listBySession(h.session.id)).toHaveLength(1);
    const taskBindingRows = await repos.config.list!('session_automation/task/');
    expect(taskBindingRows).toHaveLength(1);
    expect(JSON.parse(taskBindingRows[0]!.value)).toMatchObject({
      schemaVersion: 2,
      kind: 'ci',
      sessionId: h.session.id,
      subscriptionId: sub.id,
      taskId: before.admission.taskId,
      taskIdVersion: 'v1'
    });
  });

  it('F1 CI: conflicting acceptance persists as blocked and next refresh never consumes wrong request', async () => {
    let head = '';
    const h = await fixture({ status: vi.fn(async () => ciStatus(head, [{ id: 88, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const sub = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    const serviceOptions = h.service as unknown as { options: { runtime: SessionAutomationRuntime } };
    const original = serviceOptions.options.runtime.dispatchRequest;
    serviceOptions.options.runtime = {
      ...serviceOptions.options.runtime,
      dispatchRequest: async request => {
        await original({ ...request, prompt: 'OTHER-CI', sourcePayload: { ...(request.sourcePayload as object), agentPrompt: 'OTHER-CI' } });
        return original(request);
      }
    };
    await h.service.tick();
    const key = `session_automation/ci/${sub.id}`;
    let record = JSON.parse((await h.repositories.config.get(key))!);
    expect(record.status).toBe('blocked');
    expect(record.blockReason).toBe('admission_conflict');
    expect(h.repositories.execution.getAcceptedTask(record.admission.taskId)?.request?.prompt).toBe('OTHER-CI');

    // 竞争者的 Task 结算为 completed，再次 tick
    h.settleTask(record.admission.taskId, 'completed', 'WRONG-CI-OUTPUT');
    await h.service.tick();
    record = JSON.parse((await h.repositories.config.get(key))!);
    // 来源必须依然保持 blocked，绝不被消费为 completed！
    expect(record.status).toBe('blocked');
    expect(record.blockReason).toBe('admission_conflict');
    expect(record.result).toBeUndefined();
  });

  it('F2 authorizeTask: rejects authorization when source actor is modified to another actor while actual accepted actor was revoked', async () => {
    const h = await fixture();
    const s = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await h.service.updateSchedule(h.session.id, s.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01Z');
    await h.service.tick();
    const task = h.dispatches[0]!;
    const row = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    const key = `session_automation/occurrence/${row.id}`;
    const record = JSON.parse((await h.repositories.config.get(key))!);
    record.actor = { kind: 'channel', id: 'ou_replacement', appId: 'cli_app' };
    await h.repositories.config.set(key, JSON.stringify(record));
    (h.service as unknown as { options: { authorize: (s: string, a?: string) => Promise<boolean> } }).options.authorize = async (_s: string, actor?: string) => actor === 'ou_replacement';
    await expect(h.service.authorizeTask(task, 'submit')).rejects.toMatchObject({ code: 'SESSION_AUTOMATION_TASK_REVOKED' });
    expect(h.repositories.execution.getAcceptedTask(task.id)?.request?.actor).toMatchObject({ id: 'ou_owner' });
  });

  it('F3 CI: original Attempt manual confirmation unblocks source with persisted blockReason and transitions to completed', async () => {
    let head = '';
    const h = await fixture({ status: vi.fn(async () => ciStatus(head, [{ id: 99, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const sub = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const task = h.dispatches[0]!;
    const x = bound(h.repositories);
    const sf = { sessionId: h.session.id, runId: h.session.runId };
    const a = x.claimNext(sf)!.attempt!;
    let fence: AttemptFence = { ...sf, taskId: task.id, attemptId: a.attemptId, expectedRevision: a.revision };
    x.markSubmissionPending(fence, { submissionId: 'manual-ci', inputDigest: 'a'.repeat(64), resourceRefs: [], authorizationRefs: [] });
    fence = { ...fence, expectedRevision: h.repositories.execution.getTaskExecution(task.id)!.currentAttempt!.revision };
    x.markReconcileRequired(fence, { reasonId: 'unknown-ci', code: 'DRIVER_RESULT_UNKNOWN', evidenceRefs: [] });
    await h.service.tick();
    const key = `session_automation/ci/${sub.id}`;
    const before = JSON.parse((await h.repositories.config.get(key))!);
    expect(before.status).toBe('blocked');
    expect(before.blockReason).toBe('reconcile_required');

    fence = { ...fence, expectedRevision: h.repositories.execution.getTaskExecution(task.id)!.currentAttempt!.revision };
    x.settleAttempt(fence, 'manual-ci-result', {
      kind: 'manual',
      outcome: 'completed',
      decision: { decisionId: 'confirm-ci-original', actor: { kind: 'channel', id: 'ou_owner', appId: 'cli_app' }, action: 'confirm_result', evidenceRefs: ['test'], resourceChecks: [] }
    });
    await h.service.tick();
    const after = JSON.parse((await h.repositories.config.get(key))!);
    expect(after.status).toBe('completed');
    expect(after.result).toBeDefined();
    expect(after.result.attemptId).toBe(a.attemptId);
    expect(h.repositories.execution.getTaskExecution(task.id)!.currentAttempt).toMatchObject({ number: 1, state: 'settled', outcome: 'completed' });
  });

  it('delivers the complete output across the 200-event page boundary', async () => {
    const entered = deferred();
    const gate = deferred();
    const deliveries: AttemptResultV1[] = [];
    const h = await fixture({
      deliver: async (_sessionId, result) => { entered.resolve(); deliveries.push(result); await gate.promise; }
    });
    await scheduled(h);
    await h.service.tick();
    const task = h.dispatches[0]!;
    const chunks = Array.from({ length: 250 }, (_v, i) => `chunk-${i}-`);
    const result = h.settleTaskWithEvents(task.id, chunks);
    // refresh→交付在同一 tick 内挂在 gate：不能在 tick 自身 await，否则自死锁。
    const ticking = h.service.tick();
    try {
      await entered.promise;
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.output.text).toBe(result.output.text);
      expect(deliveries[0]!.output.text.length).toBe(chunks.join('').length);
      expect(deliveries[0]!.throughSequence).toBeGreaterThan(200);
      expect(deliveries[0]!.output.digest).toBe(result.output.digest);
    } finally {
      gate.resolve();
      await ticking;
    }
  });

  it('a late delivery receipt is not written after the source moves on while delivery is in flight', async () => {
    const entered = deferred();
    const gate = deferred();
    const h = await fixture({
      deliver: async () => { entered.resolve(); await gate.promise; }
    });
    await scheduled(h);
    await h.service.tick();
    const task = h.dispatches[0]!;
    h.settleTask(task.id);
    // refresh 冻结 number=1 result 并进入交付；交付在 gate 处挂起。
    const ticking = h.service.tick();
    await entered.promise;
    const item = (await h.service.listBySession(h.session.id)).occurrences[0]!;
    // 交付在途期间来源被取消：保留同一租约 owner，只改终态与交付语义，
    // 精确验证"当前允许写回状态"守卫，而非仅租约不匹配。
    const raw = (await h.repositories.config.get(occKey(item.id)))!;
    const current = JSON.parse(raw);
    await h.repositories.config.compareAndSet!(occKey(item.id), raw, JSON.stringify({
      ...current,
      revision: current.revision + 1,
      runStatus: 'interrupted',
      delivery: { status: 'not_requested', attempts: current.delivery.attempts, updatedAt: h.now.value.toISOString() }
    }));
    gate.resolve();
    await ticking;
    const after = JSON.parse((await h.repositories.config.get(occKey(item.id)))!)!;
    expect(after.runStatus).toBe('interrupted');
    expect(after.delivery.status).toBe('not_requested');
  });

  it('closeout: a stale CI authorization tail never overwrites a newer public cancellation (single CAS, no retry)', async () => {
    let head = '';
    const h = await fixture({ status: vi.fn(async () => ciStatus(head, [{ id: 101, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    const sub = await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    const entered = deferred();
    const gate = deferred();
    // 安装者授权即时通过；原创建人授权挂在明确停点，释放后才返回 false。
    (h.service as unknown as { options: { authorize: (s: string, actor?: string) => Promise<boolean> } }).options.authorize = async (_s: string, actor?: string) => {
      if (actor === 'installation_owner') return true;
      entered.resolve();
      await gate.promise;
      return false;
    };
    const ticking = h.service.tick();
    try {
      await entered.promise;
      // 公开 cancelCi 使用当前真实 revision 与 installation_owner，来源取消成功。
      const raw = JSON.parse((await h.repositories.config.get(`session_automation/ci/${sub.id}`))!)!;
      const cancelled = await h.service.cancelCi(h.session.id, sub.id, { expectedRevision: raw.revision }, 'installation_owner');
      expect(cancelled.status).toBe('cancelled');
    } finally {
      // 无论断言如何都释放旧授权停点并等原 tick 真正收口。
      gate.resolve();
      await ticking;
    }
    // 旧 pollCi catch 的 finishCi(revoked) 单次 CAS 因 raw 过时而失败，不覆盖取消。
    const after = JSON.parse((await h.repositories.config.get(`session_automation/ci/${sub.id}`))!)!;
    expect(after.status).toBe('cancelled');
    expect(h.dispatches).toHaveLength(0);
  });

  it('closeout: a stale Schedule authorization tail never overwrites a newer completed source (single CAS, no retry)', async () => {
    const h = await fixture();
    const s = await h.service.createSchedule(h.session.id, scheduleInput, 'ou_owner');
    await h.service.updateSchedule(h.session.id, s.id, { expectedRevision: 1, enabled: true }, 'ou_owner');
    h.now.value = new Date('2026-09-12T00:01:01Z');
    const entered = deferred();
    const gate = deferred();
    // 第一个 service 的初始授权挂在明确停点。
    (h.service as unknown as { options: { authorize: () => Promise<boolean> } }).options.authorize = async () => {
      entered.resolve();
      await gate.promise;
      return false;
    };
    const firstTick = h.service.tick();
    let sourceKey = '';
    try {
      await entered.promise;
      sourceKey = (await h.repositories.config.list!('session_automation/occurrence/'))[0]!.key;
      // 推进业务时钟到原 30 秒租约过期；第二个 service 使用同一合法 ledger claim 恢复同一来源。
      h.now.value = new Date('2026-09-12T00:02:01Z');
      const second = new SessionAutomationService({
        repositories: h.repositories,
        runtime: h.runtime,
        authorize: async () => true,
        clock: () => h.now.value
      });
      cleanups.push(() => second.close());
      await second.tick();
      const accepted = JSON.parse((await h.repositories.config.get(sourceKey))!)!;
      expect(accepted.runStatus).toBe('accepted');
      // 用真实 ledger 完成原 Task，第二 service tick 冻结 completed/REAL-COMPLETED。
      h.settleTask(accepted.taskId, 'completed', 'REAL-COMPLETED');
      await second.tick();
      expect(JSON.parse((await h.repositories.config.get(sourceKey))!)!.runStatus).toBe('completed');
    } finally {
      // 释放第一个 service 的旧授权调用并等其 tick 真正收口。
      gate.resolve();
      await firstTick;
    }
    // 旧 finishOccurrence(error) 单次 CAS 因 raw 过时而失败，新 completed 与冻结结果保持。
    const after = JSON.parse((await h.repositories.config.get(sourceKey))!)!;
    expect(after.runStatus).toBe('completed');
    expect(after.result.output.text).toBe('REAL-COMPLETED');
  });
});

describe('SessionAutomation historical capacity-result recovery', () => {
  async function historical(kind: 'schedule' | 'ci') {
    const delivered = vi.fn(async () => {});
    let head = '';
    const h = await fixture({ deliver: delivered, status: vi.fn(async () => ciStatus(head, [{ id: 88, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    if (kind === 'schedule') await scheduled(h);
    else await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const taskId = h.dispatches[0]!.id;
    const x = bound(h.repositories);
    const first = x.claimNext({ sessionId: h.session.id, runId: h.session.runId })!.attempt!;
    const fence = { sessionId: h.session.id, runId: h.session.runId, taskId, attemptId: first.attemptId, expectedRevision: first.revision };
    x.markSubmissionPending(fence, { submissionId: 'capacity-submission', inputDigest: h.repositories.execution.getAcceptedTask(taskId)!.input!.digest, resourceRefs: [], authorizationRefs: [] });
    fence.expectedRevision = h.repositories.execution.getTaskExecution(taskId)!.currentAttempt!.revision;
    x.appendEvent(fence, { id: 'capacity-error', type: 'error', data: { code: 'codex_capacity', nativeSource: 'codex', nativeTerminal: true, capacityReason: 'selected_model_capacity', nativeTurnId: 'turn' } });
    const successor = x.settleCapacityRetry(fence, 'capacity-settlement', { kind: 'driver_result', submissionId: 'capacity-submission', outcome: 'failed', outputDigest: createHash('sha256').update('').digest('hex'), stopReason: 'end_turn', complete: true }).attempt!;
    expect(readAttemptResult(h.repositories, h.session.id, taskId, first.attemptId)).toEqual({ status: 'blocked', reason: 'legacy_output_unresolved' });
    const key = (await h.repositories.config.list!(kind === 'schedule' ? 'session_automation/occurrence/' : 'session_automation/ci/'))[0]!.key;
    const raw = JSON.parse((await h.repositories.config.get(key))!);
    // Persist the exact blocked/not_requested shape emitted by the old fixed-attempt reader.
    const blocked = { ...raw, revision: raw.revision + 1, runtimeAttemptId: first.attemptId,
      ...(kind === 'schedule' ? { runStatus: 'blocked' } : { status: 'blocked' }),
      blockReason: 'legacy_output_unresolved', resultBoundary: 'legacy_output_unresolved', error: 'legacy_output_unresolved',
      delivery: { status: 'not_requested', attempts: raw.delivery.attempts, updatedAt: raw.updatedAt } };
    await h.repositories.config.set(key, JSON.stringify(blocked));
    const sql = new Database(h.database);
    try { sql.prepare("UPDATE task_attempts SET json=json_set(json, '$.automaticRetry.dueAt', '2000-01-01T00:00:00.000Z') WHERE id=?").run(successor.attemptId); }
    finally { sql.close(); }
    return { h, delivered, taskId, first, successor, key, blocked };
  }

  async function reopen(h: Awaited<ReturnType<typeof fixture>>, deliver: NonNullable<Parameters<typeof fixture>[0]>['deliver']) {
    await h.service.close();
    claims.get(h.repositories)!.release();
    claims.delete(h.repositories);
    h.repositories.close();
    const repositories = createRepositories(h.database, { newDatabaseAuthority: 'ledger_v1' });
    cleanups.push(() => { claims.get(repositories)?.release(); repositories.close(); });
    const runtime = ledgerRuntime(repositories, h.session);
    const service = new SessionAutomationService({ repositories, runtime, deliver, authorize: async () => true,
      clock: () => new Date(h.now.value),
      ciProviders: ciProviders(vi.fn(async () => { throw new Error('Recovery must not reread CI materials'); }) as StatusMock) });
    cleanups.push(() => service.close());
    return { repositories, runtime, service };
  }

  it.each([
    { kind: 'schedule', completedBeforeReopen: false }, { kind: 'ci', completedBeforeReopen: false },
    { kind: 'schedule', completedBeforeReopen: true }, { kind: 'ci', completedBeforeReopen: true }
  ] as const)('recovers historical $kind after SQLite reopen (already completed: $completedBeforeReopen), delivers once, and permits subsequent work', async ({ kind, completedBeforeReopen }) => {
    const { h, delivered, taskId, first, successor, key, blocked } = await historical(kind);
    if (completedBeforeReopen) h.settleTask(taskId, 'completed', 'successful capacity successor');
    const fresh = await reopen(h, delivered);
    if (!completedBeforeReopen) {
      // A verified but unfinished successor leaves the historical source untouched and never dispatches.
      await fresh.service.tick();
      expect(JSON.parse((await fresh.repositories.config.get(key))!)).toEqual(blocked);
      expect(fresh.runtime.dispatches).toHaveLength(0);
      expect(delivered).not.toHaveBeenCalled();
      fresh.runtime.settleTask(taskId, 'completed', 'successful capacity successor');
    }
    await fresh.service.tick();
    await vi.waitFor(async () => expect(JSON.parse((await fresh.repositories.config.get(key))!).delivery.status).toBe('delivered'));
    await fresh.service.tick();
    const after = JSON.parse((await fresh.repositories.config.get(key))!);
    expect(after).toMatchObject({ admission: blocked.admission, runtimeAttemptId: first.attemptId,
      resultBoundary: 'verified', result: { taskId, attemptId: successor.attemptId, output: { text: 'successful capacity successor' } },
      delivery: { status: 'delivered', attempts: 1 } });
    expect(kind === 'schedule' ? after.runStatus : after.status).toBe('completed');
    expect(after.blockReason).toBeUndefined();
    expect(after.error).toBeUndefined();
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(fresh.runtime.dispatches).toHaveLength(0);
    expect(await fresh.repositories.tasks.listBySession(h.session.id)).toHaveLength(1);
    if (kind === 'schedule') {
      h.now.value = new Date('2026-09-12T00:02:01Z');
      await fresh.service.tick();
      expect(fresh.runtime.dispatches).toHaveLength(1);
      expect(fresh.runtime.dispatches[0]!.id).not.toBe(taskId);
    } else {
      const next = await fresh.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
      expect(next.id).not.toBe(blocked.id);
      expect(next.status).toBe('waiting');
    }
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it.each((['schedule', 'ci'] as const).flatMap(kind => [
    'manual_successor', 'input_conflict', 'scope_conflict', 'missing_boundary', 'unknown_then_manual_retry',
    'admission_conflict', 'unrelated_block', 'missing_frozen_attempt', 'wrong_frozen_attempt', 'already_delivered'
  ].map(scenario => ({ kind, scenario }))))('keeps historical $kind unchanged for $scenario after SQLite reopen', async ({ kind, scenario }) => {
    const { h, delivered, taskId, successor, key, blocked } = await historical(kind);
    if (scenario === 'unknown_then_manual_retry') {
      const x = bound(h.repositories);
      const current = () => h.repositories.execution.getTaskExecution(taskId)!.currentAttempt!;
      const fence = () => ({ sessionId: h.session.id, runId: h.session.runId, taskId, attemptId: current().attemptId, expectedRevision: current().revision });
      x.claimNext({ sessionId: h.session.id, runId: h.session.runId });
      x.settleAttempt(fence(), 'unknown-successor', { kind: 'manual', outcome: 'unknown', decision: {
        decisionId: 'unknown-successor', actor: { kind: 'installation_owner', id: 'installation_owner' },
        action: 'confirm_result', evidenceRefs: ['test'], resourceChecks: []
      } });
      x.retryAttempt(fence(), { decisionId: 'human-retry', actor: { kind: 'installation_owner', id: 'installation_owner' },
        action: 'retry', allowDuplicateEffects: true, evidenceRefs: ['test'], resourceChecks: [] }, []);
    }
    h.settleTask(taskId, 'completed', 'must not deliver this result');
    const sql = new Database(h.database);
    try {
      if (scenario === 'manual_successor') sql.prepare("UPDATE task_attempts SET json=json_remove(json, '$.automaticRetry') WHERE id=?").run(successor.attemptId);
      if (scenario === 'input_conflict') sql.prepare("UPDATE task_attempts SET json=json_set(json, '$.automaticRetry.inputDigest', ?) WHERE id=?").run('f'.repeat(64), successor.attemptId);
      if (scenario === 'scope_conflict') sql.prepare("UPDATE task_attempts SET json=json_set(json, '$.sessionId', 'another-session') WHERE id=?").run(successor.attemptId);
      if (scenario === 'missing_boundary') sql.prepare("DELETE FROM events WHERE attempt_id=? AND type='completed'").run(successor.attemptId);
    } finally { sql.close(); }
    if (scenario === 'admission_conflict') blocked.admission.request.prompt = 'conflicting admission prompt';
    if (scenario === 'unrelated_block') blocked.blockReason = 'admission_conflict';
    if (scenario === 'missing_frozen_attempt') delete blocked.runtimeAttemptId;
    if (scenario === 'wrong_frozen_attempt') blocked.runtimeAttemptId = successor.attemptId;
    if (scenario === 'already_delivered') blocked.delivery = { status: 'delivered', attempts: 1, updatedAt: blocked.updatedAt };
    await h.repositories.config.set(key, JSON.stringify(blocked));
    const fresh = await reopen(h, delivered);
    await fresh.service.tick();
    await fresh.service.tick();
    expect(JSON.parse((await fresh.repositories.config.get(key))!)).toEqual(blocked);
    expect(delivered).not.toHaveBeenCalled();
    expect(fresh.runtime.dispatches).toHaveLength(0);
  });

  it.each((['schedule', 'ci'] as const).flatMap(kind => [false, true].map(restoreBoundary => ({ kind, restoreBoundary }))))('keeps original legacy $kind blocked when the first attempt boundary is restored: $restoreBoundary', async ({ kind, restoreBoundary }) => {
    const delivered = vi.fn(async () => {});
    let head = '';
    const h = await fixture({ deliver: delivered, status: vi.fn(async () => ciStatus(head, [{ id: 89, conclusion: 'success' }])) as StatusMock });
    head = (await run('git', ['-C', h.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
    if (kind === 'schedule') await scheduled(h);
    else await h.service.subscribeCi(h.session.id, { ttlSeconds: 600 }, 'ou_owner');
    await h.service.tick();
    const taskId = h.dispatches[0]!.id;
    const result = h.settleTask(taskId);
    const key = (await h.repositories.config.list!(kind === 'schedule' ? 'session_automation/occurrence/' : 'session_automation/ci/'))[0]!.key;
    const raw = JSON.parse((await h.repositories.config.get(key))!);
    const blocked = { ...raw, revision: raw.revision + 1, runtimeAttemptId: result.attemptId,
      ...(kind === 'schedule' ? { runStatus: 'blocked' } : { status: 'blocked' }),
      blockReason: 'legacy_output_unresolved', resultBoundary: 'legacy_output_unresolved',
      delivery: { status: 'not_requested', attempts: 0, updatedAt: raw.updatedAt } };
    await h.repositories.config.set(key, JSON.stringify(blocked));
    const sql = new Database(h.database);
    try {
      const boundary = sql.prepare("SELECT * FROM events WHERE attempt_id=? AND type='completed'").get(result.attemptId) as Record<string, unknown>;
      sql.prepare("DELETE FROM events WHERE attempt_id=? AND type='completed'").run(result.attemptId);
      expect(readAttemptResult(h.repositories, h.session.id, taskId, result.attemptId)).toEqual({ status: 'blocked', reason: 'legacy_output_unresolved' });
      if (restoreBoundary) {
        const columns = Object.keys(boundary);
        sql.prepare(`INSERT INTO events (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(boundary));
      }
    } finally { sql.close(); }
    const fresh = await reopen(h, delivered);
    await fresh.service.tick();
    await fresh.service.tick();
    expect(JSON.parse((await fresh.repositories.config.get(key))!)).toEqual(blocked);
    expect(delivered).not.toHaveBeenCalled();
    expect(fresh.runtime.dispatches).toHaveLength(0);
  });
});
