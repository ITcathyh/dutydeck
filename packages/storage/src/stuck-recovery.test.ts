import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalExecutionJson, type AcceptedTaskInputV2, type TaskAttempt, type TaskRequestV1 } from '@dutydeck/shared';
import { createRepositories } from './index.js';
import { currentProcessIdentity } from './process-identity.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const digest = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const af = (a: TaskAttempt) => ({ sessionId:a.sessionId,runId:a.runId,taskId:a.taskId,attemptId:a.attemptId,expectedRevision:a.revision });
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'stuck-recovery-'));
  cleanup.push(() => rmSync(root,{recursive:true,force:true}));
  const path = join(root,'state.db');
  const repos = createRepositories(path,{newDatabaseAuthority:'ledger_v1'});
  let claim = repos.control.attachRuntime('first');
  cleanup.push(() => { try { claim.release(); } catch {} try { repos.close(); } catch {} });
  let x = repos.execution.bind(claim);
  const cwd = join(root,'repo');mkdirSync(cwd);
  execFileSync('git',['-C',cwd,'init','-q']);
  const session = (id:string,dir:string,source?:string) => {
    const f={sessionId:id,runId:'run-'+id};
    x.createSession({id,cwd:dir,runId:f.runId,agentId:'fixture',state:'idle',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),...(source?{source,sourceId:'app:pool:memory'}:{})});
    return f;
  };
  const accept = (f:ReturnType<typeof session>,key='task') => {
    const request:TaskRequestV1={version:1,namespace:'runtime',sessionId:f.sessionId,key,prompt:key,mode:'queue',actor:{kind:'unspecified'},skills:[],options:{},sources:[],sourcePayload:null};
    const content={version:2 as const,prompt:key,executionOptions:{permissionMode:'ask' as const},executionContext:{agentPrompt:key},contentSources:[]};
    return x.acceptTask(f,request,{...content,digest:digest(content)} as AcceptedTaskInputV2,'back').task!;
  };
  const reattach = () => { claim.release(); claim = repos.control.attachRuntime('second'); x = repos.execution.bind(claim); };
  return {root,path,repos,cwd,session,accept,reattach,get x(){return x;}};
}
const blocked = expect.objectContaining({code:'WORKSPACE_RESOURCE_BLOCKED'});

it('keeps memory jobs out of repository admission while memory jobs on one directory still exclude each other', () => {
  const h=fixture(), memoryDir=join(h.cwd,'.dutydeck','memory','groups'), otherMemoryDir=join(h.cwd,'.dutydeck','memory','chat');
  mkdirSync(memoryDir,{recursive:true});mkdirSync(otherMemoryDir,{recursive:true});
  const code=h.session('code',h.cwd), memory=h.session('memory',memoryDir,'lark-memory'), sibling=h.session('memory-sibling',memoryDir,'lark-memory');
  const other=h.session('memory-other',otherMemoryDir,'lark-memory'), laterCode=h.session('later-code',h.cwd);
  h.accept(code);h.accept(memory);h.accept(sibling);h.accept(other);h.accept(laterCode);
  // An unresolved code task in the repository does not hold back a memory job, and vice versa.
  const codeAttempt=h.x.claimNext(code)!.attempt!;
  const memoryAttempt=h.x.claimNext(memory)!.attempt!;
  expect(memoryAttempt).toBeDefined();
  expect(()=>h.x.claimNext(sibling)).toThrow(blocked);
  expect(h.x.claimNext(other)!.attempt).toBeDefined();
  h.x.settleAttempt(af(codeAttempt),'code-done',{kind:'not_submitted',outcome:'cancelled',reason:'fixture'});
  const laterAttempt=h.x.claimNext(laterCode)!.attempt!;
  h.x.settleAttempt(af(memoryAttempt),'memory-done',{kind:'not_submitted',outcome:'cancelled',reason:'fixture'});
  const siblingAttempt=h.x.claimNext(sibling)!.attempt!;
  // A non-memory session working inside the memory directory itself still waits for the memory job there.
  const inside=h.session('inside-memory',memoryDir);h.accept(inside);
  h.x.settleAttempt(af(laterAttempt),'later-done',{kind:'not_submitted',outcome:'cancelled',reason:'fixture'});
  expect(()=>h.x.claimNext(inside)).toThrow(blocked);
  h.x.settleAttempt(af(siblingAttempt),'sibling-done',{kind:'not_submitted',outcome:'cancelled',reason:'fixture'});
  expect(h.x.claimNext(inside)!.attempt).toBeDefined();
});

