import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRepositories, scheduleWriterLeaseKey } from './index.js';
import { withMigrationTransaction } from './migrations.js';
import { createScheduleExecutionSchema } from './schedule-execution-migration.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'schedule-execution-')), path = join(directory, 'state.db');
  const repos = createRepositories(path);
  cleanup.push(() => { repos.close(); rmSync(directory, { recursive: true, force: true }); });
  await repos.secretRefs.create({ id: 'secret', kind: 'generic', provider: 'keychain', referenceKey: 'test', status: 'configured' });
  await repos.channelBots.create({ id: 'bot', channel: 'lark', externalAppId: 'app', displayName: 'Bot', brand: 'feishu', credentialRef: 'secret', state: 'staged' });
  const input = { id: 'schedule', channelBotId: 'bot', name: 'Summary', trigger: { kind: 'interval' as const, everySeconds: 3600, anchorAt: '2026-09-18T00:00:00.000Z' }, timezone: 'UTC', dstPolicy: { gap: 'skip' as const, overlap: 'first' as const }, delivery: { mode: 'chat' as const, chatRef: 'chat', continuation: 'chat_root' as const }, payloadRef: 'payload', identityRef: 'identity', secretRef: 'secret', sourceOwnership: 'dutydeck' as const, sourceNamespace: 'collaboration', sourceEnabled: false };
  return { repos, input, path, migrate() { const db = new Database(path); try { withMigrationTransaction(db, () => createScheduleExecutionSchema(db)); expect(db.pragma('foreign_key_check')).toEqual([]); } finally { db.close(); } } };
}
it('upgrades existing definitions, occurrences and foreign keys without enabling historical plans', async () => {
  const f = await setup();
  await f.repos.scheduleDefinitions.create({ ...f.input, sourceNamespace: 'legacy' });
  const old = await f.repos.scheduleOccurrences.recordPlanned('schedule', '2026-09-18T01:00:00.000Z');
  f.migrate(); f.migrate();
  expect(await f.repos.scheduleDefinitions.get('schedule')).toMatchObject({ state: 'staged', desiredExecutorState: 'disabled', currentGeneration: 1 });
  expect(await f.repos.scheduleOccurrences.get(old.occurrence.id)).toEqual(old.occurrence);
  await expect(f.repos.scheduleDefinitions.update('schedule', { expectedRevision: 1, state: 'enabled' })).rejects.toMatchObject({ code: 'SCHEDULE_ENABLE_FORBIDDEN' });
});
it('persists occurrence transitions and rejects an old writer after an explicit lease takeover', async () => {
  const f = await setup(); f.migrate();
  const staged = await f.repos.scheduleDefinitions.create(f.input);
  const enabled = await f.repos.scheduleDefinitions.update(staged.id, { expectedRevision: 1, state: 'enabled', nextDueAt: '2026-09-18T01:00:00.000Z' });
  const leaseKey = scheduleWriterLeaseKey('bot');
  const lease = await f.repos.scheduleLeases.acquire({ id: 'lease', leaseKey, expectedRevision: 0, expectedGeneration: 0, holderId: 'one', holderIdentityRef: 'identity', secretRef: 'secret', scheduleSetHash: 'a'.repeat(64), now: '2026-09-18T01:00:00.000Z', ttlMs: 1000 });
  const fence = { leaseKey, holderId: 'one', fenceToken: lease.fenceToken, now: '2026-09-18T01:00:00.000Z' };
  let { occurrence } = await f.repos.scheduleOccurrences.recordPlanned(enabled.id, '2026-09-18T01:00:00.000Z');
  occurrence = await f.repos.scheduleOccurrences.advance(occurrence.id, occurrence.revision, 'claimed', fence);
  occurrence = await f.repos.scheduleOccurrences.advance(occurrence.id, occurrence.revision, 'running', fence);
  expect(await f.repos.scheduleWatermarks.get(enabled.id)).toMatchObject({ lastClaimedOccurrenceKey: occurrence.idempotencyKey, lastStartedOccurrenceKey: occurrence.idempotencyKey });
  const fenced = await f.repos.scheduleLeases.fence(leaseKey, { expectedRevision: 1, expectedGeneration: 1, expectedFenceToken: 1, now: '2026-09-18T01:00:02.000Z' });
  const second = await f.repos.scheduleLeases.acquire({ id: 'lease', leaseKey, expectedRevision: fenced.revision, expectedGeneration: fenced.generation, holderId: 'two', holderIdentityRef: 'identity', secretRef: 'secret', scheduleSetHash: 'a'.repeat(64), now: '2026-09-18T01:00:02.000Z', ttlMs: 1000 });
  await expect(f.repos.scheduleOccurrences.advance(occurrence.id, occurrence.revision, 'settled', fence)).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
  const settled = await f.repos.scheduleOccurrences.advance(occurrence.id, occurrence.revision, 'settled', { ...fence, holderId: 'two', fenceToken: second.fenceToken, now: '2026-09-18T01:00:02.000Z' });
  expect(await f.repos.scheduleOccurrences.get(settled.id)).toMatchObject({ state: 'settled', holderId: 'two' });
  expect(await f.repos.scheduleWatermarks.get(enabled.id)).toMatchObject({ lastSettledOccurrenceKey: settled.idempotencyKey });
});
it('uses generation in new occurrence identity and invalidates queued work on reschedule', async () => {
  const f = await setup(); f.migrate();
  const staged = await f.repos.scheduleDefinitions.create(f.input);
  const enabled = await f.repos.scheduleDefinitions.update(staged.id, { expectedRevision: 1, state: 'enabled' });
  const first = await f.repos.scheduleOccurrences.recordPlanned(enabled.id, '2026-09-18T01:00:00.000Z');
  await f.repos.scheduleDefinitions.update(enabled.id, { expectedRevision: enabled.revision, state: 'disabled' });
  expect(await f.repos.scheduleOccurrences.get(first.occurrence.id)).toMatchObject({ state: 'suppressed' });
  const second = await f.repos.scheduleOccurrences.recordPlanned(enabled.id, '2026-09-18T01:00:00.000Z');
  expect(second.created).toBe(true);
  expect(second.occurrence.id).not.toBe(first.occurrence.id);
});

