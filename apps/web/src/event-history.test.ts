import { describe, expect, it } from 'vitest';
import type { DockEvent } from './api';
import { createEventWindow, EVENT_PAGE_SIZE, EVENT_RENDER_LIMIT, initialEventQuery, mergeLiveEvent, mergeOlderEvents, newestSequence } from './event-history';

const event = (sequence: number, text = String(sequence)): DockEvent => ({ id: `e-${sequence}`, sequence, type: 'text', timestamp: '', data: { text } });

describe('event history window', () => {
  it('initial query requests the newest bounded backward page', () => {
    expect(initialEventQuery()).toEqual({ limit: EVENT_PAGE_SIZE, direction: 'backward' });
  });

  it('prepends older pages, deduplicates and remains bounded', () => {
    const recent = createEventWindow(Array.from({ length: 200 }, (_, index) => event(index + 201)), true);
    const merged = mergeOlderEvents(recent, Array.from({ length: 201 }, (_, index) => event(index + 1)), true);
    expect(merged.events[0]?.sequence).toBe(1);
    expect(merged.events.at(-1)?.sequence).toBe(400);
    expect(merged.events).toHaveLength(400);
    const capped = mergeOlderEvents(createEventWindow(Array.from({ length: EVENT_RENDER_LIMIT - 100 }, (_, index) => event(index + 101)), true), Array.from({ length: 200 }, (_, index) => event(index + 1)), true);
    expect(capped.events).toHaveLength(EVENT_RENDER_LIMIT);
    expect(capped.hasEarlier).toBe(false);
  });

  it('SSE merge updates by sequence and keeps chronological order', () => {
    let window = createEventWindow([event(1), event(3)], false);
    window = mergeLiveEvent(window, event(2));
    window = mergeLiveEvent(window, event(3, 'updated'));
    expect(window.events.map(item => item.sequence)).toEqual([1, 2, 3]);
    expect(window.events[2]?.data.text).toBe('updated');
    expect(newestSequence(window)).toBe(3);
  });
});
