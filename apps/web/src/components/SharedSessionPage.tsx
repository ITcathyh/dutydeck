import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Link2Off, MessageSquareText, UserRound, Users } from 'lucide-react';
import { api, ApiError, type DockEvent, type Session } from '../api';
import { createTimelineProjector, hasAnswerSince, type TimelineSection } from '../timeline';
import { useEventHistory } from '../useEventHistory';
import { sessionDisplayName } from '../run-summary';
import { sessionErrorSummary } from '../workspace-model';
import { useSessionStream } from '../useSessionStream';
import { useTheme } from '../useTheme';
import { copyToClipboard } from '../clipboard';
import { push as pushToast } from '../useToasts';
import { elapsedMilliseconds, formatElapsed } from '../tool-presentation';
import { conclusionPlainText, finalSection, formatTurnSpan, liveTurnFacts, shareableEvents, shareStatus, summaryTurnFacts, type ShareStatus, type TurnFacts } from '../share-view';
import { busyStates, DutydeckIcon } from './ui';
import { Banner, Card, EmptyState, Spinner } from './primitives';
import { TimelineView } from './TimelineView';
import { CopyConclusionButton, ShareContext, ShareFailureCard, useHistoryTurnDetail, useNow, type ShareContextValue } from './ShareTurn';
import { ToastViewport } from './ToastViewport';

/**
 * 飞书卡片「查看详情」打开的只读分享页：只有这一个任务的状态、执行记录和结果。
 *
 * 数据走和工作台同一套接口与缓存键（['sessions'] 里只放这一个会话），实时流因此能原样复用
 * useSessionStream；请求都带着分享 token（api.ts 的 withShareToken），服务端只放行这个会话的读接口。
 * 页面上没有侧栏、任务列表、设置，也没有链回工作台的入口；不给任何写操作——授权卡只显示状态。
 *
 * 读者是飞书群里的同事：英雄区是提问，主角是结论卡；宽屏（≥1200px）右侧 sticky 侧栏放来源与本次执行，
 * 窄屏把来源收成链接胶囊。滚过英雄区后，滚动容器外的毛玻璃细条接替标题、状态和复制按钮。
 */
