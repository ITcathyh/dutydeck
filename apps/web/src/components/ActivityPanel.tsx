import { useState } from 'react';
import { ChevronRight, CircleStop, CircleX, LoaderCircle, MessageSquare } from 'lucide-react';
import type { TimelineActivityGroup } from '../timeline';
import { elapsedMilliseconds, formatElapsed } from '../tool-presentation';
import { ActivityGroupPanel } from './ToolCard';

export function ActivityPanel({ groups, ongoing, hasAnswer = false, taskStatus = 'running', modelLabel, startedAt, completedAt }: { groups: TimelineActivityGroup[]; ongoing: boolean; hasAnswer?: boolean; taskStatus?: string; modelLabel: string; startedAt?: string; completedAt?: string }) {
  const [open, setOpen] = useState(ongoing);
  const elapsed = formatElapsed(elapsedMilliseconds(startedAt ?? groups[0]?.startedAt, ongoing ? undefined : completedAt ?? groups.at(-1)?.completedAt));
  const interrupted = taskStatus === 'interrupted' || taskStatus === 'cancelled';
  const failed = taskStatus === 'failed';
  const incomplete = taskStatus === 'incomplete';
  const statusLabel = ongoing ? '执行中' : interrupted ? '已取消' : failed ? '已失败' : incomplete ? '未完成' : '已完成';
  const statusTone = ongoing ? 'text-blue-600' : interrupted ? 'text-zinc-500' : failed ? 'text-red-600' : incomplete ? 'text-amber-600' : 'text-emerald-600';
  const missingFinal = !ongoing && !hasAnswer;
  const missingFinalText = interrupted ? '任务已中断，未产生最终输出。' : failed ? '任务执行失败，未产生最终输出。' : 'Agent 未返回最终输出。';
  return <>
  <details open={open} onToggle={event => setOpen(event.currentTarget.open)} aria-live={ongoing ? 'polite' : undefined} aria-label={`${modelLabel} 执行过程`} className="reasoning ui-timeline-item group/turn my-3 border-b border-zinc-200 text-sm text-zinc-500">
    <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 py-2.5 text-[12px] font-medium text-zinc-500 outline-none transition-colors hover:text-zinc-800 focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-inset">
      <span className="whitespace-nowrap">{elapsed ? `${ongoing ? '已耗时' : '耗时'} ${elapsed}` : '查看执行过程'}</span>
      {ongoing ? <LoaderCircle size={11} className="shrink-0 animate-spin text-blue-500"/> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${interrupted ? 'bg-zinc-400' : failed ? 'bg-red-500' : incomplete ? 'bg-amber-500' : 'bg-emerald-500'}`}/>}<span className={`shrink-0 whitespace-nowrap text-[10px] ${statusTone}`}>{statusLabel}</span>
      <ChevronRight size={13} className="shrink-0 text-zinc-400 transition-transform group-open/turn:rotate-90"/>
      {groups.length > 0 && <span className="ml-auto text-[10px] tabular-nums text-zinc-400">{groups.length} 个阶段</span>}
    </summary>
    <div className="pb-3 pl-5">
      {groups.length ? groups.map((group, index) => <ActivityGroupPanel key={group.id} group={group} ongoing={ongoing && index === groups.length - 1}/>) : <div className="flex items-center gap-2 py-2 text-[11px] text-zinc-400"><LoaderCircle size={12} className="animate-spin"/>等待模型输出</div>}
    </div>
  </details>
  {missingFinal && <div role="status" className="ui-timeline-item my-4 flex items-center gap-2 text-[12px] text-zinc-500">{failed ? <CircleX size={14} className="text-red-500"/> : interrupted ? <CircleStop size={14} className="text-zinc-400"/> : <MessageSquare size={14} className={incomplete ? 'text-amber-500' : 'text-zinc-400'}/>}<span>{missingFinalText}</span></div>}
  </>;
}
