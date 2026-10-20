// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { api, type DockEvent, type Session, type Task } from './api';
import { useDockStore } from './store';
import { resetDrafts } from './draft-store';
import type { EventWindow } from './event-history';
import { toastStore } from './useToasts';

// Only transport boundaries and unrelated endpoints are stubbed. App, send/tasks
// API methods, QueryClient, useSessionStream, SessionStream, and timeline are real.
class ControlledEventSource {
  static instances: ControlledEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  listeners = new Map<string, (message: MessageEvent<string>) => void>();
  constructor(readonly url: string) { ControlledEventSource.instances.push(this); }
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void) { this.listeners.set(type, listener); }
  close() {}
  emit(event: DockEvent) { this.listeners.get(event.type)?.(new MessageEvent(event.type, { data: JSON.stringify(event) })); }
}
let client: QueryClient | undefined;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useDockStore.setState({ activeSessionId: undefined, rawVisible: false });
  resetDrafts();
  toastStore.clear();
  window.history.replaceState(null, '', '/');
});

const at = (n: number) => `2026-10-20T00:00:${String(n).padStart(2, '0')}.000Z`;
const queued: Task = { id: 'task-race', sessionId: 's1', prompt: '请回答一加一', status: 'queued', createdAt: at(1), updatedAt: at(1) };
const completed = { ...queued, status: 'completed', updatedAt: at(9) };
const finalText = '一加一等于二，任务已经完成。' + '以下是返回给用户的完整解释和验证结果。'.repeat(12);
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function unrelatedApi() {
  vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: true, required: false });
  vi.spyOn(api, 'agents').mockResolvedValue([{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'full-trust' }]);
  vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
  vi.spyOn(api, 'skills').mockResolvedValue([]);
  vi.spyOn(api, 'pluginCommands').mockResolvedValue([]);
  vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
  vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
  vi.spyOn(api, 'sessionCapabilities').mockResolvedValue({ observedAt: at(0), protocol: 'acp', structuredApproval: 'available', terminal: 'available', turnRecovery: 'available', verification: 'available', localFileDelivery: 'available' });
  vi.spyOn(api, 'verifications').mockResolvedValue([]);
  vi.spyOn(api, 'workItems').mockResolvedValue({ items: [], templates: [] });
  vi.spyOn(api, 'workItemRequests').mockResolvedValue([]);
  vi.spyOn(api, 'automation').mockResolvedValue({ schedules: [], subscriptions: [], occurrences: [] });
  vi.spyOn(api, 'workspaceGroups').mockResolvedValue({ organization: { groups: [], directoryGroups: {}, sessionGroups: {} }, workspaces: [] });
  vi.spyOn(api, 'instances').mockResolvedValue({ instances: [] });
  vi.spyOn(api, 'sessionUsage').mockResolvedValue({ own: { entries: 0 }, subSteps: { entries: 0 } } as never);
  vi.spyOn(api, 'turnDiffs').mockResolvedValue([]);
}

