// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, foundationApi, scheduleApi, type Agent, type DockEvent, type RunSummary, type Session } from './api';
import App from './App';
import { useDockStore } from './store';
import { shortcutDefinitions } from './useKeyboardShortcuts';

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

  /**
   * 汉堡按钮固定在 <main> 上，任务列表从它下面滚过去（真正滚动的是
   * WorkspaceOverview 内部的 overflow-y-auto 容器）。IconButton 自身背景透明，
   * 一旦外壳也透明，滚动后图标就压在任务卡片正文上——难读且会误触。
   * 这条断言守住外壳的不透明背景：改回透明立刻挂。
   *
   * 语义类替代了内联 token（契约 §1.2），断言跟着换名，守护的意图不变：
   * 不透明底 + 外圈 + 阴影，让它明确是悬浮控件而不是一个透明图标。
   * 外圈在这里合法——契约 §5 白名单第 3 类「脱离文档流的浮层外圈」。
   */
  it('gives the floating mobile navigation trigger an opaque surface so scrolled task cards never show through it', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    mockAppApi({ sessions: [session('s1', 'failed')], summaries: [summary('s1', '任务异常：Agent exited with code 129')] });
    renderApp();
    const trigger = await screen.findByRole('button', { name: '打开工作台导航' });
    const shell = trigger.parentElement!;
    expect(shell.className).toContain('bg-surface');
    expect(shell.className).toContain('border-default');
    expect(shell.className).toContain('shadow-card');
    // 透明底会让图标压在滚过的任务卡片正文上，既读不清又会误触。
    expect(shell.className).not.toMatch(/bg-transparent/);
    // 桌面端侧边栏常驻，这枚按钮必须彻底消失。
    expect(shell.className).toContain('md:hidden');
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
    await screen.findByRole('button', { name: '归档任务' });

    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: '今天需要推进什么？' });

    act(() => {
      window.history.replaceState({ sessionId: 's1' }, '', '/sessions/s1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('button', { name: '归档任务' });
  });

  it('restores a deep link and shows an explicit not-found state only after sessions load', async () => {
    window.history.replaceState(null, '', '/sessions/missing');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')] });
    renderApp();

    expect(await screen.findByRole('heading', { name: '找不到这个任务' })).toBeTruthy();
    expect(screen.queryByText('当前视图没有任务。')).toBeNull();
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
    expect(error.textContent).toContain('任务列表');
    expect(error.textContent).toContain('任务摘要');
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
    await screen.findByRole('button', { name: '归档任务' });

    vi.mocked(api.sessions).mockRejectedValueOnce(new Error('temporary sessions failure'));
    await act(async () => { await client.refetchQueries({ queryKey: ['sessions'], exact: true }); });

    const staleStatus = await screen.findByRole('status');
    expect(staleStatus.textContent).toContain('部分数据可能不是最新：任务列表');
    expect(screen.getByRole('button', { name: '归档任务' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: '今天需要推进什么？' });
    expect(screen.getByRole('status').textContent).toContain('任务列表');

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

    expect(await screen.findByRole('tablist', { name: '任务内容' })).toBeTruthy();
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
    const drawer = screen.getByText('原始日志', { selector: 'div' }).closest('aside');
    expect(drawer?.className).toContain('2xl:static');
    expect(drawer?.className).not.toContain('lg:static');
  });
});

