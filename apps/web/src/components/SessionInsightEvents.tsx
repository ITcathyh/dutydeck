import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { traceKinds, type TraceEvent } from '@dutydeck/shared';
import { insightApi, insightQueryKeys, type InsightEventFilters } from '../api';
import { currentInstance } from '../instance';
import { Banner, Button, Select, Spinner } from './primitives';
import { formatTime, metricTitle, metricValueText, traceKindLabels, traceResultLabels } from './SessionInsightShared';

const EVENT_PAGE_LIMIT = 100;

const emptyFilters: InsightEventFilters = {};

/** 单条 Trace 事件：定位信息、Token 样本与限长摘录。 */
function EventRow({ event, highlighted }: { event: TraceEvent; highlighted: boolean }) {
  const [expanded, setExpanded] = useState(highlighted);
  useEffect(() => { if (highlighted) setExpanded(true); }, [highlighted]);
  const tokenText = event.tokens ? [
    event.tokens.inputUncached != null && `未缓存输入 ${event.tokens.inputUncached}`,
    event.tokens.cacheRead != null && `缓存读 ${event.tokens.cacheRead}`,
    event.tokens.cacheWrite != null && `缓存写 ${event.tokens.cacheWrite}`,
    event.tokens.output != null && `输出 ${event.tokens.output}`,
    event.tokens.total != null && `合计 ${event.tokens.total}`
  ].filter(Boolean).join(' · ') : null;
  const excerpt = event.errorExcerpt || event.inputExcerpt || event.outputExcerpt;
  return <li className={highlighted ? 'bg-action-soft' : undefined}>
    <button type="button" className="flex w-full flex-wrap items-baseline gap-x-2 px-2 py-1.5 text-left hover:bg-muted" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
      <span className="shrink-0 text-meta text-subtle tabular-nums">L{event.lineNumber}</span>
      <span className="shrink-0 text-caption font-medium text-primary">{traceKindLabels[event.kind] ?? event.kind}</span>
      {event.toolName && <span className="shrink-0 rounded-sm bg-muted px-1.5 text-meta text-secondary">{event.toolName}</span>}
      {event.resultStatus && <span className={`shrink-0 text-meta font-medium ${event.resultStatus === 'failure' ? 'text-danger' : event.resultStatus === 'success' ? 'text-success' : 'text-subtle'}`}>
        {traceResultLabels[event.resultStatus]}
      </span>}
      <span className="ml-auto shrink-0 text-meta text-subtle">{event.timestamp ? formatTime(event.timestamp) : '无时间'}</span>
      {event.durationMs?.value != null && <span className="shrink-0 text-meta text-subtle" title={metricTitle(event.durationMs)}>{event.durationMs.value.toFixed(0)} ms</span>}
      {tokenText && <span className="basis-full text-meta text-secondary">{tokenText}</span>}
    </button>
    {expanded && <div className="space-y-1 border-l-2 border-action px-2 pb-2 pt-1 text-meta text-secondary">
      <p>事件 ID：<code className="break-all">{event.eventId}</code>{event.isSnapshotLocalId && '（快照内局部 ID，重新解析后可能变化）'}</p>
      <p>来源：{event.sourceKey}{event.nativeRunId ? ` · run ${event.nativeRunId}` : ''}{event.callId ? ` · call ${event.callId}` : ''}</p>
      {event.evidenceRefs.length > 0 && <p>配对证据：{event.evidenceRefs.join('、')}</p>}
      {excerpt && <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-code-surface p-2 text-code-header-text">{excerpt}</pre>}
    </div>}
  </li>;
}

export type SessionInsightEventsProps = {
  sessionId: string;
  /** 固定快照：事件不跨快照混页；切到新快照时分页与筛选全部重置。 */
  snapshotId: string;
  /** 摘要关键证据请求定位的事件 ID；逐页找到后高亮。 */
  locateEventId?: string | null;
  onLocated?: () => void;
};

/**
 * 固定快照的 Trace 事件浏览器。
 *
 * - React Query key 含实例 / 会话 / 快照 / 全部筛选项，实例切换不串缓存。
 * - 翻页用服务端 cursor，维护 cursor 栈支持回退；切快照或改筛选重置。
 * - 证据定位从首页起按 nextCursor 顺序有界后翻，找到即高亮，找不到则提示。
 */
export function SessionInsightEvents({ sessionId, snapshotId, locateEventId, onLocated }: SessionInsightEventsProps) {
  const instance = currentInstance();
  const [filters, setFilters] = useState<InsightEventFilters>(emptyFilters);
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [locateMissed, setLocateMissed] = useState(false);
  // 分开搜索进行态（seekingTargetId）与目标高亮（highlightedEventId）：
  // 定位完成或到底未找到后立即终止搜索（seekingTargetId=null），
  // 避免用户后续手动翻页或筛选时再次触发自动逐页后翻。
  const [seekingTargetId, setSeekingTargetId] = useState<string | null>(null);
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 切固定快照、切会话或切实例：游标栈、筛选、定位全部重置。
  useEffect(() => {
    setFilters(emptyFilters);
    setPage(0);
    setCursors([undefined]);
    setLocateMissed(false);
    setSeekingTargetId(null);
    setHighlightedEventId(null);
  }, [snapshotId, sessionId, instance]);

  const query: InsightEventFilters & { snapshotId: string } = { snapshotId, ...filters, cursor: cursors[page], limit: EVENT_PAGE_LIMIT };
  const events = useQuery({
    queryKey: insightQueryKeys.events(instance, sessionId, snapshotId, { ...filters, cursor: cursors[page], limit: EVENT_PAGE_LIMIT }),
    queryFn: ({ signal }) => insightApi.events(sessionId, query, signal),
    enabled: Boolean(snapshotId)
  });

  // 外部传入新的证据定位请求：回到第一页并清除筛选，开启一次顺序向后搜索。
  useEffect(() => {
    if (!locateEventId) return;
    setFilters(emptyFilters);
    setPage(0);
    setCursors([undefined]);
    setLocateMissed(false);
    setSeekingTargetId(locateEventId);
    setHighlightedEventId(locateEventId);
  }, [locateEventId]);

  // 搜索推进：仅在 seekingTargetId 非空时主动翻页；一旦命中或到底即刻终止搜索。
  const located = useMemo(
    () => seekingTargetId ? events.data?.items.find(item => item.eventId === seekingTargetId) ?? null : null,
    [events.data, seekingTargetId]
  );

  useEffect(() => {
    if (!seekingTargetId) return;
    if (events.isFetching) return;
    if (located) {
      setSeekingTargetId(null);
      onLocated?.();
      listRef.current?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (!events.data) return;
    if (events.data.nextCursor) {
      const nextCursor = events.data.nextCursor;
      setCursors(previous => previous.includes(nextCursor) ? previous : [...previous, nextCursor]);
      setPage(value => value + 1);
      setLocateMissed(false);
    } else {
      setSeekingTargetId(null);
      setLocateMissed(true);
      onLocated?.();
    }
  }, [seekingTargetId, located, events.data, events.isFetching, onLocated]);

  const resetPaging = (next: InsightEventFilters) => {
    // 用户手动改筛选：取消未完成的搜索，重置分页
    setSeekingTargetId(null);
    setFilters(next);
    setPage(0);
    setCursors([undefined]);
    setLocateMissed(false);
  };

  return <div ref={listRef} className="space-y-2" data-snapshot={snapshotId}>
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-0.5 text-meta text-subtle">类型
        <Select value={filters.kind ?? ''} onChange={event => resetPaging({ ...filters, kind: (event.target.value || undefined) as InsightEventFilters['kind'] })}>
          <option value="">全部类型</option>
          {traceKinds.map(kind => <option key={kind} value={kind}>{traceKindLabels[kind] ?? kind}</option>)}
        </Select>
      </label>
      <label className="flex flex-col gap-0.5 text-meta text-subtle">结果
        <Select value={filters.result ?? ''} onChange={event => resetPaging({ ...filters, result: (event.target.value || undefined) as InsightEventFilters['result'] })}>
          <option value="">全部结果</option>
          <option value="failure">失败</option>
          <option value="success">成功</option>
          <option value="unknown">结果未知</option>
        </Select>
      </label>
      <label className="flex flex-col gap-0.5 text-meta text-subtle">工具名
        <input
          className="rounded-sm border border-default bg-surface px-2 py-1 text-caption"
          value={filters.tool ?? ''}
          onChange={event => resetPaging({ ...filters, tool: event.target.value || undefined })}
        />
      </label>
      {seekingTargetId && <span className="text-meta text-action">正在定位证据 {seekingTargetId}…</span>}
      {locateMissed && <span className="text-meta text-danger">该证据不在当前快照中；可清除筛选后重试。</span>}
    </div>
    {events.isPending && <Spinner label="正在读取事件…"/>}
    {events.isError && <Banner tone="danger" action={{ label: '重试', onClick: () => void events.refetch() }}>事件读取失败：{events.error.message}</Banner>}
    {events.data && <>
      <p className="text-meta text-subtle">快照 {snapshotId} · 匹配 {events.data.totalMatching.toLocaleString('zh-CN')} 条 · 第 {page + 1} 页</p>
      {events.data.items.length === 0
        ? <p className="text-caption text-subtle">当前筛选没有事件。</p>
        : <ul className="divide-y divide-subtle rounded-md border border-subtle bg-surface">{events.data.items.map(item =>
          <EventRow key={item.eventId} event={item} highlighted={item.eventId === highlightedEventId}/>)}
        </ul>}
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={page === 0 || events.isFetching} onClick={() => { setSeekingTargetId(null); setPage(value => value - 1); }}>上一页</Button>
        <Button size="sm" variant="secondary" disabled={!events.data.nextCursor || events.isFetching} onClick={() => {
          setSeekingTargetId(null);
          const nextCursor = events.data.nextCursor!;
          setCursors(previous => previous.includes(nextCursor) ? previous : [...previous, nextCursor]);
          setPage(value => value + 1);
        }}>下一页</Button>
        {events.isFetching && <Spinner label="翻页中…"/>}
      </div>
    </>}
  </div>;
}
