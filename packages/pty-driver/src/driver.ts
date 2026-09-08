import type { AgentConfig, AgentDriver, NormalizedDriverEvent, TerminalStream } from '@dockmux/shared';
import type { AdapterSessionContext, CliAdapter } from '@dockmux/cli-adapters';
import { buildDockmuxRoutingBlock } from '@dockmux/cli-adapters';
import { PtyBackend, TmuxBackend, type SessionBackend } from '@dockmux/session-backends';
import { TerminalSnapshot } from '@dockmux/terminal-renderer';
import { IdleDetector } from './idle-detector.js';
import { createTranscriptTailer, type TranscriptEventSource } from './transcript/index.js';
import { buildSessionMarker, resolveCliSessionId } from './session-id/index.js';

export interface PtyCliDriverOptions {
  agent: AgentConfig;
  adapter: CliAdapter;
  /** 默认 new PtyBackend()；tmux 持久会话由调用方注入 TmuxBackend。 */
  backend?: SessionBackend;
  onEvent: (e: NormalizedDriverEvent) => void;
  onExit: (code: number | null) => void;
  /** Driver-owned stop completed (explicit kill or daemon detach). */
  onStopped?: () => void;
  sessionId: string;
  /**
   * 已知的 CLI 原生 session id（调用方持久化过的话）。给了就直接用，
   * 不做磁盘反查——这是最可靠的来源。
   */
  cliSessionId?: string;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
/** raw_terminal 节流窗口：窗口内屏幕文本没变就不发。 */
const RAW_TERMINAL_THROTTLE_MS = 200;

/**
 * PtyCliDriver = cli-adapters + session-backends + idle-detector + transcript
 * 四路合成 AgentDriver 事件流。
 *
 * 事件来源（三路合并，按发生顺序回调）：
 *  1. transcript tail（claude-code JSONL / codex rollout 等）→ 结构化事件，原样转发
 *  2. 屏幕流（backend.onData → TerminalSnapshot）→ raw_terminal 节流广播，兜底永不丢
 *  3. idle-detector 屏幕观察 → 一轮结束时发恰好一次 completed
 *
 * 不变量：一轮 send() 恰好发一次 completed（turnActive 闩锁保证，idle 重复触发被吞掉）。
 */
export class PtyCliDriver implements AgentDriver {
  private readonly agent: AgentConfig;
  private readonly adapter: CliAdapter;
  private readonly sessionId: string;
  private readonly emitEvent: (e: NormalizedDriverEvent) => void;
  private readonly exitCallback: (code: number | null) => void;
  private readonly stoppedCallback: (() => void) | undefined;

  private backend: SessionBackend;
  private readonly cwd: string;

  private started = false;
  private stopped = false;
  /** Normal daemon shutdown preserves a persistent backend; explicit
   * session stop/restart still destroys it. Set only by the service
   * composition root immediately before runtime.shutdown(). */
  private detachOnStop = false;
  private exitReported = false;
  /** 一轮任务进行中：send() 置 true，completed 发出后置 false。 */
  private turnActive = false;
  private firstPromptSent = false;
  /** 本轮是否已收到 CLI 的实质性输出（text/thinking/tool）。
   *  idle 检测在 CLI 启动期（splash 屏静止）会误判为空闲，必须等至少
   *  一条实质事件后才允许 completed。 */
  private turnHasOutput = false;
  /** 本轮开始时间——用于启动宽限期：CLI 初始化期间 PTY 静止，
   *  idle 检测会误判，宽限期内禁止 completed。 */
  private turnStartedAt = 0;
  private static readonly TURN_GRACE_MS = 15_000;
  /** send() 的等待者：send() 必须等本轮 completed（或 driver 退出）才 resolve，
   *  与 AcpxAdapter 的语义对齐（runtime 在 send resolve 后立即判定终态）。 */
  private turnResolve: (() => void) | null = null;
  private turnReject: ((err: Error) => void) | null = null;

  private idleDetector: IdleDetector | undefined;
  private snapshot: TerminalSnapshot | undefined;
  private transcript: TranscriptEventSource | undefined;
  private rawTerminalTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRawTerminalText = '';
  /** createTerminalStream 订阅者集合，driver 级持有，rewire 后继续生效。 */
  private readonly terminalSubscribers = new Set<(data: string) => void>();

