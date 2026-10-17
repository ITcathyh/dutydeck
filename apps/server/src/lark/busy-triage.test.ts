import { describe, expect, it } from 'vitest';
import { busyTriagePrompt, parseBusyTriageResult } from './busy-triage.js';

describe('busy triage uses agent command validation', () => {
  it.each(['cancel', 'stop', 'approve', 'reject', 'answer', 'steer'])('rejects unavailable or user-only %s', action => {
    expect(() => parseBusyTriageResult(JSON.stringify({ kind: 'command', action, params: {} }))).toThrow();
  });
  it.each(['not json', '{"kind":"unknown"}', '{"kind":"progress","extra":true}', '{"kind":"command","action":"queue.cancel","params":{"index":0}}', '{"kind":"command","action":"status","params":{"page":1}}'])('rejects malformed results %s', value => {
    expect(() => parseBusyTriageResult(value)).toThrow();
  });
  it('validates supported action arguments and documents stop fallback', () => {
    expect(parseBusyTriageResult('{"kind":"command","action":"queue.cancel","params":{"index":2}}')).toMatchObject({ command: '/queue cancel 2' });
    expect(busyTriagePrompt('停下来', '修改接口')).toContain('绝不自动停止或中断');
  });
});


it('accepts schedule and settings proposals through their shared validators', () => {
  expect(parseBusyTriageResult('{"kind":"command","action":"schedule.create","params":{"prompt":"看 CI","cron":"0 9 * * *"}}')).toMatchObject({ kind: 'schedule', params: { prompt: '看 CI', cron: '0 9 * * *' } });
  expect(parseBusyTriageResult('{"kind":"command","action":"settings.set","params":{"pairs":["notifyQuietHours=22:00-08:00"]}}')).toEqual({ kind: 'settings', pairs: ['notifyQuietHours=22:00-08:00'] });
  for (const action of ['schedule.create', 'settings.set']) expect(() => parseBusyTriageResult(JSON.stringify({ kind: 'command', action, params: { dryRun: true } }))).toThrow();
});
