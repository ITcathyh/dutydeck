// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, foundationApi, scheduleApi, type Agent, type DockEvent, type RunSummary, type Session } from './api';
import App from './App';
import { useDockStore } from './store';
import { resetDrafts } from './draft-store';
import type { EventWindow } from './event-history';
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
  vi.spyOn(api, 'sessionCapabilities').mockResolvedValue({
    observedAt: '2026-08-30T00:00:00Z',
    protocol: 'acp',
    structuredApproval: 'available',
    terminal: 'available',
    turnRecovery: 'available',
    verification: 'available',
    localFileDelivery: 'available',
  });
  vi.spyOn(api, 'verifications').mockResolvedValue([]);
  vi.spyOn(api, 'workItems').mockResolvedValue({ items: [], templates: [] });
  vi.spyOn(api, 'workItemRequests').mockResolvedValue([]);
  vi.spyOn(api, 'automation').mockResolvedValue({ schedules: [], subscriptions: [], occurrences: [] });
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
  // 编辑草稿是模块级 store（跨视图存活），不清会让用例互相串草稿。
  resetDrafts();
  window.history.replaceState(null, '', '/');
});

describe('App 批量清理', () => {
  function setup() {
    const sessions = [session('s1', 'completed'), session('s2', 'thinking')];
    mockAppApi({ sessions, summaries: [summary('s1', '已完成目标'), summary('s2', '运行中目标')] });
    return sessions;
  }

  async function selectAll(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: '批量清理' }));
    await user.click(screen.getByRole('checkbox', { name: '全选当前视图' }));
    await user.click(screen.getByRole('button', { name: '清理所选任务' }));
    return screen.getByRole('alertdialog', { name: '清理所选的 2 个任务？' });
  }

  it('二次确认前不写入，取消保留选择，成功后历史仍能从已归档查看', async () => {
    const user = userEvent.setup(); const sessions = setup();
    const archive = vi.spyOn(api, 'archive').mockImplementation(async id => ({ ...sessions.find(item => item.id === id)!, state: 'stopped', archivedAt: '2026-09-12T00:00:00Z' }));
    const { client } = renderApp();
    const dialog = await selectAll(user);
    expect(dialog.textContent).toContain('正在执行的任务会停止，排队指令会取消');
    expect(archive).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.getByText('已选 2 个任务')).toBeTruthy();
    expect(archive).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '清理所选任务' }));
    await user.click(screen.getByRole('button', { name: '确认清理' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(archive.mock.calls.map(([id]) => id).sort()).toEqual(['s1', 's2']);
    expect(client.getQueryData<Session[]>(['sessions'])?.every(item => item.archivedAt)).toBe(true);
    expect(screen.getByText('当前视图没有任务')).toBeTruthy();
    const filters = screen.getByRole('region', { name: '任务筛选' });
    await user.click(within(filters).getByRole('button', { name: '已归档 2' }));
    const list = screen.getByRole('region', { name: '任务列表' });
    expect(within(list).getByRole('button', { name: /已完成目标/ })).toBeTruthy();
    expect(within(list).getByRole('button', { name: /运行中目标/ })).toBeTruthy();
  });

  it('部分失败仍继续清理其余任务，重试只提交失败项', async () => {
    const user = userEvent.setup(); const sessions = setup();
    let fail = true;
    const archive = vi.spyOn(api, 'archive').mockImplementation(async id => {
      if (id === 's2' && fail) throw new Error('暂时无法停止任务');
      return { ...sessions.find(item => item.id === id)!, state: 'stopped', archivedAt: '2026-09-12T00:00:00Z' };
    });
    const { client } = renderApp();
    await selectAll(user);
    await user.click(screen.getByRole('button', { name: '确认清理' }));
    const retry = await screen.findByRole('button', { name: '重试失败项' });
    expect(screen.getByRole('alertdialog', { name: '清理所选的 1 个任务？' }).textContent).toContain('暂时无法停止任务');
    expect(archive.mock.calls.map(([id]) => id)).toEqual(['s2', 's1']);
    expect(client.getQueryData<Session[]>(['sessions'])?.find(item => item.id === 's1')?.archivedAt).toBeTruthy();
    expect(client.getQueryData<Session[]>(['sessions'])?.find(item => item.id === 's2')?.archivedAt).toBeUndefined();
    fail = false;
    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(archive.mock.calls.map(([id]) => id)).toEqual(['s2', 's1', 's2']);
    expect(screen.getByText('当前视图没有任务')).toBeTruthy();
  });

  it('执行中禁止重复提交、取消和 Escape，完成后更新列表', async () => {
    const user = userEvent.setup(); const sessions = setup();
    let release!: (value: Session) => void;
    const archive = vi.spyOn(api, 'archive').mockImplementationOnce(() => new Promise<Session>(resolve => { release = resolve; })).mockResolvedValue({ ...sessions[0], state: 'stopped', archivedAt: '2026-09-12T00:00:00Z' });
    renderApp();
    await selectAll(user);
    await user.dblClick(screen.getByRole('button', { name: '确认清理' }));
    expect(archive).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '处理中' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true);
    await user.keyboard('{Escape}5');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(async () => release({ ...sessions[1], state: 'stopped', archivedAt: '2026-09-12T00:00:00Z' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(archive).toHaveBeenCalledTimes(2);
    expect(screen.getByText('当前视图没有任务')).toBeTruthy();
  });

  it('归档前发起的旧列表响应不能让已清理任务重新出现', async () => {
    const user = userEvent.setup(); const sessions = setup();
    vi.spyOn(api, 'archive').mockImplementation(async id => ({ ...sessions.find(item => item.id === id)!, state: 'stopped', archivedAt: '2026-09-12T00:00:00Z' }));
    const { client } = renderApp();
    await selectAll(user);
    let release!: (value: Session[]) => void;
    vi.mocked(api.sessions).mockImplementationOnce(() => new Promise<Session[]>(resolve => { release = resolve; }));
    let refresh!: Promise<void>;
    act(() => { refresh = client.refetchQueries({ queryKey: ['sessions'], exact: true }); });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await user.click(screen.getByRole('button', { name: '确认清理' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await act(async () => { release(sessions); await refresh; });
    expect(client.getQueryData<Session[]>(['sessions'])?.every(item => item.archivedAt)).toBe(true);
    expect(screen.getByText('当前视图没有任务')).toBeTruthy();
  });
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
    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航', hidden: true });
    await waitFor(() => expect(navigation.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Escape}');
    expect(main.hasAttribute('inert')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  /**
   * 这条断言原先守的是「浮动汉堡的外壳必须不透明」。
   *
   * 那枚按钮绝对定位在 <main> 上，任务列表从它下面滚过去，外壳一透明图标就压在
   * 任务卡片正文上——难读且会误触。它需要不透明底 + 外圈 + 阴影才成立。
   *
   * 顶栏落地后这枚按钮不存在了：导航入口收进 TopBar，在自己的行里，上面永远不会
   * 有内容滚过。原来的失效模式因此结构性地消失了，再断言 bg-surface 就是在守一个
   * 不存在的东西。
   *
   * 但「移动端有且只有一个导航入口」这件事必须继续被守住，而且比原来更值得守：
   * 顶栏、RunHeader、浮动按钮三处曾共用同一个无障碍名，读屏用户会听到重复项，
   * getByRole 也会直接抛 "found multiple elements"。这里改成守唯一性与作用域。
   */
  it('keeps exactly one mobile navigation trigger, in the top bar, and hides it once the sidebar is permanent', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    mockAppApi({ sessions: [session('s1', 'failed')], summaries: [summary('s1', '任务异常：Agent exited with code 129')] });
    const { container } = renderApp();
    await screen.findByRole('heading', { name: '今天需要推进什么？' });
    // 同名按钮只能有一枚，否则读屏会重复朗读，getByRole 也会抛 multiple elements。
    const triggers = screen.getAllByRole('button', { name: '打开工作台导航' });
    expect(triggers).toHaveLength(1);
    // 它必须在顶栏里，而不是浮在滚动内容上。
    const topBar = container.querySelector('header')!;
    expect(topBar.contains(triggers[0])).toBe(true);
    expect(topBar.className).toContain('h-topbar');
    // 桌面端侧边栏常驻，这枚按钮必须彻底消失。
    expect(triggers[0].parentElement!.className).toContain('md:hidden');
  });

  it('打开任务后导航入口仍然只有一枚', async () => {
    /*
      顶栏刚落地时这里是坏的：RunHeader 里还留着它自己那枚 md:hidden 汉堡，
      无障碍名与顶栏那枚完全相同，于是会话详情页上同时存在两个「打开工作台导航」。
      读屏用户会听到两遍，getByRole 直接抛 "found multiple elements"。

      上一条只覆盖总览页——而重复恰恰只在详情页出现，所以必须单独有这一条。
    */
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '修复登录超时')] });
    renderApp();
    await screen.findByRole('heading', { name: '修复登录超时' });
    expect(screen.getAllByRole('button', { name: '打开工作台导航' })).toHaveLength(1);
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
    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    const opener = within(navigation).getByRole('button', { name: /Agent 与设置/ });
    await userEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    /*
      Dialog 原语 portal 到 body 后，inert 从 <main> 挪到了整棵应用子树上
      （container 本身），覆盖范围严格变大——背景里的侧栏、工具条也一并
      不可达了，而原先只有 <main> 被隔离。所以断言改成「背景在 inert 子树
      里」而不是「main 这个节点上有 inert 属性」：前者是我们真正要的性质，
      后者只是当时的实现方式。
    */
    expect(container.querySelector('main')?.closest('[inert]')).toBeTruthy();
    expect(screen.getByText(/受信开发机模式：/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Agent 准备本机执行者$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /开启监听|立即运行|run.now/i })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeNull());
    expect(container.querySelector('main')?.closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('pushes session selections and restores overview/detail from popstate', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')] });
    const pushState = vi.spyOn(window.history, 'pushState');
    renderApp();

    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
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
    expect(screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' }).querySelector('.animate-pulse')).toBeNull();
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
    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
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

  it.each([false, true])('raw logs use a modal below 2xl and a side panel above it (wide=%s)', async wide => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(min-width: 1536px)' ? wide : false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')], events: [{ id: 'raw-1', sequence: 1, type: 'raw_terminal', timestamp: '2026-08-30T00:00:00Z', data: { text: 'raw output' }, raw: 'raw output' }] });
    const { container } = renderApp();
    const rawButton = await screen.findByRole('button', { name: '原始日志' });
    await waitFor(() => expect(rawButton.hasAttribute('disabled')).toBe(false));
    await userEvent.click(rawButton);
    if (wide) {
      expect(screen.getByRole('complementary', { name: '原始日志' })).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: '原始日志' })).toBeNull();
      expect(container.hasAttribute('inert')).toBe(false);
    } else {
      const dialog = screen.getByRole('dialog', { name: '原始日志' });
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      expect(container.hasAttribute('inert')).toBe(true);
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: '原始日志' })).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(rawButton));
      expect(container.hasAttribute('inert')).toBe(false);
    }
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

  it('打开任务后，搜索、外观与快捷键三个全局入口仍然可见可用', async () => {
    /*
      顶栏存在的理由就是这一条。在它之前这三个入口都长在 WorkspaceOverview 的页首行里，
      而 App 的 active 分支是二选一：点进任何一个任务，WorkspaceOverview 整个卸载。

      后果按严重程度排：
        · 外观切换彻底失联——没有快捷键、没有命令面板项、没有菜单项，纯死路；
        · 搜索只剩 Mod+K，而命令面板又是「设置」「飞书」这些命令的唯一发现路径；
        · 快捷键帮助只剩 ? 键。

      这条断言在会话详情页里查这三个入口，回退成两栏布局立刻挂。
    */
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '修复登录超时')] });
    const { container } = renderApp();

    // 先确认自己确实在会话详情页，而不是被路由退回了总览。
    await screen.findByRole('heading', { name: '修复登录超时' });
    expect(screen.queryByRole('heading', { name: '今天需要推进什么？' })).toBeNull();

    const topBar = container.querySelector('header')!;
    await user.click(within(topBar).getByRole('button', { name: '搜索任务目标、工作区或 Agent' }));
    expect(await screen.findByRole('dialog', { name: '搜索任务与命令' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '搜索任务与命令' })).toBeNull());

    await user.click(within(within(topBar).getByRole('radiogroup', { name: '界面外观' })).getByRole('radio', { name: /^深色/ }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    await user.click(within(topBar).getByRole('button', { name: '查看键盘快捷键' }));
    expect(await screen.findByRole('dialog', { name: /快捷键/ })).toBeTruthy();
  });

  it('主区只靠 md:ml-main-inset 给浮动侧栏让位，移动端不让位', async () => {
    /*
      侧栏是 position:fixed 的浮动卡片，不是栅格列，所以「侧栏占多宽」这件事被拆成
      两半：侧栏写自己的 left/top/bottom，主区写 margin-left。--main-inset 是这个
      等式的唯一来源（= sidebar-w + shell-gap * 2），主区不许自己算 280px——写死之后
      改 --sidebar-w 会让主区要么留一条空隙要么压住正文，且没有任何测试会红。

      让位必须带 md: 前缀：窄屏侧栏是 translate-x 抽屉，浮在内容之上，主区一让位
      就会留下一条永远空着的左边距。
    */
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '修复登录超时')] });
    const { container } = renderApp();
    await screen.findByRole('heading', { name: '今天需要推进什么？' });
    const main = container.querySelector('main')!;
    expect(main.className).toContain('md:ml-main-inset');
    // 任意值会被 design-consistency 拦下，但「换成另一个硬编码档位」只有这条能拦。
    expect(main.className).not.toMatch(/\bml-\d|\bml-\[/);
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
    expect(screen.queryByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeNull();
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
    expect(window.localStorage.getItem('dutydeck.theme')).toBe('dark');

    await user.click(screen.getByRole('radio', { name: /^跟随系统/ }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem('dutydeck.theme')).toBeNull();
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
    const navigation = await screen.findByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await userEvent.click(within(navigation).getByRole('button', { name: /Agent 与设置/ }));
    await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
    expect(window.location.search).toBe('?panel=settings&section=agents');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeNull());
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
    expect(await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeTruthy();
    expect(pushState).not.toHaveBeenCalled();
  });

  it('深链关闭时用 replaceState 抹掉 query，不 back 出站', async () => {
    window.history.replaceState(null, '', '/?panel=settings&section=agents');
    mockAppApi();
    mockFoundation();
    const back = vi.spyOn(window.history, 'back');
    renderApp();
    await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(window.location.search).toBe(''));
    // history.state 上没有我们的标记 ⇒ 这条 entry 不是我们 push 的，back() 会离开站点。
    expect(back).not.toHaveBeenCalled();
  });

  it('后退键关闭浮层，而不是跳走', async () => {
    mockAppApi();
    mockFoundation();
    renderApp();
    const navigation = await screen.findByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await userEvent.click(within(navigation).getByRole('button', { name: /Agent 与设置/ }));
    await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });

    await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeNull());
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
  });

  it('浮层可以叠在任务详情上，关闭后仍留在该任务', async () => {
    window.history.replaceState(null, '', '/sessions/s1?panel=settings&section=agents');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '修复登录态')] });
    mockFoundation();
    renderApp();
    await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeNull());
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

