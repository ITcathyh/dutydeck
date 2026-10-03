/**
 * Session Insight 纯统计投影（设计 6.1 / 6.2）。
 *
 * 本模块不接 app/service、不读 SQL/日志/模型、不做 IO：T4c 在短读事务中枚举候选行、
 * 固定 snapshot 后调用这里的纯函数。两类入口：
 *   - buildSessionInsightSummary：单会话 primary 投影，aggregateMetrics 只取 primary 源；
 *   - buildSessionInsightSummaryResponse：跨会话候选目录的分组、去重、coverage 与分页。
 * 所有输出经契约 schema parse + 深度冻结；null 绝不折算成 0。
 */
import {
  analyzeFilesResultSchema,
  fileMetricsSchema,
  sessionInsightSummaryResponseSchema,
  sessionInsightSummarySchema,
  type AnalyzeFilesResult,
  type CountMetric,
  type ContinuousMetric,
  type FileAnalysisResult,
  type FileMetrics,
  type InsightAvailability,
  type InsightFreshness,
  type Metric,
  type RefreshState,
  type SessionInsightSummary,
  type SessionInsightSummaryResponse,
  type SummaryGroupRow,
  type SummarySessionRow,
  type TaskRequestV1,
  type TraceEvent,
  type UsageCategory,
  emptyWorkspaceOrganization,
  resolveWorkspaceGroupId,
  sessionWorkspaceDirectory,
  type WorkspaceOrganization
} from '@dutydeck/shared';
import { classifyUsage } from './usage-ledger.js';

// ---------------------------------------------------------------------------
// 常量与错误
// ---------------------------------------------------------------------------

const METRIC_KEYS = Object.keys(fileMetricsSchema.shape) as (keyof FileMetrics)[];
const NON_ADDABLE_DURATION_KEYS = new Set<keyof FileMetrics>([
  'elapsedDurationMs', 'activeDurationMs', 'idleDurationMs'
]);
const SUM_DURATION_KEYS = new Set<keyof FileMetrics>(['pairedToolDurationMs']);
/** 峰值是 max 观测语义，跨来源绝不相加。 */
const MAX_METRIC_KEYS = new Set<keyof FileMetrics>(['peakContext']);
/** 容量是元数据：多源值一致才可保留，不同模型/范围不可比时为 unknown。 */
const CONTEXT_WINDOW_KEY = 'contextWindow' as const;
const RATE_KEY = 'toolFailureRate' as const;
/** 可安全相加的计数类指标（Token、轮次、调用数等）。 */
const SUM_COUNT_KEYS = new Set<keyof FileMetrics>(METRIC_KEYS.filter(k =>
  !NON_ADDABLE_DURATION_KEYS.has(k) && !SUM_DURATION_KEYS.has(k)
  && !MAX_METRIC_KEYS.has(k) && k !== CONTEXT_WINDOW_KEY && k !== RATE_KEY));
const MAX_KEY_EVIDENCE_PER_KIND = 10;

/** 单会话摘要无法构造：T4c 据此返回 host-only 详情，不得虚构来源。 */
export class InsightSummaryBuildError extends Error {
  constructor(
    readonly code: 'INSIGHT_PRIMARY_SOURCE_NOT_FOUND' | 'INSIGHT_PRIMARY_SOURCE_UNVERIFIED',
    message: string
  ) {
    super(message);
    this.name = 'InsightSummaryBuildError';
  }
}

/** 分页 cursor 非法或与当前过滤条件不匹配：T4c 映射为固定 400，不能冒泡成 500。 */
export class InsightSummaryCursorError extends Error {
  readonly code = 'INSIGHT_SUMMARY_BAD_CURSOR' as const;
  constructor() {
    super('Invalid session insight summary cursor');
    this.name = 'InsightSummaryCursorError';
  }
}

// ---------------------------------------------------------------------------
// 安全数值
// ---------------------------------------------------------------------------

/** 非负安全整数加法：溢出返回 null，绝不产生 Infinity/精度损失。 */
function safeAdd(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return null;
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum < a) return null;
  return sum;
}

function unionReasons(parts: Pick<Metric, 'reasonCodes'>[]): string[] {
  return [...new Set(parts.flatMap(p => p.reasonCodes))].sort();
}

/**
 * 八种 quality 不是线性准确度等级（设计 4.2），不做 worst-rank 排序。
 * 合计只采用 value 非 null 的观察：全部同质时保留该 quality；混合语义时
 * 标 derived（这是跨源推导值），各部分原因码与 coverage 完整保留。
 */
function mergeQuality(parts: Metric[]): Metric['quality'] {
  const qualities = new Set(parts.map(p => p.quality));
  return qualities.size === 1 ? [...qualities][0]! : 'derived';
}

/** 合计可加计数指标。只采用 available/partial 且 value 非 null 的观察；
 * 无可用观察 → null（不补零）；安全整数溢出 → null + AGGREGATE_OVERFLOW。 */
function combineCountMetrics(parts: CountMetric[]): { metric: CountMetric; overflow: boolean } {
  const evidence = parts.reduce((acc, p) => safeAdd(acc, p.evidenceCount) ?? Number.MAX_SAFE_INTEGER, 0);
  const missing = parts.reduce((acc, p) => safeAdd(acc, p.missingCount) ?? Number.MAX_SAFE_INTEGER, 0);
  const cappedEvidence = Math.min(evidence, Number.MAX_SAFE_INTEGER);
  const cappedMissing = Math.min(missing, Number.MAX_SAFE_INTEGER);
  const reasons = unionReasons(parts);
  const usable = parts.filter(p => p.value !== null && (p.status === 'available' || p.status === 'partial'));
  if (usable.length === 0) {
    return {
      metric: {
        value: null, quality: 'unknown', status: 'unavailable',
        evidenceCount: cappedEvidence, missingCount: cappedMissing,
        reasonCodes: reasons.length ? reasons : ['NO_INCLUDED_OBSERVATIONS']
      },
      overflow: false
    };
  }
  let total = 0;
  for (const part of usable) {
    const next = safeAdd(total, part.value as number);
    if (next === null) {
      return {
        metric: {
          value: null, quality: 'unknown', status: 'unavailable',
          evidenceCount: cappedEvidence, missingCount: cappedMissing,
          reasonCodes: [...new Set([...reasons, 'AGGREGATE_OVERFLOW'])].sort()
        },
        overflow: true
      };
    }
    total = next;
  }
  const status = usable.some(p => p.status === 'partial') ? 'partial' : 'available';
  return {
    metric: {
      value: total, quality: mergeQuality(usable), status,
      evidenceCount: cappedEvidence, missingCount: cappedMissing, reasonCodes: reasons
    },
    overflow: false
  };
}

