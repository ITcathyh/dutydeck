/**
 * T4c 会话分析作业服务：排队 / 缓存 / 只读 API / 生命周期。
 *
 * 职责边界（设计第 5 节）：
 * - 1 running / 16 queued，同 session in-flight 合并；队列满 429；refresh 立即接纳，不触发
 *   Task/Attempt/Usage 写。
 * - 作业流水线严格按固定顺序：resolver 历史 proof → 固定 expectedBindingRevision/来源清单 →
 *   文件快照 hash → 一次短同步读事务冻结 hostEvidence → T4e 脱敏投影 → locator 握手固定版本 →
 *   cacheKey → resolveCacheHit → miss 才跑 Go → 校验/脱敏 → T4d 单 session 摘要 →
 *   manifest/events → 原子 publish。所有 IO 与大计算都在写事务外；better-sqlite3 事务内绝不 await。
 * - 私有的 root/path/env/stdout/stderr 不进 DTO/log；诊断只记 requestId/code/count。
 */
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import {
  canonicalExecutionJson,
  RuntimeError,
  SESSION_INSIGHT_LIMITS,
  type AcceptedTask,
  type AnalyzeFilesRequest,
  type AnalyzeFilesResult,
  type EngineVersionInfo,
  type HostEvidenceRaw,
  type HostEvidenceSnapshot,
  type InsightFreshness,
  type SessionInsightCompareRequest,
  type SessionInsightCompareResponse,
  type SessionInsightDetailsResponse,
  type SessionInsightEventItem,
  type SessionInsightEventsQuery,
  type SessionInsightEventsResponse,
  type SessionInsightExportRequest,
  type SessionInsightManifest,
  type SessionInsightRefreshResponse,
  type SessionInsightCancelResponse,
  type SessionInsightRepository,
  type SessionInsightSnapshotRecord,
  type SessionInsightSummaryQuery,
  type SessionInsightSummaryRawRow,
  type SessionInsightSummaryResponse,
  type TaskExecutionProjection,
  type TaskRequestV1,
  type UsageLedgerEntry,
  type VerificationResponse,
  type WorkspaceOrganization
} from '@dutydeck/shared';
import {
  createInsightFileSnapshots,
  cleanupStaleInsightTempDirs,
  type InsightFileCaptureInfo,
  type VerifiedInsightSource
} from './session-insight-snapshot.js';
import { runInsightProcess } from './session-insight-process.js';
import {
  resolveSessionInsightEngine,
  type AvailableEngine,
  type ResolvedEngine
} from './session-insight-engine.js';
import { redactAnalyzeResult, type RedactionContext } from './session-insight-redaction.js';
import { buildHostEvidenceSnapshot } from './session-insight-evidence.js';

/** 外部 cancel/close 中止作业：状态已由取消路径落定，runJob 安静返回，不写 failed。 */
class JobAbortedError extends Error {
  constructor() {
    super('Session insight job aborted');
    this.name = 'JobAbortedError';
  }
}
import {
  buildSessionInsightSummary,
  buildSessionInsightSummaryResponse,
  type InsightSourceRole,
  type SummaryCandidate
} from './session-insight-summary.js';
import { compareSessionSnapshots } from './session-insight-compare.js';
import {
  exportSessionInsightReport,
  type SessionInsightExportInput,
  type SessionInsightReport
} from './session-insight-export.js';

/** 脱敏投影版本：参与 cache key 与 manifest.versions，redaction 逻辑变化时必须递增。 */
const REDACTION_VERSION = 'redaction-v1';
/** 固定范围口径版本，与 T4d summary.scopeVersion 默认值一致。 */
const SCOPE_VERSION = 'primary_verified_v1';
const SCHEMA_VERSION = 1;

/**
 * 允许写入刷新状态 errorCode 的受控白名单（固定安全字面，不含路径/token/stderr）。
 * 任何依赖（engine/resolver/IO/snapshot/process）抛出的原始 code 都必须收敛于此集合，
 * 否则统一记 INSIGHT_ANALYSIS_FAILED。
 */
const PUBLIC_FAILURE_CODES = new Set<string>([
  'INSIGHT_ANALYSIS_FAILED',
  'INSIGHT_SOURCE_BINDING_CHANGED',
  'INSIGHT_SOURCE_CHANGED',
  'INSIGHT_SOURCE_CONFLICT',
  'INSIGHT_INPUT_LIMIT',
  'INSIGHT_BUDGET_EXCEEDED',
  'INSIGHT_TIMEOUT',
  'INSIGHT_INTERRUPTED',
  'INSIGHT_VERSION_MISMATCH',
  'engine_unavailable',
  'no_verified_source',
  'no_valid_analysis',
  'no_valid_primary_source'
]);

/** 诊断日志允许出现的固定 code（失败码 + 清理/初始化固定码），其余统一收敛。 */
const PUBLIC_LOG_CODES = new Set<string>([
  ...PUBLIC_FAILURE_CODES,
  'INSIGHT_CLEANUP_ERROR',
  'INSIGHT_STARTUP_FAILED'
]);

// ---------------------------------------------------------------------------
// resolver 契约（T3d 拥有；最终实现由 controller 复制到本 tree，生产经默认依赖接入）
// ---------------------------------------------------------------------------

export interface ResolvedInsightSource {
  sourceKey: string;
  sourceSessionKey?: string;
  client: SessionInsightManifest['sources'][number]['client'];
  status: 'matched' | 'missing' | 'ambiguous' | 'unsupported';
  /** matched 时的私有核准根与已核验路径；绝不进入任何公开 DTO。 */
  approvedRoot?: string;
  verifiedPath?: string;
  expectedNativeSessionId: string;
  expectedStream: SessionInsightManifest['sources'][number]['expectedStream'];
  proofKind: 'launch_observed' | 'historical_verified' | 'inferred';
  /**
   * resolver 显式给出的会话内角色；只有一个 primary。'additional' 是同一 session 的
   * 额外历史 main 来源，绝不抬升为 primary；落摘要时保守按 excluded 观察处理。
   */
  role: 'primary' | 'additional' | 'subagent' | 'excluded';
  discoveryLimited?: boolean;
  reason?: string;
  /** resolver 基于绑定证据显式给出的原生流关系（T4c 不臆造，也不抬升引擎 unknown）。 */
  relationship?: SessionInsightManifest['sources'][number]['relationship'];
}

export interface ResolveSessionInsightSourcesResult {
  sources: ResolvedInsightSource[];
  /** 唯一权威 primary；T4c 不退到 firstMain/firstValid，缺它则保守失败。 */
  primarySourceKey: string | null;
  discoveryLimited?: boolean;
  unsupportedReason?: string;
  /** matched 文件数超过 32：整作业 input_limit，不截最近文件。 */
  inputLimit?: boolean;
  hostOnlyReason?: string;
}

export interface SessionInsightResolver {
  /**
   * 枚举来源观察/资源/attempt 引用，写完全部本次发现的 historical proof 后才返回最终来源清单。
   * proof 追加会递增 bindingRevision，故必须在固定 expectedRevision 之前完成。
   */
  resolveSessionInsightSources(
    sessionId: string,
    options?: { signal?: AbortSignal; deadline?: number }
  ): Promise<ResolveSessionInsightSourcesResult>;
}

