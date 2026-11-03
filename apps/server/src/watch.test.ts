import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigRepository } from '@dutydeck/shared';
import { DutydeckWatch, WATCH_RECOVERED_RETENTION_MS, WATCH_RECOVERED_LIMIT, WATCH_FIRST_RUN_MS, WATCH_INTERVAL_MS, WATCH_PREFIX, checkWatchFindings, readWatchFindings, startDutydeckWatch, watchFingerprint, watchFindingSchema, type WatchScope, type WatchSignal } from './watch.js';

const at = '2026-11-01T02:00:00.000Z';
const signal = (objectId = 'task_1', kind = 'result_delivery'): WatchSignal => ({ kind, objectId, title: '结果投递未确认成功', since: at, location: 'https://example.test/session/1' });
function fixture() {
  let clock = at;
  const rows = new Map<string, string>();
  const store: ConfigRepository = { get: async key => rows.get(key), set: async (key, value) => { rows.set(key, value); },
    remove: async (key, expected) => rows.get(key) === expected && rows.delete(key),
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
  it('warns about a missing receiver at most once a day, shows it in doctor, and clears it once a receiver exists', async () => {
    const h = fixture(); h.scope.ownerId = undefined; h.scope.signals = [signal()];
    await h.watch.run(); h.scope.signals.push(signal('two')); await h.watch.run();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]?.[0]).toMatchObject({ appId: 'cli_test', code: 'WATCH_RECEIVER_MISSING' });
    expect(checkWatchFindings(Object.fromEntries(h.rows)).detail).toContain('巡检无人接收');
    h.setNow('2026-11-02T01:59:00.000Z'); await h.watch.run(); expect(h.warn).toHaveBeenCalledTimes(1);
    h.setNow('2026-11-02T02:00:00.000Z'); await h.watch.run(); expect(h.warn).toHaveBeenCalledTimes(2);
    h.scope.ownerId = '6796811306012770306'; h.scope.ownerIdType = 'user_id'; await h.watch.run();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({ ownerId: '6796811306012770306', ownerIdType: 'user_id' });
    expect([...h.rows.keys()].some(key => key.endsWith('/unreachable'))).toBe(false);
    expect(checkWatchFindings(Object.fromEntries(h.rows)).detail).not.toContain('巡检无人接收');
  });
  it('keeps a silent bot without a receiver visible in doctor even when nothing is wrong', async () => {
    const h = fixture(); h.scope.ownerId = undefined;
    await h.watch.run();
    expect(h.warn).not.toHaveBeenCalled();
    expect(checkWatchFindings(Object.fromEntries(h.rows))).toMatchObject({ level: 'warn', detail: expect.stringContaining('巡检无人接收：cli_test') });
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


function seedFinding(h: ReturnType<typeof fixture>, objectId: string, recoveredAt?: string, appId = 'cli_test') {
  const fingerprint = watchFingerprint('result_delivery', objectId);
  const finding = { schemaVersion: 1 as const, appId, fingerprint, ...signal(objectId), firstSeenAt: at, lastSeenAt: at, episode: 1,
    ...(recoveredAt ? { recoveredAt } : {}) };
  const key = WATCH_PREFIX + appId + '/' + fingerprint;
  const raw = JSON.stringify(finding, null, 2);
  h.rows.set(key, raw);
  return { key, raw, finding };
}
const before = (ms: number) => new Date(Date.parse(at) - ms).toISOString();
const notice = (fingerprints: string[], status = 'pending') => JSON.stringify({ schemaVersion: 1, idempotencyKey: 'watch_frozen',
  ownerId: 'ou_owner', text: '冻结通知', status, members: fingerprints.map(fingerprint => ({ fingerprint, episode: 1 })) });

describe('watch recovered finding retention', () => {
  it.each(['web', 'no owner'])('prunes at seven days in a healthy %s scope using the exact original value', async mode => {
    const h = fixture();
    if (mode === 'web') h.scope.notify = false; else h.scope.ownerId = undefined;
    const old = seedFinding(h, 'old', before(WATCH_RECOVERED_RETENTION_MS + 1));
    const boundary = seedFinding(h, 'boundary', before(WATCH_RECOVERED_RETENTION_MS));
    const recent = seedFinding(h, 'recent', before(WATCH_RECOVERED_RETENTION_MS - 1));
    const other = seedFinding(h, 'other', before(WATCH_RECOVERED_RETENTION_MS + 1), 'cli_other');
    const remove = vi.spyOn(h.store, 'remove');
    await h.watch.run();
    expect(remove).toHaveBeenCalledWith(old.key, old.raw);
    expect(remove).toHaveBeenCalledWith(boundary.key, boundary.raw);
    expect(h.rows.has(old.key)).toBe(false); expect(h.rows.has(boundary.key)).toBe(false);
    expect(h.rows.get(recent.key)).toBe(recent.raw); expect(h.rows.get(other.key)).toBe(other.raw);
    expect(h.send).not.toHaveBeenCalled();
  });
  it('keeps the latest 1000 recovered records, active findings and pending notification references', async () => {
    const h = fixture(); h.scope.notify = false; h.scope.signals = [signal('active')];
    const active = seedFinding(h, 'active');
    const protectedRow = seedFinding(h, 'protected', before(WATCH_RECOVERED_RETENTION_MS + 1));
    const notificationKey = WATCH_PREFIX + 'cli_test/notification';
    const rawNotice = notice([protectedRow.finding.fingerprint]);
    h.rows.set(notificationKey, rawNotice);
    h.rows.set(WATCH_PREFIX + 'cli_test/invalid', '{"recoveredAt":"invalid"}');
    const recent = Array.from({ length: WATCH_RECOVERED_LIMIT + 5 }, (_, index) => seedFinding(h, 'recent_' + index, before(index + 1)));
    await h.watch.run();
    const recovered = h.findings().filter(finding => finding.recoveredAt);
    expect(recovered).toHaveLength(WATCH_RECOVERED_LIMIT);
    expect(h.rows.get(protectedRow.key)).toBe(protectedRow.raw);
    expect(h.rows.has(recent[WATCH_RECOVERED_LIMIT - 2]!.key)).toBe(true);
    expect(h.rows.has(recent[WATCH_RECOVERED_LIMIT - 1]!.key)).toBe(false);
    expect(JSON.parse(h.rows.get(active.key)!)).not.toHaveProperty('recoveredAt');
    expect(h.rows.get(notificationKey)).toBe(rawNotice);
    expect(h.rows.has(WATCH_PREFIX + 'cli_test/invalid')).toBe(true);
  });
  it('allows protected references to exceed the cap rather than deleting pending notification evidence', async () => {
    const h = fixture(); h.scope.notify = false;
    const rows = Array.from({ length: WATCH_RECOVERED_LIMIT + 1 }, (_, index) => seedFinding(h, 'protected_' + index, before(WATCH_RECOVERED_RETENTION_MS + 1)));
    h.rows.set(WATCH_PREFIX + 'cli_test/notification', notice(rows.map(row => row.finding.fingerprint)));
    await h.watch.run();
    expect(h.findings()).toHaveLength(WATCH_RECOVERED_LIMIT + 1);
  });
  it.each(['list', 'remove'])('only warns when retention %s fails and still reports current problems', async failure => {
    const h = fixture(); seedFinding(h, 'old', before(WATCH_RECOVERED_RETENTION_MS + 1)); h.scope.signals = [signal('current')];
    if (failure === 'remove') h.store.remove = vi.fn().mockRejectedValue(new Error('storage unavailable'));
    else {
      const list = h.store.list!; let calls = 0;
      h.store.list = async prefix => { if (++calls === 2) throw new Error('storage unavailable'); return list(prefix); };
    }
    await h.watch.run();
    expect(h.warn).toHaveBeenCalledWith(expect.anything(), '清理已恢复巡检记录失败');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.findings().find(finding => finding.objectId === 'current')?.notifiedAt).toBe(at);
  });
  it('does not delete a finding that concurrently reappears after the retention snapshot', async () => {
    const h = fixture(); h.scope.notify = false;
    const old = seedFinding(h, 'racing', before(WATCH_RECOVERED_RETENTION_MS + 1));
    const replacement = JSON.stringify({ ...old.finding, recoveredAt: undefined, firstSeenAt: at, episode: 2 });
    const remove = h.store.remove!;
    h.store.remove = async (key, expected) => { h.rows.set(key, replacement); return remove(key, expected); };
    await h.watch.run();
    expect(h.rows.get(old.key)).toBe(replacement);
  });
  it('uses a new notification UUID when a capped record reappears with its episode reset', async () => {
    const h = fixture(); h.scope.signals = [signal()]; await h.watch.run();
    const firstKey = h.send.mock.calls[0]![0].idempotencyKey;
    h.scope.signals = []; h.setNow('2026-11-01T02:00:00.001Z'); await h.watch.run();
    for (let index = 0; index < WATCH_RECOVERED_LIMIT; index++) seedFinding(h, 'newer_' + index, '2026-11-01T02:00:00.002Z');
    h.setNow('2026-11-01T02:00:00.003Z'); await h.watch.run();
    expect(h.findings().some(finding => finding.objectId === 'task_1')).toBe(false);
    h.setNow('2026-11-01T02:00:00.004Z'); h.scope.signals = [signal()]; await h.watch.run();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.findings().find(finding => finding.objectId === 'task_1')?.episode).toBe(1);
    expect(h.send.mock.calls[1]![0].idempotencyKey).not.toBe(firstKey);
  });
});
