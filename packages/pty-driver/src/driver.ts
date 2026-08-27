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
    this.idleDetector?.reset();
    await this.adapter.writeInput(this.backend, finalPrompt);
  }

  async interrupt(): Promise<void> {
    if (this.stopped) return;
    this.backend.interrupt();
    // 不主动发 completed——等 idle 检测到 prompt 回归自然完成（turnActive 仍为 true）。
    this.emitEvent({ type: 'status', data: { state: 'interrupted' } });
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
      this.turnActive = false;
      this.emitEvent({ type: 'completed', data: { stopReason: 'end_turn' } });
    });

    backend.onData(data => {
      this.idleDetector?.feed(data);
      this.snapshot?.write(data);
      for (const cb of this.terminalSubscribers) cb(data);
      this.scheduleRawTerminal();
    });
    backend.onExit(code => this.handleExit(code));

    this.transcript = createTranscriptTailer(this.adapter.id, { cwd: this.cwd });
    if (this.transcript) {
      this.transcript.onEvent(e => this.emitEvent(e));
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
  return Object.fromEntries(
    Object.entries({ ...process.env, ...agentEnv }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}
