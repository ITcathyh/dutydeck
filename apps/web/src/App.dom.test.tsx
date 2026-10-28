// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, agentModelSettingsApi, foundationApi, insightApi, scheduleApi, terminalSettingsApi, type Agent, type DockEvent, type RunSummary, type Session } from './api';
import type { SessionInsightDetailsResponse } from '@dutydeck/shared';
import App from './App';
import { AuthGate } from './components/AuthGate';
import { useDockStore } from './store';
import { resetDrafts } from './draft-store';
import { composerDraftKey, readComposerDraft, resetComposerDrafts } from './composer-draft';
import type { EventWindow } from './event-history';
import { shortcutDefinitions } from './useKeyboardShortcuts';
import { toastStore } from './useToasts';
import { EXPERIMENTAL_STORAGE_KEY, writeExperimental } from './experimental';

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
  vi.spyOn(api, 'turnDiffs').mockResolvedValue([]);
  vi.spyOn(api, 'workItems').mockResolvedValue({ items: [], templates: [] });
  vi.spyOn(api, 'workItemRequests').mockResolvedValue([]);
  vi.spyOn(api, 'automation').mockResolvedValue({ schedules: [], subscriptions: [], occurrences: [] });
  vi.spyOn(api, 'workspaceGroups').mockResolvedValue({ organization: { groups: [], directoryGroups: {}, sessionGroups: {} }, workspaces: [] });
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
  resetComposerDrafts();
  Object.keys(window.localStorage).filter(key => key.startsWith('dutydeck:view:')).forEach(key => window.localStorage.removeItem(key));
  toastStore.clear();
  window.localStorage.removeItem(EXPERIMENTAL_STORAGE_KEY);
  window.history.replaceState(null, '', '/');
});

describe('App summary updates', () => {
  it('keeps the current task summary when a lagging list refresh arrives', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '已取消的旧目标')] });
    const task = { id: 'fresh-task', sessionId: 's1', prompt: '当前任务目标', status: 'running', createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:01:00Z' };
    vi.mocked(api.tasks).mockResolvedValue([task]);
    const { client } = renderApp();
    await screen.findByRole('heading', { level: 1, name: task.prompt });
    const cachedTasks = client.getQueryData(['tasks', 's1']);

    await act(async () => {
      client.setQueryData(['run-summaries'], [{ ...summary('s1', '已取消的旧目标'), queuedCount: 1 }]);
    });

    expect(client.getQueryData(['tasks', 's1'])).toBe(cachedTasks);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(task.prompt);
  });

  it('retains another session summary when the selected session tasks change', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1'), session('s2')], summaries: [summary('s1', '旧目标'), summary('s2', '第二个任务')] });
    const task = { id: 'fresh-task', sessionId: 's1', prompt: '更新后的目标', status: 'running', createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:01:00Z' };
    vi.mocked(api.tasks).mockImplementation(async id => id === 's1' ? [task] : []);
    const { client } = renderApp();
    await screen.findByRole('heading', { level: 1, name: task.prompt });
    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await userEvent.click(within(navigation).getByRole('button', { name: /第二个任务/ }));
    await screen.findByRole('heading', { level: 1, name: '第二个任务' });
    await act(async () => {
      client.setQueryData(['tasks', 's2'], [{ ...task, id: 'second-task', sessionId: 's2', prompt: '第二个任务的新目标' }]);
    });

    expect(within(navigation).getByRole('button', { name: /更新后的目标/ })).toBeTruthy();
  });

  it('shows a newly created task title before the summary list includes it', async () => {
    mockAppApi();
    const created = session('s1');
    const task = { id: 'created-task', sessionId: created.id, prompt: '新建后立即显示的目标', status: 'queued', createdAt: created.createdAt, updatedAt: created.updatedAt };
    vi.spyOn(api, 'create').mockResolvedValue(created);
    vi.spyOn(api, 'send').mockImplementation(async () => {
      vi.mocked(api.sessions).mockResolvedValue([created]);
      return { accepted: true, task };
    });
    const { container, client } = renderApp();
    await screen.findByRole('heading', { level: 1, name: '工作台' });
    await userEvent.click(within(container.querySelector('main')!).getByRole('button', { name: '创建任务' }));
    const dialog = await screen.findByRole('dialog', { name: '创建新任务' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '任务目标' }), { target: { value: task.prompt } });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /确认允许 Agent 直接操作此工作目录/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: '创建并执行' }));

    expect(await screen.findByRole('heading', { level: 1, name: task.prompt })).toBeTruthy();
    expect(client.getQueryData(['run-summaries'])).toEqual([]);
  });
});

