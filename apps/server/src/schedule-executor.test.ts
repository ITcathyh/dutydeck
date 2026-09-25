import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories, scheduleWriterLeaseKey } from '@dutydeck/storage';
import { withMigrationTransaction } from '../../../packages/storage/src/migrations.js';
import { createScheduleExecutionSchema } from '../../../packages/storage/src/schedule-execution-migration.js';
import { CollaborationService, collaborationContextSignature, scheduleMatchesMandate } from './collaboration-service.js';
import { ScheduleExecutor, type ScheduleExecutorOptions } from './schedule-executor.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });
const scope = { appId: 'app', chatId: 'chat' };
async function fixture(initialNow = new Date()) {
  const directory = mkdtempSync(join(tmpdir(), 'collaboration-scheduler-')), path = join(directory, 'state.db');
  const repos = createRepositories(path);
  const db = new Database(path); withMigrationTransaction(db, () => createScheduleExecutionSchema(db)); db.close();
  let clock = initialNow, allowed = true;
  const now = () => clock;
  await repos.secretRefs.create({ id: 'secret', kind: 'generic', provider: 'keychain', referenceKey: 'test', status: 'configured' });
  await repos.channelBots.create({ id: 'bot', channel: 'lark', externalAppId: 'app', displayName: 'Bot', brand: 'feishu', credentialRef: 'secret', state: 'staged' });
  const authorize = vi.fn(async (_scope: typeof scope, actor: string) => allowed && actor === 'requester');
  const service = new CollaborationService({ repositories: repos, authorize, now, resolveScheduleScope: async () => ({ channelBotId: 'bot', identityRef: 'identity', secretRef: 'secret' }) });
  const deliver = vi.fn(async input => { await input.assertCurrent(); return { receipt: 'message-one' }; });
  const instances: ScheduleExecutor[] = [];
  const executor = (options: Partial<ScheduleExecutorOptions> = {}) => {
    const instance = new ScheduleExecutor({ repositories: repos, service, authorize, deliver, now, holderId: 'writer', ...options }); instances.push(instance); return instance;
  };
  cleanup.push(async () => { await Promise.allSettled(instances.map(instance => instance.close())); repos.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = { id: 'delegation', goal: 'Follow the document', mode: 'notify' as const, prompt: 'Please share the remaining material', trigger: { kind: 'interval' as const, everySeconds: 60, anchorAt: clock.toISOString() }, timezone: 'UTC' };
  return { repos, service, executor, deliver, authorize, input, now, path, deny() { allowed = false; }, advance(ms = 60_000) { clock = new Date(clock.getTime() + ms); }, create: (extra = {}) => service.createMandate(scope, 'requester', { ...input, ...extra }) };
}

it('delivers a persisted delegation once per occurrence without creating a follow-up or requiring a live parent session', async () => {
  const f = await fixture(); const { mandate } = await f.create();
  const run = f.executor(); await run.tick(); expect(f.deliver).not.toHaveBeenCalled();
  f.advance(); await Promise.all([run.tick(), run.tick()]); await run.tick();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(await f.repos.collaboration.listFollowups(scope)).toEqual([]);
  expect(await f.repos.scheduleOccurrences.listByDefinition(mandate.scheduleDefinitionId)).toEqual([expect.objectContaining({ state: 'settled' })]);
  expect(await f.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ status: 'active' });
});

it('enforces stable create inputs, chat scope, mandate ownership and stale revisions', async () => {
  const f = await fixture(); const created = await f.create();
  expect((await f.create()).mandate.id).toBe(created.mandate.id);
  await expect(f.create({ prompt: 'Different request' })).rejects.toMatchObject({ statusCode: 409 });
  await expect(f.create({ id: 'foreign', delivery: { mode: 'chat', chatRef: 'other', continuation: 'chat_root' } })).rejects.toMatchObject({ code: 'COLLABORATION_DESTINATION_CONFLICT' });
  await expect(f.create({ id: 'thread', delivery: { mode: 'thread', chatRef: 'chat', rootMessageRef: 'unverified', continuation: 'same_thread' } })).rejects.toMatchObject({ code: 'COLLABORATION_DESTINATION_CONFLICT' });
  await expect(f.service.updateMandate(scope, 'other', created.mandate.id, { expectedRevision: 1, status: 'cancelled' })).rejects.toMatchObject({ statusCode: 403 });
  await f.service.updateMandate(scope, 'requester', created.mandate.id, { expectedRevision: 1, deliveryPaused: true });
  await expect(f.service.updateMandate(scope, 'requester', created.mandate.id, { expectedRevision: 1, status: 'cancelled' })).rejects.toMatchObject({ code: 'COLLABORATION_REVISION_CONFLICT' });
});

it('creates a future one-off, executes once and accepts its original create retry after it is due', async () => {
  const f = await fixture(new Date('2026-09-20T05:30:00.000Z'));
  const input = { trigger: { kind: 'at', localDateTime: '2026-09-20T13:31:00' }, timezone: 'Asia/Shanghai' };
  const { mandate, schedule } = await f.create(input);
  expect(schedule?.state).toBe('enabled');
  expect(await f.repos.scheduleWatermarks.get(mandate.scheduleDefinitionId)).toMatchObject({ nextDueAt: '2026-09-20T05:31:00.000Z' });
  f.advance();
  expect((await f.create(input)).mandate).toEqual(mandate);
  await f.executor().tick();
  expect(f.deliver).toHaveBeenCalledOnce();
  expect((await f.create(input)).mandate).toEqual(mandate);
  await f.executor().tick(); expect(f.deliver).toHaveBeenCalledOnce();
  const paused = await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, status: 'paused' });
  expect(paused.mandate.status).toBe('paused');
  const cancelled = await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 2, status: 'cancelled' });
  expect(cancelled.mandate.status).toBe('cancelled');
});

it.each(['13:29:59', '13:30:00'])('rejects a new one-off at %s with no persisted command or schedule', async time => {
  const f = await fixture(new Date('2026-09-20T05:30:00.000Z'));
  await expect(f.create({ trigger: { kind: 'at', localDateTime: `2026-09-20T${time}` }, timezone: 'Asia/Shanghai' }))
    .rejects.toMatchObject({ code: 'COLLABORATION_SCHEDULE_TIME_PASSED', statusCode: 400, message: expect.stringContaining('计划未创建。请选择未来的执行时间') });
  expect(await f.repos.collaboration.listMandates(scope)).toEqual([]);
  expect(await f.repos.scheduleDefinitions.list()).toEqual([]);
  expect(await f.repos.collaboration.listActions(scope)).toEqual([]);
});

