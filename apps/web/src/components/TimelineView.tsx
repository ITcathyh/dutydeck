import { ArrowDown, MessageSquare } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TimelineEvent, TimelineSection } from '../timeline';
import { useTimelineAutoScroll } from '../useTimelineAutoScroll';
import { Button, EmptyState, Skeleton } from './primitives';
import { ActivityPanel } from './ActivityPanel';
import { TimelineDisclosureContext } from '../timeline-disclosure';
import { TimelineItem } from './TimelineItem';

export type TimelineViewProps = {
  activeSessionId?: string;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  olderError?: string;
  loadOlder?(): Promise<void>;
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

const TimelineBody = memo(function TimelineBody({ timelineSections, activeOutputLabel, onResolvePermission, resolvingPermissionId, awaitingAnswer, hasOngoingActivity, timeline, latestUserIndex }: Pick<TimelineViewProps, 'timelineSections' | 'activeOutputLabel' | 'onResolvePermission' | 'resolvingPermissionId' | 'awaitingAnswer' | 'hasOngoingActivity' | 'timeline' | 'latestUserIndex'>) {
  return <>
    {timelineSections.map(section => section.kind === 'event'
      ? <div key={section.event.id} data-timeline-event={section.event.id} style={{ display: 'flow-root' }}><TimelineItem
          event={section.event}
          final={section.final}
          assistantLabel={activeOutputLabel}
          onResolvePermission={onResolvePermission}
          resolvingPermissionId={resolvingPermissionId}
        /></div>
      : <ActivityPanel
          key={`activity-${section.hasAnswer ? 'settled' : 'active'}`}
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
}, (a, b) => a.activeOutputLabel === b.activeOutputLabel && a.onResolvePermission === b.onResolvePermission
  && a.resolvingPermissionId === b.resolvingPermissionId && a.awaitingAnswer === b.awaitingAnswer
  && a.hasOngoingActivity === b.hasOngoingActivity
  && (!a.awaitingAnswer || a.timeline[a.latestUserIndex]?.timestamp === b.timeline[b.latestUserIndex]?.timestamp)
  && a.timelineSections.length === b.timelineSections.length && a.timelineSections.every((section, index) => section === b.timelineSections[index]));

type TimelineTurn = { id: string; sections: TimelineSection[] };
type TimelineRow = TimelineTurn & { top: number; height: number };

export function TimelineView({ activeSessionId, eventsLoading, onResolvePermission, resolvingPermissionId, timeline, timelineSections, awaitingAnswer, hasOngoingActivity, latestUserIndex, activeOutputLabel, footer, renderProgress, hasOlder, loadingOlder, olderError, loadOlder }: TimelineViewProps) {
  const disclosures = useMemo(() => new Map<string, boolean>(), [activeSessionId]);
  const progressRef = useRef<HTMLDivElement>(null);
  const timelineScroll = useTimelineAutoScroll(activeSessionId, timeline, awaitingAnswer);
  const heights = useMemo(() => new Map<string, number>(), [activeSessionId]);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [viewport, setViewport] = useState({ top: Infinity, height: 960 });
  const anchor = useRef<{ id: string; offset: number; eventId?: string; screenTop?: number } | undefined>(undefined);
  const programmedScrollTop = useRef<number | undefined>(undefined);
  const turnAliases = useRef(new Map<string, string>());
  const previousFirst = useRef<{ id: string; events: Set<string> } | undefined>(undefined);
  const turnCache = useMemo(() => new WeakMap<TimelineSection, TimelineTurn>(), [activeSessionId]);
  const rowCache = useMemo(() => new WeakMap<TimelineTurn, TimelineRow>(), [activeSessionId]);
  const turns = useMemo(() => {
    const result: TimelineTurn[] = [];
    let start = 0;
    const appendTurn = (end: number) => {
      const first = timelineSections[start]!;
      let turn = turnCache.get(first);
      let unchanged = turn?.sections.length === end - start;
      for (let index = start; unchanged && index < end; index++) unchanged = turn!.sections[index - start] === timelineSections[index];
      if (!unchanged) {
        turn = { id: first.kind === 'event' ? first.event.id : first.id, sections: timelineSections.slice(start, end) };
        turnCache.set(first, turn);
      }
      result.push(turn!);
      start = end;
    };
    for (let index = 1; index < timelineSections.length; index++) {
      const section = timelineSections[index]!;
      if (section.kind === 'event' && section.event.data.role === 'user' && !section.event.data.steering) appendTurn(index);
    }
    if (start < timelineSections.length) appendTurn(timelineSections.length);
    const eventIds = (turn: typeof result[number]) => turn.sections.flatMap(section => section.kind === 'event' ? [section.event.id] : section.groups.flatMap(group => group.events.map(event => event.id)));
    if (previousFirst.current && result[0]?.id !== previousFirst.current.id) {
      // Only a prepended boundary fragment can change its first event id.
      for (const turn of result) {
        if (eventIds(turn).some(id => previousFirst.current!.events.has(id))) {
          turnAliases.current.set(turn.id, previousFirst.current.id); break;
        }
      }
    }
    for (const turn of result) turn.id = turnAliases.current.get(turn.id) ?? turn.id;
    const first = result[0];
    previousFirst.current = first ? { id: first.id, events: new Set(eventIds(first)) } : undefined;
    return result;
  }, [timelineSections, turnCache]);
  const layout = useMemo(() => {
    let top = 0;
    const rows = turns.map(turn => {
      const height = heights.get(turn.id) ?? 180;
      let row = rowCache.get(turn);
      if (!row || row.top !== top || row.height !== height || row.id !== turn.id) {
        row = { ...turn, top, height }; rowCache.set(turn, row);
      }
      top += height;
      return row;
    });
    return { rows, height: top };
  }, [turns, heights, measureVersion, rowCache]);
  const top = !timelineScroll.isFollowing && Number.isFinite(viewport.top) ? viewport.top : Math.max(0, layout.height - viewport.height);
  const firstMatch = layout.rows.findIndex(row => row.top + row.height >= top - 800);
  const first = firstMatch < 0 ? Math.max(0, layout.rows.length - 1) : firstMatch;
  let last = first;
  while (last < layout.rows.length && layout.rows[last]!.top <= top + viewport.height + 800) last++;
  const visible = layout.rows.slice(first, last);
  const syncViewport = (captureAnchor = true) => {
    const container = timelineScroll.containerRef.current;
    if (!container) return;
    setViewport({ top: container.scrollTop, height: container.clientHeight || 960 });
    if (!captureAnchor) return;
    const containerTop = container.getBoundingClientRect().top;
    // A scroll can precede mounting its new virtual window. Do not capture
    // an overscan event still far below the visible viewport.
    const element = [...container.querySelectorAll<HTMLElement>('[data-timeline-event]')].find(element => { const rect = element.getBoundingClientRect(); return rect.bottom > containerTop && rect.top < containerTop + container.clientHeight; });
    const rowId = element?.closest<HTMLElement>('[data-timeline-turn]')?.dataset.timelineTurn;
    const row = layout.rows.find(row => row.id === rowId) ?? layout.rows.find(row => row.top + row.height > container.scrollTop);
    anchor.current = row ? { id: row.id, offset: container.scrollTop - row.top,
      ...(element ? { eventId: element.dataset.timelineEvent, screenTop: element.getBoundingClientRect().top } : {}) } : undefined;
  };
  useLayoutEffect(() => {
    const container = timelineScroll.containerRef.current;
    if (!container) return;
    if (timelineScroll.isFollowing) container.scrollTop = container.scrollHeight;
    else if (anchor.current) {
      const element = [...container.querySelectorAll<HTMLElement>('[data-timeline-event]')].find(element => element.dataset.timelineEvent === anchor.current!.eventId);
      if (element && anchor.current.screenTop !== undefined) container.scrollTop += element.getBoundingClientRect().top - anchor.current.screenTop;
      else {
        const row = layout.rows.find(row => row.id === anchor.current!.id);
        if (row) container.scrollTop = row.top + anchor.current.offset;
      }
    }
    programmedScrollTop.current = timelineScroll.isFollowing ? undefined : container.scrollTop;
    // Height corrections and the resulting native scroll events must retain
    // the same event/pixel target until the user scrolls again.
    syncViewport(!anchor.current?.eventId);
  }, [layout, activeSessionId, first, last]);
  const touchY = useRef<number | undefined>(undefined);
  const requestOlder = () => {
    if ((timelineScroll.containerRef.current?.scrollTop ?? Infinity) < 120 && hasOlder && !loadingOlder) {
      timelineScroll.stopFollowing(); syncViewport(); void loadOlder?.();
    }
  };
  const onScroll = () => {
    const scrollTop = timelineScroll.containerRef.current?.scrollTop;
    if (scrollTop === programmedScrollTop.current) { syncViewport(false); return; }
    programmedScrollTop.current = undefined;
    timelineScroll.onScroll(); syncViewport();
    requestOlder();
  };
  useEffect(() => {
    const progress = progressRef.current;
    if (!progress || !timelineScroll.isFollowing || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => timelineScroll.followContentResize());
    observer.observe(progress);
    return () => observer.disconnect();
  }, [activeSessionId, timelineScroll.isFollowing]);
  return <TimelineDisclosureContext.Provider value={disclosures}><div className="relative min-h-0 flex-1 bg-canvas">
    <div ref={timelineScroll.containerRef} onScroll={onScroll}
      onWheel={event => { if (event.deltaY < 0) requestOlder(); }}
      onTouchStart={event => { touchY.current = event.touches[0]?.clientY; }}
      onTouchMove={event => { if (touchY.current !== undefined && (event.touches[0]?.clientY ?? touchY.current) > touchY.current) requestOlder(); }}
      style={{ overflowAnchor: 'none' }} data-timeline-scroll="true" data-history-start={timeline[0]?.sequence} className="absolute inset-0 overscroll-contain overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-5 py-8 sm:px-8 sm:py-10">
        {olderError && <button onClick={() => void loadOlder?.()} className="text-caption text-danger">历史加载失败，点击重试：{olderError}</button>}
        {!eventsLoading && !timeline.length && hasOlder && <p className="text-caption text-subtle">向上滚动查看更早记录</p>}
        {eventsLoading
          ? <TimelineSkeleton/>
          : timeline.length
            ? <>
                <div aria-hidden="true" style={{ height: visible[0]?.top ?? 0 }}/>
                {visible.map(row => <MeasuredTurn key={row.id} id={row.id} onMeasure={height => {
                  if (heights.get(row.id) === height) return;
                  heights.set(row.id, height); setMeasureVersion(version => version + 1);
                }}><TimelineBody
                  timelineSections={row.sections} activeOutputLabel={activeOutputLabel}
                  onResolvePermission={onResolvePermission} resolvingPermissionId={resolvingPermissionId}
                  awaitingAnswer={awaitingAnswer && row.id === turns.at(-1)?.id}
                  hasOngoingActivity={hasOngoingActivity} timeline={timeline} latestUserIndex={latestUserIndex}
                /></MeasuredTurn>)}
                <div aria-hidden="true" style={{ height: Math.max(0, layout.height - ((visible.at(-1)?.top ?? 0) + (visible.at(-1)?.height ?? 0))) }}/>
              </>
            : !renderProgress && !hasOlder && <TimelineEmptyState/>}
        {renderProgress && <div ref={progressRef}>{renderProgress(!eventsLoading && !timeline.length && !hasOlder ? <TimelineEmptyState/> : null)}</div>}
        {!eventsLoading && timeline.length > 0 && footer}
      </div>
    </div>
    {!timelineScroll.isFollowing && <ScrollToBottomButton onClick={timelineScroll.scrollToBottom}/>}
  </div></TimelineDisclosureContext.Provider>;
}

function MeasuredTurn({ id, onMeasure, children }: { id: string; onMeasure(height: number): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const measure = useRef(onMeasure); measure.current = onMeasure;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => { const height = element.getBoundingClientRect().height; if (height > 0) measure.current(height); };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} data-timeline-turn={id} style={{ display: 'flow-root' }}>{children}</div>;
}
