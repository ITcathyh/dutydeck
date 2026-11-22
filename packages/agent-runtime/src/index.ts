import { runtimeHost, type ActiveTaskContext, type ExecutionPolicy, type LaunchContext, type PromptAssembler, type RuntimeEventBus, type RuntimeHost } from './runtime/host-ports.js';
export { createAcceptPrompt, RuntimeEventBus, type ActiveTaskContext, type ExecutionPolicy, type LaunchContext, type PromptAssembler, type RuntimeEvent } from './runtime/host-ports.js';
import { TurnRunner } from './runtime/turn-runner.js';
import { EventIngest } from './runtime/event-ingest.js';
import { Scheduler } from './runtime/scheduler.js';
import { DriverSupervisor } from './runtime/driver-supervisor.js';
import { SteeringService } from './runtime/steering-service.js';
import { sessionConfigOf, type SessionKinds, type SessionKindSpec, type NoticeFacts, runtimeStateKeys, clearTaskReportSafely, readSessionTaskReportReference, readSessionTaskReport, SESSION_NAME_CONFIG_PREFIX, taskReportInputSchema, writeTaskReport, type SessionWorkspace, type TaskReport, type TaskReportInput } from '@dutydeck/shared';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AgentCapabilities, AgentConfig, AttemptActivity, AgentDriver, AgentEvent, DriverFactory, DriverTranscriptSourceObservation, EventType, EventWindowOptions, HistoryOutlineQuery, NormalizedDriverEvent, PermissionMode, PermissionRequestData, PromptPart, PromptSourceDiagnostics, PublicTaskRecord, RepositoryBundle, RuntimeControlClaim, Session, SkillDeliveryMetadata, StartSessionInput, TaskExecutionContext, TaskRecord, ToolRiskPolicy, TranscriptSourceObservation, VerificationCommandInput, VerificationResponse, WorkspaceCleanupBlocker, WorkspaceCleanupPreview, WorkspaceCleanupResult, WorkspaceResponse } from '@dutydeck/shared';
import { canonicalExecutionJson, taskRequestV1Schema, makeId, now, errorMessage, RuntimeError, workspaceModes, sessionNameConfigKey, normalizeSessionName, supportsRemoteApproval, supportsNativeFork, redactCredentialText } from '@dutydeck/shared';
import { warnCaught, type DiagnosticLog } from '@dutydeck/shared';
import { listAcpxBuiltinAgents, AcpxAdapter, ProcessTreeCpu } from '@dutydeck/acp-client';
import { commandExists, JsonlTransport, PipeTransport, probeAgent, PtyTransport } from '@dutydeck/transports';
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { UnknownTaskFacts, UnknownTaskResolution, SteeringRecoveryDecision, PtyRetirementRecovery, ExecutionRecoveryDecision, AcceptedTask, AcceptedTaskInputV2, AttemptFence, AttemptRef, BoundExecutionRepository, CommitResult, DriverSteeringOutcome, ExecutionActor, ResourceCheckRef, SessionFence, TaskRequestV1 } from '@dutydeck/shared';
import { executionTaskId } from '@dutydeck/storage/helpers';
import { PersistentEventPublisher, type SubscribeOptions, type EventListener } from './persistent-event-publisher.js';
import { digest, eventJson, executionOptionsOf, DriverConfigurationLedger, LocalDriverLedger, type ExecutionOptions } from './ledger.js';
import { agentAuthFailure, agentLoginProblem, defaultAgentStatusCheck, type AgentStatusCheck, type AgentUnavailable } from './agent-availability.js';
import { isAttemptRef } from './runtime/attempt-ref.js';
import { HumanWaits } from './runtime/human-waits.js';
import { RecoveryService } from './runtime/recovery-service.js';
import { Notices } from './runtime/notices.js';
import { SessionGate } from './session-gate.js';
import { Maintenance } from './runtime/maintenance.js';
import { isNonGitWorkspace, WorkspaceManager } from './workspace.js';
import { cachedRepositoryFingerprint, VerificationManager } from './verification.js';
import { owner, RevokedOperation, RuntimeSessionMutations, type Owner, type RevocationReason } from './ownership.js';
import {
  INSIGHT_INSTANCE_ID_CONFIG_KEY,
  canonicalizeDataRoot,
  createTranscriptSourceKeys
} from './session-insight-source.js';

function isSameOrIntersectingPath(a: string, b: string): boolean {
  if (a === b) return true;
  const sepWithA = a.endsWith(sep) ? a : a + sep;
  const sepWithB = b.endsWith(sep) ? b : b + sep;
  return a.startsWith(sepWithB) || b.startsWith(sepWithA);
}


/** 启动期（资源尚未 ready）driver transcript source 观察的有界缓冲上限。 */
const INSIGHT_SOURCE_MAX_PENDING = 64;

/** 一条 transcript source 订阅的冻结上下文与启动期 pending 缓冲。 */
interface InsightSourceSubscription {
  readonly sessionId: string;
  readonly driverInstanceId: string;
  readonly generation: number;
  readonly driver: AgentDriver;
  /** 取消 driver 侧订阅的回调（subscribe 返回后填充）。 */
  unsubscribe?: () => void;
  /** false=启动期，观察入 pending；true=资源 ready 后，观察直接核验入队。 */
  ready: boolean;
  /** ready 前的有界观察缓冲，按到达顺序，采纳后 flush 一次。 */
  pending: DriverTranscriptSourceObservation[];
}



// 驱动契约类型统一从 @dutydeck/shared 导出（driver.ts 是跨团队冻结契约），
// 本包不再自定义 AgentDriver / DriverFactory / NormalizedDriverEvent。
export type { AgentDriver, DriverFactory, NormalizedDriverEvent };

// 执行账本使用的规范 JSON sha256 摘要，供 server 生成同一规则的稳定 ID。
export { digest } from './ledger.js';

// 定时计划前置命令复用交付前验证的执行器与最小工具环境。
export { runIsolatedCommand, type IsolatedCommandResult } from './verification.js';

// Session Insight 来源 key 计算规则与稳定实例 ID 配置键，供 resolver (T3d) 复用同一规则。
export {
  createTranscriptSourceKeys,
  canonicalizeDataRoot,
  INSIGHT_INSTANCE_ID_CONFIG_KEY
} from './session-insight-source.js';

export interface PtyRetirementControl {
  capture(session: Session): unknown | Promise<unknown>;
  stop(session: Session, snapshot: unknown, beforeKill: (snapshot: unknown) => Promise<void>): Promise<unknown>;
  verify(session: Session, snapshot: unknown): boolean | Promise<boolean>;
  /**
   * 原终端已不存在时给出可复核的不存在证明（verify 能复查），终端还在时返回 undefined。只凭它不算退出证明：
   * 运行时还要求终端记录的所有者运行时已退出（见 retireDetachedPty）。
   */
  captureAbsence?(session: Session): Promise<unknown | undefined>;
}
export interface TaskRequestMaterial {
  agentPrompt?: string;
  riskPolicy?: ToolRiskPolicy;
  idleCompactHours?: number;
  promptParts?: PromptPart[];
}

export interface RuntimeOptions {
  executionPolicy?: ExecutionPolicy;
  launchContext?: LaunchContext;
  promptAssembler?: PromptAssembler;
  events?: RuntimeEventBus;
  beforeSettlement?: (session: Session, taskId: string) => Promise<void>;
  matterSummary?: import('@dutydeck/shared').MatterTracking['summary'];
  sessionKinds?: SessionKinds;
  renderNotice?: (facts: NoticeFacts) => string;
  /** Legacy host callbacks are adapted when the corresponding port is omitted. */
  matterTracking?: import('@dutydeck/shared').MatterTracking;
  ptyRetirement?: PtyRetirementControl;

  authorizeExecution?: (sessionId: string, actorId?: string) => Promise<void | (() => Promise<void>)>;
  /** Stopping an owned resource remains permitted after its execution authority is revoked. */
  authorizeControl?: (sessionId: string, actor: ExecutionActor, action: 'stop') => Promise<void>;
  /** Revalidate the accepted task's external authority immediately before execution. */
  authorizeTask?: (session: Session, task: TaskRecord, phase: 'prepare' | 'submit') => Promise<void>;
  /** 新任务接收前的准入检查（如月度成本上限），抛错即拒绝；按幂等键重放已接收的任务不经过这里。 */
  admitTask?: (session: Session, request: TaskRequestV1) => Promise<void>;
  /**
   * 一轮的用量读数：ACP 驱动的 status/turn_usage 事件带读数，completed 事件不带（没有读数的驱动据此记为无数据）。
   * 在事件落库之后调用，失败不影响本轮；求差、估算、归类都由宿主负责。
   */
  recordUsage?: (session: Session, attempt: AttemptRef, reading?: Record<string, unknown>) => Promise<void>;
  /**
   * 一轮交给驱动之前（start）和驱动返回之后（end）各调一次，宿主据此记下这一轮的改动范围。
   * 失败不影响本轮；时限由宿主负责。重启后接上的一轮没有 start，也就不调 end。
   */
  observeTurn?: (session: Session, taskId: string, phase: 'start' | 'end') => Promise<void>;
  resolveRiskPolicy?: (sessionId: string, fallback?: ToolRiskPolicy) => Promise<ToolRiskPolicy | undefined>;
  acpxCommand?: string;
  driverFactory?: DriverFactory;
  /**
   * pty-cli 协议驱动工厂（PTY 适配器驱动栈，由 @dutydeck/pty-driver 提供）。
   * 仅在未注入自定义 driverFactory 时生效：agent.protocol === 'pty-cli' 的会话路由到它。
   * 未提供时创建 pty-cli 会话会抛 DRIVER_UNAVAILABLE。
   */
  ptyDriverFactory?: DriverFactory;
  /** Selected once for a newly created PTY CLI session; existing sessions keep their backend. */
  terminalBackend?: () => Promise<'tmux' | 'herdr'>;
  probe?: typeof probeAgent;
  driverIdleTimeoutMs?: number;
  driverIdleCpuAction?: 'off' | 'diagnose' | 'retire';
  cleanupIntervalMs?: number;
  configureAgent?: (agent: AgentConfig, session: Session) => Promise<AgentConfig>;
  sessionEnvironment?: (session: Session) => Record<string, string>;
  selectPromptPolicy?: (session: Session, request: TaskRequestV1) => Promise<{ version: 'legacy-v1' | 'optimized-v1'; diagnosticReason?: string }>;
  sessionPrompt?: (session: Session, prompt: string, context?: TaskExecutionContext) => string | { prompt: string; diagnostics?: PromptSourceDiagnostics } | Promise<string | { prompt: string; diagnostics?: PromptSourceDiagnostics }>;
  workspaceRoot?: string;
  prepareTaskPrompt?: (session: Session, prompt: string, skillRequests?: string[], context?: Pick<TaskExecutionContext, 'promptPolicyVersion' | 'promptParts'>) => Promise<{
    agentPrompt: string;
    skillDeliveries?: SkillDeliveryMetadata[];
    promptParts?: PromptPart[];
    promptDiagnostics?: PromptSourceDiagnostics;
  }>;
  /** Diagnostics only, e.g. a steering reply that arrives after its timeout. */
  log?: DiagnosticLog;
  /** 会话里有 Agent 的提问在等人回答（relay ask）：与待审批一样是人工等待，这期间不判这一轮可能卡住。 */
  awaitingAnswer?: (sessionId: string) => boolean;
  /** 不调模型的登录状态检查，缺省见 agent-availability.ts。只在 checkAgentAvailability 里调用。 */
  agentStatusCheck?: AgentStatusCheck;
  /**
   * 待审批的工具调用在进入人工审批前先交给宿主（插件 hook）判定：allow/deny 直接代为决定、不再出审批，
   * 其他返回值照常进入人工审批。抛错按未判定处理。
   */
  reviewPermission?: (session: Session, request: PermissionRequestData) => Promise<'allow' | 'deny' | undefined>;
  /** 一轮执行结算后（completed/failed/interrupted/cancelled）通知宿主；不阻塞队列，异常忽略。 */
  onTaskSettled?: (session: Session, task: PublicTaskRecord) => void | Promise<void>;
  /** 一次验证跑完后通知宿主；不影响验证结果，异常忽略。 */
  onVerificationCompleted?: (session: Session, result: VerificationResponse) => void | Promise<void>;
  /** 会话提醒（排队受阻、结果未知久未处理或已自动结案、空闲回收后终端退出未核实）已写进会话后交给宿主投递，比如转到飞书原话题；同一提醒只调一次，异常只记日志。 */
  onSessionNotice?: (session: Session, notice: SessionNotice) => void | Promise<void>;
}

/** 运行时留在会话里的提醒（status 事件 state=notice）。id 稳定：同一件事只提醒一次，宿主可直接当幂等键。 */
export interface SessionNotice {
  id: string;
  kind: 'workspace_blocked' | 'unknown_task_overdue' | 'unknown_task_abandoned' | 'queue_expired' | 'stop_unverified';
  taskId: string;
  /** 结果未知提醒对应的执行，用于沿用宿主已有的提醒。 */
  attemptId?: string;
  /** 给人看的纯文本，段落之间空一行。 */
  message: string;
  /** 能处理这件事的会话（Web 详情入口）。 */
  sessionIds: string[];
}
/** 自更新的 CLI 原地替换可执行文件期间命令短暂不存在；找不到命令时等这么久再看一次。 */
const COMMAND_SWAP_WAIT_MS = 3_000;
const recoveryOwner: ExecutionActor = { kind: 'installation_owner', id: 'installation_owner' };


/** 已确认投递的任务完成；明确未投递才回队列，failed 保留未知状态等待恢复。 */
export type SteeringOutcome = DriverSteeringOutcome | 'incompatible' | 'failed';
export interface SteeringResult {
  task: PublicTaskRecord;
  outcome: SteeringOutcome;
  error?: string;
  /** 持久化 steering operation 的真实投递目标；未建立 operation 时不伪造。 */
  target?: AttemptRef;
}
/**
 * 一轮后面有人排队、驱动事件与终端输出（PTY 的屏幕变化以 raw_terminal 事件到达）都静默这么久、受管进程树 CPU 也不活跃时，
 * 提示这一轮可能卡住。Claude Code 干活时每秒都在刷新计时，长工具也有输出或心跳，3 分钟毫无动静且不占 CPU 已不正常；与 HappyClaw 的判定阈值相同。
 */
const TURN_STALL_SILENCE_MS = 3 * 60_000;
/** 读不到 CPU（非 Linux、驱动给不出进程号）时只凭静默判断，放宽到 10 分钟，与 HappyClaw 的强制上限同值。 */
const TURN_STALL_UNKNOWN_CPU_SILENCE_MS = 10 * 60_000;
/** 心跳每秒都可能来问，CPU 至少隔这么久才重新读一次 /proc。 */
const TURN_STALL_CPU_WINDOW_MS = 10_000;
export interface TurnStall { taskId: string; silentMs: number; queued: number; cpu: 'inactive' | 'unknown' }

/** changeDriverConfiguration 在调用驱动之前的拒绝（轮次占用、上一次配置未完成或有待审批、驱动不能保留上下文）原样抛出，调用方据此给出专用提示。 */
const switchRejection = (error: unknown) =>
  error instanceof RuntimeError && ['TURN_IN_PROGRESS', 'DRIVER_CONFIGURATION_BUSY', 'TASK_OPTIONS_UNSUPPORTED'].includes(error.code) ? error : undefined;

const warnedTaskRejections = new Set<string>();

export class DutydeckRuntime {
  private readonly mutations = new RuntimeSessionMutations(() => this.assertBinding(), () => this.assertReady(), {
    lifecycle: id => this.lifecycle(id), ownerOf: id => this.ownerOf(id),
    transition: (id, reason) => this.transition(id, reason),
    renew: (id, parent) => {
      const lifecycle = owner(id, parent);
      this.lifecycles.set(id, lifecycle);
      return lifecycle;
    },
  });
  private readonly runtimeInstanceId = makeId('runtime');
  private binding?: RuntimeControlClaim;
  private readonly initializationContext = new AsyncLocalStorage<boolean>();
  private readonly initializationOwner = owner('runtime_initialize');
  private initialized = false;
  private initializationFailed = false;
  private assertBinding() {
    if (!this.binding) throw new RuntimeError('RUNTIME_NOT_INITIALIZED', 'Initialize this Runtime before using it', 409);
    this.binding.assertCurrent();
  }
  private assertReady() {
    if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
    this.assertBinding();
    if (this.initializationFailed || (!this.initialized && !this.initializationContext.getStore())) throw new RuntimeError('RUNTIME_NOT_INITIALIZED', 'Runtime initialization has not completed', 409);
  }
  private readonly lifecycles = new Map<string, Owner>();
  private initializationRun?: Promise<void>;
  private initializationCleanup?: Promise<void>;
  private releaseInitializationCleanup?: () => void;
  private shutdownRun?: Promise<void>;
  private readonly transitions = new Map<string, Owner>();
  private readonly attachedTerminals = new WeakSet<AgentDriver>();
  private execution?: BoundExecutionRepository;
  /** Session Insight live 来源写入器，initialize 建立真实 claim 后绑定一次。 */
  private insightWriter?: import('@dutydeck/shared').SessionInsightLiveSourcesWriter;
  /** 本实例稳定 ID（configs: insight.instance_id），重启不变；sourceSessionKey 的组成部分。 */
  private insightInstanceId?: string;
  /** 每个 driver 一条 transcript source 订阅状态（含启动期有界 pending 缓冲）。 */
  private readonly insightSourceSubs = new WeakMap<AgentDriver, InsightSourceSubscription>();
  private readonly eventScope = new AsyncLocalStorage<AttemptRef & SessionFence | SessionFence>();
  private readonly localResources: LocalDriverLedger;
  private readonly configurations: DriverConfigurationLedger;
  private readonly publisher: PersistentEventPublisher;
  private readonly sendWaiters = new Set<() => void>();
  /** 按 Agent 记的不可用标记（没登录、凭据失效），只在进程内；见 checkAgentAvailability。 */
  private readonly agentUnavailable = new Map<string, AgentUnavailable>();
  private readonly agentChecks = new Map<string, Promise<AgentUnavailable | undefined>>();
  private readonly activeTurns = new Set<string>();
  private readonly activeTasks = new Map<string, TaskRecord>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly exitedDriverGenerations = new Map<string, number>();
  private readonly exitListeners = new Map<string, Set<(code: number | null) => void>>();
  private readonly factory: DriverFactory;
  /** 当前一轮的开始时间，之后每个驱动事件（含 raw_terminal）刷新一次。 */
  private readonly turnProgressAt = new Map<string, number>();
  private readonly turnCpu = new Map<string, ProcessTreeCpu>();
  private shuttingDown = false;
  private readonly workspaces: WorkspaceManager;
  private readonly verifications: VerificationManager;
  private readonly verifyingSessions = new Set<string>();
  /** Canonical directory each admitted verification holds until its command has ended. */
  private readonly verificationHolds = new Map<string, string>();
  private readonly startingWorkSessions = new Set<string>();
  private readonly verificationDeferredTasks = new Map<string, Set<string>>();
  private readonly blockedVerificationSessions = new Map<string, string>();
  private readonly cleaningDirs = new Map<string, string>();
  private readonly preparingWorkspaces = new Map<string, Set<Owner>>();
  private readonly workspacePreparations = new Set<Promise<WorkspaceResponse>>();
  private readonly workspaceReaders = owner('workspace_readers');
  private readonly cleaningRuns = new Map<string, Promise<WorkspaceCleanupResult>>();

