import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { agentConfigSchema } from '@dutydeck/shared';
import { LarkMemoryStore } from './memory.js';
import { LarkMemoryProjection } from './memory-view.js';
import { LarkMemoryPipeline } from './memory-pipeline.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const scope = { appId: 'app', chatId: 'groups', pool: 'groups' };
async function harness(mode: 'legacy' | 'optimized' = 'optimized', maxInputChars = 1000000) {
  const dir = await mkdtemp(join(tmpdir(), 'memory-jobs-'));
  const repos = createRepositories(join(dir, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  let reply = (_prompt: string) => ({ actions: [{ op: 'noop' }] });
  let duringSend = async () => {};
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0, workspaceRoot: join(dir,'work'), probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (_config,_protocol,emit) => ({ start: async () => {}, stop: async () => {}, isStopped: async () => true, interrupt: async () => {}, send: async prompt => {
    prompts.push(prompt); await duringSend(); emit({ type: 'text', data: { text: '```json\n'+JSON.stringify(reply(prompt))+'\n```' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
  } }) });
  await runtime.initialize([agentConfigSchema.parse({ id: 'agent', name: 'Agent', command: 'fake', protocol: 'acp', cwd: dir, model: 'verified-model', reasoningEffort: 'medium' })]);
  const config = { appId: 'app', memoryEnabled: true, memoryAutoExtract: false, defaultAgentId: 'agent' } as any;
  await repos.config.set('lark.bots', JSON.stringify([config]));
  await repos.config.set('token_efficiency', JSON.stringify({ mode, memoryProfiles: [{ agentId: 'agent', protocol: 'acp', model: 'verified-model', reasoningEffort: 'medium', maxInputChars, verificationRef: 'test_fixture_only' }] }));
  const store = new LarkMemoryStore(repos.config);
  const projection = new LarkMemoryProjection(store, join(dir,'memory'));
  const pipeline = new LarkMemoryPipeline({ runtime, repos: { execution: repos.execution }, jobs: repos.memoryJobs, policyConfig: repos.config, controlActorId: 'installation_owner', store, projection, readConfig: async () => JSON.parse((await repos.config.get('lark.bots'))!)[0], log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  cleanups.push(async () => { await runtime.shutdown(); repos.close(); await rm(dir,{ recursive: true, force: true }); });
  await store.add(scope, { content: '保留完整来源和日期。', source: 'extraction', topic: 'general', chatId: 'other', taskId: 'evidence' });
  return { repos, runtime, store, projection, pipeline, prompts, setReply: (value: typeof reply) => { reply = value; }, setDuringSend: (value: typeof duringSend) => { duringSend = value; } };
}
it.each(['legacy','optimized'] as const)('%s jobs apply noop receipts and choose their frozen session lifecycle', async mode => {
  const h = await harness(mode);
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok: true });
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok: true });
  const jobs = await h.repos.memoryJobs.listScope(scope);
  expect(jobs).toHaveLength(2);
  expect(jobs.every(job => job.state === 'settled' && job.receipt?.appliedJobId === job.id)).toBe(true);
  expect(new Set(jobs.map(job => job.sessionId)).size).toBe(mode === 'legacy' ? 1 : 2);
  expect(h.prompts).toHaveLength(2);
  if (mode === 'optimized') { expect(h.prompts[0]).toContain('"chatId":"other"'); expect(h.prompts[0].split('保留完整来源和日期。')).toHaveLength(2); }
});
it('uses compatibility before dispatch when the verified input range is insufficient', async () => {
  const h = await harness('optimized',1);
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok: true });
  expect((await h.repos.memoryJobs.listScope(scope))[0]).toMatchObject({ mode: 'compatible', compatibilityReason: 'input_outside_verified_range' });
});
it.each(['ignore','authorization'] as const)('refuses a completed result after %s changes', async kind => {
  const h = await harness();
  const entry = (await h.store.list(scope))[0]!;
  h.setReply(() => ({ actions: [{ op: 'retire', id: entry.id }] } as any));
  h.setDuringSend(async () => { if (kind === 'ignore') await h.store.addIgnoreRule(scope,{ text:'禁止环境事实' }); else await h.repos.config.set('lark.bots','[]'); });
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:false, error: kind === 'ignore' ? 'MEMORY_CONCURRENT_CHANGE' : 'MEMORY_DISABLED' });
  expect((await h.store.list(scope)).map(item => item.id)).toContain(entry.id);
  expect((await h.repos.memoryJobs.listScope(scope))[0].receipt).toBeUndefined();
});
it('rebuilds projection after commit without invoking the model or applying twice', async () => {
  const h = await harness();
  const write = vi.spyOn(h.projection,'writeVerified').mockResolvedValueOnce(false);
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error:'MEMORY_PROJECTION_FAILED' });
  const applied = (await h.repos.memoryJobs.listScope(scope))[0]; expect(applied.state).toBe('applied');
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:true });
  expect(h.prompts).toHaveLength(1); expect(write).toHaveBeenCalledTimes(2);
  expect((await h.repos.memoryJobs.listScope(scope))[0].state).toBe('settled');
});
it('recovers uncertain dispatch by looking up the same accepted request', async () => {
  const h = await harness();
  const original = h.runtime.dispatch.bind(h.runtime);
  vi.spyOn(h.runtime,'dispatch').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('reply lost'); });
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:false });
  await vi.waitFor(async () => expect((await h.runtime.getTasks((await h.repos.memoryJobs.listScope(scope))[0].sessionId))[0].status).toBe('completed'));
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:true });
  expect(h.prompts).toHaveLength(1);
});
it('recovers a lost startup reply using the same session', async () => {
  const h = await harness();
  const original = h.runtime.startMemorySession.bind(h.runtime);
  vi.spyOn(h.runtime,'startMemorySession').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('start reply lost'); });
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:false });
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:true });
  expect((await h.runtime.listSessions()).filter(session => session.source === 'lark-memory')).toHaveLength(1);
  expect(h.prompts).toHaveLength(1);
});
it('reattaches the full snapshot and candidate actions for the second correction', async () => {
  const h = await harness(); let round = 0;
  h.setReply(() => ++round === 1 ? ({ actions:[{ op:'retire',id:'invalid' }] } as any) : { actions:[{ op:'noop' }] });
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:true });
  expect(h.prompts).toHaveLength(2); expect(h.prompts[1]).toContain('上一版候选动作'); expect(h.prompts[1]).toContain('保留完整来源和日期。');
  expect((await h.repos.memoryJobs.listScope(scope))[0].requests).toHaveLength(2);
});
it.each(['legacy','optimized'] as const)('%s extraction consumes only frozen readable turns and protects them from queue trimming', async mode => {
  const h = await harness(mode);
  const userSession = await h.runtime.start({ agentId:'agent' });
  const source = await h.runtime.send(userSession.id,'团队固定使用中文。');
  h.prompts.length = 0;
  await h.store.updateState(scope,{ pendingTurns:[{ sessionId:userSession.id, taskId:source.id, completedAt:new Date().toISOString(), senderKind:'human', senderId:'person', sourceMessageId:'message' }], turnsSinceExtraction:1 });
  h.setReply(() => ({ facts:[{ content:'团队用中文交流。',topic:'general',evidence:source.id }] } as any));
  h.setDuringSend(async () => {
    for (let index=0; index<30; index++) await h.pipeline.onTurnCompleted(scope,{ sessionId:userSession.id,taskId:`new_${index}`,senderKind:'human' });
    expect((await h.store.getState(scope)).pendingTurns?.some(turn => turn.taskId === source.id)).toBe(true);
  });
  expect(await h.pipeline.runExtraction(scope)).toMatchObject({ ok:true,added:1 });
  expect((await h.store.list(scope)).some(entry => entry.taskId === source.id)).toBe(true);
  const state = await h.store.getState(scope);
  expect(state.pendingTurns?.map(turn => turn.taskId)).toEqual(Array.from({ length:24 },(_,index) => `new_${index+6}`));
  expect(state.turnsSinceExtraction).toBe(24);
  expect((await h.repos.memoryJobs.listScope(scope))[0].receipt?.consumedTaskIds).toEqual([source.id]);
  await h.pipeline.onTurnCompleted(scope,{ sessionId:userSession.id,taskId:source.id,senderKind:'human' });
  expect((await h.store.getState(scope)).pendingTurns?.map(turn => turn.taskId)).not.toContain(source.id);
  expect((await h.store.getState(scope)).turnsSinceExtraction).toBe(24);
});
it('preserves unreadable pending inputs and creates no pretend successful job', async () => {
  const h = await harness();
  await h.store.updateState(scope,{ pendingTurns:[{ sessionId:'missing',taskId:'missing',completedAt:new Date().toISOString() }],turnsSinceExtraction:1 });
  expect(await h.pipeline.runExtraction(scope)).toMatchObject({ ok:false,error:'MEMORY_RESULT_UNAVAILABLE' });
  expect((await h.store.getState(scope)).pendingTurns?.map(turn => turn.taskId)).toEqual(['missing']);
  expect(await h.repos.memoryJobs.listScope(scope)).toEqual([]);
});
it('requires the explicitly supplied installation owner and does not derive it from job scope', async () => {
  const h = await harness();
  (h.pipeline as any).options.controlActorId = undefined;
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:false,error:'MEMORY_ACTOR_REQUIRED' });
  expect(await h.repos.memoryJobs.listScope(scope)).toEqual([]);
  expect(h.prompts).toHaveLength(0);
});
it('blocks migration when an old session has unknown execution', async () => {
  const h = await harness();
  const old = await h.runtime.start({ agentId:'agent',source:'lark-memory',sourceId:'app:groups:memory',permissionMode:'deny-all' });
  vi.spyOn(h.runtime,'getSessionTaskRecovery').mockImplementation(async id => id === old.id ? [{ taskId:'unknown',status:'reconcile_required',blockers:[] }] as any : []);
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:false,error:'MEMORY_RECOVERY_REQUIRED' });
  expect(await h.repos.memoryJobs.listScope(scope)).toEqual([]);
  expect(h.prompts).toHaveLength(0);
});
it('startup recovery finishes a committed receipt without any due counter', async () => {
  const h = await harness();
  vi.spyOn(h.projection,'writeVerified').mockResolvedValueOnce(false);
  await h.pipeline.runConsolidation(scope);
  expect((await h.store.getState(scope)).turnsSinceConsolidation).toBe(0);
  await h.pipeline.recoverJobs(scope.appId);
  expect((await h.repos.memoryJobs.listScope(scope))[0].state).toBe('settled');
  expect(h.prompts).toHaveLength(1);
});
it.each([{ protocol:'pty-cli' },{ reasoningEffort:'high' },{ model:'unmatched' }])('uses compatibility for an unverified actual model/adapter profile: %j', async patch => {
  const h = await harness();
  await h.repos.config.set('token_efficiency',JSON.stringify({ mode:'optimized',memoryProfiles:[{ agentId:'agent',protocol:'acp',model:'verified-model',reasoningEffort:'medium',maxInputChars:1000000,verificationRef:'test_fixture_only',...patch }] }));
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:true });
  expect((await h.repos.memoryJobs.listScope(scope))[0]).toMatchObject({ mode:'compatible',compatibilityReason:'unverified_capacity' });
});
it('does not repeat rejected credentials in the correction prompt', async () => {
  const h = await harness(); const entry = (await h.store.list(scope))[0]!; let round=0;
  h.setReply(() => ++round === 1 ? ({ actions:[{ op:'update',id:entry.id,content:'token: sk-live-AbCdEfGh12345678901234567890' }] } as any) : { actions:[{ op:'noop' }] });
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:true });
  expect(h.prompts).toHaveLength(2);
  expect(h.prompts[1]).not.toContain('sk-live-AbCdEfGh12345678901234567890');
  expect(h.prompts[1]).toContain('[疑似凭据已移除]');
});
it('freezes the prompt policy version across a global policy change and a correction', async () => {
  const h = await harness(); let round=0;
  h.setReply(() => ++round === 1 ? ({ actions:[{ op:'retire',id:'invalid' }] } as any) : { actions:[{ op:'noop' }] });
  h.setDuringSend(async () => { await h.repos.config.set('token_efficiency',JSON.stringify({ mode:'legacy',memoryProfiles:[] })); });
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:true });
  const job = (await h.repos.memoryJobs.listScope(scope))[0];
  expect((job.input as any).promptPolicyVersion).toBe('optimized-v1');
  expect(job.requests.map(request => (request.sourcePayload as any).promptPolicyVersion)).toEqual(['optimized-v1','optimized-v1']);
  expect(job.mode).toBe('isolated');
});
it.each(['model','reasoningEffort'] as const)('uses compatibility when the actual %s is an unbound CLI default', async field => {
  const h = await harness();
  const agent = (await h.repos.agents.get('agent'))!;
  await h.repos.agents.save({ ...agent, [field]: undefined });
  const profile = { agentId:'agent',protocol:'acp',model:'verified-model',reasoningEffort:'medium',maxInputChars:1000000,verificationRef:'test_fixture_only', [field]:undefined };
  await h.repos.config.set('token_efficiency',JSON.stringify({ mode:'optimized',memoryProfiles:[profile] }));
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:true });
  expect((await h.repos.memoryJobs.listScope(scope))[0]).toMatchObject({ mode:'compatible',compatibilityReason:'unresolved_model_configuration' });
});
it('does not enqueue a consumed completion when apply commits after the early receipt read', async () => {
  const h = await harness();
  const userSession = await h.runtime.start({ agentId:'agent' });
  const source = await h.runtime.send(userSession.id,'团队固定使用中文。');
  await h.store.updateState(scope,{ pendingTurns:[{ sessionId:userSession.id,taskId:source.id,completedAt:new Date().toISOString(),senderKind:'human' }],turnsSinceExtraction:1 });
  h.setReply(() => ({ facts:[{ content:'团队用中文交流。',topic:'general',evidence:source.id }] } as any));
  let allowSend!: () => void;
  let running!: () => void;
  const allowed = new Promise<void>(resolve => { allowSend=resolve; });
  const started = new Promise<void>(resolve => { running=resolve; });
  h.setDuringSend(async () => { running(); await allowed; });
  const extraction = h.pipeline.runExtraction(scope);
  await started;
  const read = h.repos.memoryJobs.isConsumed.bind(h.repos.memoryJobs);
  vi.spyOn(h.repos.memoryJobs,'isConsumed').mockImplementationOnce(async (target,taskId) => {
    const consumedBeforeApply = await read(target,taskId);
    expect(consumedBeforeApply).toBe(false);
    allowSend();
    expect(await extraction).toMatchObject({ ok:true,added:1 });
    return consumedBeforeApply;
  });
  await h.pipeline.onTurnCompleted(scope,{ sessionId:userSession.id,taskId:source.id,senderKind:'human' });
  expect(await read(scope,source.id)).toBe(true);
  expect((await h.store.getState(scope)).pendingTurns).toEqual([]);
  expect((await h.store.getState(scope)).turnsSinceExtraction).toBe(0);
});
it.each([true,false])('handles old completed extraction with an unreconciled running claim: %s', async legacyRunning => {
  const h = await harness();
  const userSession = await h.runtime.start({ agentId:'agent' });
  const source = await h.runtime.send(userSession.id,'团队固定使用中文。');
  h.setReply(() => ({ facts:[{ content:'团队用中文交流。',topic:'general',evidence:source.id }] } as any));
  const oldSession = await h.runtime.start({ agentId:'agent',source:'lark-memory',sourceId:'app:groups:memory',permissionMode:'deny-all' });
  const oldTask = await h.runtime.send(oldSession.id,'旧后台提取');
  expect(oldTask.status).toBe('completed');
  await h.store.add(scope,{ content:'团队用中文交流。',topic:'general',source:'extraction',taskId:source.id,sessionId:oldSession.id });
  await h.store.updateState(scope,{ pendingTurns:[{ sessionId:userSession.id,taskId:source.id,completedAt:new Date().toISOString(),senderKind:'human' }],turnsSinceExtraction:1,
    running: legacyRunning ? { kind:'extraction',sessionId:oldSession.id,token:'legacy-claim',startedAt:'2000-01-01T00:00:00.000Z' } : undefined });
  h.prompts.length=0;
  const before = await h.store.getState(scope);
  if (legacyRunning) {
    await expect(h.pipeline.runExtraction(scope)).rejects.toMatchObject({ code:'MEMORY_RECOVERY_REQUIRED' });
    expect(await h.store.getState(scope)).toEqual(before);
    expect(await h.repos.memoryJobs.listScope(scope)).toEqual([]);
    expect(h.prompts).toHaveLength(0);
  } else {
    expect(await h.pipeline.runExtraction(scope)).toMatchObject({ ok:true });
    expect((await h.store.getState(scope)).pendingTurns).toEqual([]);
    expect(h.prompts).toHaveLength(1);
    expect((await h.repos.memoryJobs.listScope(scope))[0].receipt?.consumedTaskIds).toEqual([source.id]);
  }
});

