import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { SessionInsightSummaryResponse, SummarySessionRow } from '@dutydeck/shared';
import { insightApi, insightQueryKeys, type InsightSummaryFilters } from '../api';
import { currentInstance } from '../instance';
import { Badge, Banner, Button, EmptyState, Select, Spinner } from './primitives';
import { formatDuration, freshnessLabels, refreshStateLabels } from './SessionInsightShared';

type GroupBy = NonNullable<InsightSummaryFilters['groupBy']>;

const usageOptions: Array<{ id: NonNullable<InsightSummaryFilters['usage']>; label: string }> = [
  { id: 'explicit', label: '显式请求' },
  { id: 'proactive', label: '主动介入' },
  { id: 'scheduled', label: '定时' },
  { id: 'background', label: '后台' },
  { id: 'mixed', label: '混合用途' },
  { id: 'unknown', label: '用途未知' }
];

const groupByOptions: Array<{ id: GroupBy; label: string }> = [
  { id: 'workspace', label: '按工作区' },
  { id: 'agent', label: '按 Agent' },
  { id: 'model', label: '按实际模型' },
  { id: 'usage', label: '按任务用途' }
];

type BatchRowState =
  | { kind: 'pending' }
  | { kind: 'submitting' }
  | { kind: 'accepted'; snapshotId?: string | null }
  | { kind: 'queued' }
  | { kind: 'queue-full' }
  | { kind: 'error'; message: string };

function MetricCoverageCell({
  valueText,
  coverage
}: {
  valueText: string;
  coverage?: { includedCount: number; excludedCount: number; excludedReasons: Record<string, number> };
}) {
  if (!coverage) {
    return <div className="flex flex-col items-end">
      <span>{valueText}</span>
      <span className="text-meta text-subtle" title="该指标未上报分母覆盖，按未知处理">覆盖未知</span>
    </div>;
  }
  const reasonText = Object.entries(coverage.excludedReasons)
    .map(([reason, count]) => `${reason} ${count}`)
    .join('；');
  const title = `纳入 ${coverage.includedCount} / 排除 ${coverage.excludedCount}${reasonText ? `（原因：${reasonText}）` : ''}`;
  return <div className="flex flex-col items-end" title={title}>
    <span>{valueText}</span>
    <span className="text-meta text-subtle">
      纳入 {coverage.includedCount} / 排除 {coverage.excludedCount}
    </span>
  </div>;
}

/**
 * 「用量与成本 → 会话分析」的跨会话汇总。
 *
 * 分母来自 Dutydeck 会话目录（candidateSessions），未分析会话计入 withoutSnapshot
 * 而不是补 0；分页只切会话行，覆盖统计始终覆盖完整候选集合。
 */