/** 合计可证明独立的连续时长（paired tool）。必须为有限非负数；仅在非 finite / 无效时标 overflow。 */
function combineAddableDuration(parts: ContinuousMetric[]): { metric: ContinuousMetric; overflow: boolean } {
  const evidence = parts.reduce((acc, p) => safeAdd(acc, p.evidenceCount) ?? Number.MAX_SAFE_INTEGER, 0);
  const missing = parts.reduce((acc, p) => safeAdd(acc, p.missingCount) ?? Number.MAX_SAFE_INTEGER, 0);
  const cappedEvidence = Math.min(evidence, Number.MAX_SAFE_INTEGER);
  const cappedMissing = Math.min(missing, Number.MAX_SAFE_INTEGER);
  const reasons = unionReasons(parts);
  const usable = parts.filter(p => p.value !== null && (p.status === 'available' || p.status === 'partial'));
  if (usable.length === 0) {
    return {
      metric: {
        value: null, quality: 'unknown', status: 'unavailable',
        evidenceCount: cappedEvidence, missingCount: cappedMissing,
        reasonCodes: reasons.length ? reasons : ['NO_INCLUDED_OBSERVATIONS']
      },
      overflow: false
    };
  }
  let total = 0;
  for (const part of usable) {
    const val = part.value as number;
    if (!Number.isFinite(val) || val < 0) {
      return {
        metric: {
          value: null, quality: 'unknown', status: 'unavailable',
          evidenceCount: cappedEvidence, missingCount: cappedMissing,
          reasonCodes: [...new Set([...reasons, 'AGGREGATE_OVERFLOW'])].sort()
        },
        overflow: true
      };
    }
    const next = total + val;
    if (!Number.isFinite(next) || next < total) {
      return {
        metric: {
          value: null, quality: 'unknown', status: 'unavailable',
          evidenceCount: cappedEvidence, missingCount: cappedMissing,
          reasonCodes: [...new Set([...reasons, 'AGGREGATE_OVERFLOW'])].sort()
        },
        overflow: true
      };
    }
    total = next;
  }
  const status = usable.some(p => p.status === 'partial') ? 'partial' : 'available';
  return {
    metric: {
      value: total, quality: mergeQuality(usable), status,
      evidenceCount: cappedEvidence, missingCount: cappedMissing, reasonCodes: reasons
    },
    overflow: false
  };
}

/** 峰值跨来源取最大观测，不相加。 */
function combineMaxMetric(parts: CountMetric[]): CountMetric {
  const evidence = parts.reduce((acc, p) => safeAdd(acc, p.evidenceCount) ?? Number.MAX_SAFE_INTEGER, 0);
  const missing = parts.reduce((acc, p) => safeAdd(acc, p.missingCount) ?? Number.MAX_SAFE_INTEGER, 0);
  const reasons = unionReasons(parts);
  const usable = parts.filter(p => p.value !== null && (p.status === 'available' || p.status === 'partial'));
  if (usable.length === 0) {
    return {
      value: null, quality: 'unknown', status: 'unavailable',
      evidenceCount: Math.min(evidence, Number.MAX_SAFE_INTEGER),
      missingCount: Math.min(missing, Number.MAX_SAFE_INTEGER),
      reasonCodes: reasons.length ? reasons : ['NO_INCLUDED_OBSERVATIONS']
    };
  }
  return {
    value: Math.max(...usable.map(p => p.value as number)),
    quality: mergeQuality(usable),
    status: usable.some(p => p.status === 'partial') ? 'partial' : 'available',
    evidenceCount: Math.min(evidence, Number.MAX_SAFE_INTEGER),
    missingCount: Math.min(missing, Number.MAX_SAFE_INTEGER),
    reasonCodes: reasons
  };
}

/** 上下文窗口是模型/范围元数据：所有来源值一致才保留；不可比或多值时 unknown。 */
function combineContextWindow(parts: CountMetric[]): CountMetric {
  const evidence = parts.reduce((acc, p) => safeAdd(acc, p.evidenceCount) ?? Number.MAX_SAFE_INTEGER, 0);
  const missing = parts.reduce((acc, p) => safeAdd(acc, p.missingCount) ?? Number.MAX_SAFE_INTEGER, 0);
  const reasons = unionReasons(parts);
  const usable = parts.filter(p => p.value !== null && (p.status === 'available' || p.status === 'partial'));
  if (usable.length === 0) {
    return {
      value: null, quality: 'unknown', status: 'unavailable',
      evidenceCount: Math.min(evidence, Number.MAX_SAFE_INTEGER),
      missingCount: Math.min(missing, Number.MAX_SAFE_INTEGER),
      reasonCodes: reasons.length ? reasons : ['NO_INCLUDED_OBSERVATIONS']
    };
  }
  const distinct = new Set(usable.map(p => p.value as number));
  if (distinct.size > 1) {
    return {
      value: null, quality: 'unknown', status: 'unavailable',
      evidenceCount: Math.min(evidence, Number.MAX_SAFE_INTEGER),
      missingCount: Math.min(missing, Number.MAX_SAFE_INTEGER),
      reasonCodes: [...new Set([...reasons, 'CONTEXT_WINDOW_INCOMPATIBLE'])].sort()
    };
  }
  return {
    value: [...distinct][0]!, quality: mergeQuality(usable),
    status: usable.some(p => p.status === 'partial') ? 'partial' : 'available',
    evidenceCount: Math.min(evidence, Number.MAX_SAFE_INTEGER),
    missingCount: Math.min(missing, Number.MAX_SAFE_INTEGER),
    reasonCodes: reasons
  };
}