describe('App 批量清理', () => {
  function setup() {
    window.history.replaceState(null, '', '/?nav=tasks');
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
  it('closes the drawer after crossing 768px and keeps it closed on returning to mobile', async () => {
    let width = 767.5;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      get matches() { const min = /min-width: (\d+)px/.exec(query)?.[1]; return min !== undefined && width >= Number(min); },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener)
    })));
    mockAppApi();
    const { container } = renderApp();
    const trigger = await screen.findByRole('button', { name: '打开工作台导航' });
    const main = container.querySelector('main')!;
    await userEvent.click(trigger);
    expect(main.hasAttribute('inert')).toBe(true);
    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    act(() => { width = 768; for (const listener of listeners) listener(); });
    expect(main.hasAttribute('inert')).toBe(false);
    act(() => { width = 767.5; for (const listener of listeners) listener(); });
    expect(main.hasAttribute('inert')).toBe(false);
    expect(navigation.getAttribute('aria-hidden')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: '打开工作台导航' }));
    expect(main.hasAttribute('inert')).toBe(true);
  });

  it('keeps desktop navigation behavior when matchMedia is unavailable', async () => {
    vi.stubGlobal('matchMedia', undefined);
    mockAppApi();
    const { container } = renderApp();
    await screen.findByRole('heading', { level: 1, name: '工作台' });
    expect(screen.getByRole('button', { name: '收起侧栏' })).toBeTruthy();
    await userEvent.keyboard('{Control>}b{/Control}');
    expect(screen.getByRole('button', { name: '展开侧栏' })).toBeTruthy();
    expect(container.querySelector('main')!.hasAttribute('inert')).toBe(false);
  });

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
    await screen.findByRole('heading', { level: 1, name: '工作台' });
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
    await screen.findByRole('heading', { level: 1, name: '工作台' });
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
    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeTruthy();
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
    expect(pushState).toHaveBeenCalledWith({ sessionId: 's1', dutydeckHistoryPosition: 1, dutydeckTaskFilters: { view: 'all', query: '', project: '' } }, '', '/sessions/s1');
    expect(window.location.pathname).toBe('/sessions/s1');
    await screen.findByRole('button', { name: '归档任务' });

    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { level: 1, name: '工作台' });

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
    await screen.findByRole('heading', { level: 1, name: '工作台' });
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
    await screen.findByRole('heading', { level: 1, name: '工作台' });
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

    const staleStatus = await screen.findByText(/部分数据可能不是最新：任务列表/);
    expect(staleStatus.closest('[role="status"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: '归档任务' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { level: 1, name: '工作台' });
    expect(screen.getByText(/部分数据可能不是最新：任务列表/).closest('[role="status"]')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByText(/部分数据可能不是最新：任务列表/)).toBeNull());
  });

  it.each(['/foo', '/sessions/a/extra'])('shows not-found for unknown pathname %s', async pathname => {
    window.history.replaceState(null, '', pathname);
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')] });
    renderApp();

    expect(await screen.findByRole('heading', { name: '找不到这个页面' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: '工作台' })).toBeNull();
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
    const timelineTab = screen.getByRole('tab', { name: '对话' });
    const changesTab = screen.getByRole('tab', { name: '改动' });
    const terminalTab = screen.getByRole('tab', { name: '终端' });
    expect(timelineTab.getAttribute('aria-selected')).toBe('true');
    expect(terminalTab.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tabpanel', { name: '对话' })).toBeTruthy();

    timelineTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(changesTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(changesTab);
    await userEvent.keyboard('{ArrowRight}');
    expect(terminalTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(terminalTab);
    expect(await screen.findByRole('tabpanel', { name: '终端' })).toBeTruthy();

    await userEvent.keyboard('{ArrowLeft}');
    expect(changesTab.getAttribute('aria-selected')).toBe('true');
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
    expect(within(palette).getByRole('option', { name: /打开 Agent 设置/ })).toBeTruthy();
    expect(within(palette).getByRole('option', { name: /打开插件与 Skills/ })).toBeTruthy();
    expect(within(palette).getByRole('option', { name: /查看用量与上下文/ })).toBeTruthy();
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
    expect(screen.queryByRole('heading', { level: 1, name: '工作台' })).toBeNull();

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
    await screen.findByRole('heading', { level: 1, name: '工作台' });
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

    await user.click(screen.getByRole('button', { name: '重新加入队尾' }));
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

  it('实验功能关闭时，?panel=groups 深链不打开群配置浮层；打开后才出现', async () => {
    window.history.replaceState(null, '', '/?panel=groups');
    mockAppApi();
    mockFoundation();
    renderApp();
    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '群配置与权限' })).toBeNull();
    expect(screen.queryByRole('button', { name: /群与权限/ })).toBeNull();
    act(() => writeExperimental(true));
    expect(await screen.findByRole('dialog', { name: '群配置与权限' })).toBeTruthy();
    act(() => writeExperimental(false));
  });

  it('未知 panel 值不打开任何浮层', async () => {
    window.history.replaceState(null, '', '/?panel=totally-made-up');
    mockAppApi();
    renderApp();
    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeTruthy();
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
    await screen.findByRole('heading', { name: /无法读取飞书接入状态/ });
    const aside = screen.getByRole('complementary', { name: '协作入口' });
    expect(within(aside).getByRole('heading', { name: /无法读取飞书接入状态/ })).toBeTruthy();
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
    await screen.findByRole('heading', { name: /无法读取飞书接入状态/ });
    const aside = screen.getByRole('complementary', { name: '协作入口' });
    expect(within(aside).getByRole('heading', { name: /无法读取飞书接入状态/ })).toBeTruthy();
    const callsBefore = spy.mock.calls.length;

    // 这一次让它成功，且返回一个「配置完成但本实例未开启监听」的 Bot。
    spy.mockResolvedValue({ configured: true, listeningDisabled: false, bots: [{ appId: 'cli_retry', name: '重试机器人', setupComplete: true, listening: false, activeListening: false } as never] });
    await userEvent.click(within(aside).getByRole('button', { name: '重试' }));

    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /无法读取飞书接入状态/ })).toBeNull());
    // 改口后必须是真实状态，而不是「已接入」。
    expect(await screen.findByText('本实例未开启监听')).toBeTruthy();
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
    expect(within(dialog).getAllByText(/本实例未开启监听/).length).toBeGreaterThan(0);
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

    // 默认在工作台；全部任务与管理入口有独立位置。
    expect(within(navigation).getByRole('button', { name: /^工作台/ }).getAttribute('aria-current')).toBe('page');
    expect(within(navigation).getByRole('button', { name: /^全部任务/ }).getAttribute('aria-current')).toBeNull();
    expect(window.location.search).toBe('');

    await user.click(within(navigation).getByRole('button', { name: /^机器人/ }));
    await screen.findByRole('heading', { name: '机器人管理' });
    expect(window.location.search).toBe('?nav=bots');
    expect(within(navigation).getByRole('button', { name: /^机器人/ }).getAttribute('aria-current')).toBe('page');
    expect(within(navigation).getByRole('button', { name: /^全部任务/ }).getAttribute('aria-current')).toBeNull();

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

    await user.click(within(navigation).getByRole('button', { name: /^全部任务/ }));
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
    await user.click(within(navigation).getByRole('button', { name: /^全部任务/ }));
    await screen.findByRole('heading', { level: 1, name: '全部任务' });
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

  it('首屏只读摘要，展开跨页完整读取并在刷新后保留已读详情', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')] });
    vi.mocked(api.sessionHistory).mockResolvedValue({ turns: [{ id: 'history-1', firstSequence: 1, lastSequence: 1205, timestamp: '', status: 'completed', prompt: { text: '最早的历史内容', truncated: false }, output: { text: '最新的历史内容', truncated: false }, toolCount: 0, artifactReferences: [] }], highWaterMark: 1205, liveAfter: 1205 });
    vi.mocked(api.events).mockImplementation(async (_id, query) => history.filter(event => event.sequence > query!.after! && (!query?.before || event.sequence < query.before)).slice(0, query!.limit));
    const { client } = renderApp();
    expect(await screen.findByText('最早的历史内容')).toBeTruthy();
    expect(screen.getByText('最新的历史内容')).toBeTruthy();
    expect(client.getQueryData<EventWindow>(['events', 's1'])?.events).toEqual([]);
    expect(api.events).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole('button', { name: '展开完整记录' }));
    await screen.findByRole('button', { name: '收起完整记录' });
    await waitFor(() => expect(client.getQueryData(['history-detail', 's1', 1, 1205])).toEqual(history));
    expect(api.events).toHaveBeenCalledTimes(8);
    expect(screen.queryByRole('button', { name: '加载更早记录' })).toBeNull();
    await act(() => client.invalidateQueries({ queryKey: ['events', 's1'] }));
    expect(client.getQueryData(['history-detail', 's1', 1, 1205])).toEqual(history);
  });

  it('历史请求失败时显示错误，重试后加载活动记录', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')] });
    vi.mocked(api.events).mockRejectedValueOnce(new Error('连接中断'));
    renderApp();
    expect(await screen.findByText('历史记录加载失败：连接中断')).toBeTruthy();
    vi.mocked(api.events).mockImplementation(async (_id, query) => history.filter(event => event.sequence > query!.after!).slice(0, query!.limit!));
    await userEvent.setup().click(screen.getByRole('button', { name: '重试加载记录' }));
    await waitFor(() => expect(vi.mocked(api.events)).toHaveBeenLastCalledWith('s1', { after: 1200, limit: 200, direction: 'forward' }, expect.any(AbortSignal)));
    expect(screen.queryByText('历史记录加载失败：连接中断')).toBeNull();
  });

  it('在会话详情点击「重命名会话」打开弹窗并完成改名', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    const s1 = session('s1');
    mockAppApi({ sessions: [s1], summaries: [summary('s1', '原始任务目标')] });
    vi.spyOn(api, 'setSessionName').mockResolvedValue({ ...s1, name: '改名后的任务' });
    const user = userEvent.setup();
    renderApp();

    expect(await screen.findByRole('heading', { name: '原始任务目标' })).toBeTruthy();
    const renameButton = screen.getByRole('button', { name: '重命名会话' });
    await user.click(renameButton);

    expect(screen.getByRole('dialog', { name: '重命名会话' })).toBeTruthy();
    const input = screen.getByRole('textbox', { name: '会话名称' });
    await user.type(input, '改名后的任务');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(api.setSessionName).toHaveBeenCalledWith('s1', '改名后的任务');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '重命名会话' })).toBeNull();
    });
    expect(await screen.findByRole('heading', { name: '改名后的任务' })).toBeTruthy();
  });
});