  private lastArgs: string[] = [];
  /** spawn 用的环境。start() 时算好；但 daemon 重启形态下 driver 从没 start()
   *  就直接 resume()，那条路径必须自己算——否则 respawn 出来的 CLI 环境全空
   *  （PATH 都没有），起不来。用 spawnEnv() 惰性取，不要直接读这个字段。 */
  private lastSpawnEnv: Record<string, string> | undefined;
  /** CLI 原生 session id：调用方注入的、或 resume 时从 CLI 落盘记录反查到的。
   *  一旦确定就缓存——反查要扫目录，同一会话不该反复付这个钱。 */
  private cliSessionId: string | undefined;

  constructor(opts: PtyCliDriverOptions) {
    this.agent = opts.agent;
    this.adapter = opts.adapter;
    this.sessionId = opts.sessionId;
    this.emitEvent = opts.onEvent;
    this.exitCallback = opts.onExit;
    this.stoppedCallback = opts.onStopped;
    this.backend = opts.backend ?? new PtyBackend();
    this.cwd = opts.agent.cwd ?? process.cwd();
    this.cliSessionId = opts.cliSessionId;
  }

  private assertPermissionModeSupported() {
    if (this.agent.permissionMode !== 'ask' && this.agent.permissionMode !== 'full-trust') {
      throw new Error(`PTY Agent ${this.agent.id} does not support permission mode ${this.agent.permissionMode}; use ask or full-trust`);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.assertPermissionModeSupported();

    // Runtime reconnects a persisted Dockmux session by constructing a fresh
    // driver and calling start(), not resume(). A production-injected tmux
    // backend therefore has to attach here when its owned pane survived the
    // daemon, otherwise spawn() would collide with the live session.
    const tmuxName = this.tmuxSessionName();
    if (tmuxName !== undefined) {
      const probe = TmuxBackend.probeSession(tmuxName);
      if (probe === 'exists') {
        this.reattachTmux(tmuxName, false);
        this.markTmuxReattached();
        return;
      }
      if (probe === 'unknown') {
        throw new Error(`Cannot determine whether persistent tmux session ${tmuxName} is alive; refusing to spawn a duplicate CLI`);
      }
    }

    this.started = true;
    this.lastArgs = this.adapter.buildArgs({
      sessionId: this.sessionId,
      cwd: this.agent.cwd,
      model: this.agent.model,
      reasoningEffort: this.agent.reasoningEffort,
      permissionMode: this.agent.permissionMode,
    });
    this.backend.spawn(this.agent.command, this.lastArgs, {
      cwd: this.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      env: this.spawnEnv(),
    });
    this.wire(this.backend);
  }

  /** spawn 环境，首次调用时算好并缓存。resume-without-start 也走这里。 */
  private spawnEnv(): Record<string, string> {
    return (this.lastSpawnEnv ??= mergedEnv(this.agent.env));
  }

  async send(prompt: string): Promise<void> {
    if (this.stopped) throw new Error('PtyCliDriver: send() called after stop()');
    if (!this.started) await this.start();

    let finalPrompt = prompt;
    const isFirstPrompt = !this.firstPromptSent;
    if (isFirstPrompt) {
      // 首轮 prompt 前注入路由块：适配器自带 injectSessionContext 的用它
      // （claude-code/grok），其余用默认 DOCKMUX_SHELL_HINTS 块——教 CLI
      // 自己正跑在无人值守桥接会话里（botmux 对大多数 CLI 同样注入）。
      const block = this.adapter.injectSessionContext
        ? this.adapter.injectSessionContext(this.sessionContext())
        : buildDockmuxRoutingBlock(this.sessionContext().locale, this.agent.env);
      // 会话指纹：CLI 会把提交的 prompt 文本落盘（claude jsonl / codex
      // history.jsonl / grok prompt_history.jsonl / opencode part 表），
      // 这个标记因此成为「dockmux 会话 ↔ CLI 原生 session id」的反查锚点。
      // 必须在首轮就注入，resume 时才有东西可查。见 session-id/marker.ts。
      const marker = buildSessionMarker(this.sessionId);
      const prefix = block ? `${block.replace(/\n$/, '')}\n${marker}` : marker;
      finalPrompt = `${prefix}\n${finalPrompt}`;
    }
    this.turnActive = true;
    this.turnHasOutput = false;
    this.turnStartedAt = Date.now();
    this.idleDetector?.reset();
    await this.adapter.writeInput(this.backend, finalPrompt);
    this.firstPromptSent = true;
    if (isFirstPrompt && this.backend instanceof TmuxBackend) {
      // tmux owns this tiny non-secret lifecycle marker across daemon
      // restarts, so reattach neither repeats nor accidentally skips the
      // first-turn routing/session marker.
      try { this.backend.setDockmuxMetadata('first_prompt_sent', 'true'); }
      catch { /* A missing lifecycle marker may repeat context after restart, but must not fail a prompt already sent. */ }
    }

    // 与 AcpxAdapter 语义对齐：send() 等本轮结束（completed）才 resolve，
    // runtime 在 send resolve 后立即判定终态。driver 退出则 reject。
    return new Promise<void>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;
    });
  }

