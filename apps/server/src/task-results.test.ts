import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalExecutionJson, type BoundExecutionRepository, type RuntimeControlClaim, type TaskAttempt, type TaskRequestV1 } from '@dutydeck/shared';
import * as storage from '@dutydeck/storage';
import { readAttemptResult } from './task-results.js';

const directories: string[] = [];
const opened: Array<{ repos: ReturnType<typeof storage.createRepositories>; claim: RuntimeControlClaim; path: string }> = [];
afterEach(() => { for (const e of opened.splice(0).reverse()) { e.claim.release(); e.repos.close(); } for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const at = '2026-09-14T00:00:00.000Z';
const fence = { sessionId: 'session', runId: 'run' };
const stableHash = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const utf8Digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const ownerActor = { kind: 'installation_owner', id: 'installation_owner' } as const;
const request = (key = 'one'): TaskRequestV1 =>
  ({ version: 1, namespace: 'work_item', key, sessionId: fence.sessionId, actor: ownerActor, prompt: 'hello', mode: 'queue', skills: [], options: { permissionMode: 'ask' }, sources: [], sourcePayload: { agentPrompt: 'hello' } });
const v2Input = () => { const content = { version: 2 as const, prompt: 'hello', executionContext: { agentPrompt: 'hello', actorId: 'installation_owner' }, contentSources: [], executionOptions: { permissionMode: 'ask' as const } }; return { ...content, digest: stableHash(content) }; };
const af = (a: TaskAttempt) => ({ sessionId: a.sessionId, runId: a.runId, taskId: a.taskId, attemptId: a.attemptId, expectedRevision: a.revision });

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'task-results-')); directories.push(dir);
  const path = join(dir, 'test.sqlite');
  const repos = storage.createRepositories(path);
  repos.execution.upgradeLegacy();
  const claim = repos.control.attachRuntime('results-test');
  const x: BoundExecutionRepository = repos.execution.bind(claim);
  x.createSession({ id: fence.sessionId, runId: fence.runId, agentId: 'agent', cwd: '/source', state: 'created', source: 'work_item', createdAt: at, updatedAt: at });
  opened.push({ repos, claim, path });
  return { repos, x, path };
}
function current(repos: ReturnType<typeof storage.createRepositories>, taskId: string) { return repos.execution.getTaskExecution(taskId)!.currentAttempt!; }
function accepted(x: BoundExecutionRepository, key = 'one') { return x.acceptTask(fence, request(key), v2Input(), 'back').task!; }
function claimed(repos: ReturnType<typeof storage.createRepositories>, x: BoundExecutionRepository, key = 'one') {
  accepted(x, key);
  const next = x.claimNext(fence);
  if (!next?.attempt) throw new Error('claimNext failed');
  return next.attempt;
}
function textEvents(x: BoundExecutionRepository, attempt: TaskAttempt, chunks: string[]) {
  chunks.forEach((text, index) => x.appendEvent(af(attempt), { id: `out:${attempt.attemptId}:${index}`, type: 'text', data: { text } }));
}
function settleDriver(repos: ReturnType<typeof storage.createRepositories>, x: BoundExecutionRepository, taskId: string, outputDigest: string, outcome: 'completed' | 'failed' | 'interrupted' = 'completed') {
  const preparing = current(repos, taskId);
  const submissionId = `submission:${taskId}:${preparing.attemptId}`;
  x.markSubmissionPending(af(preparing), { submissionId, inputDigest: stableHash('turn'), resourceRefs: [], authorizationRefs: [] });
  const active = current(repos, taskId);
  return x.settleAttempt(af(active), `settlement:${submissionId}`, { kind: 'driver_result', submissionId, outcome, outputDigest, stopReason: 'end_turn', complete: true }).attempt!;
}
const thrown = (fn: () => unknown) => { try { fn(); } catch (error) { return error; } throw new Error('Expected the function to throw'); };