describe('App 插话结果反馈', () => {
  it('发送器插话返回未知时提示核对，不承诺重新排队', async () => {
    const user = userEvent.setup();
    const active = session('s1', 'thinking');
    const task = { id: 'new-steering', sessionId: active.id, prompt: '追加一条核对', status: 'reconcile_required', createdAt: active.createdAt, updatedAt: active.updatedAt };
    mockAppApi({ sessions: [active], summaries: [summary('s1', '当前任务')] });
    const send = vi.spyOn(api, 'send').mockResolvedValue({ accepted: true, task, steering: { outcome: 'failed' } });
    renderApp();
    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await user.click(await within(navigation).findByRole('button', { name: /当前任务/ }));
    await user.type(await screen.findByRole('textbox', { name: '消息' }), task.prompt);
    await user.click(screen.getByRole('button', { name: '排队' }));
    await user.click(screen.getByRole('button', { name: '插话到当前这一轮' }));
    await user.click(screen.getByRole('button', { name: /^(发送消息|加入队列|立即插话|停止当前执行并发送)$/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(active.id, task.prompt, 'steer', []));
    await waitFor(() => expect(toastStore.getSnapshot().find(toast => toast.key === 'steering')?.title).toBe('插话投递结果未知'));
    expect(toastStore.getSnapshot().find(toast => toast.key === 'steering')?.description).toContain('不会自动重发');
  });

  it.each(['reconcile_required', 'queued', 'completed'] as const)('排队按钮按持久状态 %s 回报插话结果', async status => {
    const user = userEvent.setup();
    const active = session('s1', 'thinking');
    const queued = { id: 'queued-1', sessionId: active.id, prompt: '核对第二条指令', status: 'queued', createdAt: active.createdAt, updatedAt: active.updatedAt };
    mockAppApi({ sessions: [active], summaries: [summary('s1', '当前任务')] });
    vi.mocked(api.tasks).mockResolvedValue([queued]);
    const inject = vi.spyOn(api, 'injectQueued').mockImplementation(async () => {
      vi.mocked(api.tasks).mockResolvedValue([{ ...queued, status }]);
      return { task: { ...queued, status }, outcome: status === 'queued' ? 'unsupported' : 'failed' };
    });
    renderApp();
    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await user.click(await within(navigation).findByRole('button', { name: /当前任务/ }));
    await user.click(await screen.findByRole('button', { name: '立即插话' }));
    await waitFor(() => expect(inject).toHaveBeenCalledWith(active.id, queued.id));
    await waitFor(() => expect(toastStore.getSnapshot().find(toast => toast.key === 'steering')).toBeDefined());
    const toast = toastStore.getSnapshot().find(item => item.key === 'steering')!;
    if (status === 'reconcile_required') {
      expect(toast.title).toBe('插话投递结果未知');
      expect(toast.description).toContain('在执行记录下方选择重新执行、标为已完成或标为失败');
      expect(toast.description).toContain('不会自动重发');
      expect(toast.description).not.toContain('当前任务完成后会执行它');
    } else if (status === 'completed') {
      expect(toast.title).toBe('插话请求未确认');
      expect(toast.description).toContain('已不在队列中');
      expect(toast.description).not.toContain('当前任务完成后会执行它');
    } else {
      expect(toast.title).toBe('没有插话，这条指令在排队');
      expect(toast.description).toContain('不支持插话');
      expect(toast.description).toContain('当前任务完成后会执行它');
    }
  });
});

describe('App 会话分析深链与导航', () => {
  const insightDetails = (sessionId: string, state: SessionInsightDetailsResponse['status']['refreshState'] = 'idle', snapshotId: string | null = null): SessionInsightDetailsResponse => ({
    status: { sessionId, refreshState: state, availability: snapshotId ? 'complete' : 'none', freshness: snapshotId ? 'current' : 'unknown', currentSnapshotId: snapshotId, requestId: null, errorCode: null },
    summary: null, manifest: null, hostEvidence: null
  });

  function mockInsight() {
    vi.spyOn(insightApi, 'details').mockImplementation(async (id: string) => insightDetails(id));
    vi.spyOn(insightApi, 'refresh').mockResolvedValue({ requestId: '33333333-3333-4333-8333-333333333333', state: 'queued', cacheHit: false });
    vi.spyOn(insightApi, 'cancel').mockResolvedValue({ success: true, state: 'cancelled' });
  }

  it('RunHeader「分析」打开 Dialog lazy 面板并写入 ?panel=insight，后退关闭、前进重开', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', '任务一')] });
    mockInsight();
    const user = userEvent.setup();
    const pushState = vi.spyOn(window.history, 'pushState');
    renderApp();
    await screen.findByRole('heading', { name: '任务一' });

    await user.click(screen.getByRole('button', { name: '会话分析' }));
    const dialog = await screen.findByRole('dialog', { name: '会话分析' });
    expect(dialog).toBeTruthy();
    expect(pushState).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }), '', '/sessions/s1?panel=insight');

    // 后退：关闭面板。
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '会话分析' })).toBeNull());

    // 前进：沿同一历史记录重开。
    act(() => window.history.forward());
    expect(await screen.findByRole('dialog', { name: '会话分析' })).toBeTruthy();
  });

  it('深链 /sessions/:id?panel=insight 直接打开分析面板，?compare= 带入对比会话', async () => {
    window.history.replaceState(null, '', '/sessions/s1?panel=insight&compare=s2');
    mockAppApi({ sessions: [session('s1'), session('s2')], summaries: [summary('s1', '任务一')] });
    const detailsSpy = vi.spyOn(insightApi, 'details').mockImplementation(async (id: string) => insightDetails(id));
    renderApp();
    await screen.findByRole('dialog', { name: '会话分析' });
    await waitFor(() => expect(detailsSpy).toHaveBeenCalledWith('s2', null, expect.any(AbortSignal)));
    // 对比会话没有快照时的提示（对比不隐式分析）。
    expect(await screen.findByText(/对比会话 s2 还没有分析快照/)).toBeTruthy();
  });

  it('非会话路由上的 ?panel=insight 不打开面板', async () => {
    window.history.replaceState(null, '', '/?panel=insight');
    mockAppApi();
    renderApp();
    await screen.findByRole('heading', { level: 1, name: '工作台' });
    // 等待一个 tick 确认 lazy 面板没有挂载。
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByRole('dialog', { name: '会话分析' })).toBeNull();
  });

  it('panel=usage&view=insight 恢复「会话分析」tab，选会话跳转到该会话的分析面板', async () => {
    window.history.replaceState(null, '', '/?panel=usage&view=insight');
    mockAppApi({ sessions: [session('s1'), session('s2')] });
    vi.spyOn(api, 'usageSummary').mockResolvedValue({} as never);
    vi.spyOn(insightApi, 'summary').mockResolvedValue({
      candidateSessions: 1, withSnapshot: 0, withoutSnapshot: 1, partialSnapshots: 0, failedRefreshes: 0, staleSnapshots: 0, freshnessUnknown: 1,
      groups: [],
      sessions: [{
        sessionId: 's1', workspace: 'repo', agentId: 'codex', usage: 'explicit', createdAt: '2026-10-01T00:00:00.000Z',
        refreshState: 'idle', errorCode: null, lastCheckedAt: null, hasSnapshot: false, snapshotId: null,
        availability: 'none' as const, freshness: 'unknown' as const, models: [], metrics: null, metricAttributions: {}, isSharedSource: false
      }],
      nextCursor: null
    });
    vi.spyOn(insightApi, 'details').mockImplementation(async (id: string) => insightDetails(id));
    const user = userEvent.setup();
    renderApp();

    const usageDialog = await screen.findByRole('dialog', { name: '用量与成本' });
    // 会话分析 tab 被深链选中（lazy 面板 Suspense 加载完成后出现）。
    const insightTab = await within(usageDialog).findByRole('tab', { name: '会话分析' });
    expect(insightTab.getAttribute('aria-selected')).toBe('true');
    await within(usageDialog).findByRole('region', { name: '候选会话覆盖' });

    await user.click(within(usageDialog).getByRole('button', { name: 's1' }));
    // 关闭用量浮层，进入会话详情 + 分析面板。
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '用量与成本' })).toBeNull());
    expect(await screen.findByRole('dialog', { name: '会话分析' })).toBeTruthy();
    expect(window.location.pathname).toBe('/sessions/s1');
    expect(window.location.search).toBe('?panel=insight');
  });
});