/*
  larkConfig 失败后 isLoading 变 false、data 是 undefined。此前首页与侧栏都只判
  「loading ? 读取中 : bots.length ? … : 尚未配置」，于是接口挂掉时同屏两处都说
  「尚未配置机器人」——把「读不到」说成「没有」。

  这一组走真实 App，用 mock 让 api.larkConfig reject，验证 prop 真的流到两处、
  重试真的重新发请求，而不是只测 helper。
*/
describe('App 飞书 Bot 状态读取失败', () => {
  const failLarkConfig = () => {
    mockAppApi();
    return vi.spyOn(api, 'larkConfig').mockRejectedValue(new Error('lark api down'));
  };

  it('首页与侧栏都说状态未确认，不谎报「尚未配置机器人」', async () => {
    failLarkConfig();
    renderApp();
    const aside = await screen.findByRole('complementary', { name: '协作入口' });
    await waitFor(() => expect(within(aside).getByRole('heading', { name: /无法读取飞书接入状态/ })).toBeTruthy());
    expect(within(aside).getByText(/无法判断是否已配置机器人/)).toBeTruthy();
    // 「尚未配置」的两处文案都不许出现：概览引导与侧栏 hint。
    expect(document.body.textContent).not.toContain('尚未配置机器人');
    expect(document.body.textContent).not.toContain('尚未配置飞书机器人');
    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    expect(within(navigation).getByRole('button', { name: /飞书接入.*接入状态读取失败/ })).toBeTruthy();
  });

  it('重试按钮真的重新请求 larkConfig，成功后改口为真实状态', async () => {
    const spy = failLarkConfig();
    renderApp();
    const aside = await screen.findByRole('complementary', { name: '协作入口' });
    await waitFor(() => expect(within(aside).getByRole('heading', { name: /无法读取飞书接入状态/ })).toBeTruthy());
    const callsBefore = spy.mock.calls.length;

    // 这一次让它成功，且返回一个「配置完成但用户暂停监听」的 Bot。
    spy.mockResolvedValue({ configured: true, listeningDisabled: false, bots: [{ appId: 'cli_retry', name: '重试机器人', setupComplete: true, listening: false, activeListening: false } as never] });
    await userEvent.click(within(aside).getByRole('button', { name: '重试' }));

    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /无法读取飞书接入状态/ })).toBeNull());
    // 改口后必须是真实状态，而不是「已接入」。
    expect(await screen.findByText('用户暂停监听')).toBeTruthy();
    expect(document.body.textContent).not.toContain('监听已启动');
  });

  it('Bot API 失败不挡任务详情，任务列表仍然可用', async () => {
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '修复登录态')] });
    vi.spyOn(api, 'larkConfig').mockRejectedValue(new Error('lark api down'));
    renderApp();
    // 任务内容照常渲染：飞书接口失败不进 mainQueryFailures，不触发阻塞式失败页。
    await waitFor(() => expect(screen.getAllByText('修复登录态').length).toBeGreaterThan(0));
    expect(screen.queryByText(/无法加载工作台/)).toBeNull();
    expect(screen.getByRole('region', { name: '任务列表' })).toBeTruthy();
  });

  it('已有缓存但 refetch 失败时标注状态未确认，不沿用旧值宣称在线', async () => {
    mockAppApi();
    const spy = vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: true, listeningDisabled: false, bots: [{ appId: 'cli_cached', name: '缓存机器人', setupComplete: true, listening: true, activeListening: true } as never] });
    const { client } = renderApp();
    expect(await within(screen.getByRole('complementary', { name: '协作入口' })).findByText('1 个机器人 · 监听已启动')).toBeTruthy();

    // 缓存已经有「监听已启动」，这一次 refetch 失败：状态必须降级为未确认。
    spy.mockRejectedValue(new Error('lark api down'));
    await act(async () => { await client.refetchQueries({ queryKey: ['lark-config'] }); });

    const aside = screen.getByRole('complementary', { name: '协作入口' });
    await waitFor(() => expect(within(aside).getByText('状态未确认')).toBeTruthy());
    expect(within(aside).getByText(/已有配置记录，但这一次状态读取失败/)).toBeTruthy();
    expect(within(aside).queryByText('监听已启动')).toBeNull();
    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    expect(within(navigation).getByRole('button', { name: /飞书接入.*1 个机器人 · 状态未确认/ })).toBeTruthy();
  });

  /*
    设置与接入浮层读的是同一个 larkConfig 查询。此前 App 只把 bots 数组传进去，
    没传 loading/failed，于是首请求失败时「建议下一步」与 Bot 列表都会说
    「还没有 Bot」，缓存 refetch 失败时又照旧说「监听已启动」。
  */
  const openSettings = async () => {
    await userEvent.click(screen.getByRole('button', { name: /Agent 与设置/ }));
    return screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
  };
  // 浮层内切到「飞书 Bot」分区（Bot 列表与失败 Banner 在这一节）。
  const openLarkSection = async (dialog: HTMLElement) => {
    await userEvent.click(within(dialog).getByRole('button', { name: /飞书 Bot/ }));
  };

  it('设置与接入在首请求失败时说状态未知，且重试真的重新请求', async () => {
    const spy = failLarkConfig();
    renderApp();
    await screen.findByRole('complementary', { name: '协作入口' });
    const dialog = await openSettings();
    // 「建议下一步」不说「还没有 Bot」，而是指向重试。
    await waitFor(() => expect(within(dialog).getByText('重试读取飞书接入状态')).toBeTruthy());

    await openLarkSection(dialog);
    // Bot 列表同样不落到「还没有飞书 Bot」空态。
    expect(within(dialog).queryByText('还没有飞书 Bot')).toBeNull();
    // 建议下一步与 Bot 分区 Banner 都在说同一件事，两处都算。
    expect(within(dialog).getAllByText(/无法判断是否已配置机器人/).length).toBeGreaterThan(0);

    const callsBefore = spy.mock.calls.length;
    spy.mockResolvedValue({ configured: true, listeningDisabled: false, bots: [{ appId: 'cli_retry', name: '重试机器人', setupComplete: true, listening: false, activeListening: false } as never] });
    // 设置内的重试真的重新发请求（这条同时验证 App 把 onRetryLarkBots 接上了）。
    // 同屏有两颗：建议下一步那颗与 Bot 分区 Banner 那颗，都指向同一个 refetch。
    await userEvent.click(within(dialog).getAllByRole('button', { name: '重试' })[0]!);
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(callsBefore));
    // 改口后是真实状态，而不是「已可用」。
    await waitFor(() => expect(within(dialog).getByText('重试机器人')).toBeTruthy());
    expect(within(dialog).getAllByText(/用户暂停监听/).length).toBeGreaterThan(0);
  });

  it('设置与接入在缓存 refetch 失败时把 Bot 状态降级为未确认', async () => {
    mockAppApi();
    const spy = vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: true, listeningDisabled: false, bots: [{ appId: 'cli_cached', name: '缓存机器人', setupComplete: true, listening: true, activeListening: true } as never] });
    const { client } = renderApp();
    expect(await within(screen.getByRole('complementary', { name: '协作入口' })).findByText('1 个机器人 · 监听已启动')).toBeTruthy();
    const dialog = await openSettings();
    await openLarkSection(dialog);

    spy.mockRejectedValue(new Error('lark api down'));
    await act(async () => { await client.refetchQueries({ queryKey: ['lark-config'] }); });

    await waitFor(() => expect(within(dialog).getByText(/下面的机器人状态未确认/)).toBeTruthy());
    // 缓存里的 Bot 仍然列出（不当成消失），但状态不再宣称已启动。
    expect(within(dialog).getByText('缓存机器人')).toBeTruthy();
    expect(within(dialog).queryByText('监听已启动')).toBeNull();
  });
});

