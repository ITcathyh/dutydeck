import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { canonicalExecutionJson, type AcceptedTaskInput, type RepositoryBundle, type RuntimeControlClaim, type TaskRequestV1, type TaskAttempt, type SessionFence, type ResourceCheckRef } from '@dutydeck/shared';
import { childProcessIdentity } from './process-identity.js';
import { createRepositories } from './index.js';
import { normalizeAcpxEvent } from '../../acp-client/src/index.js';

const dirs:string[]=[];const opened:Array<{repos:RepositoryBundle;claim?:RuntimeControlClaim}>=[];
afterEach(()=>{for(const item of opened.reverse()){try{item.claim?.release();}catch{}item.repos.close();}opened.length=0;for(const dir of dirs)rmSync(dir,{recursive:true,force:true});dirs.length=0;});
const disk=()=>{const dir=mkdtempSync(join(tmpdir(),'task-ledger-'));dirs.push(dir);return join(dir,'tasks.sqlite');};
const hash=(x:unknown)=>createHash('sha256').update(canonicalExecutionJson(x)).digest('hex');
const f={sessionId:'s',runId:'r'};
const session=(id='s',runId='r')=>({id,runId,agentId:'a',cwd:'/tmp',state:'idle' as const,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'});
const request=(key='one',patch:Partial<TaskRequestV1>={}):TaskRequestV1=>({version:1,namespace:'runtime',key,sessionId:'s',actor:{kind:'unspecified'},prompt:'hello',mode:'queue',skills:[],options:{},sources:[],sourcePayload:null,...patch});
const input=(prompt='hello',agentPrompt=prompt,actorId?:string):AcceptedTaskInput=>{const content={version:2 as const,executionOptions:{permissionMode:'ask' as const},prompt,executionContext:{agentPrompt,...(actorId?{actorId}:{})},contentSources:[]};return {...content,digest:hash(content)};};
const af=(a:TaskAttempt)=>({sessionId:a.sessionId,runId:a.runId,taskId:a.taskId,attemptId:a.attemptId,expectedRevision:a.revision});
const decision=(decisionId:string,action:'retry'|'cancel'|'confirm_result'='confirm_result',resourceChecks:ResourceCheckRef[]=[])=>({decisionId,actor:{kind:'installation_owner' as const,id:'installation_owner' as const},action,evidenceRefs:['operator:verified'],resourceChecks,...(action==='retry'?{allowDuplicateEffects:true}:{})});
function open(filename=':memory:',upgrade=true){const repos=createRepositories(filename);const entry:{repos:RepositoryBundle;claim?:RuntimeControlClaim}={repos};opened.push(entry);if(upgrade)repos.execution.upgradeLegacy();return entry;}
function ready(filename=':memory:'){const entry=open(filename);entry.claim=entry.repos.control.attachRuntime('test-runtime');const x=entry.repos.execution.bind(entry.claim);x.createSession(session());return {...entry,x};}
const accepted=(x:ReturnType<typeof ready>['x'],key='one')=>x.acceptTask(f,request(key),input(),'back');
const claimed=(x:ReturnType<typeof ready>['x'])=>{accepted(x);return x.claimNext(f)!.attempt!;};
const intent=(submissionId='send')=>({submissionId,inputDigest:hash('final'),resourceRefs:[],authorizationRefs:['policy:1']});
const complete=(submissionId='send')=>({kind:'driver_result' as const,submissionId,outcome:'completed' as const,outputDigest:hash('done'),stopReason:'end_turn',complete:true as const});

describe('task execution ledger',()=>{
  it('clears only the exact stop block after probing the original real process gone', async () => {
    const { x, repos } = ready();
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const exit = once(child, 'exit');
    try {
      const identity = childProcessIdentity(child.pid!);
      let r = x.beforeCreate(f, { resourceId: 'original-process', kind: 'process' });
      r = x.spawned(f, r.resourceId, r.revision, { identityId: 'exact-child', kind: 'process', locator: identity });
      r = x.creationFinished(f, r.resourceId, r.revision, 'created');
      const raw = JSON.stringify({ ...f, reason: 'unverified' });
      await repos.config.set('runtime_driver_stop_block:s', raw);
      r = x.probePhysicalResource(f, r.resourceId, r.revision);
      expect(r.observations.at(-1)?.state).toBe('live');
      expect(() => x.clearVerifiedStopBlock(f, raw)).toThrow(expect.objectContaining({ code: 'SESSION_RESOURCE_BLOCKED' }));
      child.kill('SIGTERM'); await exit;
      expect(() => x.probePhysicalResource(f, r.resourceId, r.revision - 1)).toThrow(/RESOURCE_REVISION_CONFLICT/);
      r = x.probePhysicalResource(f, r.resourceId, r.revision);
      expect(r.observations.at(-1)?.state).toBe('gone');
      expect(() => x.clearVerifiedStopBlock(f, raw + ' ')).toThrow(/DRIVER_STOP_BLOCK_CONFLICT/);
      expect(() => x.clearVerifiedStopBlock({ ...f, runId: 'stale-run' }, raw)).toThrow(/SESSION_RUN_CONFLICT/);
      expect(x.clearVerifiedStopBlock(f, raw)).toBe(true);
      expect(await repos.config.get('runtime_driver_stop_block:s')).toBe('');
      expect(x.clearVerifiedStopBlock(f, raw)).toBe(false);
      await repos.config.set('runtime_driver_stop_block:s', raw);
      expect(x.clearVerifiedStopBlock(f, raw)).toBe(true);
      expect(await repos.config.get('runtime_driver_stop_block:s')).toBe('');
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; }
  });
  it('defaults to schema-only and requires explicit conversion, including in memory',async()=>{
    const e=open(':memory:',false);expect(e.repos.execution.authority()).toBe('legacy');
    await e.repos.sessions.save(session());await e.repos.tasks.save({id:'old',sessionId:'s',prompt:'old',status:'running',createdAt:session().createdAt,updatedAt:session().updatedAt});
    e.claim=e.repos.control.attachRuntime('live');const x=e.repos.execution.bind(e.claim);
    expect(()=>x.claimNext(f)).toThrow(/EXECUTION_AUTHORITY_LEGACY/);
    expect(()=>e.repos.execution.upgradeLegacy()).toThrow(/DATABASE_RUNTIME_STILL_ATTACHED/);
    e.claim.release();e.claim=undefined;await e.repos.tasks.save({id:'old',sessionId:'s',prompt:'old',status:'completed',createdAt:session().createdAt,updatedAt:session().updatedAt});
    e.repos.execution.upgradeLegacy();expect(e.repos.execution.getTaskExecution('old')!.currentAttempt!.outcome).toBe('completed');
    e.repos.execution.upgradeLegacy();expect(e.repos.execution.getTaskExecution('old')!.attempts).toHaveLength(1);
  });
  it('returns the first accepted snapshot for identical input and conflicts on changed semantic fields',()=>{
    const {x,repos}=ready();const first=accepted(x);
    const replay=x.acceptTask(f,request(),input('hello','later remote bytes'),'back');
    expect(replay.replayed).toBe(true);expect(replay.accepted!.input).toEqual(first.accepted!.input);
    for(const patch of [{prompt:'other'},{mode:'interrupt' as const},{skills:['new']},{sourcePayload:{a:1}}])expect(()=>x.acceptTask(f,request('one',patch),input(),'back')).toThrow(/TASK_IDEMPOTENCY_CONFLICT/);
    expect(repos.execution.getTaskExecution(first.task!.id)!.attempts).toEqual([]);
  });
  it('rejects lossy JSON, execution credentials, digest mismatch and actor conflicts',()=>{
    const {x}=ready();
    for(const payload of [NaN,undefined,new Date(),[undefined]])expect(()=>x.acceptTask(f,request('bad',{sourcePayload:payload as any}),input(),'back')).toThrow(/EXECUTION_INVALID_INPUT/);
    expect(()=>x.acceptTask(f,{...request('secret'),env:{TOKEN:'secret'}} as any,input(),'back')).toThrow(/EXECUTION_INVALID_INPUT/);
    expect(()=>x.acceptTask(f,request(),{...input(),digest:hash('bad')},'back')).toThrow(/TASK_INPUT_DIGEST_CONFLICT/);
    expect(()=>x.acceptTask(f,request(),input('hello','hello','installation_owner'),'back')).toThrow(/TASK_ACTOR_CONFLICT/);
    x.createSession({...session('lark'),source:'lark',sourceId:'app:chat:p2p'});
    expect(()=>x.acceptTask({sessionId:'lark',runId:'r'},request('app',{sessionId:'lark'}),input(),'back')).toThrow(/ACTOR_REQUIRED/);
    expect(()=>x.acceptTask({sessionId:'lark',runId:'r'},request('app',{sessionId:'lark',actor:{kind:'channel',id:'ou_x',appId:'wrong'}}),input('hello','hello','ou_x'),'back')).toThrow(/TASK_ACTOR_CONFLICT/);
  });
  it('canonicalizes object keys but keeps array order and Unicode bytes',()=>{
    expect(hash({b:2,a:1})).toBe(hash({a:1,b:2}));expect(hash([1,2])).not.toBe(hash([2,1]));expect(hash('é')).not.toBe(hash('e\u0301'));
  });
  it('enforces one activity slot and retains an unsubmitted Attempt across suspend and new generation',()=>{
    const e=ready();const a=claimed(e.x);accepted(e.x,'two');
    expect(()=>e.x.claimNext(f)).toThrow(/SESSION_EXECUTION_BUSY/);
    const suspended=e.x.suspendUnsubmitted(af(a));expect(suspended.task!.status).toBe('queued');
    expect(()=>e.x.replaceSessionRun(f,'new',[])).toThrow(/SESSION_PENDING_ATTEMPTS/);
    e.claim!.release();const claim=e.repos.control.attachRuntime('next');opened.find(v=>v.repos===e.repos)!.claim=claim;
    const next=e.repos.execution.bind(claim).claimNext(f)!;expect(next.attempt!.attemptId).toBe(a.attemptId);expect(next.attempt!.number).toBe(1);
    expect(()=>e.x.appendEvent(f,{id:'old',type:'text',data:{}})).toThrow(/DATABASE_RUNTIME_CLAIM_REVOKED/);
  });
  it('keeps submission and settlement idempotent, including an old revision, without duplicate events',async()=>{
    const {x,repos}=ready();const a=claimed(x);const active=x.markSubmissionPending(af(a),intent());
    expect(x.markSubmissionPending(af(a),intent()).replayed).toBe(true);
    expect(()=>x.markSubmissionPending(af(a),{...intent(),inputDigest:hash('different')})).toThrow(/EXECUTION_OPERATION_CONFLICT/);
    const receipt={submissionId:'send',kind:'provider_accepted' as const,provider:'fixture',receiptRef:'remote:accepted',digest:hash('ack')};
    const acknowledged=x.markSubmitted(af(active.attempt!),receipt);
    const final=x.settleAttempt(af(acknowledged.attempt!),'done',complete());
    const all=await repos.events.list('s');expect(final.task!.status).toBe('completed');expect(final.attempt!.submissionController).toEqual(active.attempt!.controller);
    expect(x.settleAttempt(af(acknowledged.attempt!),'done',complete()).replayed).toBe(true);expect(await repos.events.list('s')).toHaveLength(all.length);
    expect(()=>x.settleAttempt(af(final.attempt!),'late',{kind:'not_submitted',outcome:'failed',reason:'timeout'})).toThrow(/ATTEMPT_ALREADY_SETTLED/);
    expect(()=>x.retryAttempt(af(final.attempt!),decision('retry','retry'),[])).toThrow(/ATTEMPT_NOT_RETRYABLE/);
  });
  it('atomically rolls back submission and completion if the Session projection write fails',()=>{
    const filename=disk();const {x,repos}=ready(filename);const a=claimed(x);const sql=new Database(filename);
    sql.exec("CREATE TRIGGER fail_session BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'injected'); END;");
    expect(()=>x.markSubmissionPending(af(a),intent())).toThrow(/injected/);expect(repos.execution.getTaskExecution(a.taskId)!.currentAttempt!.submissionState).toBe('not_submitted');
    sql.exec('DROP TRIGGER fail_session');const active=x.markSubmissionPending(af(a),intent()).attempt!;
    sql.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events WHEN NEW.type='completed' BEGIN SELECT RAISE(ABORT,'event failure'); END;");
    expect(()=>x.settleAttempt(af(active),'done',complete())).toThrow(/event failure/);expect(repos.execution.getTaskExecution(a.taskId)!.task.status).toBe('running');
    sql.exec('DROP TRIGGER fail_event');expect(x.settleAttempt(af(active),'done',complete()).task!.status).toBe('completed');sql.close();
  });
  it('requires submitted uncertainty to reconcile and preserves separate output on explicit retry',()=>{
    const {x,repos}=ready();const active=x.markSubmissionPending(af(claimed(x)),intent()).attempt!;
    x.appendEvent(af(active),{id:'old-output',type:'text',data:{text:'old'},sourceId:'line1'});
    const unknown=x.markReconcileRequired(af(active),{reasonId:'timeout',code:'TIMEOUT',evidenceRefs:['transport:closed']}).attempt!;
    const retry=x.retryAttempt(af(unknown),decision('retry','retry'),[]);
    expect(retry.attempt!.number).toBe(2);expect(retry.attempt!.state).toBe('suspended');expect(repos.execution.getTaskExecution(active.taskId)!.attempts[0]!.outcome).toBe('unknown');
    expect(repos.execution.getTaskExecution(active.taskId)!.attempts[0]!.settlement).toEqual({kind:'manual',outcome:'unknown',decision:decision('retry','retry')});
    const next=x.claimNext(f)!.attempt!;x.appendEvent(af(next),{id:'new-output',type:'text',data:{text:'new'},sourceId:'line1'});
    expect(repos.execution.getAttemptEvents(active.attemptId).some(e=>(e.data as any).text==='new')).toBe(false);
    expect(repos.execution.getAttemptEvents(next.attemptId).some(e=>(e.data as any).text==='old')).toBe(false);
  });
  it('never treats cancellation of an unclaimed Task as an Attempt and fixes interrupt targets',()=>{
    const {x,repos}=ready();const a=claimed(x);const second=accepted(x,'two').task!;
    const operation={operationId:'promote',actor:{kind:'installation_owner' as const,id:'installation_owner' as const},interrupt:true};
    x.promoteQueued(f,second.id,second.revision,operation);
    const pending=x.getPendingQueueActions(f)[0]!;expect(pending.target!.attemptId).toBe(a.attemptId);
    expect(x.promoteQueued(f,second.id,second.revision,operation).replayed).toBe(true);
    expect(()=>x.promoteQueued(f,second.id,second.revision,{...operation,interrupt:false})).toThrow(/EXECUTION_OPERATION_CONFLICT/);
    x.settleAttempt(af(a),'cancel-first',{kind:'not_submitted',outcome:'cancelled',reason:'user cancel'});
    const later=x.claimNext(f)!.attempt!;
    const applied=x.settleQueueAction(f,pending.operationId,pending.revision,{evidenceId:'applied',state:'applied',reason:'original target settled',resourceChecks:[]});
    expect(applied.target!.attemptId).toBe(a.attemptId);expect(repos.execution.getTaskExecution(later.taskId)!.task.status).toBe('running');
    const third=accepted(x,'three').task!;const cancelled=x.cancelQueued(f,third.id,third.revision,decision('cancel-third','cancel'));expect(cancelled.task!.status).toBe('cancelled');expect(repos.execution.getTaskExecution(third.id)!.attempts).toEqual([]);
  });
  it('records a steering delivery into a submitted Attempt and takes the Task off the queue',()=>{
    const {x,repos}=ready();const a=claimed(x);const second=accepted(x,'two').task!;
    const delivery={operationId:'steer-two',actor:{kind:'unspecified' as const},target:{taskId:a.taskId,attemptId:a.attemptId},outcome:'injected' as const};
    // Unsubmitted content has not reached the provider yet; there is nothing to steer into.
    expect(()=>x.deliverQueuedBySteering(f,second.id,second.revision,delivery)).toThrow(/STEERING_TARGET_CONFLICT/);
    x.markSubmissionPending(af(a),intent());
    const delivered=x.deliverQueuedBySteering(f,second.id,second.revision,delivery);
    expect(delivered.task!.status).toBe('completed');expect(repos.execution.getTaskExecution(second.id)!.attempts).toEqual([]);
    expect(delivered.events.map(event=>[event.type,(event.data as any).steering?.outcome,(event.data as any).role])).toEqual([['text','injected','user'],['task','injected',undefined]]);
    expect(x.deliverQueuedBySteering(f,second.id,second.revision,delivery).replayed).toBe(true);
    expect(()=>x.deliverQueuedBySteering(f,second.id,second.revision+1,{...delivery,operationId:'steer-again'})).toThrow(/TASK_NOT_QUEUED/);
    x.settleAttempt(af(repos.execution.getTaskExecution(a.taskId)!.currentAttempt!),'settle-first',complete());
    expect(x.claimNext(f)).toBeUndefined();
  });
  it('refuses a steering delivery for a Task whose consumer reads its own Attempt',()=>{
    const {x}=ready();const a=claimed(x);x.markSubmissionPending(af(a),intent());
    const scheduled=x.acceptTask(f,request('two',{namespace:'schedule',actor:{kind:'installation_owner',id:'installation_owner'}}),input('hello','hello','installation_owner'),'back').task!;
    expect(()=>x.deliverQueuedBySteering(f,scheduled.id,scheduled.revision,{operationId:'steer-schedule',actor:{kind:'unspecified'},target:{taskId:a.taskId,attemptId:a.attemptId},outcome:'injected'})).toThrow(/STEERING_TASK_OWNED/);
  });
  it('captures no interrupt target once and never retargets later activity',()=>{
    const {x}=ready();const first=x.acceptTask(f,request('one',{mode:'interrupt'}),input(),'front');expect(x.getPendingQueueActions(f)).toEqual([]);
    x.claimNext(f);expect(x.acceptTask(f,request('one',{mode:'interrupt'}),input(),'front').task!.id).toBe(first.task!.id);expect(x.getPendingQueueActions(f)).toEqual([]);
  });
  it('allocates events after legacy high watermarks and rejects conflicting event/source replays',async()=>{
    const e=open(':memory:',false);await e.repos.sessions.save(session());await e.repos.events.append({id:'old',sessionId:'s',sequence:40,type:'text',timestamp:session().createdAt,data:{text:'old'}});e.repos.execution.upgradeLegacy();e.claim=e.repos.control.attachRuntime('new');const x=e.repos.execution.bind(e.claim);
    const one=x.appendEvent(f,{id:'one',type:'text',data:{a:1,b:2},sourceId:'session-event'});expect(one.sequence).toBe(41);
    expect(x.appendEvent(f,{id:'another-id',type:'text',data:{b:2,a:1},sourceId:'session-event'}).id).toBe('one');
    expect(()=>x.appendEvent(f,{id:'one',type:'text',data:{a:3},sourceId:'session-event'})).toThrow(/EVENT_IDEMPOTENCY_CONFLICT/);expect((await e.repos.events.list('s'))[0]!.sequence).toBe(40);
  });
  it('keeps operation and two children independent, binding identities once and blocking unfinished parents',()=>{
    const {x,repos}=ready();const op=x.beforeCreate(f,{resourceId:'op',kind:'operation'});
    for(const name of ['probe','agent']){
      const child=x.beforeCreate(f,{resourceId:name,kind:'process',parentResourceId:op.resourceId});
      const identified=x.spawned(f,name,child.revision,{identityId:`identity-${name}`,kind:'process',locator:{pid:name==='probe'?101:102,startTicks:'123',boot:'fixture',pidNamespace:'fixture'}});
      expect(()=>x.spawned(f,name,child.revision,{identityId:'replacement',kind:'process',locator:{pid:999}})).toThrow(/EXECUTION_OPERATION_CONFLICT/);
      const finished=x.creationFinished(f,name,identified.revision,'created');
      x.observed(f,name,finished.revision,{observationId:`gone-${name}`,state:'gone',identityId:`identity-${name}`,evidenceRef:'original-child-close',observedAt:session().createdAt});
    }
    expect(repos.execution.getResources('s')).toHaveLength(3);expect(repos.execution.getSessionResourceBlockers('s').map(b=>b.resourceId)).toEqual(['op']);
    accepted(x);expect(()=>x.claimNext(f)).toThrow(expect.objectContaining({code:'SESSION_RESOURCE_BLOCKED'}));
    x.creationFinished(f,'op',op.revision,'created');expect(repos.execution.getSessionResourceBlockers('s')).toEqual([]);
    expect(()=>x.beforeCreate(f,{resourceId:'late',kind:'process',parentResourceId:'op'})).toThrow(/RESOURCE_PARENT_CLOSED/);
    expect(x.claimNext(f)!.attempt!.state).toBe('preparing');
  });
  it('does not finish or silently discard unknown pending creation under a newer claim',()=>{
    const e=ready();const op=e.x.beforeCreate(f,{resourceId:'pending-op',kind:'operation'});e.x.beforeCreate(f,{resourceId:'pending-child',kind:'process',parentResourceId:'pending-op'});
    e.claim!.release();const claim=e.repos.control.attachRuntime('newer');opened.find(v=>v.repos===e.repos)!.claim=claim;const x=e.repos.execution.bind(claim);
    expect(()=>x.creationFinished(f,op.resourceId,op.revision,'not_created')).toThrow(/RESOURCE_SCOPE_CONFLICT/);
    expect(e.repos.execution.getSessionResourceBlockers('s')).toHaveLength(2);
    expect(()=>x.replaceSessionRun(f,'new-run',[])).toThrow(/RESOURCE_OBSERVATION_REQUIRED|SESSION_RESOURCE_BLOCKED/);
  });
  it('checks physical identity and observation revisions before retry; failure rolls back identity binding',()=>{
    const filename=disk();const {x,repos}=ready(filename);const a=claimed(x);const child=x.beforeCreate(f,{resourceId:'proc',kind:'process'});const sql=new Database(filename);
    sql.exec("CREATE TRIGGER fail_identity BEFORE UPDATE ON driver_resources WHEN NEW.identity_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'identity failure'); END");
    expect(()=>x.spawned(f,'proc',child.revision,{identityId:'pid1',kind:'process',locator:{pid:42}})).toThrow(/identity failure/);expect(repos.execution.getResources('s')[0]!.identity).toBeUndefined();sql.exec('DROP TRIGGER fail_identity');sql.close();
    let r=x.spawned(f,'proc',child.revision,{identityId:'pid1',kind:'process',locator:{pid:42}});r=x.creationFinished(f,'proc',r.revision,'created');
    r=x.observed(f,'proc',r.revision,{observationId:'live',state:'live',identityId:'pid1',evidenceRef:'original-process',observedAt:session().createdAt});
    const active=x.markSubmissionPending(af(a),{...intent(),resourceRefs:[{resourceId:'proc',identityId:'pid1'}]}).attempt!;
    const unknown=x.markReconcileRequired(af(active),{reasonId:'unknown',code:'DISCONNECTED',evidenceRefs:[]}).attempt!;
    const unsafe=[{resourceId:'proc',expectedRevision:r.revision,observationId:'live'}];
    expect(()=>x.retryAttempt(af(unknown),decision('retry','retry',unsafe),unsafe)).toThrow(expect.objectContaining({code:'SESSION_RESOURCE_BLOCKED'}));
    r=x.observed(f,'proc',r.revision,{observationId:'gone',state:'gone',identityId:'pid1',evidenceRef:'exact-process-closed',observedAt:session().createdAt});
    expect(()=>x.retryAttempt(af(unknown),decision('retry','retry',unsafe),unsafe)).toThrow(/RESOURCE_OBSERVATION_CONFLICT/);
    const safe=[{resourceId:'proc',expectedRevision:r.revision,observationId:'gone'}];expect(x.retryAttempt(af(unknown),decision('retry','retry',safe),safe).attempt!.number).toBe(2);
  });
  it('attaches an original turn under a new claim without changing original submission identity',()=>{
    const e=ready();const a=claimed(e.x);let r=e.x.beforeCreate(f,{resourceId:'pty',kind:'tmux'});r=e.x.spawned(f,r.resourceId,r.revision,{identityId:'tmux1',kind:'tmux',locator:{owner:'exact'}});r=e.x.creationFinished(f,r.resourceId,r.revision,'created');r=e.x.observed(f,r.resourceId,r.revision,{observationId:'live-old',state:'live',identityId:'tmux1',evidenceRef:'old-owner',observedAt:session().createdAt});
    const recovery={kind:'pty-jsonl-v1' as const,turnId:'turn1',transcript:{path:'/transcript',offset:7}};
    const active=e.x.markSubmissionPending(af(a),{...intent(),recovery,resourceRefs:[{resourceId:'pty',identityId:'tmux1'}]}).attempt!;
    e.claim!.release();const claim=e.repos.control.attachRuntime('recovered');opened.find(v=>v.repos===e.repos)!.claim=claim;const x=e.repos.execution.bind(claim);
    r=x.observed(f,r.resourceId,r.revision,{observationId:'live-new',state:'live',identityId:'tmux1',evidenceRef:'verified-turn-cursor',observedAt:session().createdAt});
    const recovered=x.recoverAttempt(af(active),{kind:'original_turn',decisionId:'recover',submissionId:'send',recovery,attached:true,resources:[{resourceId:r.resourceId,expectedRevision:r.revision,observationId:'live-new'}]}).attempt!;
    expect(recovered.submissionController).toEqual(active.controller);expect(recovered.controller.generation).not.toBe(active.controller.generation);expect(recovered.submission).toEqual(active.submission);expect(recovered.attemptId).toBe(active.attemptId);
  });
  it('requires bundle-issued claims and validates the actual business control row in each transaction',()=>{
    const filename=disk();const e=ready(filename);const b=open(filename,false);
    expect(()=>e.repos.execution.bind({...e.claim!})).toThrow(/DATABASE_RUNTIME_CLAIM_REVOKED/);
    expect(()=>b.repos.execution.bind(e.claim!)).toThrow(/DATABASE_RUNTIME_CLAIM_REVOKED/);
    const other=ready();expect(()=>e.repos.execution.bind(other.claim!)).toThrow(/DATABASE_RUNTIME_CLAIM_REVOKED/);
    const sql=new Database(filename);const original=sql.prepare('SELECT * FROM dutydeck_control').get() as Record<string,any>;
    for(const [column,value] of [['protocol',99],['phase','maintenance'],['entity','other-file'],['runtime','other-access'],['instance','other-instance'],['generation',original.generation+1]]){
      sql.prepare(`UPDATE dutydeck_control SET ${column}=?`).run(value);
      expect(()=>e.x.appendEvent(f,{id:`tampered-${column}`,type:'text',data:{}})).toThrow(/DATABASE_RUNTIME_CLAIM_REVOKED/);
      sql.prepare(`UPDATE dutydeck_control SET ${column}=?`).run(original[column!]);
    }
    expect(sql.prepare("SELECT COUNT(*) AS n FROM events WHERE id LIKE 'tampered-%'").get()).toEqual({n:0});sql.close();
  });
  it('refuses maintenance while another access or this bundle Runtime is active and never partially switches',async()=>{
    const filename=disk();const e=open(filename,false);await e.repos.sessions.save(session());const other=open(filename,false);
    expect(()=>e.repos.execution.upgradeLegacy()).toThrow(/DATABASE_UPGRADE_BUSY/);expect(e.repos.execution.authority()).toBe('legacy');other.repos.close();opened.splice(opened.indexOf(other),1);
    e.claim=e.repos.control.attachRuntime('active');expect(()=>e.repos.execution.upgradeLegacy()).toThrow(/DATABASE_RUNTIME_STILL_ATTACHED/);e.claim.release();e.claim=undefined;
    const sql=new Database(filename);sql.exec("CREATE TRIGGER fail_convert BEFORE INSERT ON driver_resources BEGIN SELECT RAISE(ABORT,'convert failure'); END");
    expect(()=>e.repos.execution.upgradeLegacy()).toThrow(/convert failure/);expect(e.repos.execution.authority()).toBe('legacy');expect(sql.prepare('SELECT COUNT(*) AS n FROM driver_resources').get()).toEqual({n:0});expect(sql.prepare('SELECT phase FROM dutydeck_control').get()).toEqual({phase:'idle'});
    sql.exec('DROP TRIGGER fail_convert');e.repos.execution.upgradeLegacy();sql.close();
  });
  it('preserves all ambiguous legacy attempts, legacy replay validation and missing-input blockers',async()=>{
    const e=open(':memory:',false);await e.repos.sessions.save(session());
    const at=session().createdAt;
    for(const [taskId,status] of [['run1','running'],['run2','mystery'],['missing','queued'],[`task_${createHash('sha256').update('s\0legacy').digest('hex')}`,'completed']])await e.repos.tasks.save({id:taskId!,sessionId:'s',prompt:'hello',status:status!,...(taskId!=='missing'?{executionContext:{agentPrompt:'hello'}}:{}),createdAt:at,updatedAt:at});
    e.repos.execution.upgradeLegacy();expect(e.repos.execution.getTaskExecution('run1')!.currentAttempt!.state).toBe('legacy_unresolved');expect(e.repos.execution.getTaskExecution('run2')!.currentAttempt!.legacy).toEqual({status:'mystery'});
    expect(e.repos.execution.getTaskExecution('missing')!.blockers.some(b=>b.code==='INPUT_SNAPSHOT_UNVERIFIABLE')).toBe(true);
    expect(e.repos.execution.lookupAccepted(request('legacy'))!.replayValidation).toBe('legacy_partial');expect(()=>e.repos.execution.lookupAccepted(request('legacy',{prompt:'changed'}))).toThrow(/TASK_IDEMPOTENCY_CONFLICT/);
    e.claim=e.repos.control.attachRuntime('new');const x=e.repos.execution.bind(e.claim);
    for(const taskId of ['run1','run2']) {const a=e.repos.execution.getTaskExecution(taskId)!.currentAttempt!;x.settleAttempt(af(a),`manual-${taskId}`,{kind:'manual',outcome:'interrupted',decision:decision(`resolve-${taskId}`)});}
    expect(e.repos.execution.getSessionResourceBlockers('s').some(b=>b.code==='LEGACY_MULTIPLE_EXECUTIONS')).toBe(false);
    expect(e.repos.execution.getSessionResourceBlockers('s').some(b=>b.code==='DRIVER_RESOURCE_UNSAFE')).toBe(true);
  });
  it('blocks old execution writes after conversion but preserves normal config changes',async()=>{
    const {repos,x}=ready();const t=accepted(x).task!;
    for(const work of [()=>repos.tasks.save(t),()=>repos.tasks.create!(t),()=>repos.tasks.enqueue!(t,'back'),()=>repos.tasks.promoteQueued!('s',t.id),()=>repos.events.append({id:'bypass',sessionId:'s',sequence:1,type:'text',timestamp:session().createdAt,data:{}}),()=>repos.sessions.save({...session(),runId:'new'})])await expect(work()).rejects.toMatchObject({code:'EXECUTION_LEDGER_REQUIRED'});
    await repos.sessions.save({...session(),model:'changed',systemPrompt:'custom'});expect((await repos.sessions.get('s'))!.model).toBe('changed');await repos.config.set('ordinary.title','ok');expect(await repos.config.get('ordinary.title')).toBe('ok');
  });
  it('recovers a real SIGKILL preparing claim as the same unsubmitted Attempt',async()=>{
    const filename=disk();const fixture=resolve('packages/storage/tests/task-execution-child.mts');
    const child=spawn(process.execPath,['--conditions=development','--import','tsx',fixture,filename],{stdio:['ignore','pipe','pipe']});let exited=false;child.once('exit',()=>{exited=true;});
    const end=once(child,'exit');let errors='';child.stderr!.on('data',chunk=>{errors+=chunk;});
    try{
      const a=await new Promise<TaskAttempt>((resolve,reject)=>{let buffer='';child.stdout!.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n'))resolve(JSON.parse(buffer.split('\n')[0]!));});child.once('error',reject);child.once('exit',()=>reject(new Error(errors||'fixture exited early')));});
      child.kill('SIGKILL');await end;
      const e=open(filename,false);e.claim=e.repos.control.attachRuntime('after-crash');const x=e.repos.execution.bind(e.claim);
      const suspended=x.recoverAttempt(af(a),{kind:'unsubmitted_preparation',decisionId:'recover-crash',safeResources:[]});expect(suspended.attempt!.state).toBe('suspended');const recovered=x.claimNext({sessionId:a.sessionId,runId:a.runId})!;
      expect(recovered.attempt!.attemptId).toBe(a.attemptId);expect(recovered.attempt!.number).toBe(1);expect(recovered.attempt!.submissionState).toBe('not_submitted');
    } finally {if(!exited){child.kill('SIGKILL');await end;}}
  },20000);
  it('rolls back an accepted request, snapshot and interrupt action when event insertion fails',()=>{
    const filename=disk();const {x,repos}=ready(filename);const sql=new Database(filename);
    sql.exec("CREATE TRIGGER fail_accept BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'accept failure'); END");
    expect(()=>x.acceptTask(f,request('atomic',{mode:'interrupt'}),input(),'front')).toThrow(/accept failure/);
    for(const table of ['tasks','task_requests','task_queue_actions'])expect(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({n:0});
    sql.exec('DROP TRIGGER fail_accept');expect(x.acceptTask(f,request('atomic',{mode:'interrupt'}),input(),'front').replayed).toBe(false);sql.close();
  });
  it('replays completed acceptance after archive and changes only execution fields during settlement',async()=>{
    const {x,repos}=ready();const a=claimed(x);const s=(await repos.sessions.get('s'))!;
    await repos.sessions.save({...s,model:'preserve-model',systemPrompt:'preserve-prompt'});
    const active=x.markSubmissionPending(af(a),intent()).attempt!;x.settleAttempt(af(active),'final',complete());
    expect(await repos.sessions.get('s')).toMatchObject({model:'preserve-model',systemPrompt:'preserve-prompt'});
    x.patchSession(f,{archivedAt:session().createdAt});
    expect(x.acceptTask(f,request(),input(),'back')).toMatchObject({replayed:true,task:{status:'completed'}});
    expect(()=>x.acceptTask(f,request('one',{prompt:'changed'}),input(),'back')).toThrow(/TASK_IDEMPOTENCY_CONFLICT/);
  });
  it('keeps every old session resource unknown and aggregates existing verification, workspace and stop evidence',async()=>{
    const e=open(':memory:',false);
    await e.repos.sessions.save(session());await e.repos.sessions.save({...session('archived'),archivedAt:session().createdAt});
    await e.repos.config.set('runtime_driver_stop_block:s',JSON.stringify({sessionId:'s',runId:'r',reason:'stop failed'}));
    await e.repos.config.set('runtime_workspace:s',JSON.stringify({sessionId:'s',state:'cleaning'}));
    await e.repos.config.set('runtime_verification:s:check',JSON.stringify({sessionId:'s',status:'running'}));
    e.repos.execution.upgradeLegacy();
    expect(e.repos.execution.getResources('archived')).toHaveLength(1);
    expect(e.repos.execution.getSessionResourceBlockers('s').map(b=>b.code).sort()).toEqual(['DRIVER_RESOURCE_UNSAFE','DRIVER_STOP_BLOCKED','VERIFICATION_RESOURCE_UNKNOWN','WORKSPACE_RECOVERY_REQUIRED']);
  });
  it('enforces the SQLite activity uniqueness index independently of the command checks',()=>{
    const filename=disk();const {x}=ready(filename);const a=claimed(x);const second=accepted(x,'two').task!;const sql=new Database(filename);
    expect(()=>sql.prepare("INSERT INTO task_attempts (id,task_id,session_id,run_id,number,revision,state,submission_state,json) VALUES ('b',?,'s','r',1,1,'preparing','not_submitted','{}')").run(second.id)).toThrow(/UNIQUE/);
    expect(sql.prepare('SELECT id FROM task_attempts').all()).toEqual([{id:a.attemptId}]);sql.close();
  });
  it('retains preparing when recovery evidence is unsafe and prevents downgrade of submitted facts',()=>{
    const {x,repos}=ready();const a=claimed(x);let r=x.beforeCreate(f,{resourceId:'pending',kind:'process'});
    expect(()=>x.recoverAttempt(af(a),{kind:'unsubmitted_preparation',decisionId:'unsafe',safeResources:[]})).toThrow(/RESOURCE_OBSERVATION_REQUIRED/);
    expect(repos.execution.getTaskExecution(a.taskId)!.currentAttempt!.state).toBe('preparing');
    x.creationFinished(f,r.resourceId,r.revision,'not_created');const active=x.markSubmissionPending(af(a),intent()).attempt!;
    expect(()=>x.recoverAttempt(af(active),{kind:'unsubmitted_preparation',decisionId:'downgrade',safeResources:[]})).toThrow(/ATTEMPT_NOT_PREPARING/);
    expect(()=>x.suspendUnsubmitted(af(active))).toThrow(/ATTEMPT_NOT_PREPARING/);
    expect(()=>x.settleAttempt(af(active),'bad-cancel',{kind:'not_submitted',outcome:'cancelled',reason:'timeout'})).toThrow(/SUBMISSION_NOT_UNSUBMITTED/);
  });
  it('rolls back partial conversion after a real child SIGKILL and keeps the legacy writer authoritative',async()=>{
    const filename=disk();const child=spawn(process.execPath,['--conditions=development','--import','tsx',resolve('packages/storage/tests/task-execution-child.mts'),filename,'migration-crash'],{stdio:['ignore','ignore','pipe']});
    const end=once(child,'exit');let errors='';child.stderr!.on('data',chunk=>{errors+=chunk;});let exited=false;child.once('exit',()=>{exited=true;});
    try{
      const [,signal]=await end;expect(signal,errors).toBe('SIGKILL');
      const e=open(filename,false);expect(e.repos.execution.authority()).toBe('legacy');expect(e.repos.execution.getResources('legacy')).toEqual([]);
      const old=(await e.repos.tasks.get!('legacy-task'))!;await e.repos.tasks.save({...old,status:'failed'});e.repos.execution.upgradeLegacy();
      expect(e.repos.execution.getTaskExecution('legacy-task')!.currentAttempt!.outcome).toBe('failed');
    }finally{if(!exited){child.kill('SIGKILL');await end;}}
  },20000);

  it('does not expose the private claim binding through returned controller projections',()=>{
    const e=ready();const a=claimed(e.x);e.claim!.release();
    const next=e.repos.control.attachRuntime('new-instance');opened.find(v=>v.repos===e.repos)!.claim=next;
    a.controller.instanceId='new-instance';a.controller.generation=next.generation;
    expect(()=>e.x.appendEvent(f,{id:'forged-via-projection',type:'text',data:{}})).toThrow(/DATABASE_RUNTIME_CLAIM_REVOKED/);
  });

  it('records failed original-turn recovery as reconcile-required without inventing live evidence',()=>{
    const e=ready();const a=claimed(e.x);let r=e.x.beforeCreate(f,{resourceId:'remote',kind:'remote'});r=e.x.spawned(f,'remote',r.revision,{identityId:'remote-id',kind:'remote',locator:{session:'server-session'}});r=e.x.creationFinished(f,'remote',r.revision,'created');r=e.x.observed(f,'remote',r.revision,{observationId:'first',state:'live',identityId:'remote-id',evidenceRef:'remote-session-owned',observedAt:session().createdAt});
    const recovery={kind:'pty-jsonl-v1' as const,turnId:'turn',transcript:{offset:0}};
    const active=e.x.markSubmissionPending(af(a),{...intent(),recovery,resourceRefs:[{resourceId:'remote',identityId:'remote-id'}]}).attempt!;
    e.claim!.release();const claim=e.repos.control.attachRuntime('next');opened.find(v=>v.repos===e.repos)!.claim=claim;const x=e.repos.execution.bind(claim);
    r=x.observed(f,'remote',r.revision,{observationId:'unknown',state:'unknown',identityId:'remote-id',evidenceRef:'remote-unreachable',observedAt:session().createdAt});
    const result=x.recoverAttempt(af(active),{kind:'original_turn',decisionId:'cannot-attach',submissionId:'send',recovery,resources:[{resourceId:'remote',expectedRevision:r.revision,observationId:'unknown'}],attached:false});
    expect(result.task!.status).toBe('reconcile_required');expect(result.attempt!.submissionState).toBe('intent_recorded');expect(result.attempt!.submission).toEqual(active.submission);
  });

  it('F1 rejects array holes, descriptors and extra keys without running input methods and replays persisted JSON',()=>{
    const {x}=ready(disk());let reads=0;
    const getter=[0];Object.defineProperty(getter,'0',{get(){reads++;return 7;},enumerable:true});
    const sparse:any[]=new Array(1);(sparse as any).extra='hidden';
    const symbol=[1];Object.defineProperty(symbol,Symbol('extra'),{value:1});
    const method=[1];Object.defineProperty(method,'map',{value(){reads++;return [];}});
    const hiddenMethod={a:1};Object.defineProperty(hiddenMethod,'toJSON',{value(){reads++;return 'changed';}});
    for(const payload of [sparse,getter,symbol,method,hiddenMethod])expect(()=>x.acceptTask(f,request('bad-array',{sourcePayload:payload}),input(),'back')).toThrow(/EXECUTION_INVALID_INPUT/);
    expect(reads).toBe(0);
    const saved=x.acceptTask(f,request('valid-array',{sourcePayload:[{b:2,a:1},null,[true,'é']]}),input(),'back').accepted!;
    expect(x.lookupAccepted(saved.request!)!.requestDigest).toBe(saved.requestDigest);
  });
  it.each(['accept-promote','promote-accept'] as const)('F2 rejects %s QueueAction identity collision and rolls back all facts',direction=>{
    const filename=disk();const {x}=ready(filename);const db=new Database(filename);
    try {
      const a=claimed(x);const futureRequest=request('future',{mode:'interrupt'});
      const futureId=`task_v1_${hash([futureRequest.namespace,futureRequest.sessionId,futureRequest.key])}`;
      const operationId=`accept_interrupt:${futureId}`;
      const queued=accepted(x,'queued').task!;
      if(direction==='accept-promote')x.acceptTask(f,futureRequest,input(),'back');
      else x.promoteQueued(f,queued.id,queued.revision,{operationId,actor:{kind:'unspecified'},interrupt:true});
      const before=db.prepare('SELECT * FROM task_queue_actions WHERE id=?').get(operationId);
      x.settleAttempt(af(a),'done-before-collision',{kind:'not_submitted',outcome:'cancelled',reason:'test'});
      const next=x.claimNext(f)!.attempt!;expect(next.attemptId).not.toBe(a.attemptId);
      const candidate=accepted(x,'candidate').task!;
      const snapshot=()=>JSON.stringify(['tasks','events','task_requests','task_queue_actions','task_execution_commands'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
      const original=snapshot();
      expect(()=>direction==='accept-promote'?x.promoteQueued(f,candidate.id,candidate.revision,{operationId,actor:{kind:'unspecified'},interrupt:true}):x.acceptTask(f,futureRequest,input(),'back')).toThrow(/QUEUE_ACTION_IDENTITY_CONFLICT/);
      expect(snapshot()).toBe(original);expect(db.prepare('SELECT * FROM task_queue_actions WHERE id=?').get(operationId)).toEqual(before);
      const q=x.getPendingQueueActions(f).find(q=>q.operationId===operationId)!;
      expect(q.target!.attemptId).toBe(a.attemptId);expect((before as any).task_id).toBe(q.taskId);
    }finally{db.close();}
  });
  it('F3 accepts nonsecret business env through the real ACP normalizer and rejects execution metadata injection',()=>{
    const {x,repos}=ready(disk());
    const payload={env:{NODE_ENV:'test'},token:'syntax-token',password:'field-name'};
    expect(x.acceptTask(f,request('business',{sourcePayload:payload}),input(),'back').accepted!.request!.sourcePayload).toEqual(payload);
    const event=normalizeAcpxEvent({type:'tool_call',id:'tc',title:'exec_command',rawInput:{command:'pnpm test',env:{NODE_ENV:'test'}},rawOutput:{},status:'running'})!;
    const stored=x.appendEvent(f,{id:'normalizer-env',...event} as any);
    expect(stored.data).toEqual(event.data);
    const context={agentPrompt:'hello',recovery:{kind:'pty-jsonl-v1',turnId:'turn',transcript:{offset:0}}};
    const valid={version:2 as const,executionOptions:{permissionMode:'ask' as const},prompt:'hello',executionContext:context,contentSources:[]};
    expect(x.acceptTask(f,request('recovery-valid'),{...valid,digest:hash(valid)} as AcceptedTaskInput,'back').accepted!.input!.executionContext.recovery).toEqual(context.recovery);
    for(const executionContext of [{agentPrompt:'hello',env:{TOKEN:'secret'}},{agentPrompt:'hello',recovery:{env:{TOKEN:'secret'}}},{...context,recovery:{...context.recovery,secret:'value'}},{...context,recovery:{...context.recovery,transcript:{offset:0,token:'secret'}}}]){
      const content={...valid,executionContext};expect(()=>x.acceptTask(f,request('credential-metadata'),{...content,digest:hash(content)} as any,'back')).toThrow(/EXECUTION_INVALID_INPUT/);
    }
    const resource=x.beforeCreate(f,{resourceId:'credential-resource',kind:'process'});
    expect(()=>x.spawned(f,resource.resourceId,resource.revision,{identityId:'secret-location',kind:'process',locator:{token:'secret'}})).toThrow(/EXECUTION_CREDENTIAL_PAYLOAD/);
    expect(repos.execution.getResources('s')[0]!.identity).toBeUndefined();
  });
  it('F4 conversion preserves the complete legacy queue order with negative, null, positive and rowid ties',async()=>{
    const {repos}=open(disk(),false);await repos.sessions.save(session());
    for(const [id,queuePosition] of [['positive',2],['null-first',undefined],['negative',-3],['null-second',undefined],['zero',0],['positive-tie',2]] as const){
      await repos.tasks.save({id,sessionId:'s',status:'queued',prompt:'hello',executionContext:{agentPrompt:'hello'},...(queuePosition===undefined?{}:{queuePosition}),createdAt:session().createdAt,updatedAt:session().updatedAt});
    }
    const before=(await repos.tasks.listQueued!('s')).map(t=>t.id);expect(before).toEqual(['negative','null-first','null-second','zero','positive','positive-tie']);
    repos.execution.upgradeLegacy();const after=await repos.tasks.listQueued!('s');expect(after.map(t=>t.id)).toEqual(before);expect(after.map(t=>t.queuePosition)).toEqual([1,2,3,4,5,6]);
  });
  it('F5 preserves omitted configuration identically in legacy and ledger while execution fields remain fenced',async()=>{
    for(const ledger of [false,true]){
      const e=open(disk(),ledger);if(ledger){e.claim=e.repos.control.attachRuntime('configuration');e.repos.execution.bind(e.claim).createSession(session());}else await e.repos.sessions.save(session());
      await e.repos.sessions.save({...session(),model:'keep-model',systemPrompt:'keep-prompt',reasoningEffort:'high'});
      await e.repos.sessions.save(session());const saved=(await e.repos.sessions.get('s'))!;
      expect(saved).toMatchObject({model:'keep-model',systemPrompt:'keep-prompt',reasoningEffort:'high'});
      await e.repos.sessions.save({...saved,model:'replacement'});expect((await e.repos.sessions.get('s'))!.model).toBe('replacement');
      if(ledger)await expect(e.repos.sessions.save({...saved,state:'stopped'})).rejects.toMatchObject({code:'EXECUTION_LEDGER_REQUIRED'});
    }
  });
  it('F6 explicitly clears error, preserves omission, rejects undefined and clears it on run replacement',()=>{
    const {x}=ready(disk());x.patchSession(f,{error:'old error'});expect(x.patchSession(f,{}).error).toBe('old error');
    expect(()=>x.patchSession(f,{error:undefined})).toThrow(/EXECUTION_INVALID_INPUT/);
    expect(x.patchSession(f,{error:null} as any).error).toBeUndefined();
    expect(()=>x.patchSession(f,{archivedAt:null} as any)).toThrow(/EXECUTION_INVALID_INPUT/);
    x.patchSession(f,{error:'another error'});expect(x.replaceSessionRun(f,'next-run',[]).error).toBeUndefined();
  });
  it('F7 conversion projects only unresolved historical sessions and retains config, archive and error evidence',async()=>{
    const {repos}=open(disk(),false);
    for(const name of ['single','multiple','terminal','no-task'])await repos.sessions.save({...session(name),state:'thinking',model:'keep',error:'original error',archivedAt:session().createdAt});
    for(const [id,sessionId,status] of [['one','single','running'],['two','multiple','running'],['three','multiple','unknown-old'],['done','terminal','completed']] as const)await repos.tasks.save({id,sessionId,status,prompt:'hello',createdAt:session().createdAt,updatedAt:session().updatedAt});
    repos.execution.upgradeLegacy();
    for(const name of ['single','multiple','terminal','no-task'])expect(await repos.sessions.get(name)).toMatchObject({state:['single','multiple'].includes(name)?'interrupted':'thinking',model:'keep',error:'original error',archivedAt:session().createdAt});
    expect(repos.execution.getTaskExecution('one')!.currentAttempt).toMatchObject({state:'reconcile_required',legacy:{status:'running'}});
    expect(repos.execution.getTaskExecution('three')!.currentAttempt).toMatchObject({state:'legacy_unresolved',legacy:{status:'unknown-old'}});
    expect(repos.execution.getResources('no-task')[0]!.stage).toBe('unknown');
  });

});