it('recognizes the recovered receipt claim after settling crashes before releasing running', async () => {
  const h = await harness();
  vi.spyOn(h.projection,'writeVerified').mockResolvedValueOnce(false);
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ error:'MEMORY_PROJECTION_FAILED' });
  const applied = (await h.repos.memoryJobs.listScope(scope))[0];
  expect(applied.state).toBe('applied');
  // Leave the real SQLite running marker as if the process exited after settlement.
  vi.spyOn(h.pipeline as any,'release').mockResolvedValueOnce(undefined);
  await h.pipeline.recoverJobs(scope.appId);
  const settled = (await h.repos.memoryJobs.listScope(scope))[0];
  const running = (await h.store.getState(scope)).running!;
  expect(settled.state).toBe('settled');
  expect(running.token).not.toBe(applied.claimToken);
  expect(settled.claimToken).toBe(running.token);
  expect(settled.receipt).toEqual(applied.receipt);
  expect(await h.repos.memoryJobs.hasClaim(scope,running.token)).toBe(true);
  expect(h.prompts).toHaveLength(1);
  await h.store.updateState(scope,{ running:{ ...running,owner:undefined,startedAt:'2000-01-01T00:00:00Z' } });
  expect(await h.pipeline.runConsolidation(scope)).toMatchObject({ ok:true });
  expect((await h.store.getState(scope)).running).toBeUndefined();
  expect(await h.repos.memoryJobs.listScope(scope)).toHaveLength(2);
  expect(h.prompts).toHaveLength(2);
});
