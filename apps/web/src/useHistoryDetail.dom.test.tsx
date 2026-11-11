import { QueryClient, QueryClientProvider, QueryObserver, onlineManager } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type HistoryTurnSummary } from './api';
import { loadTurnHistory } from './event-history';
import { ShareContext, ShareTurn, useHistoryTurnDetail } from './components/ShareTurn';

const summary = (sequence = 1): HistoryTurnSummary => ({ id: `turn-${sequence}`, firstSequence: sequence, lastSequence: sequence, timestamp: '', status: 'completed', prompt: { text: 'instruction', truncated: false }, output: { text: 'preview', truncated: true }, toolCount: 0, artifactReferences: [] });
const body = (sequence: number, text: string) => ({ id: `event-${sequence}`, sequence, type: 'text', timestamp: '', data: { text } });
const clients: QueryClient[] = [];
const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return { client, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
};
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); onlineManager.setOnline(true); vi.restoreAllMocks(); });

it('demonstrates that the old enabled=false path keeps a fetched million-character body and its observer', async () => {
  const { client } = setup();
  vi.spyOn(api, 'events').mockResolvedValue([body(1, 'x'.repeat(1_000_000))]);
  const options = { queryKey: ['history-detail', 'baseline', 1, 1], queryFn: ({ signal }: { signal: AbortSignal }) => loadTurnHistory('baseline', summary(), signal), staleTime: Infinity };
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  await observer.refetch();
  observer.setOptions({ ...options, enabled: false });
  expect(observer.getCurrentResult().data?.[0]?.data.text.length).toBe(1_000_000);
  expect(client.getQueryCache().find({ queryKey: options.queryKey })?.getObserversCount()).toBe(1);
  unsubscribe();
});

it('releases canonical bodies and projections after each of 24 real open/close reads, and reloads on reopening', async () => {
  const { client, wrapper } = setup();
  const loader = vi.spyOn(api, 'events').mockImplementation(async (_session, range) => [body(range!.after! + 1, 'x'.repeat(250_000))]);
  const hook = renderHook(({ turn, open }) => useHistoryTurnDetail('load', turn, [], open), { wrapper, initialProps: { turn: summary(), open: false } });
  const retained: number[] = [];
  for (let index = 1; index <= 24; index++) {
    hook.rerender({ turn: summary(index), open: true });
    await waitFor(() => expect(hook.result.current.query.isSuccess).toBe(true));
    expect(hook.result.current.sections?.length).toBeGreaterThan(0);
    expect(hook.result.current.query.data?.[0]?.data.text.length).toBe(250_000);
    hook.rerender({ turn: summary(index), open: false });
    await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['history-detail'] })).toHaveLength(0));
    expect(hook.result.current.query.data).toBeUndefined();
    expect(hook.result.current.sections).toBeUndefined();
    retained.push(client.getQueryCache().findAll({ queryKey: ['history-detail'] }).reduce((total, query) => total + JSON.stringify(query.state.data ?? '').length, 0));
  }
  expect(Math.max(...retained)).toBe(0);
  hook.rerender({ turn: summary(1), open: true });
  await waitFor(() => expect(hook.result.current.query.isSuccess).toBe(true));
  expect(loader).toHaveBeenCalledTimes(25);
});

it('keeps shared readers, cancels the final in-flight reader, and isolates its late response', async () => {
  const { client, wrapper } = setup();
  let complete!: () => void;
  let signal: AbortSignal | undefined;
  vi.spyOn(api, 'events').mockImplementation(async (_id, _range, requestSignal) => {
    signal = requestSignal;
    await new Promise<void>(resolve => { complete = resolve; });
    return [body(1, 'late answer')];
  });
  const reader = ({ open }: { open: boolean }) => useHistoryTurnDetail('shared', summary(), [], open);
  const first = renderHook(reader, { wrapper, initialProps: { open: true } });
  const second = renderHook(reader, { wrapper, initialProps: { open: true } });
  first.rerender({ open: false });
  await act(async () => {});
  expect(signal?.aborted).toBe(false);
  expect(client.getQueryCache().findAll({ queryKey: ['history-detail'] })).toHaveLength(1);
  second.rerender({ open: false });
  await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['history-detail'] })).toHaveLength(0));
  expect(signal?.aborted).toBe(true);
  await act(async () => complete());
  expect(client.getQueryCache().findAll({ queryKey: ['history-detail'] })).toHaveLength(0);
  expect(first.result.current.sections).toBeUndefined();
  expect(second.result.current.sections).toBeUndefined();
});

