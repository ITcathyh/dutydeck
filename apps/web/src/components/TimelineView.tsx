import { ArrowDown, MessageSquare } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useContext, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { TimelineEvent, TimelineSection } from '../timeline';
import { isNearScrollBottom, useTimelineAutoScroll } from '../useTimelineAutoScroll';
import { Button, EmptyState, Skeleton } from './primitives';
import { ActivityPanel } from './ActivityPanel';
import { TimelineDisclosureContext } from '../timeline-disclosure';
import { getTimelineReadingState, saveTimelineReadingState, type TimelineReadingAnchor } from '../timeline-reading-state';
import { TimelineItem } from './TimelineItem';
import { useQuery } from '@tanstack/react-query';
import { api, type DockEvent, type HistoryTurnPlace, type HistoryTurnSummary } from '../api';
import { HISTORY_TURN_PAGE_SIZE, loadTurnHistory } from '../event-history';
import { buildTimelineSections, createTimelineProjector } from '../timeline';
import { useTimelineDisclosure } from '../timeline-disclosure';
import { MarkdownContent } from '../MarkdownContent';
import { ShareTurn, type EarlierPlace } from './ShareTurn';
import { liveTurnFacts, turnMomentWidth } from '../share-view';

export type TimelineViewProps = {
  fullWidth?: boolean;
  /** 只读分享页：每轮渲染成结论卡，header（英雄区）与 aside（侧栏）随内容一起滚动。 */
  variant?: 'share';
  header?: ReactNode;
  aside?: ReactNode;
  onScrollTop?(scrollTop: number): void;
  activeSessionId?: string;
  historyTurns?: HistoryTurnSummary[];
  /** Every completed turn when `historyTurns` holds only the newest; the others read their summaries per page. */
  historyPlaces?: HistoryTurnPlace[];
  sourceEvents?: DockEvent[];
  readingScopeKey?: string;
  visible?: boolean;
  hasOlder?: boolean;
  loadedEventCount?: number;
  olderError?: string;
  loadOlder?(): Promise<void>;
  eventsLoading: boolean;
  /** 不传时授权卡只显示状态、不给按钮（只读分享页） */
  onResolvePermission?(permissionId: string, approved: boolean, reason?: string): void | Promise<unknown>;
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

type TimelineTurn = { id: string; sections: TimelineSection[]; summary?: HistoryTurnSummary; place?: HistoryTurnPlace; placeIndex?: number };
type TimelineRow = TimelineTurn & { top: number; height: number };
/** Summarized turns render from their summary, not sections; they share one empty list. */
const noSections: TimelineSection[] = [];

export function TimelineView({ fullWidth = false, variant, header, aside, onScrollTop, historyTurns, historyPlaces, sourceEvents, activeSessionId, readingScopeKey = activeSessionId ?? 'empty', visible: isVisible = true, eventsLoading, onResolvePermission, resolvingPermissionId, timeline, timelineSections, awaitingAnswer, hasOngoingActivity, latestUserIndex, activeOutputLabel, footer, renderProgress, hasOlder, loadedEventCount, olderError, loadOlder }: TimelineViewProps) {
  const share = variant === 'share';
  // 分享页第一次打开从英雄区开始读，不自动滚到最底部；读者滚到底后才跟随新内容，刷新后照旧跟随。
  const reading = useMemo(() => getTimelineReadingState(readingScopeKey, !share), [readingScopeKey, share]);
  const disclosures = reading.disclosures;
  const progressRef = useRef<HTMLDivElement>(null);
  const timelineScroll = useTimelineAutoScroll(readingScopeKey, timeline, awaitingAnswer, { initialFollowing: reading.following, enabled: isVisible });
  const heights = reading.heights;
  const [measureVersion, setMeasureVersion] = useState(0);
  const [viewport, setViewport] = useState({ top: reading.following ? Infinity : reading.scrollTop, height: 960 });
  const [requestedSource, setRequestedSource] = useState<HistorySource>();
  const sourceRequestId = useRef(0);
  const anchor = useRef<TimelineReadingAnchor | undefined>(reading.anchor);
  useLayoutEffect(() => {
    anchor.current = reading.anchor;
    setViewport({ top: reading.following ? Infinity : reading.scrollTop, height: 960 });
  }, [reading]);
  const programmedScrollTop = useRef<number | undefined>(undefined);
  const turnAliases = useRef(new Map<string, string>());
  const previousFirst = useRef<{ id: string; sections: TimelineSection[] } | undefined>(undefined);
  const previousScope = useRef(readingScopeKey);
  if (previousScope.current !== readingScopeKey) {
    turnAliases.current.clear(); previousFirst.current = undefined;
    previousScope.current = readingScopeKey;
  }
  const turnCache = useMemo(() => new WeakMap<TimelineSection, TimelineTurn>(), [readingScopeKey]);
  const summaryTurns = useMemo((): TimelineTurn[] => {
    if (!historyPlaces) return (historyTurns ?? []).map(summary => ({ id: summary.id, sections: noSections, summary }));
    const loaded = new Map((historyTurns ?? []).map(summary => [summary.id, summary]));
    return historyPlaces.map((place, placeIndex) => ({ id: place[0], sections: noSections, summary: loaded.get(place[0]), place, placeIndex }));
  }, [historyTurns, historyPlaces]);
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
    const eventIds = (sections: TimelineSection[]) => sections.flatMap(section => section.kind === 'event' ? [section.event.id] : section.groups.flatMap(group => group.events.map(event => event.id)));
    if (previousFirst.current && result[0]?.id !== previousFirst.current.id) {
      // Only a prepended boundary fragment can change its first event id.
      // The id set is built here, not on every live append to the first turn.
      const previousEvents = new Set(eventIds(previousFirst.current.sections));
      for (const turn of result) {
        if (eventIds(turn.sections).some(id => previousEvents.has(id))) {
          turnAliases.current.set(turn.id, previousFirst.current.id); break;
        }
      }
    }
    for (const turn of result) turn.id = turnAliases.current.get(turn.id) ?? turn.id;
    const first = result[0];
    previousFirst.current = first ? { id: first.id, sections: first.sections } : undefined;
    return [...summaryTurns, ...result];
  }, [timelineSections, turnCache, summaryTurns]);
  // 分享页「更早 N 轮」的总开关和轮内展开一样按会话保存，刷新后仍能恢复到读过的那一轮。
  // 收起时被藏起的轮次不进虚拟列表：它们不渲染，测不到高度，留着会按默认高度占出大片空白。
  const [, rerenderEarlier] = useReducer((version: number) => version + 1, 0);
  const earlierOpen = disclosures.get('share-earlier') ?? false;
  const setEarlierOpen = useCallback((open: boolean) => { disclosures.set('share-earlier', open); saveTimelineReadingState(); rerenderEarlier(); }, [disclosures]);
  const layoutTurns = useMemo(() => share && !earlierOpen && turns.length > 2 ? [turns[0]!, turns.at(-1)!] : turns, [share, earlierOpen, turns]);
  // Rows are prefix sums of their heights. A long session has tens of thousands of summarized
  // turns: only rows near the viewport become objects, and a live event re-adds numbers only.
  const layout = useMemo(() => {
    const tops = new Float64Array(layoutTurns.length + 1);
    for (let index = 0; index < layoutTurns.length; index++) tops[index + 1] = tops[index]! + (heights.get(layoutTurns[index]!.id) ?? 180);
    return { tops, height: tops[layoutTurns.length]! };
  }, [layoutTurns, heights, measureVersion]);
  const rowAt = (index: number): TimelineRow | undefined => {
    const turn = layoutTurns[index];
    return turn && { ...turn, top: layout.tops[index]!, height: layout.tops[index + 1]! - layout.tops[index]! };
  };
  // Summarized turns keep their index while live events arrive; only the live tail is searched.
  const summaryIndex = useMemo(() => new Map(summaryTurns.map((turn, index) => [turn.id, index])), [summaryTurns]);
  const rowById = (id: string | undefined) => {
    if (id === undefined) return undefined;
    const summarized = summaryIndex.get(id);
    if (summarized !== undefined && layoutTurns[summarized]?.id === id) return rowAt(summarized);
    for (let index = layoutTurns === turns ? summaryTurns.length : 0; index < layoutTurns.length; index++) if (layoutTurns[index]!.id === id) return rowAt(index);
    return undefined;
  };
  const rowContaining = (sequence: number) => rowAt(layoutTurns.findIndex(turn => containsSource(turn, sequence)));
  // 分享页的英雄区在滚动容器里、列表上方：行坐标从列表起点算，和 scrollTop 比较前先扣掉这段偏移。工作台不扣（偏移按 0）。
  const listStartRef = useRef<HTMLDivElement>(null);
  const listOffset = () => {
    const container = timelineScroll.containerRef.current, start = listStartRef.current;
    return share && container && start ? start.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop : 0;
  };
  const restoredRow = anchor.current && (rowById(anchor.current.id) ?? rowAt(layoutTurns.findIndex(turn => turn.sections.some(section => section.kind === 'event' ? section.event.id === anchor.current!.eventId : section.groups.some(group => group.events.some(event => event.id === anchor.current!.eventId))))));
  const top = !timelineScroll.isFollowing && Number.isFinite(viewport.top) ? (restoredRow ? restoredRow.top + anchor.current!.offset : viewport.top) : Math.max(0, layout.height - viewport.height);
  const firstMatch = firstRowEndingAfter(layout.tops, top - 800, true);
  const first = firstMatch < 0 ? Math.max(0, layoutTurns.length - 1) : firstMatch;
  let last = first;
  while (last < layoutTurns.length && layout.tops[last]! <= top + viewport.height + 800) last++;
  const visible = Array.from({ length: last - first }, (_, index) => rowAt(first + index)!);
  const syncViewport = (captureAnchor = true) => {
    const container = timelineScroll.containerRef.current;
    if (!container || !isVisible) return;
    const offset = listOffset();
    setViewport({ top: container.scrollTop - offset, height: container.clientHeight || 960 });
    if (!captureAnchor) return;
    const containerTop = container.getBoundingClientRect().top;
    // A scroll can precede mounting its new virtual window. Do not capture
    // an overscan event still far below the visible viewport.
    const element = [...container.querySelectorAll<HTMLElement>('[data-timeline-event]')].find(element => { const rect = element.getBoundingClientRect(); return rect.bottom > containerTop && rect.top < containerTop + container.clientHeight; });
    const rowId = element?.closest<HTMLElement>('[data-timeline-turn]')?.dataset.timelineTurn;
    const row = rowById(rowId) ?? rowAt(firstRowEndingAfter(layout.tops, container.scrollTop - offset, false));
    anchor.current = row ? { id: row.id, offset: container.scrollTop - offset - row.top,
      ...(element ? { eventId: element.dataset.timelineEvent, screenOffset: element.getBoundingClientRect().top - containerTop } : {}) } : undefined;
    reading.following = timelineScroll.isFollowing;
    reading.scrollTop = container.scrollTop;
    reading.anchor = anchor.current;
  };
  useLayoutEffect(() => {
    const container = timelineScroll.containerRef.current;
    if (!container || !isVisible || eventsLoading) return;
    // A restored event may be in an older page that is still arriving.
    if (!timelineScroll.isFollowing && anchor.current && !restoredRow && hasOlder) return;
    if (timelineScroll.isFollowing) container.scrollTop = container.scrollHeight;
    else if (anchor.current) {
      const element = [...container.querySelectorAll<HTMLElement>('[data-timeline-event]')].find(element => element.dataset.timelineEvent === anchor.current!.eventId);
      if (element && anchor.current.screenOffset !== undefined) container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.current.screenOffset;
      else {
        const row = rowById(anchor.current.id);
        if (row) container.scrollTop = row.top + anchor.current.offset + listOffset();
      }
    }
    programmedScrollTop.current = timelineScroll.isFollowing ? undefined : container.scrollTop;
    // Height corrections and the resulting native scroll events must retain
    // the same event/pixel target until the user scrolls again.
    syncViewport(!anchor.current?.eventId);
    reading.following = timelineScroll.isFollowing;
    reading.scrollTop = container.scrollTop;
    reading.anchor = anchor.current;
  }, [layout, readingScopeKey, first, last, isVisible, eventsLoading, timelineScroll.isFollowing]);
  useLayoutEffect(() => () => { saveTimelineReadingState(); }, [reading, isVisible]);
  const onScroll = () => {
    if (!isVisible) return;
    onScrollTop?.(timelineScroll.containerRef.current?.scrollTop ?? 0);
    const scrollTop = timelineScroll.containerRef.current?.scrollTop;
    if (scrollTop === programmedScrollTop.current) { syncViewport(false); return; }
    programmedScrollTop.current = undefined;
    timelineScroll.onScroll(); syncViewport();
    const container = timelineScroll.containerRef.current;
    if (container) reading.following = isNearScrollBottom(container);
  };
  const jumpToRow = (id: string) => {
    const row = rowById(id);
    const container = timelineScroll.containerRef.current;
    if (!row || !container) return;
    reading.following = false; anchor.current = { id: row.id, offset: 0, eventId: row.id, screenOffset: 0 };
    container.scrollTop = row.top + listOffset(); programmedScrollTop.current = undefined;
    timelineScroll.onScroll(); syncViewport(false);
  };
  const jumpToRowRef = useRef(jumpToRow); jumpToRowRef.current = jumpToRow;
  const jumpToTurn = useCallback((id: string) => jumpToRowRef.current(id), []);
  useEffect(() => {
    const showSource = (event: Event) => {
      const source = (event as CustomEvent<HistorySource>).detail;
      if (!source || !Number.isSafeInteger(source.sequence)) return;
      if (rowContaining(source.sequence)) setRequestedSource({ ...source, requestId: ++sourceRequestId.current });
    };
    window.addEventListener('dutydeck:show-history-turn', showSource);
    return () => window.removeEventListener('dutydeck:show-history-turn', showSource);
  }, [layout, readingScopeKey]);
  const sourceTarget = useMemo(() => requestedSource ? revealSource(timelineSections, requestedSource, sourceEvents ?? [], disclosures) : undefined, [requestedSource, timelineSections, sourceEvents, disclosures]);
  useEffect(() => {
    if (!sourceTarget || !isVisible) return;
    const frame = requestAnimationFrame(() => findSourceElement(sourceTarget)?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [sourceTarget, requestedSource, isVisible]);
  useLayoutEffect(() => {
    if (!requestedSource || !isVisible) return;
    const row = rowContaining(requestedSource.sequence);
    if (row) jumpToRow(row.id);
  }, [requestedSource, isVisible]);
  useEffect(() => {
    const progress = progressRef.current;
    if (!isVisible || !progress || !timelineScroll.isFollowing || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => timelineScroll.followContentResize());
    observer.observe(progress);
    return () => observer.disconnect();
  }, [readingScopeKey, timelineScroll.isFollowing, isVisible]);
  // 分享页：最新一轮以外的轮次都是「更早轮次」，在同一个容器里按时间排列；收起时那一行写最近一轮的时间。
  const earlierLast = share ? turns.at(-2) : undefined;
  const earlierLastAt = useMemo(() => earlierLast && (earlierLast.summary?.timestamp ?? liveTurnFacts(earlierLast.sections, false).startedAt), [earlierLast]);
  const earlierPlaces = useMemo(() => {
    const earlier = share ? turns.slice(0, -1) : [];
    const widths = new Set(earlier.map(turn => turnMomentWidth(turn.summary?.timestamp ?? liveTurnFacts(turn.sections, false).startedAt)));
    const width = widths.has('year') ? 'year' : widths.has('day') ? 'day' : 'clock';
    return new Map(earlier.map((turn, index): [string, EarlierPlace] => [turn.id,
      { index, count: earlier.length, lastAt: earlierLastAt, width, open: earlierOpen, onToggle: setEarlierOpen }]));
  }, [share, turns, earlierLastAt, earlierOpen, setEarlierOpen]);
  const content = <>
    {eventsLoading
      ? <TimelineSkeleton/>
      : turns.length
        ? <>
            {turns.length > 1 && !share && <TurnJumper turns={turns} onJump={jumpToTurn}/>}
            <div ref={listStartRef} aria-hidden="true" style={{ height: visible[0]?.top ?? 0 }}/>
            {visible.map(row => <MeasuredTurn key={row.id} id={row.id} onMeasure={height => {
              if (heights.get(row.id) === height) return;
              heights.set(row.id, height); setMeasureVersion(version => version + 1);
            }}>{share && activeSessionId ? <ShareTurn id={row.id} summary={row.summary} sections={row.sections} earlier={earlierPlaces.get(row.id)}/> : row.summary && activeSessionId ? <HistoryTurn sessionId={activeSessionId} summary={row.summary} activeOutputLabel={activeOutputLabel} requestedSource={requestedSource}/> : row.place && historyPlaces && activeSessionId ? <PendingHistoryTurn sessionId={activeSessionId} places={historyPlaces} index={row.placeIndex!} activeOutputLabel={activeOutputLabel} requestedSource={requestedSource}/> : <TimelineBody key={requestedSource && containsSource(row, requestedSource.sequence) ? requestedSource.requestId : undefined}
              timelineSections={row.sections} activeOutputLabel={activeOutputLabel}
              onResolvePermission={onResolvePermission} resolvingPermissionId={resolvingPermissionId}
              awaitingAnswer={awaitingAnswer && row.id === turns.at(-1)?.id}
              hasOngoingActivity={hasOngoingActivity} timeline={timeline} latestUserIndex={latestUserIndex}
            />}</MeasuredTurn>)}
            <div aria-hidden="true" style={{ height: Math.max(0, layout.height - ((visible.at(-1)?.top ?? 0) + (visible.at(-1)?.height ?? 0))) }}/>
          </>
        : !renderProgress && !hasOlder && <TimelineEmptyState/>}
    {renderProgress && <div ref={progressRef}>{renderProgress(!eventsLoading && !turns.length && !hasOlder ? <TimelineEmptyState/> : null)}</div>}
    {!eventsLoading && turns.length > 0 && footer}
  </>;
  return <TimelineDisclosureContext.Provider value={disclosures}><div className="relative min-h-0 flex-1 bg-canvas">
    <div ref={timelineScroll.containerRef} onScroll={onScroll}
      style={{ overflowAnchor: 'none' }} data-timeline-scroll="true" data-history-start={historyPlaces?.[0]?.[1] ?? historyTurns?.[0]?.firstSequence ?? timeline[0]?.sequence} data-history-loaded={loadedEventCount} data-history-complete={hasOlder === false} className="absolute inset-0 overscroll-contain overflow-y-auto">
      {share
        ? <div className="share-content">{header}<div className="share-layout share-gutter"><div className="share-main">{content}</div>{aside}</div></div>
        : <div className={`mx-auto w-full py-8 sm:py-10 ${fullWidth ? 'px-3 sm:px-5' : 'max-w-[880px] px-5 sm:px-8'}`}>{content}</div>}
    </div>
    {/* 历史全部加载完后这行提示只留给读屏，不再压在第一条消息上。 */}
    {!eventsLoading && loadedEventCount !== undefined && <div className={olderError || hasOlder ? 'absolute left-5 top-1 z-sticky rounded bg-canvas px-2 py-1 text-meta text-subtle' : 'sr-only'}>
      <span role="status">{olderError ? `已加载 ${loadedEventCount} 条，历史加载中断` : hasOlder ? `已加载 ${loadedEventCount} 条，正在加载全部历史…` : `已加载 ${historyPlaces?.length ?? historyTurns?.length ?? 0} 轮摘要、${loadedEventCount} 条原始记录`}</span>
      {olderError && <button onClick={() => void loadOlder?.()} className="ml-2 text-caption text-danger" title={olderError}>重试加载历史</button>}
    </div>}
    {!timelineScroll.isFollowing && !share && <ScrollToBottomButton onClick={() => { reading.following = true; reading.anchor = undefined; anchor.current = undefined; timelineScroll.scrollToBottom(); saveTimelineReadingState(); }}/>}
  </div></TimelineDisclosureContext.Provider>;
}

/**
 * A long session has one option per turn. Options exist only while the picker is in use:
 * tens of thousands of idle options cost a full relayout of the list on every live event.
 * They mount on pointerdown (synchronously, before the native list opens) or focus, and unmount on blur.
 * The width is fixed (and may shrink) so the browser does not measure every option's text to size it.
 */
const TurnJumper = memo(function TurnJumper({ turns, onJump }: { turns: TimelineTurn[]; onJump(id: string): void }) {
  const [active, setActive] = useState(false);
  const activate = () => { if (!active) flushSync(() => setActive(true)); };
  return <label className="mb-4 flex items-center gap-2 text-caption text-subtle">跳到轮次<select aria-label="跳到轮次" defaultValue="" onPointerDown={activate} onFocus={activate} onBlur={() => setActive(false)}
    onChange={event => { onJump(event.target.value); event.target.value = ''; }} className="w-64 min-w-0 max-w-full rounded border border-default bg-surface px-2 py-1">
    <option value="" disabled>选择历史轮次</option>
    {active && turns.map((turn, index) => <option key={turn.id} value={turn.id}>第 {index + 1} 轮{turn.summary ? ` · ${turn.summary.prompt.text.slice(0, 40)}` : turn.place ? ` · ${turn.place[4]}` : ' · 当前记录'}</option>)}
  </select></label>;
});

/** `tops` holds each row's top and, last, the list's end: the first row whose bottom reaches `y` (inclusive) or passes it, or -1. */
function firstRowEndingAfter(tops: Float64Array, y: number, inclusive: boolean) {
  let low = 0, high = tops.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1, bottom = tops[middle + 1]!;
    if (inclusive ? bottom >= y : bottom > y) high = middle; else low = middle + 1;
  }
  return low < tops.length - 1 ? low : -1;
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
  // Virtual rows remount during navigation; replaying translation moves the reading anchor.
  return <div ref={ref} data-timeline-turn={id} className="[&_.ui-timeline-item]:animate-none" style={{ display: 'flow-root' }}>{children}</div>;
}

