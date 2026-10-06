import { describe, expect, it } from 'vitest';
import {
  archivedHammerIntegrationSchema,
  buildScheduleTaskRunIntent,
  describeScheduleTrigger,
  previewNextSchedule,
  scheduleDefinitionSchema,
  scheduleGenerationSchema,
  scheduleOccurrenceSchema,
  scheduleReadiness,
  scheduleTriggerPeriod,
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

describe('describeScheduleTrigger', () => {
  const cron = (expression: string, timezone = 'Asia/Shanghai') => describeScheduleTrigger({ kind: 'cron', expression }, timezone);
  it('writes common cron rules in plain Chinese', () => {
    expect(cron('0 18 * * 1-5')).toBe('工作日每天 18:00');
    expect(cron('30 9 * * *')).toBe('每天 09:30');
    expect(cron('0 9,18 * * *')).toBe('每天 09:00、18:00');
    expect(cron('0 10 * * 1,3')).toBe('每周一、三 10:00');
    expect(cron('0 10 * * 6,0')).toBe('周末每天 10:00');
    expect(cron('0 9 1,15 * *')).toBe('每月 1、15 日 09:00');
    expect(cron('*/30 * * * *')).toBe('每天每 30 分钟');
    expect(cron('0 */2 * * 1-5')).toBe('工作日每 2 小时整点');
    expect(cron('0 18 * * 1-5', 'America/New_York')).toBe('工作日每天 18:00（时区 America/New_York）');
  });
  it('keeps unrecognised cron text instead of guessing', () => {
    expect(cron('0 9 1 * 1')).toBe('按 cron「0 9 1 * 1」');
    expect(cron('0-59/5 0-23/2 * * *')).toContain('cron');
  });
  it('describes one-off and interval triggers and picks the period word for an empty result', () => {
    expect(describeScheduleTrigger({ kind: 'at', localDateTime: '2026-10-07T09:00:00' }, 'Asia/Shanghai')).toBe('2026-10-07 09:00 执行一次');
    expect(describeScheduleTrigger({ kind: 'interval', everySeconds: 1800, anchorAt: timestamp })).toBe('每 30 分钟');
    expect(describeScheduleTrigger({ kind: 'interval', everySeconds: 7200, anchorAt: timestamp })).toBe('每 2 小时');
    expect(describeScheduleTrigger({ kind: 'interval', everySeconds: 86_400, anchorAt: timestamp })).toBe('每天');
    expect(scheduleTriggerPeriod({ kind: 'cron', expression: '0 18 * * 1-5' })).toBe('今天');
    expect(scheduleTriggerPeriod({ kind: 'cron', expression: '0 18 * * 5' })).toBe('本周');
    expect(scheduleTriggerPeriod({ kind: 'cron', expression: '0 9 1 * *' })).toBe('本月');
    expect(scheduleTriggerPeriod({ kind: 'interval', everySeconds: 600, anchorAt: timestamp })).toBe('这段时间');
  });
});
