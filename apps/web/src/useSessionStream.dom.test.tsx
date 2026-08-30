import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type DockEvent, type Session } from './api';
import { createEventWindow } from './event-history';
import type { MockableEventSource } from './sse';
import { useSessionStream } from './useSessionStream';

const event = (sequence: number): DockEvent => ({ id: `e${sequence}`, sequence, type: 'text', timestamp: '', data: { text: String(sequence) } });
const session: Session = { id: 's1', agentId: 'codex', state: 'idle', cwd: '/repo', runId: 'r1', createdAt: '', updatedAt: '' };

class MockEventSource implements MockableEventSource {
  static instances: MockEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, (message: MessageEvent<string>) => void>();
  constructor(readonly url: string) { MockEventSource.instances.push(this); }
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  emit(type: string, value: DockEvent) { this.listeners.get(type)?.({ data: JSON.stringify(value) } as MessageEvent<string>); }
  close() {}
}

beforeEach(() => { MockEventSource.instances = []; vi.stubGlobal('EventSource', MockEventSource); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('useSessionStream reconciliation', () => {
  it('open/reconnect 校准 tasks，并在 sequence gap 时拉取缺失事件', async () => {
    const taskLoader = vi.fn(async () => []); const sessionLoader = vi.fn(async () => [session]);
    const eventLoader = vi.spyOn(api, 'events').mockResolvedValueOnce([event(11)]).mockResolvedValueOnce([event(12), event(13)]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['events', 's1'], createEventWindow([event(10)], true));
    function Harness() {
      useQuery({ queryKey: ['tasks', 's1'], queryFn: taskLoader });
      useQuery({ queryKey: ['sessions'], queryFn: sessionLoader });
      return <span>{useSessionStream('s1', 'r1', true)}</span>;
    }
    render(<QueryClientProvider client={client}><Harness/></QueryClientProvider>);
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(taskLoader).toHaveBeenCalledTimes(1));
    act(() => MockEventSource.instances[0]!.onopen?.(new Event('open')));
    await waitFor(() => expect(screen.getByText('open')).toBeTruthy());
    await waitFor(() => expect(taskLoader.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(eventLoader).toHaveBeenCalledWith('s1', { after: 10, limit: 200, direction: 'forward' }));
    await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.at(-1)?.sequence).toBe(11));
    act(() => MockEventSource.instances[0]!.emit('text', event(13)));
    await waitFor(() => expect(eventLoader).toHaveBeenCalledWith('s1', { after: 11, limit: 200, direction: 'forward' }));
    await waitFor(() => expect(client.getQueryData<ReturnType<typeof createEventWindow>>(['events', 's1'])?.events.map(item => item.sequence)).toEqual([10, 11, 12, 13]));
  });
});
