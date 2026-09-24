import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AgentConfig, AgentDriver, AgentEvent, DriverFactory, EventType, EventWindowOptions, NormalizedDriverEvent, PermissionMode, PermissionRequestData, PublicTaskRecord, RepositoryBundle, RuntimeControlClaim, Session, SkillDeliveryMetadata, StartSessionInput, TaskExecutionContext, TaskRecord, ToolCallData, ToolRiskPolicy, VerificationCommandInput, VerificationResponse, WorkspaceCleanupBlocker, WorkspaceCleanupPreview, WorkspaceCleanupResult, WorkspaceResponse } from '@dutydeck/shared';
import { canonicalExecutionJson, ptyRetirementRecoverySchema, executionRecoveryDecisionSchema, executionActorSchema, taskRequestV1Schema, makeId, now, RuntimeError, workspaceModes } from '@dutydeck/shared';
import { AcpxAdapter, readNativeCreationRecord } from '@dutydeck/acp-client';
import { JsonlTransport, PipeTransport, probeAgent, PtyTransport, type ProbeMatrix } from '@dutydeck/transports';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { PtyRetirementRecovery, ExecutionRecoveryDecision, AcceptedTask, AcceptedTaskInputV2, AttemptFence, AttemptRef, BoundExecutionRepository, CommitResult, ExecutionActor, ResourceCheckRef, SessionFence, TaskAttempt, TaskRequestV1 } from '@dutydeck/shared';
import { executionTaskId } from '@dutydeck/storage';
import { PersistentEventPublisher, type SubscribeOptions, type EventListener } from './persistent-event-publisher.js';
import { digest, eventJson, DriverConfigurationLedger, LocalDriverLedger, type ExecutionOptions } from './ledger.js';
import { WorkspaceManager } from './workspace.js';
import { VerificationManager } from './verification.js';
import { owner, RevokedOperation, SessionMutations, type Owner } from './ownership.js';

function isSameOrIntersectingPath(a: string, b: string): boolean {
  if (a === b) return true;
  const sepWithA = a.endsWith(sep) ? a : a + sep;
  const sepWithB = b.endsWith(sep) ? b : b + sep;
  return a.startsWith(sepWithB) || b.startsWith(sepWithA);
}

const STOP_BLOCK_PREFIX = 'runtime_driver_stop_block:';
const isTaskFenceRevocation = (error: unknown): error is RuntimeError => error instanceof RuntimeError
  && (error.code === 'SESSION_AUTOMATION_TASK_REVOKED' || error.code === 'SESSION_AUTOMATION_TASK_STALE_HEAD' || error.code === 'WORK_ITEM_TASK_REVOKED');

function isAttemptRef(ref: SessionFence): ref is SessionFence & AttemptRef {
  return 'attemptId' in ref && 'taskId' in ref && typeof ref.attemptId === 'string' && typeof ref.taskId === 'string';
}

export function selectProtocol(probes: ProbeMatrix): 'acp' | 'jsonl' | 'pipe' | 'pty' {
  if (probes.acp) return 'acp';
  if (probes.jsonl) return 'jsonl';
  if (probes.pipe) return 'pipe';
  return 'pty';
}

export function correlateToolCalls(events: Array<NormalizedDriverEvent | undefined>) {
  const calls = new Map<string, ToolCallData>();
  for (const event of events) {
    if (!event || (event.type !== 'tool_call' && event.type !== 'tool_result')) continue;
    const data = eventJson(event.data) as unknown as ToolCallData;
    calls.set(data.id, mergeToolCall(data, calls.get(data.id)));
  }
  return calls;
}

function mergeToolCall(data: ToolCallData, previous?: ToolCallData): ToolCallData {
  const merged = { ...previous, ...data, name: data.name ?? previous?.name ?? 'tool', startedAt: previous?.startedAt ?? data.startedAt ?? now() };
  if (data.status === 'completed' || data.status === 'failed') merged.completedAt = data.completedAt ?? previous?.completedAt ?? now();
  else delete merged.completedAt;
  return merged;
}

interface AttemptTools {
  calls: Map<string, { sequence: number; data: ToolCallData; projected: boolean }>;
  events: Map<string, { inputDigest: string; data: ToolCallData }>;
}

// 驱动契约类型统一从 @dutydeck/shared 导出（driver.ts 是跨团队冻结契约），
// 本包不再自定义 AgentDriver / DriverFactory / NormalizedDriverEvent。
export type { AgentDriver, DriverFactory, NormalizedDriverEvent };

export interface PtyRetirementControl {
  capture(session: Session): unknown;
  stop(session: Session, snapshot: unknown, beforeKill: (snapshot: unknown) => Promise<void>): Promise<unknown>;
  verify(session: Session, snapshot: unknown): boolean;
}
export interface RuntimeOptions {
  ptyRetirement?: PtyRetirementControl;

  authorizeExecution?: (sessionId: string, actorId?: string) => Promise<void | (() => Promise<void>)>;
  /** Stopping an owned resource remains permitted after its execution authority is revoked. */
  authorizeControl?: (sessionId: string, actor: ExecutionActor, action: 'stop') => Promise<void>;
  /** Revalidate the accepted task's external authority immediately before execution. */
  authorizeTask?: (session: Session, task: TaskRecord, phase: 'prepare' | 'submit') => Promise<void>;
  resolveRiskPolicy?: (sessionId: string, fallback?: ToolRiskPolicy) => Promise<ToolRiskPolicy | undefined>;
  acpxCommand?: string;
  driverFactory?: DriverFactory;
  /**
   * pty-cli 协议驱动工厂（PTY 适配器驱动栈，由 @dutydeck/pty-driver 提供）。
   * 仅在未注入自定义 driverFactory 时生效：agent.protocol === 'pty-cli' 的会话路由到它。
   * 未提供时创建 pty-cli 会话会抛 DRIVER_UNAVAILABLE。
   */
  ptyDriverFactory?: DriverFactory;
  probe?: typeof probeAgent;
  driverIdleTimeoutMs?: number;
  cleanupIntervalMs?: number;
  sessionEnvironment?: (session: Session) => Record<string, string>;
  sessionPrompt?: (session: Session, prompt: string) => string | Promise<string>;
  workspaceRoot?: string;
  prepareTaskPrompt?: (session: Session, prompt: string, skillRequests?: string[]) => Promise<{
    agentPrompt: string;
    skillDeliveries?: SkillDeliveryMetadata[];
  }>;
}

export class DutydeckRuntime {
  private readonly mutations = new SessionMutations(() => this.assertBinding());
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
  private readonly attempts = new Map<string, Owner>();
  private readonly drains = new Map<string, Owner>();
  private initializationRun?: Promise<void>;
  private initializationCleanup?: Promise<void>;
  private releaseInitializationCleanup?: () => void;
  private shutdownRun?: Promise<void>;
  private readonly transitions = new Map<string, Owner>();
  private readonly stopIntents = new Map<string, { cancelQueue: boolean; actor?: ExecutionActor }>();
  private readonly ptyRetirements = new Set<string>();
  private readonly stopRuns = new Map<string, Promise<void>>();
  private readonly stopBlocks = new Map<string, { sessionId: string; runId: string; reason: string }>();
  private readonly stopBlockVersions = new Map<string, number>();
  private readonly blockedDrivers = new Map<string, { driver: AgentDriver; reason: string }>();
  private readonly driverOperations = new Map<AgentDriver, Set<Promise<unknown>>>();
  private readonly factoryCleanups = new Map<string, Promise<void>>();
  private readonly attachedTerminals = new WeakSet<AgentDriver>();
  private execution?: BoundExecutionRepository;
  private readonly attemptRefs = new WeakMap<Owner, AttemptRef & SessionFence>();
  private readonly eventScope = new AsyncLocalStorage<AttemptRef & SessionFence | SessionFence>();
  private readonly localResources: LocalDriverLedger;
  private readonly configurations: DriverConfigurationLedger;
  private readonly publisher: PersistentEventPublisher;
  private readonly completedTurns = new Set<string>();
  private readonly attemptTools = new Map<string, AttemptTools>();
  private readonly sendWaiters = new Set<() => void>();
  private readonly queueBlocked = new Set<string>();
  private readonly drivers = new Map<string, AgentDriver>();
  private readonly activeTurns = new Set<string>();
  private readonly activeTasks = new Map<string, TaskRecord>();
  private readonly queues = new Map<string, TaskRecord[]>();
  private readonly queueRuns = new Map<string, Promise<void>>();
  private readonly permissions = new Map<string, { request: PermissionRequestData; nativeId: string; fence: AttemptRef & SessionFence; generation: number; owner?: Owner }>();
  private readonly permissionResolutions = new Map<string, string>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly driverEventChains = new Map<string, Promise<void>>();
  private readonly driverEventErrors = new Map<string, unknown>();
  private readonly driverStopReasons = new Map<string, string>();
  private readonly turnErrors = new Map<string, string>();
  private readonly exitListeners = new Map<string, Set<(code: number | null) => void>>();
  private readonly factory: DriverFactory;
  private readonly lastActivity = new Map<string, number>();
  private readonly cleanupTimer?: NodeJS.Timeout;
  private cleanupRun?: Promise<void>;
  private shuttingDown = false;
  private readonly taskRuns = new Set<Promise<unknown>>();
  private readonly workspaces: WorkspaceManager;
  private readonly verifications: VerificationManager;
  private readonly verifyingSessions = new Set<string>();
  private readonly startingWorkSessions = new Set<string>();
  private readonly verificationDeferredTasks = new Map<string, Set<string>>();
  private readonly blockedVerificationSessions = new Map<string, string>();
  private readonly cleaningDirs = new Map<string, string>();
  private readonly preparingWorkspaces = new Map<string, Set<Owner>>();
  private readonly workspacePreparations = new Set<Promise<WorkspaceResponse>>();
  private readonly workspaceReaders = owner('workspace_readers');
  private readonly cleaningRuns = new Map<string, Promise<WorkspaceCleanupResult>>();

  constructor(private readonly repos: RepositoryBundle, private readonly options: RuntimeOptions = {}) {
    this.configurations = new DriverConfigurationLedger(repos.config);
    this.localResources = new LocalDriverLedger(() => this.bound(), repos.execution);
    this.publisher = new PersistentEventPublisher({ highWaterMark: id => repos.events.highWaterMark(id), listWindow: (id, options) => repos.events.listWindow(id, options) });
    this.workspaces = new WorkspaceManager(repos.config, options.workspaceRoot, (id, commit) => {
      if (!this.mutations.current()) throw new RuntimeError('WORKSPACE_OWNER_REQUIRED', 'Workspace record writes require an explicit local owner', 500);
      return this.mutations.write(id, commit);
    });
    this.verifications = new VerificationManager(repos.config, (id, commit) => this.mutations.run(undefined, () => this.mutations.write(id, commit)));
    const ptyDriverFactory = options.ptyDriverFactory;
    this.factory = options.driverFactory ?? ((agent, protocol, onEvent, onExit, sessionId, context) => {
      if (protocol === 'acp') return new AcpxAdapter({ ...agent, env: { ...agent.env, dutydeck_session_id: sessionId } }, { sessionKey: sessionId, context, onEvent, ...(this.options.resolveRiskPolicy ? { resolveRiskPolicy: (fallback?: ToolRiskPolicy) => this.options.resolveRiskPolicy!(sessionId, fallback) } : {}) });
      if (protocol === 'pty-cli') {
        if (!ptyDriverFactory) throw new RuntimeError('DRIVER_UNAVAILABLE', 'protocol 为 pty-cli 的 agent 需要注入 ptyDriverFactory（@dutydeck/pty-driver）', 503);
        return ptyDriverFactory(agent, protocol, onEvent, onExit, sessionId, context);
      }
      if (protocol === 'pty') return new PtyTransport(agent, { onEvent, onExit });
      if (protocol === 'pipe') return new PipeTransport(agent, { onEvent, onExit, context });
      return new JsonlTransport(agent, { onEvent, onExit, context });
    });
    if (!options.driverFactory) this.factory.controlledResources = protocol => protocol === 'acp' || protocol === 'jsonl' || protocol === 'pipe';
    const interval = options.cleanupIntervalMs ?? 5 * 60_000;
    if ((options.driverIdleTimeoutMs ?? 6 * 60 * 60_000) > 0 && interval > 0) {
      this.cleanupTimer = setInterval(() => { if (this.initialized && !this.shuttingDown) void this.cleanupIdleDrivers().catch(() => {}); }, interval);
      this.cleanupTimer.unref();
    }
  }

