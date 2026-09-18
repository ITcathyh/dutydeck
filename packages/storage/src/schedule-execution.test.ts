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
  return { repos, input, migrate() { const db = new Database(path); try { withMigrationTransaction(db, () => createScheduleExecutionSchema(db)); expect(db.pragma('foreign_key_check')).toEqual([]); } finally { db.close(); } } };
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
