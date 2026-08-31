// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, foundationApi, scheduleApi, type Agent, type DockEvent, type RunSummary, type Session } from './api';
import App from './App';
import { useDockStore } from './store';

vi.mock('./useSessionStream', () => ({ useSessionStream: () => 'open' }));
vi.mock('./components/TerminalView', () => ({ TerminalView: ({ sessionId }: { sessionId: string }) => <div>Terminal {sessionId}</div> }));

const agent = (protocol: Agent['protocol'] = 'acp'): Agent => ({ id: 'codex', name: 'Codex', protocol, permissionMode: 'full-trust' });
const session = (id: string, state = 'idle'): Session => ({ id, agentId: 'codex', state, cwd: `/repo/${id}`, permissionMode: 'full-trust', runId: `run-${id}`, createdAt: '2026-08-30T00:00:00Z', updatedAt: `2026-08-30T00:00:0${id === 's1' ? '2' : '1'}Z` });
const summary = (id: string, prompt: string): RunSummary => ({ sessionId: id, taskId: `task-${id}`, prompt, status: 'completed', queuedCount: 0, updatedAt: '2026-08-30T00:00:03Z' });

function mockAppApi({ agents = [agent()], sessions = [], summaries = [], events = [] }: { agents?: Agent[]; sessions?: Session[]; summaries?: RunSummary[]; events?: DockEvent[] } = {}) {
  vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: true, required: false });
  vi.spyOn(api, 'agents').mockResolvedValue(agents);
  vi.spyOn(api, 'sessions').mockResolvedValue(sessions);
  vi.spyOn(api, 'runSummaries').mockResolvedValue(summaries);
  vi.spyOn(api, 'events').mockResolvedValue(events);
  vi.spyOn(api, 'tasks').mockResolvedValue([]);
  vi.spyOn(api, 'agentModels').mockResolvedValue({ models: [], reasoningEfforts: [] });
  vi.spyOn(api, 'skills').mockResolvedValue([]);
  vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
  vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><App/></QueryClientProvider>), client };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useDockStore.setState({ activeSessionId: undefined, rawVisible: false });
  window.history.replaceState(null, '', '/');
});

