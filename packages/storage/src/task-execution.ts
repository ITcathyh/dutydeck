import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  executionActorSchema, acceptedTaskInputSchema, acceptedTaskInputV2Schema, canonicalExecutionJson, taskExecutionSchemas, taskRequestV1Schema, RuntimeError,
  type AcceptedTask, type AcceptedTaskInput, type AgentEvent, type AttemptFence, type BoundExecutionRepository,
  type CommitResult, type DriverResource, type ExecutionBlocker, type ExecutionController, type ExecutionRepository,
  type ExecutionTask, type ExecutionUpgradeCounts, type ExecutionUpgradeSnapshot, type QueueAction, type RecoveryDecisionInput, type ResourceCheckRef, type Session,
  type SessionFence, type TaskAttempt, type TaskRequestV1, type NativeContextSelection, type NativeContextRef, type NativeContextBinding,
  type LegacyRetirementCandidate, type LegacyRetirementReceipt, type LegacyRetirementResult
} from '@dutydeck/shared';
import type { OpenControl } from './database-control.js';
import { currentProcessIdentity, observeProcess } from './process-identity.js';

const { id, revision, fenceSchema, attemptFenceSchema, checksSchema, decisionSchema, identitySchema, observationSchema, intentSchema, sessionSchema } = taskExecutionSchemas;
function fail(code: string, detail = code): never { throw new RuntimeError(code, detail, 409); }
function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { canonicalExecutionJson(value); return schema.parse(value); } catch { return fail('EXECUTION_INVALID_INPUT'); }
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function executionTaskId(namespace: TaskRequestV1['namespace'], sessionId: string, key: string): string {
  taskRequestV1Schema.shape.namespace.parse(namespace); id.parse(sessionId); id.parse(key);
  return `task_v1_${hash(canonicalExecutionJson([namespace, sessionId, key]))}`;
}
function json(value: unknown) { return JSON.stringify(value); }
function stable(value: unknown) { return canonicalExecutionJson(value); }
function same(a: unknown, b: unknown) { return stable(a) === stable(b); }
function timestamp() { return new Date().toISOString(); }
export const LEGACY_RETIREMENT_NOTICE = '升级已结束旧会话，历史记录保留；原上下文未自动恢复，请用 /new 新建。';
function rowJson<T>(row: unknown): T | undefined { return row ? JSON.parse((row as { json: string }).json) as T : undefined; }
function noCredentials(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:env|app_secret|appSecret|access_token|refresh_token|authorization|password|api_key|apiKey|token|cookie)$/i.test(key)) fail('EXECUTION_CREDENTIAL_PAYLOAD');
    noCredentials(nested);
  }
}