export function SessionInsightOverview({ onOpenSession, onCompare }: {
  onOpenSession(sessionId: string): void;
  onCompare(leftSessionId: string, rightSessionId: string): void;
}) {
  const instance = currentInstance();
  const qc = useQueryClient();
  const [groupBy, setGroupBy] = useState<GroupBy>('workspace');
  const [usage, setUsage] = useState('');
  const [agentId, setAgentId] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<Record<string, BatchRowState>>({});

  const filters: InsightSummaryFilters = useMemo(() => ({
    groupBy,
    ...(usage ? { usage: usage as InsightSummaryFilters['usage'] } : {}),
    ...(agentId ? { agentId } : {}),
    ...(workspace ? { workspace } : {}),
    ...(from ? { from: new Date(from).toISOString() } : {}),
    ...(to ? { to: new Date(to).toISOString() } : {}),
    includeArchived
  }), [groupBy, usage, agentId, workspace, from, to, includeArchived]);

  const summary = useInfiniteQuery({
    queryKey: insightQueryKeys.summary(instance, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => insightApi.summary({ ...filters, limit: 100, cursor: pageParam }, signal),
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined
  });

  // 覆盖统计与分组覆盖完整候选集合（与行分页无关），取首页；会话行跨页拼接。
  const data: SessionInsightSummaryResponse | undefined = summary.data?.pages[0];

  // 筛选变化后旧选择可能已不在候选集合内；批量提交与对比都只认当前已加载的行。
  const rows = useMemo(
    () => summary.data?.pages.flatMap(page => page.sessions) ?? [],
    [summary.data]
  );
  const selectedRows = useMemo(
    () => [...selected].map(id => rows.find(row => row.sessionId === id)).filter((row): row is SummarySessionRow => Boolean(row)),
    [selected, rows]
  );
  const comparableSelected = selectedRows.filter(row => row.hasSnapshot && row.snapshotId);

  const toggleRow = (id: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const invalidateSummary = () => void qc.invalidateQueries({ queryKey: ['insight', instance ?? null, 'summary'] });

  // 有界逐行提交：所选会话逐个请求，服务端 429 时该行标队列满，其余继续，不做批处理任务。
  const batchAnalyze = useMutation({
    mutationFn: async (targets: SummarySessionRow[]) => {
      const results: Record<string, BatchRowState> = {};
      for (const row of targets) {
        setBatch(current => ({ ...current, [row.sessionId]: { kind: 'submitting' } }));
        try {
          const response = await insightApi.refresh(row.sessionId);
          results[row.sessionId] = response.state === 'queued'
            ? { kind: 'queued' }
            : { kind: 'accepted', snapshotId: response.snapshotId ?? null };
        } catch (error) {
          const code = (error as { code?: string }).code;
          results[row.sessionId] = code === 'INSIGHT_QUEUE_FULL'
            ? { kind: 'queue-full' }
            : { kind: 'error', message: error instanceof Error ? error.message : '提交失败' };
        }
        setBatch(current => ({ ...current, [row.sessionId]: results[row.sessionId]! }));
      }
      return results;
    },
    onSuccess: () => invalidateSummary()
  });

  if (summary.isError) return <Banner tone="danger" action={{ label: '重试', onClick: () => void summary.refetch() }}>
    会话分析汇总读取失败：{summary.error.message}
  </Banner>;
  if (summary.isPending || !data) return <Spinner label="正在读取会话分析汇总…"/>;

  const denominatorConsistent = data.withSnapshot + data.withoutSnapshot === data.candidateSessions;

  return <div className="space-y-4">
    {/* 稳定分母：with + without 必须等于候选总数，其余维度可重叠不可相加。 */}
    <section aria-label="候选会话覆盖" className="rounded-md border border-subtle bg-muted p-3">
      <p className="text-caption font-semibold text-primary">候选会话 {data.candidateSessions.toLocaleString('zh-CN')} 个（分母来自 Dutydeck 会话目录）</p>
      <div className="mt-1 flex flex-wrap gap-1.5 text-caption">
        <Badge tone="success">已有快照 {data.withSnapshot}</Badge>
        <Badge tone="neutral">未分析 {data.withoutSnapshot}</Badge>
        <Badge tone="warning">部分快照 {data.partialSnapshots}</Badge>
        <Badge tone="danger">分析失败 {data.failedRefreshes}</Badge>
        <Badge tone="warning" variant="outline">快照过期 {data.staleSnapshots}</Badge>
        <Badge tone="neutral" variant="outline">新鲜度未知 {data.freshnessUnknown}</Badge>
      </div>
      <p className="mt-1 text-meta text-subtle">
        已有快照 + 未分析 = {data.withSnapshot + data.withoutSnapshot}，{denominatorConsistent ? '与候选总数一致。' : '与候选总数不一致，请刷新重试。'}
        部分 / 失败 / 过期 / 未知是可重叠维度，不参与相加；未分析会话不按 0 计入指标。
      </p>
    </section>

    {/* 筛选与分组 */}
    <section aria-label="汇总筛选" className="grid gap-2 sm:grid-cols-3">
      <label className="flex flex-col gap-0.5 text-meta text-subtle">分组
        <Select value={groupBy} onChange={event => setGroupBy(event.target.value as GroupBy)}>
          {groupByOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
      </label>
      <label className="flex flex-col gap-0.5 text-meta text-subtle">任务用途
        <Select value={usage} onChange={event => setUsage(event.target.value)}>
          <option value="">全部用途</option>
          {usageOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
      </label>
      <label className="flex flex-col gap-0.5 text-meta text-subtle">Agent ID
        <input className="rounded-sm border border-default bg-surface px-2 py-1 text-caption" value={agentId} onChange={event => setAgentId(event.target.value)} placeholder="精确匹配"/>
      </label>
      <label className="flex flex-col gap-0.5 text-meta text-subtle">工作区
        <input className="rounded-sm border border-default bg-surface px-2 py-1 text-caption" value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="workspaceSourceCwd"/>
      </label>
      <label className="flex flex-col gap-0.5 text-meta text-subtle">创建时间起（UTC）
        <input type="date" className="rounded-sm border border-default bg-surface px-2 py-1 text-caption" value={from} onChange={event => setFrom(event.target.value)}/>
      </label>
      <label className="flex flex-col gap-0.5 text-meta text-subtle">创建时间止（UTC）
        <input type="date" className="rounded-sm border border-default bg-surface px-2 py-1 text-caption" value={to} onChange={event => setTo(event.target.value)}/>
      </label>
      <label className="flex items-center gap-1.5 text-caption text-secondary">
        <input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)}/>
        包含已归档会话
      </label>
    </section>

    {/* 分组行：指标只在聚合非空时展示；空分母明确为未知而非 0。 */}
    <section aria-label="分组汇总" className="space-y-1">
      <h3 className="text-body font-semibold">分组（{groupByOptions.find(option => option.id === groupBy)?.label}）</h3>
      {data.groups.length === 0
        ? <p className="text-caption text-subtle">当前筛选没有分组数据。</p>
        : <div className="overflow-x-auto rounded-md border border-subtle">
          <table className="w-full text-caption">
            <thead className="bg-muted text-subtle">
              <tr>
                <th className="px-2 py-1 text-left font-medium">分组</th>
                <th className="px-2 py-1 text-right font-medium">候选</th>
                <th className="px-2 py-1 text-right font-medium">有快照</th>
                <th className="px-2 py-1 text-right font-medium">未分析</th>
                <th className="px-2 py-1 text-right font-medium">失败/过期</th>
                <th className="px-2 py-1 text-right font-medium" title="该分组下候选会话层面的纳入与排除">会话候选纳入/排除</th>
                <th className="px-2 py-1 text-right font-medium" title="指标值及其指标独立的纳入/排除分母覆盖">总时长</th>
                <th className="px-2 py-1 text-right font-medium" title="指标值及其指标独立的纳入/排除分母覆盖">可追踪 token</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-subtle">
              {data.groups.map(group => <tr key={group.groupKey || '__unknown__'}>
                <td className="px-2 py-1 text-secondary">{group.groupKey || '未知'}</td>
                <td className="px-2 py-1 text-right tabular-nums">{group.candidateSessions}</td>
                <td className="px-2 py-1 text-right tabular-nums text-success">{group.withSnapshot}</td>
                <td className="px-2 py-1 text-right tabular-nums">{group.withoutSnapshot}</td>
                <td className="px-2 py-1 text-right tabular-nums">{group.failedRefreshes} / {group.staleSnapshots}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {group.includedCount} / <span title={Object.entries(group.excludedReasons).map(([reason, count]) => `${reason} ${count}`).join('；')}>{group.excludedCount}</span>
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  <MetricCoverageCell
                    valueText={group.aggregateMetrics?.elapsedDurationMs.value != null ? formatDuration(group.aggregateMetrics.elapsedDurationMs.value) : '未知'}
                    coverage={group.metricCoverage?.elapsedDurationMs}
                  />
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  <MetricCoverageCell
                    valueText={group.aggregateMetrics?.totalTracked.value != null ? group.aggregateMetrics.totalTracked.value.toLocaleString('zh-CN') : '未知'}
                    coverage={group.metricCoverage?.totalTracked}
                  />
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>}
    </section>

    {/* 会话行 + 选择 + 批量提交 */}
    <section aria-label="会话列表" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-body font-semibold">会话（已加载 {rows.length} 行）</h3>
        <span className="text-meta text-subtle">已选 {selectedRows.length} 个</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={selectedRows.length === 0 || batchAnalyze.isPending}
          loading={batchAnalyze.isPending}
          onClick={() => { setBatch({}); void batchAnalyze.mutateAsync(selectedRows); }}
        >分析所选 {selectedRows.length > 0 ? `（${selectedRows.length}）` : ''}</Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={comparableSelected.length !== 2}
          onClick={() => onCompare(comparableSelected[0]!.sessionId, comparableSelected[1]!.sessionId)}
        >对比所选两个会话</Button>
        {selected.size > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>清空选择</Button>}
        <span className="ml-auto text-meta text-subtle">对比仅允许选择两个且都已有固定快照的会话</span>
      </div>
      {rows.length === 0
        ? <EmptyState title="当前筛选没有候选会话" description="放宽筛选条件或包含已归档会话。"/>
        : <div className="overflow-x-auto rounded-md border border-subtle">
          <table className="w-full text-caption">
            <thead className="bg-muted text-subtle">
              <tr>
                <th className="w-8 px-2 py-1"/>
                <th className="px-2 py-1 text-left font-medium">会话</th>
                <th className="px-2 py-1 text-left font-medium">工作区 / Agent / 用途</th>
                <th className="px-2 py-1 text-left font-medium">实际模型</th>
                <th className="px-2 py-1 text-left font-medium">分析状态</th>
                <th className="px-2 py-1 text-left font-medium">提交结果</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-subtle">
              {rows.map(row => {
                const rowState = batch[row.sessionId];
                const canCompare = row.hasSnapshot && row.snapshotId;
                return <tr key={row.sessionId} className={row.isSharedSource ? 'bg-muted' : undefined}>
                  <td className="px-2 py-1"><input type="checkbox" aria-label={`选择会话 ${row.sessionId}`} checked={selected.has(row.sessionId)} onChange={() => toggleRow(row.sessionId)}/></td>
                  <td className="px-2 py-1">
                    <button type="button" className="text-link underline-offset-2 hover:underline" onClick={() => onOpenSession(row.sessionId)}>{row.sessionId}</button>
                    {row.isSharedSource && <span className="ml-1 text-meta text-subtle" title={row.attributionNote ?? '同一原生日志来源被多个 Dutydeck 会话引用，全局只算一次'}>共享来源</span>}
                  </td>
                  <td className="px-2 py-1 text-secondary">{row.workspace || '未知工作区'}<br/><span className="text-meta text-subtle">{row.agentId} · {row.usage}</span></td>
                  <td className="px-2 py-1 text-secondary">{row.models.length ? row.models.join('、') : <span className="text-subtle">未知{row.hasSnapshot ? '' : '（未分析）'}</span>}</td>
                  <td className="px-2 py-1">
                    <Badge tone={row.refreshState === 'succeeded' ? 'success' : row.refreshState === 'failed' ? 'danger' : row.refreshState === 'queued' || row.refreshState === 'running' ? 'queued' : 'neutral'} variant="outline">
                      {refreshStateLabels[row.refreshState]}
                    </Badge>
                    {row.hasSnapshot && <span className="ml-1 text-meta text-subtle">{freshnessLabels[row.freshness]}</span>}
                    {row.errorCode && <span className="ml-1 text-meta text-danger" title={row.errorCode}>⚠</span>}
                  </td>
                  <td className="px-2 py-1 text-meta" data-testid={`batch-state-${row.sessionId}`}>{rowState && <BatchStateView state={rowState}/>}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>}
      {summary.hasNextPage && <div className="flex justify-center">
        <Button
          size="sm"
          variant="secondary"
          loading={summary.isFetchingNextPage}
          onClick={() => void summary.fetchNextPage()}
        >加载更多会话</Button>
      </div>}
      {selectedRows.length !== selected.size && <p className="text-meta text-warning">部分已选会话不在当前筛选结果内，批量提交只处理当前已加载的 {selectedRows.length} 行。</p>}
      {selectedRows.length >= 2 && comparableSelected.length !== 2
        ? <p className="text-meta text-warning">已选 {selectedRows.length} 个会话，其中 {comparableSelected.length} 个有固定快照；对比需要恰好两个都有快照的会话。</p>
        : null}
    </section>
  </div>;
}

function BatchStateView({ state }: { state: BatchRowState }) {
  switch (state.kind) {
    case 'submitting': return <span className="text-subtle">提交中…</span>;
    case 'accepted': return <span className="text-success">已接纳{state.snapshotId ? `（命中缓存 ${state.snapshotId.slice(0, 10)}…）` : ''}</span>;
    case 'queued': return <span className="text-queued">已排队</span>;
    case 'queue-full': return <span className="text-danger font-medium">队列已满，未接纳（可稍后重试）</span>;
    case 'error': return <span className="text-danger" title={state.message}>提交失败：{state.message}</span>;
    case 'pending': return null;
  }
}
