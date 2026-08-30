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

  private backend: SessionBackend;
  private readonly cwd: string;

  private started = false;
  private stopped = false;
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
  /** 本 driver 的 tmux 会话名。driver 自己建后端时记下来，就不必反射读
   *  后端私有字段（见 tmuxSessionName）。 */
  private knownTmuxSessionName: string | undefined;

  constructor(opts: PtyCliDriverOptions) {
    this.agent = opts.agent;
    this.adapter = opts.adapter;
    this.sessionId = opts.sessionId;
    this.emitEvent = opts.onEvent;
    this.exitCallback = opts.onExit;
    this.backend = opts.backend ?? new PtyBackend();
    this.cwd = opts.agent.cwd ?? process.cwd();
    this.cliSessionId = opts.cliSessionId;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.lastArgs = this.adapter.buildArgs({
      sessionId: this.sessionId,
      cwd: this.agent.cwd,
      model: this.agent.model,
      reasoningEffort: this.agent.reasoningEffort,
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
    if (!this.firstPromptSent) {
      // 首轮 prompt 前注入路由块：适配器自带 injectSessionContext 的用它
      // （claude-code/grok），其余用默认 DOCKMUX_SHELL_HINTS 块——教 CLI
      // 自己正跑在无人值守桥接会话里（botmux 对大多数 CLI 同样注入）。
      const block = this.adapter.injectSessionContext
        ? this.adapter.injectSessionContext(this.sessionContext())
        : buildDockmuxRoutingBlock(this.sessionContext().locale);
      // 会话指纹：CLI 会把提交的 prompt 文本落盘（claude jsonl / codex
      // history.jsonl / grok prompt_history.jsonl / opencode part 表），
      // 这个标记因此成为「dockmux 会话 ↔ CLI 原生 session id」的反查锚点。
      // 必须在首轮就注入，resume 时才有东西可查。见 session-id/marker.ts。
      const marker = buildSessionMarker(this.sessionId);
      const prefix = block ? `${block.replace(/\n$/, '')}\n${marker}` : marker;
      finalPrompt = `${prefix}\n${finalPrompt}`;
    }
    this.firstPromptSent = true;

    this.turnActive = true;
    this.turnHasOutput = false;
    this.turnStartedAt = Date.now();
    this.idleDetector?.reset();
    await this.adapter.writeInput(this.backend, finalPrompt);

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
    // 路径 1：tmux 会话仍在 → reattach（后端内部重启 pipe-pane 捕获，driver 重建订阅）。
    const tmuxName = this.tmuxSessionName();
    if (tmuxName !== undefined && TmuxBackend.probeSession(tmuxName) === 'exists') {
      this.reattachTmux(tmuxName);
      // daemon 重启后的典型形态：新 driver 直接 resume()，从没调过 start()。
      // 必须置 started，否则接下来的 send() 会走 start() 再 spawn 一次，
      // 把刚 attach 上的后端二次 spawn（tmux 后端直接抛 "spawn() called twice"）。
      // 同理 firstPromptSent：CLI 进程还活着，上一条 prompt 里的路由块/指纹
      // 仍在它的上下文里，重发一遍只会污染会话。
      this.markResumed();
      return;
    }
    // 路径 2：适配器支持 CLI 级 resume → kill 旧后端，带 resume 参数重 spawn。
    if (this.adapter.buildResumeCommand) {
      this.respawn(this.buildResumeArgs());
      this.markResumed();
    }
    // 否则 no-op。
  }

  /**
   * resume 重 spawn 的完整 argv。
   *
   * 不能直接用 `adapter.buildResumeCommand()` 当 argv——它只产出**续接定位**
   * 那几个参数（claude 是 `--resume <uuid>`），不含权限绕过、settings、
   * disallowed-tools 等无人值守必需的启动参数。拿它当完整 argv 拉起来的 CLI
   * 会在权限确认处 exit 1，会话随即被判 failed（真实环境实测：resume 返回 200，
   * 2 秒后 state=failed，之后 send 全部 409）。
   *
   * 正解是走 `buildArgs({ resume: true, resumeSessionId })`：适配器在那里把
   * 「续接定位 + 常规启动参数」拼成一套完整 argv。buildResumeCommand 仍是
   * resume 能力的声明位（driver.resume 用它判断该不该走这条路径），并为
   * 只认得续接片段的适配器保留定位来源。
   */
  private buildResumeArgs(): string[] {
    const resumeSessionId = this.resolveResumeSessionId();
    const args = this.adapter.buildArgs({
      ...this.sessionContext(),
      resume: true,
      resumeSessionId,
    });
    if (args.length > 0) return args;
    // 适配器没在 buildArgs 里实现 resume 分支时，退回续接片段（聊胜于无）。
    return this.adapter.buildResumeCommand?.(resumeSessionId) ?? [];
  }

  /** resume 之后 driver 已有一个接好线的活后端：start() 不该再 spawn，
   *  首轮注入也不该重来（会话上下文已经带着它了）。 */
  private markResumed(): void {
    this.started = true;
    this.firstPromptSent = true;
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

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.teardownWiring();
    this.terminalSubscribers.clear();
    try {
      this.backend.kill();
    } catch {
      // best effort：后端可能已退出
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
      // 已有实质输出（CLI 在干活）→ 不受宽限期限制，idle 即完成。
      // 尚无实质输出 → 可能还在启动期（splash 屏静止），宽限期内禁止 completed。
      if (!this.turnHasOutput) {
        if (Date.now() - this.turnStartedAt < PtyCliDriver.TURN_GRACE_MS) return;
      }
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

    this.transcript = createTranscriptTailer(this.adapter.id, { cwd: this.cwd });
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
    };
  }

  /**
   * 本 driver 的 tmux 会话名。
   *
   * 优先用 driver 自己记住的名字：reattach / respawn 都由 driver 构造
   * TmuxBackend，名字是 driver 传进去的，不需要问后端。只有「调用方注入了
   * 一个 TmuxBackend」这一种情况 driver 没参与命名，才回退到反射读私有
   * 字段——那条路是脆的（后端一改字段名就静默失效），所以只当兜底，且拿到
   * 后立刻缓存，后续不再反射。
   *
   * TODO(cross-team): 兜底反射可以彻底去掉——需要 session-backends 在
   * SessionBackend 上暴露一个只读的会话标识（例如 `readonly name?: string`，
   * TmuxBackend 返回 sessionName、PtyBackend 返回 undefined）。该包由
   * Team Backends 持有，本次未改。
   */
  private tmuxSessionName(): string | undefined {
    if (!(this.backend instanceof TmuxBackend)) return undefined;
    if (this.knownTmuxSessionName !== undefined) return this.knownTmuxSessionName;
    const name = (this.backend as unknown as { sessionName?: unknown }).sessionName;
    if (typeof name === 'string' && name.length > 0) {
      this.knownTmuxSessionName = name;
      return name;
    }
    return undefined;
  }

  private reattachTmux(sessionName: string): void {
    this.teardownWiring();
    // detach 只拆捕获，不杀 tmux 会话——CLI 进程继续存活。
    this.backend.detach?.();
    const backend = new TmuxBackend(sessionName);
    this.backend = backend;
    // driver 自己命名的后端：记下来，之后不必反射读后端私有字段。
    this.knownTmuxSessionName = sessionName;
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
    const backend = tmuxName !== undefined ? new TmuxBackend(tmuxName) : new PtyBackend();
    this.backend = backend;
    if (tmuxName !== undefined) this.knownTmuxSessionName = tmuxName;
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