describe('App pending composer mutations', () => {
  const queuedTask = (id: string) => ({ id, sessionId: 's1', prompt: id, status: 'queued', createdAt: '2026-08-30T00:00:00Z', updatedAt: '2026-08-30T00:00:00Z' });

  function setup() {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1', 'thinking'), session('s2')], summaries: [summary('s1', 'first session'), summary('s2', 'second session')] });
  }

  it.each([
    ['cancelQueued', true], ['cancelQueued', false], ['steerQueued', true], ['steerQueued', false]
  ] as const)('%s freezes the queue only until the request settles (success=%s)', async (operation, success) => {
    setup();
    const queued = [queuedTask('q1'), queuedTask('q2')];
    vi.mocked(api.tasks).mockResolvedValue(queued);
    let resolve!: (value: Awaited<ReturnType<typeof api.cancelQueued>>) => void;
    let reject!: (error: Error) => void;
    const request = vi.spyOn(api, operation).mockImplementation(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    renderApp();
    await screen.findByRole('button', { name: '取消排队：q1' });
    const firstAction = operation === 'cancelQueued' ? screen.getByRole('button', { name: '取消排队：q1' }) : screen.getAllByRole('button', { name: '打断当前任务并执行' })[0];
    await userEvent.click(firstAction);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const remainingRow = () => screen.getByRole('button', { name: '取消排队：q2' }).parentElement!;
    for (const button of within(remainingRow()).getAllByRole('button')) expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '取消排队：q2' }));
    expect(request).toHaveBeenCalledTimes(1);
    const result = { ...queued[0], status: operation === 'cancelQueued' ? 'cancelled' : 'running' };
    if (success) vi.mocked(api.tasks).mockResolvedValue([result, queued[1]]);
    await act(async () => { if (success) resolve(result); else reject(new Error('queue request failed')); });
    await waitFor(() => {
      for (const button of within(remainingRow()).getAllByRole('button')) expect(button.hasAttribute('disabled')).toBe(false);
    });
    const cancel = operation === 'cancelQueued' ? request : vi.spyOn(api, 'cancelQueued');
    cancel.mockResolvedValue({ ...queued[1], status: 'cancelled' });
    await userEvent.click(screen.getByRole('button', { name: '取消排队：q2' }));
    await waitFor(() => expect(cancel).toHaveBeenLastCalledWith('s1', 'q2'));
  });

  async function addFile(path: string) {
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '/file' } });
    await userEvent.click(screen.getByRole('button', { name: /\/file/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '本地文件路径' }), { target: { value: path } });
    await userEvent.click(screen.getByRole('button', { name: '引用' }));
  }

  it.each(['text', 'references', 'new references', 'unchanged', 'failure', 'session'] as const)('preserves the appropriate draft after a delayed send: %s', async change => {
    setup();
    let resolve!: (value: Awaited<ReturnType<typeof api.send>>) => void;
    let reject!: (error: Error) => void;
    const send = vi.spyOn(api, 'send').mockImplementation(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    const { client } = renderApp();
    await screen.findByRole('textbox', { name: '消息' });
    await addFile('/tmp/first.ts');
    const input = () => screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    fireEvent.change(input(), { target: { value: '  first instruction  ' } });
    await userEvent.click(await screen.findByRole('button', { name: /^(发送消息|加入队列|立即插话|停止当前执行并发送)$/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('s1', '/file /tmp/first.ts\n\nfirst instruction', 'queue', []));
    if (change === 'text') fireEvent.change(input(), { target: { value: 'second unsent draft' } });
    if (change === 'references') await userEvent.click(screen.getByRole('button', { name: '移除引用 first.ts' }));
    if (change === 'new references') {
      await addFile('/tmp/second.ts');
      fireEvent.change(input(), { target: { value: '  first instruction  ' } });
    }
    if (change === 'session') {
      const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
      await userEvent.click(within(navigation).getByRole('button', { name: /second session/ }));
      fireEvent.change(input(), { target: { value: 'other session draft' } });
      await addFile('/tmp/second.ts');
      fireEvent.change(input(), { target: { value: 'other session draft' } });
    }
    await act(async () => { if (change === 'failure') reject(new Error('send failed')); else resolve({ accepted: true, task: queuedTask('sent') }); });
    await waitFor(() => expect(client.isMutating()).toBe(0));
    await waitFor(() => expect(input().value).toBe(change === 'unchanged' ? '' : change === 'text' ? 'second unsent draft' : change === 'session' ? 'other session draft' : '  first instruction  '));
    expect(Boolean(screen.queryByRole('button', { name: '移除引用 first.ts' }))).toBe(change === 'text' || change === 'failure' || change === 'new references');
    expect(Boolean(screen.queryByRole('button', { name: '移除引用 second.ts' }))).toBe(change === 'session' || change === 'new references');
  });
});


describe('App same-session overlay draft preservation', () => {
  it.each(['Escape', 'close', 'back'] as const)('keeps independent text and references across settings %s, task changes and browser history', async close => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1'), session('s2')], summaries: [summary('s1', 'first session'), summary('s2', 'second session')] });
    renderApp();
    const input = () => screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    await screen.findByRole('textbox', { name: '消息' });
    fireEvent.change(input(), { target: { value: '/file' } });
    await userEvent.click(screen.getByRole('button', { name: /\/file/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '本地文件路径' }), { target: { value: '/tmp/draft.ts' } });
    await userEvent.click(screen.getByRole('button', { name: '引用' }));
    fireEvent.change(input(), { target: { value: 'unfinished draft 123' } });
    const navigation = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await userEvent.click(within(navigation).getByRole('button', { name: /Agent 与设置/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
    if (close === 'Escape') await userEvent.keyboard('{Escape}');
    else if (close === 'close') await userEvent.click(within(dialog).getByRole('button', { name: '关闭设置与接入' }));
    else act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeNull());
    expect(input().value).toBe('unfinished draft 123');
    expect(screen.getByRole('button', { name: '移除引用 draft.ts' })).toBeTruthy();
    act(() => window.history.forward());
    await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeNull());
    expect(input().value).toBe('unfinished draft 123');
    expect(screen.getByRole('button', { name: '移除引用 draft.ts' })).toBeTruthy();
    await userEvent.click(within(navigation).getByRole('button', { name: /second session/ }));
    expect(input().value).toBe('');
    expect(screen.queryByRole('button', { name: '移除引用 draft.ts' })).toBeNull();
    fireEvent.change(input(), { target: { value: 'second session draft' } });
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe('/sessions/s1'));
    await waitFor(() => expect(input().value).toBe('unfinished draft 123'));
    expect(screen.getByRole('button', { name: '移除引用 draft.ts' })).toBeTruthy();
    act(() => window.history.forward());
    await waitFor(() => expect(window.location.pathname).toBe('/sessions/s2'));
    expect(input().value).toBe('second session draft');
  });
});


