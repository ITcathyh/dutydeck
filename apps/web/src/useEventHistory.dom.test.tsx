import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type DockEvent } from './api';
import { useEventHistory } from './useEventHistory';
import { mergeLiveEvent, type EventWindow } from './event-history';
const event = (sequence: number): DockEvent => ({ id: `e${sequence}`, sequence, type: 'text', timestamp: '', data: { text: String(sequence) } });
afterEach(() => vi.restoreAllMocks());
it('aborts an older page on session switch without late cache writes', async () => {
  let release!: (events: DockEvent[]) => void;
  const loader = vi.spyOn(api, 'events').mockImplementation(async (id, query) => {
    if (query?.before) return new Promise(resolve => { release = resolve; });
    return id === 's1' ? Array.from({ length: 200 }, (_, i) => event(i + 201)) : [event(1)];
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness({ id }: { id: string }) {
    const result = useEventHistory(id, true);
    return <button onClick={result.loadOlder}>{result.data?.events.length ?? 0}</button>;
  }
  const view = render(<QueryClientProvider client={client}><Harness id="s1"/></QueryClientProvider>);
  expect(await screen.findByText('200')).toBeTruthy();
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  const signal = loader.mock.calls[1]![2]!;
  view.rerender(<QueryClientProvider client={client}><Harness id="s2"/></QueryClientProvider>);
  expect(signal.aborted).toBe(true);
  await act(async () => release(Array.from({ length: 200 }, (_, i) => event(i + 1))));
  expect(client.getQueryData<EventWindow>(['events', 's1'])?.events).toHaveLength(200);
  expect(await screen.findByText('1')).toBeTruthy();
});


it('automatically reads all 1205 events serially while merging live events without duplicates', async () => {
  const history = Array.from({ length: 1205 }, (_, index) => event(index + 1));
  let inFlight = 0, maxInFlight = 0;
  let release!: () => void;
  const firstOlder = new Promise<void>(resolve => { release = resolve; });
  const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    if (query?.before === 1006) await firstOlder;
    const page = history.filter(event => !query?.before || event.sequence < query.before).slice(-query!.limit!);
    inFlight--; return page;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() { const history = useEventHistory('auto', true); return <p>{history.data?.events.length} {history.data?.hasOlder ? 'loading' : 'complete'}</p>; }
  render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  await screen.findByText('200 loading');
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  act(() => client.setQueryData<EventWindow>(['events', 'auto'], current => mergeLiveEvent(current, event(1206))));
  await act(async () => release());
  await screen.findByText('1206 complete');
  expect(client.getQueryData<EventWindow>(['events', 'auto'])?.events).toEqual([...history, event(1206)]);
  expect(loader).toHaveBeenCalledTimes(7);
  expect(maxInFlight).toBe(1);
});

it('keeps loaded records after an older-page failure and resumes the serial load on retry', async () => {
  const history = Array.from({ length: 405 }, (_, index) => event(index + 1));
  const loader = vi.spyOn(api, 'events').mockImplementation(async (_id, query) => {
    if (query?.before === 206) throw new Error('offline');
    return history.slice(-200);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() { const history = useEventHistory('retry', true); return <><p>{history.data?.events.length}</p>{history.olderError && <button onClick={history.loadOlder}>retry {history.olderError}</button>}</>; }
  render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  await screen.findByText('retry offline');
  expect(client.getQueryData<EventWindow>(['events', 'retry'])?.events).toEqual(history.slice(-200));
  expect(loader).toHaveBeenCalledTimes(2);
  loader.mockImplementation(async (_id, query) => history.filter(event => !query?.before || event.sequence < query.before).slice(-query!.limit!));
  fireEvent.click(screen.getByText('retry offline'));
  await screen.findByText('405');
  expect(client.getQueryData<EventWindow>(['events', 'retry'])?.events).toEqual(history);
  expect(loader).toHaveBeenCalledTimes(4);
});


it('finishes background pagination while continuous live frames arrive', async () => {
  const history = Array.from({ length: 1205 }, (_, index) => event(index + 1));
  vi.spyOn(api, 'events').mockImplementation(async (_id, query) => history.filter(event => !query?.before || event.sequence < query.before).slice(-query!.limit!));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() { const result = useEventHistory('busy', true); return <p>{result.data ? 'ready' : 'waiting'}</p>; }
  render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
  await screen.findByText('ready');
  let emitted = 0;
  const timer = setInterval(() => act(() => {
    emitted++;
    client.setQueryData<EventWindow>(['events', 'busy'], current => mergeLiveEvent(current, event(1205 + emitted)));
  }), 2);
  try {
    await waitFor(() => expect(client.getQueryData<EventWindow>(['events', 'busy'])?.hasOlder).toBe(false), { timeout: 3000 });
    expect(emitted).toBeGreaterThan(1);
    expect(client.getQueryData<EventWindow>(['events', 'busy'])?.events).toEqual([...history, ...Array.from({ length: emitted }, (_, index) => event(1206 + index))]);
  } finally { clearInterval(timer); }
});
