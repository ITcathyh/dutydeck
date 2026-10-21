import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalExecutionJson, type TaskAttempt } from '@dutydeck/shared';
import { createRepositories } from './index.js';

const closing: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const close of closing.splice(0).reverse()) close(); });
const hash = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const fence = { sessionId: 'capacity-session', runId: 'capacity-run' };
const actor = { kind: 'installation_owner', id: 'installation_owner' } as const;
const af = (attempt: TaskAttempt) => ({ ...fence, taskId: attempt.taskId, attemptId: attempt.attemptId, expectedRevision: attempt.revision });
const evidence = { kind: 'driver_result', submissionId: 'capacity-submission', outcome: 'failed', outputDigest: hash(''), stopReason: 'end_turn', complete: true } as const;
const capacity = { code: 'codex_capacity', nativeSource: 'codex', nativeTerminal: true, nativeTurnId: 'native-turn', capacityReason: 'selected_model_capacity' };
function fixture(filename = ':memory:') {
  const repos = createRepositories(filename, { newDatabaseAuthority: 'ledger_v1' }); const claim = repos.control.attachRuntime('capacity-test');
  closing.push(() => { claim.release(); repos.close(); }); const bound = repos.execution.bind(claim);
  if (!repos.execution.getSessionExecutions(fence.sessionId).length) {
    try { bound.createSession({ id: fence.sessionId, runId: fence.runId, agentId: 'codex', cwd: '/tmp', state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); } catch (error) { if (!String(error).includes('UNIQUE')) throw error; }
  }
  const accept = (key: string) => {
    const input = { version: 2 as const, prompt: 'hello', executionOptions: { permissionMode: 'ask' as const }, executionContext: { agentPrompt: 'hello', actorId: actor.id }, contentSources: [] };
    return bound.acceptTask(fence, { version: 1, namespace: 'runtime', key, sessionId: fence.sessionId, actor, prompt: 'hello', mode: 'queue', options: {}, skills: [], sources: [], sourcePayload: null }, { ...input, digest: hash(input) }, 'back');
  };
  const prepare = (attempt: TaskAttempt) => bound.markSubmissionPending(af(attempt), { submissionId: `submission:${attempt.attemptId}`, inputDigest: hash('hello'), resourceRefs: [], authorizationRefs: [] }).attempt!;
  const emit = (attempt: TaskAttempt, data = capacity, type: 'error' | 'tool_call' = 'error') => bound.appendEvent(af(attempt), { id: `error:${attempt.attemptId}`, type, data });
  return { repos, bound, accept, prepare, emit };
}
const resultFor = (a: TaskAttempt) => ({ ...evidence, submissionId: a.submission!.submissionId });
it('atomically records a failure and delayed successor, replays idempotently, and bounds retries at two', () => {
  vi.useFakeTimers(); const h = fixture(); const task = h.accept('one').task!;
  let a = h.prepare(h.bound.claimNext(fence)!.attempt!); h.emit(a);
  const firstEvidence = resultFor(a);
  const first = h.bound.settleCapacityRetry(af(a), 'capacity-1', firstEvidence);
  expect(first.task?.status).toBe('queued'); expect(first.events.some(event => event.type === 'completed' || event.type === 'task' && (event.data as any).task.status === 'failed')).toBe(false);
  expect(h.repos.execution.getTaskExecution(task.id)?.attempts[0]).toMatchObject({ state: 'settled', outcome: 'failed', settlement: firstEvidence });
  expect(first.attempt?.automaticRetry).toMatchObject({ ordinal: 1, causeAttemptId: a.attemptId });
  expect(h.bound.settleCapacityRetry(af(a), 'capacity-1', firstEvidence).replayed).toBe(true); expect(h.bound.claimNext(fence)).toBeUndefined();
  vi.advanceTimersByTime(30_000); a = h.prepare(h.bound.claimNext(fence)!.attempt!); h.emit(a);
  const second = h.bound.settleCapacityRetry(af(a), 'capacity-2', resultFor(a)); expect(second.attempt?.automaticRetry?.ordinal).toBe(2);
  vi.advanceTimersByTime(89_999); expect(h.bound.claimNext(fence)).toBeUndefined(); vi.advanceTimersByTime(1);
  a = h.prepare(h.bound.claimNext(fence)!.attempt!); h.emit(a);
  expect(() => h.bound.settleCapacityRetry(af(a), 'capacity-3', resultFor(a))).toThrow(/CAPACITY_RETRY_NOT_SAFE/);
  expect(h.repos.execution.getTaskExecution(task.id)?.attempts).toHaveLength(3);
});
it.each(['unknown', 'tools', 'unbound'])('refuses %s evidence without mutating the attempt', scenario => {
  const h = fixture(); h.accept('one'); const a = h.prepare(h.bound.claimNext(fence)!.attempt!);
  if (scenario === 'tools') h.emit(a, capacity, 'tool_call');
  else if (scenario === 'unbound') h.emit(a, { ...capacity, nativeTerminal: false });
  expect(() => h.bound.settleCapacityRetry(af(a), 'unsafe', resultFor(a))).toThrow(/CAPACITY_RETRY_NOT_SAFE/);
  expect(h.repos.execution.getAttempt(af(a))?.state).toBe('active');
});
it('new user acceptance cancels the delayed attempt in the same transaction', () => {
  const h = fixture(); const old = h.accept('old').task!; const a = h.prepare(h.bound.claimNext(fence)!.attempt!); h.emit(a);
  h.bound.settleCapacityRetry(af(a), 'capacity-old', resultFor(a)); h.accept('new');
  expect(h.repos.execution.getTaskExecution(old.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome: 'cancelled', submissionState: 'not_submitted' });
  expect(h.bound.claimNext(fence)?.task?.id).not.toBe(old.id);
});
it('persists its deadline across a real database close and can cancel after reopening', () => {
  vi.useFakeTimers(); const root = mkdtempSync(join(tmpdir(), 'dd-capacity-disk-')); closing.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'ledger.sqlite'); const h = fixture(path); const t = h.accept('persisted').task!; const a = h.prepare(h.bound.claimNext(fence)!.attempt!); h.emit(a);
  h.bound.settleCapacityRetry(af(a), 'capacity-persisted', resultFor(a)); closing.pop()!();
  const reopened = fixture(path); expect(reopened.bound.claimNext(fence)).toBeUndefined();
  expect(reopened.bound.cancelCapacityRetries(fence, 'user_stopped')).toHaveLength(1);
  vi.advanceTimersByTime(120_000); expect(reopened.bound.claimNext(fence)).toBeUndefined();
  expect(reopened.repos.execution.getTaskExecution(t.id)?.currentAttempt?.outcome).toBe('cancelled');
});
