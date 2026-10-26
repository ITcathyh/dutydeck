import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentConfigSchema, type AgentDriver, type BoundExecutionRepository, type NormalizedDriverEvent } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from './index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for(const close of cleanups.splice(0).reverse()) await close(); });
function deferred() { let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve}; }
async function fixture(options: { stopProven?: boolean; emitOnStop?: boolean } = {}) {
  const cwd=await mkdtemp(join(tmpdir(),'runtime-workspace-admission-'));
  execFileSync('git',['-C',cwd,'init','-q']);
  execFileSync('git',['-C',cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','baseline']);
  const repos=createRepositories(join(cwd,'state.db'),{newDatabaseAuthority:'ledger_v1'});
  let bound!:BoundExecutionRepository, beforeClaim:(()=>void)|undefined;
  const bind=repos.execution.bind.bind(repos.execution);
  vi.spyOn(repos.execution,'bind').mockImplementation(claim=>{
    bound=bind(claim);const original=bound.claimNext.bind(bound);
    bound.claimNext=(f,checks)=>{beforeClaim?.();return original(f,checks);};return bound;
  });
  const sent:string[]=[],stopped:string[]=[], gates=new Map<string,ReturnType<typeof deferred>>();
  const background=new Set<string>(), emitters=new Map<string,(event:NormalizedDriverEvent)=>void>();
  let proveIdle=true,proveBackground=true;
  const runtime=new DutydeckRuntime(repos,{workspaceRoot:join(cwd,'workspaces'),cleanupIntervalMs:0,
    probe:(()=>({available:true,protocol:'acp',acp:true})) as any,
    driverFactory:(_agent,_protocol,emit,_exit,id)=>{
      let busy=false,stoppedDriver=false,submitted=false;emitters.set(id,emit);
      const driver:AgentDriver={start:async()=>{},stop:async()=>{stoppedDriver=true;stopped.push(id);if(options.emitOnStop){emit({type:'status',data:{state:'idle'}});emit({type:'completed',data:{stopReason:'end_turn'}});}},isStopped:async()=>stoppedDriver&&options.stopProven!==false,interrupt:async()=>{},
        isIdle:()=>(proveIdle||submitted)&&!busy,hasBackgroundWork:()=>proveBackground?background.has(id):undefined as never,
        send:async prompt=>{submitted=true;busy=true;sent.push(prompt);await gates.get(prompt)?.promise;busy=false;emit({type:'text',data:{text:'result'}});emit({type:'completed',data:{stopReason:'end_turn'}});}};
      return driver;
    }});
  cleanups.push(async()=>{for(const gate of gates.values())gate.resolve();await runtime.shutdown();repos.close();await rm(cwd,{recursive:true,force:true});});
  await runtime.initialize([agentConfigSchema.parse({id:'fixture',name:'Fixture',command:'fake',protocol:'acp',cwd,permissionMode:'ask'})]);
  return {runtime,repos,cwd,sent,stopped,gates,background,emitters,execution:()=>bound,onClaim:(hook:(()=>void)|undefined)=>{beforeClaim=hook;},unproveBackground:()=>{proveBackground=false;},unproveIdle:()=>{proveIdle=false;}};
}
it('queues all session kinds behind a same-repository turn and wakes them without killing proven idle channels', async()=>{
  const h=await fixture();
  const one=await h.runtime.start({agentId:'fixture',cwd:h.cwd});
  const stableId='ses_schedule_'+'a'.repeat(64);
  await h.repos.config.set('session_automation/schedule/schedule-one',JSON.stringify({schemaVersion:1,id:'schedule-one',sessionId:one.id,executionSessionId:stableId,mode:'independent',actorId:'installation_owner'}));
  const two=await h.runtime.startScheduleSession({agentId:'fixture',cwd:h.cwd,workspaceMode:'worktree',source:'schedule',sourceId:'schedule-one'},stableId,async()=>{});
  const gate=deferred();h.gates.set('interactive',gate);
  const first=h.runtime.send(one.id,'interactive');
  await vi.waitFor(()=>expect(h.sent).toEqual(['interactive']));
  const accepted=await h.runtime.dispatchRequest({version:1,namespace:'automation',sessionId:two.id,key:'schedule-occurrence',prompt:'scheduled',mode:'queue',actor:{kind:'installation_owner',id:'installation_owner'},options:{},skills:[],sources:[],sourcePayload:null});
  await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(accepted.id)?.blockers).toContainEqual(expect.objectContaining({code:'WORKSPACE_EXECUTION_BUSY',sessionId:one.id})));
  expect(h.repos.execution.getTaskExecution(accepted.id)).toMatchObject({task:{status:'queued'},attempts:[]});
  expect(h.sent).toEqual(['interactive']);
  gate.resolve();expect((await first).status).toBe('completed');
  await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(accepted.id)?.task.status).toBe('completed'));
  expect(h.sent).toEqual(['interactive','scheduled']);expect(h.stopped).toEqual([]);
  expect(h.repos.execution.getResources(one.id).some(r=>r.kind==='local_only'&&r.observations.at(-1)?.state==='live')).toBe(true);
});
it('keeps a known idle driver with background work blocking and only safely stops an idle adapter lacking background proof on contention', async()=>{
  const h=await fixture(),one=await h.runtime.start({agentId:'fixture',cwd:h.cwd}),two=await h.runtime.start({agentId:'fixture',cwd:h.cwd});
  h.background.add(one.id);
  const queued=await h.runtime.dispatch(two.id,'waiting-for-background');
  await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(queued.id)?.blockers).toContainEqual(expect.objectContaining({code:'WORKSPACE_PHYSICAL_RESOURCE_UNSAFE',sessionId:one.id})));
  expect(h.sent).toEqual([]);expect(h.stopped).toEqual([]);
  h.background.delete(one.id);h.unproveBackground();
  // A real control operation supplies the wake-up; absent a reliable empty proof, physical stop must succeed.
  await h.runtime.stop(one.id,{kind:'installation_owner',id:'installation_owner'});
  await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('completed'));
  expect(h.stopped).toEqual([one.id]);
});
it('coalesces stable schedule session creation and verifies immutable worktree scope and authorization on reuse',async()=>{
  const h=await fixture(),authorize=vi.fn(async()=>{}),id='ses_schedule_'+'b'.repeat(64);
  const input={agentId:'fixture',cwd:h.cwd,workspaceMode:'worktree' as const,source:'schedule',sourceId:'stable-schedule',permissionMode:'ask' as const};
  const [one,two]=await Promise.all([h.runtime.startScheduleSession(input,id,authorize),h.runtime.startScheduleSession(input,id,authorize)]);
  expect(one.id).toBe(two.id);expect(one.workspaceMode).toBe('worktree');expect(one.cwd).not.toBe(h.cwd);
  expect((await h.runtime.startScheduleSession(input,id,authorize)).cwd).toBe(one.cwd);
  for(const patch of [{sourceId:'other'},{model:'other'},{permissionMode:'full-trust' as const}])await expect(h.runtime.startScheduleSession({...input,...patch},id,authorize)).rejects.toMatchObject({code:'SCHEDULE_SESSION_CONFLICT'});
  await expect(h.runtime.startScheduleSession(input,id,async()=>{throw new Error('revoked');})).rejects.toThrow('revoked');
  await expect(h.runtime.start(input)).rejects.toMatchObject({code:'INVALID_SCHEDULE_SESSION'});
});