  async interrupt(): Promise<void> {
    if (this.stopped) return;
    this.backend.interrupt();
    // 不主动发 completed——等 idle 检测到 prompt 回归自然完成（turnActive 仍为 true）。
    this.emitEvent({ type: 'status', data: { state: 'interrupted' } });
    // 但 send() 的等待者需要被唤醒——interrupt 后 runtime 会走 interrupted 路径。
    this.turnActive = false;
    this.turnResolve?.();
    this.turnResolve = null;
    this.turnReject = null;
  }

  async resume(): Promise<void> {
    if (this.stopped) return;
    this.assertPermissionModeSupported();
    // 路径 1：tmux 会话仍在 → reattach（后端内部重启 pipe-pane 捕获，driver 重建订阅）。
    const tmuxName = this.tmuxSessionName();
    const tmuxProbe = tmuxName === undefined ? 'missing' : TmuxBackend.probeSession(tmuxName);
    if (tmuxName !== undefined && tmuxProbe === 'exists') {
      this.reattachTmux(tmuxName, this.started);
      // daemon 重启后的典型形态：新 driver 直接 resume()，从没调过 start()。
      // 必须置 started，否则接下来的 send() 会走 start() 再 spawn 一次，
      // 把刚 attach 上的后端二次 spawn（tmux 后端直接抛 "spawn() called twice"）。
      // 同理 firstPromptSent：CLI 进程还活着，上一条 prompt 里的路由块/指纹
      // 仍在它的上下文里，重发一遍只会污染会话。
      this.markTmuxReattached();
      return;
    }
    if (tmuxName !== undefined && tmuxProbe === 'unknown') {
      throw new Error(`Cannot determine whether persistent tmux session ${tmuxName} is alive; refusing to replace it`);
    }
    // 路径 2：适配器支持 CLI 级 resume → kill 旧后端，带 resume 参数重 spawn。
    if (!this.adapter.buildResumeCommand) return;   // 无 resume 能力 → no-op
    const plan = this.planResume();
    this.respawn(plan.args);
    if (plan.kind === 'resume') {
      this.markResumed();
      return;
    }
    // 降级为全新会话：后端是活的（不该再 spawn），但 CLI 里什么上下文都没有。
    // 必须重新走首轮注入——路由块要重发，而且会话指纹是「dockmux 会话 ↔ CLI
    // 原生 id」反查的唯一锚点，新会话不重新打标，下一次 resume 同样反查不到。
    this.started = true;
    this.firstPromptSent = false;
    // 旧的 CLI id（若有）指向的会话已经不是当前这个了，清掉免得污染下次反查。
    this.cliSessionId = undefined;
    this.emitResumeDegraded(plan.attemptedSessionId);
  }

