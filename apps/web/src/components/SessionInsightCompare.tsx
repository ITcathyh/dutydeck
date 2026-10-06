import { useQuery } from '@tanstack/react-query';
import type {
  Metric,
  SessionInsightCompareResponse,
  SessionInsightSummary
} from '@dutydeck/shared';
import { insightApi, insightQueryKeys } from '../api';
import { currentInstance } from '../instance';
import { Banner, Button, Spinner } from './primitives';
import {
  clientLabels,
  formatDuration,
  formatMetricByKey,
  formatTime,
  metricMeta,
  metricTitle,
  type MetricKey
} from './SessionInsightShared';

type CompareRef = { sessionId: string; snapshotId: string };

export type SessionInsightCompareProps = {
  left: CompareRef;
  right: CompareRef;
  onClose(): void;
  onExport(format: 'markdown' | 'html'): void;
  exporting?: boolean;
};

const comparableMetricKeys: MetricKey[] = [
  'elapsedDurationMs',
  'activeDurationMs',
  'pairedToolDurationMs',
  'idleDurationMs',
  'userTurns',
  'assistantTurns',
  'toolCalls',
  'toolFailures',
  'toolFailureRate',
  'inputUncached',
  'cacheRead',
  'cacheWrite',
  'output',
  'reasoningOutput',
  'totalTracked',
  'peakContext',
  'compactionCount',
  'subagentCount'
];

function deltaText(key: MetricKey, diff: SessionInsightCompareResponse['metricDiffs'][string] | undefined): { text: string; tone: string; title?: string } {
  const fmt = (value: number) => metricMeta[key].kind === 'duration' ? formatDuration(value) : value.toLocaleString('zh-CN');
  if (!diff || !diff.comparable) {
    return {
      text: '不可比',
      tone: 'text-subtle',
      title: diff?.reasonCodes.join('、')
    };
  }
  if (diff.isBaselineZero) {
    return {
      text: `基线为零，绝对差 ${diff.delta === null ? '未知' : (diff.delta > 0 ? '+' : '') + fmt(diff.delta)}`,
      tone: 'text-warning',
      title: '左侧基线为 0，不显示无穷大或百分比改善。'
    };
  }
  if (diff.delta === null || diff.percentChange === null) return { text: '差值未知', tone: 'text-subtle', title: diff.reasonCodes.join('、') };
  const sign = diff.delta > 0 ? '+' : '';
  return {
    text: `${sign}${fmt(diff.delta)}（${diff.percentChange > 0 ? '+' : ''}${diff.percentChange}%）`,
    tone: diff.delta === 0 ? 'text-subtle' : diff.delta > 0 ? 'text-danger' : 'text-success',
    title: '正值表示右侧高于左侧；不自动判定好坏。'
  };
}

function SnapshotHeader({ side, summary }: { side: '左侧' | '右侧'; summary: SessionInsightSummary }) {
  return <div className="space-y-1 rounded-md border border-subtle bg-muted p-2">
    <p className="text-caption font-semibold text-primary">{side}：会话 {summary.sessionId}</p>
    <p className="text-meta text-subtle">快照 {summary.snapshotId} · 固定于 {formatTime(summary.createdAt)}</p>
    <p className="text-meta text-secondary">
      实际模型：{summary.models.length ? summary.models.join('、') : '未知'}{summary.isMultiModel ? '（多模型）' : ''}
    </p>
    <p className="text-meta text-subtle">来源：{summary.sources.map(source => `${clientLabels[source.client] ?? source.client} ${source.streamIdentity.kind === 'subagent' ? `子 Agent ${source.streamIdentity.nativeAgentId}` : '主会话'}`).join('；')}</p>
  </div>;
}

