import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type DockEvent } from './api';
import { useEventHistory } from './useEventHistory';
import type { EventWindow } from './event-history';
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
  fireEvent.click(await screen.findByText('200'));
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  const signal = loader.mock.calls[1]![2]!;
  view.rerender(<QueryClientProvider client={client}><Harness id="s2"/></QueryClientProvider>);
  expect(signal.aborted).toBe(true);
  await act(async () => release(Array.from({ length: 200 }, (_, i) => event(i + 1))));
  expect(client.getQueryData<EventWindow>(['events', 's1'])?.events).toHaveLength(200);
  expect(await screen.findByText('1')).toBeTruthy();
});
