import { WorkItemProgress } from './components/WorkItemProgress';
import { WorkItemsPanel } from './components/WorkItemsPanel';
import { SessionDeliveryPanel } from './components/SessionDeliveryPanel';
import { VerificationSummary } from './components/VerificationSummary';
import { TurnMemoryPanel } from './components/TurnMemoryPanel';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderCog, Menu, PanelRightClose, Terminal, X } from 'lucide-react';
import { api, type RunSummary, type Session, type SteeringResult, type Task } from './api';
import { useDockStore } from './store';
import { buildTimeline, buildTimelineSections, pendingPermissionId } from './timeline';
import { Composer, type SendMode } from './components/Composer';
import { busyStates, effectiveStatus, ToolbarButton } from './components/ui';
import { Banner, Button, Card, Dialog, IconButton, Spinner } from './components/primitives';
import { SessionList } from './components/SessionList';
import { NewSessionModal } from './components/NewSessionModal';
import { SystemPromptModal } from './components/SystemPromptModal';
import { SessionNameModal } from './components/SessionNameModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { WorkspaceOverview } from './components/WorkspaceOverview';
import { RunDetailTabs, RunHeader } from './components/RunHeader';
import { useSessionStream } from './useSessionStream';
import { buildPrompt, commandsFromEvents, contextStatsFromEvents, getModelReadiness, type ComposerReference } from './composer-utils';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';
import { createEventWindow, loadEventHistory, type EventWindow } from './event-history';
import { summaryFromTasks } from './run-summary';
import { nextActionForState, sessionWorkspaceName, type WorkbenchView } from './workspace-model';
import { appLocationPath, OVERLAY_HISTORY_MARK, parseAppLocation, sessionPath, type AppLocation, type AppRoute, type OverlayRoute, type PrimaryNav, type LarkSetupTarget } from './app-route';
import type { ControlCenterSection } from './components/ControlCenterModal';
import { useMediaQuery } from './useMediaQuery';
import { captureDialogOpener } from './useDialogFocus';
import { CommandPalette, type CommandAction } from './components/CommandPalette';
import { ToastViewport } from './components/ToastViewport';
import { toastStore } from './useToasts';
import { TopBar } from './components/TopBar';
import { useTheme } from './useTheme';
import { shortcutAvailability, useKeyboardShortcuts, workbenchViewShortcutIds } from './useKeyboardShortcuts';
import { ShortcutHelpSheet } from './components/ShortcutHelpSheet';

// 终端与控制面都属于低频重功能，避免进入工作台首屏 chunk。
const TerminalView = lazy(() => import('./components/TerminalView').then(module => ({ default: module.TerminalView })));
const ControlCenterModal = lazy(() => import('./components/ControlCenterModal').then(module => ({ default: module.ControlCenterModal })));
const LarkConfigModal = lazy(() => import('./components/LarkConfigModal').then(module => ({ default: module.LarkConfigModal })));
const GroupPolicyModal = lazy(() => import('./components/GroupPolicyModal').then(module => ({ default: module.GroupPolicyModal })));
const AutomationOverview = lazy(() => import('./components/AutomationOverview').then(module => ({ default: module.AutomationOverview })));
const TimelineView = lazy(() => import('./components/TimelineView').then(module => ({ default: module.TimelineView })));
// 机器人 / 群聊是一级视图但不是首屏：多数会话只用任务中心，两块管理界面各自带表单
// 与目录浏览器，进首屏 chunk 只会拖慢每个人的第一次加载。
const BotManagement = lazy(() => import('./components/BotManagement').then(module => ({ default: module.BotManagement })));
const GroupManagement = lazy(() => import('./components/GroupManagement').then(module => ({ default: module.GroupManagement })));
const WorkspaceGroupsModal = lazy(() => import('./components/WorkspaceGroupsModal').then(module => ({ default: module.WorkspaceGroupsModal })));

type DetailTab = 'timeline' | 'terminal';
type MainQueryFailure = { label: string; message: string; hasData: boolean; retrying: boolean; retry(): Promise<void> };

// 插话只如实报告结果：没送进去的指令仍在排队，由当前任务完成后执行。
const steeringSkipped: Record<string, string> = {
  promptRequired: '正在执行的那一轮此刻接不了插话（还没交给 Agent，或已经结束）。', unsupported: '当前 Agent 不支持插话。',
  incompatible: '这条指令的执行设置与正在执行的这一轮不同。'
};
const steeringToast = ({ outcome, error }: SteeringResult, task?: Task) => outcome === 'injected'
  ? { kind: 'success' as const, key: 'steering', title: '已插话到当前这一轮', description: 'Agent 会在这一轮里接着处理这条指令。' }
  : outcome === 'moved'
    ? { kind: 'info' as const, key: 'steering', title: '没有插话', description: task?.status === 'cancelled' ? '这条指令在插话之前已被取消。' : '这条指令在插话之前已经开始执行，按普通的一轮处理。' }
  : outcome === 'startedNewTurn'
    ? { kind: 'warning' as const, key: 'steering', title: 'Agent 用这条指令另起了一轮', description: '那一轮不在执行记录里，结果不会显示在这里。' }
    : { kind: 'info' as const, key: 'steering', title: '没有插话，这条指令在排队', description: `${steeringSkipped[outcome] ?? `插话失败${error ? `：${error}` : '。'}`}当前任务完成后会执行它。` };

const currentLocation = (): AppLocation => typeof window === 'undefined'
  ? { route: { kind: 'overview' } }
  : parseAppLocation(window.location.pathname, window.location.search);