it.each(['scope', 'delivery', 'execute'])('rechecks a new one-off after async %s validation consumed its remaining time', async stage => {
  const f = await fixture(new Date('2026-09-20T05:30:00.000Z'));
  const input = { trigger: { kind: 'at', localDateTime: '2026-09-20T05:31:00' } };
  if (stage === 'scope') {
    const original = f.service.options.resolveScheduleScope;
    f.service.options.resolveScheduleScope = async scope => { f.advance(120_000); return original(scope); };
  } else if (stage === 'delivery') {
    f.service.options.validateDelivery = async () => { f.advance(120_000); return true; };
  } else {
    f.service.options.authorize = async (_scope, _actor, action) => { if (action === 'execute') f.advance(120_000); return true; };
  }
  await expect(f.create({ ...input, ...(stage === 'delivery' ? { delivery: { mode: 'thread', chatRef: 'chat', rootMessageRef: 'om_root', continuation: 'same_thread' } } : {}) }))
    .rejects.toMatchObject({ code: 'COLLABORATION_SCHEDULE_TIME_PASSED', statusCode: 400 });
  expect(await f.repos.collaboration.listMandates(scope)).toEqual([]);
  expect(await f.repos.scheduleDefinitions.list()).toEqual([]);
  expect(await f.repos.collaboration.listActions(scope)).toEqual([]);
});

it.each(['trigger', 'timezone'])('rejects an expired one-off %s update without changing the original plan', async field => {
  const f = await fixture(new Date('2026-09-20T05:30:00.000Z'));
  const { mandate } = await f.create({ trigger: { kind: 'at', localDateTime: '2026-09-20T05:31:00' } });
  const schedule = await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId);
  const watermark = await f.repos.scheduleWatermarks.get(mandate.scheduleDefinitionId);
  const actions = await f.repos.collaboration.listActions(scope);
  const patch = field === 'trigger' ? { trigger: { kind: 'at', localDateTime: '2026-09-20T05:29:59' } } : { timezone: 'Asia/Shanghai' };
  await expect(f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, ...patch }))
    .rejects.toMatchObject({ code: 'COLLABORATION_SCHEDULE_TIME_PASSED', statusCode: 400, message: expect.stringContaining('计划未改期。请选择未来的执行时间') });
  expect(await f.repos.collaboration.getMandate(scope, mandate.id)).toEqual(mandate);
  expect(await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId)).toEqual(schedule);
  expect(await f.repos.scheduleWatermarks.get(mandate.scheduleDefinitionId)).toEqual(watermark);
  expect(await f.repos.collaboration.listActions(scope)).toEqual(actions);
});

it.each(['create', 'update'])('preserves the accepted one-off instant when %s activation authorization crosses it', async operation => {
  const f = await fixture(new Date('2026-09-20T05:30:00.000Z'));
  const existing = operation === 'update' ? await f.create() : undefined;
  let checks = 0;
  f.service.options.authorize = async (_scope, _actor, action) => {
    if (action === 'execute' && ++checks === 2) f.advance(120_000);
    return true;
  };
  const trigger = { kind: 'at', localDateTime: '2026-09-20T05:31:00' };
  const result = existing
    ? await f.service.updateMandate(scope, 'requester', existing.mandate.id, { expectedRevision: 1, trigger })
    : await f.create({ trigger });
  expect(checks).toBe(2);
  expect(result.schedule?.state).toBe('enabled');
  expect(await f.repos.scheduleWatermarks.get(result.mandate.scheduleDefinitionId)).toMatchObject({ nextDueAt: '2026-09-20T05:31:00.000Z' });
  await f.executor().tick(); expect(f.deliver).toHaveBeenCalledOnce();
  expect(await f.repos.scheduleOccurrences.listByDefinition(result.mandate.scheduleDefinitionId)).toEqual([expect.objectContaining({ scheduledForUtc: '2026-09-20T05:31:00.000Z', state: 'settled' })]);
});

it('leaves the original plan unchanged when rescheduling authorization outlasts a future one-off', async () => {
  const f = await fixture(new Date('2026-09-20T05:30:00.000Z'));
  const { mandate, schedule } = await f.create();
  const actions = await f.repos.collaboration.listActions(scope);
  f.service.options.authorize = async (_scope, _actor, action) => { if (action === 'execute') f.advance(120_000); return true; };
  await expect(f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, trigger: { kind: 'at', localDateTime: '2026-09-20T05:31:00' } }))
    .rejects.toMatchObject({ code: 'COLLABORATION_SCHEDULE_TIME_PASSED' });
  expect(await f.repos.collaboration.getMandate(scope, mandate.id)).toEqual(mandate);
  expect(await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId)).toEqual(schedule);
  expect(await f.repos.collaboration.listActions(scope)).toEqual(actions);
});

it('recovers a crash after mandate commit using the prepared reschedule and rejects an old request afterwards', async () => {
  const f = await fixture(); const { mandate } = await f.create();
  const original = f.repos.scheduleDefinitions.update.bind(f.repos.scheduleDefinitions);
  const spy = vi.spyOn(f.repos.scheduleDefinitions, 'update').mockImplementation(async (id, patch) => {
    if (patch.state === 'enabled') throw new Error('crash before activation');
    return original(id, patch);
  });
  const trigger = { kind: 'interval', everySeconds: 600, anchorAt: f.now().toISOString() };
  await expect(f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, trigger })).rejects.toThrow('crash');
  expect(await f.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ revision: 2 });
  expect(await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId)).toMatchObject({ state: 'disabled', trigger });
  spy.mockRestore(); await f.executor().tick();
  expect(await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId)).toMatchObject({ state: 'enabled', trigger });
  await expect(f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, trigger: f.input.trigger })).rejects.toMatchObject({ code: 'COLLABORATION_REVISION_CONFLICT' });
  f.advance(); await f.executor().tick(); expect(f.deliver).not.toHaveBeenCalled();
});