/** 失败率只用双方均可判定的调用做分母重算；分母未知或为 0 → null。 */
function combineFailureRate(sources: FileMetrics[]): ContinuousMetric {
  const failParts: CountMetric[] = [];
  const succParts: CountMetric[] = [];
  for (const metrics of sources) {
    failParts.push(metrics.toolFailures);
    succParts.push(metrics.toolSuccesses);
  }
  const known = sources.filter(m =>
    m.toolFailures.value !== null && m.toolFailures.status === 'available'
    && m.toolSuccesses.value !== null && m.toolSuccesses.status === 'available');
  const evidence = failParts.concat(succParts).reduce((acc, p) => safeAdd(acc, p.evidenceCount) ?? Number.MAX_SAFE_INTEGER, 0);
  const missing = failParts.concat(succParts).reduce((acc, p) => safeAdd(acc, p.missingCount) ?? Number.MAX_SAFE_INTEGER, 0);
  if (known.length === 0) {
    return {
      value: null, quality: 'unavailable', status: 'unavailable',
      evidenceCount: Math.min(evidence, Number.MAX_SAFE_INTEGER),
      missingCount: Math.min(missing, Number.MAX_SAFE_INTEGER),
      reasonCodes: ['RATE_DENOMINATOR_UNKNOWN']
    };
  }
  const failures = known.reduce((sum, m) => sum + (m.toolFailures.value as number), 0);
  const successes = known.reduce((sum, m) => sum + (m.toolSuccesses.value as number), 0);
  const denominator = failures + successes;
  if (denominator === 0) {
    return {
      value: null, quality: 'unavailable', status: 'unavailable',
      evidenceCount: Math.min(evidence, Number.MAX_SAFE_INTEGER),
      missingCount: Math.min(missing, Number.MAX_SAFE_INTEGER),
      reasonCodes: ['NO_DETERMINABLE_CALLS']
    };
  }
  return {
    value: Number((failures / denominator).toFixed(6)),
    quality: 'derived', status: 'available',
    evidenceCount: Math.min(evidence, Number.MAX_SAFE_INTEGER),
    missingCount: Math.min(missing, Number.MAX_SAFE_INTEGER),
    reasonCodes: []
  };
}

function unavailableMetric(reason: string, continuous: boolean): Metric {
  const base = {
    value: null, quality: 'unavailable' as const, status: 'unavailable' as const,
    evidenceCount: 0, missingCount: 1, reasonCodes: [reason]
  };
  return continuous ? base as ContinuousMetric : base as CountMetric;
}

