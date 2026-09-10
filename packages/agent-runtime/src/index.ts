import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { AgentConfig, AgentDriver, AgentEvent, DriverFactory, EventType, EventWindowOptions, NormalizedDriverEvent, PermissionMode, PermissionRequestData, RepositoryBundle, Session, StartSessionInput, TaskExecutionContext, TaskRecord, ToolCallData, ToolRiskPolicy } from '@dutydeck/shared';
import { DriverDetachedError, DriverRecoveryError, makeId, now, RuntimeError } from '@dutydeck/shared';
import { AcpxAdapter } from '@dutydeck/acp-client';
import { JsonlTransport, PipeTransport, probeAgent, PtyTransport, type ProbeMatrix } from '@dutydeck/transports';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 没有可接管任务或可恢复队列时，这些忙碌状态需要在启动时回收。
const RECOVERABLE_BUSY_STATES = ['starting', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting'] as const satisfies readonly Session['state'][];

/** `includes` 在 as const 数组上不接受更宽的入参；用类型谓词而不是 `as` 强转，保住穷尽性检查。 */
const isRecoverableBusy = (state: Session['state']): boolean => (RECOVERABLE_BUSY_STATES as readonly string[]).includes(state);

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
    const data = event.data;
    const previous = calls.get(data.id);
    calls.set(data.id, { id: data.id, name: data.name ?? previous?.name ?? 'tool', input: data.input ?? previous?.input, output: data.output ?? previous?.output, status: data.status, startedAt: previous?.startedAt ?? now(), completedAt: data.status === 'completed' || data.status === 'failed' ? now() : undefined });
  }
  return calls;
}

// 驱动契约类型统一从 @dutydeck/shared 导出（driver.ts 是跨团队冻结契约），
// 本包不再自定义 AgentDriver / DriverFactory / NormalizedDriverEvent。
export type { AgentDriver, DriverFactory, NormalizedDriverEvent };

export interface RuntimeOptions {
  authorizeExecution?: (sessionId: string, actorId?: string) => Promise<void>;
  resolveRiskPolicy?: (sessionId: string, fallback?: ToolRiskPolicy) => Promise<ToolRiskPolicy | undefined>;
  acpxCommand?: string;
  driverFactory?: DriverFactory;
  /**
   * pty-cli 协议驱动工厂（botmux 适配器栈，由 @dutydeck/pty-driver 提供）。
   * 仅在未注入自定义 driverFactory 时生效：agent.protocol === 'pty-cli' 的会话路由到它。
   * 未提供时创建 pty-cli 会话会抛 DRIVER_UNAVAILABLE。
   */
  ptyDriverFactory?: DriverFactory;
  probe?: typeof probeAgent;
  driverIdleTimeoutMs?: number;
  cleanupIntervalMs?: number;
  sessionEnvironment?: (session: Session) => Record<string, string>;
  sessionPrompt?: (session: Session, prompt: string) => string | Promise<string>;
}

export class DutydeckRuntime {
  private readonly emitter = new EventEmitter();
  private readonly drivers = new Map<string, AgentDriver>();
  private readonly activeTurns = new Set<string>();
  private readonly activeTasks = new Map<string, TaskRecord>();
  private readonly interruptedTurns = new Set<string>();
  private readonly hardInterrupts = new Set<string>();
  private readonly turnWaiters = new Map<string, Set<() => void>>();
  private readonly queues = new Map<string, TaskRecord[]>();
  private readonly queueRuns = new Map<string, Promise<void>>();
  private readonly sequences = new Map<string, number>();
  private readonly permissions = new Map<string, { request: PermissionRequestData; generation: number }>();
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
  private readonly replayedEvents = new Map<string, Set<string>>();

  constructor(private readonly repos: RepositoryBundle, private readonly options: RuntimeOptions = {}) {
    const ptyDriverFactory = options.ptyDriverFactory;
    this.factory = options.driverFactory ?? ((agent, protocol, onEvent, onExit, sessionId) => {
      if (protocol === 'acp') return new AcpxAdapter({ ...agent, env: { ...agent.env, dutydeck_session_id: sessionId } }, { sessionKey: sessionId, onEvent, ...(this.options.resolveRiskPolicy ? { resolveRiskPolicy: (fallback?: ToolRiskPolicy) => this.options.resolveRiskPolicy!(sessionId, fallback) } : {}) });
      if (protocol === 'pty-cli') {
        if (!ptyDriverFactory) throw new RuntimeError('DRIVER_UNAVAILABLE', 'protocol 为 pty-cli 的 agent 需要注入 ptyDriverFactory（@dutydeck/pty-driver）', 503);
        return ptyDriverFactory(agent, protocol, onEvent, onExit, sessionId);
      }
      if (protocol === 'pty') return new PtyTransport(agent, { onEvent, onExit });
      if (protocol === 'pipe') return new PipeTransport(agent, { onEvent, onExit });
      return new JsonlTransport(agent, { onEvent, onExit });
    });
    const interval = options.cleanupIntervalMs ?? 5 * 60_000;
    if ((options.driverIdleTimeoutMs ?? 6 * 60 * 60_000) > 0 && interval > 0) {
      this.cleanupTimer = setInterval(() => void this.cleanupIdleDrivers(), interval);
      this.cleanupTimer.unref();
    }
  }

