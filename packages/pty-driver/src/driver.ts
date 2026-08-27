import type { AgentConfig, AgentDriver, NormalizedDriverEvent, TerminalStream } from '@dockmux/shared';
import type { AdapterSessionContext, CliAdapter } from '@dockmux/cli-adapters';
import { buildDockmuxRoutingBlock } from '@dockmux/cli-adapters';
import { PtyBackend, TmuxBackend, type SessionBackend } from '@dockmux/session-backends';
import { TerminalSnapshot } from '@dockmux/terminal-renderer';
import { IdleDetector } from './idle-detector.js';
import { createTranscriptTailer, type TranscriptEventSource } from './transcript/index.js';

export interface PtyCliDriverOptions {
  agent: AgentConfig;
  adapter: CliAdapter;
  /** 默认 new PtyBackend()；tmux 持久会话由调用方注入 TmuxBackend。 */
  backend?: SessionBackend;
  onEvent: (e: NormalizedDriverEvent) => void;
  onExit: (code: number | null) => void;
  sessionId: string;
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
  private lastSpawnEnv: Record<string, string> = {};

  constructor(opts: PtyCliDriverOptions) {
    this.agent = opts.agent;
    this.adapter = opts.adapter;
    this.sessionId = opts.sessionId;
    this.emitEvent = opts.onEvent;
    this.exitCallback = opts.onExit;
    this.backend = opts.backend ?? new PtyBackend();
    this.cwd = opts.agent.cwd ?? process.cwd();
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
    this.lastSpawnEnv = mergedEnv(this.agent.env);
    this.backend.spawn(this.agent.command, this.lastArgs, {
      cwd: this.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      env: this.lastSpawnEnv,
    });
    this.wire(this.backend);
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
      if (block) {
        finalPrompt = block.endsWith('\n') ? block + finalPrompt : `${block}\n${finalPrompt}`;
      }
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
      return;
    }
    // 路径 2：适配器支持 CLI 级 resume → kill 旧后端，带 resume 参数重 spawn。
    if (this.adapter.buildResumeCommand) {
      this.respawn(this.adapter.buildResumeCommand(this.sessionId));
    }
    // 否则 no-op。
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
    backend.onExit(code => this.handleExit(code));

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

  private handleExit(code: number | null): void {
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
   * 从 TmuxBackend 实例上读会话名（构造参数，未必公开暴露）。
   * 读不到就放弃 tmux reattach 路径。
   */
  private tmuxSessionName(): string | undefined {
    if (!(this.backend instanceof TmuxBackend)) return undefined;
    const name = (this.backend as unknown as { sessionName?: unknown }).sessionName;
    return typeof name === 'string' ? name : undefined;
  }

  private reattachTmux(sessionName: string): void {
    this.teardownWiring();
    // detach 只拆捕获，不杀 tmux 会话——CLI 进程继续存活。
    this.backend.detach?.();
    const backend = new TmuxBackend(sessionName);
    this.backend = backend;
    // attach 到既有会话：不重建 session、不重发 CLI 启动命令，只重建捕获。
    backend.attach({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    this.wire(backend);
  }

  private respawn(args: string[]): void {
    this.teardownWiring();
    try {
      this.backend.kill();
    } catch {
      // best effort
    }
    const backend =
      this.backend instanceof TmuxBackend
        ? new TmuxBackend(this.tmuxSessionName() ?? this.sessionId)
        : new PtyBackend();
    this.backend = backend;
    this.lastArgs = args;
    backend.spawn(this.agent.command, args, {
      cwd: this.cwd,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      env: this.lastSpawnEnv,
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