// ---------------------------------------------------------------------------
// host evidence 冻结所需的账本访问（全部在一个同步只读事务内使用，事务内绝不 await）
// ---------------------------------------------------------------------------

export interface InsightHostEvidenceGateway {
  readHostEvidenceRaw(sessionId: string): HostEvidenceRaw;
  getSessionExecutions(sessionId: string): TaskExecutionProjection[];
  getAcceptedTask(taskId: string): AcceptedTask | undefined;
  readTransaction<T>(work: () => T): T;
}

export interface InsightEngineRunner {
  runInsightProcess(options: {
    binaryPath: string;
    request: AnalyzeFilesRequest;
    expectedVersions: EngineVersionInfo;
    signal?: AbortSignal;
    deadline: number;
    tempDir: string;
  }): Promise<AnalyzeFilesResult>;
}

export interface SessionInsightServiceOptions {
  insightRepository: SessionInsightRepository;
  resolver: SessionInsightResolver;
  /** 实例数据目录；insight-tmp/<requestId> 建在其下。 */
  dataDir: string;
  /** 本进程稳定 run id；启动恢复时只保留它名下 running。 */
  processRunId: string;
  hostEvidence: InsightHostEvidenceGateway;
  /** engine locator；默认接 T6a 真实 locator，测试可注入。 */
  resolveEngine?: () => Promise<ResolvedEngine>;
  /** Go 进程边界；默认接 T4a 已验收 runner，测试可注入假进程。 */
  engineRunner?: InsightEngineRunner;
  /** 当前 workspace 组织配置（事务外 await 取得，不把 async repo 放进读事务）。 */
  loadWorkspaceOrganization?: () => Promise<WorkspaceOrganization>;
  /**
   * 当前代码指纹：仅用于 host evidence 冻结时判定 verification stale；
   * 缺省（注入测试或无 runtime）时按保守规则标 stale，绝不默认 passed→fresh。
   */
  getCurrentFingerprint?: (sessionId: string) => Promise<string | undefined>;
  /** 脱敏诊断日志出口：只收 code/count，不收路径/stderr/JSONL。 */
  log?: (details: Record<string, unknown>, message: string) => void;
}

interface QueuedJob {
  sessionId: string;
  /** 与 repo beginRefresh 返回的 requestId 一致；cancel 据此精确移除内存队列项。 */
  requestId: string;
}

/**
 * 单会话分析服务。结构化实现 T4f 冻结的 SessionInsightApi（接口在 routes 文件），
 * 不另编一套路由或鉴权。
 */
export class SessionInsightService {
  private readonly repos: SessionInsightRepository;
  private readonly resolver: SessionInsightResolver;
  private readonly dataDir: string;
  private readonly processRunId: string;
  private readonly hostEvidence: InsightHostEvidenceGateway;
  private readonly resolveEngineFn: () => Promise<ResolvedEngine>;
  private readonly engineRunner: InsightEngineRunner;
  private readonly loadWorkspaceOrganization: () => Promise<WorkspaceOrganization>;
  private readonly getCurrentFingerprint?: (sessionId: string) => Promise<string | undefined>;
  private readonly log?: (details: Record<string, unknown>, message: string) => void;

  private queue: QueuedJob[] = [];
  private runnerState:
    | { kind: 'idle' }
    | { kind: 'running'; sessionId: string; requestId: string; controller: AbortController } = {
    kind: 'idle'
  };
  private closing = false;
  private initialized = false;
  private runnerPump: Promise<void> | undefined;