  private touch(sessionId: string) { this.lastActivity.set(sessionId, Date.now()); }
  private permissionKey(sessionId: string, permissionId: string) { return `${sessionId}:${permissionId}`; }
  private enqueueDriverEvent(session: Session, event: NormalizedDriverEvent, generation: number) {
    const previous = this.driverEventChains.get(session.id) ?? Promise.resolve();
    const next = previous.then(() => {
      if (this.sessionGenerations.get(session.id) === generation) return this.consume(session, event);
    }).catch(error => {
      if (!this.driverEventErrors.has(session.id)) this.driverEventErrors.set(session.id, error);
    });
    this.driverEventChains.set(session.id, next);
    void next.finally(() => {
      if (this.driverEventChains.get(session.id) === next) this.driverEventChains.delete(session.id);
    });
  }
  private async flushDriverEvents(sessionId: string) {
    while (true) {
      const pending = this.driverEventChains.get(sessionId);
      if (!pending) break;
      await pending;
      if (this.driverEventChains.get(sessionId) === pending) break;
    }
    const error = this.driverEventErrors.get(sessionId);
    this.driverEventErrors.delete(sessionId);
    if (error) throw error;
  }
  private static isTruncatedStopReason(reason?: string) {
    return reason === 'max_tokens' || reason === 'truncated';
  }
  // 终态要求最后一次活动（思考 / 工具）之后必须存在 assistant text，否则视为缺少最终输出。
  // 与 Web 时间线 buildTimelineSections 的 finalIndex 判定保持一致。
  private async turnHasFinalAssistantText(sessionId: string, promptSequence: number): Promise<boolean> {
    let beforeSequence: number | undefined;
    while (true) {
      const events = await this.repos.events.listWindow(sessionId, {
        afterSequence: promptSequence,
        beforeSequence,
        direction: 'backward',
        limit: 200
      });
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!;
        if (event.type === 'text' && (event.data as any)?.role !== 'user') return true;
        if (event.type === 'thinking' || event.type === 'tool_call' || event.type === 'tool_result') return false;
      }
      if (events.length < 200) return false;
      beforeSequence = events[0]!.sequence;
    }
  }
  private async resolveTaskOutcome(session: Session, promptSequence: number): Promise<{ status: 'completed' | 'failed' | 'interrupted'; stopReason?: string; message?: string; errorAlreadyEmitted?: boolean }> {
    const stopReason = this.driverStopReasons.get(session.id);
    if (this.interruptedTurns.has(session.id) || stopReason === 'cancelled') return { status: 'interrupted', stopReason };
    const turnError = this.turnErrors.get(session.id);
    if (turnError) return { status: 'failed', stopReason, message: turnError, errorAlreadyEmitted: true };
    if (DutydeckRuntime.isTruncatedStopReason(stopReason)) {
      return { status: 'failed', stopReason, message: `输出因达到 token 上限被截断（stopReason: ${stopReason}），未产生完整最终输出` };
    }
    if (!await this.turnHasFinalAssistantText(session.id, promptSequence)) {
      return { status: 'failed', stopReason, message: 'Agent 未返回最终输出' };
    }
    return { status: 'completed', stopReason };
  }
  private nextSessionGeneration(sessionId: string) {
    const generation = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.sessionGenerations.set(sessionId, generation);
    return generation;
  }
  private onDriverEvent(session: Session, generation: number) {
    return (event: NormalizedDriverEvent) => {
      if (this.sessionGenerations.get(session.id) !== generation) return;
      this.enqueueDriverEvent(session, event, generation);
    };
  }
  private configureAgentForSession(agent: AgentConfig, session: Session): AgentConfig {
    return {
      ...agent,
      cwd: session.cwd,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      systemPrompt: session.systemPrompt ?? agent.systemPrompt,
      permissionMode: session.permissionMode ?? agent.permissionMode,
      env: { ...agent.env, ...this.options.sessionEnvironment?.(session) }
    };
  }

  async initialize(agents: AgentConfig[]) {
    // Configuration is the source of truth on every boot and removes built-ins
    // that are no longer discovered from the ACPX registry.
    const configuredIds = new Set(agents.map(agent => agent.id));
    for (const existing of await this.repos.agents.list()) if (existing.builtin && !configuredIds.has(existing.id)) await this.repos.agents.delete(existing.id);
    for (const agent of agents) await this.repos.agents.save(agent);
    for (const session of await this.repos.sessions.list()) {
      if (session.archivedAt) continue;
      const persistedTasks = await this.repos.tasks.listBySession(session.id);
      if (!persistedTasks.length && ['created', 'starting', 'failed'].includes(session.state)) {
        const message = session.error ?? 'Dutydeck 守护进程重启，未完成启动的会话已回收';
        session.state = 'failed';
        session.error = message;
        session.archivedAt = now();
        session.updatedAt = session.archivedAt;
        await this.repos.sessions.save(session);
        continue;
      }
      const orphaned = persistedTasks.filter(task => task.status === 'running');
      const recoverable = orphaned.length === 1 && session.protocol === 'pty-cli' && !['stopped', 'failed', 'interrupting', 'interrupted'].includes(session.state) && orphaned[0]?.executionContext?.recovery
        ? orphaned[0] : undefined;
      if (orphaned.length && !recoverable) {
        const message = 'Dutydeck 守护进程重启，正在进行的任务已中断';
        for (const task of orphaned) {
          await this.saveTask(task, 'interrupted');
          await this.repos.artifacts.saveError(session.id, message);
          await this.emit(session.id, 'error', { message });
        }
        await this.saveState(session, 'interrupted', message);
      }
      const queuedTasks = persistedTasks.filter(task => task.status === 'queued').sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const legacyQueued = queuedTasks.filter(task => typeof task.executionContext?.agentPrompt !== 'string');
      if (legacyQueued.length) {
        const message = 'Dutydeck 守护进程重启，旧任务缺少可验证的执行上下文，已安全中断，请重新发送';
        for (const task of legacyQueued) {
          await this.saveTask(task, 'interrupted');
          await this.repos.artifacts.saveError(session.id, message, { taskId: task.id });
          await this.emit(session.id, 'error', { message, taskId: task.id });
        }
        if (legacyQueued.length === queuedTasks.length && !['stopped', 'failed'].includes(session.state)) await this.saveState(session, 'interrupted', message);
      }
      // Without a recoverable turn or resumable queue, a stale busy session
      // has no work that this daemon can continue.
      const resumableQueue = queuedTasks.some(task => typeof task.executionContext?.agentPrompt === 'string');
      if (!recoverable && !resumableQueue && isRecoverableBusy(session.state)) {
        const message = 'Dutydeck 守护进程重启，上一轮执行已中断';
        session.state = 'stopped';
        session.error = message;
        session.updatedAt = now();
        await this.repos.sessions.save(session);
        await this.repos.artifacts.saveError(session.id, message);
      }
      const queued = queuedTasks.filter(task => typeof task.executionContext?.agentPrompt === 'string');
      if (queued.length) {
        this.queues.set(session.id, queued);
      }
      if (recoverable) {
        const run = this.runTask(session.id, recoverable, true).then(() => {}, () => {});
        this.queueRuns.set(session.id, run);
        void run.finally(async () => {
          if (this.queueRuns.get(session.id) === run) this.queueRuns.delete(session.id);
          if (this.shuttingDown) return;
          const current = await this.repos.sessions.get(session.id);
          if (current && !['stopped', 'failed'].includes(current.state)) this.scheduleQueue(session.id);
        });
      } else if (queued.length && !['stopped', 'failed'].includes(session.state)) {
        this.scheduleQueue(session.id);
      }
    }
  }
  listAgents() { return this.repos.agents.list(); }
  listSessions() { return this.repos.sessions.list(); }
  getSession(id: string) { return this.repos.sessions.get(id); }
  /** 只读访问当前内存中的 driver 实例（如终端 WS 代理取 createTerminalStream）；未连接/已释放时返回 undefined。 */
  getDriver(sessionId: string): AgentDriver | undefined { return this.drivers.get(sessionId); }
  /** Restore an idle persistent terminal for viewing without resuming a task. */
  async getTerminalDriver(sessionId: string): Promise<AgentDriver | undefined> {
    const existing = this.drivers.get(sessionId);
    if (existing) return existing;
    const observedGeneration = this.sessionGenerations.get(sessionId);
    const session = await this.repos.sessions.get(sessionId);
    if (!session || session.archivedAt || session.protocol !== 'pty-cli'
      || !['idle', 'completed', 'interrupted'].includes(session.state)) return undefined;
    const agent = await this.repos.agents.get(session.agentId);
    if (this.shuttingDown || this.hardInterrupts.has(sessionId)) return undefined;
    const connected = this.drivers.get(sessionId);
    if (connected) return connected;
    if (!agent || this.sessionGenerations.get(sessionId) !== observedGeneration) return undefined;
    const generation = this.nextSessionGeneration(sessionId);
    const driver = this.factory(this.configureAgentForSession(agent, session), session.protocol,
      this.onDriverEvent(session, generation), code => {
        if (this.drivers.get(sessionId) !== driver) return;
        this.notifyDriverExit(sessionId, code);
        this.drivers.delete(sessionId);
      }, sessionId);
    try {
      if (!driver.attachTerminal?.()) { await driver.stop(); return undefined; }
      this.drivers.set(sessionId, driver);
      this.touch(sessionId);
      return driver;
    } catch (error) {
      await driver.stop();
      throw error;
    }
  }
  getEvents(id: string, after = 0) { return this.repos.events.list(id, after); }
  getRecentEvents(id: string, limit: number) { return this.repos.events.listRecent(id, limit); }
  getEventWindow(id: string, options?: EventWindowOptions) { return this.repos.events.listWindow(id, options); }
  async getTasks(id: string) { return (await this.repos.tasks.listBySession(id)).map(task => this.publicTask(task)); }

  /**
   * 外部来源事件写入（通用回传通道 @dutydeck/relay 使用）。
   *
   * 事件流此前只有 driver 一个入口（onDriverEvent → consume → emit），而 relay 的
   * send/ask 来自会话内 CLI 主动发起的**带外**调用，不属于任何 driver 事件。
   * 直接调 `repos.events.append()` 是错的：那样只落库、不通知在线 SSE 订阅者，
   * 且不推进 `this.sequences`，下一次 emit 会撞 events(session_id, sequence) 唯一索引。
   * 所以这里暴露一个薄封装，语义与内部 emit 完全一致（落库 + fan-out + 序号推进）。
   *
   * 只接受与会话状态无关的表述性事件；状态机迁移仍只能由 runtime 自己驱动。
   */
  async publishSessionEvent(sessionId: string, type: EventType, data: unknown) {
    const session = await this.repos.sessions.get(sessionId);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`, 404);
    if (session.archivedAt) throw new RuntimeError('SESSION_ARCHIVED', 'Archived sessions are read-only', 409);
    return this.emit(sessionId, type, data);
  }

  private async saveState(session: Session, state: Session['state'], error?: string) {
    this.touch(session.id);
    session.state = state; session.updatedAt = now(); session.error = error;
    await this.repos.sessions.save(session);
    await this.emit(session.id, 'status', { state, ...(error ? { error } : {}) });
  }

  // A task-level failure (e.g. no final output, a capped turn, or a transient
  // driver error) must not permanently poison a shared session: it should keep
  // accepting future turns and draining its queue. Only hard failures (agent
  // start failure, process exit, explicit stop) leave a session in the
  // `failed` terminal state. When a task fails we return the session to a
  // reusable `idle` state while surfacing the last task error for the UI.
  private async recoverSessionAfterTask(session: Session, error: string) {
    if (session.archivedAt || ['stopped', 'failed'].includes(session.state)) return;
    this.touch(session.id);
    session.state = 'idle'; session.updatedAt = now(); session.error = error;
    await this.repos.sessions.save(session);
    await this.emit(session.id, 'status', { state: 'idle', error });
  }

  private driverEventId(sessionId: string, sourceId: string) {
    return 'evt_' + createHash('sha256').update(sessionId + '\0' + sourceId).digest('hex');
  }

  private async emit(sessionId: string, type: EventType, data: any, raw?: string, eventId = makeId('evt')) {
    const sequence = (this.sequences.get(sessionId) ?? (await this.repos.events.listRecent(sessionId, 1)).at(-1)?.sequence ?? 0) + 1;
    this.sequences.set(sessionId, sequence);
    const event: AgentEvent = { id: eventId, sessionId, sequence, type, timestamp: now(), data, ...(raw ? { raw } : {}) };
    await this.repos.events.append(event);
    this.emitter.emit(`session:${sessionId}`, event);
    return event;
  }

  private async saveTask(task: TaskRecord, status = task.status) {
    task.status = status; task.updatedAt = now();
    await this.repos.tasks.save(task);
    await this.emit(task.sessionId, 'task', { task: this.publicTask(task) });
  }

  private publicTask(task: TaskRecord): Omit<TaskRecord, 'executionContext'> {
    const { executionContext: _executionContext, ...visible } = task;
    return visible;
  }

  private executionContext(agentPrompt: string, riskPolicy?: ToolRiskPolicy, actorId?: string): TaskExecutionContext {
    return {
      agentPrompt,
      ...(actorId ? { actorId } : {}),
      ...(riskPolicy ? { riskPolicy } : {})
    };
  }

  subscribe(sessionId: string, listener: (event: AgentEvent) => void) {
    const name = `session:${sessionId}`; this.emitter.on(name, listener);
    return () => this.emitter.off(name, listener);
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

  private async consume(session: Session, event: NormalizedDriverEvent) {
    const eventId = event.sourceId ? this.driverEventId(session.id, event.sourceId) : undefined;
    if (eventId && !this.replayedEvents.has(session.id)) {
      this.replayedEvents.set(session.id, new Set((await this.repos.events.list(session.id)).map(item => item.id)));
    }
    if (eventId && this.replayedEvents.get(session.id)?.has(eventId)) return;
    this.touch(session.id);
    // Driver completion closes its stream; Runtime emits the single canonical
    // completed event after task persistence succeeds. Capture the real ACP
    // stopReason here so runTask can distinguish cancelled / truncated turns
    // from clean end_turn completions.
    if (event.type === 'completed') {
      if (typeof event.data?.stopReason === 'string') this.driverStopReasons.set(session.id, event.data.stopReason);
      return;
    }
    let data = event.data;
    if (event.type === 'tool_call' || event.type === 'tool_result') {
      const completed = data.status === 'completed' || data.status === 'failed';
      data = { ...data, startedAt: data.startedAt ?? now(), ...(completed ? { completedAt: data.completedAt ?? now() } : {}) };
      await this.repos.artifacts.saveToolCall(session.id, data);
      await this.saveState(session, completed ? 'thinking' : 'running_tool');
    } else if (event.type === 'thinking' && session.state !== 'thinking') await this.saveState(session, 'thinking');
    else if (event.type === 'permission_request') {
      data = { ...data, status: data.status ?? 'pending' };
      const key = this.permissionKey(session.id, data.id);
      if (data.status === 'pending') { this.permissions.set(key, { request: data, generation: this.sessionGenerations.get(session.id) ?? 0 }); await this.saveState(session, 'waiting_for_permission'); }
      else { this.permissions.delete(key); this.permissionResolutions.delete(key); }
      await this.repos.artifacts.savePermission(session.id, data);
    } else if (event.type === 'error') {
      if (this.activeTurns.has(session.id)) this.turnErrors.set(session.id, data.message);
      await this.repos.artifacts.saveError(session.id, data.message, data.detail);
      // Error events emitted during a turn describe that task. runTask owns the
      // terminal task outcome and returns a reusable shared Session to idle.
      // Outside an active turn the same event is a driver-level hard failure.
      if (!this.activeTurns.has(session.id)) await this.saveState(session, 'failed', data.message);
    }
    await this.emit(session.id, event.type, data, event.raw, eventId);
    if (eventId) this.replayedEvents.get(session.id)?.add(eventId);
  }

  async start(input: StartSessionInput): Promise<Session> {
    const agent = await this.repos.agents.get(input.agentId);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${input.agentId}`, 404);
    const configured = { ...agent, cwd: input.cwd ?? agent.cwd ?? process.cwd(), model: input.model ?? agent.model, reasoningEffort: input.reasoningEffort ?? agent.reasoningEffort, permissionMode: input.permissionMode ?? agent.permissionMode };
    const capability = (this.options.probe ?? probeAgent)(configured, this.options.acpxCommand);
    if (!capability.available) throw new RuntimeError('AGENT_UNAVAILABLE', capability.detail ?? 'Agent unavailable', 503);
    if (capability.protocol === 'pty') {
      throw new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'Legacy PTY transport cannot enforce a permission posture or expose interactive approval; use an ACP or PTY CLI Agent', 422);
    }
    if (capability.protocol === 'pty-cli' && configured.permissionMode !== 'ask' && configured.permissionMode !== 'full-trust') {
      throw new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'PTY Agent only supports ask (approve in the terminal) or explicit full-trust mode', 422);
    }
    const session: Session = { id: makeId('ses'), agentId: agent.id, state: 'created', cwd: configured.cwd!, model: configured.model, reasoningEffort: configured.reasoningEffort, permissionMode: configured.permissionMode, source: input.source, sourceId: input.sourceId, protocol: capability.protocol, runId: makeId('run'), createdAt: now(), updatedAt: now(), systemPrompt: configured.systemPrompt };
    await this.repos.artifacts.ensureLocalProject(session.cwd);
    await this.repos.sessions.save(session);
    await this.saveState(session, 'starting');
    const generation = this.nextSessionGeneration(session.id);
    const driver = this.factory(this.configureAgentForSession(configured, session), capability.protocol, this.onDriverEvent(session, generation), code => { if (this.sessionGenerations.get(session.id) !== generation) return; this.notifyDriverExit(session.id, code); if (code && session.state !== 'stopped' && !this.interruptedTurns.has(session.id) && !this.hardInterrupts.has(session.id)) void this.saveState(session, 'failed', `Agent exited with code ${code}`).then(() => this.emit(session.id, 'error', { message: `Agent exited with code ${code}` })); }, session.id);
    this.drivers.set(session.id, driver);
    try { await driver.start(); this.touch(session.id); await this.saveState(session, 'idle'); return session; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hardInterrupts.add(session.id);
      try { await driver.stop({ discardSession: true }); } catch { /* Preserve the startup error. */ }
      await this.repos.artifacts.saveError(session.id, message);
      session.archivedAt = now();
      await this.saveState(session, 'failed', message);
      await this.emit(session.id, 'error', { message });
      this.releaseSessionMemory(session.id);
      throw new RuntimeError('START_FAILED', message, 503);
    }
  }

  private async active(id: string) {
    if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
    const session = await this.repos.sessions.get(id);
    if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
    if (session.archivedAt) throw new RuntimeError('SESSION_ARCHIVED', 'Archived sessions are read-only', 409);
    const driver = this.drivers.get(id);
    return { session, driver };
  }

  private async reconnect(session: Session, start = true) {
    const existing = this.drivers.get(session.id);
    if (existing) return existing;
    const agent = await this.repos.agents.get(session.agentId);
    if (this.shuttingDown) throw new RuntimeError('RUNTIME_SHUTTING_DOWN', 'Dutydeck is shutting down', 503);
    const connected = this.drivers.get(session.id);
    if (connected) return connected;
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${session.agentId}`, 404);
    const configured = this.configureAgentForSession(agent, session);
    const generation = this.nextSessionGeneration(session.id);
    const driver = this.factory(configured, session.protocol!, this.onDriverEvent(session, generation), code => {
      if (this.sessionGenerations.get(session.id) !== generation) return;
      if (code && session.state !== 'stopped' && !this.interruptedTurns.has(session.id) && !this.hardInterrupts.has(session.id)) void this.saveState(session, 'failed', `Agent exited with code ${code}`).then(() => this.emit(session.id, 'error', { message: `Agent exited with code ${code}` }));
    }, session.id);
    this.drivers.set(session.id, driver);
    try { if (start) await driver.start(); this.touch(session.id); return driver; }
    catch (error) { this.drivers.delete(session.id); throw error; }
  }

  private async applyRiskPolicy(session: Session, driver: AgentDriver | undefined, policy?: ToolRiskPolicy) {
    if (this.options.resolveRiskPolicy) policy = await this.options.resolveRiskPolicy(session.id, policy);
    driver?.setRiskPolicy?.(policy);
    const directory = join(session.cwd, '.dutydeck', 'security', 'sessions');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${session.id}.json`), JSON.stringify(policy ?? { enabled: false }), { mode: 0o600 });
  }

  private runTask(id: string, task: TaskRecord, recovering = false) {
    const run = this.executeTask(id, task, recovering);
    this.taskRuns.add(run);
    void run.then(() => this.taskRuns.delete(run), () => this.taskRuns.delete(run));
    return run;
  }

  private async executeTask(id: string, task: TaskRecord, recovering: boolean) {
    const { session } = await this.active(id);
    if (['stopped', 'failed'].includes(session.state)) throw new RuntimeError('INVALID_STATE', `Cannot send while session is ${session.state}`, 409);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response to finish', 409);
    this.activeTurns.add(id);
    this.activeTasks.set(id, task);
    this.driverStopReasons.delete(id);
    this.turnErrors.delete(id);
    this.touch(id);
    const wasQueued = task.status === 'queued';
    let submissionStarted = false;
    try {
      await this.options.authorizeExecution?.(id, task.executionContext?.actorId);
      const driver = await this.reconnect(session, !recovering);
      const { agentPrompt = task.prompt, riskPolicy } = task.executionContext ?? {};
      // 每个任务都明确设置（或清除）策略，避免复用会话沿用上一个
      // Lark 任务的高危正则到普通 Web/CLI 任务。
      await this.applyRiskPolicy(session, driver, riskPolicy);
      let promptSequence: number;
      if (recovering) {
        const events = await this.repos.events.list(id);
        const promptEvent = events.find(event => event.type === 'text' && (event.data as any)?.role === 'user' && (event.data as any)?.taskId === task.id);
        if (!driver.recover || !task.executionContext?.recovery || !promptEvent) throw new DriverRecoveryError('无法确认原任务的恢复边界，未重新发送指令');
        promptSequence = promptEvent.sequence;
        this.replayedEvents.set(id, new Set(events.map(event => event.id)));
        if (this.shuttingDown) throw new DriverDetachedError();
        await driver.recover(task.executionContext.recovery);
      } else {
        if (this.shuttingDown) throw new DriverDetachedError();
        const existingPrompt = task.executionContext?.recovery
          ? (await this.repos.events.list(id)).find(event => event.type === 'text' && (event.data as any)?.role === 'user' && (event.data as any)?.taskId === task.id)
          : undefined;
        const recovery = driver.checkpoint?.();
        if (recovery) task.executionContext = { ...task.executionContext!, agentPrompt, recovery };
        await this.saveTask(task, 'running');
        const promptEvent = existingPrompt ?? await this.emit(id, 'text', { text: task.prompt, role: 'user', taskId: task.id });
        promptSequence = promptEvent.sequence;
        await this.saveState(session, 'thinking');
        const resolvedAgentPrompt = await this.options.sessionPrompt?.(session, agentPrompt) ?? agentPrompt;
        if (this.shuttingDown) throw new DriverDetachedError();
        submissionStarted = true;
        await driver.send(resolvedAgentPrompt);
      }
      await this.flushDriverEvents(id);
      const outcome = await this.resolveTaskOutcome(session, promptSequence);
      if (outcome.status === 'interrupted') { await this.saveTask(task, 'interrupted'); await this.saveState(session, 'interrupted'); }
      else if (outcome.status === 'failed') {
        await this.saveTask(task, 'failed');
        if (outcome.message) {
          if (!outcome.errorAlreadyEmitted) { await this.repos.artifacts.saveError(id, outcome.message); await this.emit(id, 'error', { message: outcome.message }); }
          await this.recoverSessionAfterTask(session, outcome.message);
        }
      } else { await this.saveTask(task, 'completed'); await this.saveState(session, 'completed'); await this.emit(id, 'completed', { stopReason: outcome.stopReason ?? 'end_turn' }); }
    } catch (error) {
      try { await this.flushDriverEvents(id); }
      catch { /* Preserve the driver error while ensuring preceding events finish first. */ }
      if (this.shuttingDown && wasQueued && !submissionStarted && !recovering) {
        await this.saveTask(task, 'queued');
        return this.publicTask(task);
      }
      const daemonDetached = error instanceof DriverDetachedError
        || error instanceof RuntimeError && error.code === 'RUNTIME_SHUTTING_DOWN';
      if (this.shuttingDown && daemonDetached && task.executionContext?.recovery) return this.publicTask(task);
      if (error instanceof DriverRecoveryError) {
        await this.saveTask(task, 'interrupted');
        await this.cancelSessionQueue(id);
        await this.saveState(session, 'stopped', error.message);
        await this.repos.artifacts.saveError(id, error.message);
        await this.emit(id, 'error', { message: error.message });
        throw error;
      }
      const interrupted = this.shuttingDown || this.interruptedTurns.has(id) || this.driverStopReasons.get(id) === 'cancelled';
      const attempt = async (operation: () => Promise<unknown>) => { try { await operation(); } catch { /* Preserve the original turn failure and keep cleanup progressing. */ } };
      if (interrupted) {
        await attempt(() => this.saveTask(task, 'interrupted'));
        await attempt(() => this.saveState(session, 'interrupted'));
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const emittedDriverError = this.turnErrors.get(id);
        await attempt(() => this.saveTask(task, 'failed'));
        if (!emittedDriverError) {
          await attempt(() => this.repos.artifacts.saveError(id, message));
          await attempt(() => this.emit(id, 'error', { message }));
        }
        await attempt(() => this.recoverSessionAfterTask(session, emittedDriverError ?? message));
        throw error;
      }
    } finally {
      const hardInterrupted = this.hardInterrupts.has(id);
      this.interruptedTurns.delete(id); this.activeTurns.delete(id); this.activeTasks.delete(id); this.turnErrors.delete(id); this.touch(id);
      for (const resolve of this.turnWaiters.get(id) ?? []) resolve();
      this.turnWaiters.delete(id);
      if (!hardInterrupted) this.scheduleQueue(id);
    }
    return this.publicTask(task);
  }

  async send(id: string, prompt: string, agentPrompt = prompt, riskPolicy?: ToolRiskPolicy, actorId?: string) {
    const task: TaskRecord = { id: makeId('task'), sessionId: id, prompt, status: 'running', executionContext: this.executionContext(agentPrompt, riskPolicy, actorId), createdAt: now(), updatedAt: now() };
    return this.runTask(id, task);
  }

  async dispatch(id: string, prompt: string, mode: 'queue' | 'interrupt' = 'queue', agentPrompt = prompt, riskPolicy?: ToolRiskPolicy, actorId?: string, idempotencyKey?: string) {
    const stableId = idempotencyKey ? 'task_' + createHash('sha256').update(id + '\0' + idempotencyKey).digest('hex') : undefined;
    const replay = (task: TaskRecord) => {
      if (task.sessionId !== id || task.prompt !== prompt || task.executionContext?.actorId !== actorId) throw new RuntimeError('TASK_IDEMPOTENCY_CONFLICT', 'This delivery key belongs to a different task request', 409);
      return { ...this.publicTask(task), replayed: true, queuedAhead: 0 };
    };
    if (stableId) {
      if (!this.repos.tasks.get || !this.repos.tasks.create) throw new RuntimeError('TASK_IDEMPOTENCY_UNSUPPORTED', 'Task storage cannot atomically accept this message', 503);
      const existing = await this.repos.tasks.get(stableId);
      if (existing) return replay(existing);
    }
    const { session } = await this.active(id);
    if (['stopped', 'failed'].includes(session.state)) throw new RuntimeError('INVALID_STATE', `Cannot send while session is ${session.state}`, 409);
    const task: TaskRecord = { id: stableId ?? makeId('task'), sessionId: id, prompt, status: 'queued', executionContext: this.executionContext(agentPrompt, riskPolicy, actorId), createdAt: now(), updatedAt: now() };
    if (stableId && !await this.repos.tasks.create!(task)) {
      const existing = await this.repos.tasks.get!(stableId);
      if (!existing) throw new RuntimeError('TASK_IDEMPOTENCY_CONFLICT', 'Task acceptance changed; retry the message', 409);
      return replay(existing);
    }
    const queue = this.queues.get(id) ?? [];
    const queuedAhead = queue.length + (this.activeTurns.has(id) ? 1 : 0);
    if (mode === 'interrupt') queue.unshift(task); else queue.push(task);
    this.queues.set(id, queue);
    await this.saveTask(task, 'queued');
    if (mode === 'interrupt' && this.activeTurns.has(id)) await this.terminateCurrentTurn(id);
    this.scheduleQueue(id);
    return { ...this.publicTask(task), queuedAhead };
  }

  private scheduleQueue(id: string) {
    if (this.shuttingDown || this.queueRuns.has(id) || this.activeTurns.has(id)) return;
    const run = this.drainQueue(id); this.queueRuns.set(id, run);
    void run.finally(() => { if (this.queueRuns.get(id) === run) this.queueRuns.delete(id); });
  }

  private async drainQueue(id: string) {
    while (!this.shuttingDown && !this.activeTurns.has(id)) {
      const queue = this.queues.get(id);
      const task = queue?.shift();
      if (!task) { this.queues.delete(id); return; }
      if (!queue?.length) this.queues.delete(id);
      try { await this.runTask(id, task); }
      catch {
        if (this.shuttingDown) return;
        // A prompt/SDK failure only fails the current task. recoverSessionAfterTask
        // restores a reusable shared session to idle, so later queued work must
        // still get its own attempt instead of being failed without execution.
        const session = await this.repos.sessions.get(id);
        if (session && !session.archivedAt && session.state === 'idle') continue;
        await this.failRemainingQueue(id);
        return;
      }
    }
  }

  // If one queued task cannot run (e.g. the session entered a hard `failed`
  // state), the rest of the in-memory queue can never drain. Persist them as
  // `failed` instead of leaving them dangling in `queued` (which previously
  // produced "Unknown queued task" on cancel and stuck records in storage).
  private async failRemainingQueue(id: string) {
    const remaining = this.queues.get(id) ?? [];
    this.queues.delete(id);
    for (const task of remaining) {
      try { await this.saveTask(task, 'failed'); } catch { /* best-effort */ }
    }
  }

  async cancelQueued(id: string, taskId: string) {
    const queue = this.queues.get(id) ?? [];
    const index = queue.findIndex(task => task.id === taskId);
    if (index < 0) throw new RuntimeError('QUEUED_TASK_NOT_FOUND', `Unknown queued task: ${taskId}`, 404);
    const [task] = queue.splice(index, 1);
    if (!queue.length) this.queues.delete(id);
    await this.saveTask(task!, 'cancelled');
    return this.publicTask(task!);
  }

  async steerQueued(id: string, taskId: string) {
    await this.active(id);
    const queue = this.queues.get(id) ?? [];
    const index = queue.findIndex(task => task.id === taskId);
    if (index < 0) throw new RuntimeError('QUEUED_TASK_NOT_FOUND', `Unknown queued task: ${taskId}`, 404);
    const [task] = queue.splice(index, 1);
    queue.unshift(task!);
    this.queues.set(id, queue);
    if (this.activeTurns.has(id)) await this.terminateCurrentTurn(id);
    this.scheduleQueue(id);
    return this.publicTask(task!);
  }

  private async cancelSessionQueue(id: string) {
    const queue = this.queues.get(id) ?? [];
    this.queues.delete(id);
    await Promise.all(queue.map(task => this.saveTask(task, 'cancelled')));
  }

  async interrupt(id: string, expectedTaskId?: string) {
    const { session, driver } = await this.active(id);
    if (!driver) throw new RuntimeError('SESSION_DISCONNECTED', 'Session is disconnected', 409);
    const task = expectedTaskId ? this.activeTasks.get(id) : undefined;
    if (expectedTaskId && (!task || task.id !== expectedTaskId)) throw new RuntimeError('TASK_NOT_ACTIVE', 'The requested task is no longer active', 409);
    if (this.activeTurns.has(id)) this.interruptedTurns.add(id);
    await this.saveState(session, 'interrupting');
    if (expectedTaskId && this.activeTasks.get(id) !== task) throw new RuntimeError('TASK_NOT_ACTIVE', 'The requested task is no longer active', 409);
    await driver.interrupt();
    // A driver interrupt may finish the requested turn and let the queue start
    // another task before its promise resolves. That later task owns session
    // state; this stale request must not interrupt or overwrite it.
    if (expectedTaskId && this.activeTasks.get(id) !== task) return;
    await this.saveState(session, 'interrupted');
  }
  async setRiskPolicy(id: string, policy?: ToolRiskPolicy) {
    const { session, driver } = await this.active(id);
    await this.applyRiskPolicy(session, driver, policy);
  }
  async setModel(id: string, model: string) {
    const normalized = model.trim();
    if (!normalized) throw new RuntimeError('INVALID_MODEL', 'Model must not be empty', 400);
    const { session } = await this.active(id);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response before switching models', 409);
    const driver = await this.reconnect(session);
    if (!driver.setModel) throw new RuntimeError('MODEL_SWITCH_UNSUPPORTED', `Agent ${session.agentId} does not support runtime model switching`, 422);
    try { await driver.setModel(normalized); }
    catch (error) { throw new RuntimeError('MODEL_SWITCH_FAILED', error instanceof Error ? error.message : String(error), 422); }
    session.model = normalized;
    session.updatedAt = now();
    await this.repos.sessions.save(session);
    await this.emit(id, 'status', { state: session.state, model: normalized });
    return session;
  }
  async setReasoningEffort(id: string, reasoningEffort: string) {
    const normalized = reasoningEffort.trim();
    if (!normalized) throw new RuntimeError('INVALID_REASONING_EFFORT', 'Reasoning effort must not be empty', 400);
    const { session } = await this.active(id);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response before changing reasoning effort', 409);
    const driver = await this.reconnect(session);
    if (!driver.setReasoningEffort) throw new RuntimeError('REASONING_SWITCH_UNSUPPORTED', `Agent ${session.agentId} does not support runtime reasoning effort switching`, 422);
    try { await driver.setReasoningEffort(normalized); }
    catch (error) { throw new RuntimeError('REASONING_SWITCH_FAILED', error instanceof Error ? error.message : String(error), 422); }
    session.reasoningEffort = normalized;
    session.updatedAt = now();
    await this.repos.sessions.save(session);
    await this.emit(id, 'status', { state: session.state, reasoningEffort: normalized });
    return session;
  }
  /*
    等当前轮次收尾。

    ## 为什么必须有超时（2026-09-03）

    原实现返回的 promise **没有任何退出条件**：waiter 只在轮次自然走完 finally
    或 notifyDriverExit 时 resolve。功能 e2e 实测，忙碌轮次里调 stop/archive/restart
    会 20s 打满仍不返回，而空闲时 110ms 就回来；interrupt 不受影响，因为它压根不等。

    真因不是 driver：定向观测里真实 PtyCliDriver.stop() 1ms 返回且正确 reject 了
    send()。也不是「没有 SSE 订阅者」——那条假设在零 HTTP、零 SSE、emitter 无监听者
    的环境里被证伪，照样复现。是 runtime 自己的顺序问题：stop() 先 await driver.stop()，
    此时 send 已被 reject，但 runTask 的 catch/finally 在**另一条异步链**上；
    stop() 开始等的时候若那条链还没推进到 finally 去 resolve waiters，就再也等不到。

    ## 为什么是超时而不是"修好竞争"

    竞争本身可以调顺序缓解，但**等待一条自己不掌控的异步链，本就不该没有上限**。
    超时是正确的兜底：到点就往下走，让 stop 的后续清理（cancelSessionQueue /
    releaseSessionMemory / saveState）照常执行，而不是把整个请求永远挂住。
    调用方拿到的仍是"已停止"，因为那些清理才是 stop 的实质。

    2s 的取值：实测正常收尾在 110ms 量级，2s 是它的 18 倍，不会误伤慢轮次；
    同时明显小于调用方的耐心阈值——HTTP 客户端、e2e 看门狗普遍在 5s 以上，
    兜底必须先于它们动作，否则用户/测试先判定超时，兜底再返回也没意义了
    （初版取 5s 就正好贴在回归测试的 5s 判定窗口上，成了平局竞态）。
  */
  private waitForTurn(id: string, timeoutMs = 2_000) {
    if (!this.activeTurns.has(id)) return Promise.resolve();
    return new Promise<void>(resolve => {
      const waiters = this.turnWaiters.get(id) ?? new Set();
      let timer: NodeJS.Timeout | undefined;
      const settle = () => {
        if (timer) clearTimeout(timer);
        waiters.delete(settle);
        resolve();
      };
      waiters.add(settle);
      this.turnWaiters.set(id, waiters);
      timer = setTimeout(settle, timeoutMs);
      // 超时定时器不该拖住进程退出：shutdown 时还有未收尾的轮次是常态。
      timer.unref?.();
    });
  }
  private async terminateCurrentTurn(id: string) {
    const { session, driver } = await this.active(id);
    if (!driver) return;
    this.interruptedTurns.add(id); this.hardInterrupts.add(id);
    await this.saveState(session, 'interrupting');
    await driver.stop({ discardSession: true });
    await this.waitForTurn(id);
    if (this.drivers.get(id) === driver) this.drivers.delete(id);
    await this.saveState(session, 'interrupted');
    this.hardInterrupts.delete(id);
  }
  async pause(id: string) { const { session } = await this.active(id); const agent = await this.repos.agents.get(session.agentId); if (!agent?.capabilities.pause) throw new RuntimeError('UNSUPPORTED_CAPABILITY', `Agent ${agent?.name ?? session.agentId} does not support pause/resume`, 422); await this.interrupt(id); }
  /**
   * Resume a session.
   *
   * A pty-cli resume kills the old backend and re-spawns with the CLI's resume
   * flags, so the previous CLI exits (SIGHUP → 129) as a normal part of
   * resuming. That exit must not mark the session failed — `PtyCliDriver`
   * filters it out by backend identity before it ever reaches this callback
   * (see its `handleExit`), which is why there is no timing guard here.
   */
  async resume(id: string) {
    const { session } = await this.active(id);
    const agent = await this.repos.agents.get(session.agentId);
    if (!agent?.capabilities.resume) throw new RuntimeError('UNSUPPORTED_CAPABILITY', `Agent ${agent?.name ?? session.agentId} does not support resume`, 422);
    let driver = this.drivers.get(id);
    if (!driver) {
      const configured = this.configureAgentForSession(agent, session);
      const generation = this.nextSessionGeneration(session.id);
      driver = this.factory(configured, session.protocol!, this.onDriverEvent(session, generation), code => {
        if (this.sessionGenerations.get(session.id) !== generation) return;
        this.notifyDriverExit(session.id, code);
        if (code) void this.saveState(session, 'failed', `Agent exited with code ${code}`);
      }, session.id);
      this.drivers.set(id, driver);
    }
    await driver.resume();
    await this.saveState(session, 'idle');
  }
  async stop(id: string) {
    const { session, driver } = await this.active(id);
    this.hardInterrupts.add(id);
    if (this.activeTurns.has(id)) this.interruptedTurns.add(id);
    await driver?.stop();
    await this.waitForTurn(id);
    await this.cancelSessionQueue(id);
    this.releaseSessionMemory(id);
    await this.saveState(session, 'stopped');
  }
  async archive(id: string) {
    const session = await this.repos.sessions.get(id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
    if (session.archivedAt) return session;
    await this.stop(id);
    const stopped = (await this.repos.sessions.get(id)) ?? session;
    stopped.archivedAt = now();
    stopped.updatedAt = stopped.archivedAt;
    await this.repos.sessions.save(stopped);
    return stopped;
  }
  async restart(id: string) {
    const { session } = await this.active(id);
    await this.stop(id);
    const agent = await this.repos.agents.get(session.agentId);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', 'Agent config was removed', 404);
    session.runId = makeId('run'); session.error = undefined;
    const configured = this.configureAgentForSession(agent, session);
    const generation = this.nextSessionGeneration(session.id);
    const driver = this.factory(configured, session.protocol!, this.onDriverEvent(session, generation), code => {
      if (this.sessionGenerations.get(session.id) !== generation) return;
      this.notifyDriverExit(session.id, code);
      if (code) void this.saveState(session, 'failed', `Agent exited with code ${code}`);
    }, session.id);
    this.drivers.set(id, driver);
    await this.saveState(session, 'starting');
    await driver.start();
    await this.saveState(session, 'idle');
    return session;
  }
  async setPermissionMode(id: string, mode: PermissionMode) {
    const { session, driver } = await this.active(id);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response before switching permissions', 409);
    // 已启动驱动不支持热切换时，不得只改数据库却让子进程继续沿用
    // 旧 argv；未连接会话可以先持久化，下次 reconnect 会按新姿态启动。
    if (driver && !driver.setPermissionMode) throw new RuntimeError('PERMISSION_MODE_SWITCH_UNSUPPORTED', `Agent ${session.agentId} does not support runtime permission switching`, 422);
    driver?.setPermissionMode?.(mode);
    session.permissionMode = mode;
    session.updatedAt = now();
    await this.repos.sessions.save(session);
    return session;
  }
  getPendingPermissions(sessionId: string): PermissionRequestData[] {
    if (!this.drivers.get(sessionId)?.resolvePermission) return [];
    return [...this.permissions.entries()].filter(([key]) => key.startsWith(sessionId + ':') && !this.permissionResolutions.has(key)).map(([, value]) => ({ ...value.request }));
  }

  async resolvePermission(sessionId: string, permissionId: string, approved: boolean) {
    const { driver } = await this.active(sessionId);
    const key = this.permissionKey(sessionId, permissionId);
    const pending = this.permissions.get(key);
    if (!pending) throw new RuntimeError('PERMISSION_NOT_FOUND', 'Permission request is no longer active', 404);
    if (this.permissionResolutions.has(key)) throw new RuntimeError('PERMISSION_RESOLVING', 'Permission decision is already being submitted', 409);
    if (!driver?.resolvePermission) throw new RuntimeError('PERMISSION_EXPIRED', 'The original approval driver is unavailable', 409);
    const claim = makeId('permission_claim'); this.permissionResolutions.set(key, claim);
    try {
      if (pending.generation !== (this.sessionGenerations.get(sessionId) ?? 0) || this.permissions.get(key) !== pending) throw new RuntimeError('PERMISSION_EXPIRED', 'Permission request is no longer active', 409);
      const request = { ...pending.request, status: approved ? 'approved' as const : 'rejected' as const };
      // Keep the stored request pending while recording the requested decision.
      // A failed driver call must not be represented as an accepted decision.
      const intent = { ...pending.request, resolutionIntent: request.status };
      await this.repos.artifacts.savePermission(sessionId, intent);
      if (this.permissionResolutions.get(key) !== claim || this.permissions.get(key) !== pending || this.drivers.get(sessionId) !== driver || pending.generation !== (this.sessionGenerations.get(sessionId) ?? 0)) {
        throw new RuntimeError('PERMISSION_EXPIRED', 'Permission request is no longer active', 409);
      }
      const resolved = await driver.resolvePermission(permissionId, approved);
      if (!resolved || this.drivers.get(sessionId) !== driver || pending.generation !== (this.sessionGenerations.get(sessionId) ?? 0)) {
        if (this.permissions.get(key) === pending) this.permissions.delete(key);
        throw new RuntimeError('PERMISSION_EXPIRED', 'Permission request is no longer active', 409);
      }
      // ACPX may synchronously emit its terminal permission update before its
      // resolve promise settles. That event is the canonical audit record.
      if (this.permissions.get(key) !== pending) return request;
      this.permissions.delete(key);
      this.touch(sessionId);
      try {
        await this.repos.artifacts.savePermission(sessionId, request);
        await this.emit(sessionId, 'permission_request', request);
      } catch (error) {
        throw new RuntimeError('PERMISSION_ACCEPTED_AUDIT_FAILED', `Permission accepted but audit delivery failed: ${error instanceof Error ? error.message : String(error)}`, 503);
      }
      // Subsequent driver events own the session state; an approval must not overwrite a completed turn.
      return request;
    } finally { if (this.permissionResolutions.get(key) === claim) this.permissionResolutions.delete(key); }
  }

  private releaseSessionMemory(sessionId: string) {
    this.drivers.delete(sessionId);
    this.replayedEvents.delete(sessionId);
    this.sequences.delete(sessionId);
    this.lastActivity.delete(sessionId);
    this.activeTasks.delete(sessionId);
    this.interruptedTurns.delete(sessionId);
    this.hardInterrupts.delete(sessionId);
    this.driverStopReasons.delete(sessionId);
    this.turnErrors.delete(sessionId);
    this.exitListeners.delete(sessionId);
    this.driverEventChains.delete(sessionId);
    this.driverEventErrors.delete(sessionId);
    this.queues.delete(sessionId);
    this.queueRuns.delete(sessionId);
    for (const resolve of this.turnWaiters.get(sessionId) ?? []) resolve();
    this.turnWaiters.delete(sessionId);
    this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1);
    for (const key of this.permissions.keys()) if (key.startsWith(`${sessionId}:`)) this.permissions.delete(key);
    for (const key of this.permissionResolutions.keys()) if (key.startsWith(`${sessionId}:`)) this.permissionResolutions.delete(key);
  }

  private async cleanupIdleDriversOnce(at: number) {
    const timeout = this.options.driverIdleTimeoutMs ?? 6 * 60 * 60_000;
    if (timeout <= 0) return;
    for (const [sessionId, driver] of this.drivers) {
      if (this.activeTurns.has(sessionId) || at - (this.lastActivity.get(sessionId) ?? at) < timeout) continue;
      const session = await this.repos.sessions.get(sessionId);
      if (!session || !['idle', 'completed', 'interrupted'].includes(session.state)) continue;
      try { await driver.stop(); } finally { this.releaseSessionMemory(sessionId); }
    }
  }

  async cleanupIdleDrivers(at = Date.now()) {
    if (this.cleanupRun) return this.cleanupRun;
    const run = this.cleanupIdleDriversOnce(at); this.cleanupRun = run;
    try { await run; } finally { if (this.cleanupRun === run) this.cleanupRun = undefined; }
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.cleanupRun;
    const drivers = [...this.drivers.values()];
    this.drivers.clear();
    await Promise.allSettled(drivers.map(driver => driver.stop()));
    // Some drivers never settle send() after stop(); keep the existing bounded
    // turn-wait contract while allowing detached tasks to persist their state.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.taskRuns, ...this.queueRuns.values()]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
    this.taskRuns.clear();
    await Promise.allSettled(this.driverEventChains.values());
    this.replayedEvents.clear();
    this.sequences.clear(); this.permissions.clear(); this.permissionResolutions.clear(); this.sessionGenerations.clear(); this.lastActivity.clear(); this.activeTurns.clear(); this.activeTasks.clear(); this.interruptedTurns.clear(); this.hardInterrupts.clear(); this.turnErrors.clear(); this.driverEventChains.clear(); this.driverEventErrors.clear();
    for (const waiters of this.turnWaiters.values()) for (const resolve of waiters) resolve();
    this.turnWaiters.clear(); this.queues.clear(); this.queueRuns.clear(); this.emitter.removeAllListeners();
  }
}