/*
  主区一级导航：任务 / 机器人 / 群聊。

  这一组守的是「日常操作不必先进设置中心」这条产品约束的可达性部分——三个视图
  必须是常驻的一级目的地、状态进 URL、来回切换不丢当前任务和当前对象。
  各视图内部的表单行为在 BotManagement / GroupManagement 各自的用例里。
*/
describe('主区一级导航', () => {
  const mockManagementApis = () => {
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [
      { key: 'k1', chatId: 'oc_chat_1', name: '研发项目群', bots: [{ appId: 'cli_a', membership: 'member', validity: 'valid', applied: true, roles: [] }] }
    ] });
  };

  it('三项都是侧栏常驻入口，切换写进 URL 并标出当前项', async () => {
    const user = userEvent.setup();
    mockAppApi();
    mockManagementApis();
    renderApp();
    const navigation = await screen.findByRole('complementary', { name: 'Dutydeck 工作台导航' });

    // 默认在任务视图，且当前项标了 aria-current。
    expect(within(navigation).getByRole('button', { name: /^任务/ }).getAttribute('aria-current')).toBe('page');
    expect(window.location.search).toBe('');

    await user.click(within(navigation).getByRole('button', { name: /^机器人/ }));
    await screen.findByRole('heading', { name: '机器人管理' });
    expect(window.location.search).toBe('?nav=bots');
    expect(within(navigation).getByRole('button', { name: /^机器人/ }).getAttribute('aria-current')).toBe('page');
    expect(within(navigation).getByRole('button', { name: /^任务/ }).getAttribute('aria-current')).toBeNull();

    await user.click(within(navigation).getByRole('button', { name: /^群聊/ }));
    await screen.findByRole('heading', { name: '群聊管理' });
    expect(window.location.search).toBe('?nav=groups');
  });

  it('深链带 nav 与对象 id 时直接落到对应视图，刷新可复现', async () => {
    window.history.replaceState(null, '', '/?nav=groups&chatId=oc_chat_1');
    mockAppApi();
    mockManagementApis();
    renderApp();
    await screen.findByRole('heading', { name: '群聊管理' });
    // 选中的是 URL 指定的那个群，不是列表第一个碰巧命中的。
    expect(await screen.findByRole('heading', { name: '研发项目群' })).toBeTruthy();
  });

  it('从任务详情切去机器人再切回来，仍停在原来那条任务', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '修复登录超时')] });
    mockManagementApis();
    renderApp();
    await screen.findByRole('heading', { name: '修复登录超时' });

    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await user.click(within(navigation).getByRole('button', { name: /^机器人/ }));
    await screen.findByRole('heading', { name: '机器人管理' });
    // 任务仍在路径里，只是主区换了视图。
    expect(window.location.pathname).toBe('/sessions/s1');

    await user.click(within(navigation).getByRole('button', { name: /^任务/ }));
    expect(await screen.findByRole('heading', { name: '修复登录超时' })).toBeTruthy();
  });

  it('任务列表读取失败不挡住机器人与群聊管理', async () => {
    const user = userEvent.setup();
    mockAppApi();
    mockManagementApis();
    vi.spyOn(api, 'sessions').mockRejectedValue(new Error('sessions api down'));
    renderApp();
    // 任务视图如实报错。
    await screen.findByRole('heading', { name: '无法加载任务中心' });

    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await user.click(within(navigation).getByRole('button', { name: /^群聊/ }));
    // 群聊管理照常可用：两条路互不连坐。
    expect(await screen.findByRole('heading', { name: '群聊管理' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '无法加载任务中心' })).toBeNull();
  });
});

