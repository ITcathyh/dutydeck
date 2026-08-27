import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, BookOpen, Folder, Menu, MessageSquare, PanelRightClose, Square, Terminal, X } from 'lucide-react';
import { api, type Session, type Task } from './api';
import { useDockStore } from './store';
import { buildTimeline, buildTimelineSections } from './timeline';
import { Composer, type SendMode } from './components/Composer';
import { busyStates, stateLabels, stateTone, DockmuxIcon, IconButton } from './components/ui';
import { SessionList } from './components/SessionList';
import { NewSessionModal } from './components/NewSessionModal';
import { LarkConfigModal } from './components/LarkConfigModal';
import { SystemPromptModal } from './components/SystemPromptModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { TimelineView } from './components/TimelineView';
// xterm 体积较大且仅 pty-cli 会话的终端 tab 用到，按需懒加载
const TerminalView = lazy(() => import('./components/TerminalView').then(module => ({ default: module.TerminalView })));
import { useSessionStream } from './useSessionStream';
import type { StreamStatus } from './sse';
import { buildPrompt, commandsFromEvents, contextStatsFromEvents, getModelReadiness, type ComposerReference } from './composer-utils';
import { agentModelsQueryKey, loadAgentModels, readCachedAgentModels } from './model-cache';

// SSE 实时连接状态指示：绿点=已连接，琥珀色脉冲=重连中，灰点=连接中
function ConnectionDot({ status }: { status: StreamStatus }) {
  if (status === 'open') return <span title="实时连接已建立" className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"/>;
  if (status === 'reconnecting') return <span title="实时连接中断，正在重连…" className="ui-status-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"/>;
  return <span title="正在建立实时连接…" className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300"/>;
}

type DetailTab = 'timeline' | 'terminal';

