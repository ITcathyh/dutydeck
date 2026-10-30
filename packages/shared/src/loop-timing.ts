export interface LoopTimingLog {
  warn(details: Record<string, unknown>, message: string): void;
}

/** Warn when a single run of a periodic loop takes at least this long. */
export const SLOW_LOOP_WARN_MS = 500;

/**
 * Run one cycle of a periodic loop and log a warning, with the loop name and
 * duration, only when it took at least `thresholdMs` (wall time, including
 * awaits). Returns the cycle's own result; sync and async cycles both work.
 */
export function timeLoop<T>(name: string, log: LoopTimingLog | undefined, run: () => T, thresholdMs = SLOW_LOOP_WARN_MS): T {
  const startedAt = performance.now();
  const finish = () => {
    const durationMs = Math.round(performance.now() - startedAt);
    if (durationMs < thresholdMs) return;
    try { log?.warn({ loop: name, durationMs, thresholdMs }, `周期循环 ${name} 单次耗时 ${durationMs}ms，超过 ${thresholdMs}ms`); } catch { /* logging must not break the loop */ }
  };
  let result: T;
  try { result = run(); }
  catch (error) { finish(); throw error; }
  if (typeof (result as { then?: unknown } | null)?.then !== 'function') { finish(); return result; }
  return (result as unknown as Promise<unknown>).finally(finish) as T;
}
