import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { api, type DockEvent, type Session } from './api';
import * as composerUtils from './composer-utils';
import { mergeReconciledEvents, type EventWindow } from './event-history';
import type { TimelineViewProps } from './components/TimelineView';
import { useDockStore } from './store';
import { resetComposerDrafts } from './composer-draft';

const timelineRenders = vi.hoisted(() => [] as TimelineViewProps[]);
vi.mock('./composer-utils', async importOriginal => {
  const original = await importOriginal<typeof import('./composer-utils')>();
  return { ...original, currentContextStats: vi.fn(original.currentContextStats), commandsFromEvents: vi.fn(original.commandsFromEvents) };
});
vi.mock('./useSessionStream', () => ({ useSessionStream: () => 'open' }));
vi.mock('./components/TimelineView', async importOriginal => {
  const original = await importOriginal<typeof import('./components/TimelineView')>();
  return { ...original, TimelineView: (props: TimelineViewProps) => {
    timelineRenders.push(props);
    return <original.TimelineView {...props}/>;
  } };
});

let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  timelineRenders.length = 0;
  useDockStore.setState({ activeSessionId: undefined, rawVisible: false });
  resetComposerDrafts();
  Object.keys(window.localStorage).filter(key => key.startsWith('dutydeck:view:')).forEach(key => window.localStorage.removeItem(key));
  window.history.replaceState(null, '', '/');
});

function mockAppApi(sessions: Session[]) {
  vi.spyOn(api, 'agents').mockResolvedValue([{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'ask' }]);
  vi.spyOn(api, 'sessions').mockResolvedValue(sessions);
  vi.spyOn(api, 'runSummaries').mockResolvedValue(['s1', 's2'].map(id => ({ sessionId: id, taskId: `task-${id}`, prompt: `任务 ${id}`, status: 'running', queuedCount: 0, updatedAt: sessions[0]!.updatedAt })));
  vi.spyOn(api, 'events').mockImplementation(async id => [{ id: `event-${id}`, sequence: 1, type: 'permission_request', timestamp: '2026-10-23T00:00:00Z', data: { id: `permission-${id}`, title: `授权 ${id}`, status: 'pending' } }]);
  vi.spyOn(api, 'tasks').mockResolvedValue([]);
  vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
  vi.spyOn(api, 'skills').mockResolvedValue([]);
  vi.spyOn(api, 'pluginCommands').mockResolvedValue([]);
  vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
  vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
  vi.spyOn(api, 'sessionCapabilities').mockResolvedValue({ observedAt: sessions[0]!.createdAt, protocol: 'acp', structuredApproval: 'available', terminal: 'available', turnRecovery: 'available', verification: 'available', localFileDelivery: 'available' });
  vi.spyOn(api, 'verifications').mockResolvedValue([]);
  vi.spyOn(api, 'turnDiffs').mockResolvedValue([]);
  vi.spyOn(api, 'workItems').mockResolvedValue({ items: [], templates: [] });
  vi.spyOn(api, 'workItemRequests').mockResolvedValue([]);
  vi.spyOn(api, 'automation').mockResolvedValue({ schedules: [], subscriptions: [], occurrences: [] });
  vi.spyOn(api, 'workspaceGroups').mockResolvedValue({ organization: { groups: [], directoryGroups: {}, sessionGroups: {} }, workspaces: [] });
  vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: true, required: false });
  vi.spyOn(api, 'instances').mockResolvedValue({ instances: [] });
  vi.spyOn(api, 'sessionUsage').mockResolvedValue({ own: { entries: 0 }, subSteps: { entries: 0 } } as never);
}

