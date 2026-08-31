import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Keyboard, Menu, MessageSquare, PanelRightClose, Search, Terminal, X } from 'lucide-react';
import { api, type DockEvent, type RunSummary, type Session, type Task } from './api';
import { useDockStore } from './store';
import { buildTimeline, buildTimelineSections } from './timeline';
import { Composer, type SendMode } from './components/Composer';
import { busyStates, IconButton } from './components/ui';
import { SessionList } from './components/SessionList';
import { NewSessionModal } from './components/NewSessionModal';
import { SystemPromptModal } from './components/SystemPromptModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { WorkspaceOverview } from './components/WorkspaceOverview';
import { RunHeader } from './components/RunHeader';
import { useSessionStream } from './useSessionStream';
import { buildPrompt, commandsFromEvents, contextStatsFromEvents, getModelReadiness, type ComposerReference } from './composer-utils';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';
import { createEventWindow, EVENT_PAGE_SIZE, initialEventQuery, mergeOlderEvents, oldestSequence, type EventWindow } from './event-history';
import { summaryFromTasks } from './run-summary';
import type { WorkbenchView } from './workspace-model';
import type { ControlCenterSection } from './components/ControlCenterModal';
import { captureDialogOpener } from './useDialogFocus';
import { CommandPalette, type CommandAction } from './components/CommandPalette';
import { ToastViewport } from './components/ToastViewport';
import { toastStore } from './useToasts';
import { ThemeToggle } from './components/ThemeToggle';
import { useTheme } from './useTheme';
import { shortcutAvailability, useKeyboardShortcuts, workbenchViewShortcutIds } from './useKeyboardShortcuts';
import { ShortcutHelpSheet } from './components/ShortcutHelpSheet';

// 终端与控制面都属于低频重功能，避免进入工作台首屏 chunk。
const TerminalView = lazy(() => import('./components/TerminalView').then(module => ({ default: module.TerminalView })));
const ControlCenterModal = lazy(() => import('./components/ControlCenterModal').then(module => ({ default: module.ControlCenterModal })));
const LarkConfigModal = lazy(() => import('./components/LarkConfigModal').then(module => ({ default: module.LarkConfigModal })));
const GroupPolicyModal = lazy(() => import('./components/GroupPolicyModal').then(module => ({ default: module.GroupPolicyModal })));
const ScheduleFoundationPanel = lazy(() => import('./components/ScheduleFoundationPanel').then(module => ({ default: module.ScheduleFoundationPanel })));
const TimelineView = lazy(() => import('./components/TimelineView').then(module => ({ default: module.TimelineView })));

type DetailTab = 'timeline' | 'terminal';
type AppRoute = { kind: 'overview' } | { kind: 'session'; sessionId: string } | { kind: 'not-found' };
type MainQueryFailure = { label: string; message: string; hasData: boolean; retrying: boolean; retry(): Promise<void> };

const appRouteFromPath = (pathname: string): AppRoute => {
  if (pathname === '/') return { kind: 'overview' };
  const match = pathname.match(/^\/sessions\/([^/]+)$/);
  if (!match?.[1]) return { kind: 'not-found' };
  try { return { kind: 'session', sessionId: decodeURIComponent(match[1]) }; }
  catch { return { kind: 'session', sessionId: match[1] }; }
};

const sessionPath = (id?: string) => id ? `/sessions/${encodeURIComponent(id)}` : '/';