describe('readAttemptResult against the real execution ledger', () => {
  it('atomically preserves old events and returns only verified manual output, with audited idempotency', async () => {
    const { repos, x, path } = open();
    const a = claimed(repos, x);
    textEvents(x, a, ['partial old answer']);
    x.appendEvent(af(a), { id: 'hanging-tool', type: 'tool_call', data: { id: 'tool', name: 'restart' } });
    const decision = { decisionId: 'manual', actor: ownerActor, action: 'confirm_result' as const, evidenceRefs: ['transcript:sha256:reviewed'], resourceChecks: [] };
    const evidence = { kind: 'manual' as const, outcome: 'completed' as const, decision };
    const sql = new Database(path);
    sql.exec("CREATE TRIGGER reject_recovery BEFORE INSERT ON events WHEN NEW.type='completed' BEGIN SELECT RAISE(ABORT,'injected'); END;");
    expect(() => x.confirmAttemptRecovery(af(a), 'recovery:manual', evidence, 'verified complete answer')).toThrow('injected');
    expect(repos.execution.getAttemptEvents(a.attemptId).filter(e => (e.data as any).recovery)).toHaveLength(0);
    expect(current(repos, a.taskId).state).toBe('preparing');
    sql.exec('DROP TRIGGER reject_recovery');
    const settled = x.confirmAttemptRecovery(af(a), 'recovery:manual', evidence, 'verified complete answer');
    expect(x.confirmAttemptRecovery(af(a), 'recovery:manual', evidence, 'verified complete answer').replayed).toBe(true);
    expect(() => x.confirmAttemptRecovery(af(a), 'recovery:manual', evidence, 'changed')).toThrow(/EXECUTION_OPERATION_CONFLICT/);
    const events = repos.execution.getAttemptEvents(a.attemptId);
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
    expect(events.filter(e => (e.data as any).recovery)).toHaveLength(1);
    expect(settled.attempt?.settlement).toMatchObject({ kind: 'manual', verifiedOutput: { digest: utf8Digest('verified complete answer') } });
    expect(readAttemptResult({ execution: repos.execution }, 'session', a.taskId, a.attemptId)).toMatchObject({ status: 'settled', result: { output: { text: 'verified complete answer', digest: utf8Digest('verified complete answer') } } });
    sql.prepare("UPDATE events SET data=? WHERE id=?").run(JSON.stringify({ role: 'assistant', text: 'tampered' }), events.find(e => (e.data as any).recovery)!.id);
    expect(() => readAttemptResult({ execution: repos.execution }, 'session', a.taskId, a.attemptId)).toThrow(/Verified recovery output/);
    sql.close();
  });

  it('reports pending for preparing and active attempts', () => {
    const { repos, x } = open();
    const preparing = claimed(repos, x);
    expect(readAttemptResult({ execution: repos.execution }, fence.sessionId, preparing.taskId, preparing.attemptId)).toEqual({ status: 'pending' });
    x.markSubmissionPending(af(preparing), { submissionId: 's1', inputDigest: stableHash('turn'), resourceRefs: [], authorizationRefs: [] });
    const active = current(repos, preparing.taskId);
    expect(readAttemptResult({ execution: repos.execution }, fence.sessionId, active.taskId, active.attemptId)).toEqual({ status: 'pending' });
  });

  it('settles completed output with the exact digest and boundary sequence, ignoring user and thinking text', () => {
    const { repos, x } = open();
    const preparing = claimed(repos, x);
    textEvents(x, preparing, ['foo', 'bar']);
    x.appendEvent(af(preparing), { id: 'user-evt', type: 'text', data: { text: 'hello', role: 'user', taskId: preparing.taskId } });
    x.appendEvent(af(preparing), { id: 'think-evt', type: 'thinking', data: { text: 'secret' } });
    const settled = settleDriver(repos, x, preparing.taskId, utf8Digest('foobar'));
    const read = readAttemptResult({ execution: repos.execution }, fence.sessionId, settled.taskId, settled.attemptId);
    expect(read.status).toBe('settled');
    if (read.status !== 'settled') throw new Error('expected settled');
    expect(read.result).toMatchObject({ version: 1, taskId: settled.taskId, attemptId: settled.attemptId, outcome: 'completed' });
    expect(read.result.settlementId).toBe(`settlement:submission:${settled.taskId}:${settled.attemptId}`);
    expect(read.result.output.text).toBe('foobar');
    expect(read.result.output.digest).toBe(utf8Digest('foobar'));
    const boundary = repos.execution.getAttemptEvents(settled.attemptId).filter(event => event.type === 'completed').at(-1)!;
    expect(read.result.throughSequence).toBe(boundary.sequence);
  });

  it('reads all pages beyond 200 events in strict order', () => {
    const { repos, x } = open();
    const preparing = claimed(repos, x);
    const output = '字'.repeat(205);
    textEvents(x, preparing, Array.from({ length: 205 }, () => '字'));
    const settled = settleDriver(repos, x, preparing.taskId, utf8Digest(output));
    const read = readAttemptResult({ execution: repos.execution }, fence.sessionId, settled.taskId, settled.attemptId);
    expect(read.status).toBe('settled');
    if (read.status !== 'settled') throw new Error('expected settled');
    expect(read.result.output.text).toBe(output);
    expect(read.result.throughSequence).toBeGreaterThan(200);
  });

  it('blocks a number=1 unknown attempt even when attempt 2 later completes', () => {
    const { repos, x } = open();
    // 手动 confirm_result 到 unknown 后 number=1 永久 blocked，后续 retry 产生 number=2。
    accepted(x, 'unknown-task');
    const claim1 = x.claimNext(fence);
    if (!claim1?.attempt) throw new Error('claimNext failed');
    const unknown = claim1.attempt;
    x.settleAttempt(af(unknown), 'manual-unknown-2', { kind: 'manual', outcome: 'unknown', decision: { decisionId: 'confirm-unknown', actor: ownerActor, action: 'confirm_result', evidenceRefs: ['operator'], resourceChecks: [] } });
    expect(readAttemptResult({ execution: repos.execution }, fence.sessionId, unknown.taskId, unknown.attemptId)).toEqual({ status: 'blocked', reason: 'reconcile_required' });
    const unknownSettled = current(repos, unknown.taskId);
    x.retryAttempt(af(unknownSettled), { decisionId: 'retry-2', actor: ownerActor, action: 'retry', allowDuplicateEffects: true, resourceChecks: [], evidenceRefs: ['operator'] }, []);
    const claim2 = x.claimNext(fence);
    if (!claim2?.attempt) throw new Error('claimNext failed');
    const second = claim2.attempt;
    textEvents(x, second, ['second output']);
    settleDriver(repos, x, second.taskId, utf8Digest('second output'));
    expect(readAttemptResult({ execution: repos.execution }, fence.sessionId, unknown.taskId, unknown.attemptId)).toEqual({ status: 'blocked', reason: 'reconcile_required' });
    expect(repos.execution.getTaskExecution(unknown.taskId)!.task.currentAttemptId).toBe(second.attemptId);
  });

  it('blocks when the authoritative completion boundary is missing', () => {
    const { repos, x, path } = open();
    const preparing = claimed(repos, x);
    textEvents(x, preparing, ['legacy']);
    const settled = settleDriver(repos, x, preparing.taskId, utf8Digest('legacy'));
    const db = new Database(path);
    try { db.prepare('DELETE FROM events WHERE attempt_id=? AND type=?').run(settled.attemptId, 'completed'); }
    finally { db.close(); }
    expect(readAttemptResult({ execution: repos.execution }, fence.sessionId, settled.taskId, settled.attemptId)).toEqual({ status: 'blocked', reason: 'legacy_output_unresolved' });
  });

  it('blocks reconcile_required attempts', () => {
    const { repos, x } = open();
    const preparing = claimed(repos, x);
    x.markSubmissionPending(af(preparing), { submissionId: 'submission:reconcile', inputDigest: stableHash('turn'), resourceRefs: [], authorizationRefs: [] });
    const active = current(repos, preparing.taskId);
    x.markReconcileRequired(af(active), { reasonId: 'reconcile-1', code: 'DRIVER_RESULT_UNKNOWN', evidenceRefs: [] });
    const reconciled = current(repos, preparing.taskId);
    expect(readAttemptResult({ execution: repos.execution }, fence.sessionId, reconciled.taskId, reconciled.attemptId)).toEqual({ status: 'blocked', reason: 'reconcile_required' });
  });

  it('throws on digest conflict, wrong scope, wrong number and missing task', () => {
    const { repos, x } = open();
    const preparing = claimed(repos, x);
    textEvents(x, preparing, ['actual output']);
    const settled = settleDriver(repos, x, preparing.taskId, utf8Digest('different digest'));
    expect(thrown(() => readAttemptResult({ execution: repos.execution }, fence.sessionId, settled.taskId, settled.attemptId))).toMatchObject({ code: 'TASK_RESULT_DIGEST_CONFLICT' });

    const other = claimed(repos, x, 'two');
    expect(thrown(() => readAttemptResult({ execution: repos.execution }, 'other-session', other.taskId, other.attemptId))).toMatchObject({ code: 'TASK_RESULT_SCOPE_CONFLICT' });
    expect(thrown(() => readAttemptResult({ execution: repos.execution }, fence.sessionId, other.taskId, 'attempt_missing'))).toMatchObject({ code: 'TASK_RESULT_ATTEMPT_MISSING' });
    expect(readAttemptResult({ execution: repos.execution }, fence.sessionId, 'task_missing', 'attempt_x')).toEqual({ status: 'blocked', reason: 'admission_conflict' });

    x.settleAttempt(af(other), 'cancel-one', { kind: 'not_submitted', outcome: 'cancelled', reason: 'never submitted' });
    const cancelled = current(repos, other.taskId);
    x.retryAttempt(af(cancelled), { decisionId: 'retry-3', actor: ownerActor, action: 'retry', allowDuplicateEffects: true, resourceChecks: [], evidenceRefs: ['operator'] }, []);
    const second = repos.execution.getTaskExecution(other.taskId)!.attempts.find(a => a.number === 2)!;
    expect(thrown(() => readAttemptResult({ execution: repos.execution }, fence.sessionId, other.taskId, second.attemptId))).toMatchObject({ code: 'TASK_RESULT_ATTEMPT_CONFLICT' });
  });

  it('enforces the 512 KiB output limit without truncating and still requires a real boundary for cancellations', () => {
    const { repos, x } = open();
    const preparing = claimed(repos, x);
    textEvents(x, preparing, ['x'.repeat(512 * 1024 + 1)]);
    const settled = settleDriver(repos, x, preparing.taskId, utf8Digest('x'.repeat(512 * 1024 + 1)));
    expect(thrown(() => readAttemptResult({ execution: repos.execution }, fence.sessionId, settled.taskId, settled.attemptId))).toMatchObject({ code: 'TASK_RESULT_OUTPUT_TOO_LARGE' });

    const cancelledPreparing = claimed(repos, x, 'cancel');
    const done = x.settleAttempt(af(cancelledPreparing), 'cancel:now', { kind: 'not_submitted', outcome: 'cancelled', reason: 'queue cancel' }).attempt!;
    const read = readAttemptResult({ execution: repos.execution }, fence.sessionId, done.taskId, done.attemptId);
    expect(read).toMatchObject({ status: 'settled', result: { outcome: 'cancelled', output: { text: '', digest: utf8Digest('') } } });
  });

  it('handles surrogate pairs across text event boundaries at exactly 524288 bytes and fails on 524289 bytes', () => {
    const { repos, x } = open();
    // 精确 524288 字节：(524288 - 4) ASCII + '\ud83d' + '\ude00' (emoji 代理对: 4 字节)
    const preparing = claimed(repos, x, 'surrogate-exact');
    const exactChunks = ['a'.repeat(512 * 1024 - 4), '\ud83d', '\ude00'];
    textEvents(x, preparing, exactChunks);
    const exactOutput = exactChunks.join('');
    const exactSettled = settleDriver(repos, x, preparing.taskId, utf8Digest(exactOutput));
    const exactRead = readAttemptResult({ execution: repos.execution }, fence.sessionId, exactSettled.taskId, exactSettled.attemptId);
    expect(exactRead.status).toBe('settled');
    if (exactRead.status !== 'settled') throw new Error('expected settled');
    expect(Buffer.byteLength(exactRead.result.output.text, 'utf8')).toBe(512 * 1024);
    expect(exactRead.result.output.digest).toBe(utf8Digest(exactOutput));

    // 超出 1 字节：(524288 - 3) ASCII + '\ud83d' + '\ude00' = 524289 字节
    const overPreparing = claimed(repos, x, 'surrogate-over');
    const overChunks = ['a'.repeat(512 * 1024 - 3), '\ud83d', '\ude00'];
    textEvents(x, overPreparing, overChunks);
    const overOutput = overChunks.join('');
    const overSettled = settleDriver(repos, x, overPreparing.taskId, utf8Digest(overOutput));
    expect(thrown(() => readAttemptResult({ execution: repos.execution }, fence.sessionId, overSettled.taskId, overSettled.attemptId))).toMatchObject({ code: 'TASK_RESULT_OUTPUT_TOO_LARGE' });
  });

  it('rejects corrupted completed events with wrong settlement, wrong outcome or mismatched ownership', () => {
    const { repos, x, path } = open();
    const preparing = claimed(repos, x, 'corrupt-boundary');
    textEvents(x, preparing, ['valid text']);
    const settled = settleDriver(repos, x, preparing.taskId, utf8Digest('valid text'));

    // 1. settlementId 不匹配
    const db = new Database(path);
    try {
      db.prepare("UPDATE events SET settlement_id = 'different-settlement' WHERE attempt_id = ? AND type = 'completed'").run(settled.attemptId);
    } finally { db.close(); }
    expect(thrown(() => readAttemptResult({ execution: repos.execution }, fence.sessionId, settled.taskId, settled.attemptId))).toMatchObject({ code: 'TASK_RESULT_BOUNDARY_CONFLICT' });

    // 2. outcome 不匹配
    const db2 = new Database(path);
    try {
      db2.prepare("UPDATE events SET settlement_id = ?, data = json_set(data, '$.outcome', 'interrupted') WHERE attempt_id = ? AND type = 'completed'").run(settled.settlementId, settled.attemptId);
    } finally { db2.close(); }
    expect(thrown(() => readAttemptResult({ execution: repos.execution }, fence.sessionId, settled.taskId, settled.attemptId))).toMatchObject({ code: 'TASK_RESULT_BOUNDARY_CONFLICT' });

    // 3. 事件归属不匹配（sessionId 错乱）
    const db3 = new Database(path);
    try {
      db3.prepare("UPDATE events SET data = json_set(data, '$.outcome', 'completed') WHERE attempt_id = ? AND type = 'completed'").run(settled.attemptId);
      db3.prepare("UPDATE events SET session_id = 'other-session' WHERE attempt_id = ? AND type = 'completed'").run(settled.attemptId);
    } finally { db3.close(); }
    expect(thrown(() => readAttemptResult({ execution: repos.execution }, fence.sessionId, settled.taskId, settled.attemptId))).toMatchObject({ code: 'TASK_RESULT_EVENT_ORDER' });

    // 4. 事件归属不匹配（taskId 错乱）
    const db4 = new Database(path);
    try {
      db4.prepare("UPDATE events SET session_id = ? WHERE attempt_id = ? AND type = 'completed'").run(fence.sessionId, settled.attemptId);
      db4.prepare("UPDATE events SET task_id = 'other-task' WHERE attempt_id = ? AND type = 'completed'").run(settled.attemptId);
    } finally { db4.close(); }
    expect(thrown(() => readAttemptResult({ execution: repos.execution }, fence.sessionId, settled.taskId, settled.attemptId))).toMatchObject({ code: 'TASK_RESULT_EVENT_ORDER' });
  });
});