it('keeps a pre-commit cancellation crash disabled until the same request is retried', async () => {
  const f = await fixture(); const { mandate } = await f.create();
  const spy = vi.spyOn(f.repos.collaboration, 'updateMandate').mockRejectedValueOnce(new Error('commit failed'));
  await expect(f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, status: 'cancelled' })).rejects.toThrow('commit failed');
  spy.mockRestore(); f.advance(); await f.executor().tick(); expect(f.deliver).not.toHaveBeenCalled();
  expect(await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId)).toMatchObject({ state: 'disabled' });
  await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, status: 'cancelled' });
  f.advance(); await f.executor().tick(); expect(f.deliver).not.toHaveBeenCalled();
  expect(await f.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ status: 'cancelled' });
});

it('does not resend an unknown delivery after restart; a receipt query settles it', async () => {
  const f = await fixture(); await f.create();
  f.deliver.mockRejectedValueOnce(new Error('response lost after send'));
  const first = f.executor(); f.advance(); await first.tick(); first.close();
  const restarted = f.executor({ holderId: 'new-writer' }); f.advance(61_000); await restarted.tick();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_delivery')).toMatchObject({ status: 'unknown' });
  restarted.close(); f.advance(61_000);
  const reconcile = vi.fn(async () => ({ status: 'succeeded' as const, receipt: 'message-one' }));
  await f.executor({ holderId: 'third-writer', reconcile }).tick();
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.id.includes('delivery'))).toMatchObject({ status: 'succeeded' });
});

it('resumes the same pending Agent action and sends its persisted result once', async () => {
  const f = await fixture(); await f.create({ mode: 'agent' });
  const executeAgent = vi.fn(async input => { await input.assertCurrent(); return input.resume ? { status: 'completed' as const, text: 'Only the remaining section is missing', receipt: 'task-one' } : { status: 'pending' as const, receipt: 'task-one' }; });
  const run = f.executor({ executeAgent }); f.advance(); await run.tick();
  expect(f.deliver).not.toHaveBeenCalled();
  await run.tick(); await run.tick();
  expect(executeAgent).toHaveBeenCalledTimes(2);
  expect(executeAgent.mock.calls[0]![0].actionId).toBe(executeAgent.mock.calls[1]![0].actionId);
  expect(executeAgent.mock.calls[1]![0].resume).toBe(true);
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.deliver.mock.calls[0]![0].text).toBe('Only the remaining section is missing');
});

it('keeps unchanged unknown occurrences stable and reconciles the same Agent once its result settles', async () => {
  const f = await fixture(new Date('2026-09-20T05:30:00.000Z'));
  const { mandate } = await f.create({ mode: 'agent', trigger: { kind: 'at', localDateTime: '2026-09-20T05:31:00' } });
  let completed = false;
  const executeAgent = vi.fn(async input => {
    await input.assertCurrent();
    return completed ? { status: 'completed' as const, text: 'Original result', receipt: 'task-one' }
      : { status: 'unknown' as const, receipt: 'task-one', error: 'reconcile_required' };
  });
  const first = f.executor({ executeAgent }); f.advance(); await first.tick();
  const [before] = await f.repos.scheduleOccurrences.listByDefinition(mandate.scheduleDefinitionId);
  const watermark = await f.repos.scheduleWatermarks.get(mandate.scheduleDefinitionId);
  expect(before?.state).toBe('unknown');
  await first.tick(); await first.tick();
  expect(await f.repos.scheduleOccurrences.get(before!.id)).toEqual(before);
  expect(await f.repos.scheduleWatermarks.get(mandate.scheduleDefinitionId)).toEqual(watermark);
  expect(f.deliver).not.toHaveBeenCalled();
  await first.close(); f.advance(61_000);
  const resumed = f.executor({ executeAgent, holderId: 'next-writer' }); await resumed.tick();
  expect(await f.repos.scheduleOccurrences.get(before!.id)).toEqual(before);
  completed = true; await resumed.tick(); await resumed.tick();
  expect(f.deliver).toHaveBeenCalledOnce();
  expect(await f.repos.scheduleOccurrences.get(before!.id)).toMatchObject({ state: 'settled' });
  expect(new Set(executeAgent.mock.calls.map(([input]) => input.actionId)).size).toBe(1);
  expect(executeAgent.mock.calls.filter(([input]) => !input.resume)).toHaveLength(1);
});

it('cancels the old pending Agent after delegation cancellation and suppresses its result', async () => {
  const f = await fixture(); const { mandate } = await f.create({ mode: 'agent' });
  const executeAgent = vi.fn(async () => ({ status: 'pending' as const, receipt: 'task-one' })), cancelAgent = vi.fn(async () => {});
  const run = f.executor({ executeAgent, cancelAgent }); f.advance(); await run.tick();
  await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, status: 'cancelled' });
  await run.tick(); expect(cancelAgent).toHaveBeenCalledTimes(1);
  expect(executeAgent).toHaveBeenCalledTimes(1); expect(f.deliver).not.toHaveBeenCalled();
});

it.each(['cancelled', 'paused'] as const)('never acquires or renews the writer lease for a %s mandate without in-flight occurrences', async status => {
  const f = await fixture(); const { mandate } = await f.create();
  await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, status });
  f.advance(61_000);
  const run = f.executor();
  await run.tick(); await run.tick(); await run.tick();
  const db = new Database(f.path, { readonly: true });
  expect((db.prepare('SELECT count(*) AS cnt FROM schedule_leases').get() as { cnt: number }).cnt).toBe(0);
  expect((db.prepare("SELECT count(*) AS cnt FROM schedule_entity_versions WHERE entity_kind = 'schedule_lease'").get() as { cnt: number }).cnt).toBe(0);
  db.close();
  expect(f.deliver).not.toHaveBeenCalled();
});

