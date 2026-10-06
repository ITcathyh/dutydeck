import type {
  HostEvidenceSnapshot,
  RefreshState,
  SessionInsightEventItem,
  SessionInsightEventsQuery,
  SessionInsightEventsResponse,
  SessionInsightManifest,
  SessionInsightRefreshRecord,
  SessionInsightSnapshotRecord,
  SessionInsightStatus,
  SessionInsightSummary,
  TranscriptSourceObservation
} from './session-insight.js';
import type { RuntimeControlClaim } from './database-control.js';
import type { TaskExecutionContext } from './index.js';

export interface PublishInsightParams {
  sessionId: string;
  requestId: string;
  expectedBindingRevision: number;
  snapshot: SessionInsightSnapshotRecord;
  events: SessionInsightEventItem[];
}

/** 单个 session 的原始任务行，供 T4 做用途分类，storage 不实现 classifyUsage 策略。 */
export interface SessionInsightRawTaskRow {
  id: string;
  prompt: string;
  status: string;
  createdAt: string;
  executionContext?: TaskExecutionContext;
  /** ledger_v1 下经核验的原始任务请求（namespace/key/actor/sources 等），未核验时为 null。 */
  acceptedRequest: unknown | null;
  /** 当前 attempt 的原始账本 JSON（无则 null）。 */
  currentAttempt: unknown | null;
}

/**
 * hostEvidence 冻结所需的权威账本原始行。storage 只在一个同步只读事务内抓取这些行，
 * 不做脱敏、目标摘录或用途分类——那些是 T4 的投影职责。所有 JSON 字段已 parse。
 */
export interface HostEvidenceRaw {
  capturedAt: string;
  session: {
    id: string;
    runId: string;
    agentId: string;
    model: string | null;
    source: string | null;
    sourceId: string | null;
    cwd: string;
  };
  tasks: SessionInsightRawTaskRow[];
  /** configs 中 runtime_verification:<sessionId>: 前缀的原始核验记录。 */
  verificationRecords: Array<{ key: string; value: unknown }>;
  /** task_steering_operations 原始行（json 已 parse）。 */
  steeringOperations: Array<{
    id: string;
    taskId: string;
    runId: string;
    state: string;
    revision: number;
    payload: unknown;
  }>;
  /** usage_ledger 中归属本 session 的原始费用行。 */
  usageEntries: Array<Record<string, unknown>>;
  /** 当前 native selection 原始值（无则 null）。 */
  nativeSelection: unknown | null;
}

/**
 * Catalog 原始行：完整 session 目录（含未分析）+ 持久刷新状态/指针 + 可选当前快照。
 * storage 只做原始读取与投影，workspace / usage 分组等汇总业务策略由 T4 负责。
 */
export interface SessionInsightSummaryRawRow {
  sessionId: string;
  agentId: string;
  cwd: string;
  /** runtime 从 configs 的 runtime_workspace:<sessionId> 记录派生出的托管工作区原始 cwd（无则 null）。 */
  workspaceSourceCwd: string | null;
  model: string | null;
  source: string | null;
  sourceId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  refreshState: RefreshState;
  requestId: string | null;
  errorCode: string | null;
  bindingRevision: number;
  currentSnapshotId: string | null;
  lastCheckedAt: string | null;
  timestamps: {
    queuedAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  };
  snapshot?: {
    snapshotId: string;
    cacheKey: string;
    payloadBytes: number;
    createdAt: string;
    summary: SessionInsightSummary;
    manifest: SessionInsightManifest;
    hostEvidence: HostEvidenceSnapshot;
  };
  tasks: SessionInsightRawTaskRow[];
}

export interface SessionInsightSummaryRawOptions {
  /** Session.createdAt 的 [from,to) UTC 时间窗。 */
  from?: string;
  to?: string;
  includeArchived?: boolean;
  agentId?: string;
  sessionId?: string;
  limit?: number;
  /** 不透明分页游标（createdAt,sessionId）。 */
  cursor?: string;
}

export interface SessionInsightSummaryRawResult {
  rows: SessionInsightSummaryRawRow[];
  totalMatching: number;
  nextCursor: string | null;
}

export interface InsightPruneResult {
  prunedSnapshotsCount: number;
  freedBytes: number;
  retainedSnapshotsCount: number;
  totalPayloadBytes: number;
}

export interface SessionInsightLiveSourcesWriter {
  /**
   * 同步在 BEGIN IMMEDIATE 内调用 OpenControl.validateClaim，并校验 session 当前 activeRun、
   * 资源准确归属和 identity；ACP live 引用须匹配当前 native selection，originRunId 可旧。
   * 同 observationId 同 payload 幂等；同 ID 不同 payload 报冲突。
   * 来源实质变化才递增 bindingRevision。接受运行时 launch_observed 与弱 inferred 观察，
   * 拒绝历史核验结论 historical_verified（那条证据只能走 appendHistoricalProof）。
   */
  appendObserved(observation: TranscriptSourceObservation): void;
}