  /**
   * resume 决策：续接既有会话，还是放弃 resume 改起新会话。
   *
   * `buildResumeCommand` 在这里有双重身份：既是 resume 能力的声明位，也是
   * 「这个 id 能不能用」的裁决者。返回 null = 适配器认定该 id 对它的 CLI 无效
   * （最典型的是反查失败后退回来的 dockmux sessionId），此时带着这个 id 启动
   * 必然失败——`opencode -s <不存在的id>` 立刻 exit 1，会话随即被判 failed。
   * 与其起一个注定崩掉的进程，不如起一个干净会话：丢上下文是降级，起不来是故障。
   *
   * 真正的 argv 仍然走 `buildArgs`（见下），buildResumeCommand 只出裁决与定位。
   */
  private planResume():
    | { kind: 'resume'; args: string[] }
    | { kind: 'fresh'; args: string[]; attemptedSessionId: string } {
    const resumeSessionId = this.resolveResumeSessionId();
    const fragment = this.adapter.buildResumeCommand?.(resumeSessionId) ?? null;
    if (fragment === null) {
      // 适配器否决了这个 id：起全新会话，argv 走 fresh 分支（不带任何 resume 定位）。
      return {
        kind: 'fresh',
        args: this.adapter.buildArgs(this.sessionContext()),
        attemptedSessionId: resumeSessionId,
      };
    }
    return { kind: 'resume', args: this.buildResumeArgs(resumeSessionId, fragment) };
  }

  /**
   * resume 重 spawn 的完整 argv。
   *
   * 不能直接用 `adapter.buildResumeCommand()` 当 argv——它只产出**续接定位**
   * 那几个参数（claude 是 `--resume <uuid>`），不含权限姿态、settings、
   * disallowed-tools 等通用启动参数。拿它当完整 argv 会丢掉会话配置，
   * 甚至使 CLI 在启动交互处 exit 1（真实环境实测：resume 返回 200，
   * 2 秒后 state=failed，之后 send 全部 409）。
   *
   * 正解是走 `buildArgs({ resume: true, resumeSessionId })`：适配器在那里把
   * 「续接定位 + 常规启动参数」拼成一套完整 argv。传进来的 fragment 只在
   * 「适配器没在 buildArgs 里实现 resume 分支」时兜底。
   */
  private buildResumeArgs(resumeSessionId: string, fragment: string[]): string[] {
    const args = this.adapter.buildArgs({
      ...this.sessionContext(),
      resume: true,
      resumeSessionId,
    });
    if (args.length > 0) return args;
    // 适配器没在 buildArgs 里实现 resume 分支时，退回续接片段（聊胜于无）。
    return fragment;
  }

  /**
   * 告诉用户「resume 降级成新会话了」。
   *
   * 发两条，各有各的受众：
   *  - `status`：结构化、机器可读，时间线与卡片不渲染，供 runtime/relay 判读。
   *  - `text`：人读的一句话。降级是**静默丢上下文**——CLI 好端端地起来了，用户
   *    看不出任何异样，直到发现 agent 不记得刚才聊过什么。这条必须可见。
   *
   * 刻意不发 `error`：runtime 对轮次之外的 error 的处置是把会话打成 failed
   * （见 agent-runtime 的 onDriverEvent），而这里新进程明明已经正常起来了，
   * 打成 failed 会让后续 send 全部 409 —— 那才是真故障。
   */
  private emitResumeDegraded(attemptedSessionId: string): void {
    this.emitEvent({
      type: 'status',
      data: {
        state: 'resume_degraded',
        reason: 'unusable_cli_session_id',
        adapterId: this.adapter.id,
        attemptedSessionId,
      },
    });
    this.emitEvent({
      type: 'text',
      data: {
        role: 'assistant',
        text: `⚠️ 无法恢复原会话（${this.adapter.id} 认不出会话 id `
          + `\`${attemptedSessionId}\`），已改为**新起一个干净会话**。`
          + `之前的上下文不会带过来，需要的话请重新交代背景。`,
      },
    });
  }

  /** CLI-level resume 之后 driver 已有一个接好线的活后端：start() 不该再 spawn，
   *  首轮注入也不该重来（会话上下文已经带着它了）。 */
  private markResumed(): void {
    this.started = true;
    this.firstPromptSent = true;
  }

  /** tmux reattach restores the exact first-prompt state saved on the owned
   * session. This also handles a daemon restart between session start and the
   * first user prompt without silently losing the routing/session marker. */
  private markTmuxReattached(): void {
    this.started = true;
    this.firstPromptSent = this.backend instanceof TmuxBackend
      && this.backend.getDockmuxMetadata('first_prompt_sent') === 'true';
  }

