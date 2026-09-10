import { describe, expect, it } from 'vitest';
import type { CreateScheduleDefinitionInput } from '@dutydeck/shared';
import { createRepositories, scheduleWriterLeaseKey } from './index.js';

const at = (minutes: number) => new Date(Date.UTC(2026, 7, 30, 0, minutes)).toISOString();
const scheduleSetHash = 'c'.repeat(64);

function definition(id: string, options: Partial<CreateScheduleDefinitionInput> = {}): CreateScheduleDefinitionInput {
  return {
    id, channelBotId: 'bot-schedule', name: `Schedule ${id}`,
    trigger: { kind: 'interval', everySeconds: 3600, anchorAt: at(0) }, timezone: 'Asia/Shanghai',
    dstPolicy: { gap: 'skip', overlap: 'first' }, delivery: { mode: 'chat', chatRef: 'chat_ref', continuation: 'chat_root' },
    payloadRef: 'payload_ref', sourceOwnership: 'dutydeck', sourceNamespace: 'dutydeck-fixture', sourceEnabled: false,
    ...options
  };
}

async function setup() {
  const repositories = createRepositories(':memory:');
  await repositories.secretRefs.create({ id: 'secret-schedule', kind: 'generic', provider: 'keychain', referenceKey: 'fixture/schedule', status: 'configured' });
  await repositories.channelBots.create({ id: 'bot-schedule', channel: 'lark', externalAppId: 'cli_schedule_fixture', displayName: 'Schedule Fixture', brand: 'feishu', credentialRef: 'secret-schedule', state: 'staged' });
  return repositories;
}