export interface SessionInsightRepository {
  /** 绑定当前 session 运行时 claim，返回同步 live 来源写入器。 */
  bindSources(claim: RuntimeControlClaim): SessionInsightLiveSourcesWriter;

  /**
   * 历史核验派生证据，独立普通方法，不需要 claim；proofKind 不得为 launch_observed。
   * 实质变化递增 bindingRevision。
   */
  appendHistoricalProof(proof: TranscriptSourceObservation): void;

  listSources(sessionId: string): TranscriptSourceObservation[];

  getState(sessionId: string): SessionInsightRefreshRecord;

  getStatus(sessionId: string): SessionInsightStatus;

  /**
   * 排队一次刷新。同 session 已有 queued/running 时合并返回原 requestId；
   * 实例排队上限 16，满则抛 INSIGHT_QUEUE_FULL(429)。
   */
  beginRefresh(
    sessionId: string,
    requestId: string,
    processRunId?: string
  ): { requestId: string; state: RefreshState; bindingRevision: number; merged: boolean };

  /** CAS queued -> running，绑定 processRunId。 */
  markRunning(sessionId: string, requestId: string, processRunId?: string): boolean;

  /**
   * 原子发布 snapshots + events + 指针 CAS（session/request/running/expectedBindingRevision）。
   * bindingRevision 变化则本次置 failed(source_binding_changed) 并抛错，不提交混合结果。
   * 失败/取消保留旧快照指针；进程在提交前退出不留半份摘要（事务回滚）。
   */
  publish(params: PublishInsightParams): void;

  /**
   * cacheKey 命中既有完整快照时的状态 transition：CAS 当前 request 到 succeeded 并指向已存在
   * 快照，保留原 snapshotId/createdAt，只刷新最后检查时间。同样校验 expectedBindingRevision。
   * - hit：命中并完成 transition；miss：无此活跃 cacheKey（调用方再调 Go）；
   * - binding_changed：修订已变，已原子置 failed(source_binding_changed) 并保留旧指针。
   */
  resolveCacheHit(
    sessionId: string,
    requestId: string,
    cacheKey: string,
    expectedBindingRevision: number
  ): { outcome: 'hit'; snapshotId: string } | { outcome: 'miss' } | { outcome: 'binding_changed' };

  /** 置失败，保留旧快照指针；旧 requestId/已终态不得覆盖新作业。 */
  fail(sessionId: string, requestId: string, errorCode: string): boolean;

  /** 幂等取消；succeeded 保持不变；保留旧快照指针。 */
  cancel(sessionId: string, requestId: string): boolean;

  getSnapshot(sessionId: string, snapshotId?: string): SessionInsightSnapshotRecord | undefined;

  /** 快照曾存在但已被淘汰（固定 snapshot 请求返回 410）。 */
  isSnapshotTombstoned(sessionId: string, snapshotId: string): boolean;

  findSnapshotByCacheKey(sessionId: string, cacheKey: string): SessionInsightSnapshotRecord | undefined;

  /** 稳定事件分页；cursor 绑定 snapshot + filter，不跨快照混页。 */
  listEvents(query: SessionInsightEventsQuery): SessionInsightEventsResponse;

  /** 完整 catalog 原始行（不排除未分析 session），不含任何汇总业务策略。 */
  listSummaryRows(options?: SessionInsightSummaryRawOptions): SessionInsightSummaryRawResult;

  /** 当前 + 最近 1 份旧快照 + 全实例 512 MiB 逻辑 payload 淘汰；与指针清空原子完成。 */
  prune(maxPayloadBytes?: number): InsightPruneResult;

  /** 启动恢复：把非当前 processRunId 遗留的 queued/running 标 interrupted，不自动重试。 */
  markInterrupted(currentProcessRunId?: string): number;

  /** 同步只读短事务（冻结 hostEvidence 等）。 */
  readTransaction<T>(work: () => T): T;

  /**
   * 在单个同步只读事务内冻结 hostEvidence 所需的权威账本原始行（任务、核验、steering、
   * 费用只读投影、native selection）。不脱敏、不分类、不调模型；投影由 T4 完成。
   * 因为 better-sqlite3 事务不能 await，config/usage 等 async 接口不能在此使用，
   * 故由 storage 直接提供这一窄同步读取。
   */
  readHostEvidenceRaw(sessionId: string): HostEvidenceRaw;
}