it('settles a recorded intent as not submitted only for that intent and only before any receipt', () => {
  const h=fixture(), f=h.session('origin',h.cwd);
  h.accept(f,'first');h.accept(f,'second');
  let a=h.x.claimNext(f)!.attempt!;
  a=h.x.markSubmissionPending(af(a),{submissionId:'send-1',inputDigest:digest('input'),resourceRefs:[],authorizationRefs:[]}).attempt!;
  expect(()=>h.x.settleAttempt(af(a),'other',{kind:'not_submitted',outcome:'failed',reason:'fixture',submissionId:'other-send'})).toThrow(expect.objectContaining({code:'SUBMISSION_NOT_UNSUBMITTED'}));
  expect(()=>h.x.settleAttempt(af(a),'plain',{kind:'not_submitted',outcome:'failed',reason:'fixture'})).toThrow(expect.objectContaining({code:'SUBMISSION_NOT_UNSUBMITTED'}));
  const settled=h.x.settleAttempt(af(a),'prompt-not-written',{kind:'not_submitted',outcome:'failed',reason:'not ready',submissionId:'send-1'});
  expect(settled.task).toMatchObject({status:'failed'});
  expect(settled.attempt).toMatchObject({state:'settled',outcome:'failed',submissionState:'intent_recorded',settlement:{kind:'not_submitted',submissionId:'send-1'}});
  let b=h.x.claimNext(f)!.attempt!;
  b=h.x.markSubmissionPending(af(b),{submissionId:'send-2',inputDigest:digest('input-2'),resourceRefs:[],authorizationRefs:[]}).attempt!;
  b=h.x.markSubmitted(af(b),{submissionId:'send-2',kind:'provider_accepted',provider:'fixture',receiptRef:'accepted',digest:digest('accepted')}).attempt!;
  expect(()=>h.x.settleAttempt(af(b),'late',{kind:'not_submitted',outcome:'failed',reason:'fixture',submissionId:'send-2'})).toThrow(expect.objectContaining({code:'SUBMISSION_NOT_UNSUBMITTED'}));
});

it('marks an in-process terminal record gone only after its owner runtime released or exited', () => {
  const h=fixture(), f=h.session('origin',h.cwd), target=h.session('target',h.cwd);
  let r=h.x.beforeCreate(f,{resourceId:'pty',kind:'local_only'});
  r=h.x.spawned(f,r.resourceId,r.revision,{identityId:'pty-identity',kind:'local_only',locator:{owner:'runtime-adapter'}});
  r=h.x.creationFinished(f,r.resourceId,r.revision,'created');
  r=h.x.observed(f,r.resourceId,r.revision,{observationId:'live',state:'live',identityId:'pty-identity',evidenceRef:'start',observedAt:new Date().toISOString()});
  h.accept(target);
  const gone=(id:string)=>({observationId:id,state:'gone' as const,identityId:'pty-identity',evidenceRef:'pty-absent:fixture',observedAt:new Date().toISOString()});
  // The current owner is never proven exited by a missing terminal.
  expect(()=>h.x.observeDetachedLocalResource(f,r.resourceId,r.revision,gone('own'))).toThrow(expect.objectContaining({code:'RESOURCE_OWNER_NOT_PROVEN_EXITED'}));
  expect(()=>h.x.claimNext(target)).toThrow(blocked);
  h.reattach();
  // Another registered process still owns it: forge that ownership directly in the ledger row.
  const db=new Database(h.path);cleanup.push(()=>db.close());
  const row=db.prepare('SELECT json FROM driver_resources WHERE id=?').get(r.resourceId) as {json:string};
  const forged=JSON.parse(row.json);forged.controller={...forged.controller,accessId:'other-process'};
  db.prepare('UPDATE driver_resources SET json=? WHERE id=?').run(JSON.stringify(forged),r.resourceId);
  db.prepare('INSERT INTO dutydeck_access VALUES (?,?)').run('other-process',JSON.stringify(currentProcessIdentity()));
  expect(()=>h.x.observeDetachedLocalResource(f,r.resourceId,r.revision,gone('registered'))).toThrow(expect.objectContaining({code:'RESOURCE_OWNER_NOT_PROVEN_EXITED'}));
  db.prepare('DELETE FROM dutydeck_access WHERE id=?').run('other-process');
  expect(()=>h.x.observeDetachedLocalResource(f,r.resourceId,r.revision,{...gone('wrong-state'),state:'live'} as any)).toThrow(expect.objectContaining({code:'RESOURCE_OBSERVATION_CONFLICT'}));
  const retired=h.x.observeDetachedLocalResource(f,r.resourceId,r.revision,gone('released'));
  expect(retired.observations.at(-1)).toMatchObject({state:'gone',evidenceRef:'pty-absent:fixture'});
  expect(()=>h.x.observeDetachedLocalResource(f,r.resourceId,retired.revision,gone('again'))).toThrow(expect.objectContaining({code:'RESOURCE_OBSERVATION_CONFLICT'}));
  expect(h.x.claimNext(target)!.attempt).toBeDefined();
});