export function SharedSessionPage({ sessionId }: { sessionId: string }) {
  useTheme();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: async () => [await api.session(sessionId)], retry: false, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const session = sessions.data?.[0];
  const events = useEventHistory(sessionId, Boolean(session));
  const tasks = useQuery({ queryKey: ['tasks', sessionId], queryFn: () => api.tasks(sessionId), enabled: Boolean(session) });
  const streamStatus = useSessionStream(session ? sessionId : undefined, session?.runId, events.isSuccess);
  // 后台任务结束后的回答不属于任何一轮：投影前就去掉，否则只有它一条实时事件时会被当成「最新一轮」，盖掉历史结论和状态。
  const eventList = useMemo(() => shareableList(events.data?.events ?? noEvents), [events.data?.events]);
  const eventDelta = useMemo(() => events.data && { previousEvents: events.data.previousEvents && shareableList(events.data.previousEvents), changes: events.data.changes && shareableEvents(events.data.changes) }, [events.data]);
  const projectTimeline = useMemo(() => createTimelineProjector(), [sessionId]);
  const historyTurns = events.data?.outline?.turns;
  const visibleTasks = useMemo(() => { const summarized = new Set(historyTurns?.map(turn => turn.taskId)); return tasks.data?.filter(task => !summarized.has(task.id)); }, [tasks.data, historyTurns]);
  const { timeline, timelineSections } = useMemo(() => projectTimeline(eventList, visibleTasks, events.data?.hasOlder, eventDelta), [projectTimeline, eventList, visibleTasks, events.data?.hasOlder]);
  const latestUserIndex = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index--) if (timeline[index].type === 'text' && timeline[index].data.role === 'user') return index;
    return -1;
  }, [timeline]);
  const awaitingAnswer = busyStates.has(session?.state ?? '') && latestUserIndex >= 0 && !hasAnswerSince(timeline, latestUserIndex);
  const hasOngoingActivity = timelineSections.some(section => section.kind === 'activity' && section.isLatestTurn && awaitingAnswer);
  const running = Boolean(session && !session.archivedAt && busyStates.has(session.state));

  // 页头、侧栏和细条描述的是最新一轮：实时记录里有就取最后一轮，否则取最后一条历史摘要。
  const latestLive = useMemo(() => latestLiveTurn(timelineSections), [timelineSections]);
  const latestSummary = latestLive ? undefined : historyTurns?.at(-1);
  const latestDetail = useHistoryTurnDetail(sessionId, latestSummary, tasks.data, Boolean(latestSummary?.output.truncated));
  // 记录和任务都读完前，最新一轮的次数、用时和状态都还不可信（只有任务时会算出「0 次」「未完成」），先不显示。
  const timelineReady = events.isSuccess && !events.data.hasOlder && !tasks.isPending;
  const latest = useMemo<TurnFacts | undefined>(() => {
    if (!timelineReady) return;
    if (latestLive) return liveTurnFacts(latestLive, running);
    if (!latestSummary) return;
    const facts = summaryTurnFacts(latestSummary, tasks.data?.find(task => task.id === latestSummary.taskId));
    const final = latestDetail.sections && finalSection(latestDetail.sections);
    return final ? { ...facts, output: final.event.data, outputTruncated: false } : facts;
  }, [timelineReady, latestLive, latestSummary, latestDetail.sections, running, tasks.data]);

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copyConclusion = useCallback(async (markdown: string) => {
    const ok = await copyToClipboard(conclusionPlainText(markdown, window.location.href));
    pushToast(ok ? { kind: 'success', title: '结论已复制', description: '可以直接粘贴到飞书。', key: 'share-copy' } : { kind: 'error', title: '复制失败', description: '浏览器没有允许写入剪贴板，请手动选中结论复制。', key: 'share-copy' });
    if (!ok) return;
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1_800);
  }, []);

  const heroRef = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const onScrollTop = useCallback((top: number) => {
    const hero = heroRef.current;
    setCollapsed(Boolean(hero) && top > hero!.offsetTop + hero!.offsetHeight - 40);
  }, []);

  const firstPrompt = [...(tasks.data ?? [])].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).find(task => task.prompt?.trim())?.prompt.trim();
  const title = session ? sessionDisplayName(session, firstPrompt, '任务详情') : '';
  const status = useMemo(() => session ? shareStatus(session, latest?.status) : { label: '', tone: 'neutral' as const }, [session, latest?.status]);
  // 会话状态本身说明不了结局（空闲、已停止等）时，等最新一轮读完再显示状态，避免先闪一下「待开始」。
  const statusSettled = timelineReady || status.tone !== 'neutral';
  const errorSummary = sessionErrorSummary(session?.error);
  const modelLabel = session ? session.model ?? session.agentId : '';
  const context = useMemo<ShareContextValue>(() => ({ sessionId, title, modelLabel, status, running, errorSummary, tasks: tasks.data, copied, copyConclusion: markdown => void copyConclusion(markdown) }),
    [sessionId, title, modelLabel, status, running, errorSummary, tasks.data, copied, copyConclusion]);

  if (sessions.isPending) return <main className="grid min-h-[100dvh] place-items-center bg-canvas"><Spinner size="sm" label="正在打开任务详情…"/></main>;
  if (!session) {
    // 401/404 都是同一句：不区分「链接被改过」「密钥已轮换」「任务不存在」，也不给工作台入口。
    const unavailable = sessions.error instanceof ApiError && [401, 403, 404].includes(sessions.error.status);
    return <main className="grid min-h-[100dvh] place-items-center bg-canvas p-5">
      <Card as="section" padding="lg" className="w-full max-w-md">
        <EmptyState icon={<Link2Off size={22}/>} title={unavailable ? '链接无效或已失效' : '暂时打不开这个任务'}
          description={unavailable ? '请回到飞书卡片重新点「查看详情」；如果仍然打不开，请联系机器人管理员。' : sessions.error?.message ?? '请稍后刷新重试。'}/>
      </Card>
    </main>;
  }

  const queued = tasks.data?.filter(task => task.status === 'queued').length ?? 0;
  const output = latest?.output?.text?.trim();
  const source = session.sourceContext;
  // 连接正常时不显示同步状态；只有重连或补记录失败时才提示。
  const syncProblem = typeof streamStatus === 'string'
    ? streamStatus === 'reconnecting' ? '正在重连' : undefined
    : streamStatus.content === 'failed' ? streamStatus.retrying ? '记录同步失败，正在重试' : '记录同步失败' : streamStatus.transport === 'reconnecting' ? '正在重连' : undefined;
  const header = <>
    <div className="share-aura" aria-hidden="true"><i/><i/><i/></div>
    <header className="share-brand share-gutter">
      <DutydeckIcon className="share-brand-icon"/><span>dutydeck</span><span className="share-agent">{modelLabel}</span>
    </header>
    <section ref={heroRef} aria-label="提问" className="share-hero share-gutter">
      <p className="share-eyebrow share-rise"><span className="share-eyebrow-tag">提问</span>{source?.initiator && eyebrowWho(source.initiator) && <span className="share-eyebrow-who">{eyebrowWho(source.initiator)}</span>}</p>
      <h1 className="share-title share-rise" data-quoted={firstPrompt || session.name?.trim() ? '' : undefined}>{title}</h1>
      <div className="share-meta share-rise">
        {statusSettled && <StatusPill status={status} running={running} startedAt={latest?.startedAt}/>}
        <TurnSpan facts={latest} running={running}/>
        {latest && <span className="share-narrow-only share-meta-run"><RunSummary facts={latest} running={running}/></span>}
        {queued > 0 && <span className="share-queue">待执行指令 {queued} 条</span>}
        {syncProblem && <span role="status" className="share-sync">{syncProblem}{typeof streamStatus !== 'string' && streamStatus.content === 'failed' && !streamStatus.retrying && <button type="button" onClick={streamStatus.retry} className="share-text-button">重试同步</button>}</span>}
      </div>
      {/* 窄屏只放能点的来源；没有记录话题时不放占位胶囊。 */}
      {source && <div className="share-narrow-only share-chips share-rise">
        {source.topic && <a href={source.topic.url} target="_blank" rel="noreferrer" title={source.topic.id} className="share-chip"><MessageSquareText size={14}/>{topicTitle(source.topic.title)}<ArrowUpRight size={13} className="share-chip-go"/></a>}
        <a href={source.chat.url} target="_blank" rel="noreferrer" title={source.chat.id} className="share-chip"><Users size={14}/><span className="share-chip-text">{chatChipText(source.chat)}</span><ArrowUpRight size={13} className="share-chip-go"/></a>
      </div>}
    </section>
  </>;
  const aside = <aside aria-label="来源与执行信息" className="share-aside share-rise">
    {source && <section aria-label="会话来源" className="share-side-card">
      <h2 className="share-side-title">来源</h2>
      {source.topic
        ? <SourceRow href={source.topic.url} title={source.topic.id} icon={<MessageSquareText size={16}/>} name={topicTitle(source.topic.title)} note="提问所在的话题"/>
        : <SourceRow icon={<MessageSquareText size={16}/>} name={missingTopicText(source)} note="来源话题"/>}
      <SourceRow href={source.chat.url} title={source.chat.id} icon={<Users size={16}/>} name={bareId(source.chat) ? shortId(source.chat.id) : source.chat.name} note={source.chat.type === 'p2p' ? '私聊' : '群聊'}/>
      {source.initiator
        ? <SourceRow title={source.initiator.id} icon={<span className="share-avatar">{bareId(source.initiator) ? <UserRound size={16}/> : Array.from(source.initiator.name.trim())[0]}</span>} name={initiatorName(source.initiator)} note="发起人"/>
        : <SourceRow icon={<span className="share-avatar"><UserRound size={16}/></span>} name="来源记录不可用" note="发起人"/>}
    </section>}
    {latest && <section aria-label="这次执行" className="share-side-card">
      <h2 className="share-side-title">这次执行</h2>
      <RunStats facts={latest} running={running}/>
      <p className="share-side-note"><TurnSpan facts={latest} running={running}/></p>
      {queued > 0 && <p className="share-side-note"><span className="share-queue">待执行指令 {queued} 条</span> 本轮结束后自动开始</p>}
    </section>}
    <div className="share-side-actions">
      {output && <CopyConclusionButton markdown={output}/>}
      {source && <a href={source.topic?.url ?? source.chat.url} target="_blank" rel="noreferrer" className="share-button">
        {source.topic ? <><MessageSquareText size={15}/>回到飞书话题</> : <><Users size={15}/>{source.chat.type === 'p2p' ? '回到私聊' : '回到群聊'}</>}
      </a>}
    </div>
  </aside>;
  return <ShareContext.Provider value={context}><div data-tone={status.tone} className="share-page">
    <div data-show={collapsed || undefined} aria-hidden={!collapsed} inert={!collapsed} className="share-minibar share-gutter">
      <DutydeckIcon className="share-minibar-icon"/>
      <span className="share-minibar-title">{title}</span>
      {statusSettled && <StatusPill status={status} running={running} startedAt={latest?.startedAt} compact/>}
      {/* 宽屏侧栏已有复制按钮，细条只留标题和状态。 */}
      {output && <span className="share-narrow-only"><CopyConclusionButton markdown={output} compact/></span>}
    </div>
    {events.isError && <div className="shrink-0 px-4 py-2"><Banner tone="danger">执行记录加载失败：{events.error.message}<button className="ml-2 underline" onClick={() => void events.refetch()}>重试加载记录</button></Banner></div>}
    <TimelineView variant="share" header={header} aside={aside} onScrollTop={onScrollTop} sourceEvents={eventList} historyTurns={historyTurns} key={sessionId} hasOlder={events.data?.hasOlder} loadedEventCount={events.data?.events.length} activeSessionId={sessionId} eventsLoading={events.isLoading || tasks.isPending} timeline={timeline} timelineSections={timelineSections}
      awaitingAnswer={awaitingAnswer} hasOngoingActivity={hasOngoingActivity} latestUserIndex={latestUserIndex} activeOutputLabel={modelLabel}
      renderProgress={emptyState => emptyState ? errorSummary ? <ShareFailureCard reason={errorSummary}/> : <p className="py-10 text-center text-caption text-subtle">这个任务还没有执行记录。</p> : null}/>
    <ToastViewport/>
  </div></ShareContext.Provider>;
}

