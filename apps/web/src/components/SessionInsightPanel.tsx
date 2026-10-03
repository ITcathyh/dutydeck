import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type {
  AnalysisCoverage,
  FileMetrics,
  HostEvidenceSnapshot,
  Metric,
  RefreshState,
  SessionInsightManifest,
  SessionInsightSourceSummary,
  SessionInsightSummary
} from '@dutydeck/shared';
import { api, insightApi, insightQueryKeys, ApiError } from '../api';
import { currentInstance } from '../instance';
import { Badge, Banner, Button, Dialog, EmptyState, Spinner } from './primitives';
import { SessionInsightPulseChart } from './SessionInsightPulseChart';
import { SessionInsightEvents } from './SessionInsightEvents';
import { SessionInsightCompare } from './SessionInsightCompare';
import {
  availabilityLabels,
  clientLabels,
  formatMetricByKey,
  formatTime,
  freshnessLabels,
  isRefreshInFlight,
  metricMeta,
  metricTitle,
  metricValueText,
  qualityLabels,
  refreshStateLabels,
  type MetricKey
} from './SessionInsightShared';

const POLL_INTERVAL_MS = 2000;

/** 触发浏览器 attachment 下载；报告内容已由服务端脱敏并固定到快照。 */
function downloadAttachment(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // 让点击事件先派发再回收对象 URL。
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function MetricCell({ metricKey, metric }: { metricKey: MetricKey; metric: Metric }) {
  const unknown = metric.value === null;
  const degraded = metric.status !== 'available';
  return <span
    title={metricTitle(metric)}
    className={`tabular-nums ${unknown ? 'text-subtle' : degraded ? 'text-warning' : 'text-primary'}`}
  >
    {formatMetricByKey(metricKey, metric)}
    {unknown && <span className="ml-1 text-meta">（{qualityLabels[metric.quality]}）</span>}
  </span>;
}

function MetricGrid({ title, keys, metrics }: { title: string; keys: MetricKey[]; metrics: FileMetrics }) {
  return <section aria-label={title} className="space-y-1">
    <h3 className="text-body font-semibold">{title}</h3>
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
      {keys.map(key => <div key={key} className="flex items-baseline justify-between gap-2 border-b border-subtle pb-0.5">
        <dt className="text-caption text-secondary">{metricMeta[key].label}</dt>
        <dd className="shrink-0 text-caption"><MetricCell metricKey={key} metric={metrics[key] as Metric}/></dd>
      </div>)}
    </dl>
  </section>;
}

function CoverageSection({ sources }: { sources: SessionInsightSourceSummary[] }) {
  return <section aria-label="数据覆盖与质量" className="space-y-2">
    <h3 className="text-body font-semibold">数据覆盖与质量</h3>
    {sources.map(source => {
      const { coverage } = source;
      const roleName = source.scopeRole === 'primary'
        ? '主来源'
        : source.scopeRole === 'subagent'
          ? `子 Agent${source.streamIdentity.kind === 'subagent' ? ` (${source.streamIdentity.nativeAgentId})` : ''}`
          : '已排除来源';
      const clientName = clientLabels[source.client] ?? source.client;
      const title = `${roleName}（${clientName}）`;
      const rows: Array<[string, string]> = [
        ['原始行数', coverage.rawLines.toLocaleString('zh-CN')],
        ['成功解析行数', coverage.parsedLines.toLocaleString('zh-CN')],
        ['忽略行数', coverage.ignoredLines.toLocaleString('zh-CN')],
        ['错误行数', coverage.errorLines.toLocaleString('zh-CN')],
        ['缺失时间戳行数', coverage.missingTimestampCount.toLocaleString('zh-CN')],
        ['乱序时间戳行数', coverage.disorderedTimestampCount.toLocaleString('zh-CN')],
        ['保留 Trace / 省略', `${coverage.retainedTraceCount.toLocaleString('zh-CN')} / ${coverage.omittedTraceCount.toLocaleString('zh-CN')}`],
        ['Token 样本可用 / 缺失', `${coverage.tokenSamplesAvailable.toLocaleString('zh-CN')} / ${coverage.tokenSamplesMissing.toLocaleString('zh-CN')}`],
        ['源时间范围', `${formatTime(coverage.timeRange.start)} – ${formatTime(coverage.timeRange.end)}`],
        ['子 Agent 发现范围', { none: '无子 Agent', complete: '完整', partial: '部分', unknown: '未知' }[coverage.subagentDiscovery]],
        ['继承历史识别', { none: '无', detected: '检测到继承片段', unsupported: '客户端不支持', unknown: '未知' }[coverage.inheritedHistory]]
      ];
      const omittedCategories = Object.entries(coverage.omittedTraceByCategory);
      return <div key={source.sourceKey} className="space-y-1 rounded-md border border-subtle p-2">
        <div className="flex items-center justify-between">
          <span className="text-caption font-medium text-primary">{title}</span>
          <span className="text-meta text-subtle">{source.sourceKey}</span>
        </div>
        <div className="overflow-hidden rounded-sm border border-subtle">
          <table className="w-full text-caption">
            <tbody className="divide-y divide-subtle">
              {rows.map(([label, value]) => <tr key={label}>
                <td className="px-2 py-0.5 text-secondary">{label}</td>
                <td className="px-2 py-0.5 text-right tabular-nums text-primary">{value}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {omittedCategories.length > 0 && <p className="text-meta text-subtle">
          省略事件分类：{omittedCategories.map(([category, count]) => `${category} ${count}`).join('；')}；不是每条事件都能下钻。
        </p>}
      </div>;
    })}
  </section>;
}

const scopeRoleLabels: Record<SessionInsightSourceSummary['scopeRole'], string> = {
  primary: '主来源',
  subagent: '子 Agent',
  excluded: '已排除（不可加总）'
};

function SourcesSection({ sources }: { sources: SessionInsightSourceSummary[] }) {
  return <section aria-label="来源与加总范围" className="space-y-1">
    <h3 className="text-body font-semibold">来源与加总范围</h3>
    <ul className="space-y-2">
      {sources.map(source => <li key={source.sourceKey} className="rounded-md border border-subtle p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-caption font-medium text-primary">{clientLabels[source.client] ?? source.client}</span>
          <Badge tone={source.scopeRole === 'primary' ? 'accent' : source.scopeRole === 'subagent' ? 'info' : 'neutral'}>{scopeRoleLabels[source.scopeRole]}</Badge>
          {source.streamIdentity.kind === 'subagent' && <Badge tone="neutral" variant="outline">子 Agent {source.streamIdentity.nativeAgentId}</Badge>}
          <Badge tone={source.status === 'ok' ? 'success' : source.status === 'partial' ? 'warning' : 'danger'} variant="outline">
            {source.status === 'ok' ? '解析正常' : source.status === 'partial' ? '部分解析' : '解析错误'}
          </Badge>
          <span className="ml-auto text-meta text-subtle">SHA {source.sha256.slice(0, 12)}</span>
        </div>
        {source.aggregation.eligibility === 'excluded' && <p className="mt-1 text-meta text-warning">
          不进入跨会话可加总总量，原因：{source.aggregation.reasonCodes.join('、') || '未说明'}；下列数值仅为该来源独立观察值。
        </p>}
        {source.relationship.kind !== 'none' && <p className="mt-1 text-meta text-secondary">
          来源关系：{source.relationship.kind === 'child' ? '子流' : source.relationship.kind === 'fork' ? 'fork 继承' : '关系未知'}
          {source.relationship.parentNativeSessionId ? ` · 父会话 ${source.relationship.parentNativeSessionId}` : ''}
        </p>}
        <p className="mt-1 text-meta text-subtle">
          时间 {formatTime(source.coverage.timeRange.start)} – {formatTime(source.coverage.timeRange.end)}
          {' · '}解析 {source.coverage.parsedLines.toLocaleString('zh-CN')} 行
          {' · '}工具 {metricValueText(source.metrics.toolCalls)} 次（失败 {metricValueText(source.metrics.toolFailures)}，结果未知 {metricValueText(source.metrics.toolUnknowns)}）
        </p>
      </li>)}
    </ul>
  </section>;
}

function HostEvidenceSection({ evidence }: { evidence: HostEvidenceSnapshot | null }) {
  if (!evidence) {
    return <section aria-label="宿主验证与关联任务" className="space-y-2">
      <h3 className="text-body font-semibold">宿主验证与关联任务</h3>
      <div className="rounded-md border border-subtle p-2">
        <p className="text-caption text-subtle">快照中没有关联的宿主执行、验证或费用证据。</p>
      </div>
    </section>;
  }
  return <section aria-label="宿主验证与关联任务" className="space-y-2">
    <h3 className="text-body font-semibold">宿主验证与关联任务</h3>
    <div className="rounded-md border border-subtle p-2">
      <p className="text-caption font-medium text-primary">任务目标（来自执行账本，非日志推断）</p>
      {evidence.taskGoals.length
        ? <ul className="mt-1">{evidence.taskGoals.map(goal => <li key={`${goal.taskId}-${goal.attemptId ?? ''}`} className="text-caption text-secondary">
          {goal.goal} <span className="text-subtle">（任务 {goal.taskId} · {goal.status}）</span>
        </li>)}</ul>
        : <p className="mt-1 text-meta text-subtle">快照中没有任务目标证据。</p>}
      {evidence.omittedGoalsCount > 0 && <p className="mt-1 text-meta text-subtle">另有 {evidence.omittedGoalsCount} 条目标因限量省略。</p>}
    </div>
    {evidence.steeringRelations.length > 0 && <div className="rounded-md border border-subtle p-2">
      <p className="text-caption font-medium text-primary">Steering 投递关系</p>
      <ul className="mt-1">{evidence.steeringRelations.map(relation => <li key={`${relation.steeringTaskId}-${relation.targetTaskId}`} className="text-caption text-secondary">
        {relation.steeringTaskId} → {relation.targetTaskId}{relation.completed ? '，已投递完成（不计独立模型轮次）' : '，未完成'}
      </li>)}</ul>
    </div>}
    <div className="rounded-md border border-subtle p-2">
      <p className="text-caption font-medium text-primary">验证快照</p>
      {evidence.verificationSnapshot.length
        ? <ul className="mt-1">{evidence.verificationSnapshot.map(item => <li key={`${item.taskId}-${item.attemptId ?? ''}`} className="text-caption text-secondary">
          <span className={item.passed ? 'text-success' : 'text-danger'}>{item.passed ? '通过' : '未通过'}</span>
          {item.stale && <span className="text-warning">（记录已过期 stale，不以最新状态改写）</span>}
          {item.summary ? `：${item.summary}` : ''}
        </li>)}</ul>
        : <p className="mt-1 text-meta text-subtle">宿主记录中没有验证结果；日志中的 test 关键词不算验证通过。</p>}
    </div>
    {evidence.modelConfigs.length > 0 && <div className="rounded-md border border-subtle p-2">
      <p className="text-caption font-medium text-primary">任务冻结的模型配置（只作配置证据，不覆盖原生观测）</p>
      <ul className="mt-1">{evidence.modelConfigs.map((config, index) => <li key={`${config.taskId}-${index}`} className="text-caption text-secondary">
        {config.configuredModel}{config.provider ? `（${config.provider}）` : ''}
      </li>)}</ul>
    </div>}
    {evidence.usageLedgerProjection && <div className="rounded-md border border-subtle p-2">
      <p className="text-caption font-medium text-primary">费用账本只读投影</p>
      <p className="mt-1 text-caption text-secondary">
        记账时间 {formatTime(evidence.usageLedgerProjection.recordedAtRange.start)} – {formatTime(evidence.usageLedgerProjection.recordedAtRange.end)}
        {evidence.usageLedgerProjection.totalCostEstimate != null && ` · 估算合计 ${evidence.usageLedgerProjection.currency ?? ''}${evidence.usageLedgerProjection.totalCostEstimate.toFixed(4)}`}
        {evidence.usageLedgerProjection.hasUnpricedUsage && ' · 存在有 token 但费用未知的记录'}
      </p>
      <p className="mt-1 text-meta text-subtle">源日志时间与记账时间可能跨天，不据此做对账结论；分析不产生第二笔费用。</p>
    </div>}
  </section>;
}

const tokenMetricKeys: MetricKey[] = ['inputUncached', 'cacheRead', 'cacheWrite', 'output', 'reasoningOutput', 'totalTracked', 'rawInput', 'rawOutput', 'rawTotal', 'peakContext', 'contextWindow'];
const durationMetricKeys: MetricKey[] = ['elapsedDurationMs', 'activeDurationMs', 'idleDurationMs', 'pairedToolDurationMs'];
const turnMetricKeys: MetricKey[] = ['userTurns', 'assistantTurns', 'toolCalls', 'toolFailures', 'toolSuccesses', 'toolUnknowns', 'toolFailureRate', 'compactionCount', 'subagentCount'];

type SessionInsightPanelProps = {
  sessionId: string;
  /** 深链 ?compare=<sessionId> 恢复的对比会话；在当前实例内选取。 */
  compareSessionId?: string | null;
  onCompareSessionChange(sessionId: string | null): void;
  onClose(): void;
};

export function SessionInsightPanel({ sessionId, compareSessionId, onCompareSessionChange, onClose }: SessionInsightPanelProps) {
  const qc = useQueryClient();
  const instance = currentInstance();
  const [locateEventId, setLocateEventId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // GET 详情：不触发分析；只在面板可见且作业 queued/running 时轮询，完成即停。
  const details = useQuery({
    queryKey: insightQueryKeys.details(instance, sessionId, null),
    queryFn: ({ signal }) => insightApi.details(sessionId, null, signal),
    refetchInterval: query => {
      const state = query.state.data?.status.refreshState;
      return state && isRefreshInFlight(state) ? POLL_INTERVAL_MS : false;
    }
  });

  // 作业从进行中转为终态：失效跨会话汇总（覆盖分母可能变化）。
  // 详情不在这里再失效：轮询的最后一次响应已是终态，刷新/取消 mutation 的 onSuccess
  // 也已失效详情；重复失效只会在取消后多发一次请求。
  const wasInFlight = useRef(false);
  const refreshState: RefreshState | undefined = details.data?.status.refreshState;
  useEffect(() => {
    const inFlight = refreshState ? isRefreshInFlight(refreshState) : false;
    if (wasInFlight.current && !inFlight) {
      void qc.invalidateQueries({ queryKey: ['insight', instance ?? null, 'summary'] });
    }
    wasInFlight.current = inFlight;
  }, [refreshState, instance, qc]);

  const refresh = useMutation({
    mutationFn: () => insightApi.refresh(sessionId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: insightQueryKeys.details(instance, sessionId, null) }),
    onError: () => { /* 错误在按钮下方统一展示 */ }
  });

  const cancel = useMutation({
    mutationFn: (requestId: string) => insightApi.cancel(sessionId, requestId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: insightQueryKeys.details(instance, sessionId, null) })
  });

  const exportReport = async (
    format: 'markdown' | 'html',
    compareRefs?: {
      left: { sessionId: string; snapshotId: string };
      right: { sessionId: string; snapshotId: string };
    }
  ) => {
    const currentSnapshotId = details.data?.summary?.snapshotId;
    if (!compareRefs && !currentSnapshotId) return;
    setExporting(true);
    setExportError(null);
    try {
      const result = await insightApi.exportReport(compareRefs
        ? { kind: 'comparison', left: compareRefs.left, right: compareRefs.right, format }
        : { kind: 'session', sessionId, snapshotId: currentSnapshotId!, format });
      downloadAttachment(result.blob, result.filename);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const status = details.data?.status;
  const summary: SessionInsightSummary | null = details.data?.summary ?? null;
  const manifest: SessionInsightManifest | null = details.data?.manifest ?? null;
  const hostEvidence = details.data?.hostEvidence ?? null;
  const inFlight = refreshState ? isRefreshInFlight(refreshState) : false;
  const failedWithOldSnapshot = refreshState === 'failed' && Boolean(summary);

  // 右侧对比会话：深链只给 sessionId，固定版本取该会话当前快照。
  const rightDetails = useQuery({
    queryKey: insightQueryKeys.details(instance, compareSessionId ?? '', null),
    queryFn: ({ signal }) => insightApi.details(compareSessionId!, null, signal),
    enabled: Boolean(compareSessionId)
  });
  const sessionsForCompare = useQuery({ queryKey: ['sessions', instance ?? null], queryFn: api.sessions, staleTime: 30_000 });

  const currentContextKey = compareSessionId ? `${instance ?? ''}:${sessionId}:${compareSessionId}` : null;
  const currentLeftSnapshotId = status?.currentSnapshotId;
  const currentRightSnapshotId = rightDetails.data?.status.currentSnapshotId;

  // 选定对比时冻结左右两侧 {sessionId, snapshotId}，刷新不漂移；切换上下文或选择重置为新选择的首次可用快照
  const [frozenCompare, setFrozenCompare] = useState<{
    contextKey: string;
    left: { sessionId: string; snapshotId: string };
    right: { sessionId: string; snapshotId: string };
  } | null>(null);

  let activeCompareRefs = (currentContextKey && frozenCompare?.contextKey === currentContextKey)
    ? frozenCompare
    : null;

  if (currentContextKey) {
    if (!activeCompareRefs && currentLeftSnapshotId && currentRightSnapshotId) {
      activeCompareRefs = {
        contextKey: currentContextKey,
        left: { sessionId, snapshotId: currentLeftSnapshotId },
        right: { sessionId: compareSessionId!, snapshotId: currentRightSnapshotId }
      };
      setFrozenCompare(activeCompareRefs);
    } else if (frozenCompare && frozenCompare.contextKey !== currentContextKey) {
      setFrozenCompare(null);
    }
  } else if (frozenCompare) {
    setFrozenCompare(null);
  }

  const evidenceButtons = useMemo(() => {
    if (!summary) return [] as Array<{ id: string; label: string }>;
    return [
      ...summary.keyEvidenceEventIds.failures.slice(0, 20).map(id => ({ id, label: '失败调用' })),
      ...summary.keyEvidenceEventIds.slowCalls.slice(0, 10).map(id => ({ id, label: '最慢调用' })),
      ...summary.keyEvidenceEventIds.highTokenDeltas.slice(0, 10).map(id => ({ id, label: '高 Token' }))
    ];
  }, [summary]);

  const body = (() => {
    if (details.isPending) return <Spinner label="正在读取会话分析…"/>;
    if (details.isError) return <Banner tone="danger" action={{ label: '重试', onClick: () => void details.refetch() }}>
      分析状态读取失败：{details.error.message}
    </Banner>;

    return <div className="space-y-4">
      {/* 状态 / 刷新操作条 */}
      <section aria-label="分析状态" className="flex flex-wrap items-center gap-2">
        <Badge tone={inFlight ? 'queued' : refreshState === 'succeeded' ? 'success' : refreshState === 'failed' ? 'danger' : refreshState === 'cancelled' || refreshState === 'interrupted' ? 'warning' : 'neutral'}>
          {refreshState ? refreshStateLabels[refreshState] : '状态未知'}
        </Badge>
        {status && <>
          <Badge tone={status.availability === 'complete' ? 'success' : status.availability === 'partial' ? 'warning' : 'neutral'} variant="outline">
            {availabilityLabels[status.availability]}
          </Badge>
          <Badge tone={status.freshness === 'current' ? 'success' : status.freshness === 'stale' ? 'warning' : 'neutral'} variant="outline">
            {freshnessLabels[status.freshness]}
          </Badge>
          {status.lastCheckedAt && <span className="text-meta text-subtle">最后检查 {formatTime(status.lastCheckedAt)}</span>}
        </>}
        <span className="ml-auto flex gap-2">
          {inFlight && status?.requestId && <Button size="sm" variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate(status.requestId!)}>取消刷新</Button>}
          {/* 无快照时操作入口在下方 EmptyState 主 CTA，这里不重复放同名按钮。 */}
          {summary && <Button size="sm" variant="secondary" loading={refresh.isPending || inFlight} onClick={() => refresh.mutate()}>
            重新分析
          </Button>}
        </span>
      </section>

      {refresh.isError && <Banner tone="danger">
        {(refresh.error as ApiError)?.status === 429 || (refresh.error as ApiError)?.code === 'INSIGHT_QUEUE_FULL'
          ? '分析队列已满，此会话未被接纳，请稍候重试。'
          : `刷新请求失败：${refresh.error.message}`}
      </Banner>}
      {cancel.isError && <Banner tone="danger">取消失败：{cancel.error.message}</Banner>}
      {exportError && <Banner tone="danger" onDismiss={() => setExportError(null)}>导出失败：{exportError}</Banner>}

      {/* 原生日志不可用或历史无绑定证据时的说明 */}
      {details.data?.hostExecutionFallback?.unsupportedReason && <Banner tone="info" title="原生日志不可用">
        {details.data.hostExecutionFallback.unsupportedReason}
      </Banner>}

      {/* 未分析：GET 绝不自动触发，只给明确动作。 */}
      {!summary && refreshState !== 'failed' && <EmptyState
        tone="guide"
        title="此会话还没有分析快照"
        description="分析只读取已绑定的原生日志固定快照，不会影响正在运行的任务，也不修改费用或任务状态。"
        primaryAction={{ label: refresh.isPending ? '正在提交…' : '分析此会话', onClick: () => refresh.mutate(), disabled: refresh.isPending }}
      />}

      {/* 失败但有旧快照：保留旧数据并标示，失败不阻塞读取。 */}
      {failedWithOldSnapshot && <Banner tone="warning" title="最近一次分析失败，以下为旧快照">
        失败原因{status?.errorCode ? `（${status.errorCode}）` : ''}见上方状态；旧快照 {summary!.snapshotId} 仍然可读，刷新成功前不会被替换。
      </Banner>}
      {refreshState === 'failed' && !summary && <Banner tone="danger" title="分析失败且没有可读旧快照" action={{
        label: '重新分析',
        busy: refresh.isPending || inFlight,
        onClick: () => refresh.mutate()
      }}>
        错误码：{status?.errorCode ?? '未知'}。可重新分析重试；取消、失败和中断都不会删除已有快照。
      </Banner>}

      {/* 无原生快照时，若有宿主任务记录/验证/费用证据，同样完整呈现，不隐藏执行事实。 */}
      {!summary && hostEvidence && <HostEvidenceSection evidence={hostEvidence}/>}

      {summary && <>
        <section aria-label="快照概要" className="rounded-md border border-subtle bg-muted p-2 text-caption">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <span className="font-semibold text-primary">快照 {summary.snapshotId}</span>
            <span className="text-meta text-subtle">固定于 {formatTime(summary.createdAt)}</span>
          </div>
          <p className="mt-1 text-secondary">
            实际模型集合：{summary.models.length
              ? <span className="font-medium">{summary.models.join('、')}{summary.isMultiModel && <Badge tone="info">多模型</Badge>}</span>
              : <span className="text-subtle">未知（模型缺失不影响其他指标展示）</span>}
          </p>
          <details className="mt-1 text-meta text-subtle">
            <summary className="cursor-pointer hover:text-secondary">版本与范围证据</summary>
            <div className="mt-1 space-y-0.5 border-l border-subtle pl-2">
              <p>范围口径：{summary.scopeVersion} · 主来源：{summary.primarySourceKey}</p>
              {manifest && <p>
                引擎 {manifest.versions.engineVersion} · parser {manifest.versions.parserVersion} · 指标口径 {manifest.versions.metricVersion} · 脱敏 {manifest.versions.redactionVersion}
              </p>}
            </div>
          </details>
        </section>

        <MetricGrid title="Token 分布" keys={tokenMetricKeys} metrics={summary.aggregateMetrics}/>
        <MetricGrid title="时间口径" keys={durationMetricKeys} metrics={summary.aggregateMetrics}/>
        <MetricGrid title="轮次、工具与上下文" keys={turnMetricKeys} metrics={summary.aggregateMetrics}/>

        <section aria-label="Token 脉冲" className="space-y-1">
          <h3 className="text-body font-semibold">Token 脉冲</h3>
          <SessionInsightPulseChart buckets={summary.pulseBuckets}/>
        </section>

        {/* 关键证据 → 定位到具体 Trace 事件（设计完成判据：从摘要定位到一条调用）。 */}
        {evidenceButtons.length > 0 && <section aria-label="关键证据定位" className="space-y-1">
          <h3 className="text-body font-semibold">关键证据定位</h3>
          <div className="flex flex-wrap gap-1.5">
            {evidenceButtons.map(item => <Button key={item.id} size="sm" variant="secondary" onClick={() => setLocateEventId(item.id)}>
              {item.label} <code className="ml-1 text-meta">{item.id.slice(0, 18)}…</code>
            </Button>)}
          </div>
        </section>}

        <CoverageSection sources={summary.sources}/>
        <SourcesSection sources={summary.sources}/>
        <HostEvidenceSection evidence={hostEvidence}/>

        <section aria-label="源时间线与事件" className="space-y-1">
          <h3 className="text-body font-semibold">源时间线与事件</h3>
          <SessionInsightEvents sessionId={sessionId} snapshotId={summary.snapshotId} locateEventId={locateEventId} onLocated={() => { /* 高亮与翻页由事件组件管理 */ }}/>
        </section>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" loading={exporting} onClick={() => void exportReport('markdown')}>导出 Markdown</Button>
          <Button size="sm" variant="secondary" loading={exporting} onClick={() => void exportReport('html')}>导出 HTML</Button>
        </div>
      </>}

      {/* 对比：在当前实例选第二个会话；两个实例之间不做对比。 */}
      <section aria-label="两会话对比" className="space-y-2 border-t border-subtle pt-3">
        <h3 className="text-body font-semibold">与另一会话对比</h3>
        <label className="flex items-center gap-2 text-caption text-secondary">
          选择当前实例内的会话
          <select
            className="rounded-sm border border-default bg-surface px-2 py-1"
            value={compareSessionId ?? ''}
            onChange={event => onCompareSessionChange(event.target.value || null)}
          >
            <option value="">不对比</option>
            {(sessionsForCompare.data ?? []).filter(item => item.id !== sessionId).map(item =>
              <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
          </select>
        </label>
        {compareSessionId && (rightDetails.isPending
          ? <Spinner label="正在读取对比会话快照…"/>
          : rightDetails.isError
            ? <Banner tone="danger">对比会话读取失败：{rightDetails.error.message}</Banner>
            : !activeCompareRefs && !currentRightSnapshotId
              ? <Banner tone="warning">对比会话 {compareSessionId} 还没有分析快照；两侧都需要固定快照才能对比，且对比不会隐式触发分析。</Banner>
              : !activeCompareRefs && !currentLeftSnapshotId
                ? <Banner tone="warning">当前会话还没有固定快照，无法作为对比左侧。</Banner>
                : activeCompareRefs
                  ? <SessionInsightCompare
                    left={activeCompareRefs.left}
                    right={activeCompareRefs.right}
                    onClose={() => onCompareSessionChange(null)}
                    exporting={exporting}
                    onExport={format => void exportReport(format, activeCompareRefs!)}
                  />
                  : null)}
      </section>
    </div>;
  })();

  return <Dialog open onClose={onClose} label="会话分析" size="xl" closeOnEscape={!inFlight}>
    <Dialog.Header>
      <h2 className="text-title font-semibold">会话分析</h2>
      <span className="truncate text-meta text-subtle">会话 {sessionId}</span>
      <span className="ml-auto"><Button variant="ghost" size="sm" aria-label="关闭会话分析" onClick={onClose} icon={<X size={16}/>}>关闭</Button></span>
    </Dialog.Header>
    <Dialog.Body>{body}</Dialog.Body>
  </Dialog>;
}
