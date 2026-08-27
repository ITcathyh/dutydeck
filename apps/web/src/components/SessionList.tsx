import { useMemo, useState } from 'react';
import { Archive, Bot, Plus, Settings2 } from 'lucide-react';
import type { Agent, LarkBotConfig, Session } from '../api';
import { DockmuxIcon } from './ui';
import { SessionRow } from './SessionRow';

export type SessionListProps = {
  open: boolean;
  onClose(): void;
  sessions: Session[];
  sessionsLoading: boolean;
  archivedSessions: Session[];
  agents: Agent[];
  larkBots: LarkBotConfig[];
  activeSessionId?: string;
  onSelect(id: string): void;
  onNewSession(): void;
  onOpenLark(): void;
};

export function SessionList({ open, onClose, sessions, sessionsLoading, archivedSessions, agents, larkBots, activeSessionId, onSelect, onNewSession, onOpenLark }: SessionListProps) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [sessionFilter, setSessionFilter] = useState('all');
  const visibleSessions = useMemo(() => sessions.filter(session => !session.archivedAt && (sessionFilter === 'all' || sessionFilter === 'local' ? sessionFilter === 'all' || session.source !== 'lark' : session.source === 'lark' && session.sourceId?.startsWith(`${sessionFilter}:`))), [sessions, sessionFilter]);
  return <aside className={`fixed inset-y-0 left-0 z-20 flex w-[286px] shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-[#f1f3f5] shadow-[12px_0_36px_rgba(24,24,27,.08)] transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)] md:static md:w-[268px] md:translate-x-0 md:shadow-none ${open ? 'translate-x-0' : '-translate-x-full'}`}>
    <div className="flex h-14 min-w-[268px] items-center gap-2.5 px-4"><DockmuxIcon className="h-7 w-7 shrink-0"/><span className="text-sm font-semibold tracking-[-.02em]">Dockmux</span></div>
    <div className="min-w-[268px] px-2.5"><button onClick={onNewSession} className="flex h-9 w-full items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-[13px] font-medium shadow-[0_1px_2px_rgba(24,24,27,.06)] hover:bg-zinc-50 active:scale-[.99]"><Plus size={15}/>新建 Session</button></div>
    <div className="mt-5 min-w-[268px] px-4 text-[10px] font-semibold uppercase tracking-[.12em] text-zinc-500">会话列表</div>
    <div className="mt-2 flex min-w-[268px] gap-1 overflow-x-auto px-2 pb-1">{larkBots.map(bot => <button key={bot.appId} type="button" onClick={() => setSessionFilter(bot.appId)} className={`flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-medium ${sessionFilter === bot.appId ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:bg-white/60'}`}><Bot size={11}/>{bot.tabLabel}</button>)}<button type="button" onClick={() => setSessionFilter('local')} className={`h-7 shrink-0 rounded-lg px-2 text-[10px] font-medium ${sessionFilter === 'local' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:bg-white/60'}`}>本地</button><button type="button" onClick={() => setSessionFilter('all')} className={`h-7 shrink-0 rounded-lg px-2 text-[10px] font-medium ${sessionFilter === 'all' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:bg-white/60'}`}>全部</button></div>
    <div className="mt-1 min-w-[268px] flex-1 overflow-y-auto px-2">{sessionsLoading ? <div className="space-y-2 px-2"><div className="h-14 animate-pulse rounded-xl bg-zinc-200/70"/><div className="h-14 animate-pulse rounded-xl bg-zinc-200/50"/></div> : visibleSessions.length ? visibleSessions.map(session => <SessionRow key={session.id} session={session} agent={agents.find(item => item.id === session.agentId)} botName={larkBots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} active={activeSessionId === session.id} onClick={() => { onSelect(session.id); onClose(); }}/>) : <div className="px-3 py-6 text-xs leading-5 text-zinc-500">当前分类暂无会话。</div>}{archivedOpen && archivedSessions.length > 0 && <div className="mt-3 border-t border-zinc-200 pt-2"><div className="px-3 py-1 text-[10px] font-medium text-zinc-400">已归档，只读</div>{archivedSessions.map(session => <SessionRow key={session.id} session={session} agent={agents.find(item => item.id === session.agentId)} botName={larkBots.find(bot => session.sourceId?.startsWith(`${bot.appId}:`))?.name} active={activeSessionId === session.id} onClick={() => { onSelect(session.id); onClose(); }}/>)}</div>}</div>
    <div className="min-w-[268px] px-2 pb-1"><button type="button" onClick={() => setArchivedOpen(value => !value)} className={`flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[12px] font-medium transition-colors ${archivedOpen ? 'bg-white/75 text-zinc-900' : 'text-zinc-600 hover:bg-white/75 hover:text-zinc-900'}`}><Archive size={14}/><span>归档会话</span><span className="ml-auto text-[10px] tabular-nums text-zinc-400">{archivedSessions.length}</span></button></div>
    <div className="min-w-[268px] px-2 pb-2"><button type="button" onClick={onOpenLark} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[12px] font-medium text-zinc-600 transition-[background-color,color,transform] duration-200 hover:bg-white/75 hover:text-zinc-900 active:scale-[.99]"><Settings2 size={14}/><span>飞书设置</span></button></div>
    <div className="min-w-[268px] border-t border-zinc-200 px-4 py-3 text-[10px] text-zinc-400">ACPX 运行时 <span className="font-mono">0.13.0</span></div>
  </aside>;
}
