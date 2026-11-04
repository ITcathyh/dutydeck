import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, CircleAlert, Copy, Sparkles } from 'lucide-react';
import type { HistoryTurnSummary, Task } from '../api';
import { loadTurnHistory } from '../event-history';
import { buildTimelineSections, createTimelineProjector, type TimelineSection } from '../timeline';
import { useTimelineDisclosure } from '../timeline-disclosure';
import { elapsedMilliseconds, formatElapsed } from '../tool-presentation';
import { MarkdownContent } from '../MarkdownContent';
import { finalSection, formatTurnMoment, liveTurnFacts, recordSections, rhythmBarHeight, rhythmBucketCount, rhythmBuckets, displayCommand, rhythmLiveSpan, shareNowLine, summaryTurnFacts, turnStatusLabels, turnTone, type ShareStatus, type MomentWidth, type ToolSpan, type TurnFacts } from '../share-view';
import { EventContent } from './EventContent';
import { ActivityGroupPanel, ToolDetailFormat } from './ToolCard';
import { TimelineItem } from './TimelineItem';

/*
  分享页（TimelineView variant="share"）的一轮：结论卡是主角，提问只在和标题不同时用小号引语出现，
  执行过程收成一行加节律条。更早的轮次在当前轮上方收成一行，点开是同样的结论卡。
  展开的完整记录沿用工作台的工具卡与只读授权卡，历史轮次仍按需读取。
*/

export type ShareContextValue = {
  sessionId: string;
  title: string;
  modelLabel: string;
  status: ShareStatus;
  /** 会话正在执行（只作用于最新一轮）。 */
  running: boolean;
  errorSummary?: string;
  tasks?: Task[];
  copied: boolean;
  copyConclusion(markdown: string): void;
};
export const ShareContext = createContext<ShareContextValue | undefined>(undefined);
const useShare = () => useContext(ShareContext)!;

/** 执行中每秒刷新一次的当前时间；不在执行时不起定时器。 */
export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** 历史轮次的完整记录：和工作台同一个缓存键，展开时才读。 */
export function useHistoryTurnDetail(sessionId: string, summary: HistoryTurnSummary | undefined, tasks: Task[] | undefined, enabled: boolean) {
  const query = useQuery({ queryKey: ['history-detail', sessionId, summary?.firstSequence, summary?.lastSequence],
    queryFn: ({ signal }) => loadTurnHistory(sessionId, summary!, signal), enabled: enabled && Boolean(summary), staleTime: Infinity });
  const projector = useMemo(() => createTimelineProjector(), [summary?.id]);
  const sections = useMemo(() => query.data ? buildTimelineSections(projector(query.data, []).timeline, tasks ?? [], false) : undefined, [projector, query.data, tasks]);
  return { query, sections };
}

/**
 * 更早轮次在容器里的位置；lastAt 是最近一轮更早轮次的开始时间，用于收起时的那一行。
 * open 是两轮及以上时「更早 N 轮」的总开关，由时间线按会话保存，收起的轮次不进虚拟列表。
 */
export type EarlierPlace = { index: number; count: number; lastAt?: string; width: MomentWidth; open: boolean; onToggle(open: boolean): void };

export const ShareTurn = memo(function ShareTurn({ id, summary, sections, earlier }: { id: string; summary?: HistoryTurnSummary; sections: TimelineSection[]; earlier?: EarlierPlace }) {
  return summary ? <HistoryShareTurn id={id} summary={summary} earlier={earlier}/> : <LiveShareTurn id={id} sections={sections} earlier={earlier}/>;
});

function LiveShareTurn({ id, sections, earlier }: { id: string; sections: TimelineSection[]; earlier?: EarlierPlace }) {
  const latest = !earlier;
  const share = useShare();
  const running = latest && share.running;
  const facts = useMemo(() => liveTurnFacts(sections, running), [sections, running]);
  const [open, setOpen] = useTimelineDisclosure(`share-record:${id}`, false);
  return <ShareTurnView id={id} facts={facts} latest={latest} running={running} recordOpen={open} onRecordToggle={setOpen}
    record={<ShareRecord sections={facts.record} running={running}/>} earlier={earlier}/>;
}

