import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type DockEvent } from './api';
import { createEventWindow, loadHistoryRange, loadProjectedHistory, mergeLiveEvent, newestSequence } from './event-history';

const event = (sequence: number, text = String(sequence)): DockEvent => ({ id: `e-${sequence}`, sequence, type: 'text', timestamp: '', data: { text } });

afterEach(() => vi.restoreAllMocks());

describe('projected event history', () => {
  it.each([0, 37, 1_205, 2_000])('loads only the canonical active suffix after the completed boundary for %i records', async count => {
    const history = Array.from({ length: count }, (_, index) => event(index + 1));
    const completed = Math.max(0, count - 37);
    const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => history.filter(item => item.sequence > query!.after!).slice(0, query!.limit!));
    const result = await loadProjectedHistory('s1', { turns: [], highWaterMark: count, liveAfter: completed });
    expect(result.events).toEqual(history.slice(completed));
    expect(result.highWaterMark).toBe(count);
    expect(result.hasOlder).toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenNthCalledWith(1, 's1', { after: completed, limit: 200, direction: 'forward' }, undefined);
  });

  it('rejects a failed active suffix instead of treating it as a complete empty history', async () => {
    vi.spyOn(api, 'events').mockRejectedValueOnce(new Error('offline'));
    await expect(loadProjectedHistory('s1', { turns: [], liveAfter: 10, highWaterMark: 11 })).rejects.toThrow('offline');
  });

  it('does not mark a short suffix complete below the known server watermark', async () => {
    vi.spyOn(api, 'events').mockResolvedValue([event(11)]);
    await expect(loadProjectedHistory('s1', { turns: [], liveAfter: 10, highWaterMark: 13 })).rejects.toThrow('尚未追平');
  });

  it('stops reading when its session query is cancelled', async () => {
    const controller = new AbortController();
    const loader = vi.spyOn(api, 'events').mockImplementationOnce(async () => { controller.abort(); return [event(1)]; });
    await expect(loadHistoryRange('s1', 0, 1, controller.signal)).rejects.toThrow();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]?.[2]).toBe(controller.signal);
  });

  it('reads a complete cross-page range and refuses sparse canonical details', async () => {
    const history = Array.from({ length: 405 }, (_, index) => event(index + 1));
    const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => history.filter(item => item.sequence > query!.after! && item.sequence < query!.before!).slice(0, query!.limit!));
    expect(await loadHistoryRange('s1', 0, 405)).toEqual(history);
    expect(loader.mock.calls.map(call => call[1]?.after)).toEqual([0, 200, 400]);
    loader.mockResolvedValue([event(1), event(3)]);
    await expect(loadHistoryRange('s1', 0, 3)).rejects.toThrow('记录不连续');
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
