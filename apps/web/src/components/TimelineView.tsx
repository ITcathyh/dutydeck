import { ArrowDown, MessageSquare } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import type { TimelineEvent, TimelineSection } from '../timeline';
import { useTimelineAutoScroll } from '../useTimelineAutoScroll';
import { Button, EmptyState, Skeleton } from './primitives';
import { ActivityPanel } from './ActivityPanel';
import { TimelineItem } from './TimelineItem';

export type TimelineViewProps = {
  activeSessionId?: string;
  eventsLoading: boolean;
  /** 不传时授权卡只显示状态、不给按钮（只读分享页） */
  onResolvePermission?(permissionId: string, approved: boolean): void;
  resolvingPermissionId?: string;
  timeline: TimelineEvent[];
  timelineSections: TimelineSection[];
  awaitingAnswer: boolean;
  hasOngoingActivity: boolean;
  latestUserIndex: number;
  activeOutputLabel: string;
  footer?: ReactNode;
  renderProgress?: (emptyState: ReactNode) => ReactNode;
};

/** 时间线首屏骨架：两行标题占位 + 一块正文占位，对应真实内容的视觉重量。 */
function TimelineSkeleton() {
  return <div className="space-y-5">
    <Skeleton variant="text" lines={2}/>
    <Skeleton variant="block"/>
  </div>;
}

/** 首次进入、还没有任何任务时的引导（tone=guide，不是「筛不出结果」的 neutral）。 */
function TimelineEmptyState() {
  return <div className="flex min-h-[55vh] flex-col items-center justify-center">
    <EmptyState
      tone="guide"
      icon={<MessageSquare size={22}/>}
      title="下达第一个任务"
      description="说明目标、改动范围与验收条件，Agent 会在当前工作区开始执行。"
    />
  </div>;
}

/** 用户向上翻阅历史后，把他送回最新消息。 */
function ScrollToBottomButton({ onClick }: { onClick(): void }) {
  return <div className="absolute bottom-4 right-5 z-sticky">
    <Button size="md" variant="secondary" icon={<ArrowDown size={13}/>} aria-label="回到最新消息" onClick={onClick} className="shadow-panel">回到底部</Button>
  </div>;
}

function TimelineBody({ timelineSections, activeOutputLabel, onResolvePermission, resolvingPermissionId, awaitingAnswer, hasOngoingActivity, timeline, latestUserIndex }: Pick<TimelineViewProps, 'timelineSections' | 'activeOutputLabel' | 'onResolvePermission' | 'resolvingPermissionId' | 'awaitingAnswer' | 'hasOngoingActivity' | 'timeline' | 'latestUserIndex'>) {
  return <>
    {timelineSections.map(section => section.kind === 'event'
      ? <TimelineItem
          key={section.event.id}
          event={section.event}
          final={section.final}
          assistantLabel={activeOutputLabel}
          onResolvePermission={onResolvePermission}
          resolvingPermissionId={resolvingPermissionId}
        />
      : <ActivityPanel
          key={`${section.id}-${section.hasAnswer ? 'settled' : 'active'}`}
          groups={section.groups}
          hasAnswer={section.hasAnswer}
          taskStatus={section.taskStatus}
          ongoing={section.isLatestTurn && awaitingAnswer}
          modelLabel={activeOutputLabel}
          startedAt={section.startedAt}
          completedAt={section.completedAt}
        />)}
    {awaitingAnswer && !hasOngoingActivity && <ActivityPanel groups={[]} ongoing modelLabel={activeOutputLabel} startedAt={timeline[latestUserIndex]?.timestamp}/>}
  </>;
}

export function TimelineView({ activeSessionId, eventsLoading, onResolvePermission, resolvingPermissionId, timeline, timelineSections, awaitingAnswer, hasOngoingActivity, latestUserIndex, activeOutputLabel, footer, renderProgress }: TimelineViewProps) {
  const progressRef = useRef<HTMLDivElement>(null);
  const timelineScroll = useTimelineAutoScroll(activeSessionId, timeline, awaitingAnswer);
  useEffect(() => {
    const progress = progressRef.current;
    if (!progress || !timelineScroll.isFollowing || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => timelineScroll.followContentResize());
    observer.observe(progress);
    return () => observer.disconnect();
  }, [activeSessionId, timelineScroll.isFollowing]);
  return <div className="relative min-h-0 flex-1 bg-canvas">
    <div ref={timelineScroll.containerRef} onScroll={timelineScroll.onScroll} className="absolute inset-0 overscroll-contain overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-5 py-8 sm:px-8 sm:py-10">
        {eventsLoading
          ? <TimelineSkeleton/>
          : timeline.length
            ? <TimelineBody
                timelineSections={timelineSections}
                activeOutputLabel={activeOutputLabel}
                onResolvePermission={onResolvePermission}
                resolvingPermissionId={resolvingPermissionId}
                awaitingAnswer={awaitingAnswer}
                hasOngoingActivity={hasOngoingActivity}
                timeline={timeline}
                latestUserIndex={latestUserIndex}
              />
            : !renderProgress && <TimelineEmptyState/>}
        {renderProgress && <div ref={progressRef}>{renderProgress(!eventsLoading && !timeline.length ? <TimelineEmptyState/> : null)}</div>}
        {!eventsLoading && timeline.length > 0 && footer}
      </div>
    </div>
    {!timelineScroll.isFollowing && <ScrollToBottomButton onClick={timelineScroll.scrollToBottom}/>}
  </div>;
}