describe('v13 Schedule foundation repositories', () => {
  it('creates and updates only staged/disabled definitions with an immutable generation pin and conditional rollback', async () => {
    const repositories = await setup();
    const created = await repositories.scheduleDefinitions.create(definition('schedule-cas'));
    expect(created).toMatchObject({ revision: 1, state: 'staged', desiredExecutorState: 'disabled', currentGeneration: 1 });
    expect(await repositories.scheduleGenerations.listByDefinition(created.id)).toEqual([
      expect.objectContaining({ generation: 1, definitionRevision: 1, state: 'staged_disabled' })
    ]);
    const updated = await repositories.scheduleDefinitions.update(created.id, { expectedRevision: 1, name: 'Edited', state: 'disabled' });
    expect(updated).toMatchObject({ revision: 2, currentGeneration: 2, state: 'disabled', desiredExecutorState: 'disabled' });
    expect((await repositories.scheduleGenerations.listByDefinition(created.id)).map(item => [item.generation, item.definitionRevision])).toEqual([[2, 2], [1, 1]]);
    await expect(repositories.scheduleDefinitions.update(created.id, { expectedRevision: 1, name: 'stale' })).rejects.toMatchObject({ code: 'SCHEDULE_REVISION_CONFLICT' });
    await expect(repositories.scheduleDefinitions.rollbackLast(created.id, 1)).rejects.toMatchObject({ code: 'SCHEDULE_REVISION_CONFLICT' });
    const rolledBack = await repositories.scheduleDefinitions.rollbackLast(created.id, 2);
    expect(rolledBack).toMatchObject({ revision: 3, currentGeneration: 3, name: created.name, state: 'disabled', desiredExecutorState: 'disabled' });
    repositories.close();
  });

  it('deduplicates deterministic occurrences and advances only the planning watermark without creating Tasks/Runs', async () => {
    const repositories = await setup();
    const created = await repositories.scheduleDefinitions.create(definition('schedule-occurrence'));
    await expect(repositories.scheduleOccurrences.recordPlanned(created.id, at(60), 'not-a-time')).rejects.toMatchObject({ code: 'SCHEDULE_WATERMARK_TIME_INVALID' });
    const first = await repositories.scheduleOccurrences.recordPlanned(created.id, at(60), at(120));
    const duplicate = await repositories.scheduleOccurrences.recordPlanned(created.id, at(60), at(120));
    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ occurrence: first.occurrence, created: false });
    expect(first.occurrence.idempotencyKey).toMatch(/^occ_[a-f0-9]{64}$/);
    expect(await repositories.scheduleOccurrences.listByDefinition(created.id)).toHaveLength(1);
    expect(await repositories.scheduleWatermarks.get(created.id)).toMatchObject({ revision: 2, lastPlannedOccurrenceKey: first.occurrence.idempotencyKey, nextDueAt: at(120) });
    expect(await repositories.tasks.listBySession('schedule-occurrence')).toEqual([]);
    repositories.close();
  });

  it('marks imported enabled Botmux occurrences source-owned and keeps hard blockers visible', async () => {
    const repositories = await setup();
    const imported = await repositories.scheduleDefinitions.create(definition('schedule-imported', {
      identityRef: 'identity_fixture', secretRef: 'secret-schedule', sourceOwnership: 'botmux', sourceNamespace: 'botmux-source-ref', sourceScheduleRef: 'botmux-schedule-ref', sourceEnabled: true
    }));
    const occurrence = await repositories.scheduleOccurrences.recordPlanned(imported.id, at(60));
    expect(occurrence.occurrence.state).toBe('source_owned_pending');
    expect((await repositories.scheduleDefinitions.readiness(imported.id, at(0))).blockers.map(blocker => blocker.code)).toEqual(expect.arrayContaining([
      'schedule_lease_required', 'botmux_source_schedule_enabled', 'schedule_executor_unavailable'
    ]));
    repositories.close();
  });

  it('enforces lease acquire/renew/fence CAS and never steals an expired held generation', async () => {
    const repositories = await setup();
    const key = scheduleWriterLeaseKey('bot-schedule');
    await expect(repositories.scheduleLeases.acquire({ id: 'lease-invalid', leaseKey: key, expectedRevision: 0, expectedGeneration: 0, holderId: 'holder-a', holderIdentityRef: 'identity-a', secretRef: 'missing-secret', scheduleSetHash, now: at(0), ttlMs: 60_000 })).rejects.toMatchObject({ code: 'SCHEDULE_SECRET_REF_NOT_FOUND' });
    const acquired = await repositories.scheduleLeases.acquire({ id: 'lease-schedule', leaseKey: key, expectedRevision: 0, expectedGeneration: 0, holderId: 'holder-a', holderIdentityRef: 'identity-a', secretRef: 'secret-schedule', scheduleSetHash, now: at(0), ttlMs: 60_000 });
    expect(acquired).toMatchObject({ revision: 1, generation: 1, state: 'held', fenceToken: 1 });
    await expect(repositories.scheduleLeases.renew(key, { expectedRevision: 1, expectedGeneration: 1, expectedFenceToken: 0, holderId: 'holder-a', now: at(0.5), ttlMs: 60_000 })).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
    const renewed = await repositories.scheduleLeases.renew(key, { expectedRevision: 1, expectedGeneration: 1, expectedFenceToken: 1, holderId: 'holder-a', now: at(0.5), ttlMs: 60_000 });
    expect(renewed).toMatchObject({ revision: 2, generation: 1, state: 'held' });
    await expect(repositories.scheduleLeases.acquire({ id: 'lease-other', leaseKey: key, expectedRevision: 2, expectedGeneration: 1, holderId: 'holder-b', holderIdentityRef: 'identity-b', secretRef: 'secret-schedule', scheduleSetHash, now: at(5), ttlMs: 60_000 })).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
    const fenced = await repositories.scheduleLeases.fence(key, { expectedRevision: 2, expectedGeneration: 1, expectedFenceToken: 1, now: at(5) });
    expect(fenced).toMatchObject({ revision: 3, generation: 1, state: 'fenced', fenceToken: 2 });
    await expect(repositories.scheduleLeases.renew(key, { expectedRevision: 2, expectedGeneration: 1, expectedFenceToken: 1, holderId: 'holder-a', now: at(6), ttlMs: 60_000 })).rejects.toMatchObject({ code: 'SCHEDULE_LEASE_CONFLICT' });
    const reacquired = await repositories.scheduleLeases.acquire({ id: 'ignored-existing-id', leaseKey: key, expectedRevision: 3, expectedGeneration: 1, holderId: 'holder-b', holderIdentityRef: 'identity-b', secretRef: 'secret-schedule', scheduleSetHash, now: at(6), ttlMs: 60_000 });
    expect(reacquired).toMatchObject({ revision: 4, generation: 2, state: 'held', holderId: 'holder-b', fenceToken: 3 });
    repositories.close();
  });

  it('stores Hammer capability only as typed archived metadata with an unavailable executor', async () => {
    const repositories = await setup();
    const archived = await repositories.archivedHammerIntegrations.create({ id: 'hammer-archive', channelBotId: 'bot-schedule', sourceEnabled: true, mode: 'full', enforceGates: true, skillsInjection: 'prompt' });
    expect(archived).toMatchObject({ kind: 'hammer', state: 'archived', executorState: 'unavailable', blockerCode: 'hammer_executor_unavailable' });
    expect(await repositories.archivedHammerIntegrations.listByChannelBot('bot-schedule')).toEqual([archived]);
    await expect(repositories.archivedHammerIntegrations.create({ id: 'hammer-second', channelBotId: 'bot-schedule', sourceEnabled: true, mode: 'lite', enforceGates: false, skillsInjection: 'none' })).rejects.toMatchObject({ code: 'SCHEDULE_NATURAL_KEY_CONFLICT' });
    repositories.close();
  });
});