describe('App archived workspace deep link', () => {
  it('selects the archived old session and opens its existing workspace panel after login', async () => {
    window.history.replaceState(null, '', '/sessions/old%20session?panel=workspace');
    const old = { ...session('old session', 'stopped'), archivedAt: '2026-10-21T00:00:00Z', workspaceMode: 'worktree' as const };
    mockAppApi({ sessions: [session('new-session'), old] });
    vi.mocked(api.authStatus).mockResolvedValue({ authenticated: false, required: true });
    const login = vi.spyOn(api, 'login').mockImplementation(async () => {
      vi.mocked(api.authStatus).mockResolvedValue({ authenticated: true, required: true });
      return { authenticated: true, required: true };
    });
    const workspace = vi.spyOn(api, 'workspace').mockResolvedValue({ schemaVersion: 1, revision: 1, sessionId: old.id, mode: 'worktree', sourceCwd: '/repo', cwd: '/repo/old-worktree', state: 'ready', branch: 'old-branch', createdAt: old.createdAt, updatedAt: old.updatedAt });
    vi.spyOn(api, 'turnDiffs').mockResolvedValue([]);
    const preview = vi.spyOn(api, 'workspaceCleanupPreview');
    const clean = vi.spyOn(api, 'cleanWorkspace');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><AuthGate><App/></AuthGate></QueryClientProvider>);
    await screen.findByRole('heading', { name: '连接到这台 Dutydeck' });
    expect(api.sessions).not.toHaveBeenCalled();
    expect(workspace).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?panel=workspace');
    await userEvent.type(screen.getByLabelText('访问令牌'), 'access-token');
    await userEvent.click(screen.getByRole('button', { name: '连接工作台' }));
    const dialog = await screen.findByRole('dialog', { name: '结果检视' });
    expect(login).toHaveBeenCalledWith('access-token');
    await within(dialog).findByText('/repo/old-worktree');
    expect(workspace).toHaveBeenCalledWith(old.id);
    expect(useDockStore.getState().activeSessionId).toBe(old.id);
    expect(screen.getByText('该任务已归档，只能查看历史记录。')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '检查可否清理' })).toBeTruthy();
    expect(preview).not.toHaveBeenCalled();
    expect(clean).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: '关闭结果检视' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '结果检视' })).toBeNull());
    expect(window.location.pathname).toBe('/sessions/old%20session');
    expect(window.location.search).toBe('');
  });

  it('opens the archived workspace directly for an authenticated visitor', async () => {
    window.history.replaceState(null, '', '/sessions/s1?panel=workspace');
    mockAppApi({ sessions: [{ ...session('s1', 'stopped'), archivedAt: '2026-10-21T00:00:00Z' }] });
    vi.spyOn(api, 'workspace').mockResolvedValue({ schemaVersion: 1, revision: 1, sessionId: 's1', mode: 'worktree', sourceCwd: '/repo', cwd: '/repo/s1', state: 'ready', createdAt: '', updatedAt: '' });
    const preview = vi.spyOn(api, 'workspaceCleanupPreview');
    const clean = vi.spyOn(api, 'cleanWorkspace');
    renderApp();
    expect(await screen.findByRole('dialog', { name: '结果检视' })).toBeTruthy();
    expect(useDockStore.getState().activeSessionId).toBe('s1');
    expect(preview).not.toHaveBeenCalled(); expect(clean).not.toHaveBeenCalled();
  });
});


it('shows session background lifecycle separately while preserving the current running task', async () => {
  window.history.replaceState(null, '', '/sessions/s1');
  const events: DockEvent[] = [
    { id: 'input', sequence: 1, timestamp: '', type: 'text', data: { role: 'user', text: 'current business request' } },
    { id: 'answer', sequence: 2, timestamp: '', type: 'text', data: { role: 'assistant', text: 'main round answer' } },
    { id: 'background', sequence: 3, timestamp: '', type: 'status', data: { state: 'background_work', count: 1, mainTurnEnded: true, tasks: [{ id: 'old-native-task', toolUseId: 'old-tool', originInputId: 'older-input', kind: 'agent', state: 'running' }] } }
  ];
  const task = { id: 'current-task', sessionId: 's1', prompt: 'current business request', status: 'running', createdAt: '', updatedAt: '' };
  mockAppApi({ sessions: [session('s1', 'thinking')], events });
  vi.mocked(api.tasks).mockResolvedValue([task]);
  const { client, container } = renderApp();
  await userEvent.click(await screen.findByRole('button', { name: '结果检视' }));
  const inspector = await screen.findByRole('dialog', { name: '结果检视' });
  await userEvent.click(within(inspector).getByText('详细用量与后台状态'));
  await within(inspector).findByText('主回合已结束 · 后台子任务运行中（1）');
  await userEvent.click(within(inspector).getByRole('button', { name: '关闭结果检视' }));
  const activity = await screen.findByLabelText('Codex 执行过程');
  await userEvent.click(activity.querySelector('summary')!);
  expect(await within(activity).findByText('main round answer')).toBeTruthy();
  expect(client.getQueryData(['tasks', 's1'])).toEqual([task]);
  expect(client.getQueryData<Session[]>(['sessions'])?.[0]?.state).toBe('thinking');
  expect(container.querySelector('[data-timeline-event="background"]')).toBeNull();
  expect(container.querySelector('[data-timeline-scroll]')?.textContent).not.toContain('old-native-task');
});