  private readonly gate: SessionGate = new SessionGate({
    capacity_wait: id => this.scheduler.capacityWaiting(id),
    pty_retirement: id => this.recovery.isRetiringPty(id),
    shutting_down: () => this.shuttingDown,
    queue_held: () => this.scheduler.isQueueHeld(),
    initialization_failed: () => this.initializationFailed,
    queue_blocked: id => this.scheduler.queueBlocked.has(id),
    resource_queue_blocked: id => this.scheduler.resourceQueueBlocked.has(id),
    driver_retiring: id => this.supervisor.retiringDrivers.has(id),
    stop_running: id => this.supervisor.stopRuns.has(id),
    lifecycle_invalid: id => !this.mutations.valid(this.lifecycle(id)),
    lifecycle_revoked: id => this.lifecycle(id).revoked,
    drain_active: id => this.mutations.drains.has(id),
    attempt_active: id => this.mutations.attempts.has(id),
    verification_active: id => this.verifyingSessions.has(id),
    steering_active: id => this.steering.isActive(id),
    verification_blocked: id => this.blockedVerificationSessions.has(id),
    queue_empty: id => !this.scheduler.projected(id)?.length,
    turn_active: id => this.activeTurns.has(id),
    driver_replaced: (id, driver) => this.supervisor.drivers.get(id) !== driver,
    recovery_in_flight: id => this.recoveryInFlight(id),
    permission_pending: id => this.humanWaits.pendingPermissionCount(id) > 0,
    answer_pending: id => this.humanWaits.awaitingAnswer(id),
    unresolved_tasks: id => this.repos.execution.getUnresolvedTasks(id).length > 0,
    queued_or_running: id => this.repos.execution.hasQueuedOrRunningTasks(id)
  }, id => this.supervisor.drivers.has(id), id => this.repos.execution.getTaskExecution(id)?.task.status, () => this.supervisor.stopFacts);

  private readonly steering: SteeringService;
  private readonly supervisor: DriverSupervisor;
  private readonly scheduler: Scheduler;
  private readonly events: EventIngest;
  private readonly runner: TurnRunner;
  private readonly recovery: RecoveryService;
  private readonly maintenance: Maintenance;
  private readonly humanWaits: HumanWaits;
  private readonly notices: Notices;

  private readonly options: RuntimeHost;
  constructor(private readonly repos: RepositoryBundle, input: RuntimeOptions = {}) {
    const options = this.options = runtimeHost(input);
    const interval = options.cleanupIntervalMs ?? 5 * 60_000;
    if (!Number.isInteger(interval) || interval < 0 || interval > 2_147_483_647) {
      throw new RuntimeError('INVALID_CLEANUP_INTERVAL', 'cleanupIntervalMs must be 0 (disabled) or an integer between 1 and 2147483647', 400);
    }
    this.notices = new Notices(repos.config, options, this.mutations, this.gate,
      (id, data, eventId) => this.emit(id, 'status', data, undefined, eventId));
    this.configurations = new DriverConfigurationLedger(repos.config);
    this.localResources = new LocalDriverLedger(() => this.bound(), repos.execution);
    this.publisher = new PersistentEventPublisher({ highWaterMark: id => repos.events.highWaterMark(id), listWindow: (id, options) => repos.events.listWindow(id, options) }, undefined, options.log);
    this.workspaces = new WorkspaceManager(repos.config, options.launch.workspaceRoot, (id, commit) => {
      if (!this.mutations.current()) throw new RuntimeError('WORKSPACE_OWNER_REQUIRED', 'Workspace record writes require an explicit local owner', 500);
      return this.mutations.write(id, commit);
    });
    this.verifications = new VerificationManager(repos.config, (id, commit) => this.mutations.run(undefined, () => this.mutations.write(id, commit)));
    const ptyDriverFactory = options.launch.ptyDriverFactory;
    this.factory = options.launch.driverFactory ?? ((agent, protocol, onEvent, onExit, sessionId, context) => {
      if (protocol === 'acp') return new AcpxAdapter({ ...agent, env: { ...agent.env, dutydeck_session_id: sessionId } }, { sessionKey: sessionId, context, onEvent, log: this.options.log, ...(this.options.policy.riskPolicy ? { resolveRiskPolicy: (fallback?: ToolRiskPolicy) => this.options.policy.riskPolicy!(sessionId, fallback) } : {}), ...(this.options.awaitingAnswer ? { awaitingAnswer: () => this.humanWaits.awaitingAnswer(sessionId) } : {}) });
      if (protocol === 'pty-cli') {
        if (!ptyDriverFactory) throw new RuntimeError('DRIVER_UNAVAILABLE', 'protocol 为 pty-cli 的 agent 需要注入 ptyDriverFactory（@dutydeck/pty-driver）', 503);
        // 高风险拦截钩子按 dutydeck_session_id 找会话策略，和 ACP 一样由宿主注入。
        return ptyDriverFactory({ ...agent, env: { ...agent.env, dutydeck_session_id: sessionId } }, protocol, onEvent, onExit, sessionId, context);
      }
      if (protocol === 'pty') return new PtyTransport(agent, { onEvent, onExit });
      if (protocol === 'pipe') return new PipeTransport(agent, { onEvent, onExit, context });
      return new JsonlTransport(agent, { onEvent, onExit, context });
    });
    if (!options.launch.driverFactory) this.factory.controlledResources = protocol => protocol === 'acp' || protocol === 'jsonl' || protocol === 'pipe';
    this.supervisor = new DriverSupervisor(this.mutations, {
      assertResources: (...args) => this.assertResources(...args),
      assertVerificationRecoverySafe: (...args) => this.assertVerificationRecoverySafe(...args),
      attachedTerminals: this.attachedTerminals,
      attemptFence: (...args) => this.attemptFence(...args),
      blockedVerificationSessions: this.blockedVerificationSessions,
      bound: (...args) => this.bound(...args),
      cancelSessionQueue: (...args) => this.scheduler.cancelSessionQueue(...args),
      cancelCapacityTimer: id => this.scheduler.cancelCapacityTimer(id),
      changeDriverConfiguration: (...args) => this.runner.changeDriverConfiguration(...args),
      claim: () => this.binding,
      commandSwapWindow: (...args) => this.commandSwapWindow(...args),
      configurations: this.configurations,
      configureAgentForSession: (...args) => this.configureAgentForSession(...args),
      drainSessionEvents: id => this.events.drainSession(id),
      exitedDriverGenerations: this.exitedDriverGenerations,
      factory: this.factory,
      fence: (...args) => this.fence(...args),
      flushInsightSources: (...args) => this.flushInsightSources(...args),
      gate: this.gate,
      humanWaits: () => this.humanWaits,
      localResources: this.localResources,
      notices: this.notices,
      notifyDriverExit: (...args) => this.notifyDriverExit(...args),
      onDriverEvent: (...args) => this.events.onDriverEvent(...args),
      options,
      persistTerminalReceipt: (...args) => this.recovery.persistTerminalReceipt(...args),
      probe: (...args) => this.probe(...args),
      releaseSteeringDriver: driver => this.steering.releaseDriver(driver),
      reopenQueue: (...args) => this.reopenQueue(...args),
      repos,
      saveState: (...args) => this.saveState(...args),
      scheduleQueue: (...args) => this.scheduler.scheduleQueue(...args),
      sessionGenerations: this.sessionGenerations,
      settleExitedDriver: (...args) => this.events.settleExitedDriver(...args),
      shuttingDown: () => this.shuttingDown,
      subscribeInsightSources: (session, driver, generation, resourceId) => this.subscribeInsightSources(session, driver, generation, resourceId),
      unsubscribeInsightSources: (...args) => this.unsubscribeInsightSources(...args),
      verifications: this.verifications,
      wake: (...args) => this.wake(...args),
      wakeResourceQueues: (...args) => this.scheduler.wakeResourceQueues(...args),
      warnCaught: (...args) => this.warnCaught(...args),
      workspaces: this.workspaces,
    });
    this.humanWaits = new HumanWaits(this.mutations, {
      repos, options, drivers: this.supervisor.drivers, activeTasks: this.activeTasks, sessionGenerations: this.sessionGenerations,
      eventScope: this.eventScope, shuttingDown: () => this.shuttingDown,
      driverEventData: (scope, event) => this.events.driverEventData(scope, event),
      savePermission: (id, data) => this.artifact('savePermission', id, data),
      emit: (...args) => this.emit(...args), saveState: (...args) => this.saveState(...args),
      consume: (...args) => this.events.consume(...args), warnCaught: (...args) => this.warnCaught(...args),
      active: id => this.active(id),
      driverOperation: (driver, operation) => this.supervisor.driverOperation(driver, operation), touch: id => this.supervisor.touch(id),
    });
    this.scheduler = new Scheduler(this.mutations, {
      activeTasks: this.activeTasks,
      attachedTerminals: this.attachedTerminals,
      bound: (...args) => this.bound(...args),
      fence: (...args) => this.fence(...args),
      gate: this.gate,
      hasBinding: () => !!this.binding,
      humanWaits: this.humanWaits,
      interruptOwnedAttempt: (...args) => this.interruptOwnedAttempt(...args),
      localResources: this.localResources,
      notices: this.notices,
      options,
      recoveryActor: recoveryOwner,
      repos,
      runTask: (...args) => this.runner.runTask(...args),
      shuttingDown: () => this.shuttingDown,
      steeringActive: id => this.steering.isActive(id),
      supervisor: this.supervisor,
      verifyingSessions: this.verifyingSessions,
      wake: (...args) => this.wake(...args),
      warnCaught: (...args) => this.warnCaught(...args),
    });
    this.events = new EventIngest(this.mutations, {
      artifact: (method, ...args) => this.artifact(method, ...args),
      currentRef: (...args) => this.currentRef(...args),
      emit: (...args) => this.emit(...args),
      eventScope: this.eventScope,
      fence: (...args) => this.fence(...args),
      gate: this.gate,
      humanWaits: this.humanWaits,
      noteAgentFailure: (...args) => this.noteAgentFailure(...args),
      options,
      repos,
      saveState: (...args) => this.saveState(...args),
      scheduler: this.scheduler,
      sessionGenerations: this.sessionGenerations,
      shuttingDown: () => this.shuttingDown,
      supervisor: this.supervisor,
      turnProgressAt: this.turnProgressAt,
    });
    this.runner = new TurnRunner(this.mutations, {
      acceptedInput: (...args) => this.acceptedInput(...args),
      active: (...args) => this.active(...args),
      activeTasks: this.activeTasks,
      activeTurns: this.activeTurns,
      agentUnavailable: this.agentUnavailable,
      attemptFence: (...args) => this.attemptFence(...args),
      authorize: (...args) => this.authorize(...args),
      bound: (...args) => this.bound(...args),
      claim: () => this.binding,
      clearSessionTaskReports: (...args) => this.clearSessionTaskReports(...args),
      configurations: this.configurations,
      configureAgentForSession: (...args) => this.configureAgentForSession(...args),
      emit: (...args) => this.emit(...args),
      events: this.events,
      exitedDriverGenerations: this.exitedDriverGenerations,
      factory: this.factory,
      fence: (...args) => this.fence(...args),
      flushInsightSources: (...args) => this.flushInsightSources(...args),
      humanWaits: this.humanWaits,
      localResources: this.localResources,
      noteAgentFailure: (...args) => this.noteAgentFailure(...args),
      notifyDriverExit: (...args) => this.notifyDriverExit(...args),
      options,
      patchSession: (...args) => this.patchSession(...args),
      publicTask: (...args) => this.publicTask(...args),
      persistTerminalReceipt: (session, driver) => this.recovery.persistTerminalReceipt(session, driver),
      repos,
      scheduler: this.scheduler,
      sessionGenerations: this.sessionGenerations,
      shuttingDown: () => this.shuttingDown,
      subscribeInsightSources: (session, driver, generation, resourceId) => this.subscribeInsightSources(session, driver, generation, resourceId),
      supervisor: this.supervisor,
      turnProgressAt: this.turnProgressAt,
      unsubscribeInsightSources: (...args) => this.unsubscribeInsightSources(...args),
      wake: (...args) => this.wake(...args),
      warnCaught: (...args) => this.warnCaught(...args),
    });
    this.recovery = new RecoveryService(this.mutations, {
      adoptDriver: (id, driver) => this.supervisor.adopt(id, driver), clearRecoveredStop: id => this.supervisor.clearRecoveredStop(id),
      factory: (...args) => this.factory(...args), workspaces: this.workspaces, humanWaits: this.humanWaits,
      sessionGenerations: this.sessionGenerations, attachedTerminals: this.attachedTerminals,
      hasDrain: id => this.mutations.drains.has(id), hasActiveTurn: id => this.activeTurns.has(id),
      onDriverEvent: (...args) => this.events.onDriverEvent(...args),
      subscribeInsightSources: (session, driver, generation, resourceId) =>
        this.subscribeInsightSources(session, driver, generation, resourceId),
      flushInsightSources: driver => this.flushInsightSources(driver),
      unsubscribeInsightSources: driver => this.unsubscribeInsightSources(driver),
      acceptedOptions: task => this.acceptedInput(task).executionOptions,
      runRecoveredTurn: turn => this.runner.runRecoveredTurn(turn),
      repos, options, gate: this.gate, localResources: this.localResources, configurations: this.configurations,
      drivers: this.supervisor.drivers, queueBlocked: this.scheduler.queueBlocked, runtimeInstanceId: this.runtimeInstanceId,
      claim: () => this.binding, driverRetiring: id => this.supervisor.retiringDrivers.has(id),
      active: (...args) => this.active(...args),
      assertReady: (...args) => this.assertReady(...args),
      assertReplaceable: (...args) => this.supervisor.assertReplaceable(...args),
      assertResources: (...args) => this.assertResources(...args),
      resourceBlockers: (...args) => this.resourceBlockers(...args),
      idleResourceChecks: (...args) => this.scheduler.idleResourceChecks(...args),
      recoveryInFlight: (...args) => this.recoveryInFlight(...args),
      bound: (...args) => this.bound(...args),
      wake: (...args) => this.wake(...args),
      fence: (...args) => this.fence(...args),
      attemptFence: (...args) => this.attemptFence(...args),
      publicTask: (...args) => this.publicTask(...args),
      emit: (...args) => this.emit(...args),
      wakeResourceQueues: (...args) => this.scheduler.wakeResourceQueues(...args),
      loadStopBlock: (...args) => this.supervisor.loadStopBlock(...args),
      retainStopBlock: (...args) => this.supervisor.retainStopBlock(...args),
      reopenQueue: (...args) => this.reopenQueue(...args),
      nextSessionGeneration: (...args) => this.supervisor.nextSessionGeneration(...args),
      notifyDriverExit: (...args) => this.notifyDriverExit(...args),
      stopDriver: (...args) => this.supervisor.stopDriver(...args),
      revokeSession: (...args) => this.supervisor.revokeSession(...args),
      authorize: (...args) => this.authorize(...args),
      configureAgentForSession: (...args) => this.configureAgentForSession(...args),
      saveState: (...args) => this.saveState(...args),
      reconnect: (...args) => this.supervisor.reconnect(...args),
      driverOperation: (...args) => this.supervisor.driverOperation(...args),
      patchSession: (...args) => this.patchSession(...args),
      warnCaught: (...args) => this.warnCaught(...args),
    });
    this.maintenance = new Maintenance(this.mutations, {
      reclaimIdleDrivers: at => this.supervisor.reclaimIdleDrivers(at),
      recoveryActor: recoveryOwner, repos, options, drivers: this.supervisor.drivers, notices: this.notices, gate: this.gate,
      shuttingDown: () => this.shuttingDown,
      recoveryInFlight: (...args) => this.recoveryInFlight(...args),
      queuedTasks: (...args) => this.scheduler.queuedTasks(...args),
      active: (...args) => this.active(...args),
      observeAbandonedResources: (...args) => this.recovery.observeAbandonedResources(...args),
      retireDetachedPty: (...args) => this.recovery.retireDetachedPty(...args),
      clearVerifiedStopBlock: (...args) => this.recovery.clearVerifiedStopBlock(...args),
      inspectExecutionRecovery: (...args) => this.inspectExecutionRecovery(...args),
      confirmExecutionRecovery: (...args) => this.confirmExecutionRecovery(...args),
    });
    this.steering = new SteeringService(this.mutations, {
      acceptedInput: (...args) => this.acceptedInput(...args),
      active: (...args) => this.active(...args),
      actor: (...args) => this.actor(...args),
      applyQueueActions: (...args) => this.scheduler.applyQueueActions(...args),
      assertReady: (...args) => this.assertReady(...args),
      authorize: (...args) => this.authorize(...args),
      bound: (...args) => this.bound(...args),
      driverOperation: (...args) => this.supervisor.driverOperation(...args),
      emit: (...args) => this.emit(...args),
      eventScope: this.eventScope,
      fence: (...args) => this.fence(...args),
      hasBinding: () => !!this.binding,
      idleResourceChecks: (...args) => this.scheduler.idleResourceChecks(...args),
      inspectRecovery: (id, actor) => this.inspectExecutionRecovery(id, actor),
      isQueueHeld: (...args) => this.isQueueHeld(...args),
      logTaskRejection: (...args) => this.logTaskRejection(...args),
      options,
      projectQueue: (...args) => this.scheduler.projectQueue(...args),
      publicTask: (...args) => this.publicTask(...args),
      unblockQueue: id => this.scheduler.unblockQueue(id),
      recordPrompt: (...args) => this.runner.recordPrompt(...args),
      recoveryInFlight: (...args) => this.recoveryInFlight(...args),
      reopenQueue: (...args) => this.reopenQueue(...args),
      repos,
      requireRecoveryOwner: actor => this.recovery.requireRecoveryOwner(actor),
      scheduleQueue: (...args) => this.scheduler.scheduleQueue(...args),
      turnOutput: (...args) => this.events.turnOutput(...args),
      wake: (...args) => this.wake(...args),
      wakeResourceQueues: (...args) => this.scheduler.wakeResourceQueues(...args),
      warnTaskRejection: (...args) => this.warnTaskRejection(...args),
    });
    this.maintenance.startTimer(interval, () => this.initialized && !this.shuttingDown, () => this.cleanupIdleDrivers());
  }