function HistoryTurn({ sessionId, summary, activeOutputLabel, requestedSource }: { sessionId: string; summary: HistoryTurnSummary; activeOutputLabel: string; requestedSource?: HistorySource }) {
  const [open, setOpen] = useTimelineDisclosure(`history:${summary.id}`, false);
  const requested = requestedSource && requestedSource.sequence >= summary.firstSequence && requestedSource.sequence <= summary.lastSequence;
  useEffect(() => { if (requested) setOpen(true); }, [requestedSource]);
  const detail = useQuery({ queryKey: ['history-detail', sessionId, summary.firstSequence, summary.lastSequence],
    queryFn: ({ signal }) => loadTurnHistory(sessionId, summary, signal), enabled: open, staleTime: Infinity });
  const projector = useMemo(() => createTimelineProjector(), [summary.id]);
  const tasks = useQuery({ queryKey: ['tasks', sessionId], queryFn: () => api.tasks(sessionId), enabled: open, staleTime: Infinity });
  const { timeline } = useMemo(() => projector(detail.data ?? [], []), [projector, detail.data]);
  const timelineSections = useMemo(() => buildTimelineSections(timeline, tasks.data ?? [], false), [timeline, tasks.data]);
  const disclosures = useContext(TimelineDisclosureContext);
  const target = useMemo(() => requested && requestedSource ? revealSource(timelineSections, requestedSource, detail.data ?? [], disclosures) : undefined, [timelineSections, requestedSource, detail.data, disclosures]);
  useEffect(() => {
    if (!requested || !detail.isSuccess || !target) return;
    const frame = requestAnimationFrame(() => {
      findSourceElement(target)?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [requestedSource, detail.isSuccess, target]);
  const labels: Record<string, string> = { completed: '已完成', failed: '已失败', cancelled: '已取消', interrupted: '已中断', unverified: '结果未确认' };
  return <section data-history-summary={summary.id} className="my-4 border-b border-default pb-4">
    <div data-timeline-event={summary.id}>
      <div className="mb-2 whitespace-pre-wrap text-body text-primary">{summary.prompt.text || '历史执行记录'}{summary.prompt.truncated && <span className="text-caption text-subtle">（指令已截断，展开读取完整记录）</span>}</div>
      <div className="mb-3 text-meta text-subtle">{labels[summary.status] ?? summary.status} · {summary.toolCount} 次工具调用 · 事件 {summary.firstSequence}–{summary.lastSequence}{summary.artifactReferences.length > 0 && ` · ${summary.artifactReferences.length} 个产物引用`}{summary.artifactReferencesTruncated && '（引用清单已截断，展开查看全部）'}</div>
      {(!open || !detail.isSuccess) && summary.output.text && <div className="assistant-output markdown text-body text-primary"><MarkdownContent>{summary.output.text}</MarkdownContent></div>}
      {(!open || !detail.isSuccess) && summary.output.truncated && <p className="text-caption text-subtle">最终输出已截断；展开可读取完整内容。</p>}
    </div>
    <button className="my-2 min-h-10 text-caption text-info" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起完整记录' : '展开完整记录'}</button>
    {open && (detail.isPending ? <p role="status">正在读取完整记录…</p> : detail.isError ? <p role="alert">记录读取失败：{detail.error.message}<button onClick={() => void detail.refetch()} className="ml-2 text-info">重试</button></p> : <TimelineBody key={requested ? requestedSource?.requestId : undefined} timelineSections={timelineSections} timeline={timeline} latestUserIndex={-1} activeOutputLabel={activeOutputLabel} awaitingAnswer={false} hasOngoingActivity={false}/>)}
  </section>;
}

/** An earlier turn known only by its place: its page of summaries loads when it scrolls into view. */
function PendingHistoryTurn({ sessionId, places, index, activeOutputLabel, requestedSource }: { sessionId: string; places: HistoryTurnPlace[]; index: number; activeOutputLabel: string; requestedSource?: HistorySource }) {
  const place = places[index]!;
  const start = index - index % HISTORY_TURN_PAGE_SIZE, end = Math.min(places.length, start + HISTORY_TURN_PAGE_SIZE) - 1;
  const from = places[start]![1], through = places[end]![2];
  const page = useQuery({ queryKey: ['history-page', sessionId, from, through], queryFn: ({ signal }) => api.sessionHistoryTurns(sessionId, from, through, signal), staleTime: Infinity });
  const summary = page.data?.turns.find(turn => turn.id === place[0]);
  if (summary) return <HistoryTurn sessionId={sessionId} summary={summary} activeOutputLabel={activeOutputLabel} requestedSource={requestedSource}/>;
  return <section data-history-pending={place[0]} className="my-4 border-b border-default pb-4">
    <div className="mb-2 whitespace-pre-wrap text-body text-primary">{place[4] || '历史执行记录'}</div>
    {page.isError ? <p role="alert" className="text-caption">摘要读取失败：{page.error.message}<button onClick={() => void page.refetch()} className="ml-2 text-info">重试</button></p>
      : page.isSuccess ? <p className="text-caption text-subtle">这一轮的记录已变化，刷新页面后再查看。</p>
      : <p className="text-caption text-subtle">正在读取这一轮的摘要…</p>}
  </section>;
}

type HistorySource = { eventId?: string; sequence: number; requestId?: number };
function containsSource(row: TimelineTurn, sequence: number) {
  if (row.summary) return sequence >= row.summary.firstSequence && sequence <= row.summary.lastSequence;
  if (row.place) return sequence >= row.place[1] && sequence <= row.place[2];
  const sequences = row.sections.flatMap(section => section.kind === 'event' ? [section.event.sequence] : section.groups.flatMap(group => group.events.map(event => event.sequence))).filter(sequence => sequence > 0);
  const range = sequences.reduce((range, value) => ({ first: Math.min(range.first, value), last: Math.max(range.last, value) }), { first: Infinity, last: -Infinity });
  return sequence >= range.first && sequence <= range.last;
}
function findSourceElement(id: string) {
  return [...document.querySelectorAll<HTMLElement>('[data-timeline-event]')].find(element => element.dataset.timelineEvent === id);
}
function revealSource(sections: TimelineSection[], source: HistorySource, canonical: DockEvent[], choices?: Map<string, boolean>) {
  const original = canonical.find(event => event.sequence === source.sequence);
  const all = sections.flatMap(section => section.kind === 'event' ? [section.event] : section.groups.flatMap(group => group.events));
  const target = all.find(event => event.id === source.eventId)
    ?? (original?.type === 'tool_result' && original.data.id ? all.find(event => (event.type === 'tool_call' || event.type === 'tool_result') && event.data.id === original.data.id) : undefined)
    ?? all.filter(event => event.sequence >= source.sequence).sort((left, right) => left.sequence - right.sequence)[0];
  if (!target) return;
  for (const section of sections) if (section.kind === 'activity') for (const group of section.groups) if (group.events.includes(target)) {
    choices?.set(`activity:${section.groups[0]?.id ?? section.startedAt}:${section.hasAnswer}`, true);
    choices?.set(`group:${group.id}`, true);
    choices?.set(`tool:${target.id}`, true);
    choices?.set(`batch:${group.events[0]?.id}`, true);
  }
  return target.id;
}