it('fences every scheduled action mutation against its real bot, occurrence and revision across two connections', async () => {
  const f = await setup(); f.migrate();
  const staged = await f.repos.scheduleDefinitions.create(f.input);
  const schedule = await f.repos.scheduleDefinitions.update(staged.id, { expectedRevision: staged.revision, state: 'enabled' });
  const scope = { appId: 'app', chatId: 'chat' };
  await f.repos.collaboration.createMandate({ id: 'mandate', scope, goal: 'Summary', status: 'active', requesterId: 'actor', sourceRefs: [], scheduleDefinitionId: schedule.id,
    mode: 'notify', prompt: 'Summary', condition: 'always', deliveryPaused: false, catchupPolicy: 'coalesce' });
  const { occurrence } = await f.repos.scheduleOccurrences.recordPlanned(schedule.id, '2026-09-18T01:00:00.000Z');
  const leaseKey = scheduleWriterLeaseKey('bot');
  const acquire = { id: 'lease', leaseKey, holderIdentityRef: 'identity', secretRef: 'secret', scheduleSetHash: 'a'.repeat(64), ttlMs: 1000 };
  const first = await f.repos.scheduleLeases.acquire({ ...acquire, expectedRevision: 0, expectedGeneration: 0, holderId: 'one', now: '2026-09-18T01:00:00.000Z' });
  const proof = { leaseKey, holderId: 'one', fenceToken: first.fenceToken, now: '2026-09-18T01:00:00.000Z', occurrenceId: occurrence.id };
  const input = { id: `collaboration_delivery_${occurrence.idempotencyKey}`, scope, kind: 'schedule_delivery', mandateId: 'mandate', mandateRevision: 1,
    scheduleGeneration: occurrence.generation, requesterId: 'actor', inputDigest: 'digest', payload: {} };
  await expect(f.repos.collaboration.beginAction(input)).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
  const { action } = await f.repos.collaboration.beginAction(input, proof);
  const patch = { expectedRevision: action.revision, status: 'sending' as const };
  await expect(f.repos.collaboration.updateAction(scope, action.id, patch)).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
  await expect(f.repos.collaboration.updateAction(scope, action.id, patch, { ...proof, now: '2026-09-18T01:00:01.000Z' })).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
  await expect(f.repos.collaboration.beginAction({ ...input, id: 'forged-action' }, proof)).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
  await expect(f.repos.collaboration.updateAction(scope, action.id, patch, { ...proof, occurrenceId: 'other' })).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
  await f.repos.channelBots.create({ id: 'other-bot', channel: 'lark', externalAppId: 'other-app', displayName: 'Other', brand: 'feishu', credentialRef: 'secret', state: 'staged' });
  const foreignKey = scheduleWriterLeaseKey('other-bot');
  const foreign = await f.repos.scheduleLeases.acquire({ ...acquire, id: 'foreign', leaseKey: foreignKey, expectedRevision: 0, expectedGeneration: 0, holderId: 'one', now: proof.now });
  await expect(f.repos.collaboration.updateAction(scope, action.id, patch, { ...proof, leaseKey: foreignKey, fenceToken: foreign.fenceToken })).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
  const other = createRepositories(f.path); cleanup.push(() => other.close());
  const fenced = await other.scheduleLeases.fence(leaseKey, { expectedRevision: first.revision, expectedGeneration: first.generation, expectedFenceToken: first.fenceToken, now: '2026-09-18T01:00:02.000Z' });
  const second = await other.scheduleLeases.acquire({ ...acquire, expectedRevision: fenced.revision, expectedGeneration: fenced.generation, holderId: 'two', now: '2026-09-18T01:00:02.000Z' });
  const nextProof = { ...proof, holderId: 'two', fenceToken: second.fenceToken, now: '2026-09-18T01:00:02.000Z' };
  await expect(f.repos.collaboration.beginAction(input, proof)).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
  const claimed = await other.collaboration.updateAction(scope, action.id, patch, nextProof);
  await expect(f.repos.collaboration.updateAction(scope, action.id, { expectedRevision: claimed.revision, status: 'suppressed' }, proof)).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
  await expect(other.collaboration.updateAction(scope, action.id, patch, nextProof)).rejects.toMatchObject({ code: 'COLLABORATION_REVISION_CONFLICT' });
  const succeeded = await other.collaboration.updateAction(scope, action.id, { expectedRevision: claimed.revision, status: 'succeeded', receipt: 'receipt' }, nextProof);
  await expect(f.repos.collaboration.updateAction(scope, action.id, { expectedRevision: succeeded.revision, status: 'unknown', receipt: null }, proof)).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
  expect(await other.collaboration.getAction(scope, action.id)).toMatchObject({ status: 'succeeded', receipt: 'receipt' });
});
