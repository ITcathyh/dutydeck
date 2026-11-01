import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigRepository } from '@dutydeck/shared';
import { DutydeckWatch, WATCH_FIRST_RUN_MS, WATCH_INTERVAL_MS, WATCH_PREFIX, checkWatchFindings, readWatchFindings, startDutydeckWatch, watchFingerprint, watchFindingSchema, type WatchScope, type WatchSignal } from './watch.js';

const at = '2026-11-01T02:00:00.000Z';
const signal = (objectId = 'task_1', kind = 'result_delivery'): WatchSignal => ({ kind, objectId, title: '结果投递未确认成功', since: at, location: 'https://example.test/session/1' });
function fixture() {
  let clock = at;
  const rows = new Map<string, string>();
  const store: ConfigRepository = { get: async key => rows.get(key), set: async (key, value) => { rows.set(key, value); },
    list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) };
  let scope: WatchScope = { appId: 'cli_test', ownerId: 'ou_owner', notify: true, signals: [] };
  const send = vi.fn().mockResolvedValue({});
  const warn = vi.fn();
  const watch = new DutydeckWatch({ store, collect: async () => [scope], send, warn, now: () => new Date(clock) });
  return { rows, store, watch, send, warn, scope, setNow: (value: string) => { clock=value; }, findings: () => readWatchFindings([...rows].map(([key,value]) => ({key,value}))) };
}
afterEach(() => vi.useRealTimers());

