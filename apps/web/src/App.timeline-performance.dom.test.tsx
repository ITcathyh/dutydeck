import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { api, type Session } from './api';
import type { TimelineViewProps } from './components/TimelineView';
import { useDockStore } from './store';
import { resetComposerDrafts } from './composer-draft';

const timelineRenders = vi.hoisted(() => [] as TimelineViewProps[]);
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
  timelineRenders.length = 0;
  useDockStore.setState({ activeSessionId: undefined, rawVisible: false });
  resetComposerDrafts();
  Object.keys(window.localStorage).filter(key => key.startsWith('dutydeck:view:')).forEach(key => window.localStorage.removeItem(key));
  window.history.replaceState(null, '', '/');
});

it('keeps the permission callback stable while typing and targets the selected session after navigation', async () => {
  const sessions: Session[] = ['s1', 's2', 'background'].map(id => ({ id, agentId: 'codex', state: 'waiting_permission', cwd: `/tmp/${id}`, runId: `run-${id}`, permissionMode: 'ask', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', ...(id === 'background' ? { source: 'work_item' } : {}) }));
  window.history.replaceState(null, '', '/sessions/s1');
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
