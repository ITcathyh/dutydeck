import { describe, expect, it } from 'vitest';
import { claudeRateLimits, codexRateLimits, contextUsage, rateLimitWindow } from './session-usage.js';
const at = '2026-10-02T08:00:00Z';
describe('session usage measurements', () => {
  it('keeps zero valid and rejects invalid context and quota values', () => {
    expect(contextUsage(0, 200000, at)).toEqual({ used: 0, size: 200000, observedAt: at });
    expect(contextUsage(-1, 200000, at)).toBeUndefined();
    expect(contextUsage(100, 0, at)).toEqual({ used: 100, observedAt: at });
    expect(rateLimitWindow(0, 1, at)?.usedPercent).toBe(0);
    for (const value of [-1, 101, NaN, Infinity, '5', null]) expect(rateLimitWindow(value, 1, at)).toBeUndefined();
    expect(rateLimitWindow(50, 0, at)).toBeUndefined();
  });
  it('converts Claude SDK fractions and excludes model-specific limits', () => {
    expect(claudeRateLimits({ rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1791000000 }, at)).toMatchObject({ fiveHour: { usedPercent: 42 } });
    expect(claudeRateLimits({ rateLimitType: 'seven_day', utilization: 0, resetsAt: 1 }, at)).toMatchObject({ sevenDay: { usedPercent: 0 } });
    expect(claudeRateLimits({ rateLimitType: 'seven_day_sonnet', utilization: 0.5, resetsAt: 1 }, at)).toBeUndefined();
    expect(claudeRateLimits({ rateLimitType: 'five_hour', utilization: 42, resetsAt: 1 }, at)).toBeUndefined();
    expect(claudeRateLimits({ unifiedWindows: { five_hour: { utilization: 0, resetsAt: 1 }, seven_day: { utilization: 0.75, resetsAt: 2 } } }, at)).toMatchObject({ fiveHour: { usedPercent: 0 }, sevenDay: { usedPercent: 75 } });
  });
  it('maps Codex by duration rather than primary/secondary position', () => {
    expect(codexRateLimits({ primary: { window_minutes: 10080, used_percent: 0, resets_at: 1 }, secondary: null }, at)).toMatchObject({ sevenDay: { usedPercent: 0 } });
    expect(codexRateLimits({ primary: { window_minutes: 300, used_percent: 12, resets_at: 1 }, secondary: { window_minutes: 10080, used_percent: 50, resets_at: 2 } }, at)).toMatchObject({ fiveHour: { usedPercent: 12 }, sevenDay: { usedPercent: 50 } });
    expect(codexRateLimits({ primary: { window_minutes: 60, used_percent: 12, resets_at: 1 } }, at)).toBeUndefined();
  });
});
