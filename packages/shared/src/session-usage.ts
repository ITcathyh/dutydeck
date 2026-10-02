/** Current session measurements; token totals belong to the separate usage ledger. */
export interface ContextUsage { used: number; size?: number; observedAt: string }
export interface RateLimitWindow { usedPercent: number; resetsAt: number; observedAt: string }
export interface SessionUsageSnapshot { context?: ContextUsage; rateLimits?: { fiveHour?: RateLimitWindow; sevenDay?: RateLimitWindow }; error?: string }
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function contextUsage(used: unknown, size: unknown, observedAt: string): ContextUsage | undefined {
  return nonnegative(used) && Number.isSafeInteger(used) && Number.isFinite(Date.parse(observedAt)) ? { used, ...(nonnegative(size) && Number.isSafeInteger(size) && size > 0 ? { size } : {}), observedAt } : undefined;
}
export function rateLimitWindow(percent: unknown, reset: unknown, observedAt: string): RateLimitWindow | undefined {
  return nonnegative(percent) && percent <= 100 && nonnegative(reset) && reset > 0 && Number.isFinite(new Date(reset * 1000).getTime()) && Number.isFinite(Date.parse(observedAt))
    ? { usedPercent: percent, resetsAt: reset, observedAt } : undefined;
}
export function claudeRateLimits(raw: any, observedAt: string): SessionUsageSnapshot['rateLimits'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const result: NonNullable<SessionUsageSnapshot['rateLimits']> = {};
  const fractionWindow = (value: any) => nonnegative(value?.utilization) && value.utilization <= 1
    ? rateLimitWindow(value.utilization * 100, value.resetsAt, observedAt) : undefined;
  // SDK fractions differ from the statusline / structured usage percent schema.
  for (const [source, key] of [['five_hour', 'fiveHour'], ['seven_day', 'sevenDay']] as const) {
    const window = fractionWindow(raw.unifiedWindows?.[source]);
    if (window) result[key] = window;
  }
  const key = raw.rateLimitType === 'five_hour' ? 'fiveHour' : raw.rateLimitType === 'seven_day' ? 'sevenDay' : undefined;
  const window = fractionWindow(raw);
  if (key && window) result[key] ??= window;
  return Object.keys(result).length ? result : undefined;
}
export function codexRateLimits(raw: any, observedAt: string): SessionUsageSnapshot['rateLimits'] {
  const result: NonNullable<SessionUsageSnapshot['rateLimits']> = {};
  for (const rawWindow of [raw?.primary, raw?.secondary]) {
    const key = rawWindow?.window_minutes === 300 ? 'fiveHour' : rawWindow?.window_minutes === 10080 ? 'sevenDay' : undefined;
    const window = rateLimitWindow(rawWindow?.used_percent, rawWindow?.resets_at, observedAt);
    if (key && window) result[key] = window;
  }
  return Object.keys(result).length ? result : undefined;
}