function HistoryShareTurn({ id, summary, earlier }: { id: string; summary: HistoryTurnSummary; earlier?: EarlierPlace }) {
  const share = useShare();
  const latest = !earlier;
  const [open, setOpen] = useTimelineDisclosure(`share-record:${id}`, false);
  // 最新一轮的结论被摘要截断时，直接读完整记录补全结论卡。
  const detail = useHistoryTurnDetail(share.sessionId, summary, share.tasks, open || (latest && summary.output.truncated));
  const task = share.tasks?.find(item => item.id === summary.taskId);
  const facts = useMemo(() => {
    const base = summaryTurnFacts(summary, task);
    const final = detail.sections && finalSection(detail.sections);
    return final ? { ...base, output: final.event.data, outputTruncated: false } : base;
  }, [summary, task, detail.sections]);
  const record = detail.query.isPending
    ? <p role="status" className="share-record-note">正在读取完整记录…</p>
    : detail.query.isError
      ? <p role="alert" className="share-record-note">记录读取失败：{detail.query.error.message}<button type="button" onClick={() => void detail.query.refetch()} className="share-text-button">重试</button></p>
      : <ShareRecord sections={recordSections(detail.sections ?? [])} running={false}/>;
  return <ShareTurnView id={id} facts={facts} latest={latest} running={false} recordOpen={open} onRecordToggle={setOpen} record={record} earlier={earlier}/>;
}

function ShareTurnView({ id, facts, latest, running, recordOpen, onRecordToggle, record, earlier }: { id: string; facts: TurnFacts; latest: boolean; running: boolean; recordOpen: boolean; onRecordToggle(open: boolean): void; record: ReactNode; earlier?: EarlierPlace }) {
  const share = useShare();
  const [expanded, setExpanded] = useTimelineDisclosure(`share-turn:${id}`, false);
  const prompt = facts.prompt?.trim();
  const statusLabel = latest && (running || share.status.tone === 'failed') ? share.status.label : turnStatusLabels[facts.status] ?? facts.status;
  const text = facts.output?.text?.trim();
  const failure = (latest ? share.errorSummary : undefined) ?? (facts.status === 'failed' && !text ? '任务执行失败，未产生最终输出。' : undefined);
  const body = <>
    {prompt && prompt !== share.title.trim() && <blockquote className="share-quote">{prompt}</blockquote>}
    {failure && <ShareFailureCard reason={failure} hasOutput={Boolean(text)}/>}
    {text || extraParts(facts.output).length
      ? <ShareConclusion facts={facts} latest={latest}/>
      : running
        ? <ShareLiveConclusion facts={facts} tone={share.status.tone}/>
        : !failure && <article className="share-card share-rise"><div className="share-card-label"><Sparkles size={14}/>结论</div><p className="share-muted">{missingOutputText(facts.status)}</p></article>}
    <ShareTrace facts={facts} running={running} statusLabel={statusLabel} open={recordOpen} onToggle={onRecordToggle}>{record}</ShareTrace>
  </>;
  if (!earlier) return <section data-timeline-event={id} aria-label="本轮结论" className="share-turn">{body}</section>;
  // 更早轮次共用一个安静的容器：每轮一行，行间细线；两轮及以上默认收成「更早 N 轮」一行。
  const grouped = earlier.count > 1;
  const head = grouped && earlier.index === 0 && <button type="button" aria-expanded={earlier.open} onClick={() => earlier.onToggle(!earlier.open)} className="share-earlier-head">
    <span className="share-earlier-prompt">更早 {earlier.count} 轮{earlier.lastAt && ` · 最近 ${formatTurnMoment(earlier.lastAt)}`}</span>
    <ChevronDown size={14} className="share-chevron"/>
  </button>;
  // 收起的那一行和展开后的第一轮是同一个元素、同一个 data-timeline-event：时间线按它校正滚动，点开后这一行停在原处。
  if (grouped && !earlier.open) return earlier.index === 0 ? <section data-timeline-event={id} data-first="" data-last="" className="share-earlier">{head}</section> : null;
  const statusText = turnStatusLabels[facts.status] ?? facts.status;
  return <section data-timeline-event={id} data-first={earlier.index === 0 || undefined} data-last={earlier.index === earlier.count - 1 || undefined} data-open={expanded || undefined} className="share-earlier">
    {head}
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="share-earlier-line">
      <span data-width={earlier.width} className="share-earlier-time">{formatTurnMoment(facts.startedAt)}</span>
      <span className="share-earlier-prompt">{prompt || '历史执行记录'}</span>
      <span data-tone={turnTone(facts.status)} title={statusText} className="share-earlier-status"><span className="share-dot" aria-hidden="true"/><span className="sr-only">{statusText}</span></span>
    </button>
    {expanded && <div className="share-earlier-body">{body}</div>}
  </section>;
}

