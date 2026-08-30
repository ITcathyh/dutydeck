import { EventEmitter } from 'node:events';
import type { AgentConfig, AgentDriver, AgentEvent, DriverFactory, EventType, EventWindowOptions, NormalizedDriverEvent, PermissionMode, PermissionRequestData, RepositoryBundle, Session, StartSessionInput, TaskExecutionContext, TaskRecord, ToolCallData, ToolRiskPolicy } from '@dockmux/shared';
import { makeId, now, RuntimeError } from '@dockmux/shared';
import { AcpxAdapter } from '@dockmux/acp-client';
import { JsonlTransport, PipeTransport, probeAgent, PtyTransport, type ProbeMatrix } from '@dockmux/transports';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

// 驱动契约类型统一从 @dockmux/shared 导出（driver.ts 是跨团队冻结契约），
// 本包不再自定义 AgentDriver / DriverFactory / NormalizedDriverEvent。
export type { AgentDriver, DriverFactory, NormalizedDriverEvent };

export interface RuntimeOptions {
  acpxCommand?: string;
  driverFactory?: DriverFactory;
  /**
   * pty-cli 协议驱动工厂（botmux 适配器栈，由 @dockmux/pty-driver 提供）。
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

export class DockmuxRuntime {
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
  private readonly permissions = new Map<string, PermissionRequestData>();
  private readonly driverEventChains = new Map<string, Promise<void>>();
  private readonly driverEventErrors = new Map<string, unknown>();
  private readonly driverStopReasons = new Map<string, string>();
  private readonly turnErrors = new Map<string, string>();
  private readonly exitListeners = new Map<string, Set<(code: number | null) => void>>();
  private readonly factory: DriverFactory;
  private readonly lastActivity = new Map<string, number>();
  private readonly cleanupTimer?: NodeJS.Timeout;
  private cleanupRun?: Promise<void>;

  constructor(private readonly repos: RepositoryBundle, private readonly options: RuntimeOptions = {}) {
    const ptyDriverFactory = options.ptyDriverFactory;
    this.factory = options.driverFactory ?? ((agent, protocol, onEvent, onExit, sessionId) => {
      if (protocol === 'acp') return new AcpxAdapter({ ...agent, env: { ...agent.env, dockmux_session_id: sessionId } }, { sessionKey: sessionId, onEvent });
      if (protocol === 'pty-cli') {
        if (!ptyDriverFactory) throw new RuntimeError('DRIVER_UNAVAILABLE', 'protocol 为 pty-cli 的 agent 需要注入 ptyDriverFactory（@dockmux/pty-driver）', 503);
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
  private enqueueDriverEvent(session: Session, event: NormalizedDriverEvent) {
    const previous = this.driverEventChains.get(session.id) ?? Promise.resolve();
    const next = previous.then(() => this.consume(session, event)).catch(error => {
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
    if (DockmuxRuntime.isTruncatedStopReason(stopReason)) {
      return { status: 'failed', stopReason, message: `输出因达到 token 上限被截断（stopReason: ${stopReason}），未产生完整最终输出` };
    }
    if (!await this.turnHasFinalAssistantText(session.id, promptSequence)) {
      return { status: 'failed', stopReason, message: 'Agent 未返回最终输出' };
    }
    return { status: 'completed', stopReason };
  }
  private onDriverEvent(session: Session) {
    return (event: NormalizedDriverEvent) => this.enqueueDriverEvent(session, event);
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
        const message = session.error ?? 'Dockmux 守护进程重启，未完成启动的会话已回收';
        session.state = 'failed';
        session.error = message;
        session.archivedAt = now();
        session.updatedAt = session.archivedAt;
        await this.repos.sessions.save(session);
        continue;
      }
      const orphaned = persistedTasks.filter(task => task.status === 'running');
      if (orphaned.length) {
        const message = 'Dockmux 守护进程重启，正在进行的任务已中断';
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
        const message = 'Dockmux 守护进程重启，旧任务缺少可验证的执行上下文，已安全中断，请重新发送';
        for (const task of legacyQueued) {
          await this.saveTask(task, 'interrupted');
          await this.repos.artifacts.saveError(session.id, message, { taskId: task.id });
          await this.emit(session.id, 'error', { message, taskId: task.id });
        }
        if (legacyQueued.length === queuedTasks.length && !['stopped', 'failed'].includes(session.state)) await this.saveState(session, 'interrupted', message);
      }
      const queued = queuedTasks.filter(task => typeof task.executionContext?.agentPrompt === 'string');
      if (queued.length) {
        this.queues.set(session.id, queued);
        if (!['stopped', 'failed'].includes(session.state)) this.scheduleQueue(session.id);
      }
    }
  }
  listAgents() { return this.repos.agents.list(); }
  listSessions() { return this.repos.sessions.list(); }
  getSession(id: string) { return this.repos.sessions.get(id); }
  /** 只读访问当前内存中的 driver 实例（如终端 WS 代理取 createTerminalStream）；未连接/已释放时返回 undefined。 */
  getDriver(sessionId: string): AgentDriver | undefined { return this.drivers.get(sessionId); }
  getEvents(id: string, after = 0) { return this.repos.events.list(id, after); }
  getRecentEvents(id: string, limit: number) { return this.repos.events.listRecent(id, limit); }
  getEventWindow(id: string, options?: EventWindowOptions) { return this.repos.events.listWindow(id, options); }
  async getTasks(id: string) { return (await this.repos.tasks.listBySession(id)).map(task => this.publicTask(task)); }

