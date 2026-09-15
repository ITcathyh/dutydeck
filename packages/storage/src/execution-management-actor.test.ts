import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalExecutionJson, type ExecutionActor, type TaskAttempt, type TaskRequestV1 } from '@dutydeck/shared';
import { createRepositories } from './index.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const actions = ['cancel', 'promote', 'confirm_result', 'retry', 'interrupt'] as const;
type Action = typeof actions[number];
const actor: ExecutionActor = { kind: 'channel', id: 'alice', appId: 'appA' };
const owner: ExecutionActor = { kind: 'installation_owner', id: 'installation_owner' };
const hash = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
function rows(db: Database.Database): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
  return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
}
function fixture(action: Action, source: 'lark' | 'work_item', originalActor: ExecutionActor = actor) {
  const directory = mkdtempSync(join(tmpdir(), 'execution-management-actor-'));
  const file = join(directory, 'state.db');
  const repos = createRepositories(file, { newDatabaseAuthority: 'ledger_v1' });
  const claim = repos.control.attachRuntime('actor-regression');
  const x = repos.execution.bind(claim);
  const db = new Database(file);
  cleanup.push(() => { claim.release(); repos.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const fence = { sessionId: 'session', runId: 'run' };
  const timestamp = new Date().toISOString();
  x.createSession({ id: fence.sessionId, runId: fence.runId, agentId: 'fixture', cwd: directory, state: 'idle', source, sourceId: source === 'lark' ? 'appA:chat:p2p' : 'work-attempt', createdAt: timestamp, updatedAt: timestamp });
  const request: TaskRequestV1 = { version: 1, namespace: source, key: action, sessionId: fence.sessionId, actor: originalActor, prompt: 'fixture', mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: null };
  const content = { version: 2 as const, prompt: request.prompt, executionContext: { actorId: originalActor.kind === 'unspecified' ? undefined : originalActor.id, agentPrompt: request.prompt }, contentSources: [], executionOptions: { permissionMode: 'ask' as const } };
  const accepted = x.acceptTask(fence, request, { ...content, digest: hash(content) }, 'back').task!;
  let attempt: TaskAttempt | undefined;
  const attemptFence = () => {
    if (!attempt) throw new Error('Attempt fixture missing');
    return { ...fence, taskId: attempt.taskId, attemptId: attempt.attemptId, expectedRevision: attempt.revision };
  };
  if (!['cancel', 'promote'].includes(action)) {
    attempt = x.claimNext(fence)!.attempt!;
    if (action !== 'interrupt') {
      attempt = x.markSubmissionPending(attemptFence(), { submissionId: 'submission', inputDigest: hash('fixture'), resourceRefs: [], authorizationRefs: [] }).attempt!;
      attempt = x.markReconcileRequired(attemptFence(), { reasonId: 'unknown', code: 'FIXTURE_UNKNOWN', evidenceRefs: [] }).attempt!;
    }
  }
  const invoke = (supplied: ExecutionActor) => {
    const base = { decisionId: `decision:${action}`, actor: supplied, evidenceRefs: ['fixture'], resourceChecks: [] };
    switch (action) {
      case 'cancel': return x.cancelQueued(fence, accepted.id, accepted.revision, { ...base, action: 'cancel' });
      case 'promote': return x.promoteQueued(fence, accepted.id, accepted.revision, { operationId: 'promote', actor: supplied, interrupt: false });
      case 'confirm_result': return x.settleAttempt(attemptFence(), 'manual', { kind: 'manual', outcome: 'failed', decision: { ...base, action: 'confirm_result' } });
      case 'retry': return x.retryAttempt(attemptFence(), { ...base, action: 'retry', allowDuplicateEffects: true }, []);
      case 'interrupt': return x.recordInterruptIntent(attemptFence(), { operationId: 'interrupt', actor: supplied });
    }
  };
  return { db, repos, accepted, invoke };
}

describe('Execution management App boundary', () => {
  for (const source of ['lark', 'work_item'] as const) {
    it.each(actions)(`${source} %s rejects another App without any persistent mutation`, action => {
      const f = fixture(action, source);
      const before = rows(f.db);
      expect(() => f.invoke({ kind: 'channel', id: 'bob', appId: 'appB' })).toThrow(expect.objectContaining({ code: 'TASK_ACTOR_CONFLICT' }));
      expect(rows(f.db)).toBe(before);
      expect(() => f.invoke({ kind: 'channel', id: 'bob', appId: 'appA' })).not.toThrow();
      const committed = rows(f.db);
      expect(() => f.invoke({ kind: 'channel', id: 'bob', appId: 'appA' })).not.toThrow();
      expect(rows(f.db)).toBe(committed);
    });
    it.each(actions)(`${source} %s permits the installation owner`, action => {
      const f = fixture(action, source);
      expect(() => f.invoke(owner)).not.toThrow();
      expect(rows(f.db)).toContain('installation_owner');
    });
  }

  it.each(actions)('%s rechecks current App scope before returning an old operation', action => {
    const f = fixture(action, 'lark');
    f.invoke(actor);
    // Change the persisted Session scope after the original operation committed.
    f.db.prepare('UPDATE sessions SET source_id=? WHERE id=?').run('appB:chat:p2p', 'session');
    const before = rows(f.db);
    expect(() => f.invoke(actor)).toThrow(expect.objectContaining({ code: 'TASK_ACTOR_CONFLICT' }));
    expect(rows(f.db)).toBe(before);
  });

  it.each(actions)('work-item %s cannot infer an App from the caller when original acceptance was by the installer', action => {
    const f = fixture(action, 'work_item', owner);
    const before = rows(f.db);
    expect(() => f.invoke(actor)).toThrow(expect.objectContaining({ code: 'TASK_ACTOR_CONFLICT' }));
    expect(rows(f.db)).toBe(before);
    expect(() => f.invoke(owner)).not.toThrow();
  });
});
