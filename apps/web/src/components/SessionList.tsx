import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Archive, Bot, CheckCircle2, CircleDot, FolderKanban, LayoutDashboard, ListEnd, Plus, Radio, Settings2, ShieldCheck } from 'lucide-react';
import type { Agent, LarkBotConfig, RunSummary, Session } from '../api';
import { groupSessionsByWorkspace, type WorkbenchView, workbenchCounts } from '../workspace-model';
import { DockmuxIcon } from './ui';
import { SessionRow } from './SessionRow';

export type SessionListProps = {
  open: boolean;
  onClose(): void;
  sessions: Session[];
  summaries: Record<string, RunSummary>;
  sessionsLoading: boolean;
  agents: Agent[];
  larkBots: LarkBotConfig[];
  activeSessionId?: string;
  view: WorkbenchView;
  onViewChange(view: WorkbenchView): void;
  onSelect(id?: string): void;
  onNewSession(): void;
  onOpenLarkSetup(): void;
  onOpenControlCenter(): void;
  authRequired?: boolean;
};

const navigation: Array<{ id: WorkbenchView; label: string; Icon: typeof LayoutDashboard }> = [
  { id: 'all', label: '总览', Icon: LayoutDashboard },
  { id: 'attention', label: '待你处理', Icon: CircleDot },
  { id: 'active', label: '进行中', Icon: Radio },
  { id: 'queued', label: '有排队的运行', Icon: ListEnd },
  { id: 'failed', label: '失败', Icon: AlertTriangle },
  { id: 'completed', label: '已完成', Icon: CheckCircle2 },
  { id: 'archived', label: '已归档', Icon: Archive }
];

export function SessionList({ open, onClose, sessions, summaries, sessionsLoading, agents, larkBots, activeSessionId, view, onViewChange, onSelect, onNewSession, onOpenLarkSetup, onOpenControlCenter, authRequired }: SessionListProps) {
  const counts = useMemo(() => workbenchCounts(sessions, summaries), [sessions, summaries]);
  const workspaces = useMemo(() => groupSessionsByWorkspace(sessions, view, summaries), [sessions, summaries, view]);
  const [desktop, setDesktop] = useState(() => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => { if (typeof window.matchMedia !== 'function') return; const media = window.matchMedia('(min-width: 768px)'); const update = () => setDesktop(media.matches); update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  const selectView = (next: WorkbenchView) => { onViewChange(next); onSelect(undefined); onClose(); };
  const hiddenOnMobile = !desktop && !open;
  return <aside aria-label="Dockmux 工作台导航" aria-hidden={hiddenOnMobile || undefined} inert={hiddenOnMobile || undefined} className={`fixed inset-y-0 left-0 z-20 flex w-[304px] shrink-0 flex-col overflow-hidden border-r border-slate-800 bg-[var(--surface-inverse)] text-slate-200 shadow-[12px_0_32px_rgba(15,23,42,.16)] transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)] md:static md:w-[292px] md:translate-x-0 md:shadow-none ${open ? 'translate-x-0' : '-translate-x-full'}`}>
    <div className="flex h-16 min-w-[292px] items-center gap-2.5 px-4"><DockmuxIcon className="h-8 w-8 shrink-0"/><span><strong className="block text-sm font-semibold tracking-[-.025em] text-white">Dockmux</strong><span className="block text-xs text-slate-400">Agent 任务台</span></span></div>
    <div className="grid min-w-[292px] grid-cols-2 gap-2 px-3">
      <button onClick={agents.length ? onNewSession : onOpenControlCenter} className="flex min-h-10 items-center justify-center gap-2 rounded-lg bg-teal-300 px-3 text-sm font-semibold text-slate-950 transition hover:bg-teal-200 active:translate-y-px"><Plus size={16}/>{agents.length ? '创建任务' : '准备 Agent'}</button>
      <button onClick={onOpenLarkSetup} className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm font-semibold text-slate-100 transition hover:border-slate-500 hover:bg-slate-700 active:translate-y-px"><Bot size={16}/>绑定 Bot</button>
    </div>

    <nav aria-label="任务视图" className="mt-5 min-w-[292px] px-2.5"><div className="px-2 pb-2 text-xs font-semibold text-slate-500">任务视图</div>{navigation.map(({ id, label, Icon }) => <button key={id} type="button" aria-current={view === id ? 'page' : undefined} onClick={() => selectView(id)} className={`mb-0.5 flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition ${view === id && !activeSessionId ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/[.06] hover:text-slate-100'}`}><Icon size={15}/><span>{label}</span><span className={`ml-auto font-mono text-xs tabular-nums ${id === 'failed' && counts[id] ? 'text-rose-300' : id === 'attention' && counts[id] ? 'text-amber-300' : 'text-slate-500'}`}>{counts[id]}</span></button>)}{counts.queuedCommands > 0 && <p className="mx-2 mt-1 text-xs leading-5 text-slate-500">{counts.queued} 个运行有排队，共 {counts.queuedCommands} 条待执行指令</p>}</nav>

    <div className="mt-5 flex min-h-0 min-w-[292px] flex-1 flex-col"><div className="flex items-center px-4 pb-2 text-xs font-semibold text-slate-500"><FolderKanban size={13} className="mr-2"/>工作区<span className="ml-auto font-mono">{workspaces.length}</span></div><div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">{sessionsLoading ? <div className="space-y-2 px-1"><div className="h-20 animate-pulse rounded-xl bg-white/[.06]"/><div className="h-20 animate-pulse rounded-xl bg-white/[.04]"/></div> : workspaces.length ? workspaces.map(workspace => <section key={workspace.id} className="mb-3"><div className="flex min-w-0 items-center px-2 pb-1.5"><span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-300" title={workspace.cwd}>{workspace.name}</span><span className="ml-2 font-mono text-[11px] text-slate-500">{workspace.sessions.length}</span></div>{workspace.sessions.map(session => <SessionRow key={session.id} session={session} summary={summaries[session.id]} agent={agents.find(item => item.id === session.agentId)} botName={larkBots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} active={activeSessionId === session.id} onClick={() => { onSelect(session.id); onClose(); }}/>)}</section>) : <div className="rounded-xl border border-dashed border-slate-700 px-4 py-6 text-center text-xs leading-5 text-slate-500">当前视图没有任务运行。</div>}</div></div>

    <div className="min-w-[292px] border-t border-slate-800 px-2.5 py-2"><button type="button" onClick={onOpenControlCenter} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-slate-400 transition hover:bg-white/[.05] hover:text-slate-100"><Settings2 size={15} className="text-teal-300"/><span>Agent 与设置</span><span className="ml-auto font-mono text-xs text-slate-500">{agents.length} Agent{larkBots.length > 0 ? ` · ${larkBots.length} Bot` : ''}</span></button></div>
    <div className="min-w-[292px] border-t border-slate-800/70 px-4 py-2.5 text-[11px] text-slate-600">{authRequired === false ? <span className="flex items-center gap-1.5 text-teal-400"><ShieldCheck size={12}/>受信开发机模式 · 无需 token</span> : '本机运行 · ACPX 0.13'}</div>
  </aside>;
}
