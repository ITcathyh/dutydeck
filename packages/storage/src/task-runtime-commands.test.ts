import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as shared from '@dutydeck/shared';
import type { RuntimeControlClaim, TaskAttempt, TaskRequestV1 } from '@dutydeck/shared';
import * as storage from './index.js';

const directories: string[] = [];
const opened: Array<{ repos: ReturnType<typeof storage.createRepositories>; claim?: RuntimeControlClaim; db: Database.Database }> = [];
afterEach(() => { for (const e of opened.splice(0)) { e.claim?.release(); e.repos.close(); e.db.close(); } for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = '2026-09-14T00:00:00.000Z';
const f = { sessionId: 'session', runId: 'run' };
const hash = (value: unknown) => createHash('sha256').update(shared.canonicalExecutionJson(value)).digest('hex');
const rawHash = (value: string) => createHash('sha256').update(value).digest('hex');
const session = () => ({ id: f.sessionId, runId: f.runId, agentId: 'agent', cwd: '/source', state: 'created' as const, createdAt: at, updatedAt: at });
const request = (key = 'one', options: TaskRequestV1['options'] = {}): TaskRequestV1 => ({ version: 1, namespace: 'runtime', key, sessionId: f.sessionId, actor: { kind: 'unspecified' }, prompt: 'hello', mode: 'queue', skills: [], options, sources: [], sourcePayload: null });
const input = (options = { permissionMode: 'ask' }, version = 2): any => { const content = { version, prompt: 'hello', executionContext: { agentPrompt: 'hello' }, contentSources: [], ...(version === 2 ? { executionOptions: options } : {}) }; return { ...content, digest: hash(content) }; };
const af = (a: TaskAttempt) => ({ ...f, taskId: a.taskId, attemptId: a.attemptId, expectedRevision: a.revision });
function open(legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), 'task-runtime-commands-')); directories.push(dir);
  const path = join(dir, 'test.sqlite'); const repos = storage.createRepositories(path); const db = new Database(path);
  if (!legacy) repos.execution.upgradeLegacy();
  const e = { repos, db, claim: legacy ? undefined : repos.control.attachRuntime('commands') }; opened.push(e);
  const x: any = e.claim ? repos.execution.bind(e.claim) : undefined;
  if (x) x.createSession(session());
  return { ...e, x, entry: e };
}
function queued(x: any, key = 'one') { return x.acceptTask(f, request(key), input(), 'back').task; }
function active(x: any) { queued(x); return x.claimNext(f).attempt as TaskAttempt; }
function workspace(db: Database.Database, cwd = '/prepared', patch: Record<string, unknown> = {}) {
  const record = { schemaVersion: 1, revision: 2, sessionId: f.sessionId, state: 'ready', mode: 'worktree', sourceCwd: '/source', cwd, createdAt: at, updatedAt: at, ...patch };
  const raw = JSON.stringify(record); db.prepare('INSERT INTO configs(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`runtime_workspace:${f.sessionId}`, raw);
  return { expectedCwd: '/source', workspaceRevision: 2, workspaceDigest: rawHash(raw) };
}
function snapshot(db: Database.Database) { return JSON.stringify(['sessions', 'tasks', 'task_attempts', 'task_queue_actions', 'events', 'task_execution_commands', 'configs'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())); }
function allTables(db: Database.Database) { return JSON.stringify((db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as {name:string}[]).map(({name}) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()])); }
function trigger(db: Database.Database, table: string) { db.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected write'); END`); }

describe('Runtime ledger commands', () => {
  it('exports the single task ID algorithm and reads a synchronous durable high water mark', () => {
    const { repos, x, db } = open();
    expect((storage as any).executionTaskId('runtime', f.sessionId, 'one')).toBe(`task_v1_${hash(['runtime', f.sessionId, 'one'])}`);
    expect((repos.events as any).highWaterMark(f.sessionId)).toBe(0);
    const t = queued(x); expect(t.id).toBe((storage as any).executionTaskId('runtime', f.sessionId, 'one'));
    expect((repos.events as any).highWaterMark(f.sessionId)).toBe(1);
    db.prepare('UPDATE events SET sequence=91').run(); expect((repos.events as any).highWaterMark(f.sessionId)).toBe(91); expect((repos.events as any).highWaterMark('missing')).toBe(0);
  });

  it('freezes V2 effective options and rejects new V1, missing options, credentials and explicit-option mismatches', () => {
    const { x } = open();
    expect(() => x.acceptTask(f, request(), input({}, 1), 'back')).toThrow(/EXECUTION_INVALID_INPUT/);
    expect(() => x.acceptTask(f, request(), input({} as any), 'back')).toThrow(/EXECUTION_INVALID_INPUT/);
    expect(() => x.acceptTask(f, request(), input({ permissionMode: 'ask', env: { TOKEN: 'secret' } } as any), 'back')).toThrow(/EXECUTION_INVALID_INPUT/);
    expect(() => x.acceptTask(f, request('mismatch', { model: 'A' }), input(), 'back')).toThrow(/TASK_INPUT_OPTIONS_CONFLICT/);
    const options = { model: 'A', reasoningEffort: 'high', permissionMode: 'ask' };
    const first = x.acceptTask(f, request('v2', { model: 'A' }), input(options), 'back');
    expect(first.accepted.input).toEqual(input(options)); expect(input(options).digest).not.toBe(input().digest);
    expect(x.acceptTask(f, request('v2', { model: 'A' }), input({ ...options, model: 'later-default' }), 'back').accepted.input).toEqual(first.accepted.input);
  });

  it('preserves historical V1 JSON and digest, replays it, and blocks a new submission or retry without options', () => {
    const { x, repos, db } = open(); const task = queued(x); const legacy = input({}, 1); const raw = JSON.stringify(legacy);
    db.prepare('UPDATE task_requests SET accepted_json=? WHERE task_id=?').run(raw, task.id);
    expect(x.lookupAccepted(request()).input).toEqual(legacy); expect(x.acceptTask(f, request(), legacy, 'back').replayed).toBe(true);
    expect(() => x.claimNext(f)).toThrow(/INPUT_OPTIONS_UNVERIFIABLE/);
    expect(repos.execution.getTaskExecution(task.id)!.blockers.some(b => b.code === 'INPUT_OPTIONS_UNVERIFIABLE')).toBe(true);
    db.prepare('UPDATE task_requests SET accepted_json=? WHERE task_id=?').run(JSON.stringify(input()), task.id);
    const a = x.claimNext(f).attempt;
    db.prepare('UPDATE task_requests SET accepted_json=? WHERE task_id=?').run(raw, task.id);
    expect(() => x.markSubmissionPending(af(a), { submissionId: 'submit', inputDigest: hash('final'), resourceRefs: [], authorizationRefs: [] })).toThrow(/INPUT_OPTIONS_UNVERIFIABLE/);
    const settled = x.settleAttempt(af(a), 'cancelled', { kind: 'not_submitted', outcome: 'cancelled', reason: 'old options unavailable' }).attempt;
    expect(() => x.retryAttempt(af(settled), { decisionId: 'retry', actor: { kind: 'installation_owner', id: 'installation_owner' }, action: 'retry', allowDuplicateEffects: true, resourceChecks: [], evidenceRefs: ['operator'] }, [])).toThrow(/INPUT_OPTIONS_UNVERIFIABLE/);
    expect(db.prepare('SELECT accepted_json FROM task_requests WHERE task_id=?').pluck().get(task.id)).toBe(raw);
  });

  it('retains the actual V1 snapshot produced by legacy conversion without synthesizing execution options', async () => {
    const { repos, db } = open(true); await repos.sessions.save(session());
    const id = `task_${createHash('sha256').update(`${f.sessionId}\0legacy`).digest('hex')}`;
    await repos.tasks.save({ id, sessionId: f.sessionId, prompt: 'hello', status: 'queued', executionContext: { agentPrompt: 'hello' }, createdAt: at, updatedAt: at });
    repos.execution.upgradeLegacy(); const raw = db.prepare('SELECT accepted_json FROM task_requests WHERE task_id=?').pluck().get(id) as string;
    const accepted = repos.execution.lookupAccepted(request('legacy'))!; expect(accepted.input).toEqual(input({}, 1)); expect(accepted.replayValidation).toBe('legacy_partial');
    repos.execution.upgradeLegacy(); expect(db.prepare('SELECT accepted_json FROM task_requests WHERE task_id=?').pluck().get(id)).toBe(raw);
  });

  it('finalizes matching raw workspace evidence atomically and handles lost responses without rewriting history', () => {
    const { x, repos, db } = open(); const proof = workspace(db);
    const ready = x.finalizeSessionWorkspace(f, proof); expect(ready.cwd).toBe('/prepared'); expect(ready.runId).toBe(f.runId);
    const a = active(x); x.settleAttempt(af(a), 'done', { kind: 'not_submitted', outcome: 'cancelled', reason: 'done' });
    const before = snapshot(db); expect(x.finalizeSessionWorkspace(f, proof).cwd).toBe(ready.cwd); expect(snapshot(db)).toBe(before);
    expect(x.replaceSessionRun(f, 'next-run', []).runId).toBe('next-run');
    expect(() => x.finalizeSessionWorkspace(f, proof)).toThrow(/SESSION_RUN_CONFLICT/);
    expect(repos.execution.getTaskExecution(a.taskId)!.attempts).toHaveLength(1);
  });

  it('rejects stale, mismatched, not-ready, and unverified workspace proofs without writes', () => {
    const { x, db } = open(); const proof = workspace(db); const before = snapshot(db);
    for (const patch of [{ expectedCwd: '/wrong' }, { workspaceRevision: 3 }, { workspaceDigest: hash('other') }]) expect(() => x.finalizeSessionWorkspace(f, { ...proof, ...patch })).toThrow();
    expect(snapshot(db)).toBe(before);
    for (const patch of [{ state: 'preparing' }, { sessionId: 'other' }]) { const changed = workspace(db, '/prepared', patch); expect(() => x.finalizeSessionWorkspace(f, changed)).toThrow(); }
    workspace(db); const raw = db.prepare('SELECT value FROM configs').pluck().get() as string; db.prepare('UPDATE configs SET value=?').run(raw+' ');
    expect(() => x.finalizeSessionWorkspace(f, proof)).toThrow(/WORKSPACE_PROOF_CONFLICT/);
  });

  it('blocks cwd changes for history, archive and unsafe resources but keeps same-cwd proof as a true no-op', () => {
    const { x, repos, db } = open(); const r = x.beforeCreate(f, { resourceId: 'pending', kind: 'operation' }); const proof = workspace(db);
    expect(() => x.finalizeSessionWorkspace(f, proof)).toThrow(expect.objectContaining({code:'SESSION_RESOURCE_BLOCKED'}));
    const same = workspace(db, '/source'); const before = snapshot(db); expect(x.finalizeSessionWorkspace(f, same).cwd).toBe('/source'); expect(snapshot(db)).toBe(before);
    expect(repos.execution.getSessionResourceBlockers(f.sessionId).some(b => b.resourceId === r.resourceId)).toBe(true);
    x.creationFinished(f, r.resourceId, r.revision, 'not_created'); const a = active(x); x.settleAttempt(af(a), 'done', { kind: 'not_submitted', outcome: 'cancelled', reason: 'done' });
    x.patchSession(f, { state: 'failed' }); const historyProof = workspace(db); expect(() => x.finalizeSessionWorkspace(f, historyProof)).toThrow(/SESSION_WORKSPACE_HISTORY/);
  });

  it('rolls back workspace projection failure and rejects a stale database claim', () => {
    const { x, db, entry, repos } = open(); const proof = workspace(db);
    db.exec("CREATE TRIGGER fail_cwd BEFORE UPDATE OF cwd ON sessions BEGIN SELECT RAISE(ABORT,'injected cwd'); END"); const before = snapshot(db);
    expect(() => x.finalizeSessionWorkspace(f, proof)).toThrow(/injected cwd/); expect(snapshot(db)).toBe(before); db.exec('DROP TRIGGER fail_cwd');
    entry.claim!.release(); entry.claim = repos.control.attachRuntime('replacement'); expect(() => x.finalizeSessionWorkspace(f, proof)).toThrow(/DATABASE_RUNTIME_CLAIM_REVOKED/);
  });

  it('records a direct interrupt without a queued Task and never retargets an old replay', () => {
    const { x, db } = open(); const a = active(x); const op = { operationId: 'interrupt', actor: { kind: 'installation_owner', id: 'installation_owner' } };
    const committed = x.recordInterruptIntent(af(a), op); expect(committed.action).toMatchObject({ source: 'interrupt', taskId: a.taskId, target: { taskId: a.taskId, attemptId: a.attemptId, runId: a.runId } });
    expect(committed.task.interruptedByActor).toBe('installation_owner'); expect(committed.task.revision).toBeGreaterThan(1); expect(committed.attempt.state).toBe('preparing'); expect(committed.session.state).toBe('interrupting');
    expect(db.prepare('SELECT COUNT(*) FROM tasks').pluck().get()).toBe(1); const high = db.prepare('SELECT MAX(sequence) FROM events').pluck().get();
    expect(x.recordInterruptIntent(af(a), op).replayed).toBe(true); expect(db.prepare('SELECT MAX(sequence) FROM events').pluck().get()).toBe(high);
    x.settleAttempt(af(committed.attempt), 'done', { kind: 'not_submitted', outcome: 'cancelled', reason: 'stop' }); queued(x, 'later'); const later = x.claimNext(f).attempt;
    const before = snapshot(db); expect(x.recordInterruptIntent(af(a), op).action.target.attemptId).toBe(a.attemptId); expect(snapshot(db)).toBe(before);
    expect(() => x.recordInterruptIntent(af(later), op)).toThrow(/EXECUTION_OPERATION_CONFLICT/);
  });

  it('does not infer an actor, preserves known interrupt attribution and rejects cross-source action IDs', () => {
    const { x, db } = open(); const a = active(x);
    expect(() => x.recordInterruptIntent(af(a), { operationId: 'missing' })).toThrow(/EXECUTION_INVALID_INPUT/);
    const known = x.recordInterruptIntent(af(a), { operationId: 'known', actor: { kind: 'installation_owner', id: 'installation_owner' } });
    const anonymous = x.recordInterruptIntent(af(known.attempt), { operationId: 'anonymous', actor: { kind: 'unspecified' } }); expect(anonymous.task.interruptedByActor).toBe('installation_owner');
    const queuedTask = queued(x, 'queued'); x.promoteQueued(f, queuedTask.id, queuedTask.revision, { operationId: 'promotion', actor: { kind: 'unspecified' }, interrupt: true }); const before = snapshot(db);
    expect(() => x.recordInterruptIntent(af(anonymous.attempt), { operationId: 'promotion', actor: { kind: 'unspecified' } })).toThrow(); expect(snapshot(db)).toBe(before);
  });

  it('rolls back interrupt intent, actor, Session and all events together when audit insertion fails', () => {
    const { x, db } = open(); const a = active(x); trigger(db, 'events'); const before = snapshot(db);
    expect(() => x.recordInterruptIntent(af(a), { operationId: 'audit-failure', actor: { kind: 'installation_owner', id: 'installation_owner' } })).toThrow(/injected write/); expect(snapshot(db)).toBe(before);
  });

  it('patches final Session state and error with a single durable event and idempotent replay', () => {
    const { x, db } = open(); const failed = x.patchSessionState(f, 'failed', { state: 'failed', error: 'old error' });
    expect(failed.events).toHaveLength(1); expect(failed.events[0].data).toEqual({ state: 'failed', error: 'old error' });
    const cleared = x.patchSessionState(f, 'idle', { state: 'idle', error: null }); expect(cleared.session.error).toBeUndefined(); expect(cleared.events[0].data).toEqual({ state: 'idle', error: null });
    const before = snapshot(db); expect(x.patchSessionState(f, 'failed', { state: 'failed', error: 'old error' }).replayed).toBe(true); expect(snapshot(db)).toBe(before);
    expect(() => x.patchSessionState(f, 'idle', { state: 'failed' })).toThrow(/EXECUTION_OPERATION_CONFLICT/);
    expect(() => x.patchSessionState(f, 'undefined', { state: 'idle', error: undefined })).toThrow(/EXECUTION_INVALID_INPUT/);
  });

  it('fences lifecycle and Attempt state transitions, preserving suspended work and refusing unsafe stopped', () => {
    const { x, db } = open(); const a = active(x);
    expect(() => x.patchSessionState(f, 'lifecycle', { state: 'failed' })).toThrow(/SESSION_EXECUTION_BUSY/);
    for (const state of ['completed', 'failed', 'interrupted', 'stopped']) expect(() => x.patchSessionState(af(a), `result-${state}`, { state })).toThrow(/ATTEMPT_STATE_PATCH_INVALID/);
    const status = x.patchSessionState(af(a), 'tool', { state: 'running_tool' }); expect(status.events[0].attemptId).toBe(a.attemptId);
    x.suspendUnsubmitted(af(a)); x.patchSessionState(f, 'stopped', { state: 'stopped' }); expect(db.prepare('SELECT state FROM task_attempts').pluck().get()).toBe('suspended');
    x.patchSession(f, { state: 'created' }); x.beforeCreate(f, { resourceId: 'pending', kind: 'operation' });
    expect(() => x.patchSessionState(f, 'unsafe-stop', { state: 'stopped' })).toThrow(expect.objectContaining({code:'SESSION_RESOURCE_BLOCKED'}));
    expect(x.patchSessionState(f, 'startup-failed', { state: 'failed', error: 'resource unknown' }).blockers.length).toBeGreaterThan(0);
  });

  it('rolls back Session and event state atomically and rejects commands bound to an old claim', () => {
    const { x, db, entry, repos } = open(); trigger(db, 'events'); const before = snapshot(db);
    expect(() => x.patchSessionState(f, 'atomic', { state: 'starting' })).toThrow(/injected write/); expect(snapshot(db)).toBe(before); db.exec('DROP TRIGGER fail_write');
    entry.claim!.release(); entry.claim = repos.control.attachRuntime('new-runtime'); expect(() => x.patchSessionState(f, 'stale', { state: 'starting' })).toThrow(/DATABASE_RUNTIME_CLAIM_REVOKED/);
  });

  it('strictly decodes canonical/legacy admissions and only known, bounded Attempt results', () => {
    const admission = (shared as any).taskAdmissionV1Schema; const result = (shared as any).attemptResultV1Schema;
    const canonical = { version: 1, kind: 'canonical', taskIdVersion: 'v1', taskId: 'task', request: request() };
    expect(admission.parse(canonical)).toEqual(canonical); expect(admission.parse({ version: 1, kind: 'legacy_partial', taskIdVersion: 'legacy', taskId: 'old' }).request).toBeUndefined();
    expect(() => admission.parse({ ...canonical, request: undefined })).toThrow(); expect(() => admission.parse({ ...canonical, taskIdVersion: 'legacy' })).toThrow();
    const good = { version: 1, taskId: 'task', attemptId: 'attempt', settlementId: 'settlement', throughSequence: 99, outcome: 'completed', output: { text: 'done', digest: hash('done') } };
    expect(result.parse(good)).toEqual(good); for (const patch of [{ outcome: 'unknown' }, { throughSequence: 0 }, { throughSequence: Infinity }, { extra: true }]) expect(() => result.parse({ ...good, ...patch })).toThrow();
  });
  it('allows submitted historical V1 to attach its original turn under a new claim', () => {
    const {x,db,repos,entry}=open();const a=active(x);
    const pending=x.beforeCreate(f,{resourceId:'original',kind:'tmux'});
    const bound=x.spawned(f,pending.resourceId,pending.revision,{identityId:'tmux-original',kind:'tmux',locator:{session:'test'}});
    const created=x.creationFinished(f,bound.resourceId,bound.revision,'created');
    const resource=x.observed(f,created.resourceId,created.revision,{observationId:'live',state:'live',identityId:'tmux-original',evidenceRef:'verified-original',observedAt:at});
    const recovery={kind:'pty-jsonl-v1',turnId:'original-turn',transcript:{offset:0}};
    const submitted=x.markSubmissionPending(af(a),{submissionId:'original-submit',inputDigest:hash('final'),resourceRefs:[{resourceId:resource.resourceId,identityId:'tmux-original'}],authorizationRefs:[],recovery}).attempt;
    const raw=JSON.stringify(input({},1));db.prepare('UPDATE task_requests SET accepted_json=? WHERE task_id=?').run(raw,a.taskId);
    entry.claim!.release();entry.claim=repos.control.attachRuntime('recovery');const next=repos.execution.bind(entry.claim);
    const attached=next.recoverAttempt(af(submitted),{kind:'original_turn',decisionId:'attach',submissionId:'original-submit',recovery:recovery as any,resources:[{resourceId:resource.resourceId,expectedRevision:resource.revision,observationId:'live'}],attached:true});
    expect(attached.attempt!.attemptId).toBe(a.attemptId);expect(attached.attempt!.state).toBe('active');expect(attached.attempt!.submission!.submissionId).toBe('original-submit');
    expect(repos.execution.lookupAccepted(request())!.input!.version).toBe(1);expect(db.prepare('SELECT accepted_json FROM task_requests WHERE task_id=?').pluck().get(a.taskId)).toBe(raw);
  });

  it('refuses archive/history cwd changes and never clears archived or stopped same-cwd facts', () => {
    const {x,db}=open();x.patchSession(f,{archivedAt:at});let proof=workspace(db);
    expect(()=>x.finalizeSessionWorkspace(f,proof)).toThrow(/SESSION_WORKSPACE_STATE_CONFLICT/);
    proof=workspace(db,'/source');const before=snapshot(db);expect(x.finalizeSessionWorkspace(f,proof).archivedAt).toBe(at);expect(snapshot(db)).toBe(before);
  });

  it('permits healthy owned resources for idle but refuses live-resource stopped and unknown Attempt lifecycle writes', () => {
    const {x}=open();const r=x.beforeCreate(f,{resourceId:'resource',kind:'process'});
    const spawned=x.spawned(f,r.resourceId,r.revision,{identityId:'process',kind:'process',locator:{pid:1}});
    const created=x.creationFinished(f,spawned.resourceId,spawned.revision,'created');
    x.observed(f,created.resourceId,created.revision,{observationId:'healthy',state:'live',identityId:'process',evidenceRef:'local-observation',observedAt:at});
    expect(x.patchSessionState(f,'healthy-idle',{state:'idle'}).session.state).toBe('idle');
    expect(()=>x.patchSessionState(f,'live-stopped',{state:'stopped'})).toThrow(expect.objectContaining({code:'SESSION_RESOURCE_BLOCKED'}));
    const a=active(x);const submitted=x.markSubmissionPending(af(a),{submissionId:'submit',inputDigest:hash('final'),resourceRefs:[],authorizationRefs:[]}).attempt;
    const unknown=x.markReconcileRequired(af(submitted),{reasonId:'unknown',code:'UNKNOWN',evidenceRefs:['closed']}).attempt;
    expect(()=>x.patchSessionState(f,'unknown-failed',{state:'failed'})).toThrow(/SESSION_EXECUTION_BUSY/);
    expect(()=>x.patchSessionState(af(unknown),'unknown-thinking',{state:'thinking'})).toThrow(/ATTEMPT_STATE_PATCH_INVALID/);
  });

  it('reads accepted facts by ID strictly without a claim, preserving V1 bytes and legacy absence', async () => {
    const {x,repos,db,entry}=open();const accepted=x.acceptTask(f,request(),input(),'back');
    entry.claim!.release();entry.claim=undefined;const reader:any=repos.execution;
    let before=snapshot(db);expect(reader.getAcceptedTask(accepted.task.id)).toEqual(accepted.accepted);expect(reader.getAcceptedTask('absent')).toBeUndefined();expect(snapshot(db)).toBe(before);
    const raw=JSON.stringify(input({},1));db.prepare('UPDATE task_requests SET accepted_json=? WHERE task_id=?').run(raw,accepted.task.id);
    before=snapshot(db);expect(reader.getAcceptedTask(accepted.task.id).input).toEqual(input({},1));expect(snapshot(db)).toBe(before);
    const badRequest={...request(),unexpected:'field'};db.prepare('UPDATE task_requests SET request_json=? WHERE task_id=?').run(JSON.stringify(badRequest),accepted.task.id);
    before=snapshot(db);expect(()=>reader.getAcceptedTask(accepted.task.id)).toThrow(/EXECUTION_INVALID_INPUT/);expect(snapshot(db)).toBe(before);
    db.prepare('UPDATE task_requests SET request_json=?,accepted_json=? WHERE task_id=?').run(JSON.stringify(request()),JSON.stringify({...input({},1),extra:true}),accepted.task.id);
    expect(()=>reader.getAcceptedTask(accepted.task.id)).toThrow(/EXECUTION_INVALID_INPUT/);
    const legacy=open(true);await legacy.repos.sessions.save(session());
    for(const [id,executionContext] of [['legacy-input',{agentPrompt:'hello'}],['legacy-missing',undefined]] as const)await legacy.repos.tasks.save({id,sessionId:f.sessionId,prompt:'hello',status:'queued',...(executionContext?{executionContext}:{}),createdAt:at,updatedAt:at});
    legacy.repos.execution.upgradeLegacy();const query:any=legacy.repos.execution;const legacyBefore=snapshot(legacy.db);
    expect(query.getAcceptedTask('legacy-input')).toMatchObject({replayValidation:'legacy_partial',input:input({},1)});
    expect(query.getAcceptedTask('legacy-missing').input).toBeUndefined();expect(query.getAcceptedTask('legacy-missing').request).toBeUndefined();expect(snapshot(legacy.db)).toBe(legacyBefore);
    legacy.db.prepare("UPDATE task_requests SET accepted_json=? WHERE task_id='legacy-input'").run(JSON.stringify(''));const invalid=snapshot(legacy.db);
    expect(()=>query.getAcceptedTask('legacy-input')).toThrow();expect(snapshot(legacy.db)).toBe(invalid);
  });

  it('marks a submitted orphan under a new controller without taking over original evidence and replays exactly', () => {
    const {x,repos,db,entry}=open();const a=active(x);
    const submitted=x.markSubmissionPending(af(a),{submissionId:'orphan-submit',inputDigest:hash('final'),resourceRefs:[],authorizationRefs:['original-auth'],recovery:{kind:'pty-jsonl-v1',turnId:'old-turn',transcript:{offset:9}}}).attempt;
    x.beforeCreate(f,{resourceId:'unfinished-original',kind:'operation'});
    const reason={reasonId:'orphan',code:'CONTROLLER_EXITED',evidenceRefs:['process-proof']};
    expect(()=>x.markOrphanedAttempt(af(submitted),reason)).toThrow(/ATTEMPT_CONTROLLER_NOT_ORPHANED/);
    entry.claim!.release();entry.claim=repos.control.attachRuntime('new-controller');const current:any=repos.execution.bind(entry.claim);
    expect(()=>x.markOrphanedAttempt(af(submitted),reason)).toThrow(/DATABASE_RUNTIME_CLAIM_REVOKED/);
    const resources=JSON.stringify(repos.execution.getResources(f.sessionId));const committed=current.markOrphanedAttempt(af(submitted),reason);
    expect(committed.task.status).toBe('reconcile_required');expect(committed.session.state).toBe('interrupted');
    expect(committed.attempt).toMatchObject({state:'reconcile_required',reconcileReason:reason,controller:submitted.controller,submissionController:submitted.submissionController,submission:submitted.submission,recoveryControllers:submitted.recoveryControllers});
    expect(committed.attempt.submissionState).toBe(submitted.submissionState);expect(committed.attempt.revision).toBe(submitted.revision+1);expect(JSON.stringify(repos.execution.getResources(f.sessionId))).toBe(resources);
    expect(committed.events.some((event:any)=>event.type==='completed')).toBe(false);const before=snapshot(db);
    expect(current.markOrphanedAttempt(af(submitted),reason).replayed).toBe(true);expect(snapshot(db)).toBe(before);
    expect(()=>current.markOrphanedAttempt(af(submitted),{...reason,code:'DIFFERENT'})).toThrow(/EXECUTION_OPERATION_CONFLICT/);expect(snapshot(db)).toBe(before);
    expect(()=>current.markOrphanedAttempt({...af(committed.attempt),expectedRevision:submitted.revision},{...reason,reasonId:'stale'})).toThrow(/ATTEMPT_REVISION_CONFLICT/);
  });

  it('rolls back an orphan reason and state if event persistence fails, with no mutation of prior recovery evidence', () => {
    const {x,repos,db,entry}=open();const a=active(x);const submitted=x.markSubmissionPending(af(a),{submissionId:'submit',inputDigest:hash('final'),resourceRefs:[],authorizationRefs:[]}).attempt;
    const previous=x.markReconcileRequired(af(submitted),{reasonId:'previous',code:'DISCONNECTED',evidenceRefs:['original']}).attempt;
    entry.claim!.release();entry.claim=repos.control.attachRuntime('new');const current:any=repos.execution.bind(entry.claim);
    trigger(db,'events');const before=snapshot(db);expect(()=>current.markOrphanedAttempt(af(previous),{reasonId:'next',code:'ORPHAN',evidenceRefs:['proof']})).toThrow(/injected write/);expect(snapshot(db)).toBe(before);
    db.exec('DROP TRIGGER fail_write');const committed=current.markOrphanedAttempt(af(previous),{reasonId:'next',code:'ORPHAN',evidenceRefs:['proof']});
    expect(committed.attempt.controller).toEqual(previous.controller);expect(committed.attempt.recoveryControllers).toEqual(previous.recoveryControllers);
  });

  it.each(['preparing','suspended','settled','legacy_unresolved'] as const)('rejects orphan marking for %s without state reinterpretation', async state => {
    const e=open(state==='legacy_unresolved');let a:TaskAttempt;
    if(state==='legacy_unresolved') {
      await e.repos.sessions.save(session());for(const id of ['first','second'])await e.repos.tasks.save({id,sessionId:f.sessionId,status:'running',prompt:'hello',createdAt:at,updatedAt:at});
      e.repos.execution.upgradeLegacy();a=e.repos.execution.getTaskExecution('first')!.currentAttempt!;
    }else{
      a=active(e.x);if(state==='suspended')a=e.x.suspendUnsubmitted(af(a)).attempt;if(state==='settled')a=e.x.settleAttempt(af(a),'settled',{kind:'not_submitted',outcome:'cancelled',reason:'done'}).attempt;
      e.entry.claim!.release();
    }
    e.entry.claim=e.repos.control.attachRuntime('replacement');const current:any=e.repos.execution.bind(e.entry.claim);const before=snapshot(e.db);
    expect(()=>current.markOrphanedAttempt(af(a),{reasonId:'refused',code:'ORPHAN',evidenceRefs:['proof']})).toThrow(/ATTEMPT_NOT_SUBMITTED/);expect(snapshot(e.db)).toBe(before);
  });

  it('recognizes only the exact empty stop-block tombstone while retaining all actual resource evidence', async () => {
    const {x,repos}=open();const stop=`runtime_driver_stop_block:${f.sessionId}`;
    await repos.config.set(stop,'');expect(repos.execution.getSessionResourceBlockers(f.sessionId)).toEqual([]);
    await repos.config.set(stop,'{bad');expect(repos.execution.getSessionResourceBlockers(f.sessionId)).toContainEqual(expect.objectContaining({code:'RESOURCE_EVIDENCE_INVALID'}));
    await repos.config.set(stop,JSON.stringify({reason:'still-live'}));expect(repos.execution.getSessionResourceBlockers(f.sessionId)).toContainEqual(expect.objectContaining({code:'DRIVER_STOP_BLOCKED'}));
    await repos.config.set(stop,'');const pending=x.beforeCreate(f,{resourceId:'pending-stays',kind:'operation'});
    for(const state of ['unknown','live'] as const){
      const isolated=open();await isolated.repos.config.set(stop,'');
      const start=isolated.x.beforeCreate(f,{resourceId:state,kind:'process'});
      const spawned=isolated.x.spawned(f,start.resourceId,start.revision,{identityId:state,kind:'process',locator:{pid:1}});
      const created=isolated.x.creationFinished(f,spawned.resourceId,spawned.revision,'created');
      isolated.x.observed(f,created.resourceId,created.revision,{observationId:state,state,identityId:state,evidenceRef:'retained',observedAt:at});
      const before=JSON.stringify(isolated.repos.execution.getResources(f.sessionId));
      expect(isolated.repos.execution.getSessionResourceBlockers(f.sessionId)).toContainEqual(expect.objectContaining({resourceId:state,code:'DRIVER_RESOURCE_UNSAFE'}));
      expect(JSON.stringify(isolated.repos.execution.getResources(f.sessionId))).toBe(before);
    }
    const beforeResources=JSON.stringify(repos.execution.getResources(f.sessionId));
    expect(repos.execution.getSessionResourceBlockers(f.sessionId)).toContainEqual(expect.objectContaining({resourceId:pending.resourceId,code:'DRIVER_RESOURCE_UNSAFE'}));
    await repos.config.set(`runtime_workspace:${f.sessionId}`,'');await repos.config.set(`runtime_verification:${f.sessionId}:verify`,'');
    expect(repos.execution.getSessionResourceBlockers(f.sessionId).filter(b=>b.code==='RESOURCE_EVIDENCE_INVALID')).toHaveLength(2);
    expect(repos.execution.getResources(f.sessionId)[0]!.stage).toBe('pending');expect(JSON.stringify(repos.execution.getResources(f.sessionId))).toBe(beforeResources);
  });

  it('fences work-item channel interrupts by the original App while allowing other same-App users and the installer', () => {
    const {x,db}=open();const wf={sessionId:'work',runId:'run'};
    x.createSession({...session(),id:wf.sessionId,source:'work_item',sourceId:'work-attempt'});
    const r={...request(),namespace:'work_item',sessionId:wf.sessionId,actor:{kind:'channel',id:'alice',appId:'appA'}};
    const {digest:_,...content}=input();content.executionContext.actorId='alice';const accepted={...content,digest:hash(content)};
    x.acceptTask(wf,r,accepted,'back');const a=x.claimNext(wf).attempt;const fence={...af(a),...wf};
    let before=allTables(db);
    expect(()=>x.recordInterruptIntent(fence,{operationId:'cross-app',actor:{kind:'channel',id:'bob',appId:'appB'}})).toThrow(/TASK_ACTOR_CONFLICT/);expect(allTables(db)).toBe(before);
    const op={operationId:'same-app',actor:{kind:'channel',id:'bob',appId:'appA'}};
    expect(x.recordInterruptIntent(fence,op).task.interruptedByActor).toBe('bob');
    expect(x.recordInterruptIntent(fence,{operationId:'installer',actor:{kind:'installation_owner',id:'installation_owner'}}).task.interruptedByActor).toBe('installation_owner');
    x.settleAttempt(fence,'work-done',{kind:'not_submitted',outcome:'cancelled',reason:'done'});
    x.acceptTask(wf,{...r,key:'next'},accepted,'back');const next=x.claimNext(wf).attempt;
    before=allTables(db);expect(x.recordInterruptIntent(fence,op).action.target.attemptId).toBe(a.attemptId);expect(allTables(db)).toBe(before);
    expect(()=>x.recordInterruptIntent({...af(next),...wf},op)).toThrow(/EXECUTION_OPERATION_CONFLICT/);expect(allTables(db)).toBe(before);
  });

  it.each(['missing_request','legacy_missing_request','installer_request'] as const)('does not infer a work-item App from the interrupter for %s', origin => {
    const {x,db}=open();const wf={sessionId:'work',runId:'run'};
    x.createSession({...session(),id:wf.sessionId,source:'work_item',sourceId:'work-attempt'});
    const actor={kind:'installation_owner',id:'installation_owner'};
    const r={...request(),namespace:'work_item',sessionId:wf.sessionId,actor};const {digest:_,...content}=input();content.executionContext.actorId=actor.id;
    x.acceptTask(wf,r,{...content,digest:hash(content)},'back');const a=x.claimNext(wf).attempt;const fence={...af(a),...wf};
    if(origin!=='installer_request')db.prepare('DELETE FROM task_requests WHERE task_id=?').run(a.taskId);
    if(origin==='legacy_missing_request')db.prepare("UPDATE tasks SET digest_version='legacy_unverifiable' WHERE id=?").run(a.taskId);
    const before=allTables(db);expect(()=>x.recordInterruptIntent(fence,{operationId:'unknown-app',actor:{kind:'channel',id:'bob',appId:'appA'}})).toThrow();expect(allTables(db)).toBe(before);
    expect(x.recordInterruptIntent(fence,{operationId:'installer',actor}).task.interruptedByActor).toBe(actor.id);
  });

  it.each([1,2])('rejects schema-valid V%s input tampering in every reader without changing persistent bytes', version => {
    const {x,repos,db}=open();const t=queued(x);const original=input({},1);
    const accepted=version===1?original:input();const changed=JSON.parse(JSON.stringify(accepted));
    if(version===1)changed.executionContext.agentPrompt='different';else changed.executionOptions.permissionMode='full-trust';
    db.prepare('UPDATE task_requests SET accepted_json=? WHERE task_id=?').run(JSON.stringify(changed),t.id);const before=allTables(db);
    expect(()=>repos.execution.getAcceptedTask(t.id)).toThrow(/TASK_INPUT_DIGEST_CONFLICT/);expect(allTables(db)).toBe(before);
    expect(()=>repos.execution.lookupAccepted(request())).toThrow(/TASK_INPUT_DIGEST_CONFLICT/);expect(allTables(db)).toBe(before);
    expect(()=>x.lookupAccepted(request())).toThrow(/TASK_INPUT_DIGEST_CONFLICT/);expect(allTables(db)).toBe(before);
    expect(()=>x.acceptTask(f,request(),input(),'back')).toThrow(/TASK_INPUT_DIGEST_CONFLICT/);expect(allTables(db)).toBe(before);
  });

  it('rejects corrupted V2 input before claim, submission and retry with every table unchanged', () => {
    const {x,db}=open();const t=queued(x);const valid=JSON.stringify(input());const corrupt=input();corrupt.executionOptions.permissionMode='full-trust';
    const corruptInput=()=>db.prepare('UPDATE task_requests SET accepted_json=? WHERE task_id=?').run(JSON.stringify(corrupt),t.id);
    const restore=()=>db.prepare('UPDATE task_requests SET accepted_json=? WHERE task_id=?').run(valid,t.id);
    corruptInput();let before=allTables(db);expect(()=>x.claimNext(f)).toThrow(/TASK_INPUT_DIGEST_CONFLICT/);expect(allTables(db)).toBe(before);
    restore();const a=x.claimNext(f).attempt;corruptInput();before=allTables(db);
    expect(()=>x.markSubmissionPending(af(a),{submissionId:'bad-input',inputDigest:hash('final'),resourceRefs:[],authorizationRefs:[]})).toThrow(/TASK_INPUT_DIGEST_CONFLICT/);expect(allTables(db)).toBe(before);
    restore();const settled=x.settleAttempt(af(a),'done',{kind:'not_submitted',outcome:'cancelled',reason:'done'}).attempt;corruptInput();before=allTables(db);
    expect(()=>x.retryAttempt(af(settled),{decisionId:'retry-bad-input',actor:{kind:'installation_owner',id:'installation_owner'},action:'retry',allowDuplicateEffects:true,resourceChecks:[],evidenceRefs:['operator']},[])).toThrow(/TASK_INPUT_DIGEST_CONFLICT/);expect(allTables(db)).toBe(before);
  });

  it.each([1,2])('reads reordered and whitespace-formatted V%s JSON using the original canonical digest', version => {
    const {x,repos,db}=open();const t=queued(x);const accepted=version===1?input({},1):input();
    const raw=JSON.stringify(Object.fromEntries(Object.entries(accepted).reverse()),null,3)+'\n';
    db.prepare('UPDATE task_requests SET accepted_json=? WHERE task_id=?').run(raw,t.id);const before=allTables(db);
    expect(repos.execution.getAcceptedTask(t.id)!.input).toEqual(accepted);expect(repos.execution.lookupAccepted(request())!.input).toEqual(accepted);expect(allTables(db)).toBe(before);
    expect(db.prepare('SELECT accepted_json FROM task_requests WHERE task_id=?').pluck().get(t.id)).toBe(raw);
  });

});
