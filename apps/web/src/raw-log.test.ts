import { describe, expect, it, vi } from 'vitest';
import type { DockEvent } from './api';
import { createEventWindow, mergeReconciledEvents } from './event-history';
import { createRawLogProjector } from './raw-log';

const event = (sequence: number, type = 'raw_terminal', text = `screen ${sequence}\n`): DockEvent => ({ id: `raw-${sequence}`, sequence, type, timestamp: '', data: { text } });
const full = (events: DockEvent[]) => events.filter(event => event.type === 'raw_terminal').map(event => event.raw ?? event.data.text).join('');

describe('complete incremental raw log', () => {
  it('retains every snapshot and raw precedence through append, prepend, replacement and session reset', () => {
    const project = createRawLogProjector();
    let window = createEventWindow([event(3), { ...event(4), raw: 'native\n' }, event(5, 'text')], true);
    const first = project(window.events, window);
    expect(first).toBe(full(window.events));
    for (const incoming of [[event(6)], [event(1), event(2)], [{ ...event(4), raw: 'edited\n' }], [event(6), event(7)], [event(8, 'text')]]) {
      window = mergeReconciledEvents(window, incoming);
      expect(project(window.events, window)).toBe(full(window.events));
    }
    expect(first).toBe('screen 3\nnative\n');
    expect(project([event(100)])).toBe('screen 100\n');
    expect(project([])).toBe('');
  });

  it('does not read historical raw payloads on an append, prepend or unrelated live event', () => {
    const read = vi.fn(() => 'complete old screen\n');
    const old = { ...event(2), get raw() { return read(); } };
    let window = createEventWindow([old]);
    const project = createRawLogProjector();
    project(window.events, window); read.mockClear();
    for (const incoming of [[event(3)], [event(1)], [event(4, 'status')]]) {
      window = mergeReconciledEvents(window, incoming);
      expect(project(window.events, window)).toContain('complete old screen\n');
    }
    expect(read).not.toHaveBeenCalled();
  });
});
