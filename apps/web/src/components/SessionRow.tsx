import { MessageSquare } from 'lucide-react';
import type { Agent, RunSummary, Session } from '../api';
import { fallbackRunTitle } from '../run-summary';
import { formatRelativeTime, shortRunId } from '../workspace-model';
import { busyStates, stateLabels, stateTone } from './ui';

export type SessionRowProps = { session: Session; summary?: RunSummary; agent?: Agent; botName?: string; active: boolean; onClick(): void };

export function SessionRow({ session, summary, agent, botName, active, onClick }: SessionRowProps) {
  const lark = session.source === 'lark';
  const status = session.archivedAt ? '已归档' : stateLabels[session.state] ?? session.state;
  const queuedCount = summary?.queuedCount ?? 0;
  return <button onClick={onClick} className={`ui-session-row group relative mb-1 min-h-[52px] w-full rounded-lg border px-2.5 py-2 text-left transition-[background-color,border-color,box-shadow,transform] duration-200 active:scale-[.99] ${active ? 'border-[var(--sidebar-border)] bg-[var(--sidebar-active)] shadow-[inset_3px_0_0_var(--sidebar-accent)]' : 'border-transparent hover:border-[var(--sidebar-border)] hover:bg-[var(--sidebar-hover)]'}`}>
    <div className="flex items-center gap-2"><span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${busyStates.has(session.state) ? 'ui-status-pulse' : ''} ${stateTone[session.state] ?? 'bg-[var(--status-neutral-solid)]'}`}/><span className={`min-w-0 flex-1 truncate text-[13px] font-medium ${active ? 'text-[var(--sidebar-text-strong)]' : 'text-[var(--sidebar-text)]'}`} title={summary?.prompt}>{summary?.prompt ?? fallbackRunTitle(session.source)}</span><span className={`shrink-0 text-[11px] font-medium ${session.state === 'failed' ? 'text-[var(--status-danger)]' : session.state === 'waiting_for_permission' ? 'text-[var(--status-warning)]' : 'text-[var(--sidebar-text-muted)]'}`}>{status}</span></div>
    <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-3.5 text-xs text-[var(--sidebar-text-muted)]">{lark && <MessageSquare size={11} className="shrink-0 text-[var(--status-queued)]"/>}<span className="truncate">{session.archivedAt ? `${agent?.name ?? session.agentId} · 只读` : `${agent?.name ?? session.agentId}${lark ? ` · ${botName ?? '飞书'}` : ''}`}</span>{queuedCount > 0 && <span className="shrink-0 text-[var(--status-queued)]">待执行 {queuedCount}</span>}<span className="ml-auto shrink-0 text-[11px] text-[var(--sidebar-text-muted)]">更新于 {formatRelativeTime(session.updatedAt || session.createdAt)}</span><span className="hidden shrink-0 font-mono text-[10px] tracking-[.06em] text-[var(--sidebar-text-faint)] xl:inline">{shortRunId(session)}</span></div>
  </button>;
}
