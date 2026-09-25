import { describe, expect, it } from 'vitest';
import { mergeGroupTaskWatermark } from './group-task-context.js';

const mark = (contextRevision: number, settingsRevision: number, items: Record<string, number>, fullAt: string, participation?: string) =>
  JSON.stringify({ contextRevision, settingsRevision, ...(participation ? { participation } : {}), items, fullAt });

describe('mergeGroupTaskWatermark', () => {
  it('never moves behind a newer stored watermark and keeps the larger revision of each recorded item', () => {
    const stored = mark(9, 3, { follow_a: 4, follow_b: 1 }, '2026-09-25T03:00:00.000Z', 'selective');
    const late = mark(5, 2, { follow_a: 2, follow_b: 6, follow_c: 1 }, '2026-09-25T02:00:00.000Z', 'observe');
    expect(JSON.parse(mergeGroupTaskWatermark(stored, late))).toEqual({
      contextRevision: 9, settingsRevision: 3, participation: 'selective', items: { follow_a: 4, follow_b: 6, follow_c: 1 }, fullAt: '2026-09-25T03:00:00.000Z'
    });
  });

  it('moves forward to this turn when it is ahead of the stored watermark', () => {
    const stored = mark(2, 1, { follow_a: 1 }, '2026-09-25T02:00:00.000Z', 'observe');
    const ahead = mark(3, 1, { follow_a: 2 }, '2026-09-25T02:30:00.000Z', 'selective');
    expect(JSON.parse(mergeGroupTaskWatermark(stored, ahead))).toEqual({
      contextRevision: 3, settingsRevision: 1, participation: 'selective', items: { follow_a: 2 }, fullAt: '2026-09-25T02:30:00.000Z'
    });
  });

  it('drops the participation mode when both sides read the same revision but saw different modes', () => {
    const stored = mark(4, 1, {}, '2026-09-25T02:00:00.000Z', 'observe');
    const same = mark(4, 1, {}, '2026-09-25T02:00:00.000Z', 'selective');
    expect(JSON.parse(mergeGroupTaskWatermark(stored, same))).not.toHaveProperty('participation');
    expect(JSON.parse(mergeGroupTaskWatermark(stored, mark(4, 1, {}, '2026-09-25T02:00:00.000Z', 'observe')))).toHaveProperty('participation', 'observe');
  });

  it('keeps this turn when the stored watermark is missing or unreadable', () => {
    const late = mark(5, 2, { follow_a: 2 }, '2026-09-25T02:00:00.000Z');
    expect(mergeGroupTaskWatermark(undefined, late)).toBe(late);
    expect(mergeGroupTaskWatermark('{broken', late)).toBe(late);
  });
});