it('keeps the permission callback stable while typing and targets the selected session after navigation', async () => {
  const sessions: Session[] = ['s1', 's2', 'background'].map(id => ({ id, agentId: 'codex', state: 'waiting_permission', cwd: `/tmp/${id}`, runId: `run-${id}`, permissionMode: 'ask', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', ...(id === 'background' ? { source: 'work_item' } : {}) }));
  window.history.replaceState(null, '', '/sessions/s1');
  mockAppApi(sessions);
  const historicalOutline = { turns: [{ id: 'old-summary', taskId: 'old-task', firstSequence: 1, lastSequence: 5, timestamp: '', status: 'completed', prompt: { text: '旧历史指令', truncated: false }, output: { text: '旧历史结果', truncated: false }, toolCount: 0, artifactReferences: [] }], highWaterMark: 6, liveAfter: 5 };
  vi.mocked(api.sessionHistory).mockImplementation(async id => id === 's1' ? historicalOutline : { turns: [], highWaterMark: 1, liveAfter: 0 });
  vi.mocked(api.events).mockImplementation(async id => [{ id: 'event-' + id, sequence: id === 's1' ? 6 : 1, type: 'permission_request', timestamp: '2026-10-23T00:00:00Z', data: { id: 'permission-' + id, title: '授权 ' + id, status: 'pending' } }]);
  const permission = vi.spyOn(api, 'permission').mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
  await screen.findByText('授权 s1');
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const initialCallback = timelineRenders.at(-1)!.onResolvePermission;
  expect(initialCallback).toBeTypeOf('function');
  const beforeTyping = timelineRenders.length;
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '输入新的问题' } });
  await waitFor(() => expect(timelineRenders.length).toBeGreaterThan(beforeTyping));
  expect(timelineRenders.slice(beforeTyping).every(props => props.onResolvePermission === initialCallback)).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: '允许本次' }));
  await waitFor(() => expect(permission).toHaveBeenCalledWith('s1', 'permission-s1', true));
  expect(client.getQueryData<EventWindow>(['events', 's1'])?.outline).toEqual(historicalOutline);
  expect(client.getQueryData<EventWindow>(['events', 's1'])?.highWaterMark).toBe(6);
  expect(screen.getByText('旧历史指令')).toBeTruthy();
  expect(screen.getByText('旧历史结果')).toBeTruthy();

  const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
  await userEvent.click(within(navigation).getByRole('button', { name: /任务 s2/ }));
  await screen.findByText('授权 s2');
  expect(timelineRenders.at(-1)!.onResolvePermission).not.toBe(initialCallback);
  await userEvent.click(within(screen.getByRole('complementary', { name: '权限审批' })).getByRole('button', { name: '拒绝' }));
  await waitFor(() => expect(permission).toHaveBeenLastCalledWith('s2', 'permission-s2', false));

  act(() => {
    window.history.pushState(null, '', '/sessions/background');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await screen.findByText('授权 background');
  expect(timelineRenders.at(-1)!.activeSessionId).toBe('background');
  expect(timelineRenders.at(-1)!.onResolvePermission).toBeUndefined();
  expect(screen.queryByRole('button', { name: '允许本次' })).toBeNull();
  expect(permission).toHaveBeenCalledTimes(2);
});

it('memoizes event derivations across input and inspection while refreshing live context, commands and sessions', async () => {
  const sessions: Session[] = ['s1', 's2'].map(id => ({ id, agentId: 'codex', state: 'idle', cwd: `/tmp/${id}`, runId: `run-${id}`, permissionMode: 'ask', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' }));
  const event = (sequence: number, data: Record<string, unknown>): DockEvent => ({ id: `usage-${sequence}`, sequence: sequence + 1, type: 'status', timestamp: `2026-10-23T00:00:0${sequence}Z`, data });
  const events = [
    { ...event(0, { role: 'user', text: 'show usage' }), type: 'text' },
    event(1, { state: 'usage', used: 600, size: 1000 }),
    event(2, { state: 'usage', used: 300, size: 1000 }),
    event(3, { state: 'commands', availableCommands: [{ name: 'before', description: 'initial command' }] })
  ];
  window.history.replaceState(null, '', '/sessions/s1');
  mockAppApi(sessions);
  vi.mocked(api.events).mockImplementation(async id => id === 's1' ? events : [{ ...event(0, { role: 'user', text: 'second usage' }), type: 'text' }, event(1, { state: 'usage', used: 200, size: 1000 }), event(2, { state: 'commands', availableCommands: [{ name: 'second', description: 'second session command' }] })]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
  await screen.findByRole('textbox', { name: '消息' });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const count = () => [vi.mocked(composerUtils.currentContextStats).mock.calls.length, vi.mocked(composerUtils.commandsFromEvents).mock.calls.length];
  const beforeInput = count();
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '/before' } });
  expect(await screen.findByRole('button', { name: /\/before.*initial command/ })).toBeTruthy();
  expect(count()).toEqual(beforeInput);
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: 'draft remains' } });
  await userEvent.click(screen.getByRole('button', { name: '查看验证证据' }));
  const inspector = await screen.findByRole('dialog', { name: '结果检视' });
  await userEvent.click(within(inspector).getByText('详细用量与后台状态'));
  const contextMeter = () => within(inspector).getByRole('progressbar', { name: '上下文已用' }).getAttribute('aria-valuenow');
  expect(contextMeter()).toBe('30');
  await userEvent.click(within(inspector).getByText('明细'));
  expect(within(inspector).getByText('已压缩 300 token')).toBeTruthy();
  expect(count()).toEqual(beforeInput);

  await act(async () => {
    client.setQueryData<EventWindow>(['events', 's1'], previous => mergeReconciledEvents(previous, [event(4, { state: 'usage', used: 100, size: 1000 }), event(5, { state: 'commands', availableCommands: [{ name: 'after', description: 'updated command' }] })]));
  });
  await waitFor(() => expect(contextMeter()).toBe('10'));
  expect(within(inspector).getByText('已压缩 500 token')).toBeTruthy();
  const afterEvents = count();
  expect(afterEvents).toEqual(beforeInput.map(value => value + 1));
  await act(async () => {
    client.setQueryData(['session-usage', 's1'], { own: { entries: 0 }, subSteps: { entries: 0 }, snapshot: { context: { used: 800, size: 1000, observedAt: '2026-10-23T00:00:06Z', source: 'codex_transcript' } } });
  });
  await waitFor(() => expect(contextMeter()).toBe('80'));
  expect(count()).toEqual([afterEvents[0]! + 1, afterEvents[1]]);
  const beforePlugins = count();
  await act(async () => {
    client.setQueryData(['plugin-commands', sessions[0]!.cwd], [{ name: 'plugin-new', description: 'new plugin command' }]);
  });
  await userEvent.click(within(inspector).getByRole('button', { name: '关闭结果检视' }));
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '/' } });
  expect(await screen.findByRole('button', { name: /\/after.*updated command/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /\/before.*initial command/ })).toBeNull();
  expect(screen.getByRole('button', { name: /\/plugin-new.*new plugin command/ })).toBeTruthy();
  expect(count()).toEqual(beforePlugins);

  act(() => {
    window.history.pushState(null, '', '/sessions/s2');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await waitFor(() => expect(timelineRenders.at(-1)!.activeSessionId).toBe('s2'));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '/second' } });
  expect(await screen.findByRole('button', { name: /\/second.*second session command/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /\/plugin-new/ })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '查看验证证据' }));
  const secondInspector = await screen.findByRole('dialog', { name: '结果检视' });
  await userEvent.click(within(secondInspector).getByText('详细用量与后台状态'));
  expect(within(secondInspector).getByRole('progressbar', { name: '上下文已用' }).getAttribute('aria-valuenow')).toBe('20');
});