describe('watch findings and notifications', () => {
  it('is silent when healthy and persists only its own namespace', async () => {
    const h = fixture(); await h.watch.run();
    expect(h.send).not.toHaveBeenCalled(); expect(h.rows.size).toBe(0);
  });
  it('reports each fingerprint once, silently recovers, and reports a new episode', async () => {
    const h = fixture(); h.scope.signals = [signal()];
    await h.watch.run(); await h.watch.run();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.findings()[0]).toMatchObject({ episode: 1, firstSeenAt: at, notifiedAt: at });
    h.scope.signals = []; await h.watch.run();
    expect(h.findings()[0]?.recoveredAt).toBe(at); expect(h.send).toHaveBeenCalledTimes(1);
    h.scope.signals = [signal()]; await h.watch.run();
    expect(h.send).toHaveBeenCalledTimes(2); expect(h.findings()[0]).toMatchObject({ episode: 2 });
    expect(h.send.mock.calls[0]?.[0].idempotencyKey).not.toBe(h.send.mock.calls[1]?.[0].idempotencyKey);
    expect([...h.rows.keys()].every(key => key.startsWith(WATCH_PREFIX + 'cli_test/'))).toBe(true);
  });
  it('keeps onset and first observation stable while the same issue persists', async () => {
    const h = fixture(); h.scope.signals = [signal()]; await h.watch.run();
    h.scope.signals = [{ ...signal(), since: '2026-11-01T03:00:00.000Z' }]; await h.watch.run();
    expect(h.findings()[0]?.since).toBe(at); expect(h.findings()[0]?.firstSeenAt).toBe(at);
  });
  it('isolates type/object fingerprints and removes duplicate observations in one pass', async () => {
    const h = fixture(); h.scope.signals = [signal(), signal(), signal('task_2'), signal('task_1','memory_failures')];
    await h.watch.run(); expect(h.findings()).toHaveLength(3);
    expect(new Set(h.findings().map(row => row.fingerprint)).size).toBe(3);
    expect(h.send.mock.calls[0]?.[0].text).toContain('3 个新问题');
  });
  it('aggregates blocked queues, unknown results and schedules into one message with counts and links', async () => {
    const h = fixture();
    h.scope.signals = ['queue_blocked','result_unknown','schedule_overdue'].flatMap(kind => ['one','two'].map(id => ({ ...signal(id,kind), title: kind })));
    await h.watch.run(); expect(h.send).toHaveBeenCalledTimes(1);
    const text = h.send.mock.calls[0]?.[0].text;
    expect(text.split('\n')).toHaveLength(4);
    for (const kind of ['queue_blocked','result_unknown','schedule_overdue']) expect(text).toContain(kind + ' 2 项');
    expect(text).toContain('https://example.test/session/1');
  });
  it('records findings without sending when owner is missing, and can notify once an owner becomes available', async () => {
    const h = fixture(); h.scope.ownerId = undefined; h.scope.signals = [signal()];
    await h.watch.run(); expect(h.send).not.toHaveBeenCalled(); expect(h.warn).toHaveBeenCalled();
    expect(h.findings()).toHaveLength(1); h.scope.ownerId = 'ou_owner'; await h.watch.run();
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('checks Web instances without direct messages', async () => {
    const h = fixture(); h.scope.appId = 'web'; h.scope.notify = false; h.scope.signals = [signal()];
    await h.watch.run(); expect(h.send).not.toHaveBeenCalled(); expect(h.findings()).toHaveLength(1);
  });
  it('freezes the provider UUID and payload after an uncertain send, even when a new issue appears', async () => {
    const h = fixture(); h.scope.signals = [signal()];
    h.send.mockRejectedValueOnce(new Error('response lost')); await h.watch.run();
    h.scope.signals.push(signal('new')); await h.watch.run();
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.send.mock.calls[1]?.[0]).toEqual(h.send.mock.calls[0]?.[0]);
    expect(h.send.mock.calls[2]?.[0].text).toContain('1 个新问题');
    expect(h.findings().every(row => row.notifiedAt)).toBe(true);
  });
  it('does not resend an unknown notification beyond the provider window, including after restart', async () => {
    const h=fixture();h.scope.signals=[signal()];h.send.mockRejectedValueOnce(new Error('lost response'));
    await h.watch.run();
    const later='2026-11-01T03:01:00.000Z';h.setNow(later);
    const restarted=new DutydeckWatch({store:h.store,collect:async()=>[h.scope],send:h.send,warn:h.warn,now:()=>new Date(later)});
    await restarted.run();await restarted.run();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.findings()[0]).toMatchObject({notificationUnknownAt:later});
    expect(h.findings()[0]?.notifiedAt).toBeUndefined();
    expect(checkWatchFindings(Object.fromEntries(h.rows)).detail).toContain('巡检通知发送结果未知');
    h.scope.signals.push(signal('new'));await restarted.run();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1]?.[0].text).toContain('1 个新问题');
    h.scope.signals=[];await restarted.run();h.scope.signals=[signal()];await restarted.run();
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.findings().find(row=>row.objectId==='task_1')?.episode).toBe(2);
  });
  it('reuses the frozen batch after partial receipt persistence fails', async () => {
    const h = fixture(); h.scope.signals = [signal(), signal('two')];
    const set = h.store.set;
    let failed = false;
    h.store.set = async (key, value) => {
      if (!failed && key.endsWith(watchFingerprint('result_delivery','two')) && JSON.parse(value).notifiedAt) {
        failed = true; throw new Error('database busy');
      }
      await set(key, value);
    };
    await h.watch.run(); await h.watch.run();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1]?.[0]).toEqual(h.send.mock.calls[0]?.[0]);
    expect(h.findings().every(row => row.notifiedAt)).toBe(true);
  });
  it('does not send recovered pending findings or a frozen notification to a former owner', async () => {
    const h = fixture(); h.scope.signals = [signal()]; h.send.mockRejectedValueOnce(new Error('timeout'));
    await h.watch.run(); h.scope.signals = []; await h.watch.run();
    expect(h.send).toHaveBeenCalledTimes(1);
    h.scope.signals = [signal()]; h.send.mockRejectedValueOnce(new Error('timeout')); await h.watch.run();
    h.scope.ownerId = 'ou_new'; await h.watch.run();
    expect(h.send.mock.calls.at(-1)?.[0].ownerId).toBe('ou_new');
  });
  it('serializes overlapping runs', async () => {
    const h = fixture(); h.scope.signals = [signal()];
    await Promise.all([h.watch.run(),h.watch.run(),h.watch.run()]);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('uses a strict versioned schema and ignores malformed rows in doctor', () => {
    expect(watchFindingSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
    expect(checkWatchFindings({ [WATCH_PREFIX+'bad']: '{' }).level).toBe('ok');
  });
});

describe('watch scheduling and CLI', () => {
  it('first runs at five minutes, then hourly, and stops all timers', async () => {
    vi.useFakeTimers(); const run = vi.fn().mockResolvedValue(undefined);
    const stop = startDutydeckWatch({ run }, vi.fn());
    await vi.advanceTimersByTimeAsync(WATCH_FIRST_RUN_MS - 1); expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS); expect(run).toHaveBeenCalledTimes(2);
    await stop(); await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS); expect(run).toHaveBeenCalledTimes(2);
  });
  it('waits for an in-flight check before stopping and does not schedule another', async () => {
    vi.useFakeTimers(); let release!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const stop = startDutydeckWatch({run}, vi.fn());
    await vi.advanceTimersByTimeAsync(WATCH_FIRST_RUN_MS);
    let stopped = false; const closing = stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await closing; await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('doctor lists only unresolved findings with first observation time', async () => {
    const h = fixture(); h.scope.signals = [signal()]; await h.watch.run();
    const check = checkWatchFindings(Object.fromEntries(h.rows));
    expect(check).toMatchObject({ label: '巡检发现', level: 'warn' });
    expect(check.detail).toContain('首次发现 ' + at);
    expect(check.detail).toContain('https://example.test/session/1');
    h.scope.signals = []; await h.watch.run();
    expect(checkWatchFindings(Object.fromEntries(h.rows)).level).toBe('ok');
    expect(checkWatchFindings({},true).level).toBe('skip');
  });
});
