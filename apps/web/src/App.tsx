import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Menu, MessageSquare, PanelRightClose, Terminal, X } from 'lucide-react';
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

// 终端与飞书设置都属于低频重功能，避免进入工作台首屏 chunk。
const TerminalView = lazy(() => import('./components/TerminalView').then(module => ({ default: module.TerminalView })));
const LarkConfigModal = lazy(() => import('./components/LarkConfigModal').then(module => ({ default: module.LarkConfigModal })));
const TimelineView = lazy(() => import('./components/TimelineView').then(module => ({ default: module.TimelineView })));

type DetailTab = 'timeline' | 'terminal';

export default function App() {
  const qc = useQueryClient();
  const { activeSessionId, setActive, rawVisible, toggleRaw } = useDockStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 768px)').matches);
  const [newOpen, setNewOpen] = useState(false);
  const [larkOpen, setLarkOpen] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [composerReferences, setComposerReferences] = useState<ComposerReference[]>([]);
  const [sendMode, setSendMode] = useState<SendMode>('queue');
  const [actionError, setActionError] = useState<string>();
  const [detailTab, setDetailTab] = useState<DetailTab>('timeline');
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>('all');
  const [runSummaries, setRunSummaries] = useState<Record<string, RunSummary>>({});
  const navigationTrigger = useRef<HTMLElement | null>(null);
  const mobileNavigationOpen = mobile && sidebarOpen;
  const openMobileNavigation = () => {
    navigationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSidebarOpen(true);
  };

  const selectSession = (id?: string) => {
    setActive(id);
    setPrompt('');
    setComposerReferences([]);
    setDetailTab('timeline');
    window.history.replaceState(null, '', id ? `/sessions/${encodeURIComponent(id)}` : '/');
  };

  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents, staleTime: 5 * 60_000 });
  // 非当前运行没有 SSE，低频同步用于捕获飞书创建等外部变化；当前运行状态仍由 SSE 即时写入缓存。
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const summaries = useQuery({ queryKey: ['run-summaries'], queryFn: api.runSummaries, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const larkConfig = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig, staleTime: 30_000, refetchOnWindowFocus: true });
  const systemCapabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities, staleTime: Infinity });

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
    if (activeSessionId) return;
    const match = window.location.pathname.match(/^\/sessions\/([^/]+)$/);
    if (match?.[1]) setActive(decodeURIComponent(match[1]));
  }, [activeSessionId, setActive]);

  const events = useQuery({ queryKey: ['events', activeSessionId], queryFn: async () => { const page = await api.events(activeSessionId!, initialEventQuery()); return createEventWindow(page, page.length >= EVENT_PAGE_SIZE); }, enabled: !!activeSessionId });
  const tasks = useQuery({ queryKey: ['tasks', activeSessionId], queryFn: () => api.tasks(activeSessionId!), enabled: !!activeSessionId });
  const sortedSessions = useMemo(() => [...(sessions.data ?? [])].sort((left, right) => (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt)), [sessions.data]);
  const active = useMemo(() => sortedSessions.find(session => session.id === activeSessionId), [sortedSessions, activeSessionId]);
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
  const cancelQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.cancelQueued(sessionId, taskId), onSuccess: (result, variables) => qc.setQueryData<Task[]>(['tasks', variables.sessionId], current => current?.map(task => task.id === result.id ? result : task)), onError: error => setActionError(error.message) });
  const steerQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.steerQueued(sessionId, taskId), onSuccess: (_result, variables) => { setActionError(undefined); void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId] }); }, onError: error => setActionError(error.message) });
  const archive = useMutation({ mutationFn: (sessionId: string) => api.archive(sessionId), onSuccess: result => { qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); setArchiveConfirm(false); selectSession(undefined); }, onError: error => setActionError(error.message) });
  const restart = useMutation({ mutationFn: api.restart, onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); void qc.invalidateQueries({ queryKey: ['sessions'] }); void qc.invalidateQueries({ queryKey: ['events', activeSessionId] }); void qc.invalidateQueries({ queryKey: ['tasks', activeSessionId] }); }, onError: error => setActionError(error.message) });
  const resolvePermission = useMutation({ mutationFn: ({ sessionId, permissionId, approved }: { sessionId: string; permissionId: string; approved: boolean }) => api.permission(sessionId, permissionId, approved), onSuccess: (_result, variables) => { qc.setQueryData<EventWindow>(['events', variables.sessionId], current => { if (!current) return current; const next = current.events.map(event => event.type === 'permission_request' && (event.data.id === variables.permissionId || event.id === variables.permissionId) ? { ...event, data: { ...event.data, status: variables.approved ? 'approved' : 'rejected' } } : event); return createEventWindow(next, current.hasEarlier); }); }, onError: error => setActionError(error.message) });
  const loadEarlier = useMutation({ mutationFn: async () => { const before = oldestSequence(events.data); if (before === undefined || !activeSessionId) return [] as DockEvent[]; return api.events(activeSessionId, { before, limit: EVENT_PAGE_SIZE, direction: 'backward' }); }, onSuccess: older => { if (!activeSessionId) return; qc.setQueryData<EventWindow>(['events', activeSessionId], current => mergeOlderEvents(current, older, older.length >= EVENT_PAGE_SIZE)); }, onError: error => setActionError(error.message) });
  const pickComposerFile = useMutation({ mutationFn: api.selectFile, onError: error => setActionError(error.message) });
  const refreshModels = useMutation({ mutationFn: ({ agentId: targetAgentId, currentModel }: { agentId: string; currentModel?: string }) => loadAgentModels(targetAgentId, currentModel, true), onSuccess: (result, variables) => { setActionError(undefined); qc.setQueryData(agentModelsQueryKey(variables.agentId, variables.currentModel), result); }, onError: error => setActionError(error.message) });
  const switchModel = useMutation({ mutationFn: ({ sessionId, nextModel }: { sessionId: string; nextModel: string }) => api.setSessionModel(sessionId, nextModel), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); void activeModels.refetch(); }, onError: error => setActionError(error.message) });
  const switchReasoningEffort = useMutation({ mutationFn: ({ sessionId, nextReasoningEffort }: { sessionId: string; nextReasoningEffort: string }) => api.setSessionReasoningEffort(sessionId, nextReasoningEffort), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); }, onError: error => setActionError(error.message) });
  const modelReadiness = getModelReadiness({ loaded: activeModels.data !== undefined, loading: activeModels.data === undefined && (activeModels.isPending || activeModels.isFetching || refreshModels.isPending), switching: switchModel.isPending, failed: activeModels.data === undefined && activeModels.isError });
  const submit = () => { if (modelReadiness.kind !== 'ready') return; const message = buildPrompt(prompt, composerReferences); if (message && activeSessionId) send.mutate({ sessionId: activeSessionId, message, mode: busyStates.has(active?.state ?? '') ? sendMode : 'queue' }); };
  const act = async (action: string) => { try { setActionError(undefined); await api.action(activeSessionId!, action); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); } };

  return <div className="relative flex h-[100dvh] min-h-[100dvh] overflow-hidden bg-[var(--canvas)] font-sans text-slate-900">
    {mobileNavigationOpen && <button type="button" aria-label="关闭工作台导航" onClick={() => setSidebarOpen(false)} className="ui-overlay fixed inset-0 z-10 bg-slate-950/35 backdrop-blur-[1px] md:hidden"/>}
    <SessionList open={sidebarOpen} onClose={() => setSidebarOpen(false)} sessions={sortedSessions} summaries={runSummaries} sessionsLoading={sessions.isLoading} agents={agents.data ?? []} larkBots={larkConfig.data?.bots ?? []} activeSessionId={activeSessionId} view={workbenchView} onViewChange={setWorkbenchView} onSelect={selectSession} onNewSession={() => { setActionError(undefined); setNewOpen(true); }} onOpenLark={() => setLarkOpen(true)}/>
    <main aria-hidden={mobileNavigationOpen || undefined} inert={mobileNavigationOpen || undefined} className="flex min-w-0 flex-1 flex-col">
      {active ? <>
        <RunHeader session={active} agent={activeAgent} taskPrompt={runSummaries[active.id]?.prompt} streamStatus={streamStatus} queuedTasks={queuedTasks} rawVisible={rawVisible} rawAvailable={Boolean(raw)} restarting={restart.isPending} onOpenSidebar={openMobileNavigation} onInterrupt={() => void act('interrupt')} onRestart={() => restart.mutate(active.id)} onOpenPrompt={() => setSystemPromptOpen(true)} onArchive={() => { archive.reset(); setArchiveConfirm(true); }} onToggleRaw={toggleRaw}/>
        {actionError && <div role="alert" className="flex items-center border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700"><span>{actionError}</span><button className="ml-auto" onClick={() => setActionError(undefined)} aria-label="关闭错误提示"><X size={13}/></button></div>}
        {isPtyCli && <><div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-3 sm:px-5">{([['timeline', MessageSquare, '执行记录'], ['terminal', Terminal, '终端']] as const).map(([tab, Icon, label]) => <button key={tab} type="button" onClick={() => setDetailTab(tab)} className={`-mb-px flex h-9 items-center gap-1.5 border-b-2 px-2 text-[11px] font-semibold transition ${detailTab === tab ? 'border-teal-600 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'}`}><Icon size={12}/>{label}</button>)}</div>{active.permissionMode === 'ask' && <div className="flex shrink-0 items-center border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800 sm:px-5"><span className="min-w-0 flex-1">此 CLI 的操作确认在终端中完成；若运行等待响应，请前往终端处理。</span><button type="button" onClick={() => setDetailTab('terminal')} className="ml-3 shrink-0 rounded-md border border-amber-300 bg-white px-2 py-1 font-semibold hover:bg-amber-100">打开终端</button></div>}</>}
        <div className="flex min-h-0 flex-1"><section className="flex min-w-0 flex-1 flex-col">{detailTab === 'terminal' && isPtyCli ? <div className="min-h-0 flex-1 bg-slate-950 p-2"><Suspense fallback={<div className="grid h-full place-items-center text-xs text-slate-400">终端加载中…</div>}><TerminalView sessionId={active.id} className="h-full"/></Suspense></div> : <Suspense fallback={<div className="grid min-h-0 flex-1 place-items-center text-xs text-slate-400">正在加载执行记录…</div>}><TimelineView activeSessionId={activeSessionId} eventsLoading={events.isLoading} loadingEarlier={loadEarlier.isPending} hasEarlier={Boolean(events.data?.hasEarlier)} onLoadEarlier={() => loadEarlier.mutateAsync()} onResolvePermission={(permissionId, approved) => resolvePermission.mutate({ sessionId: active.id, permissionId, approved })} resolvingPermissionId={resolvePermission.isPending ? resolvePermission.variables?.permissionId : undefined} timeline={timeline} timelineSections={timelineSections} awaitingAnswer={awaitingAnswer} hasOngoingActivity={hasOngoingActivity} latestUserIndex={latestUserIndex} activeOutputLabel={activeOutputLabel}/></Suspense>} {active.archivedAt ? <div className="border-t border-slate-200 bg-white px-4 py-3 text-center text-xs text-slate-500">该任务运行已归档，只能查看历史记录。</div> : <Composer state={active.state} value={prompt} references={composerReferences} sending={send.isPending} mode={sendMode} queuedTasks={queuedTasks} cancellingTaskId={cancelQueued.variables?.taskId} steeringTaskId={steerQueued.variables?.taskId} skills={skills.data ?? []} models={activeModels.data?.models ?? []} reasoningEfforts={activeModels.data?.reasoningEfforts ?? []} currentModel={active.model ?? activeModels.data?.defaultModel} currentReasoningEffort={active.reasoningEffort ?? activeModels.data?.defaultReasoningEffort} context={contextStatsFromEvents(eventList)} advertisedCommands={commandsFromEvents(eventList)} filePicker={Boolean(systemCapabilities.data?.filePicker)} modelReadiness={modelReadiness} switchingModel={switchModel.isPending || busyStates.has(active.state)} switchingReasoningEffort={switchReasoningEffort.isPending || busyStates.has(active.state)} refreshingModels={activeModels.isFetching || refreshModels.isPending} onChange={setPrompt} onReferencesChange={setComposerReferences} onModeChange={setSendMode} onSubmit={submit} onInterrupt={() => void act('interrupt')} onCancelQueued={taskId => cancelQueued.mutate({ sessionId: active.id, taskId })} onSteerQueued={taskId => steerQueued.mutate({ sessionId: active.id, taskId })} onPickFile={async () => (await pickComposerFile.mutateAsync()).path} onModelChange={nextModel => switchModel.mutate({ sessionId: active.id, nextModel })} onReasoningEffortChange={nextReasoningEffort => switchReasoningEffort.mutate({ sessionId: active.id, nextReasoningEffort })} onRefreshModels={() => refreshModels.mutate({ agentId: active.agentId, currentModel: active.model })}/>}</section>
          {rawVisible && <aside className="ui-side-panel fixed inset-y-0 right-0 z-20 flex w-full max-w-[440px] shrink-0 flex-col border-l border-slate-800 bg-slate-950 text-slate-300 shadow-[-18px_0_55px_rgba(15,23,42,.24)] lg:static lg:z-auto lg:w-[420px] lg:shadow-none"><div className="flex h-11 items-center border-b border-slate-800 px-3 text-xs font-medium"><Terminal size={13} className="mr-2 text-teal-300"/>原始运行日志<span className="ml-auto"><IconButton label="关闭原始日志" onClick={toggleRaw}><PanelRightClose size={14}/></IconButton></span></div><pre className="m-0 flex-1 overflow-auto whitespace-pre-wrap border-0 bg-slate-950 p-4 font-mono text-[11px] leading-5 text-slate-400">{raw || '当前运行暂无原始输出。'}</pre></aside>}
        </div>
      </> : <><div className="absolute left-3 top-3 z-10 md:hidden"><IconButton label="打开工作台导航" onClick={openMobileNavigation}><Menu size={17}/></IconButton></div><WorkspaceOverview sessions={sortedSessions} summaries={runSummaries} agents={agents.data ?? []} loading={sessions.isLoading} larkBots={larkConfig.data?.bots.length ?? 0} view={workbenchView} onViewChange={setWorkbenchView} onSelect={selectSession} onCreate={() => setNewOpen(true)} onOpenLark={() => setLarkOpen(true)}/></>}
    </main>
    <NewSessionModal open={newOpen} onClose={() => setNewOpen(false)} onCreated={(session, task) => { setRunSummaries(current => ({ ...current, [session.id]: { sessionId: session.id, taskId: task.id, prompt: task.prompt, status: task.status, queuedCount: task.status === 'queued' ? 1 : 0, updatedAt: task.updatedAt || task.createdAt } })); void qc.invalidateQueries({ queryKey: ['sessions'] }); selectSession(session.id); setNewOpen(false); setActionError(undefined); }} agents={agents.data ?? []} capabilities={systemCapabilities.data}/>
    {larkOpen && <Suspense fallback={<div className="fixed inset-0 z-20 grid place-items-center bg-slate-950/30 text-sm text-white backdrop-blur-sm">正在打开飞书指挥台…</div>}><LarkConfigModal agents={agents.data ?? []} onClose={() => setLarkOpen(false)}/></Suspense>}
    <ConfirmDialog open={archiveConfirm} tone="danger" title="归档此任务运行？" description="归档后运行将变为只读且无法恢复，历史指令和执行记录会继续保留。" confirmLabel="确认归档" busy={archive.isPending} error={archive.error?.message} onCancel={() => { if (!archive.isPending) setArchiveConfirm(false); }} onConfirm={() => { if (active) archive.mutate(active.id); }}/>
    <SystemPromptModal open={systemPromptOpen} session={active} onClose={() => setSystemPromptOpen(false)}/>
  </div>;
}
