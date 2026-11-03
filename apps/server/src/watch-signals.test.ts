import { createHash } from 'node:crypto';
import { larkConfirmActionId } from './lark/confirm-cards.js';
import { DutydeckWatch } from './watch.js';
import { createRepositories } from '@dutydeck/storage';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelMapping, MemoryJob, RepositoryBundle, Session, TaskRecord } from '@dutydeck/shared';
import type { StoredLarkConfig } from './lark/config.js';
import { collectWatchScopes, resolveWatchReceiver, WATCH_DISCONNECTED_MS, WATCH_QUEUED_MS, WATCH_UNKNOWN_MS, WATCH_SCHEDULE_OVERDUE_MS, WATCH_REPORT_MS, WATCH_INBOX_MS, WATCH_SCHEDULE_DISABLED_MS } from './watch-signals.js';

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
  const attempts = new Map<string,string>();
  const resources = new Map<string,unknown[]>();
  const repos = {
    config: { get: async (key: string) => values.get(key), set: mutations,
      list: async (prefix: string) => [...values].filter(([key]) => key.startsWith(prefix)).map(([key,value])=>({key,value})) },
    sessions: { list: async () => sessions, save: mutations },
    tasks: { get: async (id:string) => tasks.find(task=>task.id===id), listBySession: async (id:string) => tasks.filter(task => task.sessionId === id), save: mutations },
    channelMappings: { list: async () => mappings, save: mutations },
    execution: { getTaskExecution: (id: string) => ({ blockers: blockers.get(id) ?? [] }),
      getTaskExecutionState: (id: string) => {
        if (attempts.get(id) === 'legacy') throw new Error('EXECUTION_AUTHORITY_LEGACY');
        return attempts.has(id) ? { currentAttempt: { state: attempts.get(id) } } : undefined;
      },
      getResources: (id: string) => resources.get(id) ?? [] },
    memoryJobs: { listScope: async () => jobs, update: mutations }
  } as unknown as RepositoryBundle;
  return { values, sessions, tasks, mappings, jobs, mutations, blockers, attempts, resources, repos,
    collect: (bots: StoredLarkConfig[] = [bot], options: { listeningDisabled?:boolean; appId?: string; terminalAbsent?: (session: Session) => Promise<boolean> } = {}) => collectWatchScopes(repos,bots,{now,...options}) };
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