it('renews the held lease across ticks without appending schedule_lease version rows', async () => {
  const f = await fixture(); await f.create();
  const run = f.executor(); f.advance(); await run.tick();
  const leaseKey = scheduleWriterLeaseKey('bot');
  const afterAcquire = await f.repos.scheduleLeases.getByKey(leaseKey);
  expect(afterAcquire?.revision).toBe(1);
  await run.tick(); await run.tick();
  // 后续 tick 持续续租（revision 增长），但版本表只保留首次 acquire 一行。
  const afterRenewals = await f.repos.scheduleLeases.getByKey(leaseKey);
  expect(afterRenewals!.revision).toBeGreaterThan(1);
  const db = new Database(f.path, { readonly: true });
  expect((db.prepare("SELECT count(*) AS cnt FROM schedule_entity_versions WHERE entity_kind = 'schedule_lease'").get() as { cnt: number }).cnt).toBe(1);
  db.close();
});

it('delivers the frozen scheduled summary when an unrelated follow-up is added during analysis', async () => {
  const f = await fixture(); await f.create({ mode: 'agent' });
  let completed = false;
  const run = f.executor({ executeAgent: async () => completed ? { status: 'completed', text: 'Old summary' } : { status: 'pending' } });
  f.advance(); await run.tick();
  await f.service.createFollowup(scope, 'requester', { id: 'new', goal: 'New information' }); completed = true;
  await run.tick(); await run.tick(); expect(f.deliver).toHaveBeenCalledOnce();
  expect(f.deliver.mock.calls[0]![0].snapshot.followups).toEqual([]);
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_delivery')).toMatchObject({ status: 'succeeded' });
});

it.each(['human', 'bot'] as const)('delivers the original scheduled summary after %s messages roll the observation window and bootstrap cursor', async senderKind => {
  const f = await fixture();
  await f.repos.collaboration.saveBootstrap({ scope, status: 'complete', missing: [], lastEventAt: f.now().toISOString(), updatedAt: f.now().toISOString() });
  await f.repos.collaboration.observe({ scope, source: 'lark.message', eventId: 'original', occurredAt: f.now().toISOString(), receivedAt: f.now().toISOString(), senderKind: 'human', text: 'ATLAS recovered after three timeouts', refs: [], origin: 'live', missing: [] });
  await f.create({ mode: 'agent' });
  let completed = false;
  const executeAgent = vi.fn(async (input: Parameters<NonNullable<ScheduleExecutorOptions['executeAgent']>>[0]) => {
    await input.assertCurrent(); return completed ? { status: 'completed' as const, text: 'ATLAS recovered after three timeouts' } : { status: 'pending' as const };
  });
  const run = f.executor({ executeAgent }); f.advance(); await run.tick();
  const frozen = executeAgent.mock.calls[0]![0].snapshot;
  for (let index = 0; index < 31; index++) await f.repos.collaboration.observe({ scope, source: 'lark.message', eventId: `appended-${index}`, occurredAt: f.now().toISOString(), receivedAt: f.now().toISOString(), senderKind, ...(senderKind === 'bot' ? { senderId: scope.appId } : {}), text: senderKind === 'bot' ? 'Confirm this operation' : 'Another group discussion', refs: [], origin: senderKind === 'bot' ? 'history' : 'live', missing: [] });
  await f.repos.collaboration.saveBootstrap({ scope, status: 'complete', missing: [], lastEventAt: f.now().toISOString(), updatedAt: f.now().toISOString() });
  expect((await f.repos.collaboration.snapshot(scope)).observations.some(item => item.eventId === 'original')).toBe(false);
  completed = true; await run.tick(); await run.tick();
  expect(executeAgent).toHaveBeenCalledTimes(2); expect(f.deliver).toHaveBeenCalledOnce();
  expect(executeAgent.mock.calls[1]![0].snapshot).toEqual(frozen);
  expect(f.deliver.mock.calls[0]![0].snapshot).toEqual(frozen);
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_delivery')).toMatchObject({ status: 'succeeded' });
});

it.each(['execute', 'deliver', 'completed', 'progress', 'paused', 'deliveryPaused', 'notificationsPaused', 'reschedule'] as const)('still suppresses scheduled output on %s changes even when ordinary chat also advances', async change => {
  const f = await fixture();
  const { followup } = await f.service.createFollowup(scope, 'requester', { id: 'tracked', goal: 'Finish the material' });
  const { mandate } = await f.create({ mode: 'agent', followupId: followup.id, condition: 'followup_open' });
  let completed = false, revoked = false;
  const run = f.executor({ authorize: async (_scope, _actor, action) => !(revoked && action === change), cancelAgent: async () => {}, executeAgent: async () => completed ? { status: 'completed', text: 'Do not send' } : { status: 'pending' } });
  f.advance(); await run.tick();
  await f.repos.collaboration.observe({ scope, source: 'lark.message', eventId: 'new-chat', occurredAt: f.now().toISOString(), receivedAt: f.now().toISOString(), senderKind: 'human', text: 'Unrelated discussion', refs: [], origin: 'live', missing: [] });
  if (change === 'execute' || change === 'deliver') revoked = true;
  else if (change === 'completed') await f.service.updateFollowup(scope, 'requester', followup.id, { expectedRevision: 1, status: 'completed' });
  else if (change === 'progress') await f.service.updateFollowup(scope, 'requester', followup.id, { expectedRevision: 1, progress: 'First part completed' });
  else if (change === 'notificationsPaused') await f.service.updateSettings(scope, 'requester', { expectedRevision: 0, notificationsPaused: true });
  else await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, ...(change === 'paused' ? { status: 'paused' } : change === 'deliveryPaused' ? { deliveryPaused: true } : { trigger: { kind: 'interval', everySeconds: 600, anchorAt: f.now().toISOString() } }) });
  completed = true; await run.tick();
  expect(f.deliver).not.toHaveBeenCalled();
  expect(await f.repos.scheduleOccurrences.listByDefinition(mandate.scheduleDefinitionId)).toEqual([expect.objectContaining({ state: 'suppressed' })]);
});

