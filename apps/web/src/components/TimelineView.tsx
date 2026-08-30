import { ArrowDown, LoaderCircle, MessageSquare } from 'lucide-react';
import type { TimelineEvent, TimelineSection } from '../timeline';
import { useTimelineAutoScroll } from '../useTimelineAutoScroll';
import { ActivityPanel } from './ActivityPanel';
import { TimelineItem } from './TimelineItem';

export type TimelineViewProps = {
  activeSessionId?: string;
  eventsLoading: boolean;
  loadingEarlier: boolean;
  hasEarlier: boolean;
  onLoadEarlier(): Promise<unknown>;
  onResolvePermission(permissionId: string, approved: boolean): void;
  resolvingPermissionId?: string;
  timeline: TimelineEvent[];
  timelineSections: TimelineSection[];
  awaitingAnswer: boolean;
  hasOngoingActivity: boolean;
  latestUserIndex: number;
  activeOutputLabel: string;
};

export function TimelineView({ activeSessionId, eventsLoading, loadingEarlier, hasEarlier, onLoadEarlier, onResolvePermission, resolvingPermissionId, timeline, timelineSections, awaitingAnswer, hasOngoingActivity, latestUserIndex, activeOutputLabel }: TimelineViewProps) {
  const timelineScroll = useTimelineAutoScroll(activeSessionId, timeline, awaitingAnswer);
  const loadEarlier = async () => {
    const container = timelineScroll.containerRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    try {
      await onLoadEarlier();
      requestAnimationFrame(() => { if (container) container.scrollTop += container.scrollHeight - previousHeight; });
    } catch { /* mutation 已在全局错误条展示 */ }
  };
  return <div className="relative min-h-0 flex-1 bg-[var(--canvas)]"><div ref={timelineScroll.containerRef} onScroll={timelineScroll.onScroll} className="absolute inset-0 overscroll-contain overflow-y-auto"><div className="mx-auto w-full max-w-[880px] px-5 py-8 sm:px-8 sm:py-10">
        {hasEarlier && <div className="mb-6 flex justify-center"><button type="button" disabled={loadingEarlier} onClick={() => void loadEarlier()} className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-[11px] font-medium text-slate-600 shadow-sm hover:border-slate-300 disabled:opacity-50">{loadingEarlier && <LoaderCircle size={12} className="animate-spin"/>}{loadingEarlier ? '加载中…' : '加载更早记录'}</button></div>}{eventsLoading ? <div className="space-y-5"><div className="h-4 w-3/4 animate-pulse rounded bg-slate-200"/><div className="h-4 w-1/2 animate-pulse rounded bg-slate-200"/><div className="h-20 animate-pulse rounded-xl bg-white"/></div> : timeline.length ? <>{timelineSections.map(section => section.kind === 'event' ? <TimelineItem key={section.event.id} event={section.event} final={section.final} assistantLabel={activeOutputLabel} onResolvePermission={onResolvePermission} resolvingPermissionId={resolvingPermissionId}/> : <ActivityPanel key={`${section.id}-${section.hasAnswer ? 'settled' : 'active'}`} groups={section.groups} hasAnswer={section.hasAnswer} taskStatus={section.taskStatus} ongoing={section.isLatestTurn && awaitingAnswer} modelLabel={activeOutputLabel} startedAt={section.startedAt} completedAt={section.completedAt}/>)}{awaitingAnswer && !hasOngoingActivity && <ActivityPanel groups={[]} ongoing modelLabel={activeOutputLabel} startedAt={timeline[latestUserIndex]?.timestamp}/>}</> : <div className="flex min-h-[55vh] flex-col items-center justify-center text-center"><div className="grid h-11 w-11 place-items-center rounded-2xl border border-slate-200 bg-white text-teal-700 shadow-sm"><MessageSquare size={18}/></div><h2 className="mt-4 text-sm font-semibold text-slate-900">下达第一个任务</h2><p className="mt-1 max-w-xs leading-5 text-xs text-slate-500">说明目标、改动范围与验收条件，Agent 会在当前工作区开始执行。</p></div>}
        </div></div>{!timelineScroll.isFollowing && <button type="button" onClick={timelineScroll.scrollToBottom} className="absolute bottom-4 right-5 z-10 flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 shadow-[0_8px_24px_rgba(24,24,27,.12)] transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/40" aria-label="回到最新消息"><ArrowDown size={13}/>回到底部</button>}</div>;
}