it.each(['running', 'completed'] as const)('keeps the %s task from SSE/refetch when the queued acknowledgement arrives late', async status => {
  unrelatedApi();
  ControlledEventSource.instances = [];
  vi.stubGlobal('EventSource', ControlledEventSource);
  window.history.replaceState(null, '', '/sessions/s1');
  let serverSession: Session = { id: 's1', agentId: 'codex', state: 'idle', cwd: '/tmp/isolated-workspace', permissionMode: 'full-trust', runId: 'run-s1', createdAt: at(0), updatedAt: at(0) };
  let serverTasks: Task[] = [];
  let serverEvents: DockEvent[] = [];
  const calls: string[] = [];
  let releaseSend!: (value: Response) => void;
  let sentBody: unknown;
  let holdTaskRefresh = false;
  let releaseTasks!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/api/sessions') return response([serverSession]);
    if (url.pathname === '/api/sessions/summaries') return response(serverTasks.map(task => ({ sessionId: 's1', taskId: task.id, prompt: task.prompt, status: task.status, queuedCount: task.status === 'queued' ? 1 : 0, updatedAt: task.updatedAt })));
    if (url.pathname === '/api/sessions/s1/tasks') return holdTaskRefresh ? new Promise<Response>(resolve => { releaseTasks = resolve; }) : response(serverTasks);
    if (url.pathname === '/api/sessions/s1/events') return response(serverEvents.filter(event => event.sequence > Number(url.searchParams.get('after') ?? 0)));
    if (url.pathname === '/api/sessions/s1/send') {
      sentBody = JSON.parse(String(init?.body));
      return new Promise<Response>(resolve => { releaseSend = resolve; });
    }
    throw new Error(`Unexpected fetch ${input}`);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
  await screen.findByRole('textbox', { name: '消息' });
  await waitFor(() => expect(ControlledEventSource.instances).toHaveLength(1));
  const stream = ControlledEventSource.instances[0]!;
  act(() => stream.onopen?.(new Event('open')));
  await waitFor(() => expect(client!.isFetching()).toBe(0));
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: queued.prompt } });
  await userEvent.click(await screen.findByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(sentBody).toEqual({ prompt: queued.prompt, mode: 'queue' }));
  expect(client.isMutating()).toBe(1);

  let sequence = 0;
  const emit = (type: string, data: unknown) => {
    const event: DockEvent = { id: `event-${++sequence}`, sequence, type, timestamp: at(sequence), taskId: queued.id, data };
    serverEvents.push(event);
    stream.emit(event);
    return event;
  };
  serverTasks = [{ ...queued, status: 'running', updatedAt: at(2) }];
  serverSession = { ...serverSession, state: 'thinking', updatedAt: at(3) };
  act(() => {
    emit('task', { task: queued });
    emit('task', { task: serverTasks[0] });
    emit('text', { role: 'user', text: queued.prompt, taskId: queued.id });
    emit('status', { state: 'thinking' });
    emit('thinking', { text: '计算答案。' });
  });
  await waitFor(() => expect(client!.getQueryData<Task[]>(['tasks', 's1'])?.[0]?.status).toBe('running'));
  const latest = status === 'completed' ? completed : serverTasks[0]!;
  serverTasks = [latest];
  serverSession = { ...serverSession, state: status === 'completed' ? 'completed' : 'thinking', updatedAt: latest.updatedAt };
  act(() => {
    if (status === 'completed') emit('text', { role: 'assistant', text: finalText, taskId: queued.id });
    emit('task', { task: latest });
    emit('status', { state: serverSession.state });
  });
  await waitFor(() => expect(client!.getQueryData<EventWindow>(['events', 's1'])?.events).toHaveLength(serverEvents.length));
  if (status === 'completed') await screen.findByRole('article', { name: 'Codex 最终输出' });
  await waitFor(() => expect(client!.isFetching()).toBe(0));
  expect(client.getQueryData<Task[]>(['tasks', 's1'])?.[0]).toEqual(latest);
  expect(screen.queryByRole('button', { name: `取消排队：${queued.prompt}` })).toBeNull();
  const taskFetchCount = calls.filter(call => call.endsWith('/s1/tasks')).length;
  holdTaskRefresh = true;
  // Only network delivery changes order; all query writes come from the App/hooks.
  await act(async () => releaseSend(response({ accepted: true, task: queued }, 202)));
  await waitFor(() => expect(client!.isMutating()).toBe(0));
  expect(client.getQueryData<Task[]>(['tasks', 's1'])?.[0]).toEqual(latest);
  expect(screen.queryByRole('button', { name: `取消排队：${queued.prompt}` })).toBeNull();
  if (status === 'completed') {
    expect(screen.getByRole('article', { name: 'Codex 最终输出' }).textContent).toContain(finalText);
    expect(screen.queryByText('Agent 未返回最终输出。')).toBeNull();
  }
  await waitFor(() => expect(client!.isFetching()).toBe(1));
  expect(calls.filter(call => call.endsWith('/s1/tasks')).length).toBeGreaterThan(taskFetchCount);
  await act(async () => releaseTasks(response(serverTasks)));
  await waitFor(() => expect(client!.isFetching()).toBe(0));
  expect(client.getQueryData<Task[]>(['tasks', 's1'])?.[0]).toEqual(latest);
});

it.each(['queue', 'steer'] as const)('shows a new %s acknowledgement immediately and preserves steering feedback', async mode => {
  unrelatedApi();
  ControlledEventSource.instances = [];
  vi.stubGlobal('EventSource', ControlledEventSource);
  window.history.replaceState(null, '', '/sessions/s1');
  const session: Session = { id: 's1', agentId: 'codex', state: 'thinking', cwd: '/tmp/isolated-workspace', permissionMode: 'full-trust', runId: 'run-s1', createdAt: at(0), updatedAt: at(0) };
  let sentBody: unknown;
  let holdTasks = false;
  let releaseTasks!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/sessions') return response([session]);
    if (url.pathname === '/api/sessions/summaries' || url.pathname === '/api/sessions/s1/events') return response([]);
    if (url.pathname === '/api/sessions/s1/tasks') return holdTasks ? new Promise<Response>(resolve => { releaseTasks = resolve; }) : response([]);
    if (url.pathname === '/api/sessions/s1/send') {
      sentBody = JSON.parse(String(init?.body));
      holdTasks = true;
      return response({ accepted: true, task: queued, ...(mode === 'steer' ? { steering: { outcome: 'unsupported' } } : {}) }, 202);
    }
    throw new Error(`Unexpected fetch ${input}`);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
  const input = await screen.findByRole('textbox', { name: '消息' });
  await waitFor(() => expect(client!.isFetching()).toBe(0));
  fireEvent.change(input, { target: { value: queued.prompt } });
  if (mode === 'steer') {
    await userEvent.click(screen.getByRole('button', { name: '排队' }));
    await userEvent.click(screen.getByRole('button', { name: '插话到当前这一轮' }));
  }
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(client!.isMutating()).toBe(0));
  expect(sentBody).toEqual({ prompt: queued.prompt, mode });
  expect(await screen.findByRole('button', { name: `取消排队：${queued.prompt}` })).toBeTruthy();
  expect((input as HTMLTextAreaElement).value).toBe('');
  expect(client.getQueryData<Task[]>(['tasks', 's1'])).toEqual([queued]);
  if (mode === 'steer') expect(toastStore.getSnapshot().find(toast => toast.key === 'steering')?.title).toBe('没有插话，这条指令在排队');
  await waitFor(() => expect(client!.isFetching()).toBe(1));
  await act(async () => releaseTasks(response([queued])));
  await waitFor(() => expect(client!.isFetching()).toBe(0));
  expect(screen.getByRole('button', { name: `取消排队：${queued.prompt}` })).toBeTruthy();
});