it('checks original history coverage even when model input truncation adds its own missing markers', async () => {
  const f = await fixture();
  await f.repos.collaboration.saveBootstrap({ scope, status: 'complete', missing: [], updatedAt: f.now().toISOString() });
  await f.repos.collaboration.observe({ scope, source: 'lark.message', eventId: 'large-message', occurredAt: f.now().toISOString(), receivedAt: f.now().toISOString(), senderKind: 'human', text: 'x'.repeat(12_000), refs: [], origin: 'live', missing: [] });
  await f.create({ mode: 'agent' });
  const executeAgent = vi.fn(async () => ({ status: 'completed' as const, text: 'Bounded summary' }));
  f.advance(); await f.executor({ executeAgent }).tick();
  expect(f.deliver).toHaveBeenCalledOnce();
  expect(f.deliver.mock.calls[0]![0].snapshot.bootstrap?.status).toBe('partial');
  const actions = await f.repos.collaboration.listActions(scope);
  expect(actions.find(action => action.kind === 'schedule_delivery')!.payload.coverageSignature).toBe(actions.find(action => action.kind === 'schedule_agent')!.payload.coverageSignature);
});

it('honors progress, group notification pause, authorization and bounded downtime catch-up', async () => {
  const f = await fixture();
  const { followup } = await f.service.createFollowup(scope, 'requester', { id: 'doc', goal: 'Submit two sections', steps: [{ id: 'a', label: 'First', status: 'open' }, { id: 'b', label: 'Second', status: 'open' }] });
  await f.create({ followupId: followup.id, condition: 'no_progress' });
  await f.service.updateFollowup(scope, 'requester', followup.id, { expectedRevision: 1, steps: [{ id: 'a', label: 'First', status: 'done' }, { id: 'b', label: 'Second', status: 'open' }] });
  const run = f.executor(); f.advance(3600_000); await run.tick(); expect(f.deliver).not.toHaveBeenCalled();
  expect(await f.repos.collaboration.getFollowup(scope, followup.id)).toMatchObject({ status: 'open', steps: [expect.objectContaining({ status: 'done' }), expect.objectContaining({ status: 'open' })] });
  await f.service.updateFollowup(scope, 'requester', followup.id, { expectedRevision: 2, status: 'completed' });
  await f.create({ id: 'summary' }); f.advance(3600_000); await run.tick(); expect(f.deliver).toHaveBeenCalledTimes(1);
  await f.service.updateSettings(scope, 'requester', { expectedRevision: 0, notificationsPaused: true });
  f.advance(); await run.tick(); expect(f.deliver).toHaveBeenCalledTimes(1);
  await f.service.updateSettings(scope, 'requester', { expectedRevision: 1, notificationsPaused: false });
  f.deny(); f.advance(); await run.tick(); expect(f.deliver).toHaveBeenCalledTimes(1);
});


it('binds follow-up provenance to the trusted entry point and includes it in create idempotency', async () => {
  const f = await fixture();
  const body = { id: 'inferred', goal: 'Possibly remaining work' };
  expect((await f.service.createFollowup(scope, 'requester', body, 'inferred')).followup.provenance).toBe('inferred');
  await expect(f.service.createFollowup(scope, 'requester', { ...body, provenance: 'confirmed' }, 'inferred')).rejects.toThrow();
  await expect(f.service.createFollowup(scope, 'requester', body, 'confirmed')).rejects.toMatchObject({ statusCode: 409 });
  expect((await f.service.createFollowup(scope, 'requester', body, 'inferred')).followup.revision).toBe(1);
});

it('restarts the no-progress window after partial progress and subsequently reminds about remaining work', async () => {
  const f = await fixture();
  const { followup } = await f.service.createFollowup(scope, 'requester', { id: 'doc', goal: 'Finish document' });
  const { mandate } = await f.create({ followupId: followup.id, condition: 'no_progress' });
  await f.service.updateFollowup(scope, 'requester', followup.id, { expectedRevision: 1, progress: 'First section complete' });
  const run = f.executor(); f.advance(); await run.tick();
  expect(f.deliver).not.toHaveBeenCalled();
  expect(await f.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ revision: 2, lastProgressRevision: 2 });
  f.advance(); await run.tick(); expect(f.deliver).toHaveBeenCalledTimes(1);
});

it('uses one live writer and resumes an Agent across lease takeover without replacing its action', async () => {
  const f = await fixture(); await f.create({ mode: 'agent', trigger: { kind: 'interval', everySeconds: 600, anchorAt: f.now().toISOString() } });
  const executeAgent = vi.fn(async input => input.resume ? { status: 'completed' as const, text: 'x'.repeat(9000) } : { status: 'pending' as const });
  const first = f.executor({ executeAgent }), other = f.executor({ executeAgent, holderId: 'other' });
  f.advance(600_000); await first.tick(); await other.tick(); expect(executeAgent).toHaveBeenCalledTimes(1);
  first.close(); f.advance(61_000); await other.tick();
  expect(executeAgent).toHaveBeenCalledTimes(2);
  expect(executeAgent.mock.calls[1]![0]).toMatchObject({ resume: true, actionId: executeAgent.mock.calls[0]![0].actionId });
  expect(f.deliver).toHaveBeenCalledTimes(1); expect(f.deliver.mock.calls[0]![0].text.length).toBe(9000);
});

it('suppresses a prepared send when rescheduling races with provider dispatch', async () => {
  const f = await fixture(); const { mandate } = await f.create(); let sent = false;
  const deliver = vi.fn(async input => {
    await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, trigger: { kind: 'interval', everySeconds: 600, anchorAt: f.now().toISOString() } });
    await input.assertCurrent(); sent = true; return { receipt: 'never' };
  });
  f.advance(); await f.executor({ deliver }).tick(); expect(sent).toBe(false);
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_delivery')).toMatchObject({ status: 'suppressed' });
});

it('skips missed occurrences when requested and rechecks credential readiness before any delivery', async () => {
  const f = await fixture(); await f.create({ catchupPolicy: 'skip' });
  const run = f.executor(); f.advance(3600_000); await run.tick(); expect(f.deliver).not.toHaveBeenCalled();
  await f.repos.secretRefs.update('secret', { expectedRevision: 1, status: 'invalid' });
  f.advance(); await run.tick(); expect(f.deliver).not.toHaveBeenCalled();
});


it('rejects competing mutation payloads for the same mandate revision across service instances', async () => {
  const f = await fixture(); const { mandate } = await f.create();
  const second = new CollaborationService(f.service.options);
  const results = await Promise.allSettled([
    f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, prompt: 'first request', trigger: { kind: 'interval', everySeconds: 600, anchorAt: f.now().toISOString() } }),
    second.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, prompt: 'second request', trigger: { kind: 'interval', everySeconds: 900, anchorAt: f.now().toISOString() } })
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const current = await f.repos.collaboration.getMandate(scope, mandate.id);
  const schedule = await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId);
  expect(schedule?.trigger).toMatchObject({ everySeconds: current?.prompt === 'first request' ? 600 : 900 });
  expect(current?.revision).toBe(2);
});


