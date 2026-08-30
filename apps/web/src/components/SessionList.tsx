import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Archive, CheckCircle2, CircleDot, FolderKanban, LayoutDashboard, ListEnd, MessageSquare, Plus, Radio, Settings2 } from 'lucide-react';
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
  onOpenLark(): void;
};

const navigation: Array<{ id: WorkbenchView; label: string; Icon: typeof LayoutDashboard }> = [
  { id: 'all', label: '全部运行', Icon: LayoutDashboard },
  { id: 'active', label: '正在推进', Icon: Radio },
  { id: 'queued', label: '排队等待', Icon: ListEnd },
  { id: 'attention', label: '等待处理', Icon: CircleDot },
  { id: 'failed', label: '需要恢复', Icon: AlertTriangle },
  { id: 'completed', label: '已经完成', Icon: CheckCircle2 },
  { id: 'archived', label: '已经归档', Icon: Archive }
];

export function SessionList({ open, onClose, sessions, summaries, sessionsLoading, agents, larkBots, activeSessionId, view, onViewChange, onSelect, onNewSession, onOpenLark }: SessionListProps) {
  const counts = useMemo(() => workbenchCounts(sessions, summaries), [sessions, summaries]);
  const workspaces = useMemo(() => groupSessionsByWorkspace(sessions, view, summaries), [sessions, summaries, view]);
  const [desktop, setDesktop] = useState(() => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => { if (typeof window.matchMedia !== 'function') return; const media = window.matchMedia('(min-width: 768px)'); const update = () => setDesktop(media.matches); update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  const selectView = (next: WorkbenchView) => { onViewChange(next); onSelect(undefined); onClose(); };
  const hiddenOnMobile = !desktop && !open;
  return <aside aria-label="Dockmux 工作台导航" aria-hidden={hiddenOnMobile || undefined} inert={hiddenOnMobile || undefined} className={`fixed inset-y-0 left-0 z-20 flex w-[304px] shrink-0 flex-col overflow-hidden border-r border-slate-800 bg-[var(--ink)] text-slate-200 shadow-[16px_0_48px_rgba(15,23,42,.22)] transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)] md:static md:w-[292px] md:translate-x-0 md:shadow-none ${open ? 'translate-x-0' : '-translate-x-full'}`}>
    <div className="flex h-16 min-w-[292px] items-center gap-2.5 px-4"><DockmuxIcon className="h-8 w-8 shrink-0"/><span><strong className="block text-[14px] font-semibold tracking-[-.025em] text-white">Dockmux</strong><span className="block text-[9px] uppercase tracking-[.16em] text-slate-500">Agent workbench</span></span></div>
    <div className="min-w-[292px] px-3"><button onClick={onNewSession} className="flex h-10 w-full items-center gap-2 rounded-xl bg-teal-300 px-3 text-[12px] font-semibold text-slate-950 shadow-[0_6px_20px_rgba(94,234,212,.1)] transition hover:bg-teal-200 active:scale-[.99]"><Plus size={15}/>创建任务<span className="ml-auto rounded-md border border-slate-900/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[.1em]">New</span></button></div>

    <nav aria-label="任务视图" className="mt-5 min-w-[292px] px-2.5"><div className="px-2 pb-2 text-[9px] font-semibold uppercase tracking-[.16em] text-slate-500">任务视图</div>{navigation.map(({ id, label, Icon }) => <button key={id} type="button" aria-current={view === id ? 'page' : undefined} onClick={() => selectView(id)} className={`mb-0.5 flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[11px] font-medium transition ${view === id && !activeSessionId ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/[.06] hover:text-slate-100'}`}><Icon size={13}/><span>{label}</span><span className={`ml-auto font-mono text-[9px] tabular-nums ${id === 'failed' && counts[id] ? 'text-rose-300' : id === 'attention' && counts[id] ? 'text-amber-300' : 'text-slate-500'}`}>{counts[id]}</span></button>)}</nav>

    <div className="mt-5 flex min-h-0 min-w-[292px] flex-1 flex-col"><div className="flex items-center px-4 pb-2 text-[9px] font-semibold uppercase tracking-[.16em] text-slate-500"><FolderKanban size={11} className="mr-2"/>工作区<span className="ml-auto font-mono">{workspaces.length}</span></div><div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">{sessionsLoading ? <div className="space-y-2 px-1"><div className="h-20 animate-pulse rounded-xl bg-white/[.06]"/><div className="h-20 animate-pulse rounded-xl bg-white/[.04]"/></div> : workspaces.length ? workspaces.map(workspace => <section key={workspace.id} className="mb-3"><div className="flex min-w-0 items-center px-2 pb-1.5"><span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-slate-300" title={workspace.cwd}>{workspace.name}</span><span className="ml-2 font-mono text-[8px] text-slate-600">{workspace.sessions.length}</span></div>{workspace.sessions.map(session => <SessionRow key={session.id} session={session} summary={summaries[session.id]} agent={agents.find(item => item.id === session.agentId)} botName={larkBots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} active={activeSessionId === session.id} onClick={() => { onSelect(session.id); onClose(); }}/>)}</section>) : <div className="rounded-xl border border-dashed border-slate-700 px-4 py-6 text-center text-[11px] leading-5 text-slate-500">当前视图没有任务运行。</div>}</div></div>

    <div className="min-w-[292px] border-t border-slate-800 px-2.5 py-2"><button type="button" onClick={onOpenLark} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[11px] font-medium text-slate-400 transition hover:bg-white/[.05] hover:text-slate-100"><MessageSquare size={13} className="text-[#6b8cff]"/><span>飞书指挥台</span>{larkBots.length > 0 && <span className="ml-auto flex items-center gap-1 font-mono text-[9px] text-teal-300"><span className="h-1.5 w-1.5 rounded-full bg-teal-400"/>{larkBots.length}</span>}<Settings2 size={11} className={larkBots.length > 0 ? '' : 'ml-auto'}/></button></div>
    <div className="min-w-[292px] border-t border-slate-800/70 px-4 py-2.5 text-[8px] uppercase tracking-[.12em] text-slate-600">Local runtime · ACPX 0.13</div>
  </aside>;
}
