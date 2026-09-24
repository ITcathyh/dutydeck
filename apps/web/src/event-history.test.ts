import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type DockEvent } from './api';
import { createEventWindow, loadEventHistory, mergeLiveEvent, newestSequence } from './event-history';

const event = (sequence: number, text = String(sequence)): DockEvent => ({ id: `e-${sequence}`, sequence, type: 'text', timestamp: '', data: { text } });

afterEach(() => vi.restoreAllMocks());

describe('complete event history', () => {
  it.each([0, 37, 1_205, 2_000])('automatically loads all %i events in order', async count => {
    const history = Array.from({ length: count }, (_, index) => event(index + 1));
    const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => history.filter(item => query?.before === undefined || item.sequence < query.before).slice(-query!.limit!));
    const result = await loadEventHistory('s1');
    expect(result.events).toEqual(history);
    expect(loader).toHaveBeenCalledTimes(Math.floor(count / 1_000) + 1);
    expect(loader).toHaveBeenNthCalledWith(1, 's1', { before: undefined, limit: 1_000, direction: 'backward' }, undefined);
    if (count > 1_000) expect(loader).toHaveBeenNthCalledWith(2, 's1', { before: count - 999, limit: 1_000, direction: 'backward' }, undefined);
  });

  it('rejects failed older pages instead of returning incomplete history', async () => {
    vi.spyOn(api, 'events').mockResolvedValueOnce(Array.from({ length: 1_000 }, (_, index) => event(index + 201))).mockRejectedValueOnce(new Error('offline'));
    await expect(loadEventHistory('s1')).rejects.toThrow('offline');
  });

  it('stops loading the old session when its query is cancelled', async () => {
    const controller = new AbortController();
    const loader = vi.spyOn(api, 'events').mockImplementationOnce(async () => {
      controller.abort();
      return Array.from({ length: 1_000 }, (_, index) => event(index + 201));
    });
    await expect(loadEventHistory('s1', controller.signal)).rejects.toThrow();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]?.[2]).toBe(controller.signal);
  });

  it('retains history beyond 800 events, sorts and deduplicates by sequence', () => {
    const history = Array.from({ length: 1_205 }, (_, index) => event(index + 1));
    const result = createEventWindow([...[...history].reverse(), event(1, 'updated')]);
    expect(result.events).toHaveLength(1_205);
    expect(result.events[0]?.data.text).toBe('updated');
    expect(result.events.map(item => item.sequence)).toEqual(history.map(item => item.sequence));
  });

  it('SSE updates and out-of-order events keep all earlier history', () => {
    let window = createEventWindow(Array.from({ length: 1_205 }, (_, index) => event(index + 1)));
    window = mergeLiveEvent(window, event(1_207));
    window = mergeLiveEvent(window, event(1_206));
    window = mergeLiveEvent(window, event(1_205, 'updated'));
    expect(window.events.map(item => item.sequence)).toEqual(Array.from({ length: 1_207 }, (_, index) => index + 1));
    expect(window.events[1_204]?.data.text).toBe('updated');
    expect(newestSequence(window)).toBe(1_207);
  });
});