function GoalComparison({ data }: { data: SessionInsightCompareResponse }) {
  const leftGoals = data.leftHostEvidence.taskGoals;
  const rightGoals = data.rightHostEvidence.taskGoals;
  const sameGoal = leftGoals.length === rightGoals.length
    && leftGoals.every((goal, index) => goal.goal === rightGoals[index]?.goal);
  const sides: Array<{ label: string; goals: typeof leftGoals }> = [
    { label: '左侧', goals: leftGoals },
    { label: '右侧', goals: rightGoals }
  ];
  return <section aria-label="任务目标对比" className="space-y-1">
    <h3 className="text-body font-semibold">任务目标</h3>
    <Banner tone={sameGoal ? 'info' : 'warning'}>
      {sameGoal
        ? '两侧任务目标一致，指标差异可结合目标理解。'
        : '两侧任务目标不同：指标差异不能归因于模型或 Agent 变更，只反映不同任务。'}
    </Banner>
    <ul className="grid gap-2 sm:grid-cols-2">
      {sides.map(({ label, goals }) =>
        <li key={label} className="rounded-md border border-subtle p-2">
          <p className="text-meta font-medium text-subtle">{label}</p>
          {goals.length
            ? goals.map(goal =>
              <p key={goal.taskId} className="text-caption text-secondary">{goal.goal} <span className="text-subtle">（{goal.status}）</span></p>)
            : <p className="text-caption text-subtle">快照中没有任务目标证据。</p>}
        </li>)}
    </ul>
  </section>;
}

function VerificationComparison({ data }: { data: SessionInsightCompareResponse }) {
  const renderSide = (label: string, verifications: SessionInsightCompareResponse['leftHostEvidence']['verificationSnapshot']) =>
    <div className="rounded-md border border-subtle p-2">
      <p className="text-meta font-medium text-subtle">{label}</p>
      {verifications.length
        ? <ul>{verifications.map(item => <li key={`${item.taskId}-${item.attemptId ?? ''}`} className="text-caption text-secondary">
          {item.passed ? '通过' : '未通过'}{item.stale && <span className="text-warning">（记录已过期，stale）</span>}
          {item.summary ? `：${item.summary}` : ''}
        </li>)}</ul>
        : <p className="text-caption text-subtle">宿主记录中没有验证快照；不以日志里的 test 关键词当验证通过。</p>}
    </div>;
  return <section aria-label="验证结果对比" className="space-y-1">
    <h3 className="text-body font-semibold">宿主验证</h3>
    <div className="grid gap-2 sm:grid-cols-2">
      {renderSide('左侧', data.leftHostEvidence.verificationSnapshot)}
      {renderSide('右侧', data.rightHostEvidence.verificationSnapshot)}
    </div>
  </section>;
}

/** 两侧固定快照的来源覆盖：匹配状态、读取/分析字节、尾部截断与加总资格。 */
function CoverageComparison({ data }: { data: SessionInsightCompareResponse }) {
  const renderSide = (label: string, manifest: SessionInsightCompareResponse['leftManifest']) =>
    <div className="rounded-md border border-subtle p-2">
      <p className="text-meta font-medium text-subtle">{label}（bindingRevision {manifest.bindingRevision}）</p>
      {manifest.sources.length === 0
        ? <p className="text-caption text-subtle">清单中没有来源条目。</p>
        : <ul className="mt-1 space-y-1">{manifest.sources.map(source => <li key={`${source.sourceKey}-${source.client}`} className="text-meta text-secondary">
          <span className="font-medium">{clientLabels[source.client] ?? source.client}</span> · {source.sourceKey}
          {' · '}匹配：{source.matchStatus} · 解析状态：{source.status}
          {source.readBytes != null && ` · 读 ${source.readBytes.toLocaleString('zh-CN')} B`}
          {source.analyzedBytes != null && ` / 分析 ${source.analyzedBytes.toLocaleString('zh-CN')} B`}
          {source.trailingBytes ? <span className="text-warning">{` · 忽略尾部 ${source.trailingBytes.toLocaleString('zh-CN')} B（半行）`}</span> : null}
          {source.aggregation.eligibility === 'excluded' && <span className="text-warning">{` · 不可加总（${source.aggregation.reasonCodes.join('、') || '未说明'}）`}</span>}
        </li>)}</ul>}
    </div>;
  return <section aria-label="覆盖范围对比" className="space-y-1">
    <h3 className="text-body font-semibold">来源覆盖范围</h3>
    <div className="grid gap-2 sm:grid-cols-2">
      {renderSide('左侧', data.leftManifest)}
      {renderSide('右侧', data.rightManifest)}
    </div>
  </section>;
}