describe('App 搜索、快捷键与通知接线', () => {
  it('Ctrl-K 打开命令面板，可检索到任务并跳进详情', async () => {
    const user = userEvent.setup();
    mockAppApi({ sessions: [session('s1'), session('s2')], summaries: [summary('s1', '修复登录超时'), summary('s2', '补齐回归测试')] });
    renderApp();
    // 任务同时出现在侧栏和总览列表里，这里只锚定总览列表，避免匹配到侧栏那一份。
    const taskList = await screen.findByRole('region', { name: '任务列表' });
    await within(taskList).findByRole('button', { name: /修复登录超时/ });

    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: '搜索任务与命令' });
    const results = within(palette).getByRole('listbox', { name: '搜索结果' });
    await user.type(within(palette).getByRole('combobox'), '回归');
    // 检索命中的是另一条任务，说明搜索真的过滤了，而不是把全部任务列出来。
    await waitFor(() => expect(within(results).queryByText('修复登录超时')).toBeNull());
    await user.click(within(results).getByText('补齐回归测试'));

    await waitFor(() => expect(window.location.pathname).toBe('/sessions/s2'));
    expect(screen.queryByRole('dialog', { name: '搜索任务与命令' })).toBeNull();
  });

  it('页首搜索入口与问号帮助面板都可达，且帮助面板如实标出不可用项', async () => {
    const user = userEvent.setup();
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '修复登录超时')] });
    renderApp();

    await user.click(await screen.findByRole('button', { name: /搜索任务目标、工作区或 Agent/ }));
    expect(await screen.findByRole('dialog', { name: '搜索任务与命令' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '搜索任务与命令' })).toBeNull());

    await user.keyboard('?');
    const sheet = await screen.findByRole('dialog', { name: /快捷键/ });
    /**
     * 面板必须如实标注，两个方向都不能错：
     *   · session 作用域（总览页没有打开任何任务）要标成不可用，并说明先打开一个任务；
     *   · 全局作用域此刻确实能按，就不能标成不可用。
     *
     * 后者曾经是坏的：展示层复用了运行期的 enabled: !overlayOpen，而帮助面板自己就是
     * 浮层，一打开 overlayOpen 即为 true，于是 21 条里 20 条被标成「当前不可用」。
     * 面板的意义正是告诉用户此刻能按什么，那样它每次都在撒谎。当时的断言写的是
     * 「> 0」，恰好被这个 bug 满足，所以没能拦住——这里改成精确计数。
     */
    const unavailable = within(sheet).getAllByText(/当前不可用/);
    const sessionScoped = shortcutDefinitions.filter(definition => definition.scope === 'session').length;
    expect(unavailable.length).toBe(sessionScoped);
    expect(within(sheet).getAllByText(/当前不可用：先打开一个任务/).length).toBe(sessionScoped);
    const globalRow = within(sheet).getByText('打开命令面板，搜索任务与操作').closest('li')!;
    expect(within(globalRow).queryByText(/当前不可用/)).toBeNull();
  });

  /**
   * 回归：整页加载（而非 SPA 导航）进任务中心后按 n。
   *
   * shortcutHandlers 的 useMemo 依赖数组曾漏掉 agents.data，于是首屏 agents 还没到位时
   * openCreateTask 闭包看到 0 个 Agent，改道去了「设置与接入」；agents 到位后 memo 不
   * 重算，闭包永久过期——最常见的入口（直接打开或刷新）上 n 就一直是错的。
   */
  it('整页加载任务中心后按 n 打开创建任务，而不是设置与接入', async () => {
    const user = userEvent.setup();
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '修复登录超时')] });
    renderApp();
    // 等 agents 查询落地：Agent 数据到位后，过期闭包与正确闭包才会出现分歧。
    await screen.findByRole('region', { name: '任务列表' });
    await waitFor(() => expect(api.agents).toHaveBeenCalled());

    await user.keyboard('n');
    expect(await screen.findByRole('dialog', { name: /新建|创建/ })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Dockmux 设置与接入' })).toBeNull();
  });

  it('取消待执行指令后给出成功通知，并提供把指令排回队尾的撤销', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1', 'thinking')], summaries: [summary('s1', '修复登录超时')] });
    const queued = { id: 'task-q1', sessionId: 's1', prompt: '顺手补一个回归测试', status: 'queued', createdAt: '2026-08-30T00:00:00Z', updatedAt: '2026-08-30T00:00:00Z' };
    vi.spyOn(api, 'tasks').mockResolvedValue([queued]);
    vi.spyOn(api, 'cancelQueued').mockResolvedValue({ ...queued, status: 'cancelled' });
    const send = vi.spyOn(api, 'send').mockResolvedValue({ accepted: true, task: { ...queued, id: 'task-q2' } });
    renderApp();

    await user.click(await screen.findByRole('button', { name: /取消/ }));
    expect(await screen.findByText('已取消 1 条待执行指令')).toBeTruthy();
    // 诚实表达能力：撤销只能排到队尾，不能还原原来的位置，文案必须说明。
    expect(screen.getByText('恢复会把这条指令重新排到队列末尾，不会回到原来的位置。')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '恢复这条指令' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('s1', '顺手补一个回归测试', 'queue'));
  });

  it('外观选择持久化到 localStorage，并写入 data-theme', async () => {
    const user = userEvent.setup();
    mockAppApi();
    renderApp();

    await user.click(await screen.findByRole('radio', { name: /^深色/ }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('dockmux.theme')).toBe('dark');

    await user.click(screen.getByRole('radio', { name: /^跟随系统/ }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem('dockmux.theme')).toBeNull();
  });

  it('在输入框里打字不会被单键快捷键劫持', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '修复登录超时')] });
    renderApp();

    const composer = await screen.findByRole('textbox', { name: /指令|输入|消息/ }).catch(() => undefined) ?? (await screen.findAllByRole('textbox'))[0]!;
    await user.click(composer);
    await user.type(composer, 'net');
    // n 会新建任务、e 会归档、t 会切 tab —— 在输入态它们都必须只是普通字符。
    expect((composer as HTMLTextAreaElement).value).toBe('net');
    expect(screen.queryByRole('dialog', { name: '创建新任务' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: /归档/ })).toBeNull();
  });
});