describe('App mobile navigation accessibility', () => {
  it('makes the background inert, moves focus into navigation, and restores focus on Escape', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.spyOn(api, 'agents').mockResolvedValue([]);
    vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: true, required: false });
    vi.spyOn(api, 'sessions').mockResolvedValue([]);
    vi.spyOn(api, 'runSummaries').mockResolvedValue([]);
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
    vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
    const trigger = await screen.findByRole('button', { name: '打开工作台导航' });
    trigger.focus();
    await userEvent.click(trigger);
    const main = container.querySelector('main')!;
    expect(main.hasAttribute('inert')).toBe(true);
    expect(main.getAttribute('aria-hidden')).toBe('true');
    const navigation = screen.getByRole('complementary', { name: 'Dockmux 工作台导航', hidden: true });
    await waitFor(() => expect(navigation.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Escape}');
    expect(main.hasAttribute('inert')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe('App browser navigation and shell states', () => {
  it('restores the exact create-task opener after the auto-focused dialog closes', async () => {
    mockAppApi();
    const user = userEvent.setup();
    const { container } = renderApp();
    await screen.findByRole('heading', { name: '今天需要推进什么？' });
    const opener = within(container.querySelector('main')!).getByRole('button', { name: '创建任务' });
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: '创建新任务' });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: '任务目标' })));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '创建新任务' })).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('keeps the attention-first task home and mounts one trusted-machine control center', async () => {
    mockAppApi();
    const foundation = { schemaVersion: 1 as const, repositoriesWired: true, permissionEvaluatorWired: true, secretInspectorWired: true, runtimeWired: false as const, writesEnabled: true, readiness: 'offline_management_ready' as const, blockers: [{ code: 'production_execution_unwired', message: 'Runtime missing', action: 'Wire later' }] };
    const schedules = { schemaVersion: 1 as const, repositoriesWired: true, permissionEvaluatorWired: true, writesEnabled: true, executorWired: false as const, uiEntryReady: false as const, readiness: 'offline_management_ready' as const, blockers: [{ code: 'schedule_executor_unavailable', message: 'Executor missing', action: 'Keep disabled' }] };
    vi.spyOn(foundationApi, 'capabilities').mockResolvedValue(foundation);
    vi.spyOn(foundationApi, 'groupMatrix').mockResolvedValue({ capabilities: foundation, bots: [] });
    vi.spyOn(foundationApi, 'secretRefs').mockResolvedValue({ secretRefs: [] });
    vi.spyOn(scheduleApi, 'capabilities').mockResolvedValue(schedules);
    vi.spyOn(scheduleApi, 'list').mockResolvedValue({ capabilities: schedules, schedules: [] });
    const { container } = renderApp();
    expect(await screen.findByRole('heading', { name: '今天需要推进什么？' })).toBeTruthy();
    const navigation = screen.getByRole('complementary', { name: 'Dockmux 工作台导航' });
    const opener = within(navigation).getByRole('button', { name: /Agent 与设置/ });
    await userEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Dockmux 设置与接入' });
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(true);
    expect(screen.getByText(/受信开发机模式：/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Agent 准备本机执行者$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /开启监听|立即运行|run.now/i })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dockmux 设置与接入' })).toBeNull());
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('pushes session selections and restores overview/detail from popstate', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')] });
    const pushState = vi.spyOn(window.history, 'pushState');
    renderApp();

    const navigation = screen.getByRole('complementary', { name: 'Dockmux 工作台导航' });
    await userEvent.click(await within(navigation).findByRole('button', { name: /任务一/ }));
    expect(pushState).toHaveBeenCalledWith({ sessionId: 's1' }, '', '/sessions/s1');
    expect(window.location.pathname).toBe('/sessions/s1');
    await screen.findByRole('button', { name: '归档任务运行' });

    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: '今天需要推进什么？' });

    act(() => {
      window.history.replaceState({ sessionId: 's1' }, '', '/sessions/s1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('button', { name: '归档任务运行' });
  });

  it('restores a deep link and shows an explicit not-found state only after sessions load', async () => {
    window.history.replaceState(null, '', '/sessions/missing');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')] });
    renderApp();

    expect(await screen.findByRole('heading', { name: '找不到这个任务运行' })).toBeTruthy();
    expect(screen.queryByText('当前视图没有任务运行。')).toBeNull();
    expect(api.events).not.toHaveBeenCalled();
    expect(api.tasks).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '回到任务中心' }));
    expect(window.location.pathname).toBe('/');
    await screen.findByRole('heading', { name: '今天需要推进什么？' });
  });

  it('shows retryable failures for every main query instead of empty data', async () => {
    const agents = vi.spyOn(api, 'agents').mockRejectedValueOnce(new Error('agents offline')).mockResolvedValue([agent()]);
    vi.spyOn(api, 'authStatus').mockResolvedValue({ authenticated: true, required: false });
    const sessions = vi.spyOn(api, 'sessions').mockRejectedValueOnce(new Error('sessions offline')).mockResolvedValue([]);
    const summaries = vi.spyOn(api, 'runSummaries').mockRejectedValueOnce(new Error('summaries offline')).mockResolvedValue([]);
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: false, bots: [], listeningDisabled: false });
    vi.spyOn(api, 'systemCapabilities').mockResolvedValue({ platform: 'linux', directoryPicker: false, filePicker: false });
    renderApp();

    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('Agent 信息');
    expect(error.textContent).toContain('任务运行');
    expect(error.textContent).toContain('运行摘要');
    expect(screen.getByRole('complementary', { name: 'Dockmux 工作台导航' }).querySelector('.animate-pulse')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '重新加载' }));
    await screen.findByRole('heading', { name: '今天需要推进什么？' });
    expect(agents).toHaveBeenCalledTimes(2);
    expect(sessions).toHaveBeenCalledTimes(2);
    expect(summaries).toHaveBeenCalledTimes(2);
  });

  it('keeps cached detail and task-center data visible after a background refetch error', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')] });
    const { client } = renderApp();
    await screen.findByRole('button', { name: '归档任务运行' });

    vi.mocked(api.sessions).mockRejectedValueOnce(new Error('temporary sessions failure'));
    await act(async () => { await client.refetchQueries({ queryKey: ['sessions'], exact: true }); });

    const staleStatus = await screen.findByRole('status');
    expect(staleStatus.textContent).toContain('部分数据可能不是最新：任务运行');
    expect(screen.getByRole('button', { name: '归档任务运行' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: '今天需要推进什么？' });
    expect(screen.getByRole('status').textContent).toContain('任务运行');

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it.each(['/foo', '/sessions/a/extra'])('shows not-found for unknown pathname %s', async pathname => {
    window.history.replaceState(null, '', pathname);
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')] });
    renderApp();

    expect(await screen.findByRole('heading', { name: '找不到这个页面' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '今天需要推进什么？' })).toBeNull();
    expect(api.events).not.toHaveBeenCalled();
    expect(api.tasks).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '回到任务中心' }));
    expect(window.location.pathname).toBe('/');
  });

  it('clears an action error when switching sessions', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1', 'thinking'), session('s2')], summaries: [summary('s1', '任务一'), summary('s2', '任务二')] });
    vi.spyOn(api, 'action').mockRejectedValue(new Error('中断失败'));
    renderApp();

    await waitFor(() => expect(screen.getAllByRole('button', { name: '中断当前任务' }).length).toBeGreaterThan(0));
    await userEvent.click(screen.getAllByRole('button', { name: '中断当前任务' })[0]);
    expect((await screen.findByRole('alert')).textContent).toContain('中断失败');
    const navigation = screen.getByRole('complementary', { name: 'Dockmux 工作台导航' });
    await userEvent.click(within(navigation).getByRole('button', { name: /任务二/ }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(window.location.pathname).toBe('/sessions/s2');
  });

  it('exposes PTY timeline and terminal as tabs with matching tabpanels', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ agents: [agent('pty-cli')], sessions: [session('s1')], summaries: [summary('s1', 'PTY 任务')] });
    renderApp();

    expect(await screen.findByRole('tablist', { name: '任务运行内容' })).toBeTruthy();
    const timelineTab = screen.getByRole('tab', { name: '执行记录' });
    const terminalTab = screen.getByRole('tab', { name: '终端' });
    expect(timelineTab.getAttribute('aria-selected')).toBe('true');
    expect(terminalTab.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tabpanel', { name: '执行记录' })).toBeTruthy();

    timelineTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(terminalTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(terminalTab);
    expect(await screen.findByRole('tabpanel', { name: '终端' })).toBeTruthy();

    await userEvent.keyboard('{ArrowLeft}');
    expect(timelineTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(timelineTab);
    await userEvent.keyboard('{End}');
    expect(terminalTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(terminalTab);
    await userEvent.keyboard('{Home}');
    expect(timelineTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(timelineTab);
  });

  it('keeps raw logs as a drawer until the 2xl breakpoint', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')], events: [{ id: 'raw-1', sequence: 1, type: 'raw_terminal', timestamp: '2026-08-30T00:00:00Z', data: { text: 'raw output' }, raw: 'raw output' }] });
    renderApp();

    const rawButton = await screen.findByRole('button', { name: '原始日志' });
    await waitFor(() => expect(rawButton.hasAttribute('disabled')).toBe(false));
    await userEvent.click(rawButton);
    const drawer = screen.getByText('原始运行日志').closest('aside');
    expect(drawer?.className).toContain('2xl:static');
    expect(drawer?.className).not.toContain('lg:static');
  });
});