/** 最终输出里文字以外的内容（图片、资源引用）；文字部分已经在 text 里。 */
const extraParts = (output: TurnFacts['output']) => {
  const parts = output?.parts;
  return Array.isArray(parts) ? parts.filter(part => part && typeof part === 'object' && (part as { type?: unknown }).type !== 'text') : [];
};
const missingOutputText = (status: string) => status === 'interrupted' || status === 'cancelled' ? '任务已中断，未产生最终输出。'
  : status === 'unverified' || status === 'reconcile_required' ? '这一轮的执行结果未确认。' : 'Agent 未返回最终输出。';

function ShareConclusion({ facts, latest }: { facts: TurnFacts; latest: boolean }) {
  const share = useShare();
  const text = facts.output?.text?.trim() ?? '';
  const parts = extraParts(facts.output);
  return <>
    <article aria-label={`${share.modelLabel} 结论`} className="share-card share-rise">
      <div className="share-card-label"><Sparkles size={14}/>结论</div>
      <div className="share-prose">
        {text && <MarkdownContent variant="share">{text}</MarkdownContent>}
        {parts.length > 0 && <EventContent data={{ parts }}/>}
      </div>
      {facts.outputTruncated && <p className="share-muted share-note">结论较长，这里只显示开头；展开下方执行过程可读取完整记录。</p>}
    </article>
    {latest && text && <div className="share-narrow-only share-inline-actions">
      <CopyConclusionButton markdown={text}/>
    </div>}
  </>;
}

export function CopyConclusionButton({ markdown, compact = false }: { markdown: string; compact?: boolean }) {
  const share = useShare();
  return <button type="button" data-primary="" data-copied={share.copied || undefined} aria-label={compact ? share.copied ? '已复制' : '复制结论' : undefined} onClick={() => share.copyConclusion(markdown)} className={compact ? 'share-button share-button-compact' : 'share-button'}>
    {share.copied ? <Check size={15}/> : <Copy size={15}/>}<span className={compact ? 'share-button-label' : undefined}>{share.copied ? '已复制' : '复制结论'}</span>
  </button>;
}

/** 执行中：取最近一次工具调用的说明做字幕，不编造进度。 */
function ShareLiveConclusion({ facts, tone }: { facts: TurnFacts; tone: ShareStatus['tone'] }) {
  const line = shareNowLine(facts.lastTool);
  return <article aria-live="polite" aria-label="结论生成中" data-tone={tone} className="share-card share-live share-rise">
    <div className="share-card-label"><Sparkles size={14}/>结论生成中</div>
    <div className="share-now">
      <p key={`${facts.lastTool?.id ?? ''}:${line.detail ?? ''}`} data-command={line.command || undefined} className="share-now-line">
        <span className="share-now-key">{line.action}</span>{' '}
        {line.detail && <>{line.command ? <code className="share-now-code">{line.detail}</code> : line.detail}{' '}</>}…
      </p>
    </div>
    <div className="share-skeleton" aria-hidden="true"><i/><i/><i/></div>
    <p className="share-muted share-note">完成后结论会出现在这里，页面会自动更新，不用刷新。</p>
  </article>;
}

/** 失败原因；用时与调用次数已在侧栏和执行过程里，这里不重复。 */
export function ShareFailureCard({ reason, hasOutput = false }: { reason: string; hasOutput?: boolean }) {
  return <article role="alert" className="share-failure share-rise">
    <h2 className="share-failure-title"><CircleAlert size={20}/>{hasOutput ? '执行失败' : '执行失败，没有得到结论'}</h2>
    <p className="share-failure-reason">{reason}</p>
  </article>;
}