export function createTaskExecutionRepository(db: Database.Database, control: OpenControl): ExecutionRepository {
  const authority = () => (db.prepare('SELECT authority FROM execution_authority WHERE id=1').get() as { authority: 'legacy' | 'ledger_v1' }).authority;
  const session = (sessionId: string): Session => {
    const row = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as Record<string, unknown> | undefined;
    if (!row) fail('SESSION_NOT_FOUND');
    const names: Record<string, string> = { agent_id: 'agentId', run_id: 'runId', source_id: 'sourceId', permission_mode: 'permissionMode', system_prompt: 'systemPrompt', reasoning_effort: 'reasoningEffort', created_at: 'createdAt', updated_at: 'updatedAt', archived_at: 'archivedAt' };
    return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null).map(([k, v]) => [names[k] ?? k, v])) as unknown as Session;
  };
  const task = (taskId: string): ExecutionTask | undefined => {
    const r = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as Record<string, any> | undefined;
    if (!r) return;
    return { id: r.id, sessionId: r.session_id, prompt: r.prompt, status: r.status, revision: r.revision, digestVersion: r.digest_version,
      ...(r.execution_context ? { executionContext: JSON.parse(r.execution_context) } : {}), ...(r.current_attempt_id ? { currentAttemptId: r.current_attempt_id } : {}),
      ...(r.queue_position !== null ? { queuePosition: r.queue_position } : {}), ...(r.interrupted_by_actor ? { interruptedByActor: r.interrupted_by_actor } : {}), createdAt: r.created_at, updatedAt: r.updated_at };
  };
  const attempt = (attemptId: string) => rowJson<TaskAttempt>(db.prepare('SELECT json FROM task_attempts WHERE id=?').get(attemptId));
  const attempts = (sessionId: string) => db.prepare('SELECT json FROM task_attempts WHERE session_id=? ORDER BY number,id').all(sessionId).map(row => rowJson<TaskAttempt>(row)!);
  const readResource = (row: unknown): DriverResource | undefined => {
    if (!row) return;
    const r = parse(taskExecutionSchemas.resource, rowJson<unknown>(row));
    const provenance = r.creationProvenance;
    const closure = r.creationClosure;
    if (provenance && (r.kind !== 'operation' || !same(provenance.controller, r.controller))) fail('RESOURCE_CREATION_PROVENANCE_INVALID');
    if (closure && (!provenance || !['pending', 'unknown'].includes(r.stage) || r.revision !== closure.expectedRevision + 1
      || closure.provenanceDigest !== hash(stable(provenance)) || !same(closure.evidence.creator, provenance.creator))) fail('RESOURCE_CREATION_CLOSURE_INVALID');
    if (r.identity && (r.kind === 'operation' || r.identity.kind !== r.kind)) fail('RESOURCE_IDENTITY_CONFLICT');
    if (r.purpose && (r.kind !== 'remote' || !r.nativeExpected || !r.driverInstanceId)) fail('NATIVE_CONTEXT_INVALID');
    if (r.nativeReplacement && r.purpose !== 'acp_native_context') fail('NATIVE_CONTEXT_INVALID');
    if(r.purpose==='acp_native_context'&&r.identity) {
      const identity=parse(taskExecutionSchemas.nativeIdentitySchema,r.identity.locator),{acpxRecordId,backendSessionId,agentSessionId,defaults,...expected}=identity;
      if(!same(expected,r.nativeExpected)||r.identity.identityId!==`native_${hash(stable([r.resourceId,identity]))}`)fail('NATIVE_CONTEXT_IDENTITY_CONFLICT');
    }
    if(r.nativeBindings?.some(binding=>r.purpose!=='acp_native_context'||binding.sessionId!==r.sessionId||binding.context.resourceId!==r.resourceId||binding.context.identityId!==r.identity?.identityId||binding.context.originRunId!==r.runId))fail('NATIVE_CONTEXT_BINDING_INVALID');
    return r;
  };
  const resource = (resourceId: string) => readResource(db.prepare('SELECT json FROM driver_resources WHERE id=?').get(resourceId));
  const resources = (sessionId: string) => db.prepare('SELECT json FROM driver_resources WHERE session_id=? ORDER BY rowid').all(sessionId).map(row => readResource(row)!);
  const sameController = (a: ExecutionController, b: ExecutionController) => a.accessId === b.accessId && a.instanceId === b.instanceId && a.generation === b.generation;
  const resourceSafe = (r: DriverResource, owner?: ExecutionController): boolean => {
    if (r.purpose === 'acp_native_context') return Boolean(r.nativeReplacement || r.stage === 'created' && r.identity);
    if (r.kind === 'operation') return r.stage === 'created' || r.stage === 'not_created' || Boolean(r.creationClosure);
    if (r.stage === 'pending' && !(r.identity && r.observations.at(-1)?.state==='gone')) return false;
    if (r.stage === 'not_created' && !r.identity) return true;
    const observation = r.observations.at(-1);
    if (observation?.state === 'gone') return true;
    return Boolean(owner && sameController(r.holder ?? r.controller, owner) && r.stage === 'created' && r.identity && observation?.state === 'live');
  };
  const externalBlockers = (sessionId: string): ExecutionBlocker[] => {
    const result: ExecutionBlocker[] = [];
    for (const row of db.prepare("SELECT key,value FROM configs WHERE key=? OR key=? OR substr(key,1,length(?))=?").all(`runtime_driver_stop_block:${sessionId}`, `runtime_workspace:${sessionId}`, `runtime_verification:${sessionId}:`, `runtime_verification:${sessionId}:`) as Array<{ key: string; value: string }>) {
      if (row.key === `runtime_driver_stop_block:${sessionId}` && row.value === '') continue;
      try {
        const v = JSON.parse(row.value);
        if (row.key.startsWith('runtime_driver_stop_block:')) result.push({ sessionId, code: 'DRIVER_STOP_BLOCKED' });
        else if (row.key.startsWith('runtime_workspace:') && ['preparing', 'cleaning', 'failed'].includes(v.state)) result.push({ sessionId, code: 'WORKSPACE_RECOVERY_REQUIRED' });
        else if (row.key.startsWith('runtime_verification:') && v.sessionId === sessionId && v.status === 'running') result.push({ sessionId, code: 'VERIFICATION_RESOURCE_UNKNOWN' });
      } catch { result.push({ sessionId, code: 'RESOURCE_EVIDENCE_INVALID', detail: row.key }); }
    }
    return result;
  };
  const blockers = (sessionId: string, owner?: ExecutionController): ExecutionBlocker[] => [
    ...resources(sessionId).filter(r => !resourceSafe(r, owner)).map(r => ({ sessionId, resourceId: r.resourceId, code: 'DRIVER_RESOURCE_UNSAFE' })),
    ...externalBlockers(sessionId),
    ...(attempts(sessionId).some(a => a.state === 'legacy_unresolved') ? [{ sessionId, code: 'LEGACY_MULTIPLE_EXECUTIONS' }] : [])
  ];
  const readInput = (raw: string): AcceptedTaskInput => {
    const input = parse(acceptedTaskInputSchema, JSON.parse(raw));
    const { digest, ...content } = input;
    if (digest !== hash(stable(content))) fail('TASK_INPUT_DIGEST_CONFLICT');
    return input;
  };
  const inputFor = (taskId: string): AcceptedTaskInput | undefined => {
    const row = db.prepare('SELECT accepted_json FROM task_requests WHERE task_id=?').get(taskId) as { accepted_json: string | null } | undefined;
    return row?.accepted_json ? readInput(row.accepted_json) : undefined;
  };
  const inputBlockers = (t: ExecutionTask): ExecutionBlocker[] => {
    if (t.status !== 'queued') return [];
    const input = inputFor(t.id);
    return input?.version === 2 ? [] : [{ sessionId: t.sessionId, taskId: t.id, code: input ? 'INPUT_OPTIONS_UNVERIFIABLE' : 'INPUT_SNAPSHOT_UNVERIFIABLE' }];
  };
  const requireInputOptions = (taskId: string) => {
    const input = inputFor(taskId);
    if (!input) fail('INPUT_SNAPSHOT_UNVERIFIABLE');
    if (input.version !== 2) fail('INPUT_OPTIONS_UNVERIFIABLE');
    return input;
  };
  const assertResources = (f: SessionFence, checks?: ResourceCheckRef[], owner?: ExecutionController) => {
    if (checks) {
      parse(checksSchema, checks);
      for (const check of checks) {
        const r = resource(check.resourceId);
        if (!r || r.sessionId !== f.sessionId || r.revision !== check.expectedRevision || r.observations.at(-1)?.observationId !== check.observationId) fail('RESOURCE_OBSERVATION_CONFLICT');
      }
      for (const r of resources(f.sessionId)) if (r.kind !== 'operation' && r.purpose !== 'acp_native_context' && r.stage !== 'not_created' && !checks.some(check => check.resourceId === r.resourceId)) fail('RESOURCE_OBSERVATION_REQUIRED');
    }
    const unsafe = blockers(f.sessionId, owner);
    if (unsafe.length) fail('SESSION_RESOURCE_BLOCKED', json(unsafe));
  };
  const checkSession = (f: SessionFence) => {
    const s = session(f.sessionId);
    if (s.runId !== f.runId) fail('SESSION_RUN_CONFLICT');
    return s;
  };
  const saveTask = (t: ExecutionTask) => db.prepare('UPDATE tasks SET status=?, current_attempt_id=?, revision=?, queue_position=?, updated_at=? WHERE id=?').run(t.status, t.currentAttemptId ?? null, t.revision, t.queuePosition ?? null, t.updatedAt, t.id);
  const saveAttempt = (a: TaskAttempt) => db.prepare(`INSERT INTO task_attempts (id,task_id,session_id,run_id,number,revision,state,submission_state,submission_id,settlement_id,json) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state,submission_state=excluded.submission_state,submission_id=excluded.submission_id,settlement_id=excluded.settlement_id,json=excluded.json`).run(a.attemptId, a.taskId, a.sessionId, a.runId, a.number, a.revision, a.state, a.submissionState, a.submission?.submissionId ?? null, a.settlementId ?? null, json(a));
  const saveResource = (r: DriverResource) => db.prepare(`INSERT INTO driver_resources (id,session_id,run_id,parent_id,identity_id,revision,json) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET identity_id=excluded.identity_id,revision=excluded.revision,json=excluded.json`).run(r.resourceId, r.sessionId, r.runId, r.parentResourceId ?? null, r.identity?.identityId ?? null, r.revision, json(r));
  const insertAction = (q: QueueAction) => db.prepare('INSERT INTO task_queue_actions (id,session_id,task_id,revision,state,json) VALUES (?,?,?,?,?,?)').run(q.operationId, q.sessionId, q.taskId, q.revision, q.state, json(q));
  const decodeEvent = (r: any): AgentEvent => ({ id: r.id, sessionId: r.session_id, sequence: r.sequence, type: r.type, timestamp: r.timestamp, data: JSON.parse(r.data), ...(r.raw !== null ? { raw: r.raw } : {}), ...(r.task_id ? { taskId: r.task_id } : {}), ...(r.attempt_id ? { attemptId: r.attempt_id } : {}), ...(r.settlement_id ? { settlementId: r.settlement_id } : {}) });
  const append = (f: SessionFence, event: { id: string; type: AgentEvent['type']; data: unknown; sourceId?: string; timestamp?: string; raw?: string }, a?: TaskAttempt, settlementId?: string): AgentEvent => {
    const sourceKey = event.sourceId ? stable([f.sessionId, a ? ['attempt', a.attemptId] : ['run', f.runId], event.sourceId]) : null;
    const stored = db.prepare('SELECT * FROM events WHERE id=? OR (source_key IS NOT NULL AND source_key=?)').all(event.id, sourceKey) as any[];
    const payload = { sessionId: f.sessionId, type: event.type, data: event.data, raw: event.raw ?? null, taskId: a?.taskId ?? null, attemptId: a?.attemptId ?? null, settlementId: settlementId ?? null };
    if (stored.length) {
      if (stored.length !== 1) fail('EVENT_IDEMPOTENCY_CONFLICT');
      const old = stored[0];
      if (!same(payload, { sessionId: old.session_id, type: old.type, data: JSON.parse(old.data), raw: old.raw, taskId: old.task_id, attemptId: old.attempt_id, settlementId: old.settlement_id }) || old.source_key !== sourceKey) fail('EVENT_IDEMPOTENCY_CONFLICT');
      return decodeEvent(old);
    }
    const sequence = (db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM events WHERE session_id=?').get(f.sessionId) as { n: number }).n;
    db.prepare('INSERT INTO events (id,session_id,sequence,type,timestamp,data,raw,task_id,attempt_id,settlement_id,source_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(event.id, f.sessionId, sequence, event.type, event.timestamp ?? timestamp(), json(event.data), event.raw ?? null, a?.taskId ?? null, a?.attemptId ?? null, settlementId ?? null, sourceKey);
    return decodeEvent(db.prepare('SELECT * FROM events WHERE id=?').get(event.id));
  };
  const nextPosition = (sessionId: string, position: 'front' | 'back') => {
    const r = db.prepare("SELECT MIN(COALESCE(queue_position,0)) AS lo,MAX(COALESCE(queue_position,0)) AS hi FROM tasks WHERE session_id=? AND status='queued'").get(sessionId) as { lo: number | null; hi: number | null };
    const n = position === 'front' ? Math.min(0, r.lo ?? 0) - 1 : Math.max(0, r.hi ?? 0) + 1;
    if (!Number.isSafeInteger(n)) fail('QUEUE_POSITION_EXHAUSTED');
    return n;
  };
  const nativeKey = (sessionId: string) => `runtime_native_context:${sessionId}`;
  const nativeSelection = (sessionId: string): NativeContextSelection | undefined => {
    const row = db.prepare('SELECT value FROM configs WHERE key=?').get(nativeKey(sessionId)) as {value:string} | undefined;
    return row?.value ? parse(taskExecutionSchemas.nativeSelectionSchema, JSON.parse(row.value)) : undefined;
  };
  const nativeResource = (sessionId: string, ref: NativeContextRef) => {
    parse(taskExecutionSchemas.nativeContextRefSchema, ref);
    const r = resource(ref.resourceId);
    if (!r || r.sessionId !== sessionId || r.runId !== ref.originRunId || r.purpose !== 'acp_native_context'
      || r.identity?.identityId !== ref.identityId || r.stage !== 'created' || r.nativeReplacement) fail('NATIVE_CONTEXT_IDENTITY_CONFLICT');
    parse(taskExecutionSchemas.nativeIdentitySchema, r.identity.locator);
    return r;
  };
  const nextNativeRevision = (sessionId:string) => {
    const row=db.prepare('SELECT value FROM configs WHERE key=?').get(`${nativeKey(sessionId)}:revision`) as {value:string}|undefined;
    const value=row?Number(row.value):0;if(!Number.isSafeInteger(value)||value<0||value===Number.MAX_SAFE_INTEGER)fail('NATIVE_CONTEXT_REVISION_INVALID');return value+1;
  };
  const saveNativeSelection = (sessionId: string, selection: NativeContextSelection) => {
    db.prepare('INSERT INTO configs(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${nativeKey(sessionId)}:revision`,String(selection.revision));
    db.prepare('INSERT INTO configs(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(nativeKey(sessionId), stable(selection));
  };
  const actorId = (actor: TaskRequestV1['actor']) => actor.kind === 'unspecified' ? undefined : actor.id;
  const validateActor = (r: Pick<TaskRequestV1, 'actor' | 'namespace' | 'sessionId'>, s: Session, accepted?: AcceptedTaskInput) => {
    if (r.actor.kind === 'unspecified' && (r.namespace !== 'runtime' || ['lark', 'work_item', 'foundation_group_binding'].includes(s.source ?? ''))) fail('ACTOR_REQUIRED');
    if (r.actor.kind === 'channel' && !['lark', 'work_item'].includes(s.source ?? '')) fail('TASK_ACTOR_CONFLICT');
    if (r.namespace === 'work_item' && s.source !== 'work_item') fail('TASK_REQUEST_SCOPE_CONFLICT');
    if (r.sessionId !== s.id) fail('TASK_REQUEST_SCOPE_CONFLICT');
    if (s.source === 'lark') {
      const appId = s.sourceId?.split(':')[0];
      if (r.actor.kind === 'unspecified') fail('ACTOR_REQUIRED');
      if (r.actor.kind === 'channel' && r.actor.appId !== appId) fail('TASK_ACTOR_CONFLICT');
    }
    if (r.namespace === 'lark' && s.source !== 'lark') fail('TASK_REQUEST_SCOPE_CONFLICT');
    if (accepted && accepted.executionContext.actorId !== actorId(r.actor)) fail('TASK_ACTOR_CONFLICT');
  };
  const validateNativeActor = (f:SessionFence, raw:unknown) => {
    const actor=parse(executionActorSchema,raw),s=session(f.sessionId);
    if(actor.kind==='unspecified')fail('ACTOR_REQUIRED');
    validateActor({namespace:'runtime',sessionId:f.sessionId,actor},s);
    if(actor.kind==='channel'&&s.source==='work_item') {
      const original=db.prepare('SELECT request_json FROM task_requests WHERE session_id=? AND request_json IS NOT NULL ORDER BY rowid').all(f.sessionId) as Array<{request_json:string}>;
      const actors=original.map(row=>parse(taskRequestV1Schema,JSON.parse(row.request_json)).actor);
      if(!actors.length||actors.some(item=>item.kind!=='channel'||item.appId!==actor.appId))fail('TASK_ACTOR_CONFLICT');
    }
    return actor;
  };
  const validateManagementActor = (f: SessionFence, taskId: string, actor: TaskRequestV1['actor']) => {
    checkSession(f);
    const current = session(f.sessionId);
    validateActor({ namespace: 'runtime', sessionId: f.sessionId, actor }, current);
    if (current.source === 'work_item' && actor.kind === 'channel') {
      const accepted = getAcceptedTask(taskId);
      const original = accepted?.request?.actor;
      if (accepted?.task.sessionId !== f.sessionId || original?.kind !== 'channel' || original.appId !== actor.appId) fail('TASK_ACTOR_CONFLICT');
    }
  };
  const validateRequest = (raw: TaskRequestV1) => { const r = parse(taskRequestV1Schema, raw); validateActor(r, session(r.sessionId)); return r; };
  const getAcceptedTask = (taskId: string): AcceptedTask | undefined => {
    id.parse(taskId);
    if (authority() !== 'ledger_v1') fail('EXECUTION_AUTHORITY_LEGACY');
    const existing = task(taskId); if (!existing) return;
    const row = db.prepare('SELECT request_json,accepted_json,request_digest FROM task_requests WHERE task_id=?').get(taskId) as {request_json:string|null;accepted_json:string|null;request_digest:string} | undefined;
    const request = row?.request_json != null ? parse(taskRequestV1Schema,JSON.parse(row.request_json)) : undefined;
    const input = row?.accepted_json != null ? readInput(row.accepted_json) : undefined;
    if (request && request.sessionId !== existing.sessionId || input && input.prompt !== existing.prompt) fail('TASK_ACCEPTANCE_CONFLICT');
    if (existing.digestVersion === 'legacy_unverifiable') return {task:existing,...(input?{input}:{}),...(request?{request}:{}),replayValidation:'legacy_partial'};
    if (existing.digestVersion !== 'v1' || !row || !request || !input || row.request_digest !== hash(stable(request))) fail('TASK_ACCEPTANCE_UNVERIFIABLE');
    return {task:existing,input,request,requestDigest:row.request_digest,replayValidation:'complete'};
  };
  const lookup = (raw: TaskRequestV1): AcceptedTask | undefined => {
    if (authority() !== 'ledger_v1') fail('EXECUTION_AUTHORITY_LEGACY');
    const r = validateRequest(raw);
    const found = db.prepare('SELECT * FROM task_requests WHERE namespace=? AND session_id=? AND request_key=?').get(r.namespace, r.sessionId, r.key) as any;
    if (found) {
      if (found.request_digest !== hash(stable(r))) fail('TASK_IDEMPOTENCY_CONFLICT');
      return { task: task(found.task_id)!, input: readInput(found.accepted_json), request: JSON.parse(found.request_json), requestDigest: found.request_digest, replayValidation: 'complete' };
    }
    const legacy = task(`task_${hash(`${r.sessionId}\0${r.key}`)}`);
    if (legacy && legacy.digestVersion === 'legacy_unverifiable') {
      if (legacy.sessionId !== r.sessionId || legacy.prompt !== r.prompt || legacy.executionContext?.actorId !== actorId(r.actor)) fail('TASK_IDEMPOTENCY_CONFLICT');
      const stored = db.prepare('SELECT accepted_json FROM task_requests WHERE task_id=?').get(legacy.id) as { accepted_json: string | null } | undefined;
      return { task: legacy, ...(stored?.accepted_json ? { input: readInput(stored.accepted_json) } : {}), replayValidation: 'legacy_partial' };
    }
  };
  const result = (f: SessionFence, t?: ExecutionTask, a?: TaskAttempt, events: AgentEvent[] = [], replayed = false): CommitResult => ({ session: session(f.sessionId), ...(t ? { task: t } : {}), ...(a ? { attempt: a } : {}), events, replayed, blockers: [...blockers(f.sessionId), ...(t ? inputBlockers(t) : [])] });
  const sessionStatus = (sessionId: string) => {
    const all = attempts(sessionId);
    const state = all.some(a => a.state === 'preparing' || a.state === 'active') ? 'thinking'
      : all.some(a => a.state === 'reconcile_required' || a.state === 'legacy_unresolved' || a.outcome === 'unknown' && task(a.taskId)?.currentAttemptId === a.attemptId) ? 'interrupted' : 'idle';
    db.prepare('UPDATE sessions SET state=?,updated_at=? WHERE id=?').run(state, timestamp(), sessionId);
  };
  const transitions = (f: SessionFence, t: ExecutionTask, a: TaskAttempt, settled = false) => {
    saveAttempt(a); saveTask(t); sessionStatus(f.sessionId);
    const prefix = `execution:${a.attemptId}:${a.revision}`;
    const events = [append(f, { id: `${prefix}:task`, type: 'task', data: { task: { id: t.id, status: t.status, revision: t.revision } } }, a, settled ? a.settlementId : undefined),
      append(f, { id: `${prefix}:status`, type: 'status', data: { state: session(f.sessionId).state } }, a, settled ? a.settlementId : undefined)];
    if (settled) events.push(append(f, { id: `${prefix}:settled`, type: 'completed', data: { outcome: a.outcome } }, a, a.settlementId));
    return result(f, t, a, events);
  };
  const touch = (t: ExecutionTask, a: TaskAttempt) => { const at = timestamp(); t.revision++; t.updatedAt = at; a.revision++; a.updatedAt = at; };
  const recordDecision = (f: SessionFence, a: TaskAttempt | undefined, decision: RecoveryDecisionInput | unknown, decisionId: string) => {
    if (decision && typeof decision === 'object' && 'resourceChecks' in decision) {
      const checks = parse(checksSchema, decision.resourceChecks);
      for (const check of checks) {
        const r = resource(check.resourceId);
        if (!r || r.sessionId !== f.sessionId || r.revision !== check.expectedRevision || r.observations.at(-1)?.observationId !== check.observationId) fail('RESOURCE_OBSERVATION_CONFLICT');
      }
    }
    const content = { ...f, attemptId: a?.attemptId ?? null, evidence: decision };
    const old = db.prepare('SELECT json FROM recovery_decisions WHERE id=?').get(decisionId) as { json: string } | undefined;
    if (old) { if (old.json !== stable(content)) fail('RECOVERY_DECISION_CONFLICT'); return; }
    db.prepare('INSERT INTO recovery_decisions VALUES (?,?,?,?)').run(decisionId, f.sessionId, a?.attemptId ?? null, stable(content));
  };
  const readUpgradeCounts = (): ExecutionUpgradeCounts => {
    const tasksCount = (db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c;
    const attemptsCount = (db.prepare('SELECT COUNT(*) AS c FROM task_attempts').get() as { c: number }).c;
    const resourcesCount = (db.prepare('SELECT COUNT(*) AS c FROM driver_resources').get() as { c: number }).c;
    const hasAccessTable = Boolean(db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='dutydeck_access'").get());
    const registeredAccess = hasAccessTable
      ? (db.prepare('SELECT COUNT(*) AS c FROM dutydeck_access').get() as { c: number }).c
      : 0;
    return { tasks: tasksCount, attempts: attemptsCount, resources: resourcesCount, registeredAccess };
  };
  const legacyResourceId = (sessionId: string) => `legacy_resource_${hash(sessionId)}`;
  const retirementKey = (sessionId: string) => `legacy_retirement:${sessionId}`;
  const retirementSnapshotDigest = (sessionId: string): string => {
    const rows = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params);
    return hash(stable({
      session: db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId),
      tasks: rows('SELECT * FROM tasks WHERE session_id=? ORDER BY created_at,rowid', sessionId),
      requests: rows('SELECT * FROM task_requests WHERE session_id=? ORDER BY task_id', sessionId),
      attempts: rows('SELECT * FROM task_attempts WHERE session_id=? ORDER BY number,id', sessionId),
      queueActions: rows('SELECT * FROM task_queue_actions WHERE session_id=? ORDER BY id', sessionId),
      resources: rows('SELECT * FROM driver_resources WHERE session_id=? ORDER BY rowid', sessionId),
      decisions: rows('SELECT * FROM recovery_decisions WHERE session_id=? ORDER BY id', sessionId),
      events: rows('SELECT * FROM events WHERE session_id=? ORDER BY sequence,id', sessionId),
      toolCalls: rows('SELECT * FROM tool_calls WHERE session_id=? ORDER BY id', sessionId),
      permissions: rows('SELECT * FROM permission_requests WHERE session_id=? ORDER BY id', sessionId),
      errors: rows('SELECT * FROM errors WHERE session_id=? ORDER BY id', sessionId),
      channelMappings: rows('SELECT * FROM channel_mappings WHERE session_id=? ORDER BY id', sessionId),
      runtimeConfigs: rows("SELECT key,value FROM configs WHERE key IN (?,?,?,?,?,?,?) OR substr(key,1,length(?))=? OR key LIKE ? ESCAPE '\\' ORDER BY key",
        `runtime_driver_stop_block:${sessionId}`, `runtime_workspace:${sessionId}`, `runtime_driver_configuration:${sessionId}`,
        `runtime_native_context:${sessionId}`, `runtime_native_context:${sessionId}:revision`, `lark.run-context.${sessionId}`,
        retirementKey(sessionId), `runtime_verification:${sessionId}:`, `runtime_verification:${sessionId}:`,
        `lark.context.%.${sessionId.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}`)
    }));
  };
  const legacyRetirementBlockers = (s: Session): ExecutionBlocker[] => {
    const result: ExecutionBlocker[] = [];
    if (!['idle', 'interrupted', 'completed', 'failed', 'stopped'].includes(s.state)) {
      result.push({ sessionId: s.id, code: 'LEGACY_RETIREMENT_SESSION_ACTIVE', detail: s.state });
    }
    const expectedResourceId = legacyResourceId(s.id);
    const sessionResources = resources(s.id);
    const legacyResource = sessionResources.find(item => item.resourceId === expectedResourceId);
    if (!legacyResource || legacyResource.kind !== 'legacy' || legacyResource.stage !== 'unknown'
      || legacyResource.controller.instanceId !== 'legacy_unverified' || legacyResource.controller.generation !== 0) {
      result.push({ sessionId: s.id, code: 'LEGACY_RETIREMENT_NOT_MIGRATED' });
    }
    if (sessionResources.some(item => item.resourceId !== expectedResourceId && !resourceSafe(item))) {
      result.push({ sessionId: s.id, code: 'LEGACY_RETIREMENT_OTHER_RESOURCE_UNSAFE' });
    }
    const nonterminal = db.prepare("SELECT id FROM tasks WHERE session_id=? AND status NOT IN ('completed','failed','interrupted','cancelled') ORDER BY id").all(s.id) as Array<{ id: string }>;
    result.push(...nonterminal.map(item => ({ sessionId: s.id, taskId: item.id, code: 'LEGACY_RETIREMENT_TASK_ACTIVE' })));
    const unsettled = db.prepare("SELECT task_id FROM task_attempts WHERE session_id=? AND state!='settled' ORDER BY id").all(s.id) as Array<{ task_id: string }>;
    result.push(...unsettled.map(item => ({ sessionId: s.id, taskId: item.task_id, code: 'LEGACY_RETIREMENT_ATTEMPT_UNSETTLED' })));
    if (db.prepare("SELECT 1 FROM task_queue_actions WHERE session_id=? AND state='pending' LIMIT 1").get(s.id)) {
      result.push({ sessionId: s.id, code: 'LEGACY_RETIREMENT_QUEUE_ACTION_PENDING' });
    }
    result.push(...externalBlockers(s.id));
    return result;
  };
  const readRetirementReceipt = (sessionId: string): LegacyRetirementReceipt | undefined => {
    const row = db.prepare('SELECT value FROM configs WHERE key=?').get(retirementKey(sessionId)) as { value: string } | undefined;
    return row ? parse(taskExecutionSchemas.legacyRetirementReceiptSchema, JSON.parse(row.value)) : undefined;
  };
  const listLegacyRetirementCandidates = (): LegacyRetirementCandidate[] => {
    control.assertMaintenance(db);
    if (authority() !== 'ledger_v1') fail('EXECUTION_AUTHORITY_LEGACY');
    const entity = (db.prepare('SELECT entity FROM dutydeck_control WHERE id=1').get() as { entity: string }).entity;
    const rows = db.prepare("SELECT id FROM sessions WHERE EXISTS (SELECT 1 FROM driver_resources WHERE session_id=sessions.id AND id LIKE 'legacy_resource_%') ORDER BY id").all() as Array<{ id: string }>;
    return rows.map(row => {
      const s = session(row.id);
      let receipt: LegacyRetirementReceipt | undefined;
      const candidateBlockers: ExecutionBlocker[] = [];
      try { receipt = readRetirementReceipt(s.id); }
      catch (error) {
        candidateBlockers.push({ sessionId: s.id, code: 'LEGACY_RETIREMENT_RECEIPT_INVALID', detail: error instanceof Error ? error.message : String(error) });
      }
      if (!receipt) {
        try { candidateBlockers.push(...legacyRetirementBlockers(s)); }
        catch (error) {
          candidateBlockers.push({ sessionId: s.id, code: 'LEGACY_RETIREMENT_METADATA_INVALID', detail: error instanceof Error ? error.message : String(error) });
        }
      }
      return {
        sessionId: s.id, runId: s.runId, databaseEntity: entity,
        snapshotDigest: receipt?.snapshotDigest ?? retirementSnapshotDigest(s.id),
        agentId: s.agentId, cwd: s.cwd, ...(s.protocol ? { protocol: s.protocol } : {}),
        state: s.state, ...(s.archivedAt ? { archivedAt: s.archivedAt } : {}),
        ...(receipt ? { receipt } : {}), blockers: receipt ? [] : candidateBlockers
      };
    });
  };
  const retireLegacySession = (rawReceipt: LegacyRetirementReceipt): LegacyRetirementResult => {
    const receipt = parse(taskExecutionSchemas.legacyRetirementReceiptSchema, rawReceipt);
    const { receiptId, ...receiptContent } = receipt;
    if (receiptId !== `legacy_retirement_${hash(stable(receiptContent))}`) fail('LEGACY_RETIREMENT_RECEIPT_INVALID');
    return db.transaction((): LegacyRetirementResult => {
        control.assertMaintenance(db);
        if (authority() !== 'ledger_v1') fail('EXECUTION_AUTHORITY_LEGACY');
        const existing = readRetirementReceipt(receipt.sessionId);
        if (existing) {
          if (!same(existing, receipt)) fail('LEGACY_RETIREMENT_RECEIPT_CONFLICT');
          const retired = session(receipt.sessionId);
          const currentEntity = (db.prepare('SELECT entity FROM dutydeck_control WHERE id=1').get() as { entity: string }).entity;
          if (retired.runId !== receipt.runId || retired.state !== 'stopped' || retired.archivedAt !== receipt.archivedAt
            || !retired.error?.includes(LEGACY_RETIREMENT_NOTICE) || receipt.databaseEntity !== currentEntity) fail('LEGACY_RETIREMENT_FINAL_STATE_CONFLICT');
          return { session: retired, receipt: existing, replayed: true };
        }
        const s = checkSession(receipt);
        const entity = (db.prepare('SELECT entity FROM dutydeck_control WHERE id=1').get() as { entity: string }).entity;
        if (receipt.databaseEntity !== entity) fail('LEGACY_RETIREMENT_DATABASE_CONFLICT');
        if (s.protocol !== receipt.protocol) fail('LEGACY_RETIREMENT_PROTOCOL_CONFLICT');
        const retirementBlockers = legacyRetirementBlockers(s);
        if (retirementBlockers.length) fail('LEGACY_RETIREMENT_BLOCKED', json(retirementBlockers));
        if (retirementSnapshotDigest(s.id) !== receipt.snapshotDigest) fail('LEGACY_RETIREMENT_SNAPSHOT_CONFLICT');
        if (receipt.archivedAt !== (s.archivedAt ?? receipt.verifiedAt)) fail('LEGACY_RETIREMENT_ARCHIVE_CONFLICT');
        if (receipt.evidence.kind === 'pty_tmux_absent') {
          const readable = s.id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'session';
          const expectedTargetName = `dutydeck-${readable}-${hash(s.id).slice(0, 16)}`;
          if (receipt.protocol !== 'pty-cli' || receipt.evidence.owner !== `dutydeck:${s.id}`
            || receipt.evidence.targetName !== expectedTargetName) fail('LEGACY_RETIREMENT_EVIDENCE_CONFLICT');
          if (receipt.evidence.outcome === 'stopped_owned' && !receipt.evidence.targetId) fail('LEGACY_RETIREMENT_EVIDENCE_CONFLICT');
          if (receipt.evidence.outcome === 'already_missing' && (receipt.evidence.targetId || receipt.evidence.paneProcesses.length)) fail('LEGACY_RETIREMENT_EVIDENCE_CONFLICT');
        } else if (receipt.protocol !== 'acp' || receipt.evidence.acpxRecordId !== s.id
          || !receipt.evidence.recordPath.endsWith(`/sessions/${encodeURIComponent(s.id)}.json`)) fail('LEGACY_RETIREMENT_EVIDENCE_CONFLICT');
        const error = s.error?.includes(LEGACY_RETIREMENT_NOTICE) ? s.error : [s.error, LEGACY_RETIREMENT_NOTICE].filter(Boolean).join('\n\n');
        const updated = db.prepare("UPDATE sessions SET state='stopped',archived_at=?,error=?,updated_at=? WHERE id=? AND run_id=? AND archived_at IS ?")
          .run(receipt.archivedAt, error, receipt.verifiedAt, s.id, s.runId, s.archivedAt ?? null);
        if (updated.changes !== 1) fail('LEGACY_RETIREMENT_SNAPSHOT_CONFLICT');
        db.prepare('INSERT INTO configs (key,value) VALUES (?,?)').run(retirementKey(s.id), stable(receipt));
        return { session: session(s.id), receipt, replayed: false };
      }).immediate();
  };
  const beginLegacyRetirement = () => {
    control.beginUpgrade();
    let closed = false;
    const open = () => { if (closed) fail('DATABASE_MAINTENANCE_REQUIRED'); };
    return {
      listCandidates() { open(); return listLegacyRetirementCandidates(); },
      retireSession(receipt: LegacyRetirementReceipt) { open(); return retireLegacySession(receipt); },
      close() { if (!closed) { closed = true; control.finishUpgrade(); } }
    };
  };
  const collectAllBlockers = (): ExecutionBlocker[] => {
    const allSessions = db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>;
    const result: ExecutionBlocker[] = [];
    for (const row of allSessions) {
      result.push(...blockers(row.id));
    }
    return result;
  };
  const legacySummary = () => {
    const sessionIds = db.prepare("SELECT DISTINCT session_id FROM driver_resources WHERE json_extract(json,'$.kind')='legacy' AND json_extract(json,'$.stage')='unknown'").pluck().all() as string[];
    let retiredSessions = 0;
    for (const sessionId of sessionIds) {
      let receipt: LegacyRetirementReceipt | undefined;
      try { receipt = readRetirementReceipt(sessionId); } catch { continue; }
      if (!receipt) continue;
      const s = session(sessionId);
      if (s.state === 'stopped' && s.archivedAt === receipt.archivedAt && s.error?.includes(LEGACY_RETIREMENT_NOTICE)) retiredSessions += 1;
    }
    return { unresolvedSessions: sessionIds.length - retiredSessions, retiredSessions, evidenceIncomplete: sessionIds.length };
  };
  const upgradeLegacy = (): ExecutionUpgradeSnapshot => {
    control.beginUpgrade();
    try {
      return db.transaction((): ExecutionUpgradeSnapshot => {
        control.assertMaintenance(db);
        const beforeAuthority = authority();
        if (beforeAuthority !== 'legacy' && beforeAuthority !== 'ledger_v1') {
          fail('EXECUTION_AUTHORITY_INVALID', `Invalid execution authority: ${beforeAuthority}`);
        }
        const before = { authority: beforeAuthority, counts: readUpgradeCounts() };
        if (beforeAuthority === 'ledger_v1') {
          return {
            before,
            after: { authority: 'ledger_v1', counts: readUpgradeCounts() },
            blockers: collectAllBlockers(), legacy: legacySummary()
          };
        }
        const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
        for (const row of db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>) {
          const s = session(row.id);
          const f = { sessionId: s.id, runId: s.runId };
          const controller = { accessId: control.accessId, instanceId: 'legacy_unverified', generation: 0 };
          saveResource({ ...f, resourceId: legacyResourceId(s.id), kind: 'legacy', revision: 1, controller, stage: 'unknown', observations: [], createdAt: timestamp() });
          const oldTasks = (db.prepare('SELECT id FROM tasks WHERE session_id=? ORDER BY created_at,rowid').all(s.id) as Array<{ id: string }>).map(r => task(r.id)!);
          const ambiguous = oldTasks.filter(t => t.status !== 'queued' && !terminal.has(t.status)).length > 1;
          for (const t of oldTasks) {
            const oldStatus = t.status;
            let accepted: AcceptedTaskInput | undefined;
            if (t.executionContext?.agentPrompt !== undefined) {
              const frozen = { version: 1 as const, prompt: t.prompt, executionContext: t.executionContext, contentSources: [] };
              // Legacy snapshots preserve their old evidence; digestVersion never becomes v1.
              accepted = { ...frozen, digest: hash(stable(frozen)) };
            }
            db.prepare('INSERT INTO task_requests VALUES (?,?,?,?,?,?,?)').run(t.id, 'legacy', s.id, t.id, 'legacy_unverifiable', null, accepted ? json(accepted) : null);
            if (t.status !== 'queued') {
              const attemptId = `legacy_attempt_${hash(t.id)}`;
              const a: TaskAttempt = { ...f, taskId: t.id, attemptId, number: 1, revision: 1, state: terminal.has(oldStatus) ? 'settled' : ambiguous ? 'legacy_unresolved' : 'reconcile_required', submissionState: 'legacy_unknown', controller, recoveryControllers: [],
                legacy: JSON.parse(json({ status: oldStatus, ...(t.executionContext?.recovery ? { recovery: t.executionContext.recovery } : {}) })), createdAt: t.createdAt, updatedAt: t.updatedAt };
              if (terminal.has(oldStatus)) { a.outcome = oldStatus as 'completed' | 'failed' | 'interrupted' | 'cancelled'; a.settlementId = `legacy_settlement_${hash(t.id)}`; }
              else t.status = 'reconcile_required';
              t.currentAttemptId = attemptId;
              saveAttempt(a);
            }
            saveTask(t);
          }
          const queued = db.prepare("SELECT id FROM tasks WHERE session_id=? AND status='queued' ORDER BY COALESCE(queue_position,0),created_at,rowid").all(s.id) as Array<{ id: string }>;
          queued.forEach((row, index) => db.prepare('UPDATE tasks SET queue_position=? WHERE id=?').run(index + 1, row.id));
          if (oldTasks.some(t => t.currentAttemptId && attempt(t.currentAttemptId)?.state !== 'settled')) db.prepare("UPDATE sessions SET state='interrupted' WHERE id=?").run(s.id);
        }
        db.prepare("UPDATE execution_authority SET authority='ledger_v1' WHERE id=1").run();
        const afterAuthority = authority();
        const after = { authority: afterAuthority, counts: readUpgradeCounts() };
        return { before, after, blockers: collectAllBlockers(), legacy: legacySummary() };
      }).immediate();
    } finally {
      // Atomic rollback keeps legacy authoritative; never leave a live failed conversion in maintenance.
      // A killed owner is handled by the existing persistent maintenance recovery gate.
      control.finishUpgrade();
    }
  };
  return {
    authority, upgradeLegacy, beginLegacyRetirement, lookupAccepted: lookup, getAcceptedTask,
    getResources: resources,
    getNativeContext(sessionId) { const selection = nativeSelection(sessionId); return selection ? {selection,resource:nativeResource(sessionId,selection.context)} : undefined; },
    getSessionResourceBlockers: sessionId => blockers(sessionId),
    getTaskExecution(taskId) {
      const t = task(taskId); if (!t) return;
      if (authority() !== 'ledger_v1') fail('EXECUTION_AUTHORITY_LEGACY');
      return { task: t, currentAttempt: t.currentAttemptId ? attempt(t.currentAttemptId) : undefined, attempts: attempts(t.sessionId).filter(a => a.taskId === t.id), blockers: [...blockers(t.sessionId), ...inputBlockers(t)] };
    },
    getAttemptEvents(attemptId, window = {}) {
      id.parse(attemptId);
      const limit = Math.max(1, Math.min(1000, Math.trunc(window.limit ?? 200)));
      if (!Number.isFinite(limit)) fail('EXECUTION_INVALID_INPUT');
      const backwards = window.direction === 'backward';
      const rows = db.prepare(`SELECT * FROM events WHERE attempt_id=? AND sequence>? AND sequence<? ORDER BY sequence ${backwards ? 'DESC' : 'ASC'} LIMIT ?`).all(attemptId, window.afterSequence ?? 0, window.beforeSequence ?? Number.MAX_SAFE_INTEGER, limit);
      return (backwards ? rows.reverse() : rows).map(decodeEvent);
    },
    bind(claim) {
      db.transaction(() => control.validateClaim(db, claim)).immediate();
      const write = <T>(work: (owner: ExecutionController) => T): T => db.transaction(() => {
        const owner = control.validateClaim(db, claim);
        if (authority() !== 'ledger_v1') fail('EXECUTION_AUTHORITY_LEGACY');
        return work(owner);
      }).immediate();
      const readFence = (raw: SessionFence) => { const f = parse(fenceSchema, raw); checkSession(f); return f; };
      const attemptScope = (f: AttemptFence): { t: ExecutionTask; a: TaskAttempt } => {
        parse(attemptFenceSchema, f); checkSession(f);
        const t = task(f.taskId); const a = attempt(f.attemptId);
        if (!t || !a || t.sessionId !== f.sessionId || a.taskId !== t.id || a.sessionId !== f.sessionId || a.runId !== f.runId) fail('ATTEMPT_SCOPE_CONFLICT');
        return { t, a };
      };
      const currentAttempt = (f: AttemptFence, owner: ExecutionController, recovering = false) => {
        const pair = attemptScope(f);
        if (pair.t.currentAttemptId !== f.attemptId) fail('ATTEMPT_NOT_CURRENT');
        if (pair.a.revision !== f.expectedRevision) fail('ATTEMPT_REVISION_CONFLICT');
        if (!recovering && !sameController(pair.a.controller, owner)) fail('ATTEMPT_CONTROLLER_CONFLICT');
        return pair;
      };
      const command = <T>(key: string, payload: unknown, work: () => T): T => {
        const serialized = stable(payload);
        const old = db.prepare('SELECT payload,result FROM task_execution_commands WHERE id=?').get(key) as { payload: string; result: string } | undefined;
        if (old) {
          if (old.payload !== serialized) fail('EXECUTION_OPERATION_CONFLICT');
          const result = JSON.parse(old.result);
          if ('replayed' in result) result.replayed = true;
          return result;
        }
        const value = work();
        db.prepare('INSERT INTO task_execution_commands VALUES (?,?,?)').run(key, serialized, json(value));
        return value;
      };
      const attemptCommand = <T>(f: AttemptFence, key: string, input: unknown, work: () => T) => {
        attemptScope(f);
        return command(key, { sessionId: f.sessionId, runId: f.runId, taskId: f.taskId, attemptId: f.attemptId, input }, work);
      };
      const queuedTask = (f: SessionFence, taskId: string, expectedRevision: number) => {
        id.parse(taskId); revision.parse(expectedRevision);
        const t = task(taskId);
        if (!t || t.sessionId !== f.sessionId || t.status !== 'queued') fail('TASK_NOT_QUEUED');
        if (t.revision !== expectedRevision) fail('TASK_REVISION_CONFLICT');
        const a = t.currentAttemptId ? attempt(t.currentAttemptId) : undefined;
        if (a && (a.state !== 'suspended' || a.submissionState !== 'not_submitted')) fail('TASK_NOT_QUEUED');
        return { t, a };
      };
      const queueAction = (f: SessionFence, t: ExecutionTask, source: QueueAction['source'], operation: { operationId: string; actor: TaskRequestV1['actor']; interrupt: boolean }, target?: TaskAttempt) => {
        const identity = { ...f, ...operation, source, taskId: t.id };
        const existing = rowJson<QueueAction>(db.prepare('SELECT json FROM task_queue_actions WHERE id=?').get(operation.operationId));
        if (existing) {
          const { target: _target, revision: _revision, state: _state, evidence: _evidence, ...storedIdentity } = existing;
          if (!same(identity, storedIdentity)) fail('QUEUE_ACTION_IDENTITY_CONFLICT');
          return existing;
        }
        const active = target ?? attempts(f.sessionId).find(a => ['preparing', 'active', 'reconcile_required'].includes(a.state));
        const q: QueueAction = { ...f, ...operation, source, taskId: t.id, revision: 1, state: operation.interrupt && active ? 'pending' : 'applied', ...(operation.interrupt && active ? { target: { taskId: active.taskId, attemptId: active.attemptId, runId: active.runId } } : {}) };
        insertAction(q); return q;
      };
      const settle = (f: AttemptFence, t: ExecutionTask, a: TaskAttempt, settlementId: string, evidence: Parameters<BoundExecutionRepository['settleAttempt']>[2]) => {
        if (a.state === 'settled') fail('ATTEMPT_ALREADY_SETTLED');
        if (evidence.kind === 'driver_result') {
          parse(taskExecutionSchemas.driverResult, evidence);
          if (!a.submission || a.submission.submissionId !== evidence.submissionId || a.submissionState === 'not_submitted') fail('SUBMISSION_SCOPE_CONFLICT');
        } else if (evidence.kind === 'not_submitted') {
          parse(taskExecutionSchemas.notSubmitted, evidence);
          if (a.submissionState !== 'not_submitted') fail('SUBMISSION_NOT_UNSUBMITTED');
        } else {
          parse(taskExecutionSchemas.manual, evidence);
          if (evidence.decision.action !== 'confirm_result' || evidence.decision.actor.kind === 'unspecified') fail('RECOVERY_DECISION_REQUIRED');
          recordDecision(f, a, evidence.decision, evidence.decision.decisionId);
        }
        a.state = 'settled'; a.settlementId = settlementId; a.outcome = evidence.outcome; a.settlement = evidence;
        t.status = evidence.outcome === 'unknown' ? 'reconcile_required' : evidence.outcome;
        touch(t, a); return transitions(f, t, a, true);
      };
      const bound: BoundExecutionRepository = {
        lookupAccepted(request) { return write(() => lookup(request)); },
        acceptTask(rawFence, rawRequest, rawInput, position) { return write(() => {
          const f = readFence(rawFence); const request = validateRequest(rawRequest);
          if (request.sessionId !== f.sessionId) fail('TASK_REQUEST_SCOPE_CONFLICT');
          const replay = lookup(request);
          if (replay) return { ...result(f, replay.task, replay.task.currentAttemptId ? attempt(replay.task.currentAttemptId) : undefined, [], true), accepted: replay };
          const s = session(f.sessionId);
          if (s.archivedAt || s.state === 'stopped') fail('SESSION_NOT_ACCEPTING');
          taskExecutionSchemas.position.parse(position);
          const input = parse(acceptedTaskInputV2Schema, rawInput);
          if (input.prompt !== request.prompt) fail('TASK_INPUT_CONFLICT');
          for (const key of Object.keys(request.options) as Array<keyof TaskRequestV1['options']>) if (request.options[key] !== input.executionOptions[key]) fail('TASK_INPUT_OPTIONS_CONFLICT');
          const { digest, ...content } = input;
          if (digest !== hash(stable(content))) fail('TASK_INPUT_DIGEST_CONFLICT');
          validateActor(request, s, input);
          const time = timestamp();
          const taskId = executionTaskId(request.namespace, request.sessionId, request.key);
          const t: ExecutionTask = { id: taskId, sessionId: f.sessionId, prompt: input.prompt, executionContext: input.executionContext, status: 'queued', revision: 1, digestVersion: 'v1', queuePosition: nextPosition(f.sessionId, position), createdAt: time, updatedAt: time };
          db.prepare('INSERT INTO tasks (id,session_id,prompt,status,execution_context,queue_position,revision,digest_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(t.id,t.sessionId,t.prompt,t.status,json(t.executionContext),t.queuePosition!,t.revision,t.digestVersion,time,time);
          db.prepare('INSERT INTO task_requests VALUES (?,?,?,?,?,?,?)').run(t.id,request.namespace,request.sessionId,request.key,hash(stable(request)),json(request),json(input));
          const events = [append(f, { id: `accepted:${t.id}`, type: 'task', data: { task: { id: t.id, status: t.status } } })];
          // Accepted task events have no Attempt but retain the Task identity.
          db.prepare('UPDATE events SET task_id=? WHERE id=?').run(t.id,events[0]!.id); events[0]!.taskId = t.id;
          if (request.mode === 'interrupt') queueAction(f,t,'accept',{ operationId: `accept_interrupt:${t.id}`, actor: request.actor, interrupt: true });
          return { ...result(f,t,undefined,events), accepted: lookup(request)! };
        }); },
        claimNext(rawFence) { return write(owner => {
          const f = readFence(rawFence); const s = session(f.sessionId);
          if (s.archivedAt || s.state === 'stopped') fail('SESSION_NOT_ACCEPTING');
          assertResources(f, undefined, owner);
          if (attempts(f.sessionId).some(a => ['preparing','active','reconcile_required'].includes(a.state))) fail('SESSION_EXECUTION_BUSY');
          const row = db.prepare("SELECT id FROM tasks WHERE session_id=? AND status='queued' ORDER BY COALESCE(queue_position,0),created_at,rowid LIMIT 1").get(f.sessionId) as { id: string } | undefined;
          if (!row) return;
          const t = task(row.id)!;
          requireInputOptions(t.id);
          let a = t.currentAttemptId ? attempt(t.currentAttemptId) : undefined;
          if (a) {
            if (a.state !== 'suspended' || a.submissionState !== 'not_submitted' || a.runId !== f.runId) fail('ATTEMPT_NOT_SUSPENDED');
            if (!sameController(a.controller, owner)) {
              const evidence = { kind: 'unsubmitted_preparation' as const, decisionId: `claim_suspended:${a.attemptId}:${owner.generation}`, safeResources: [] };
              a.recoveryControllers.push({ controller: owner, evidence }); a.controller = owner;
            }
            a.state = 'preparing'; touch(t,a);
          } else {
            a = { ...f, taskId: t.id, attemptId: `attempt_${randomUUID()}`, number: 1, revision: 1, state: 'preparing', submissionState: 'not_submitted', controller: owner, recoveryControllers: [], createdAt: timestamp(), updatedAt: timestamp() };
            t.revision++; t.updatedAt = timestamp(); t.currentAttemptId = a.attemptId;
          }
          t.status = 'running'; return transitions(f,t,a);
        }); },
        promoteQueued(rawFence, taskId, expectedTaskRevision, rawOperation) { return write(() => {
          const f = readFence(rawFence);
          const operation = parse(taskExecutionSchemas.queueOperation,rawOperation);
          validateManagementActor(f,taskId,operation.actor);
          return command(`queue:${operation.operationId}`,{ ...f,taskId,operation },() => {
            const { t } = queuedTask(f,taskId,expectedTaskRevision);
            t.queuePosition = nextPosition(f.sessionId,'front'); t.revision++; t.updatedAt=timestamp(); saveTask(t);
            const action = queueAction(f,t,'promote',operation);
            const event=append(f,{ id: `queue:${operation.operationId}`, type: 'task', data: { task: { id:t.id,status:t.status }, queueAction:action } });
            return result(f,t,t.currentAttemptId ? attempt(t.currentAttemptId) : undefined,[event]);
          });
        }); },
        getPendingQueueActions(rawFence) { return write(() => {
          const f = readFence(rawFence);
          return db.prepare("SELECT json FROM task_queue_actions WHERE session_id=? AND state IN ('pending','blocked')").all(f.sessionId).map(r => rowJson<QueueAction>(r)!).filter(q=>q.runId===f.runId);
        }); },
        settleQueueAction(rawFence, operationId, expectedRevision, rawEvidence) { return write(() => {
          const f=readFence(rawFence);
          const evidence=parse(taskExecutionSchemas.queueEvidence,rawEvidence);
          return command(`queue_evidence:${evidence.evidenceId}`,{ ...f,operationId,evidence },() => {
            const q=rowJson<QueueAction>(db.prepare('SELECT json FROM task_queue_actions WHERE id=?').get(operationId));
            if (!q || q.sessionId!==f.sessionId || q.runId!==f.runId) fail('QUEUE_ACTION_SCOPE_CONFLICT');
            if (q.revision!==expectedRevision) fail('QUEUE_ACTION_REVISION_CONFLICT');
            if (q.state==='applied' || q.state==='obsolete') fail('QUEUE_ACTION_ALREADY_SETTLED');
            const target=q.target ? attempt(q.target.attemptId) : undefined;
            if (evidence.state==='applied' && target && target.state!=='settled') fail('QUEUE_TARGET_NOT_SETTLED');
            if (evidence.state==='obsolete' && target && target.state!=='settled') fail('QUEUE_TARGET_NOT_SETTLED');
            for(const check of evidence.resourceChecks) { const r=resource(check.resourceId); if(!r || r.sessionId!==f.sessionId || r.revision!==check.expectedRevision || r.observations.at(-1)?.observationId!==check.observationId) fail('RESOURCE_OBSERVATION_CONFLICT'); }
            q.revision++;q.state=evidence.state;q.evidence=evidence;
            if (db.prepare('UPDATE task_queue_actions SET revision=?,state=?,json=? WHERE id=? AND session_id=? AND revision=?').run(q.revision,q.state,json(q),q.operationId,f.sessionId,expectedRevision).changes !== 1) fail('QUEUE_ACTION_REVISION_CONFLICT');
            return q;
          });
        }); },
        markSubmissionPending(f, rawInput) { return write(owner => {
          const input=parse(intentSchema,rawInput);
          return attemptCommand(f,`submission:${input.submissionId}`,input,() => {
            const {t,a}=currentAttempt(f,owner);
            if(a.state!=='preparing' || a.submissionState!=='not_submitted') fail('ATTEMPT_NOT_PREPARING');
            requireInputOptions(t.id);
            assertResources(f,undefined,owner);
            for(const ref of input.resourceRefs) {
              const r=resource(ref.resourceId);
              if(!r || r.sessionId!==f.sessionId || r.runId!==f.runId || r.kind==='operation' || r.purpose==='acp_native_context' || r.identity?.identityId!==ref.identityId || !resourceSafe(r,owner)) fail('RESOURCE_IDENTITY_CONFLICT');
            }
            const selection = nativeSelection(f.sessionId);
            if (selection) {
              if (selection.runId !== f.runId || !input.nativeContextRef || !same(input.nativeContextRef,selection.context)) fail('NATIVE_CONTEXT_SELECTION_CONFLICT');
              const native = nativeResource(f.sessionId,selection.context);
              if (!native.nativeBindings?.some(b => b.proofId === input.contextProofId && b.runId === f.runId && b.driverInstanceId === input.driverInstanceId && sameController(b.controller,owner))) fail('NATIVE_CONTEXT_PROOF_REQUIRED');
              const configuration = db.prepare('SELECT value FROM configs WHERE key=?').get(`runtime_driver_configuration:${f.sessionId}`) as {value:string} | undefined;
              if (configuration?.value) fail('DRIVER_CONFIGURATION_UNKNOWN');
            } else if (input.nativeContextRef || input.contextProofId) fail('NATIVE_CONTEXT_SELECTION_CONFLICT');
            a.submission=input;a.submissionController=owner;a.submissionState='intent_recorded';a.state='active';touch(t,a);
            return transitions(f,t,a);
          });
        }); },
        markSubmitted(f, rawReceipt) { return write(owner => {
          const receipt=parse(taskExecutionSchemas.receipt,rawReceipt);
          return attemptCommand(f,`receipt:${receipt.submissionId}`,receipt,() => {
            const {t,a}=currentAttempt(f,owner);
            if(a.submission?.submissionId!==receipt.submissionId || a.submissionState!=='intent_recorded' || !['active','reconcile_required'].includes(a.state)) fail('SUBMISSION_SCOPE_CONFLICT');
            a.receipt=receipt;a.submissionState='acknowledged';touch(t,a);return transitions(f,t,a);
          });
        }); },
        confirmAttemptRecovery(f, settlementId, evidence, verifiedOutputText) { return write(owner => {
          id.parse(settlementId);
          if (evidence.verifiedOutput || (evidence.outcome === 'completed') !== (typeof verifiedOutputText === 'string')) fail('RECOVERY_OUTPUT_REQUIRED');
          if (verifiedOutputText !== undefined && Buffer.byteLength(verifiedOutputText, 'utf8') > 512 * 1024) fail('TASK_RESULT_OUTPUT_TOO_LARGE');
          parse(taskExecutionSchemas.manual, evidence);
          if (evidence.decision.actor.kind !== 'installation_owner') fail('RECOVERY_OWNER_REQUIRED');
          validateManagementActor(f, f.taskId, evidence.decision.actor);
          return attemptCommand(f, `settlement:${settlementId}`, { evidence, ...(verifiedOutputText !== undefined ? { verifiedOutputText } : {}) }, () => {
            const { t, a } = currentAttempt(f, owner, true);
            assertResources(f, evidence.decision.resourceChecks);
            if (verifiedOutputText === undefined) return settle(f, t, a, settlementId, evidence);
            const eventId = `recovery_output_${hash(stable([f.sessionId, f.runId, f.taskId, f.attemptId, settlementId]))}`;
            const event = append(f, { id: eventId, type: 'text', data: { role: 'assistant', text: verifiedOutputText, recovery: { decisionId: evidence.decision.decisionId, actor: evidence.decision.actor, evidenceRefs: evidence.decision.evidenceRefs } } }, a, settlementId);
            const result = settle(f, t, a, settlementId, { ...evidence, verifiedOutput: { eventId, digest: hash(verifiedOutputText) } });
            return { ...result, events: [event, ...result.events] };
          });
        }); },
        settleAttempt(f, settlementId, evidence) { return write(owner => {
          id.parse(settlementId);
          if (evidence.kind === 'manual') validateManagementActor(f,f.taskId,parse(taskExecutionSchemas.manual,evidence).decision.actor);
          return attemptCommand(f,`settlement:${settlementId}`,evidence,() => {
            const {t,a}=currentAttempt(f,owner,evidence.kind==='manual');
            return settle(f,t,a,settlementId,evidence);
          });
        }); },
        suspendUnsubmitted(f) { return write(owner => {
          const {t,a}=currentAttempt(f,owner);
          if(a.state!=='preparing' || a.submissionState!=='not_submitted') fail('ATTEMPT_NOT_PREPARING');
          a.state='suspended';t.status='queued';touch(t,a);return transitions(f,t,a);
        }); },
        cancelQueued(rawFence,taskId,expectedTaskRevision,rawDecision) { return write(() => {
          const f=readFence(rawFence);const decision=parse(decisionSchema,rawDecision);
          if(decision.action!=='cancel' || decision.actor.kind==='unspecified') fail('RECOVERY_DECISION_REQUIRED');
          validateManagementActor(f,taskId,decision.actor);
          return command(`decision:${decision.decisionId}`,{...f,taskId,decision},() => {
            const {t,a}=queuedTask(f,taskId,expectedTaskRevision);
            recordDecision(f,a,decision,decision.decisionId);
            if(a) return settle({...f,taskId,attemptId:a.attemptId,expectedRevision:a.revision},t,a,`cancel:${decision.decisionId}`,{kind:'not_submitted',outcome:'cancelled',reason:decision.evidenceRefs.join(',')});
            t.status='cancelled';t.revision++;t.updatedAt=timestamp();saveTask(t);
            const event=append(f,{id:`cancel:${decision.decisionId}`,type:'task',data:{task:{id:t.id,status:t.status}}});
            return result(f,t,undefined,[event]);
          });
        }); },
        markReconcileRequired(f, rawReason) { return write(owner => {
          const reason=parse(taskExecutionSchemas.reconcile,rawReason);
          return attemptCommand(f,`reconcile:${reason.reasonId}`,reason,() => {
            const {t,a}=currentAttempt(f,owner);
            if(a.state==='settled' || a.submissionState==='not_submitted') fail('ATTEMPT_NOT_SUBMITTED');
            a.state='reconcile_required';a.reconcileReason=reason;t.status='reconcile_required';touch(t,a);return transitions(f,t,a);
          });
        }); },
        markOrphanedAttempt(f, rawReason) { return write(owner => {
          const reason = parse(taskExecutionSchemas.reconcile,rawReason);
          return attemptCommand(f,`orphaned:${reason.reasonId}`,reason,() => {
            const {t,a} = currentAttempt(f,owner,true);
            if (sameController(a.controller,owner)) fail('ATTEMPT_CONTROLLER_NOT_ORPHANED');
            if (a.submissionState === 'not_submitted' || !['preparing','active','reconcile_required'].includes(a.state)) fail('ATTEMPT_NOT_SUBMITTED');
            a.state='reconcile_required';a.reconcileReason=reason;t.status='reconcile_required';touch(t,a);
            const committed=transitions(f,t,a);
            committed.events.push(append(f,{id:`orphaned:${reason.reasonId}`,type:'task',data:{reason,reportingController:owner,originalController:a.controller}},a));
            return committed;
          });
        }); },
        recoverAttempt(f, rawEvidence) { return write(owner => {
          const evidence=parse(taskExecutionSchemas.recovery,rawEvidence);
          return attemptCommand(f,`recovery:${evidence.decisionId}`,evidence,() => {
            const {t,a}=currentAttempt(f,owner,true);
            if(evidence.kind==='unsubmitted_preparation') {
              if(a.state!=='preparing' || a.submissionState!=='not_submitted') fail('ATTEMPT_NOT_PREPARING');
              assertResources(f,evidence.safeResources);
              a.state='suspended';t.status='queued';
            } else {
              if(a.submissionState==='not_submitted' || a.state==='settled' || a.state==='legacy_unresolved' || a.submission?.submissionId!==evidence.submissionId || !a.submission.recovery || !same(a.submission.recovery,evidence.recovery)) fail('RECOVERY_TURN_CONFLICT');
              for(const check of evidence.resources) {
                const r=resource(check.resourceId);
                if(!r || r.sessionId!==f.sessionId || r.runId!==f.runId || r.revision!==check.expectedRevision || r.observations.at(-1)?.observationId!==check.observationId || !r.identity || evidence.attached && r.observations.at(-1)?.state!=='live' || !a.submission.resourceRefs.some(ref=>ref.resourceId===r.resourceId&&ref.identityId===r.identity!.identityId)) fail('RESOURCE_OBSERVATION_CONFLICT');
              }
              if(!a.submission.resourceRefs.length || a.submission.resourceRefs.some(ref=>!evidence.resources.some(check=>check.resourceId===ref.resourceId))) fail('RESOURCE_OBSERVATION_REQUIRED');
              // Recovery observations verify the original resources; creation ownership remains immutable.
              if(evidence.attached) {
                for(const check of evidence.resources) {const r=resource(check.resourceId)!;r.holder=owner;r.revision++;saveResource(r);}
                assertResources(f,undefined,owner);
              }
              a.state=evidence.attached?'active':'reconcile_required';t.status=evidence.attached?'running':'reconcile_required';
            }
            recordDecision(f,a,evidence,evidence.decisionId);
            a.recoveryControllers.push({controller:owner,evidence});a.controller=owner;touch(t,a);return transitions(f,t,a);
          });
        }); },
        retryAttempt(f,rawDecision,safeResources) { return write(owner => {
          const decision=parse(decisionSchema,rawDecision);parse(checksSchema,safeResources);
          if(decision.action!=='retry' || decision.actor.kind==='unspecified' || decision.allowDuplicateEffects!==true || !same(decision.resourceChecks,safeResources)) fail('RECOVERY_DECISION_REQUIRED');
          validateManagementActor(f,f.taskId,decision.actor);
          return attemptCommand(f,`decision:${decision.decisionId}`,{decision,safeResources},() => {
            const {t,a}=currentAttempt(f,owner,true);
            requireInputOptions(t.id);
            assertResources(f,safeResources);
            if(session(f.sessionId).archivedAt) fail('SESSION_NOT_ACCEPTING');
            if(a.state==='settled' ? !['failed','interrupted','cancelled','unknown'].includes(a.outcome!) : a.state!=='reconcile_required') fail('ATTEMPT_NOT_RETRYABLE');
            recordDecision(f,a,decision,decision.decisionId);
            let priorEvents:AgentEvent[]=[];
            if(a.state!=='settled') {
              // The explicit retry decision records uncertainty, never manufactures a failed result.
              a.state='settled';a.outcome='unknown';a.settlementId=`retry_unknown:${decision.decisionId}`;
              a.settlement={kind:'manual',outcome:'unknown',decision};
              t.status='reconcile_required';touch(t,a);priorEvents=transitions(f,t,a,true).events;
            }
            const next:TaskAttempt={sessionId:f.sessionId,runId:f.runId,taskId:t.id,attemptId:`attempt_${randomUUID()}`,number:a.number+1,revision:1,state:'suspended',submissionState:'not_submitted',controller:owner,recoveryControllers:[],createdAt:timestamp(),updatedAt:timestamp()};
            t.currentAttemptId=next.attemptId;t.status='queued';t.queuePosition=nextPosition(f.sessionId,'back');t.revision++;t.updatedAt=timestamp();
            const committed=transitions(f,t,next);committed.events=[...priorEvents,...committed.events];return committed;
          });
        }); },
        appendEvent(rawFence,rawEvent) { return write(owner => {
          const event=parse(taskExecutionSchemas.event,rawEvent);
          if('attemptId' in rawFence) {
            const {a}=attemptScope(rawFence);
            // Duplicate output remains replayable after settlement; new output cannot mutate a settled result.
            const sourceKey=event.sourceId?stable([rawFence.sessionId,['attempt',a.attemptId],event.sourceId]):null;
            const old=db.prepare('SELECT 1 FROM events WHERE id=? OR source_key=?').get(event.id,sourceKey);
            if(!old) { currentAttempt(rawFence,owner);if(a.state==='settled'||a.state==='suspended') fail('ATTEMPT_OUTPUT_CLOSED'); }
            return append(rawFence,event,a);
          }
          const f=readFence(rawFence);return append(f,event);
        }); },
        createSession(rawSession) { return write(() => {
          const s=parse(sessionSchema,rawSession);
          if(db.prepare('SELECT 1 FROM sessions WHERE id=?').get(s.id)) fail('SESSION_ALREADY_EXISTS');
          db.prepare('INSERT INTO sessions (id,agent_id,state,cwd,model,reasoning_effort,system_prompt,permission_mode,source,source_id,archived_at,protocol,run_id,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(s.id,s.agentId,s.state,s.cwd,s.model??null,s.reasoningEffort??null,s.systemPrompt??null,s.permissionMode??'ask',s.source??null,s.sourceId??null,s.archivedAt??null,s.protocol??null,s.runId,s.error??null,s.createdAt,s.updatedAt);
          return session(s.id);
        }); },
        finalizeSessionWorkspace(rawFence, rawProof) { return write(() => {
          const f = readFence(rawFence); const proof = parse(taskExecutionSchemas.workspaceProof, rawProof);
          const row = db.prepare('SELECT value FROM configs WHERE key=?').get(`runtime_workspace:${f.sessionId}`) as { value: string } | undefined;
          if (!row || hash(row.value) !== proof.workspaceDigest) fail('WORKSPACE_PROOF_CONFLICT');
          let decoded: unknown;
          try { decoded = JSON.parse(row.value); } catch { fail('WORKSPACE_PROOF_CONFLICT'); }
          const ready = parse(taskExecutionSchemas.workspaceProjection, decoded);
          if (ready.sessionId !== f.sessionId || ready.revision !== proof.workspaceRevision) fail('WORKSPACE_PROOF_CONFLICT');
          const current = session(f.sessionId);
          if (current.cwd === ready.cwd) return current;
          if (current.archivedAt || !['created','starting','failed'].includes(current.state)) fail('SESSION_WORKSPACE_STATE_CONFLICT');
          if (attempts(f.sessionId).length) fail('SESSION_WORKSPACE_HISTORY');
          if (current.cwd !== proof.expectedCwd) fail('WORKSPACE_PROOF_CONFLICT');
          assertResources(f);
          db.prepare('UPDATE sessions SET cwd=?,updated_at=? WHERE id=?').run(ready.cwd,timestamp(),f.sessionId);
          return session(f.sessionId);
        }); },
        recordInterruptIntent(f, rawInput) { return write(owner => {
          const input = parse(taskExecutionSchemas.interruptIntent, rawInput);
          validateManagementActor(f,f.taskId,input.actor);
          return attemptCommand(f, `queue:${input.operationId}`, { source: 'interrupt', input }, () => {
            const { t, a } = currentAttempt(f, owner);
            if (!['preparing','active','reconcile_required'].includes(a.state)) fail('ATTEMPT_NOT_ACTIVE');
            const action = queueAction({sessionId:f.sessionId,runId:f.runId},t,'interrupt',{...input,interrupt:true},a);
            const actor = actorId(input.actor);
            if (actor !== undefined) t.interruptedByActor = actor;
            t.revision++; t.updatedAt = timestamp(); saveTask(t);
            db.prepare('UPDATE tasks SET interrupted_by_actor=? WHERE id=?').run(t.interruptedByActor ?? null,t.id);
            db.prepare('UPDATE sessions SET state=?,updated_at=? WHERE id=?').run('interrupting',timestamp(),f.sessionId);
            const current = session(f.sessionId);
            const events = [append(f,{id:`interrupt:${input.operationId}:intent`,type:'task',data:{task:{id:t.id,status:t.status,revision:t.revision,interruptedByActor:t.interruptedByActor ?? null},actor:input.actor,queueAction:action}},a),
              append(f,{id:`interrupt:${input.operationId}:status`,type:'status',data:{state:current.state,error:current.error ?? null}},a)];
            return {...result(f,t,a,events),action};
          });
        }); },
        patchSessionState(rawFence, operationId, rawPatch) { return write(owner => {
          id.parse(operationId); const patch = parse(taskExecutionSchemas.statePatch, rawPatch);
          const apply = () => {
            let pair: {t: ExecutionTask; a: TaskAttempt} | undefined;
            if ('attemptId' in rawFence) {
              pair = currentAttempt(rawFence,owner);
              if (!['preparing','active'].includes(pair.a.state) || !['thinking','running_tool','waiting_for_permission','interrupting'].includes(patch.state)) fail('ATTEMPT_STATE_PATCH_INVALID');
            } else {
              if (attempts(rawFence.sessionId).some(a => ['preparing','active','reconcile_required','legacy_unresolved'].includes(a.state))) fail('SESSION_EXECUTION_BUSY');
              if (!['created','starting','idle','failed','stopped','interrupted'].includes(patch.state)) fail('SESSION_STATE_PATCH_INVALID');
              if (patch.state === 'stopped') assertResources(rawFence);
              if (patch.state === 'starting' || patch.state === 'idle') assertResources(rawFence,undefined,owner);
            }
            if ('error' in patch) db.prepare('UPDATE sessions SET state=?,error=?,updated_at=? WHERE id=?').run(patch.state,patch.error,timestamp(),rawFence.sessionId);
            else db.prepare('UPDATE sessions SET state=?,updated_at=? WHERE id=?').run(patch.state,timestamp(),rawFence.sessionId);
            const current = session(rawFence.sessionId);
            const event = append(rawFence,{id:`session_state:${operationId}`,type:'status',data:{state:current.state,error:current.error ?? null}},pair?.a);
            return result(rawFence,pair?.t,pair?.a,[event]);
          };
          if ('attemptId' in rawFence) return attemptCommand(rawFence,`session_state:${operationId}`,patch,apply);
          const f = readFence(rawFence);
          return command(`session_state:${operationId}`,{...f,patch},apply);
        }); },
        patchSession(rawFence,rawPatch) { return write(() => {
          const f=readFence(rawFence);const patch=parse(taskExecutionSchemas.sessionPatch,rawPatch);
          if(patch.archivedAt) {
            if(attempts(f.sessionId).some(a=>['preparing','active','reconcile_required','legacy_unresolved','suspended'].includes(a.state))) fail('SESSION_PENDING_ATTEMPTS');
            assertResources(f);
          }
          for(const [key,value] of Object.entries(patch)) db.prepare(`UPDATE sessions SET ${key==='archivedAt'?'archived_at':key}=?,updated_at=? WHERE id=?`).run(value,timestamp(),f.sessionId);
          return session(f.sessionId);
        }); },
        replaceSessionRun(rawFence,newRunId,safeResources) { return write(() => {
          const f=readFence(rawFence);id.parse(newRunId);
          if(newRunId===f.runId) fail('SESSION_RUN_CONFLICT');
          if(attempts(f.sessionId).some(a=>['preparing','active','reconcile_required','legacy_unresolved','suspended'].includes(a.state))) fail('SESSION_PENDING_ATTEMPTS');
          assertResources(f,safeResources);
          const selection = nativeSelection(f.sessionId);
          if (selection) saveNativeSelection(f.sessionId,{...selection,runId:newRunId,revision:nextNativeRevision(f.sessionId)});
          db.prepare('UPDATE sessions SET run_id=?,state=?,error=NULL,updated_at=? WHERE id=?').run(newRunId,'idle',timestamp(),f.sessionId);
          return session(f.sessionId);
        }); },
        beforeCreate(rawFence,rawInput) { return write(owner => {
          const f=readFence(rawFence);const input=parse(taskExecutionSchemas.beforeCreate,rawInput);
          const existing = resource(input.resourceId);
          if (existing && (!sameController(existing.controller, owner) || existing.stage !== 'pending' || existing.creationClosure)) fail('RESOURCE_CREATION_FINISHED');
          return command(`resource_create:${input.resourceId}`,{...f,input},()=>{
            const cleanup = input.parentResourceId && resource(input.parentResourceId)?.operationScope?.kind === 'cleanup';
            if ((session(f.sessionId).archivedAt || session(f.sessionId).state==='stopped') && !cleanup) fail('SESSION_NOT_ACCEPTING');
            if (cleanup && input.kind !== 'process') fail('RESOURCE_SCOPE_CONFLICT');
            if(input.parentResourceId) {
              const parent=resource(input.parentResourceId);
              if(!parent || parent.kind!=='operation' || parent.stage!=='pending' || parent.creationClosure || parent.sessionId!==f.sessionId || parent.runId!==f.runId || !sameController(parent.controller,owner)) fail('RESOURCE_PARENT_CLOSED');
            } else assertResources(f,undefined,owner);
            const parent = input.parentResourceId ? resource(input.parentResourceId) : undefined;
            if(parent?.operationScope?.kind==='submission') {
              const scope=parent.operationScope,a=attempt(scope.attemptId),t=task(scope.taskId);
              if(!a||!t||t.currentAttemptId!==a.attemptId||a.state!=='active'||a.submission?.submissionId!==scope.submissionId||a.submission.driverInstanceId!==parent.driverInstanceId||!sameController(a.controller,owner))fail('SUBMISSION_SCOPE_CONFLICT');
            }
            const r:DriverResource={...f,...input,...(parent?.driverInstanceId?{driverInstanceId:parent.driverInstanceId,operationScope:parent.operationScope}:{}),revision:1,controller:owner,stage:'pending',observations:[],createdAt:timestamp()};saveResource(r);return r;
          });
        }); },
        beforeControlledOperation(rawFence, rawInput) { return write(owner => {
          const f = readFence(rawFence); const input = parse(taskExecutionSchemas.controlledOperation, rawInput);
          const existing = resource(input.resourceId);
          if (existing && (!sameController(existing.controller, owner) || existing.stage !== 'pending' || existing.creationClosure)) fail('RESOURCE_CREATION_FINISHED');
          return command(`resource_create:${input.resourceId}`, { ...f, input }, () => {
            if (existing) fail('RESOURCE_CREATION_PROTOCOL_CONFLICT');
            const s = session(f.sessionId), scope = input.scope ?? {kind:'lifecycle' as const};
            if (scope.kind !== 'cleanup' && (s.archivedAt || s.state === 'stopped')) fail('SESSION_NOT_ACCEPTING');
            if (input.parentResourceId) {
              const parent = resource(input.parentResourceId);
              if (!parent || parent.kind !== 'operation' || parent.stage !== 'pending' || parent.creationClosure
                || parent.sessionId !== f.sessionId || parent.runId !== f.runId || !sameController(parent.controller,owner)
                || parent.driverInstanceId !== input.driverInstanceId || !same(parent.operationScope,scope)) fail('RESOURCE_PARENT_CLOSED');
            } else if (scope.kind === 'submission') {
              const a = attempt(scope.attemptId), t = task(scope.taskId);
              if (!a || !t || a.taskId !== t.id || t.currentAttemptId !== a.attemptId || a.sessionId !== f.sessionId || a.runId !== f.runId
                || a.state !== 'active' || a.submission?.submissionId !== scope.submissionId || a.submission.driverInstanceId !== input.driverInstanceId || !sameController(a.controller,owner)) fail('SUBMISSION_SCOPE_CONFLICT');
              const unsafe = resources(f.sessionId).filter(r => !resourceSafe(r,owner) && !(r.stage === 'pending' && r.driverInstanceId === input.driverInstanceId && sameController(r.controller,owner) && same(r.operationScope,scope)));
              if (unsafe.length || externalBlockers(f.sessionId).length) fail('SESSION_RESOURCE_BLOCKED');
            } else if (scope.kind === 'cleanup') {
              for (const rid of scope.resourceIds) {
                const r = resource(rid);
                if (!r || r.sessionId !== f.sessionId || r.runId !== f.runId || r.driverInstanceId !== input.driverInstanceId || !sameController(r.holder ?? r.controller,owner)) fail('RESOURCE_SCOPE_CONFLICT');
              }
            } else if (scope.kind === 'strict-context-restore') {
              const selection = nativeSelection(f.sessionId);
              if (!selection || selection.runId !== f.runId || selection.revision !== scope.selectionRevision || !same(selection.context,scope.context)) fail('NATIVE_CONTEXT_SELECTION_CONFLICT');
              nativeResource(f.sessionId,scope.context); assertResources(f,undefined,owner);
              const configuration = db.prepare('SELECT value FROM configs WHERE key=?').get(`runtime_driver_configuration:${f.sessionId}`) as {value:string} | undefined;
              if (configuration?.value && !scope.repairConfiguration) fail('DRIVER_CONFIGURATION_UNKNOWN');
            } else assertResources(f,undefined,owner);
            const source = control.creationSource(db, claim);
            const r: DriverResource = { ...f, resourceId: input.resourceId, kind: 'operation',
              ...(input.parentResourceId ? { parentResourceId: input.parentResourceId } : {}),
              revision: 1, controller: owner, stage: 'pending', observations: [], createdAt: timestamp(), driverInstanceId: input.driverInstanceId, operationScope: scope,
              ...(source ? { creationProvenance: { protocol: 'dutydeck_driver_resources_v1', ...source, controller: owner, driverInstanceId: input.driverInstanceId } } : {}) };
            saveResource(r); return r;
          });
        }); },
        reserveNativeContext(rawFence, rawInput) { return write(owner => {
          const f = readFence(rawFence); const input = parse(taskExecutionSchemas.nativeReserve,rawInput);
          id.parse(input.resourceId); id.parse(input.parentResourceId); const expected = parse(taskExecutionSchemas.nativeContextExpectedSchema,input.expected); noCredentials(expected);
          return command(`native_reserve:${input.resourceId}`,{...f,input},() => {
            if (nativeSelection(f.sessionId)) fail('NATIVE_CONTEXT_ALREADY_SELECTED');
            if (resources(f.sessionId).some(r => r.purpose === 'acp_native_context' && !r.nativeReplacement)) fail('NATIVE_CONTEXT_CREATION_UNRESOLVED');
            const parent = resource(input.parentResourceId);
            if (!parent || parent.sessionId !== f.sessionId || parent.runId !== f.runId || parent.kind !== 'operation' || parent.stage !== 'pending' || parent.creationClosure
              || !parent.driverInstanceId || parent.operationScope?.kind !== 'lifecycle' || !sameController(parent.controller,owner)) fail('RESOURCE_PARENT_CLOSED');
            const r:DriverResource = {...f,resourceId:input.resourceId,parentResourceId:parent.resourceId,kind:'remote',purpose:'acp_native_context',nativeExpected:expected,
              driverInstanceId:parent.driverInstanceId,revision:1,controller:owner,stage:'pending',observations:[],createdAt:timestamp()};
            saveResource(r);return r;
          });
        }); },
        assertDriverSubmission(rawFence,rawInput) {return write(owner=>{
          const f=readFence(rawFence),input=parse(taskExecutionSchemas.driverSubmission,rawInput),a=attempt(input.attemptId),t=task(input.taskId);
          if(!a||!t||a.taskId!==input.taskId||t.currentAttemptId!==a.attemptId||a.sessionId!==f.sessionId||a.runId!==f.runId||a.state!=='active'||a.submission?.submissionId!==input.submissionId||a.submission.inputDigest!==input.inputDigest||a.submission.driverInstanceId!==input.driverInstanceId||!sameController(a.controller,owner))fail('SUBMISSION_SCOPE_CONFLICT');
          const configuration=db.prepare('SELECT value FROM configs WHERE key=?').get(`runtime_driver_configuration:${f.sessionId}`) as {value:string}|undefined;
          if(configuration?.value)fail('DRIVER_CONFIGURATION_UNKNOWN');
        });},
        authorizeNativeContextControl(rawFence,actor) { return write(()=>{validateNativeActor(readFence(rawFence),actor);}); },
        confirmRecoveredNativeContext(rawFence,resourceId,expectedRevision,rawIdentity) { return write(owner=>{
          const f=readFence(rawFence),identity=parse(taskExecutionSchemas.nativeIdentitySchema,rawIdentity);id.parse(resourceId);revision.parse(expectedRevision);
          return command(`native_recovered:${resourceId}`,{...f,resourceId,identity},()=>{
            const r=resource(resourceId),parent=r?.parentResourceId?resource(r.parentResourceId):undefined;
            if(!r||r.purpose!=='acp_native_context'||r.sessionId!==f.sessionId||r.runId!==f.runId||r.nativeReplacement||r.stage!=='pending'||r.revision!==expectedRevision)fail('RESOURCE_SCOPE_CONFLICT');
            if(!parent||parent.kind!=='operation'||!parent.operationScope||!resourceSafe(parent)||resources(f.sessionId).some(item=>item.resourceId!==r.resourceId&&!resourceSafe(item)))fail('SESSION_RESOURCE_BLOCKED');
            const {acpxRecordId,backendSessionId,agentSessionId,defaults,...expected}=identity;
            if(!same(expected,r.nativeExpected)||nativeSelection(f.sessionId))fail('NATIVE_CONTEXT_IDENTITY_CONFLICT');
            r.identity={identityId:`native_${hash(stable([resourceId,identity]))}`,kind:'remote',locator:identity};r.stage='created';r.revision++;
            const context={resourceId,identityId:r.identity.identityId,originRunId:r.runId};
            const selection:NativeContextSelection={version:1,revision:nextNativeRevision(f.sessionId),runId:f.runId,context};
            // This recovers the creation receipt, not an attached client or an active turn.
            saveResource(r);saveNativeSelection(f.sessionId,selection);return selection;
          });
        }); },
        clearVerifiedStopBlock(rawFence, expectedValue) { return write(() => {
          const f = readFence(rawFence);
          const key = `runtime_driver_stop_block:${f.sessionId}`;
          const row = db.prepare('SELECT value FROM configs WHERE key=?').get(key) as { value: string } | undefined;
          if (!row?.value) return false;
          if (row.value !== expectedValue) fail('DRIVER_STOP_BLOCK_CONFLICT');
          let block: { sessionId?: string; runId?: string };
          try { block = JSON.parse(row.value); if (!block || typeof block !== 'object') fail('DRIVER_STOP_BLOCK_INVALID'); } catch { fail('DRIVER_STOP_BLOCK_INVALID'); }
          if (block.sessionId !== f.sessionId || block.runId !== f.runId) fail('SESSION_RUN_CONFLICT');
          // No ownership-based live exemption: every old physical resource must be proven gone.
          const unsafe = blockers(f.sessionId).filter(item => item.code !== 'DRIVER_STOP_BLOCKED');
          if (unsafe.length) fail('SESSION_RESOURCE_BLOCKED', json(unsafe));
          const checks = resources(f.sessionId).map(r => ({ resourceId: r.resourceId, revision: r.revision, ...(r.observations.length ? { observation: r.observations.at(-1)! } : {}) }));
          command(`clear_stop:${randomUUID()}`, { ...f, expectedValue, checks }, () => {
            db.prepare("UPDATE configs SET value='' WHERE key=? AND value=?").run(key, expectedValue);
            return { cleared: true };
          });
          return true;
        }); },
        probePhysicalResource(rawFence,resourceId,expectedRevision) {
          if(db.inTransaction)fail('RESOURCE_OBSERVATION_IN_TRANSACTION');
          const f=readFence(rawFence);id.parse(resourceId);revision.parse(expectedRevision);claim.assertCurrent();
          const original=resource(resourceId);
          if(!original||original.sessionId!==f.sessionId||original.runId!==f.runId||original.kind!=='process'||!original.identity)fail('RESOURCE_IDENTITY_REQUIRED');
          if(original.revision!==expectedRevision)fail('RESOURCE_REVISION_CONFLICT');
          const identity=parse(taskExecutionSchemas.creatorIdentitySchema,original.identity.locator);
          const observed=observeProcess(identity);
          return write(()=>{
            readFence(f);const current=resource(resourceId);
            if(!current||current.revision!==expectedRevision||!same(current.identity,original.identity))fail('RESOURCE_REVISION_CONFLICT');
            current.observations.push({observationId:randomUUID(),identityId:original.identity!.identityId,state:observed==='dead'?'gone':observed==='alive'?'live':'unknown',evidenceRef:`readonly-process:${observed}`,observedAt:timestamp()});
            current.revision++;saveResource(current);return current;
          });
        },
        confirmNativeContext(rawFence,resourceId,expectedRevision,rawIdentity) { return write(owner => {
          const f=readFence(rawFence);const identity=parse(taskExecutionSchemas.nativeIdentitySchema,rawIdentity);
          return command(`native_confirm:${resourceId}`,{...f,resourceId,identity},() => {
            const r=resource(resourceId);
            if (!r || r.purpose !== 'acp_native_context' || r.sessionId !== f.sessionId || r.runId !== f.runId || r.nativeReplacement || !sameController(r.controller,owner)) fail('RESOURCE_SCOPE_CONFLICT');
            if (r.revision !== expectedRevision || r.stage !== 'pending') fail('RESOURCE_REVISION_CONFLICT');
            const {acpxRecordId,backendSessionId,agentSessionId,defaults,...expected}=identity;
            if (!same(expected,r.nativeExpected) || nativeSelection(f.sessionId)) fail('NATIVE_CONTEXT_IDENTITY_CONFLICT');
            r.identity={identityId:`native_${hash(stable([resourceId,identity]))}`,kind:'remote',locator:identity};r.stage='created';r.revision++;
            const context={resourceId,identityId:r.identity.identityId,originRunId:r.runId};
            const selection:NativeContextSelection={version:1,revision:nextNativeRevision(f.sessionId),runId:f.runId,context};
            const binding:NativeContextBinding={...f,context,proofId:`native_creation:${resourceId}`,driverInstanceId:r.driverInstanceId!,operationId:r.parentResourceId!,controller:owner,observedAt:timestamp()};
            r.nativeBindings=[binding];saveResource(r);saveNativeSelection(f.sessionId,selection);return selection;
          });
        }); },
        confirmNativeContextRestore(rawFence,rawInput) { return write(owner => {
          const input=parse(taskExecutionSchemas.nativeRestore,rawInput);
          const f=readFence(rawFence); const identity=parse(taskExecutionSchemas.nativeIdentitySchema,input.identity);
          return command(`native_restore:${input.proofId}`,{...f,input},() => {
            const selection=nativeSelection(f.sessionId), r=nativeResource(f.sessionId,input.context), op=resource(input.operationId);
            if (!selection || selection.runId !== f.runId || selection.revision !== input.selectionRevision || !same(selection.context,input.context)) fail('NATIVE_CONTEXT_SELECTION_CONFLICT');
            if (r.revision !== input.expectedRevision || !same(r.identity!.locator,identity)) fail('NATIVE_CONTEXT_IDENTITY_CONFLICT');
            if (!op || op.sessionId !== f.sessionId || op.runId !== f.runId || !op.driverInstanceId || op.operationScope?.kind !== 'strict-context-restore'
              || !same(op.operationScope.context,input.context) || op.stage !== 'pending' || op.creationClosure || !sameController(op.controller,owner)) fail('RESOURCE_SCOPE_CONFLICT');
            const binding:NativeContextBinding={...f,context:input.context,proofId:input.proofId,driverInstanceId:op.driverInstanceId,operationId:op.resourceId,controller:owner,observedAt:timestamp()};
            r.nativeBindings=[...(r.nativeBindings??[]),binding];r.holder=owner;r.revision++;saveResource(r);return binding;
          });
        }); },
        replaceNativeContext(rawFence,rawDecision) { return write(() => {
          const f=readFence(rawFence), decision=parse(taskExecutionSchemas.nativeReplacementSchema,rawDecision);
          validateNativeActor(f,decision.actor);
          command(`native_replace:${decision.decisionId}`,{...f,decision},() => {
            const r=resource(decision.resourceId);
            if (!r || r.sessionId !== f.sessionId || r.purpose !== 'acp_native_context' || !r.nativeExpected || r.nativeReplacement) fail('NATIVE_CONTEXT_IDENTITY_CONFLICT');
            if (r.revision !== decision.expectedRevision) fail('RESOURCE_REVISION_CONFLICT');
            const unsafe=resources(f.sessionId).filter(item=>item.resourceId!==r.resourceId && !resourceSafe(item));
            if (unsafe.length || externalBlockers(f.sessionId).length) fail('SESSION_RESOURCE_BLOCKED');
            if (attempts(f.sessionId).some(a=>['active','preparing'].includes(a.state))) fail('SESSION_EXECUTION_BUSY');
            r.nativeReplacement=decision;r.revision++;saveResource(r);
            const selection=nativeSelection(f.sessionId);
            if (selection?.context.resourceId===r.resourceId) db.prepare('DELETE FROM configs WHERE key=?').run(nativeKey(f.sessionId));
            return {replaced:r.resourceId};
          });
        }); },
        closeAbandonedCreation(rawFence, resourceId, expectedRevision) {
          // Observation must not run under an outer repository transaction either.
          if (db.inTransaction) fail('RESOURCE_OBSERVATION_IN_TRANSACTION');
          const f = readFence(rawFence); id.parse(resourceId); revision.parse(expectedRevision); claim.assertCurrent();
          const original = resource(resourceId);
          if (!original || original.sessionId !== f.sessionId || original.runId !== f.runId || original.kind !== 'operation') fail('RESOURCE_SCOPE_CONFLICT');
          const provenance = original.creationProvenance;
          if (!provenance) fail('RESOURCE_CREATION_PROVENANCE_REQUIRED');
          if (original.creationClosure) return write(() => {
            readFence(f);
            const source = control.creationSource(db, claim);
            if (!source || source.databaseEntity !== provenance.databaseEntity) fail('RESOURCE_DATABASE_IDENTITY_CONFLICT');
            const current = resource(resourceId);
            if (!current || current.sessionId !== f.sessionId || current.runId !== f.runId || !current.creationProvenance
              || !same(current.creationProvenance, provenance)) fail('RESOURCE_CREATION_PROVENANCE_CONFLICT');
            if (!current.creationClosure || current.creationClosure.expectedRevision !== expectedRevision) fail('RESOURCE_REVISION_CONFLICT');
            return current;
          });
          if (original.revision !== expectedRevision || expectedRevision === Number.MAX_SAFE_INTEGER) fail('RESOURCE_REVISION_CONFLICT');
          if (!['pending', 'unknown'].includes(original.stage)) fail('RESOURCE_CREATION_FINISHED');
          if (observeProcess(provenance.creator) !== 'dead') fail('RESOURCE_CREATOR_NOT_PROVEN_DEAD');
          const evidence = { version: 1 as const, state: 'dead' as const, creator: { ...provenance.creator }, observer: currentProcessIdentity(), observedAt: timestamp() };
          const provenanceDigest = hash(stable(provenance));
          return write(owner => {
            readFence(f);
            const source = control.creationSource(db, claim);
            const current = resource(resourceId);
            if (!source || source.databaseEntity !== provenance.databaseEntity) fail('RESOURCE_DATABASE_IDENTITY_CONFLICT');
            if (!current || current.sessionId !== f.sessionId || current.runId !== f.runId || current.kind !== 'operation'
              || !current.creationProvenance || !same(current.creationProvenance, provenance)) fail('RESOURCE_CREATION_PROVENANCE_CONFLICT');
            if (current.creationClosure) {
              if (current.creationClosure.expectedRevision !== expectedRevision) fail('RESOURCE_REVISION_CONFLICT');
              return current;
            }
            if (current.revision !== expectedRevision || current.stage !== original.stage) fail('RESOURCE_REVISION_CONFLICT');
            current.creationClosure = { closureId: `creation_close_${hash(stable([resourceId, provenanceDigest, expectedRevision]))}`,
              provenanceDigest, expectedRevision, validator: owner, evidence };
            current.revision++; saveResource(current); return current;
          });
        },
        spawned(rawFence,resourceId,expectedRevision,rawIdentity) { return write(owner => {
          const f=readFence(rawFence);const identity=parse(identitySchema,rawIdentity);noCredentials(identity.locator);
          return command(`resource_identity:${resourceId}`,{...f,resourceId,identity},()=>{
            const r=resource(resourceId);
            if(!r || r.sessionId!==f.sessionId || r.runId!==f.runId || r.kind==='operation' || r.purpose==='acp_native_context' || r.kind!==identity.kind || !sameController(r.controller,owner)) fail('RESOURCE_SCOPE_CONFLICT');
            if(r.revision!==expectedRevision) fail('RESOURCE_REVISION_CONFLICT');
            if(r.identity || r.stage!=='pending') fail('RESOURCE_IDENTITY_IMMUTABLE');
            r.identity=identity;r.revision++;saveResource(r);return r;
          });
        }); },
        creationFinished(rawFence,resourceId,expectedRevision,finish) { return write(owner => {
          const f=readFence(rawFence);taskExecutionSchemas.finish.parse(finish);
          return command(`resource_finished:${resourceId}`,{...f,resourceId,finish},()=>{
            const r=resource(resourceId);
            if(!r || r.sessionId!==f.sessionId || r.runId!==f.runId || !sameController(r.controller,owner)) fail('RESOURCE_SCOPE_CONFLICT');
            if(r.revision!==expectedRevision) fail('RESOURCE_REVISION_CONFLICT');
            if(r.stage!=='pending' || r.creationClosure || r.purpose==='acp_native_context') fail('RESOURCE_CREATION_FINISHED');
            if(r.kind!=='operation' && (finish==='created'&&!r.identity || finish==='not_created'&&r.identity)) fail('RESOURCE_CREATION_EVIDENCE_INVALID');
            r.stage=finish;r.revision++;saveResource(r);return r;
          });
        }); },
        observed(rawFence,resourceId,expectedRevision,rawObservation) { return write(() => {
          const f=readFence(rawFence);const observation=parse(observationSchema,rawObservation);
          return command(`observation:${observation.observationId}`,{...f,resourceId,observation},()=>{
            const r=resource(resourceId);
            if(!r || r.sessionId!==f.sessionId || r.runId!==f.runId || r.kind==='operation' || r.purpose==='acp_native_context') fail('RESOURCE_SCOPE_CONFLICT');
            if(r.revision!==expectedRevision || r.identity?.identityId!==observation.identityId) fail('RESOURCE_OBSERVATION_CONFLICT');
            if(observation.state==='live' && !r.identity) fail('RESOURCE_IDENTITY_REQUIRED');
            r.observations.push(observation);r.revision++;saveResource(r);return r;
          });
        }); }
      };
      return bound;
    }
  };
}
