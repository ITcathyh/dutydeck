import { Activity, ArrowDownWideNarrow, ChevronDown, ChevronRight, ListTree, Search, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, DockEvent, Session } from '../api';
import type { StreamStatus } from '../sse';
import type { SessionSyncState } from '../useSessionStream';
import { buildTraceRows, filterTraceRows, groupTraceRows, TRACE_PAGE_SIZE, traceCategories, traceDuration, traceLabels, type TraceCategory, type TraceRow } from '../trace-view';
import { connectionLabel } from './RunHeader';
import { Banner, Button, Dialog, EmptyState, IconButton, Input, Spinner, StatusBadge } from './primitives';

const categoryClass: Record<Exclude<TraceCategory, 'all'>, string> = { system: 'bg-muted text-secondary', user: 'bg-info-soft text-info', assistant: 'bg-action-soft text-action', context: 'bg-success-soft text-success', tool: 'bg-warning-soft text-warning', error: 'bg-danger-soft text-danger' };
const dotClass: Record<Exclude<TraceCategory, 'all'>, string> = { system: 'bg-neutral-solid', user: 'bg-info-solid', assistant: 'bg-action', context: 'bg-success-solid', tool: 'bg-warning-solid', error: 'bg-danger-solid' };
const date = (at: number | undefined) => at === undefined || !Number.isFinite(at) ? '—' : new Date(at).toLocaleString();
const turnLabel = (id: string) => id === 'unassigned' ? '未关联轮次' : id.startsWith('input:') ? `输入 #${id.slice(6)} 起的轮次` : `轮次 ${id.slice(5)}`;

function TraceTimeline({ rows, range, selected, onSelect }: { rows: TraceRow[]; range?: [number, number]; selected?: number; onSelect(sequence: number): void }) {
  const tracks = [{ label: '输入', categories: ['user'] }, { label: '模型', categories: ['assistant'] }, { label: '工具', categories: ['tool'] }, { label: '系统 / 上下文', categories: ['system', 'context', 'error'] }];
  const span = range ? range[1] - range[0] : 0;
  return <section aria-label="事件时间轴" className="rounded-md bg-muted px-3 py-2">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-1 text-caption text-subtle"><span>时间轴 · 当前页事件</span><span>点为事件时间 · 条为工具观测区间</span></div>
    {!range ? <p className="text-caption text-subtle">没有可用的事件时间</p> : <>
      <div className="ml-24 flex justify-between text-meta tabular-nums text-subtle"><span>0 ms</span><span>{traceDuration(span / 2)}</span><span>{traceDuration(span)}</span></div>
      {tracks.map(track => <div key={track.label} className="flex h-12 items-center gap-2 sm:h-7">
        <span className="w-20 shrink-0 text-caption text-secondary">{track.label}</span>
        <div className="relative h-11 min-w-0 flex-1 border-b border-default sm:h-5">
          {rows.filter(row => track.categories.includes(row.category) && (row.at !== undefined || row.start !== undefined)).map(row => {
            const interval = row.duration !== undefined && row.start !== undefined && row.end !== undefined;
            const start = interval ? row.start! : row.at ?? row.start!;
            const left = span ? Math.max(0, Math.min(100, (start - range[0]) / span * 100)) : 0;
            const width = interval && span ? Math.min(100 - left, row.duration! / span * 100) : 0;
            // A separate marker keeps mobile hit targets from widening the displayed time interval.
            return <Fragment key={row.event.sequence}>
              <span aria-hidden="true" className={`pointer-events-none absolute top-4 h-3 rounded-sm sm:top-1 ${dotClass[row.category]} ${selected === row.event.sequence ? 'z-10 ring-2 ring-focus-ring ring-offset-2 ring-offset-surface' : 'opacity-70'}`} style={{ left: `calc(${left}% - ${left === 100 ? 4 : 0}px)`, width: `max(4px, ${width}%)` }}/>
              <button type="button" aria-label={`定位事件 #${row.event.sequence}：${row.label}`} aria-pressed={selected === row.event.sequence} title={`#${row.event.sequence} ${row.summary} · ${date(row.at)}${interval ? ` · 观测耗时 ${traceDuration(row.duration)}` : ''}`} onClick={() => onSelect(row.event.sequence)} className="absolute top-0 h-11 bg-transparent focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring sm:h-5" style={{ left: `min(${left}%, calc(100% - 44px))`, width: `max(44px, ${width}%)` }}/>
            </Fragment>;
          })}
        </div>
      </div>)}
    </>}
  </section>;
}