function ShareTrace({ facts, running, statusLabel, open, onToggle, children }: { facts: TurnFacts; running: boolean; statusLabel: string; open: boolean; onToggle(open: boolean): void; children: ReactNode }) {
  const share = useShare();
  const now = useNow(running);
  const elapsed = formatElapsed(elapsedMilliseconds(facts.startedAt, running ? undefined : facts.endedAt, now));
  return <section aria-label={`${share.modelLabel} 执行过程`} data-open={open || undefined} className="share-trace share-rise">
    <button type="button" aria-expanded={open} onClick={() => onToggle(!open)} className="share-trace-head">
      <span className="share-trace-title">执行过程</span>
      <span className="share-trace-sub">{[`${facts.toolCount} 次工具调用`, elapsed, statusLabel].filter(Boolean).join(' · ')}</span>
      <span className="share-trace-chevron"><ChevronDown size={16}/></span>
    </button>
    {facts.spans && facts.spans.length > 0 && facts.startedAt && <ShareRhythm spans={facts.spans} startedAt={facts.startedAt} endedAt={running ? undefined : facts.endedAt} running={running} now={now}/>}
    {open && <div className="share-trace-body">{children}</div>}
  </section>;
}

/**
 * 节律条：按时间分桶的直方图，横轴是这一轮从开始到结束，柱高是桶内调用次数的平方根。
 * 空桶画成淡色短桩，整条读作连续的时间轴；两端的小字是起止时刻。
 * 执行中横轴取 rhythmLiveSpan 的整档长度：最后一个有调用的桶发光，发光圆点标出此刻；横轴末端不是真实时刻，不写时间。
 */
function ShareRhythm({ spans, startedAt, endedAt, running, now }: { spans: ToolSpan[]; startedAt: string; endedAt?: string; running: boolean; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(48);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setCount(rhythmBucketCount(entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const origin = Date.parse(startedAt);
  const last = Math.max(...spans.map(([start, end]) => end ?? start));
  const finish = endedAt ? Date.parse(endedAt) : running ? origin + rhythmLiveSpan(Math.max(now, last) - origin) : last;
  const buckets = rhythmBuckets(spans.map(([start]) => start), origin, finish, count);
  const max = Math.max(...buckets);
  const lastFilled = buckets.reduce((last, value, index) => value > 0 ? index : last, -1);
  const head = finish > origin ? Math.min(100, Math.max(0, (now - origin) / (finish - origin) * 100)) : 100;
  return <div aria-hidden="true" className="share-rhythm">
    <div ref={ref} className="share-rhythm-bars">
      {buckets.map((value, index) => <i key={index} data-empty={value ? undefined : ''} data-live={running && index === lastFilled ? '' : undefined} style={value ? { height: rhythmBarHeight(value, max) } : undefined}/>)}
      {running && <span className="share-rhythm-head" style={{ left: `${head}%` }}/>}
    </div>
    <div className="share-rhythm-axis"><span>{formatTurnMoment(startedAt, now)}</span>{!running && <span>{formatTurnMoment(new Date(finish).toISOString(), now)}</span>}</div>
  </div>;
}

function ShareRecord({ sections, running }: { sections: TimelineSection[]; running: boolean }) {
  if (!sections.length) return <p className="share-record-note">这一轮没有工具调用或中间记录。</p>;
  // 工具卡沿用工作台组件，只在这里把标题里的命令缩写成和字幕一样的写法；悬停仍能看到原文。
  return <ToolDetailFormat.Provider value={displayCommand}><div className="share-record">{sections.map(section => section.kind === 'activity'
    ? section.groups.map((group, index) => <ActivityGroupPanel key={group.id} group={group} ongoing={running && index === section.groups.length - 1}/>)
    : <div key={section.event.id} data-timeline-event={section.event.id} style={{ display: 'flow-root' }}><TimelineItem event={section.event} final={section.final}/></div>)}</div></ToolDetailFormat.Provider>;
}