  constructor(options: SessionInsightServiceOptions) {
    this.repos = options.insightRepository;
    this.resolver = options.resolver;
    this.dataDir = options.dataDir;
    this.processRunId = options.processRunId;
    this.hostEvidence = options.hostEvidence;
    this.resolveEngineFn = options.resolveEngine ?? (() => resolveSessionInsightEngine());
    this.engineRunner = options.engineRunner ?? { runInsightProcess };
    this.loadWorkspaceOrganization =
      options.loadWorkspaceOrganization ?? (async () => (await import('@dutydeck/shared')).emptyWorkspaceOrganization());
    this.getCurrentFingerprint = options.getCurrentFingerprint;
    this.log = options.log;
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 启动恢复：旧进程遗留 queued/running 标 interrupted，清理无作业持有的临时目录。 */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      this.repos.markInterrupted(this.processRunId);
    } catch (error) {
      this.safeDiagnostic(error, { stage: 'initialize.markInterrupted' });
    }
    try {
      await cleanupStaleInsightTempDirs(this.dataDir, new Set());
    } catch (error) {
      this.safeDiagnostic(error, { stage: 'initialize.cleanupTemp' });
    }
  }

  /**
   * 有序关闭：先拒新 refresh，再取消排队与运行中作业并等待 runner 退出、清理临时目录，
   * 然后才允许关闭 runtime/repos。分析清理异常只做安全诊断，不阻止其它正常清理。
   * 必须在 service.ts 的并行关闭组之前显式 await。
   */
  async close(): Promise<void> {
    if (this.closing) {
      await this.runnerPump?.catch(() => {});
      return;
    }
    this.closing = true;
    // 精确移除并取消所有仍 queued 的作业（用 queue 内权威 requestId，不凭当前状态误取消新作业）。
    const pending = this.queue.splice(0);
    this.queue.length = 0;
    for (const job of pending) {
      try {
        this.repos.cancel(job.sessionId, job.requestId);
      } catch (error) {
        this.safeDiagnostic(error, { stage: 'close.cancelQueued' });
      }
    }
    // 运行中作业：先落持久 cancelled 终态（旧 snapshot 指针不变），再 abort controller。
    // runJob 收到 abort 后等待真实 child close（T4a runner 保证）才返回，因此 await runnerPump
    // 即等待 child 已退出；不会留下持久 running。
    if (this.runnerState.kind === 'running') {
      const { sessionId, requestId, controller } = this.runnerState;
      try {
        this.repos.cancel(sessionId, requestId);
      } catch (error) {
        this.safeDiagnostic(error, { stage: 'close.cancelRunning' });
      }
      controller.abort();
    }
    try {
      await this.runnerPump?.catch(() => {});
    } catch (error) {
      this.safeDiagnostic(error, { stage: 'close.awaitRunner' });
    }
    try {
      await cleanupStaleInsightTempDirs(this.dataDir, new Set());
    } catch (error) {
      this.safeDiagnostic(error, { stage: 'close.cleanupTemp' });
    }
  }

  private safeDiagnostic(error: unknown, extra: Record<string, unknown>): void {
    // 任何入口（initialize/close/runner）都只记录受控白名单 code，
    // 绝不原样回显依赖抛出的 code（可能携带私有路径/token）。
    const rawCode = (error as { code?: unknown } | null | undefined)?.code;
    const code = typeof rawCode === 'string' && PUBLIC_LOG_CODES.has(rawCode)
      ? rawCode
      : 'INSIGHT_CLEANUP_ERROR';
    const safeExtra = Object.fromEntries(
      Object.entries(extra).filter(([, value]) =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      )
    );
    this.log?.({ code, ...safeExtra }, 'Session insight cleanup diagnostic');
  }

  // -------------------------------------------------------------------------
  // API: refresh / cancel
  // -------------------------------------------------------------------------

  async refresh(sessionId: string): Promise<SessionInsightRefreshResponse> {
    if (this.closing) {
      // 关闭期间拒新刷新；与队列满同属暂不可接纳。
      throw new RuntimeError('INSIGHT_QUEUE_FULL', 'Session insight is shutting down', 429);
    }
    const requestId = cryptoRandomUuid();
    // 同 session in-flight 合并 + 全实例 16 队列上限均由 repo 在一个事务内判定。
    const accepted = this.repos.beginRefresh(sessionId, requestId, this.processRunId);
    if (accepted.merged) {
      return { requestId: accepted.requestId, state: accepted.state, cacheHit: false };
    }
    // 内存队列持权威 requestId；同 session 重复 refresh 已在 repo 层 merged，
    // 因此这里不会为终态旧 entry 无限堆积（cancel 也精确移除）。
    this.queue.push({ sessionId, requestId });
    this.pumpRunner();
    return { requestId, state: 'queued', cacheHit: false };
  }

  async cancel(sessionId: string, requestId: string): Promise<SessionInsightCancelResponse> {
    // 幂等取消：旧 requestId 不影响新作业；succeeded 保持成功；保留旧快照指针。
    const changed = this.repos.cancel(sessionId, requestId);
    // 精确移除内存队列项：只删 sessionId+requestId 均匹配的 queued 作业。
    const index = this.queue.findIndex(job => job.sessionId === sessionId && job.requestId === requestId);
    if (index >= 0) this.queue.splice(index, 1);
    if (
      this.runnerState.kind === 'running'
      && this.runnerState.sessionId === sessionId
      && this.runnerState.requestId === requestId
    ) {
      this.runnerState.controller.abort();
    }
    return { success: changed, state: this.repos.getState(sessionId).state };
  }

  // -------------------------------------------------------------------------
  // 单作业调度：本服务内串行消费队列，因此全实例恒为 1 running（repo 另有 SQL 闸门）
  // -------------------------------------------------------------------------

  private pumpRunner(): void {
    if (this.runnerPump) return;
    this.runnerPump = this.runQueue().finally(() => {
      this.runnerPump = undefined;
    });
  }

  private async runQueue(): Promise<void> {
    while (!this.closing) {
      const job = this.queue.shift();
      if (!job) return;
      const state = this.repos.getState(job.sessionId);
      // 内存项带权威 requestId：只处理它；若 repo 当前已不是该 queued 请求
      // （被精确 cancel / 被更新请求取代），直接跳过，绝不误晋级别的请求。
      if (state.requestId !== job.requestId || state.state !== 'queued') continue;
      const promoted = this.repos.markRunning(job.sessionId, job.requestId, this.processRunId);
      if (!promoted) continue;
      const controller = new AbortController();
      this.runnerState = { kind: 'running', sessionId: job.sessionId, requestId: job.requestId, controller };
      try {
        await this.runJob(job.sessionId, job.requestId, controller.signal);
      } catch (error) {
        this.safeDiagnostic(error, { stage: 'runner.uncaught', requestId: job.requestId });
      } finally {
        this.runnerState = { kind: 'idle' };
      }
    }
  }

  private async runJob(sessionId: string, requestId: string, externalSignal: AbortSignal): Promise<void> {
    const deadline = Date.now() + SESSION_INSIGHT_LIMITS.jobTimeoutMs;
    // 单作业 60s 总 deadline：内部 controller 同时绑定外部 cancel 与整体超时。
    // resolver/fingerprint/locator/host 投影/cache/publish 每阶段后统一 checkpoint，
    // 超时不允许继续走到成功发布；真实 child 由 T4a runner 在 abort 后等其 close，
    // 这里绝不用 Promise.race 丢弃后台进程。
    const job = new AbortController();
    const onExternalAbort = (): void => job.abort();
    if (externalSignal.aborted) job.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    const timeoutTimer = setTimeout(() => job.abort(), Math.max(0, deadline - Date.now()));
    timeoutTimer.unref?.();
    const signal = job.signal;
    let timedOut = false;
    const onAbortForTimeout = (): void => {
      if (Date.now() >= deadline) timedOut = true;
    };
    signal.addEventListener('abort', onAbortForTimeout);

    /** 每阶段闸口：超时 → 受控 INSIGHT_TIMEOUT；外部取消 → 直接返回（repo 已 cancelled）。 */
    const checkpoint = (): void => {
      if (!signal.aborted) return;
      if (timedOut || Date.now() >= deadline) {
        throw new RuntimeError('INSIGHT_TIMEOUT', 'Session insight job deadline exceeded', 408);
      }
      // 外部 cancel/close abort：状态已由 cancel/close 路径处理，直接结束，不写 failed。
      throw new JobAbortedError();
    };

    let snapshotCleanup: (() => Promise<void>) | undefined;
    const finishFailed = (code: string): void => {
      // 取消/中断/更新请求已落终态时不覆盖：fail 只影响 queued/running 的当前 requestId，
      // 这里再复查一次，避免 abort 路径把 cancelled 改写成 failed。
      const current = this.repos.getState(sessionId);
      if (current.requestId === requestId && (current.state === 'queued' || current.state === 'running')) {
        this.repos.fail(sessionId, requestId, code);
      }
    };
    try {
      // 1. resolver：全部 historical proof 在这一步写完，之后固定修订与最终来源清单。
      const resolved = await this.resolver.resolveSessionInsightSources(sessionId, { signal, deadline });
      checkpoint();
      const expectedBindingRevision = this.repos.getState(sessionId).bindingRevision;
      const matched = resolved.sources.filter(source => source.status === 'matched');

      // primary 唯一权威来自 resolver：绝不回退到 firstMain/firstValid，
      // 也不把子流 / 额外历史来源抬升为 primary。缺权威 primary 时保守失败（host-only）。
      const primaryResolved = resolved.primarySourceKey
        ? matched.find(source => source.sourceKey === resolved.primarySourceKey)
        : undefined;

      // 2. 没有任何 matched 来源或缺权威 primary：不跑 Go、不伪造 source/快照。
      if (matched.length === 0 || !primaryResolved) {
        finishFailed('no_verified_source');
        return;
      }

      // matched 来源必须带私有核准根与已核验路径；缺字段属于 resolver 契约违反，保守失败。
      for (const source of matched) {
        if (!source.approvedRoot || !source.verifiedPath) {
          throw new RuntimeError('INSIGHT_RESOLVER_INVALID_SOURCE', 'Matched source lacks a verified path', 502);
        }
      }

      // 3. 文件快照 hash（私有 tempDir，路径不返 API）。
      const verifiedSources: VerifiedInsightSource[] = matched.map(source => ({
        sourceKey: source.sourceKey,
        client: source.client,
        approvedRoot: source.approvedRoot!,
        verifiedPath: source.verifiedPath!,
        expectedNativeSessionId: source.expectedNativeSessionId,
        expectedStream: source.expectedStream
      }));
      const created = await createInsightFileSnapshots({
        dataDir: this.dataDir,
        requestId,
        sources: verifiedSources,
        signal,
        deadline
      });
      snapshotCleanup = created.cleanup;
      const tempDir = dirname(created.files[0]!.path);
      checkpoint();
      const captureByKey = new Map<string, InsightFileCaptureInfo>();
      created.captures.forEach((capture, index) => captureByKey.set(created.files[index]!.sourceKey, capture));
      const analyzeRequest: AnalyzeFilesRequest = {
        schemaVersion: SCHEMA_VERSION,
        requestId,
        files: created.files,
        limits: {
          maxLineBytes: SESSION_INSIGHT_LIMITS.maxLineBytes,
          maxTraceEvents: SESSION_INSIGHT_LIMITS.maxTraceEventsPerJob
        }
      };

      // 4. 事务外取得当前代码指纹（async 接口不能进同步事务）。
      let currentFingerprint: string | undefined;
      try {
        currentFingerprint = await this.getCurrentFingerprint?.(sessionId);
      } catch {
        currentFingerprint = undefined;
      }
      checkpoint();

      // 5. 一次短同步读事务冻结 hostEvidence 所需权威原始行；事务内绝不 await。
      const frozen = this.hostEvidence.readTransaction(() => {
        const raw = this.hostEvidence.readHostEvidenceRaw(sessionId);
        const executions = this.hostEvidence.getSessionExecutions(sessionId);
        const accepted = raw.tasks
          .map(task => this.hostEvidence.getAcceptedTask(task.id))
          .filter((value): value is AcceptedTask => Boolean(value));
        return { raw, executions, accepted };
      });

      // 6. T4e 投影 + 脱敏 host evidence（稳定 digest，私有字段不进入）。
      //    统一 canary 上下文：session cwd / dataDir / 本次 tempDir / 本次解析来源的
      //    root/path / 以及已持久化 sources 的历史 root/path。prompt、verification
      //    command 等 free text 落库前一律脱敏；与 details/currentDigest 同规则。
      const redactionContext: RedactionContext = {
        canaryPaths: [
          ...new Set([
            ...this.collectCanaries(frozen.raw.session.cwd, resolved.sources, tempDir),
            ...this.buildHostRedactionContext(sessionId, frozen.raw.session.cwd).canaryPaths!
          ])
        ]
      };
      const hostEvidence = buildHostEvidenceSnapshot(
        {
          capturedAt: frozen.raw.capturedAt,
          executions: frozen.executions,
          accepted: frozen.accepted,
          verifications: this.projectVerifications(frozen.raw.verificationRecords, currentFingerprint),
          usageEntries: frozen.raw.usageEntries as unknown as UsageLedgerEntry[]
        },
        redactionContext
      );
      checkpoint();

      // 7. locator 握手固定引擎版本（cache key 必须含版本）；引擎不可用只让本次分析失败，
      //    旧快照与主服务不受影响（cache key 无规范引擎版本时不允许命中）。
      const engine = await this.resolveEngineFn();
      checkpoint();
      if (engine.status !== 'available') {
        finishFailed('engine_unavailable');
        return;
      }

      // 8. cache key（稳定 sorted JSON SHA256；不含 requestId/capturedAt/mtime/checkedAt）。
      const discoveryLimited =
        resolved.discoveryLimited === true
        || resolved.sources.some(source => source.discoveryLimited === true);
      const cacheKey = this.computeCacheKey({
        bindingRevision: expectedBindingRevision,
        sources: resolved.sources,
        captures: captureByKey,
        hostDigest: hostEvidence.digest,
        versions: engine.versions,
        discoveryLimited
      });

      // 9. cache hit：沿用原 snapshot/host/capturedAt，仅刷新 lastCheckedAt。
      const hit = this.repos.resolveCacheHit(sessionId, requestId, cacheKey, expectedBindingRevision);
      if (hit.outcome === 'binding_changed') return; // repo 已原子置 failed(source_binding_changed)
      if (hit.outcome === 'hit') return;
      checkpoint();

      // 10. miss 才跑 Go（单 child SIGTERM+2s SIGKILL 由 T4a runner 负责）。
      const result = await this.engineRunner.runInsightProcess({
        binaryPath: engine.binaryPath,
        request: analyzeRequest,
        expectedVersions: engine.versions,
        signal,
        deadline,
        tempDir
      });
      // runner 在 abort/timeout 时抛错（真实 child 已 close）；这里再闸口防止超时后继续投影。
      checkpoint();

      // 11. runner 已做 schema/source/hash/native/version 校验；这里做落库前公开投影脱敏。
      const safeResult = redactAnalyzeResult(result, redactionContext);
      const expectedKeys = new Set(matched.map(source => source.sourceKey));
      for (const file of safeResult.files) {
        if (!expectedKeys.has(file.sourceKey)) {
          throw new RuntimeError('INSIGHT_PROCESS_ERROR', 'Engine returned an unexpected source', 502);
        }
      }

      // 至少一个有效（ok/partial）来源才发布分析快照；全 error 不伪 source。
      if (!safeResult.files.some(file => file.status !== 'error')) {
        finishFailed('no_valid_analysis');
        return;
      }

      // primary 唯一权威来自 resolver；确认它在引擎结果中且有效，否则保守失败不抬升其他来源。
      const primarySourceKey = resolved.primarySourceKey!;
      const primaryFile = safeResult.files.find(file => file.sourceKey === primarySourceKey);
      if (!primaryFile || primaryFile.status === 'error') {
        finishFailed('no_valid_primary_source');
        return;
      }

      // A2 半行：Go 只收完整 prefix（file.status 仍 ok），宿主必须把 capture 的
      // 截尾事实合并进该来源结果（ok→partial），保留正常 metrics，使
      // manifest/summary source/报告一致表达 partial，而不是谎称 complete。
      // A3 发现截断：resolver 的 discoveryLimited 经 coverage.subagentDiscovery=partial
      // + aggregation.reasonCodes DISCOVERY_LIMITED 表达，不改 eligibility（仍可汇总）。
      const publishedResult = this.applyHostCoverageFacts(safeResult, {
        captures: captureByKey,
        discoveryLimited: resolved.discoveryLimited === true,
        perSourceDiscoveryLimited: new Set(
          resolved.sources.filter(s => s.discoveryLimited === true).map(s => s.sourceKey)
        )
      });

      // 12. T4d 单会话 primary 摘要（aggregate 只取 primary 源）。
      // A7 淘汰重建：cache miss 新发布生成新唯一 ID（含随机 publish nonce），
      // 避免与仍持 PK 的 tombstone 行冲突；cache hit 路径由 repo 复用旧 ID，不经此处。
      const snapshotId = `insight_${createHash('sha256')
        .update(`${sessionId}:${cacheKey}:${cryptoRandomUuid()}`)
        .digest('hex')
        .slice(0, 24)}`;
      const createdAt = new Date().toISOString();
      const summary = buildSessionInsightSummary({
        sessionId,
        snapshotId,
        createdAt,
        primarySourceKey,
        result: publishedResult,
        sourceRoles: this.sourceRoles(resolved)
      });

      // 13. manifest + events（ordinal 由 publish 按数组顺序权威赋值）。
      const manifest = this.buildManifest({
        snapshotId,
        sessionId,
        createdAt,
        bindingRevision: expectedBindingRevision,
        hostDigest: hostEvidence.digest,
        sources: resolved.sources,
        captures: captureByKey,
        result: publishedResult,
        versions: engine.versions
      });
      const events = this.flattenEvents(publishedResult, snapshotId);

      const snapshot: SessionInsightSnapshotRecord = {
        snapshotId,
        sessionId,
        cacheKey,
        versions: {
          schemaVersion: SCHEMA_VERSION,
          engineVersion: publishedResult.engineVersion,
          parserVersion: publishedResult.parserVersion,
          metricVersion: publishedResult.metricVersion,
          redactionVersion: REDACTION_VERSION
        },
        summary,
        manifest,
        hostEvidence,
        payloadBytes: 0,
        createdAt
      };

      // 14. 原子发布前最后闸口：超时/取消绝不发布新快照。
      checkpoint();
      // 原子发布：revision 变化 → source_binding_changed，不提交混合结果、不改 expected。
      this.repos.publish({ sessionId, requestId, expectedBindingRevision, snapshot, events });
    } catch (error) {
      if (error instanceof JobAbortedError) return; // 外部取消/关闭：状态已落定，不写 failed。
      if ((error as { code?: string } | null | undefined)?.code === 'INSIGHT_SOURCE_BINDING_CHANGED') return;
      // 只允许受控错误码进入持久刷新状态：engine/resolver/IO 抛出的原始 code 可能携带
      // 路径/token 等私有内容，其余统一收敛为固定码，绝不把异常 message 落库或回显。
      const rawCode = typeof (error as { code?: unknown } | null | undefined)?.code === 'string'
        ? ((error as { code: string }).code)
        : 'INSIGHT_ANALYSIS_FAILED';
      const code = PUBLIC_FAILURE_CODES.has(rawCode) ? rawCode : 'INSIGHT_ANALYSIS_FAILED';
      this.safeDiagnostic(error, { stage: 'runner.job', requestId, code });
      finishFailed(code);
    } finally {
      clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onAbortForTimeout);
      externalSignal.removeEventListener('abort', onExternalAbort);
      if (snapshotCleanup) {
        try {
          await snapshotCleanup();
        } catch (error) {
          this.safeDiagnostic(error, { stage: 'runner.tempCleanup', requestId });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // API: details（轻量；未做内容 hash 不宣称字节 current）
  // -------------------------------------------------------------------------

  async details(sessionId: string, snapshotId?: string): Promise<SessionInsightDetailsResponse> {
    const status = this.repos.getStatus(sessionId); // session 不存在抛 404
    const targetId = snapshotId ?? status.currentSnapshotId ?? undefined;
    let snapshot: SessionInsightSnapshotRecord | undefined;
    if (targetId && this.repos.isSnapshotTombstoned(sessionId, targetId)) {
      throw new RuntimeError('INSIGHT_SNAPSHOT_GONE', 'Session insight snapshot is no longer available', 410);
    }
    if (targetId) snapshot = this.repos.getSnapshot(sessionId, targetId);

    // 显式请求固定 snapshotId 但取不到（未知或不属本 session）：404，不降级成 host-only。
    if (snapshotId && !snapshot) {
      throw new RuntimeError('INSIGHT_NOT_FOUND', 'Session insight resource not found', 404);
    }

    if (!snapshot) {
      // 无缓存：现场只读冻结宿主执行信息（summary=null + hostEvidence + fallback），200 非 404。
      const hostEvidence = this.projectCurrentHostEvidence(sessionId);
      return {
        status: { ...status, availability: 'none', freshness: 'unknown', currentSnapshotId: null },
        summary: null,
        manifest: null,
        hostEvidence,
        hostExecutionFallback: {
          hasExecutionRecords: hostEvidence !== null,
          ...(this.fallbackReason(sessionId) ? { unsupportedReason: this.fallbackReason(sessionId) } : {})
        }
      };
    }

    // 轻量 stale：bindingRevision 前进或当前 host digest 与快照不同；不内容 hash → 不标 current。
    let freshness: InsightFreshness = 'unknown';
    if (this.repos.getState(sessionId).bindingRevision > snapshot.manifest.bindingRevision) {
      freshness = 'stale';
    } else {
      const currentDigest = await this.safeCurrentHostDigest(sessionId);
      freshness = currentDigest && currentDigest !== snapshot.hostEvidence.digest ? 'stale' : 'unknown';
    }

    return {
      status: {
        ...status,
        currentSnapshotId: snapshot.snapshotId,
        availability: this.availabilityForManifest(snapshot.manifest),
        freshness
      },
      summary: snapshot.summary,
      manifest: snapshot.manifest,
      hostEvidence: snapshot.hostEvidence
    };
  }

  // -------------------------------------------------------------------------
  // API: events（固定 snapshot 归属，不能只凭 snapshotId 查他 session）
  // -------------------------------------------------------------------------

  async events(sessionId: string, query: SessionInsightEventsQuery): Promise<SessionInsightEventsResponse> {
    if (this.repos.isSnapshotTombstoned(sessionId, query.snapshotId)) {
      throw new RuntimeError('INSIGHT_SNAPSHOT_GONE', 'Session insight snapshot is no longer available', 410);
    }
    // getSnapshot 校验 session 归属；不存在/不归属 → 404。
    if (!this.repos.getSnapshot(sessionId, query.snapshotId)) {
      throw new RuntimeError('INSIGHT_NOT_FOUND', 'Session insight resource not found', 404);
    }
    return this.repos.listEvents(query);
  }

  // -------------------------------------------------------------------------
  // API: summary（完整 catalog 全页冻结，再 T4d 全队列过滤/全局去重/分组/计数）
  // -------------------------------------------------------------------------

  async summary(query: SessionInsightSummaryQuery): Promise<SessionInsightSummaryResponse> {
    // workspace organization 是当前事实配置，先 await，不把 async repo 放进读事务。
    const organization = await this.loadWorkspaceOrganization();

    // 完整 catalog（含真实 accepted request 与已发布快照 DTO）必须在同一个短同步读事务内
    // 一次冻结全部页，避免分页之间被 prune/新发布割裂；之后事务外做 T4d 纯投影。
    const rows: SessionInsightSummaryRawRow[] = this.hostEvidence.readTransaction(() => {
      const all: SessionInsightSummaryRawRow[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = this.repos.listSummaryRows({
          ...(query.from ? { from: query.from } : {}),
          ...(query.to ? { to: query.to } : {}),
          includeArchived: query.includeArchived,
          ...(query.agentId ? { agentId: query.agentId } : {}),
          limit: SESSION_INSIGHT_LIMITS.maxSummaryRowsPerPageMax,
          ...(cursor ? { cursor } : {})
        });
        all.push(...page.rows);
        if (!page.nextCursor) return all;
        cursor = page.nextCursor;
      }
    });

    const candidates: SummaryCandidate[] = rows.map(row => this.toSummaryCandidate(row));
    return buildSessionInsightSummaryResponse({
      candidates,
      filter: {
        ...(query.workspace ? { workspace: query.workspace } : {}),
        ...(query.agentId ? { agentId: query.agentId } : {}),
        ...(query.usage ? { usage: query.usage } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        includeArchived: query.includeArchived
      },
      groupBy: query.groupBy,
      organization,
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {})
    });
  }

  // -------------------------------------------------------------------------
  // API: compare（同一 sync readTxn 冻结两侧完整 DTO，再事务外 pure compare）
  // -------------------------------------------------------------------------

  async compare(request: SessionInsightCompareRequest): Promise<SessionInsightCompareResponse> {
    const frozen = this.hostEvidence.readTransaction(() => ({
      left: this.requireSnapshot(request.left.sessionId, request.left.snapshotId),
      right: this.requireSnapshot(request.right.sessionId, request.right.snapshotId)
    }));
    return compareSessionSnapshots(frozen);
  }

  // -------------------------------------------------------------------------
  // API: export（同事务冻结两侧完整 DTO + 每侧最多 100 关键事件，事务外 pure export）
  // -------------------------------------------------------------------------

  async exportReport(request: SessionInsightExportRequest): Promise<{
    body: string;
    contentType: SessionInsightReport['contentType'];
    filename: string;
  }> {
    const collectSide = (sessionId: string, snapshotId: string) => ({
      snapshot: this.requireSnapshot(sessionId, snapshotId),
      events: this.collectKeyEvidence(this.requireSnapshot(sessionId, snapshotId))
    });

    let input: SessionInsightExportInput;
    if (request.kind === 'session') {
      const side = this.hostEvidence.readTransaction(() =>
        collectSide(request.sessionId, request.snapshotId)
      );
      input = { kind: 'session', format: request.format, ...side };
    } else {
      const sides = this.hostEvidence.readTransaction(() => ({
        left: collectSide(request.left.sessionId, request.left.snapshotId),
        right: collectSide(request.right.sessionId, request.right.snapshotId)
      }));
      input = { kind: 'comparison', format: request.format, ...sides };
    }

    const report = exportSessionInsightReport(input);
    return { body: report.content, contentType: report.contentType, filename: report.filename };
  }

  // -------------------------------------------------------------------------
  // 内部辅助
  // -------------------------------------------------------------------------

  /** 固定 snapshot 归属读取：tombstone 410 优先，未知/不归属 404。 */
  private requireSnapshot(sessionId: string, snapshotId: string): SessionInsightSnapshotRecord {
    if (this.repos.isSnapshotTombstoned(sessionId, snapshotId)) {
      throw new RuntimeError('INSIGHT_SNAPSHOT_GONE', 'Session insight snapshot is no longer available', 410);
    }
    const snapshot = this.repos.getSnapshot(sessionId, snapshotId);
    if (!snapshot) {
      throw new RuntimeError('INSIGHT_NOT_FOUND', 'Session insight resource not found', 404);
    }
    return snapshot;
  }

  private availabilityForManifest(manifest: SessionInsightManifest): 'partial' | 'complete' {
    // complete 要求：所有预期来源 matched 且引擎 ok/无截尾，且没有发现截断
    // （DISCOVERY_LIMITED 经 aggregation.reasonCodes 表达，见 A3 host 覆盖事实合并）。
    const allMatchedWhole = manifest.sources.every(
      source => source.matchStatus === 'matched' && source.status === 'ok'
    );
    const noDiscoveryLimit = manifest.sources.every(
      source => !source.aggregation.reasonCodes.includes('DISCOVERY_LIMITED')
    );
    return allMatchedWhole && noDiscoveryLimit ? 'complete' : 'partial';
  }

  private fallbackReason(sessionId: string): string | undefined {
    const code = this.repos.getState(sessionId).errorCode;
    if (code === 'engine_unavailable') return 'analysis_engine_unavailable';
    if (code === 'no_verified_source' || code === 'no_valid_analysis') return 'no_verified_native_source';
    return code ?? undefined;
  }

  /** details 无快照时现场只读冻结宿主证据（读取时刻事实，非固定分析快照）。 */
  private projectCurrentHostEvidence(sessionId: string): HostEvidenceSnapshot | null {
    try {
      const frozen = this.hostEvidence.readTransaction(() => {
        const raw = this.hostEvidence.readHostEvidenceRaw(sessionId);
        const executions = this.hostEvidence.getSessionExecutions(sessionId);
        const accepted = raw.tasks
          .map(task => this.hostEvidence.getAcceptedTask(task.id))
          .filter((value): value is AcceptedTask => Boolean(value));
        return { raw, executions, accepted };
      });
      return buildHostEvidenceSnapshot(
        {
          capturedAt: frozen.raw.capturedAt,
          executions: frozen.executions,
          accepted: frozen.accepted,
          verifications: this.projectVerifications(frozen.raw.verificationRecords, undefined),
          usageEntries: frozen.raw.usageEntries as unknown as UsageLedgerEntry[]
        },
        // host-only 现场投影同样使用统一私有路径上下文（含持久 sources 历史 root/path）。
        this.buildHostRedactionContext(sessionId, frozen.raw.session.cwd)
      );
    } catch {
      return null;
    }
  }

  private async safeCurrentHostDigest(sessionId: string): Promise<string | undefined> {
    try {
      const fingerprint = await this.getCurrentFingerprint?.(sessionId).catch(() => undefined);
      // 事务内只同步冻结权威原始行；canonical JSON/hash/脱敏等大计算一律在事务外，
      // 与 runJob 的 freeze→project 顺序保持一致。
      const frozen = this.hostEvidence.readTransaction(() => {
        const raw = this.hostEvidence.readHostEvidenceRaw(sessionId);
        const executions = this.hostEvidence.getSessionExecutions(sessionId);
        const accepted = raw.tasks
          .map(task => this.hostEvidence.getAcceptedTask(task.id))
          .filter((value): value is AcceptedTask => Boolean(value));
        return { raw, executions, accepted };
      });
      return buildHostEvidenceSnapshot(
        {
          capturedAt: frozen.raw.capturedAt,
          executions: frozen.executions,
          accepted: frozen.accepted,
          verifications: this.projectVerifications(frozen.raw.verificationRecords, fingerprint),
          usageEntries: frozen.raw.usageEntries as unknown as UsageLedgerEntry[]
        },
        this.buildHostRedactionContext(sessionId, frozen.raw.session.cwd)
      ).digest;
    } catch {
      return undefined;
    }
  }

  /** configs 原始核验行 → VerificationResponse；无当前指纹时保守标 stale，绝不默认 fresh。 */
  private projectVerifications(
    records: Array<{ key: string; value: unknown }>,
    currentFingerprint: string | undefined
  ): VerificationResponse[] {
    const result: VerificationResponse[] = [];
    for (const record of records) {
      const value = record.value as Partial<VerificationResponse> | null;
      if (!value || value.schemaVersion !== 1 || typeof value.id !== 'string') continue;
      const before = typeof value.beforeFingerprint === 'string' ? value.beforeFingerprint : undefined;
      const after = typeof value.afterFingerprint === 'string' ? value.afterFingerprint : undefined;
      let stale: boolean;
      let staleReason: VerificationResponse['staleReason'];
      if (before && after && before !== after) {
        stale = true;
        staleReason = 'changed_during_run';
      } else if (currentFingerprint && after && currentFingerprint !== after) {
        stale = true;
        staleReason = 'code_changed';
      } else if (!currentFingerprint) {
        stale = true;
        staleReason = 'current_fingerprint_unavailable';
      } else if (!before || !after) {
        stale = true;
        staleReason = 'record_fingerprint_missing';
      } else {
        stale = false;
      }
      result.push({
        schemaVersion: 1,
        revision: typeof value.revision === 'number' ? value.revision : 1,
        id: value.id,
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
        ...(value.taskId ? { taskId: value.taskId } : {}),
        command: typeof value.command === 'string' ? value.command : '',
        cwd: typeof value.cwd === 'string' ? value.cwd : '',
        ...(value.actorId ? { actorId: value.actorId } : {}),
        status: (value.status as VerificationResponse['status']) ?? 'unverified',
        startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
        ...(value.completedAt ? { completedAt: value.completedAt } : {}),
        ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
        output: typeof value.output === 'string' ? value.output : '',
        outputTruncated: Boolean(value.outputTruncated),
        ...(before ? { beforeFingerprint: before } : {}),
        ...(after ? { afterFingerprint: after } : {}),
        ...(value.error ? { error: value.error } : {}),
        stale,
        ...(staleReason ? { staleReason } : {})
      });
    }
    return result;
  }

  private collectCanaries(
    sessionCwd: string,
    sources: ResolvedInsightSource[],
    tempDir?: string
  ): string[] {
    const canaries = new Set<string>();
    if (sessionCwd) canaries.add(sessionCwd);
    for (const source of sources) {
      if (source.approvedRoot) canaries.add(source.approvedRoot);
      if (source.verifiedPath) canaries.add(source.verifiedPath);
    }
    canaries.add(this.dataDir);
    if (tempDir) canaries.add(tempDir);
    return [...canaries];
  }

  /**
   * 构造 host 投影统一的私有路径 canary 上下文：session cwd + dataDir +
   * 已持久化 insight_sources 中的私有 dataRoot/verifiedPath。
   * details/host-only/currentDigest 与 runJob 快照投影必须用同一上下文规则，
   * 否则业务内容含 root 字符串时 digest 不稳定、host-only 也可能漏脱敏。
   * canary 仅用于内存脱敏，绝不持久进任何公开 DTO。
   */
  private buildHostRedactionContext(sessionId: string, sessionCwd: string): RedactionContext {
    const canaries = new Set<string>();
    if (sessionCwd) canaries.add(sessionCwd);
    canaries.add(this.dataDir);
    try {
      for (const observation of this.repos.listSources(sessionId)) {
        if (observation.dataRoot) canaries.add(observation.dataRoot);
        if (observation.verifiedPath) canaries.add(observation.verifiedPath);
        if (observation.cwd) canaries.add(observation.cwd);
      }
    } catch {
      // 列来源失败不阻断投影，仍至少脱敏 cwd/dataDir。
    }
    return { canaryPaths: [...canaries] };
  }

  private sourceRoles(resolved: ResolveSessionInsightSourcesResult): Record<string, InsightSourceRole> {
    const roles: Record<string, InsightSourceRole> = {};
    for (const source of resolved.sources) {
      if (source.status !== 'matched') continue;
      // T4d 只认 primary/subagent/excluded：resolver 的 additional 历史 main 来源
      // 在单会话摘要中保守按 excluded 观察，绝不抬成第二个 primary。
      roles[source.sourceKey] =
        source.role === 'primary'
          ? 'primary'
          : source.role === 'subagent'
            ? 'subagent'
            : 'excluded';
    }
    return roles;
  }

  /**
   * A2 + A3：把宿主侧已知但 Go 进程看不到/不需要看的覆盖事实合并进引擎结果。
   * - 半行截尾（capture.isPartial / trailingBytes>0）：Go 只分析完整 prefix 故报 ok，
   *   宿主把该文件降为 partial（metrics/trace 原样保留，不丢已有数据、不让整 job 失败）。
   * - 发现截断（resolver discoveryLimited）：在相关文件 coverage.subagentDiscovery
   *   标 partial 并向 aggregation.reasonCodes 补固定 DISCOVERY_LIMITED；
   *   不改 eligibility（primary 仍 eligible，正常 metrics 继续汇总），不伪造来源。
   * 纯函数，返回新对象，不修改引擎结果。
   */
  private applyHostCoverageFacts(
    result: AnalyzeFilesResult,
    facts: {
      captures: Map<string, InsightFileCaptureInfo>;
      discoveryLimited: boolean;
      perSourceDiscoveryLimited: Set<string>;
    }
  ): AnalyzeFilesResult {
    const files = result.files.map(file => {
      const capture = facts.captures.get(file.sourceKey);
      const halfLine = capture ? capture.isPartial === true || capture.trailingBytes > 0 : false;
      const discoveryLimited = facts.discoveryLimited || facts.perSourceDiscoveryLimited.has(file.sourceKey);
      if (!halfLine && (!discoveryLimited || file.status === 'error')) return file;

      const status = halfLine && file.status === 'ok' ? 'partial' : file.status;
      const subagentDiscovery =
        discoveryLimited && file.status !== 'error'
          ? ('partial' as const)
          : file.coverage.subagentDiscovery;
      const reasonCodes =
        discoveryLimited && file.status !== 'error' && !file.aggregation.reasonCodes.includes('DISCOVERY_LIMITED')
          ? [...file.aggregation.reasonCodes, 'DISCOVERY_LIMITED']
          : file.aggregation.reasonCodes;
      return {
        ...file,
        status,
        coverage: { ...file.coverage, subagentDiscovery },
        aggregation: { ...file.aggregation, reasonCodes }
      };
    });
    return { ...result, files };
  }

  private computeCacheKey(input: {
    bindingRevision: number;
    sources: ResolvedInsightSource[];
    captures: Map<string, InsightFileCaptureInfo>;
    hostDigest: string;
    versions: EngineVersionInfo;
    /** 全局发现截断（任一发现阶段命中候选上限）。 */
    discoveryLimited: boolean;
  }): string {
    const payload = {
      versions: {
        schema: SCHEMA_VERSION,
        engine: input.versions.engineVersion,
        parser: input.versions.parserVersion,
        metric: input.versions.metricVersion,
        redaction: REDACTION_VERSION
      },
      bindingRevision: input.bindingRevision,
      scope: SCOPE_VERSION,
      hostDigest: input.hostDigest,
      // A3：发现完整性是缓存身份的一部分。全局或任一来源 discoveryLimited 变化
      // （如候选从 <上限 增至 >上限）必须 miss，不能复用旧的“complete”快照。
      discoveryLimited: input.discoveryLimited,
      sources: input.sources
        .map(source => {
          const capture = input.captures.get(source.sourceKey);
          return {
            key: source.sourceKey,
            client: source.client,
            status: source.status,
            expectedNativeSessionId: source.expectedNativeSessionId,
            expectedStream: source.expectedStream,
            discoveryLimited: source.discoveryLimited === true,
            ...(capture
              ? {
                  prefixSha256: capture.sha256,
                  analyzedBytes: capture.analyzedBytes,
                  readBytes: capture.readBytes,
                  trailingBytes: capture.trailingBytes,
                  partial: capture.isPartial
                }
              : {})
          };
        })
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    };
    return createHash('sha256').update(canonicalExecutionJson(payload)).digest('hex');
  }

  private buildManifest(input: {
    snapshotId: string;
    sessionId: string;
    createdAt: string;
    bindingRevision: number;
    hostDigest: string;
    sources: ResolvedInsightSource[];
    captures: Map<string, InsightFileCaptureInfo>;
    result: AnalyzeFilesResult;
    versions: EngineVersionInfo;
  }): SessionInsightManifest {
    const resultByKey = new Map(input.result.files.map(file => [file.sourceKey, file]));
    const noRelationship = () => ({
      kind: 'none' as const,
      parentNativeSessionId: null,
      parentNativeAgentId: null,
      evidenceRefs: [] as string[]
    });
    // 引擎标 unknown 时宿主只能降低不能提升：resolver 的 child/fork 不覆盖引擎 unknown。
    const effectiveRelationship = (
      source: ResolvedInsightSource,
      engineRelationship: SessionInsightManifest['sources'][number]['relationship'] | undefined
    ): SessionInsightManifest['sources'][number]['relationship'] => {
      if (engineRelationship?.kind === 'unknown') return engineRelationship;
      return source.relationship ?? engineRelationship ?? noRelationship();
    };
    return {
      snapshotId: input.snapshotId,
      sessionId: input.sessionId,
      createdAt: input.createdAt,
      bindingRevision: input.bindingRevision,
      scopeVersion: SCOPE_VERSION,
      hostEvidenceDigest: input.hostDigest,
      sources: input.sources.map(source => {
        const capture = input.captures.get(source.sourceKey);
        const file = resultByKey.get(source.sourceKey);
        return {
          sourceKey: source.sourceKey,
          client: source.client,
          matchStatus: source.status,
          expectedStream: source.expectedStream,
          sha256: capture?.sha256 ?? null,
          capturedAt: capture?.capturedAt ?? null,
          readBytes: capture?.readBytes ?? null,
          analyzedBytes: capture?.analyzedBytes ?? null,
          trailingBytes: capture?.trailingBytes ?? null,
          fingerprint: capture?.fingerprint ?? null,
          relationship: effectiveRelationship(source, file?.relationship),
          aggregation: file?.aggregation ?? {
            eligibility: 'excluded' as const,
            reasonCodes: [`source_${source.status}`]
          },
          // manifest status 只承载 ok/partial/error/missing；ambiguous/unsupported 已体现在
          // matchStatus，引擎未回传该来源时统一记 missing，不伪造成可分析结果。
          status: file ? file.status : 'missing'
        };
      }),
      versions: {
        schemaVersion: SCHEMA_VERSION,
        engineVersion: input.versions.engineVersion,
        parserVersion: input.versions.parserVersion,
        metricVersion: input.versions.metricVersion,
        redactionVersion: REDACTION_VERSION
      }
    };
  }

  private flattenEvents(result: AnalyzeFilesResult, snapshotId: string): SessionInsightEventItem[] {
    const events: SessionInsightEventItem[] = [];
    // error 文件的 trace 不发布：只保留有效（ok/partial）文件的事件。
    for (const file of result.files) {
      if (file.status === 'error') continue;
      for (const event of file.trace) {
        events.push({ ...event, snapshotId, ordinal: events.length });
      }
    }
    return events;
  }

  /**
   * 报告关键事件：按 summary.keyEvidenceEventIds 通过 repo 分页收集，
   * 每侧最多 100 条，全程扫描硬上限 20k，禁止新 raw log。
   */
  private collectKeyEvidence(snapshot: SessionInsightSnapshotRecord): SessionInsightEventItem[] {
    const wanted = new Set<string>([
      ...snapshot.summary.keyEvidenceEventIds.failures,
      ...snapshot.summary.keyEvidenceEventIds.slowCalls,
      ...snapshot.summary.keyEvidenceEventIds.highTokenDeltas
    ]);
    const byId = new Map<string, SessionInsightEventItem>();
    let cursor: string | undefined;
    let scanned = 0;
    while (scanned < SESSION_INSIGHT_LIMITS.maxTraceEventsPerJob) {
      const page = this.repos.listEvents({
        snapshotId: snapshot.snapshotId,
        ...(cursor ? { cursor } : {}),
        limit: SESSION_INSIGHT_LIMITS.maxEventsPerPageMax
      });
      for (const item of page.items) {
        if (wanted.has(item.eventId)) byId.set(item.eventId, item);
      }
      scanned += page.items.length;
      if (!page.nextCursor || byId.size >= SESSION_INSIGHT_LIMITS.maxReportEvidenceCount) break;
      cursor = page.nextCursor;
    }
    const order = new Map<string, number>();
    [
      ...snapshot.summary.keyEvidenceEventIds.failures,
      ...snapshot.summary.keyEvidenceEventIds.slowCalls,
      ...snapshot.summary.keyEvidenceEventIds.highTokenDeltas
    ].forEach((id, index) => {
      if (!order.has(id)) order.set(id, index);
    });
    return [...byId.values()].sort(
      (a, b) => (order.get(a.eventId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.eventId) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  private toSummaryCandidate(row: SessionInsightSummaryRawRow): SummaryCandidate {
    // 用途证据只用真实 accepted request；proactive 证据在 catalog 行中不可得，留 unknown，
    // 不用 prompt / Usage 反推（T4d deriveSessionUsage 对证据缺失保守返回 unknown）。
    const tasks = row.tasks.map(task => ({ request: this.parseAcceptedRequest(task.acceptedRequest) }));
    return {
      sessionId: row.sessionId,
      agentId: row.agentId,
      cwd: row.cwd,
      ...(row.workspaceSourceCwd ? { workspaceSourceCwd: row.workspaceSourceCwd } : {}),
      source: row.source,
      sourceId: row.sourceId,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      refreshState: row.refreshState,
      errorCode: row.errorCode,
      lastCheckedAt: row.lastCheckedAt,
      tasks,
      ...(row.snapshot
        ? {
            snapshot: {
              snapshotId: row.snapshot.snapshotId,
              availability: this.availabilityForManifest(row.snapshot.manifest),
              // 不做全量 stat/内容 hash：汇总维度只给 unknown 或明确 revision stale。
              freshness: 'unknown' as InsightFreshness,
              metricVersion: row.snapshot.manifest.versions.metricVersion,
              summary: row.snapshot.summary
            }
          }
        : {})
    };
  }

  private parseAcceptedRequest(raw: unknown): TaskRequestV1 | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const candidate = raw as { request?: unknown };
    if (candidate.request && typeof candidate.request === 'object') {
      return candidate.request as TaskRequestV1;
    }
    return raw as TaskRequestV1;
  }
}

function cryptoRandomUuid(): string {
  return globalThis.crypto.randomUUID();
}