/**
 * 两固定快照对比。请求带两侧 sessionId + snapshotId；只读，不隐式触发分析。
 * delta 为 null / 不可比 / 基线为零各自明确展示，不把未知算作改善。
 */
export function SessionInsightCompare({ left, right, onClose, onExport, exporting }: SessionInsightCompareProps) {
  const instance = currentInstance();
  const compare = useQuery({
    queryKey: insightQueryKeys.compare(instance, { left, right }),
    queryFn: ({ signal }) => insightApi.compare({ left, right }, signal)
  });

  if (compare.isPending) return <div className="space-y-3"><Spinner label="正在读取固定快照对比…"/><Button variant="secondary" onClick={onClose}>关闭</Button></div>;
  if (compare.isError) return <div className="space-y-3">
    <Banner tone="danger" action={{ label: '重试', onClick: () => void compare.refetch() }}>对比读取失败：{compare.error.message}</Banner>
    <Button variant="secondary" onClick={onClose}>关闭</Button>
  </div>;

  const data = compare.data;
  return <div className="space-y-4">
    <div className="grid gap-2 sm:grid-cols-2">
      <SnapshotHeader side="左侧" summary={data.left}/>
      <SnapshotHeader side="右侧" summary={data.right}/>
    </div>
    {!data.comparable && <Banner tone="warning" title="两侧口径不完全可比">
      {data.incomparableReasons.length ? data.incomparableReasons.join('；') : '部分指标不可比，下表逐项说明。'}
      ；两侧 metricVersion 分别为 {data.leftManifest.versions.metricVersion} / {data.rightManifest.versions.metricVersion}。
    </Banner>}

    <GoalComparison data={data}/>
    <CoverageComparison data={data}/>
    <VerificationComparison data={data}/>

    <section aria-label="指标差异" className="space-y-1">
      <h3 className="text-body font-semibold">同口径指标</h3>
      <div className="overflow-x-auto rounded-md border border-subtle">
        <table className="w-full text-caption">
          <thead className="bg-muted text-subtle">
            <tr>
              <th className="px-2 py-1 text-left font-medium">指标</th>
              <th className="px-2 py-1 text-right font-medium">左侧</th>
              <th className="px-2 py-1 text-right font-medium">右侧</th>
              <th className="px-2 py-1 text-left font-medium">差异（右−左）</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-subtle">
            {comparableMetricKeys.map(key => {
              const leftMetric = data.left.aggregateMetrics[key] as Metric;
              const rightMetric = data.right.aggregateMetrics[key] as Metric;
              const diff = data.metricDiffs[key];
              const delta = deltaText(key, diff);
              return <tr key={key}>
                <td className="px-2 py-1 text-secondary" title={metricMeta[key].label}>{metricMeta[key].label}</td>
                <td className="px-2 py-1 text-right tabular-nums" title={metricTitle(leftMetric)}>{formatMetricByKey(key, leftMetric)}</td>
                <td className="px-2 py-1 text-right tabular-nums" title={metricTitle(rightMetric)}>{formatMetricByKey(key, rightMetric)}</td>
                <td className={`px-2 py-1 font-medium ${delta.tone}`} title={delta.title}>{delta.text}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      <p className="text-meta text-subtle">未知值不计入差异；左侧为 0 时只给绝对差与「基线为零」，不显示百分比。差异颜色只表示高低，不代表好坏，也不对模型质量下结论。</p>
    </section>

    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => onExport('markdown')} loading={exporting}>导出 Markdown</Button>
      <Button variant="secondary" onClick={() => onExport('html')} loading={exporting}>导出 HTML</Button>
      <Button variant="secondary" onClick={onClose}>关闭对比</Button>
    </div>
  </div>;
}
