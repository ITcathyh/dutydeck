export interface LoopTimingLog {
  warn(details: Record<string, unknown>, message: string): void;
}

/** Warn when a single run of a periodic loop takes at least this long. */
export const SLOW_LOOP_WARN_MS = 500;
/** While a loop stays slow, warn again at most this often, as one summary. */
export const SLOW_LOOP_SUMMARY_MS = 3_600_000;

/** Slow runs since the last warning, per loop name; a fast run ends the streak. */
const slowStreaks = new Map<string, { warnedAt: number; durations: number[] }>();

/**
 * Run one cycle of a periodic loop and log a warning, with the loop name and
 * duration, only when it took at least `thresholdMs` (wall time, including
 * awaits). While the loop stays slow, later slow runs are folded into at most
 * one summary per `SLOW_LOOP_SUMMARY_MS` (count, p50, max); the next fast run
 * resets this. Returns the cycle's own result; sync and async cycles both work.
 */
export function timeLoop<T>(name: string, log: LoopTimingLog | undefined, run: () => T, thresholdMs = SLOW_LOOP_WARN_MS): T {
  const startedAt = performance.now();
  const finish = () => {
    const finishedAt = performance.now();
    const durationMs = Math.round(finishedAt - startedAt);
    if (durationMs < thresholdMs) { slowStreaks.delete(name); return; }
    if (!log) return;
    const streak = slowStreaks.get(name);
    try {
      if (!streak) {
        slowStreaks.set(name, { warnedAt: finishedAt, durations: [] });
        log.warn({ loop: name, durationMs, thresholdMs }, `周期循环 ${name} 单次耗时 ${durationMs}ms，超过 ${thresholdMs}ms`);
        return;
      }
      streak.durations.push(durationMs);
      if (finishedAt - streak.warnedAt < SLOW_LOOP_SUMMARY_MS) return;
      const sorted = streak.durations.sort((left, right) => left - right);
      const p50Ms = sorted[Math.floor((sorted.length - 1) / 2)]!;
      const maxMs = sorted.at(-1)!;
      const minutes = Math.round((finishedAt - streak.warnedAt) / 60_000);
      streak.warnedAt = finishedAt;
      streak.durations = [];
      log.warn({ loop: name, count: sorted.length, p50Ms, maxMs, thresholdMs },
        `周期循环 ${name} 持续偏慢：近 ${minutes} 分钟又有 ${sorted.length} 次超过 ${thresholdMs}ms，p50 ${p50Ms}ms，最长 ${maxMs}ms`);
    } catch { /* logging must not break the loop */ }
  };
  let result: T;
  try { result = run(); }
  catch (error) { finish(); throw error; }
  if (typeof (result as { then?: unknown } | null)?.then !== 'function') { finish(); return result; }
  return (result as unknown as Promise<unknown>).finally(finish) as T;
}
