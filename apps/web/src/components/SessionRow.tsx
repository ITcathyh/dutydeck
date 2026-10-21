import type { Agent, RunSummary, Session } from '../api';
import { fallbackRunTitle, sessionDisplayName } from '../run-summary';
import { sidebarStatusVisual } from './ui';

export type SessionRowProps = { session: Session; summary?: RunSummary; agent?: Agent; botName?: string; active: boolean; onClick(): void };

export function SessionRow({ session, summary, agent, botName, active, onClick }: SessionRowProps) {
  // 状态和身份都保留在可访问树中，导航只显示任务名与静态状态点。
  const status = sidebarStatusVisual(session);
  const title = sessionDisplayName(session, summary?.prompt, fallbackRunTitle(session.source));
  const identity = session.archivedAt
    ? `${agent?.name ?? session.agentId} · 只读`
    : `${agent?.name ?? session.agentId}${session.source === 'lark' ? ` · ${botName ?? '飞书'}` : ''}`;
  return <button
    onClick={onClick}
    aria-current={active ? 'true' : undefined}
    title={`${title}｜${status.label}｜${identity}`}
    className={`ui-session-row group relative mb-0.5 flex min-h-10 w-full items-center gap-2 rounded-md border px-2.5 text-left transition-[background-color,border-color,box-shadow,transform] duration-fast active:scale-[.99] ${active ? 'border-sidebar-border bg-surface shadow-card' : 'border-transparent hover:border-sidebar-border hover:bg-sidebar-hover'}`}
  >
    <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.pulse ? 'ui-status-pulse' : ''} ${status.dotClass}`}/>
    <span className={`min-w-0 flex-1 truncate text-caption ${active ? 'font-medium text-sidebar-text-strong' : 'text-sidebar-text'}`}>{title}</span>
    <span className={`sr-only ${status.textClass}`}>{status.label}</span>
    <span className="sr-only">{identity}</span>
  </button>;
}
