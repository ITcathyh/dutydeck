import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalExecutionJson, type AcceptedTaskInputV2, type TaskAttempt, type TaskRequestV1 } from '@dutydeck/shared';
import { createRepositories } from './index.js';
import { resolveExecutionWorkspace } from './execution-workspace.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const digest = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const af = (a: TaskAttempt) => ({ sessionId:a.sessionId,runId:a.runId,taskId:a.taskId,attemptId:a.attemptId,expectedRevision:a.revision });
const actor = {kind:'installation_owner' as const,id:'installation_owner' as const};
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'workspace-admission-'));
  cleanup.push(() => rmSync(root,{recursive:true,force:true}));
  const path = join(root,'state.db');
  const repos = createRepositories(path,{newDatabaseAuthority:'ledger_v1'});
  const claim = repos.control.attachRuntime('first');
  cleanup.push(() => { try { claim.release(); } catch {} try { repos.close(); } catch {} });
  const x = repos.execution.bind(claim);
  const git = (cwd:string,...args:string[]) => execFileSync('git',['-C',cwd,...args],{stdio:'pipe'});
  const repo = (name:string) => { const cwd=join(root,name);mkdirSync(cwd);git(cwd,'init','-q');git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','baseline');return cwd; };
  const session = (id:string,cwd:string) => { const f={sessionId:id,runId:'run-'+id};x.createSession({id,cwd,runId:f.runId,agentId:'fixture',state:'idle',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});return f; };
  const accept = (f:ReturnType<typeof session>,key='task') => {
    const request:TaskRequestV1={version:1,namespace:'runtime',sessionId:f.sessionId,key,prompt:key,mode:'queue',actor:{kind:'unspecified'},skills:[],options:{},sources:[],sourcePayload:null};
    const content={version:2 as const,prompt:key,executionOptions:{permissionMode:'ask' as const},executionContext:{agentPrompt:key},contentSources:[]};
    return x.acceptTask(f,request,{...content,digest:digest(content)} as AcceptedTaskInputV2,'back').task!;
  };
  return {root,path,repos,claim,x,git,repo,session,accept};
}
it('canonicalizes real Git worktrees, subdirectories and symlinks while allowing other repositories to claim', async () => {
  const h=fixture(), original=h.repo('original'), other=h.repo('other');
  const nested=join(original,'nested');mkdirSync(nested);
  const link=join(h.root,'link');symlinkSync(nested,link);
  const worktree=join(h.root,'worktree');h.git(original,'worktree','add','--detach','-q',worktree,'HEAD');
  const fs=[h.session('origin',original),h.session('link',link),h.session('worktree',worktree),h.session('different',other)];
  const tasks=fs.map(f=>h.accept(f));
  const first=h.x.claimNext(fs[0]!)!.attempt!;
  for(const f of fs.slice(1,3))expect(()=>h.x.claimNext(f)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  expect(h.repos.execution.getTaskExecution(tasks[1]!.id)).toMatchObject({task:{status:'queued'},attempts:[],blockers:expect.arrayContaining([expect.objectContaining({code:'WORKSPACE_EXECUTION_BUSY',sessionId:'origin',taskId:first.taskId,attemptId:first.attemptId})])});
  expect(h.x.claimNext(fs[3]!)!.attempt).toBeDefined();
  expect(resolveExecutionWorkspace(original).key).toBe(resolveExecutionWorkspace(worktree).key);
  expect(resolveExecutionWorkspace(original).key).toBe(resolveExecutionWorkspace(link).key);
  for(const cwd of [original,worktree,link])expect(resolveExecutionWorkspace(cwd).key).toBe('git:'+realpathSync(String(h.git(cwd,'rev-parse','--path-format=absolute','--git-common-dir')).trim()));
  // Independent bound callers contend on the same SQLite immediate transaction, not a dispatch precheck.
  h.x.settleAttempt(af(first),'done',{kind:'not_submitted',outcome:'cancelled',reason:'fixture'});
  const second=h.repos.execution.bind(h.claim);
  const claims=await Promise.allSettled([Promise.resolve().then(()=>h.x.claimNext(fs[1]!)),Promise.resolve().then(()=>second.claimNext(fs[2]!))]);
  expect(claims.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(claims.filter(result=>result.status==='rejected')).toHaveLength(1);
});
it('derives preexisting unknown ownership, keeps it through reopen and stop, and releases only on explicit recovery', () => {
  const h=fixture(), cwd=h.repo('repo'), origin=h.session('origin',cwd), target=h.session('target',cwd);
  const task=h.accept(origin);h.accept(target);
  let a=h.x.claimNext(origin)!.attempt!;
  a=h.x.markSubmissionPending(af(a),{submissionId:'original-send',inputDigest:digest('input'),resourceRefs:[],authorizationRefs:[]}).attempt!;
  a=h.x.markReconcileRequired(af(a),{reasonId:'disconnect',code:'DISCONNECTED',evidenceRefs:[]}).attempt!;
  const sql=new Database(h.path);
  sql.prepare("DELETE FROM configs WHERE key LIKE 'runtime_execution_workspace:%'").run();sql.close();
  h.claim.release();h.repos.close();
  const reopened=createRepositories(h.path);const replacement=reopened.control.attachRuntime('replacement');
  cleanup.push(()=>{replacement.release();reopened.close();});
  const x=reopened.execution.bind(replacement);
  expect(()=>x.claimNext(target)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  x.patchSession(origin,{state:'stopped'});
  expect(()=>x.claimNext(target)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  const decision={decisionId:'verified',actor,action:'confirm_result' as const,evidenceRefs:['operator:verified-original'],resourceChecks:[]};
  x.confirmAttemptRecovery(af(a),'manual-final',{kind:'manual',outcome:'completed',decision},'verified output');
  expect(x.claimNext(target)!.attempt).toBeDefined();
  expect(reopened.execution.getTaskExecution(task.id)?.attempts[0]?.settlementId).toBe('manual-final');
  expect(()=>x.settleAttempt(af(a),'late-result',{kind:'driver_result',submissionId:'original-send',outcome:'completed',outputDigest:digest('late'),stopReason:'end_turn',complete:true})).toThrow();
  const integrity=new Database(h.path);expect(integrity.pragma('foreign_key_check')).toEqual([]);integrity.close();
});
it('retains unsafe physical resources after settlement and checks ephemeral idle proofs against revision and scope', () => {
  const h=fixture(),cwd=h.repo('repo'),origin=h.session('origin',cwd),target=h.session('target',cwd);
  h.accept(origin);h.accept(target);
  const a=h.x.claimNext(origin)!.attempt!;
  let r=h.x.beforeCreate(origin,{resourceId:'channel',kind:'local_only'});
  r=h.x.spawned(origin,r.resourceId,r.revision,{identityId:'original-object',kind:'local_only',locator:{driver:'fixture'}});
  r=h.x.creationFinished(origin,r.resourceId,r.revision,'created');
  r=h.x.observed(origin,r.resourceId,r.revision,{observationId:'ready',state:'live',identityId:'original-object',evidenceRef:'fixture:ready',observedAt:new Date().toISOString()});
  h.x.settleAttempt(af(a),'final',{kind:'not_submitted',outcome:'cancelled',reason:'fixture'});
  const proof={resourceId:r.resourceId,expectedRevision:r.revision,observationId:'ready'};
  expect(()=>h.x.claimNext(target,[{...proof,expectedRevision:proof.expectedRevision-1}])).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  expect(h.x.claimNext(target,[proof])!.attempt).toBeDefined();
  // The proof permits a known idle control channel, never fabricates physical exit.
  expect(h.repos.execution.getResources(origin.sessionId)[0]?.observations.at(-1)?.state).toBe('live');
});
it('never grants idle-channel exceptions to submission child processes or across runtime generations', () => {
  const h=fixture(),cwd=h.repo('repo'),origin=h.session('origin',cwd),target=h.session('target',cwd);
  h.accept(target);h.accept(origin);
  let a=h.x.claimNext(origin)!.attempt!;
  a=h.x.markSubmissionPending(af(a),{submissionId:'send',inputDigest:digest('input'),resourceRefs:[],authorizationRefs:[],driverInstanceId:'driver'}).attempt!;
  const operation=h.x.beforeControlledOperation(origin,{resourceId:'turn',driverInstanceId:'driver',scope:{kind:'submission',taskId:a.taskId,attemptId:a.attemptId,submissionId:'send'}});
  let r=h.x.beforeCreate(origin,{resourceId:'child',kind:'process',parentResourceId:operation.resourceId});
  r=h.x.spawned(origin,r.resourceId,r.revision,{identityId:'child-id',kind:'process',locator:{fixture:true}});
  r=h.x.creationFinished(origin,r.resourceId,r.revision,'created');
  r=h.x.observed(origin,r.resourceId,r.revision,{observationId:'live-child',state:'live',identityId:'child-id',evidenceRef:'fixture',observedAt:new Date().toISOString()});
  h.x.settleAttempt(af(a),'turn-completed',{kind:'driver_result',submissionId:'send',outcome:'completed',outputDigest:digest('done'),stopReason:'end_turn',complete:true});
  h.x.creationFinished(origin,operation.resourceId,operation.revision,'created');
  const proof={resourceId:r.resourceId,expectedRevision:r.revision,observationId:'live-child'};
  expect(()=>h.x.claimNext(target,[proof])).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  h.claim.release();const next=h.repos.control.attachRuntime('next');cleanup.push(()=>next.release());
  expect(()=>h.repos.execution.bind(next).claimNext(target,[proof])).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  h.repos.execution.bind(next).observed(origin,r.resourceId,r.revision,{observationId:'child-gone',state:'gone',identityId:'child-id',evidenceRef:'fixture:closed',observedAt:new Date().toISOString()});
  expect(h.repos.execution.bind(next).claimNext(target)!.attempt).toBeDefined();
});
it('freezes non-Git directory identity at acceptance and blocks replacements without serializing distinct directories', () => {
  const h=fixture(),cwd=join(h.root,'plain'),other=join(h.root,'other');mkdirSync(cwd);mkdirSync(other);
  const one=h.session('one',cwd),two=h.session('two',other);h.accept(one);h.accept(two);
  renameSync(cwd,join(h.root,'original-directory'));mkdirSync(cwd);
  expect(()=>h.x.claimNext(one)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  expect(h.x.claimNext(two)!.attempt).toBeDefined();
});

it('keeps unknown steering and legacy unresolved attempts holding their repository until audited recovery', () => {
  const h=fixture(),cwd=h.repo('repo'),origin=h.session('origin',cwd),target=h.session('target',cwd);
  h.accept(origin);h.accept(target);
  let a=h.x.claimNext(origin)!.attempt!;
  a=h.x.markSubmissionPending(af(a),{submissionId:'original-send',inputDigest:digest('input'),resourceRefs:[],authorizationRefs:[]}).attempt!;
  const steered=h.accept(origin,'steered');
  h.x.beginQueuedSteering(origin,steered.id,steered.revision,{operationId:'steering',actor,target:{taskId:a.taskId,attemptId:a.attemptId}});
  h.x.settleAttempt(af(a),'original-final',{kind:'driver_result',submissionId:'original-send',outcome:'completed',outputDigest:digest('done'),stopReason:'end_turn',complete:true});
  const pending=h.repos.execution.getTaskExecution(steered.id)!.steering!;
  h.x.resolveQueuedSteering(origin,pending.operationId,pending.controller,'unknown');
  for(let i=0;i<3;i++)expect(()=>h.x.claimNext(target)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  const unknown=h.repos.execution.getTaskExecution(steered.id)!.steering!;
  h.x.confirmSteeringRecovery(origin,{runId:origin.runId,taskId:steered.id,operationId:unknown.operationId,expectedRevision:unknown.revision,decisionId:'abandon',evidenceRefs:['operator:verified'],resourceChecks:[],action:'abandon'},actor);
  const next=h.x.claimNext(target)!.attempt!;
  const sql=new Database(h.path);
  const legacy={...next,state:'legacy_unresolved',submissionState:'legacy_unknown'};
  sql.prepare("UPDATE task_attempts SET state='legacy_unresolved',submission_state='legacy_unknown',json=? WHERE id=?").run(JSON.stringify(legacy),next.attemptId);sql.close();
  h.accept(origin,'after-legacy');
  expect(()=>h.x.claimNext(origin)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
});
it('persists manual retry lineage alongside the exact audited decision and retains the original unknown settlement', () => {
  const h=fixture(),origin=h.session('origin',h.repo('repo'));h.accept(origin);
  let a=h.x.claimNext(origin)!.attempt!;
  a=h.x.markSubmissionPending(af(a),{submissionId:'send',inputDigest:digest('input'),resourceRefs:[],authorizationRefs:[]}).attempt!;
  a=h.x.markReconcileRequired(af(a),{reasonId:'lost',code:'DISCONNECTED',evidenceRefs:[]}).attempt!;
  const decision={decisionId:'explicit-retry',actor,action:'retry' as const,evidenceRefs:['operator:reviewed-effects'],resourceChecks:[],allowDuplicateEffects:true};
  const next=h.x.retryAttempt(af(a),decision,[]).attempt!;
  expect(next.manualRetry).toEqual({causeAttemptId:a.attemptId,decisionId:decision.decisionId,inputDigest:h.repos.execution.getAcceptedTask(a.taskId)!.input!.digest});
  expect(h.repos.execution.getRecoveryDecision(decision.decisionId)).toEqual({...origin,attemptId:a.attemptId,decision});
  expect(h.repos.execution.getTaskExecution(a.taskId)?.attempts[0]).toMatchObject({attemptId:a.attemptId,state:'settled',outcome:'unknown',settlement:{kind:'manual',outcome:'unknown',decision}});
  expect(h.x.claimNext(origin)?.attempt?.attemptId).toBe(next.attemptId);
});

it('matches Git for a non-repository .git shell and a bare repository, and never downgrades a frozen Git identity', () => {
  const h=fixture(),plain=join(h.root,'plain'),bare=join(h.root,'bare');mkdirSync(plain);mkdirSync(join(plain,'.git'));writeFileSync(join(plain,'.git','config.worktree'),'');
  expect(()=>h.git(plain,'rev-parse','--git-common-dir')).toThrow();
  expect(resolveExecutionWorkspace(plain).key).toBe('directory:'+realpathSync(plain));
  h.git(h.root,'init','--bare','-q',bare);
  expect(resolveExecutionWorkspace(bare).key).toBe('git:'+realpathSync(String(h.git(bare,'rev-parse','--path-format=absolute','--git-common-dir')).trim()));
  const cwd=h.repo('original'),origin=h.session('origin',cwd);h.accept(origin);
  renameSync(join(cwd,'.git'),join(cwd,'original-git'));mkdirSync(join(cwd,'.git'));writeFileSync(join(cwd,'.git','config.worktree'),'');
  expect(()=>h.x.claimNext(origin)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
});

it('preserves the independent schedule channel actor through its durable origin mapping and rejects actor/App/scope changes', async () => {
  const h=fixture(),cwd=h.repo('repo'),at=new Date().toISOString(),scheduleId='schedule-with-channel';
  const executionId='ses_schedule_'+createHash('sha256').update(scheduleId).digest('hex');
  h.x.createSession({id:'lark-origin',runId:'origin-run',agentId:'fixture',cwd,state:'stopped',source:'lark',sourceId:'cli_app:oc_chat:group',createdAt:at,updatedAt:at});
  h.x.createSession({id:executionId,runId:'execution-run',agentId:'fixture',cwd,state:'idle',source:'schedule',sourceId:scheduleId,createdAt:at,updatedAt:at});
  const mapping={schemaVersion:1,id:scheduleId,sessionId:'lark-origin',executionSessionId:executionId,mode:'independent',actorId:'ou_owner'};
  const key='session_automation/schedule/'+scheduleId;
  await h.repos.config.set(key,JSON.stringify(mapping));
  const request:TaskRequestV1={version:1,namespace:'automation',key:'occurrence',sessionId:executionId,actor:{kind:'channel',id:'ou_owner',appId:'cli_app'},prompt:'scheduled input',mode:'queue',skills:[],options:{},sources:[],sourcePayload:null};
  const content={version:2 as const,prompt:request.prompt,executionOptions:{permissionMode:'ask' as const},executionContext:{agentPrompt:request.prompt,actorId:'ou_owner'},contentSources:[]};
  const accepted=h.x.acceptTask({sessionId:executionId,runId:'execution-run'},request,{...content,digest:digest(content)},'back');
  expect(accepted.accepted?.request?.actor).toEqual(request.actor);
  expect(h.x.lookupAccepted(request)?.task.id).toBe(accepted.task!.id);
  for(const actor of [{kind:'channel',id:'ou_other',appId:'cli_app'},{kind:'channel',id:'ou_owner',appId:'other_app'},{kind:'installation_owner',id:'installation_owner'}] as const)expect(()=>h.x.lookupAccepted({...request,actor})).toThrow(expect.objectContaining({code:'TASK_ACTOR_CONFLICT'}));
  await h.repos.config.set(key,JSON.stringify({...mapping,executionSessionId:'different-session'}));
  expect(()=>h.x.lookupAccepted(request)).toThrow(expect.objectContaining({code:'SCHEDULE_EXECUTION_SCOPE_INVALID'}));
  await h.repos.config.set(key,JSON.stringify({...mapping,sessionId:'missing-origin'}));
  expect(()=>h.x.lookupAccepted(request)).toThrow(expect.objectContaining({code:'SESSION_NOT_FOUND'}));
});

it('keeps malformed verification evidence scoped to its actual repository instead of skipping it or blocking unrelated work',async()=>{
  const h=fixture(),cwd=h.repo('repo'),origin=h.session('origin',cwd),target=h.session('target',cwd),unrelated=h.session('other',h.repo('other-repo'));
  h.accept(target);h.accept(unrelated);
  await h.repos.config.set('runtime_verification:'+origin.sessionId+':proof','{invalid');
  expect(()=>h.x.claimNext(target)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  expect(h.x.claimNext(unrelated)?.attempt).toBeDefined();
  await h.repos.config.set('runtime_verification:'+origin.sessionId+':proof',JSON.stringify({sessionId:origin.sessionId,status:'passed'}));
  expect(h.x.claimNext(target)?.attempt).toBeDefined();
});

it.each([
  {sessionId:'wrong-owner',status:'running'},
  {sessionId:'wrong-owner',status:'passed'},
  {status:'passed'},
  {sessionId:'origin'},
  {sessionId:'origin',status:'unknown'},
  null,
])('rejects ambiguous verification ownership or status without blocking another repository: %j',async evidence=>{
  const h=fixture(),cwd=h.repo('repo'),origin=h.session('origin',cwd),target=h.session('target',cwd),other=h.session('other',h.repo('other'));
  const task=h.accept(target);h.accept(other);
  await h.repos.config.set('runtime_verification:'+origin.sessionId+':proof',JSON.stringify(evidence));
  expect(()=>h.x.claimNext(target)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  expect(h.repos.execution.getTaskExecution(task.id)?.blockers).toContainEqual(expect.objectContaining({code:'RESOURCE_EVIDENCE_INVALID',sessionId:'origin'}));
  expect(h.x.claimNext(other)?.attempt).toBeDefined();
});

it('releases same-session and cross-session admission after an audited unknown settlement without rewriting the original outcome',()=>{
  const h=fixture(),cwd=h.repo('repo'),origin=h.session('origin',cwd),target=h.session('target',cwd);
  const task=h.accept(origin);h.accept(target);
  let a=h.x.claimNext(origin)!.attempt!;
  a=h.x.markSubmissionPending(af(a),{submissionId:'original',inputDigest:digest('input'),resourceRefs:[],authorizationRefs:[]}).attempt!;
  a=h.x.markReconcileRequired(af(a),{reasonId:'lost',code:'DISCONNECTED',evidenceRefs:[]}).attempt!;
  h.accept(origin,'next');
  expect(()=>h.x.claimNext(origin)).toThrow(expect.objectContaining({code:'SESSION_EXECUTION_BUSY'}));
  expect(()=>h.x.claimNext(target)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  const decision={decisionId:'reviewed-unknown',actor,action:'confirm_result' as const,evidenceRefs:['operator:reviewed-original-effects'],resourceChecks:[]};
  h.x.confirmAttemptRecovery(af(a),'manual-unknown',{kind:'manual',outcome:'unknown',decision});
  const next=h.x.claimNext(target)!.attempt!;
  expect(next).toBeDefined();
  h.x.settleAttempt(af(next),'target-done',{kind:'not_submitted',outcome:'cancelled',reason:'fixture'});
  expect(h.x.claimNext(origin)?.attempt).toBeDefined();
  expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt).toMatchObject({state:'settled',outcome:'unknown',settlement:{kind:'manual',outcome:'unknown',decision}});
});

it.each(['pty-cli','acp'] as const)('honors the exact %s legacy retirement receipt without erasing history, and rejects tampering',async protocol=>{
  const root=mkdtempSync(join(tmpdir(),'workspace-legacy-retirement-')),path=join(root,'state.db');
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const repos=createRepositories(path),at=new Date().toISOString();
  cleanup.push(()=>repos.close());
  await repos.sessions.save({id:'legacy',runId:'legacy-run',agentId:'fixture',protocol,cwd:root,state:'completed',createdAt:at,updatedAt:at});
  repos.execution.upgradeLegacy();
  let claim=repos.control.attachRuntime('before-retirement'),x=repos.execution.bind(claim);
  const target={sessionId:'target',runId:'target-run'};
  x.createSession({id:target.sessionId,runId:target.runId,agentId:'fixture',cwd:root,state:'idle',createdAt:at,updatedAt:at});
  const request:TaskRequestV1={version:1,namespace:'runtime',sessionId:target.sessionId,key:'after-legacy',prompt:'after-legacy',mode:'queue',actor:{kind:'unspecified'},skills:[],options:{},sources:[],sourcePayload:null};
  const content={version:2 as const,prompt:request.prompt,executionOptions:{permissionMode:'ask' as const},executionContext:{agentPrompt:request.prompt},contentSources:[]};
  x.acceptTask(target,request,{...content,digest:digest(content)},'back');
  expect(()=>x.claimNext(target)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  claim.release();
  const maintenance=repos.execution.beginLegacyRetirement(),candidate=maintenance.listCandidates()[0]!;
  const original=repos.execution.getResources('legacy');
  const receiptContent={version:1 as const,sessionId:candidate.sessionId,runId:candidate.runId,databaseEntity:candidate.databaseEntity,snapshotDigest:candidate.snapshotDigest,
    protocol,verifiedAt:at,archivedAt:at,
    verifier:{hostname:'test-host',uid:1001,process:{host:'machine',boot:'boot',namespace:'pid:[1]',pid:123,start:'1'}},
    evidence:protocol==='pty-cli'?{kind:'pty_tmux_absent' as const,socketPath:'/tmp/fixture.sock',targetName:'dutydeck-legacy-'+createHash('sha256').update('legacy').digest('hex').slice(0,16),
      owner:'dutydeck:legacy',outcome:'already_missing' as const,paneProcesses:[]}
      :{kind:'acp_recorded_agent_pid_absent' as const,recordPath:'/tmp/sessions/legacy.json',acpxRecordId:'legacy',pid:123,agentStartedAt:at}};
  const proof={...receiptContent,receiptId:'legacy_retirement_'+digest(receiptContent)};
  maintenance.retireSession(proof);maintenance.close();
  claim=repos.control.attachRuntime('after-retirement');cleanup.push(()=>claim.release());x=repos.execution.bind(claim);
  for(const patch of [{sessionId:'wrong-owner'},{runId:'wrong-run'},{databaseEntity:'wrong-database'},{archivedAt:'2020-01-01T00:00:00.000Z'}]){
    // Rehashing a different scope still cannot authorize the actual retired resource.
    const changed={...receiptContent,...patch};
    await repos.config.set('legacy_retirement:legacy',JSON.stringify({...changed,receiptId:'legacy_retirement_'+digest(changed)}));
    expect(()=>x.claimNext(target)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  }
  const wrongEvidence=receiptContent.evidence.kind==='pty_tmux_absent'
    ? [{...receiptContent.evidence,owner:'dutydeck:other'},{...receiptContent.evidence,targetName:'foreign'},
      {...receiptContent.evidence,outcome:'stopped_owned'},{...receiptContent.evidence,targetId:'$42'}]
    : [{...receiptContent.evidence,acpxRecordId:'other'},{...receiptContent.evidence,recordPath:'/tmp/sessions/other.json'}];
  for(const evidence of wrongEvidence){
    const changed={...receiptContent,evidence};
    await repos.config.set('legacy_retirement:legacy',JSON.stringify({...changed,receiptId:'legacy_retirement_'+digest(changed)}));
    expect(()=>x.claimNext(target)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  }
  await repos.config.set('legacy_retirement:legacy',JSON.stringify({...proof,receiptId:'invalid-receipt'}));
  expect(()=>x.claimNext(target)).toThrow(expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'}));
  await repos.config.set('legacy_retirement:legacy',JSON.stringify(proof));
  expect(x.claimNext(target)?.attempt).toBeDefined();
  expect(repos.execution.getResources('legacy')).toEqual(original);
});