const noEvents: DockEvent[] = [];
// 同一份原始事件数组只过滤一次并复用结果：投影器靠 previousEvents 与上一次输入是同一个数组来走增量路径。
const shareableCache = new WeakMap<DockEvent[], DockEvent[]>();
function shareableList(events: DockEvent[]) {
  let filtered = shareableCache.get(events);
  if (!filtered) { filtered = shareableEvents(events); shareableCache.set(events, filtered); }
  return filtered;
}

/** 最后一轮的实时记录：从最后一条（非插话的）提问开始。 */
function latestLiveTurn(sections: TimelineSection[]) {
  if (!sections.length) return;
  for (let index = sections.length - 1; index > 0; index--) {
    const section = sections[index]!;
    if (section.kind === 'event' && section.event.type === 'text' && section.event.data.role === 'user' && !section.event.data.steering) return sections.slice(index);
  }
  return sections;
}

type SourceContext = NonNullable<Session['sourceContext']>;
type Initiator = NonNullable<SourceContext['initiator']>;
/** 名称读取失败时来源里只有飞书 ID（ou_/oc_…），这种 ID 不给读者看全文。 */
const bareId = ({ id, name }: { id: string; name: string }) => !name.trim() || name.trim() === id || /^o[cnu]_[0-9a-z]{12,}$/i.test(name.trim());
const shortId = (id: string) => id.length > 14 ? `${id.slice(0, 7)}…${id.slice(-4)}` : id;
const initiatorName = (initiator: Initiator) => `${bareId(initiator) ? shortId(initiator.id) : initiator.name}${initiator.type === 'bot' ? '（机器人）' : ''}`;
const eyebrowWho = (initiator: Initiator) => !bareId(initiator) ? `${initiatorName(initiator)} 发起` : initiator.type === 'bot' ? '机器人发起' : undefined;
const chatChipText = (chat: SourceContext['chat']) => chat.type === 'p2p' ? bareId(chat) ? '私聊' : chat.name : bareId(chat) ? '群聊' : `${chat.name} 群`;
/** 来源话题的标题常是「打开来源话题」这种泛称，读者要的是「这是飞书话题」。 */
const topicTitle = (title: string) => !title.trim() || title.trim() === '打开来源话题' ? '飞书话题' : title;
const missingTopicText = (source: SourceContext) => source.originAvailable ? '未记录话题' : '来源记录不可用';