it('rejects a stale idle proof if resource evidence changes at the claim boundary and rechecks after an idle event',async()=>{
  const h=await fixture(),one=await h.runtime.start({agentId:'fixture',cwd:h.cwd}),two=await h.runtime.start({agentId:'fixture',cwd:h.cwd});
  h.onClaim(()=>{
    h.onClaim(undefined);h.background.add(one.id);
    const r=h.repos.execution.getResources(one.id).find(value=>value.kind==='local_only')!;
    h.execution().observed({sessionId:one.id,runId:one.runId},r.resourceId,r.revision,{observationId:'new-background-evidence',state:'live',identityId:r.identity!.identityId,evidenceRef:'fixture:background-changed',observedAt:new Date().toISOString()});
  });
  const task=await h.runtime.dispatch(two.id,'after-proof-race');
  await vi.waitFor(()=>expect(h.background.has(one.id)).toBe(true));
  await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(task.id)?.blockers).toContainEqual(expect.objectContaining({code:'WORKSPACE_PHYSICAL_RESOURCE_UNSAFE',sessionId:one.id})));
  expect(h.sent).toEqual([]);expect(h.stopped).toEqual([]);
  h.background.delete(one.id);h.emitters.get(one.id)!({type:'status',data:{state:'program_status',programState:'idle'}});
  await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(task.id)?.task.status).toBe('completed'));
  expect(h.stopped).toEqual([]);
});
it('safely retires an idle adapter lacking background-empty proof only when another session needs its repository',async()=>{
  const h=await fixture(),one=await h.runtime.start({agentId:'fixture',cwd:h.cwd}),two=await h.runtime.start({agentId:'fixture',cwd:h.cwd});
  h.unproveBackground();
  expect(h.stopped).toEqual([]);
  const task=await h.runtime.dispatch(two.id,'requires-proof');
  await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(task.id)?.task.status).toBe('completed'));
  expect(h.stopped).toEqual([one.id]);expect(h.sent).toEqual(['requires-proof']);
});

