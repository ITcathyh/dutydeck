import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcpxAdapter } from '@dutydeck/acp-client';
import { createRuntimeStore } from 'acpx/runtime';
import { agentConfigSchema, type BoundExecutionRepository, type TaskRequestV1, type DriverFactory, type DriverContext } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from './index.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const run of cleanup.splice(0).reverse())await run();vi.restoreAllMocks();});
async function setup(env:Record<string,string>={},observeBound?: (bound:BoundExecutionRepository)=>void,expectedStartError?:string) {
 const dir=await mkdtemp(join(tmpdir(),'dutydeck-physical-native-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
 const agent=agentConfigSchema.parse({id:'strict',name:'Strict',protocol:'acp',command:process.execPath,args:[resolve('tests/fixtures/acp-strict-native-agent.mjs')],cwd:dir,env:{native_directory:dir,...env},permissionMode:'full-trust',timeout:10,capabilities:{pause:false,resume:true}});
 const repos=createRepositories(join(dir,'db'),{newDatabaseAuthority:'ledger_v1'});const bind=repos.execution.bind.bind(repos.execution);vi.spyOn(repos.execution,'bind').mockImplementation(claim=>{const result=bind(claim);observeBound?.(result);return result;});const runtime=new DutydeckRuntime(repos,{cleanupIntervalMs:0});
 cleanup.push(async()=>{await rm(join(dir,'hold-config'),{force:true});await rm(join(dir,'hold-new'),{force:true});await runtime.shutdown();repos.close();});
 await runtime.initialize([agent]);
 const session=await runtime.start({agentId:agent.id}).catch(async(error:unknown)=>{if(!expectedStartError)throw error;expect(error).toBeInstanceOf(Error);expect((error as Error).message).toContain(expectedStartError);const value=(await repos.sessions.list())[0];if(!value)throw error;return value;});
 const calls=async()=> (await readFile(join(dir,'native-calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {method:string;params?:Record<string,unknown>;env?:string});
 return {dir,agent,repos,runtime,session,calls,store:createRuntimeStore({stateDir:join(dir,'.dutydeck','acpx')})};
}
describe('controlled physical resources and strict native context',()=>{
 it('finishes asynchronous turn preparation before recording intent and freezes only after its tail',async()=>{
  const h=await setup();let release!:()=>void;const gate=new Promise<void>(yes=>{release=yes;});let entered=false;
  Object.defineProperty(AcpxAdapter.prototype,'prepareTurn',{configurable:true,value:async()=>{entered=true;await gate;}});
  cleanup.push(async()=>{release();Reflect.deleteProperty(AcpxAdapter.prototype,'prepareTurn');});
  const result=h.runtime.send(h.session.id,'prepared');await expect.poll(()=>entered).toBe(true);
  const tasks=await h.repos.tasks.listBySession(h.session.id);const attempt=h.repos.execution.getTaskExecution(tasks[0]!.id)!.currentAttempt!;
  expect(attempt.submissionState).toBe('not_submitted');
  expect(h.repos.execution.getResources(h.session.id).filter(r=>r.kind==='operation'&&r.stage==='pending')).toHaveLength(1);
  expect((await h.calls()).filter(c=>c.method==='session/prompt')).toHaveLength(0);
  release();expect((await result).status).toBe('completed');
  expect(h.repos.execution.getResources(h.session.id).filter(r=>r.kind==='operation'&&r.stage==='pending')).toHaveLength(0);
 });
 it('keeps an interrupted preparation operation pending until its real tail ends and never submits',async()=>{
  const h=await setup();let release!:()=>void;const gate=new Promise<void>(yes=>{release=yes;});let entered=false;
  Object.defineProperty(AcpxAdapter.prototype,'prepareTurn',{configurable:true,value:async()=>{entered=true;await gate;}});
  cleanup.push(async()=>{release();Reflect.deleteProperty(AcpxAdapter.prototype,'prepareTurn');});
  const result=h.runtime.send(h.session.id,'cancel preparation');await expect.poll(()=>entered).toBe(true);
  const interruption=h.runtime.interrupt(h.session.id);
  expect((await result).status).toBe('cancelled');
  expect(h.repos.execution.getResources(h.session.id).filter(r=>r.kind==='operation'&&r.stage==='pending')).toHaveLength(1);
  release();await interruption;await expect.poll(()=>h.repos.execution.getResources(h.session.id).filter(r=>r.kind==='operation'&&r.stage==='pending').length).toBe(0);
  expect((await h.calls()).filter(c=>c.method==='session/prompt')).toHaveLength(0);
 });
 it('persists physical children and native identity before one prompt, then preserves native history on restore',async()=>{
  const h=await setup();const selected=h.repos.execution.getNativeContext(h.session.id)!;
  expect(selected.resource.identity?.locator).toMatchObject({defaults:{model:'A',reasoningEffort:'low'}});
  const first=await h.runtime.send(h.session.id,'hello');expect(first.status).toBe('completed');
  const key=h.session.id;const before=await h.store.load(key);expect(before?.messages.length).toBe(2);
  await h.runtime.stop(key);expect(h.repos.execution.getSessionResourceBlockers(key)).toEqual([]);
  expect(h.repos.execution.getResources(key).filter(r=>r.kind==='process')).not.toHaveLength(0);
  expect(h.repos.execution.getResources(key).filter(r=>r.kind==='process').every(r=>r.observations.at(-1)?.state==='gone')).toBe(true);
  await h.runtime.resume(key);expect((await h.store.load(key))?.messages).toEqual(before?.messages);
  expect((await h.runtime.send(key,'second')).status).toBe('completed');
  expect((await h.calls()).filter(c=>c.method==='session/new')).toHaveLength(1);expect((await h.calls()).filter(c=>c.method==='session/load')).toHaveLength(1);
  expect(h.repos.execution.getNativeContext(key)?.selection.context).toEqual(selected.selection.context);
 });
 it('restores creation defaults between tasks after an explicit model and effort override',async()=>{
  const h=await setup();await h.runtime.setModel(h.session.id,'B');await h.runtime.setReasoningEffort(h.session.id,'high');
  expect((await h.runtime.send(h.session.id,'configured')).status).toBe('completed');
  expect(JSON.parse(await readFile(join(h.dir,'native-state.json'),'utf8'))).toMatchObject({model:'B',effort:'high'});
 });
 it('does not resend a prompt when its error contains resource not found',async()=>{
  const h=await setup();await writeFile(join(h.dir,'fail-prompt'),'1');
  const task=await h.runtime.send(h.session.id,'unknown');expect(h.repos.execution.getTaskExecution(task.id)?.attempts[0]?.state).toBe('reconcile_required');
  expect((await h.calls()).filter(c=>c.method==='session/new')).toHaveLength(1);expect((await h.calls()).filter(c=>c.method==='session/prompt')).toHaveLength(1);
 });
 it('keeps configuration pending and then unknown without accepting a new native prompt',async()=>{
  const h=await setup();await writeFile(join(h.dir,'hold-config'),'1');await writeFile(join(h.dir,'fail-config'),'1');
  const changing=h.runtime.setModel(h.session.id,'B').catch(error=>error);
  await expect.poll(()=>existsSync(join(h.dir,'config-entered'))).toBe(true);
  const during=await h.runtime.send(h.session.id,'during');expect(during.status).toBe('failed');expect(h.repos.execution.getTaskExecution(during.id)?.currentAttempt?.submissionState).toBe('not_submitted');
  await rm(join(h.dir,'hold-config'));expect(await changing).toBeInstanceOf(Error);
  expect(await h.repos.config.get(`runtime_driver_configuration:${h.session.id}`)).toContain('unknown');
  await h.runtime.stop(h.session.id);await expect(h.runtime.resume(h.session.id)).rejects.toThrow();
  expect((await h.calls()).filter(c=>c.method==='session/prompt')).toHaveLength(0);
 });
 it('records host terminal and cleanup helper processes independently',async()=>{
  const h=await setup();expect((await h.runtime.send(h.session.id,'terminal')).status).toBe('completed');
  await h.runtime.stop(h.session.id);
  const processes=h.repos.execution.getResources(h.session.id).filter(r=>r.kind==='process');expect(processes.length).toBeGreaterThanOrEqual(2);
  expect(processes.every(r=>r.stage==='not_created'||r.observations.at(-1)?.state==='gone')).toBe(true);
 });
 it('repairs the original native configuration after a failed ACK without replaying any old task',async()=>{
  const h=await setup();await writeFile(join(h.dir,'fail-config'),'1');
  await expect(h.runtime.setModel(h.session.id,'B')).rejects.toThrow();await rm(join(h.dir,'fail-config'));
  const before=h.repos.execution.getNativeContext(h.session.id)!.selection.context;
  await h.runtime.restoreNativeConfiguration(h.session.id,{kind:'installation_owner',id:'installation_owner'});
  expect(await h.repos.config.get(`runtime_driver_configuration:${h.session.id}`)).toBe('');
  expect(h.repos.execution.getNativeContext(h.session.id)?.selection.context).toEqual(before);
  expect((await h.calls()).filter(c=>c.method==='session/prompt')).toHaveLength(0);
  expect((await h.runtime.send(h.session.id,'after repair')).status).toBe('completed');
  expect(JSON.parse(await readFile(join(h.dir,'native-state.json'),'utf8'))).toMatchObject({model:'A',effort:'low'});
 });
 it('keeps messages and metadata when scoped startup credentials change, and persists only snake_case keys',async()=>{
  const h=await setup({dutydeck_group_tools_token:'old',UPPER_VENDOR_TOKEN:'vendor'});
  await h.runtime.send(h.session.id,'history');await h.runtime.stop(h.session.id);
  const before=await h.store.load(h.session.id);expect(before?.messages.length).toBe(2);
  if(!before)throw new Error('missing record');before.title='keep title';await h.store.save(before);
  await h.repos.agents.save({...h.agent,env:{...h.agent.env,dutydeck_group_tools_token:'new'}});
  await h.runtime.resume(h.session.id);const after=await h.store.load(h.session.id);
  expect(after?.messages).toEqual(before.messages);expect(after?.title).toBe('keep title');
  expect(after?.eventLog).toEqual(before.eventLog);expect(after?.acpx?.session_options?.env?.dutydeck_group_tools_token).toBe('new');
  expect(JSON.stringify(after?.acpx?.session_options)).not.toContain('UPPER_VENDOR_TOKEN');
  expect((await h.calls()).filter(c=>c.method==='session/new')).toHaveLength(1);expect((await h.calls()).filter(c=>c.method==='spawn').at(-1)?.env).toBe('new');
 });
 it('rejects a lost native record before any new process, load or prompt',async()=>{
  const h=await setup();await h.runtime.stop(h.session.id);
  await rm(join(h.dir,'.dutydeck','acpx'),{recursive:true,force:true});
  await expect(h.runtime.resume(h.session.id)).rejects.toThrow('ACP_NATIVE_CONTEXT_MISSING');
  expect((await h.calls()).filter(c=>c.method==='session/new')).toHaveLength(1);expect((await h.calls()).filter(c=>c.method==='session/prompt')).toHaveLength(0);expect((await h.calls()).filter(c=>c.method==='spawn')).toHaveLength(1);
 });
 it('rejects an altered record at a later prompt without implicit fresh retry',async()=>{
  const h=await setup();const record=await h.store.load(h.session.id);if(!record)throw new Error('missing record');record.acpSessionId='other';await h.store.save(record);
  const task=await h.runtime.send(h.session.id,'must not prompt');expect(task.status).toBe('reconcile_required');
  expect((await h.calls()).filter(c=>c.method==='session/prompt')).toHaveLength(0);expect((await h.calls()).filter(c=>c.method==='session/new')).toHaveLength(1);
 });
 it('rejects foreign App and unspecified configuration-repair actors before creating resources',async()=>{
  const h=await setup();await writeFile(join(h.dir,'fail-config'),'1');await expect(h.runtime.setModel(h.session.id,'B')).rejects.toThrow();
  const before=h.repos.execution.getResources(h.session.id);
  await expect(h.runtime.restoreNativeConfiguration(h.session.id,{kind:'unspecified'})).rejects.toMatchObject({code:'ACTOR_REQUIRED'});
  await expect(h.runtime.restoreNativeConfiguration(h.session.id,{kind:'channel',id:'actor',appId:'foreign'})).rejects.toThrow();
  expect(h.repos.execution.getResources(h.session.id)).toEqual(before);
 });

 it('recovers the exact first persisted native receipt after its SQLite confirmation fails',async()=>{
  const h=await setup({},bound=>{vi.spyOn(bound,'confirmNativeContext').mockImplementationOnce(()=>{throw new Error('native confirmation unavailable');});},'native confirmation unavailable');
  const pending=h.repos.execution.getResources(h.session.id).find(r=>r.purpose==='acp_native_context')!;expect(pending.stage).toBe('pending');expect(pending.identity).toBeUndefined();
  expect((await h.calls()).filter(c=>c.method==='session/new')).toHaveLength(1);expect((await h.calls()).filter(c=>c.method==='session/prompt')).toHaveLength(0);
  await h.runtime.probeNativeResources(h.session.id,{kind:'installation_owner',id:'installation_owner'});
  expect(h.repos.execution.getNativeContext(h.session.id)?.resource.nativeBindings).toBeUndefined();
  await h.runtime.resume(h.session.id);expect((await h.runtime.send(h.session.id,'after receipt recovery')).status).toBe('completed');
  expect((await h.calls()).filter(c=>c.method==='session/new')).toHaveLength(1);
 });
 it('has zero child spawn if its durable birth permit cannot be written',async()=>{
  const h=await setup({},bound=>{vi.spyOn(bound,'beforeCreate').mockImplementationOnce(()=>{throw new Error('before child denied');});},'before child denied');
  expect(existsSync(join(h.dir,'native-calls.jsonl'))).toBe(false);
  expect(h.repos.execution.getResources(h.session.id).filter(r=>r.kind==='process')).toHaveLength(0);
  expect(h.repos.execution.getResources(h.session.id).find(r=>r.purpose==='acp_native_context')?.stage).toBe('pending');
 });
 it('retains and stops the original child when persisting its identity fails',async()=>{
  const h=await setup({},bound=>{vi.spyOn(bound,'spawned').mockImplementationOnce(()=>{throw new Error('identity write denied');});},'identity write denied');
  const child=()=>h.repos.execution.getResources(h.session.id).find(r=>r.kind==='process');
  await expect.poll(()=>child()?.observations.at(-1)?.state).toBe('gone');
  expect(child()?.identity).toBeUndefined();expect(child()?.stage).toBe('unknown');
  expect(h.repos.execution.getResources(h.session.id).find(r=>r.purpose==='acp_native_context')?.stage).toBe('pending');
 });
 it('freezes per-task overrides and resets omitted values to actual creation defaults',async()=>{
  const h=await setup();
  const request:TaskRequestV1={version:1,namespace:'runtime',sessionId:h.session.id,key:'override',actor:{kind:'unspecified'},prompt:'override',mode:'queue',skills:[],sources:[],sourcePayload:null,options:{model:'B',reasoningEffort:'high'}};
  expect((await h.runtime.send(h.session.id,'override','override',undefined,undefined,[],request)).status).toBe('completed');
  expect(JSON.parse(await readFile(join(h.dir,'native-state.json'),'utf8'))).toMatchObject({model:'B',effort:'high'});
  expect((await h.runtime.send(h.session.id,'defaults')).status).toBe('completed');
  expect(JSON.parse(await readFile(join(h.dir,'native-state.json'),'utf8'))).toMatchObject({model:'A',effort:'low'});
 });

 it('closes a crashed creator and recovers its file receipt without replacing the native session',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dutydeck-native-crash-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const child=spawn(process.execPath,['--conditions=development','--import','tsx',resolve('packages/agent-runtime/tests/fixtures/native-creation-crash.mts'),dir],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr?.on('data',data=>{stderr+=String(data);});
  const exited=once(child,'exit');cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  const [message]=await once(child,'message');expect(message).toEqual({phase:'native-file-saved'});await exited;expect(stderr).toBe('');
  const repos=createRepositories(join(dir,'db'),{newDatabaseAuthority:'ledger_v1'});const runtime=new DutydeckRuntime(repos,{cleanupIntervalMs:0});cleanup.push(async()=>{await runtime.shutdown();repos.close();});
  const agents=await repos.agents.list();await runtime.initialize(agents);const session=(await repos.sessions.list())[0];if(!session)throw new Error('Missing original Session');
  await expect.poll(async()=>{await runtime.probeNativeResources(session.id,{kind:'installation_owner',id:'installation_owner'});return repos.execution.getSessionResourceBlockers(session.id).length;}).toBe(0);
  const resources=repos.execution.getResources(session.id);expect(resources.some(r=>r.creationClosure?.evidence.state==='dead')).toBe(true);
  expect(repos.execution.getNativeContext(session.id)?.resource.nativeBindings).toBeUndefined();
  await runtime.resume(session.id);expect((await runtime.send(session.id,'after crash')).status).toBe('completed');
  const calls=(await readFile(join(dir,'native-calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {method:string});
  expect(calls.filter(c=>c.method==='session/new')).toHaveLength(1);expect(calls.filter(c=>c.method==='session/prompt')).toHaveLength(1);
 });

 it('creates an explicitly selected replacement while retaining the old unresolved Attempt',async()=>{
  const h=await setup();await writeFile(join(h.dir,'fail-prompt'),'1');const task=await h.runtime.send(h.session.id,'unknown');await rm(join(h.dir,'fail-prompt'));
  const native=h.repos.execution.getNativeContext(h.session.id)!;const old=h.repos.execution.getTaskExecution(task.id)!.currentAttempt!;
  await h.runtime.replaceNativeContext(h.session.id,{kind:'installation_owner',id:'installation_owner'},native.resource.resourceId,native.resource.revision,'explicit-replacement');
  const next=h.repos.execution.getNativeContext(h.session.id)!;
  expect(next.selection.context).not.toEqual(native.selection.context);expect(next.selection.revision).toBeGreaterThan(native.selection.revision);
  expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt).toEqual(old);
  expect(h.repos.execution.getResources(h.session.id).find(r=>r.resourceId===native.resource.resourceId)?.nativeReplacement?.decisionId).toBe('explicit-replacement');
  expect((await h.calls()).filter(c=>c.method==='session/new')).toHaveLength(2);expect((await h.calls()).filter(c=>c.method==='session/prompt')).toHaveLength(1);
 });
 it('clears old configuration uncertainty only after explicit replacement has proved new defaults',async()=>{
  const h=await setup();await writeFile(join(h.dir,'fail-config'),'1');await expect(h.runtime.setModel(h.session.id,'B')).rejects.toThrow();await rm(join(h.dir,'fail-config'));
  const native=h.repos.execution.getNativeContext(h.session.id)!;
  await h.runtime.replaceNativeContext(h.session.id,{kind:'installation_owner',id:'installation_owner'},native.resource.resourceId,native.resource.revision,'configuration-replacement');
  expect(await h.repos.config.get(`runtime_driver_configuration:${h.session.id}`)).toBe('');
  expect(h.repos.execution.getNativeContext(h.session.id)?.selection.context).not.toEqual(native.selection.context);
  expect((await h.calls()).filter(c=>c.method==='session/prompt')).toHaveLength(0);
  expect((await h.runtime.send(h.session.id,'new context')).status).toBe('completed');
 });

 it('does not treat a load response without configuration as proof of unchanged default options',async()=>{
  const h=await setup({native_load_no_config:'1'});
  const request:TaskRequestV1={version:1,namespace:'runtime',sessionId:h.session.id,key:'override-load',actor:{kind:'unspecified'},prompt:'override-load',mode:'queue',skills:[],sources:[],sourcePayload:null,options:{model:'B'}};
  expect((await h.runtime.send(h.session.id,'override-load','override-load',undefined,undefined,[],request)).status).toBe('completed');
  await h.runtime.stop(h.session.id);await h.runtime.resume(h.session.id);
  expect(JSON.parse(await readFile(join(h.dir,'native-state.json'),'utf8'))).toMatchObject({model:'A'});
  expect((await h.runtime.send(h.session.id,'default after load')).status).toBe('completed');
 });

});

describe('controlled factory failure cleanup',()=>{
 async function factorySetup(factory:DriverFactory,configure?:(bound:BoundExecutionRepository)=>void){
  const dir=await mkdtemp(join(tmpdir(),'dutydeck-factory-failure-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const repos=createRepositories(join(dir,'db'),{newDatabaseAuthority:'ledger_v1'});
  if(configure){const bind=repos.execution.bind.bind(repos.execution);vi.spyOn(repos.execution,'bind').mockImplementation(claim=>{const bound=bind(claim);configure(bound);return bound;});}
  factory.controlledResources=()=>true;
  const runtime=new DutydeckRuntime(repos,{driverFactory:factory,cleanupIntervalMs:0});
  cleanup.push(async()=>{await runtime.shutdown();repos.close();});
  const agent=agentConfigSchema.parse({id:'factory',name:'Factory',protocol:'pipe',command:process.execPath,cwd:dir,permissionMode:'ask',timeout:10,capabilities:{pause:false,resume:false}});
  await runtime.initialize([agent]);return {repos,runtime,agent};
 }
 function capturedChild(context:DriverContext){
  const permit=context.resources.beforeCreate(context.rootOperation,'process');context.resources.assertCreation(permit);
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  const exited=once(child,'exit');cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  context.resources.spawned(permit,child);return child;
 }
 it('closes a factory that throws before spawning without leaving a pending operation',async()=>{
  const h=await factorySetup(()=>{throw new Error('factory empty failure');});
  await expect(h.runtime.start({agentId:h.agent.id})).rejects.toThrow('factory empty failure');
  const session=(await h.repos.sessions.list())[0]!;
  expect(h.repos.execution.getResources(session.id)).toMatchObject([{kind:'operation',stage:'created'}]);
  expect(h.repos.execution.getSessionResourceBlockers(session.id)).toEqual([]);
 });
 it('waits for the captured original child to exit when the factory throws',async()=>{
  let child:ReturnType<typeof spawn>|undefined;
  const h=await factorySetup((_a,_p,_e,_x,_s,context)=>{child=capturedChild(context);throw new Error('factory after spawn');});
  await expect(h.runtime.start({agentId:h.agent.id})).rejects.toThrow('factory after spawn');
  expect(child).toBeDefined();expect(child!.exitCode!==null||child!.signalCode!==null).toBe(true);
  const session=(await h.repos.sessions.list())[0]!;
  expect(h.repos.execution.getSessionResourceBlockers(session.id)).toEqual([]);
  expect(h.repos.execution.getResources(session.id).find(r=>r.kind==='process')?.observations.at(-1)?.state).toBe('gone');
 });
 it('retains the child after a factory identity hook fails and records its real exit',async()=>{
  const h=await factorySetup((_a,_p,_e,_x,_s,context)=>{capturedChild(context);throw new Error('unreachable');},bound=>{
    vi.spyOn(bound,'spawned').mockImplementationOnce(()=>{throw new Error('factory identity failed');});
  });
  await expect(h.runtime.start({agentId:h.agent.id})).rejects.toThrow('factory identity failed');
  const session=(await h.repos.sessions.list())[0]!;
  expect(h.repos.execution.getResources(session.id).find(r=>r.kind==='process')).toMatchObject({stage:'unknown',observations:[{state:'gone'}]});
  expect(h.repos.execution.getSessionResourceBlockers(session.id)).toEqual([]);
 });
 it('keeps shutdown and the claim waiting for a nested factory tail while rejecting its late birth',async()=>{
  let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(yes=>{release=yes;}),entered=new Promise<void>(yes=>{enter=yes;});
  let tail:Promise<void>|undefined,lateError:unknown,spawned=0;
  const h=await factorySetup((_a,_p,_e,_x,_s,context)=>{
    const operation=context.resources.beginOperation(context.rootOperation);
    const permit=context.resources.beforeCreate(operation,'process');
    tail=(async()=>{try{enter();await gate;context.resources.assertCreation(permit);spawned++;}
      catch(error){lateError=error;}finally{context.resources.creationFinished(permit,'not_created');context.resources.creationFinished(operation,'created');}})();
    throw new Error('factory nested failure');
  });
  cleanup.push(async()=>{release();await tail;});
  let startDone=false,shutdownDone=false;
  const starting=h.runtime.start({agentId:h.agent.id}).catch(error=>error).finally(()=>{startDone=true;});
  await entered;const session=(await h.repos.sessions.list())[0]!;
  const shutting=h.runtime.shutdown().then(()=>{shutdownDone=true;});
  await new Promise<void>(yes=>setImmediate(yes));
  expect(startDone).toBe(false);expect(shutdownDone).toBe(false);
  expect(h.repos.execution.getResources(session.id).some(r=>r.kind==='operation'&&r.stage==='pending')).toBe(true);
  expect(()=>h.repos.control.attachRuntime('must-wait')).toThrow();
  release();await tail;await starting;await shutting;
  expect(lateError).toMatchObject({code:'RESOURCE_OWNER_REVOKED'});expect(spawned).toBe(0);
  expect(h.repos.execution.getSessionResourceBlockers(session.id)).toEqual([]);
  const claim=h.repos.control.attachRuntime('after-tail');claim.release();
 });
});
