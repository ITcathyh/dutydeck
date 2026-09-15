import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { canonicalExecutionJson, type OperationPermit, type RepositoryBundle, type RuntimeControlClaim, type TaskRequestV1 } from '@dutydeck/shared';
import { createHash } from 'node:crypto';
import { ControlledDriverResources, localOnlyDriverContext } from './driver-context.js';
const opened:Array<{repos:RepositoryBundle;claim:RuntimeControlClaim}>=[];
afterEach(()=>{for(const {repos,claim}of opened.splice(0)){claim.release();repos.close();}});
function fixture(sessionId='one') {
 const repos=createRepositories(':memory:',{newDatabaseAuthority:'ledger_v1'}),claim=repos.control.attachRuntime('controller');opened.push({repos,claim});
 const bound=repos.execution.bind(claim),f={sessionId,runId:'run'},at=new Date().toISOString();bound.createSession({id:sessionId,runId:'run',agentId:'fixture',cwd:'/tmp',state:'idle',createdAt:at,updatedAt:at});
 let valid=true;const owner=new ControlledDriverResources(f,()=>bound,repos.execution,()=>valid,'local');return {repos,bound,f,owner,context:owner.context,revoke(){valid=false;}};
}
describe('opaque resource permits and fixed submissions',()=>{
 it('rejects fabricated and foreign Context permits before creating any child row',()=>{
  const a=fixture(),b=fixture('two');
  expect(()=>a.context.resources.beforeCreate(Object.freeze({}) as OperationPermit,'process')).toThrow('Permit belongs to another driver');
  expect(()=>a.context.resources.beforeCreate(b.context.rootOperation,'process')).toThrow('Permit belongs to another driver');
  expect(a.repos.execution.getResources('one')).toHaveLength(1);
 });
 it('revalidates an existing child permit after generation revocation and keeps cleanup available',()=>{
  const h=fixture();const permit=h.context.resources.beforeCreate(h.context.rootOperation,'process');h.revoke();
  expect(()=>h.context.resources.assertCreation(permit)).toThrow('Original driver owner was revoked');
  h.context.resources.creationFinished(permit,'not_created');h.owner.ready();
  expect(()=>h.context.resources.beginCleanup()).not.toThrow();
  expect(()=>h.context.resources.beforeCreate(h.context.rootOperation,'process')).toThrow();
 });
 it('cannot add another child to a completed parent or upgrade local-only resources',()=>{
  const h=fixture();h.owner.ready();expect(()=>h.context.resources.beforeCreate(h.context.rootOperation,'process')).toThrow('RESOURCE_PARENT_CLOSED');
  const legacy=localOnlyDriverContext(h.f,'legacy');expect(()=>legacy.resources.beginOperation(legacy.rootOperation)).toThrow('Legacy drivers cannot obtain controlled resource permits');
 });
 it('opens a new lifecycle preparation after startup and binds descendants to its fixed owner',()=>{
  const h=fixture();h.owner.ready();let valid=true;
  const operation=h.owner.beginPreparation(()=>valid);
  const nested=h.context.resources.beginOperation(operation);
  const child=h.context.resources.beforeCreate(nested,'process');
  valid=false;
  expect(()=>h.context.resources.assertCreation(child)).toThrow('Original preparation owner was revoked');
  expect(()=>h.context.resources.beginOperation(nested)).toThrow('Original preparation owner was revoked');
  h.context.resources.creationFinished(child,'not_created');h.context.resources.creationFinished(nested,'created');h.owner.endPreparation(operation);
  expect(()=>h.owner.beginPreparation(()=>true)).not.toThrow();
 });
 it('uses the initial permit once, then gives resume a fresh revocable creation scope',()=>{
  const h=fixture();expect(h.owner.beginResume(()=>true)).toBe(h.context.rootOperation);
  h.owner.ready();let valid=true;
  const operation=h.owner.beginResume(()=>valid);
  expect(operation).not.toBe(h.context.rootOperation);
  const child=h.context.resources.beforeCreate(operation,'process');
  valid=false;
  expect(()=>h.context.resources.assertCreation(child)).toThrow('Original preparation owner was revoked');
  h.context.resources.creationFinished(child,'not_created');h.owner.endPreparation(operation);
  expect(()=>h.context.resources.beforeCreate(operation,'process')).toThrow();
  expect(()=>h.owner.beginResume(()=>false)).toThrow('Original resume owner was revoked');
 });
 it('binds a frozen prompt to its active Attempt and rejects its late use after settlement',()=>{
  const h=fixture();h.owner.ready();
  const request:TaskRequestV1={version:1,namespace:'runtime',key:'one',sessionId:'one',actor:{kind:'unspecified'},prompt:'hello',mode:'queue',skills:[],sources:[],sourcePayload:null,options:{}};
  const input={version:2 as const,prompt:'hello',executionContext:{agentPrompt:'hello'},executionOptions:{permissionMode:'ask' as const},contentSources:[]};
  h.bound.acceptTask(h.f,request,{...input,digest:createHash('sha256').update(canonicalExecutionJson(input)).digest('hex')},'back');
  const attempt=h.bound.claimNext(h.f)!.attempt!;const f={...h.f,taskId:attempt.taskId,attemptId:attempt.attemptId,expectedRevision:attempt.revision};
  const prepared=h.context.prepareSubmission({taskId:attempt.taskId,attemptId:attempt.attemptId,submissionId:'submission',prompt:'hello',executionOptions:input.executionOptions});
  expect(()=>{prepared.executionOptions.permissionMode='deny-all';}).toThrow();
  const active=h.bound.markSubmissionPending(f,{submissionId:'submission',inputDigest:prepared.inputDigest,resourceRefs:[],authorizationRefs:[],driverInstanceId:h.context.driverInstanceId}).attempt!;
  const operation=h.owner.beginSubmission(prepared),submission={...prepared,operation,onAccepted(){}};
  expect(()=>h.context.assertSubmission(submission)).not.toThrow();
  expect(()=>h.context.assertSubmission({...submission,prompt:'changed'})).toThrow('Frozen prompt/options changed');
  for(const changed of [
   {resourceRefs:[{resourceId:'another',identityId:'another'}]},
   {nativeContextRef:{resourceId:'native',identityId:'native',originRunId:'run'}},
   {contextProofId:'another-proof'},
   {recovery:{kind:'pty-jsonl-v1' as const,turnId:'another-turn',transcript:{offset:1}}}
  ])expect(()=>h.context.assertSubmission({...submission,...changed})).toThrow('Frozen resource or recovery references changed');
  const nested=h.context.resources.beginOperation(operation);
  expect(()=>h.context.assertSubmission({...submission,operation:nested})).not.toThrow();
  h.context.resources.creationFinished(nested,'created');
  h.bound.markReconcileRequired({...f,expectedRevision:active.revision},{reasonId:'unknown',code:'missing-result',evidenceRefs:[]});
  expect(()=>h.context.assertSubmission(submission)).toThrow('SUBMISSION_SCOPE_CONFLICT');
  expect(()=>h.context.resources.beforeCreate(operation,'process')).toThrow('SUBMISSION_SCOPE_CONFLICT');
 });
});
