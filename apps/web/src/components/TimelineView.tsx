import { ArrowDown, MessageSquare } from 'lucide-react';
import type { TimelineEvent, TimelineSection } from '../timeline';
import { useTimelineAutoScroll } from '../useTimelineAutoScroll';
import { ActivityPanel } from './ActivityPanel';
import { TimelineItem } from './TimelineItem';

export type TimelineViewProps = {
  activeSessionId?: string;
  eventsLoading: boolean;
  timeline: TimelineEvent[];
  timelineSections: TimelineSection[];
  awaitingAnswer: boolean;
  hasOngoingActivity: boolean;
  latestUserIndex: number;
  activeOutputLabel: string;
};

export function TimelineView({ activeSessionId, eventsLoading, timeline, timelineSections, awaitingAnswer, hasOngoingActivity, latestUserIndex, activeOutputLabel }: TimelineViewProps) {
  const timelineScroll = useTimelineAutoScroll(activeSessionId, timeline, awaitingAnswer);
  return <div className="relative min-h-0 flex-1"><div ref={timelineScroll.containerRef} onScroll={timelineScroll.onScroll} className="absolute inset-0 overscroll-contain overflow-y-auto"><div className="mx-auto w-full max-w-[820px] px-5 py-8 sm:px-8 sm:py-10">
        {eventsLoading ? <div className="space-y-5"><div className="h-4 w-3/4 animate-pulse rounded bg-zinc-200"/><div className="h-4 w-1/2 animate-pulse rounded bg-zinc-200"/><div className="h-20 animate-pulse rounded-xl bg-zinc-100"/></div> : timeline.length ? <>{timelineSections.map(section => section.kind === 'event' ? <TimelineItem key={section.event.id} event={section.event} final={section.final} assistantLabel={activeOutputLabel}/> : <ActivityPanel key={`${section.id}-${section.hasAnswer ? 'settled' : 'active'}`} groups={section.groups} hasAnswer={section.hasAnswer} taskStatus={section.taskStatus} ongoing={section.isLatestTurn && awaitingAnswer} modelLabel={activeOutputLabel} startedAt={section.startedAt} completedAt={section.completedAt}/>)}{awaitingAnswer && !hasOngoingActivity && <ActivityPanel groups={[]} ongoing modelLabel={activeOutputLabel} startedAt={timeline[latestUserIndex]?.timestamp}/>}</> : <div className="flex min-h-[55vh] flex-col items-center justify-center text-center"><div className="grid h-10 w-10 place-items-center rounded-xl border border-zinc-200 bg-white text-zinc-500 shadow-sm"><MessageSquare size={18}/></div><h2 className="mt-4 text-sm font-semibold">开始对话</h2><p className="mt-1 max-w-xs leading-5 text-xs text-zinc-500">让 Agent 检查代码、实现改动或讲解当前项目。</p></div>}
        </div></div>{!timelineScroll.isFollowing && <button type="button" onClick={timelineScroll.scrollToBottom} className="absolute bottom-4 right-5 z-10 flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-[12px] font-medium text-zinc-700 shadow-[0_8px_24px_rgba(24,24,27,.12)] transition-colors hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/40" aria-label="回到最新消息"><ArrowDown size={13}/>回到底部</button>}</div>;
}
