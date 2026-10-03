import {
  calculateMetricComparison,
  sessionInsightCompareResponseSchema,
  type FileMetrics,
  type MetricComparison,
  type SessionInsightCompareResponse,
  type SessionInsightSnapshotRecord
} from '@dutydeck/shared';

/**
 * T4b 固定快照对比与报告的统一错误。
 * code 为设计第 7.1 节固定错误码，message 为不含任何用户数据的固定文本，
 * 避免快照内 canary / 路径等内容经错误消息泄漏到日志。
 */
export class SessionInsightReportError extends Error {
  constructor(
    public readonly code: 'INSIGHT_INPUT_LIMIT' | 'INSIGHT_REPORT_LIMIT',
    message: string
  ) {
    super(message);
    this.name = 'SessionInsightReportError';
  }
}

const INCONSISTENT_SNAPSHOT_MESSAGE = 'Inconsistent frozen snapshot internal references';

/**
 * FileMetrics 中计数类指标的固定键与顺序（与冻结契约 fileMetricsSchema 一致）。
 */
export const FILE_METRIC_COUNT_KEYS = [
  'inputUncached',
  'cacheRead',
  'cacheWrite',
  'output',
  'reasoningOutput',
  'totalTracked',
  'rawInput',
  'rawOutput',
  'rawTotal',
  'peakContext',
  'contextWindow',
  'userTurns',
  'assistantTurns',
  'toolCalls',
  'toolFailures',
  'toolSuccesses',
  'toolUnknowns',
  'compactionCount',
  'subagentCount'
] as const satisfies readonly (keyof FileMetrics)[];

/**
 * FileMetrics 中耗时/比率类指标的固定键与顺序。
 */
export const FILE_METRIC_CONTINUOUS_KEYS = [
  'elapsedDurationMs',
  'activeDurationMs',
  'idleDurationMs',
  'pairedToolDurationMs',
  'toolFailureRate'
] as const satisfies readonly (keyof FileMetrics)[];

/**
 * 参与对比的全部指标键，顺序固定，保证输出确定。
 */
export const FILE_METRIC_KEYS: readonly (keyof FileMetrics)[] = [
  ...FILE_METRIC_COUNT_KEYS,
  ...FILE_METRIC_CONTINUOUS_KEYS
];

/**
 * 校验一份冻结快照内部引用一致：
 * 顶层 / summary / manifest 的 snapshotId、sessionId 必须互相对应，
 * scopeVersion、metricVersion、hostEvidenceDigest 必须互相对应。
 * 纯函数只接受已经固定的快照，任何不一致都拒绝，不允许跨快照串证据。
 */
export function assertFrozenSnapshotConsistent(record: SessionInsightSnapshotRecord): void {
  const fail = (): never => {
    throw new SessionInsightReportError('INSIGHT_INPUT_LIMIT', INCONSISTENT_SNAPSHOT_MESSAGE);
  };
  if (record.summary.snapshotId !== record.snapshotId) fail();
  if (record.summary.sessionId !== record.sessionId) fail();
  if (record.manifest.snapshotId !== record.snapshotId) fail();
  if (record.manifest.sessionId !== record.sessionId) fail();
  if (record.summary.scopeVersion !== record.manifest.scopeVersion) fail();
  if (record.manifest.versions.metricVersion !== record.versions.metricVersion) fail();
  if (record.manifest.hostEvidenceDigest !== record.hostEvidence.digest) fail();
  if (!record.summary.sources.some(source => source.sourceKey === record.summary.primarySourceKey)) {
    fail();
  }
}

export interface CompareSessionSnapshotsInput {
  left: SessionInsightSnapshotRecord;
  right: SessionInsightSnapshotRecord;
}

function incomparableMetric(reasonCodes: readonly string[]): MetricComparison {
  return {
    leftValue: null,
    rightValue: null,
    delta: null,
    percentChange: null,
    isBaselineZero: false,
    comparable: false,
    reasonCodes: [...reasonCodes]
  };
}

/**
 * 比较两份完整固定快照，输出冻结契约 SessionInsightCompareResponse 对应结构。
 *
 * 规则（设计第 6.3 节）：
 * - 两侧 metricVersion 与范围规则（scopeVersion）一致才逐项给差值；否则整体不可比，
 *   每项 delta/percentChange 为 null 并带固定原因。
 * - 单项任一侧 null / conflict / partial / unavailable 不算 delta，
 *   原因由共享 calculateMetricComparison 给出。
 * - 左侧为 0 时只给绝对差，percentChange 为 null 且标记 BASELINE_ZERO。
 * - 不重算任何指标，不按模型归因，不合计费用；数值与质量原样取自已发布摘要。
 */
export function compareSessionSnapshots(
  input: CompareSessionSnapshotsInput
): SessionInsightCompareResponse {
  const { left, right } = input;
  assertFrozenSnapshotConsistent(left);
  assertFrozenSnapshotConsistent(right);

  const incomparableReasons: string[] = [];
  if (left.versions.metricVersion !== right.versions.metricVersion) {
    incomparableReasons.push('METRIC_VERSION_MISMATCH');
  }
  if (left.summary.scopeVersion !== right.summary.scopeVersion) {
    incomparableReasons.push('SCOPE_VERSION_MISMATCH');
  }
  const comparable = incomparableReasons.length === 0;

  const metricDiffs: Record<string, MetricComparison> = {};
  for (const key of FILE_METRIC_KEYS) {
    if (!comparable) {
      metricDiffs[key] = incomparableMetric(incomparableReasons);
      continue;
    }
    metricDiffs[key] = calculateMetricComparison(
      left.summary.aggregateMetrics[key],
      right.summary.aggregateMetrics[key]
    );
  }

  return sessionInsightCompareResponseSchema.parse({
    left: left.summary,
    right: right.summary,
    leftManifest: left.manifest,
    rightManifest: right.manifest,
    leftHostEvidence: left.hostEvidence,
    rightHostEvidence: right.hostEvidence,
    comparable,
    incomparableReasons,
    metricDiffs
  });
}