/*
  草稿跨主导航存活。

  机器人页与群聊页是 <main> 按 primaryNav 分派的一级视图，切换即卸载——草稿留在
  组件 useState 里就会静默丢字段。这条只能在 App 这一层验：单独渲染子组件时它
  从来不卸载，无论草稿放哪里都会「通过」。
*/
describe('编辑草稿跨视图存活', () => {
  const bot = { appId: 'cli_a', name: '开发助手', setupComplete: true, listening: true, activeListening: true, workspace: '/data/dev', defaultAgentId: 'codex', revision: 2 };

  it('改了 Bot 默认目录后切去任务再切回来，草稿仍在', async () => {
    const user = userEvent.setup();
    mockAppApi();
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: true, listeningDisabled: false, bots: [bot as never] });
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [] });
    renderApp();

    const navigation = await screen.findByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await user.click(within(navigation).getByRole('button', { name: /^机器人/ }));
    await screen.findByRole('heading', { name: '机器人管理' });

    // 列表页不自动选中首项（否则窄屏退不回列表），要先点开这个 Bot。
    await user.click(await screen.findByRole('button', { name: /开发助手/ }));
    const workspaceInput = await screen.findByDisplayValue('/data/dev');
    await user.type(workspaceInput, '-draft');
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();

    // 切去任务：机器人页整体卸载。
    await user.click(within(navigation).getByRole('button', { name: /^任务/ }));
    await screen.findByRole('heading', { name: '今天需要推进什么？' });
    expect(screen.queryByRole('heading', { name: '机器人管理' })).toBeNull();

    // 切回来，用户填的字还在。
    await user.click(within(navigation).getByRole('button', { name: /^机器人/ }));
    await screen.findByRole('heading', { name: '机器人管理' });
    // appId 留在 URL 里，切回来仍选中同一个 Bot，草稿也还在。
    expect(await screen.findByDisplayValue('/data/dev-draft')).toBeTruthy();
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();
  });

  it('群内 Bot 的草稿在切去机器人页再回来后仍在', async () => {
    const user = userEvent.setup();
    mockAppApi();
    vi.spyOn(api, 'larkConfig').mockResolvedValue({ configured: true, listeningDisabled: false, bots: [bot as never] });
    vi.spyOn(api, 'managementGroups').mockResolvedValue({ groups: [
      { key: 'k1', chatId: 'oc_chat_1', name: '研发项目群', bots: [{ appId: 'cli_a', membership: 'member', validity: 'valid', applied: true, roles: [] }] }
    ] });
    renderApp();

    const navigation = await screen.findByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await user.click(within(navigation).getByRole('button', { name: /^群聊/ }));
    await screen.findByRole('heading', { name: '群聊管理' });

    // 群列表同样不自动选首项，先点开这个群。
    await user.click(await screen.findByRole('button', { name: /研发项目群/ }));
    // 把模型改成「清空」——这是与「继承」语义不同的一档，必须被记住。
    const clearModel = await screen.findByRole('radio', { name: /使用 Agent 默认/ });
    await user.click(clearModel);
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();

    await user.click(within(navigation).getByRole('button', { name: /^机器人/ }));
    await screen.findByRole('heading', { name: '机器人管理' });

    await user.click(within(navigation).getByRole('button', { name: /^群聊/ }));
    await screen.findByRole('heading', { name: '群聊管理' });
    expect((await screen.findByRole('radio', { name: /使用 Agent 默认/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/有未保存的修改/)).toBeTruthy();
  });
});