function TraceDetails({ row }: { row: TraceRow }) {
  const data = JSON.stringify(row.event.data, null, 2) ?? 'null';
  const limit = 20_000;
  return <div className="space-y-2 p-3 text-caption text-secondary">
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
      <div><dt className="inline text-subtle">事件 ID：</dt><dd className="inline break-all font-mono">{row.event.id}</dd></div>
      <div><dt className="inline text-subtle">类型：</dt><dd className="inline">{row.event.type}</dd></div>
      <div><dt className="inline text-subtle">任务：</dt><dd className="inline break-all">{row.event.taskId ?? row.event.data?.taskId ?? '—'}</dd></div>
      <div><dt className="inline text-subtle">执行尝试：</dt><dd className="inline break-all">{row.event.attemptId ?? row.event.data?.attemptId ?? '—'}</dd></div>
    </dl>
    {row.duration !== undefined && <p>工具观测区间：{date(row.start)} → {date(row.end)}（{traceDuration(row.duration)}）；不代表纯模型或 CPU 执行时间。</p>}
    <pre aria-label={`事件 #${row.event.sequence} 数据`} className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface p-3 font-mono text-caption text-primary">{data.slice(0, limit)}</pre>
    {data.length > limit && <p>仅预览前 {limit.toLocaleString()} 字符；完整事件可在原始日志中查看或导出。</p>}
    {row.event.raw && <details><summary className="cursor-pointer text-subtle">原始内容{row.event.raw.length > limit ? `（前 ${limit.toLocaleString()} 字符）` : ''}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono">{row.event.raw.slice(0, limit)}</pre></details>}
  </div>;
}

export function SessionTraceView({ session, agent, events, loading, error, historyLoaded, streamStatus, onRetry, onClose }: {
  session: Session;
  agent?: Agent;
  events: DockEvent[];
  loading: boolean;
  error?: string;
  historyLoaded: boolean;
  streamStatus: SessionSyncState | StreamStatus;
  onRetry(): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<TraceCategory>('all');
  const [newest, setNewest] = useState(true);
  const [grouped, setGrouped] = useState(true);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<number>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selectedRow = useRef<HTMLTableRowElement>(null);
  const rows = useMemo(() => buildTraceRows(events), [events]);
  const filtered = useMemo(() => filterTraceRows(rows, category, query, newest), [rows, category, query, newest]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / TRACE_PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = filtered.slice(currentPage * TRACE_PAGE_SIZE, (currentPage + 1) * TRACE_PAGE_SIZE);
  const groups = groupTraceRows(visible, grouped);
  const counts = useMemo(() => Object.fromEntries(traceCategories.map(kind => [kind, kind === 'all' ? rows.length : kind === 'error' ? rows.filter(row => row.failed).length : rows.filter(row => row.category === kind).length])) as Record<TraceCategory, number>, [rows]);
  const range = useMemo<[number, number] | undefined>(() => {
    let first = Infinity, last = -Infinity;
    for (const row of rows) for (const at of [row.at, row.start, row.end]) if (at !== undefined) { first = Math.min(first, at); last = Math.max(last, at); }
    return first === Infinity ? undefined : [first, last];
  }, [rows]);
  const toolCount = useMemo(() => new Set(rows.flatMap(row => row.toolKey ? [row.toolKey] : [])).size, [rows]);
  useEffect(() => { selectedRow.current?.scrollIntoView?.({ block: 'nearest' }); }, [expanded]);
  const reset = () => { setPage(0); setExpanded(undefined); };
  const locate = (sequence: number) => { setCollapsed(new Set()); setExpanded(sequence); };
  const sequenceRange = rows.length ? `${rows[0]!.event.sequence}–${rows.at(-1)!.event.sequence}` : '—';
  return <Dialog open onClose={onClose} label="会话追踪" size="trace">
    <Dialog.Header className="flex-wrap items-center gap-2 py-3">
      <Activity size={18} className="shrink-0 text-action"/><h2 className="text-title font-semibold text-primary">追踪</h2>
      <span className="max-w-48 truncate text-body text-secondary" title={session.name}>{session.name ?? agent?.name ?? session.agentId}</span><StatusBadge session={session}/>
      <span className="text-caption text-subtle">已加载 {rows.length.toLocaleString()} · 工具 {toolCount.toLocaleString()} · 已加载跨度 {traceDuration(range ? range[1] - range[0] : undefined)}</span>
      <span className="ml-auto"><IconButton label="关闭会话追踪" onClick={onClose}><X size={18}/></IconButton></span>
    </Dialog.Header>
    <Dialog.Body className="space-y-3 px-3 py-3 sm:px-5">
      <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 text-caption sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Agent', agent?.name ?? session.agentId], ['连接方式', agent?.protocol ?? '—'], ['当前模型配置', session.model ?? '—'],
          ['工作目录', session.cwd], ['会话创建', date(Date.parse(session.createdAt))], ['Run ID', session.runId]
        ].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-subtle">{label}</dt><dd className="mt-0.5 break-all text-secondary">{value}</dd></div>)}
      </dl>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-subtle" aria-live="polite">
        <span>已加载序列 {sequenceRange}</span><span>{loading ? <span className="inline-flex items-center gap-1"><Spinner size="sm"/>正在读取完整历史</span> : historyLoaded ? '历史快照已读取；新事件随会话同步' : '当前为部分记录'}</span><span>{connectionLabel(streamStatus)}</span>
      </div>
      {error && <Banner tone="danger" title="追踪历史读取失败"><span>{error}；当前展示已加载记录。</span><Button size="sm" variant="ghost" onClick={onRetry}>重试读取</Button></Banner>}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 grow basis-60"><Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-3 text-subtle"/><Input aria-label="搜索追踪事件" placeholder="搜索摘要、类型或 ID" value={query} onChange={event => { setQuery(event.target.value); reset(); }} className="pl-9"/></div>
        <Button aria-pressed={grouped} variant="secondary" icon={<ListTree size={14}/>} onClick={() => { setGrouped(value => !value); setCollapsed(new Set()); }}>按轮次分组</Button>
        <Button aria-label="切换事件排序" variant="secondary" icon={<ArrowDownWideNarrow size={14}/>} onClick={() => { setNewest(value => !value); reset(); }}>{newest ? '最新优先' : '最早优先'}</Button>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="事件分类">{traceCategories.map(kind => <Button key={kind} size="sm" aria-pressed={category === kind} variant={category === kind ? 'primary' : 'ghost'} onClick={() => { setCategory(kind); reset(); }}>{traceLabels[kind]} {counts[kind].toLocaleString()}</Button>)}</div>
      <TraceTimeline rows={visible} range={range} selected={expanded} onSelect={locate}/>
      <p className="text-caption text-subtle">未记录的时长显示 —；模型消息只标事件时间。</p>
      {!filtered.length ? <EmptyState icon={<Activity size={22}/>} title={loading ? '正在加载追踪事件' : rows.length ? '没有匹配的事件' : '暂无追踪事件'} description={rows.length ? '调整搜索或事件分类后重试。' : '会话产生记录后会在这里显示。'}/> : <div className="overflow-x-auto rounded-md border border-default">
        <table aria-label="追踪事件" className="w-full min-w-[640px] table-fixed text-left text-caption">
          <thead className="bg-muted text-subtle"><tr><th className="w-44 px-3 py-2 font-medium">事件</th><th className="w-24 px-3 py-2 font-medium">观测时长</th><th className="px-3 py-2 font-medium">摘要</th><th className="w-44 px-3 py-2 font-medium">时间</th></tr></thead>
          <tbody>{groups.map(group => <Fragment key={group.id}>
            {grouped && <tr className="bg-muted"><td colSpan={4}><button type="button" aria-expanded={!collapsed.has(group.id)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })} className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{collapsed.has(group.id) ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<span className="truncate">{turnLabel(group.id)}</span><span className="ml-auto shrink-0 text-meta text-subtle">本页 {group.rows.length} 条</span></button></td></tr>}
            {(!grouped || !collapsed.has(group.id)) && group.rows.map(row => <Fragment key={row.event.sequence}>
              <tr ref={expanded === row.event.sequence ? selectedRow : undefined} className={`border-t border-subtle ${expanded === row.event.sequence ? 'bg-action-soft' : 'hover:bg-muted'}`}>
                <td className="px-3 py-2"><button type="button" aria-label={`事件 #${row.event.sequence} ${row.label}`} aria-expanded={expanded === row.event.sequence} onClick={() => setExpanded(value => value === row.event.sequence ? undefined : row.event.sequence)} className="flex min-h-8 w-full items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{expanded === row.event.sequence ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}<span className={`shrink-0 rounded-sm px-1.5 py-0.5 ${categoryClass[row.category]}`}>{traceLabels[row.category]}</span><span className="truncate text-primary">{row.label}</span></button></td>
                <td className="px-3 py-2 tabular-nums text-subtle">{traceDuration(row.duration)}</td>
                <td className="px-3 py-2"><div className={`truncate ${row.failed ? 'text-danger' : 'text-secondary'}`} title={row.summary}>{row.summary}</div></td>
                <td className="px-3 py-2 tabular-nums text-subtle"><time dateTime={row.at === undefined ? undefined : new Date(row.at).toISOString()}>{date(row.at)}</time></td>
              </tr>
              {expanded === row.event.sequence && <tr className="border-t border-subtle bg-muted"><td colSpan={4}><TraceDetails row={row}/></td></tr>}
            </Fragment>)}
          </Fragment>)}</tbody>
        </table>
      </div>}
    </Dialog.Body>
    <Dialog.Footer className="flex-wrap justify-between gap-2">
      <span className="text-caption text-subtle">匹配 {filtered.length.toLocaleString()} / 已加载 {rows.length.toLocaleString()} 条 · 每页 {TRACE_PAGE_SIZE} 条</span>
      <div className="flex items-center gap-2"><Button size="sm" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setExpanded(undefined); }}>上一页</Button><span className="text-caption tabular-nums text-secondary">{currentPage + 1} / {lastPage + 1}</span><Button size="sm" disabled={currentPage === lastPage} onClick={() => { setPage(currentPage + 1); setExpanded(undefined); }}>下一页</Button></div>
    </Dialog.Footer>
  </Dialog>;
}