export default function App() {
  const qc = useQueryClient();
  const { activeSessionId, setActive, rawVisible, toggleRaw } = useDockStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 768px)').matches);
  const [newOpen, setNewOpen] = useState(false);
  const [controlOpen, setControlOpen] = useState(false);
  const [controlSection, setControlSection] = useState<ControlCenterSection>('agents');
  const [larkSetupOpen, setLarkSetupOpen] = useState(false);
  const [groupPolicyOpen, setGroupPolicyOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [composerReferences, setComposerReferences] = useState<ComposerReference[]>([]);
  const [sendMode, setSendMode] = useState<SendMode>('queue');
  const [actionError, setActionError] = useState<string>();
  const [detailTab, setDetailTab] = useState<DetailTab>('timeline');
  const [route, setRoute] = useState<AppRoute>(() => typeof window === 'undefined' ? { kind: 'overview' } : appRouteFromPath(window.location.pathname));
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>('all');
  const [runSummaries, setRunSummaries] = useState<Record<string, RunSummary>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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
    setActionError(undefined);
  }, [setActive]);

  const selectSession = useCallback((id?: string) => {
    applySessionSelection(id);
    setRoute(id ? { kind: 'session', sessionId: id } : { kind: 'overview' });
    const nextPath = sessionPath(id);
    if (window.location.pathname !== nextPath) window.history.pushState({ sessionId: id }, '', nextPath);
  }, [applySessionSelection]);

  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, staleTime: 5 * 60_000 });
  // 非当前运行没有 SSE，低频同步用于捕获飞书创建等外部变化；当前运行状态仍由 SSE 即时写入缓存。
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const summaries = useQuery({ queryKey: ['run-summaries'], queryFn: api.runSummaries, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const larkConfig = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig, staleTime: 30_000, refetchOnWindowFocus: true });
  const systemCapabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities, staleTime: Infinity });
  const authStatus = useQuery({ queryKey: ['auth-status'], queryFn: api.authStatus, staleTime: Infinity, retry: false });

  const openSettings = (section: ControlCenterSection = 'agents') => {
    setControlSection(section);
    setControlOpen(true);
    setSidebarOpen(false);
  };
  const openLarkSetup = () => {
    setControlOpen(false);
    setLarkSetupOpen(true);
    setSidebarOpen(false);
  };
  const openCreateTask = () => {
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

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 768px)');
    const update = () => { setMobile(!media.matches); if (media.matches) setSidebarOpen(false); };
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!mobileNavigationOpen) return;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="Dockmux 工作台导航"] button')?.focus());
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
      const nextRoute = appRouteFromPath(window.location.pathname);
      setRoute(nextRoute);
      applySessionSelection(nextRoute.kind === 'session' ? nextRoute.sessionId : undefined);
    };
    syncSelectionFromLocation();
    window.addEventListener('popstate', syncSelectionFromLocation);
    return () => window.removeEventListener('popstate', syncSelectionFromLocation);
  }, [applySessionSelection]);

  const sortedSessions = useMemo(() => [...(sessions.data ?? [])].sort((left, right) => (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt)), [sessions.data]);
  const active = useMemo(() => sortedSessions.find(session => session.id === activeSessionId), [sortedSessions, activeSessionId]);
  const events = useQuery({ queryKey: ['events', activeSessionId], queryFn: async () => { const page = await api.events(activeSessionId!, initialEventQuery()); return createEventWindow(page, page.length >= EVENT_PAGE_SIZE); }, enabled: Boolean(active) });
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

  const send = useMutation({ mutationFn: ({ sessionId, message, mode }: { sessionId: string; message: string; mode: SendMode }) => api.send(sessionId, message, mode), onSuccess: (result, variables) => { if (variables.sessionId === activeSessionId) { setPrompt(''); setComposerReferences([]); setSendMode('queue'); } qc.setQueryData<Task[]>(['tasks', variables.sessionId], current => [...(current ?? []).filter(task => task.id !== result.task.id), result.task]); }, onError: error => setActionError(error.message) });
  const cancelQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.cancelQueued(sessionId, taskId), onMutate: ({ sessionId, taskId }) => ({ prompt: qc.getQueryData<Task[]>(['tasks', sessionId])?.find(task => task.id === taskId)?.prompt }), onSuccess: (result, variables, context) => {
    qc.setQueryData<Task[]>(['tasks', variables.sessionId], current => current?.map(task => task.id === result.id ? result : task));
    // 撤销只能把指令重新排到队尾，拿不回原来的任务 ID 和位置，所以 description 必须说清楚，不假装能还原现场。
    const restorable = context?.prompt?.trim();
    toastStore.push({ kind: 'success', key: `cancel-queued-${variables.taskId}`, title: '已取消 1 条待执行指令', description: restorable ? '恢复会把这条指令重新排到队列末尾，不会回到原来的位置。' : undefined, action: restorable ? { label: '恢复这条指令', run: () => api.send(variables.sessionId, restorable, 'queue').then(() => { void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId] }); }) } : undefined });
  }, onError: error => { setActionError(error.message); toastStore.push({ kind: 'error', key: 'cancel-queued', title: '取消待执行指令失败', description: error.message }); } });
  const steerQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.steerQueued(sessionId, taskId), onSuccess: (_result, variables) => { setActionError(undefined); void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId] }); }, onError: error => setActionError(error.message) });
  const archive = useMutation({ mutationFn: (sessionId: string) => api.archive(sessionId), onSuccess: result => { qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); setArchiveConfirm(false); selectSession(undefined); toastStore.push({ kind: 'success', key: 'archive', title: '任务运行已归档', description: '历史指令和执行记录仍可在「已归档」筛选中查看。' }); }, onError: error => setActionError(error.message) });
  const restart = useMutation({ mutationFn: api.restart, onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); void qc.invalidateQueries({ queryKey: ['sessions'] }); void qc.invalidateQueries({ queryKey: ['events', activeSessionId] }); void qc.invalidateQueries({ queryKey: ['tasks', activeSessionId] }); toastStore.push({ kind: 'success', key: 'restart', title: '任务运行已重新启动', description: '下达新指令即可从当前上下文继续。' }); }, onError: error => { setActionError(error.message); toastStore.push({ kind: 'error', key: 'restart', title: '重新启动失败', description: error.message }); } });
  const resolvePermission = useMutation({ mutationFn: ({ sessionId, permissionId, approved }: { sessionId: string; permissionId: string; approved: boolean }) => api.permission(sessionId, permissionId, approved), onSuccess: (_result, variables) => { qc.setQueryData<EventWindow>(['events', variables.sessionId], current => { if (!current) return current; const next = current.events.map(event => event.type === 'permission_request' && (event.data.id === variables.permissionId || event.id === variables.permissionId) ? { ...event, data: { ...event.data, status: variables.approved ? 'approved' : 'rejected' } } : event); return createEventWindow(next, current.hasEarlier); }); }, onError: error => setActionError(error.message) });
  const loadEarlier = useMutation({ mutationFn: async () => { const before = oldestSequence(events.data); if (before === undefined || !activeSessionId) return [] as DockEvent[]; return api.events(activeSessionId, { before, limit: EVENT_PAGE_SIZE, direction: 'backward' }); }, onSuccess: older => { if (!activeSessionId) return; qc.setQueryData<EventWindow>(['events', activeSessionId], current => mergeOlderEvents(current, older, older.length >= EVENT_PAGE_SIZE)); }, onError: error => setActionError(error.message) });
  const pickComposerFile = useMutation({ mutationFn: api.selectFile, onError: error => setActionError(error.message) });
  const refreshModels = useMutation({ mutationFn: ({ agentId: targetAgentId, currentModel }: { agentId: string; currentModel?: string }) => loadAgentModels(targetAgentId, currentModel, true), onSuccess: (result, variables) => { setActionError(undefined); qc.setQueryData(agentModelsQueryKey(variables.agentId, variables.currentModel), result); }, onError: error => setActionError(error.message) });
  const switchModel = useMutation({ mutationFn: ({ sessionId, nextModel }: { sessionId: string; nextModel: string }) => api.setSessionModel(sessionId, nextModel), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); void activeModels.refetch(); }, onError: error => setActionError(error.message) });
  const switchReasoningEffort = useMutation({ mutationFn: ({ sessionId, nextReasoningEffort }: { sessionId: string; nextReasoningEffort: string }) => api.setSessionReasoningEffort(sessionId, nextReasoningEffort), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); }, onError: error => setActionError(error.message) });
  const modelReadiness = getModelReadiness({ loaded: activeModels.data !== undefined, loading: activeModels.data === undefined && (activeModels.isPending || activeModels.isFetching || refreshModels.isPending), switching: switchModel.isPending, failed: activeModels.data === undefined && activeModels.isError });
  const mainQueryFailures: MainQueryFailure[] = [
    ...(agents.isError ? [{ label: 'Agent 信息', message: agents.error.message, hasData: agents.data !== undefined, retrying: agents.isFetching, retry: async () => { await agents.refetch(); } }] : []),
    ...(sessions.isError ? [{ label: '任务运行', message: sessions.error.message, hasData: sessions.data !== undefined, retrying: sessions.isFetching, retry: async () => { await sessions.refetch(); } }] : []),
    ...(summaries.isError ? [{ label: '运行摘要', message: summaries.error.message, hasData: summaries.data !== undefined, retrying: summaries.isFetching, retry: async () => { await summaries.refetch(); } }] : [])
  ];
  const blockingMainQueryFailures = mainQueryFailures.filter(failure => !failure.hasData);
  const staleMainQueryFailures = mainQueryFailures.filter(failure => failure.hasData);
  const retryingMainQueries = mainQueryFailures.some(failure => failure.retrying);
  const submit = () => { if (modelReadiness.kind !== 'ready') return; const message = buildPrompt(prompt, composerReferences); if (message && activeSessionId) send.mutate({ sessionId: activeSessionId, message, mode: busyStates.has(active?.state ?? '') ? sendMode : 'queue' }); };
  const act = async (action: string) => { try { setActionError(undefined); await api.action(activeSessionId!, action); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); } };

  // 有浮层占用键盘时整套快捷键停用，避免和弹窗内的按键语义打架。
  const overlayOpen = newOpen || controlOpen || larkSetupOpen || groupPolicyOpen || scheduleOpen || archiveConfirm || systemPromptOpen || paletteOpen || helpOpen;
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
    // session 作用域：没有打开运行时 shortcutAvailability 会自动判为不可用，这里无需再判。
    ...(active ? {
      'interrupt-run': () => { if (busyStates.has(active.state)) void act('interrupt'); },
      'restart-run': () => { if (active.state === 'failed' || active.state === 'stopped') restart.mutate(active.id); },
      'archive-run': () => { if (!active.archivedAt) { archive.reset(); setArchiveConfirm(true); } },
      'toggle-detail-tab': () => { if (isPtyCli) setDetailTab(tab => tab === 'timeline' ? 'terminal' : 'timeline'); },
      'toggle-raw-log': () => { if (raw) toggleRaw(); }
    } : {})
  // openCreateTask / openSettings / openLarkSetup / act 每次渲染重建但只读最新 state，hook 内部用 ref 同步，
  // 因此依赖数组只跟踪真正影响可用性的值。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [active, isPtyCli, raw, selectSession, toggleRaw]);
  useKeyboardShortcuts(shortcutHandlers, { enabled: !overlayOpen, sessionOpen: Boolean(active) });
  const shortcutsAvailable = shortcutAvailability(shortcutHandlers, { sessionOpen: Boolean(active), enabled: !overlayOpen });

  const paletteActions: CommandAction[] = [
    { id: 'create-task', label: '创建任务', hint: agents.data?.length ? '描述目标后立即开始执行' : undefined, group: '任务', keywords: 'new task 新建 创建', shortcut: 'N', disabled: agents.isLoading, disabledReason: agents.isLoading ? '正在检测可用 Agent，稍候即可创建' : undefined, run: openCreateTask },
    { id: 'go-task-center', label: '回到任务中心', hint: '查看待你处理、进行中与最近的任务', group: '导航', keywords: 'home overview 总览 首页', run: () => selectSession(undefined) },
    { id: 'open-settings', label: '打开设置与接入', hint: '管理 Agent、飞书 Bot 与自动化', group: '导航', keywords: 'settings agent 设置', run: () => openSettings('agents') },
    { id: 'open-lark', label: '绑定或管理飞书 Bot', hint: '在飞书中下达任务并接收结果', group: '导航', keywords: 'lark feishu 飞书 bot', run: openLarkSetup },
    { id: 'toggle-help', label: '查看键盘快捷键', group: '帮助', keywords: 'help shortcut 快捷键 帮助', shortcut: '?', run: openHelp },
    ...(active && !active.archivedAt ? [
      { id: 'interrupt-run', label: '中断当前运行', hint: '停在已完成的步骤，可稍后继续', group: '任务', keywords: 'interrupt stop 中断', disabled: !busyStates.has(active.state), disabledReason: '当前运行没有在执行中的步骤', run: () => void act('interrupt') },
      { id: 'archive-run', label: '归档当前任务运行', hint: '归档后只读，需二次确认', group: '任务', keywords: 'archive 归档', run: () => { archive.reset(); setArchiveConfirm(true); } }
    ] satisfies CommandAction[] : [])
  ];
  const moveDetailTab = (nextTab: DetailTab) => {
    setDetailTab(nextTab);
    document.getElementById(`run-detail-tab-${nextTab}`)?.focus();
  };
  const handleDetailTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, tab: DetailTab) => {
    const nextTab = event.key === 'Home' ? 'timeline' : event.key === 'End' ? 'terminal' : event.key === 'ArrowRight' ? (tab === 'timeline' ? 'terminal' : 'timeline') : event.key === 'ArrowLeft' ? (tab === 'timeline' ? 'terminal' : 'timeline') : undefined;
    if (!nextTab) return;
    event.preventDefault();
    moveDetailTab(nextTab);
  };
  const renderNotFound = (kind: 'page' | 'session') => <div className="relative grid min-h-0 flex-1 place-items-center overflow-auto p-6"><div className="absolute left-3 top-3 md:hidden"><IconButton label="打开工作台导航" onClick={openMobileNavigation}><Menu size={17}/></IconButton></div><section className="w-full max-w-md rounded-2xl border border-[var(--border-default)] bg-[var(--surface-default)] p-7 text-center shadow-[var(--shadow-card)]"><p className="text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--status-warning)]">{kind === 'page' ? 'Page not found' : 'Session not found'}</p><h1 className="mt-2 text-lg font-semibold text-[var(--text-primary)]">{kind === 'page' ? '找不到这个页面' : '找不到这个任务运行'}</h1><p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">{kind === 'page' ? '当前链接不是有效的 Dockmux 页面。' : '它可能已被删除，或当前链接不属于这个 Dockmux 实例。'}</p><button type="button" onClick={() => selectSession(undefined)} className="mt-5 rounded-lg bg-[var(--surface-inverse)] px-3.5 py-2 text-xs font-semibold text-[var(--text-inverse)] hover:bg-[var(--surface-inverse-hover)]">回到任务中心</button></section></div>;

  return <div className="relative flex h-[100dvh] min-h-[100dvh] overflow-hidden bg-[var(--surface-canvas)] font-sans text-[var(--text-primary)]">
    {mobileNavigationOpen && <button type="button" aria-label="关闭工作台导航" onClick={() => setSidebarOpen(false)} className="ui-overlay fixed inset-0 z-10 bg-[var(--overlay-scrim)] backdrop-blur-[1px] md:hidden"/>}
    <SessionList open={sidebarOpen} onClose={() => setSidebarOpen(false)} sessions={sortedSessions} summaries={runSummaries} sessionsLoading={sessions.isLoading} agents={agents.data ?? []} larkBots={larkConfig.data?.bots ?? []} activeSessionId={activeSessionId} view={workbenchView} onViewChange={setWorkbenchView} onSelect={selectSession} onNewSession={openCreateTask} onOpenLarkSetup={openLarkSetup} onOpenControlCenter={() => openSettings('agents')} authRequired={authStatus.data?.required}/>
    <main aria-hidden={mobileNavigationOpen || undefined} inert={mobileNavigationOpen || undefined} className="flex min-w-0 flex-1 flex-col">
      {route.kind !== 'not-found' && !blockingMainQueryFailures.length && staleMainQueryFailures.length > 0 && <div role="status" className="flex shrink-0 items-center gap-3 border-b border-[var(--status-warning-border)] bg-[var(--status-warning-soft)] px-4 py-2 text-xs text-[var(--status-warning)]"><span className="min-w-0 flex-1 truncate" title={staleMainQueryFailures.map(failure => `${failure.label}：${failure.message}`).join('\n')}>部分数据可能不是最新：{staleMainQueryFailures.map(failure => failure.label).join('、')}</span><button type="button" disabled={retryingMainQueries} onClick={() => void Promise.all(staleMainQueryFailures.map(failure => failure.retry()))} className="shrink-0 rounded-md border border-[var(--status-warning-border)] bg-[var(--surface-default)] px-2 py-1 font-semibold hover:bg-[var(--surface-hover)] disabled:opacity-50">{retryingMainQueries ? '重试中…' : '重试'}</button></div>}
      {route.kind === 'not-found' ? renderNotFound('page') : blockingMainQueryFailures.length ? <div className="relative grid min-h-0 flex-1 place-items-center overflow-auto p-6"><div className="absolute left-3 top-3 md:hidden"><IconButton label="打开工作台导航" onClick={openMobileNavigation}><Menu size={17}/></IconButton></div><section role="alert" className="w-full max-w-lg rounded-2xl border border-[var(--status-danger-border)] bg-[var(--surface-default)] p-6 shadow-[var(--shadow-card)]"><p className="text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--status-danger)]">数据未就绪</p><h1 className="mt-2 text-lg font-semibold text-[var(--text-primary)]">无法加载任务中心</h1><p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">以下关键数据加载失败。为避免把故障显示成空列表，任务内容已暂停展示。</p><ul className="mt-4 space-y-2">{mainQueryFailures.map(failure => <li key={failure.label} className="rounded-lg bg-[var(--status-danger-soft)] px-3 py-2 text-xs text-[var(--status-danger)]"><strong>{failure.label}</strong><span className="ml-2">{failure.message}</span></li>)}</ul><button type="button" disabled={retryingMainQueries} onClick={() => void Promise.all(mainQueryFailures.map(failure => failure.retry()))} className="mt-5 rounded-lg bg-[var(--surface-inverse)] px-3.5 py-2 text-xs font-semibold text-[var(--text-inverse)] hover:bg-[var(--surface-inverse-hover)] disabled:opacity-50">{retryingMainQueries ? '正在重试…' : '重新加载'}</button></section></div> : route.kind === 'session' && sessions.isPending ? <div className="grid min-h-0 flex-1 place-items-center text-xs text-[var(--text-muted)]">正在加载任务运行…</div> : missingActiveSession ? renderNotFound('session') : active ? <>
        <RunHeader session={active} agent={activeAgent} taskPrompt={runSummaries[active.id]?.prompt} streamStatus={streamStatus} queuedTasks={queuedTasks} rawVisible={rawVisible} rawAvailable={Boolean(raw)} restarting={restart.isPending} onOpenSidebar={openMobileNavigation} onInterrupt={() => void act('interrupt')} onRestart={() => restart.mutate(active.id)} onOpenPrompt={() => setSystemPromptOpen(true)} onArchive={() => { archive.reset(); setArchiveConfirm(true); }} onToggleRaw={toggleRaw}/>
        {actionError && <div role="alert" className="flex items-center border-b border-[var(--status-danger-border)] bg-[var(--status-danger-soft)] px-4 py-2 text-xs text-[var(--status-danger)]"><span>{actionError}</span><button className="ml-auto" onClick={() => setActionError(undefined)} aria-label="关闭错误提示"><X size={13}/></button></div>}
        {isPtyCli && <><div role="tablist" aria-label="任务运行内容" className="flex shrink-0 items-center gap-1 border-b border-[var(--border-default)] bg-[var(--surface-default)] px-3 sm:px-5">{([['timeline', MessageSquare, '执行记录'], ['terminal', Terminal, '终端']] as const).map(([tab, Icon, label]) => <button key={tab} id={`run-detail-tab-${tab}`} role="tab" aria-selected={detailTab === tab} aria-controls={`run-detail-panel-${tab}`} tabIndex={detailTab === tab ? 0 : -1} type="button" onClick={() => setDetailTab(tab)} onKeyDown={event => handleDetailTabKeyDown(event, tab)} className={`-mb-px flex h-9 items-center gap-1.5 border-b-2 px-2 text-[11px] font-semibold transition ${detailTab === tab ? 'border-[var(--action-primary)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}><Icon size={12}/>{label}</button>)}</div>{active.permissionMode === 'ask' && <div className="flex shrink-0 items-center border-b border-[var(--status-warning-border)] bg-[var(--status-warning-soft)] px-4 py-2 text-[11px] text-[var(--status-warning)] sm:px-5"><span className="min-w-0 flex-1">此 CLI 的操作确认在终端中完成；若运行等待响应，请前往终端处理。</span><button type="button" onClick={() => setDetailTab('terminal')} className="ml-3 shrink-0 rounded-md border border-[var(--status-warning-border)] bg-[var(--surface-default)] px-2 py-1 font-semibold hover:bg-[var(--surface-hover)]">打开终端</button></div>}</>}
        <div className="flex min-h-0 flex-1"><section className="flex min-w-0 flex-1 flex-col">{detailTab === 'terminal' && isPtyCli ? <div id="run-detail-panel-terminal" role="tabpanel" aria-labelledby="run-detail-tab-terminal" tabIndex={0} className="min-h-0 flex-1 bg-[var(--terminal-bg)] p-2"><Suspense fallback={<div className="grid h-full place-items-center text-xs text-[var(--text-muted)]">终端加载中…</div>}><TerminalView sessionId={active.id} className="h-full"/></Suspense></div> : <div id={isPtyCli ? 'run-detail-panel-timeline' : undefined} role={isPtyCli ? 'tabpanel' : undefined} aria-labelledby={isPtyCli ? 'run-detail-tab-timeline' : undefined} tabIndex={isPtyCli ? 0 : undefined} className="flex min-h-0 flex-1 flex-col"><Suspense fallback={<div className="grid min-h-0 flex-1 place-items-center text-xs text-[var(--text-muted)]">正在加载执行记录…</div>}><TimelineView activeSessionId={activeSessionId} eventsLoading={events.isLoading} loadingEarlier={loadEarlier.isPending} hasEarlier={Boolean(events.data?.hasEarlier)} onLoadEarlier={() => loadEarlier.mutateAsync()} onResolvePermission={(permissionId, approved) => resolvePermission.mutate({ sessionId: active.id, permissionId, approved })} resolvingPermissionId={resolvePermission.isPending ? resolvePermission.variables?.permissionId : undefined} timeline={timeline} timelineSections={timelineSections} awaitingAnswer={awaitingAnswer} hasOngoingActivity={hasOngoingActivity} latestUserIndex={latestUserIndex} activeOutputLabel={activeOutputLabel}/></Suspense></div>} {active.archivedAt ? <div className="border-t border-[var(--border-default)] bg-[var(--surface-default)] px-4 py-3 text-center text-xs text-[var(--text-muted)]">该任务运行已归档，只能查看历史记录。</div> : <Composer state={active.state} value={prompt} references={composerReferences} sending={send.isPending} mode={sendMode} queuedTasks={queuedTasks} cancellingTaskId={cancelQueued.variables?.taskId} steeringTaskId={steerQueued.variables?.taskId} skills={skills.data ?? []} models={activeModels.data?.models ?? []} reasoningEfforts={activeModels.data?.reasoningEfforts ?? []} currentModel={active.model ?? activeModels.data?.defaultModel} currentReasoningEffort={active.reasoningEffort ?? activeModels.data?.defaultReasoningEffort} context={contextStatsFromEvents(eventList)} advertisedCommands={commandsFromEvents(eventList)} filePicker={Boolean(systemCapabilities.data?.filePicker)} modelReadiness={modelReadiness} switchingModel={switchModel.isPending || busyStates.has(active.state)} switchingReasoningEffort={switchReasoningEffort.isPending || busyStates.has(active.state)} refreshingModels={activeModels.isFetching || refreshModels.isPending} onChange={setPrompt} onReferencesChange={setComposerReferences} onModeChange={setSendMode} onSubmit={submit} onInterrupt={() => void act('interrupt')} onCancelQueued={taskId => cancelQueued.mutate({ sessionId: active.id, taskId })} onSteerQueued={taskId => steerQueued.mutate({ sessionId: active.id, taskId })} onPickFile={async () => (await pickComposerFile.mutateAsync()).path} onModelChange={nextModel => switchModel.mutate({ sessionId: active.id, nextModel })} onReasoningEffortChange={nextReasoningEffort => switchReasoningEffort.mutate({ sessionId: active.id, nextReasoningEffort })} onRefreshModels={() => refreshModels.mutate({ agentId: active.agentId, currentModel: active.model })}/>}</section>
          {rawVisible && <aside className="ui-side-panel fixed inset-y-0 right-0 z-20 flex w-full max-w-[440px] shrink-0 flex-col border-l border-[var(--code-border)] bg-[var(--code-surface)] text-[var(--code-header-text)] shadow-[var(--shadow-overlay)] 2xl:static 2xl:z-auto 2xl:w-[420px] 2xl:shadow-none"><div className="flex h-11 items-center border-b border-[var(--code-border)] px-3 text-xs font-medium"><Terminal size={13} className="mr-2 text-[var(--sidebar-accent)]"/>原始运行日志<span className="ml-auto"><IconButton label="关闭原始日志" onClick={toggleRaw}><PanelRightClose size={14}/></IconButton></span></div><pre className="m-0 flex-1 overflow-auto whitespace-pre-wrap border-0 bg-[var(--code-surface)] p-4 font-mono text-[11px] leading-5 text-[var(--code-header-text)]">{raw || '当前运行暂无原始输出。'}</pre></aside>}
        </div>
      </> : <><div className="absolute left-3 top-3 z-10 md:hidden"><IconButton label="打开工作台导航" onClick={openMobileNavigation}><Menu size={17}/></IconButton></div><WorkspaceOverview sessions={sortedSessions} summaries={runSummaries} agents={agents.data ?? []} loading={sessions.isLoading} agentsLoading={agents.isLoading} larkBots={larkConfig.data?.bots.length ?? 0} larkBotsLoading={larkConfig.isLoading} view={workbenchView} onViewChange={setWorkbenchView} onSelect={selectSession} onCreate={openCreateTask} onOpenAgentSetup={() => openSettings('agents')} onOpenLarkSetup={openLarkSetup} onOpenSearch={openPalette} onOpenShortcuts={openHelp} themeControl={<ThemeToggle preference={theme.preference} resolved={theme.resolved} onChange={theme.setPreference}/>}/></>}
    </main>
    <NewSessionModal open={newOpen} onClose={() => setNewOpen(false)} onOpenAgentSetup={() => { setNewOpen(false); openSettings('agents'); }} onCreated={(session, task) => { setRunSummaries(current => ({ ...current, [session.id]: { sessionId: session.id, taskId: task.id, prompt: task.prompt, status: task.status, queuedCount: task.status === 'queued' ? 1 : 0, updatedAt: task.updatedAt || task.createdAt } })); void qc.invalidateQueries({ queryKey: ['sessions'] }); selectSession(session.id); setNewOpen(false); setActionError(undefined); }} agents={agents.data ?? []} capabilities={systemCapabilities.data}/>
    {larkSetupOpen && <Suspense fallback={<div className="fixed inset-0 z-30 grid place-items-center bg-[var(--overlay-scrim)] text-sm text-[var(--text-primary)] backdrop-blur-sm">正在打开 Bot 绑定向导…</div>}><LarkConfigModal agents={agents.data ?? []} onClose={() => { setLarkSetupOpen(false); void qc.invalidateQueries({ queryKey: ['lark-config'] }); }}/></Suspense>}
    {controlOpen && <Suspense fallback={<div className="fixed inset-0 z-30 grid place-items-center bg-[var(--overlay-scrim)] text-sm text-[var(--text-primary)] backdrop-blur-sm">正在打开设置与接入…</div>}><ControlCenterModal open initialSection={controlSection} agents={agents.data ?? []} legacyBots={larkConfig.data?.bots ?? []} authRequired={authStatus.data?.required} onClose={() => setControlOpen(false)} onCreateTask={() => { setControlOpen(false); openCreateTask(); }} onOpenLarkSetup={openLarkSetup} onOpenGroups={() => { setControlOpen(false); setGroupPolicyOpen(true); }} onOpenSchedules={() => { setControlOpen(false); setScheduleOpen(true); }}/></Suspense>}
    {groupPolicyOpen && <Suspense fallback={<div className="fixed inset-0 z-30 grid place-items-center bg-[var(--overlay-scrim)] text-sm text-[var(--text-primary)] backdrop-blur-sm">正在打开群配置…</div>}><GroupPolicyModal open onClose={() => setGroupPolicyOpen(false)}/></Suspense>}
    {scheduleOpen && <Suspense fallback={<div className="fixed inset-0 z-30 grid place-items-center bg-[var(--overlay-scrim)] text-sm text-[var(--text-primary)] backdrop-blur-sm">正在打开自动化…</div>}><ScheduleFoundationPanel open onClose={() => setScheduleOpen(false)}/></Suspense>}
    <ConfirmDialog open={archiveConfirm} tone="danger" title="归档此任务运行？" description="归档后运行将变为只读且无法恢复，历史指令和执行记录会继续保留。" confirmLabel="确认归档" busy={archive.isPending} error={archive.error?.message} onCancel={() => { if (!archive.isPending) setArchiveConfirm(false); }} onConfirm={() => { if (active) archive.mutate(active.id); }}/>
    <SystemPromptModal open={systemPromptOpen} session={active} onClose={() => setSystemPromptOpen(false)}/>
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} sessions={sortedSessions} summaries={runSummaries} agents={agents.data ?? []} actions={paletteActions} onSelectSession={selectSession}/>
    <ShortcutHelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} available={shortcutsAvailable}/>
    <ToastViewport/>
  </div>;
}