  /**
   * resume 要传给适配器的 session id。
   *
   * 旧行为直接传 dockmux 的 sessionId，这只有在「dockmux 亲自把 id 钉给 CLI」
   * 时才成立（claude `--session-id`、grok `--session-id`）。大多数 CLI 自己
   * 生成 id 且从不告诉我们，那些 resume 于是静默起了个全新会话，或者对
   * `codex resume <id>` 这类形态直接失败。
   *
   * 三级优先：
   *  1. 调用方注入/上次反查缓存的 cliSessionId —— 最可靠，不碰磁盘。
   *  2. 从 CLI 自己的落盘记录反查（按首轮 prompt 里的会话指纹匹配）。
   *  3. 反查不到 → 退回 dockmux sessionId（旧行为）。绝不抛错、绝不卡住：
   *     对钉过 id 的 CLI 这本来就是对的，对其余 CLI 它至少能起一个新会话，
   *     而 resume 失败绝不该让整个会话不可用。
   */
  private resolveResumeSessionId(): string {
    if (this.cliSessionId) return this.cliSessionId;
    const found = resolveCliSessionId(this.adapter.id, {
      sessionId: this.sessionId,
      cwd: this.cwd,
      // The CLI recorded its id under the data root ITS env named — see the
      // note on spawnEnv() and cli-paths.ts.
      env: this.spawnEnv(),
    });
    if (found) {
      this.cliSessionId = found;
      return found;
    }
    return this.sessionId;
  }

  /** 已确定的 CLI 原生 session id（未确定则 undefined）。调用方可持久化它，
   *  下次构造 driver 时经 `cliSessionId` 传回来，省掉一次目录扫描。 */
  getCliSessionId(): string | undefined {
    return this.cliSessionId;
  }

  /**
   * Mark the next normal stop as a daemon-lifecycle detach. The service calls
   * this immediately before runtime.shutdown(); user stop/restart paths never
   * call it and therefore continue to kill the tmux session.
   */
  prepareForDaemonShutdown(): void {
    this.detachOnStop = true;
  }

