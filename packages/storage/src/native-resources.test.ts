import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalExecutionJson, type NativeContextIdentity, type RepositoryBundle, type RuntimeControlClaim, type TaskRequestV1 } from '@dutydeck/shared';
import { createRepositories } from './index.js';

const opened: Array<{repos:RepositoryBundle;claim:RuntimeControlClaim}> = [];
afterEach(() => {for (const {repos,claim} of opened.splice(0)) {claim.release();repos.close();}});
const fence={sessionId:'session',runId:'run'};
const hash=(v:unknown)=>createHash('sha256').update(canonicalExecutionJson(v)).digest('hex');
function setup(source?:{source:string;sourceId:string}) {
  const repos=createRepositories(':memory:',{newDatabaseAuthority:'ledger_v1'}),claim=repos.control.attachRuntime('controller');opened.push({repos,claim});
  const x=repos.execution.bind(claim),at=new Date().toISOString();
  x.createSession({id:fence.sessionId,runId:fence.runId,agentId:'fixture',cwd:'/tmp',state:'idle',createdAt:at,updatedAt:at,...source});
  return {repos,claim,x};
}
const expected={nativeCreationId:'native-create',sessionKey:'key',agent:'fixture',command:['node','fixture.mjs'],cwd:'/tmp',executionDomain:'local'};
const identity:NativeContextIdentity={...expected,acpxRecordId:'key',backendSessionId:'original',defaults:{model:'A'}};
function native(x: ReturnType<typeof setup>['x']) {
  const root=x.beforeControlledOperation(fence,{resourceId:'factory',driverInstanceId:'driver'});
  const row=x.reserveNativeContext(fence,{resourceId:'native',parentResourceId:root.resourceId,expected});
  return {root,row};
}
function claimTask(x:ReturnType<typeof setup>['x'],runId='run') {
  const request:TaskRequestV1={version:1,namespace:'runtime',key:runId,sessionId:'session',actor:{kind:'unspecified'},prompt:'hello',mode:'queue',skills:[],options:{},sources:[],sourcePayload:null};
  const content={version:2 as const,prompt:'hello',executionContext:{agentPrompt:'hello'},executionOptions:{permissionMode:'ask' as const},contentSources:[]};
  x.acceptTask({...fence,runId},request,{...content,digest:hash(content)},'back');
  const a=x.claimNext({...fence,runId})!.attempt!;
  return {sessionId:a.sessionId,runId:a.runId,taskId:a.taskId,attemptId:a.attemptId,expectedRevision:a.revision};
}

