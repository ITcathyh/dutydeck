/**
 * 停服各阶段的耗时记录。
 *
 * 停服是串行加并行组的一串关闭步骤，超时被强制退出时，日志里过去只有一句「超过 N 秒」，
 * 看不出卡在哪一步。这里记下每一步的开始和结束：正常停完汇总成一条耗时日志，强制退出时
 * 列出还没结束（含还没开始）的步骤。
 */

/** 强制退出的上限：低于 systemd unit 的 TimeoutStopSec=15，留出余量让进程自己带着阶段信息退出，而不是被 SIGKILL。 */
export const SHUTDOWN_DEADLINE_MS = 12_000;

export class ShutdownPhases {
  private readonly started = new Map<string, number>();
  private readonly durations = new Map<string, number>();

  constructor(private readonly planned: readonly string[], private readonly now: () => number = () => performance.now()) {}

  /** 执行一个关闭步骤并记录耗时；异常原样抛出，由调用方汇总。 */
  async run(name: string, operation: () => unknown): Promise<void> {
    const startedAt = this.now();
    this.started.set(name, startedAt);
    try {
      await operation();
    } finally {
      this.durations.set(name, Math.round(this.now() - startedAt));
    }
  }

  /** 已结束步骤的耗时（毫秒），按完成顺序。 */
  durationsMs(): Record<string, number> {
    return Object.fromEntries(this.durations);
  }

  /** 还没结束的步骤：正在运行的带已运行时长，没开始的标「未开始」。 */
  unfinished(): string[] {
    const at = this.now();
    const names = [...new Set([...this.planned, ...this.started.keys()])];
    return names.filter(name => !this.durations.has(name)).map(name => {
      const startedAt = this.started.get(name);
      return startedAt === undefined ? `${name}（未开始）` : `${name}（已运行 ${Math.round(at - startedAt)}ms）`;
    });
  }
}

/**
 * 收到停服信号后挂上强制退出计时器。到点时把未完成的步骤和已完成步骤的耗时写进日志再退出，
 * 返回取消函数。`phases` 取不到（服务还没起来）时只报超时。
 */
export function armShutdownDeadline(
  phases: () => ShutdownPhases | undefined,
  write: (line: string) => void,
  exit: (code: number) => void,
  deadlineMs = SHUTDOWN_DEADLINE_MS
): () => void {
  const timer = setTimeout(() => {
    const current = phases();
    const unfinished = current?.unfinished() ?? [];
    const finished = current ? Object.entries(current.durationsMs()).map(([name, ms]) => `${name}=${ms}ms`) : [];
    write(`Shutdown exceeded ${deadlineMs / 1000} seconds; forcing exit. 未完成的停服阶段：${unfinished.join('、') || '无记录'}；已完成：${finished.join(' ') || '无'}\n`);
    exit(1);
  }, deadlineMs);
  return () => clearTimeout(timer);
}
