import { ArrowDown, MessageSquare } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useContext, type ReactNode } from 'react';
import type { TimelineEvent, TimelineSection } from '../timeline';
import { isNearScrollBottom, useTimelineAutoScroll } from '../useTimelineAutoScroll';
import { Button, EmptyState, Skeleton } from './primitives';
import { ActivityPanel } from './ActivityPanel';
import { TimelineDisclosureContext } from '../timeline-disclosure';
import { getTimelineReadingState, saveTimelineReadingState, type TimelineReadingAnchor } from '../timeline-reading-state';
import { TimelineItem } from './TimelineItem';
import { useQuery } from '@tanstack/react-query';
import { api, type DockEvent, type HistoryTurnSummary } from '../api';
import { loadTurnHistory } from '../event-history';
import { buildTimelineSections, createTimelineProjector } from '../timeline';
import { useTimelineDisclosure } from '../timeline-disclosure';
import { MarkdownContent } from '../MarkdownContent';

export type TimelineViewProps = {
  activeSessionId?: string;
  historyTurns?: HistoryTurnSummary[];
  sourceEvents?: DockEvent[];
  readingScopeKey?: string;
  visible?: boolean;
  hasOlder?: boolean;
  loadedEventCount?: number;
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

type TimelineTurn = { id: string; sections: TimelineSection[]; summary?: HistoryTurnSummary };
type TimelineRow = TimelineTurn & { top: number; height: number };

export function TimelineView({ historyTurns, sourceEvents, activeSessionId, readingScopeKey = activeSessionId ?? 'empty', visible: isVisible = true, eventsLoading, onResolvePermission, resolvingPermissionId, timeline, timelineSections, awaitingAnswer, hasOngoingActivity, latestUserIndex, activeOutputLabel, footer, renderProgress, hasOlder, loadedEventCount, olderError, loadOlder }: TimelineViewProps) {
  const reading = useMemo(() => getTimelineReadingState(readingScopeKey), [readingScopeKey]);
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
  const previousFirst = useRef<{ id: string; events: Set<string> } | undefined>(undefined);
  const previousScope = useRef(readingScopeKey);
  if (previousScope.current !== readingScopeKey) {
    turnAliases.current.clear(); previousFirst.current = undefined;
    previousScope.current = readingScopeKey;
  }
  const turnCache = useMemo(() => new WeakMap<TimelineSection, TimelineTurn>(), [readingScopeKey]);
  const rowCache = useMemo(() => new WeakMap<TimelineTurn, TimelineRow>(), [readingScopeKey]);
  const summaryTurns = useMemo(() => (historyTurns ?? []).map(summary => ({ id: summary.id, sections: [], summary })), [historyTurns]);
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
    return [...summaryTurns, ...result];
  }, [timelineSections, turnCache, summaryTurns]);
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
  const restoredRow = anchor.current && (layout.rows.find(row => row.id === anchor.current!.id) ?? layout.rows.find(row => row.sections.some(section => section.kind === 'event' ? section.event.id === anchor.current!.eventId : section.groups.some(group => group.events.some(event => event.id === anchor.current!.eventId)))));
  const top = !timelineScroll.isFollowing && Number.isFinite(viewport.top) ? (restoredRow ? restoredRow.top + anchor.current!.offset : viewport.top) : Math.max(0, layout.height - viewport.height);
  const firstMatch = layout.rows.findIndex(row => row.top + row.height >= top - 800);
  const first = firstMatch < 0 ? Math.max(0, layout.rows.length - 1) : firstMatch;
  let last = first;
  while (last < layout.rows.length && layout.rows[last]!.top <= top + viewport.height + 800) last++;
  const visible = layout.rows.slice(first, last);
  const syncViewport = (captureAnchor = true) => {
    const container = timelineScroll.containerRef.current;
    if (!container || !isVisible) return;
    setViewport({ top: container.scrollTop, height: container.clientHeight || 960 });
    if (!captureAnchor) return;
    const containerTop = container.getBoundingClientRect().top;
    // A scroll can precede mounting its new virtual window. Do not capture
    // an overscan event still far below the visible viewport.
    const element = [...container.querySelectorAll<HTMLElement>('[data-timeline-event]')].find(element => { const rect = element.getBoundingClientRect(); return rect.bottom > containerTop && rect.top < containerTop + container.clientHeight; });
    const rowId = element?.closest<HTMLElement>('[data-timeline-turn]')?.dataset.timelineTurn;
    const row = layout.rows.find(row => row.id === rowId) ?? layout.rows.find(row => row.top + row.height > container.scrollTop);
    anchor.current = row ? { id: row.id, offset: container.scrollTop - row.top,
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
        const row = layout.rows.find(row => row.id === anchor.current!.id);
        if (row) container.scrollTop = row.top + anchor.current.offset;
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
    const scrollTop = timelineScroll.containerRef.current?.scrollTop;
    if (scrollTop === programmedScrollTop.current) { syncViewport(false); return; }
    programmedScrollTop.current = undefined;
    timelineScroll.onScroll(); syncViewport();
    const container = timelineScroll.containerRef.current;
    if (container) reading.following = isNearScrollBottom(container);
  };
  const jumpToRow = (id: string) => {
    const row = layout.rows.find(row => row.id === id);
    const container = timelineScroll.containerRef.current;
    if (!row || !container) return;
    reading.following = false; anchor.current = { id: row.id, offset: 0, eventId: row.id, screenOffset: 0 };
    container.scrollTop = row.top; programmedScrollTop.current = undefined;
    timelineScroll.onScroll(); syncViewport(false);
  };
  useEffect(() => {
    const showSource = (event: Event) => {
      const source = (event as CustomEvent<HistorySource>).detail;
      if (!source || !Number.isSafeInteger(source.sequence)) return;
      const row = layout.rows.find(row => containsSource(row, source.sequence));
      if (row) setRequestedSource({ ...source, requestId: ++sourceRequestId.current });
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
    const row = layout.rows.find(row => containsSource(row, requestedSource.sequence));
    if (row) jumpToRow(row.id);
  }, [requestedSource, isVisible]);
  useEffect(() => {
    const progress = progressRef.current;
    if (!isVisible || !progress || !timelineScroll.isFollowing || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => timelineScroll.followContentResize());
    observer.observe(progress);
    return () => observer.disconnect();
  }, [readingScopeKey, timelineScroll.isFollowing, isVisible]);
  return <TimelineDisclosureContext.Provider value={disclosures}><div className="relative min-h-0 flex-1 bg-canvas">
    <div ref={timelineScroll.containerRef} onScroll={onScroll}
      style={{ overflowAnchor: 'none' }} data-timeline-scroll="true" data-history-start={historyTurns?.[0]?.firstSequence ?? timeline[0]?.sequence} data-history-loaded={loadedEventCount} data-history-complete={hasOlder === false} className="absolute inset-0 overscroll-contain overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-5 py-8 sm:px-8 sm:py-10">
        {eventsLoading
          ? <TimelineSkeleton/>
          : turns.length
            ? <>
                {turns.length > 1 && <label className="mb-4 flex items-center gap-2 text-caption text-subtle">跳到轮次<select aria-label="跳到轮次" defaultValue="" onChange={event => { jumpToRow(event.target.value); event.target.value = ''; }} className="max-w-64 rounded border border-default bg-surface px-2 py-1"><option value="" disabled>选择历史轮次</option>{turns.map((turn, index) => <option key={turn.id} value={turn.id}>第 {index + 1} 轮{turn.summary ? ` · ${turn.summary.prompt.text.slice(0, 40)}` : ' · 当前记录'}</option>)}</select></label>}
                <div aria-hidden="true" style={{ height: visible[0]?.top ?? 0 }}/>
                {visible.map(row => <MeasuredTurn key={row.id} id={row.id} onMeasure={height => {
                  if (heights.get(row.id) === height) return;
                  heights.set(row.id, height); setMeasureVersion(version => version + 1);
                }}>{row.summary && activeSessionId ? <HistoryTurn sessionId={activeSessionId} summary={row.summary} activeOutputLabel={activeOutputLabel} requestedSource={requestedSource}/> : <TimelineBody key={requestedSource && containsSource(row, requestedSource.sequence) ? requestedSource.requestId : undefined}
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
      </div>
    </div>
    {/* 历史全部加载完后这行提示只留给读屏，不再压在第一条消息上。 */}
    {!eventsLoading && loadedEventCount !== undefined && <div className={olderError || hasOlder ? 'absolute left-5 top-1 z-sticky rounded bg-canvas px-2 py-1 text-meta text-subtle' : 'sr-only'}>
      <span role="status">{olderError ? `已加载 ${loadedEventCount} 条，历史加载中断` : hasOlder ? `已加载 ${loadedEventCount} 条，正在加载全部历史…` : `已加载 ${historyTurns?.length ?? 0} 轮摘要、${loadedEventCount} 条原始记录`}</span>
      {olderError && <button onClick={() => void loadOlder?.()} className="ml-2 text-caption text-danger" title={olderError}>重试加载历史</button>}
    </div>}
    {!timelineScroll.isFollowing && <ScrollToBottomButton onClick={() => { reading.following = true; reading.anchor = undefined; anchor.current = undefined; timelineScroll.scrollToBottom(); saveTimelineReadingState(); }}/>}
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
      {(!open || !detail.isSuccess) && summary.output.text && <MarkdownContent>{summary.output.text}</MarkdownContent>}
      {(!open || !detail.isSuccess) && summary.output.truncated && <p className="text-caption text-subtle">最终输出已截断；展开可读取完整内容。</p>}
    </div>
    <button className="my-2 min-h-10 text-caption text-info" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起完整记录' : '展开完整记录'}</button>
    {open && (detail.isPending ? <p role="status">正在读取完整记录…</p> : detail.isError ? <p role="alert">记录读取失败：{detail.error.message}<button onClick={() => void detail.refetch()} className="ml-2 text-info">重试</button></p> : <TimelineBody key={requested ? requestedSource?.requestId : undefined} timelineSections={timelineSections} timeline={timeline} latestUserIndex={-1} activeOutputLabel={activeOutputLabel} awaitingAnswer={false} hasOngoingActivity={false}/>)}
  </section>;
}

type HistorySource = { eventId?: string; sequence: number; requestId?: number };
function containsSource(row: TimelineTurn, sequence: number) {
  if (row.summary) return sequence >= row.summary.firstSequence && sequence <= row.summary.lastSequence;
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