export default function App() {
  const qc = useQueryClient(); const { activeSessionId, setActive, rawVisible, toggleRaw } = useDockStore();
  const [sidebarOpen, setSidebarOpen] = useState(false); const [newOpen, setNewOpen] = useState(false); const [larkOpen, setLarkOpen] = useState(false); const [archiveConfirm, setArchiveConfirm] = useState(false); const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState(''); const [composerReferences, setComposerReferences] = useState<ComposerReference[]>([]); const [sendMode, setSendMode] = useState<SendMode>('queue'); const [actionError, setActionError] = useState<string>(); const [detailTab, setDetailTab] = useState<DetailTab>('timeline');
  const selectSession = (id: string) => { setActive(id); setPrompt(''); setComposerReferences([]); setDetailTab('timeline'); window.history.replaceState(null, '', `/sessions/${encodeURIComponent(id)}`); };
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents }); const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, refetchInterval: 2_000 }); const larkConfig = useQuery({ queryKey: ['lark-config'], queryFn: api.larkConfig, refetchInterval: 5_000 }); const systemCapabilities = useQuery({ queryKey: ['system-capabilities'], queryFn: api.systemCapabilities });
  useEffect(() => {
    if (activeSessionId) return;
    const match = window.location.pathname.match(/^\/sessions\/([^/]+)$/);
    if (match?.[1]) setActive(decodeURIComponent(match[1]));
  }, [activeSessionId, setActive]);
  const events = useQuery({ queryKey: ['events', activeSessionId], queryFn: () => api.events(activeSessionId!), enabled: !!activeSessionId });
  const tasks = useQuery({ queryKey: ['tasks', activeSessionId], queryFn: () => api.tasks(activeSessionId!), enabled: !!activeSessionId, refetchInterval: 2_000 });
  const sortedSessions = useMemo(() => [...(sessions.data ?? [])].sort((left, right) => (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt)), [sessions.data]);
  const archivedSessions = useMemo(() => sortedSessions.filter(session => session.archivedAt), [sortedSessions]);
  const active = sortedSessions.find(session => session.id === activeSessionId); const activeAgent = agents.data?.find(agent => agent.id === active?.agentId);
  const activeOutputLabel = active?.model ?? activeAgent?.name ?? active?.agentId ?? 'Agent';
  const streamStatus = useSessionStream(activeSessionId, active?.runId, events.isSuccess);
  const activeModels = useQuery({ queryKey: agentModelsQueryKey(active?.agentId, active?.model), queryFn: () => loadAgentModels(active!.agentId, active!.model), enabled: Boolean(active && !active.archivedAt), initialData: () => active ? readCachedAgentModels(active.agentId, active.model) : undefined, initialDataUpdatedAt: 0, refetchOnMount: 'always', staleTime: 60_000 });
  const skills = useQuery({ queryKey: ['skills', active?.cwd], queryFn: () => api.skills(active?.cwd), enabled: Boolean(active && !active.archivedAt), staleTime: 60_000 });
  const timeline = useMemo(() => buildTimeline(events.data, tasks.data), [events.data, tasks.data]); const timelineSections = useMemo(() => buildTimelineSections(timeline, tasks.data), [timeline, tasks.data]); const raw = useMemo(() => events.data?.filter(event => event.type === 'raw_terminal').map(event => event.raw ?? event.data.text).join('') ?? '', [events.data]);
  let latestUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index--) if (timeline[index].type === 'text' && timeline[index].data.role === 'user') { latestUserIndex = index; break; }
  const awaitingAnswer = busyStates.has(active?.state ?? '') && latestUserIndex >= 0 && !timeline.slice(latestUserIndex + 1).some(event => event.type === 'text' && event.data.role !== 'user');
  const hasOngoingActivity = timelineSections.some(section => section.kind === 'activity' && section.isLatestTurn && awaitingAnswer);
  const isPtyCli = activeAgent?.protocol === 'pty-cli';
  const send = useMutation({ mutationFn: ({ sessionId, message, mode }: { sessionId: string; message: string; mode: SendMode }) => api.send(sessionId, message, mode), onSuccess: (result, variables) => { if (variables.sessionId === activeSessionId) { setPrompt(''); setComposerReferences([]); setSendMode('queue'); } qc.setQueryData<Task[]>(['tasks', variables.sessionId], current => [...(current ?? []).filter(task => task.id !== result.task.id), result.task]); }, onError: error => setActionError(error.message) });
  const cancelQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.cancelQueued(sessionId, taskId), onSuccess: (result, variables) => qc.setQueryData<Task[]>(['tasks', variables.sessionId], current => current?.map(task => task.id === result.id ? result : task)), onError: error => setActionError(error.message) });
  const steerQueued = useMutation({ mutationFn: ({ sessionId, taskId }: { sessionId: string; taskId: string }) => api.steerQueued(sessionId, taskId), onSuccess: (_result, variables) => { setActionError(undefined); void qc.invalidateQueries({ queryKey: ['tasks', variables.sessionId] }); }, onError: error => setActionError(error.message) });
  const archive = useMutation({ mutationFn: (sessionId: string) => api.archive(sessionId), onSuccess: result => { qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); setArchiveConfirm(false); setActive(undefined); window.history.replaceState(null, '', '/'); }, onError: error => setActionError(error.message) });
  const pickComposerFile = useMutation({ mutationFn: api.selectFile, onError: error => setActionError(error.message) });
  const refreshModels = useMutation({
    mutationFn: ({ agentId: targetAgentId, currentModel }: { agentId: string; currentModel?: string }) => loadAgentModels(targetAgentId, currentModel, true),
    onSuccess: (result, variables) => { setActionError(undefined); qc.setQueryData(agentModelsQueryKey(variables.agentId, variables.currentModel), result); },
    onError: error => setActionError(error.message)
  });
  const switchModel = useMutation({ mutationFn: ({ sessionId, nextModel }: { sessionId: string; nextModel: string }) => api.setSessionModel(sessionId, nextModel), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); void activeModels.refetch(); }, onError: error => setActionError(error.message) });
  const switchReasoningEffort = useMutation({ mutationFn: ({ sessionId, nextReasoningEffort }: { sessionId: string; nextReasoningEffort: string }) => api.setSessionReasoningEffort(sessionId, nextReasoningEffort), onSuccess: result => { setActionError(undefined); qc.setQueryData<Session[]>(['sessions'], current => current?.map(session => session.id === result.id ? result : session)); }, onError: error => setActionError(error.message) });
  const modelReadiness = getModelReadiness({ loaded: activeModels.data !== undefined, loading: activeModels.data === undefined && (activeModels.isPending || activeModels.isFetching || refreshModels.isPending), switching: switchModel.isPending, failed: activeModels.data === undefined && activeModels.isError });
  const submit = () => { if (modelReadiness.kind !== 'ready') return; const message = buildPrompt(prompt, composerReferences); if (message && activeSessionId) send.mutate({ sessionId: activeSessionId, message, mode: busyStates.has(active?.state ?? '') ? sendMode : 'queue' }); };
  const act = async (action: string) => { try { setActionError(undefined); await api.action(activeSessionId!, action); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); } };

  return <div className="relative flex h-[100dvh] min-h-[100dvh] overflow-hidden bg-[#f7f8fa] font-sans text-zinc-900">
    {sidebarOpen && <button type="button" aria-label="关闭会话列表" onClick={() => setSidebarOpen(false)} className="ui-overlay fixed inset-0 z-10 bg-zinc-950/20 backdrop-blur-[1px] md:hidden"/>}
    <SessionList open={sidebarOpen} onClose={() => setSidebarOpen(false)} sessions={sortedSessions} sessionsLoading={sessions.isLoading} archivedSessions={archivedSessions} agents={agents.data ?? []} larkBots={larkConfig.data?.bots ?? []} activeSessionId={activeSessionId} onSelect={selectSession} onNewSession={() => { setActionError(undefined); setNewOpen(true); }} onOpenLark={() => setLarkOpen(true)}/>
    <main className="flex min-w-0 flex-1 flex-col">
      {active ? <><header className="flex h-14 shrink-0 items-center border-b border-zinc-200 bg-white/80 px-3 backdrop-blur sm:px-4">
        <span className="mr-1 md:hidden"><IconButton label="打开会话列表" onClick={() => setSidebarOpen(true)}><Menu size={16}/></IconButton></span>
        <div className="min-w-0"><div className="flex items-center gap-2 text-[13px] font-semibold"><span>{activeAgent?.name ?? active.agentId}</span><span className={`h-1.5 w-1.5 rounded-full ${stateTone[active.state] ?? 'bg-zinc-400'}`}/><span className="text-[11px] font-normal text-zinc-500">{stateLabels[active.state] ?? active.state}</span><ConnectionDot status={streamStatus}/></div><div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-400"><Folder size={11}/><span title={active.cwd} className="truncate">{active.cwd}</span>{active.model && <span className="shrink-0">({active.model})</span>}</div></div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">{!active.archivedAt && busyStates.has(active.state) && <IconButton label="中断当前任务" onClick={() => void act('interrupt')}><Square size={14}/></IconButton>}{active.systemPrompt && <IconButton label="查看系统提示词" onClick={() => setSystemPromptOpen(true)}><BookOpen size={14}/></IconButton>}{!active.archivedAt && <IconButton label="永久归档" disabled={archive.isPending} onClick={() => { archive.reset(); setArchiveConfirm(true); }}><Archive size={15}/></IconButton>}<button type="button" disabled={!raw} onClick={toggleRaw} aria-label="原始日志" className={`ml-1 flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 sm:ml-2 sm:px-2.5 ${rawVisible ? 'border-zinc-800 bg-zinc-900 text-white' : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50'}`}><Terminal size={13}/><span className="hidden sm:inline">原始日志</span></button></div>
      </header>
      {actionError && <div className="flex items-center border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700"><span>{actionError}</span><button className="ml-auto" onClick={() => setActionError(undefined)} aria-label="关闭错误提示"><X size={13}/></button></div>}
      {isPtyCli && <div className="flex shrink-0 items-center gap-1 border-b border-zinc-200 bg-white/80 px-3 sm:px-4">
        {([['timeline', MessageSquare, '时间线'], ['terminal', Terminal, '终端']] as const).map(([tab, Icon, label]) => <button key={tab} type="button" onClick={() => setDetailTab(tab)} className={`-mb-px flex h-9 items-center gap-1.5 border-b-2 px-2 text-[12px] font-medium transition-colors ${detailTab === tab ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-zinc-500 hover:text-zinc-800'}`}><Icon size={12}/>{label}</button>)}
      </div>}
      <div className="flex min-h-0 flex-1"><section className="flex min-w-0 flex-1 flex-col">
        {detailTab === 'terminal' && isPtyCli ? <div className="min-h-0 flex-1 bg-white p-2"><Suspense fallback={<div className="grid h-full place-items-center text-xs text-zinc-400">终端加载中…</div>}><TerminalView sessionId={active.id} className="h-full"/></Suspense></div> : <TimelineView activeSessionId={activeSessionId} eventsLoading={events.isLoading} timeline={timeline} timelineSections={timelineSections} awaitingAnswer={awaitingAnswer} hasOngoingActivity={hasOngoingActivity} latestUserIndex={latestUserIndex} activeOutputLabel={activeOutputLabel}/>}
        {active.archivedAt ? <div className="border-t border-zinc-200 bg-white/75 px-4 py-3 text-center text-xs text-zinc-500">该会话已永久归档，仅支持查看。</div> : <Composer state={active.state} value={prompt} references={composerReferences} sending={send.isPending} mode={sendMode} queuedTasks={tasks.data?.filter(task => task.status === 'queued') ?? []} cancellingTaskId={cancelQueued.variables?.taskId} steeringTaskId={steerQueued.variables?.taskId} skills={skills.data ?? []} models={activeModels.data?.models ?? []} reasoningEfforts={activeModels.data?.reasoningEfforts ?? []} currentModel={active.model ?? activeModels.data?.defaultModel} currentReasoningEffort={active.reasoningEffort ?? activeModels.data?.defaultReasoningEffort} context={contextStatsFromEvents(events.data)} advertisedCommands={commandsFromEvents(events.data)} filePicker={Boolean(systemCapabilities.data?.filePicker)} modelReadiness={modelReadiness} switchingModel={switchModel.isPending || busyStates.has(active.state)} switchingReasoningEffort={switchReasoningEffort.isPending || busyStates.has(active.state)} refreshingModels={activeModels.isFetching || refreshModels.isPending} onChange={setPrompt} onReferencesChange={setComposerReferences} onModeChange={setSendMode} onSubmit={submit} onInterrupt={() => void act('interrupt')} onCancelQueued={taskId => cancelQueued.mutate({ sessionId: active.id, taskId })} onSteerQueued={taskId => steerQueued.mutate({ sessionId: active.id, taskId })} onPickFile={async () => (await pickComposerFile.mutateAsync()).path} onModelChange={nextModel => switchModel.mutate({ sessionId: active.id, nextModel })} onReasoningEffortChange={nextReasoningEffort => switchReasoningEffort.mutate({ sessionId: active.id, nextReasoningEffort })} onRefreshModels={() => refreshModels.mutate({ agentId: active.agentId, currentModel: active.model })}/>}
      </section>
        {rawVisible && <aside className="ui-side-panel fixed inset-y-0 right-0 z-20 flex w-full max-w-[420px] shrink-0 flex-col border-l border-zinc-200 bg-white text-zinc-700 shadow-[-16px_0_48px_rgba(24,24,27,.12)] lg:static lg:z-auto lg:w-[420px] lg:shadow-none"><div className="flex h-11 items-center border-b border-zinc-200 px-3 text-xs font-medium"><Terminal size={13} className="mr-2"/>原始终端输出<span className="ml-auto"><IconButton label="关闭原始终端" onClick={toggleRaw}><PanelRightClose size={14}/></IconButton></span></div><pre className="m-0 flex-1 overflow-auto whitespace-pre-wrap border-0 bg-zinc-50/60 p-4 font-mono text-[11px] leading-5 text-zinc-600">{raw || '当前 Session 暂无原始输出。'}</pre></aside>}
      </div></> : <div className="relative grid flex-1 place-items-center p-8"><span className="absolute left-3 top-3 md:hidden"><IconButton label="打开会话列表" onClick={() => setSidebarOpen(true)}><Menu size={17}/></IconButton></span><div className="ui-empty-state max-w-md text-center"><DockmuxIcon className="mx-auto h-12 w-12"/><h1 className="mt-5 text-xl font-semibold tracking-[-.03em]">选择 Agent，开始工作</h1><p className="mt-2 text-sm leading-6 text-zinc-500">在同一个工作台中运行 Codex、Claude、Cursor、Pi、TraeX 或自定义 ACP Agent。</p><button onClick={() => setNewOpen(true)} className="mt-5 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-[background-color,transform,box-shadow] duration-200 hover:bg-zinc-700 hover:shadow-[0_6px_18px_rgba(24,24,27,.14)] active:scale-[.98]">新建 Session</button></div></div>}
    </main>
    <NewSessionModal open={newOpen} onClose={() => setNewOpen(false)} onCreated={session => { void qc.invalidateQueries({ queryKey: ['sessions'] }); selectSession(session.id); setNewOpen(false); setActionError(undefined); }} agents={agents.data ?? []} capabilities={systemCapabilities.data}/>
    {larkOpen && <LarkConfigModal agents={agents.data ?? []} onClose={() => setLarkOpen(false)}/>}
    <ConfirmDialog open={archiveConfirm} tone="danger" title="归档此会话？" description="归档后会话将变为只读且无法恢复。历史消息和执行记录会保留在归档列表中。" confirmLabel="确认归档" busy={archive.isPending} error={archive.error?.message} onCancel={() => { if (!archive.isPending) setArchiveConfirm(false); }} onConfirm={() => { if (active) archive.mutate(active.id); }}/>
    <SystemPromptModal open={systemPromptOpen} session={active} onClose={() => setSystemPromptOpen(false)}/>
  </div>;
}
