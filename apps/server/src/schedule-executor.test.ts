import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
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
  return { repos, service, executor, deliver, authorize, input, now, deny() { allowed = false; }, advance(ms = 60_000) { clock = new Date(clock.getTime() + ms); }, create: (extra = {}) => service.createMandate(scope, 'requester', { ...input, ...extra }) };
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

it('cancels the old pending Agent after delegation cancellation and suppresses its result', async () => {
  const f = await fixture(); const { mandate } = await f.create({ mode: 'agent' });
  const executeAgent = vi.fn(async () => ({ status: 'pending' as const, receipt: 'task-one' })), cancelAgent = vi.fn(async () => {});
  const run = f.executor({ executeAgent, cancelAgent }); f.advance(); await run.tick();
  await f.service.updateMandate(scope, 'requester', mandate.id, { expectedRevision: 1, status: 'cancelled' });
  await run.tick(); expect(cancelAgent).toHaveBeenCalledTimes(1);
  expect(executeAgent).toHaveBeenCalledTimes(1); expect(f.deliver).not.toHaveBeenCalled();
});

it('suppresses a result whose source context changed while the Agent was running', async () => {
  const f = await fixture(); await f.create({ mode: 'agent' });
  let completed = false;
  const run = f.executor({ executeAgent: async () => completed ? { status: 'completed', text: 'Old summary' } : { status: 'pending' } });
  f.advance(); await run.tick();
  await f.service.createFollowup(scope, 'requester', { id: 'new', goal: 'New information' }); completed = true;
  await run.tick(); expect(f.deliver).not.toHaveBeenCalled();
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_delivery')).toMatchObject({ status: 'suppressed' });
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

it.each(['message', 'progress', 'bootstrap'] as const)('still suppresses an old result after notification toggles plus new %s evidence', async change => {
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
  expect(f.deliver).not.toHaveBeenCalled();
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_delivery')).toMatchObject({ status: 'suppressed' });
});


it.each([true, false])('checks bootstrap evidence without relying on context revision (changed evidence: %s)', async changedEvidence => {
  const f = await fixture();
  const bootstrap = { scope, status: 'complete' as const, missing: [], updatedAt: f.now().toISOString() };
  await f.repos.collaboration.saveBootstrap(bootstrap);
  await f.create({ mode: 'agent' });
  let completed = false;
  const run = f.executor({ executeAgent: async () => completed ? { status: 'completed', text: 'Analysis' } : { status: 'pending' } });
  f.advance(); await run.tick(); const before = await f.repos.collaboration.snapshot(scope);
  await f.repos.collaboration.saveBootstrap({ ...bootstrap, missing: changedEvidence ? ['An earlier page is unavailable'] : [], updatedAt: f.now().toISOString() });
  expect((await f.repos.collaboration.snapshot(scope)).contextRevision).toBe(before.contextRevision);
  completed = true; await run.tick();
  expect(f.deliver).toHaveBeenCalledTimes(changedEvidence ? 0 : 1);
  expect((await f.repos.collaboration.listActions(scope)).find(action => action.kind === 'schedule_delivery')).toMatchObject({ status: changedEvidence ? 'suppressed' : 'succeeded' });
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
