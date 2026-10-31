import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { canonicalExecutionJson, type TaskAttempt } from '@dutydeck/shared';
import { createRepositories, withOfflineDatabase } from '@dutydeck/storage';
import { readAttemptResult } from '../apps/server/src/task-results.js';
import { createTaskExecutionRepository } from '../packages/storage/src/task-execution.js';
import { previewTerminalPrune, pruneTerminalEvents } from '../scripts/prune-terminal-events.mts';

type Sqlite = Parameters<Parameters<typeof withOfflineDatabase>[1]>[0];
const Database = createRequire(new URL('../packages/storage/package.json', import.meta.url))('better-sqlite3') as new (path: string, options?: { readonly: boolean }) => Sqlite;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const old = '2025-01-01T00:00:00.000Z', before = '2025-02-01T00:00:00.000Z';
const hash = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const fence = (attempt: TaskAttempt) => ({ sessionId: attempt.sessionId, runId: attempt.runId, taskId: attempt.taskId, attemptId: attempt.attemptId, expectedRevision: attempt.revision });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-prune-')); dirs.push(dir);
  const path = join(dir, 'runtime.db');
  const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  const claim = repos.control.attachRuntime('prune-fixture');
  const execution = repos.execution.bind(claim);
  const turns = new Map<string, { taskId: string; attemptId: string }>();
  for (const id of ['safe', 'queued', 'resource', 'unknown-resource', 'steering', 'queue-action', 'queue-blocked', 'attempt-open']) {
    const scope = { sessionId: id, runId: `run-${id}` };
    execution.createSession({ id, runId: scope.runId, agentId: 'agent', state: 'idle', cwd: dir, createdAt: old, updatedAt: old });
    const content = { version: 2 as const, executionOptions: { permissionMode: 'ask' as const }, prompt: 'request', executionContext: { agentPrompt: 'request' }, contentSources: [] };
    execution.acceptTask(scope, { version: 1, namespace: 'runtime', key: 'first', sessionId: id, actor: { kind: 'unspecified' }, prompt: 'request', mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: null }, { ...content, digest: hash(content) }, 'back');
    let attempt = execution.claimNext(scope)!.attempt!;
    attempt = execution.markSubmissionPending(fence(attempt), { submissionId: `submission-${id}`, inputDigest: hash('request'), resourceRefs: [], authorizationRefs: [] }).attempt!;
    execution.appendEvent(fence(attempt), { id: `raw-${id}`, type: 'raw_terminal', timestamp: old, data: { text: `terminal ${id}` } });
    execution.appendEvent(fence(attempt), { id: `output-${id}`, type: 'text', timestamp: old, data: { text: 'done' } });
    if (id === 'queue-blocked') {
      const interrupt = execution.recordInterruptIntent(fence(attempt), { operationId: 'blocked-interrupt', actor: { kind: 'installation_owner', id: 'installation_owner' } });
      attempt = interrupt.attempt!;
      execution.settleQueueAction(scope, interrupt.action.operationId, interrupt.action.revision, {
        evidenceId: 'interrupt-blocked', state: 'blocked', reason: 'original_attempt_not_owned', resourceChecks: []
      });
      expect(execution.getPendingQueueActions(scope).map(action => action.state)).toEqual(['blocked']);
    }
    execution.settleAttempt(fence(attempt), `settlement-${id}`, { kind: 'driver_result', submissionId: `submission-${id}`, outcome: 'completed', outputDigest: createHash('sha256').update('done').digest('hex'), stopReason: 'end_turn', complete: true });
    turns.set(id, { taskId: attempt.taskId, attemptId: attempt.attemptId });
  }
  claim.release(); repos.close();
  const db = new Database(path);
  db.prepare('INSERT INTO configs VALUES (?,?)').run('runtime_driver_stop_block:resource', '{}');
  db.prepare('INSERT INTO driver_resources VALUES (?,?,?,?,?,?,?)').run('invalid-resource', 'unknown-resource', 'run-unknown-resource', null, null, 1, '{}');
  db.prepare("UPDATE tasks SET status='queued' WHERE session_id='queued'").run();
  db.prepare("UPDATE task_attempts SET state='reconcile_required' WHERE session_id='attempt-open'").run();
  db.prepare('INSERT INTO task_steering_operations (id,session_id,run_id,task_id,state,revision,json) VALUES (?,?,?,?,?,?,?)').run('steering-pending', 'steering', 'run-steering', turns.get('steering')!.taskId, 'unknown', 1, '{}');
  db.prepare('INSERT INTO task_queue_actions (id,session_id,task_id,state,revision,json) VALUES (?,?,?,?,?,?)').run('queue-pending', 'queue-action', turns.get('queue-action')!.taskId, 'pending', 1, '{}');
  const safe = turns.get('safe')!;
  let sequence = (db.prepare("SELECT MAX(sequence) AS n FROM events WHERE session_id='safe'").get() as { n: number }).n;
  const add = (id: string, timestamp: string, task: string | null = safe.taskId, attempt: string | null = safe.attemptId, sourceKey: string | null = null) => {
    db.prepare('INSERT INTO events (id,session_id,sequence,type,timestamp,data,task_id,attempt_id,source_key) VALUES (?,?,?,?,?,?,?,?,?)').run(id, 'safe', ++sequence, 'raw_terminal', timestamp, JSON.stringify({ text: id }), task, attempt, sourceKey);
  };
  add('recent', new Date().toISOString()); add('unattributed', old, null, null); add('source-key', old, safe.taskId, safe.attemptId, 'native-source');
  add('artifact-source', old); db.prepare('INSERT INTO configs VALUES (?,?)').run('artifact.snapshot.reference', JSON.stringify({ eventId: 'artifact-source' }));
  add('dangling-attempt', old, safe.taskId, 'not-recorded'); add('tail', old);
  db.close();
  return { path, turns };
}