it.each(['pending', 'unknown'] as const)('fairly runs the 21st delegation while the first 20 stay %s', async status => {
  const f = await fixture();
  for (let index = 0; index < 20; index++) await f.create({ id: `blocked-${index}`, mode: 'agent' });
  await f.create({ id: 'tail' });
  const executeAgent = vi.fn(async () => ({ status }));
  const run = f.executor({ executeAgent }); f.advance();
  await run.tick();
  expect(executeAgent).toHaveBeenCalledTimes(20); expect(f.deliver).not.toHaveBeenCalled();
  await run.tick();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.deliver.mock.calls[0]![0].mandate.id).toBe('tail');
  const actions = (await f.repos.collaboration.listActions(scope, 500)).filter(action => action.kind === 'schedule_agent');
  expect(actions).toHaveLength(20);
  expect(actions.every(action => action.status === (status === 'pending' ? 'sending' : 'unknown'))).toBe(true);
});

it('fairly stops the 21st cancelled Agent while the first 20 remain pending', async () => {
  const f = await fixture();
  for (let index = 0; index < 20; index++) await f.create({ id: `blocked-${index}`, mode: 'agent' });
  const { mandate } = await f.create({ id: 'tail', mode: 'agent' });
  const executeAgent = vi.fn(async (_input: Parameters<NonNullable<ScheduleExecutorOptions['executeAgent']>>[0]) => ({ status: 'pending' as const }));
  const cancelAgent = vi.fn(async (_input: Parameters<NonNullable<ScheduleExecutorOptions['cancelAgent']>>[0]) => {});
  const run = f.executor({ executeAgent, cancelAgent }); f.advance();
  await run.tick(); await run.tick();
  const tail = executeAgent.mock.calls.find(([input]) => input.mandate.id === mandate.id)?.[0];
  expect(tail).toBeDefined();
  await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, status: 'cancelled' });
  await run.tick();
  expect(cancelAgent).toHaveBeenCalledTimes(1);
  expect(cancelAgent.mock.calls[0]![0].actionId).toBe(tail!.actionId);
  expect(await f.repos.collaboration.getAction(scope, tail!.actionId)).toMatchObject({ status: 'suppressed' });
  expect(await f.repos.scheduleOccurrences.get(tail!.occurrence.id)).toMatchObject({ state: 'suppressed' });
  expect(f.deliver).not.toHaveBeenCalled();
});


it.each(['mandate', 'group'] as const)('continues the same pending Agent while %s notifications are paused, without replaying suppressed output', async level => {
  const f = await fixture(); const { mandate, schedule } = await f.create({ mode: 'agent' });
  let completed = false;
  const executeAgent = vi.fn(async (input: Parameters<NonNullable<ScheduleExecutorOptions['executeAgent']>>[0]) => {
    await input.assertCurrent(); return completed ? { status: 'completed' as const, text: 'Analysis saved' } : { status: 'pending' as const };
  });
  const cancelAgent = vi.fn(async () => {});
  const run = f.executor({ executeAgent, cancelAgent }); f.advance(); await run.tick();
  if (level === 'mandate') await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, deliveryPaused: true });
  else await f.service.updateSettings(scope, 'requester', { expectedRevision: 0, notificationsPaused: true });
  await run.tick();
  expect(cancelAgent).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
  expect(executeAgent).toHaveBeenCalledTimes(2);
  expect(executeAgent.mock.calls[1]![0]).toMatchObject({ actionId: executeAgent.mock.calls[0]![0].actionId, resume: true });
  expect((await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId))?.currentGeneration).toBe(schedule!.currentGeneration);
  completed = true; await run.tick();
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_agent')).toMatchObject({ status: 'succeeded' });
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_delivery')).toMatchObject({ status: 'suppressed' });
  if (level === 'mandate') await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 2, deliveryPaused: false });
  else await f.service.updateSettings(scope, 'requester', { expectedRevision: 1, notificationsPaused: false });
  await run.tick();
  expect(executeAgent).toHaveBeenCalledTimes(3); expect(cancelAgent).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
  expect((await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId))?.currentGeneration).toBe(schedule!.currentGeneration);
});

it.each(['mandate', 'group'] as const)('starts authorized analysis with %s notifications already paused', async level => {
  const f = await fixture(); const { mandate } = await f.create({ mode: 'agent' });
  if (level === 'mandate') await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, deliveryPaused: true });
  else await f.service.updateSettings(scope, 'requester', { expectedRevision: 0, notificationsPaused: true });
  const executeAgent = vi.fn(async (input: Parameters<NonNullable<ScheduleExecutorOptions['executeAgent']>>[0]) => { await input.assertCurrent(); return { status: 'completed' as const, text: 'Analysis saved' }; });
  const run = f.executor({ executeAgent }); f.advance(); await run.tick();
  expect(executeAgent).toHaveBeenCalledTimes(1); expect(f.deliver).not.toHaveBeenCalled();
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_agent')).toMatchObject({ status: 'succeeded' });
});

it('still fences and physically stops pending work on execution pause after a delivery-only toggle', async () => {
  const f = await fixture(); const { mandate, schedule } = await f.create({ mode: 'agent' });
  const executeAgent = vi.fn(async () => ({ status: 'pending' as const })), cancelAgent = vi.fn(async () => {});
  const run = f.executor({ executeAgent, cancelAgent }); f.advance(); await run.tick();
  await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, deliveryPaused: true });
  await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 2, status: 'paused' });
  await run.tick();
  expect(cancelAgent).toHaveBeenCalledTimes(1); expect(executeAgent).toHaveBeenCalledTimes(1); expect(f.deliver).not.toHaveBeenCalled();
  expect((await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId))?.currentGeneration).toBeGreaterThan(schedule!.currentGeneration);
});

