import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type DockEvent } from './api';
import { completeEventHistory, createCompleteHistoryProjector, createEventWindow, loadHistoryRange, loadProjectedHistory, mergeLiveEvent, mergeReconciledEvents, newestSequence } from './event-history';

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
    expect(loader).toHaveBeenNthCalledWith(1, 's1', { after: completed, limit: 1000, direction: 'forward' }, undefined);
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

  it('reads a complete cross-page range', async () => {
    const history = Array.from({ length: 2005 }, (_, index) => event(index + 1));
    const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => history.filter(item => item.sequence > query!.after! && item.sequence < query!.before!).slice(0, query!.limit!));
    expect(await loadHistoryRange('s1', 0, 2005)).toEqual(history);
    expect(loader.mock.calls.map(call => call[1]?.after)).toEqual([0, 1000, 2000]);
  });

  it('continues after pruned holes, including across page boundaries', async () => {
    // Pruned raw terminal output leaves holes; everything still stored is returned in order.
    const history = Array.from({ length: 2250 }, (_, index) => event(index + 1)).filter(item => item.sequence % 3 !== 0 && item.sequence !== 1501);
    const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => history.filter(item => item.sequence > query!.after! && (query!.before === undefined || item.sequence < query!.before)).slice(0, query!.limit!));
    expect(await loadHistoryRange('s1', 0, 2249)).toEqual(history);
    expect(loader.mock.calls.map(call => call[1]?.after)).toEqual([0, history[999]!.sequence]);
    expect(await loadHistoryRange('s1', 2, 7)).toEqual([event(4), event(5), event(7)]);
    expect((await loadProjectedHistory('s1', { turns: [], liveAfter: 2240, highWaterMark: 2249 })).events.map(item => item.sequence)).toEqual([2242, 2243, 2245, 2246, 2248, 2249]);
  });

  it('returns every stored record in range regardless of page boundaries', async () => {
    // Exactly two full pages, then holes: the result must equal the stored range, not depend on page size.
    const history = Array.from({ length: 3_100 }, (_, index) => event(index + 1)).filter(item => item.sequence <= 2_000 || item.sequence % 7 !== 0);
    const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => history.filter(item => item.sequence > query!.after! && (query!.before === undefined || item.sequence < query!.before)).slice(0, query!.limit!));
    expect(await loadHistoryRange('s1', 0)).toEqual(history);
    expect(loader.mock.calls.map(call => call[1]?.after)).toEqual([0, 1_000, 2_000]);
    loader.mockClear();
    // A full final page that reaches `through` stops without an extra empty request.
    expect(await loadHistoryRange('s1', 0, 2_000)).toEqual(history.slice(0, 2_000));
    expect(loader.mock.calls.map(call => call[1]?.after)).toEqual([0, 1_000]);
    loader.mockClear();
    // An unbounded read ending on an exact full page needs one empty page to confirm the end.
    vi.spyOn(api, 'events').mockImplementation(async (_id, query) => history.slice(0, 2_000).filter(item => item.sequence > query!.after!).slice(0, query!.limit!));
    expect(await loadHistoryRange('s1', 0)).toEqual(history.slice(0, 2_000));
  });

  it('rejects a short page that ends before the requested range end', async () => {
    const history = Array.from({ length: 1_500 }, (_, index) => event(index + 1));
    vi.spyOn(api, 'events').mockImplementation(async (_id, query) => history.filter(item => item.sequence > query!.after!).slice(0, Math.min(query!.limit!, 999)));
    await expect(loadHistoryRange('s1', 0, 1_500)).rejects.toThrow('记录尚未读取完整');
  });

  it.each([
    ['a page that does not move past the cursor', [event(4)]],
    ['records out of order', [event(6), event(5)]],
    ['a repeated record', [event(5), event(5)]],
    ['a record beyond the requested end', [event(5), event(9)]]
  ])('rejects %s instead of treating it as a pruned hole', async (_name, page) => {
    vi.spyOn(api, 'events').mockResolvedValue(page);
    await expect(loadHistoryRange('s1', 4, 8)).rejects.toThrow('分页结果异常');
  });

  it('rejects a read that stops before the requested end or the known watermark', async () => {
    vi.spyOn(api, 'events').mockResolvedValue([event(2), event(4)]);
    await expect(loadHistoryRange('s1', 0, 6)).rejects.toThrow('记录尚未读取完整');
    await expect(loadProjectedHistory('s1', { turns: [], liveAfter: 0, highWaterMark: 6 })).rejects.toThrow('尚未追平');
  });

  it('keeps a complete read with pruned holes and only the live events that continue it', () => {
    const complete = [event(1), event(3), event(6)];
    expect(completeEventHistory(complete, [event(6, 'live'), event(7), event(8)])?.map(item => [item.sequence, item.data.text])).toEqual([[1, '1'], [3, '3'], [6, 'live'], [7, '7'], [8, '8']]);
    // A live hole after the complete read is still a gap the stream has not recovered yet.
    expect(completeEventHistory(complete, [event(7), event(9)])?.map(item => item.sequence)).toEqual([1, 3, 6, 7]);
    expect(completeEventHistory([], [event(1), event(3)])?.map(item => item.sequence)).toEqual([1]);
    expect(completeEventHistory(undefined, [event(1)])).toBeUndefined();
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

  it('keeps the fallback deduplication semantics for NaN sequences', () => {
    const first = event(Number.NaN, 'first');
    const second = event(Number.NaN, 'second');
    const result = mergeReconciledEvents(createEventWindow([event(1)]), [first, second]);
    expect(result.events.filter(item => Number.isNaN(item.sequence))).toEqual([second]);
  });

  it('matches completeEventHistory while appending only the contiguous live tail', () => {
    const complete = [event(1), event(3), event(5)];
    const project = createCompleteHistoryProjector();
    let live = createEventWindow([event(5, 'live')]);
    let result = project(complete, live)!;
    expect(result.events).toEqual(completeEventHistory(complete, live.events));
    const steps = [event(6), event(8), event(7), event(9), event(4, 'late')];
    for (const next of steps) {
      const previous = result;
      live = mergeLiveEvent(live, next);
      result = project(complete, live)!;
      expect(result.events).toEqual(completeEventHistory(complete, live.events));
      if (next.sequence === 8) expect(result).toBe(previous);
      if (next.sequence === 7) expect(result.changes?.map(item => item.sequence)).toEqual([7, 8]);
    }
    expect(project(complete, live)).toBe(result);
    expect(project(undefined, live)).toBeUndefined();
  });
});