describe('watch report and intake integration signals', () => {
  it.each(['waiting', 'blocked'] as const)('reads only latest uncleared %s reports after 24h and recovers cleared reports', async status => {
    const h = fixture();
    const quiet = { ...bot, listening: false };
    h.tasks.push(task('reported', 'completed', WATCH_REPORT_MS + 10));
    const report = { schemaVersion: 1, taskId: 'reported', sessionId: session.id, status, question: '需要决定', summary: '需要权限', reportedAt: ago(WATCH_REPORT_MS) };
    h.values.set('task_report/reported', JSON.stringify(report));
    expect((await h.collect([quiet]))[0]?.signals).toEqual([]);
    h.values.set('task_report/reported', JSON.stringify({ ...report, reportedAt: ago(WATCH_REPORT_MS + 1) }));
    expect((await h.collect([quiet]))[0]?.signals).toEqual([expect.objectContaining({ kind: `task_report_${status}`, objectId: 'reported' })]);
    h.repos.config.set = async (key, value) => { h.values.set(key, value); };
    const watch = new DutydeckWatch({ store: h.repos.config, collect: () => h.collect([quiet]), send: vi.fn(), warn: vi.fn(), now: () => now });
    await watch.run();
    h.values.set('task_report/reported', JSON.stringify({ ...report, clearedAt: now.toISOString() }));
    await watch.run();
    const findings = [...h.values].filter(([key]) => key.startsWith('watch_findings/')).map(([, value]) => JSON.parse(value));
    expect(findings).toEqual([expect.objectContaining({ recoveredAt: now.toISOString() })]);
    for (const ended of ['ready', 'dropped']) {
      h.values.set('task_report/reported', JSON.stringify({ ...report, status: ended, reportedAt: ago(WATCH_REPORT_MS + 1) }));
      expect((await h.collect([quiet]))[0]?.signals).toEqual([]);
    }
    h.values.set('task_report/reported', JSON.stringify({ ...report, reportedAt: ago(WATCH_REPORT_MS + 1) }));
    h.tasks.push(task('newer', 'completed', 1));
    expect((await h.collect([quiet]))[0]?.signals).toEqual([]);
    expect((await h.collect([{ ...quiet, appId: 'cli_other' }], { appId: 'cli_other' }))[0]?.signals).toEqual([]);
  });

  it('warns on a report read failure and keeps collecting other sessions and signals', async () => {
    const h = fixture();
    h.tasks.push(task('unknown', 'reconcile_required', WATCH_UNKNOWN_MS + 2), task('unreadable', 'completed', 1));
    h.sessions.push({ ...session, id: 'other_session' });
    h.tasks.push({ ...task('other_report', 'completed', WATCH_REPORT_MS + 2), sessionId: 'other_session' });
    h.values.set('task_report/other_report', JSON.stringify({ schemaVersion: 1, taskId: 'other_report', sessionId: 'other_session',
      status: 'blocked', summary: '等待权限', reportedAt: ago(WATCH_REPORT_MS + 1) }));
    h.values.set('session_automation/schedule/' + schedule.id, JSON.stringify(schedule));
    const get = h.repos.config.get;
    h.repos.config.get = async key => {
      if (key === 'task_report/unreadable') throw new Error('report storage unavailable');
      return get(key);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await h.collect())[0]?.signals.map(signal => signal.kind)).toEqual(['result_unknown', 'task_report_blocked', 'schedule_overdue']);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'unreadable' }), expect.stringContaining('读取收尾报告失败'));
      expect(h.mutations).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('preserves repository order for same-millisecond latest reports and rejects another session report', async () => {
    const h = fixture();
    h.tasks.push(task('z_older', 'completed', WATCH_REPORT_MS + 2), task('a_latest', 'completed', WATCH_REPORT_MS + 2));
    const report = { schemaVersion: 1, taskId: 'a_latest', sessionId: session.id, status: 'waiting',
      question: '需要决定', reportedAt: ago(WATCH_REPORT_MS + 1) };
    h.values.set('task_report/a_latest', JSON.stringify(report));
    expect((await h.collect())[0]?.signals).toEqual([expect.objectContaining({ kind: 'task_report_waiting', objectId: 'a_latest' })]);
    h.values.set('task_report/a_latest', JSON.stringify({ ...report, sessionId: 'another_session' }));
    expect((await h.collect())[0]?.signals).toEqual([]);
  });

  it('scans every intake row without a 500-row query cap and excludes terminal, accepted and invalid records', async () => {
    const h = fixture();
    const receipt = (id: string, state: string, extra: Record<string, unknown> = {}, age = WATCH_INBOX_MS + 1) => ({
      appId: bot.appId, event: { messageId: id, chatId: 'oc_test' }, state, boot: '', receivedAt: ago(age), ...extra
    });
    const save = (id: string, state: string, extra: Record<string, unknown> = {}, age?: number) => h.values.set(`lark.inbox.${bot.appId}.${id}`, JSON.stringify(receipt(id, state, extra, age)));
    for (let n = 0; n < 501; n++) save(`decided_${n}`, 'ignored', { disposition: { schemaVersion: 1, reason: 'not_addressed' } });
    save('unrouted', 'unrouted'); save('received', 'received'); save('boundary', 'received', {}, WATCH_INBOX_MS);
    save('observes', 'ignored', { disposition: { schemaVersion: 1, reason: 'participation_observes' } });
    for (const reason of ['not_addressed', 'participation_silent', 'access_denied', 'command_rejected', 'participation_handled', 'backlog_expired']) {
      save(reason, 'ignored', { disposition: { schemaVersion: 1, reason } });
    }
    save('failed', 'failed', { disposition: { schemaVersion: 1, reason: 'context_failed' } });
    save('accepted', 'accepted'); save('task', 'received', { taskId: 'accepted_task' });
    save('invalid', 'ignored', { disposition: { schemaVersion: 1, reason: 'participation_observes', unexpected: true } });
    save('wrong_app', 'received', { appId: 'cli_other' }); save('invalid_time', 'received', { receivedAt: 'yesterday' });
    const before = new Map(h.values);
    expect((await h.collect())[0]?.signals.map(item => item.objectId)).toEqual(['unrouted', 'received', 'observes']);
    expect(h.values).toEqual(before); expect(h.mutations).not.toHaveBeenCalled();
  });

  it('marks intake findings recovered once an observed message has a decided silent outcome', async () => {
    const h = fixture();
    const key = 'lark.inbox.' + bot.appId + '.om_observed';
    const record = { appId: bot.appId, event: { messageId: 'om_observed', chatId: 'oc_test' }, state: 'ignored',
      receivedAt: ago(WATCH_INBOX_MS + 1), disposition: { schemaVersion: 1, reason: 'participation_observes' } };
    h.values.set(key, JSON.stringify(record));
    h.repos.config.set = async (name, value) => { h.values.set(name, value); };
    const watch = new DutydeckWatch({ store: h.repos.config, collect: () => h.collect([{ ...bot, listening: false }]), send: vi.fn(), warn: vi.fn(), now: () => now });
    await watch.run();
    h.values.set(key, JSON.stringify({ ...record, disposition: { schemaVersion: 1, reason: 'participation_silent' } }));
    await watch.run();
    expect([...h.values].filter(([name]) => name.startsWith('watch_findings/')).map(([, value]) => JSON.parse(value)))
      .toEqual([expect.objectContaining({ kind: 'inbox_backlog', recoveredAt: now.toISOString() })]);
  });

  it('checks the actual confirmation action and recovers cancelled, expired and completed waits', async () => {
    const h = fixture();
    const scope = { appId: bot.appId, chatId: 'oc_test' };
    const action = { kind: 'confirm.participation_act', status: 'intent', receipt: 'om_card', payload: { expiresAt: new Date(now.getTime() + 60_000).toISOString(), payload: { decisionId: 'decision' } } };
    const getAction = vi.fn(async () => action);
    h.repos.collaboration = { getAction } as any;
    h.values.set(`lark.inbox.${bot.appId}.om_pending`, JSON.stringify({ appId: bot.appId, event: { messageId: 'om_pending', chatId: scope.chatId }, state: 'ignored',
      receivedAt: ago(WATCH_INBOX_MS + 1), disposition: { schemaVersion: 1, reason: 'participation_confirmation', decisionId: 'decision' } }));
    expect((await h.collect())[0]?.signals).toEqual([expect.objectContaining({ kind: 'inbox_backlog', objectId: 'om_pending' })]);
    expect(getAction).toHaveBeenCalledWith(scope, larkConfirmActionId('participation_act', scope, 'om_pending'));
    for (const status of ['suppressed', 'succeeded', 'failed']) {
      action.status = status; expect((await h.collect())[0]?.signals).toEqual([]);
    }
    action.status = 'intent'; action.payload.expiresAt = now.toISOString();
    expect((await h.collect())[0]?.signals).toEqual([]);
    action.payload.expiresAt = new Date(now.getTime() + 60_000).toISOString(); action.payload.payload.decisionId = 'other';
    expect((await h.collect())[0]?.signals).toEqual([]);
  });

  it('reads a fresh occurrence task globally instead of guessing from its stopped source session', async () => {
    const h = fixture();
    h.sessions[0] = { ...session, state: 'stopped' };
    h.sessions.push({ ...session, id: 'fresh_child', source: 'schedule', sourceId: schedule.id });
    h.values.set(`session_automation/schedule/${schedule.id}`, JSON.stringify({ ...schedule, mode: 'fresh', executionSessionId: 'fresh_child',
      pendingOccurrence: { id: 'fresh_occ', generation: 1, scheduledForUtc: schedule.nextDueAt } }));
    const occurrence = { schemaVersion: 2, id: 'fresh_occ', revision: 1, scheduleId: schedule.id, sessionId: session.id, executionSessionId: 'fresh_child', generation: 1,
      scheduledForUtc: schedule.nextDueAt, conditionStatus: 'passed', runStatus: 'accepted', taskId: 'fresh_task', delivery: { status: 'not_requested', attempts: 0, updatedAt: ago(1) }, createdAt: ago(3600_000), updatedAt: ago(1) };
    h.values.set('session_automation/occurrence/fresh_occ', JSON.stringify(occurrence));
    h.tasks.push({ ...task('fresh_task', 'queued', 60_000), sessionId: 'fresh_child' });
    expect((await h.collect())[0]?.signals).toEqual([expect.objectContaining({ kind: 'schedule_overdue', objectId: schedule.id })]);
    h.tasks[0]!.status = 'running'; expect((await h.collect())[0]?.signals).toEqual([]);
    h.tasks[0]!.status = 'completed'; expect((await h.collect())[0]?.signals).toEqual([]);
    expect(h.mutations).not.toHaveBeenCalled();
  });
});