describe('Calm workbench continuity', () => {
  it.each([false, true])('acknowledges the submitted task after switching away and back (new draft=%s)', async edited => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1'), session('s2')], summaries: [summary('s1', 'first task'), summary('s2', 'second task')] });
    let resolve!: (value: Awaited<ReturnType<typeof api.send>>) => void;
    const send = vi.spyOn(api, 'send').mockImplementation(() => new Promise(done => { resolve = done; }));
    const { client } = renderApp();
    const input = () => screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    await screen.findByRole('textbox', { name: '消息' });
    fireEvent.change(input(), { target: { value: 'submitted first draft' } });
    await userEvent.click(screen.getByRole('button', { name: /^(发送消息|加入队列|立即插话|停止当前执行并发送)$/ }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const nav = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await userEvent.click(within(nav).getByRole('button', { name: /second task/ }));
    fireEvent.change(input(), { target: { value: 'second task retained' } });
    await userEvent.click(within(nav).getByRole('button', { name: /first task/ }));
    expect(input().value).toBe('submitted first draft');
    if (edited) fireEvent.change(input(), { target: { value: 'new first draft' } });
    await act(async () => resolve({ accepted: true, task: { id: 'sent', sessionId: 's1', prompt: 'submitted first draft', status: 'queued', createdAt: session('s1').createdAt, updatedAt: session('s1').updatedAt } }));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect(input().value).toBe(edited ? 'new first draft' : '');
    await userEvent.click(within(nav).getByRole('button', { name: /second task/ }));
    expect(input().value).toBe('second task retained');
  });

  it('preserves text and references after unmounting and remounting the workbench', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')] });
    const first = renderApp();
    await screen.findByRole('textbox', { name: '消息' });
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '/file' } });
    await userEvent.click(screen.getByRole('button', { name: /\/file/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '本地文件路径' }), { target: { value: '/tmp/preserved.ts' } });
    await userEvent.click(screen.getByRole('button', { name: '引用' }));
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: 'restore on reload' } });
    first.unmount(); first.client.clear();
    renderApp();
    expect((await screen.findByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('restore on reload');
    expect(screen.getByRole('button', { name: '移除引用 preserved.ts' })).toBeTruthy();
  });

  it('offers keyboard sidebar resizing within its limits and remembers collapse', async () => {
    mockAppApi();
    const first = renderApp();
    const separator = screen.getByRole('separator', { name: '调整侧栏宽度' });
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator.getAttribute('aria-valuenow')).toBe('320');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator.getAttribute('aria-valuenow')).toBe('320');
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator.getAttribute('aria-valuenow')).toBe('208');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator.getAttribute('aria-valuenow')).toBe('208');
    await userEvent.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(screen.queryByRole('separator', { name: '调整侧栏宽度' })).toBeNull();
    first.unmount(); first.client.clear();
    renderApp();
    expect(screen.getByRole('button', { name: '展开侧栏' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '展开侧栏' }));
    expect(screen.getByRole('separator', { name: '调整侧栏宽度' }).getAttribute('aria-valuenow')).toBe('208');
  });
});


it('keeps global-search selections in navigation and restores the original task filter on Back', async () => {
  window.history.replaceState(null, '', '/?nav=tasks');
  mockAppApi({ sessions: [session('s1', 'waiting_for_permission'), session('s2', 'completed')], summaries: [summary('s1', 'awaiting target'), summary('s2', 'completed target')] });
  renderApp();
  const filters = await screen.findByRole('region', { name: '任务筛选' });
  await userEvent.click(within(filters).getByRole('button', { name: '待你处理 1' }));
  fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
  const search = await screen.findByRole('combobox', { name: '搜索任务与命令' });
  fireEvent.change(search, { target: { value: 'completed target' } });
  await userEvent.click(screen.getByRole('option', { name: /completed target/ }));
  await screen.findByRole('heading', { level: 1, name: 'completed target' });
  const nav = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
  expect(within(nav).getByRole('button', { name: /completed target/ }).getAttribute('aria-current')).toBe('true');
  act(() => window.history.back());
  const restored = await screen.findByRole('region', { name: '任务筛选' });
  expect(within(restored).getByRole('button', { name: '待你处理 1' }).getAttribute('aria-pressed')).toBe('true');
  expect(window.location.search).toBe('?nav=tasks');
});


it('keeps task content modes independent and only offers a terminal for PTY connections', async () => {
  window.history.replaceState(null, '', '/sessions/s1');
  mockAppApi({ sessions: [session('s1'), session('s2')], summaries: [summary('s1', 'first mode task'), summary('s2', 'second mode task')] });
  renderApp();
  const changes = await screen.findByRole('tab', { name: '改动' });
  expect(screen.queryByRole('tab', { name: '终端' })).toBeNull();
  await userEvent.click(changes);
  expect(changes.getAttribute('aria-selected')).toBe('true');
  const nav = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
  await userEvent.click(within(nav).getByRole('button', { name: /second mode task/ }));
  expect(screen.getByRole('tab', { name: '对话' }).getAttribute('aria-selected')).toBe('true');
  await userEvent.click(within(nav).getByRole('button', { name: /first mode task/ }));
  expect(screen.getByRole('tab', { name: '改动' }).getAttribute('aria-selected')).toBe('true');
});

it('remembers closing the result inspector and does not reopen it for session updates', async () => {
  window.history.replaceState(null, '', '/sessions/s1');
  mockAppApi({ sessions: [session('s1')], summaries: [summary('s1', 'inspector task')] });
  vi.spyOn(api, 'workspace').mockResolvedValue({ schemaVersion: 1, revision: 1, sessionId: 's1', mode: 'shared', sourceCwd: '/repo/s1', cwd: '/repo/s1', state: 'ready', createdAt: session('s1').createdAt, updatedAt: session('s1').updatedAt });
  const { client } = renderApp();
  await userEvent.click(await screen.findByRole('button', { name: '结果检视' }));
  const inspector = await screen.findByRole('dialog', { name: '结果检视' });
  expect(within(inspector).getByRole('heading', { name: '验证证据' })).toBeTruthy();
  await userEvent.click(within(inspector).getByRole('button', { name: '关闭结果检视' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '结果检视' })).toBeNull());
  act(() => client.setQueryData(['sessions'], [session('s1', 'thinking')]));
  expect(screen.queryByRole('dialog', { name: '结果检视' })).toBeNull();
});