function SourceRow({ href, title, icon, name, note }: { href?: string; title?: string; icon: ReactNode; name: string; note: string }) {
  const content = <>
    <span className="share-source-icon">{icon}</span>
    <span className="share-source-text"><b>{name}</b><small>{note}</small></span>
    {href && <ArrowUpRight size={15} className="share-source-go"/>}
  </>;
  return href
    ? <a href={href} target="_blank" rel="noreferrer" title={title} className="share-source">{content}</a>
    : <div title={title} className="share-source">{content}</div>;
}

function StatusPill({ status, running, startedAt, compact = false }: { status: ShareStatus; running: boolean; startedAt?: string; compact?: boolean }) {
  const now = useNow(running);
  const elapsed = running ? formatElapsed(elapsedMilliseconds(startedAt, undefined, now)) : undefined;
  return <span data-tone={status.tone} className={compact ? 'share-status share-status-compact' : 'share-status'}>
    <span className="share-dot" aria-hidden="true"/>
    <span className="share-status-label">{status.label}</span>
    {elapsed && !compact && <span className="share-status-elapsed">{elapsed}</span>}
  </span>;
}

function TurnSpan({ facts, running }: { facts?: TurnFacts; running: boolean }) {
  const span = formatTurnSpan(facts?.startedAt, facts?.endedAt, running);
  return span ? <span className="share-span">{span}</span> : null;
}

