import { describe, expect, it } from 'vitest';
import {
  archivedHammerIntegrationSchema,
  buildScheduleTaskRunIntent,
  previewNextSchedule,
  scheduleDefinitionSchema,
  scheduleGenerationSchema,
  scheduleOccurrenceSchema,
  scheduleReadiness,
  type ScheduleDefinition
} from './schedule-foundation.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const base = (trigger: ScheduleDefinition['trigger'], overrides: Partial<ScheduleDefinition> = {}): ScheduleDefinition => scheduleDefinitionSchema.parse({
  schemaVersion: 1, id: 'schedule-test', revision: 1, channelBotId: 'bot-test', name: 'Test schedule',
  trigger, timezone: 'America/New_York', dstPolicy: { gap: 'skip', overlap: 'first' },
  delivery: { mode: 'chat', chatRef: 'chat_ref', continuation: 'chat_root' }, payloadRef: 'payload_ref',
  sourceOwnership: 'dutydeck', sourceNamespace: 'fixture', sourceEnabled: false, state: 'staged',
  desiredExecutorState: 'disabled', currentGeneration: 1, createdAt: timestamp, updatedAt: timestamp, ...overrides
});

describe('Schedule foundation time semantics', () => {
  it('models DST gaps explicitly instead of silently changing timezone semantics', () => {
    const skipped = base({ kind: 'at', localDateTime: '2026-03-08T02:30:00' });
    expect(previewNextSchedule(skipped, new Date('2026-03-01T00:00:00.000Z'))).toBeUndefined();

    const shifted = base({ kind: 'at', localDateTime: '2026-03-08T02:30:00' }, { dstPolicy: { gap: 'shift_forward', overlap: 'first' } });
    expect(previewNextSchedule(shifted, new Date('2026-03-01T00:00:00.000Z'))).toMatchObject({
      scheduledForUtc: '2026-03-08T07:00:00.000Z', localLabel: '2026-03-08T03:00:00', dstResolution: 'gap_shifted'
    });
  });

  it('pins first or second instant during a DST overlap', () => {
    const first = base({ kind: 'at', localDateTime: '2026-11-01T01:30:00' });
    const second = base({ kind: 'at', localDateTime: '2026-11-01T01:30:00' }, { dstPolicy: { gap: 'skip', overlap: 'second' } });
    expect(previewNextSchedule(first, new Date('2026-10-01T00:00:00.000Z'))).toMatchObject({ scheduledForUtc: '2026-11-01T05:30:00.000Z', dstResolution: 'overlap_first' });
    expect(previewNextSchedule(second, new Date('2026-10-01T00:00:00.000Z'))).toMatchObject({ scheduledForUtc: '2026-11-01T06:30:00.000Z', dstResolution: 'overlap_second' });
  });

  it('keeps interval cadence absolute across a DST jump and previews cron in local time', () => {
    const interval = base({ kind: 'interval', everySeconds: 3600, anchorAt: '2026-03-08T06:30:00.000Z' });
    expect(previewNextSchedule(interval, new Date('2026-03-08T06:30:00.000Z'))).toMatchObject({ scheduledForUtc: '2026-03-08T07:30:00.000Z', localLabel: '2026-03-08T03:30:00' });
    const cron = base({ kind: 'cron', expression: '15 9 * * 1-5' }, { timezone: 'Asia/Shanghai' });
    expect(previewNextSchedule(cron, new Date('2026-08-28T01:16:00.000Z'))).toMatchObject({ scheduledForUtc: '2026-08-31T01:15:00.000Z', localLabel: '2026-08-31T09:15:00' });
  });
});

describe('Schedule foundation safety contracts', () => {
  it('hard-blocks missing lease, identity and SecretRef and only builds a non-dispatchable Task/RunSnapshot intent', () => {
    const definition = base({ kind: 'interval', everySeconds: 3600, anchorAt: timestamp });
    const generation = scheduleGenerationSchema.parse({ schemaVersion: 1, id: 'generation-test-1', scheduleDefinitionId: definition.id, generation: 1, definitionRevision: 1, definitionHash: 'a'.repeat(64), timezone: definition.timezone, state: 'staged_disabled', createdAt: timestamp });
    const occurrence = scheduleOccurrenceSchema.parse({ schemaVersion: 1, id: 'occurrence-test', revision: 1, scheduleDefinitionId: definition.id, scheduleGenerationId: generation.id, generation: 1, scheduledForUtc: '2026-01-01T01:00:00.000Z', idempotencyKey: `occ_${'b'.repeat(64)}`, state: 'planned', intentKind: 'task_run_snapshot', createdAt: timestamp, updatedAt: timestamp });
    const readiness = scheduleReadiness(definition, generation, undefined, 'missing', new Date(timestamp));
    expect(readiness.executionEligible).toBe(false);
    expect(readiness.blockers.map(blocker => blocker.code)).toEqual(expect.arrayContaining([
      'schedule_lease_required', 'schedule_identity_required', 'schedule_secret_ref_required', 'schedule_executor_unavailable'
    ]));
    const intent = buildScheduleTaskRunIntent(definition, generation, occurrence, readiness.blockers);
    expect(intent).toMatchObject({ kind: 'task_run_snapshot_intent', dispatchAllowed: false, task: { source: 'schedule', status: 'intent_only' }, runSnapshot: { sourceKind: 'schedule', sourceGeneration: 1 } });
    expect(JSON.stringify(intent)).not.toContain('prompt');
  });

  it('preserves Hammer as typed archived metadata with an unavailable executor', () => {
    const hammer = archivedHammerIntegrationSchema.parse({
      schemaVersion: 1, id: 'hammer-test', revision: 1, channelBotId: 'bot-test', kind: 'hammer', sourceSystem: 'botmux',
      sourceEnabled: true, mode: 'full', enforceGates: true, skillsInjection: 'prompt', state: 'archived',
      executorState: 'unavailable', blockerCode: 'hammer_executor_unavailable', createdAt: timestamp, updatedAt: timestamp
    });
    expect(hammer.executorState).toBe('unavailable');
    expect(() => archivedHammerIntegrationSchema.parse({ ...hammer, executorState: 'available', arbitraryConfig: {} })).toThrow();
  });
});