it.each(['web', undefined])('checks unscoped %s problems alongside configured bots without sending a direct message', async source => {
  const h = fixture(); h.sessions[0] = { ...session, source, sourceId: undefined };
  h.tasks.push(task('unknown', 'reconcile_required', WATCH_UNKNOWN_MS + 3));
  h.tasks.push(task('reported', 'completed', WATCH_REPORT_MS + 2));
  h.values.set('task_report/reported', JSON.stringify({ schemaVersion: 1, taskId: 'reported', sessionId: session.id,
    status: 'waiting', question: '需要决定', reportedAt: ago(WATCH_REPORT_MS + 1) }));
  h.values.set('session_automation/schedule/' + schedule.id, JSON.stringify(schedule));
  const scopes = await h.collect([bot]);
  expect(scopes.find(scope => scope.appId === 'web')).toMatchObject({ notify: false, signals: [
    expect.objectContaining({ kind: 'task_report_waiting' }), expect.objectContaining({ kind: 'result_unknown' }), expect.objectContaining({ kind: 'schedule_overdue' })
  ] });
  expect(scopes.find(scope => scope.appId === bot.appId)?.signals).toEqual([]);
  h.repos.config.set = async (key, value) => { h.values.set(key, value); };
  const send = vi.fn();
  await new DutydeckWatch({ store: h.repos.config, collect: () => h.collect([bot]), send, warn: vi.fn(), now: () => now }).run();
  expect(send).not.toHaveBeenCalled();
  expect([...h.values.keys()].filter(key => key.startsWith('watch_findings/web/'))).toHaveLength(3);
  expect((await h.collect([bot], { appId: bot.appId })).find(scope => scope.appId === 'web')).toBeUndefined();
});