  private bound() { this.assertBinding(); return this.execution!; }
  private wake<T extends CommitResult>(result: T): T { this.publisher.wake(result.session.id); this.scheduler.wakeResourceQueues(); return result; }
  private fence(session: Session): SessionFence { return { sessionId: session.id, runId: session.runId }; }
  private attemptFence(ref: AttemptRef & SessionFence): AttemptFence {
    const attempt = this.repos.execution.getAttempt(ref);
    if (!attempt || attempt.runId !== ref.runId) throw new RuntimeError('ATTEMPT_NOT_FOUND', 'The captured execution attempt no longer exists', 409);
    return { sessionId: ref.sessionId, runId: ref.runId, taskId: ref.taskId, attemptId: ref.attemptId, expectedRevision: attempt.revision };
  }
  private currentRef(id: string): (AttemptRef & SessionFence) | SessionFence | undefined {
    const token = this.mutations.current();
    const ref = token && this.mutations.attemptRefs.get(token);
    const event = this.eventScope.getStore();
    return event?.sessionId === id ? event : (ref?.sessionId === id ? ref : undefined);
  }
  private resourceBlockers(id: string, reuseOwned = false) {
    const reusable = reuseOwned ? this.localResources.reusableIds(id) : new Set<string>();
    return [...(this.recovery.isRetiringPty(id) ? [{ sessionId: id, code: 'PTY_RETIREMENT_ACTIVE' }] : []), ...this.repos.execution.getSessionResourceBlockers(id)].filter(block => !(block.code === 'DRIVER_RESOURCE_UNSAFE' && block.resourceId && reusable.has(block.resourceId)));
  }
  private assertResources(id: string, reuseOwned = false) {
    const blockers = this.resourceBlockers(id, reuseOwned);
    if (blockers.length) throw new RuntimeError('SESSION_RESOURCE_BLOCKED', blockers.map(block => block.code).join(', '), 409);
  }
  private actor(session: Session, actorId?: string): ExecutionActor {
    if (!actorId) return { kind: 'unspecified' };
    if (actorId === 'installation_owner') return { kind: 'installation_owner', id: 'installation_owner' };
    const appId = this.options.channelAppId(session);
    if (!appId) throw new RuntimeError('ACTOR_REQUIRED', 'Channel execution requires an explicit request with its App identity', 403);
    return { kind: 'channel', id: actorId, appId };
  }
  private async finalizeWorkspace(session: Session) {
    const proof = await this.mutations.wait(() => this.workspaces.proof(session.id, session.cwd));
    return this.mutations.write(session.id, async () => this.bound().finalizeSessionWorkspace(this.fence(session), proof));
  }