function useRunElapsed(facts: TurnFacts, running: boolean) {
  const now = useNow(running);
  return formatElapsed(elapsedMilliseconds(facts.startedAt, running ? undefined : facts.endedAt, now));
}

/** 窄屏把用时与调用次数并进英雄区元信息行；执行中耗时已在状态胶囊里。 */
function RunSummary({ facts, running }: { facts: TurnFacts; running: boolean }) {
  const elapsed = useRunElapsed(facts, running);
  return <>{[!running && elapsed ? `用时 ${elapsed}` : undefined, `${facts.toolCount} 次工具调用`].filter(Boolean).join(' · ')}</>;
}

function RunStats({ facts, running }: { facts: TurnFacts; running: boolean }) {
  const elapsed = useRunElapsed(facts, running);
  return <div className="share-stats">
    <div><b className="share-stat-value">{elapsed ? elapsed.split(/(\d+)/).filter(Boolean).map((part, index) => /\d/.test(part) ? <span key={index}>{part}</span> : <small key={index}>{part.trim()}</small>) : '—'}</b><span className="share-stat-label">{running ? '已耗时' : '用时'}</span></div>
    <div><b className="share-stat-value"><span>{facts.toolCount}</span><small>次</small></b><span className="share-stat-label">工具调用</span></div>
  </div>;
}
