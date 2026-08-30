import { MessageSquare } from 'lucide-react';
import type { Agent, RunSummary, Session } from '../api';
import { fallbackRunTitle } from '../run-summary';
import { shortRunId } from '../workspace-model';
import { busyStates, stateLabels, stateTone } from './ui';

export type SessionRowProps = { session: Session; summary?: RunSummary; agent?: Agent; botName?: string; active: boolean; onClick(): void };

export function SessionRow({ session, summary, agent, botName, active, onClick }: SessionRowProps) {
  const lark = session.source === 'lark';
  return <button onClick={onClick} className={`ui-session-row group relative mb-1 w-full rounded-xl border px-2.5 py-2 text-left transition-[background-color,border-color,box-shadow,transform] duration-200 active:scale-[.99] ${active ? 'border-teal-300/25 bg-teal-300/[.09] shadow-[inset_3px_0_0_#5eead4]' : 'border-transparent hover:border-white/[.06] hover:bg-white/[.055]'}`}>
    <div className="flex items-center gap-2"><span aria-label={stateLabels[session.state]} className={`h-1.5 w-1.5 shrink-0 rounded-full ${busyStates.has(session.state) ? 'ui-status-pulse' : ''} ${stateTone[session.state] ?? 'bg-slate-500'}`}/><span className={`min-w-0 flex-1 truncate text-[11px] font-medium ${active ? 'text-white' : 'text-slate-300'}`} title={summary?.prompt}>{summary?.prompt ?? fallbackRunTitle(session.source)}</span></div>
    <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-3.5 text-[9px] text-slate-500">{lark && <MessageSquare size={9} className="shrink-0 text-[#6b8cff]"/>}<span className="truncate">{session.archivedAt ? '已归档 · 只读' : `${agent?.name ?? session.agentId} · ${lark ? botName ?? '飞书' : stateLabels[session.state] ?? session.state}`}</span><span className="ml-auto shrink-0 font-mono text-[8px] tracking-[.08em] text-slate-600">{shortRunId(session)}</span></div>
  </button>;
}