it('restores each list entry view, search and project independently across multiple task visits', async () => {
  window.history.replaceState(null, '', '/?nav=tasks');
  mockAppApi({ sessions: [session('s1', 'completed'), session('s2', 'completed'), session('s3', 'thinking')], summaries: [summary('s1', 'first scoped task'), summary('s2', 'second scoped task'), summary('s3', 'running outside scope')] });
  renderApp();
  const search = () => screen.getByRole('textbox', { name: '筛选当前任务列表' }) as HTMLInputElement;
  const project = () => screen.getByRole('combobox', { name: '筛选项目' }) as HTMLSelectElement;
  const filters = () => screen.getByRole('region', { name: '任务筛选' });
  const nav = await screen.findByRole('complementary', { name: 'Dutydeck 工作台导航' });
  await screen.findByRole('heading', { level: 1, name: '全部任务' });
  await userEvent.click(within(filters()).getByRole('button', { name: '已完成 2' }));
  fireEvent.change(search(), { target: { value: 'first scoped' } });
  fireEvent.change(project(), { target: { value: 's1' } });
  await userEvent.click(within(screen.getByRole('region', { name: '任务列表' })).getByRole('button', { name: /first scoped task/ }));
  await screen.findByRole('heading', { level: 1, name: 'first scoped task' });
  await userEvent.click(within(nav).getByRole('button', { name: /^全部任务/ }));
  expect(search().value).toBe('first scoped');
  expect(project().value).toBe('s1');
  const historyLength = window.history.length;
  fireEvent.change(search(), { target: { value: 'second scoped' } });
  fireEvent.change(project(), { target: { value: '' } });
  await userEvent.click(within(filters()).getByRole('button', { name: '全部 3' }));
  expect(window.history.length).toBe(historyLength);
  await userEvent.click(within(screen.getByRole('region', { name: '任务列表' })).getByRole('button', { name: /second scoped task/ }));
  await screen.findByRole('heading', { level: 1, name: 'second scoped task' });
  act(() => window.history.back());
  await screen.findByRole('heading', { level: 1, name: '全部任务' });
  expect(search().value).toBe('second scoped');
  expect(project().value).toBe('');
  expect(within(filters()).getByRole('button', { name: '全部 3' }).getAttribute('aria-pressed')).toBe('true');
  act(() => window.history.back());
  await screen.findByRole('heading', { level: 1, name: 'first scoped task' });
  act(() => window.history.back());
  await screen.findByRole('heading', { level: 1, name: '全部任务' });
  expect(search().value).toBe('first scoped');
  expect(project().value).toBe('s1');
  expect(within(filters()).getByRole('button', { name: '已完成 2' }).getAttribute('aria-pressed')).toBe('true');
  await userEvent.click(within(nav).getByRole('button', { name: /^工作台/ }));
  await screen.findByRole('heading', { level: 1, name: '工作台' });
  expect(screen.queryByRole('textbox', { name: '筛选当前任务列表' })).toBeNull();
  expect(within(screen.getByRole('region', { name: '任务列表' })).getByRole('button', { name: /running outside scope/ })).toBeTruthy();
});


it.each([false, true])('preserves detailed usage and restores the evidence opener when inspection closes (wide=%s)', async wide => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(min-width: 768px)' || query === '(min-width: 1280px)' && wide, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  window.history.replaceState(null, '', '/sessions/s1');
  const events: DockEvent[] = [
    { id: 'usage-user', sequence: 1, timestamp: '2026-10-21T00:00:00Z', type: 'text', data: { role: 'user', text: 'show current usage' } },
    { id: 'usage-before', sequence: 2, timestamp: '2026-10-21T00:00:01Z', type: 'status', data: { state: 'usage', used: 600, size: 1000 } },
    { id: 'usage-after', sequence: 3, timestamp: '2026-10-21T00:00:02Z', type: 'status', data: { state: 'usage', used: 300, size: 1000 } }
  ];
  mockAppApi({ sessions: [session('s1')], events });
  vi.spyOn(api, 'workspace').mockResolvedValue({ schemaVersion: 1, revision: 1, sessionId: 's1', mode: 'shared', sourceCwd: '/repo/s1', cwd: '/repo/s1', state: 'ready', createdAt: session('s1').createdAt, updatedAt: session('s1').updatedAt });
  const quota = (usedPercent: number) => ({ usedPercent, resetsAt: Math.floor(Date.now() / 1000) + 3600, observedAt: '2026-10-21T00:00:03Z' });
  vi.spyOn(api, 'sessionUsage').mockResolvedValue({ own: { entries: 0 }, subSteps: { entries: 0 }, snapshot: { rateLimits: { fiveHour: quota(10), sevenDay: quota(20) }, error: 'quota sample partially unavailable' } } as never);
  renderApp();
  const opener = await screen.findByRole('button', { name: '查看验证证据' });
  await userEvent.click(opener);
  const inspector = await screen.findByRole(wide ? 'complementary' : 'dialog', { name: '结果检视' });
  await userEvent.click(within(inspector).getByText('详细用量与后台状态'));
  const usage = await within(inspector).findByRole('region', { name: '任务用量' });
  expect(within(usage).getByRole('progressbar', { name: '上下文已用' }).getAttribute('aria-valuenow')).toBe('30');
  expect(within(usage).getByRole('progressbar', { name: '5h额度已用' }).getAttribute('aria-valuenow')).toBe('10');
  expect(within(usage).getByRole('progressbar', { name: '7天额度已用' }).getAttribute('aria-valuenow')).toBe('20');
  await userEvent.click(within(usage).getByText('明细'));
  expect(within(usage).getByText('300 / 1,000 token')).toBeTruthy();
  expect(within(usage).getByText('已压缩 300 token')).toBeTruthy();
  expect(within(usage).getAllByText(/重置/)).toHaveLength(2);
  expect(within(usage).getByText('quota sample partially unavailable')).toBeTruthy();
  await userEvent.click(within(inspector).getByRole('button', { name: '关闭结果检视' }));
  await waitFor(() => expect(document.activeElement).toBe(opener));
});


it.each(['acp', 'pty-cli'] as const)('opens the actionable context from the home attention entry after reviewing changes (%s)', async protocol => {
  window.history.replaceState(null, '', '/sessions/s1');
  const permission: DockEvent = { id: 'permission', sequence: 2, timestamp: '2026-10-21T00:00:01Z', type: 'permission_request', data: { id: 'pending-approval', status: 'pending', title: 'approve pnpm test' } };
  mockAppApi({ agents: [agent(protocol)], sessions: [session('s1', 'waiting_for_permission')], summaries: [summary('s1', 'approval target')], events: [
    { id: 'input', sequence: 1, timestamp: '2026-10-21T00:00:00Z', type: 'text', data: { role: 'user', text: 'approval target' } }, permission
  ] });
  renderApp();
  await userEvent.click(await screen.findByRole('tab', { name: '改动' }));
  const nav = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
  await userEvent.click(within(nav).getByRole('button', { name: /^工作台/ }));
  await screen.findByRole('heading', { level: 1, name: '工作台' });
  await userEvent.click(within(screen.getByRole('region', { name: '任务列表' })).getByRole('button', { name: /approval target/ }));
  expect(screen.getByRole('tab', { name: protocol === 'acp' ? '对话' : '终端' }).getAttribute('aria-selected')).toBe('true');
  if (protocol === 'acp') expect(await screen.findByRole('complementary', { name: '权限审批' })).toBeTruthy();
  else expect(await screen.findByText('Terminal s1')).toBeTruthy();
});

it('shows managed-step approval as read-only and never offers an ineffective permission action', async () => {
  window.history.replaceState(null, '', '/sessions/s1');
  mockAppApi({ sessions: [{ ...session('s1', 'waiting_for_permission'), source: 'work_item' }], events: [
    { id: 'managed-permission', sequence: 1, timestamp: '2026-10-21T00:00:00Z', type: 'permission_request', data: { id: 'managed-approval', status: 'pending', title: 'managed operation' } }
  ] });
  const permission = vi.spyOn(api, 'permission');
  renderApp();
  const card = await screen.findByRole('complementary', { name: '权限审批' });
  expect(within(card).getByText('等待当前操作者处理')).toBeTruthy();
  expect(within(card).queryByRole('button', { name: '允许本次' })).toBeNull();
  expect(within(card).queryByRole('button', { name: '拒绝' })).toBeNull();
  expect(screen.getByText('此后台步骤由目标管理，请从原目标处理问题、授权、重试或停止。')).toBeTruthy();
  expect(permission).not.toHaveBeenCalled();
});