  private bound() { this.assertBinding(); return this.execution!; }
  private wake<T extends CommitResult>(result: T): T { this.publisher.wake(result.session.id); return result; }
  private fence(session: Session): SessionFence { return { sessionId: session.id, runId: session.runId }; }
  private attemptFence(ref: AttemptRef & SessionFence): AttemptFence {
    const attempt = this.repos.execution.getTaskExecution(ref.taskId)?.attempts.find(item => item.attemptId === ref.attemptId);
    if (!attempt || attempt.runId !== ref.runId) throw new RuntimeError('ATTEMPT_NOT_FOUND', 'The captured execution attempt no longer exists', 409);
    return { sessionId: ref.sessionId, runId: ref.runId, taskId: ref.taskId, attemptId: ref.attemptId, expectedRevision: attempt.revision };
  }
  private currentRef(id: string): (AttemptRef & SessionFence) | SessionFence | undefined {
    const token = this.mutations.current();
    const ref = token && this.attemptRefs.get(token);
    const event = this.eventScope.getStore();
    return event?.sessionId === id ? event : (ref?.sessionId === id ? ref : undefined);
  }
  private resourceBlockers(id: string, reuseOwned = false) {
    const reusable = reuseOwned ? this.localResources.reusableIds(id) : new Set<string>();
    return [...(this.ptyRetirements.has(id) ? [{ sessionId: id, code: 'PTY_RETIREMENT_ACTIVE' }] : []), ...this.repos.execution.getSessionResourceBlockers(id)].filter(block => !(block.code === 'DRIVER_RESOURCE_UNSAFE' && block.resourceId && reusable.has(block.resourceId)));
  }
  private assertResources(id: string, reuseOwned = false) {
    const blockers = this.resourceBlockers(id, reuseOwned);
    if (blockers.length) throw new RuntimeError('SESSION_RESOURCE_BLOCKED', blockers.map(block => block.code).join(', '), 409);
  }
  private actor(session: Session, actorId?: string): ExecutionActor {
    if (!actorId) return { kind: 'unspecified' };
    if (actorId === 'installation_owner') return { kind: 'installation_owner', id: 'installation_owner' };
    const appId = session.source === 'lark' ? session.sourceId?.split(':')[0] : undefined;
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
  private transition(id: string) {
    this.transitions.get(id)?.revoke();
    const token = owner(id); this.transitions.set(id, token); return token;
  }
  private async scoped<T>(id: string, operation: () => Promise<T>) {
    this.assertReady();
    if (this.shuttingDown) return Promise.reject(new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503));
    return this.mutations.run(this.lifecycle(id), operation);
  }
  private async readWorkspace<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.assertReady();
    if (this.shuttingDown) return Promise.reject(new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503));
    const token = owner(id, this.workspaceReaders);
    return this.mutations.run(token, () => this.mutations.wait(operation));
  }
  private async authorize(id: string, actorId?: string, activate = false) {
    const commit = await this.mutations.wait(() => this.options.authorizeExecution?.(id, actorId) ?? Promise.resolve());
    if (activate && commit) await this.mutations.write(id, commit);
    this.mutations.check();
  }
  private async driverOperation<T>(driver: AgentDriver, operation: () => Promise<T>) {
    this.mutations.check();
    return this.observeDriverOperation(driver, operation());
  }
  private observeDriverOperation<T>(driver: AgentDriver, pending: Promise<T>) {
    const operations = this.driverOperations.get(driver) ?? new Set<Promise<unknown>>();
    operations.add(pending); this.driverOperations.set(driver, operations);
    const cleanup = () => { operations.delete(pending); if (!operations.size) this.driverOperations.delete(driver); };
    void pending.then(cleanup, cleanup);
    return this.mutations.wait(pending);
  }
  private assertReplaceable(id: string) {
    this.mutations.check();
    const blocked = this.stopBlocks.get(id) ?? this.blockedDrivers.get(id);
    if (blocked) throw new RuntimeError('DRIVER_STOP_UNVERIFIED', blocked.reason, 409);
    if (this.stopRuns.has(id)) throw new RuntimeError('SESSION_STOPPING', 'Session cleanup is still running', 409);
  }
  getDriverStopBlock(id: string) { return this.stopBlocks.get(id)?.reason ?? this.blockedDrivers.get(id)?.reason; }
  private async loadStopBlock(id: string) {
    const version = this.stopBlockVersions.get(id) ?? 0;
    const raw = await this.mutations.wait(() => this.repos.config.get(STOP_BLOCK_PREFIX + id));
    if (!raw || (this.stopBlockVersions.get(id) ?? 0) !== version) return;
    let block: { sessionId: string; runId: string; reason: string };
    try {
      block = JSON.parse(raw);
      if (block.sessionId !== id || typeof block.reason !== 'string') throw new Error('invalid stop block');
    } catch { block = { sessionId: id, runId: '', reason: 'Persisted driver stop evidence is invalid; resource verification is required' }; }
    this.mutations.check(); this.stopBlocks.set(id, block);
  }
  private async retainStopBlock(id: string, reason: string) {
    await this.mutations.write(id, async () => {
      const session = await this.repos.sessions.get(id);
      this.mutations.check();
      const block = { sessionId: id, runId: session?.runId ?? '', reason };
      this.stopBlockVersions.set(id, (this.stopBlockVersions.get(id) ?? 0) + 1);
      this.stopBlocks.set(id, block);
      await this.repos.config.set(STOP_BLOCK_PREFIX + id, JSON.stringify(block));
    });
  }
  private async clearStopBlock(id: string) {
    await this.mutations.write(id, async () => {
      if (this.stopBlocks.has(id)) await this.repos.config.set(STOP_BLOCK_PREFIX + id, '');
      this.stopBlockVersions.set(id, (this.stopBlockVersions.get(id) ?? 0) + 1);
      this.stopBlocks.delete(id);
    });
  }
  private async patchSession(id: string, patch: Partial<Session>) {
    return this.mutations.write(id, async () => {
      const current = await this.repos.sessions.get(id); this.mutations.check();
      if (!current) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
      if (patch.cwd !== undefined && patch.cwd !== current.cwd || patch.runId !== undefined && patch.runId !== current.runId) throw new RuntimeError('SESSION_EXPLICIT_COMMAND_REQUIRED', 'Workspace and run changes require explicit ledger commands', 409);
      let result = current;
      if (patch.state !== undefined || Object.hasOwn(patch, 'error')) {
        const scope = this.currentRef(id);
        const fence = scope && isAttemptRef(scope) ? this.attemptFence(scope) : this.fence(current);
        result = this.wake(this.bound().patchSessionState(fence, makeId('session_state'), { state: patch.state ?? current.state, ...(Object.hasOwn(patch, 'error') ? { error: patch.error ?? null } : {}) })).session;
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
  private touch(sessionId: string) { this.lastActivity.set(sessionId, Date.now()); }
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
  private permissionKey(sessionId: string, permissionId: string) { return `${sessionId}:${permissionId}`; }
  private enqueueDriverEvent(session: Session, event: NormalizedDriverEvent, generation: number, token: Owner) {
    const ref = this.attemptRefs.get(token) ?? this.fence(session);
    const eventId = event.sourceId ? this.driverEventId(ref, event.sourceId) : makeId('evt');
    const previous = this.driverEventChains.get(session.id) ?? Promise.resolve();
    const next = previous.then(() => this.mutations.run(token, async () => {
      if (this.sessionGenerations.get(session.id) !== generation || !this.mutations.valid(token)) return;
      await this.eventScope.run(ref, () => this.mutations.write(session.id, () => this.consume(session, event, eventId)));
    })).catch(error => {
      if (this.mutations.valid(token) && this.sessionGenerations.get(session.id) === generation && !this.driverEventErrors.has(session.id)) this.driverEventErrors.set(session.id, error);
    });
    this.driverEventChains.set(session.id, next);
    void next.finally(() => { if (this.driverEventChains.get(session.id) === next) this.driverEventChains.delete(session.id); });
  }
  private async flushDriverEvents(sessionId: string) {
    while (true) {
      this.mutations.check();
      const pending = this.driverEventChains.get(sessionId);
      if (!pending) break;
      await this.mutations.wait(() => pending);
      if (this.driverEventChains.get(sessionId) === pending) break;
    }
    this.mutations.check();
    const error = this.driverEventErrors.get(sessionId);
    this.driverEventErrors.delete(sessionId);
    if (error) throw error;
  }
  private static isTruncatedStopReason(reason?: string) {
    return reason === 'max_tokens' || reason === 'truncated';
  }
  private turnOutput(ref: AttemptRef) {
    const events: AgentEvent[] = [];
    let afterSequence = 0;
    for (;;) {
      const page = this.repos.execution.getAttemptEvents(ref.attemptId, { afterSequence, limit: 200 });
      events.push(...page);
      if (page.length < 200) break;
      afterSequence = page.at(-1)!.sequence;
    }
    const finalActivity = [...events].reverse().find(event => ['text', 'thinking', 'tool_call', 'tool_result'].includes(event.type) && !(event.type === 'text' && (event.data as { role?: string })?.role === 'user'));
    const stopReason = this.driverStopReasons.get(ref.attemptId) ?? 'end_turn';
    const error = this.turnErrors.get(ref.attemptId);
    const status = stopReason === 'cancelled' ? 'interrupted'
      : error || DutydeckRuntime.isTruncatedStopReason(stopReason) || finalActivity?.type !== 'text' ? 'failed' : 'completed';
    const text = events.filter(event => event.type === 'text').map(event => event.data as { role?: string; text?: unknown })
      .filter(data => data.role !== 'user' && typeof data.text === 'string').map(data => data.text).join('');
    return { status, stopReason, outputDigest: createHash('sha256').update(text, 'utf8').digest('hex') } as const;
  }
  private nextSessionGeneration(sessionId: string) {
    const generation = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.sessionGenerations.set(sessionId, generation);
    return generation;
  }
  private onDriverEvent(session: Session, generation: number) {
    const lifecycle = this.lifecycle(session.id);
    return (event: NormalizedDriverEvent) => {
      if (this.shuttingDown || !this.mutations.valid(lifecycle) || this.sessionGenerations.get(session.id) !== generation) return;
      const attempt = this.attempts.get(session.id);
      this.enqueueDriverEvent(session, event, generation, attempt ?? lifecycle);
    };
  }
  private configureAgentForSession(agent: AgentConfig, session: Session): AgentConfig {
    return {
      ...agent,
      cwd: session.cwd,
      model: session.model ?? agent.model,
      reasoningEffort: session.reasoningEffort ?? agent.reasoningEffort,
      systemPrompt: session.systemPrompt ?? agent.systemPrompt,
      permissionMode: session.permissionMode ?? agent.permissionMode,
      env: { ...agent.env, ...this.options.sessionEnvironment?.(session) }
    };
  }

  initialize(agents: AgentConfig[]) {
    if (!this.initializationRun) this.initializationRun = Promise.resolve().then(() => {
      if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
      if (this.repos.execution.authority() !== 'ledger_v1') {
        this.repos.close();
        throw new RuntimeError('EXECUTION_UPGRADE_REQUIRED', 'Run dutydeck database upgrade-execution --database <path> while this database is offline', 409);
      }
      this.binding = this.repos.control.attachRuntime(this.runtimeInstanceId);
      this.execution = this.repos.execution.bind(this.binding);
      return this.initializationContext.run(true, () => this.mutations.run(this.initializationOwner, async () => {
        await this.initializeOnce(agents);
        this.mutations.check();
        this.initialized = true;
      }));
    }).catch(error => {
      this.initializationFailed = true;
      this.initializationOwner.revoke();
      this.workspaceReaders.revoke();
      for (const transition of this.transitions.values()) transition.revoke();
      // Recovery may already have admitted turns for earlier sessions. Capture
      // their submitted state and revoke them before rejecting initialization.
      const ids = new Set([...this.lifecycles.keys(), ...this.drivers.keys()]);
      // The service marks persistent PTY drivers for detach before shutdown.
      // Fence facts now, but keep physical teardown behind that lifecycle boundary.
      const cleanupReady = this.shuttingDown ? Promise.resolve() : new Promise<void>(resolve => { this.releaseInitializationCleanup = resolve; });
      this.initializationCleanup = Promise.allSettled([...ids].map(id => this.revokeSession(id, false, 'stopped', true, false, cleanupReady))).then(() => {});
      throw error;
    });
    return this.initializationRun;
  }
  private async initializeOnce(agents: AgentConfig[]) {
    const blockedVerifications = await this.verifications.interruptRunning();
    this.mutations.check();
    this.blockedVerificationSessions.clear();
    for (const [sessionId, error] of blockedVerifications) this.blockedVerificationSessions.set(sessionId, error);
    // Configuration is the source of truth on every boot and removes built-ins
    // that are no longer discovered from the ACPX registry.
    const configuredIds = new Set(agents.map(agent => agent.id));
    for (const existing of await this.mutations.wait(() => this.repos.agents.list())) if (existing.builtin && !configuredIds.has(existing.id)) await this.mutations.write('runtime_initialize', () => this.repos.agents.delete(existing.id));
    for (const agent of agents) await this.mutations.write('runtime_initialize', () => this.repos.agents.save(agent));
    for (const session of await this.mutations.wait(() => this.repos.sessions.list())) {
      await this.scoped(session.id, async () => {
        await this.loadStopBlock(session.id);
        if (session.archivedAt) return;
        const tasks = await this.mutations.wait(() => this.repos.tasks.listBySession(session.id));
        for (const task of tasks) {
          const current = this.repos.execution.getTaskExecution(task.id)?.currentAttempt;
          if (current && current.submissionState !== 'not_submitted' && ['preparing', 'active', 'reconcile_required'].includes(current.state)
            && (current.controller.accessId !== this.repos.control.accessId || current.controller.instanceId !== this.runtimeInstanceId || current.controller.generation !== this.binding!.generation)) {
            await this.mutations.write(session.id, async () => this.wake(this.bound().markOrphanedAttempt(this.attemptFence(current), { reasonId: `orphan:${current.attemptId}:${this.binding!.generation}`, code: 'PREVIOUS_RUNTIME_RESULT_UNKNOWN', evidenceRefs: [] })));
          }
        }
        await this.observeAbandonedResources(session);
        await this.clearVerifiedStopBlock(session);
        try { await this.mutations.wait(() => this.configurations.assertClear(session.id)); }
        catch (error) {
          if (error instanceof RuntimeError && ['DRIVER_CONFIGURATION_BUSY', 'DRIVER_CONFIGURATION_UNKNOWN'].includes(error.code)) return;
          throw error;
        }
        // Reopened local_only and legacy resources cannot be adopted by a new adapter.
        if (this.resourceBlockers(session.id).length || blockedVerifications.has(session.id)) return;
        for (const task of tasks) {
          const attempt = this.repos.execution.getTaskExecution(task.id)?.currentAttempt;
          if (attempt?.state === 'preparing' && attempt.submissionState === 'not_submitted') {
            const safeResources: ResourceCheckRef[] = this.repos.execution.getResources(session.id)
              .filter(resource => resource.kind !== 'operation' && resource.purpose !== 'acp_native_context' && resource.stage !== 'not_created')
              .map(resource => ({ resourceId: resource.resourceId, expectedRevision: resource.revision, observationId: resource.observations.at(-1)!.observationId }));
            this.wake(this.bound().recoverAttempt(this.attemptFence(attempt), { kind: 'unsubmitted_preparation', decisionId: `recover:${attempt.attemptId}:${this.binding!.generation}`, safeResources }));
          }
        }
        const executions = tasks.map(task => this.repos.execution.getTaskExecution(task.id));
        if (executions.some(item => item?.attempts.some(attempt => ['active', 'reconcile_required', 'legacy_unresolved'].includes(attempt.state)))) return;
        let workspace = await this.mutations.wait(() => this.workspaces.get(session.id));
        if (workspace?.state === 'preparing') {
          workspace = await this.prepareWorkspace(session.id, workspace.sourceCwd, workspace.mode);
        }
        if (workspace?.state === 'ready') Object.assign(session, await this.finalizeWorkspace(session));
        await this.projectQueue(session.id);
        if (this.queues.get(session.id)?.length) this.scheduleQueue(session.id);
      });
    }
  }
  listAgents() { return this.repos.agents.list(); }
  async listSessions() { return this.readWorkspace('workspace_list', async () => Promise.all((await this.mutations.wait(() => this.repos.sessions.list())).map(session => this.withWorkspaceMode(session)))); }
  async getSession(id: string) { return this.readWorkspace(id, async () => { const session = await this.mutations.wait(() => this.repos.sessions.get(id)); return session ? this.withWorkspaceMode(session) : undefined; }); }
  async getWorkspace(id: string): Promise<WorkspaceResponse | undefined> {
    return this.readWorkspace(id, async () => {
      const workspace = await this.mutations.wait(() => this.workspaces.get(id));
      if (workspace?.state === 'ready') await this.mutations.wait(() => this.workspaces.validate(workspace));
      return workspace;
    });
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
    await this.loadStopBlock(sessionId);
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
        } catch {
          // ignore error reading other workspace
        }
        const otherCanonical = await this.mutations.wait(() => realpath(otherDir).catch(() => otherDir));
        if (isSameOrIntersectingPath(targetRoot, otherCanonical)) {
          intersectingSessionIds.add(other.id);
          for (const block of this.resourceBlockers(other.id)) runtimeBlockers.push({ code: block.code, message: `相交会话 ${other.id}: ${block.code}` });
          await this.loadStopBlock(other.id);
          if (this.getDriverStopBlock(other.id)) runtimeBlockers.push({ code: 'DRIVER_STOP_UNVERIFIED', message: `相交会话 ${other.id}: ${this.getDriverStopBlock(other.id)}` });
          if (!other.archivedAt) {
            runtimeBlockers.push({ code: 'ACTIVE_SESSION_CONFLICT', message: `同工作目录存在未归档会话: ${other.id}` });
          }
          if (this.drivers.has(other.id)) {
            runtimeBlockers.push({ code: 'SESSION_BUSY', message: `同工作目录存在活动驱动会话: ${other.id}` });
          }
          if (this.activeTurns.has(other.id) || (this.queues.get(other.id)?.length ?? 0) > 0 || this.queueRuns.has(other.id)) {
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

    if (this.drivers.has(sessionId)) {
      runtimeBlockers.push({ code: 'SESSION_BUSY', message: '当前会话仍有未断开的驱动连接' });
    }
    if (this.activeTurns.has(sessionId) || (this.queues.get(sessionId)?.length ?? 0) > 0 || this.queueRuns.has(sessionId)) {
      runtimeBlockers.push({ code: 'SESSION_BUSY', message: '当前会话仍有活跃任务' });
    }
    if (this.verifyingSessions.has(sessionId) || this.blockedVerificationSessions.has(sessionId)) {
      runtimeBlockers.push({ code: 'VERIFICATION_RUNNING', message: '当前会话存在正在执行或未恢复的验证任务' });
    }

    // 检查所有相交会话及存储中的持久 running verification；捕获任何未知/读取异常作为明确 blocker
    try {
      if (this.repos.config.list) {
        const rawVerifications = await this.mutations.wait(() => this.repos.config.list!('runtime_verification:'));
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
    if (this.shuttingDown) return Promise.reject(new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503));
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
      cleanupOwner.revoke();
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

  private async withWorkspaceMode(session: Session): Promise<Session> {
    const workspace = await this.mutations.wait(() => this.workspaces.get(session.id));
    return workspace ? { ...session, workspaceMode: workspace.mode, workspaceSourceCwd: workspace.sourceCwd } : session;
  }
  /** 只读访问当前内存中的 driver 实例（如终端 WS 代理取 createTerminalStream）；未连接/已释放时返回 undefined。 */
  getDriver(sessionId: string): AgentDriver | undefined {
    if (this.blockedVerificationSessions.has(sessionId) || this.stopBlocks.has(sessionId) || this.blockedDrivers.has(sessionId) || !this.mutations.valid(this.lifecycle(sessionId))) return undefined;
    return this.drivers.get(sessionId);
  }
  /** Restore an idle persistent terminal for viewing without resuming a task. */
  async getTerminalDriver(id: string): Promise<AgentDriver | undefined> {
    return this.scoped(id, async () => {
      this.assertVerificationRecoverySafe(id);
      if (this.shuttingDown) return undefined;
      this.mutations.check();
      await this.mutations.wait(() => this.configurations.assertClear(id));
      this.assertResources(id, true);
      const existing = this.drivers.get(id); if (existing) return existing;
      const session = await this.mutations.wait(() => this.repos.sessions.get(id));
      if (!session || session.archivedAt || session.protocol !== 'pty-cli' || !['idle', 'completed', 'interrupted'].includes(session.state)) return undefined;
      const driver = await this.reconnect(session, false);
      this.mutations.check();
      if (this.attachedTerminals.has(driver)) return driver;
      let attached: boolean;
      try { attached = driver.attachTerminal?.() ?? false; }
      catch (error) { await this.discardUnattachedTerminal(id, driver); throw error; }
      if (attached) { this.localResources.ready(driver); this.attachedTerminals.add(driver); return driver; }
      await this.discardUnattachedTerminal(id, driver); return undefined;
    }).catch(error => { if (error instanceof RevokedOperation) return undefined; throw error; });
  }
  /**
   * A terminal view that attached nothing owns no process, so there is no exit to prove.
   * Shutdown retires idle panes whose native history can resume; revoking the view's
   * driver here demanded a stop proof it can never give, and the retained stop block
   * then refused every later task in the session. The session state is left untouched.
   */
  private async discardUnattachedTerminal(id: string, driver: AgentDriver) {
    this.nextSessionGeneration(id);
    if (this.drivers.get(id) === driver) this.drivers.delete(id);
    try { await driver.stop(); } catch { /* Nothing was attached. */ }
    await this.mutations.write(id, async () => this.localResources.gone(driver, 'terminal-attach-found-no-pane'));
  }
  getEvents(id: string, after = 0) { return this.repos.events.list(id, after); }
  getRecentEvents(id: string, limit: number) { return this.repos.events.listRecent(id, limit); }
  getEventWindow(id: string, options?: EventWindowOptions) { return this.repos.events.listWindow(id, options); }
  async getTasks(id: string) { return (await this.repos.tasks.listBySession(id)).map(task => this.publicTask(task)); }
  async getTaskRecovery(id: string, taskId: string) {
    const projection = this.repos.execution.getTaskExecution(taskId);
    if (!projection || projection.task.sessionId !== id) throw new RuntimeError('TASK_NOT_FOUND', 'Task not found in this session', 404);
    const reusable = this.localResources.reusableIds(id);
    const blockers = projection.blockers.filter(block => !(block.code === 'DRIVER_RESOURCE_UNSAFE' && block.resourceId && reusable.has(block.resourceId)));
    const tasks = await this.getTasks(id);
    const unresolved = (taskId: string) => this.repos.execution.getTaskExecution(taskId)?.attempts.some(attempt => ['preparing', 'active', 'reconcile_required', 'legacy_unresolved'].includes(attempt.state));
    const active = tasks.find(task => task.id !== taskId && unresolved(task.id));
    if (active && active.status !== 'running') blockers.push({ code: 'PREVIOUS_RESULT_UNKNOWN', sessionId: id });
    if (projection.task.status === 'queued' && this.queueBlocked.has(id)) {
      blockers.push({ code: 'QUEUE_START_CHECK_FAILED', sessionId: id });
    }
    return { status: projection.task.status, resolvedUnknown: projection.currentAttempt?.state === 'settled' && projection.currentAttempt.outcome === 'unknown', blockers: [...new Set(blockers.map(block => block.code))].map(code => ({ code })),
      ...(projection.currentAttempt?.state === 'settled' && projection.currentAttempt.outcome === 'completed' && projection.currentAttempt.settlement?.kind === 'manual' && projection.currentAttempt.settlement.verifiedOutput ? { verifiedOutput: projection.currentAttempt.settlement.verifiedOutput } : {}),
      ...(active ? { activeTaskId: active.id } : {}) };
  }


  private requireRecoveryOwner(actor: ExecutionActor) {
    if (executionActorSchema.parse(actor).kind !== 'installation_owner') throw new RuntimeError('RECOVERY_OWNER_REQUIRED', 'Installation owner authorization is required', 403);
  }
  async inspectExecutionRecovery(id: string, actor: ExecutionActor) {
    this.assertReady(); this.requireRecoveryOwner(actor);
    const session = await this.repos.sessions.get(id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', 'Session not found', 404);
    const tasks = (await this.repos.tasks.listBySession(id)).map(task => this.repos.execution.getTaskExecution(task.id)!).filter(Boolean);
    const resources = this.repos.execution.getResources(id);
    return { sessionId: id, runId: session.runId, state: session.state,
      tasks: tasks.map(({ task, currentAttempt }) => ({ taskId: task.id, status: task.status, revision: task.revision,
        attempt: currentAttempt, resolvedUnknown: currentAttempt?.state === 'settled' && currentAttempt.outcome === 'unknown' })),
      resources, blockers: this.repos.execution.getSessionResourceBlockers(id),
      stopBlock: await this.repos.config.get(STOP_BLOCK_PREFIX + id) ?? null,
      resourceChecks: resources.filter(resource => resource.kind !== 'operation' && resource.purpose !== 'acp_native_context' && resource.stage !== 'not_created')
        .flatMap(resource => resource.observations.at(-1) ? [{ resourceId: resource.resourceId, expectedRevision: resource.revision, observationId: resource.observations.at(-1)!.observationId }] : []),
      unverifiedResourceIds: resources.filter(resource => ['local_only', 'legacy'].includes(resource.kind) && resource.observations.at(-1)?.state !== 'gone').map(resource => resource.resourceId)
    };
  }
  private recoveryInFlight(id: string, includeQueueDrain = true) {
    return this.ptyRetirements.has(id) || (includeQueueDrain && this.drains.has(id)) || this.attempts.has(id) || this.activeTurns.has(id) || this.stopRuns.has(id) || this.factoryCleanups.has(id)
      || [...this.drivers.entries(), ...[...this.blockedDrivers].map(([key, value]) => [key, value.driver] as const)]
        .some(([key, driver]) => key === id && this.driverOperations.get(driver)?.size);
  }
  private async clearVerifiedStopBlock(session: Session) {
    if (this.recoveryInFlight(session.id)) return false;
    const raw = await this.mutations.wait(() => this.repos.config.get(STOP_BLOCK_PREFIX + session.id));
    if (!raw) return false;
    try {
      const cleared = await this.mutations.write(session.id, async () => this.bound().clearVerifiedStopBlock(this.fence(session), raw));
      if (cleared) {
        this.stopBlockVersions.set(session.id, (this.stopBlockVersions.get(session.id) ?? 0) + 1);
        this.stopBlocks.delete(session.id);
        this.drivers.delete(session.id); this.blockedDrivers.delete(session.id);
      }
      return cleared;
    } catch (error) {
      if (error instanceof RuntimeError && ['SESSION_RESOURCE_BLOCKED', 'DRIVER_STOP_BLOCK_INVALID', 'SESSION_RUN_CONFLICT'].includes(error.code)) return false;
      throw error;
    }
  }
  async probeExecutionRecovery(id: string, runId: string, actor: ExecutionActor) {
    this.assertReady(); this.requireRecoveryOwner(actor);
    return this.mutations.run(owner(id, this.transitions.get(id) ?? this.transition(id)), async () => {
      const { session } = await this.active(id);
      if (session.runId !== runId) throw new RuntimeError('SESSION_RUN_CONFLICT', 'Session run changed', 409);
      if (this.recoveryInFlight(id)) throw new RuntimeError('RECOVERY_EXECUTION_ACTIVE', 'Original execution still has an in-flight owner', 409);
      await this.observeAbandonedResources(session);
      await this.clearVerifiedStopBlock(session);
      if (!this.resourceBlockers(id).length) {
        if (this.lifecycle(id).revoked) this.lifecycles.set(id, owner(id, this.transitions.get(id) ?? this.transition(id)));
        this.queueBlocked.delete(id); await this.projectQueue(id); this.scheduleQueue(id);
      }
      return this.inspectExecutionRecovery(id, actor);
    });
  }
  async retirePtyExecution(id: string, raw: PtyRetirementRecovery, actor: ExecutionActor) {
    this.assertReady(); this.requireRecoveryOwner(actor);
    const input = ptyRetirementRecoverySchema.parse(raw), control = this.options.ptyRetirement;
    if (!control) throw new RuntimeError('PTY_RETIREMENT_UNAVAILABLE', 'Trusted PTY recovery is not configured', 503);
    return this.mutations.run(owner(id, this.transitions.get(id) ?? this.transition(id)), async () => {
      const { session } = await this.active(id);
      if (session.runId !== input.runId) throw new RuntimeError('SESSION_RUN_CONFLICT', 'Session run changed', 409);
      const key = `runtime_pty_retirement:${id}:${input.decisionId}`;
      const observationId = `pty_retirement_${digest({ sessionId: id, ...input })}`;
      type Receipt = { input: PtyRetirementRecovery; actor: ExecutionActor; identity: unknown; snapshot: unknown };
      let receipt: Receipt | undefined;
      let replayed = false, reserved = false;
      const checkScope = async () => {
        const current = await this.repos.sessions.get(id); this.mutations.check();
        if (current?.runId !== input.runId) throw new RuntimeError('SESSION_RUN_CONFLICT', 'Session run changed', 409);
      };
      const checkResource = () => {
        this.mutations.check();
        const resource = this.repos.execution.getResources(id).find(item => item.resourceId === input.resourceId);
        if (!resource || resource.runId !== input.runId || resource.kind !== 'local_only' || !resource.identity || resource.identity.locator === null) throw new RuntimeError('RESOURCE_SCOPE_CONFLICT', 'The exact local PTY resource is required', 409);
        if (receipt && canonicalExecutionJson(resource.identity) !== canonicalExecutionJson(receipt.identity)) throw new RuntimeError('RESOURCE_IDENTITY_CONFLICT', 'Original resource identity changed', 409);
        const observed = resource.observations.find(item => item.observationId === observationId);
        if (receipt && observed && observed.state === 'gone' && resource.revision === input.expectedRevision + 1 && observed.evidenceRef === `pty-retirement:${digest(receipt)}`) return { resource, recorded: true };
        if (resource.revision !== input.expectedRevision) throw new RuntimeError('RESOURCE_REVISION_CONFLICT', 'Resource revision changed', 409);
        return { resource, recorded: false };
      };
      await this.mutations.write(id, async () => {
        const persisted = await this.repos.config.get(key);
        if (persisted) {
          receipt = JSON.parse(persisted) as Receipt;
          if (canonicalExecutionJson(receipt.input) !== canonicalExecutionJson(input) || canonicalExecutionJson(receipt.actor) !== canonicalExecutionJson(actor)) throw new RuntimeError('EXECUTION_OPERATION_CONFLICT', 'Retirement decision was reused with different input', 409);
        }
        await checkScope();
        const checked = checkResource(); replayed = checked.recorded;
        if (replayed) return;
        if (this.recoveryInFlight(id)) throw new RuntimeError('RECOVERY_EXECUTION_ACTIVE', 'Original execution or queue drain still has an in-flight owner', 409);
        if (checked.resource.stage !== 'created' || checked.resource.observations.at(-1)?.state === 'gone') throw new RuntimeError('PTY_RETIREMENT_RESOURCE_UNSAFE', 'Only the original live or unverified created PTY resource can be retired', 409);
        const resources = this.repos.execution.getResources(id);
        if (resources.some(resource => resource.kind === 'local_only' && resource.resourceId !== input.resourceId && resource.stage !== 'not_created' && resource.observations.at(-1)?.state !== 'gone')
          || resources.some(resource => resource.kind === 'operation' && ['pending', 'unknown'].includes(resource.stage) && !resource.creationClosure)) throw new RuntimeError('PTY_RETIREMENT_RESOURCE_AMBIGUOUS', 'Another PTY resource or unfinished creation prevents unambiguous retirement', 409);
        this.ptyRetirements.add(id); reserved = true;
        if (!await this.repos.config.get(STOP_BLOCK_PREFIX + id)) await this.retainStopBlock(id, 'Explicit PTY retirement requires verified physical exit');
      }).catch(error => { if (reserved) this.ptyRetirements.delete(id); throw error; });
      if (replayed) return { replayed: true, recovery: await this.inspectExecutionRecovery(id, actor) };
      try {
        if (!replayed) {
          if (!receipt) {
            const snapshot = control.capture(session);
            canonicalExecutionJson(snapshot);
            await this.mutations.write(id, async () => {
              await checkScope(); const { resource } = checkResource();
              receipt = { input, actor, identity: resource.identity!, snapshot };
              await this.repos.config.set(key, canonicalExecutionJson(receipt));
            });
          }
          if (!control.verify(session, receipt!.snapshot)) {
            const proof = await this.mutations.wait(() => control.stop(session, receipt!.snapshot, async snapshot => {
              canonicalExecutionJson(snapshot);
              await this.mutations.write(id, async () => {
                await checkScope(); checkResource(); receipt = { ...receipt!, snapshot };
                await this.repos.config.set(key, canonicalExecutionJson(receipt));
              });
            }));
            canonicalExecutionJson(proof);
            await this.mutations.write(id, async () => {
              await checkScope(); checkResource(); receipt = { ...receipt!, snapshot: proof };
              await this.repos.config.set(key, canonicalExecutionJson(receipt));
            });
          }
          await this.mutations.write(id, async () => {
            await checkScope(); const { resource } = checkResource();
            if (!control.verify(session, receipt!.snapshot)) throw new RuntimeError('PTY_EXIT_UNVERIFIED', 'Original PTY processes have not all been proven gone', 409);
            this.bound().observed(this.fence(session), resource.resourceId, input.expectedRevision, { observationId, state: 'gone', identityId: resource.identity!.identityId, observedAt: now(), evidenceRef: `pty-retirement:${digest(receipt)}` });
          });
        }
      } finally { this.ptyRetirements.delete(id); }
      await this.clearVerifiedStopBlock(session);
      if (!this.resourceBlockers(id).length) {
        if (this.lifecycle(id).revoked) this.lifecycles.set(id, owner(id, this.transitions.get(id) ?? this.transition(id)));
        this.queueBlocked.delete(id); await this.projectQueue(id); this.scheduleQueue(id);
      }
      return { replayed, recovery: await this.inspectExecutionRecovery(id, actor) };
    });
  }

  async confirmExecutionRecovery(id: string, raw: ExecutionRecoveryDecision, actor: ExecutionActor) {
    this.assertReady(); this.requireRecoveryOwner(actor);
    const input = executionRecoveryDecisionSchema.parse(raw);
    return this.mutations.run(owner(id, this.transitions.get(id) ?? this.transition(id)), async () => {
      const { session } = await this.active(id);
      if (session.runId !== input.runId) throw new RuntimeError('SESSION_RUN_CONFLICT', 'Session run changed', 409);
      const original = this.repos.execution.getTaskExecution(input.taskId)?.attempts.find(attempt => attempt.attemptId === input.attemptId);
      const replay = original?.settlement?.kind === 'manual' && original.settlement.decision.decisionId === input.decisionId;
      if (!replay && this.recoveryInFlight(id)) throw new RuntimeError('RECOVERY_EXECUTION_ACTIVE', 'Original execution still has an in-flight owner', 409);
      const f = { sessionId: id, runId: input.runId, taskId: input.taskId, attemptId: input.attemptId, expectedRevision: input.expectedRevision };
      const decision = { decisionId: input.decisionId, actor, action: input.action, evidenceRefs: input.evidenceRefs, resourceChecks: input.resourceChecks,
        ...(input.action === 'retry' ? { allowDuplicateEffects: true } : {}) };
      const result = await this.mutations.write(id, async () => this.wake(input.action === 'retry'
        ? this.bound().retryAttempt(f, decision, input.resourceChecks)
        : this.bound().confirmAttemptRecovery(f, `recovery:${input.decisionId}`, { kind: 'manual', outcome: input.outcome, decision }, input.verifiedOutputText)));
      if (!result.replayed) {
        if (this.lifecycle(id).revoked) this.lifecycles.set(id, owner(id, this.transitions.get(id) ?? this.transition(id)));
        this.queueBlocked.delete(id); await this.projectQueue(id); this.scheduleQueue(id);
      }
      return { replayed: result.replayed, task: this.publicTask(result.task!), recovery: await this.inspectExecutionRecovery(id, actor) };
    });
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
      const preexistingQueue = (this.queues.get(id) ?? []).some(task => !deferredTasks.has(task.id));
      if (this.activeTurns.has(id) || this.queueRuns.has(id) || preexistingQueue
        || eligibleTasks.some(task => task.status === 'running' || task.status === 'queued')) {
        throw new RuntimeError('SESSION_BUSY', 'Wait for Agent execution and its queue to finish before verification', 409);
      }
      const workspace = await this.mutations.wait(() => this.workspaces.get(id));
      if (workspace) await this.mutations.wait(() => this.workspaces.validate(workspace));
      const token = this.mutations.current();
      this.mutations.check();
      return await this.mutations.run(undefined, () => this.verifications.run(
        id, session.cwd, input, actorId, eligibleTasks.at(-1)?.id,
        () => this.mutations.run(token, () => this.authorize(id, actorId))
      ));
    } finally {
      if (this.verificationDeferredTasks.get(id) === deferredTasks) {
        this.verifyingSessions.delete(id); this.verificationDeferredTasks.delete(id);
        this.mutations.run(undefined, () => this.scheduleQueue(id));
      }
    }
    });
  }

  /** Persist descriptive out-of-band events through the same authoritative ledger. */
  async publishSessionEvent(sessionId: string, type: EventType, data: unknown) {
    if (['completed', 'status', 'task'].includes(type)) throw new RuntimeError('EXECUTION_EVENT_RESERVED', 'Execution transitions require an explicit ledger command', 409);
    return this.scoped(sessionId, async () => {
    if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
    const session = await this.repos.sessions.get(sessionId);
    if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`, 404);
    if (session.archivedAt) throw new RuntimeError('SESSION_ARCHIVED', 'Archived sessions are read-only', 409);
    return this.mutations.run(undefined, () => this.emit(sessionId, type, data));
    });
  }

  private async saveState(session: Session, state: Session['state'], error?: string) {
    const patch = { state, ...(error !== undefined ? { error } : {}) };
    Object.assign(session, await this.patchSession(session.id, patch)); this.touch(session.id);
  }
  private driverEventId(ref: SessionFence | (SessionFence & AttemptRef), sourceId: string) {
    return `evt_v1_${digest([ref.sessionId, isAttemptRef(ref) ? ['attempt', ref.attemptId] : ['run', ref.runId], sourceId])}`;
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

  private executionContext(agentPrompt: string, riskPolicy?: ToolRiskPolicy, actorId?: string, skillDeliveries?: SkillDeliveryMetadata[]): TaskExecutionContext {
    return {
      agentPrompt,
      ...(actorId ? { actorId } : {}),
      ...(riskPolicy ? { riskPolicy } : {}),
      ...(skillDeliveries?.length ? { skillDeliveries } : {})
    };
  }

  private async prepareTask(session: Session, agentPrompt: string, skillRequests?: string[]): Promise<{ agentPrompt: string; skillDeliveries?: SkillDeliveryMetadata[] }> {
    if (skillRequests?.length && !this.options.prepareTaskPrompt) {
      throw new RuntimeError('SKILL_DELIVERY_UNAVAILABLE', 'This Runtime has no Skill delivery resolver', 503);
    }
    return this.options.prepareTaskPrompt?.(session, agentPrompt, skillRequests) ?? { agentPrompt };
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

  private async consume(session: Session, event: NormalizedDriverEvent, eventId: string) {
    const scope = this.currentRef(session.id);
    this.touch(session.id);
    if (event.type === 'completed') {
      if (scope && isAttemptRef(scope)) {
        this.completedTurns.add(scope.attemptId);
        if (typeof event.data?.stopReason === 'string') this.driverStopReasons.set(scope.attemptId, event.data.stopReason);
      }
      return;
    }
    let data = event.data;
    const scopedId = (nativeId: string) => scope && isAttemptRef(scope) ? `turn_${digest([scope.taskId, scope.attemptId, nativeId])}` : nativeId;
    if (event.type === 'permission_request' || event.type === 'tool_call' || event.type === 'tool_result') {
      data = { ...data, id: scopedId(String(data.id)), ...(data.toolCallId ? { toolCallId: scopedId(String(data.toolCallId)) } : {}) };
    }
    let tools: AttemptTools | undefined;
    if ((event.type === 'tool_call' || event.type === 'tool_result') && scope && isAttemptRef(scope)) {
      tools = this.attemptTools.get(scope.attemptId);
      if (!tools) { tools = { calls: new Map(), events: new Map() }; this.attemptTools.set(scope.attemptId, tools); }
      const input = eventJson(data) as unknown as ToolCallData;
      const inputDigest = digest({ type: event.type, data: input, raw: event.raw ?? null });
      const cached = tools.events.get(eventId);
      if (cached && cached.inputDigest !== inputDigest) throw new RuntimeError('EVENT_IDEMPOTENCY_CONFLICT', 'A tool event identity was reused with a different payload', 409);
      data = cached?.data ?? mergeToolCall(input, tools.calls.get(input.id)?.data);
      // Stable provider replays must reuse the original enrichment, even after a lost write ACK.
      if (event.sourceId && !cached) tools.events.set(eventId, { inputDigest, data });
    }
    const rememberTool = (stored: AgentEvent) => {
      if (!tools) return true;
      const saved = stored.data as ToolCallData;
      // Replaying an earlier call must not regress the completed tool artifact or Session state.
      const previous = tools.calls.get(saved.id);
      if (previous && (previous.sequence > stored.sequence || previous.sequence === stored.sequence && previous.projected)) return false;
      if (!previous || previous.sequence < stored.sequence) tools.calls.set(saved.id, { sequence: stored.sequence, data: saved, projected: false });
      return true;
    };
    let stored: AgentEvent;
    try { stored = await this.emit(session.id, event.type, data, event.raw, eventId, event.sourceId); }
    catch (error) {
      if (tools && scope && isAttemptRef(scope)) {
        // A failed return may follow a committed append. Only durable matching data can seed later results.
        try {
          const expected = digest({ type: event.type, data: eventJson(data), raw: event.raw ?? null });
          let afterSequence = 0;
          for (;;) {
            const page = this.repos.execution.getAttemptEvents(scope.attemptId, { afterSequence, limit: 200 });
            const saved = page.find(item => item.id === eventId);
            if (saved) {
              if (digest({ type: saved.type, data: saved.data, raw: saved.raw ?? null }) === expected) rememberTool(saved);
              break;
            }
            if (page.length < 200) break;
            afterSequence = page.at(-1)!.sequence;
          }
        } catch (readError) { throw new AggregateError([error, readError], 'Driver event write failed and its durable result could not be read back'); }
      }
      throw error;
    }
    if (event.type === 'tool_call' || event.type === 'tool_result') {
      if (!rememberTool(stored)) return;
      if (scope && isAttemptRef(scope)) await this.saveState(session, event.type === 'tool_result' ? 'thinking' : 'running_tool');
      await this.artifact('saveToolCall', session.id, data).catch(() => {});
      if (tools) tools.calls.get(data.id)!.projected = true;
    } else if (event.type === 'thinking' && scope && isAttemptRef(scope)) await this.saveState(session, 'thinking');
    else if (event.type === 'permission_request' && scope && isAttemptRef(scope)) {
      const key = this.permissionKey(session.id, data.id);
      if ((data.status ?? 'pending') === 'pending') {
        this.permissions.set(key, { request: data, nativeId: String(event.data.id), fence: scope, generation: this.sessionGenerations.get(session.id) ?? 0, owner: this.mutations.current() });
        await this.saveState(session, 'waiting_for_permission');
      } else { this.permissions.delete(key); this.permissionResolutions.delete(key); }
      await this.artifact('savePermission', session.id, data).catch(() => {});
    } else if (event.type === 'error') {
      if (scope && isAttemptRef(scope)) this.turnErrors.set(scope.attemptId, data.message);
      await this.artifact('saveError', session.id, data.message, data.detail).catch(() => {});
    }
  }

  getActiveTaskContext(sessionId: string): { taskId: string; attemptId?: string; actorId?: string } | undefined {
    const task = this.activeTasks.get(sessionId);
    if (!task) return undefined;
    // 当前 attempt 必须确实属于这个活跃 task；队列/旧 token 残留不能冒充当前轮。
    const owner = this.attempts.get(sessionId);
    const ref = owner ? this.attemptRefs.get(owner) : undefined;
    return {
      taskId: task.id,
      ...(ref && ref.taskId === task.id ? { attemptId: ref.attemptId } : {}),
      actorId: task.executionContext?.actorId
    };
  }

  async start(input: StartSessionInput): Promise<Session> {
    this.assertReady();
    if (input?.source === 'work_item') throw new RuntimeError('INVALID_WORK_SESSION', 'Work-item sessions require the internal admission API', 403);
    return this.startSession(input);
  }

  /** Internal orchestration entry: mapping and authority must be durable before birth. */
  async startWorkItemSession(input: StartSessionInput, stableSessionId: string, beforeStart: () => Promise<void>): Promise<Session> {
    if (input.source !== 'work_item' || !input.sourceId || !/^ses_work_[a-f0-9]{64}$/.test(stableSessionId)) {
      throw new RuntimeError('INVALID_WORK_SESSION', 'Invalid work-item session identity', 400);
    }
    return this.scoped(stableSessionId, async () => {
    await this.mutations.wait(() => beforeStart());
    const existing = await this.mutations.wait(() => this.repos.sessions.get(stableSessionId));
    if (existing) {
      if (existing.source !== 'work_item' || existing.sourceId !== input.sourceId || existing.agentId !== input.agentId) {
        throw new RuntimeError('WORK_SESSION_CONFLICT', 'Work-item session identity conflict', 409);
      }
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
    if (input.source !== 'lark' || !/^[^:]+:[^:]+:group:collaboration:.+$/.test(input.sourceId ?? '') || !/^ses_collab_[a-f0-9]{64}$/.test(stableSessionId) || input.workspaceMode === 'worktree') {
      throw new RuntimeError('INVALID_BACKGROUND_SESSION', 'Background sessions require a stable authorized Lark group scope and shared workspace', 400);
    }
    await beforeStart();
    const pending = this.backgroundStarts.get(stableSessionId);
    if (pending) { await pending; return this.startBackgroundSession(input, stableSessionId, beforeStart); }
    const agent = await this.repos.agents.get(input.agentId);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', 'Background Agent not found', 404);
    const existing = await this.repos.sessions.get(stableSessionId);
    if (existing) {
      const expected = { source: input.source, sourceId: input.sourceId, agentId: input.agentId, cwd: input.cwd ?? agent.cwd ?? process.cwd(), model: input.model ?? agent.model, reasoningEffort: input.reasoningEffort ?? agent.reasoningEffort, permissionMode: input.permissionMode ?? agent.permissionMode, systemPrompt: agent.systemPrompt };
      if (Object.entries(expected).some(([key, value]) => (existing[key as keyof Session] ?? undefined) !== (value ?? undefined))) throw new RuntimeError('BACKGROUND_SESSION_CONFLICT', 'Background session immutable configuration changed', 409);
      return existing;
    }
    // Recheck after the asynchronous reads before reserving the stable identity.
    const raced = this.backgroundStarts.get(stableSessionId);
    if (raced) { await raced; return this.startBackgroundSession(input, stableSessionId, beforeStart); }
    const start = this.startSession(input, { id: stableSessionId, beforeStart });
    this.backgroundStarts.set(stableSessionId, start);
    try { return await start; } finally { if (this.backgroundStarts.get(stableSessionId) === start) this.backgroundStarts.delete(stableSessionId); }
  }

  /** A persisted stopped flag alone is not evidence that a previous process stopped. */
  async stopWorkItemSession(sessionId: string, actor: ExecutionActor): Promise<boolean> {
    this.assertReady();
    const session = await this.repos.sessions.get(sessionId);
    if (session?.source !== 'work_item') throw new RuntimeError('INVALID_WORK_SESSION', 'Not a work-item session', 409);
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
        preparationOwner.revoke();
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
    const workspaceMode = input.workspaceMode ?? 'shared';
    const initialConfigured = { ...agent, cwd: sourceCwd, model: input.model ?? agent.model, reasoningEffort: input.reasoningEffort ?? agent.reasoningEffort, permissionMode: input.permissionMode ?? agent.permissionMode };
    const capability = (this.options.probe ?? probeAgent)(initialConfigured, this.options.acpxCommand);
    if (!capability.available) throw new RuntimeError('AGENT_UNAVAILABLE', capability.detail ?? 'Agent unavailable', 503);
    if (capability.protocol === 'pty') {
      throw new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'Legacy PTY transport cannot enforce a permission posture or expose interactive approval; use an ACP or PTY CLI Agent', 422);
    }
    if (capability.protocol === 'pty-cli' && initialConfigured.permissionMode !== 'ask' && initialConfigured.permissionMode !== 'full-trust') {
      throw new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'PTY Agent only supports ask (approve in the terminal) or explicit full-trust mode', 422);
    }
    const session: Session = { id: owned?.id ?? makeId('ses'), agentId: agent.id, state: 'created', cwd: sourceCwd, workspaceMode, model: initialConfigured.model, reasoningEffort: initialConfigured.reasoningEffort, permissionMode: initialConfigured.permissionMode, source: input.source, sourceId: input.sourceId, protocol: capability.protocol, runId: makeId('run'), createdAt: now(), updatedAt: now(), systemPrompt: agent.systemPrompt };
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
      const message = error instanceof Error ? error.message : String(error);
      session.state = 'failed'; session.error = message; session.updatedAt = now();
      await this.saveState(session, 'failed', message);
      await this.artifact('saveError', session.id, message);
      throw new RuntimeError('WORKSPACE_PREPARATION_FAILED', `Session ${session.id}: ${message}`, 422);
    }
    await this.mutations.wait(() => owned?.beforeStart() ?? Promise.resolve());
    await this.saveState(session, 'starting');
    try {
      await this.reconnect(session);
      await this.mutations.wait(() => owned?.beforeStart() ?? Promise.resolve());
      await this.saveState(session, 'idle'); return session;
    } catch (error) {
      if (error instanceof RevokedOperation) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const driver = this.drivers.get(session.id);
      try { if (driver) await this.stopDriver(session.id, driver, true); } catch { /* Retain resource block and original failure. */ }
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
    const driver = this.drivers.get(id);
    return { session, driver };
  }

  private async observeAbandonedResources(session:Session) {
    const f=this.fence(session);
    for(const resource of this.repos.execution.getResources(session.id)) {
      if(resource.runId!==f.runId)continue;
      if(resource.kind==='operation'&&resource.creationProvenance&&!resource.creationClosure&&['pending','unknown'].includes(resource.stage)) {
        try{this.bound().closeAbandonedCreation(f,resource.resourceId,resource.revision);}catch(error){if(!(error instanceof RuntimeError&&error.code==='RESOURCE_CREATOR_NOT_PROVEN_DEAD'))throw error;}
      } else if(resource.kind==='process'&&resource.identity&&resource.observations.at(-1)?.state!=='gone') {
        this.bound().probePhysicalResource(f,resource.resourceId,resource.revision);
      }
    }
    for(const resource of this.repos.execution.getResources(session.id)) {
      if(resource.runId!==f.runId||resource.purpose!=='acp_native_context'||resource.stage!=='pending'||resource.nativeReplacement||!resource.nativeExpected)continue;
      let identity:Awaited<ReturnType<typeof readNativeCreationRecord>>;
      try{identity=await this.mutations.wait(()=>readNativeCreationRecord(resource.nativeExpected!));}
      catch(error){if(error instanceof RevokedOperation)throw error;await this.emit(session.id,'error',{code:'NATIVE_CONTEXT_RECEIPT_UNVERIFIABLE',resourceId:resource.resourceId,message:'The original native creation receipt cannot be verified; its pending resource is retained'});continue;}
      if(identity){try{this.bound().confirmRecoveredNativeContext(f,resource.resourceId,resource.revision,identity);}catch(error){if(!(error instanceof RuntimeError&&error.code==='SESSION_RESOURCE_BLOCKED'))throw error;}}
    }
  }
  async probeNativeResources(id:string,actor:ExecutionActor) {
    this.assertReady();
    if(this.lifecycle(id).revoked){this.mutations.run(undefined,()=>this.assertReplaceable(id));this.lifecycles.set(id,owner(id,this.transition(id)));}
    return this.scoped(id,async()=>{const {session}=await this.active(id);this.bound().authorizeNativeContextControl(this.fence(session),actor);await this.authorize(id,actor.kind==='unspecified'?undefined:actor.id);await this.observeAbandonedResources(session);return this.repos.execution.getSessionResourceBlockers(id);});
  }
  async replaceNativeContext(id:string,actor:ExecutionActor,resourceId:string,expectedRevision:number,decisionId:string,expectedRunId?:string) {
    if(expectedRunId!==undefined)this.requireRecoveryOwner(actor);
    return this.prepareNativeContext(id,actor,{resourceId,expectedRevision,decisionId},expectedRunId);
  }
  async restoreNativeConfiguration(id:string,actor:ExecutionActor) { return this.prepareNativeContext(id,actor); }
  private async prepareNativeContext(id:string,actor:ExecutionActor,replacement?:{resourceId:string;expectedRevision:number;decisionId:string},expectedRunId?:string) {
    this.assertReady();
    const original=await this.repos.sessions.get(id);if(!original)throw new RuntimeError('SESSION_NOT_FOUND','Unknown Session',404);
    if(expectedRunId!==undefined&&original.runId!==expectedRunId)throw new RuntimeError('SESSION_RUN_CONFLICT','Session run changed',409);
    this.bound().authorizeNativeContextControl(this.fence(original),actor);await this.authorize(id,actor.kind==='unspecified'?undefined:actor.id);
    if(!replacement&&!await this.repos.config.get(`runtime_driver_configuration:${id}`))throw new RuntimeError('DRIVER_CONFIGURATION_REPAIR_NOT_REQUIRED','No configuration blocker exists',409);
    if(expectedRunId!==undefined&&(await this.repos.sessions.get(id))?.runId!==expectedRunId)throw new RuntimeError('SESSION_RUN_CONFLICT','Session run changed',409);
    // Retain queued requests and unknown submitted Attempts. This operation never prompts.
    try{await this.revokeSession(id,false,'stopped');}catch(error){
      const blockers=this.repos.execution.getSessionResourceBlockers(id);
      if(!replacement||!(error instanceof RuntimeError&&error.code==='SESSION_RESOURCE_BLOCKED')||!blockers.length||blockers.some(block=>block.resourceId!==replacement.resourceId))throw error;
    }
    const transition=this.transition(id),lifecycle=owner(id,transition);this.lifecycles.set(id,lifecycle);
    return this.mutations.run(lifecycle,async()=>{
      const {session}=await this.active(id);
      if(expectedRunId!==undefined&&session.runId!==expectedRunId)throw new RuntimeError('SESSION_RUN_CONFLICT','Session run changed',409);
      this.bound().authorizeNativeContextControl(this.fence(session),actor);this.assertReplaceable(id);
      if(replacement)await this.mutations.write(id,async()=>this.bound().replaceNativeContext(this.fence(session),{...replacement,actor}));
      this.assertResources(id);
      const expected=await this.mutations.wait(()=>this.repos.config.get(`runtime_driver_configuration:${id}`));
      if(!replacement&&!this.repos.execution.getNativeContext(id))throw new RuntimeError('NATIVE_CONTEXT_PROOF_REQUIRED','The original native context is required',409);
      const unresolved=(await this.mutations.wait(()=>this.repos.tasks.listBySession(id))).some(task=>this.repos.execution.getTaskExecution(task.id)?.attempts.some(attempt=>['preparing','active','reconcile_required','legacy_unresolved'].includes(attempt.state)));
      const agent=await this.mutations.wait(()=>this.repos.agents.get(session.agentId));if(!agent)throw new RuntimeError('AGENT_NOT_FOUND','Unknown agent',404);
      const configured=this.configureAgentForSession(agent,session),target:ExecutionOptions={permissionMode:configured.permissionMode,...(configured.model!==undefined?{model:configured.model}:{}),...(configured.reasoningEffort!==undefined?{reasoningEffort:configured.reasoningEffort}:{})};
      if(!unresolved)await this.saveState(session,'starting');
      let driver:AgentDriver|undefined;
      let operation:Awaited<ReturnType<DriverConfigurationLedger['beginRepair']>>|undefined;
      try {
        driver=await this.reconnect(session,true,target,Boolean(expected));
        if(!expected){if(!unresolved)await this.saveState(session,'idle');return session;}
        const owned=this.localResources.get(driver)!;
        if(!owned.controlled||!driver.configureNative)throw new RuntimeError('NATIVE_CONFIGURATION_REPAIR_UNSUPPORTED','Driver cannot prove original-context configuration',422);
        operation=await this.mutations.write(id,()=>this.configurations.beginRepair(id,owned.identityId,target,expected,actor));
        const nativeTarget={...(target.model!==undefined?{model:target.model}:{}),...(target.reasoningEffort!==undefined?{reasoningEffort:target.reasoningEffort}:{})};
        const proof=await this.driverOperation(driver,()=>driver!.configureNative!({operationId:operation!.operationId,target:nativeTarget}));
        await this.mutations.write(id,async()=>{
          this.mutations.check(lifecycle);this.bound().authorizeNativeContextControl(this.fence(session),actor);
          if(this.drivers.get(id)!==driver||proof.driverInstanceId!==owned.identityId||proof.operationId!==operation!.operationId||canonicalExecutionJson(proof.target)!==canonicalExecutionJson(nativeTarget)||canonicalExecutionJson(proof.context)!==canonicalExecutionJson(this.repos.execution.getNativeContext(id)?.selection.context))throw new RuntimeError('DRIVER_CONFIGURATION_UNKNOWN','Native configuration proof no longer belongs to this operation',409);
          owned.options={...target};await this.configurations.finish(operation!,true);
        });
        if(!unresolved)await this.saveState(session,'idle');return session;
      } catch(error) {
        if(operation)await this.mutations.run(undefined,()=>this.mutations.write(id,()=>this.configurations.finish(operation!,false))).catch(()=>{});
        if(driver)await this.mutations.run(undefined,()=>this.stopDriver(id,driver!)).catch(()=>{});
        throw error;
      }
    });
  }

  private async reconnect(session: Session, start = true, executionOptions?: ExecutionOptions, repairConfiguration = false) {
    this.mutations.check(); this.assertVerificationRecoverySafe(session.id);
    if(!repairConfiguration)await this.mutations.wait(() => this.configurations.assertClear(session.id));
    await this.loadStopBlock(session.id); this.assertReplaceable(session.id);
    this.assertResources(session.id, true);
    const existing = this.drivers.get(session.id);
    if (existing) return existing;
    const agent = await this.mutations.wait(() => this.repos.agents.get(session.agentId));
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', 'Unknown agent', 404);
    const workspace = await this.mutations.wait(() => this.workspaces.get(session.id));
    if (workspace) await this.mutations.wait(() => this.workspaces.validate(workspace));
    this.assertReplaceable(session.id); this.assertResources(session.id, true);
    const connected = this.drivers.get(session.id); if (connected) return connected;
    const configured = this.configureAgentForSession(agent, session);
    const options: ExecutionOptions = executionOptions ?? { permissionMode: configured.permissionMode, ...(configured.model !== undefined ? { model: configured.model } : {}), ...(configured.reasoningEffort !== undefined ? { reasoningEffort: configured.reasoningEffort } : {}) };
    const generation = this.nextSessionGeneration(session.id), lifecycle = this.lifecycle(session.id),startupOwner=this.mutations.current();
    const resource = this.localResources.begin(this.fence(session), options, this.factory.controlledResources?.(session.protocol!) ? {startupValid:()=>this.mutations.valid(startupOwner),valid:()=>this.mutations.valid(lifecycle)&&this.sessionGenerations.get(session.id)===generation,repairConfiguration,executionDomain:`${session.source ?? 'local'}:${session.sourceId ?? ''}`} : undefined);
    let driver:AgentDriver;
    try {driver = this.factory({ ...configured, model: options.model, reasoningEffort: options.reasoningEffort, permissionMode: options.permissionMode }, session.protocol!, this.onDriverEvent(session, generation), code => {
      if (!this.mutations.valid(lifecycle) || this.sessionGenerations.get(session.id) !== generation) return;
      this.notifyDriverExit(session.id, code);
      // An executing turn owns its result. A lifecycle exit never overwrites it.
      if (code && !this.attempts.has(session.id)) void this.mutations.run(lifecycle, () => this.saveState(session, 'failed', `Agent exited with code ${code}`)).catch(() => {});
    }, session.id, resource.context);} catch(error) {
      if(resource.controlled){
        const cleanup=resource.controlled.abortFactory();this.factoryCleanups.set(session.id,cleanup);
        const release=()=>{if(this.factoryCleanups.get(session.id)===cleanup)this.factoryCleanups.delete(session.id);};
        void cleanup.then(release,release);
        try{await cleanup;}catch{/* Keep the failed factory and durable resource evidence. */}
      }
      this.mutations.check();throw error;
    }
    this.drivers.set(session.id, driver);
    let startBegan = false;
    try {
      this.localResources.returned(resource, driver);
      if (start) {
        startBegan = true;
        const starting = Promise.resolve().then(() => driver.start());
        const settled = starting.then(async () => {
          this.localResources.settled(driver);
          await this.mutations.run(undefined, () => this.mutations.write(session.id, async () => this.localResources.ready(driver)));
        }, error => { this.localResources.settled(driver); throw error; });
        await this.driverOperation(driver, () => settled);
      } else this.localResources.settled(driver);
      if(resource.controlled&&start&&!repairConfiguration) {
        const actual=driver.nativeConfiguration?.();
        if(actual)resource.options={permissionMode:options.permissionMode,...actual};
        await this.changeDriverConfiguration(session,driver,()=>options,undefined,true);
      }
      this.mutations.check(); this.touch(session.id); return driver;
    } catch (error) {
      if (!startBegan) this.localResources.settled(driver);
      if (this.mutations.valid()) {
        const reason = 'Driver startup is unresolved; original resource cleanup must finish before replacement';
        this.blockedDrivers.set(session.id, { driver, reason }); await this.retainStopBlock(session.id, reason);
      }
      throw error;
    }
  }
  private async stopDriver(id: string, driver: AgentDriver, discardSession = false) {
    this.localResources.get(driver)?.controlled?.revoke();
    let stopError: unknown;
    try { await driver.stop(discardSession ? { discardSession: true } : undefined); } catch (error) { stopError = error; }
    while (this.driverOperations.get(driver)?.size) await Promise.allSettled([...this.driverOperations.get(driver)!]);
    const proven = await driver.isStopped?.() === true;
    if (!proven) {
      const reason = stopError instanceof Error ? stopError.message : 'Driver physical resource exit is unverified';
      this.blockedDrivers.set(id, { driver, reason }); await this.retainStopBlock(id, reason);
      throw new RuntimeError('DRIVER_STOP_UNVERIFIED', reason, 409);
    }
    await this.mutations.write(id, async () => this.localResources.gone(driver));
    await this.clearStopBlock(id);
    if (this.drivers.get(id) === driver) this.drivers.delete(id);
    this.blockedDrivers.delete(id);
  }
  private async applyRiskPolicy(session: Session, driver: AgentDriver | undefined, policy?: ToolRiskPolicy) {
    if (this.options.resolveRiskPolicy) policy = await this.mutations.wait(() => this.options.resolveRiskPolicy!(session.id, policy));
    this.mutations.check();
    await this.mutations.write(session.id, async () => { driver?.setRiskPolicy?.(policy); });
    const directory = join(session.cwd, '.dutydeck', 'security', 'sessions');
    await this.mutations.wait(() => mkdir(directory, { recursive: true }));
    await this.mutations.write(session.id, async () => {
      await writeFile(join(directory, `${session.id}.json`), JSON.stringify(policy ?? { enabled: false }), { mode: 0o600 });
    });
  }

  private runTask(id: string, task: TaskRecord, attempt: TaskAttempt, token: Owner) {
    this.attemptRefs.set(token, { sessionId: id, runId: attempt.runId, taskId: task.id, attemptId: attempt.attemptId });
    this.attempts.set(id, token); this.activeTasks.set(id, task);
    const run = this.mutations.run(token, () => this.executeTask(id, task));
    this.taskRuns.add(run);
    const cleanup = () => { this.taskRuns.delete(run); };
    void run.then(cleanup, cleanup); return run;
  }
  private acceptedInput(task: TaskRecord): AcceptedTaskInputV2 {
    // The original request is read from the accepted row, never regenerated from mutable defaults.
    const accepted = this.repos.execution.getAcceptedTask(task.id)?.input;
    if (!accepted || accepted.version !== 2) throw new RuntimeError('INPUT_OPTIONS_UNVERIFIABLE', 'This task has no frozen execution options; cancel it and send a complete new request', 409);
    return accepted;
  }
  private async changeDriverConfiguration(session: Session, driver: AgentDriver, targetOptions: (current: ExecutionOptions) => ExecutionOptions, defaults?: Partial<ExecutionOptions>, forceNativeProof=false) {
    const token = this.mutations.current();
    const owned = this.localResources.get(driver);
    if (!owned) throw new RuntimeError('DRIVER_RESOURCE_MISSING', 'The existing driver has no resource owner', 409);
    const operation = await this.mutations.write(session.id, async () => {
      await this.configurations.assertClear(session.id); this.mutations.check();
      if (this.drivers.get(session.id) !== driver || this.attempts.has(session.id) && this.attempts.get(session.id) !== token) throw new RuntimeError('TURN_IN_PROGRESS', 'Another Attempt owns this driver', 409);
      if (this.driverOperations.get(driver)?.size || this.permissionsForSession(session.id).length) throw new RuntimeError('DRIVER_CONFIGURATION_BUSY', 'A previous driver operation has not finished', 409);
      const target = targetOptions(owned.options);
      if (canonicalExecutionJson(owned.options) === canonicalExecutionJson(target)&&!forceNativeProof) {
        if (defaults) Object.assign(session, await this.patchSession(session.id, defaults));
        return undefined;
      }
      if (owned.options.permissionMode !== target.permissionMode && !driver.setPermissionMode || !driver.configureNative && (owned.options.model !== target.model && (!target.model || !driver.setModel)
        || owned.options.reasoningEffort !== target.reasoningEffort && (!target.reasoningEffort || !driver.setReasoningEffort))) throw new RuntimeError('TASK_OPTIONS_UNSUPPORTED', 'This driver cannot prove a context-preserving configuration reset before submission', 422);
      return this.configurations.begin(session.id, owned.identityId, target);
    });
    if (!operation) return;
    const changing = (async () => {
      try {
        this.mutations.check(token);
        const target = operation.target;
        if (owned.options.permissionMode !== target.permissionMode) driver.setPermissionMode!(target.permissionMode);
        if(owned.controlled&&driver.configureNative) {
          const nativeTarget={...(target.model!==undefined?{model:target.model}:{}),...(target.reasoningEffort!==undefined?{reasoningEffort:target.reasoningEffort}:{})};
          const proof=await driver.configureNative({operationId:operation.operationId,target:nativeTarget});
          const selected=this.repos.execution.getNativeContext(session.id);
          if(!selected||proof.operationId!==operation.operationId||proof.driverInstanceId!==owned.controlled.driverInstanceId||canonicalExecutionJson(proof.context)!==canonicalExecutionJson(selected.selection.context)||canonicalExecutionJson(proof.target)!==canonicalExecutionJson(nativeTarget))throw new RuntimeError('DRIVER_CONFIGURATION_UNKNOWN','Configuration ACK does not identify the original operation and target',409);
        } else {
          if (owned.options.model !== target.model) await driver.setModel!(target.model!);
          this.mutations.check(token);
          if (owned.options.reasoningEffort !== target.reasoningEffort) await driver.setReasoningEffort!(target.reasoningEffort!);
        }
        await this.mutations.write(session.id, async () => {
          this.mutations.check(token);
          if (this.drivers.get(session.id) !== driver || this.localResources.get(driver)?.identityId !== operation.driverIdentity) throw new RuntimeError('DRIVER_CONFIGURATION_UNKNOWN', 'Original driver identity changed during configuration', 409);
          // Keep pending durable until defaults and the exact confirmed in-memory options agree.
          if (defaults) Object.assign(session, await this.patchSession(session.id, defaults));
          owned.options = { ...target };
          await this.configurations.finish(operation, true);
        });
      } catch (error) {
        await this.mutations.run(undefined, () => this.mutations.write(session.id, () => this.configurations.finish(operation, false)));
        throw error;
      }
    })();
    await this.observeDriverOperation(driver, changing);
  }
  private async configureTaskDriver(session: Session, options: ExecutionOptions) {
    await this.mutations.wait(() => this.configurations.assertClear(session.id));
    const existing = this.drivers.get(session.id);
    if (session.protocol === 'pty-cli' && !['ask', 'full-trust'].includes(options.permissionMode)) throw new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'PTY CLI cannot enforce the requested permission mode', 422);
    if (!existing) return this.reconnect(session, true, options);
    const owned=this.localResources.get(existing);
    if(owned?.controlled&&owned.options.permissionMode!==options.permissionMode){await this.stopDriver(session.id,existing);this.mutations.check();return this.reconnect(session,true,options);}
    await this.flushDriverEvents(session.id);
    await this.changeDriverConfiguration(session, existing, () => options);
    return existing;
  }
  private permissionsForSession(id: string) { return [...this.permissions.values()].filter(permission => permission.fence.sessionId === id); }
  private async executeTask(id: string, task: TaskRecord) {
    const token = this.mutations.current()!;
    const ref = this.attemptRefs.get(token)!;
    this.activeTurns.add(id); this.completedTurns.delete(ref.attemptId);
    try {
      const { session } = await this.active(id);
      const input = this.acceptedInput(task);
      await this.authorize(id, task.executionContext?.actorId, true);
      await this.mutations.wait(() => this.options.authorizeTask?.(session, task, 'prepare') ?? Promise.resolve());
      const driver = await this.configureTaskDriver(session, input.executionOptions);
      await this.applyRiskPolicy(session, driver, task.executionContext?.riskPolicy);
      const prompt = await this.mutations.wait(() => Promise.resolve(this.options.sessionPrompt?.(session, input.executionContext.agentPrompt) ?? input.executionContext.agentPrompt));
      const submissionId = makeId('submission');
      const controlled=this.localResources.get(driver)?.controlled;
      const submissionInput=Object.freeze({taskId:ref.taskId,attemptId:ref.attemptId,submissionId,prompt,executionOptions:Object.freeze({...input.executionOptions})});
      if(controlled&&driver.prepareTurn){
        const operation=controlled.beginPreparation(()=>this.mutations.valid(token));
        await this.driverOperation(driver,async()=>{
          try { await driver.prepareTurn!(submissionInput,operation); }
          finally { controlled.endPreparation(operation); }
        });
      }
      await this.authorize(id, task.executionContext?.actorId, true);
      await this.mutations.wait(() => this.options.authorizeTask?.(session, task, 'submit') ?? Promise.resolve());
      await this.flushDriverEvents(id);
      await this.emit(id, 'text', { text: task.prompt, role: 'user', taskId: task.id });
      this.mutations.check();
      let prepared:ReturnType<NonNullable<AgentDriver['prepareSubmission']>>|undefined;
      await this.mutations.write(id, async () => {
        await this.configurations.assertClear(id); this.mutations.check();
        const recovery = controlled ? undefined : driver.checkpoint?.();
        prepared = controlled ? driver.prepareSubmission?.(submissionInput) : undefined;
        if (controlled && !prepared) throw new RuntimeError('DRIVER_SUBMISSION_UNSUPPORTED','Controlled driver must freeze its submission',409);
        this.wake(this.bound().markSubmissionPending(this.attemptFence(ref), { submissionId, inputDigest: prepared?.inputDigest ?? digest({ prompt, executionOptions: input.executionOptions }), resourceRefs: prepared?.resourceRefs ?? this.localResources.refs(driver), authorizationRefs: [], ...(controlled?{driverInstanceId:controlled.driverInstanceId}:{}),...(prepared?.nativeContextRef ? {nativeContextRef:prepared.nativeContextRef,contextProofId:prepared.contextProofId}:{}), ...(prepared?.recovery || recovery ? { recovery:prepared?.recovery ?? recovery } : {}) }));
      });
      if (controlled && prepared) {
        const operation=controlled.beginSubmission(prepared), frozen=prepared;
        await this.driverOperation(driver,async()=>{
          try {await driver.send(Object.freeze({...frozen,operation,onAccepted:(receipt:import('@dutydeck/shared').SubmissionReceipt)=>{this.wake(this.bound().markSubmitted(this.attemptFence(ref),receipt));}}));}
          finally {controlled.endSubmission(operation);}
        });
      } else await this.driverOperation(driver, () => driver.send(prompt));
      await this.flushDriverEvents(id);
      if (!this.completedTurns.has(ref.attemptId)) throw new RuntimeError('DRIVER_RESULT_INCOMPLETE', 'Driver returned without a completed result', 409);
      const result = this.turnOutput(ref);
      await this.mutations.write(id, async () => this.wake(this.bound().settleAttempt(this.attemptFence(ref), `settlement:${submissionId}`, { kind: 'driver_result', submissionId, outcome: result.status, outputDigest: result.outputDigest, stopReason: result.stopReason, complete: true })));
    } catch (error) {
      // Stop owns revoked attempts and retains its claim until this cleanup finishes.
      if (this.mutations.valid(token)) {
        await this.flushDriverEvents(id).catch(() => {});
        await this.mutations.write(id, async () => {
          const attempt = this.repos.execution.getTaskExecution(task.id)?.attempts.find(item => item.attemptId === ref.attemptId);
          if (!attempt || attempt.state === 'settled') return;
          if (attempt.submissionState === 'not_submitted') this.wake(this.bound().settleAttempt(this.attemptFence(ref), `preparation:${ref.attemptId}`, { kind: 'not_submitted', outcome: isTaskFenceRevocation(error) ? 'cancelled' : 'failed', reason: error instanceof Error ? error.message : String(error) }));
          else this.wake(this.bound().markReconcileRequired(this.attemptFence(ref), { reasonId: `unknown:${ref.attemptId}`, code: error instanceof RuntimeError || error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? String(error.code) : 'DRIVER_RESULT_UNKNOWN', evidenceRefs: [] }));
        });
      }
    } finally {
      if (this.attempts.get(id) === token) {
        this.attempts.delete(id); this.activeTurns.delete(id); this.activeTasks.delete(id);
        token.revoke(); this.touch(id);
      }
      this.completedTurns.delete(ref.attemptId); this.driverStopReasons.delete(ref.attemptId); this.turnErrors.delete(ref.attemptId);
      this.attemptTools.delete(ref.attemptId);
    }
    return this.publicTask(this.repos.execution.getTaskExecution(task.id)?.task ?? task);
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
        if (error) reject(error); else resolve(value!);
      };
      const inspect = () => {
        try {
          const value = this.repos.execution.getTaskExecution(task.id);
          // The first execution remains this send's result even after an explicit retry.
          const selected = selectedAttemptId ? value?.attempts.find(attempt => attempt.attemptId === selectedAttemptId) : value?.attempts.find(attempt => attempt.number === 1);
          selectedAttemptId ??= selected?.attemptId;
          if (value && selected && ['settled', 'reconcile_required', 'legacy_unresolved'].includes(selected.state)) {
            const status = selected.state === 'settled' && selected.outcome !== 'unknown' ? selected.outcome : 'reconcile_required';
            finish(undefined, { ...this.publicTask(value.task), currentAttemptId: selected.attemptId, status: status ?? 'reconcile_required' });
          } else if (value?.task.status === 'cancelled' && !selected) finish(undefined, this.publicTask(value.task));
          else if (this.shuttingDown) finish(new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Task remains durable for recovery', 409));
        } catch (error) { finish(error); }
      };
      this.sendWaiters.add(inspect);
      try { unsubscribe = this.publisher.subscribe(id, inspect, { afterSequence: 0 }); inspect(); }
      catch (error) { finish(error); }
    });
  }

  async dispatch(id: string, prompt: string, mode: 'queue' | 'interrupt' = 'queue', agentPrompt = prompt, riskPolicy?: ToolRiskPolicy, actorId?: string, idempotencyKey?: string, skillRequests?: string[], supplied?: TaskRequestV1) {
    this.assertReady();
      const stored = await this.repos.sessions.get(id);
      this.assertReady();
      if (!stored) throw new RuntimeError('SESSION_NOT_FOUND', 'Session is missing', 404);
      const request: TaskRequestV1 = supplied ?? { version: 1, namespace: 'runtime', sessionId: id, key: idempotencyKey ?? makeId('request'), actor: this.actor(stored, actorId), prompt, mode, skills: skillRequests ?? [], options: {}, sources: [], sourcePayload: { agentPrompt, ...(riskPolicy ? { riskPolicy: JSON.parse(canonicalExecutionJson(riskPolicy)) } : {}), skills: skillRequests ?? [] } };
      canonicalExecutionJson(request); taskRequestV1Schema.parse(request);
      const explicitActor = actorId ?? undefined;
      const requestActor = request.actor.kind === 'unspecified' ? undefined : request.actor.id;
      if (request.sessionId !== id || request.prompt !== prompt || request.mode !== mode || idempotencyKey !== undefined && request.key !== idempotencyKey || canonicalExecutionJson(request.skills) !== canonicalExecutionJson(skillRequests ?? []) || explicitActor !== requestActor) throw new RuntimeError('TASK_REQUEST_MISMATCH', 'Explicit dispatch arguments differ from the immutable request', 409);
      const existing = this.lookupAcceptedTask(request);
      if (existing) {
        if (this.mutations.valid(this.lifecycle(id)) && !stored.archivedAt && stored.state !== 'stopped') {
          await this.scoped(id, async () => {
            this.rememberQueued(existing.task); this.queueBlocked.delete(id);
            try { await this.projectQueue(id); await this.applyQueueActions(stored); }
            finally { this.scheduleQueue(id); }
          });
        }
        return { ...this.publicTask(existing.task), replayed: true, queuedAhead: 0 };
      }
    return this.scoped(id, async () => {
      const { session } = await this.active(id);
      await this.authorize(id, actorId);
      const agent = await this.mutations.wait(() => this.repos.agents.get(session.agentId));
      if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', 'Agent is missing', 404);
      const executionOptions: ExecutionOptions = { permissionMode: request.options.permissionMode ?? session.permissionMode ?? agent.permissionMode,
        ...((request.options.model ?? session.model ?? agent.model) !== undefined ? { model: request.options.model ?? session.model ?? agent.model } : {}),
        ...((request.options.reasoningEffort ?? session.reasoningEffort ?? agent.reasoningEffort) !== undefined ? { reasoningEffort: request.options.reasoningEffort ?? session.reasoningEffort ?? agent.reasoningEffort } : {}) };
      if (request.actor.kind === 'unspecified' && executionOptions.permissionMode === 'full-trust' && session.permissionMode !== 'full-trust') throw new RuntimeError('ACTOR_REQUIRED', 'An unspecified actor cannot enable full trust', 403);
      const prepared = await this.mutations.wait(() => this.prepareTask(session, agentPrompt, skillRequests));
      const content = { version: 2 as const, prompt, executionContext: this.executionContext(prepared.agentPrompt, riskPolicy, actorId, prepared.skillDeliveries), contentSources: [], executionOptions };
      const accepted = await this.mutations.write(id, async () => {
        const committed = this.wake(this.bound().acceptTask(this.fence(session), request, { ...content, digest: digest(content) }, mode === 'interrupt' ? 'front' : 'back'));
        if (committed.task) this.rememberQueued(committed.task);
        return committed;
      });
      if (!accepted.task) throw new RuntimeError('TASK_ACCEPTANCE_MISSING', 'The committed task is missing', 500);
      this.verificationDeferredTasks.get(id)?.add(accepted.task.id);
      if (!accepted.replayed && accepted.task.id !== executionTaskId(request.namespace, id, request.key)) throw new RuntimeError('TASK_ID_MISMATCH', 'Accepted task identity differs from its request', 500);
      this.queueBlocked.delete(id);
      try { await this.projectQueue(id); await this.applyQueueActions(session); }
      finally { this.scheduleQueue(id); }
      return { ...this.publicTask(accepted.task), replayed: accepted.replayed, queuedAhead: Math.max(0, (this.queues.get(id)?.length ?? 1) - 1) };
    });
  }

  private rememberQueued(task: TaskRecord) {
    // A committed Task keeps scheduling alive if the derived queue read fails. claimNext owns order.
    if (task.status !== 'queued') return;
    const queue = this.queues.get(task.sessionId) ?? [];
    if (!queue.some(item => item.id === task.id)) this.queues.set(task.sessionId, [...queue, task]);
  }
  private async queuedTasks(id: string) {
    return this.repos.tasks.listQueued ? this.repos.tasks.listQueued(id)
      : (await this.repos.tasks.listBySession(id)).filter(task => task.status === 'queued');
  }
  private async projectQueue(id: string) {
    const queue = await this.queuedTasks(id);
    this.mutations.check();
    if (queue.length) this.queues.set(id, queue); else this.queues.delete(id);
  }
  private scheduleQueue(id: string) {
    if (this.ptyRetirements.has(id) || this.shuttingDown || this.initializationFailed || this.queueBlocked.has(id) || this.stopRuns.has(id) || this.stopBlocks.has(id) || this.blockedDrivers.has(id) || !this.mutations.valid(this.lifecycle(id)) || this.drains.has(id) || this.attempts.has(id) || this.verifyingSessions.has(id)
      || this.blockedVerificationSessions.has(id) || !(this.queues.get(id)?.length)) return;
    const token = owner(id, this.lifecycle(id)); this.drains.set(id, token);
    const run = this.mutations.run(token, () => this.drainQueue(id)); this.queueRuns.set(id, run);
    const finish = () => {
      if (this.drains.get(id) !== token) return;
      this.drains.delete(id); token.revoke();
      if (this.queueRuns.get(id) === run) this.queueRuns.delete(id);
      this.mutations.run(undefined, () => this.scheduleQueue(id));
    };
    void run.then(finish, finish);
  }
  private async drainQueue(id: string) {
    while (this.mutations.valid() && !this.shuttingDown && !this.attempts.has(id) && !this.verifyingSessions.has(id)) {
      const session = await this.mutations.wait(() => this.repos.sessions.get(id));
      if (!session) return;
      let next: TaskRecord | undefined;
      try { next = (await this.queuedTasks(id))[0]; }
      catch { this.queueBlocked.add(id); return; }
      if (next && this.repos.execution.getAcceptedTask(next.id)?.input?.version !== 2) { this.queueBlocked.add(id); return; }
      let claimed: CommitResult | undefined;
      let token: Owner | undefined;
      try {
        await this.mutations.write(id, async () => {
          claimed = this.wakeOptional(this.bound().claimNext(this.fence(session)));
          if (claimed?.task && claimed.attempt) {
            token = owner(id, this.lifecycle(id));
            this.attemptRefs.set(token, { sessionId: id, runId: claimed.attempt.runId, taskId: claimed.task.id, attemptId: claimed.attempt.attemptId });
            this.attempts.set(id, token); this.activeTasks.set(id, claimed.task);
          }
        });
      } catch { this.queueBlocked.add(id); return; }
      if (!claimed?.task || !claimed.attempt || !token) { this.queues.delete(id); return; }
      // No await separates claiming the durable activity slot from registering its local owner.
      const running = this.runTask(id, claimed.task, claimed.attempt, token);
      await this.mutations.wait(() => running);
      await this.projectQueue(id);
      await this.applyQueueActions(session);
    }
  }
  private wakeOptional(result: CommitResult | undefined) { return result ? this.wake(result) : undefined; }
  private async applyQueueActions(session: Session) {
    for (const action of this.bound().getPendingQueueActions(this.fence(session))) {
      const target = action.target;
      if (!target) continue;
      const targetAttempt = this.repos.execution.getTaskExecution(target.taskId)?.attempts.find(item => item.attemptId === target.attemptId);
      const token = this.attempts.get(session.id);
      const ref = token && this.attemptRefs.get(token);
      if (targetAttempt?.state === 'settled') {
        this.bound().settleQueueAction(this.fence(session), action.operationId, action.revision, { evidenceId: `queue_settled:${action.operationId}`, state: 'applied', reason: 'original_attempt_settled', resourceChecks: [] });
      } else if (ref?.attemptId === target.attemptId && this.mutations.valid(token)) {
        await this.interruptOwnedAttempt(ref, token!, action.operationId);
      } else if (action.state === 'pending') this.bound().settleQueueAction(this.fence(session), action.operationId, action.revision, { evidenceId: `queue_blocked:${action.operationId}`, state: 'blocked', reason: 'original_attempt_not_owned', resourceChecks: [] });
    }
  }
  private async interruptOwnedAttempt(ref: AttemptRef & SessionFence, token: Owner, operationId: string) {
    const current = this.repos.execution.getTaskExecution(ref.taskId)?.attempts.find(attempt => attempt.attemptId === ref.attemptId);
    if (!current || current.state === 'settled' || this.attempts.get(ref.sessionId) !== token) return;
    const driver = this.drivers.get(ref.sessionId);
    if (current.submissionState !== 'not_submitted') {
      if (driver) await this.driverOperation(driver, () => driver.interrupt());
      return;
    }
    await this.mutations.write(ref.sessionId, async () => {
      const latest = this.repos.execution.getTaskExecution(ref.taskId)?.attempts.find(attempt => attempt.attemptId === ref.attemptId);
      if (!latest || latest.state === 'settled') return;
      if (latest.submissionState !== 'not_submitted') return;
      token.revoke();
      if (driver) this.blockedDrivers.set(ref.sessionId, { driver, reason: 'Interrupted preparation is still closing its original driver' });
      this.wake(this.bound().settleAttempt(this.attemptFence(ref), `interrupt_preparing:${operationId}`, { kind: 'not_submitted', outcome: 'cancelled', reason: 'interrupted_before_submission' }));
    });
    if (!token.revoked) { if (driver) await this.driverOperation(driver, () => driver.interrupt()); return; }
    if (driver) await this.stopDriver(ref.sessionId, driver);
    this.scheduleQueue(ref.sessionId);
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
        return this.wake(this.bound().cancelQueued(this.fence(session), taskId, expectedRevision ?? task.revision, { decisionId, actor: this.actor(session, actorId), action: 'cancel', evidenceRefs: ['runtime:queue-cancel'], resourceChecks: [] }));
      });
      const queue = this.queues.get(id);
      if (queue) {
        const next = queue.filter(item => item.id !== taskId);
        if (next.length) this.queues.set(id, next);
        else this.queues.delete(id);
      }
      try {
        await this.projectQueue(id);
      } catch {
        this.queueBlocked.add(id);
      }
      return this.publicTask(committed.task!);
    });
  }
  async steerQueued(id: string, taskId: string, actorId?: string, expectedRevision?: number, operationId = makeId('promote')) {
    return this.scoped(id, async () => {
      const { session } = await this.active(id);
      const task = this.repos.execution.getTaskExecution(taskId)?.task;
      if (!task) throw new RuntimeError('QUEUED_TASK_NOT_FOUND', 'Queued task is missing', 404);
      const committed = await this.mutations.write(id, async () => this.wake(this.bound().promoteQueued(this.fence(session), taskId, expectedRevision ?? task.revision, { operationId, actor: this.actor(session, actorId), interrupt: true })));
      await this.projectQueue(id); await this.applyQueueActions(session); this.queueBlocked.delete(id); this.scheduleQueue(id);
      return this.publicTask(committed.task!);
    });
  }
  private async cancelSessionQueue(id: string, suppliedActor?: ExecutionActor): Promise<boolean> {
    const session = await this.repos.sessions.get(id);
    if (!session) return true;
    const queued = await this.queuedTasks(id);
    const actor = executionActorSchema.parse(suppliedActor ?? { kind: 'unspecified' });
    if (queued.length && actor.kind === 'unspecified') return false;
    for (const task of queued) {
      const current = this.repos.execution.getTaskExecution(task.id)!.task;
      this.wake(this.bound().cancelQueued(this.fence(session), task.id, current.revision, { decisionId: `stop_cancel:${task.id}:${current.revision}`, actor, action: 'cancel', evidenceRefs: ['runtime:session-stop'], resourceChecks: [] }));
    }
    this.queues.delete(id); return true;
  }
  async interrupt(id: string, expectedTaskId?: string, actorId?: string, operationId = makeId('interrupt')) {
    return this.scoped(id, async () => {
      const { session, driver } = await this.active(id);
      const token = this.attempts.get(id), ref = token && this.attemptRefs.get(token);
      if (!ref) return { interrupted: false, reason: 'no_active_attempt' };
      if (expectedTaskId && expectedTaskId !== ref.taskId) throw new RuntimeError('TASK_NOT_ACTIVE', 'The requested task is no longer active', 409);
      await this.mutations.write(id, async () => this.wake(this.bound().recordInterruptIntent(this.attemptFence(ref), { operationId, actor: this.actor(session, actorId) })));
      if (this.attempts.get(id) === token) await this.interruptOwnedAttempt(ref, token!, operationId);
      return { interrupted: true };
    });
  }
  async setRiskPolicy(id: string, policy?: ToolRiskPolicy) {
    return this.scoped(id, async () => {
    const { session, driver } = await this.active(id);
    await this.applyRiskPolicy(session, driver, policy);
    });
  }
  async setModel(id: string, model: string) {
    return this.scoped(id, async () => {
    const normalized = model.trim();
    if (!normalized) throw new RuntimeError('INVALID_MODEL', 'Model must not be empty', 400);
    const { session } = await this.active(id);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response before switching models', 409);
    const driver = await this.reconnect(session);
    if (!driver.setModel) throw new RuntimeError('MODEL_SWITCH_UNSUPPORTED', `Agent ${session.agentId} does not support runtime model switching`, 422);
    try { await this.changeDriverConfiguration(session, driver, current => ({ ...current, model: normalized }), { model: normalized }); }
    catch (error) { throw new RuntimeError('MODEL_SWITCH_FAILED', error instanceof Error ? error.message : String(error), 422); }
    await this.emit(id, 'status', { state: session.state, model: normalized });
    return session;
    });
  }
  async setReasoningEffort(id: string, reasoningEffort: string) {
    return this.scoped(id, async () => {
    const normalized = reasoningEffort.trim();
    if (!normalized) throw new RuntimeError('INVALID_REASONING_EFFORT', 'Reasoning effort must not be empty', 400);
    const { session } = await this.active(id);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response before changing reasoning effort', 409);
    const driver = await this.reconnect(session);
    if (!driver.setReasoningEffort) throw new RuntimeError('REASONING_SWITCH_UNSUPPORTED', `Agent ${session.agentId} does not support runtime reasoning effort switching`, 422);
    try { await this.changeDriverConfiguration(session, driver, current => ({ ...current, reasoningEffort: normalized }), { reasoningEffort: normalized }); }
    catch (error) { throw new RuntimeError('REASONING_SWITCH_FAILED', error instanceof Error ? error.message : String(error), 422); }
    await this.emit(id, 'status', { state: session.state, reasoningEffort: normalized });
    return session;
    });
  }
  async pause(id: string) {
    return this.scoped(id, async () => {
      const { session } = await this.active(id);
      const agent = await this.mutations.wait(() => this.repos.agents.get(session.agentId));
      if (!agent?.capabilities.pause) throw new RuntimeError('UNSUPPORTED_CAPABILITY', 'Agent does not support pause', 422);
      this.mutations.check();
      return this.interrupt(id);
    });
  }
  async resume(id: string) {
    this.assertReady();
    if (this.lifecycle(id).revoked) {
      this.mutations.run(undefined, () => this.assertReplaceable(id));
      const transition = this.transition(id);
      this.lifecycles.set(id, owner(id, transition));
    }
    return this.scoped(id, async () => {
      const { session } = await this.active(id);
      const agent = await this.mutations.wait(() => this.repos.agents.get(session.agentId));
      if (!agent?.capabilities.resume) throw new RuntimeError('UNSUPPORTED_CAPABILITY', 'Agent does not support resume', 422);
      await this.mutations.wait(() => this.configurations.assertClear(id));
      await this.saveState(session, 'starting');
      const driver = await this.reconnect(session, false);
      const owned=this.localResources.get(driver),token=this.mutations.current();
      await this.driverOperation(driver, async () => {
        const operation=owned?.controlled?.beginResume(()=>this.mutations.valid(token));
        try { await driver.resume(operation); }
        finally { if(operation)owned!.controlled!.endPreparation(operation); }
      });
      this.localResources.ready(driver);
      const target=owned?.options;
      if(owned?.controlled&&target&&driver.nativeConfiguration){owned.options={permissionMode:target.permissionMode,...driver.nativeConfiguration()};await this.changeDriverConfiguration(session,driver,()=>target,undefined,true);}
      await this.saveState(session, 'idle');
      await this.projectQueue(id); this.queueBlocked.delete(id); this.scheduleQueue(id);
      return session;
    });
  }
  private revokeSession(id: string, cancelQueue: boolean, state: 'stopped' | 'interrupted', shutdown = false, discardSession = false, beforeResourceCleanup?: Promise<void>, actor?: ExecutionActor): Promise<void> {
    const pending = this.stopRuns.get(id);
    if (pending) { if (cancelQueue) this.stopIntents.get(id)!.cancelQueue = true; if (actor) this.stopIntents.get(id)!.actor = actor; return pending; }
    const intent = { cancelQueue, actor };  this.stopIntents.set(id, intent);
    const token = this.attempts.get(id), ref = token && this.attemptRefs.get(token);
    this.lifecycle(id).revoke(); token?.revoke(); this.drains.get(id)?.revoke();
    this.nextSessionGeneration(id);
    const driver = this.drivers.get(id) ?? this.blockedDrivers.get(id)?.driver;
    const run = this.mutations.run(undefined, async () => {
      // Start teardown before waiting for a turn which may be waiting on permission.
      const stopping = (async () => { await beforeResourceCleanup; await this.factoryCleanups.get(id); if (driver) await this.stopDriver(id, driver, discardSession); })();
      void stopping.catch(() => {});
      let factError: unknown;
      let actorRequired = false;
      try {
      await this.verifications.stopSession(id);
      await this.mutations.write(id, async () => {
        if (ref) {
          const attempt = this.repos.execution.getTaskExecution(ref.taskId)?.attempts.find(item => item.attemptId === ref.attemptId);
          if (attempt && !['settled', 'suspended'].includes(attempt.state)) {
            if (attempt.submissionState === 'not_submitted') {
              if (shutdown) this.wake(this.bound().suspendUnsubmitted(this.attemptFence(ref)));
              else this.wake(this.bound().settleAttempt(this.attemptFence(ref), `stop:${ref.attemptId}`, { kind: 'not_submitted', outcome: 'cancelled', reason: 'session_stop_before_submission' }));
            } else this.wake(this.bound().markReconcileRequired(this.attemptFence(ref), { reasonId: `stop_unknown:${ref.attemptId}`, code: 'STOP_RESULT_UNKNOWN', evidenceRefs: [] }));
          }
        }
        if (intent.cancelQueue) actorRequired = !await this.cancelSessionQueue(id, intent.actor);
        for (const [key, permission] of this.permissions) if (permission.fence.sessionId === id) {
          this.permissions.delete(key); this.permissionResolutions.delete(key);
        }
      });
      } catch (error) { factError = error; }
      let stopError: unknown;
      try { await stopping; } catch (error) { stopError = error; }
      while (this.driverEventChains.has(id)) await this.driverEventChains.get(id);
      if (!factError && intent.cancelQueue) actorRequired = !await this.mutations.write(id, () => this.cancelSessionQueue(id, intent.actor));
      await this.mutations.barrier(id);
      if (!shutdown && !stopError && !factError) {
        const session = await this.repos.sessions.get(id);
        const tasks = await this.repos.tasks.listBySession(id);
        const unresolved = tasks.some(task => this.repos.execution.getTaskExecution(task.id)?.attempts.some(attempt => ['active', 'preparing', 'reconcile_required', 'legacy_unresolved'].includes(attempt.state)));
        if (session && !unresolved) await this.saveState(session, state);
      }
      if (factError) throw factError;
      if (stopError) throw stopError;
      if (actorRequired) throw new RuntimeError('ACTOR_REQUIRED', 'Execution stopped; queued tasks remain until a named actor cancels them', 403);
    });
    this.stopRuns.set(id, run);
    const finish = () => { if (this.stopRuns.get(id) === run) this.stopRuns.delete(id); this.drains.delete(id); };
    void run.then(finish, finish); return run;
  }
  private async stopTransition(id: string, token: Owner, actor?: ExecutionActor) {
    const session = await this.repos.sessions.get(id);
    this.mutations.check(token);
    await this.mutations.run(token, () => this.loadStopBlock(id));
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
    // Validate every fallible identity check before signalling a process. A
    // rejected /new must not leave the current task stopped and its queue alive.
    if ((await this.queuedTasks(id)).length && (!actor || actor.kind === 'unspecified')) {
      throw new RuntimeError('ACTOR_REQUIRED', 'A named actor is required to stop a session with queued tasks', 403);
    }
    if (actor && actor.kind !== 'unspecified') {
      this.bound().authorizeNativeContextControl(this.fence(session), actor);
      if (actor.kind !== 'installation_owner') {
        if (this.options.authorizeControl) await this.options.authorizeControl(id, actor, 'stop');
        else await this.options.authorizeExecution?.(id, actor.id);
      }
    }
    await this.revokeSession(id, true, 'stopped', false, false, undefined, actor);
    this.mutations.check(token);
    if (this.resourceBlockers(id).length) throw new RuntimeError('SESSION_RESOURCE_BLOCKED', '原执行进程尚未确认安全停止；请联系管理员核对，当前会话未安全结束。', 409);
  }
  async stop(id: string, actor?: ExecutionActor) {
    this.assertReady();
    const token = this.transition(id);
    return this.stopTransition(id, token, actor);
  }
  async archive(id: string, actor?: ExecutionActor) {
    this.assertReady();
    const token = this.transition(id);
    await this.stopTransition(id, token, actor);
    return this.mutations.run(token, () => this.patchSession(id, { archivedAt: now() }));
  }
  async restart(id: string, actor?: ExecutionActor) {
    this.assertReady();
    this.assertVerificationRecoverySafe(id);
    const transition = this.transition(id);
    await this.stopTransition(id, transition, actor);
    this.mutations.check(transition);
    this.lifecycles.get(id)?.revoke();
    const token = owner(id, transition); this.lifecycles.set(id, token);
    return this.mutations.run(token, async () => {
      const { session } = await this.active(id);
      await this.mutations.wait(() => this.configurations.assertClear(id));
      this.assertReplaceable(id);
      const workspace = await this.mutations.wait(() => this.workspaces.get(id));
      if (workspace) {
        const prepared = await this.prepareWorkspace(id, workspace.sourceCwd, workspace.mode);
        Object.assign(session, await this.finalizeWorkspace(session));
      }
      const resources = this.repos.execution.getResources(id).filter(resource => resource.kind !== 'operation' && resource.purpose !== 'acp_native_context' && resource.stage !== 'not_created');
      Object.assign(session, this.bound().replaceSessionRun(this.fence(session), makeId('run'), resources.map(resource => ({ resourceId: resource.resourceId, expectedRevision: resource.revision, observationId: resource.observations.at(-1)!.observationId }))));
      await this.reconnect(session);
      await this.saveState(session, 'idle'); return session;
    });
  }
  async setPermissionMode(id: string, mode: PermissionMode) {
    return this.scoped(id, async () => {
    const { session, driver } = await this.active(id);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response before switching permissions', 409);
    // 已启动驱动不支持热切换时，不得只改数据库却让子进程继续沿用
    // 旧 argv；未连接会话可以先持久化，下次 reconnect 会按新姿态启动。
    if (driver && !driver.setPermissionMode) throw new RuntimeError('PERMISSION_MODE_SWITCH_UNSUPPORTED', `Agent ${session.agentId} does not support runtime permission switching`, 422);
    if (driver) await this.changeDriverConfiguration(session, driver, current => ({ ...current, permissionMode: mode }), { permissionMode: mode });
    else await this.mutations.write(id, async () => { await this.configurations.assertClear(id); Object.assign(session, await this.patchSession(id, { permissionMode: mode })); });
    return session;
    });
  }
  getPendingPermissions(sessionId: string): PermissionRequestData[] {
    if (!this.mutations.valid(this.lifecycle(sessionId)) || !this.drivers.get(sessionId)?.resolvePermission) return [];
    return [...this.permissions.entries()].filter(([key, pending]) => key.startsWith(sessionId + ':') && this.mutations.valid(pending.owner) && !this.permissionResolutions.has(key)).map(([, value]) => ({ ...value.request }));
  }

  async resolvePermission(sessionId: string, permissionId: string, approved: boolean) {
    return this.scoped(sessionId, async () => {
    const { driver } = await this.active(sessionId);
    const key = this.permissionKey(sessionId, permissionId);
    const pending = this.permissions.get(key);
    if (!pending) throw new RuntimeError('PERMISSION_NOT_FOUND', 'Permission request is no longer active', 404);
    if (this.permissionResolutions.has(key)) throw new RuntimeError('PERMISSION_RESOLVING', 'Permission decision is already being submitted', 409);
    if (!driver?.resolvePermission) throw new RuntimeError('PERMISSION_EXPIRED', 'The original approval driver is unavailable', 409);
    const claim = makeId('permission_claim'); this.permissionResolutions.set(key, claim);
    try {
      if (!this.mutations.valid(pending.owner) || pending.generation !== (this.sessionGenerations.get(sessionId) ?? 0) || this.permissions.get(key) !== pending) throw new RuntimeError('PERMISSION_EXPIRED', 'Permission request is no longer active', 409);
      const request = { ...pending.request, status: approved ? 'approved' as const : 'rejected' as const };
      // Keep the stored request pending while recording the requested decision.
      // A failed driver call must not be represented as an accepted decision.
      const intent = { ...pending.request, resolutionIntent: request.status };
      await this.artifact('savePermission', sessionId, intent);
      if (!this.mutations.valid(pending.owner) || this.permissionResolutions.get(key) !== claim || this.permissions.get(key) !== pending || this.drivers.get(sessionId) !== driver || pending.generation !== (this.sessionGenerations.get(sessionId) ?? 0)) {
        throw new RuntimeError('PERMISSION_EXPIRED', 'Permission request is no longer active', 409);
      }
      const resolved = await this.driverOperation(driver, () => driver.resolvePermission!(pending.nativeId, approved));
      if (!resolved || !this.mutations.valid(pending.owner) || this.drivers.get(sessionId) !== driver || pending.generation !== (this.sessionGenerations.get(sessionId) ?? 0)) {
        if (this.permissions.get(key) === pending) this.permissions.delete(key);
        throw new RuntimeError('PERMISSION_EXPIRED', 'Permission request is no longer active', 409);
      }
      // ACPX may synchronously emit its terminal permission update before its
      // resolve promise settles. That event is the canonical audit record.
      if (this.permissions.get(key) !== pending) return request;
      try {
        await this.mutations.write(sessionId, async () => {
          if (this.permissions.get(key) !== pending) return;
          this.mutations.check(pending.owner);
          this.permissions.delete(key); this.touch(sessionId);
          await this.eventScope.run(pending.fence, () => this.emit(sessionId, 'permission_request', request));
          await this.artifact('savePermission', sessionId, request).catch(() => {});
        });
      } catch (error) {
        throw new RuntimeError('PERMISSION_ACCEPTED_AUDIT_FAILED', `Permission accepted but audit delivery failed: ${error instanceof Error ? error.message : String(error)}`, 503);
      }
      // Subsequent driver events own the session state; an approval must not overwrite a completed turn.
      return request;
    } finally { if (this.permissionResolutions.get(key) === claim) this.permissionResolutions.delete(key); }
    });
  }

  private async cleanupIdleDriversOnce(at: number) {
    const timeout = this.options.driverIdleTimeoutMs ?? 6 * 60 * 60_000;
    if (timeout <= 0) return;
    for (const [sessionId, driver] of this.drivers) {
      if (this.attempts.has(sessionId) || at - (this.lastActivity.get(sessionId) ?? at) < timeout) continue;
      const lifecycle = this.lifecycle(sessionId);
      const session = await this.repos.sessions.get(sessionId);
      if (!session || this.drivers.get(sessionId) !== driver || this.lifecycle(sessionId) !== lifecycle || this.attempts.has(sessionId) || !['idle', 'completed', 'interrupted'].includes(session.state)) continue;
      const transition = this.transition(sessionId);
      try {
        await this.revokeSession(sessionId, false, 'interrupted');
        if (!this.shuttingDown && this.mutations.valid(transition) && this.lifecycle(sessionId) === lifecycle) this.lifecycles.set(sessionId, owner(sessionId, transition));
      }
      catch { /* Retain the resource block for an explicit stop retry. */ }
    }
  }

  async cleanupIdleDrivers(at = Date.now()) {
    this.assertReady();
    if (this.cleanupRun) return this.cleanupRun;
    const run = this.cleanupIdleDriversOnce(at); this.cleanupRun = run;
    try { await run; } finally { if (this.cleanupRun === run) this.cleanupRun = undefined; }
  }

  shutdown(): Promise<void> {
    if (!this.shutdownRun) this.shutdownRun = this.shutdownOnce();
    return this.shutdownRun;
  }
  private async shutdownOnce() {
    this.shuttingDown = true;
    for (const inspect of [...this.sendWaiters]) inspect();
    this.releaseInitializationCleanup?.();
    this.initializationOwner.revoke();
    this.workspaceReaders.revoke();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const transition of this.transitions.values()) transition.revoke();
    const ids = new Set([...this.lifecycles.keys(), ...this.drivers.keys()]);
    try {
      for (const [id, driver] of this.drivers) {
        if (!driver.prepareForDaemonShutdown) continue;
        const tasks = await this.repos.tasks.listBySession(id);
        const unresolved = tasks.some(task => this.repos.execution.getTaskExecution(task.id)?.attempts.some(attempt => ['preparing', 'active', 'reconcile_required', 'legacy_unresolved'].includes(attempt.state)));
        const pendingCreation = this.repos.execution.getResources(id).some(resource => resource.kind === 'operation' && ['pending', 'unknown'].includes(resource.stage) && !resource.creationClosure);
        // Admission is closed and transitions revoked; an unclaimed queue drain cannot start a new turn.
        const preserve = this.drivers.get(id) !== driver || this.recoveryInFlight(id, false) || this.verifyingSessions.has(id) || unresolved || pendingCreation;
        try { await driver.prepareForDaemonShutdown(Boolean(preserve)); }
        catch {
          try { await driver.prepareForDaemonShutdown(true); } catch { /* Stop still must prove physical exit. */ }
          await this.retainStopBlock(id, 'Shutdown preparation failed; physical resource verification is required');
        }
      }
      await Promise.allSettled([...ids].map(id => this.revokeSession(id, false, 'stopped', true)));
      if (this.binding) await this.verifications.stop();
      await this.cleanupRun;
    } finally {
      // The service may close SQLite even when shutdown rejects. No local fact
      // continuation may escape this drain on either the success or failure path.
      await Promise.allSettled([this.initializationRun]);
      await Promise.allSettled([this.initializationCleanup, this.cleanupRun]);
      await Promise.allSettled([...this.taskRuns, ...this.queueRuns.values()]);
      while (this.driverEventChains.size) await Promise.allSettled([...this.driverEventChains.values()]);
      while (this.workspacePreparations.size) await Promise.allSettled([...this.workspacePreparations]);
      while (this.cleaningRuns.size) await Promise.allSettled([...this.cleaningRuns.values()]);
      while (this.factoryCleanups.size) await Promise.allSettled([...this.factoryCleanups.values()]);
      await this.mutations.barrier();
      await this.publisher.close();
      this.drivers.clear(); this.queues.clear();
      this.cleaningDirs.clear(); this.preparingWorkspaces.clear();

      this.binding?.release();
      this.binding = undefined; this.execution = undefined;
    }
  }
}