  async stop(options: { discardSession?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.teardownWiring();
    this.terminalSubscribers.clear();
    const tmuxBackend = this.backend instanceof TmuxBackend ? this.backend : undefined;
    const preservePersistentSession = this.detachOnStop
      && !options.discardSession
      && tmuxBackend !== undefined;
    if (this.turnActive) {
      this.turnActive = false;
      this.turnReject?.(new Error(preservePersistentSession
        ? 'Driver detached for Dockmux daemon shutdown'
        : 'Driver stopped'));
      this.turnResolve = null;
      this.turnReject = null;
    }
    try {
      if (preservePersistentSession) tmuxBackend.detach();
      else this.backend.kill();
    } catch {
      // best effort：后端可能已退出
    } finally {
      this.stoppedCallback?.();
    }
    // onExit 由 backend 的 exit 事件驱动（kill 会触发）；若后端已自行退出，
    // handleExit 早已回调过，exitReported 保证恰好一次。
  }

  createTerminalStream(): TerminalStream {
    const local = new Set<(data: string) => void>();
    return {
      onData: cb => {
        local.add(cb);
        this.terminalSubscribers.add(cb);
      },
      write: data => {
        this.backend.write(data);
      },
      resize: (cols, rows) => {
        this.backend.resize(cols, rows);
        this.snapshot?.resize(cols, rows);
      },
      dispose: () => {
        for (const cb of local) this.terminalSubscribers.delete(cb);
        local.clear();
      },
    };
  }

  /** 把一个后端接线进事件流（start / reattach / respawn 共用）。 */
  private wire(backend: SessionBackend): void {
    this.snapshot = new TerminalSnapshot(DEFAULT_COLS, DEFAULT_ROWS);
    this.idleDetector = new IdleDetector({
      completionPattern: this.adapter.completionPattern,
      idleToBusyPattern: this.adapter.idleToBusyPattern,
      staticBusyPattern: this.adapter.staticBusyPattern,
      staticBusyClearPattern: this.adapter.staticBusyClearPattern,
      readyPattern: this.adapter.readyPattern,
    });
    this.idleDetector.onIdle(() => {
      if (!this.turnActive) return;
      // Streaming can pause with an old prompt still on screen. Only the
      // current footer counts; earlier busy text may remain in the answer.
      const footer = this.snapshot?.lastLine() ?? '';
      if (this.adapter.screenBusyPattern?.test(footer)) {
        // Keep checking even if the next redraw only clears the footer.
        this.idleDetector?.reset();
        this.idleDetector?.seedReadyEvidence();
        return;
      }
      // 已有实质输出（CLI 在干活）→ 不受宽限期限制，idle 即完成。
      // 尚无实质输出 → 可能还在启动期（splash 屏静止），宽限期内禁止 completed。
      if (!this.turnHasOutput) {
        if (Date.now() - this.turnStartedAt < PtyCliDriver.TURN_GRACE_MS) return;
      }
      // Publish the final JSONL record before Runtime closes the turn, even
      // when it was written between the tailer's polling ticks.
      this.transcript?.flush();
      this.turnActive = false;
      this.emitEvent({ type: 'completed', data: { stopReason: 'end_turn' } });
      this.turnResolve?.();
      this.turnResolve = null;
      this.turnReject = null;
    });

    backend.onData(data => {
      this.idleDetector?.feed(data);
      this.snapshot?.write(data);
      for (const cb of this.terminalSubscribers) cb(data);
      this.scheduleRawTerminal();
      // 本轮进行中的 PTY 输出 = CLI 在干活（splash 屏静止不会触发 onData）。
      if (this.turnActive) this.turnHasOutput = true;
    });
    backend.onExit(code => this.handleExit(code, backend));

    // The tailer must resolve the CLI's data dir from the environment the CLI
    // CHILD got, never the daemon's: mergedEnv strips CLAUDE_* from the child,
    // and agent.env may relocate CODEX_HOME / CLAUDE_CONFIG_DIR / HOME. Reading
    // the daemon's env instead watches a tree the CLI never writes to, and the
    // turn is then reported as "no final output" while the screen shows a
    // perfectly good answer.
    this.transcript = createTranscriptTailer(this.adapter.id, {
      cwd: this.cwd,
      env: this.spawnEnv(),
      // Claude keys its transcript directory by cwd ALONE, so two dockmux
      // sessions in one repo share it. Without the session id the tailer
      // resolves by recency and picks up a sibling's transcript — the timeline
      // then shows another session's answer, or the turn is failed as "no
      // final output" while our own transcript sits on disk, correct and
      // unread. Sources that cannot be session-scoped ignore this.
      sessionId: this.sessionId,
    });
    if (this.transcript) {
      this.transcript.onEvent(e => {
        // 标记本轮已有实质输出（text/thinking/tool_*），解除 idle 闸门。
        if (e.type === 'text' || e.type === 'thinking' || e.type === 'tool_call' || e.type === 'tool_result') {
          this.turnHasOutput = true;
        }
        this.emitEvent(e);
      });
      this.transcript.start();
    }
  }

  private teardownWiring(): void {
    if (this.idleDetector) {
      this.idleDetector.dispose();
      this.idleDetector = undefined;
    }
    if (this.transcript) {
      this.transcript.stop();
      this.transcript = undefined;
    }
    if (this.rawTerminalTimer) {
      clearTimeout(this.rawTerminalTimer);
      this.rawTerminalTimer = undefined;
    }
  }

  private handleExit(code: number | null, source?: SessionBackend): void {
    // 只认「当前后端」的退出。respawn 会 kill 旧后端再换新的，被 kill 的旧后端
    // 的 exit 是我们自己造成的退场，不是 agent 崩溃——上报它会让 runtime 把会话
    // 打成 failed（真实环境实测：resume 返回 200 后立刻 status=failed /
    // "Agent exited with code 129"（SIGHUP），之后 send 全部 409 INVALID_STATE），
    // 而此时新进程其实已经正常起来了。
    //
    // 按「事件来自哪个后端实例」判断，而不是时间窗：kill() 只发信号，exit 由
    // node-pty 在后续 tick 才回调，任何时长的窗口都是猜。后端实例是确定性依据。
    if (source !== undefined && source !== this.backend) return;
    if (this.exitReported) return;
    this.exitReported = true;
    this.stopped = true;
    this.teardownWiring();
    // 若本轮仍在进行，driver 退出 = 本轮失败，reject send() 的等待者。
    if (this.turnActive) {
      this.turnActive = false;
      this.turnReject?.(new Error(`Agent exited with code ${code}`));
      this.turnResolve = null;
      this.turnReject = null;
    }
    this.exitCallback(code);
  }

  /** trailing-edge 节流：200ms 窗口内只发一次，且屏幕文本没变就不发。 */
  private scheduleRawTerminal(): void {
    if (this.rawTerminalTimer) return;
    const timer = setTimeout(() => {
      this.rawTerminalTimer = undefined;
      const text = this.snapshot?.text() ?? '';
      if (text === this.lastRawTerminalText) return;
      this.lastRawTerminalText = text;
      this.emitEvent({ type: 'raw_terminal', data: { text } });
    }, RAW_TERMINAL_THROTTLE_MS);
    timer.unref();
    this.rawTerminalTimer = timer;
  }

  private sessionContext(): AdapterSessionContext {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      model: this.agent.model,
      reasoningEffort: this.agent.reasoningEffort,
      permissionMode: this.agent.permissionMode,
      env: this.agent.env,
    };
  }