it('matches delivery-only revisions but rejects changed execution identity and instructions', async () => {
  const f = await fixture(); const { mandate, schedule } = await f.create({ mode: 'agent' });
  expect(scheduleMatchesMandate(schedule!, { ...mandate, revision: 2, deliveryPaused: true })).toBe(true);
  for (const patch of [{ requesterId: 'other' }, { followupId: 'other' }, { condition: 'no_progress' as const }, { prompt: 'different' }, { mode: 'notify' as const }, { status: 'paused' as const }]) {
    expect(scheduleMatchesMandate(schedule!, { ...mandate, ...patch, revision: 2 })).toBe(false);
  }
});


it('still stops pending analysis when group execution instructions change', async () => {
  const f = await fixture(); await f.create({ mode: 'agent' });
  const executeAgent = vi.fn(async () => ({ status: 'pending' as const })), cancelAgent = vi.fn(async () => {});
  const run = f.executor({ executeAgent, cancelAgent }); f.advance(); await run.tick();
  await f.service.updateSettings(scope, 'requester', { expectedRevision: 0, instructions: 'Use the revised instructions' });
  await run.tick();
  expect(cancelAgent).toHaveBeenCalledTimes(1); expect(executeAgent).toHaveBeenCalledTimes(1); expect(f.deliver).not.toHaveBeenCalled();
});


it.each(['mandate', 'group'] as const)('delivers one original result when %s notifications resume before pending analysis finishes', async level => {
  const f = await fixture(); const { mandate } = await f.create({ mode: 'agent' });
  let completed = false;
  const executeAgent = vi.fn(async (input: Parameters<NonNullable<ScheduleExecutorOptions['executeAgent']>>[0]) => {
    await input.assertCurrent(); return completed ? { status: 'completed' as const, text: 'Original analysis' } : { status: 'pending' as const };
  });
  const cancelAgent = vi.fn(async () => {});
  const run = f.executor({ executeAgent, cancelAgent }); f.advance(); await run.tick();
  const before = await f.repos.collaboration.snapshot(scope);
  if (level === 'mandate') await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, deliveryPaused: true });
  else await f.service.updateSettings(scope, 'requester', { expectedRevision: 0, notificationsPaused: true });
  await run.tick();
  if (level === 'mandate') await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 2, deliveryPaused: false });
  else await f.service.updateSettings(scope, 'requester', { expectedRevision: 1, notificationsPaused: false });
  const after = await f.repos.collaboration.snapshot(scope);
  expect(after.contextRevision).toBeGreaterThan(before.contextRevision);
  expect(collaborationContextSignature(after)).toBe(collaborationContextSignature(before));
  completed = true; await run.tick(); await run.tick();
  expect(executeAgent).toHaveBeenCalledTimes(3); expect(cancelAgent).not.toHaveBeenCalled(); expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(new Set(executeAgent.mock.calls.map(([input]) => input.actionId)).size).toBe(1);
  const actions = await f.repos.collaboration.listActions(scope);
  const agent = actions.find(action => action.kind === 'schedule_agent')!, delivery = actions.find(action => action.kind === 'schedule_delivery')!;
  expect(agent.payload.contextSignature).toBe(collaborationContextSignature(before));
  expect(delivery.payload.contextSignature).toBe(agent.payload.contextSignature);
  expect(delivery).toMatchObject({ status: 'succeeded' });
});

it.each(['message', 'progress', 'bootstrap'] as const)('uses frozen scheduled material after new %s evidence, retaining associated progress and coverage guards', async change => {
  const f = await fixture();
  const { followup } = await f.service.createFollowup(scope, 'requester', { id: 'tracked', goal: 'Collect remaining material' });
  const { mandate } = await f.create({ mode: 'agent', followupId: followup.id });
  let completed = false;
  const run = f.executor({ executeAgent: async () => completed ? { status: 'completed', text: 'Old analysis' } : { status: 'pending' } });
  f.advance(); await run.tick();
  await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, deliveryPaused: true });
  if (change === 'message') await f.repos.collaboration.observe({ scope, source: 'lark', eventId: 'new-message', occurredAt: f.now().toISOString(), receivedAt: f.now().toISOString(), senderKind: 'human', text: 'The requirements have changed', refs: [], origin: 'live', missing: [] });
  else if (change === 'progress') await f.service.updateFollowup(scope, 'requester', followup.id, { expectedRevision: 1, progress: 'A new section arrived' });
  else await f.repos.collaboration.saveBootstrap({ scope, status: 'partial', missing: ['History coverage changed'], updatedAt: f.now().toISOString() });
  await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 2, deliveryPaused: false });
  completed = true; await run.tick();
  // Appended chat is not a revocation; associated progress and history coverage still invalidate delivery.
  expect(f.deliver).toHaveBeenCalledTimes(change === 'message' ? 1 : 0);
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_delivery')).toMatchObject({ status: change === 'message' ? 'succeeded' : 'suppressed' });
});


it.each(['missing', 'status', 'timestamp'] as const)('checks bootstrap %s without relying on context revision', async change => {
  const f = await fixture();
  const bootstrap = { scope, status: 'complete' as const, missing: [], updatedAt: f.now().toISOString() };
  await f.repos.collaboration.saveBootstrap(bootstrap);
  await f.create({ mode: 'agent' });
  let completed = false;
  const run = f.executor({ executeAgent: async () => completed ? { status: 'completed', text: 'Analysis' } : { status: 'pending' } });
  f.advance(); await run.tick(); const before = await f.repos.collaboration.snapshot(scope);
  f.advance(1);
  await f.repos.collaboration.saveBootstrap({ ...bootstrap, status: change === 'status' ? 'partial' : 'complete', missing: change === 'missing' ? ['An earlier page is unavailable'] : [], updatedAt: f.now().toISOString() });
  expect((await f.repos.collaboration.snapshot(scope)).contextRevision).toBe(before.contextRevision);
  completed = true; await run.tick();
  expect(f.deliver).toHaveBeenCalledTimes(change === 'timestamp' ? 1 : 0);
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_delivery')).toMatchObject({ status: change === 'timestamp' ? 'succeeded' : 'suppressed' });
});