function unavailableFileMetrics(reason: string): FileMetrics {
  const result = {} as FileMetrics;
  for (const key of METRIC_KEYS) {
    (result as Record<string, Metric>)[key as string] = unavailableMetric(
      reason,
      !SUM_COUNT_KEYS.has(key) && !MAX_METRIC_KEYS.has(key) && key !== CONTEXT_WINDOW_KEY
    );
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// 单会话 primary 投影（设计 6.1 单会话部分 / 6.2）
// ---------------------------------------------------------------------------

export type InsightSourceRole = 'primary' | 'subagent' | 'excluded';

export interface BuildSessionInsightSummaryInput {
  sessionId: string;
  snapshotId: string;
  /** 快照发布时刻（UTC ISO）。 */
  createdAt: string;
  primarySourceKey: string;
  /** 已核验身份、已脱敏并通过引擎契约校验的分析结果。 */
  result: AnalyzeFilesResult;
  /** 显式来源角色；缺省时 primary 取 primarySourceKey，其余按 streamIdentity 推断。 */
  sourceRoles?: Record<string, InsightSourceRole>;
}

/**
 * scopeRole 只表示会话内范围归属，绝不抬升引擎 eligibility：
 * fork/unknown 关系或引擎 excluded 的 primary 仍标 primary（保留单源观察），
 * 其 aggregation/relationship 原样保留，跨会话合计据此排除。error 文件一律 excluded。
 */
function effectiveScopeRole(file: FileAnalysisResult, input: BuildSessionInsightSummaryInput): InsightSourceRole {
  if (file.status === 'error') return 'excluded';
  if (file.sourceKey === input.primarySourceKey) return 'primary';
  const declared = input.sourceRoles?.[file.sourceKey];
  if (declared === 'primary') return 'excluded'; // 只有 primarySourceKey 能当 primary
  // 引擎已排除（fork/继承不清/重叠疑点）：保留为观察，但不进 subagent 分组。
  if (file.aggregation.eligibility === 'excluded') return 'excluded';
  // subagent 角色必须与已核验流身份一致，防止把 main 流误归入子 Agent。
  if (file.streamIdentity.kind === 'subagent') return 'subagent';
  return 'excluded';
}

function pickKeyEvidence(trace: TraceEvent[]): SessionInsightSummary['keyEvidenceEventIds'] {
  const failures = trace.filter(e => e.resultStatus === 'failure');
  const toolEvents = trace.filter(e =>
    (e.kind === 'tool_call' || e.kind === 'tool_result' || e.kind === 'tool_summary')
    && e.durationMs?.value !== null && e.durationMs?.value !== undefined);
  const tokenEvents = trace.filter(e => e.tokens !== null || e.rawUsage !== null);
  const tokenMagnitude = (e: TraceEvent): number => {
    const buckets = e.tokens ? [
      e.tokens.total, e.tokens.inputUncached, e.tokens.cacheRead, e.tokens.cacheWrite,
      e.tokens.output, e.tokens.reasoning
    ] : [];
    const raw = e.rawUsage ? [
      e.rawUsage.totalTokens, e.rawUsage.inputTokens, e.rawUsage.cachedInputTokens,
      e.rawUsage.cacheCreationInputTokens, e.rawUsage.outputTokens, e.rawUsage.reasoningOutputTokens
    ] : [];
    const values = [...buckets, ...raw].filter((v): v is number => typeof v === 'number');
    return values.length ? Math.max(...values) : -1;
  };
  const top = (events: TraceEvent[], score: (e: TraceEvent) => number): string[] =>
    [...events]
      .sort((a, b) => {
        const diff = score(b) - score(a);
        return diff !== 0 ? diff : a.eventId.localeCompare(b.eventId);
      })
      .slice(0, MAX_KEY_EVIDENCE_PER_KIND)
      .map(e => e.eventId);
  return {
    failures: top(failures, () => 0),
    slowCalls: top(toolEvents, e => e.durationMs?.value ?? -1),
    highTokenDeltas: top(tokenEvents, tokenMagnitude)
  };
}

function qualityOverview(metrics: FileMetrics): SessionInsightSummary['qualityOverview'] {
  const values = METRIC_KEYS.map(k => metrics[k]);
  const usable = values.filter(m => m.status === 'available' || m.status === 'partial');
  if (usable.length === 0) return 'unavailable';
  if (usable.some(m => m.quality === 'derived' || m.quality === 'estimated'
    || m.quality === 'inferred' || m.quality === 'heuristic')) return 'derived_or_estimated';
  return 'recorded';
}

/**
 * 由已核验 AnalyzeFilesResult 生成冻结的单会话摘要。aggregateMetrics 就是 primary
 * 源的指标，不与任何 subagent / excluded 源相加；错误文件只保留为 excluded 观察。
 */
export function buildSessionInsightSummary(input: BuildSessionInsightSummaryInput): SessionInsightSummary {
  const result = analyzeFilesResultSchema.parse(input.result);
  const primaryFile = result.files.find(f => f.sourceKey === input.primarySourceKey);
  if (!primaryFile) {
    throw new InsightSummaryBuildError(
      'INSIGHT_PRIMARY_SOURCE_NOT_FOUND',
      `primary source ${input.primarySourceKey} is not present in the analyzed files`
    );
  }
  if (primaryFile.status === 'error') {
    throw new InsightSummaryBuildError(
      'INSIGHT_PRIMARY_SOURCE_UNVERIFIED',
      `primary source ${input.primarySourceKey} is an error file; unverified metrics never become readable native results`
    );
  }
  if (primaryFile.relationship.kind === 'child') {
    throw new InsightSummaryBuildError(
      'INSIGHT_PRIMARY_SOURCE_UNVERIFIED',
      `primary source ${input.primarySourceKey} is a child stream and cannot be the session primary`
    );
  }
  if (primaryFile.streamIdentity.kind !== 'main') {
    throw new InsightSummaryBuildError(
      'INSIGHT_PRIMARY_SOURCE_UNVERIFIED',
      `primary source ${input.primarySourceKey} must be a main stream`
    );
  }

  const scoped = result.files.map(file => ({ file, role: effectiveScopeRole(file, input) }));
  const ordered = [
    ...scoped.filter(s => s.role === 'primary'),
    ...scoped.filter(s => s.role !== 'primary').sort((a, b) => a.file.sourceKey.localeCompare(b.file.sourceKey))
  ];

  const sources = ordered.map(({ file, role }) => ({
    sourceKey: file.sourceKey,
    client: file.client,
    streamIdentity: file.streamIdentity,
    sha256: file.sha256,
    status: file.status,
    scopeRole: role,
    // 错误文件的 metrics/models 未核验：读侧全部替换为不可用，不放行任何数字。
    metrics: file.status === 'error' ? unavailableFileMetrics(file.errorCode ?? 'ANALYSIS_ERROR') : file.metrics,
    models: file.status === 'error' ? [] : file.models,
    coverage: file.coverage,
    relationship: file.relationship,
    aggregation: file.aggregation,
    keyEvidenceEventIds: pickKeyEvidence(file.status === 'error' ? [] : file.trace)
  }));

  // evidence 只取自真实 retained trace；error 文件的 trace 不可信，不参与。
  const retainedTrace = result.files.filter(f => f.status !== 'error').flatMap(f => f.trace);
  const models = [...new Set(primaryFile.models)].sort();

  const summary = sessionInsightSummarySchema.parse({
    schemaVersion: 1,
    sessionId: input.sessionId,
    snapshotId: input.snapshotId,
    createdAt: input.createdAt,
    primarySourceKey: input.primarySourceKey,
    models,
    isMultiModel: models.length > 1,
    aggregateMetrics: primaryFile.metrics,
    qualityOverview: qualityOverview(primaryFile.metrics),
    sources,
    keyEvidenceEventIds: pickKeyEvidence(retainedTrace),
    pulseBuckets: primaryFile.pulseBuckets
  });
  return deepFreeze(summary);
}

// ---------------------------------------------------------------------------
// 用途 / 工作区推导（设计 6.1）
// ---------------------------------------------------------------------------

export type InsightUsageGroup = UsageCategory | 'mixed' | 'unknown';

export interface SessionUsageEvidence {
  source?: string | null;
  sourceId?: string | null;
  /** 真实 TaskRequestV1 与已核验的主动参与标记；proactive 缺证据时为 undefined。 */
  tasks?: Array<{ request?: TaskRequestV1; proactive?: boolean }>;
}

const BACKGROUND_ONLY_SOURCES = new Set([
  'lark-decision', 'lark-response', 'lark-memory', 'work_item', 'lark-leader'
]);

/**
 * 复用 usage-ledger.classifyUsage 与真实 TaskRequest。多个任务落入多类 → mixed；
 * proactive 证据缺失且该结论依赖 proactive 时 → unknown（不用 prompt 关键词或费用反推）。
 */
export function deriveSessionUsage(evidence: SessionUsageEvidence): InsightUsageGroup {
  const session = { source: evidence.source ?? undefined, sourceId: evidence.sourceId ?? undefined };
  const categories = new Set<InsightUsageGroup>();
  for (const task of evidence.tasks ?? []) {
    if (task.proactive === undefined) {
      const passive = classifyUsage(session, task.request, false).category;
      const active = classifyUsage(session, task.request, true).category;
      categories.add(passive === active ? passive : 'unknown');
    } else {
      categories.add(classifyUsage(session, task.request, task.proactive).category);
    }
  }
  if (categories.size === 0) {
    return session.source && BACKGROUND_ONLY_SOURCES.has(session.source) ? 'background' : 'unknown';
  }
  // 任一任务证据不足时整个会话保守为 unknown，不能靠其余任务把它强行归成 mixed。
  if (categories.has('unknown')) return 'unknown';
  return categories.size === 1 ? [...categories][0]! : 'mixed';
}

export interface WorkspaceCandidate {
  sessionId: string;
  cwd: string;
  workspaceSourceCwd?: string | null;
}

/** 工作区分组：worktree 会话按 workspaceSourceCwd 归回源仓库，避免把同仓库拆成多组。 */
export function resolveCandidateWorkspace(
  candidate: WorkspaceCandidate,
  organization: WorkspaceOrganization = emptyWorkspaceOrganization()
): string {
  const custom = resolveWorkspaceGroupId(
    { id: candidate.sessionId, cwd: candidate.cwd, workspaceSourceCwd: candidate.workspaceSourceCwd ?? undefined },
    organization
  );
  return custom ?? sessionWorkspaceDirectory({
    cwd: candidate.cwd,
    workspaceSourceCwd: candidate.workspaceSourceCwd ?? undefined
  });
}

// ---------------------------------------------------------------------------
// 跨会话汇总的窄输入（T4c 在短读事务中组装，不依赖 T2 私有实现）
// ---------------------------------------------------------------------------

export interface SummarySnapshotRef {
  snapshotId: string;
  availability: InsightAvailability;
  freshness: InsightFreshness;
  /** manifest.versions.metricVersion：只有同版本才能合计。 */
  metricVersion: string;
  /** 固定快照摘要（buildSessionInsightSummary 产物或同等冻结契约对象）。 */
  summary: SessionInsightSummary;
}

export interface SummaryCandidate extends SessionUsageEvidence, WorkspaceCandidate {
  agentId: string;
  archivedAt?: string | null;
  /** Session.createdAt（UTC ISO），时间窗按它过滤。 */
  createdAt: string;
  refreshState: RefreshState;
  errorCode?: string | null;
  lastCheckedAt?: string | null;
  snapshot?: SummarySnapshotRef;
}

export interface SummaryCohortFilter {
  workspace?: string;
  agentId?: string;
  usage?: InsightUsageGroup;
  from?: string;
  to?: string;
  includeArchived?: boolean;
}

export type SummaryGroupBy = 'workspace' | 'agent' | 'model' | 'usage';

// 排除原因（同时写入 coverage.excludedReasons / metricAttributions.reason）。
const R = {
  notAnalyzed: 'not_analyzed',
  sharedDuplicate: 'shared_duplicate_source',
  versionConflict: 'snapshot_version_conflict',
  metricVersionConflict: 'metric_version_conflict',
  forkRelationship: 'fork_relationship',
  inheritanceUnknown: 'inheritance_unknown',
  sourceExcluded: 'source_aggregation_excluded',
  metricUnavailable: 'metric_unavailable',
  metricConflict: 'metric_conflict',
  durationNotAddable: 'duration_not_addable',
  contextWindowIncompatible: 'context_window_incompatible',
  overflow: 'aggregate_overflow'
} as const;

function primarySourceOf(snapshot: SummarySnapshotRef) {
  return snapshot.summary.sources.find(s => s.scopeRole === 'primary');
}

/** primary 源在跨会话合计层面是否合格（summary 已保证，缓存历史数据需再防一次）。 */
function sourceIneligibilityReason(source: NonNullable<ReturnType<typeof primarySourceOf>>): string | null {
  if (source.aggregation.eligibility === 'excluded') return R.sourceExcluded;
  if (source.relationship.kind === 'fork') return R.forkRelationship;
  if (source.relationship.kind === 'unknown' || source.relationship.kind === 'child') return R.inheritanceUnknown;
  return null;
}

function modelGroupOf(snapshot: SummarySnapshotRef | undefined): string {
  if (!snapshot) return 'unknown';
  if (snapshot.summary.models.length > 1) return 'multi_model';
  if (snapshot.summary.models.length === 1) return snapshot.summary.models[0]!;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// 候选过滤（与缓存无关：冷/热候选分母必然一致）
// ---------------------------------------------------------------------------

export function filterSummaryCandidates(
  candidates: readonly SummaryCandidate[],
  filter: SummaryCohortFilter,
  organization: WorkspaceOrganization = emptyWorkspaceOrganization()
): SummaryCandidate[] {
  const from = filter.from ? Date.parse(filter.from) : null;
  const to = filter.to ? Date.parse(filter.to) : null;
  return candidates.filter(c => {
    if (!filter.includeArchived && c.archivedAt) return false;
    if (from !== null || to !== null) {
      const t = Date.parse(c.createdAt);
      if (!Number.isFinite(t)) return false;
      if (from !== null && t < from) return false;
      if (to !== null && t >= to) return false; // [from, to)
    }
    if (filter.agentId !== undefined && c.agentId !== filter.agentId) return false;
    if (filter.usage !== undefined && deriveSessionUsage(c) !== filter.usage) return false;
    if (filter.workspace !== undefined && resolveCandidateWorkspace(c, organization) !== filter.workspace) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// cursor（绑定过滤条件与稳定行序 createdAt asc, sessionId asc）
// ---------------------------------------------------------------------------

function filterSignature(filter: SummaryCohortFilter, groupBy: SummaryGroupBy): string {
  return JSON.stringify([
    filter.workspace ?? null,
    filter.agentId ?? null,
    filter.usage ?? null,
    filter.from ?? null,
    filter.to ?? null,
    filter.includeArchived ?? false,
    groupBy
  ]);
}

function encodeCursor(createdAt: string, sessionId: string, signature: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt, id: sessionId, f: signature }), 'utf8')
    .toString('base64url');
}

function decodeCursor(cursor: string, signature: string): { createdAt: string; sessionId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InsightSummaryCursorError();
  }
  if (typeof parsed !== 'object' || parsed === null) throw new InsightSummaryCursorError();
  const payload = parsed as Record<string, unknown>;
  if (typeof payload.t !== 'string' || typeof payload.id !== 'string' || typeof payload.f !== 'string'
    || payload.f !== signature || Number.isNaN(Date.parse(payload.t))) {
    throw new InsightSummaryCursorError();
  }
  return { createdAt: payload.t, sessionId: payload.id };
}

// ---------------------------------------------------------------------------
// 跨会话主入口
// ---------------------------------------------------------------------------

interface PreparedCandidate {
  candidate: SummaryCandidate;
  workspace: string;
  usage: InsightUsageGroup;
  modelGroup: string;
  /** 非 null 表示该行不参与合计的会话级原因；shared/conflict 也在此标记。 */
  sessionExclusion: string | null;
  shared: boolean;
  ownerDuplicateCount: number;
  note?: string;
  /** 合格 contributor 时的 primary 源观察。 */  primary: ReturnType<typeof primarySourceOf>;
  metricVersion: string | null;
}

export interface BuildSummaryOptions {
  candidates: readonly SummaryCandidate[];
  filter?: SummaryCohortFilter;
  groupBy?: SummaryGroupBy;
  organization?: WorkspaceOrganization;
  limit: number;
  cursor?: string;
}

export function buildSessionInsightSummaryResponse(options: BuildSummaryOptions): SessionInsightSummaryResponse {
  const filter = options.filter ?? {};
  const groupBy = options.groupBy ?? 'workspace';
  const organization = options.organization ?? emptyWorkspaceOrganization();
  const signature = filterSignature(filter, groupBy);
  const cursorPosition = options.cursor ? decodeCursor(options.cursor, signature) : null;

  const filtered = filterSummaryCandidates(options.candidates, filter, organization);
  // 稳定归属行序：Session.createdAt asc, sessionId asc；输入乱序不改变结果。
  const ordered = [...filtered].sort((a, b) => {
    const diff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return diff !== 0 ? diff : a.sessionId.localeCompare(b.sessionId);
  });

  // 全局 sourceKey + hash 去重：同 key 同 hash 只算最早归属行；同 key 不同 hash
  // 全部 snapshot_version_conflict，不按 mtime 选赢家。
  const sourceOwners = new Map<string, { hash: string; sessionId: string }>();
  const conflictKeys = new Set<string>();
  for (const c of ordered) {
    const primary = c.snapshot ? primarySourceOf(c.snapshot) : undefined;
    if (!primary) continue;
    const existing = sourceOwners.get(primary.sourceKey);
    if (!existing) {
      sourceOwners.set(primary.sourceKey, { hash: primary.sha256, sessionId: c.sessionId });
    } else if (existing.hash !== primary.sha256) {
      conflictKeys.add(primary.sourceKey);
    }
  }
  const duplicateCounts = new Map<string, number>(); // ownerSessionId -> 共享行数
  const conflictSessionSets = new Map<string, Set<string>>();
  for (const c of ordered) {
    const primary = c.snapshot ? primarySourceOf(c.snapshot) : undefined;
    if (!primary) continue;
    const owner = sourceOwners.get(primary.sourceKey);
    if (conflictKeys.has(primary.sourceKey)) {
      if (!conflictSessionSets.has(primary.sourceKey)) conflictSessionSets.set(primary.sourceKey, new Set());
      conflictSessionSets.get(primary.sourceKey)!.add(c.sessionId);
    } else if (owner && owner.sessionId !== c.sessionId) {
      duplicateCounts.set(owner.sessionId, (duplicateCounts.get(owner.sessionId) ?? 0) + 1);
    }
  }

  const prepared: PreparedCandidate[] = ordered.map(c => {
    const workspace = resolveCandidateWorkspace(c, organization);
    const usage = deriveSessionUsage(c);
    const modelGroup = modelGroupOf(c.snapshot);
    const primary = c.snapshot ? primarySourceOf(c.snapshot) : undefined;
    let sessionExclusion: string | null = null;
    let shared = false;
    let note: string | undefined;
    if (!c.snapshot || !primary) {
      sessionExclusion = R.notAnalyzed;
    } else if (conflictKeys.has(primary.sourceKey)) {
      sessionExclusion = R.versionConflict;
      note = `Native source has ${R.versionConflict} across sessions: ${[...conflictSessionSets.get(primary.sourceKey)!].sort().join(', ')}`;
    } else {
      const owner = sourceOwners.get(primary.sourceKey)!;
      if (owner.sessionId !== c.sessionId) {
        sessionExclusion = R.sharedDuplicate;
        shared = true;
        note = `Native source attributed to earliest session ${owner.sessionId}`;
      } else {
        sessionExclusion = sourceIneligibilityReason(primary);
        const copies = duplicateCounts.get(c.sessionId) ?? 0;
        if (copies > 0) note = `Native source shared with ${copies} other session(s)`;
      }
    }
    return {
      candidate: c, workspace, usage, modelGroup, sessionExclusion, shared,
      ownerDuplicateCount: duplicateCounts.get(c.sessionId) ?? 0, note, primary,
      metricVersion: c.snapshot && primary && sessionExclusion === null ? c.snapshot.metricVersion : null
    };
  });

  // 分组与覆盖统计（groups/counts 覆盖整个已筛选目录，不受分页影响）。
  const groups = new Map<string, PreparedCandidate[]>();
  for (const p of prepared) {
    const key = groupBy === 'workspace' ? p.workspace
      : groupBy === 'agent' ? p.candidate.agentId
      : groupBy === 'usage' ? p.usage
      : p.modelGroup;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  /** 会话 × 指标的最终判定，同时驱动 metricCoverage 与行级 metricAttributions。 */
  const attributions = new Map<string, Partial<Record<keyof FileMetrics, { included: boolean; reason?: string }>>>();
  const recordVerdict = (
    sessionId: string, metricKey: keyof FileMetrics, verdict: { included: boolean; reason?: string }
  ) => {
    attributions.set(sessionId, { ...attributions.get(sessionId), [metricKey]: verdict });
  };

  /** 单个成员对单个指标是否可合计；不可合计必须给出稳定原因码。 */
  const metricVerdict = (
    p: PreparedCandidate, metricKey: keyof FileMetrics, versionMixed: boolean
  ): { included: boolean; reason?: string } => {
    if (p.sessionExclusion) return { included: false, reason: p.sessionExclusion };
    if (versionMixed) return { included: false, reason: R.metricVersionConflict };
    if (!p.primary) return { included: false, reason: R.notAnalyzed };
    if (metricKey === RATE_KEY) {
      const failuresKnown = p.primary.metrics.toolFailures.value !== null
        && p.primary.metrics.toolFailures.status === 'available';
      const successesKnown = p.primary.metrics.toolSuccesses.value !== null
        && p.primary.metrics.toolSuccesses.status === 'available';
      return failuresKnown && successesKnown
        ? { included: true }
        : { included: false, reason: R.metricUnavailable };
    }
    const metric = p.primary.metrics[metricKey];
    if (metric.value === null || metric.status === 'unavailable') {
      return { included: false, reason: R.metricUnavailable };
    }
    if (metric.status === 'conflict') return { included: false, reason: R.metricConflict };
    return { included: true };
  };

  const groupRows: SummaryGroupRow[] = [...groups.entries()].map(([groupKey, members]) => {
    const candidateSessions = members.length;
    let withSnapshot = 0;
    let partialSnapshots = 0;
    let failedRefreshes = 0;
    let staleSnapshots = 0;
    let freshnessUnknown = 0;
    for (const p of members) {
      if (p.candidate.snapshot) {
        withSnapshot += 1;
        if (p.candidate.snapshot.availability === 'partial') partialSnapshots += 1;
        if (p.candidate.snapshot.freshness === 'stale') staleSnapshots += 1;
        if (p.candidate.snapshot.freshness === 'unknown') freshnessUnknown += 1;
      } else {
        freshnessUnknown += 1;
      }
      if (p.candidate.refreshState === 'failed') failedRefreshes += 1;
    }

    // 混 metricVersion：所有指标不合计（explicit incompatible），coverage 逐项给原因。
    const contributingMembers = members.filter(p => p.sessionExclusion === null && p.primary && p.metricVersion);
    const versions = new Set(contributingMembers.map(p => p.metricVersion));
    const versionMixed = versions.size > 1;

    const sessionReasons = new Map<string, number>();
    for (const p of members) {
      if (p.sessionExclusion) {
        sessionReasons.set(p.sessionExclusion, (sessionReasons.get(p.sessionExclusion) ?? 0) + 1);
      } else if (versionMixed) {
        // 会话本身合格，但组内 metricVersion 混杂导致整组不可合计。
        sessionReasons.set(R.metricVersionConflict, (sessionReasons.get(R.metricVersionConflict) ?? 0) + 1);
      }
    }

    const metricCoverage = {} as SummaryGroupRow['metricCoverage'];
    const aggregate = (versionMixed ? null : {}) as FileMetrics | null;

    for (const metricKey of METRIC_KEYS) {
      const included: PreparedCandidate[] = [];
      const reasonCounts = new Map<string, number>();
      for (const p of members) {
        const verdict = metricVerdict(p, metricKey, versionMixed);
        recordVerdict(p.candidate.sessionId, metricKey, verdict);
        if (verdict.included) included.push(p);
        else reasonCounts.set(verdict.reason!, (reasonCounts.get(verdict.reason!) ?? 0) + 1);
      }
      // 不同原生流的 elapsed/active/idle 可能重叠：只有多于一个源可提供值时才不可加；
      // 仅一个源有值、其余未知时仍保留单源观察，不把未知当等待时间。
      if (NON_ADDABLE_DURATION_KEYS.has(metricKey) && included.length > 1) {
        for (const p of included) {
          recordVerdict(p.candidate.sessionId, metricKey, { included: false, reason: R.durationNotAddable });
          reasonCounts.set(R.durationNotAddable, (reasonCounts.get(R.durationNotAddable) ?? 0) + 1);
        }
        included.length = 0;
      }

      let combined: Metric | null = null;
      let overflow = false;
      if (!versionMixed && included.length > 0) {
        if (metricKey === RATE_KEY) {
          combined = combineFailureRate(included.map(p => p.primary!.metrics));
        } else if (NON_ADDABLE_DURATION_KEYS.has(metricKey)) {
          combined = included[0]!.primary!.metrics[metricKey]; // 多源时已全部标 duration_not_addable
        } else if (MAX_METRIC_KEYS.has(metricKey)) {
          combined = combineMaxMetric(included.map(p => p.primary!.metrics[metricKey] as CountMetric));
        } else if (metricKey === CONTEXT_WINDOW_KEY) {
          combined = combineContextWindow(included.map(p => p.primary!.metrics[metricKey] as CountMetric));
          if (combined.reasonCodes.includes('CONTEXT_WINDOW_INCOMPATIBLE')) {
            for (const p of included) {
              recordVerdict(p.candidate.sessionId, metricKey, { included: false, reason: R.contextWindowIncompatible });
              reasonCounts.set(R.contextWindowIncompatible, (reasonCounts.get(R.contextWindowIncompatible) ?? 0) + 1);
            }
            included.length = 0;
          }
        } else if (SUM_COUNT_KEYS.has(metricKey)) {
          const result = combineCountMetrics(included.map(p => p.primary!.metrics[metricKey] as CountMetric));
          combined = result.metric;
          overflow = result.overflow;
        } else if (SUM_DURATION_KEYS.has(metricKey)) {
          const result = combineAddableDuration(included.map(p => p.primary!.metrics[metricKey] as ContinuousMetric));
          combined = result.metric;
          overflow = result.overflow;
        }
      }

      if (overflow) {
        // 安全整数溢出：把合计成员改判 excluded，组指标保持 null + 明确原因码。
        for (const p of included) {
          recordVerdict(p.candidate.sessionId, metricKey, { included: false, reason: R.overflow });
          reasonCounts.set(R.overflow, (reasonCounts.get(R.overflow) ?? 0) + 1);
        }
        included.length = 0;
        combined = unavailableMetric(
          'AGGREGATE_OVERFLOW',
          SUM_DURATION_KEYS.has(metricKey) || NON_ADDABLE_DURATION_KEYS.has(metricKey) || metricKey === RATE_KEY
        );
      }

      // 有成员被排除（未分析/该指标未知/冲突等）时，合计只是已知子集：available 降 partial。
      if (combined && combined.status === 'available' && reasonCounts.size > 0) {
        combined = {
          ...combined,
          status: 'partial',
          reasonCodes: [...new Set([...combined.reasonCodes, 'PARTIAL_SOURCE_COVERAGE'])].sort()
        };
      }

      const continuous = NON_ADDABLE_DURATION_KEYS.has(metricKey)
        || SUM_DURATION_KEYS.has(metricKey) || metricKey === RATE_KEY;
      if (aggregate) (aggregate as Record<string, Metric>)[metricKey as string] = combined
        ?? unavailableMetric([...reasonCounts.keys()].sort()[0] ?? R.metricUnavailable, continuous);
      metricCoverage[metricKey as string] = {
        includedCount: included.length,
        excludedCount: candidateSessions - included.length,
        excludedReasons: Object.fromEntries([...reasonCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])))
      };
    }

    const groupIncluded = versionMixed ? 0 : contributingMembers.length;
    const row: SummaryGroupRow = {
      groupKey,
      candidateSessions,
      withSnapshot,
      withoutSnapshot: candidateSessions - withSnapshot,
      partialSnapshots,
      failedRefreshes,
      staleSnapshots,
      freshnessUnknown,
      includedCount: groupIncluded,
      excludedCount: candidateSessions - groupIncluded,
      excludedReasons: Object.fromEntries([...sessionReasons.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      metricCoverage,
      aggregateMetrics: groupIncluded === 0 ? null : aggregate
    };
    return row;
  }).sort((a, b) => a.groupKey.localeCompare(b.groupKey));

  // 分页只切 sessions：cursor 之后的稳定行序（时间戳 + sessionId 决胜）。
  const cursorTime = cursorPosition ? Date.parse(cursorPosition.createdAt) : null;
  const paged: PreparedCandidate[] = [];
  for (const p of prepared) {
    if (cursorTime !== null) {
      const t = Date.parse(p.candidate.createdAt);
      const after = t > cursorTime
        || (t === cursorTime && p.candidate.sessionId.localeCompare(cursorPosition!.sessionId) > 0);
      if (!after) continue;
    }
    paged.push(p);
    if (paged.length >= options.limit) break;
  }

  const sessionRows: SummarySessionRow[] = paged.map(p => {
    const primary = p.primary ?? null;
    const attribution = attributions.get(p.candidate.sessionId) ?? {};
    const metricAttributions: SummarySessionRow['metricAttributions'] = {};
    for (const key of METRIC_KEYS) {
      const attr = attribution[key];
      metricAttributions[key as string] = attr
        ? { included: attr.included, ...(attr.reason ? { reason: attr.reason } : {}) }
        : { included: false, reason: p.sessionExclusion ?? R.metricUnavailable };
    }
    return {
      sessionId: p.candidate.sessionId,
      workspace: p.workspace,
      agentId: p.candidate.agentId,
      usage: p.usage,
      createdAt: p.candidate.createdAt,
      refreshState: p.candidate.refreshState,
      errorCode: p.candidate.errorCode ?? null,
      lastCheckedAt: p.candidate.lastCheckedAt ?? null,
      hasSnapshot: !!p.candidate.snapshot,
      snapshotId: p.candidate.snapshot?.snapshotId ?? null,
      availability: p.candidate.snapshot?.availability ?? 'none',
      freshness: p.candidate.snapshot?.freshness ?? 'unknown',
      models: p.candidate.snapshot?.summary.models ?? [],
      // 即使 excluded/fork 也保留单源观察值，但绝不进组合计；无快照必须为 null。
      metrics: primary ? primary.metrics : null,
      metricAttributions,
      isSharedSource: p.shared,
      ...(p.note ? { attributionNote: p.note } : {})
    };
  });

  const last = paged[paged.length - 1];
  const lastTime = last ? Date.parse(last.candidate.createdAt) : null;
  const remainingAfterPage = last ? prepared.some(p => {
    const t = Date.parse(p.candidate.createdAt);
    return t > lastTime! || (t === lastTime && p.candidate.sessionId.localeCompare(last.candidate.sessionId) > 0);
  }) : false;

  const totals = {
    candidateSessions: prepared.length,
    withSnapshot: prepared.filter(p => p.candidate.snapshot).length,
    partialSnapshots: prepared.filter(p => p.candidate.snapshot?.availability === 'partial').length,
    failedRefreshes: prepared.filter(p => p.candidate.refreshState === 'failed').length,
    staleSnapshots: prepared.filter(p => p.candidate.snapshot?.freshness === 'stale').length,
    freshnessUnknown: prepared.filter(p => !p.candidate.snapshot || p.candidate.snapshot.freshness === 'unknown').length
  };

  const response = sessionInsightSummaryResponseSchema.parse({
    candidateSessions: totals.candidateSessions,
    withSnapshot: totals.withSnapshot,
    withoutSnapshot: totals.candidateSessions - totals.withSnapshot,
    partialSnapshots: totals.partialSnapshots,
    failedRefreshes: totals.failedRefreshes,
    staleSnapshots: totals.staleSnapshots,
    freshnessUnknown: totals.freshnessUnknown,
    groups: groupRows,
    sessions: sessionRows,
    nextCursor: last && remainingAfterPage
      ? encodeCursor(last.candidate.createdAt, last.candidate.sessionId, signature)
      : null
  });
  return deepFreeze(response);
}