it('defaults to a byte-for-byte read-only preview and prunes only safe old raw events without changing results or sequence watermarks', async () => {
  const { path, turns } = fixture();
  const bytes = readFileSync(path);
  const files = readdirSync(join(path, '..')), modified = statSync(path).mtimeMs;
  const preview = await pruneTerminalEvents({ database: path, before });
  expect(preview).toMatchObject({ mode: 'dry-run', eligibleEvents: 1, deletedEvents: 0, affectedSessions: 1 });
  expect(preview.protectedReasons).toMatchObject({ unsafe_session: 7, unattributed_event: 2, source_key: 1, referenced_event: 1, session_high_watermark: 1 });
  expect(readFileSync(path)).toEqual(bytes);
  expect(statSync(path).mtimeMs).toBe(modified);
  const added = readdirSync(join(path, '..')).filter(name => !files.includes(name));
  expect(added.every(name => ['runtime.db-wal', 'runtime.db-shm'].includes(name))).toBe(true);
  if (added.includes('runtime.db-wal')) expect(statSync(`${path}-wal`).size).toBe(0);
  if (added.includes('runtime.db-shm')) expect(statSync(`${path}-shm`).size).toBe(32768);
  const db = new Database(path, { readonly: true });
  const allBefore = db.prepare('SELECT * FROM events ORDER BY session_id,sequence').all() as Array<{ id: string; type: string }>;
  const watermarks = db.prepare('SELECT session_id,MAX(sequence) AS sequence FROM events GROUP BY session_id').all();
  const turn = turns.get('safe')!;
  const result = readAttemptResult({ execution: createTaskExecutionRepository(db, {} as never) }, 'safe', turn.taskId, turn.attemptId);
  db.close();
  const applied = await pruneTerminalEvents({ database: path, before, apply: true, expectCount: preview.eligibleEvents, expectBytes: preview.eligibleContentBytes });
  expect(applied.deletedEvents).toBe(1);
  const after = new Database(path, { readonly: true });
  try {
    expect(after.prepare('SELECT * FROM events ORDER BY session_id,sequence').all()).toEqual(allBefore.filter(event => event.id !== 'raw-safe'));
    expect(after.prepare('SELECT session_id,MAX(sequence) AS sequence FROM events GROUP BY session_id').all()).toEqual(watermarks);
    expect(readAttemptResult({ execution: createTaskExecutionRepository(after, {} as never) }, 'safe', turn.taskId, turn.attemptId)).toEqual(result);
    expect(after.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(after.pragma('foreign_key_check')).toEqual([]);
  } finally { after.close(); }
  expect((await pruneTerminalEvents({ database: path, before })).eligibleEvents).toBe(0);
  expect((await pruneTerminalEvents({ database: path, before, apply: true, expectCount: preview.eligibleEvents, expectBytes: preview.eligibleContentBytes })).deletedEvents).toBe(0);
});

it('includes committed WAL-only output in a read-only preview without checkpointing or changing the WAL', async () => {
  const { path, turns } = fixture();
  const writer = new Database(path);
  writer.pragma('wal_autocheckpoint=0');
  const turn = turns.get('safe')!;
  let sequence = (writer.prepare("SELECT MAX(sequence) AS n FROM events WHERE session_id='safe'").get() as { n: number }).n;
  writer.prepare('INSERT INTO events (id,session_id,sequence,type,timestamp,data,task_id,attempt_id) VALUES (?,?,?,?,?,?,?,?)')
    .run('wal-raw', 'safe', ++sequence, 'raw_terminal', old, '{"text":"committed WAL only"}', turn.taskId, turn.attemptId);
  writer.prepare('INSERT INTO events (id,session_id,sequence,type,timestamp,data,task_id,attempt_id) VALUES (?,?,?,?,?,?,?,?)')
    .run('wal-tail', 'safe', ++sequence, 'status', old, '{"state":"idle"}', turn.taskId, turn.attemptId);
  const main = readFileSync(path), wal = readFileSync(`${path}-wal`);
  expect(wal.length).toBeGreaterThan(0);
  try {
    const reader = new Database(path, { readonly: true });
    try { expect(previewTerminalPrune(reader, before).candidates.some(event => event.id === 'wal-raw')).toBe(true); }
    finally { reader.close(); }
    await pruneTerminalEvents({ database: path, before });
    expect(readFileSync(path)).toEqual(main);
    expect(readFileSync(`${path}-wal`)).toEqual(wal);
  } finally { writer.close(); }
});

it('rejects an unreviewed or changed scope and leaves the database usable after rollback', async () => {
  const { path } = fixture();
  await expect(pruneTerminalEvents({ database: path, before, apply: true })).rejects.toThrow('requires --expect-count');
  await expect(pruneTerminalEvents({ database: path, before, apply: true, expectCount: 999, expectBytes: 999 })).rejects.toThrow('scope changed');
  expect((await pruneTerminalEvents({ database: path, before })).eligibleEvents).toBe(1);
  const repos = createRepositories(path);
  try { const claim = repos.control.attachRuntime('after-rollback'); claim.release(); }
  finally { repos.close(); }
  await expect(pruneTerminalEvents({ database: path, before: '2025-02-30' })).rejects.toThrow('--before');
});
