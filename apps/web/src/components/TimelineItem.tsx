import { AlertTriangle, CircleX } from 'lucide-react';
import type { TimelineEvent } from '../timeline';
import { MarkdownContent } from '../MarkdownContent';
import { ToolCard } from './ToolCard';
import { PermissionCard } from './PermissionCard';

export function TimelineItem({ event, final = false, assistantLabel = 'Agent', onResolvePermission, resolvingPermissionId }: { event: TimelineEvent; final?: boolean; assistantLabel?: string; onResolvePermission?(permissionId: string, approved: boolean): void; resolvingPermissionId?: string }) {
  if (event.type === 'tool_call' || event.type === 'tool_result') return <ToolCard event={event}/>;
  if (event.type === 'permission_request') return <PermissionCard event={event} onResolve={onResolvePermission} resolving={resolvingPermissionId === String(event.data.id ?? event.id)}/>;
  if (event.type === 'warning') return <aside role="status" className="ui-timeline-item my-4 overflow-hidden rounded-xl border border-amber-200 bg-amber-50/75 shadow-[0_4px_14px_rgba(180,83,9,.045)]">
    <div className="flex items-start gap-3 px-4 py-3"><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700"><AlertTriangle size={14}/></span><div className="min-w-0"><div className="text-[13px] font-semibold text-amber-950">{event.data.warningKind === 'skill' ? 'Skill 提示' : 'Agent 警告'}</div><div className="mt-1 text-[13px] leading-5 text-amber-800"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></div></div></div>
  </aside>;
  if (event.type === 'error') return <aside role="alert" className="ui-timeline-item my-4 overflow-hidden rounded-xl border border-red-200 bg-red-50/80 shadow-[0_4px_14px_rgba(185,28,28,.045)]">
    <div className="flex items-start gap-3 px-4 py-3"><span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-red-100 text-red-700"><CircleX size={14}/></span><div className="min-w-0"><div className="text-[13px] font-semibold text-red-950">Agent 错误</div><div className="mt-1 text-[13px] leading-5 text-red-800"><MarkdownContent>{event.data.message ?? 'Agent 运行失败'}</MarkdownContent></div></div></div>
  </aside>;
  if (event.type === 'thinking') return null;
  const user = event.data.role === 'user';
  if (user) return <div className="ui-timeline-item my-6 flex justify-end"><div className="max-w-[84%] rounded-2xl rounded-br-md bg-slate-900 px-4 py-3 text-[14px] leading-6 text-slate-50 shadow-[0_5px_18px_rgba(15,23,42,.12)] sm:max-w-[78%]"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></div></div>;
  if (final) return <article aria-label={`${assistantLabel} 最终输出`} className="assistant-output markdown ui-timeline-item my-4 max-w-[78ch] text-[14px] leading-6 text-zinc-800"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
  return <article className="assistant-output markdown ui-timeline-item my-5 max-w-[78ch] text-[14px] leading-6 text-zinc-800"><MarkdownContent>{event.data.text ?? ''}</MarkdownContent></article>;
}
