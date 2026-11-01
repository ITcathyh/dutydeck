import { DutydeckWatch } from './watch.js';
import { createRepositories } from '@dutydeck/storage';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelMapping, MemoryJob, RepositoryBundle, Session, TaskRecord } from '@dutydeck/shared';
import type { StoredLarkConfig } from './lark/config.js';
import { collectWatchScopes, WATCH_DISCONNECTED_MS, WATCH_QUEUED_MS, WATCH_UNKNOWN_MS, WATCH_SCHEDULE_OVERDUE_MS } from './watch-signals.js';

const now = new Date('2026-11-01T02:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const bot = { appId: 'cli_test', name: '测试机器人', allowedUsers: [{ openId: 'ou_owner', name: '所有者' }], listening: true, memoryEnabled: true } as StoredLarkConfig;
const session: Session = { id: 'ses_test', source: 'lark', sourceId: 'cli_test:oc_test:group', state: 'idle', agentId: 'agent', cwd: '/tmp', runId: 'run', createdAt: ago(1), updatedAt: ago(1) };
const schedule = { schemaVersion: 1, id: 'schedule_test', revision: 1, generation: 1, sessionId: session.id, name: '检查', prompt: '只读检查',
  trigger: { kind: 'interval', everySeconds: 60, anchorAt: ago(3600_000) }, timezone: 'Asia/Shanghai',
  dstPolicy: { gap: 'skip', overlap: 'first' }, condition: {kind:'always'}, enabled: true, nextDueAt: ago(WATCH_SCHEDULE_OVERDUE_MS+1), createdAt: ago(3600_000), updatedAt: ago(1) };
function fixture() {
  const values = new Map<string,string>([['lark.listener.status', JSON.stringify({pid:process.pid,updatedAt:now.toISOString(),active:[bot.appId],retrying:[],reconnecting:[]})]]);
  const sessions = [session];
  const tasks: TaskRecord[] = [];
  const mappings: ChannelMapping[] = [];
  const jobs: MemoryJob[] = [];
  const mutations = vi.fn();
  const blockers = new Map<string,Array<{code:string}>>();
  const repos = {
    config: { get: async (key: string) => values.get(key), set: mutations,
      list: async (prefix: string) => [...values].filter(([key]) => key.startsWith(prefix)).map(([key,value])=>({key,value})) },
    sessions: { list: async () => sessions, save: mutations },
    tasks: { get: async (id:string) => tasks.find(task=>task.id===id), listBySession: async (id:string) => tasks.filter(task => task.sessionId === id), save: mutations },
    channelMappings: { list: async () => mappings, save: mutations },
    execution: { getTaskExecution: (id: string) => ({ blockers: blockers.get(id) ?? [] }) },
    memoryJobs: { listScope: async () => jobs, update: mutations }
  } as unknown as RepositoryBundle;
  return { values, sessions, tasks, mappings, jobs, mutations, blockers, repos,
    collect: (bots: StoredLarkConfig[] = [bot], options: { listeningDisabled?:boolean; appId?: string } = {}) => collectWatchScopes(repos,bots,{now,...options}) };
}
const task = (id:string,status:string,age:number): TaskRecord => ({id, sessionId:session.id,prompt:'检查',status,createdAt:ago(age),updatedAt:ago(age)});
const card = (overrides:Record<string,unknown>={}): ChannelMapping => ({id:'map',channel:'lark-card:cli_test',externalId:'om_card',sessionId:session.id,createdAt:ago(3600_000),
  extra:JSON.stringify({app_id:bot.appId,chat_id:'oc_test',task_name:'检查',state:'completed',started_at:now.getTime()-3600_000,final_delivery_state:'failed',...overrides})});

describe('watch existing health signals', () => {
  it('is healthy without issues and performs no writes', async () => {
    const h=fixture(); expect((await h.collect())[0]?.signals).toEqual([]);
    expect(h.mutations).not.toHaveBeenCalled();
  });
  it('checks long-connection thresholds and sustained exponential reconnect failures', async () => {
    const h=fixture();
    const status = (reconnecting: unknown[],retrying:unknown[]=[]) => h.values.set('lark.listener.status',JSON.stringify({pid:process.pid,updatedAt:now.toISOString(),active:[],reconnecting,retrying}));
    status([{appId:bot.appId,since:ago(WATCH_DISCONNECTED_MS)}]); expect((await h.collect())[0]?.signals).toEqual([]);
    status([{appId:bot.appId,since:ago(WATCH_DISCONNECTED_MS+1)}]); expect((await h.collect())[0]?.signals[0]?.kind).toBe('lark_connection');
    status([],[{appId:bot.appId,failedAt:ago(1),nextRetryAt:new Date(now.getTime()+30_000-1).toISOString()}]);
    expect((await h.collect())[0]?.signals).toEqual([]);
    status([],[{appId:bot.appId,failedAt:ago(1),nextRetryAt:new Date(now.getTime()+60_000-1).toISOString()}]);
    expect((await h.collect())[0]?.signals[0]?.title).toContain('持续重连失败');
  });
  it('reports absent or stale-process listener proof, but disabled listeners do not raise connection alerts', async () => {
    const h=fixture(); h.values.delete('lark.listener.status');
    expect((await h.collect())[0]?.signals[0]?.kind).toBe('lark_connection');
    expect((await h.collect([bot],{listeningDisabled:true}))[0]?.signals).toEqual([]);
    expect((await h.collect([{...bot,listening:false}]))[0]?.signals).toEqual([]);
  });
  it('reports unconfirmed failed/retrying deliveries and clears them once success is confirmed', async () => {
    const h=fixture(); h.mappings.push(card());
    expect((await h.collect())[0]?.signals).toEqual([expect.objectContaining({kind:'result_delivery',objectId:'om_card',since:now.toISOString()})]);
    h.mappings[0]=card({final_delivery_state:undefined,final_delivery_attempts:2,final_delivery_first_failed_at:now.getTime()-60_000});
    expect((await h.collect())[0]?.signals[0]?.since).toBe(ago(60_000));
    h.mappings[0]=card({final_delivery_state:'delivered'}); expect((await h.collect())[0]?.signals).toEqual([]);
  });
  it('counts only old queued tasks with current workspace blockers and old unknown results', async () => {
    const h=fixture(); h.tasks.push(task('blocked','queued',WATCH_QUEUED_MS+1),task('ordinary','queued',WATCH_QUEUED_MS+1),
      task('young','queued',WATCH_QUEUED_MS),task('unknown','reconcile_required',WATCH_UNKNOWN_MS+1),task('recent','reconcile_required',WATCH_UNKNOWN_MS));
    h.blockers.set('blocked',[{code:'WORKSPACE_EXECUTION_BUSY'}]); h.blockers.set('young',[{code:'WORKSPACE_EXECUTION_BUSY'}]);
    const signals=(await h.collect())[0]!.signals;
    expect(signals.map(f=>f.objectId)).toEqual(['blocked','unknown']);
    expect(signals[0]?.location).toContain('openChatId=oc_test'); expect(h.mutations).not.toHaveBeenCalled();
  });
  it('checks Web tasks without direct messages and isolates a selected bot', async () => {
    const h=fixture(); h.sessions[0]={...session,source:'web',sourceId:undefined};
    h.tasks.push(task('unknown','reconcile_required',WATCH_UNKNOWN_MS+1));
    const scopes=await h.collect([]);
    expect(scopes[0]).toMatchObject({appId:'web',notify:false,signals:[expect.objectContaining({kind:'result_unknown'})]});
    expect((await h.collect([bot,{...bot,appId:'cli_other'}],{appId:'cli_other'})).map(scope=>scope.appId)).toEqual(['cli_other']);
  });
  it('reports due schedules and excludes disabled, deleted, future and running/terminal reservations', async () => {
    const h=fixture(); const key='session_automation/schedule/schedule_test';
    h.values.set(key,JSON.stringify(schedule)); expect((await h.collect())[0]?.signals[0]?.kind).toBe('schedule_overdue');
    for (const change of [{enabled:false},{deletedAt:ago(1)},{nextDueAt:ago(WATCH_SCHEDULE_OVERDUE_MS)},{nextDueAt:new Date(now.getTime()+1).toISOString()}]) {
      h.values.set(key,JSON.stringify({...schedule,...change})); expect((await h.collect())[0]?.signals).toEqual([]);
    }
    h.values.set(key,JSON.stringify({...schedule,pendingOccurrence:{id:'occ',generation:1,scheduledForUtc:ago(WATCH_SCHEDULE_OVERDUE_MS+1)}}));
    for (const runStatus of ['completed','failed','interrupted','skipped']) {
      h.values.set('session_automation/occurrence/occ',JSON.stringify({schemaVersion:1,id:'occ',revision:1,scheduleId:schedule.id,sessionId:session.id,generation:1,scheduledForUtc:ago(WATCH_SCHEDULE_OVERDUE_MS+1),
        conditionStatus:'passed',runStatus,delivery:{status:'not_requested',attempts:0,updatedAt:ago(1)},createdAt:ago(60_000),updatedAt:ago(1)}));
      expect((await h.collect())[0]?.signals,runStatus).toEqual([]);
    }
  });
  it('counts an overdue accepted queued schedule, but excludes started and completed tasks', async () => {
    const h=fixture(); const key='session_automation/schedule/schedule_test';
    h.values.set(key,JSON.stringify({...schedule,pendingOccurrence:{id:'occ',generation:1,scheduledForUtc:ago(WATCH_SCHEDULE_OVERDUE_MS+1)}}));
    const occurrence={schemaVersion:1,id:'occ',revision:1,scheduleId:schedule.id,sessionId:session.id,generation:1,scheduledForUtc:ago(WATCH_SCHEDULE_OVERDUE_MS+1),
      conditionStatus:'passed',runStatus:'accepted',taskId:'scheduled_task',delivery:{status:'not_requested',attempts:0,updatedAt:ago(1)},createdAt:ago(3600_000),updatedAt:ago(1)};
    h.values.set('session_automation/occurrence/occ',JSON.stringify(occurrence));
    h.tasks.push(task('scheduled_task','queued',60_000));
    expect((await h.collect())[0]?.signals[0]?.kind).toBe('schedule_overdue');
    h.tasks[0]={...h.tasks[0]!,status:'running'};
    expect((await h.collect())[0]?.signals).toEqual([]);
    h.tasks[0]={...h.tasks[0]!,status:'queued'};
    h.values.set('session_automation/occurrence/occ',JSON.stringify({...occurrence,taskStartedAt:ago(60_000)}));
    expect((await h.collect())[0]?.signals).toEqual([]);
  });
  it('reports repeated memory job failures and stops after a successful job', async () => {
    const h=fixture(); h.values.set('lark.memory.state.cli_test.groups',JSON.stringify({v:1,turnsSinceExtraction:0,turnsSinceConsolidation:0,lastFailureAt:{extraction:ago(60_000)}}));
    const job = (id:string,state:'failed'|'settled') => ({id,state,kind:'extraction',scope:{appId:bot.appId,pool:'groups'}} as MemoryJob);
    h.jobs.push(job('one','failed')); expect((await h.collect())[0]?.signals).toEqual([]);
    h.jobs.push(job('two','failed')); expect((await h.collect())[0]?.signals[0]).toMatchObject({kind:'memory_failures',since:ago(60_000)});
    h.jobs.push({...job('three','settled'),state:'applied',receipt:{appliedJobId:'three',consumedTaskIds:[],result:{},appliedAt:now.toISOString()}});
    expect((await h.collect())[0]?.signals).toEqual([]);
    h.jobs[2]=job('three','settled'); expect((await h.collect())[0]?.signals).toEqual([]);
  });
  it('reuses doctor memory backlog criteria, skipping manual extraction and migrated pools', async () => {
    const h=fixture(); h.values.set('lark.memory.state.cli_test.groups',JSON.stringify({v:1,pendingTurns:Array.from({length:20},()=>({senderKind:'human'}))}));
    expect((await h.collect())[0]?.signals.some(f=>f.kind==='memory_stalled')).toBe(true);
    expect((await h.collect([{...bot,memoryAutoExtract:false}]))[0]?.signals).toEqual([]);
    h.values.set('lark.memory.state.cli_test.groups',JSON.stringify({migratedTo:'other',pendingTurns:Array.from({length:20},()=>({senderKind:'human'}))}));
    expect((await h.collect())[0]?.signals).toEqual([]);
  });
  it('uses existing configured owner identity and never substitutes a chat or bot as owner', async () => {
    const h=fixture();
    expect((await h.collect([{...bot,allowedUsers:[{openId:'on_owner',name:'owner'}]}]))[0]?.ownerId).toBe('on_owner');
    expect((await h.collect([{...bot,allowedUsers:[{openId:'oc_chat',name:'chat'}]}]))[0]?.ownerId).toBeUndefined();
  });
});



it('collects real persisted config, schedule and mapping samples without changing their contents', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const claim = repos.control.attachRuntime('watch-test');
  try {
    repos.execution.bind(claim).createSession(session);
    await repos.config.set('lark.listener.status', JSON.stringify({pid:process.pid,updatedAt:now.toISOString(),active:[bot.appId],retrying:[],reconnecting:[]}));
    await repos.config.set('session_automation/schedule/schedule_test',JSON.stringify(schedule));
    await repos.channelMappings.save(card());
    const before = await repos.config.list!('');
    const mappingsBefore = await repos.channelMappings.list('lark-card:cli_test');
    const scopes = await collectWatchScopes(repos,[bot],{now});
    expect(scopes[0]?.signals.map(f=>f.kind)).toEqual(['result_delivery','schedule_overdue']);
    expect(await repos.config.list!('')).toEqual(before);
    expect(await repos.channelMappings.list('lark-card:cli_test')).toEqual(mappingsBefore);
  } finally { claim.release(); repos.close(); }
});