  private lifecycle(id: string) {
    let token = this.lifecycles.get(id);
    if (!token) { token = owner(id); this.lifecycles.set(id, token); }
    return token;
  }
  private retireTransition(id: string, reason: RevocationReason) {
    const previous = this.transitions.get(id);
    if (!previous || previous.revoked) return;
    let lifecycleOwnsParent = false;
    for (let token = this.lifecycles.get(id); token; token = token.parent) if (token === previous) { lifecycleOwnsParent = true; break; }
    const driver = this.supervisor.drivers.get(id) ?? this.gate.stops.driver(id)?.driver;
    const source = lifecycleOwnsParent ? driver?.drainExitedOutput?.() : undefined;
    if (!source) { previous.revoke(reason); return; }
    // Only the current lifecycle's parent survives, and only until this exact
    // exit drain has persisted or exhausted its budget. Other tokens stay fenced.
    void this.events.settleExitedDriver(id, driver, source).then(() => previous.revoke(reason));
  }
  private transition(id: string, reason: RevocationReason = { code: 'transition_superseded', by: 'DutydeckRuntime.transition' }) {
    this.retireTransition(id, reason);
    const token = owner(id); this.transitions.set(id, token); return token;
  }
  private ownerOf(id: string) { return owner(id, this.transitions.get(id) ?? this.transition(id)); }
  private scoped<T>(id: string, operation: () => Promise<T>) {
    return this.mutations.scoped(id, operation);
  }
  private warnTaskRejection(sessionId: string, error: unknown) {
    const log = this.options.log;
    if (!log || !(error instanceof RuntimeError) || !['OPERATION_REVOKED', 'DRIVER_STOP_UNVERIFIED'].includes(error.code)) return;
    const reason = error instanceof RevokedOperation ? error.details
      : error.code === 'DRIVER_STOP_UNVERIFIED' ? this.getDriverStopBlock(sessionId) ?? error.message : undefined;
    const key = JSON.stringify([sessionId, error.code, reason]);
    if (warnedTaskRejections.has(key)) return;
    warnedTaskRejections.add(key);
    try {
      log.warn({ sessionId, code: error.code, reason: typeof reason === 'string' ? redactCredentialText(reason) : reason }, 'Session task operation rejected');
    } catch { /* best-effort: logging cannot replace the rejection. */ }
  }
  private async logTaskRejection<T>(id: string, operation: Promise<T>): Promise<T> {
    try { return await operation; }
    catch (error) { this.warnTaskRejection(id, error); throw error; }
  }
  private warnCaught(location: string, sessionId: string | undefined, error: unknown) {
    warnCaught(this.options.log, 'DutydeckRuntime', location, sessionId, error);
  }
  private async readWorkspace<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.assertReady();
    const token = owner(id, this.workspaceReaders);
    return this.mutations.run(token, () => this.mutations.wait(operation));
  }
  private async authorize(id: string, actorId?: string, activate = false) {
    const commit = await this.mutations.wait(() => this.options.policy.authorize({ phase: 'start', sessionId: id, actorId }));
    if (activate && commit) await this.mutations.write(id, commit);
    this.mutations.check();
  }
  getDriverStopBlock(id: string) { return this.supervisor.getDriverStopBlock(id); }
  private async patchSession(id: string, patch: Partial<Session>) {
    return this.mutations.write(id, async () => {
      const current = await this.repos.sessions.get(id); this.mutations.check();
      if (!current) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
      if (patch.cwd !== undefined && patch.cwd !== current.cwd || patch.runId !== undefined && patch.runId !== current.runId) throw new RuntimeError('SESSION_EXPLICIT_COMMAND_REQUIRED', 'Workspace and run changes require explicit ledger commands', 409);
      let result = current;
      if (patch.state !== undefined || Object.hasOwn(patch, 'error')) {
        const scope = this.currentRef(id);
        const turnProgress = !!scope && isAttemptRef(scope);
        const fence = scope && isAttemptRef(scope) ? this.attemptFence(scope) : this.fence(current);
        const committed = this.bound().patchSessionState(fence, makeId('session_state'), { state: patch.state ?? current.state, ...(Object.hasOwn(patch, 'error') ? { error: patch.error ?? null } : {}) });
        // Admission never reads Session state, and turn progress follows every driver event; only a real lifecycle change retries blocked queues.
        this.publisher.wake(id);
        if (committed.events.length && !turnProgress) this.scheduler.wakeResourceQueues();
        result = committed.session;
      }
      if (patch.archivedAt !== undefined) result = this.bound().patchSession(this.fence(result), { archivedAt: patch.archivedAt });
      const config = { ...result, updatedAt: now(),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
        ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
        ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}) };
      if (['model', 'reasoningEffort', 'permissionMode', 'systemPrompt'].some(key => Object.hasOwn(patch, key))) await this.repos.sessions.save(config);
      return config;
    });
  }
  private artifact<K extends 'saveError' | 'savePermission' | 'saveToolCall'>(method: K, ...args: Parameters<RepositoryBundle['artifacts'][K]>) {
    return this.mutations.write(args[0] as string, () => (this.repos.artifacts[method] as (...values: any[]) => Promise<any>)(...args));
  }
  private assertVerificationRecoverySafe(sessionId: string) {
    const reason = this.blockedVerificationSessions.get(sessionId);
    if (reason) {
      throw new RuntimeError(
        'VERIFICATION_RECOVERY_BLOCKED',
        `Verification recovery is unresolved; restart the Dutydeck service after the process is safely reaped: ${reason}`,
        409
      );
    }
  }
  private agentForSessionProtocol(agent: AgentConfig, session: Session): AgentConfig {
    // Existing ACP sessions keep their launcher when discovery now prefers a terminal adapter.
    if (agent.builtin && agent.protocol === 'pty-cli' && session.protocol === 'acp') {
      const builtin = listAcpxBuiltinAgents().find(candidate => candidate.id === agent.id);
      if (builtin) agent = { ...agent, command: builtin.argv[0]!, args: builtin.argv.slice(1), protocol: 'acp', adapterId: undefined, capabilities: { pause: false, resume: true } };
    }
    return agent;
  }
  private async configureAgentForSession(agent: AgentConfig, session: Session): Promise<AgentConfig> {
    agent = this.agentForSessionProtocol(agent, session);
    if (this.options.launch.configureAgent) agent = await this.mutations.wait(() => this.options.launch.configureAgent!(agent, session));
    return {
      ...agent,
      cwd: session.cwd,
      model: session.model ?? agent.model,
      codexProfile: session.codexProfile ?? agent.codexProfile,
      reasoningEffort: session.reasoningEffort ?? agent.reasoningEffort,
      systemPrompt: session.systemPrompt ?? agent.systemPrompt,
      permissionMode: session.permissionMode ?? agent.permissionMode,
      // 终端模式的适配器据会话来源决定启动参数（飞书会话固定 CLI 的权限模式），只注入 pty-cli，不进 ACPX session。
      // dutydeck_session_permission_mode：任务以 deny-all（先出计划）运行时，终端仍按会话本身的模式启动 CLI。
      env: { ...agent.env, ...this.options.launch.environment?.(session), ...(session.protocol === 'pty-cli' ? { dutydeck_terminal_backend: session.terminalBackend ?? 'tmux', dutydeck_session_permission_mode: session.permissionMode ?? agent.permissionMode, ...(session.source ? { dutydeck_session_source: session.source } : {}) } : {}) }
    };
  }

  /** onAgentsRegistered：Agent 登记完、开始逐个恢复会话之前调用，只用于启动耗时日志。 */
  initialize(agents: AgentConfig[], onAgentsRegistered?: () => void) {
    if (!this.initializationRun) this.initializationRun = Promise.resolve().then(() => {
      if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
      if (this.repos.execution.authority() !== 'ledger_v1') {
        this.repos.close();
        throw new RuntimeError('EXECUTION_UPGRADE_REQUIRED', 'Run dutydeck database upgrade-execution --database <path> while this database is offline', 409);
      }
      this.binding = this.repos.control.attachRuntime(this.runtimeInstanceId);
      this.execution = this.repos.execution.bind(this.binding);
      // 复用刚建立的真实 claim 绑定 insight live 来源写入器；不再 attachRuntime。
      this.insightWriter = this.repos.insight.bindSources(this.binding);
      return this.initializationContext.run(true, () => this.mutations.run(this.initializationOwner, async () => {
        await this.initializeOnce(agents, onAgentsRegistered);
        this.mutations.check();
        this.initialized = true;
      }));
    }).catch(error => {
      this.initializationFailed = true;
      const reason = { code: 'initialization_failed', by: 'DutydeckRuntime.initialize' };
      this.initializationOwner.revoke(reason);
      this.workspaceReaders.revoke(reason);
      for (const transition of this.transitions.values()) transition.revoke(reason);
      // Recovery may already have admitted turns for earlier sessions. Capture
      // their submitted state and revoke them before rejecting initialization.
      const ids = new Set([...this.lifecycles.keys(), ...this.supervisor.drivers.keys()]);
      // The service marks persistent PTY drivers for detach before shutdown.
      // Fence facts now, but keep physical teardown behind that lifecycle boundary.
      const cleanupReady = this.shuttingDown ? Promise.resolve() : new Promise<void>(resolve => { this.releaseInitializationCleanup = resolve; });
      this.initializationCleanup = Promise.allSettled([...ids].map(id => this.supervisor.revokeSession(id, reason, false, 'stopped', true, false, cleanupReady))).then(() => {});
      throw error;
    });
    return this.initializationRun;
  }
  private async initializeOnce(agents: AgentConfig[], onAgentsRegistered?: () => void) {
    await this.ensureInsightInstanceId();
    const blockedVerifications = await this.verifications.interruptRunning();
    this.mutations.check();
    this.blockedVerificationSessions.clear();
    for (const [sessionId, error] of blockedVerifications) this.blockedVerificationSessions.set(sessionId, error);
    // Configuration is the source of truth on every boot and removes built-ins
    // that are no longer discovered from the ACPX registry, and Agents of plugins that are gone.
    const configuredIds = new Set(agents.map(agent => agent.id));
    const removed = (await this.mutations.wait(() => this.repos.agents.list())).filter(existing => (existing.builtin || existing.origin) && !configuredIds.has(existing.id));
    // A built-in terminal CLI that is replacing itself drops out of the boot scan; keep its record when the command is back.
    const swapping = new Set(removed.filter(existing => existing.builtin && existing.protocol === 'pty-cli' && !commandExists(existing.command)));
    if (swapping.size) await this.commandSwapWindow();
    for (const existing of removed) if (!swapping.has(existing) || !commandExists(existing.command)) await this.mutations.write('runtime_initialize', () => this.repos.agents.delete(existing.id));
    for (const agent of agents) await this.mutations.write('runtime_initialize', () => this.repos.agents.save(agent));
    onAgentsRegistered?.();
    for (const session of await this.mutations.wait(() => this.repos.sessions.list())) {
      try {
        await this.scoped(session.id, async () => {
          if (!await this.recovery.restoreSession(session, blockedVerifications)) return;
          let workspace = await this.mutations.wait(() => this.workspaces.get(session.id));
          if (workspace?.state === 'preparing') {
            workspace = await this.prepareWorkspace(session.id, workspace.sourceCwd, workspace.mode);
          }
          if (workspace?.state === 'ready') Object.assign(session, await this.finalizeWorkspace(session));
          await this.scheduler.projectQueue(session.id);
          if (this.scheduler.projected(session.id)?.length) this.scheduler.scheduleQueue(session.id);
        });
      } catch (error) {
        // 一个会话的工作目录不见了（比如 worktree 被删）只影响它自己：记下来、跳过它，别让整个实例起不来。
        if (this.shuttingDown || !(error instanceof RuntimeError && error.code === 'WORKSPACE_UNAVAILABLE')) throw error;
        this.options.log?.warn({ sessionId: session.id, code: error.code, error: error.message }, 'Session startup recovery skipped');
        const latest = (await this.repos.events.listRecent(session.id, 1))[0];
        const latestData = latest?.type === 'error' ? latest.data as { code?: unknown; message?: unknown } : undefined;
        if (latestData?.code === error.code && latestData.message === error.message) continue;
        await this.emit(session.id, 'error', { code: error.code, message: error.message });
      }
    }
  }
  listAgents() { return this.repos.agents.list(); }
  async listRunSummaries() {
    return this.readWorkspace('workspace_list', () => this.mutations.wait(async () => {
      if (this.repos.tasks.listRunSummaries) return this.repos.tasks.listRunSummaries();
      const summaries: import('@dutydeck/shared').RunSummary[] = [];
      for (const session of await this.repos.sessions.list()) {
        const tasks = (await this.repos.tasks.listBySession(session.id)).filter(task => task.prompt?.trim() && task.status !== 'cancelled').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const first = tasks[0];
        if (first) summaries.push({ sessionId: session.id, taskId: first.id, prompt: first.prompt.trim(), status: first.status,
          queuedCount: tasks.filter(task => task.status === 'queued').length,
          updatedAt: tasks.reduce((latest, task) => (task.updatedAt || task.createdAt) > latest ? task.updatedAt || task.createdAt : latest, first.updatedAt || first.createdAt) });
      }
      return summaries;
    }));
  }
  async listSessions() {
    return this.readWorkspace('workspace_list', async () => {
      const sessions = await this.mutations.wait(() => this.repos.sessions.list());
      const metadata = await this.mutations.wait(() => this.sessionMetadataSnapshot());
      return Promise.all(sessions.map(session => this.withSessionMetadata(session, metadata)));
    });
  }
  async getSession(id: string) { return this.readWorkspace(id, async () => { const session = await this.mutations.wait(() => this.repos.sessions.get(id)); return session ? this.withSessionMetadata(session) : undefined; }); }
  async setSessionName(id: string, rawName: string | null): Promise<Session> {
    this.assertReady();
    const normalizedName = normalizeSessionName(rawName);
    return this.mutations.write(id, async () => {
      const session = await this.repos.sessions.get(id);
      if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
      const refusal = this.kindForSource(session.source)?.renameError?.();
      if (refusal) throw refusal;
      const key = sessionNameConfigKey(id);
      await this.repos.config.set(key, normalizedName ?? '');
      return this.withSessionMetadata(session);
    });
  }
  async getWorkspace(id: string): Promise<WorkspaceResponse | undefined> {
    return this.readWorkspace(id, async () => {
      const workspace = await this.mutations.wait(() => this.workspaces.get(id));
      if (workspace?.state === 'ready') await this.mutations.wait(() => this.workspaces.validate(workspace));
      return workspace;
    });
  }
  /** Avoid preparing redundant children; the later ledger claim still owns all execution limits. */
  canPrepareWorkItemWorkspace(cwd: string): boolean {
    this.assertReady();
    return this.bound().canPrepareWorkspace(cwd, this.scheduler.idleResourceChecks());
  }
  getWorkspaceCleanupPreview(sessionId: string): Promise<WorkspaceCleanupPreview> {
    return this.readWorkspace(sessionId, () => this.workspaceCleanupPreview(sessionId));
  }
  private async workspaceCleanupPreview(sessionId: string): Promise<WorkspaceCleanupPreview> {
    const session = await this.mutations.wait(() => this.repos.sessions.get(sessionId));
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`, 404);
    this.assertResources(sessionId);
    if (!session.archivedAt) throw new RuntimeError('SESSION_NOT_ARCHIVED', '仅已归档任务可清理工作目录', 409);

    const workspace = await this.mutations.wait(() => this.workspaces.get(sessionId));
    if (!workspace) throw new RuntimeError('WORKSPACE_NOT_FOUND', `Workspace record not found for session: ${sessionId}`, 404);

    if (workspace.mode !== 'worktree') {
      return {
        sessionId,
        path: workspace.cwd,
        branch: workspace.branch,
        canClean: false,
        blockers: [{ code: 'SHARED_WORKSPACE', message: '共享工作目录不可清理' }],
        fingerprint: '',
        cleanedAt: undefined
      };
    }

    if (workspace.state === 'cleaned' || workspace.cleanedAt) {
      return {
        sessionId,
        path: workspace.repoRoot ?? workspace.cwd,
        branch: workspace.branch,
        canClean: false,
        blockers: [],
        fingerprint: '',
        cleanedAt: workspace.cleanedAt
      };
    }

    const runtimeBlockers: WorkspaceCleanupBlocker[] = [];
    await this.supervisor.loadStopBlock(sessionId);
    if (this.getDriverStopBlock(sessionId)) runtimeBlockers.push({ code: 'DRIVER_STOP_UNVERIFIED', message: this.getDriverStopBlock(sessionId)! });
    const targetRoot = await this.mutations.wait(() => realpath(workspace.repoRoot ?? workspace.cwd).catch(() => workspace.repoRoot ?? workspace.cwd));

    for (const [cleaningDir, cleaningSessionId] of this.cleaningDirs) {
      if (cleaningSessionId !== sessionId && isSameOrIntersectingPath(targetRoot, cleaningDir)) {
        runtimeBlockers.push({ code: 'WORKSPACE_BUSY', message: '工作目录正在清理中' });
      }
    }

    for (const [preparingPath, sessionSet] of this.preparingWorkspaces) {
      if (sessionSet.size > 0 && isSameOrIntersectingPath(targetRoot, preparingPath)) {
        runtimeBlockers.push({ code: 'WORKSPACE_PREPARING', message: '同工作目录正在准备启动新会话' });
        break;
      }
    }

    const intersectingSessionIds = new Set<string>([sessionId]);
    try {
      const allSessions = await this.mutations.wait(() => this.repos.sessions.list());
      for (const other of allSessions) {
        if (other.id === sessionId) continue;
        let otherDir = other.cwd;
        try {
          const otherWorkspace = await this.mutations.wait(() => this.workspaces.get(other.id, false));
          if (otherWorkspace?.repoRoot) {
            otherDir = otherWorkspace.repoRoot;
          }
        } catch (error) {
          this.warnCaught('workspaceCleanupPreview.readOtherWorkspace', other.id, error);
        }
        const otherCanonical = await this.mutations.wait(() => realpath(otherDir).catch(() => otherDir));
        if (isSameOrIntersectingPath(targetRoot, otherCanonical)) {
          intersectingSessionIds.add(other.id);
          for (const block of this.resourceBlockers(other.id)) runtimeBlockers.push({ code: block.code, message: `相交会话 ${other.id}: ${block.code}` });
          await this.supervisor.loadStopBlock(other.id);
          if (this.getDriverStopBlock(other.id)) runtimeBlockers.push({ code: 'DRIVER_STOP_UNVERIFIED', message: `相交会话 ${other.id}: ${this.getDriverStopBlock(other.id)}` });
          if (!other.archivedAt) {
            runtimeBlockers.push({ code: 'ACTIVE_SESSION_CONFLICT', message: `同工作目录存在未归档会话: ${other.id}` });
          }
          if (this.supervisor.drivers.has(other.id)) {
            runtimeBlockers.push({ code: 'SESSION_BUSY', message: `同工作目录存在活动驱动会话: ${other.id}` });
          }
          if (this.activeTurns.has(other.id) || (this.scheduler.projected(other.id)?.length ?? 0) > 0 || this.scheduler.queueRuns.has(other.id)) {
            runtimeBlockers.push({ code: 'SESSION_BUSY', message: `同工作目录存在排队或执行中的任务: ${other.id}` });
          }
          if (this.verifyingSessions.has(other.id) || this.blockedVerificationSessions.has(other.id)) {
            runtimeBlockers.push({ code: 'VERIFICATION_RUNNING', message: `同工作目录存在正在执行或未恢复的验证任务: ${other.id}` });
          }
        }
      }
    } catch (err) {
      runtimeBlockers.push({ code: 'SESSION_CHECK_FAILED', message: `检查同目录会话清单失败: ${err instanceof Error ? err.message : String(err)}` });
    }

    if (this.supervisor.drivers.has(sessionId)) {
      runtimeBlockers.push({ code: 'SESSION_BUSY', message: '当前会话仍有未断开的驱动连接' });
    }
    if (this.activeTurns.has(sessionId) || (this.scheduler.projected(sessionId)?.length ?? 0) > 0 || this.scheduler.queueRuns.has(sessionId)) {
      runtimeBlockers.push({ code: 'SESSION_BUSY', message: '当前会话仍有活跃任务' });
    }
    if (this.verifyingSessions.has(sessionId) || this.blockedVerificationSessions.has(sessionId)) {
      runtimeBlockers.push({ code: 'VERIFICATION_RUNNING', message: '当前会话存在正在执行或未恢复的验证任务' });
    }

    // 检查所有相交会话及存储中的持久 running verification；捕获任何未知/读取异常作为明确 blocker
    try {
      if (this.repos.config.list) {
        const rawVerifications = await this.mutations.wait(() => this.repos.config.list!(runtimeStateKeys.verification.prefix));
        for (const item of rawVerifications) {
          try {
            const v = JSON.parse(item.value);
            if (v.status === 'running') {
              let vDir = v.cwd;
              const vCanonical = vDir ? await this.mutations.wait(() => realpath(vDir).catch(() => vDir)) : undefined;
              if ((vCanonical && isSameOrIntersectingPath(targetRoot, vCanonical)) || intersectingSessionIds.has(v.sessionId)) {
                runtimeBlockers.push({ code: 'VERIFICATION_RUNNING', message: `工作目录存在未完成的验证任务: 会话 ${v.sessionId}` });
              }
            }
          } catch (parseErr) {
            runtimeBlockers.push({ code: 'VERIFICATION_CHECK_FAILED', message: `验证记录损坏: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}` });
          }
        }
      }
    } catch (err) {
      runtimeBlockers.push({ code: 'VERIFICATION_CHECK_FAILED', message: `读取持久化验证记录失败: ${err instanceof Error ? err.message : String(err)}` });
    }

    const safety = await this.mutations.wait(() => this.workspaces.checkSafety(workspace));
    if (safety.cleanedAt) {
      return {
        sessionId,
        path: targetRoot,
        branch: workspace.branch,
        canClean: false,
        blockers: [],
        fingerprint: '',
        cleanedAt: safety.cleanedAt
      };
    }

    const allBlockers = [...runtimeBlockers, ...safety.blockers];
    return {
      sessionId,
      path: targetRoot,
      branch: workspace.branch,
      canClean: allBlockers.length === 0,
      blockers: allBlockers,
      fingerprint: safety.fingerprint,
      cleanedAt: undefined
    };
  }

  async cleanWorkspace(sessionId: string, fingerprint: string): Promise<WorkspaceCleanupResult> {
    this.assertReady();
    const existingRun = this.cleaningRuns.get(sessionId);
    if (existingRun) return existingRun;

    const cleanupOwner = owner(sessionId);
    let targetRoot: string | undefined;
    let run!: Promise<WorkspaceCleanupResult>;
    run = this.mutations.run(cleanupOwner, () => Promise.resolve().then(async () => {
      const session = await this.mutations.wait(() => this.repos.sessions.get(sessionId));
      if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`, 404);
      if (!session.archivedAt) throw new RuntimeError('SESSION_NOT_ARCHIVED', '仅已归档任务可清理工作目录', 409);

      const workspace = await this.mutations.wait(() => this.workspaces.get(sessionId));
      if (!workspace) throw new RuntimeError('WORKSPACE_NOT_FOUND', `Workspace record not found for session: ${sessionId}`, 404);
      if (workspace.mode !== 'worktree') throw new RuntimeError('CANNOT_CLEAN_SHARED', '共享工作目录不可清理', 409);

      if (workspace.state === 'cleaned' || workspace.cleanedAt) {
        return {
          ok: true,
          sessionId,
          path: workspace.repoRoot ?? workspace.cwd,
          cleanedAt: workspace.cleanedAt!
        };
      }

      const preview = await this.workspaceCleanupPreview(sessionId);
      if (preview.cleanedAt) {
        return {
          ok: true,
          sessionId,
          path: preview.path,
          cleanedAt: preview.cleanedAt
        };
      }
      if (preview.fingerprint !== fingerprint) {
        throw new RuntimeError('WORKSPACE_FINGERPRINT_MISMATCH', '工作目录状态已变化，请重新检查', 409);
      }
      if (!preview.canClean) {
        const first = preview.blockers[0];
        throw new RuntimeError(first?.code ?? 'CANNOT_CLEAN', first?.message ?? '工作目录当前无法安全清理', 409);
      }

      targetRoot = await this.mutations.wait(() => realpath(workspace.repoRoot ?? workspace.cwd).catch(() => workspace.repoRoot ?? workspace.cwd));
      this.mutations.check();
      this.cleaningDirs.set(targetRoot, sessionId);

      const finalPreview = await this.workspaceCleanupPreview(sessionId);
      if (finalPreview.cleanedAt) {
        return {
          ok: true,
          sessionId,
          path: finalPreview.path,
          cleanedAt: finalPreview.cleanedAt
        };
      }
      if (!finalPreview.canClean || finalPreview.fingerprint !== fingerprint) {
        throw new RuntimeError('WORKSPACE_FINGERPRINT_MISMATCH', '工作目录状态已变化，请重新检查', 409);
      }

      const cleaned = await this.workspaces.removeWorktree(workspace, workspace.revision, fingerprint);
      return {
        ok: true,
        sessionId,
        path: cleaned.repoRoot ?? cleaned.cwd,
        cleanedAt: cleaned.cleanedAt!
      };
    })).finally(() => {
      cleanupOwner.revoke({ code: 'workspace_cleanup_finished', by: 'DutydeckRuntime.cleanWorkspace' });
      if (this.cleaningRuns.get(sessionId) === run && targetRoot && this.cleaningDirs.get(targetRoot) === sessionId) {
        this.cleaningDirs.delete(targetRoot);
      }
      if (this.cleaningRuns.get(sessionId) === run) {
        this.cleaningRuns.delete(sessionId);
      }
    });

    this.cleaningRuns.set(sessionId, run);
    return run;
  }
  async getVerifications(id: string): Promise<VerificationResponse[]> {
    const session = await this.repos.sessions.get(id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
    return this.verifications.list(id, session.cwd);
  }
  /** Current code fingerprint of the Session directory, computed exactly like verification records. */
  async getCodeFingerprint(id: string): Promise<string> {
    const session = await this.repos.sessions.get(id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
    return cachedRepositoryFingerprint(session.cwd);
  }

  /** 列表用：一次读出全部工作区记录与会话名，代替逐会话读取；配置仓库不支持前缀列举时返回 undefined。 */
  private async sessionMetadataSnapshot() {
    const config = this.repos.config;
    if (!config.list) return undefined;
    const [workspace, names] = await Promise.all([this.workspaces.snapshot(), config.list(SESSION_NAME_CONFIG_PREFIX)]);
    return workspace ? { workspace, names: new Map(names.map(row => [row.key, row.value])) } : undefined;
  }

  private async withSessionMetadata(session: Session, snapshot?: { workspace: (sessionId: string) => Promise<SessionWorkspace | undefined>; names: Map<string, string> }): Promise<Session> {
    const workspace = await this.mutations.wait(() => snapshot ? snapshot.workspace(session.id) : this.workspaces.get(session.id));
    const rawName = snapshot ? snapshot.names.get(sessionNameConfigKey(session.id))
      : await this.mutations.wait(() => this.repos.config.get(sessionNameConfigKey(session.id)));
    const name = rawName && rawName.trim() ? rawName.trim() : undefined;
    return {
      ...session,
      ...(workspace ? { workspaceMode: workspace.mode, workspaceSourceCwd: workspace.sourceCwd } : {}),
      ...(name ? { name } : {})
    };
  }
  /** 只读访问当前内存中的 driver 实例（如终端 WS 代理取 createTerminalStream）；未连接/已释放时返回 undefined。 */
  getDriver(sessionId: string): AgentDriver | undefined { return this.supervisor.getDriver(sessionId); }
  /** Restore an idle persistent terminal for viewing without resuming a task. */
  getTerminalDriver(id: string): Promise<AgentDriver | undefined> { return this.supervisor.getTerminalDriver(id); }
  getEvents(id: string, after = 0) { return this.repos.events.list(id, after); }
  /** Internal input for the external task-detail projection; other consumers retain the full event stream. */
  getTaskConversationEvents(id: string) { return this.repos.events.listTaskConversation?.(id) ?? this.getEvents(id); }
  /** Event count and activity times of one execution attempt of this Session, read through the attempt index. */
  async getAttemptActivity(id: string, attemptId: string): Promise<AttemptActivity> { return this.repos.execution.getAttemptActivity(id, attemptId); }
  /** Tool call and result events of one execution attempt of this Session, read through the attempt index. */
  async getAttemptToolEvents(id: string, attemptId: string): Promise<AgentEvent[]> { return this.repos.execution.getAttemptToolEvents(id, attemptId); }
  getDeferredConfirmationId(id: string, taskId: string) { return this.humanWaits.getDeferredConfirmationId(id, taskId); }
  hasPermissionRequest(id: string, nativeId: string) { return this.humanWaits.hasPermissionRequest(id, nativeId); }
  getLatestPermissionRequest(id: string, taskId: string, nativeId: string) { return this.humanWaits.getLatestPermissionRequest(id, taskId, nativeId); }
  getRecentEvents(id: string, limit: number) { return this.repos.events.listRecent(id, limit); }
  getHistoryOutline(id: string, query?: HistoryOutlineQuery) {
    if (!this.repos.events.listHistoryOutline) throw new RuntimeError('HISTORY_OUTLINE_UNSUPPORTED', 'History summaries are unavailable', 501);
    return this.repos.events.listHistoryOutline(id, query);
  }
  getHistoryTurns(id: string, from: number, through: number) {
    if (!this.repos.events.listHistoryTurns) throw new RuntimeError('HISTORY_OUTLINE_UNSUPPORTED', 'History summaries are unavailable', 501);
    return this.repos.events.listHistoryTurns(id, from, through);
  }
  getEventWindow(id: string, options?: EventWindowOptions) { return this.repos.events.listWindow(id, options); }
  async getTasks(id: string) {
    return (await this.repos.tasks.listBySession(id)).map(task => {
      const visible = this.publicTask(task);
      if (task.status === 'queued' && visible.skillDeliveries?.length && !this.originalSkillRequests(task.id)) {
        return { ...visible, canEditQueued: false as const };
      }
      return visible;
    });
  }
  getInboxTasks(id: string) { return this.repos.tasks.getInboxTasks?.(id) ?? this.getTasks(id); }
  getTaskRecovery(id: string, taskId: string) {
    return this.recovery.getTaskRecovery(id, taskId);
  }
  getSessionTaskRecovery(id: string) {
    return this.recovery.getSessionTaskRecovery(id);
  }

  /** Capture the session before asynchronous authorization; call the returned check at the final return boundary. */
  captureSessionContinuation(id: string) {
    const initial = this.repos.execution.getSessionScope(id);
    const lifecycle = this.lifecycles.get(id);
    const generation = this.sessionGenerations.get(id);
    return (expected?: { taskId?: string; attemptId?: string }): 'available' | 'ended' | 'unknown' => {
      try {
        this.assertReady();
        const current = this.repos.execution.getSessionScope(id);
        if (!initial || !current || current.runId !== initial.runId || current.archivedAt || ['stopped', 'failed'].includes(current.state)
          || this.lifecycles.get(id) !== lifecycle || lifecycle && !this.mutations.valid(lifecycle) || this.sessionGenerations.get(id) !== generation) return 'ended';
        if (!expected?.taskId) return 'available';
        const { projection, recovery } = this.recovery.readTaskRecovery(id, expected.taskId);
        if (recovery.status === 'reconcile_required' || recovery.resolvedUnknown || recovery.blockers.length) return 'unknown';
        if (recovery.status !== 'running' || projection.currentAttempt?.state === 'settled') return 'ended';
        const owner = this.getActiveTaskContext(id);
        if (!expected.attemptId || !owner?.attemptId || projection.currentAttempt?.state !== 'active') return 'unknown';
        return owner.taskId === expected.taskId && owner.attemptId === expected.attemptId && projection.currentAttempt.attemptId === expected.attemptId
          && projection.currentAttempt.runId === current.runId && this.mutations.valid(this.mutations.attempts.get(id)) ? 'available' : 'ended';
      } catch { return 'unknown'; }
    };
  }

  private async noteAgentFailure(agentId: string, failure: { code?: unknown; detailCode?: unknown; message?: unknown }) {
    const kind = agentAuthFailure(failure);
    const agent = kind && await this.repos.agents.get(agentId).catch(() => undefined);
    if (agent) this.agentUnavailable.set(agentId, { ...agentLoginProblem(agent, kind!), at: new Date().toISOString() });
  }
  /** Agent 当前的不可用标记；没有标记即可用。 */
  getAgentAvailability(agentId: string): AgentUnavailable | undefined { return this.agentUnavailable.get(agentId); }
  /**
   * 复查 Agent 是否可用：有标记时（用户重发、标记超过 5 分钟）或 force（服务启动）时跑不调模型的状态命令。
   * 确认已登录清掉标记，确认未登录记上或刷新标记，说不准保持原样；这个 Agent 没有状态命令时清掉标记，让这次真实请求当检查。
   * 返回检查后的标记。同一个 Agent 同时只跑一次。
   */
  async checkAgentAvailability(agentId: string, options: { force?: boolean } = {}): Promise<AgentUnavailable | undefined> {
    if (!options.force && !this.agentUnavailable.has(agentId)) return undefined;
    const running = this.agentChecks.get(agentId);
    if (running) return running;
    const check = (async () => {
      const agent = await this.repos.agents.get(agentId);
      const pending = agent && (this.options.launch.agentStatusCheck ?? defaultAgentStatusCheck)(agent);
      if (!agent || !pending) { this.agentUnavailable.delete(agentId); return undefined; }
      const state = await pending.catch(() => 'unknown' as const);
      if (state === 'logged_in') this.agentUnavailable.delete(agentId);
      else if (state === 'logged_out') this.agentUnavailable.set(agentId, { ...agentLoginProblem(agent, 'login'), at: new Date().toISOString() });
      return this.agentUnavailable.get(agentId);
    })().finally(() => this.agentChecks.delete(agentId));
    this.agentChecks.set(agentId, check);
    return check;
  }
  /**
   * 会话的 Agent 此刻是否停下：本进程还有这个会话的轮次在跑为 busy；驱动确认没有在途轮次为 idle；
   * 没有驱动时（比如服务重启后），执行进程都已确认退出或从没建起来也是 idle；驱动说不准、或还有没确认退出的进程（可能是还没接回的持久终端）为 unknown。
   */
  inspectAgentQuiescence(id: string): 'idle' | 'busy' | 'unknown' {
    return this.recovery.inspectAgentQuiescence(id);
  }

  private recoveryInFlight(id: string, includeQueueDrain = true) {
    return this.steering.awaitingReply(id) || this.recovery.isRetiringPty(id) || (includeQueueDrain && this.mutations.drains.has(id)) || this.mutations.attempts.has(id) || this.activeTurns.has(id) || this.supervisor.stopRuns.has(id) || this.supervisor.factoryCleanups.has(id)
      || [this.supervisor.drivers.get(id), this.gate.stops.driver(id)?.driver].some(driver => driver && this.supervisor.driverOperations.get(driver)?.size);
  }
  private async reopenQueue(id: string) {
    if (this.lifecycle(id).revoked) this.lifecycles.set(id, this.ownerOf(id));
    this.scheduler.unblockQueue(id); await this.scheduler.projectQueue(id); this.scheduler.scheduleQueue(id);
  }
  inspectExecutionRecovery(id: string, actor: ExecutionActor) {
    return this.recovery.inspectExecutionRecovery(id, actor);
  }
  probeExecutionRecovery(id: string, runId: string, actor: ExecutionActor) {
    return this.recovery.probeExecutionRecovery(id, runId, actor);
  }
  retirePtyExecution(id: string, raw: PtyRetirementRecovery, actor: ExecutionActor) {
    return this.recovery.retirePtyExecution(id, raw, actor);
  }
  confirmSteeringRecovery(id: string, raw: SteeringRecoveryDecision, actor: ExecutionActor) { return this.steering.confirmSteeringRecovery(id, raw, actor); }

  confirmExecutionRecovery(id: string, raw: ExecutionRecoveryDecision, actor: ExecutionActor) {
    return this.recovery.confirmExecutionRecovery(id, raw, actor);
  }
  settleIdleAttempt(id: string, input: { taskId: string; decisionId: string; outcome: 'unknown' | 'interrupted' | 'failed'; evidenceRefs: string[] }, actor: ExecutionActor) {
    return this.recovery.settleIdleAttempt(id, input, actor);
  }
  inspectUnknownTask(id: string, taskId: string, target?: string): Promise<UnknownTaskFacts> {
    return this.recovery.inspectUnknownTask(id, taskId, target);
  }
  resolveUnknownTask(id: string, raw: UnknownTaskResolution, actor: ExecutionActor) {
    return this.recovery.resolveUnknownTask(id, raw, actor);
  }

  async runVerification(id: string, input: VerificationCommandInput, actorId?: string): Promise<VerificationResponse> {
    return this.scoped(id, async () => {
    this.assertVerificationRecoverySafe(id);
    if (this.verifyingSessions.has(id)) throw new RuntimeError('VERIFICATION_IN_PROGRESS', 'Verification is already running', 409);
    this.verifyingSessions.add(id);
    const deferredTasks = new Set<string>();
    this.verificationDeferredTasks.set(id, deferredTasks);
    try {
      const { session } = await this.active(id);
      if (['stopped', 'failed'].includes(session.state)) throw new RuntimeError('INVALID_STATE', `Cannot verify while session is ${session.state}`, 409);
      await this.authorize(id, actorId);
      const persistedTasks = await this.mutations.wait(() => this.repos.tasks.listBySession(id));
      const eligibleTasks = persistedTasks.filter(task => !deferredTasks.has(task.id));
      const preexistingQueue = (this.scheduler.projected(id) ?? []).some(task => !deferredTasks.has(task.id));
      if (this.activeTurns.has(id) || this.scheduler.queueRuns.has(id) || preexistingQueue
        || eligibleTasks.some(task => task.status === 'running' || task.status === 'queued')) {
        throw new RuntimeError('SESSION_BUSY', 'Wait for Agent execution and its queue to finish before verification', 409);
      }
      await this.assertVerificationAdmission(session);
      const workspace = await this.mutations.wait(() => this.workspaces.get(id));
      if (workspace) await this.mutations.wait(() => this.workspaces.validate(workspace));
      const token = this.mutations.current();
      this.mutations.check();
      const result = await this.mutations.run(undefined, () => this.verifications.run(
        id, session.cwd, input, actorId, eligibleTasks.at(-1)?.id,
        () => this.mutations.run(token, () => this.authorize(id, actorId)),
        () => this.mutations.run(token, () => this.assertVerificationAdmission(session))
      ));
      // best-effort: verification is already settled before this notification.
      if (this.options.events.observed) void Promise.resolve().then(() => this.options.events.publish({ type: 'verification.completed', session, result })).catch(() => {});
      return result;
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'VERIFICATION_RECOVERY_BLOCKED') this.blockedVerificationSessions.set(id, error.message);
      throw error;
    } finally {
      if (this.verificationDeferredTasks.get(id) === deferredTasks) {
        this.verifyingSessions.delete(id); this.verificationDeferredTasks.delete(id); this.verificationHolds.delete(id);
        this.mutations.run(undefined, () => this.scheduler.scheduleQueue(id));
        // Other Sessions in this directory waited on the running record; it has settled now.
        this.scheduler.wakeResourceQueues();
      }
    }
    });
  }
  private verificationResourceBlock(id: string, own: boolean, idleChecks: ResourceCheckRef[]): string | undefined {
    if (this.gate.stops.block(id) || this.gate.stops.driver(id)) return 'DRIVER_STOP_BLOCKED';
    if (this.supervisor.stopRuns.has(id) || this.supervisor.retiringDrivers.has(id)) return 'DRIVER_OPERATION_BUSY';
    const driver = this.supervisor.drivers.get(id) ?? this.gate.stops.driver(id)?.driver;
    if (driver && this.supervisor.driverOperations.get(driver)?.size) return 'DRIVER_OPERATION_BUSY';
    const blockers = this.resourceBlockers(id, own);
    // The second admission runs after this verification's own running record
    // exists. That record is the hold being rechecked, not a competing run.
    if (own) return blockers.find(block => block.code !== 'VERIFICATION_RESOURCE_UNKNOWN')?.code;
    const resources = this.repos.execution.getResources(id);
    const proven = new Set(idleChecks.filter(check => {
      const resource = resources.find(value => value.resourceId === check.resourceId);
      const last = resource?.observations.at(-1);
      const parent = resources.find(value => value.resourceId === resource?.parentResourceId);
      return resource && resource.revision === check.expectedRevision && last?.observationId === check.observationId && last.state === 'live'
        && (resource.kind === 'local_only' || resource.kind === 'process' && parent?.stage === 'created'
          && ['lifecycle', 'strict-context-restore'].includes(parent.operationScope?.kind ?? ''));
    }).map(check => check.resourceId));
    return blockers.find(block => block.code !== 'DRIVER_RESOURCE_UNSAFE' || !block.resourceId || !proven.has(block.resourceId))?.code;
  }

  /** Verification admission follows task admission: unknown results, Agent work including native background work, and other verifications hold the directory. */
  private async assertVerificationAdmission(session: Session) {
    const root = await this.mutations.wait(() => realpath(session.cwd).catch(() => session.cwd));
    const shared: string[] = [];
    for (const other of await this.mutations.wait(() => this.repos.sessions.list())) {
      if (other.id === session.id) continue;
      const otherRoot = await this.mutations.wait(() => realpath(other.cwd).catch(() => other.cwd));
      if (isSameOrIntersectingPath(root, otherRoot)) shared.push(other.id);
    }
    // No await below: the checks and taking the hold are one step against a concurrent verification.
    if (this.repos.execution.getUnresolvedTasks(session.id).length) {
      throw new RuntimeError('SESSION_BUSY', 'The previous Agent execution result is unknown; resolve it before verification', 409);
    }
    if (this.supervisor.drivers.get(session.id)?.hasBackgroundWork?.()) {
      throw new RuntimeError('SESSION_BUSY', 'Native background work of this Session is still running; wait for it before verification', 409);
    }
    const idleChecks = this.scheduler.idleResourceChecks();
    const ownResourceBlock = this.verificationResourceBlock(session.id, true, idleChecks);
    if (ownResourceBlock) {
      throw new RuntimeError('SESSION_BUSY', `This Session has unconfirmed driver or workspace resources: ${ownResourceBlock}`, 409);
    }
    const verifying = (id: string) => new RuntimeError('SESSION_BUSY', `Another verification is running in this workspace: ${id}`, 409);
    for (const id of shared) {
      if (this.repos.execution.getUnresolvedTasks(id).length || this.supervisor.drivers.get(id)?.hasBackgroundWork?.()) {
        throw new RuntimeError('SESSION_BUSY', `Another Session is executing in this workspace: ${id}`, 409);
      }
      const resourceBlock = this.verificationResourceBlock(id, false, idleChecks);
      if (resourceBlock) {
        throw new RuntimeError('SESSION_BUSY', `Another Session has unconfirmed driver or workspace resources in this workspace: ${id}: ${resourceBlock}`, 409);
      }
      if (this.blockedVerificationSessions.has(id)) throw verifying(id);
    }
    for (const [id, held] of this.verificationHolds) if (id !== session.id && isSameOrIntersectingPath(root, held)) throw verifying(id);
    this.verificationHolds.set(session.id, root);
  }

  /** Client labels are audit metadata, never assistant output or execution transitions. */
  async recordClientAudit(sessionId: string, action: string, client: string) {
    return this.scoped(sessionId, async () => {
      if (!await this.repos.sessions.get(sessionId)) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`, 404);
      await this.repos.config.set(`client_audit/${makeId('audit')}`, JSON.stringify({ sessionId, action, client, at: new Date().toISOString() }));
    });
  }

  /** Persist descriptive out-of-band events through the same authoritative ledger. */
  async publishSessionEvent(sessionId: string, type: EventType, data: unknown, eventId?: string) {
    if (['completed', 'status', 'task'].includes(type)) throw new RuntimeError('EXECUTION_EVENT_RESERVED', 'Execution transitions require an explicit ledger command', 409);
    return this.scoped(sessionId, async () => {
    if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
    const session = await this.repos.sessions.get(sessionId);
    if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`, 404);
    if (session.archivedAt) throw new RuntimeError('SESSION_ARCHIVED', 'Archived sessions are read-only', 409);
    return this.mutations.run(undefined, () => this.emit(sessionId, type, data, undefined, eventId));
    });
  }

  private async saveState(session: Session, state: Session['state'], error?: string) {
    const patch = { state, ...(error !== undefined ? { error } : {}) };
    Object.assign(session, await this.patchSession(session.id, patch)); this.supervisor.touch(session.id);
  }
  private emit(sessionId: string, type: EventType, data: unknown, raw?: string, eventId = makeId('evt'), sourceId?: string) {
    const captured = this.currentRef(sessionId);
    return this.mutations.write(sessionId, async () => {
      const session = await this.repos.sessions.get(sessionId); this.mutations.check();
      if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session is missing', 404);
      const scope = captured ?? this.fence(session);
      if (scope.sessionId !== sessionId) throw new RuntimeError('EVENT_SESSION_MISMATCH', 'Event scope differs from its explicit Session', 409);
      const fence = isAttemptRef(scope) ? this.attemptFence(scope) : scope;
      if (fence.sessionId !== sessionId) throw new RuntimeError('EVENT_SESSION_MISMATCH', 'Event fence differs from its explicit Session', 409);
      const event = this.bound().appendEvent(fence, { id: eventId, type, data: eventJson(data), ...(raw !== undefined ? { raw } : {}), ...(sourceId ? { sourceId } : {}) });
      this.publisher.wake(sessionId); return event;
    });
  }
  private publicTask(task: TaskRecord): PublicTaskRecord {
    const { executionContext: _executionContext, queuePosition: _queuePosition, ...visible } = task;
    return { ...visible, ...(task.executionContext?.skillDeliveries?.length ? { skillDeliveries: task.executionContext.skillDeliveries } : {}) };
  }

  private executionContext(agentPrompt: string, riskPolicy?: ToolRiskPolicy, actorId?: string, skillDeliveries?: SkillDeliveryMetadata[], idleCompactHours?: number): TaskExecutionContext {
    return {
      agentPrompt,
      ...(idleCompactHours !== undefined ? { idleCompactHours } : {}),
      ...(actorId ? { actorId } : {}),
      ...(riskPolicy ? { riskPolicy } : {}),
      ...(skillDeliveries?.length ? { skillDeliveries } : {})
    };
  }

  subscribe(sessionId: string, listener: EventListener, options?: SubscribeOptions) {
    return this.publisher.subscribe(sessionId, event => this.eventScope.exit(() => this.mutations.run(undefined, () => listener(event))), options);
  }

  /**
   * 订阅某 session 的 driver 进程退出事件（终端 WS 代理等用它合成 exit 帧，替代匹配 error 事件文本）。
   * driver 工厂的 onExit 触发时 fan-out 给该 session 的所有订阅者；返回取消订阅函数。
   */
  onDriverExit(sessionId: string, callback: (code: number | null) => void): () => void {
    const listeners = this.exitListeners.get(sessionId) ?? new Set();
    listeners.add(callback);
    this.exitListeners.set(sessionId, listeners);
    return () => {
      const current = this.exitListeners.get(sessionId);
      current?.delete(callback);
      if (current && !current.size) this.exitListeners.delete(sessionId);
    };
  }
  private notifyDriverExit(sessionId: string, code: number | null) {
    for (const callback of this.exitListeners.get(sessionId) ?? []) {
      try { callback(code); } catch { /* 订阅者异常不影响 runtime 自身的退出处理 */ }
    }
  }

  async getSessionTaskReport(sessionId: string, latest?: ReadonlyArray<Pick<TaskRecord, 'id' | 'createdAt'>>) {
    try {
      const tasks = latest ?? (this.repos.tasks.listRecentBySession
        ? await this.repos.tasks.listRecentBySession(sessionId) : await this.repos.tasks.listBySession(sessionId));
      return await readSessionTaskReport(this.repos.config, sessionId, tasks);
    } catch (error) { (this.options.log ?? console).warn({ error, sessionId }, '读取会话收尾报告失败，继续处理'); }
  }

  /** 批量版 getSessionTaskReport：一次查出各会话最新一条任务引用再读收尾报告，结果与逐个调用相同；没有报告的会话不在结果里。 */
  async getSessionTaskReports(sessionIds: string[]): Promise<Map<string, TaskReport>> {
    const wanted = new Set(sessionIds);
    let latest: Map<string, Pick<TaskRecord, 'id' | 'sessionId' | 'createdAt'>> | undefined;
    if (wanted.size && this.repos.tasks.listLatestPerSession) {
      try {
        latest = new Map((await this.repos.tasks.listLatestPerSession()).filter(task => wanted.has(task.sessionId)).map(task => [task.sessionId, task]));
      } catch { latest = undefined; } // 批量查询失败时退回逐会话读取，告警语义不变。
    }
    const reports = new Map<string, TaskReport>();
    await Promise.all([...wanted].map(async sessionId => {
      const task = latest?.get(sessionId);
      const report = await this.getSessionTaskReport(sessionId, latest ? (task ? [task] : []) : undefined);
      if (report) reports.set(sessionId, report);
    }));
    return reports;
  }

  async reportCurrentTask(sessionId: string, input: TaskReportInput, expected: { taskId: string; attemptId?: string }) {
    const parsed = taskReportInputSchema.parse(input);
    return this.scoped(sessionId, async () => {
      const { session } = await this.active(sessionId);
      const current = this.getActiveTaskContext(sessionId);
      if (!current?.attemptId || current.taskId !== expected.taskId || current.attemptId !== expected.attemptId
        || (await this.getTaskRecovery(sessionId, current.taskId)).status !== 'running') {
        throw new RuntimeError('TASK_NOT_ACTIVE', '当前任务轮次已结束，不能再报告收尾状态。', 409);
      }
      await this.authorize(sessionId, current.actorId, true);
      return this.mutations.write(sessionId, async () => {
        const fresh = this.getActiveTaskContext(sessionId);
        if (fresh?.taskId !== current.taskId || fresh.attemptId !== current.attemptId
          || this.repos.execution.getTaskExecution(current.taskId)?.task.status !== 'running') {
          throw new RuntimeError('TASK_NOT_ACTIVE', '当前任务轮次已结束，不能再报告收尾状态。', 409);
        }
        return writeTaskReport(this.repos.config, { schemaVersion: 1, sessionId: session.id, taskId: current.taskId, ...parsed, reportedAt: now() });
      });
    });
  }

  private async clearSessionTaskReports(sessionId: string) {
    try {
      // The persisted reference also covers an older active turn behind queued receipts.
      const reference = await readSessionTaskReportReference(this.repos.config, sessionId);
      const recent = await this.repos.tasks.listRecentBySession?.(sessionId) ?? [];
      const active = this.activeTasks.get(sessionId)?.id;
      for (const taskId of new Set([reference, active, ...recent.map(task => task.id)])) {
        if (taskId) await clearTaskReportSafely(this.repos.config, taskId, this.options.log);
      }
    } catch (error) { (this.options.log ?? console).warn({ error, sessionId }, '读取待清理收尾报告失败，继续处理'); }
  }

  getActiveTaskContext(sessionId: string): ActiveTaskContext | undefined {
    const task = this.activeTasks.get(sessionId);
    if (!task) return undefined;
    // 当前 attempt 必须确实属于这个活跃 task；队列/旧 token 残留不能冒充当前轮。
    const owner = this.mutations.attempts.get(sessionId);
    const ref = owner ? this.mutations.attemptRefs.get(owner) : undefined;
    return {
      taskId: task.id,
      ...(ref && ref.taskId === task.id ? { attemptId: ref.attemptId } : {}),
      actorId: task.executionContext?.actorId
    };
  }

  /** Hold or release claiming of queued Tasks. Admission is unchanged; release reschedules every projected queue. */
  setQueueHeld(held: boolean) { return this.scheduler.setQueueHeld(held); }
  isQueueHeld() { return this.scheduler.isQueueHeld(); }

  /**
   * 当前一轮是否可能卡住：后面有排队任务、驱动事件与终端输出都已静默超过阈值、受管进程树 CPU 不活跃，且没有在等审批或等人回答。
   * 只是提示依据，运行时不据此中断、重跑或结束任何进程。
   */
  async getTurnStall(id: string): Promise<TurnStall | undefined> {
    const task = this.activeTasks.get(id);
    const silentMs = Date.now() - (this.turnProgressAt.get(id) ?? Date.now());
    const queued = task && silentMs >= TURN_STALL_SILENCE_MS && !this.humanWaits.pendingPermissionCount(id) && !this.humanWaits.awaitingAnswer(id)
      ? (await this.scheduler.queuedTasks(id)).length : 0;
    if (!task || !queued || this.activeTasks.get(id) !== task) { this.turnCpu.delete(id); return undefined; }
    let sampler = this.turnCpu.get(id);
    if (!sampler) { sampler = new ProcessTreeCpu(TURN_STALL_CPU_WINDOW_MS); this.turnCpu.set(id, sampler); }
    const cpu = sampler.sample(this.supervisor.drivers.get(id)?.processIds?.() ?? []);
    if (cpu === undefined || cpu === 'active' || cpu === 'unknown' && silentMs < TURN_STALL_UNKNOWN_CPU_SILENCE_MS) return undefined;
    return { taskId: task.id, silentMs, queued, cpu };
  }

  getRunningTaskCount(excludeSessionId?: string): number {
    const running = new Set<string>();
    for (const [sessionId, task] of this.activeTasks) {
      if (sessionId === excludeSessionId) continue;
      if (task.status === 'running') running.add(sessionId);
    }
    // An unanswered steering request may already be inside the agent's turn, so the restart drain waits for it too.
    for (const sessionId of this.steering.activeSessions()) if (sessionId !== excludeSessionId) running.add(sessionId);
    for (const [sessionId, driver] of this.supervisor.drivers) if (sessionId !== excludeSessionId && driver.hasBackgroundWork?.()) running.add(sessionId);
    return running.size;
  }

  /** Restart may detach only verified original turns while queue claiming stays held. */
  async getRestartActivity(excludeSessionId?: string): Promise<{ runningTasks: number; restartBlockers: number; recoverableTasks: number }> {
    const recoverable = new Map<string, () => boolean>();
    if (this.scheduler.isQueueHeld() && !this.shuttingDown) for (const [id, task] of this.activeTasks) {
      if (id === excludeSessionId || task.status !== 'running') continue;
      try {
        const session = await this.repos.sessions.get(id), driver = this.supervisor.drivers.get(id);
        const attempt = this.repos.execution.getTaskExecution(task.id)?.currentAttempt;
        const submission = attempt?.submission, recovery = submission?.recovery;
        if (!session || session.protocol !== 'pty-cli' || session.terminalBackend !== 'tmux'
          || !driver?.canRecoverTurn || !attempt || attempt.state !== 'active' || !submission || !recovery
          || task.interruptedByActor || this.acceptedInput(task).executionOptions.permissionMode !== 'full-trust') continue;
        const resource = this.recovery.recoverableResource(id, session.runId, submission.resourceRefs);
        if (!resource) continue;
        const unchanged = () => this.scheduler.isQueueHeld() && !this.shuttingDown && this.activeTasks.get(id) === task && task.status === 'running'
          && this.supervisor.drivers.get(id) === driver && !this.gate.stops.block(id) && !this.verifyingSessions.has(id)
          && !this.steering.isActive(id) && !this.humanWaits.pendingPermissionCount(id)
          && !this.humanWaits.oscWaiting(attempt.attemptId)
          && this.repos.execution.getTaskExecution(task.id)?.currentAttempt?.revision === attempt.revision
          && this.repos.execution.getResources(id).find(row => row.resourceId === resource.resourceId)?.revision === resource.revision
          && !this.bound().getPendingQueueActions(this.fence(session)).some(action => action.target?.attemptId === attempt.attemptId);
        if (!unchanged()) continue;
        const policy = this.options.policy.riskPolicy ? await this.options.policy.riskPolicy(id, task.executionContext?.riskPolicy) : task.executionContext?.riskPolicy;
        if (policy?.enabled && !policy.authorized) continue;
        if (await driver.canRecoverTurn(recovery) && unchanged()) recoverable.set(id, unchanged);
      } catch (error) { this.warnCaught('getRestartActivity.checkRecovery', id, error); }
    }
    const runningTasks = this.getRunningTaskCount(excludeSessionId);
    const recoverableTasks = [...recoverable.values()].filter(unchanged => unchanged()).length;
    return { runningTasks, restartBlockers: runningTasks - recoverableTasks, recoverableTasks };
  }

  async start(input: StartSessionInput): Promise<Session> {
    this.assertReady();
    const refusal = this.kindForSource(input?.source)?.publicStartError?.();
    if (refusal) throw refusal;
    return this.startSession(input);
  }

  private kindForSource(source: Session['source']): SessionKindSpec | undefined {
    return Object.values(this.options.sessionKinds).find((spec: SessionKindSpec) => spec.source === source);
  }

  private validateKind(spec: SessionKindSpec, id: string, input: StartSessionInput) {
    if (id.search(spec.idPattern) < 0) throw spec.invalidIdentity();
    spec.validate(undefined, input);
  }

  /** Internal orchestration entry: mapping and authority must be durable before birth. */
  async startWorkItemSession(input: StartSessionInput, stableSessionId: string, beforeStart: () => Promise<void>): Promise<Session> {
    const spec = this.options.sessionKinds.workItem;
    this.validateKind(spec, stableSessionId, input);
    return this.scoped(stableSessionId, async () => {
    await this.mutations.wait(() => beforeStart());
    const existing = await this.mutations.wait(() => this.repos.sessions.get(stableSessionId));
    if (existing) {
      spec.validate(existing, input);
      return existing;
    }
    if (this.startingWorkSessions.has(stableSessionId)) throw new RuntimeError('WORK_SESSION_STARTING', 'Work session start is already in progress', 409);
    this.startingWorkSessions.add(stableSessionId);
    try { return await this.startSession(input, { id: stableSessionId, beforeStart }); }
    finally { this.startingWorkSessions.delete(stableSessionId); }
    });
  }

  /** The caller must persist the delegation admission before creating this session. */
  private readonly backgroundStarts = new Map<string, Promise<Session>>();
  async startBackgroundSession(input: StartSessionInput, stableSessionId: string, beforeStart: () => Promise<void>): Promise<Session> {
    this.assertReady();
    const spec = this.options.sessionKinds.collaboration;
    this.validateKind(spec, stableSessionId, input);
    return this.startStable(input, stableSessionId, beforeStart, 'Background', async (existing, agent) => {
      spec.validate(existing, input, agent);
      return existing;
    }, () => this.startBackgroundSession(input, stableSessionId, beforeStart));
  }

  /**
   * Shared birth path for stable-identity sessions: reuse an existing session after `reuse` checks its frozen
   * configuration, otherwise reserve the identity in `backgroundStarts` and start it. `retry` re-enters the
   * public entry point (re-validating) after waiting for a concurrent start of the same identity.
   */
  private async startStable(input: StartSessionInput, stableSessionId: string, beforeStart: () => Promise<void>, label: string,
    reuse: (existing: Session, agent: AgentConfig) => Promise<Session>, retry: () => Promise<Session>): Promise<Session> {
    await beforeStart();
    const pending = this.backgroundStarts.get(stableSessionId);
    if (pending) { await pending; return retry(); }
    const agent = await this.repos.agents.get(input.agentId);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `${label} Agent not found`, 404);
    const existing = await this.repos.sessions.get(stableSessionId);
    if (existing) return reuse(existing, agent);
    // Recheck after the asynchronous reads before reserving the stable identity.
    const raced = this.backgroundStarts.get(stableSessionId);
    if (raced) { await raced; return retry(); }
    const start = this.startSession(input, { id: stableSessionId, beforeStart });
    this.backgroundStarts.set(stableSessionId, start);
    try { return await start; } finally { if (this.backgroundStarts.get(stableSessionId) === start) this.backgroundStarts.delete(stableSessionId); }
  }

  private probe(agent: AgentConfig) {
    return (this.options.launch.probe ?? probeAgent)(agent, this.options.launch.acpxCommand);
  }

  private sessionCapability(agent: AgentConfig, input: StartSessionInput) {
    const configured = { ...agent, ...sessionConfigOf(agent, input) };
    return { configured, capability: this.probe(configured) };
  }

  /** For a new session a missing command gets one more probe after the swap window. */
  private async newSessionCapability(agent: AgentConfig, input: StartSessionInput) {
    const result = this.sessionCapability(agent, input);
    if (result.capability.available || commandExists(result.configured.command)) return result;
    await this.commandSwapWindow();
    return commandExists(result.configured.command) ? this.sessionCapability(agent, input) : result;
  }

  /** Waits once, so a CLI that is really gone costs one swap window. */
  private commandSwapWindow() {
    return this.mutations.wait(() => new Promise<void>(resolve => setTimeout(resolve, COMMAND_SWAP_WAIT_MS)));
  }

  /** Resolve auto transport before the memory job freezes its permission posture. */
  async resolveMemorySessionInput(input: StartSessionInput): Promise<StartSessionInput & { protocol: AgentCapabilities['protocol'] }> {
    this.assertReady();
    this.options.sessionKinds.memory.validateScope(input);
    const agent = await this.repos.agents.get(input.agentId);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', 'Memory Agent not found', 404);
    const { configured, capability } = await this.newSessionCapability(agent, input);
    if (!capability.available) throw new RuntimeError('AGENT_UNAVAILABLE', capability.detail ?? 'Agent unavailable', 503);
    if (capability.protocol === 'pty') throw new RuntimeError('MEMORY_AGENT_UNSUPPORTED', 'Legacy PTY cannot enforce memory permissions', 422);
    return { ...input, protocol: capability.protocol, cwd: configured.cwd, model: configured.model, reasoningEffort: configured.reasoningEffort, permissionMode: capability.protocol === 'pty-cli' ? 'ask' : 'deny-all' };
  }

  async startMemorySession(input: StartSessionInput, stableSessionId: string, beforeStart: () => Promise<void>): Promise<Session> {
    this.assertReady();
    const spec = this.options.sessionKinds.memory;
    this.validateKind(spec, stableSessionId, input);
    return this.startStable(input, stableSessionId, beforeStart, 'Memory', async (existing, agent) => {
      const { capability } = this.sessionCapability(agent, input);
      spec.validate(existing, input, agent, capability.protocol);
      return existing;
    }, () => this.startMemorySession(input, stableSessionId, beforeStart));
  }

  /** The schedule admission and frozen configuration must be durable before session birth. */
  async startScheduleSession(input: StartSessionInput, stableSessionId: string, beforeStart: () => Promise<void>): Promise<Session> {
    this.assertReady();
    // independent 计划用受管 worktree；fresh 计划每次触发一个新会话，沿用来源会话的共享目录。
    const spec = this.options.sessionKinds.schedule;
    this.validateKind(spec, stableSessionId, input);
    return this.startStable(input, stableSessionId, beforeStart, 'Schedule', async (existing, agent) => {
      const current = await this.withSessionMetadata(existing);
      const { capability } = this.sessionCapability(agent, input);
      spec.validate(current, input, agent, capability.protocol);
      // Reusing a schedule session re-runs the admission hook against the existing identity.
      await beforeStart();
      return current;
    }, () => this.startScheduleSession(input, stableSessionId, beforeStart));
  }

  /** A persisted stopped flag alone is not evidence that a previous process stopped. */
  async stopWorkItemSession(sessionId: string, actor: ExecutionActor): Promise<boolean> {
    this.assertReady();
    const session = await this.repos.sessions.get(sessionId);
    if (session?.source !== this.options.sessionKinds.workItem.source) throw new RuntimeError('INVALID_WORK_SESSION', 'Not a work-item session', 409);
    const startupPending = this.startingWorkSessions.has(sessionId);
    await this.stop(sessionId, actor);
    if (!actor || actor.kind === 'unspecified') throw new RuntimeError('ACTOR_REQUIRED', 'Work-item cancellation requires its recorded actor', 403);
    return !startupPending && this.resourceBlockers(sessionId).length === 0;
  }

  private async prepareWorkspace(sessionId: string, sourceCwd: string, workspaceMode: WorkspaceResponse['mode'], beforePrepare?: () => Promise<void>): Promise<WorkspaceResponse> {
    const canonicalSource = await this.mutations.wait(() => realpath(sourceCwd).catch(() => sourceCwd));
    const canonicalWorkspaceRoot = await this.mutations.wait(() => realpath(this.workspaces.root).catch(() => this.workspaces.root));
    this.mutations.check();
    const canonicalTarget = workspaceMode === 'worktree' ? join(canonicalWorkspaceRoot, sessionId) : canonicalSource;
    const pathsToProtect = canonicalTarget === canonicalSource ? [canonicalSource] : [canonicalSource, canonicalTarget];

    for (const [cleaningDir] of this.cleaningDirs) {
      for (const p of pathsToProtect) {
        if (isSameOrIntersectingPath(cleaningDir, p)) {
          throw new RuntimeError('WORKSPACE_CONFLICT', '工作区目录正在清理中，无法启动会话', 409);
        }
      }
    }

    const preparationOwner = owner(sessionId, this.mutations.current());
    let preparation: Promise<WorkspaceResponse> | undefined;
    for (const p of pathsToProtect) {
      let set = this.preparingWorkspaces.get(p);
      if (!set) {
        set = new Set();
        this.preparingWorkspaces.set(p, set);
      }
      set.add(preparationOwner);
    }
    try {
      await this.mutations.wait(() => beforePrepare?.() ?? Promise.resolve());
      this.mutations.check();
      preparation = this.mutations.run(preparationOwner, () => this.workspaces.prepare(sessionId, sourceCwd, workspaceMode));
      this.workspacePreparations.add(preparation);
      return await this.mutations.wait(preparation);
    } finally {
      const release = () => {
        preparationOwner.revoke({ code: 'workspace_preparation_finished', by: 'DutydeckRuntime.prepareWorkspace' });
        if (preparation) this.workspacePreparations.delete(preparation);
        for (const p of pathsToProtect) {
          const set = this.preparingWorkspaces.get(p);
          if (set) { set.delete(preparationOwner); if (!set.size) this.preparingWorkspaces.delete(p); }
        }
      };
      if (preparation) void preparation.then(release, release); else release();
    }
  }

  private async startSession(input: StartSessionInput, owned?: { id: string; beforeStart: () => Promise<void> }): Promise<Session> {
    if (!input || typeof input !== 'object' || typeof input.agentId !== 'string' || !input.agentId.trim()) {
      throw new RuntimeError('INVALID_SESSION_INPUT', 'agentId must be a non-empty string', 400);
    }
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim())) {
      throw new RuntimeError('INVALID_WORKSPACE_SOURCE', 'cwd must be a non-empty string', 400);
    }
    if (input.workspaceMode !== undefined && !(workspaceModes as readonly unknown[]).includes(input.workspaceMode)) {
      throw new RuntimeError('INVALID_WORKSPACE_MODE', 'workspaceMode must be shared or worktree', 400);
    }
    const agent = await this.repos.agents.get(input.agentId);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${input.agentId}`, 404);
    const sourceCwd = input.cwd ?? agent.cwd ?? process.cwd();
    const { configured: initialConfigured, capability } = await this.newSessionCapability(agent, input);
    if (!capability.available) throw new RuntimeError('AGENT_UNAVAILABLE', capability.detail ?? 'Agent unavailable', 503);
    if (capability.protocol === 'pty') {
      throw new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'Legacy PTY transport cannot enforce a permission posture or expose interactive approval; use an ACP or PTY CLI Agent', 422);
    }
    if (capability.protocol === 'pty-cli' && initialConfigured.permissionMode !== 'ask' && initialConfigured.permissionMode !== 'full-trust'
      && !(initialConfigured.permissionMode === 'approve-reads' && supportsRemoteApproval({ ...initialConfigured, protocol: 'pty-cli' }))) {
      throw new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'PTY Agent only supports ask (approve in the terminal) or explicit full-trust mode; approve-reads requires a Claude Code family CLI', 422);
    }
    if (input.nativeForkSessionId && (capability.protocol !== 'pty-cli' || !supportsNativeFork(agent))) {
      throw new RuntimeError('FORK_UNSUPPORTED', 'This Agent does not support native session copying', 422);
    }
    // Decide before writing the session or workspace intent so fallback uses a single identity.
    const requestedMode = input.workspaceMode ?? 'shared';
    const workspaceMode = !owned && requestedMode === 'worktree' && input.fallbackToShared === true && await isNonGitWorkspace(sourceCwd)
      ? 'shared' : requestedMode;
    const terminalBackend = capability.protocol === 'pty-cli' ? await this.options.launch.terminalBackend?.() ?? 'tmux' : undefined;
    const session: Session = { terminalBackend, id: owned?.id ?? makeId('ses'), agentId: agent.id, state: 'created', cwd: sourceCwd, workspaceMode, model: initialConfigured.model, codexProfile: initialConfigured.codexProfile, reasoningEffort: initialConfigured.reasoningEffort, permissionMode: initialConfigured.permissionMode, source: input.source, sourceId: input.sourceId, protocol: capability.protocol, runId: makeId('run'), createdAt: now(), updatedAt: now(), systemPrompt: agent.systemPrompt };
    return this.scoped(session.id, async () => {
    await this.mutations.write(session.id, async () => this.bound().createSession(eventJson(session) as unknown as Session));

    let workspace: WorkspaceResponse;
    try {
      workspace = await this.prepareWorkspace(session.id, sourceCwd, workspaceMode, owned?.beforeStart);
      Object.assign(session, await this.finalizeWorkspace(session));
      session.workspaceSourceCwd = workspace.sourceCwd;
      await this.mutations.write(session.id, () => this.repos.artifacts.ensureLocalProject(session.cwd));

    } catch (error) {
      if (error instanceof RevokedOperation || error instanceof RuntimeError && error.code === 'WORKSPACE_CONFLICT') throw error;
      const message = errorMessage(error);
      session.state = 'failed'; session.error = message; session.updatedAt = now();
      await this.saveState(session, 'failed', message);
      await this.artifact('saveError', session.id, message);
      throw new RuntimeError('WORKSPACE_PREPARATION_FAILED', `Session ${session.id}: ${message}`, 422);
    }
    await this.mutations.wait(() => owned?.beforeStart() ?? Promise.resolve());
    await this.saveState(session, 'starting');
    try {
      await this.supervisor.reconnect(session, true, undefined, false, input.nativeForkSessionId, true);
      await this.mutations.wait(() => owned?.beforeStart() ?? Promise.resolve());
      await this.saveState(session, 'idle'); return this.withSessionMetadata(session);
    } catch (error) {
      if (error instanceof RevokedOperation) throw error;
      const message = errorMessage(error);
      const driver = this.supervisor.drivers.get(session.id);
      try { if (driver) await this.supervisor.stopDriver(session.id, driver, true); } catch (failure) { this.warnCaught('startSession.stopFailedDriver', session.id, failure); }
      await this.artifact('saveError', session.id, message);
      if (!this.resourceBlockers(session.id).length&&!this.repos.execution.getNativeContext(session.id)) Object.assign(session, await this.patchSession(session.id, { archivedAt: now() }));
      await this.saveState(session, 'failed', message);
      await this.emit(session.id, 'error', { message });
      if (error instanceof RuntimeError && error.code === 'DRIVER_UNAVAILABLE') throw error;
      throw new RuntimeError('START_FAILED', message, 503);
    }
    });
  }

  private async active(id: string) {
    if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
    const session = await this.repos.sessions.get(id);
    if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
    if (session.archivedAt) throw new RuntimeError('SESSION_ARCHIVED', 'Archived sessions are read-only', 409);
    const workspace = await this.mutations.wait(() => this.workspaces.get(id));
    this.mutations.check();
    if (workspace) { session.workspaceMode = workspace.mode; session.workspaceSourceCwd = workspace.sourceCwd; }
    if (session.archivedAt) throw new RuntimeError('SESSION_ARCHIVED', 'Archived sessions are read-only', 409);
    const driver = this.supervisor.drivers.get(id);
    return { session, driver };
  }

  probeNativeResources(id:string,actor:ExecutionActor) {
    return this.recovery.probeNativeResources(id, actor);
  }
  replaceNativeContext(id:string,actor:ExecutionActor,resourceId:string,expectedRevision:number,decisionId:string,expectedRunId?:string) {
    return this.recovery.replaceNativeContext(id, actor, resourceId, expectedRevision, decisionId, expectedRunId);
  }
  restoreNativeConfiguration(id:string,actor:ExecutionActor,expectedRunId?:string) {
    return this.recovery.restoreNativeConfiguration(id, actor, expectedRunId);
  }

  /**
   * 在真实 claim 建立后初始化一次本实例稳定 ID（configs: insight.instance_id）。
   * 只有已落库的值可采集：已有值复用；缺失才 CAS 写一次 UUID。
   * CAS 失败（并发）必须重新读取已落库值；若仍读不到则保持 undefined（安全降级，
   * 不采集来源），绝不用仅进程内 generated 冒充稳定 ID。
   */
  private async ensureInsightInstanceId(): Promise<void> {
    const existing = await this.repos.config.get(INSIGHT_INSTANCE_ID_CONFIG_KEY);
    if (existing) { this.insightInstanceId = existing; return; }
    const generated = randomUUID();
    const committed = await this.repos.config.compareAndSet?.(INSIGHT_INSTANCE_ID_CONFIG_KEY, undefined, generated);
    if (committed) { this.insightInstanceId = generated; return; }
    // 只能采信另一个 runtime 已落库的同值；读不到就不采集。
    this.insightInstanceId = (await this.repos.config.get(INSIGHT_INSTANCE_ID_CONFIG_KEY)) ?? undefined;
  }

  /**
   * 在 start/attach 前订阅 driver 的 transcript source 观察。
   * driverInstanceId 必须与 T2 anchor 严格一致（绝不新造 ID）：
   *  - controlled-v1（ACP）：lifecycle operation 行 id（context.driverInstanceId）。
   *  - local-only（PTY）：local_only 子资源行 id（context.driverInstanceId，即 resourceId）。
   *
   * 启动期（资源尚未 created / 当前 driver 尚未就绪）driver 就可能上报 launch / native
   * 观察；这些观察先进有界 pending 缓冲，driver 被采纳且资源 ready 后由
   * flushInsightSources 落库，绝不静默丢弃。换 driver / stop / 未采纳时整段缓冲随订阅取消丢弃。
   */
  private subscribeInsightSources(
    session: Session,
    driver: AgentDriver,
    generation: number,
    driverInstanceId: string
  ): void {
    if (!driver.subscribeTranscriptSource) return;
    // 同 driver 重复订阅（不应发生）时先取消旧的，避免重复回调。
    this.insightSourceSubs.get(driver)?.unsubscribe?.();
    const sub: InsightSourceSubscription = {
      sessionId: session.id,
      driverInstanceId,
      generation,
      driver,
      ready: false,
      pending: []
    };
    this.mutations.capture(sub);
    const unsubscribe = driver.subscribeTranscriptSource(observation => {
      this.acceptInsightSourceObservation(sub, observation);
    });
    sub.unsubscribe = unsubscribe;
    this.insightSourceSubs.set(driver, sub);
  }

  private unsubscribeInsightSources(driver: AgentDriver): void {
    const sub = this.insightSourceSubs.get(driver);
    if (!sub) return;
    this.insightSourceSubs.delete(driver);
    // 取消即作废启动期缓冲（未采纳 / 已换 driver / stop），杜绝迟到回调落库。
    sub.pending.length = 0;
    if (sub.unsubscribe) { try { sub.unsubscribe(); } catch { /* 取消失败不影响 stop / 结算。 */ } }
  }

  /**
   * 接收一条观察：ready 前入有界缓冲；ready 后直接异步核验并入队。
   * 不做 setTimeout 轮询——ready 由 reconnect / attach 采纳路径显式触发 flush。
   */
  private acceptInsightSourceObservation(
    sub: InsightSourceSubscription,
    raw: DriverTranscriptSourceObservation
  ): void {
    if (!sub.ready) {
      if (sub.pending.length >= INSIGHT_SOURCE_MAX_PENDING) sub.pending.shift();
      sub.pending.push(raw);
      return;
    }
    // best-effort: Insight observations are independent of task execution.
    void this.processInsightSourceObservation(sub, raw).catch(() => {});
  }

  /**
   * driver 已采纳、资源 created 后调用：标记 ready 并把启动期缓冲按序 flush。
   * 在 mutations.write 内调用（localResources.ready 同一事务之后），此时当前 run 已确定。
   */
  private flushInsightSources(driver: AgentDriver): void {
    const sub = this.insightSourceSubs.get(driver);
    if (!sub || sub.ready) return;
    sub.ready = true;
    const pending = sub.pending.splice(0);
    for (const raw of pending) this.acceptInsightSourceObservation(sub, raw);
  }

  /**
   * 单条 driver 来源观察的受控写路径（设计 3.2）：
   *  1. 回调入口的 sub 已冻结 session/driverInstance/generation/owner/driver。
   *  2. realpath(dataRoot) 等异步核验在 mutation 写队列之外完成；await 前后都复查 fence，
   *     因此跨 replace / claim revoke 的 in-flight 回调在 await 后被丢弃。
   *  3. mutations.run(owner) → mutations.write(sessionId) 内：先 await 读当前 ledger session
   *     （此读在 fence 复查之前），随后同步复查 owner/generation/当前 driver 并用当前 runId
   *     组装 observation，紧接着在无 await 的同一同步段 appendObserved；T2 在同一 BEGIN IMMEDIATE
   *     内再 validateClaim 并核对 run / 资源归属 / native identity。
   * 失败只记脱敏诊断，绝不抛出影响任务结算；不升级 driver 的 proofKind。
   */
  private async processInsightSourceObservation(
    sub: InsightSourceSubscription,
    raw: DriverTranscriptSourceObservation
  ): Promise<void> {
    try {
      // await 前的活 fence 快照；realpath 挂起期间若被 revoke / 换 driver，await 后复查即丢弃。
      if (!this.insightFenceLive(sub)) return;
      const instanceId = this.insightInstanceId;
      if (!this.binding || !this.insightWriter || !instanceId) return;
      // 异步 realpath 在写队列外；仅核准非密钥 dataRoot 元信息。
      const canonicalRoot = await canonicalizeDataRoot(raw.dataRoot);
      // await 后复查：owner / generation / 当前 driver 任一变化（replace、revoke、stop）都丢弃。
      if (!this.insightFenceLive(sub)) return;
      const keys = createTranscriptSourceKeys(
        instanceId,
        raw.client,
        canonicalRoot,
        raw.nativeSessionId ?? null,
        raw.streamIdentity
      );
      // mutations.run(owner) 建立 owner ALS scope 并包裹整个 write Promise；write 把同步事务排进
      // 该 session 的串行尾队。
      const persisted = await this.mutations.runCaptured(sub, () =>
        this.mutations.write(sub.sessionId, async () => {
          // 读当前 ledger session（fence 复查之前允许的唯一 await）：activeRunId 以提交瞬间为准，
          // 不能用回调捕获时可能已过期的 run。
          const currentSession = await this.repos.sessions.get(sub.sessionId);
          if (!currentSession) return;
          // 以下内存 fence 复查到 appendObserved 位于同一同步段，中间无 await。
          if (!this.insightFenceLive(sub)) return;
          const observation: TranscriptSourceObservation = {
            ...raw,
            dataRoot: canonicalRoot,
            sessionId: sub.sessionId,
            activeRunId: currentSession.runId,
            driverInstanceId: sub.driverInstanceId,
            ...(keys ? { sourceSessionKey: keys.sourceSessionKey, sourceKey: keys.sourceKey } : {})
          };
          // T2 在同一 BEGIN IMMEDIATE 内再 validateClaim 并核对 run / 资源归属 / native identity。
          this.insightWriter!.appendObserved(observation);
          return true;
        })
      ).catch((error: unknown) => {
        this.logInsightSourceDiagnostic(error, raw.observationId, sub.sessionId);
      });
      if (persisted && this.insightFenceLive(sub)) sub.driver.confirmTranscriptSource?.(raw.observationId);
    } catch (error) {
      this.logInsightSourceDiagnostic(error, raw.observationId, sub.sessionId);
    }
  }

  /**
   * 同步复查一条订阅的 fence 是否仍活（不访问数据库、不产生 await）：
   * 未 shutdown、owner 未 revoke、generation 未变、当前 driver 仍是订阅对象且已 ready。
   */
  private insightFenceLive(sub: InsightSourceSubscription): boolean {
    return !this.shuttingDown
      && this.mutations.validCaptured(sub)
      && this.sessionGenerations.get(sub.sessionId) === sub.generation
      && this.supervisor.drivers.get(sub.sessionId) === sub.driver;
  }

  /** 只记 requestId / observationId / 错误码级别诊断，不打印路径或 JSONL。 */
  private logInsightSourceDiagnostic(error: unknown, observationId: string, sessionId: string): void {
    const code = error instanceof RuntimeError ? error.code : 'INSIGHT_SOURCE_OBSERVE_FAILED';
    this.options.log?.warn(
      { sessionId, observationId, code },
      'session insight source observation not persisted'
    );
  }
  private acceptedInput(task: TaskRecord): AcceptedTaskInputV2 {
    // The original request is read from the accepted row, never regenerated from mutable defaults.
    const accepted = this.repos.execution.getAcceptedTask(task.id)?.input;
    if (!accepted || accepted.version !== 2) throw new RuntimeError('INPUT_OPTIONS_UNVERIFIABLE', 'This task has no frozen execution options; cancel it and send a complete new request', 409);
    return accepted;
  }

  getAcceptedTask(taskId: string) {
    this.assertReady();
    return this.repos.execution.getAcceptedTask(taskId);
  }

  lookupAcceptedTask(request: TaskRequestV1): AcceptedTask | undefined {
    this.assertReady();
    const accepted = this.repos.execution.lookupAccepted(request);
    return accepted;
  }
  async send(id: string, prompt: string, agentPrompt = prompt, riskPolicy?: ToolRiskPolicy, actorId?: string, skillRequests?: string[], request?: TaskRequestV1) {
    const task = await this.dispatch(id, prompt, 'queue', agentPrompt, riskPolicy, actorId, request?.key, skillRequests, request);
    const accepted = this.repos.execution.getAcceptedTask(task.id);
    if (accepted?.input?.version !== 2 && task.status === 'queued') throw new RuntimeError('INPUT_OPTIONS_UNVERIFIABLE', 'Queued legacy input has no frozen execution options', 409);
    return new Promise<PublicTaskRecord>((resolve, reject) => {
      let unsubscribe = () => {};
      let selectedAttemptId: string | undefined;
      let finished = false;
      const finish = (error?: unknown, value?: PublicTaskRecord) => {
        if (finished) return;
        finished = true; unsubscribe(); this.sendWaiters.delete(inspect);
        if (error) { this.warnTaskRejection(id, error); reject(error); } else resolve(value!);
      };
      const inspect = () => {
        try {
          const value = this.repos.execution.getTaskExecution(task.id);
          // The first execution remains this send's result even after an explicit retry.
          let selected = selectedAttemptId ? value?.attempts.find(attempt => attempt.attemptId === selectedAttemptId) : value?.attempts.find(attempt => attempt.number === 1);
          // Automatic capacity successors are part of this logical send;
          // explicit operator retries retain their existing result semantics.
          for (;;) {
            const successor = selected && value?.attempts.find(attempt => attempt.automaticRetry?.causeAttemptId === selected!.attemptId);
            if (!successor) break;
            selected = successor; selectedAttemptId = successor.attemptId;
          }
          selectedAttemptId ??= selected?.attemptId;
          if (value && selected && ['settled', 'reconcile_required', 'legacy_unresolved'].includes(selected.state)) {
            const status = selected.state === 'settled' && selected.outcome !== 'unknown' ? selected.outcome : 'reconcile_required';
            finish(undefined, { ...this.publicTask(value.task), currentAttemptId: selected.attemptId, status: status ?? 'reconcile_required' });
          } else if (value && !selected && (value.task.status === 'cancelled' || value.steering && value.steering.state !== 'pending' && ['completed','reconcile_required'].includes(value.task.status))) finish(undefined, this.publicTask(value.task));
          else if (this.shuttingDown) finish(new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Task remains durable for recovery', 409));
        } catch (error) { finish(error); }
      };
      this.sendWaiters.add(inspect);
      try {
        unsubscribe = this.publisher.subscribe(id, inspect);
        if (finished) unsubscribe();
        else inspect();
      } catch (error) { finish(error); }
    });
  }

  async dispatch(id: string, prompt: string, mode: 'queue' | 'interrupt' = 'queue', agentPrompt = prompt, riskPolicy?: ToolRiskPolicy, actorId?: string, idempotencyKey?: string, skillRequests?: string[], supplied?: TaskRequestV1, idleCompactHours?: number, promptParts?: PromptPart[], permissionMode?: PermissionMode) {
    this.assertReady();
    const stored = await this.repos.sessions.get(id);
    this.assertReady();
    if (!stored) throw new RuntimeError('SESSION_NOT_FOUND', 'Session is missing', 404);
    const request: TaskRequestV1 = supplied ?? { version: 1, namespace: 'runtime', sessionId: id, key: idempotencyKey ?? makeId('request'), actor: this.actor(stored, actorId), prompt, mode, skills: skillRequests ?? [], options: permissionMode ? { permissionMode } : {}, sources: [], sourcePayload: { agentPrompt, ...(riskPolicy ? { riskPolicy: JSON.parse(canonicalExecutionJson(riskPolicy)) } : {}), skills: skillRequests ?? [], ...(idleCompactHours !== undefined ? { idleCompactHours } : {}), ...(promptParts ? { promptParts: JSON.parse(canonicalExecutionJson(promptParts)) } : {}) } };
    canonicalExecutionJson(request); taskRequestV1Schema.parse(request);
    const explicitActor = actorId ?? undefined;
    const requestActor = request.actor.kind === 'unspecified' ? undefined : request.actor.id;
    if (request.sessionId !== id || request.prompt !== prompt || request.mode !== mode || idempotencyKey !== undefined && request.key !== idempotencyKey || canonicalExecutionJson(request.skills) !== canonicalExecutionJson(skillRequests ?? []) || explicitActor !== requestActor) throw new RuntimeError('TASK_REQUEST_MISMATCH', 'Explicit dispatch arguments differ from the immutable request', 409);
    return this.dispatchRequest(request, { agentPrompt, riskPolicy, idleCompactHours, promptParts });
  }

  async trackMatterSession(sessionId: string, input: import('@dutydeck/shared').MatterSessionInput) {
    try { await this.options.events.publish({ type: 'matter.session', sessionId, input }); } catch { console.warn('MATTER_LINK_FAILED'); }
  }
  getMatter(sessionId: string) { return this.options.matterSummary?.(sessionId); }

  async dispatchRequest(request: TaskRequestV1, material: TaskRequestMaterial = {}) {
    this.assertReady();
    canonicalExecutionJson(request); taskRequestV1Schema.parse(request);
    const { sessionId: id, prompt, mode } = request;
    const actorId = request.actor.kind === 'unspecified' ? undefined : request.actor.id;
    const { agentPrompt = prompt, riskPolicy, idleCompactHours, promptParts } = material;
    const stored = await this.repos.sessions.get(id);
    this.assertReady();
    if (!stored) throw new RuntimeError('SESSION_NOT_FOUND', 'Session is missing', 404);
    const existing = this.lookupAcceptedTask(request);
    if (existing) {
      try { await this.options.events.publish({ type: 'task.accepted', session: stored, task: existing.task }); } catch { console.warn('MATTER_LINK_FAILED'); }
      if (this.mutations.valid(this.lifecycle(id)) && !stored.archivedAt && stored.state !== 'stopped') {
        await this.logTaskRejection(id, this.scoped(id, async () => {
          this.scheduler.rememberQueued(existing.task); this.scheduler.unblockQueue(id);
          try { await this.scheduler.projectQueue(id); await this.scheduler.applyQueueActions(stored); }
          finally { this.scheduler.scheduleQueue(id); }
        }));
      }
      return { ...this.publicTask(existing.task), replayed: true, queuedAhead: 0 };
    }
    return this.logTaskRejection(id, this.scoped(id, async () => {
      const { session } = await this.active(id);
      // 空闲回收或启动失败后没核实进程已退出、正等后台复核：排进队列也要等复核，直接告诉调用方这个会话暂不可用。
      // 其余停止受阻（包括驱动报告退出永远无法核实的）由恢复流程（核对结果未知、终端回收）解除，解除后照常执行排队的消息，所以仍收进队列。
      const stopBlock = this.gate.stops.recheckingReason(id);
      if (stopBlock) throw new RuntimeError('DRIVER_STOP_UNVERIFIED', `这个会话的 Agent 进程还没确认已经退出，暂时不能接新消息。后台会定时复核，确认退出后自动恢复，之后重新发送即可。（${stopBlock}）`, 409);
      await this.authorize(id, actorId);
      await this.mutations.wait(() => this.options.policy.admit?.(session, request) ?? Promise.resolve());
      const agent = await this.mutations.wait(() => this.repos.agents.get(session.agentId));
      if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', 'Agent is missing', 404);
      const executionOptions: ExecutionOptions = executionOptionsOf({ permissionMode: request.options.permissionMode ?? session.permissionMode ?? agent.permissionMode,
        model: request.options.model ?? session.model ?? agent.model, reasoningEffort: request.options.reasoningEffort ?? session.reasoningEffort ?? agent.reasoningEffort });
      if (request.actor.kind === 'unspecified' && executionOptions.permissionMode === 'full-trust' && session.permissionMode !== 'full-trust') throw new RuntimeError('ACTOR_REQUIRED', 'An unspecified actor cannot enable full trust', 403);
      const payload = request.sourcePayload as { promptPolicyVersion?: unknown; promptParts?: unknown };
      const inherited = payload?.promptPolicyVersion;
      if (inherited !== undefined && inherited !== 'legacy-v1' && inherited !== 'optimized-v1') throw new RuntimeError('PROMPT_POLICY_INVALID', 'Unsupported inherited prompt policy', 409);
      const sources = promptParts ?? (Array.isArray(payload?.promptParts) ? payload.promptParts as PromptPart[] : undefined);
      const prepared = await this.mutations.wait(() => this.options.prompts.atAccept(session, request,
        { agentPrompt, inheritedVersion: inherited, promptParts: sources }, () => this.mutations.check()));
      const context: TaskExecutionContext = { ...this.executionContext(prepared.agentPrompt, riskPolicy, actorId, prepared.skillDeliveries, idleCompactHours), promptPolicyVersion: prepared.version,
        ...(prepared.promptParts ? { promptParts: prepared.promptParts } : {}), ...(prepared.promptDiagnostics ? { promptDiagnostics: { ...prepared.promptDiagnostics, ...(prepared.diagnosticReason ? { fallbackReason: prepared.diagnosticReason } : {}) } }
          : prepared.diagnosticReason ? { promptDiagnostics: { templateVersion: prepared.version, beforeChars: prepared.agentPrompt.length, afterChars: prepared.agentPrompt.length, deduplicatedParts: 0, fallbackReason: prepared.diagnosticReason, parts: [] } } : {}) };
      const content = { version: 2 as const, prompt, executionContext: context, contentSources: [], executionOptions };
      const accepted = await this.mutations.write(id, async () => {
        const committed = this.wake(this.bound().acceptTask(this.fence(session), request, { ...content, digest: digest(content) }, mode === 'interrupt' ? 'front' : 'back'));
        if (committed.task) this.scheduler.rememberQueued(committed.task);
        return committed;
      });
      if (!accepted.task) throw new RuntimeError('TASK_ACCEPTANCE_MISSING', 'The committed task is missing', 500);
      if (!accepted.replayed) await this.clearSessionTaskReports(id);
      try { await this.options.events.publish({ type: 'task.accepted', session, task: accepted.task }); } catch { console.warn('MATTER_LINK_FAILED'); }
      this.verificationDeferredTasks.get(id)?.add(accepted.task.id);
      if (!accepted.replayed && accepted.task.id !== executionTaskId(request.namespace, id, request.key)) throw new RuntimeError('TASK_ID_MISMATCH', 'Accepted task identity differs from its request', 500);
      this.scheduler.unblockQueue(id);
      try { await this.scheduler.projectQueue(id); await this.scheduler.applyQueueActions(session); }
      finally { this.scheduler.scheduleQueue(id); }
      return { ...this.publicTask(accepted.task), replayed: accepted.replayed, queuedAhead: Math.max(0, (this.scheduler.projected(id)?.length ?? 1) - 1) };
    }));
  }
  private async interruptOwnedAttempt(ref: AttemptRef & SessionFence, operationId: string) {
    const token = this.mutations.attempts.get(ref.sessionId);
    const current = this.repos.execution.getTaskExecution(ref.taskId)?.attempts.find(attempt => attempt.attemptId === ref.attemptId);
    if (!current || current.state === 'settled' || !token || this.mutations.attemptRefs.get(token)?.attemptId !== ref.attemptId) return;
    const driver = this.supervisor.drivers.get(ref.sessionId);
    if (current.submissionState !== 'not_submitted') {
      if (driver) await this.supervisor.driverOperation(driver, () => driver.interrupt());
      return;
    }
    await this.mutations.write(ref.sessionId, async () => {
      const latest = this.repos.execution.getTaskExecution(ref.taskId)?.attempts.find(attempt => attempt.attemptId === ref.attemptId);
      if (!latest || latest.state === 'settled') return;
      if (latest.submissionState !== 'not_submitted') return;
      token.revoke({ code: 'interrupted_before_submission', by: 'DutydeckRuntime.interruptOwnedAttempt' });
      if (driver) this.supervisor.holdInterruptedDriver(ref.sessionId, driver);
      this.wake(this.bound().settleAttempt(this.attemptFence(ref), `interrupt_preparing:${operationId}`, { kind: 'not_submitted', outcome: 'cancelled', reason: 'interrupted_before_submission' }));
    });
    if (!token.revoked) { if (driver) await this.supervisor.driverOperation(driver, () => driver.interrupt()); return; }
    if (driver) await this.supervisor.stopDriver(ref.sessionId, driver);
    this.scheduler.scheduleQueue(ref.sessionId);
  }
  private originalSkillRequests(taskId: string): string[] | undefined {
    try { return this.repos.execution.getAcceptedTask(taskId)?.request?.skills; }
    catch (error) { this.options.log?.warn({ error, taskId }, 'Could not read original Skill requests'); }
  }

  async cancelQueued(id: string, taskId: string, actorId?: string, expectedRevision?: number, decisionId = makeId('cancel')) {
    this.assertReady();
    // Cancelling unsubmitted input remains safe even after a failed stop revoked
    // the driver's lifecycle. The durable session fence and actor still apply.
    return this.mutations.run(owner(id), async () => {
      const { session } = await this.active(id);
      await this.authorize(id, actorId);
      const committed = await this.mutations.write(id, async () => {
        const task = this.repos.execution.getTaskExecution(taskId)?.task;
        if (!task) throw new RuntimeError('QUEUED_TASK_NOT_FOUND', 'Queued task is missing', 404);
        // The agent may already hold this content; cancelling now would contradict what it does with it.
        if (this.steering.pendingTask(id) === taskId) throw new RuntimeError('STEERING_IN_PROGRESS', 'The queued task is being steered into the running turn', 409);
        return this.wake(this.bound().cancelQueued(this.fence(session), taskId, expectedRevision ?? task.revision, { decisionId, actor: this.actor(session, actorId), action: 'cancel', evidenceRefs: ['runtime:queue-cancel'], resourceChecks: [] }));
      });
      await this.scheduler.removeCancelled(id, taskId);
      const task = this.publicTask(committed.task!);
      const skillRequests = this.originalSkillRequests(task.id);
      if (skillRequests?.length) return { ...task, skillRequests };
      if (!skillRequests && task.skillDeliveries?.length) return { ...task, canEditQueued: false as const };
      return task;
    });
  }
  steerQueued(id: string, taskId: string, actorId?: string, expectedRevision?: number, operationId = makeId('promote')) { return this.steering.steerQueued(id, taskId, actorId, expectedRevision, operationId); }
  /** 插话：先持久记录投递意图；没有明确回执时禁止普通队列重发。 */
  injectQueued(id: string, taskId: string, actorId?: string, operationId = makeId('steering'), expectedTarget?: { taskId: string; attemptId?: string }): Promise<SteeringResult> { return this.steering.injectQueued(id, taskId, actorId, operationId, expectedTarget); }
  /** Persist the confirmation handoff before returning it; ACK later cancels only this original turn. */
  deferTurn(id: string, expectedTaskId: string, askId: string, stop: boolean, expectedAttemptId: string) { return this.steering.deferTurn(id, expectedTaskId, askId, stop, expectedAttemptId); }
  async interrupt(id: string, expectedTaskId?: string, actorId?: string, operationId = makeId('interrupt')) {
    return this.scoped(id, async () => {
      const { session } = await this.active(id);
      const token = this.mutations.attempts.get(id), ref = token && this.mutations.attemptRefs.get(token);
      if (!ref) return { interrupted: false, reason: 'no_active_attempt', state: 'idle' as const };
      if (expectedTaskId && expectedTaskId !== ref.taskId) throw new RuntimeError('TASK_NOT_ACTIVE', 'The requested task is no longer active', 409);
      await this.mutations.write(id, async () => this.wake(this.bound().recordInterruptIntent(this.attemptFence(ref), { operationId, actor: this.actor(session, actorId) })));
      if (this.mutations.attempts.get(id) === token) await this.interruptOwnedAttempt(ref, operationId);
      await clearTaskReportSafely(this.repos.config, ref.taskId);
      const attempt = this.repos.execution.getTaskExecution(ref.taskId)?.attempts.find(attempt => attempt.attemptId === ref.attemptId);
      return { interrupted: true, state: attempt?.state === 'settled' && attempt.outcome !== 'unknown' ? 'interrupted' as const : 'interrupting' as const };
    });
  }
  async setRiskPolicy(id: string, policy?: ToolRiskPolicy) {
    return this.scoped(id, async () => {
    const { session, driver } = await this.active(id);
    await this.runner.applyRiskPolicy(session, driver, policy);
    });
  }
  async setModel(id: string, model: string) {
    return this.scoped(id, async () => {
    const normalized = model.trim();
    if (!normalized) throw new RuntimeError('INVALID_MODEL', 'Model must not be empty', 400);
    const { session } = await this.active(id);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response before switching models', 409);
    const driver = await this.supervisor.reconnect(session);
    if (!driver.setModel) throw new RuntimeError('MODEL_SWITCH_UNSUPPORTED', `Agent ${session.agentId} does not support runtime model switching`, 422);
    try { await this.runner.changeDriverConfiguration(session, driver, current => ({ ...current, model: normalized }), { model: normalized }); }
    catch (error) { throw switchRejection(error) ?? new RuntimeError('MODEL_SWITCH_FAILED', errorMessage(error), 422); }
    await this.emit(id, 'status', { state: session.state, model: normalized });
    return this.withSessionMetadata(session);
    });
  }
  async setReasoningEffort(id: string, reasoningEffort: string) {
    return this.scoped(id, async () => {
    const normalized = reasoningEffort.trim();
    if (!normalized) throw new RuntimeError('INVALID_REASONING_EFFORT', 'Reasoning effort must not be empty', 400);
    const { session } = await this.active(id);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response before changing reasoning effort', 409);
    const driver = await this.supervisor.reconnect(session);
    if (!driver.setReasoningEffort) throw new RuntimeError('REASONING_SWITCH_UNSUPPORTED', `Agent ${session.agentId} does not support runtime reasoning effort switching`, 422);
    try { await this.runner.changeDriverConfiguration(session, driver, current => ({ ...current, reasoningEffort: normalized }), { reasoningEffort: normalized }); }
    catch (error) { throw switchRejection(error) ?? new RuntimeError('REASONING_SWITCH_FAILED', errorMessage(error), 422); }
    await this.emit(id, 'status', { state: session.state, reasoningEffort: normalized });
    return this.withSessionMetadata(session);
    });
  }
  async pause(id: string, actorId?: string) {
    return this.scoped(id, async () => {
      const { session } = await this.active(id);
      const agent = await this.mutations.wait(() => this.repos.agents.get(session.agentId));
      if (!agent || !this.agentForSessionProtocol(agent, session).capabilities.pause) throw new RuntimeError('UNSUPPORTED_CAPABILITY', 'Agent does not support pause', 422);
      this.mutations.check();
      return this.interrupt(id, undefined, actorId);
    });
  }
  async resume(id: string) {
    this.assertReady();
    if (this.lifecycle(id).revoked) {
      this.mutations.run(undefined, () => this.supervisor.assertReplaceable(id));
      const transition = this.transition(id);
      this.lifecycles.set(id, owner(id, transition));
    }
    return this.scoped(id, async () => {
      const { session } = await this.active(id);
      const agent = await this.mutations.wait(() => this.repos.agents.get(session.agentId));
      if (!agent || !this.agentForSessionProtocol(agent, session).capabilities.resume) throw new RuntimeError('UNSUPPORTED_CAPABILITY', 'Agent does not support resume', 422);
      await this.mutations.wait(() => this.configurations.assertClear(id));
      await this.saveState(session, 'starting');
      const driver = await this.supervisor.reconnect(session, false);
      const owned=this.localResources.get(driver),token=this.mutations.current();
      await this.supervisor.driverOperation(driver, async () => {
        const operation=owned?.controlled?.beginResume(()=>this.mutations.valid(token));
        try { await driver.resume(operation); }
        finally { if(operation)owned!.controlled!.endPreparation(operation); }
      });
      this.localResources.ready(driver);
      await this.recovery.persistTerminalReceipt(session, driver);
      // resume 复用既有 native 资源，ready 后 flush 启动期 pending 观察。
      this.flushInsightSources(driver);
      const target=owned?.options;
      if(owned?.controlled&&target&&driver.nativeConfiguration){owned.options={permissionMode:target.permissionMode,...driver.nativeConfiguration()};await this.runner.changeDriverConfiguration(session,driver,()=>target,undefined,true);}
      await this.saveState(session, 'idle');
      await this.scheduler.projectQueue(id); this.scheduler.unblockQueue(id); this.scheduler.scheduleQueue(id);
      return this.withSessionMetadata(session);
    });
  }
  private async stopTransition(id: string, token: Owner, reason: RevocationReason, actor?: ExecutionActor) {
    const session = await this.repos.sessions.get(id);
    this.mutations.check(token);
    await this.mutations.run(token, () => this.supervisor.loadStopBlock(id));
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
    // Validate every fallible identity check before signalling a process. A
    // rejected /new must not leave the current task stopped and its queue alive.
    if ((await this.scheduler.queuedTasks(id)).length && (!actor || actor.kind === 'unspecified')) {
      throw new RuntimeError('ACTOR_REQUIRED', 'A named actor is required to stop a session with queued tasks', 403);
    }
    if (actor && actor.kind !== 'unspecified') {
      this.bound().authorizeNativeContextControl(this.fence(session), actor);
      if (actor.kind !== 'installation_owner') {
        await this.options.policy.authorize({ phase: 'control', sessionId: id, actor, action: 'stop' });
      }
    }
    await this.supervisor.revokeSession(id, reason, true, 'stopped', false, false, undefined, actor);
    await this.clearSessionTaskReports(id);
    this.mutations.check(token);
    if (this.resourceBlockers(id).length) throw new RuntimeError('SESSION_RESOURCE_BLOCKED', '原执行进程尚未确认安全停止；请联系管理员核对，当前会话未安全结束。', 409);
  }
  async stop(id: string, actor?: ExecutionActor) {
    this.assertReady();
    const reason = { code: 'session_stop', by: 'DutydeckRuntime.stop' };
    const token = this.transition(id, reason);
    return this.stopTransition(id, token, reason, actor);
  }
  async archive(id: string, actor?: ExecutionActor) {
    this.assertReady();
    const reason = { code: 'archive', by: 'DutydeckRuntime.archive' };
    const token = this.transition(id, reason);
    const running = this.mutations.attempts.get(id);
    const ref = running && this.mutations.attemptRefs.get(running);
    await this.stopTransition(id, token, reason, actor);
    const session = await this.mutations.run(token, async () => {
      const attempt = ref && this.repos.execution.getTaskExecution(ref.taskId)?.currentAttempt;
      // A verified stop ends execution, not proof of its external effects. Record
      // the owner's abandonment of this turn while retaining its unknown result.
      if (ref && attempt?.attemptId === ref.attemptId && attempt.state === 'reconcile_required') {
        if (!actor) throw new RuntimeError('RECOVERY_OWNER_REQUIRED', 'Installation owner authorization is required', 403);
        this.recovery.requireRecoveryOwner(actor);
        if (this.recoveryInFlight(id)) throw new RuntimeError('RECOVERY_EXECUTION_ACTIVE', 'Original execution still has an in-flight owner', 409);
        const recovery = await this.inspectExecutionRecovery(id, actor);
        this.mutations.check(token);
        await this.mutations.write(id, async () => {
          const decisionId = makeId('archive');
          this.wake(this.bound().confirmAttemptRecovery({ ...ref, expectedRevision: attempt.revision }, `archive:${decisionId}`, {
            kind: 'manual', outcome: 'unknown', decision: { decisionId, actor, action: 'confirm_result',
              evidenceRefs: ['session_archive_after_verified_stop'], resourceChecks: recovery.resourceChecks }
          }));
        });
        await this.saveState((await this.repos.sessions.get(id))!, 'stopped');
      }
      return this.patchSession(id, { archivedAt: now() });
    });
    return this.withSessionMetadata(session);
  }
  async restart(id: string, actor?: ExecutionActor) {
    this.assertReady();
    this.assertVerificationRecoverySafe(id);
    const reason = { code: 'restart', by: 'DutydeckRuntime.restart' };
    const transition = this.transition(id, reason);
    await this.stopTransition(id, transition, reason, actor);
    this.mutations.check(transition);
    this.lifecycles.get(id)?.revoke(reason);
    const token = owner(id, transition); this.lifecycles.set(id, token);
    return this.mutations.run(token, async () => {
      const { session } = await this.active(id);
      await this.mutations.wait(() => this.configurations.assertClear(id));
      this.supervisor.assertReplaceable(id);
      const workspace = await this.mutations.wait(() => this.workspaces.get(id));
      if (workspace) {
        await this.prepareWorkspace(id, workspace.sourceCwd, workspace.mode);
        Object.assign(session, await this.finalizeWorkspace(session));
      }
      const resources = this.repos.execution.getResources(id).filter(resource => resource.kind !== 'operation' && resource.purpose !== 'acp_native_context' && resource.stage !== 'not_created');
      Object.assign(session, this.bound().replaceSessionRun(this.fence(session), makeId('run'), resources.map(resource => ({ resourceId: resource.resourceId, expectedRevision: resource.revision, observationId: resource.observations.at(-1)!.observationId }))));
      await this.supervisor.reconnect(session);
      await this.saveState(session, 'idle'); return this.withSessionMetadata(session);
    });
  }
  async setPermissionMode(id: string, mode: PermissionMode) {
    return this.scoped(id, async () => {
    const { session, driver } = await this.active(id);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response before switching permissions', 409);
    // 已启动驱动不支持热切换时，不得只改数据库却让子进程继续沿用
    // 旧 argv；未连接会话可以先持久化，下次 reconnect 会按新姿态启动。
    // 终端驱动的 setPermissionMode 只服务任务级的先出计划，不能换掉已启动 CLI 的会话姿态。
    if (driver && (!driver.setPermissionMode || session.protocol === 'pty-cli')) throw new RuntimeError('PERMISSION_MODE_SWITCH_UNSUPPORTED', `Agent ${session.agentId} does not support runtime permission switching`, 422);
    if (driver) await this.runner.changeDriverConfiguration(session, driver, current => ({ ...current, permissionMode: mode }), { permissionMode: mode });
    else await this.mutations.write(id, async () => { await this.configurations.assertClear(id); Object.assign(session, await this.patchSession(id, { permissionMode: mode })); });
    return this.withSessionMetadata(session);
    });
  }
  autoApproveAgentCommand(sessionId: string, kind: string, command: string): Promise<boolean> {
    return this.humanWaits.autoApproveAgentCommand(sessionId, kind, command);
  }
  requestDriverPermission(sessionId: string, request: Omit<PermissionRequestData, 'id' | 'status'>) {
    return this.humanWaits.requestDriverPermission(sessionId, request);
  }
  getPendingPermissions(sessionId: string): PermissionRequestData[] {
    return this.humanWaits.getPendingPermissions(sessionId);
  }
  resolvePermission(sessionId: string, permissionId: string, approved: boolean, reason?: string, annotation?: Pick<PermissionRequestData, 'workspaceRule' | 'handledBy'>) {
    return this.humanWaits.resolvePermission(sessionId, permissionId, approved, reason, annotation);
  }

  async cleanupIdleDrivers(at = Date.now()) {
    this.assertReady();
    return this.maintenance.cleanupIdleDrivers(at);
  }

  shutdown(): Promise<void> {
    if (!this.shutdownRun) this.shutdownRun = this.shutdownOnce();
    return this.shutdownRun;
  }
  private async shutdownOnce() {
    // Admission closes below, but a current driver's already observed exit may
    // still finish its exact task/attempt persistence before that fence applies.
    for (const [id, driver] of this.supervisor.drivers) if (driver.drainExitedOutput?.()) this.events.settleExitedDriver(id, driver);
    this.shuttingDown = true;
    for (const inspect of [...this.sendWaiters]) inspect();
    this.releaseInitializationCleanup?.();
    const reason = { code: 'shutdown', by: 'DutydeckRuntime.shutdownOnce' };
    this.initializationOwner.revoke(reason);
    this.workspaceReaders.revoke(reason);
    this.maintenance.stopTimer();
    this.supervisor.clearStopRechecks();
    for (const id of this.transitions.keys()) this.retireTransition(id, reason);
    const ids = new Set([...this.lifecycles.keys(), ...this.supervisor.drivers.keys()]);
    try {
      for (const [id, driver] of this.supervisor.drivers) {
        if (!driver.prepareForDaemonShutdown) continue;
        const unresolved = this.repos.execution.getUnresolvedTasks(id).length > 0;
        const pendingCreation = this.repos.execution.getResources(id).some(resource => resource.kind === 'operation' && ['pending', 'unknown'].includes(resource.stage) && !resource.creationClosure);
        // Admission is closed and transitions revoked; an unclaimed queue drain cannot start a new turn.
        const preserve = this.supervisor.drivers.get(id) !== driver || this.recoveryInFlight(id, false) || this.verifyingSessions.has(id) || unresolved || pendingCreation;
        try {
          await driver.prepareForDaemonShutdown(Boolean(preserve));
          if (!preserve) {
            const session = await this.repos.sessions.get(id);
            if (session) await this.recovery.persistTerminalReceipt(session, driver);
          }
        }
        catch {
          try { await driver.prepareForDaemonShutdown(true); } catch (error) { this.warnCaught('shutdownOnce.prepareDriver', id, error); }
          await this.supervisor.retainStopBlock(id, 'Shutdown preparation failed; physical resource verification is required');
        }
      }
      await Promise.allSettled([...ids].map(id => this.supervisor.revokeSession(id, reason, false, 'stopped', true)));
      if (this.binding) await this.verifications.stop();
      await this.maintenance.currentRun;
    } finally {
      // The service may close SQLite even when shutdown rejects. No local fact
      // continuation may escape this drain on either the success or failure path.
      await Promise.allSettled([this.initializationRun]);
      await Promise.allSettled([this.initializationCleanup, this.maintenance.currentRun]);
      await Promise.allSettled([...this.runner.taskRuns, ...this.scheduler.queueRuns.values()]);
      await this.events.drainAll();
      while (this.workspacePreparations.size) await Promise.allSettled([...this.workspacePreparations]);
      while (this.cleaningRuns.size) await Promise.allSettled([...this.cleaningRuns.values()]);
      while (this.supervisor.factoryCleanups.size) await Promise.allSettled([...this.supervisor.factoryCleanups.values()]);
      await this.mutations.barrier();
      this.options.unsubscribeLegacy?.();
      await this.publisher.close();
      this.supervisor.clearDrivers(); this.scheduler.clearQueues();
      this.cleaningDirs.clear(); this.preparingWorkspaces.clear();

      this.binding?.release();
      this.binding = undefined; this.execution = undefined;
    }
  }
}
