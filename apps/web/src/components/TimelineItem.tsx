import { AlertTriangle, CircleX } from 'lucide-react';
import type { TimelineEvent } from '../timeline';
import { MarkdownContent } from '../MarkdownContent';
import { ToolCard } from './ToolCard';
import { PermissionCard } from './PermissionCard';

export function TimelineItem({ event, final = false, assistantLabel = 'Agent', onResolvePermission, resolvingPermissionId }: { event: TimelineEvent; final?: boolean; assistantLabel?: string; onResolvePermission?(permissionId: string, approved: boolean): void; resolvingPermissionId?: string }) {
  if (event.type === 'tool_call' || event.type === 'tool_result') return <ToolCard event={event}/>;
  if (event.type === 'permission_request') return <PermissionCard event={event} onResolve={onResolvePermission} resolving={resolvingPermissionId === String(event.data.id ?? event.id)}/>;
  if (event.type === 'warning') return <aside role="status" className="ui-timeline-item my-4 overflow-hidden rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-soft)] shadow-[var(--shadow-card)]">
    <div className="flex items-start gap-3 px-4 py-3"><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--status-warning-border)] text-[var(--status-warning)]"><AlertTriangle size={14}/></span><div className="min-w-0"><div className="text-[13px] font-semibold text-[var(--status-warning)]">{event.data.warningKind === 'skill' ? 'Skill 提示' : 'Agent 警告'}</div><div className="mt-1 text-[13px] leading-5 text-[var(--status-warning)]"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></div></div></div>
  </aside>;
  if (event.type === 'error') return <aside role="alert" className="ui-timeline-item my-4 overflow-hidden rounded-xl border border-[var(--status-danger-border)] bg-[var(--status-danger-soft)] shadow-[var(--shadow-card)]">
    <div className="flex items-start gap-3 px-4 py-3"><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--status-danger-border)] text-[var(--status-danger)]"><CircleX size={14}/></span><div className="min-w-0"><div className="text-[13px] font-semibold text-[var(--status-danger)]">Agent 错误</div><div className="mt-1 text-[13px] leading-5 text-[var(--status-danger)]"><MarkdownContent>{event.data.message ?? 'Agent 运行失败'}</MarkdownContent></div></div></div>
  </aside>;
  if (event.type === 'thinking') return null;
  const user = event.data.role === 'user';
  if (user) return <div className="ui-timeline-item my-6 flex justify-end"><div className="max-w-[84%] rounded-2xl rounded-br-md bg-[var(--surface-inverse)] px-4 py-3 text-[14px] leading-6 text-[var(--text-inverse)] shadow-[var(--shadow-card)] sm:max-w-[78%]"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></div></div>;
  if (final) return <article aria-label={`${assistantLabel} 最终输出`} className="assistant-output markdown ui-timeline-item my-4 max-w-[78ch] text-[14px] leading-6 text-[var(--text-primary)]"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
  return <article className="assistant-output markdown ui-timeline-item my-5 max-w-[78ch] text-[14px] leading-6 text-[var(--text-primary)]"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
}