it('silently recovers deleted bots while a bot-scoped process does not touch other scopes', async () => {
  const h=fixture();
  h.values.set('lark.listener.status',JSON.stringify({pid:process.pid,updatedAt:now.toISOString(),active:[],retrying:[],reconnecting:[{appId:bot.appId,since:ago(WATCH_DISCONNECTED_MS+1)}]}));
  h.repos.config.set=async (key,value)=>{h.values.set(key,value);};
  const send=vi.fn();
  let bots=[bot];
  const watch=new DutydeckWatch({store:h.repos.config,collect:()=>h.collect(bots),send,warn:vi.fn(),now:()=>now});
  await watch.run(); expect(send).toHaveBeenCalledTimes(1);
  bots=[]; await watch.run();
  const values=[...h.values.entries()].filter(([key])=>key.startsWith('watch_findings/cli_test/')&&!key.endsWith('/notification')).map(([,value])=>JSON.parse(value));
  expect(values).toHaveLength(1); expect(values[0].recoveredAt).toBe(now.toISOString());
  expect(send).toHaveBeenCalledTimes(1);
  expect((await h.collect([],{appId:'cli_other'})).map(scope=>scope.appId)).toEqual(['cli_other']);
});

it('uses the configured workbench link and the bot brand for chat links', async () => {
  const h=fixture();h.tasks.push(task('unknown','reconcile_required',WATCH_UNKNOWN_MS+1));
  expect((await h.collect([{...bot,webBaseUrl:'https://console.example.test/'}]))[0]?.signals[0]?.location).toBe('https://console.example.test/sessions/ses_test');
  expect((await h.collect([{...bot,brand:'lark'}]))[0]?.signals[0]?.location).toContain('applink.larksuite.com');
});


it('attributes native scheduled execution tasks to an explicitly scoped bot and links its workbench', async () => {
  const h=fixture();h.sessions[0]={...session,source:'schedule',sourceId:'schedule_test'};
  h.tasks.push(task('unknown','reconcile_required',WATCH_UNKNOWN_MS+1));
  const scopes=await h.collect([{...bot,webBaseUrl:'https://console.example.test'}],{appId:bot.appId});
  expect(scopes[0]).toMatchObject({appId:bot.appId,signals:[expect.objectContaining({kind:'result_unknown',location:'https://console.example.test/sessions/ses_test'})]});
});