describe('App shared model draft navigation guard', () => {
  async function setup() {
    mockAppApi({ agents: [{ id: 'claude-code', name: 'Claude Code', protocol: 'pty-cli', permissionMode: 'ask' }] });
    vi.spyOn(terminalSettingsApi, 'get').mockResolvedValue({ terminalBackend: 'tmux', scope: 'pty-cli' });
    vi.spyOn(agentModelSettingsApi, 'get').mockResolvedValue({ agentId: 'claude-code', model: '', baseUrl: 'https://saved.example', authMode: 'bearer', hasApiKey: false, apiKeyAvailable: false, appliesTo: 'next_process' });
    renderApp();
    const nav = await screen.findByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await userEvent.click(within(nav).getByRole('button', { name: /Agent 与设置/ }));
    await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
    await userEvent.click(screen.getByText('模型服务配置'));
    const input = await screen.findByLabelText('服务地址');
    fireEvent.change(input, { target: { value: 'https://unsaved.example' } });
    return input as HTMLInputElement;
  }
  it('retains the real settings draft and URL on cancelled browser back, then confirms one back navigation', async () => {
    const input = await setup();
    act(() => window.history.back());
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe('?panel=settings&section=agents'));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(input.value).toBe('https://unsaved.example');
    expect(screen.getByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeTruthy();
    act(() => window.history.back());
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: '放弃更改并离开' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeNull());
    expect(window.location.search).toBe('');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    act(() => window.history.forward());
    await screen.findByRole('dialog', { name: 'Dutydeck 设置与接入' });
    await userEvent.click(screen.getByText('模型服务配置'));
    expect((await screen.findByLabelText('服务地址') as HTMLInputElement).value).toBe('https://saved.example');
  });
  it('restores a cancelled browser forward and follows the forward entry only after confirmation', async () => {
    const input = await setup();
    const settingsPath = window.location.search;
    const nextPosition = Number(window.history.state.dutydeckHistoryPosition) + 1;
    // Seed a real forward entry while leaving React's current settings view mounted.
    window.history.pushState({ dutydeckHistoryPosition: nextPosition }, '', '/?nav=tasks');
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe(settingsPath));
    act(() => window.history.forward());
    await screen.findByRole('alertdialog');
    await waitFor(() => expect(window.location.search).toBe(settingsPath));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(input.value).toBe('https://unsaved.example');
    act(() => window.history.forward());
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: '放弃更改并离开' }));
    await waitFor(() => expect(window.location.search).toBe('?nav=tasks'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeNull();
  });
  it('restores an unindexed legacy history entry without looping, and permits a confirmed close exactly once', async () => {
    await setup();
    // A history entry created before this app version has no position marker.
    window.history.pushState(null, '', '/?nav=tasks');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await screen.findByRole('alertdialog');
    expect(window.location.search).toBe('?panel=settings&section=agents');
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    await userEvent.click(screen.getByRole('button', { name: '关闭设置与接入' }));
    await userEvent.click(screen.getByRole('button', { name: '放弃更改并离开' }));
    await waitFor(() => expect(window.location.search).toBe('?nav=tasks'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeNull();
  });
  it('keeps settings and its URL while saving even when browser back bypasses its disabled buttons', async () => {
    await setup();
    let reject!: (error: Error) => void;
    vi.spyOn(agentModelSettingsApi, 'set').mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    await userEvent.click(screen.getByRole('button', { name: '保存模型配置' }));
    await screen.findByRole('button', { name: '保存中…' });
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe('?panel=settings&section=agents'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Dutydeck 设置与接入' })).toBeTruthy();
    await act(async () => reject(new Error('save rejected')));
    await screen.findByText('save rejected');
    act(() => window.history.back());
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe('https://unsaved.example');
  });

});


describe('App plan creation channels', () => {
  it('keeps ordinary Web plan creation available', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    mockAppApi({ sessions: [session('s1')] });
    const plan = vi.spyOn(api, 'plan').mockResolvedValue({ accepted: true, task: { id: 'plan-task', sessionId: 's1', prompt: '/plan review', status: 'queued', createdAt: session('s1').createdAt, updatedAt: session('s1').updatedAt } });
    const send = vi.spyOn(api, 'send');
    const { client } = renderApp();
    await userEvent.click(await screen.findByRole('button', { name: '先出计划' }));
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: 'review' } });
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(plan).toHaveBeenCalledWith('s1', 'review'));
    expect(send).not.toHaveBeenCalled();
    client.clear();
  });

  it('blocks a restored Lark plan draft until explicitly changed to ordinary send, including after session navigation', async () => {
    window.history.replaceState(null, '', '/sessions/s1');
    const key = composerDraftKey('s2');
    localStorage.setItem(key, JSON.stringify({ text: 'preserve plan intent', references: [], mode: 'queue', planFirst: true, revision: 7 }));
    mockAppApi({ sessions: [session('s1'), { ...session('s2'), source: 'lark' }], summaries: [summary('s1', 'Web task'), summary('s2', 'Lark task')] });
    const plan = vi.spyOn(api, 'plan');
    const send = vi.spyOn(api, 'send').mockResolvedValue({ accepted: true, task: { id: 'ordinary-task', sessionId: 's2', prompt: 'preserve plan intent', status: 'queued', createdAt: session('s2').createdAt, updatedAt: session('s2').updatedAt } });
    const first = renderApp();
    await userEvent.click(await screen.findByRole('button', { name: '先出计划' }));
    const nav = screen.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await userEvent.click(within(nav).getByRole('button', { name: /Lark task/ }));
    const input = await screen.findByRole('textbox', { name: '消息' });
    expect((input as HTMLTextAreaElement).value).toBe('preserve plan intent');
    expect(screen.queryByRole('button', { name: '先出计划' })).toBeNull();
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(plan).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(readComposerDraft(key).planFirst).toBe(true);

    await userEvent.click(within(nav).getByRole('button', { name: /Web task/ }));
    expect(screen.getByRole('button', { name: '先出计划' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(within(nav).getByRole('button', { name: /Lark task/ }));
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true);
    first.unmount(); first.client.clear();
    const second = renderApp();
    await userEvent.click(await screen.findByRole('button', { name: '改为普通消息' }));
    expect(readComposerDraft(key).planFirst).toBe(false);
    expect((screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement).value).toBe('preserve plan intent');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('s2', 'preserve plan intent', 'queue', []));
    expect(plan).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '先出计划' })).toBeNull();
    second.client.clear();
  });
});

beforeEach(() => { vi.spyOn(api, 'sessionHistory').mockResolvedValue({ turns: [], highWaterMark: 0, liveAfter: 0 }); });

vi.mock('./skill-catalog-api', async () => { const { api } = await import('./api'); return { fetchSkillCatalog: async (...args: Parameters<typeof api.skills>) => ({ skills: await api.skills(...args), diagnostics: [], partial: false }) }; });