/**
 * 浮层的 URL 状态（契约 §11.4）。
 *
 * 重构前 9 个浮层全无 URL 表示：设置页分享不出去、后退键关不掉弹层（会直接跳走）、
 * 刷新即丢失。这组测试守住「可深链的四个浮层」的完整往返。
 */
describe('可深链浮层的 URL 契约', () => {
  const mockFoundation = () => {
    const foundation = { schemaVersion: 1 as const, repositoriesWired: true, permissionEvaluatorWired: true, secretInspectorWired: true, runtimeWired: false as const, writesEnabled: true, readiness: 'offline_management_ready' as const, blockers: [] };
    const schedules = { schemaVersion: 1 as const, repositoriesWired: true, permissionEvaluatorWired: true, writesEnabled: true, executorWired: false as const, uiEntryReady: false as const, readiness: 'offline_management_ready' as const, blockers: [] };
    vi.spyOn(foundationApi, 'capabilities').mockResolvedValue(foundation);
    vi.spyOn(foundationApi, 'groupMatrix').mockResolvedValue({ capabilities: foundation, bots: [] });
    vi.spyOn(foundationApi, 'secretRefs').mockResolvedValue({ secretRefs: [] });
    vi.spyOn(scheduleApi, 'capabilities').mockResolvedValue(schedules);
    vi.spyOn(scheduleApi, 'list').mockResolvedValue({ capabilities: schedules, schedules: [] });
  };

  it('打开设置写进 URL，关闭后退回原地址', async () => {
    mockAppApi();
    mockFoundation();
    renderApp();
    const navigation = await screen.findByRole('complementary', { name: 'Dockmux 工作台导航' });
    await userEvent.click(within(navigation).getByRole('button', { name: /Agent 与设置/ }));
    await screen.findByRole('dialog', { name: 'Dockmux 设置与接入' });
    expect(window.location.search).toBe('?panel=settings&section=agents');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dockmux 设置与接入' })).toBeNull());
    // 关闭走 history.back()，不是再 push 一条——否则后退会把刚关掉的浮层重新打开。
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toBe('/');
  });

  it('直接深链进设置页时自动打开，且不叠加新的历史记录', async () => {
    window.history.replaceState(null, '', '/?panel=settings&section=lark');
    mockAppApi();
    mockFoundation();
    const pushState = vi.spyOn(window.history, 'pushState');
    renderApp();
    expect(await screen.findByRole('dialog', { name: 'Dockmux 设置与接入' })).toBeTruthy();
    expect(pushState).not.toHaveBeenCalled();
  });

  it('深链关闭时用 replaceState 抹掉 query，不 back 出站', async () => {
    window.history.replaceState(null, '', '/?panel=settings&section=agents');
    mockAppApi();
    mockFoundation();
    const back = vi.spyOn(window.history, 'back');
    renderApp();
    await screen.findByRole('dialog', { name: 'Dockmux 设置与接入' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(window.location.search).toBe(''));
    // history.state 上没有我们的标记 ⇒ 这条 entry 不是我们 push 的，back() 会离开站点。
    expect(back).not.toHaveBeenCalled();
  });

  it('后退键关闭浮层，而不是跳走', async () => {
    mockAppApi();
    mockFoundation();
    renderApp();
    const navigation = await screen.findByRole('complementary', { name: 'Dockmux 工作台导航' });
    await userEvent.click(within(navigation).getByRole('button', { name: /Agent 与设置/ }));
    await screen.findByRole('dialog', { name: 'Dockmux 设置与接入' });

    await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dockmux 设置与接入' })).toBeNull());
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
  });

  it('浮层可以叠在任务详情上，关闭后仍留在该任务', async () => {
    window.history.replaceState(null, '', '/sessions/s1?panel=settings&section=agents');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '修复登录态')] });
    mockFoundation();
    renderApp();
    await screen.findByRole('dialog', { name: 'Dockmux 设置与接入' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dockmux 设置与接入' })).toBeNull());
    // 关掉设置不应该把用户踢回任务中心。
    expect(window.location.pathname).toBe('/sessions/s1');
    expect(window.location.search).toBe('');
  });

  it('归档确认框没有 URL 表示，深链打不开', async () => {
    // 深链等于让一条链接直接对别人的任务弹出不可逆操作的确认框。
    window.history.replaceState(null, '', '/sessions/s1?panel=archive');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '修复登录态')] });
    renderApp();
    // 标题在侧栏和详情页各出现一次，这里只需确认详情已渲染。
    await waitFor(() => expect(screen.getAllByText('修复登录态').length).toBeGreaterThan(0));
    expect(screen.queryByRole('dialog', { name: /归档/ })).toBeNull();
  });

  it('未知 panel 值不打开任何浮层', async () => {
    window.history.replaceState(null, '', '/?panel=totally-made-up');
    mockAppApi();
    renderApp();
    expect(await screen.findByRole('heading', { name: '今天需要推进什么？' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