beforeEach(() => { vi.spyOn(api, 'sessionHistory').mockResolvedValue({ turns: [], highWaterMark: 0, liveAfter: 0 }); });

vi.mock('./skill-catalog-api', async () => { const { api } = await import('./api'); return { fetchSkillCatalog: async (...args: Parameters<typeof api.skills>) => ({ skills: await api.skills(...args), diagnostics: [], partial: false }) }; });

it('keeps native commands discoverable from fully summarized history and honors a newer empty live catalog', async () => {
  const session: Session = { id: 's1', agentId: 'codex', state: 'idle', cwd: '/tmp/native-menu', runId: 'r1', permissionMode: 'ask', createdAt: '', updatedAt: '' };
  window.history.replaceState(null, '', '/sessions/s1');
  mockAppApi([session]);
  vi.mocked(api.events).mockResolvedValue([]);
  vi.mocked(api.sessionHistory).mockResolvedValue({ turns: [{ id: 'old-native-turn', taskId: 'old-task', firstSequence: 1, lastSequence: 50, timestamp: '', status: 'completed', prompt: { text: 'closed instruction', truncated: false }, output: { text: 'closed result', truncated: false }, toolCount: 0, artifactReferences: [] }], liveAfter: 50, highWaterMark: 50, commandCatalog: { sequence: 1, commands: [{ name: 'compact', description: 'Compact native context' }], truncated: false } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
  await screen.findByText('closed result');
  const input = screen.getByRole('textbox', { name: '消息' });
  fireEvent.change(input, { target: { value: '/compact' } });
  expect(await screen.findByRole('button', { name: /\/compact.*Compact native context/ })).toBeTruthy();
  expect(client.getQueryData<EventWindow>(['events', 's1'])?.events).toEqual([]);
  act(() => client.setQueryData<EventWindow>(['events', 's1'], current => mergeReconciledEvents(current, [{ id: 'empty-native-commands', sequence: 51, type: 'status', timestamp: '', data: { state: 'commands', availableCommands: [] } }])));
  await waitFor(() => expect(screen.queryByRole('button', { name: /\/compact.*Compact native context/ })).toBeNull());
  act(() => client.setQueryData<EventWindow>(['events', 's1'], current => mergeReconciledEvents(current, [{ id: 'new-native-commands', sequence: 52, type: 'status', timestamp: '', data: { state: 'commands', availableCommands: [{ name: '/refresh', description: 'Current native command' }] } }])));
  fireEvent.change(input, { target: { value: '/refresh' } });
  expect(await screen.findByRole('button', { name: /\/refresh.*Current native command/ })).toBeTruthy();
});
