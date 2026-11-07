import { processTreePids, scanProcesses } from './agent-process-tree.js';

/**
 * 受管进程树最近一段时间有没有在占用 CPU。尽力而为：只读 Linux 的 /proc；
 * 其他平台、没有进程号、进程已退出都是 unknown，由调用方按「不知道」处理。
 */
export type ProcessTreeActivity = 'active' | 'inactive' | 'unknown';

/** 窗口内整棵树的 CPU 时间达到墙钟的 5% 算活跃：空闲的 Node/CLI 进程远低于此，编译、跑测试、打包远高于此。 */
const ACTIVE_CPU_RATIO = 0.05;
/** 比这更短的窗口里一个时钟滴答（10ms）就会被放大成高占用，不下结论。 */
export const PROCESS_CPU_MIN_WINDOW_MS = 1_000;
/** /proc 的 CPU 时间以 USER_HZ 计，Linux 对用户态固定为 100。 */
const TICKS_PER_SECOND = 100;

/** roots 及其全部后代的累计 CPU 时间（含已回收子进程），按「进程号:启动时刻」区分复用的进程号。 */
function readProcessTree(roots: number[]): Map<string, number> | undefined {
  const table = scanProcesses();
  const pids = processTreePids(table, roots);
  if (!pids.length) return undefined;
  return new Map(pids.map(pid => { const stat = table.get(pid)!; return [`${pid}:${stat.start}`, stat.ticks]; }));
}

export class ProcessTreeCpu {
  private previous?: { at: number; ticks: Map<string, number> };
  private last?: ProcessTreeActivity;
  /** minWindowMs 不小于 PROCESS_CPU_MIN_WINDOW_MS；采样频繁的调用方可以放长，少读 /proc。 */
  constructor(private readonly minWindowMs = PROCESS_CPU_MIN_WINDOW_MS) {}
  /**
   * 采样并与上一次对照。第一次还没有对照，返回 undefined；距上次不足最短窗口时沿用上次的结论，不读 /proc。
   */
  sample(roots: number[]): ProcessTreeActivity | undefined {
    const now = Date.now();
    if (this.previous && now - this.previous.at < this.minWindowMs) return this.last;
    const ticks = roots.length ? readProcessTree(roots) : undefined;
    if (!ticks) { this.previous = undefined; return this.last = 'unknown'; }
    const previous = this.previous;
    this.previous = { at: now, ticks };
    if (!previous) return this.last = undefined;
    let used = 0;
    for (const [key, value] of ticks) used += Math.max(0, value - (previous.ticks.get(key) ?? 0));
    return this.last = used * 1_000 / TICKS_PER_SECOND >= (now - previous.at) * ACTIVE_CPU_RATIO ? 'active' : 'inactive';
  }
  reset() { this.previous = undefined; this.last = undefined; }
}
