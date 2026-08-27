import { MessageSquare } from 'lucide-react';
import type { Agent, Session } from '../api';
import { busyStates, stateLabels, stateTone } from './ui';

export type SessionRowProps = { session: Session; agent?: Agent; botName?: string; active: boolean; onClick(): void };

export function SessionRow({ session, agent, botName, active, onClick }: SessionRowProps) {
  const lark = session.source === 'lark';
  return <button onClick={onClick} className={`ui-session-row group relative mb-1 w-full rounded-xl border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow,transform] duration-200 active:scale-[.99] ${active ? 'border-zinc-200/80 bg-white shadow-[0_2px_8px_rgba(24,24,27,.055)]' : 'border-transparent hover:border-zinc-200/60 hover:bg-white/65'}`}>
    <div className="flex items-center gap-2"><span aria-label={stateLabels[session.state]} className={`h-1.5 w-1.5 shrink-0 rounded-full ${busyStates.has(session.state) ? 'ui-status-pulse' : ''} ${stateTone[session.state] ?? 'bg-zinc-400'}`}/><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-800">{agent?.name ?? session.agentId}</span>{lark ? <span className="max-w-24 shrink-0 truncate rounded-md bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium text-zinc-500">{botName ?? '飞书'}</span> : <span className="text-[10px] text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100">{stateLabels[session.state]}</span>}</div>
    <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-3.5 text-[11px] text-zinc-500">{lark && <MessageSquare size={10} className="shrink-0 text-zinc-400"/>}<span title={!session.archivedAt && !lark ? session.cwd : undefined} className="truncate">{session.archivedAt ? '已归档，只读' : lark ? '飞书对话记录' : session.cwd}</span></div>
  </button>;
}