it('does not deadlock two accepted sibling sessions whose startup screens have not proved idle before their first prompt',async()=>{
  const h=await fixture(),one=await h.runtime.start({agentId:'fixture',cwd:h.cwd}),two=await h.runtime.start({agentId:'fixture',cwd:h.cwd});
  h.unproveIdle();
  const [first,second]=await Promise.all([h.runtime.dispatch(one.id,'first-sibling'),h.runtime.dispatch(two.id,'second-sibling')]);
  await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(first.id)?.task.status).toBe('completed'));
  await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(second.id)?.task.status).toBe('completed'));
  expect([...h.sent].sort()).toEqual(['first-sibling','second-sibling']);
  expect(h.stopped).toEqual([]);
});

it('does not reuse an initial control-channel proof after a never-submitted Herdr terminal is attached across restart',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'runtime-admission-attach-')),path=join(cwd,'state.db');
  const agent=agentConfigSchema.parse({id:'terminal',name:'Terminal',command:'fake',protocol:'pty-cli',cwd,permissionMode:'ask'});
  let repos=createRepositories(path,{newDatabaseAuthority:'ledger_v1'}),detached=false;
  let runtime=new DutydeckRuntime(repos,{cleanupIntervalMs:0,driverIdleTimeoutMs:0,terminalBackend:async()=>'herdr',
    probe:()=>({available:true,protocol:'pty-cli'}),
    driverFactory:()=>({start:async()=>{},send:async()=>{},interrupt:async()=>{},stop:async()=>{},isStopped:async()=>!detached,
      prepareForDaemonShutdown:()=>{detached=true;},isDetachedForShutdown:()=>detached,
      persistentTerminalIdentity:async()=>({original:'admission-attach-fixture'})})});
  const close=deferred();let closing=false,attachedIdle=false;const sent:string[]=[];
  try {
    await runtime.initialize([agent]);
    const original=await runtime.start({agentId:agent.id});
    expect(await repos.config.get('runtime_idle_terminal:'+original.id)).toBeDefined();
    await runtime.shutdown();repos.close();repos=createRepositories(path);
    runtime=new DutydeckRuntime(repos,{cleanupIntervalMs:0,driverIdleTimeoutMs:0,probe:()=>({available:true,protocol:'pty-cli'}),
      driverFactory:(_agent,_protocol,emit,_exit,id)=>({
        start:async()=>{},attachTerminal:async()=>true,interrupt:async()=>{},
        isIdle:()=>id!==original.id||attachedIdle,hasBackgroundWork:()=>false,
        stop:async()=>{if(id===original.id){closing=true;await close.promise;}},isStopped:async()=>true,
        send:async prompt=>{sent.push(prompt);emit({type:'text',data:{text:'result'}});emit({type:'completed',data:{stopReason:'end_turn'}});}
      })});
    await runtime.initialize([agent]);
    const target=await runtime.start({agentId:agent.id});
    const task=await runtime.dispatch(target.id,'after-restart');
    await vi.waitFor(()=>expect(closing).toBe(true));
    expect(sent).toEqual([]);
    expect(repos.execution.getTaskExecution(task.id)?.task.status).toBe('queued');
    close.resolve();
    await vi.waitFor(()=>expect(repos.execution.getTaskExecution(task.id)?.task.status,JSON.stringify(repos.execution.getTaskExecution(task.id)?.currentAttempt)).toBe('completed'));
    expect(sent).toEqual(['after-restart']);
  } finally {close.resolve();attachedIdle=true;await runtime.shutdown();repos.close();await rm(cwd,{recursive:true,force:true});}
});

it('does not retry an unverified stop on its own status/completion events or starve the event loop',async()=>{
  const h=await fixture({stopProven:false,emitOnStop:true});
  const one=await h.runtime.start({agentId:'fixture',cwd:h.cwd}),two=await h.runtime.start({agentId:'fixture',cwd:h.cwd});
  h.unproveBackground();
  const task=await h.runtime.dispatch(two.id,'blocked-on-unverified-stop');
  await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(task.id)?.blockers).toContainEqual(expect.objectContaining({code:'DRIVER_STOP_BLOCKED',sessionId:one.id})));
  const eventsBefore=(await h.runtime.getEvents(one.id)).length;
  // A genuine timer must run despite the adapter emitting events during stop.
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(h.stopped).toEqual([one.id]);
  expect(h.sent).toEqual([]);
  expect(h.repos.execution.getTaskExecution(task.id)).toMatchObject({task:{status:'queued'},attempts:[]});
  expect((await h.runtime.getEvents(one.id)).length).toBe(eventsBefore);
  expect(eventsBefore).toBeLessThan(10);
  expect(await h.repos.config.get('runtime_driver_stop_block:'+one.id)).toContain('unverified');
});