describe('App 完整历史记录', () => {
  const history = Array.from({ length: 1_205 }, (_, index): DockEvent => ({
    id: `history-${index + 1}`, sequence: index + 1, timestamp: '2026-08-30T00:00:00Z',
    type: index === 0 || index === 1_204 ? 'text' : 'status',
    data: index === 0 ? { role: 'user', text: '最早的历史内容' } : { role: 'assistant', text: '最新的历史内容' }
  }));

  it('进入会话自动跨页读取全部记录，重新读取后仍保留完整历史', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')] });
    vi.mocked(api.events).mockImplementation(async (_id, query) => history.filter(event => query?.before === undefined || event.sequence < query.before).slice(-query!.limit!));
    const { client } = renderApp();
    expect(await screen.findByText('最早的历史内容')).toBeTruthy();
    expect(screen.getByText('最新的历史内容')).toBeTruthy();
    expect(client.getQueryData<EventWindow>(['events', 's1'])?.events).toEqual(history);
    expect(api.events).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: '加载更早记录' })).toBeNull();
    await act(() => client.invalidateQueries({ queryKey: ['events', 's1'] }));
    expect(client.getQueryData<EventWindow>(['events', 's1'])?.events).toEqual(history);
    expect(screen.getByText('最早的历史内容')).toBeTruthy();
  });

  it('历史请求失败时显示错误，重试后自动补全记录', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')] });
    vi.mocked(api.events).mockRejectedValueOnce(new Error('连接中断'));
    renderApp();
    expect(await screen.findByText('历史记录加载失败：连接中断')).toBeTruthy();
    vi.mocked(api.events).mockImplementation(async (_id, query) => history.filter(event => query?.before === undefined || event.sequence < query.before).slice(-query!.limit!));
    await userEvent.setup().click(screen.getByRole('button', { name: '重试加载记录' }));
    expect(await screen.findByText('最早的历史内容')).toBeTruthy();
    expect(screen.queryByText('历史记录加载失败：连接中断')).toBeNull();
  });
});
