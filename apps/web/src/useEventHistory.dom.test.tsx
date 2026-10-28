import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type DockEvent, type HistoryOutline } from './api';
import { useEventHistory } from './useEventHistory';
import { mergeLiveEvent, type EventWindow } from './event-history';
const event = (sequence: number): DockEvent => ({ id: `e${sequence}`, sequence, type: 'text', timestamp: '', data: { text: String(sequence) } });
const outline: HistoryOutline = { turns: [{ id: 'e1', taskId: 't1', firstSequence: 1, lastSequence: 1200, timestamp: '', status: 'completed', prompt: { text: 'prompt', truncated: false }, output: { text: 'summary', truncated: true }, toolCount: 20, artifactReferences: [] }], highWaterMark: 1205, liveAfter: 1200 };
afterEach(() => vi.restoreAllMocks());
it('loads only the active suffix, keeps summaries separate and merges new live events', async () => {
  vi.spyOn(api, 'sessionHistory').mockResolvedValue(outline);
  const history = Array.from({ length: 1205 }, (_, i) => event(i + 1));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => { await gate; return history.filter(event => event.sequence > query!.after!).slice(0, query!.limit); });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() { const result = useEventHistory('s', true); return <p>{result.data?.events.length ?? 0}</p>; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
  act(() => client.setQueryData<EventWindow>(['events', 's'], current => mergeLiveEvent(current, event(1206))));
  await act(async () => release());
  await screen.findByText('6');
  expect(client.getQueryData<EventWindow>(['events', 's'])?.events).toEqual([...history.slice(1200), event(1206)]);
  expect(client.getQueryData<EventWindow>(['events', 's'])?.outline).toEqual(outline);
  expect(loader).toHaveBeenCalledTimes(1);
  expect(loader.mock.calls[0]?.[1]).toEqual({ after: 1200, limit: 200, direction: 'forward' });
  view.unmount(); client.clear();
});
it('aborts an active suffix read on session switch without a late cache write', async () => {
  vi.spyOn(api, 'sessionHistory').mockResolvedValue({ ...outline, highWaterMark: 0, liveAfter: 0, turns: [] });
  let release!: (events: DockEvent[]) => void;
  const loader = vi.spyOn(api, 'events').mockImplementation((id) => id === 's1' ? new Promise(resolve => { release = resolve; }) : Promise.resolve([event(1)]));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness({ id }: { id: string }) { const result = useEventHistory(id, true); return <p>{result.data?.events.length ?? 0}</p>; }
  const view = render(<QueryClientProvider client={client}><Harness id="s1"/></QueryClientProvider>);
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
  view.rerender(<QueryClientProvider client={client}><Harness id="s2"/></QueryClientProvider>);
  expect(loader.mock.calls[0]?.[2]?.aborted).toBe(true);
  await act(async () => release([event(1)]));
  await screen.findByText('1');
  expect(client.getQueryData(['events', 's1'])).toBeUndefined();
  view.unmount(); client.clear();
});
it('explicitly reads all canonical pages for raw copy/export, reports failures and allows retry', async () => {
  vi.spyOn(api, 'sessionHistory').mockResolvedValue(outline);
  const history = Array.from({ length: 1205 }, (_, i) => event(i + 1));
  let fail = true, inFlight = 0, maxInFlight = 0;
  const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try { if (query!.after === 200 && fail) throw new Error('offline'); return history.filter(event => event.sequence > query!.after!).slice(0, query!.limit); }
    finally { inFlight--; }
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() { const result = useEventHistory('s', true); return <><p>active {result.data?.events.length}</p><p>raw {result.rawEvents?.length ?? 0}</p><button onClick={() => void result.loadAll()}>read raw</button>{result.rawError && <p>{result.rawError}</p>}</>; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  await screen.findByText('active 5'); expect(loader).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('read raw')); await screen.findByText('offline');
  expect(client.getQueryData<EventWindow>(['events', 's'])?.events).toEqual(history.slice(1200));
  fail = false; fireEvent.click(screen.getByText('read raw')); await screen.findByText('raw 1205');
  expect(client.getQueryData<EventWindow>(['events', 's'])?.events).toHaveLength(5);
  expect(maxInFlight).toBe(1);
  view.unmount(); client.clear();
});

it('freezes a full-read watermark even when the active session keeps appending events', async () => {
  vi.spyOn(api, 'sessionHistory').mockResolvedValue({ ...outline, highWaterMark: 405, liveAfter: 405 });
  let history = Array.from({ length: 405 }, (_, i) => event(i + 1));
  const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => {
    const page = history.filter(event => event.sequence > query!.after! && (query!.before === undefined || event.sequence < query!.before)).slice(0, query!.limit);
    if (query!.after! < 405) history = [...history, ...Array.from({ length: 200 }, (_, i) => event(history.length + i + 1))];
    return page;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() { const result = useEventHistory('s', true); return <><p>active {result.data?.events.length}</p><p>raw {result.rawEvents?.length ?? 0}</p><button onClick={() => void result.loadAll()}>read full</button></>; }
  const view = render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  await screen.findByText('active 0');
  fireEvent.click(screen.getByText('read full'));
  await screen.findByText('raw 405');
  expect(loader.mock.calls.slice(1).map(call => call[1])).toEqual([0, 200, 400].map(after => ({ after, before: 406, limit: 200, direction: 'forward' })));
  expect(history.length).toBeGreaterThan(405);
  view.unmount(); client.clear();
});