  /**
   * 外部来源事件写入（通用回传通道 @dockmux/relay 使用）。
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

  private async emit(sessionId: string, type: EventType, data: any, raw?: string) {
    const sequence = (this.sequences.get(sessionId) ?? (await this.repos.events.listRecent(sessionId, 1)).at(-1)?.sequence ?? 0) + 1;
    this.sequences.set(sessionId, sequence);
    const event: AgentEvent = { id: makeId('evt'), sessionId, sequence, type, timestamp: now(), data, ...(raw ? { raw } : {}) };
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

  private executionContext(agentPrompt: string, riskPolicy?: ToolRiskPolicy): TaskExecutionContext {
    return {
      agentPrompt,
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
      if (data.status === 'pending') { this.permissions.set(this.permissionKey(session.id, data.id), data); await this.saveState(session, 'waiting_for_permission'); }
      await this.repos.artifacts.savePermission(session.id, data);
    } else if (event.type === 'error') {
      if (this.activeTurns.has(session.id)) this.turnErrors.set(session.id, data.message);
      await this.repos.artifacts.saveError(session.id, data.message, data.detail);
      // Error events emitted during a turn describe that task. runTask owns the
      // terminal task outcome and returns a reusable shared Session to idle.
      // Outside an active turn the same event is a driver-level hard failure.
      if (!this.activeTurns.has(session.id)) await this.saveState(session, 'failed', data.message);
    }
    await this.emit(session.id, event.type, data, event.raw);
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
    const driver = this.factory(this.configureAgentForSession(configured, session), capability.protocol, this.onDriverEvent(session), code => { this.notifyDriverExit(session.id, code); if (code && session.state !== 'stopped' && !this.interruptedTurns.has(session.id) && !this.hardInterrupts.has(session.id)) void this.saveState(session, 'failed', `Agent exited with code ${code}`).then(() => this.emit(session.id, 'error', { message: `Agent exited with code ${code}` })); }, session.id);
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
    const session = await this.repos.sessions.get(id);
    if (!session) throw new RuntimeError('SESSION_NOT_FOUND', `Unknown session: ${id}`, 404);
    if (session.archivedAt) throw new RuntimeError('SESSION_ARCHIVED', 'Archived sessions are read-only', 409);
    const driver = this.drivers.get(id);
    return { session, driver };
  }

  private async reconnect(session: Session) {
    const existing = this.drivers.get(session.id);
    if (existing) return existing;
    const agent = await this.repos.agents.get(session.agentId);
    if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${session.agentId}`, 404);
    const configured = this.configureAgentForSession(agent, session);
    const driver = this.factory(configured, session.protocol!, this.onDriverEvent(session), code => {
      if (code && session.state !== 'stopped' && !this.interruptedTurns.has(session.id) && !this.hardInterrupts.has(session.id)) void this.saveState(session, 'failed', `Agent exited with code ${code}`).then(() => this.emit(session.id, 'error', { message: `Agent exited with code ${code}` }));
    }, session.id);
    this.drivers.set(session.id, driver);
    try { await driver.start(); this.touch(session.id); return driver; }
    catch (error) { this.drivers.delete(session.id); throw error; }
  }

  private async applyRiskPolicy(session: Session, driver: AgentDriver | undefined, policy?: ToolRiskPolicy) {
    driver?.setRiskPolicy?.(policy);
    const directory = join(session.cwd, '.dockmux', 'security', 'sessions');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${session.id}.json`), JSON.stringify(policy ?? { enabled: false }), { mode: 0o600 });
  }

  private async runTask(id: string, task: TaskRecord) {
    const { session } = await this.active(id);
    if (['stopped', 'failed'].includes(session.state)) throw new RuntimeError('INVALID_STATE', `Cannot send while session is ${session.state}`, 409);
    if (this.activeTurns.has(id)) throw new RuntimeError('TURN_IN_PROGRESS', 'Wait for the current response to finish', 409);
    this.activeTurns.add(id);
    this.activeTasks.set(id, task);
    this.driverStopReasons.delete(id);
    this.turnErrors.delete(id);
    this.touch(id);
    try {
      const driver = await this.reconnect(session);
      const { agentPrompt = task.prompt, riskPolicy } = task.executionContext ?? {};
      // 每个任务都明确设置（或清除）策略，避免复用会话沿用上一个
      // Lark 任务的高危正则到普通 Web/CLI 任务。
      await this.applyRiskPolicy(session, driver, riskPolicy);
      await this.saveTask(task, 'running');
      const promptEvent = await this.emit(id, 'text', { text: task.prompt, role: 'user', taskId: task.id });
      await this.saveState(session, 'thinking');
      const resolvedAgentPrompt = await this.options.sessionPrompt?.(session, agentPrompt) ?? agentPrompt;
      await driver.send(resolvedAgentPrompt);
      await this.flushDriverEvents(id);
      const outcome = await this.resolveTaskOutcome(session, promptEvent.sequence);
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
      const interrupted = this.interruptedTurns.has(id) || this.driverStopReasons.get(id) === 'cancelled';
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

  async send(id: string, prompt: string, agentPrompt = prompt, riskPolicy?: ToolRiskPolicy) {
    const task: TaskRecord = { id: makeId('task'), sessionId: id, prompt, status: 'running', executionContext: this.executionContext(agentPrompt, riskPolicy), createdAt: now(), updatedAt: now() };
    return this.runTask(id, task);
  }

  async dispatch(id: string, prompt: string, mode: 'queue' | 'interrupt' = 'queue', agentPrompt = prompt, riskPolicy?: ToolRiskPolicy) {
    const { session } = await this.active(id);
    if (['stopped', 'failed'].includes(session.state)) throw new RuntimeError('INVALID_STATE', `Cannot send while session is ${session.state}`, 409);
    const task: TaskRecord = { id: makeId('task'), sessionId: id, prompt, status: 'queued', executionContext: this.executionContext(agentPrompt, riskPolicy), createdAt: now(), updatedAt: now() };
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
    if (this.queueRuns.has(id) || this.activeTurns.has(id)) return;
    const run = this.drainQueue(id); this.queueRuns.set(id, run);
    void run.finally(() => { if (this.queueRuns.get(id) === run) this.queueRuns.delete(id); });
  }

  private async drainQueue(id: string) {
    while (!this.activeTurns.has(id)) {
      const queue = this.queues.get(id);
      const task = queue?.shift();
      if (!task) { this.queues.delete(id); return; }
      if (!queue?.length) this.queues.delete(id);
      try { await this.runTask(id, task); }
      catch {
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

  async interrupt(id: string) { const { session, driver } = await this.active(id); if (!driver) throw new RuntimeError('SESSION_DISCONNECTED', 'Session is disconnected', 409); if (this.activeTurns.has(id)) this.interruptedTurns.add(id); await this.saveState(session, 'interrupting'); await driver.interrupt(); await this.saveState(session, 'interrupted'); }
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
  private waitForTurn(id: string) {
    if (!this.activeTurns.has(id)) return Promise.resolve();
    return new Promise<void>(resolve => { const waiters = this.turnWaiters.get(id) ?? new Set(); waiters.add(resolve); this.turnWaiters.set(id, waiters); });
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
      driver = this.factory(configured, session.protocol!, this.onDriverEvent(session), code => {
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
  async restart(id: string) { const { session } = await this.active(id); await this.stop(id); const agent = await this.repos.agents.get(session.agentId); if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', 'Agent config was removed', 404); session.runId = makeId('run'); session.error = undefined; const configured = this.configureAgentForSession(agent, session); const driver = this.factory(configured, session.protocol!, this.onDriverEvent(session), code => { this.notifyDriverExit(session.id, code); if (code) void this.saveState(session, 'failed', `Agent exited with code ${code}`); }, session.id); this.drivers.set(id, driver); await this.saveState(session, 'starting'); await driver.start(); await this.saveState(session, 'idle'); return session; }
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
  async resolvePermission(sessionId: string, permissionId: string, approved: boolean) { const { session, driver } = await this.active(sessionId); const key = this.permissionKey(sessionId, permissionId); const request = this.permissions.get(key); if (!request) throw new RuntimeError('PERMISSION_NOT_FOUND', `Unknown permission request: ${permissionId}`, 404); const resolved = await driver?.resolvePermission?.(permissionId, approved); if (driver?.resolvePermission && !resolved) throw new RuntimeError('PERMISSION_EXPIRED', `Permission request is no longer active: ${permissionId}`, 409); request.status = approved ? 'approved' : 'rejected'; this.permissions.delete(key); this.touch(sessionId); await this.repos.artifacts.savePermission(sessionId, request); await this.emit(sessionId, 'permission_request', request); await this.saveState(session, 'thinking'); return request; }

  private releaseSessionMemory(sessionId: string) {
    this.drivers.delete(sessionId);
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
    for (const key of this.permissions.keys()) if (key.startsWith(`${sessionId}:`)) this.permissions.delete(key);
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
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await this.cleanupRun;
    const drivers = [...this.drivers.values()];
    this.drivers.clear();
    await Promise.allSettled(drivers.map(driver => driver.stop()));
    await Promise.allSettled(this.queueRuns.values());
    await Promise.allSettled(this.driverEventChains.values());
    this.sequences.clear(); this.permissions.clear(); this.lastActivity.clear(); this.activeTurns.clear(); this.activeTasks.clear(); this.interruptedTurns.clear(); this.hardInterrupts.clear(); this.turnErrors.clear(); this.driverEventChains.clear(); this.driverEventErrors.clear();
    for (const waiters of this.turnWaiters.values()) for (const resolve of waiters) resolve();
    this.turnWaiters.clear(); this.queues.clear(); this.queueRuns.clear(); this.emitter.removeAllListeners();
  }
}