describe('Native context and controlled resource scopes',()=>{
  it('does not upgrade an old operation into a controlled parent',()=>{
    const {x}=setup();x.beforeCreate(fence,{resourceId:'legacy',kind:'operation'});
    expect(()=>x.beforeControlledOperation(fence,{resourceId:'nested',driverInstanceId:'driver',parentResourceId:'legacy'})).toThrow('RESOURCE_PARENT_CLOSED');
  });
  it('keeps native creation pending independently of finished factory and forbids generic bypasses',()=>{
    const {x,repos}=setup(),{root,row}=native(x);
    x.creationFinished(fence,root.resourceId,root.revision,'created');
    expect(repos.execution.getSessionResourceBlockers('session').map(b=>b.resourceId)).toEqual(['native']);
    expect(()=>x.creationFinished(fence,row.resourceId,row.revision,'not_created')).toThrow();
    expect(()=>x.spawned(fence,row.resourceId,row.revision,{identityId:'forged',kind:'remote',locator:{}})).toThrow();
    expect(()=>x.observed(fence,row.resourceId,row.revision,{observationId:'gone',state:'gone',evidenceRef:'process-exit',observedAt:new Date().toISOString()})).toThrow();
    expect(()=>x.beforeControlledOperation(fence,{resourceId:'replacement',driverInstanceId:'driver2'})).toThrow(expect.objectContaining({code:'SESSION_RESOURCE_BLOCKED'}));
  });
  it('confirms exact identity and selection atomically and requires proof at submission',()=>{
    const {x,repos}=setup(),{root,row}=native(x);
    expect(()=>x.confirmNativeContext(fence,row.resourceId,row.revision,{...identity,sessionKey:'other'})).toThrow('NATIVE_CONTEXT_IDENTITY_CONFLICT');
    expect(repos.execution.getNativeContext('session')).toBeUndefined();
    const selected=x.confirmNativeContext(fence,row.resourceId,row.revision,identity);
    expect(x.confirmNativeContext(fence,row.resourceId,row.revision,identity)).toEqual(selected);
    x.creationFinished(fence,root.resourceId,root.revision,'created');
    const f=claimTask(x);
    const intent={submissionId:'submission',inputDigest:hash('hello'),resourceRefs:[],authorizationRefs:[]};
    expect(()=>x.markSubmissionPending(f,intent)).toThrow('NATIVE_CONTEXT_SELECTION_CONFLICT');
    expect(()=>x.markSubmissionPending(f,{...intent,nativeContextRef:selected.context,contextProofId:'wrong',driverInstanceId:'driver'})).toThrow('NATIVE_CONTEXT_PROOF_REQUIRED');
    expect(x.markSubmissionPending(f,{...intent,nativeContextRef:selected.context,contextProofId:'native_creation:native',driverInstanceId:'driver'}).attempt?.state).toBe('active');
  });
  it('carries a native reference across run while preserving origin and requires a current binding',()=>{
    const {x,repos}=setup(),{root,row}=native(x);
    const selected=x.confirmNativeContext(fence,row.resourceId,row.revision,identity);x.creationFinished(fence,root.resourceId,root.revision,'created');
    x.replaceSessionRun(fence,'next',[]);
    const next={...fence,runId:'next'}, view=repos.execution.getNativeContext('session')!;
    expect(view.selection).toMatchObject({runId:'next',revision:2,context:selected.context});expect(view.resource.runId).toBe('run');
    const op=x.beforeControlledOperation(next,{resourceId:'restore',driverInstanceId:'driver2',scope:{kind:'strict-context-restore',context:selected.context,selectionRevision:2,repairConfiguration:false}});
    const binding=x.confirmNativeContextRestore(next,{operationId:op.resourceId,context:selected.context,expectedRevision:view.resource.revision,selectionRevision:2,proofId:'proof2',identity});
    expect(binding.runId).toBe('next');expect(repos.execution.getNativeContext('session')?.resource.runId).toBe('run');
    x.creationFinished(next,op.resourceId,op.revision,'created');
    const f=claimTask(x,'next');
    expect(()=>x.markSubmissionPending(f,{submissionId:'s',inputDigest:hash('x'),resourceRefs:[{resourceId:'native',identityId:selected.context.identityId}],authorizationRefs:[],nativeContextRef:selected.context,contextProofId:'proof2',driverInstanceId:'driver2'})).toThrow('RESOURCE_IDENTITY_CONFLICT');
  });
  it('allows sibling operations only within the active fixed submission',()=>{
    const {x}=setup(), f=claimTask(x);
    x.markSubmissionPending(f,{submissionId:'s',inputDigest:hash('x'),resourceRefs:[],authorizationRefs:[],driverInstanceId:'driver'});
    const scope={kind:'submission' as const,taskId:f.taskId,attemptId:f.attemptId,submissionId:'s'};
    x.beforeControlledOperation(fence,{resourceId:'one',driverInstanceId:'driver',scope});
    x.beforeControlledOperation(fence,{resourceId:'two',driverInstanceId:'driver',scope});
    expect(()=>x.beforeControlledOperation(fence,{resourceId:'wrong-driver',driverInstanceId:'other',scope})).toThrow('SUBMISSION_SCOPE_CONFLICT');
    expect(()=>x.beforeControlledOperation(fence,{resourceId:'wrong-attempt',driverInstanceId:'driver',scope:{...scope,attemptId:'other'}})).toThrow('SUBMISSION_SCOPE_CONFLICT');
    expect(()=>x.beforeControlledOperation(fence,{resourceId:'unrelated',driverInstanceId:'driver'})).toThrow(expect.objectContaining({code:'SESSION_RESOURCE_BLOCKED'}));
  });
  it('permits restricted cleanup after stop without authorizing a new lifecycle',()=>{
    const {x}=setup();const root=x.beforeControlledOperation(fence,{resourceId:'factory',driverInstanceId:'driver'});
    const child=x.beforeCreate(fence,{resourceId:'child',kind:'process',parentResourceId:root.resourceId});
    x.creationFinished(fence,child.resourceId,child.revision,'not_created');
    x.creationFinished(fence,root.resourceId,root.revision,'created');
    x.patchSessionState(fence,'stop',{state:'stopped'});
    expect(()=>x.beforeControlledOperation(fence,{resourceId:'new',driverInstanceId:'driver'})).toThrow('SESSION_NOT_ACCEPTING');
    const op=x.beforeControlledOperation(fence,{resourceId:'cleanup',driverInstanceId:'driver',scope:{kind:'cleanup',resourceIds:['child']}});
    expect(op.operationScope?.kind).toBe('cleanup');
    expect(x.beforeCreate(fence,{resourceId:'cleanup-ps',kind:'process',parentResourceId:op.resourceId}).stage).toBe('pending');
    expect(()=>x.beforeControlledOperation(fence,{resourceId:'bad',driverInstanceId:'other',scope:{kind:'cleanup',resourceIds:['child']}})).toThrow('RESOURCE_SCOPE_CONFLICT');
  });
  it('requires an explicit replacement and preserves the unknown context record',()=>{
    const {x,repos}=setup(),{root,row}=native(x);
    const decision={decisionId:'replace',actor:{kind:'installation_owner' as const,id:'installation_owner' as const},resourceId:row.resourceId,expectedRevision:row.revision};
    expect(()=>x.replaceNativeContext(fence,decision)).toThrow('SESSION_RESOURCE_BLOCKED');
    x.creationFinished(fence,root.resourceId,root.revision,'created');
    x.replaceNativeContext(fence,decision);x.replaceNativeContext(fence,decision);
    expect(repos.execution.getResources('session').find(r=>r.resourceId==='native')).toMatchObject({stage:'pending',nativeReplacement:decision});
    expect(repos.execution.getSessionResourceBlockers('session')).toEqual([]);
  });
  it('protects the selection reference from config writers',async()=>{
    const {repos}=setup();
    const escaped=await repos.groupPolicy.transact(tx=>tx.config);
    for(const key of ['runtime_native_context:session','runtime_native_context:session:revision']){
      await expect(repos.config.set(key,'{}')).rejects.toMatchObject({code:'EXECUTION_WRITE_REQUIRES_LEDGER'});
      await expect(repos.config.compareAndSet!(key,undefined,'{}')).rejects.toMatchObject({code:'EXECUTION_WRITE_REQUIRES_LEDGER'});
      await expect(repos.groupPolicy.transact(tx=>tx.config.set(key,'{}'))).rejects.toMatchObject({code:'EXECUTION_WRITE_REQUIRES_LEDGER'});
      expect(()=>escaped.set(key,'{}')).toThrow('Native context selection requires a bound ledger command');
      expect(await repos.config.get(key)).toBeUndefined();
    }
    for(const key of ['runtime_driver_configuration:session','work-item:one','lark.run-context.one']){
      escaped.set(key,'normal');expect(await repos.config.get(key)).toBe('normal');
    }
  });
  it('does not execute a restore-input getter before rejecting non-JSON input',()=>{
    const {x}=setup();let accessed=false;
    const input={get identity(){accessed=true;return identity;}};
    expect(()=>Reflect.apply(x.confirmNativeContextRestore,x,[fence,input])).toThrow('EXECUTION_INVALID_INPUT');expect(accessed).toBe(false);
  });
  it('requires the original App scope for native management',()=>{
    const {x}=setup({source:'lark',sourceId:'original-app:chat'});
    expect(()=>x.authorizeNativeContextControl(fence,{kind:'channel',id:'person',appId:'foreign-app'})).toThrow('TASK_ACTOR_CONFLICT');
    expect(()=>x.authorizeNativeContextControl(fence,{kind:'unspecified'})).toThrow('ACTOR_REQUIRED');
    expect(()=>x.authorizeNativeContextControl(fence,{kind:'channel',id:'person',appId:'original-app'})).not.toThrow();
  });

});