it('waits a full interval after progress near the previous due time', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
  const f = await fixture(new Date('2026-09-18T10:00:00.000Z'));
  const { followup } = await f.service.createFollowup(scope, 'requester', { id: 'document', goal: 'Finish remaining sections' });
  const { mandate } = await f.create({ followupId: followup.id, condition: 'no_progress', trigger: { kind: 'interval', everySeconds: 3600, anchorAt: f.now().toISOString() } });
  const run = f.executor(); f.advance(59 * 60_000); vi.setSystemTime(f.now());
  await f.service.updateFollowup(scope, 'requester', followup.id, { expectedRevision: 1, progress: 'Another section completed' });
  await run.tick();
  expect((await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId))?.trigger).toMatchObject({ kind: 'interval', everySeconds: 3600, anchorAt: '2026-09-18T10:59:00.000Z' });
  expect(await f.repos.scheduleWatermarks.get(mandate.scheduleDefinitionId)).toMatchObject({ nextDueAt: '2026-09-18T11:59:00.000Z' });
  f.advance(); await run.tick(); expect(f.now().toISOString()).toBe('2026-09-18T11:00:00.000Z'); expect(f.deliver).not.toHaveBeenCalled();
  f.advance(59 * 60_000); await run.tick(); expect(f.now().toISOString()).toBe('2026-09-18T11:59:00.000Z'); expect(f.deliver).toHaveBeenCalledTimes(1);
});

it.each([
  { kind: 'cron', expression: '0 * * * *' },
  { kind: 'at', localDateTime: '2026-09-18T11:00:00' }
] as const)('preserves the $kind calendar trigger when progress changes', async trigger => {
  const f = await fixture(new Date('2026-09-18T10:00:00.000Z'));
  const { followup } = await f.service.createFollowup(scope, 'requester', { id: 'document', goal: 'Finish remaining sections' });
  const { mandate } = await f.create({ followupId: followup.id, condition: 'no_progress', trigger });
  const run = f.executor(); f.advance(59 * 60_000);
  await f.service.updateFollowup(scope, 'requester', followup.id, { expectedRevision: 1, progress: 'Another section completed' });
  await run.tick();
  expect((await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId))?.trigger).toEqual(trigger);
  expect(await f.repos.scheduleWatermarks.get(mandate.scheduleDefinitionId)).toMatchObject({ nextDueAt: '2026-09-18T11:00:00.000Z' });
  f.advance(); await run.tick(); expect(f.deliver).toHaveBeenCalledTimes(1);
});


it.each(['prepare', 'commit'] as const)('retries a progress reset after %s failure with the persisted progress timestamp', async failure => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
  const f = await fixture(new Date('2026-09-18T10:00:00.000Z'));
  const { followup } = await f.service.createFollowup(scope, 'requester', { id: 'document', goal: 'Finish remaining sections' });
  const { mandate } = await f.create({ followupId: followup.id, condition: 'no_progress', trigger: { kind: 'interval', everySeconds: 3600, anchorAt: f.now().toISOString() } });
  const run = f.executor(); f.advance(59 * 60_000); vi.setSystemTime(f.now());
  await f.service.updateFollowup(scope, 'requester', followup.id, { expectedRevision: 1, progress: 'Another section completed' });
  expect(await f.repos.collaboration.getFollowup(scope, followup.id)).toMatchObject({ updatedAt: '2026-09-18T10:59:00.000Z' });
  const failurePoint = failure === 'prepare'
    ? vi.spyOn(f.repos.scheduleDefinitions, 'update').mockRejectedValueOnce(new Error('temporary update failure'))
    : vi.spyOn(f.repos.collaboration, 'updateMandate').mockRejectedValueOnce(new Error('temporary update failure'));
  await expect(run.tick()).rejects.toThrow('temporary update failure');
  expect(await f.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ revision: 1 });
  failurePoint.mockRestore(); f.advance(); vi.setSystemTime(f.now());
  await run.tick();
  expect(await f.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ revision: 2, lastProgressRevision: 2 });
  expect((await f.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId))?.trigger).toMatchObject({ anchorAt: '2026-09-18T10:59:00.000Z' });
  expect(await f.repos.scheduleWatermarks.get(mandate.scheduleDefinitionId)).toMatchObject({ nextDueAt: '2026-09-18T11:59:00.000Z' });
  expect(f.deliver).not.toHaveBeenCalled();
  f.advance(59 * 60_000); vi.setSystemTime(f.now()); await run.tick();
  expect(f.now().toISOString()).toBe('2026-09-18T11:59:00.000Z'); expect(f.deliver).toHaveBeenCalledTimes(1);
});


it('drains an accepted provider send on close and persists its actual receipt before stopping', async () => {
  const f = await fixture(); const { mandate } = await f.create();
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void; const network = new Promise<void>(resolve => { release = resolve; });
  const deliver = vi.fn(async input => { await input.assertCurrent(); enter(); await network; return { receipt: 'accepted-provider-receipt' }; });
  const run = f.executor({ deliver }); f.advance();
  const tick = run.tick(); await entered;
  let drained = false; const close = run.close().then(() => { drained = true; });
  try {
    await Promise.resolve(); expect(drained).toBe(false);
    await run.tick(); expect(deliver).toHaveBeenCalledOnce();
  } finally { release(); await Promise.all([tick, close]); }
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_delivery')).toMatchObject({ status: 'succeeded', receipt: 'accepted-provider-receipt' });
  expect(await f.repos.scheduleOccurrences.listByDefinition(mandate.scheduleDefinitionId)).toEqual([expect.objectContaining({ state: 'settled' })]);
  f.advance(); await run.tick(); expect(deliver).toHaveBeenCalledOnce();
});

it('blocks Agent dispatch when closing races the persisted sending claim', async () => {
  const f = await fixture(); await f.create({ mode: 'agent' });
  const executeAgent = vi.fn(async () => ({ status: 'completed' as const, text: 'must not start' }));
  const run = f.executor({ executeAgent });
  const update = f.repos.collaboration.updateAction.bind(f.repos.collaboration);
  let closing: Promise<void> | undefined;
  vi.spyOn(f.repos.collaboration, 'updateAction').mockImplementation(async (scope, id, patch) => {
    const action = await update(scope, id, patch);
    if (action.kind === 'schedule_agent' && patch.status === 'sending') closing = run.close();
    return action;
  });
  f.advance(); await run.tick(); await closing;
  expect(executeAgent).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_agent')!.status).toBe('suppressed');
});