  /**
   * The tmux session name this driver is bound to, or undefined when the
   * backend is not a tmux backend.
   *
   * `SessionBackend.sessionName` is the contract (TmuxBackend returns its
   * session, PtyBackend returns undefined), so an injected backend and a
   * driver-built one answer through the same door. This used to reflect into
   * the backend's private `sessionName` field, which broke silently on any
   * rename; that fallback is gone.
   */
  private tmuxSessionName(): string | undefined {
    if (!(this.backend instanceof TmuxBackend)) return undefined;
    const name = this.backend.sessionName;
    return name.length > 0 ? name : undefined;
  }

  private reattachTmux(sessionName: string, detachCurrent: boolean): void {
    this.teardownWiring();
    // detach 只拆捕获，不杀 tmux 会话——CLI 进程继续存活。
    const ownerId = this.backend instanceof TmuxBackend ? this.backend.ownerId : undefined;
    if (detachCurrent) this.backend.detach?.();
    const backend = new TmuxBackend(sessionName, { ownerId });
    this.backend = backend;
    // attach 到既有会话：不重建 session、不重发 CLI 启动命令，只重建捕获。
    backend.attach({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    this.wire(backend);
  }

  private respawn(args: string[]): void {
    this.teardownWiring();
    // 会话名必须在 kill 之前取：kill 之后旧后端就不该再被问了。
    const tmuxName = this.backend instanceof TmuxBackend
      ? (this.tmuxSessionName() ?? this.sessionId)
      : undefined;
    // 旧后端的 exit 是我们自己造成的，不该当成 agent 崩溃——handleExit 按
    // 「事件来自哪个后端实例」过滤掉它（见那里的说明）。
    const previousBackend = this.backend;
    try {
      previousBackend.kill();
    } catch {
      // best effort
    }
    const ownerId = previousBackend instanceof TmuxBackend ? previousBackend.ownerId : undefined;
    const backend = tmuxName !== undefined ? new TmuxBackend(tmuxName, { ownerId }) : new PtyBackend();
    this.backend = backend;
    this.lastArgs = args;
    backend.spawn(this.agent.command, args, {
      cwd: this.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      env: this.spawnEnv(),
    });
    this.wire(backend);
  }
}

export function createPtyCliDriver(opts: PtyCliDriverOptions): PtyCliDriver {
  return new PtyCliDriver(opts);
}

function mergedEnv(agentEnv: Record<string, string>): Record<string, string> {
  // 剥离桥接进程自身的 ANTHROPIC_* / CLAUDE_* 环境变量——这些是 dockmux
  // daemon 的运行身份，不是被桥接 CLI 的。CLI 应该用自己的配置（~/.claude/）
  // 或 agent.env 里显式声明的变量。
  const stripped = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(ANTHROPIC_|CLAUDE_)/i.test(key)
    )
  );
  return Object.fromEntries(
    Object.entries({ ...stripped, ...agentEnv }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}