describe('watch accuracy, receivers and runtime signals', () => {
  it('reports unknown results only while the current execution attempt is unsettled, and recovers settled ones', async () => {
    const h = fixture();
    h.tasks.push(task('settled', 'reconcile_required', WATCH_UNKNOWN_MS + 1), task('open', 'reconcile_required', WATCH_UNKNOWN_MS + 1),
      task('legacy', 'reconcile_required', WATCH_UNKNOWN_MS + 1));
    h.attempts.set('settled', 'settled'); h.attempts.set('open', 'reconcile_required'); h.attempts.set('legacy', 'legacy');
    expect((await h.collect())[0]?.signals.map(signal => signal.objectId)).toEqual(['open', 'legacy']);
    h.repos.config.set = async (key, value) => { h.values.set(key, value); };
    const watch = new DutydeckWatch({ store: h.repos.config, collect: () => h.collect([{ ...bot, listening: false }]), send: vi.fn(), warn: vi.fn(), now: () => now });
    await watch.run();
    h.attempts.set('open', 'settled');
    await watch.run();
    const findings = [...h.values].filter(([key]) => key.startsWith('watch_findings/')).map(([, value]) => JSON.parse(value));
    expect(findings.find(finding => finding.objectId === 'open')).toMatchObject({ kind: 'result_unknown', recoveredAt: now.toISOString() });
    expect(findings.find(finding => finding.objectId === 'legacy')?.recoveredAt).toBeUndefined();
  });

  it('does not count bot messages that group participation never judges as intake backlog', async () => {
    const h = fixture();
    const save = (id: string, senderType?: string) => h.values.set(`lark.inbox.${bot.appId}.${id}`, JSON.stringify({ appId: bot.appId,
      event: { messageId: id, chatId: 'oc_test', ...(senderType ? { senderType } : {}) }, state: 'ignored', receivedAt: ago(WATCH_INBOX_MS + 1),
      disposition: { schemaVersion: 1, reason: 'participation_observes' } }));
    save('human', 'user'); save('alert_bot', 'bot'); save('observe_only');
    h.values.set(`lark.inbox.${bot.appId}.observe_only`, JSON.stringify({ appId: bot.appId, event: { messageId: 'observe_only', chatId: 'oc_test' },
      state: 'ignored', receivedAt: ago(WATCH_INBOX_MS + 1), disposition: { schemaVersion: 1, reason: 'participation_observe_only' } }));
    expect((await h.collect())[0]?.signals.map(signal => signal.objectId)).toEqual(['human']);
  });

  it('falls back from the allowlist only to the app creator, never to a registered group member', async () => {
    const h = fixture();
    const open = { ...bot, allowedUsers: [] };
    expect(await resolveWatchReceiver(h.repos.config, open)).toBeUndefined();
    // 群授权会先登记发请求的人再判定（被拒也登记），登记不代表能管这个机器人。
    h.values.set('lark.principal.p_member', JSON.stringify({ appId: bot.appId, openId: 'ou_denied_member', name: 'ou_denied_member' }));
    expect(await resolveWatchReceiver(h.repos.config, open)).toBeUndefined();
    expect((await h.collect([open]))[0]?.ownerId).toBeUndefined();
    h.values.set('lark.app_creation.job_other', JSON.stringify({ id: 'job_other', appId: 'cli_other', status: 'completed' }));
    h.values.set('lark.app_creation_owner.job_other', JSON.stringify({ userId: 'u_other', tenantId: '1' }));
    h.values.set('lark.app_creation.job', JSON.stringify({ id: 'job', appId: bot.appId, status: 'completed' }));
    h.values.set('lark.app_creation_owner.job', JSON.stringify({ userId: '6796811306012770306', tenantId: '1' }));
    expect(await resolveWatchReceiver(h.repos.config, open)).toEqual({ id: '6796811306012770306', type: 'user_id' });
    expect((await h.collect([open]))[0]).toMatchObject({ ownerId: '6796811306012770306', ownerIdType: 'user_id' });
    expect((await h.collect())[0]).toMatchObject({ ownerId: 'ou_owner', ownerIdType: 'open_id' });
    expect(h.mutations).not.toHaveBeenCalled();
  });

  it('reports the latest schedule trigger error until a later trigger runs', async () => {
    const h = fixture();
    h.values.set('session_automation/schedule/' + schedule.id, JSON.stringify({ ...schedule, nextDueAt: new Date(now.getTime() + 3600_000).toISOString() }));
    const occurrence = (id: string, at: number, runStatus: string, extra: Record<string, unknown> = {}) => h.values.set('session_automation/occurrence/' + id, JSON.stringify({
      schemaVersion: 2, id, revision: 1, scheduleId: schedule.id, sessionId: session.id, generation: 1, scheduledForUtc: ago(at), conditionStatus: 'passed', runStatus,
      delivery: { status: 'not_requested', attempts: 0, updatedAt: ago(at) }, createdAt: ago(at), updatedAt: ago(at - 1000), ...extra }));
    occurrence('older_error', 2 * 86400_000, 'error', { error: 'old' });
    occurrence('ok', 86400_000, 'completed');
    expect((await h.collect())[0]?.signals).toEqual([]);
    occurrence('latest', 3600_000, 'error', { error: 'The session operation was revoked' });
    expect((await h.collect())[0]?.signals).toEqual([expect.objectContaining({ kind: 'schedule_error', objectId: schedule.id, since: ago(3600_000 - 1000),
      title: expect.stringContaining('出错') })]);
    h.values.set('session_automation/schedule/' + schedule.id, JSON.stringify({ ...schedule, enabled: false }));
    expect((await h.collect())[0]?.signals.some(signal => signal.kind === 'schedule_error')).toBe(false);
  });

  it('treats a fresh-session retry of the same trigger as the final result of that run', async () => {
    const h = fixture();
    h.values.set('session_automation/schedule/' + schedule.id, JSON.stringify({ ...schedule, nextDueAt: new Date(now.getTime() + 3600_000).toISOString() }));
    const occurrence = (id: string, runStatus: string) => h.values.set('session_automation/occurrence/' + id, JSON.stringify({
      schemaVersion: 2, id, revision: 1, scheduleId: schedule.id, sessionId: session.id, generation: 1, scheduledForUtc: ago(3600_000), conditionStatus: 'passed', runStatus,
      delivery: { status: 'not_requested', attempts: 0, updatedAt: ago(1) }, createdAt: ago(3600_000), updatedAt: ago(1) }));
    const original = 'occ_0000000000000000000000000000000000000000';
    occurrence(original, 'error');
    expect((await h.collect())[0]?.signals.map(signal => signal.kind)).toEqual(['schedule_error']);
    const retry = 'occ_retry_' + createHash('sha256').update(original).digest('hex');
    occurrence(retry, 'completed');
    expect((await h.collect())[0]?.signals).toEqual([]);
    occurrence(retry, 'error');
    expect((await h.collect())[0]?.signals.map(signal => signal.kind)).toEqual(['schedule_error']);
  });

  it('reports schedules that were never enabled 24 hours after creation', async () => {
    const h = fixture();
    const key = 'session_automation/schedule/' + schedule.id;
    const draft = { ...schedule, enabled: false, nextDueAt: undefined, createdAt: ago(WATCH_SCHEDULE_DISABLED_MS + 1) };
    h.values.set(key, JSON.stringify(draft));
    expect((await h.collect())[0]?.signals).toEqual([expect.objectContaining({ kind: 'schedule_never_enabled', objectId: schedule.id, since: draft.createdAt })]);
    for (const change of [{ createdAt: ago(WATCH_SCHEDULE_DISABLED_MS) }, { disabledAt: ago(60_000), disabledReason: 'session_ended' }, { deletedAt: ago(1) }]) {
      h.values.set(key, JSON.stringify({ ...draft, ...change })); expect((await h.collect())[0]?.signals).toEqual([]);
    }
    h.values.set(key, JSON.stringify(draft));
    h.values.set('session_automation/occurrence/ran', JSON.stringify({ schemaVersion: 2, id: 'ran', revision: 1, scheduleId: schedule.id, sessionId: session.id,
      generation: 1, scheduledForUtc: ago(86400_000), conditionStatus: 'passed', runStatus: 'completed', delivery: { status: 'not_requested', attempts: 0, updatedAt: ago(1) },
      createdAt: ago(86400_000), updatedAt: ago(1) }));
    expect((await h.collect())[0]?.signals).toEqual([]);
  });

  it('reports stop-blocked sessions and live terminal records whose terminal is gone, using only the read-only probe', async () => {
    const h = fixture();
    const terminal = { ...session, id: 'ses_terminal', protocol: 'pty-cli' } as Session;
    const blocked = { ...session, id: 'ses_blocked', protocol: 'pty-cli' } as Session;
    h.sessions.push(terminal, blocked);
    h.values.set('runtime_driver_stop_block:ses_blocked', JSON.stringify({ sessionId: 'ses_blocked', runId: 'run', reason: 'Driver physical resource exit is unverified' }));
    h.values.set('runtime_driver_stop_block:ses_cleared', '');
    const live = (sessionId: string, state = 'live') => ({ sessionId, runId: 'run', resourceId: `${sessionId}_pty`, kind: 'local_only', stage: 'created',
      identity: { identityId: 'id', kind: 'local_only', locator: {} }, observations: [{ observationId: 'o', state, evidenceRef: 'e', observedAt: ago(7200_000) }] });
    h.resources.set('ses_terminal', [live('ses_terminal')]);
    h.resources.set('ses_blocked', [live('ses_blocked')]);
    h.resources.set(session.id, [live(session.id, 'gone')]);
    const terminalAbsent = vi.fn(async (item: Session) => item.id !== session.id);
    const signals = (await h.collect([bot], { terminalAbsent }))[0]!.signals;
    expect(signals.map(signal => [signal.kind, signal.objectId])).toEqual([['terminal_missing', 'ses_terminal'], ['session_stop_blocked', 'ses_blocked']]);
    expect(terminalAbsent.mock.calls.map(([item]) => item.id)).toEqual(['ses_terminal']);
    expect((await h.collect([bot]))[0]!.signals.map(signal => signal.kind)).toEqual(['session_stop_blocked']);
    terminalAbsent.mockRejectedValueOnce(new Error('LEGACY_TMUX_PROBE_UNKNOWN'));
    expect((await h.collect([bot], { terminalAbsent }))[0]!.signals.map(signal => signal.kind)).toEqual(['session_stop_blocked']);
    expect(h.mutations).not.toHaveBeenCalled();
  });
});
