import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';
import { api, type DockEvent, type Session, type Task } from './api';
import { useDockStore } from './store';
import { resetComposerDrafts } from './composer-draft';

class EventSourceStub {
  static instances: EventSourceStub[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  listeners = new Map<string, (message: MessageEvent<string>) => void>();
  closed = false;
  constructor(readonly url: string) { EventSourceStub.instances.push(this); }
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  emit(event: DockEvent) { this.listeners.get(event.type)?.({ data: JSON.stringify(event) } as MessageEvent<string>); }
  close() { this.closed = true; }
}
const task: Task = { id: 't1', sessionId: 's1', prompt: 'verify startup behavior', status: 'running', createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' };
const initialSession: Session = { id: 's1', agentId: 'codex', cwd: '/tmp/synthetic', state: 'thinking', runId: 'r1', permissionMode: 'full-trust', createdAt: task.createdAt, updatedAt: task.updatedAt };
const historical: DockEvent = { id: 'e10', sequence: 10, type: 'text', timestamp: task.createdAt, data: { role: 'user', text: task.prompt } };
const taskEvent: DockEvent = { id: 'e11', sequence: 11, type: 'task', timestamp: '2026-10-22T00:00:01Z', data: { task: { id: task.id, status: 'reconcile_required', revision: 2 } } };
const statusEvent: DockEvent = { id: 'e12', sequence: 12, type: 'status', timestamp: taskEvent.timestamp, data: { state: 'interrupted' } };
const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useDockStore.setState({ activeSessionId: undefined, rawVisible: false });
  resetComposerDrafts();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  EventSourceStub.instances = [];
});

it.each(['completed', 'reconcile_required'])('refreshes the full %s task after its initial snapshot settles', async status => {
  vi.stubGlobal('EventSource', EventSourceStub);
  window.history.replaceState(null, '', '/sessions/s1');
  let currentSession = initialSession;
  let currentTasks: Task[] = [task];
  let releaseTasks!: (value: Response) => void;
  let releaseHistory!: (value: DockEvent[]) => void;
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== '/api/sessions/s1/tasks') throw new Error(`Unexpected network access: ${String(input)}`);
    // api.tasks is real: verify it does not consume or pass Query's AbortSignal.
    expect(init?.signal).toBeUndefined();
    if (fetcher.mock.calls.length === 1) return new Promise<Response>(resolve => { releaseTasks = resolve; });
    return Promise.resolve(response(currentTasks));
  });
  vi.stubGlobal('fetch', fetcher);
  vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: true, required: false });
  vi.spyOn(api, 'agents').mockResolvedValue([{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' }]);
  vi.spyOn(api, 'sessions').mockImplementation(async () => [currentSession]);
  vi.spyOn(api, 'runSummaries').mockImplementation(async () => [{ sessionId: 's1', taskId: 't1', prompt: task.prompt, status: currentTasks[0]!.status, queuedCount: 0, updatedAt: currentTasks[0]!.updatedAt }]);
  const events = vi.spyOn(api, 'events').mockImplementation((_id, query) => query?.direction === 'backward' ? new Promise(resolve => { releaseHistory = resolve; }) : Promise.resolve([]));
  vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
  vi.spyOn(api, 'skills').mockResolvedValue([]);
  vi.spyOn(api, 'pluginCommands').mockResolvedValue([]);
  vi.spyOn(api, 'instances').mockResolvedValue({ instances: [] });
  vi.spyOn(api, 'sessionUsage').mockResolvedValue({ own: { entries: 0 }, subSteps: { entries: 0 } } as never);
  vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
  vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
  vi.spyOn(api, 'sessionCapabilities').mockResolvedValue({ observedAt: task.createdAt, protocol: 'acp', structuredApproval: 'available', terminal: 'available', turnRecovery: 'available', verification: 'available', localFileDelivery: 'available' });
  vi.spyOn(api, 'verifications').mockResolvedValue([]);
  vi.spyOn(api, 'turnDiffs').mockResolvedValue([]);
  vi.spyOn(api, 'workItems').mockResolvedValue({ items: [], templates: [] });
  vi.spyOn(api, 'workItemRequests').mockResolvedValue([]);
  vi.spyOn(api, 'automation').mockResolvedValue({ schedules: [], subscriptions: [], occurrences: [] });
  vi.spyOn(api, 'workspaceGroups').mockResolvedValue({ organization: { groups: [], directoryGroups: {}, sessionGroups: {} }, workspaces: [] });
  const unknown = vi.spyOn(api, 'unknownTasks').mockResolvedValue([{ taskId: task.id, status: 'reconcile_required', actionable: true, kind: 'attempt', target: 'attempt_1', submission: 'intent_recorded', reasonCode: 'RESULT_UNKNOWN', prompt: task.prompt, factLines: ['结果未知，需要人工决定'] }]);
  const client = new QueryClient();
  const view = render(<StrictMode><QueryClientProvider client={client}><App/></QueryClientProvider></StrictMode>);
  try {
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(['tasks', 's1'])).toBeUndefined();
    expect(EventSourceStub.instances).toHaveLength(0);
    expect(events.mock.calls.some(([, query]) => query?.direction === 'backward')).toBe(true);
    await act(async () => releaseHistory([historical]));
    await waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));
    const stream = EventSourceStub.instances[0]!;
    expect(stream.url).toContain('after=10');
    await act(async () => { stream.onopen?.(new Event('open')); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    currentSession = { ...initialSession, state: 'interrupted', updatedAt: taskEvent.timestamp };
    currentTasks = [{ ...task, status, updatedAt: taskEvent.timestamp }];
    act(() => { stream.emit({ ...taskEvent, data: { task: { ...taskEvent.data.task, status } } }); stream.emit(statusEvent); });
    await waitFor(() => expect(client.getQueryData<Session[]>(['sessions'])?.[0]?.state).toBe('interrupted'));
    expect(client.getQueryData(['tasks', 's1'])).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => releaseTasks(response([task])));
    await waitFor(() => expect(client.getQueryData<Task[]>(['tasks', 's1'])).toEqual(currentTasks));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(EventSourceStub.instances).toHaveLength(1);
    if (status === 'reconcile_required') {
      expect(await screen.findByRole('button', { name: '重新执行' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '标为已完成' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '标为失败' })).toBeTruthy();
      expect(unknown).toHaveBeenCalledTimes(1);
    } else {
      expect(unknown).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: '重新执行' })).toBeNull();
    }
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { view.unmount(); client.clear(); }
});
