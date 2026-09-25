import { useState } from 'react';
import { ChevronRight, CircleStop, CircleX, MessageSquare } from 'lucide-react';
import type { TimelineActivityGroup } from '../timeline';
import { elapsedMilliseconds, formatElapsed } from '../tool-presentation';
import { Spinner } from './primitives';
import { ActivityGroupPanel } from './ToolCard';

export function ActivityPanel({ groups, ongoing, hasAnswer = false, taskStatus = 'running', modelLabel, startedAt, completedAt }: { groups: TimelineActivityGroup[]; ongoing: boolean; hasAnswer?: boolean; taskStatus?: string; modelLabel: string; startedAt?: string; completedAt?: string }) {
  const [open, setOpen] = useState(ongoing);
  const elapsed = formatElapsed(elapsedMilliseconds(startedAt ?? groups[0]?.startedAt, ongoing ? undefined : completedAt ?? groups.at(-1)?.completedAt));
  const interrupted = taskStatus === 'interrupted' || taskStatus === 'cancelled';
  const failed = taskStatus === 'failed';
  // 执行结果没有确认（例如被服务重启切断）：既不是失败也不是完成，按未完成的样式标「结果未知」。
  const unknown = taskStatus === 'reconcile_required';
  const incomplete = taskStatus === 'incomplete' || unknown;
  const statusLabel = ongoing ? '执行中' : interrupted ? '已取消' : failed ? '已失败' : unknown ? '结果未知' : incomplete ? '未完成' : '已完成';
  const statusTone = ongoing ? 'text-info' : interrupted ? 'text-subtle' : failed ? 'text-danger' : incomplete ? 'text-warning' : 'text-success';
  const missingFinal = !ongoing && !hasAnswer;
  const missingFinalText = interrupted ? '任务已中断，未产生最终输出。' : failed ? '任务执行失败，未产生最终输出。' : unknown ? '这一轮的执行结果未确认。' : 'Agent 未返回最终输出。';
  return <>
  <details open={open} onToggle={event => setOpen(event.currentTarget.open)} aria-live={ongoing ? 'polite' : undefined} aria-label={`${modelLabel} 执行过程`} className="reasoning ui-timeline-item group/turn my-3 border-b border-default text-body text-subtle">
    <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 py-2.5 text-caption font-medium text-subtle outline-none transition-colors hover:text-primary focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset">
      <span className="whitespace-nowrap">{elapsed ? `${ongoing ? '已耗时' : '耗时'} ${elapsed}` : '查看执行过程'}</span>
      {/* 转圈是纯装饰：状态文案就在旁边，不传 label，避免读屏重复播报。 */}
      {ongoing ? <span className="shrink-0 text-info-solid"><Spinner/></span> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${interrupted ? 'bg-neutral-solid' : failed ? 'bg-danger-solid' : incomplete ? 'bg-warning-solid' : 'bg-success-solid'}`}/>}<span className={`shrink-0 whitespace-nowrap text-caption ${statusTone}`}>{statusLabel}</span>
      <ChevronRight size={13} className="shrink-0 text-subtle transition-transform group-open/turn:rotate-90"/>
      {groups.length > 0 && <span className="ml-auto text-caption tabular-nums text-subtle">{groups.length} 个阶段</span>}
    </summary>
    <div className="pb-3 pl-5">
      {groups.length ? groups.map((group, index) => <ActivityGroupPanel key={group.id} group={group} ongoing={ongoing && index === groups.length - 1}/>) : <div className="flex items-center gap-2 py-2 text-caption text-subtle"><Spinner/>等待模型输出</div>}
    </div>
  </details>
  {missingFinal && <div role="status" className="ui-timeline-item my-4 flex items-center gap-2 text-caption text-subtle">{failed ? <CircleX size={14} className="text-danger-solid"/> : interrupted ? <CircleStop size={14} className="text-subtle"/> : <MessageSquare size={14} className={incomplete ? 'text-warning-solid' : 'text-subtle'}/>}<span>{missingFinalText}</span></div>}
  </>;
}