it('preserves the offline copy, reopens without a fetch, and releases it after reconnecting closed', async () => {
  const { client, wrapper } = setup();
  const loader = vi.spyOn(api, 'events').mockResolvedValue([body(1, 'offline final with attachment')]);
  const hook = renderHook(({ open }) => useHistoryTurnDetail('offline', summary(), [], open), { wrapper, initialProps: { open: true } });
  await waitFor(() => expect(hook.result.current.query.isSuccess).toBe(true));
  act(() => onlineManager.setOnline(false));
  hook.rerender({ open: false });
  await act(async () => {});
  expect(client.getQueryData(['history-detail', 'offline', 1, 1])).toBeTruthy();
  hook.rerender({ open: true });
  expect(hook.result.current.query.data?.[0]?.data.text).toBe('offline final with attachment');
  expect(loader).toHaveBeenCalledTimes(1);
  hook.rerender({ open: false });
  act(() => onlineManager.setOnline(true));
  await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['history-detail'] })).toHaveLength(0));
});

it('keeps a completed shared reader through StrictMode effect cleanup and another reader unmounting', async () => {
  const { client, wrapper: Provider } = setup();
  const wrapper = ({ children }: { children: ReactNode }) => <StrictMode><Provider>{children}</Provider></StrictMode>;
  vi.spyOn(api, 'events').mockResolvedValue([body(1, 'shared final')]);
  const reader = () => useHistoryTurnDetail('strict', summary(), [], true);
  const first = renderHook(reader, { wrapper });
  await waitFor(() => expect(first.result.current.query.isSuccess).toBe(true));
  const second = renderHook(reader, { wrapper });
  await act(async () => {});
  first.unmount();
  await act(async () => {});
  expect(second.result.current.query.data?.[0]?.data.text).toBe('shared final');
  expect(client.getQueryCache().findAll({ queryKey: ['history-detail'] })).toHaveLength(1);
  second.unmount();
  await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['history-detail'] })).toHaveLength(0));
});

it('releases an offline retained copy on reconnect even after every reader has unmounted', async () => {
  const { client, wrapper } = setup();
  vi.spyOn(api, 'events').mockResolvedValue([body(1, 'offline departed')]);
  const hook = renderHook(() => useHistoryTurnDetail('departed', summary(), [], true), { wrapper });
  await waitFor(() => expect(hook.result.current.query.isSuccess).toBe(true));
  act(() => onlineManager.setOnline(false));
  hook.unmount();
  await act(async () => {});
  expect(client.getQueryData(['history-detail', 'departed', 1, 1])).toBeTruthy();
  act(() => onlineManager.setOnline(true));
  expect(client.getQueryCache().findAll({ queryKey: ['history-detail'] })).toHaveLength(0);
});

it('releases a share record when its containing earlier turn collapses, and reloads when shown again', async () => {
  const { client, wrapper } = setup();
  const loader = vi.spyOn(api, 'events').mockResolvedValue([body(1, 'complete answer')]);
  render(<ShareContext.Provider value={{ sessionId: 'share-collapse', title: 'latest question', modelLabel: 'Agent', status: { label: '已完成', tone: 'done' }, running: false, copied: false, copyConclusion() {} }}>
    <ShareTurn id="earlier" summary={{ ...summary(), timestamp: '2026-01-01T00:00:00Z' }} sections={[]} earlier={{ index: 0, count: 1, width: 'clock', open: true, onToggle() {} }}/>
  </ShareContext.Provider>, { wrapper });
  fireEvent.click(screen.getByRole('button', { name: /instruction/ }));
  fireEvent.click(screen.getByRole('button', { name: /^执行过程/ }));
  await waitFor(() => expect(client.getQueryData(['history-detail', 'share-collapse', 1, 1])).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /instruction/ }));
  await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['history-detail'] })).toHaveLength(0));
  fireEvent.click(screen.getByRole('button', { name: /instruction/ }));
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
});