export default function App() {
  const qc = useQueryClient();
  const { activeSessionId, setActive, rawVisible, toggleRaw } = useDockStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 768px)').matches);
  const [newOpen, setNewOpen] = useState(false);
  const [newAgentId, setNewAgentId] = useState<string>();
  const rawSideBySide = useMediaQuery('(min-width: 1536px)');
  const toggleRawPanel = useCallback(() => { if (!rawVisible) captureDialogOpener(); toggleRaw(); }, [rawVisible, toggleRaw]);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [bulkArchiveIds, setBulkArchiveIds] = useState<string[]>([]);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [composerReferences, setComposerReferences] = useState<ComposerReference[]>([]);
  const [sendMode, setSendMode] = useState<SendMode>('queue');
  const [actionError, setActionError] = useState<string>();
  const [deliveryPanelOpen, setDeliveryPanelOpen] = useState(false);
  const [workItemPanel, setWorkItemPanel] = useState<{ sessionId: string; itemId: string } | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('timeline');
  // 路由与「可深链的浮层」是同一个东西的两半，合成一个 state：分开存会让 URL 与界面
  // 各走各的，回退键、刷新、分享链接三者立刻打架（见 app-route.ts 的说明）。
  const [location, setLocation] = useState<AppLocation>(currentLocation);
  const route = location.route;
  const overlay = location.overlay;
  // 主区一级视图与选中对象。三者都在 URL 里，刷新和分享都能回到同一个对象
  // （app-route.ts 的 nav/appId/chatId）。
  const primaryNav: PrimaryNav = location.nav ?? 'tasks';
  const selectedAppId = location.appId;
  const selectedChatId = location.chatId;
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>('all');
  const [runSummaries, setRunSummaries] = useState<Record<string, RunSummary>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [workspaceGroupsOpen, setWorkspaceGroupsOpen] = useState(false);
  const [renameSession, setRenameSession] = useState<Session | null>(null);
  const theme = useTheme();
  const navigationTrigger = useRef<HTMLElement | null>(null);
  const mobileNavigationOpen = mobile && sidebarOpen;
  const openMobileNavigation = () => {
    navigationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSidebarOpen(true);
  };

  const applySessionSelection = useCallback((id?: string) => {
    setActive(id);
    setPrompt('');
    setComposerReferences([]);
    setDetailTab('timeline');
    setWorkItemPanel(null);
    setActionError(undefined);
  }, [setActive]);

  /**
   * 写 URL 并同步界面状态。
   *
   * 打开浮层时在 history.state 上打 `OVERLAY_HISTORY_MARK` 标记，这样关闭时能分辨
   * 两种来路：本次会话里点开的（back() 回到浮层之前，后退键行为自然），还是别人
   * 甩过来的深链（此时 back() 会离开站点，改用 replaceState 抹掉 query）。
   */
  const navigate = useCallback((next: AppLocation, options?: { replace?: boolean }) => {
    setLocation(next);
    const nextPath = appLocationPath(next);
    if (`${window.location.pathname}${window.location.search}` === nextPath) return;
    const state = { sessionId: next.route.kind === 'session' ? next.route.sessionId : undefined, ...(next.overlay ? { [OVERLAY_HISTORY_MARK]: true } : {}) };
    if (options?.replace) window.history.replaceState(state, '', nextPath);
    else window.history.pushState(state, '', nextPath);
  }, []);

  const openOverlay = useCallback((next: OverlayRoute) => {
    captureDialogOpener();
    setSidebarOpen(false);
    navigate({ route, nav: primaryNav, appId: selectedAppId, chatId: selectedChatId, overlay: next });
  }, [navigate, route, primaryNav, selectedAppId, selectedChatId]);

  /**
   * 关闭可深链浮层。
   *
   * 走 back() 而不是再 push 一条：否则用户按后退会把刚关掉的浮层重新打开，
   * 而且每开关一次就往历史里塞两条记录。
   */
  const closeOverlay = useCallback(() => {
    const pushedByUs = Boolean((window.history.state as Record<string, unknown> | null)?.[OVERLAY_HISTORY_MARK]);
    if (pushedByUs) { window.history.back(); return; }
    navigate({ route, nav: primaryNav, appId: selectedAppId, chatId: selectedChatId }, { replace: true });
  }, [navigate, route, primaryNav, selectedAppId, selectedChatId]);

  /**
   * 选中任务。
   *
   * 一律切回任务视图（点任务却停在 Bot 管理页上，是在无视用户刚做的选择），
   * 但 appId / chatId 原样留在 URL 里：用户从任务详情跳去改配置、再切回来时
   * 仍然落在原来那个 Bot 或群上，不用重新找一遍。
   */
  const selectSession = useCallback((id?: string) => {
    applySessionSelection(id);
    navigate({ route: id ? { kind: 'session', sessionId: id } : { kind: 'overview' }, nav: 'tasks', appId: selectedAppId, chatId: selectedChatId });
  }, [applySessionSelection, navigate, selectedAppId, selectedChatId]);

  /**
   * 切换主区一级视图。
   *
   * `route` 原样保留：用户在任务详情里切去「机器人」，主区换成 Bot 管理，但
   * 那条任务仍在 URL 里；切回「任务」直接回到同一条任务，不用重新找。这正是
   * 契约要求的「跳转配置再返回不丢任务」。
   */
  const setPrimaryNav = useCallback((next: PrimaryNav) => {
    navigate({ route, nav: next, appId: selectedAppId, chatId: selectedChatId });
  }, [navigate, route, selectedAppId, selectedChatId]);

  /** 选中某个 Bot，进入机器人视图。chatId 保留，便于从 Bot 再跳回原来的群。 */
  const selectBot = useCallback((appId: string) => {
    navigate({ route, nav: 'bots', appId: appId || undefined, chatId: selectedChatId });
  }, [navigate, route, selectedChatId]);

  /** 选中某个群，进入群聊视图；带上 appId 时直接定位到该群里的这个 Bot。 */
  const selectGroup = useCallback((chatId: string, appId?: string) => {
    navigate({ route, nav: 'groups', chatId: chatId || undefined, appId: appId ?? selectedAppId });
  }, [navigate, route, selectedAppId]);

  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, staleTime: 5 * 60_000 });
  // 非当前任务没有 SSE，低频同步用于捕获飞书创建等外部变化；当前任务状态仍由 SSE 即时写入缓存。
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const summaries = useQuery({ queryKey: ['run-summaries'], queryFn: api.runSummaries, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const workspaceGroups = useQuery({ queryKey: ['workspace-groups'], queryFn: api.workspaceGroups, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const larkConfig = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig, staleTime: 30_000, refetchOnWindowFocus: true });
  const systemCapabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities, staleTime: Infinity });
  const authStatus = useQuery({ queryKey: ['auth-status'], queryFn: api.authStatus, staleTime: Infinity, retry: false });

  const openSettings = (section: ControlCenterSection = 'agents') => openOverlay({ kind: 'settings', section });
  const openLarkSetup = (target?: LarkSetupTarget) => openOverlay({ kind: 'lark-setup', target });
  const openCreateTask = () => openCreateTaskForAgent();
  const openCreateTaskForAgent = (agentId?: string) => {
    setNewAgentId(agentId);
    setActionError(undefined);
    if ((agents.data?.length ?? 0) === 0) {
      openSettings('agents');
      return;
    }
    captureDialogOpener();
    setNewOpen(true);
    setSidebarOpen(false);
  };
  // 命令面板与帮助面板都要先记下触发者，关闭后焦点才能回到原处。
  const openPalette = () => { captureDialogOpener(); setPaletteOpen(true); };
  const openHelp = () => { captureDialogOpener(); setHelpOpen(true); };
  const openRenameSession = (target: Session) => { captureDialogOpener(); setRenameSession(target); };

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 768px)');
    const update = () => { setMobile(!media.matches); if (media.matches) setSidebarOpen(false); };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!mobileNavigationOpen) return;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="Dutydeck 工作台导航"] button')?.focus());
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setSidebarOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      navigationTrigger.current?.focus();
      navigationTrigger.current = null;
    };
  }, [mobileNavigationOpen]);

  useEffect(() => {
    const syncSelectionFromLocation = () => {
      const next = currentLocation();
      setLocation(next);
      applySessionSelection(next.route.kind === 'session' ? next.route.sessionId : undefined);
    };
    syncSelectionFromLocation();
    window.addEventListener('popstate', syncSelectionFromLocation);
    return () => window.removeEventListener('popstate', syncSelectionFromLocation);
  }, [applySessionSelection]);

  const sortedSessions = useMemo(() => [...(sessions.data ?? [])].sort((left, right) => (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt)), [sessions.data]);
  // 目标步骤（work_item）与飞书会话记忆的后台提取（lark-memory）都不是用户下达的任务：
  // 后者会以 .dutydeck/memory/<app>/<chat> 为工作区出现在侧栏，并以「已取消」挤进待你处理。
  // 直接打开链接仍能查看，active 取自 sortedSessions。
  const visibleSessions = useMemo(() => sortedSessions.filter(session => session.source !== 'work_item' && session.source !== 'lark-memory'), [sortedSessions]);
  const active = useMemo(() => sortedSessions.find(session => session.id === activeSessionId), [sortedSessions, activeSessionId]);
  const events = useQuery({ queryKey: ['events', activeSessionId], queryFn: async ({ signal }) => { const history = await loadEventHistory(activeSessionId!, signal); const cached = qc.getQueryData<EventWindow>(['events', activeSessionId]); return createEventWindow([...history.events, ...(cached?.events ?? [])]); }, enabled: Boolean(active), staleTime: Infinity });
  const tasks = useQuery({ queryKey: ['tasks', activeSessionId], queryFn: () => api.tasks(activeSessionId!), enabled: Boolean(active) });
  const missingActiveSession = Boolean(route.kind === 'session' && sessions.isSuccess && !active);
  const activeAgent = useMemo(() => agents.data?.find(agent => agent.id === active?.agentId), [agents.data, active?.agentId]);
  const activeOutputLabel = active?.model ?? activeAgent?.name ?? active?.agentId ?? 'Agent';
  const streamStatus = useSessionStream(activeSessionId, active?.runId, events.isSuccess);
  const activeModels = useQuery({ queryKey: agentModelsQueryKey(active?.agentId, active?.model), queryFn: () => loadAgentModels(active!.agentId, active!.model), enabled: Boolean(active && !active.archivedAt), initialData: () => active ? readCachedAgentModels(active.agentId, active.model) : undefined, initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 60_000 });
  const skills = useQuery({ queryKey: ['skills', active?.cwd], queryFn: () => api.skills(active?.cwd), enabled: Boolean(active && !active.archivedAt), staleTime: 60_000 });
  const eventList = events.data?.events ?? [];
  const timeline = useMemo(() => buildTimeline(eventList, tasks.data), [eventList, tasks.data]);
  const timelineSections = useMemo(() => buildTimelineSections(timeline, tasks.data), [timeline, tasks.data]);
  const raw = useMemo(() => eventList.filter(event => event.type === 'raw_terminal').map(event => event.raw ?? event.data.text).join(''), [eventList]);
  const queuedTasks = useMemo(() => tasks.data?.filter(task => task.status === 'queued') ?? [], [tasks.data]);
  const blockingPermissionId = useMemo(() => active?.state === 'waiting_for_permission' ? pendingPermissionId(timeline) : undefined, [active?.state, timeline]);
  const latestUserIndex = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index--) if (timeline[index].type === 'text' && timeline[index].data.role === 'user') return index;
    return -1;
  }, [timeline]);
  const awaitingAnswer = useMemo(() => busyStates.has(active?.state ?? '') && latestUserIndex >= 0 && !timeline.slice(latestUserIndex + 1).some(event => event.type === 'text' && event.data.role !== 'user'), [active?.state, latestUserIndex, timeline]);
  const hasOngoingActivity = useMemo(() => timelineSections.some(section => section.kind === 'activity' && section.isLatestTurn && awaitingAnswer), [timelineSections, awaitingAnswer]);
  const isPtyCli = activeAgent?.protocol === 'pty-cli';

  useEffect(() => {
    if (!summaries.data?.length) return;
    setRunSummaries(current => {
      let changed = false;
      const next = { ...current };
      for (const summary of summaries.data) {
        const existing = next[summary.sessionId];
        if (!existing || summary.updatedAt >= existing.updatedAt) { next[summary.sessionId] = summary; changed ||= existing !== summary; }
      }
      return changed ? next : current;
    });
  }, [summaries.data]);

  useEffect(() => {
    if (!activeSessionId) return;
    const summary = summaryFromTasks(activeSessionId, tasks.data);
    if (summary) setRunSummaries(current => current[activeSessionId]?.taskId === summary.taskId && current[activeSessionId]?.status === summary.status && current[activeSessionId]?.queuedCount === summary.queuedCount && current[activeSessionId]?.updatedAt === summary.updatedAt ? current : { ...current, [activeSessionId]: summary });
  }, [activeSessionId, tasks.data]);

  const send = useMutation({ mutationFn: ({ sessionId, message, mode, skillRequests }: { sessionId: string; message: string; mode: SendMode; skillRequests?: string[] }) => api.send(sessionId, message, mode, skillRequests), onSuccess: (result, variables) => { if (variables.sessionId === activeSessionId) { setPrompt(''); setComposerReferences([]); setSendMode('queue'); } qc.setQueryData<Task[]>(['tasks', variables.sessionId], current => [...(current ?? []).filter(task => task.id !== result.task.id), result.task]); if (result.steering && (result.task.status === 'queued' || result.steering.outcome !== 'promptRequired')) toastStore.push(steeringToast(result.steering, result.task)); }, onError: error => setActionError(error.message) });
  const cancelQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.cancelQueued(sessionId, taskId), onMutate: ({ sessionId, taskId }) => ({ prompt: qc.getQueryData<Task[]>(['tasks', sessionId])?.find(task => task.id === taskId)?.prompt }), onSuccess: (result, variables, context) => {
    qc.setQueryData<Task[]>(['tasks', variables.sessionId], current => current?.map(task => task.id === result.id ? result : task));
    // 撤销只能把指令重新排到队尾，拿不回原来的任务 ID 和位置，所以 description 必须说清楚，不假装能还原现场。
    const restorable = context?.prompt?.trim();
    toastStore.push({ kind: 'success', key: `cancel-queued-${variables.taskId}`, title: '已取消 1 条待执行指令', description: restorable ? '恢复会把这条指令重新排到队列末尾，不会回到原来的位置。' : undefined, action: restorable ? { label: '恢复这条指令', run: () => api.send(variables.sessionId, restorable, 'queue').then(() => { void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId] }); }) } : undefined });
  }, onError: error => { setActionError(error.message); toastStore.push({ kind: 'error', key: 'cancel-queued', title: '取消待执行指令失败', description: error.message }); } });
  const steerQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.steerQueued(sessionId, taskId), onSuccess: (_result, variables) => { setActionError(undefined); void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId] }); }, onError: error => setActionError(error.message) });
  const injectQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.injectQueued(sessionId, taskId), onSuccess: (result, variables) => { setActionError(undefined); toastStore.push(steeringToast(result)); void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId] }); }, onError: error => setActionError(error.message) });
  const archive = useMutation({ mutationFn: (sessionId: string) => api.archive(sessionId), onSuccess: result => { qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); setArchiveConfirm(false); selectSession(undefined); toastStore.push({ kind: 'success', key: 'archive', title: '任务已归档', description: '历史指令和执行记录仍可在「已归档」筛选中查看。' }); }, onError: error => setActionError(error.message) });
  const bulkArchive = useMutation({
    mutationFn: async (ids: string[]) => {
      const archived = new Map<string, Session>();
      const failures: Array<{ id: string; message: string }> = [];
      for (const id of new Set(ids)) {
        try { archived.set(id, await api.archive(id)); }
        catch (error) { failures.push({ id, message: error instanceof Error ? error.message : String(error) }); }
      }
      return { archived, failures };
    },
    onSuccess: async ({ archived, failures }) => {
      await qc.cancelQueries({ queryKey: ['sessions'], exact: true });
      qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => archived.get(session.id) ?? session));
      setBulkArchiveIds(failures.map(failure => failure.id));
      toastStore.push({
        kind: failures.length ? archived.size ? 'warning' : 'error' : 'success',
        key: 'bulk-archive',
        title: failures.length ? `已清理 ${archived.size} 个任务，${failures.length} 个失败` : `已清理 ${archived.size} 个任务`,
        description: failures.length ? '失败项已保留，可重试。' : '历史指令和执行记录可在「已归档」中查看。'
      });
    }
  });
  const restart = useMutation({ mutationFn: api.restart, onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); void qc.invalidateQueries({ queryKey: ['sessions'] }); void qc.invalidateQueries({ queryKey: ['events', activeSessionId] }); void qc.invalidateQueries({ queryKey: ['tasks', activeSessionId] }); toastStore.push({ kind: 'success', key: 'restart', title: '任务已重新启动', description: '这是一个全新的 Agent 进程，会从空白上下文开始；之前的对话不会带过来。' }); }, onError: error => { setActionError(error.message); toastStore.push({ kind: 'error', key: 'restart', title: '重新启动失败', description: error.message }); } });
  const resolvePermission = useMutation({ mutationFn: ({ sessionId, permissionId, approved }: { sessionId: string; permissionId: string; approved: boolean }) => api.permission(sessionId, permissionId, approved), onSuccess: (_result, variables) => { qc.setQueryData<EventWindow>(['events', variables.sessionId], current => { if (!current) return current; const next = current.events.map(event => event.type === 'permission_request' && (event.data.id === variables.permissionId || event.id === variables.permissionId) ? { ...event, data: { ...event.data, status: variables.approved ? 'approved' : 'rejected' } } : event); return createEventWindow(next); }); }, onError: error => setActionError(error.message) });
  const pickComposerFile = useMutation({ mutationFn: api.selectFile, onError: error => setActionError(error.message) });
  const refreshModels = useMutation({ mutationFn: ({ agentId: targetAgentId, currentModel }: { agentId: string; currentModel?: string }) => loadAgentModels(targetAgentId, currentModel, true), onSuccess: (result, variables) => { setActionError(undefined); qc.setQueryData(agentModelsQueryKey(variables.agentId, variables.currentModel), result); }, onError: error => setActionError(error.message) });
  const switchModel = useMutation({ mutationFn: ({ sessionId, nextModel }: { sessionId: string; nextModel: string }) => api.setSessionModel(sessionId, nextModel), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); void activeModels.refetch(); }, onError: error => setActionError(error.message) });
  const switchReasoningEffort = useMutation({ mutationFn: ({ sessionId, nextReasoningEffort }: { sessionId: string; nextReasoningEffort: string }) => api.setSessionReasoningEffort(sessionId, nextReasoningEffort), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); }, onError: error => setActionError(error.message) });
  const modelReadiness = getModelReadiness({ loaded: activeModels.data !== undefined, loading: activeModels.data === undefined && (activeModels.isPending || activeModels.isFetching || refreshModels.isPending), switching: switchModel.isPending, failed: activeModels.data === undefined && activeModels.isError });
  const mainQueryFailures: MainQueryFailure[] = [
    ...(agents.isError ? [{ label: 'Agent 信息', message: agents.error.message, hasData: agents.data !== undefined, retrying: agents.isFetching, retry: async () => { await agents.refetch(); } }] : []),
    ...(sessions.isError ? [{ label: '任务列表', message: sessions.error.message, hasData: sessions.data !== undefined, retrying: sessions.isFetching, retry: async () => { await sessions.refetch(); } }] : []),
    ...(summaries.isError ? [{ label: '任务摘要', message: summaries.error.message, hasData: summaries.data !== undefined, retrying: summaries.isFetching, retry: async () => { await summaries.refetch(); } }] : [])
  ];
  const blockingMainQueryFailures = mainQueryFailures.filter(failure => !failure.hasData);
  const staleMainQueryFailures = mainQueryFailures.filter(failure => failure.hasData);
  const retryingMainQueries = mainQueryFailures.some(failure => failure.retrying);
  const submit = () => { if (modelReadiness.kind !== 'ready') return; const message = buildPrompt(prompt, composerReferences); if (message && activeSessionId) send.mutate({ sessionId: activeSessionId, message, mode: busyStates.has(active?.state ?? '') ? sendMode : 'queue', skillRequests: composerReferences.filter(reference => reference.kind === 'skill').map(reference => reference.value) }); };
  const act = async (action: string) => { try { setActionError(undefined); await api.action(activeSessionId!, action); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); } };

  // 有浮层占用键盘时整套快捷键停用，避免和弹窗内的按键语义打架。
  const overlayOpen = Boolean(overlay) || newOpen || archiveConfirm || bulkArchiveIds.length > 0 || systemPromptOpen || paletteOpen || helpOpen || deliveryPanelOpen || Boolean(renameSession) || (rawVisible && !rawSideBySide);
  const shortcutHandlers = useMemo(() => ({
    'command-palette': openPalette,
    'toggle-help': () => setHelpOpen(open => !open),
    'focus-search': openPalette,
    'create-task': openCreateTask,
    'go-task-center': () => selectSession(undefined),
    'go-settings': () => openSettings('agents'),
    'go-lark-setup': openLarkSetup,
    'toggle-navigation': () => setSidebarOpen(open => !open),
    ...Object.fromEntries(Object.entries(workbenchViewShortcutIds).map(([view, id]) => [id, () => { setWorkbenchView(view as WorkbenchView); selectSession(undefined); }])),
    // session 作用域：没有打开任务时 shortcutAvailability 会自动判为不可用，这里无需再判。
    ...(active ? {
      'interrupt-run': () => { if (busyStates.has(active.state)) void act('interrupt'); },
      'restart-run': () => { if (active.state === 'failed' || active.state === 'stopped') restart.mutate(active.id); },
      'archive-run': () => { if (!active.archivedAt) { archive.reset(); setArchiveConfirm(true); } },
      'toggle-detail-tab': () => { if (isPtyCli) setDetailTab(tab => tab === 'timeline' ? 'terminal' : 'timeline'); },
      'toggle-raw-log': () => { if (raw) toggleRawPanel(); }
    } : {})
  // openCreateTask / openSettings / openLarkSetup / act 每次渲染重建但只读最新 state，hook 内部用 ref 同步，
  // 因此依赖数组只跟踪真正影响可用性的值。
  //
  // agents.data 必须在列：openCreateTask 会在「一个 Agent 都没有」时改道去设置页，而首屏
  // agents 还没加载完。漏掉它会让这个 memo 冻住一个「看到 0 个 Agent」的过期闭包——整页
  // 打开或刷新任务中心后按 n 永久跳到设置与接入。hook 内部同步的是这个 memo 对象本身，
  // 救不了对象里的陈旧闭包。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [active, agents.data, isPtyCli, raw, selectSession, toggleRawPanel]);
  useKeyboardShortcuts(shortcutHandlers, { enabled: !overlayOpen, sessionOpen: Boolean(active) });
  /**
   * 帮助面板的可用性标注刻意不传 enabled。
   *
   * 运行期在浮层打开时停用整套快捷键是对的，但展示层不能共用这个判断：帮助面板自己
   * 就是浮层，一打开 overlayOpen 即为 true，于是 21 条快捷键会有 20 条被标成「当前
   * 不可用」——面板存在的意义正是告诉用户能按什么，那样它每次都在撒谎。这里只按
   * 作用域（是否打开了任务）与 handler 是否存在来判定。
   */
  const shortcutsAvailable = shortcutAvailability(shortcutHandlers, { sessionOpen: Boolean(active) });

  const paletteActions: CommandAction[] = [
    { id: 'create-task', label: '创建任务', hint: agents.data?.length ? '描述目标后立即开始执行' : undefined, group: '任务', keywords: 'new task 新建 创建', shortcut: 'N', disabled: agents.isLoading, disabledReason: agents.isLoading ? '正在检测可用 Agent，稍候即可创建' : undefined, run: openCreateTask },
    { id: 'go-task-center', label: '回到任务中心', hint: '查看待你处理、进行中与最近的任务', group: '导航', keywords: 'home overview 总览 首页', run: () => selectSession(undefined) },
    { id: 'open-settings', label: '打开设置与接入', hint: '管理 Agent、飞书 Bot 与自动化', group: '导航', keywords: 'settings agent 设置', run: () => openSettings('agents') },
    { id: 'open-lark', label: '绑定或管理飞书 Bot', hint: '在飞书中下达任务并接收结果', group: '导航', keywords: 'lark feishu 飞书 bot', run: openLarkSetup },
    { id: 'toggle-help', label: '查看键盘快捷键', group: '帮助', keywords: 'help shortcut 快捷键 帮助', shortcut: '?', run: openHelp },
    ...(active && !active.archivedAt ? [
      { id: 'interrupt-run', label: '中断当前任务', hint: '停在已完成的步骤，可稍后继续', group: '任务', keywords: 'interrupt stop 中断', disabled: !busyStates.has(active.state), disabledReason: '当前任务没有在执行中的步骤', run: () => void act('interrupt') },
      { id: 'archive-run', label: '归档当前任务', hint: '归档后只读，需二次确认', group: '任务', keywords: 'archive 归档', run: () => { archive.reset(); setArchiveConfirm(true); } }
    ] satisfies CommandAction[] : [])
  ];
  /**
   * 移动端导航入口现在只有一枚，在顶栏里（TopBar 的 md:hidden 汉堡）。
   *
   * 在顶栏出现之前，这里还有一枚绝对定位在 <main> 上的浮动汉堡，另一枚在
   * RunHeader 里，三处共用同一个无障碍名「打开工作台导航」。顶栏是常驻的，
   * 再留着那两枚就等于同一时刻有两个同名按钮：读屏用户听到两遍、
   * getByRole 直接抛 "found multiple elements"，而它们做的是同一件事。
   *
   * 顺带解决了浮动汉堡的老问题——它压在滚动内容上，得靠不透明底 + 边框 + 阴影
   * 才不至于和任务卡片正文糊在一起。挪进顶栏后它在自己的行里，不再需要这些补丁。
   */
  const renderNotFound = (kind: 'page' | 'session') => <div className="relative grid min-h-0 flex-1 place-items-center overflow-auto p-6">
    <Card as="section" padding="lg" className="w-full max-w-md text-center">
      <p className="text-meta font-semibold uppercase tracking-[.12em] text-warning">{kind === 'page' ? '页面不存在' : '任务不存在'}</p>
      <h1 className="mt-2 text-heading font-semibold text-primary">{kind === 'page' ? '找不到这个页面' : '找不到这个任务'}</h1>
      <p className="mt-2 text-caption text-subtle">{kind === 'page' ? '当前链接不是有效的 Dutydeck 页面。' : '它可能已被删除，或当前链接不属于这个 Dutydeck 实例。'}</p>
      <div className="mt-5 flex justify-center"><Button variant="primary" onClick={() => selectSession(undefined)}>回到任务中心</Button></div>
    </Card>
  </div>;

  const renderBlockingFailure = () => <div className="relative grid min-h-0 flex-1 place-items-center overflow-auto p-6">
    <Card as="section" role="alert" padding="lg" className="w-full max-w-lg">
      <p className="text-meta font-semibold uppercase tracking-[.12em] text-danger">数据未就绪</p>
      <h1 className="mt-2 text-heading font-semibold text-primary">无法加载任务中心</h1>
      <p className="mt-1 text-caption text-subtle">以下关键数据加载失败。为避免把故障显示成空列表，任务内容已暂停展示。</p>
      <ul className="mt-4 space-y-2">{mainQueryFailures.map(failure => <li key={failure.label} className="rounded-md bg-danger-soft px-3 py-2 text-caption text-danger"><strong>{failure.label}</strong><span className="ml-2">{failure.message}</span></li>)}</ul>
      <Button variant="primary" className="mt-5" loading={retryingMainQueries} onClick={() => void Promise.all(mainQueryFailures.map(failure => failure.retry()))}>{retryingMainQueries ? '正在重试…' : '重新加载'}</Button>
    </Card>
  </div>;

  // 四个懒加载浮层的加载态是同一件事，只有文案不同。
  const overlayFallback = (label: string) => <div className="fixed inset-0 z-dialog grid place-items-center bg-scrim backdrop-blur-sm"><Spinner label={label}/></div>;

  return <div className="relative flex h-[100dvh] min-h-[100dvh] flex-col overflow-hidden bg-canvas font-sans text-primary">
    <TopBar hidden={mobileNavigationOpen} onOpenNavigation={openMobileNavigation} onGoHome={() => selectSession(undefined)} onOpenSearch={openPalette} onOpenShortcuts={openHelp} themePreference={theme.preference} themeResolved={theme.resolved} onThemeChange={theme.setPreference}/>
    {/*
      顶栏之下的躯干。侧栏是 position:fixed 的浮动卡片而不是栅格列，所以这里是
      普通的 block/flex 容器，主区靠 md:ml-main-inset 让位——--main-inset 就是
      「侧栏左插入 + 侧栏宽 + 右间距」的唯一定义（tokens.css），主区不自己算像素。

      让位只在 md: 及以上生效：窄屏侧栏是 translate-x 抽屉，浮在内容之上，主区
      让位反而会留下一条永远空着的左边距。
    */}
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {mobileNavigationOpen && <button type="button" aria-label="关闭工作台导航" onClick={() => setSidebarOpen(false)} className="ui-overlay fixed inset-0 z-sticky bg-scrim backdrop-blur-[1px] md:hidden"/>}
      <SessionList open={sidebarOpen} onClose={() => setSidebarOpen(false)} sessions={visibleSessions} summaries={runSummaries} sessionsLoading={sessions.isLoading} agents={agents.data ?? []} agentsLoading={agents.isLoading} larkBots={larkConfig.data?.bots ?? []} larkBotsLoading={larkConfig.isLoading} larkListeningDisabled={larkConfig.data?.listeningDisabled ?? false} larkBotsFailed={larkConfig.isError} activeSessionId={activeSessionId} view={workbenchView} onSelect={selectSession} onNewSession={openCreateTask} onOpenControlCenter={() => openSettings('agents')} onOpenLarkSetup={() => openLarkSetup()} onOpenGroups={() => openOverlay({ kind: 'groups' })} onOpenSchedules={() => openOverlay({ kind: 'automation' })} primaryNav={primaryNav} onPrimaryNavChange={setPrimaryNav} authRequired={authStatus.data?.required} organization={workspaceGroups.data?.organization} onManageWorkspaces={() => { captureDialogOpener(); setSidebarOpen(false); setWorkspaceGroupsOpen(true); }}/>
      <main aria-hidden={mobileNavigationOpen || undefined} inert={mobileNavigationOpen || undefined} className="flex min-w-0 flex-1 flex-col md:ml-main-inset">
      {route.kind !== 'not-found' && !blockingMainQueryFailures.length && staleMainQueryFailures.length > 0 && <div className="shrink-0 px-4 py-2"><Banner tone="warning" action={{ label: retryingMainQueries ? '重试中…' : '重试', busy: retryingMainQueries, onClick: () => void Promise.all(staleMainQueryFailures.map(failure => failure.retry())) }}><span className="block min-w-0 truncate" title={staleMainQueryFailures.map(failure => `${failure.label}：${failure.message}`).join('\n')}>部分数据可能不是最新：{staleMainQueryFailures.map(failure => failure.label).join('、')}</span></Banner></div>}
      {/*
        主区分派。机器人 / 群聊排在最前面：它们是用户刚点过的一级视图，
        任务列表加载失败或当前任务不存在都不该把这两块管理界面挡掉——
        「改配置」与「看任务」是两条独立的路，一条断了不该连坐另一条。
      */}
      {primaryNav === 'bots' ? <Suspense fallback={<div className="grid min-h-0 flex-1 place-items-center"><Spinner label="正在打开机器人管理…"/></div>}><BotManagement selectedAppId={selectedAppId} onSelectBot={selectBot} onOpenLarkSetup={openLarkSetup} onSelectGroup={selectGroup} agents={agents.data ?? []} larkListeningDisabled={larkConfig.data?.listeningDisabled ?? false}/></Suspense>
      : primaryNav === 'groups' ? <Suspense fallback={<div className="grid min-h-0 flex-1 place-items-center"><Spinner label="正在打开群聊管理…"/></div>}><GroupManagement selectedChatId={selectedChatId} selectedAppId={selectedAppId} onSelectGroup={selectGroup} onNavigateToBot={selectBot} agents={agents.data ?? []}/></Suspense>
      : route.kind === 'not-found' ? renderNotFound('page') : blockingMainQueryFailures.length ? renderBlockingFailure() : route.kind === 'session' && sessions.isPending ? <div className="grid min-h-0 flex-1 place-items-center"><Spinner label="正在加载任务…"/></div> : missingActiveSession ? renderNotFound('session') : active ? <>
        <RunHeader session={active} agent={activeAgent} taskPrompt={runSummaries[active.id]?.prompt} streamStatus={streamStatus} queuedTasks={queuedTasks} rawVisible={rawVisible} rawAvailable={Boolean(raw)} restarting={restart.isPending} onInterrupt={() => void act('interrupt')} onRestart={() => restart.mutate(active.id)} onOpenPrompt={() => setSystemPromptOpen(true)} onArchive={() => { archive.reset(); setArchiveConfirm(true); }} onToggleRaw={toggleRawPanel} onRename={() => openRenameSession(active)}/>
        <div className="flex shrink-0 items-stretch bg-surface px-3 sm:px-5">
          <div className="flex min-w-0 flex-1 flex-col justify-end">{isPtyCli ? <RunDetailTabs value={detailTab} onChange={setDetailTab}/> : <div className="flex-1 border-b border-default"/>}</div>
          <div className="flex shrink-0 items-center gap-0.5 border-b border-default pl-2">{active.source !== 'work_item' && <WorkItemsPanel session={active} agents={agents.data ?? []} onSelectSession={selectSession} control={{ open: workItemPanel?.sessionId === active.id, selectedId: workItemPanel?.sessionId === active.id ? workItemPanel.itemId : '', onOpenChange: open => setWorkItemPanel(open ? { sessionId: active.id, itemId: '' } : null), onSelectItem: itemId => setWorkItemPanel(current => current?.sessionId === active.id ? { sessionId: active.id, itemId } : current) }}/>}<ToolbarButton label="工作目录、验证与自动化" icon={<FolderCog size={14}/>} onClick={() => setDeliveryPanelOpen(true)}/></div>
        </div>
        {events.isError && <div className="shrink-0 px-4 py-2"><Banner tone="danger">历史记录加载失败：{events.error.message}<Button size="sm" variant="secondary" onClick={() => void events.refetch()}>重试加载记录</Button></Banner></div>}
        {actionError && <div className="shrink-0 px-4 py-2"><Banner tone="danger" onDismiss={() => setActionError(undefined)}>{actionError}</Banner></div>}
        {deliveryPanelOpen && <SessionDeliveryPanel key={active.id} session={active} tasks={tasks.data ?? []} onClose={() => setDeliveryPanelOpen(false)}/>}
        {isPtyCli && active.permissionMode === 'ask' && <div className="shrink-0 px-4 py-2 sm:px-5"><Banner tone="warning" action={{ label: '打开终端', onClick: () => setDetailTab('terminal') }}>{active.source === 'work_item' ? '此步骤终端只读。需要确认时，请在原飞书话题使用 /work terminal 查看并按提示输入。' : '此 CLI 的操作确认在终端中完成；若任务等待响应，请前往终端处理。'}</Banner></div>}
        <div className="flex min-h-0 flex-1"><section className="flex min-w-0 flex-1 flex-col">{detailTab === 'terminal' && isPtyCli ? <div id="tabpanel-terminal" role="tabpanel" aria-labelledby="tab-terminal" tabIndex={0} className="min-h-0 flex-1 bg-terminal-bg p-2"><Suspense fallback={<div className="grid h-full place-items-center"><Spinner label="终端加载中…"/></div>}><TerminalView sessionId={active.id} readOnly={active.source === 'work_item'} className="h-full"/></Suspense></div> : <div id={isPtyCli ? 'tabpanel-timeline' : undefined} role={isPtyCli ? 'tabpanel' : undefined} aria-labelledby={isPtyCli ? 'tab-timeline' : undefined} tabIndex={isPtyCli ? 0 : undefined} className="flex min-h-0 flex-1 flex-col"><Suspense fallback={<div className="grid min-h-0 flex-1 place-items-center"><Spinner label="正在加载执行记录…"/></div>}><TimelineView activeSessionId={activeSessionId} eventsLoading={events.isLoading} onResolvePermission={(permissionId, approved) => active.source === 'work_item' ? setActionError('请从原目标处理此步骤的工具授权') : resolvePermission.mutate({ sessionId: active.id, permissionId, approved })} resolvingPermissionId={resolvePermission.isPending ? resolvePermission.variables?.permissionId : undefined} timeline={timeline} timelineSections={timelineSections} awaitingAnswer={awaitingAnswer} hasOngoingActivity={hasOngoingActivity} latestUserIndex={latestUserIndex} activeOutputLabel={activeOutputLabel} renderProgress={active.source !== 'work_item' ? emptyState => <WorkItemProgress emptyState={emptyState} session={active} agents={agents.data ?? []} onOpenItem={itemId => setWorkItemPanel({ sessionId: active.id, itemId })} onSelectSession={selectSession}/> : undefined} footer={<><VerificationSummary session={active} onOpenEvidence={() => { captureDialogOpener(); setDeliveryPanelOpen(true); }}/>{active.source === 'lark' && <TurnMemoryPanel session={active}/>}</>} /></Suspense></div>} {active.source === 'work_item' ? <div className="border-t border-default bg-surface px-4 py-3 text-caption text-subtle">此后台步骤由目标管理，请从原目标处理问题、授权、重试或停止。</div> : active.archivedAt ? <div className="border-t border-default bg-surface px-4 py-3 text-center text-caption text-subtle">该任务已归档，只能查看历史记录。</div> : <Composer state={active.state} value={prompt} references={composerReferences} sending={send.isPending} mode={sendMode} queuedTasks={queuedTasks} cancellingTaskId={cancelQueued.variables?.taskId} steeringTaskId={steerQueued.variables?.taskId} injectingTaskId={injectQueued.isPending ? injectQueued.variables?.taskId : undefined} steerable={activeAgent?.protocol === 'acp'} blockingPermissionId={blockingPermissionId} rejectingPermission={resolvePermission.isPending} onRejectPermission={permissionId => resolvePermission.mutate({ sessionId: active.id, permissionId, approved: false })} skills={skills.data ?? []} models={activeModels.data?.models ?? []} reasoningEfforts={activeModels.data?.reasoningEfforts ?? []} currentModel={active.model ?? activeModels.data?.defaultModel} currentReasoningEffort={active.reasoningEffort ?? activeModels.data?.defaultReasoningEffort} context={contextStatsFromEvents(eventList)} advertisedCommands={commandsFromEvents(eventList)} filePicker={Boolean(systemCapabilities.data?.filePicker)} modelReadiness={modelReadiness} switchingModel={switchModel.isPending || busyStates.has(active.state)} switchingReasoningEffort={switchReasoningEffort.isPending || busyStates.has(active.state)} refreshingModels={activeModels.isFetching || refreshModels.isPending} onChange={setPrompt} onReferencesChange={setComposerReferences} onModeChange={setSendMode} onSubmit={submit} onInterrupt={() => void act('interrupt')} onCancelQueued={taskId => cancelQueued.mutate({ sessionId: active.id, taskId })} onSteerQueued={taskId => steerQueued.mutate({ sessionId: active.id, taskId })} onInjectQueued={taskId => injectQueued.mutate({ sessionId: active.id, taskId })} onPickFile={async () => (await pickComposerFile.mutateAsync()).path} onModelChange={nextModel => switchModel.mutate({ sessionId: active.id, nextModel })} onReasoningEffortChange={nextReasoningEffort => switchReasoningEffort.mutate({ sessionId: active.id, nextReasoningEffort })} onRefreshModels={() => refreshModels.mutate({ agentId: active.agentId, currentModel: active.model })} session={active} onShowStatus={() => { const status = effectiveStatus(active); toastStore.push({ kind: 'info', key: 'composer-status', title: `${status.label} · ${activeAgent?.name ?? active.agentId}`, description: `${sessionWorkspaceName(active)}｜${queuedTasks.length ? `待执行指令 ${queuedTasks.length} 条｜` : ''}${status.archived ? '已归档任务只读' : nextActionForState(active.state)}` }); }} onRestart={() => restart.mutate(active.id)} onCreateTask={openCreateTask} onOpenHelp={openHelp}/>}</section>
          {rawVisible && (rawSideBySide
            ? <aside aria-label="原始日志" className="ui-side-panel flex w-[420px] shrink-0 flex-col border-l border-code-border bg-code-surface text-code-header-text"><div className="flex h-11 items-center border-b border-code-border px-3 text-caption font-medium"><Terminal size={13} className="mr-2"/>原始日志<span className="ml-auto"><IconButton label="关闭原始日志" onClick={toggleRawPanel}><PanelRightClose size={14}/></IconButton></span></div><pre className="m-0 flex-1 overflow-auto whitespace-pre-wrap border-0 bg-code-surface p-4 font-mono text-meta leading-5 text-code-header-text">{raw || '当前任务暂无原始输出。'}</pre></aside>
            : <Dialog open onClose={toggleRawPanel} label="原始日志" size="lg"><Dialog.Header><Terminal size={16}/><h2 className="text-title font-semibold">原始日志</h2><span className="ml-auto"><IconButton label="关闭原始日志" onClick={toggleRawPanel}><PanelRightClose size={16}/></IconButton></span></Dialog.Header><Dialog.Body className="bg-code-surface"><pre tabIndex={0} aria-label="原始日志内容" className="m-0 whitespace-pre-wrap border-0 bg-code-surface font-mono text-meta leading-5 text-code-header-text">{raw || '当前任务暂无原始输出。'}</pre></Dialog.Body></Dialog>)}
        </div>
      </> : <WorkspaceOverview sessions={visibleSessions} summaries={runSummaries} agents={agents.data ?? []} loading={sessions.isLoading} agentsLoading={agents.isLoading} larkBots={larkConfig.data?.bots ?? []} larkBotsLoading={larkConfig.isLoading} larkListeningDisabled={larkConfig.data?.listeningDisabled ?? false} larkBotsFailed={larkConfig.isError} larkBotsRetrying={larkConfig.isFetching} onRetryLarkBots={() => void larkConfig.refetch()} view={workbenchView} onViewChange={setWorkbenchView} onSelect={selectSession} onBulkArchive={ids => { captureDialogOpener(); bulkArchive.reset(); setBulkArchiveIds(ids); }} onCreate={openCreateTask} onOpenAgentSetup={() => openSettings('agents')} onOpenLarkSetup={() => openLarkSetup('new')} onManageBots={() => setPrimaryNav('bots')}/>}
    </main>
    </div>
    {newOpen && <NewSessionModal open initialAgentId={newAgentId} onClose={() => setNewOpen(false)} onOpenAgentSetup={() => { setNewOpen(false); openSettings('agents'); }} onCreated={(session, task) => { setRunSummaries(current => ({ ...current, [session.id]: { sessionId: session.id, taskId: task.id, prompt: task.prompt, status: task.status, queuedCount: task.status === 'queued' ? 1 : 0, updatedAt: task.updatedAt || task.createdAt } })); void qc.invalidateQueries({ queryKey: ['sessions'] }); selectSession(session.id); setNewOpen(false); setActionError(undefined); }} agents={agents.data ?? []} capabilities={systemCapabilities.data}/>}
    {overlay?.kind === 'lark-setup' && <Suspense fallback={overlayFallback('正在打开 Bot 绑定向导…')}><LarkConfigModal key={overlay.target === 'new' ? 'new' : overlay.target?.appId ?? 'manage'} target={overlay.target} agents={agents.data ?? []} onClose={() => { closeOverlay(); void qc.invalidateQueries({ queryKey: ['lark-config'] }); }}/></Suspense>}
    {overlay?.kind === 'settings' && <Suspense fallback={overlayFallback('正在打开设置与接入…')}><ControlCenterModal open initialSection={overlay.section} agents={agents.data ?? []} legacyBots={larkConfig.data?.bots ?? []} larkListeningDisabled={larkConfig.data?.listeningDisabled ?? false} larkBotsLoading={larkConfig.isLoading} larkBotsFailed={larkConfig.isError} larkBotsRetrying={larkConfig.isFetching} onRetryLarkBots={() => void larkConfig.refetch()} authRequired={authStatus.data?.required} onClose={closeOverlay} onCreateTask={agentId => { closeOverlay(); openCreateTaskForAgent(agentId); }} onOpenLarkSetup={openLarkSetup} onOpenGroups={() => openOverlay({ kind: 'groups' })} onOpenSchedules={() => openOverlay({ kind: 'automation' })}/></Suspense>}
    {overlay?.kind === 'groups' && <Suspense fallback={overlayFallback('正在打开群配置…')}><GroupPolicyModal open onClose={closeOverlay}/></Suspense>}
    {overlay?.kind === 'automation' && <Dialog open onClose={closeOverlay} label="任务自动化" size="lg">
      <Dialog.Header><h2 className="text-title font-semibold">任务自动化</h2><span className="ml-auto"><IconButton label="关闭自动化" onClick={closeOverlay}><X size={16}/></IconButton></span></Dialog.Header>
      <Dialog.Body><Suspense fallback={<Spinner label="正在读取任务自动化…"/>}><AutomationOverview sessions={visibleSessions} summaries={runSummaries} onSelectSession={id => { applySessionSelection(id); navigate({ route: { kind: 'session', sessionId: id }, nav: 'tasks', appId: selectedAppId, chatId: selectedChatId }, { replace: true }); }}/></Suspense></Dialog.Body>
    </Dialog>}
    {workspaceGroupsOpen && <Suspense fallback={overlayFallback('正在打开整理分组…')}><WorkspaceGroupsModal open onClose={() => setWorkspaceGroupsOpen(false)} snapshot={workspaceGroups.data} loading={workspaceGroups.isLoading} error={workspaceGroups.error ?? undefined} sessions={visibleSessions} summaries={runSummaries} onRetry={() => void workspaceGroups.refetch()}/></Suspense>}
    <ConfirmDialog open={archiveConfirm} tone="danger" title="归档此任务？" description="归档后任务将变为只读且无法恢复，历史指令和执行记录会继续保留。" confirmLabel="确认归档" busy={archive.isPending} error={archive.error?.message} onCancel={() => { if (!archive.isPending) setArchiveConfirm(false); }} onConfirm={() => { if (active) archive.mutate(active.id); }}/>
    <ConfirmDialog open={bulkArchiveIds.length > 0} tone="danger" title={`清理所选的 ${bulkArchiveIds.length} 个任务？`} description="所选任务将归档为只读且无法恢复；正在执行的任务会停止，排队指令会取消。历史指令和执行记录会保留，可在「已归档」中查看。" confirmLabel={bulkArchive.data?.failures.length ? '重试失败项' : '确认清理'} busy={bulkArchive.isPending} error={bulkArchive.data?.failures.length ? `${bulkArchive.data.failures.length} 个任务未清理。首个错误：${bulkArchive.data.failures[0].message}` : undefined} onCancel={() => { if (!bulkArchive.isPending) setBulkArchiveIds([]); }} onConfirm={() => { if (bulkArchiveIds.length && !bulkArchive.isPending) bulkArchive.mutate(bulkArchiveIds); }}/>
    <SystemPromptModal open={systemPromptOpen} session={active} onClose={() => setSystemPromptOpen(false)}/>
    <SessionNameModal open={Boolean(renameSession)} session={renameSession} onClose={() => setRenameSession(null)}/>
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} sessions={visibleSessions} summaries={runSummaries} agents={agents.data ?? []} actions={paletteActions} onSelectSession={selectSession}/>
    <ShortcutHelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} available={shortcutsAvailable}/>
    <ToastViewport/>
  </div>;
}
