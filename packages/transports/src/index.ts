import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import type {
  AgentConfig,
  AgentCapabilities,
  AgentDriver,
  DriverContext,
  DriverSubmission,
  DriverSubmissionInput,
  DriverResourceCapabilities,
  OperationPermit,
  ChildPermit
} from '@dutydeck/shared';
import { normalizeAcpxEvent, type NormalizedDriverEvent } from '@dutydeck/acp-client';

export interface ProbeMatrix { acp: boolean; jsonl: boolean; pipe: boolean; pty: boolean }

function isExecutableFilePosix(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutableFileWin32(filePath: string): boolean {
  // Windows 分支未实机验证（测试与生产运行环境为 Linux）。
  // Windows 下文件执行权限主要由后缀名与系统 DACL 决定，fs.accessSync(X_OK) 在 Windows 上并不等价于执行权限位。
  // 此处在 Windows 下验证普通文件存在，并由调用方按 PATHEXT 匹配。
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function checkExecutableCandidate(targetPath: string, isWin32: boolean, extensions: string[]): boolean {
  if (isWin32) {
    const ext = path.extname(targetPath).toLowerCase();
    if (ext && extensions.includes(ext)) {
      return isExecutableFileWin32(targetPath);
    }
    for (const pathext of extensions) {
      const candidate = `${targetPath}${pathext}`;
      if (isExecutableFileWin32(candidate)) return true;
    }
    return isExecutableFileWin32(targetPath);
  }
  return isExecutableFilePosix(targetPath);
}

export function commandExists(command: string): boolean {
  if (!command || typeof command !== 'string') return false;
  const isWin32 = process.platform === 'win32';
  const hasPathSep = command.includes('/') || (isWin32 && command.includes('\\'));

  const rawPathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const win32Exts = isWin32
    ? rawPathExt.split(';').map(e => e.trim().toLowerCase()).filter(Boolean)
    : [];

  if (hasPathSep) {
    const resolved = path.resolve(command);
    return checkExecutableCandidate(resolved, isWin32, win32Exts);
  }

  const rawPathEnv = process.env.PATH;
  let entries: string[];
  if (rawPathEnv === undefined) {
    // Linux/POSIX 平台在 PATH 环境变量缺失时，采用与 Node.js spawn / libc execvp 一致的系统缺省搜索路径
    // Windows 分支未在实机验证，如实标为 unverified
    entries = isWin32 ? [] : ['/usr/bin', '/bin'];
  } else {
    // 按系统 PATH 查找语义保留目录字节，不要 trim()；
    // 空条目（例如 PATH=""、首尾或连续冒号）在 POSIX 标准中表示当前工作目录（'.'）
    entries = rawPathEnv.split(path.delimiter).map(dir => dir === '' ? '.' : dir);
  }

  for (const dir of entries) {
    const candidate = path.join(dir, command);
    if (checkExecutableCandidate(candidate, isWin32, win32Exts)) {
      return true;
    }
  }

  return false;
}

export function probeAgent(agent: AgentConfig, acpxCommand = 'acpx'): AgentCapabilities {
  const executable = commandExists(agent.command);
  // The default runtime is the pinned `acpx` package imported by acp-client.
  // A non-default command is treated as an operator-supplied dependency probe.
  const acpx = acpxCommand === 'acpx' || commandExists(acpxCommand);
  const requested = agent.protocol === 'auto' ? (acpx && executable ? 'acp' : executable ? 'jsonl' : 'pty') : agent.protocol;
  const available = requested === 'acp' ? acpx && executable : executable;
  return { protocol: requested, available, detail: available ? undefined : requested === 'acp' && !acpx ? `acpx is unavailable; install acpx@0.13.0` : `Command not found: ${agent.command}`, pause: agent.capabilities.pause, resume: agent.capabilities.resume };
}

export interface ProcessTransportOptions {
  onEvent(event: NormalizedDriverEvent): void;
  onExit?(code: number | null): void;
  /** Grace period between SIGTERM and SIGKILL escalation (POSIX tests only). */
  killGraceMs?: number;
  /** Controlled DriverContext for physical-native resource ledger & submission. */
  context?: DriverContext;
}

class TransportStoppedError extends Error {
  constructor() { super('Transport is stopped'); this.name = 'TransportStoppedError'; }
}

interface ActiveTurn {
  readonly id: number;
  readonly prompt: string;
  readonly owned: OwnedProcess;
  writeSucceeded: boolean;
  completedReceived: boolean;
  settled: boolean;
  detached: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

interface SendSlot {
  readonly id: number;
}

interface OwnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  settled: boolean;
  stdoutClosed: boolean;
  exitCode?: number | null;
  exitNotified?: boolean;
  readonly exited: Promise<number | null>;
  resolveExited(code: number | null): void;
  terminating?: Promise<void>;
  discarded?: boolean;
}

const POSIX = process.platform !== 'win32';
const DEFAULT_KILL_GRACE_MS = 2_000;
const GROUP_PROBE_INTERVAL_MS = 20;

/**
 * JSONL/pipe 子进程驱动实现：支持受控资源账本、固定提交与 POSIX 进程树生命周期。
 *
 * 核心契约：
 * 1. Runtime 发放的固定 context/operation token 显式穿过 start、必要 prepare 和每个实际 spawn。
 *    每 child 独立 beforeCreate；许可后到 spawn 无 await；拒绝许可时零子进程。
 * 2. spawn 返回后先保留原 ChildProcess 并挂真实 exit/stream 错误监听，再调用持久 identity hook；
 *    登记失败仍保留并收口实际对象，不丢句柄、不自动补建。
 * 3. 正式 prepareTurn 先完成可能启动/替代进程和旧创建尾声，再由 prepareSubmission 纯计算最终输入与 physical refs；
 *    send(DriverSubmission) 只使用冻结正文，不再调用补建进程的 start，不修改摘要输入。
 * 4. 没有独立 ACK 时如实保留提交状态（不造 provider onAccepted）；结果由 completed 事件与既有核心路径结算；
 *    每条结构化事件只属于原轮次，旧 late completed/error/exit 不影响新 Attempt。
 * 5. 同实例停止与输出尾声仍等待实际原对象；进程能力仅证明 ChildProcess，跨实例停止保持不支持。
 */
export class JsonlTransport implements AgentDriver {
  private stopped = false;
  private starting?: Promise<OwnedProcess>;
  private current?: OwnedProcess;
  private readonly owned = new Set<OwnedProcess>();
  private stopping?: Promise<void>;

  private pendingSendSlot?: SendSlot;
  private activeTurn?: ActiveTurn;
  private turnSeq = 0;
  private turnTail?: Promise<void>;
  private preparedOwned?: OwnedProcess;

  get resourceCapabilities(): DriverResourceCapabilities {
    const strict = this.options.context?.protocol === 'controlled-v1';
    return {
      observe: true,
      originalObjectStop: true,
      identityBoundStop: false,
      nativeContextRestore: false,
      activeTurnAttach: false,
      configurationAck: false,
      creationDefaults: false
    };
  }

  constructor(private readonly agent: AgentConfig, private readonly options: ProcessTransportOptions) {}

  async start(operation?: OperationPermit): Promise<void> {
    if (this.stopped) throw new TransportStoppedError();
    if (this.current && !this.current.settled && !this.current.discarded) return;
    await this.ensureStarted(operation);
  }

  async prepareTurn(input: DriverSubmissionInput, operation: OperationPermit): Promise<void> {
    void input;
    if (this.stopped) throw new TransportStoppedError();
    // 1. 等待上一轮尾声
    if (this.turnTail) {
      try {
        await this.turnTail;
      } finally {
        this.turnTail = undefined;
      }
      if (this.stopped) throw new TransportStoppedError();
    }
    // 2. 完成可能启动/替代进程
    const owned = await this.ensureStarted(operation);
    this.preparedOwned = owned;
    if (this.stopped) throw new TransportStoppedError();
  }

  prepareSubmission(input: DriverSubmissionInput): Omit<DriverSubmission, 'operation' | 'onAccepted'> {
    if (this.stopped) throw new TransportStoppedError();
    const context = this.options.context;
    if (!context || context.protocol !== 'controlled-v1') {
      throw new Error('CONTROLLED_CONTEXT_REQUIRED');
    }
    // 验证准备好的物理对象仍存活且未发生替换
    if (!this.preparedOwned || this.preparedOwned.settled || this.preparedOwned.discarded || this.current !== this.preparedOwned) {
      throw new Error('DRIVER_PROCESS_NOT_READY');
    }
    return context.prepareSubmission(input);
  }

  private async ensureStarted(operation?: OperationPermit): Promise<OwnedProcess> {
    if (this.stopped) throw new TransportStoppedError();
    if (this.current && !this.current.settled && !this.current.discarded) {
      return this.current;
    }
    if (!this.starting) {
      // 同实例并发 start 共享同一次任务：先收口证明旧组退出，再 launch 新子进程。
      const launch = (async (): Promise<OwnedProcess> => {
        // leader 自然 exit 而 owned 组仍有孙代时，必须先对旧 owned 组收口并证明退出；
        // 失败/未知保持阻塞/报错，绝不允许旧存活组与新 child 并存。
        for (const old of [...this.owned]) {
          if (!this.groupGone(old)) {
            await this.terminate(old);
          } else {
            this.owned.delete(old);
          }
        }
        if (this.stopped) throw new TransportStoppedError();
        return await this.launch(operation);
      })();
      this.starting = launch;
      void launch.catch(() => undefined);
      void launch.then(owned => { if (!this.stopped) this.current = owned; }, () => undefined);
    }
    const pending = this.starting;
    try {
      const owned = await pending;
      // await 期间可能已被 stop 撤销，必须复核，不能复活或写旧句柄。
      if (this.stopped) {
        await this.stopping?.catch(() => undefined);
        throw new TransportStoppedError();
      }
      return owned;
    } finally {
      if (this.starting === pending) this.starting = undefined;
    }
  }

  async send(input: string | DriverSubmission): Promise<void> {
    if (this.stopped) throw new TransportStoppedError();

    const controlled = this.options.context?.protocol === 'controlled-v1';
    const submission = typeof input === 'string' ? undefined : input;
    if (controlled && !submission) {
      throw new Error('DRIVER_SUBMISSION_REQUIRED');
    }

    // 1. 同一实例最多一个未收口轮次：必须在第一个 await 之前同步占位，并发 send 显式拒绝！
    if (this.activeTurn || this.pendingSendSlot) {
      throw new Error('Turn already in progress');
    }

    // 2. 如果是受控驱动，同步调用 assertSubmission（无前置 await！）
    if (controlled && submission) {
      this.options.context!.assertSubmission(submission);
    }

    const slot: SendSlot = { id: ++this.turnSeq };
    this.pendingSendSlot = slot;

    try {
      let owned: OwnedProcess | undefined;
      if (controlled) {
        // 在受控模式下，所有可能启动或替代进程已经在 prepareTurn 结束！
        // 验证执行目标精确等于 prepare 阶段冻结的原对象，不得指向替代进程或未就绪进程
        owned = this.current;
        if (!owned || owned.settled || owned.discarded || owned !== this.preparedOwned) {
          throw new Error('DRIVER_PROCESS_NOT_READY');
        }
      } else {
        // 兼容非受控 local-only 路径：若上一个轮次因超时等导致提前拒绝，先等待旧轮次尾声
        if (this.turnTail) {
          try {
            await this.turnTail;
          } finally {
            this.turnTail = undefined;
          }
          if (this.stopped) throw new TransportStoppedError();
        }
        await this.start();
        owned = this.current;
        if (this.stopped || !owned || owned.settled || owned.discarded) {
          throw new TransportStoppedError();
        }
      }

      const prompt = submission ? submission.prompt : (input as string);

      // 创建当前轮次对象
      let resolveTurn!: () => void;
      let rejectTurn!: (error: Error) => void;
      const turnPromise = new Promise<void>((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });

      const turn: ActiveTurn = {
        id: slot.id,
        prompt,
        owned,
        writeSucceeded: false,
        completedReceived: false,
        settled: false,
        detached: false,
        resolve: resolveTurn,
        reject: rejectTurn
      };
      this.activeTurn = turn;

      // 设置超时计时器（AgentConfig.timeout，单位秒）
      if (this.agent.timeout && this.agent.timeout > 0) {
        const timeoutMs = this.agent.timeout * 1000;
        turn.timer = setTimeout(() => {
          if (turn.settled || this.activeTurn !== turn) return;
          // 先关闭旧轮向 Runtime 的事件投递，再拒绝 Promise
          this.reapDiscardedProcess(owned!, new Error(`Turn timed out after ${this.agent.timeout}s`));
        }, timeoutMs);
      }

      // 写入 stdin：成功 callback 与 completed 是两个独立条件，二者齐备才 resolve
      // 注意：JSONL/Pipe 没有独立 ACK 协议，绝对不调用 submission.onAccepted！
      try {
        owned.child.stdin.write(`${JSON.stringify({ type: 'prompt', prompt })}\n`, error => {
          if (turn.settled) return;
          if (error) this.reapDiscardedProcess(owned!, error);
          else {
            turn.writeSucceeded = true;
            this.checkTurnSettlement(turn);
          }
        });
      } catch (error) {
        this.reapDiscardedProcess(owned, error instanceof Error ? error : new Error(String(error)));
      }

      return await turnPromise;
    } finally {
      if (this.pendingSendSlot === slot) {
        this.pendingSendSlot = undefined;
      }
    }
  }

  async interrupt(): Promise<void> {
    if (this.stopped) throw new TransportStoppedError();
    const owned = this.current;
    if (!owned || owned.settled || owned.discarded) return;
    this.signalGroup(owned, 'SIGINT');

    // 若当前有活动轮次，等待进程响应并结束轮次；若进程忽略 SIGINT 则在有限宽限期后收口
    if (this.activeTurn && this.activeTurn.owned === owned && !this.activeTurn.settled) {
      const grace = 300;
      const turn = this.activeTurn;
      let timer: NodeJS.Timeout | undefined;
      let check: NodeJS.Timeout | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(async () => {
            if (check) clearInterval(check);
            if (!turn.settled && this.activeTurn === turn) {
              try {
                await this.reapDiscardedProcess(owned, new Error('Turn interrupted'));
                resolve();
              } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
              }
            } else {
              resolve();
            }
          }, grace);

          check = setInterval(() => {
            if (turn.settled || this.groupGone(owned)) {
              if (timer) clearTimeout(timer);
              if (check) clearInterval(check);
              resolve();
            }
          }, 20);
        });
      } finally {
        if (timer) clearTimeout(timer);
        if (check) clearInterval(check);
      }
    }
  }

  async resume(operation?: OperationPermit): Promise<void> {
    if (this.stopped) throw new TransportStoppedError();
    // interrupt 发送 SIGINT，子进程仍在；若子进程自然退出则重新拉起。
    await this.start(operation);
  }

  stop(options: { discardSession?: boolean } = {}): Promise<void> {
    void options;
    if (this.stopping) return this.stopping;
    this.stopped = true;

    // 清理正在占位或进行中的轮次
    this.pendingSendSlot = undefined;
    if (this.activeTurn && !this.activeTurn.settled) {
      this.failActiveTurn(this.activeTurn, new TransportStoppedError());
    }

    const work = (async () => {
      const pendingStart = this.starting;
      // 先回收已确认出生的资源，再兜住启动中的迟到资源；不持锁等待 start。
      await Promise.allSettled([...this.owned].map(owned => this.terminate(owned)));
      if (pendingStart) await pendingStart.catch(() => undefined);
      if (this.turnTail) await this.turnTail.catch(() => undefined);
      const results = await Promise.allSettled([...this.owned].map(owned => this.terminate(owned)));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    this.stopping = work;
    // 升级后仍无法证明退出时明确报失败，并允许后续 stop 重试；绝不假装成功。
    void work.catch(() => { if (this.stopping === work) this.stopping = undefined; });
    return work;
  }

  /**
   * 权威停机探针：stop 已请求、无待启动、所有 owned 进程组均被内核证明消失。
   * POSIX 用负 pgid + signal 0 的 ESRCH 证明整组消失（单个 leader 退出不算）。
   * Windows 无法等价证明进程树，保守返回 false（unverified），不冒称树已终止。
   */
  async isStopped(): Promise<boolean> {
    if (!this.stopped || this.starting) return false;
    if (!POSIX) return false;
    // 始终按负 pgid 探整组：leader 已退出（settled）不代表孙代已消失，不能跳过。
    for (const owned of this.owned) {
      if (owned.pid <= 0) {
        if (!owned.settled) return false;
        continue;
      }
      try { process.kill(-owned.pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
    }
    return true;
  }

  private checkTurnSettlement(turn: ActiveTurn): void {
    if (turn.settled) return;
    // 双完成条件：stdin 写入成功 callback 且收到明确归一化 completed 事件，二者齐备才 resolve
    if (turn.writeSucceeded && turn.completedReceived) {
      if (turn.timer) clearTimeout(turn.timer);
      turn.settled = true;
      if (this.activeTurn === turn) this.activeTurn = undefined;
      turn.resolve();
    }
  }

  private failActiveTurn(turn: ActiveTurn, error: Error): void {
    if (turn.settled) return;
    if (turn.timer) clearTimeout(turn.timer);
    turn.settled = true;
    turn.detached = true;
    if (this.activeTurn === turn) this.activeTurn = undefined;
    turn.reject(error);
  }

  private reapDiscardedProcess(owned: OwnedProcess, error: Error): Promise<void> {
    owned.discarded = true;
    if (this.current === owned) this.current = undefined;
    const turn = this.activeTurn;
    if (turn?.owned === owned) this.failActiveTurn(turn, error);
    const tail = this.terminate(owned);
    this.turnTail = tail;
    // Observe immediately even if nobody sends again. Keep the rejected Promise
    // itself so the next caller still sees failed resource cleanup.
    void tail.catch(() => undefined);
    return tail;
  }

  private spawnChild(command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; detached: boolean }): ChildProcessWithoutNullStreams {
    return spawn(command, args, options);
  }

  private async launch(operation?: OperationPermit): Promise<OwnedProcess> {
    if (this.stopped) throw new TransportStoppedError();
    const context = this.options.context;
    const controlled = context?.protocol === 'controlled-v1';
    let childPermit: ChildPermit | undefined;

    if (controlled) {
      const parent = operation ?? context!.rootOperation;
      childPermit = context!.resources.beforeCreate(parent, 'process');
      context!.resources.assertCreation(childPermit);
    }

    let rawChild: ChildProcessWithoutNullStreams;
    try {
      rawChild = this.spawnChild(
        this.agent.command,
        this.agent.args,
        { cwd: this.agent.cwd, env: { ...process.env, ...this.agent.env }, detached: POSIX }
      );
    } catch (spawnSyncError) {
      if (controlled && childPermit) {
        try { context!.resources.creationFinished(childPermit, 'not_created'); } catch {}
      }
      throw spawnSyncError;
    }

    // 关键实施边界 2：spawn 返回后先保留原 ChildProcess 并挂真实 exit/stream 错误监听，再调用可能抛出的持久 identity hook。
    const owned = this.register(rawChild);

    if (this.stopped) {
      // 进程已经由底层 spawn 出生，绝对不能猜测没创建写 not_created！
      // 若处于受控模式，登记其真实出生，并由 terminate 实际收口等待真实退出
      if (controlled && childPermit) {
        try { context!.resources.spawned(childPermit, rawChild); } catch {}
      }
      const tail = this.terminate(owned);
      this.turnTail = tail;
      void tail.catch(() => undefined);
      throw new TransportStoppedError();
    }

    if (controlled && childPermit) {
      try {
        context!.resources.spawned(childPermit, rawChild);
      } catch (identityError) {
        owned.discarded = true;
        if (this.current === owned) this.current = undefined;
        // 登记失败仍保留并收口实际对象，不能丢句柄或自动补建
        const tail = this.terminate(owned);
        this.turnTail = tail;
        void tail.catch(() => undefined);
        throw identityError;
      }
    }

    await new Promise<void>((resolve, reject) => {
      let birthSettled = false;
      const onSpawn = () => {
        if (birthSettled) return;
        birthSettled = true;
        rawChild.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        if (birthSettled) return;
        birthSettled = true;
        rawChild.off('spawn', onSpawn);
        owned.discarded = true;
        owned.settled = true;
        this.owned.delete(owned);
        owned.resolveExited(null);
        if (this.current === owned) this.current = undefined;
        if (controlled && childPermit) {
          try { context!.resources.creationFinished(childPermit, 'not_created'); } catch {}
        }
        reject(error);
      };
      rawChild.once('spawn', onSpawn);
      rawChild.once('error', onError);
    });

    return owned;
  }

  private register(child: ChildProcessWithoutNullStreams): OwnedProcess {
    let resolveExited!: (code: number | null) => void;
    const exited = new Promise<number | null>(resolve => { resolveExited = resolve; });
    const owned: OwnedProcess = {
      child,
      pid: child.pid ?? 0,
      settled: false,
      stdoutClosed: false,
      exitCode: undefined,
      exited,
      resolveExited
    };
    this.owned.add(owned);

    child.once('spawn', () => {
      if (child.pid !== undefined && owned.pid === 0) {
        (owned as any).pid = child.pid;
      }
    });

    // stdout/stderr 错误监听，防止流错误逃逸到未捕获异常杀宿主，并向活动轮次传播
    const failOutput = (error: Error) => { if (!owned.discarded) this.reapDiscardedProcess(owned, error); };
    child.stdout.on('error', failOutput);
    child.stderr.on('error', failOutput);

    // stdin 流的 EPIPE/ECONNRESET 只在该流上抛 'error'（child 的 'error' 不转发 stdio
    // 错误，stdout/stderr 已有监听器兜底）。send 的写回调会据此 reject 调用者；
    // 这里仅吞掉流事件，避免“无 error 监听即杀宿主”。
    child.stdin.on('error', () => undefined);

    // 使用 readline 读取 stdout：覆盖多行、单 chunk 多事件以及末行无换行（流 close 时自动 flush 最后一行）
    const rlStdout = readline.createInterface({ input: child.stdout });
    rlStdout.on('line', line => {
      this.handleStdoutLine(owned, line);
    });
    rlStdout.on('error', failOutput);

    child.stdout.on('close', () => {
      owned.stdoutClosed = true;
      this.checkProcessClose(owned);
    });

    const rlStderr = readline.createInterface({ input: child.stderr });
    rlStderr.on('line', line => {
      if (this.stopped || owned.discarded) return;
      if (owned.terminating && (!this.activeTurn || this.activeTurn.owned !== owned)) return;
      const turn = this.activeTurn;
      if (turn && turn.owned === owned && turn.detached) return;
      this.options.onEvent({ type: 'raw_terminal', data: { text: line }, raw: line });
    });
    rlStderr.on('error', failOutput);

    // 回调按对象身份闭包绑定：迟到 exit 只标记自己，保存真实 exitCode，绝不碰替代实例或新 child。
    child.once('exit', code => {
      owned.exitCode = code;
      owned.settled = true;
      owned.resolveExited(code);
      if (this.current === owned && !this.activeTurn) this.current = undefined;
      // leader 退出不等于整组消失：POSIX 下立即探一次组，仍有后代则保留证据到 stop。
      if (this.groupGone(owned)) this.owned.delete(owned);
      this.checkProcessClose(owned);
    });

    // spawn 之后的异步 error（如管道 ECONNRESET）由本实例吞掉，等待 exit 收口，不杀宿主。
    child.on('error', () => undefined);
    return owned;
  }

  private handleStdoutLine(owned: OwnedProcess, line: string): void {
    if (this.stopped || owned.discarded) return;
    if (owned.terminating && (!this.activeTurn || this.activeTurn.owned !== owned)) return;

    const event = normalizeAcpxEvent(line);
    const normalized: NormalizedDriverEvent = event ?? { type: 'raw_terminal', data: { text: line }, raw: line };

    const turn = this.activeTurn;
    if (turn && turn.owned === owned && !turn.settled) {
      // completed closes event ownership even if its write acknowledgement is
      // still pending. Subsequent output cannot become another result.
      if (turn.completedReceived) return;
      // 正在进行的活动轮次：若超时等导致本轮已 detached，切断向 Runtime 的事件投递，只在内部完成收尾核验
      if (!turn.detached) {
        this.options.onEvent(normalized);
      }
      // 收到 completed 事件：先交付事件，再标记 completedReceived
      if (normalized.type === 'completed') {
        turn.completedReceived = true;
        this.checkTurnSettlement(turn);
      }
      return;
    }

    // 没有活动归属轮次（例如轮次之间、非轮次期间的自发输出、或者旧进程的迟到输出）
    // 关键：绝对不能把结构化事件（completed, error, text 等）当作当前任务的事件发给 Runtime！
    // 只有非结构化的原始输出作为 raw_terminal 诊断保留（且不作为业务结果改变状态）
    if (normalized.type === 'raw_terminal') {
      this.options.onEvent(normalized);
    }
  }

  private checkProcessClose(owned: OwnedProcess): void {
    // 必须等待 leader 退出且 stdout 管道完全收口，不能因 exit 先到而丢弃末尾输出
    if (!owned.settled || !owned.stdoutClosed || owned.exitNotified) return;
    owned.exitNotified = true;
    const exitCode = owned.exitCode ?? null;

    const turn = this.activeTurn;
    if (turn && turn.owned === owned && !turn.settled) {
      if (this.current === owned) this.current = undefined;
      // 输出关闭且进程已退出，但未发 completed：本轮必须明确 reject，不出现悬挂 Promise
      this.failActiveTurn(turn, new Error(`Process exited with code ${exitCode ?? 'null'} without completing turn`));
      return;
    }

    // 只有在没有活动轮次、且非主动收口终止、且非已废弃进程、且未被新 child 替换时，才向外通知实例级 onExit
    if (!this.stopped && !owned.terminating && !owned.discarded && (!this.current || this.current === owned)) {
      this.options.onExit?.(exitCode);
    }
  }

  private groupGone(owned: OwnedProcess): boolean {
    if (!POSIX || owned.pid <= 0) return owned.settled; // 仅能证明 leader，进程树范围 unverified。
    try { process.kill(-owned.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }

  private async waitGroupGone(owned: OwnedProcess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.groupGone(owned)) return true;
      await new Promise(resolve => setTimeout(resolve, GROUP_PROBE_INTERVAL_MS));
    }
    return this.groupGone(owned);
  }

  private signalGroup(owned: OwnedProcess, signal: NodeJS.Signals) {
    if (POSIX && owned.pid > 0) {
      try { process.kill(-owned.pid, signal); return; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      }
    }
    try { owned.child.kill(POSIX ? signal : undefined); } catch { /* 已退出则由 exit 探针收口 */ }
  }

  private async terminate(owned: OwnedProcess) {
    if (owned.terminating) return owned.terminating;
    const grace = this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const task = (async () => {
      if (!this.groupGone(owned)) {
        this.signalGroup(owned, 'SIGTERM');
        if (!(await this.waitGroupGone(owned, grace))) {
          // 期限到只触发升级，不清空资源证据。
          if (POSIX) this.signalGroup(owned, 'SIGKILL');
          if (!(await this.waitGroupGone(owned, grace))) {
            throw new Error(`Transport process group ${owned.pid} did not exit after SIGKILL`);
          }
        }
      }
      await owned.exited.catch(() => undefined);
      this.owned.delete(owned);
    })();
    owned.terminating = task;
    try { await task; }
    catch (error) { owned.terminating = undefined; throw error; }
  }
}

/** Newline-delimited stdin/stdout compatibility transport without ACP ownership. */
export class PipeTransport extends JsonlTransport {}

export class PtyTransport {
  private child?: pty.IPty;
  constructor(private readonly agent: AgentConfig, private readonly options: ProcessTransportOptions) {}
  async start() {
    if (this.child) return;
    const env = Object.fromEntries(Object.entries({ ...process.env, ...this.agent.env }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    this.child = pty.spawn(this.agent.command, this.agent.args, { name: 'xterm-256color', cwd: this.agent.cwd ?? process.cwd(), env });
    this.child.onData(raw => this.options.onEvent({ type: 'raw_terminal', data: { text: raw }, raw }));
    this.child.onExit(({ exitCode }) => { this.child = undefined; this.options.onExit?.(exitCode); });
  }
  async send(prompt: string) { await this.start(); this.child!.write(`${prompt}\r`); }
  async interrupt() { this.child?.write('\x03'); }
  async resume() { await this.start(); }
  async stop() { this.child?.kill(); this.child = undefined; }
}
