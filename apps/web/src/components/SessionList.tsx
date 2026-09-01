import { useEffect, useMemo, useState } from 'react';
import { FolderKanban, Plus, Settings2, ShieldCheck } from 'lucide-react';
import type { Agent, LarkBotConfig, RunSummary, Session } from '../api';
import { groupSessionsByWorkspace, type WorkbenchView } from '../workspace-model';
import { createTaskAffordance, DockmuxIcon } from './ui';
import { SessionRow } from './SessionRow';

export type SessionListProps = {
  open: boolean;
  onClose(): void;
  sessions: Session[];
  summaries: Record<string, RunSummary>;
  sessionsLoading: boolean;
  agents: Agent[];
  agentsLoading?: boolean;
  larkBots: LarkBotConfig[];
  activeSessionId?: string;
  view: WorkbenchView;
  onSelect(id?: string): void;
  onNewSession(): void;
  onOpenControlCenter(): void;
  authRequired?: boolean;
};

/**
 * 工作区导航。
 *
 * 这里刻意不再渲染状态筛选：状态筛选是总览页的职责，而侧栏在桌面端恒常可见
 * （md:static），两份筛选曾经必然同屏并列。侧栏回答「按目录找任务」，
 * 总览页回答「按状态找任务」，两条正交的检索路径各留一处。
 */
export function SessionList({ open, onClose, sessions, summaries, sessionsLoading, agents, agentsLoading = false, larkBots, activeSessionId, view, onSelect, onNewSession, onOpenControlCenter, authRequired }: SessionListProps) {
  const workspaces = useMemo(() => groupSessionsByWorkspace(sessions, view, summaries), [sessions, summaries, view]);
  const [desktop, setDesktop] = useState(() => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => { if (typeof window.matchMedia !== 'function') return; const media = window.matchMedia('(min-width: 768px)'); const update = () => setDesktop(media.matches); update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  const createTask = createTaskAffordance({ agents, agentsLoading, onCreate: onNewSession, onPrepareAgents: onOpenControlCenter });
  const hiddenOnMobile = !desktop && !open;
  return <aside aria-label="Dockmux 工作台导航" aria-hidden={hiddenOnMobile || undefined} inert={hiddenOnMobile || undefined} className={`fixed inset-y-0 left-0 z-20 flex w-[304px] shrink-0 flex-col overflow-hidden border-r border-[var(--sidebar-border)] bg-[var(--sidebar-surface)] text-[var(--sidebar-text)] shadow-[var(--sidebar-shadow)] transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)] md:static md:w-[292px] md:translate-x-0 md:shadow-none ${open ? 'translate-x-0' : '-translate-x-full'}`}>
    <div className="flex h-16 min-w-[292px] items-center gap-2.5 px-4"><DockmuxIcon className="h-8 w-8 shrink-0"/><span><strong className="block text-sm font-semibold tracking-[-.025em] text-[var(--sidebar-text-strong)]">Dockmux</strong><span className="block text-xs text-[var(--sidebar-text-muted)]">Agent 任务台</span></span></div>
    <div className="min-w-[292px] px-3">
      <button type="button" disabled={createTask.disabled} onClick={createTask.onClick} className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--sidebar-accent)] px-3 text-sm font-semibold text-[var(--sidebar-accent-text)] transition hover:brightness-110 active:translate-y-px disabled:opacity-60"><Plus size={16}/>{createTask.label}</button>
    </div>

    <div className="mt-5 flex min-h-0 min-w-[292px] flex-1 flex-col"><div className="flex items-center px-4 pb-2 text-xs font-semibold text-[var(--sidebar-text-muted)]"><FolderKanban size={13} className="mr-2"/>工作区<span className="ml-auto font-mono">{workspaces.length}</span></div><div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">{sessionsLoading ? <div className="space-y-2 px-1"><div className="h-20 animate-pulse rounded-xl bg-[var(--sidebar-hover)]"/><div className="h-20 animate-pulse rounded-xl bg-[var(--sidebar-hover)]"/></div> : workspaces.length ? workspaces.map(workspace => <section key={workspace.id} className="mb-3"><div className="flex min-w-0 items-center px-2 pb-1.5"><span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--sidebar-text)]" title={workspace.cwd}>{workspace.name}</span><span className="ml-2 font-mono text-[11px] text-[var(--sidebar-text-muted)]">{workspace.sessions.length}</span></div>{workspace.sessions.map(session => <SessionRow key={session.id} session={session} summary={summaries[session.id]} agent={agents.find(item => item.id === session.agentId)} botName={larkBots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} active={activeSessionId === session.id} onClick={() => { onSelect(session.id); onClose(); }}/>)}</section>) : <div className="rounded-xl border border-dashed border-[var(--sidebar-border)] px-4 py-6 text-center text-xs leading-5 text-[var(--sidebar-text-muted)]">当前视图没有任务。</div>}</div></div>

    <div className="min-w-[292px] border-t border-[var(--sidebar-border)] px-2.5 py-2"><button type="button" onClick={onOpenControlCenter} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-[var(--sidebar-text-muted)] transition hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-strong)]"><Settings2 size={15} className="text-[var(--sidebar-accent)]"/><span>Agent 与设置</span><span className="ml-auto font-mono text-xs text-[var(--sidebar-text-muted)]">{agents.length} Agent{larkBots.length > 0 ? ` · ${larkBots.length} Bot` : ''}</span></button></div>
    <div className="min-w-[292px] border-t border-[var(--sidebar-border)] px-4 py-2.5 text-[11px] text-[var(--sidebar-text-faint)]">{authRequired === false ? <span className="flex items-center gap-1.5 text-[var(--sidebar-accent)]"><ShieldCheck size={12}/>受信开发机模式 · 无需 token</span> : '本机运行 · ACPX 0.13'}</div>
  </aside>;
}
