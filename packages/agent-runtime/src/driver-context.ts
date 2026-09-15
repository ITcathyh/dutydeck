import type { ChildProcess } from 'node:child_process';
import { childProcessIdentity } from '@dutydeck/storage';
import { makeId, now, RuntimeError, taskExecutionSchemas, type BoundExecutionRepository, type ChildPermit, type DriverContext, type DriverResource, type DriverSubmission, type DriverSubmissionInput, type ExecutionRepository, type NativeContextIdentity, type NativeContextExpected, type NativeContextRef, type OperationPermit, type ResourceOperationScope, type SessionFence } from '@dutydeck/shared';
import { createHash } from 'node:crypto';
import { canonicalExecutionJson } from '@dutydeck/shared';
const digest = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');

type Permit = OperationPermit | ChildPermit;
interface Entry { resourceId: string; operation: boolean; scope: ResourceOperationScope; child?: ChildProcess; exited: boolean; valid?: () => boolean; tail?: Promise<void>; finishTail?: () => void; finished?: boolean; exit?: Promise<void>; }

/** One instance owns all callbacks, even after its execution owner is revoked. */
export class ControlledDriverResources {
  readonly driverInstanceId = makeId('driver');
  readonly rootOperation: OperationPermit;
  readonly context: DriverContext;
  private readonly permits = new Map<Permit, Entry>();
  private revoked = false;
  private startupSettled = false;
  private nativeRef?: NativeContextRef;
  private nativeProof?: string;
  private nativeCreation?: string;
  private factoryAborting = false;
  private factoryCleanup?: Promise<void>;
  constructor(readonly fence: SessionFence, private readonly execution: () => BoundExecutionRepository,
    private readonly repository: ExecutionRepository, private readonly valid: () => boolean, private readonly executionDomain: string,
    repairConfiguration = false, private readonly startupValid:()=>boolean = valid) {
    const original = repository.getNativeContext(fence.sessionId);
    if(original&&taskExecutionSchemas.nativeIdentitySchema.parse(original.resource.identity?.locator).executionDomain!==executionDomain)throw new RuntimeError('NATIVE_CONTEXT_SCOPE_CONFLICT','Original native context belongs to another execution domain',409);
    const scope: ResourceOperationScope = original
      ? {kind:'strict-context-restore',context:original.selection.context,selectionRevision:original.selection.revision,repairConfiguration}
      : {kind:'lifecycle'};
    this.rootOperation=this.operation(scope);
    const expected=original ? taskExecutionSchemas.nativeIdentitySchema.parse(original.resource.identity?.locator) : undefined;
    const resources = {
      beginOperation: (parent?:OperationPermit) => {
        const selected=parent;
        if (!selected) throw new RuntimeError('RESOURCE_SCOPE_REQUIRED','An explicit operation scope is required',409);
        const entry=this.entry(selected,true);this.assertEntry(entry);return this.operation(entry.scope,selected,entry.valid);
      },
      beginCleanup: (resourceIds?:string[]) => {
        const targets=resourceIds ?? [...this.permits.values()].filter(e=>!e.operation).map(e=>e.resourceId);
        if (!targets.length) targets.push(this.entry(this.rootOperation,true).resourceId);
        return this.operation({kind:'cleanup',resourceIds:targets});
      },
      beforeCreate:(parent:OperationPermit,kind:'process')=>{
        const entry=this.entry(parent,true);this.assertEntry(entry);
        const row=this.execution().beforeCreate(this.fence,{resourceId:makeId('resource'),parentResourceId:entry.resourceId,kind});
        const permit=Object.freeze({}) as ChildPermit;this.permits.set(permit,{resourceId:row.resourceId,operation:false,scope:entry.scope,exited:false,valid:entry.valid});return permit;
      },
      assertCreation:(permit:ChildPermit)=>{const entry=this.entry(permit,false);this.assertEntry(entry);if(this.row(entry).stage!=='pending'||this.row(entry).identity||entry.child)throw new RuntimeError('RESOURCE_CREATION_FINISHED','Child permit has already been consumed',409);},
      spawned:(permit:ChildPermit,child:ChildProcess)=>this.capture(permit,child),
      creationFinished:(permit:Permit,result:'created'|'not_created'|'unknown')=>this.finish(permit,result)
    };
    this.context=Object.freeze({...fence,protocol:'controlled-v1' as const,driverInstanceId:this.driverInstanceId,executionDomain,mode:original?'attach' as const:'create' as const,rootOperation:this.rootOperation,resources,
      assertSubmission:(input:DriverSubmission)=>{
        const entry=this.entry(input.operation,true);this.assertScope(entry.scope);
        if(entry.scope.kind!=='submission'||entry.scope.taskId!==input.taskId||entry.scope.attemptId!==input.attemptId||entry.scope.submissionId!==input.submissionId||this.row(entry).stage!=='pending')throw new RuntimeError('SUBMISSION_SCOPE_CONFLICT','Original submission permit is not active',409);
        if(input.inputDigest!==digest({prompt:input.prompt,executionOptions:input.executionOptions}))throw new RuntimeError('SUBMISSION_DIGEST_CONFLICT','Frozen prompt/options changed',409);
        this.execution().assertDriverSubmission(this.fence,{taskId:input.taskId,attemptId:input.attemptId,submissionId:input.submissionId,driverInstanceId:this.driverInstanceId,inputDigest:input.inputDigest});
        const stored=this.repository.getTaskExecution(input.taskId)?.currentAttempt?.submission;
        const references=(value:Pick<DriverSubmission,'resourceRefs'|'nativeContextRef'|'contextProofId'|'recovery'>)=>({resourceRefs:value.resourceRefs,nativeContextRef:value.nativeContextRef??null,contextProofId:value.contextProofId??null,recovery:value.recovery??null});
        if(!stored||canonicalExecutionJson(references(input))!==canonicalExecutionJson(references(stored)))throw new RuntimeError('SUBMISSION_REFERENCES_CONFLICT','Frozen resource or recovery references changed',409);
      },
      prepareSubmission:(input:DriverSubmissionInput)=>this.prepare(input),
      native:{sessionKey:expected?.sessionKey??(()=>{const replacement=repository.getResources(fence.sessionId).filter(r=>r.nativeReplacement).at(-1)?.nativeReplacement;return replacement?`${fence.sessionId}-native-${digest(replacement.decisionId)}`:fence.sessionId;})(),...(expected?{expected}:{}),reserve:(input:NativeContextExpected)=>{
        this.assertScope({kind:'lifecycle'});
        if (input.executionDomain!==this.executionDomain) throw new RuntimeError('NATIVE_CONTEXT_SCOPE_CONFLICT','Native context belongs to a different execution domain',409);
        const row=this.execution().reserveNativeContext(this.fence,{resourceId:makeId('native'),parentResourceId:this.entry(this.rootOperation,true).resourceId,expected:input});
        this.nativeCreation=row.resourceId;return {resourceId:row.resourceId,nativeCreationId:input.nativeCreationId};
      },confirmed:(identity:NativeContextIdentity)=>{
        this.assertScope(scope);
        if (original) {
          const current=this.repository.getNativeContext(fence.sessionId);
          if (!current) throw new RuntimeError('NATIVE_CONTEXT_MISSING','Original context selection is missing',409);
          const binding=this.execution().confirmNativeContextRestore(fence,{operationId:this.entry(this.rootOperation,true).resourceId,context:original.selection.context,
            expectedRevision:original.resource.revision,selectionRevision:original.selection.revision,proofId:makeId('context_proof'),identity});
          this.nativeRef=binding.context;this.nativeProof=binding.proofId;
        } else {
          const row=this.repository.getResources(fence.sessionId).find(r=>r.resourceId===this.nativeCreation);
          if (!row) throw new RuntimeError('NATIVE_CREATION_REQUIRED','Native creation has not been reserved',409);
          const selection=this.execution().confirmNativeContext(fence,row.resourceId,row.revision,identity);
          this.nativeRef=selection.context;this.nativeProof=`native_creation:${row.resourceId}`;
        }
      }}});
  }
  private entry(permit:Permit,operation?:boolean):Entry {
    const entry=this.permits.get(permit);
    if (!entry || operation!==undefined&&entry.operation!==operation) throw new RuntimeError('RESOURCE_PERMIT_INVALID','Permit belongs to another driver or resource kind',409);
    return entry;
  }
  private row(entry:Entry):DriverResource {
    const r=this.repository.getResources(this.fence.sessionId).find(r=>r.resourceId===entry.resourceId);
    if (!r) throw new RuntimeError('DRIVER_RESOURCE_MISSING','Original resource record is missing',409);return r;
  }
  private assertScope(scope:ResourceOperationScope) {
    if (scope.kind!=='cleanup'&&(this.revoked||!this.valid()||!this.startupSettled&&!this.startupValid())) throw new RuntimeError('RESOURCE_OWNER_REVOKED','Original driver owner was revoked',409);
  }
  private assertEntry(entry:Entry) {
    this.assertScope(entry.scope);
    if(entry.valid&&!entry.valid())throw new RuntimeError('RESOURCE_OWNER_REVOKED','Original preparation owner was revoked',409);
  }
  private operation(scope:ResourceOperationScope,parent?:OperationPermit,valid?:()=>boolean):OperationPermit {
    this.assertScope(scope);
    const r=this.execution().beforeControlledOperation(this.fence,{resourceId:makeId('operation'),driverInstanceId:this.driverInstanceId,scope,...(parent?{parentResourceId:this.entry(parent,true).resourceId}:{})});
    let finishTail!:()=>void;
    const tail=new Promise<void>(resolve=>{finishTail=resolve;});
    const permit=Object.freeze({}) as OperationPermit;this.permits.set(permit,{resourceId:r.resourceId,operation:true,scope,exited:false,valid,tail,finishTail,finished:false});return permit;
  }
  private capture(permit:ChildPermit,child:ChildProcess) {
    const entry=this.entry(permit,false);
    if(entry.child)throw new RuntimeError('RESOURCE_PERMIT_CONSUMED','A child permit cannot bind twice',409);
    entry.child=child;
    let finishExit!:()=>void;entry.exit=new Promise<void>(resolve=>{finishExit=resolve;});
    const exited=()=>{entry.exited=true;finishExit();try{this.exited(permit);}catch{/* Keep durable pending evidence if the claim or write is unavailable. */}};
    child.once('exit',exited);child.once('error',()=>{if(child.pid===undefined){entry.exited=true;finishExit();try{this.finish(permit,'not_created');}catch{/* Durable pending remains. */}}});
    if(child.exitCode!==null||child.signalCode!==null){entry.exited=true;finishExit();}
    try {
      if(child.pid===undefined)return;
      const identity=childProcessIdentity(child.pid),r=this.row(entry);
      this.execution().spawned(this.fence,r.resourceId,r.revision,{identityId:makeId('identity'),kind:r.kind as 'process'|'process_group',locator:{...identity}});
      this.finish(permit,'created');
      if(entry.exited)this.exited(permit);
      else {const current=this.row(entry);this.execution().observed(this.fence,current.resourceId,current.revision,{observationId:makeId('observation'),identityId:current.identity!.identityId,state:'live',evidenceRef:'original-child-spawn',observedAt:now()});}
    } catch(error) {
      if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
      throw error;
    } finally {
      if(this.factoryAborting&&entry.scope.kind!=='cleanup'&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    }
  }
  private finish(permit:Permit,result:'created'|'not_created'|'unknown') {
    const entry=this.entry(permit);
    try {
      const r=this.row(entry);if(r.stage!=='pending')return;
      this.execution().creationFinished(this.fence,r.resourceId,r.revision,result);
    } finally {
      // The callback proves its local tail ended even if the durable write fails.
      if(entry.operation){entry.finished=true;entry.finishTail?.();}
    }
  }
  private exited(permit:ChildPermit) {
    const entry=this.entry(permit,false);if(entry.child&&!entry.exited&&entry.child.exitCode===null&&entry.child.signalCode===null)throw new RuntimeError('RESOURCE_EXIT_UNPROVEN','The original child has not exited',409);
    let r=this.row(entry);
    if(r.stage==='pending') { this.finish(permit,r.identity?'created':'unknown');r=this.row(entry); }
    if(r.observations.at(-1)?.state==='gone')return;
    this.execution().observed(this.fence,r.resourceId,r.revision,{observationId:makeId('observation'),...(r.identity?{identityId:r.identity.identityId}:{}),state:'gone',evidenceRef:'original-child-exit',observedAt:now()});
  }
  ready(){this.finish(this.rootOperation,'created');this.startupSettled=true;}
  revoke(){this.revoked=true;}
  refs(){return [...this.permits.values()].filter(e=>!e.operation).map(e=>this.row(e)).filter(r=>r.stage==='created'&&r.identity&&r.observations.at(-1)?.state==='live').map(r=>({resourceId:r.resourceId,identityId:r.identity!.identityId}));}
  reusableIds(){return new Set(this.refs().map(ref=>ref.resourceId));}
  private prepare(input:DriverSubmissionInput):Omit<DriverSubmission,'operation'|'onAccepted'> {
    if(this.nativeCreation&&(!this.nativeRef||!this.nativeProof))throw new RuntimeError('NATIVE_CONTEXT_PROOF_REQUIRED','Strict native context preparation has not completed',409);
    const refs=this.refs().map(ref=>Object.freeze(ref));Object.freeze(refs);
    return Object.freeze({...input,executionOptions:Object.freeze({...input.executionOptions}),inputDigest:digest({prompt:input.prompt,executionOptions:input.executionOptions}),resourceRefs:refs,...(this.nativeRef?{nativeContextRef:Object.freeze({...this.nativeRef}),contextProofId:this.nativeProof}:{})});
  }
  beginPreparation(valid:()=>boolean){
    if(!valid())throw new RuntimeError('RESOURCE_OWNER_REVOKED','Original preparation owner was revoked',409);
    return this.operation({kind:'lifecycle'},undefined,valid);
  }
  beginResume(valid:()=>boolean){
    if(!valid())throw new RuntimeError('RESOURCE_OWNER_REVOKED','Original resume owner was revoked',409);
    return this.startupSettled?this.beginPreparation(valid):this.rootOperation;
  }
  endPreparation(permit:OperationPermit){this.finish(permit,'created');}
  beginSubmission(input:DriverSubmissionInput){
    const permit=this.operation({kind:'submission',taskId:input.taskId,attemptId:input.attemptId,submissionId:input.submissionId});return permit;
  }
  endSubmission(permit:OperationPermit){this.finish(permit,'created');}
  abortFactory():Promise<void> {
    if(!this.factoryCleanup)this.factoryCleanup=this.abortFactoryOnce();
    return this.factoryCleanup;
  }
  private async abortFactoryOnce() {
    this.revoke();this.factoryAborting=true;
    const failures:unknown[]=[];
    const captureFailure=(work:()=>void)=>{try{work();}catch(error){failures.push(error);}};
    captureFailure(()=>this.ready());
    const kill=(entry:Entry)=>{if(entry.child&&!entry.exited)captureFailure(()=>{entry.child!.kill('SIGKILL');});};
    for(const entry of this.permits.values())if(entry.scope.kind!=='cleanup')kill(entry);
    // Nested operations can still be unwinding. Their explicit finish callbacks,
    // rather than the failed outer factory, prove those continuations ended.
    while(true){
      const tails=[...this.permits.values()].filter(entry=>entry.operation&&!entry.finished);
      if(!tails.length)break;
      await Promise.all(tails.map(entry=>entry.tail));
    }
    for(const [permit,entry] of this.permits){
      if(entry.operation)continue;
      if(entry.child)kill(entry);
      else captureFailure(()=>this.finish(permit,'not_created'));
    }
    await Promise.all([...this.permits.values()].map(entry=>entry.exit));
    for(const [permit,entry]of this.permits)if(entry.child&&entry.exited)captureFailure(()=>this.exited(permit as ChildPermit));
    if(failures.length)throw new AggregateError(failures,'Failed factory resource cleanup could not be fully persisted');
  }
  stopped(){
    for(const [permit,entry]of this.permits)if(!entry.operation&&entry.child&&(entry.child.exitCode!==null||entry.child.signalCode!==null))this.exited(permit as ChildPermit);
    const pending=[...this.permits.values()].filter(e=>this.row(e).stage==='pending');
    if(pending.length)throw new RuntimeError('DRIVER_CREATION_PENDING','Original creation tails are still pending',409);
  }
}

export function localOnlyDriverContext(fence:SessionFence,driverInstanceId:string):DriverContext {
  const unsupported=():never=>{throw new RuntimeError('DRIVER_RESOURCE_PROTOCOL_UNSUPPORTED','Legacy drivers cannot obtain controlled resource permits',409);};
  return Object.freeze({...fence,driverInstanceId,protocol:'local-only',executionDomain:'',mode:'create',rootOperation:Object.freeze({}) as OperationPermit,
    assertSubmission:unsupported,prepareSubmission:unsupported,resources:{beginOperation:unsupported,beginCleanup:unsupported,beforeCreate:unsupported,assertCreation:unsupported,spawned:unsupported,creationFinished:unsupported}});
}
