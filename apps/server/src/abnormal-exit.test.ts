import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { abnormalExitFileName, abnormalExitNote, beginServeRun, enrichAbnormalExitFromJournal, markServeRunning, readAbnormalExit, recordAbnormalExit, recordCleanExit, type AbnormalExitRecord, type ServeRunLifecycle } from './abnormal-exit.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = () => { const root = mkdtempSync(join(tmpdir(), 'dutydeck-abnormal-exit-')); roots.push(root); return root; };
const databaseIn = (root: string) => { const database = join(root, 'dutydeck.db'); writeFileSync(database, ''); return database; };
const lifecycle = (runId: string, override: Partial<ServeRunLifecycle> = {}): ServeRunLifecycle => ({
  runId, pid: 4321, startedAt: '2026-11-13T00:00:00.000Z', version: '1.2.3', phase: 'running', unit: 'dutydeck-test.service', boot: 'boot-test', ...override
});
const documentIn = (database: string) => JSON.parse(readFileSync(join(dirname(database), abnormalExitFileName), 'utf8')) as Record<string, any>;

// 未修改的第五轮读取器（含同库路径判断），用于证明旧程序能读新格式。
const legacyCanonical = (path: string) => {
  try { return realpathSync(path); } catch { /* 文件不存在 */ }
  try { return join(realpathSync(dirname(path)), basename(path)); } catch { return resolve(path); }
};
function legacyReadAbnormalExit(databaseUrl: string | undefined): AbnormalExitRecord | undefined {
  if (!databaseUrl || databaseUrl === ':memory:' || databaseUrl.startsWith('file:')) return undefined;
  const database = legacyCanonical(databaseUrl);
  try {
    const parsed = JSON.parse(readFileSync(join(dirname(database), abnormalExitFileName), 'utf8')) as Partial<AbnormalExitRecord>;
    if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || (parsed.kind !== 'fatal' && parsed.kind !== 'startup')) return undefined;
    if (typeof parsed.database !== 'string' || legacyCanonical(parsed.database) !== database) return undefined;
    return { at: parsed.at, kind: parsed.kind, exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : 1, error: typeof parsed.error === 'string' ? parsed.error : '', version: typeof parsed.version === 'string' ? parsed.version : '', database: parsed.database };
  } catch { return undefined; }
}


describe('abnormal exit record', () => {
  it('writes next to the database with a redacted first line and reads it back only for the same database', () => {
    const root = scratch(); const database = join(root, 'data', 'dutydeck.db'); mkdirSync(join(root, 'data'));
    const now = new Date('2026-11-08T02:00:00.000Z');
    recordAbnormalExit(database, { kind: 'fatal', exitCode: 1, error: new Error('boom password=hunter2-secret token: "abc-def"\n    at secondLine (/srv/private.js:1:1)'), version: '9.9.9', now });
    const file = join(root, 'data', abnormalExitFileName);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('hunter2-secret');
    expect(raw).not.toContain('abc-def');
    expect(raw).not.toContain('secondLine');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readAbnormalExit(database)).toEqual({ at: now.toISOString(), kind: 'fatal', exitCode: 1, error: expect.stringContaining('boom'), version: '9.9.9', database });
    // 同目录下的另一个库不认这条记录。
    expect(readAbnormalExit(join(root, 'data', 'other.db'))).toBeUndefined();
  });

  it('matches the database through symlinks', () => {
    const root = scratch(); mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    recordAbnormalExit(join(root, 'link', 'dutydeck.db'), { kind: 'startup', exitCode: 1, error: 'bad config', version: '1' });
    expect(existsSync(join(root, 'real', abnormalExitFileName))).toBe(true);
    expect(readAbnormalExit(join(root, 'real', 'dutydeck.db'))?.kind).toBe('startup');
  });

  it('writes nothing without a resolved file database and stays silent when the directory is missing', () => {
    const root = scratch();
    for (const database of [undefined, '', ':memory:']) recordAbnormalExit(database, { kind: 'startup', exitCode: 1, error: 'x', version: '1' });
    expect(() => recordAbnormalExit(join(root, 'missing', 'dutydeck.db'), { kind: 'fatal', exitCode: 1, error: 'x', version: '1' })).not.toThrow();
    expect(existsSync(join(root, 'missing'))).toBe(false);
    expect(readAbnormalExit(undefined)).toBeUndefined();
  });

  it('ignores unreadable or foreign records', () => {
    const root = scratch(); const database = join(root, 'dutydeck.db');
    writeFileSync(join(root, abnormalExitFileName), 'not json');
    expect(readAbnormalExit(database)).toBeUndefined();
    writeFileSync(join(root, abnormalExitFileName), JSON.stringify({ at: new Date().toISOString(), kind: 'fatal', exitCode: 1, error: 'x', version: '1', database: '/elsewhere/dutydeck.db' }));
    expect(readAbnormalExit(database)).toBeUndefined();
  });
});

describe('serve lifecycle and bounded abnormal history', () => {
  it('does not expose an in-progress lifecycle as an old-format abnormal exit, and the unchanged old reader ignores new metadata', () => {
    const root = scratch(), database = databaseIn(root), run = lifecycle('run-1');
    const started = beginServeRun(database, run, { isProcessAlive: () => false });
    expect(started.previousRun).toBeUndefined();
    expect(documentIn(database)).toMatchObject({ lifecycle: { runId: 'run-1', pid: 4321, startedAt: run.startedAt, unit: run.unit, boot: run.boot, phase: 'starting' } });
    expect(readAbnormalExit(database)).toBeUndefined();
    expect(legacyReadAbnormalExit(database)).toBeUndefined();

    recordAbnormalExit(database, { kind: 'fatal', exitCode: 1, error: 'boom', version: run.version, lifecycle: run });
    expect(legacyReadAbnormalExit(database)).toEqual({ at: expect.any(String), kind: 'fatal', exitCode: 1, error: 'boom', version: run.version, database });
    expect(readAbnormalExit(database)).toMatchObject({ runId: 'run-1', phase: 'running' });
  });

  it('reads an old single-record file, keeps only the latest 10, and deduplicates by runId', () => {
    const root = scratch(), database = databaseIn(root);
    const old = { at: '2026-11-01T00:00:00.000Z', kind: 'startup', exitCode: 1, error: 'old', version: '1', database };
    writeFileSync(join(root, abnormalExitFileName), JSON.stringify(old));
    expect(readAbnormalExit(database)).toEqual(old);
    for (let index = 0; index < 12; index++) {
      const run = lifecycle(`run-${index}`, { phase: index % 2 ? 'running' : 'starting' });
      recordAbnormalExit(database, { kind: index % 2 ? 'fatal' : 'startup', exitCode: 1, error: `error-${index}`, version: '2', lifecycle: run, now: new Date(Date.UTC(2026, 10, 13, 0, index)) });
    }
    let document = documentIn(database);
    expect(document.history).toHaveLength(10);
    expect(document.history.map((entry: any) => entry.runId)).toEqual(Array.from({ length: 10 }, (_, index) => `run-${index + 2}`));
    expect(['fatal', 'startup']).toContain(document.kind);

    recordAbnormalExit(database, { kind: 'fatal', exitCode: 1, error: 'repeat', version: '2', lifecycle: lifecycle('run-5') });
    document = documentIn(database);
    expect(document.history).toHaveLength(10);
    expect(new Set(document.history.map((entry: any) => entry.runId)).size).toBe(10);
    expect(document.history.filter((entry: any) => entry.runId === 'run-5')).toHaveLength(1);
    expect(document).toMatchObject({ runId: 'run-5', error: 'repeat', kind: 'fatal' });
  });

  it.each(['stopped', 'planned-restart'] as const)('does not turn a %s generation into an abnormal exit', reason => {
    const root = scratch(), database = databaseIn(root), first = beginServeRun(database, lifecycle('clean-run')).lifecycle;
    markServeRunning(database, first);
    recordCleanExit(database, first, { reason, signal: 'SIGTERM' });
    const second = beginServeRun(database, lifecycle('next-run'), { isProcessAlive: () => { throw new Error('a clean generation must not need a PID probe'); } });
    expect(second.previousRun).toBeUndefined();
    expect(readAbnormalExit(database)).toBeUndefined();
    expect(documentIn(database)['clean-exit']).toMatchObject({ runId: 'clean-run', reason, signal: 'SIGTERM' });
  });

  it('only lets the current runId mark a clean exit and does not report a previous PID that is still alive', () => {
    const root = scratch(), database = databaseIn(root), first = beginServeRun(database, lifecycle('run-1')).lifecycle;
    const second = beginServeRun(database, lifecycle('run-2'), { isProcessAlive: () => true });
    expect(second.previousRun).toBeUndefined();
    expect(readAbnormalExit(database)).toBeUndefined();
    recordCleanExit(database, second.lifecycle, { reason: 'stopped' });
    expect(documentIn(database)['clean-exit']).toBeUndefined();
    const third = beginServeRun(database, lifecycle('run-3'), { isProcessAlive: () => false });
    expect(third.previousRun?.runId).toBe('run-1');
    expect(readAbnormalExit(database)).toMatchObject({ runId: 'run-1', kind: 'startup', phase: 'starting' });
  });

  it('keeps startup and running phases distinct and preserves an existing abnormal record across later clean stops', () => {
    const root = scratch(), database = databaseIn(root);
    const first = beginServeRun(database, lifecycle('startup-run')).lifecycle;
    expect(first.phase).toBe('starting');
    const second = beginServeRun(database, lifecycle('clean-run'), { isProcessAlive: () => false }).lifecycle;
    expect(readAbnormalExit(database)).toMatchObject({ runId: 'startup-run', kind: 'startup' });
    recordCleanExit(database, second, { reason: 'stopped', signal: 'SIGINT' });
    beginServeRun(database, lifecycle('third-run'), { isProcessAlive: () => false });
    const document = documentIn(database);
    expect(document.history).toHaveLength(1);
    expect(document).toMatchObject({ runId: 'startup-run', kind: 'startup' });
    expect(document['clean-exit']).toMatchObject({ runId: 'clean-run', signal: 'SIGINT' });
  });

  it('recovers from a corrupt diagnostic file without treating it as an abnormal exit', () => {
    const root = scratch(), database = databaseIn(root);
    writeFileSync(join(root, abnormalExitFileName), '{broken');
    expect(() => beginServeRun(database, lifecycle('new-run'))).not.toThrow();
    expect(readAbnormalExit(database)).toBeUndefined();
    expect(documentIn(database).lifecycle.runId).toBe('new-run');
    recordAbnormalExit(database, { kind: 'fatal', exitCode: 1, error: 'after corruption', version: '1' });
    expect(readAbnormalExit(database)).toMatchObject({ error: 'after corruption', kind: 'fatal' });
  });
});

describe('lifecycle ownership regressions', () => {
  it('ignores a legacy lock directory without deleting state that an older process may still own', () => {
    const root = scratch(), database = databaseIn(root), file = join(root, abnormalExitFileName), lock = `${file}.lock`;
    mkdirSync(lock); const expired = new Date(Date.now() - 10_000); utimesSync(lock, expired, expired);
    recordAbnormalExit(database, { kind: 'fatal', exitCode: 1, error: 'after stale lock', version: '1' });
    expect(readAbnormalExit(database)).toMatchObject({ error: 'after stale lock' });
    expect(existsSync(lock)).toBe(true);
  });

  it('keeps a live A lifecycle when B is rejected, then attributes A SIGKILL to C', () => {
    const root = scratch(), database = databaseIn(root);
    const a = beginServeRun(database, lifecycle('run-a', { pid: 1001 })).lifecycle;
    markServeRunning(database, a);
    beginServeRun(database, lifecycle('run-b', { pid: 1002 }), { isProcessAlive: () => true });
    expect(documentIn(database).lifecycle.runId).toBe('run-a');
    recordAbnormalExit(database, { kind: 'startup', exitCode: 1, error: 'DATABASE_RUNTIME_BUSY', version: '2', lifecycle: lifecycle('run-b', { pid: 1002 }) });
    expect(documentIn(database).lifecycle.runId).toBe('run-a');

    beginServeRun(database, lifecycle('run-c', { pid: 1003 }), { isProcessAlive: () => false });
    const document = documentIn(database);
    expect(document).toMatchObject({ runId: 'run-a', kind: 'fatal', database });
    expect(document.lifecycle.runId).toBe('run-c');
    expect(document.history.some((entry: any) => entry.runId === 'run-b' && entry.kind === 'startup')).toBe(true);
  });

  it('publishes B when it really acquires ownership after A exits and records A before enrichment', () => {
    const root = scratch(), database = databaseIn(root);
    const a = beginServeRun(database, lifecycle('run-a', { pid: 1001 })).lifecycle;
    markServeRunning(database, a);
    const b = beginServeRun(database, lifecycle('run-b', { pid: 1002 }), { isProcessAlive: () => true }).lifecycle;
    const published = markServeRunning(database, b, { isProcessAlive: () => false });
    const document = documentIn(database);
    expect(published.previousRun?.runId).toBe('run-a');
    expect(document.lifecycle).toMatchObject({ runId: 'run-b', phase: 'running' });
    expect(document).toMatchObject({ runId: 'run-a', kind: 'fatal' });
  });

  it('treats database ownership as proof to publish B even when the old running PID is alive', () => {
    const root = scratch(), database = databaseIn(root);
    const a = beginServeRun(database, lifecycle('run-a', { pid: 1001 })).lifecycle;
    markServeRunning(database, a);
    const b = beginServeRun(database, lifecycle('run-b', { pid: 1002 }), { isProcessAlive: () => true }).lifecycle;
    const published = markServeRunning(database, b, { isProcessAlive: () => true });
    expect(published.lifecycle).toMatchObject({ runId: 'run-b', phase: 'running' });
    expect(documentIn(database).lifecycle.runId).toBe('run-b');
    recordCleanExit(database, a, { reason: 'stopped' });
    expect(documentIn(database)['clean-exit']).toBeUndefined();
    expect(documentIn(database).cleanExits?.find((entry: any) => entry.runId === 'run-a')).toMatchObject({ runId: 'run-a', database });
  });

  it('persists the first running lifecycle when the database directory did not exist at begin', () => {
    const root = scratch(), database = join(root, 'missing', 'dutydeck.db');
    const first = beginServeRun(database, lifecycle('first-run')).lifecycle;
    expect(existsSync(join(root, 'missing'))).toBe(false);
    mkdirSync(join(root, 'missing'), { recursive: true }); writeFileSync(database, '');
    markServeRunning(database, first);
    expect(documentIn(database).lifecycle).toMatchObject({ runId: 'first-run', phase: 'running' });
    beginServeRun(database, lifecycle('second-run'), { isProcessAlive: () => false });
    expect(readAbnormalExit(database)).toMatchObject({ runId: 'first-run', kind: 'fatal' });
  });

  it('never attributes a lifecycle from a.db to b.db in the same directory', () => {
    const root = scratch(), a = join(root, 'a.db'), b = join(root, 'b.db');
    writeFileSync(a, ''); writeFileSync(b, '');
    const first = beginServeRun(a, lifecycle('run-a')).lifecycle;
    markServeRunning(a, first);
    beginServeRun(b, lifecycle('run-b'), { isProcessAlive: () => false });
    expect(readAbnormalExit(b)).toBeUndefined();
    const document = documentIn(b);
    expect(document.lifecycle).toMatchObject({ runId: 'run-b', database: b });
    expect(document.kind).toBeUndefined();
  });

  it('returns every dead unclean generation for asynchronous journal enrichment', () => {
    const root = scratch(), database = databaseIn(root);
    const a = beginServeRun(database, lifecycle('run-a', { pid: 1001 })).lifecycle;
    markServeRunning(database, a);
    beginServeRun(database, lifecycle('run-b', { pid: 1002 }), { isProcessAlive: () => true });
    const next = beginServeRun(database, lifecycle('run-c', { pid: 1003 }), { isProcessAlive: () => false });
    expect(next.previousRuns?.map(run => run.runId)).toEqual(['run-a', 'run-b']);
    expect(next.previousRun?.runId).toBe('run-b');
    const document = documentIn(database);
    expect(document.history.some((entry: any) => entry.runId === 'run-a')).toBe(true);
    expect(document.history.some((entry: any) => entry.runId === 'run-b')).toBe(true);
  });

  it('retains A across a clean b.db run and reports A when a.db starts again', () => {
    const root = scratch(), a = join(root, 'a.db'), b = join(root, 'b.db');
    writeFileSync(a, ''); writeFileSync(b, '');
    const runA = beginServeRun(a, lifecycle('run-a', { pid: 1001 })).lifecycle;
    markServeRunning(a, runA);
    const runB = beginServeRun(b, lifecycle('run-b', { pid: 1002 }), { isProcessAlive: () => false }).lifecycle;
    markServeRunning(b, runB);
    recordCleanExit(b, runB, { reason: 'stopped' });
    beginServeRun(a, lifecycle('run-a2', { pid: 1003 }), { isProcessAlive: () => false });
    expect(readAbnormalExit(a)).toMatchObject({ runId: 'run-a', kind: 'fatal', database: a });
  });

  it('keeps per-database lifecycles while A and B are both alive, then finds A after it is killed', () => {
    const root = scratch(), a = join(root, 'a.db'), b = join(root, 'b.db');
    writeFileSync(a, ''); writeFileSync(b, '');
    const runA = beginServeRun(a, lifecycle('run-a', { pid: 1001 })).lifecycle;
    markServeRunning(a, runA);
    const runB = beginServeRun(b, lifecycle('run-b', { pid: 1002 }), { isProcessAlive: () => true }).lifecycle;
    markServeRunning(b, runB);
    beginServeRun(a, lifecycle('run-a2', { pid: 1003 }), { isProcessAlive: pid => pid === 1002 });
    expect(readAbnormalExit(a)).toMatchObject({ runId: 'run-a', kind: 'fatal', database: a });
    expect(readAbnormalExit(b)).toBeUndefined();
  });

  it('remembers a slow-starting A killed after B became ready on the same database', () => {
    const root = scratch(), database = databaseIn(root);
    const a = beginServeRun(database, lifecycle('run-a', { pid: 1001 })).lifecycle;
    const b = beginServeRun(database, lifecycle('run-b', { pid: 1002 }), { isProcessAlive: () => true }).lifecycle;
    markServeRunning(database, b, { isProcessAlive: () => true });
    const c = beginServeRun(database, lifecycle('run-c', { pid: 1003 }), { isProcessAlive: pid => pid === 1002 });
    expect(c.previousRuns?.map(run => run.runId)).toEqual(['run-a']);
    expect(readAbnormalExit(database)).toMatchObject({ runId: 'run-a', kind: 'startup', database });
    expect(documentIn(database).lifecycle.runId).toBe('run-b');
    expect(documentIn(database).history.filter((entry: any) => entry.runId === 'run-b')).toHaveLength(0);
  });

  it('bounds lifecycleRuns and cleanExits to the latest 10 generations', () => {
    const root = scratch(), database = databaseIn(root);
    for (let index = 0; index < 12; index++) {
      const run = beginServeRun(database, lifecycle(`run-${index}`, { pid: 1000 + index }), { isProcessAlive: () => true }).lifecycle;
      recordCleanExit(database, run, { reason: 'stopped' });
    }
    const document = documentIn(database);
    expect(document.lifecycleRuns).toHaveLength(10);
    expect(document.cleanExits).toHaveLength(10);
    expect(document.lifecycleRuns.some((entry: any) => entry.runId === 'run-0')).toBe(false);
    expect(document.cleanExits.some((entry: any) => entry.runId === 'run-11')).toBe(true);
  });

  it('publishes B when slow-starting A is still alive, and accepts A late clean without a later false abnormal', () => {
    const root = scratch(), database = databaseIn(root);
    const a = beginServeRun(database, lifecycle('run-a', { pid: 1001 })).lifecycle;
    const b = beginServeRun(database, lifecycle('run-b', { pid: 1002 }), { isProcessAlive: () => true }).lifecycle;
    const published = markServeRunning(database, b, { isProcessAlive: () => true });
    expect(published.lifecycle).toMatchObject({ runId: 'run-b', phase: 'running' });
    expect(documentIn(database).lifecycle.runId).toBe('run-b');
    recordCleanExit(database, a, { reason: 'stopped' });
    expect(documentIn(database).cleanExits?.find((entry: any) => entry.runId === 'run-a')).toMatchObject({ runId: 'run-a', database });
    recordCleanExit(database, b, { reason: 'stopped' });
    beginServeRun(database, lifecycle('run-c', { pid: 1003 }), { isProcessAlive: () => false });
    expect(readAbnormalExit(database)).toBeUndefined();
  });

  it('clears optional metadata from the previous abnormal before writing a plain startup error', () => {
    const root = scratch(), database = databaseIn(root), previous = lifecycle('sigkill-run');
    recordAbnormalExit(database, { kind: 'fatal', exitCode: 1, error: 'killed', version: '1', lifecycle: previous, signal: 'SIGKILL', source: 'systemd-journal' });
    recordAbnormalExit(database, { kind: 'startup', exitCode: 1, error: 'plain config error', version: '1' });
    const document = documentIn(database);
    expect(document).toMatchObject({ kind: 'startup', error: 'plain config error' });
    expect(document.runId).toBeUndefined();
    expect(document.signal).toBeUndefined();
    expect(document.source).toBeUndefined();
    expect(document.history[0]).toMatchObject({ runId: 'sigkill-run', signal: 'SIGKILL' });
  });
});

describe('bounded systemd journal enrichment', () => {
  const exitEntry = (run: ServeRunLifecycle, override: Record<string, unknown> = {}) => ({
    _SYSTEMD_UNIT: run.unit, _BOOT_ID: run.boot, MAIN_PID: String(run.pid), EXIT_CODE: 'killed', EXIT_STATUS: '9',
    __REALTIME_TIMESTAMP: String((Date.parse(run.startedAt) + 5_000) * 1_000), ...override
  });
  function interrupted() {
    const root = scratch(), database = databaseIn(root), previous = beginServeRun(database, lifecycle('killed-run')).lifecycle;
    markServeRunning(database, previous);
    beginServeRun(database, lifecycle('current-run'), { isProcessAlive: () => false });
    return { database, previous };
  }

  it('enriches only an exactly aligned SIGKILL and keeps the old top-level kind', async () => {
    const { database, previous } = interrupted();
    await enrichAbnormalExitFromJournal(database, previous, { queryJournal: async request => {
      expect(request).toMatchObject({ unit: previous.unit, boot: previous.boot, pid: previous.pid, startedAt: previous.startedAt });
      return [exitEntry(previous)];
    } });
    const record = readAbnormalExit(database);
    expect(record).toMatchObject({ kind: 'fatal', exitCode: 1, runId: 'killed-run', signal: 'SIGKILL', source: 'systemd-journal', at: '2026-11-13T00:00:05.000Z' });
    expect(abnormalExitNote(record, { running: true, ready: true, startedAt: '2026-11-13T00:01:00.000Z' }, new Date('2026-11-13T00:02:00.000Z'))).toContain('SIGKILL');
    expect(documentIn(database).history.filter((entry: any) => entry.runId === previous.runId)).toHaveLength(1);
  });

  it.each([
    ['01234567-89ab-cdef-8123-456789abcdef', '0123456789abcdef8123456789abcdef'],
    ['0123456789abcdef8123456789abcdef', '01234567-89ab-cdef-8123-456789abcdef']
  ])('normalizes persisted and journal boot IDs (%s vs %s)', async (persistedBoot, journalBoot) => {
    const root = scratch(), database = databaseIn(root), previous = beginServeRun(database, lifecycle('killed-run', { boot: persistedBoot })).lifecycle;
    markServeRunning(database, previous);
    beginServeRun(database, lifecycle('current-run', { boot: persistedBoot }), { isProcessAlive: () => false });
    await enrichAbnormalExitFromJournal(database, previous, { queryJournal: async () => [exitEntry(previous, { _BOOT_ID: journalBoot })] });
    expect(readAbnormalExit(database)).toMatchObject({ signal: 'SIGKILL', source: 'systemd-journal' });
  });

  it('accepts the user-unit journal field even when UNIT names the user manager', async () => {
    const { database, previous } = interrupted();
    await enrichAbnormalExitFromJournal(database, previous, { queryJournal: async () => [{
      ...exitEntry(previous), _SYSTEMD_UNIT: undefined, _SYSTEMD_USER_UNIT: previous.unit, UNIT: 'user@1000.service'
    }] });
    expect(readAbnormalExit(database)).toMatchObject({ signal: 'SIGKILL', source: 'systemd-journal' });
  });

  it('keeps the basic record for missing, timed-out, ambiguous or misattributed journal data', async () => {
    for (const entries of [
      new Error('journal unavailable'),
      new Error('journal timeout'),
      [],
      [exitEntry(lifecycle('x'), { _SYSTEMD_UNIT: 'other.service' })],
      [exitEntry(lifecycle('x'), { _BOOT_ID: 'other-boot' })],
      [exitEntry(lifecycle('x'), { MAIN_PID: '9999' })],
      [exitEntry(lifecycle('x'), { __REALTIME_TIMESTAMP: '1' })],
      [exitEntry(lifecycle('x')), exitEntry(lifecycle('x'), { __REALTIME_TIMESTAMP: String((Date.parse('2026-11-13T00:00:00.000Z') + 6_000) * 1_000) })]
    ]) {
      const { database, previous } = interrupted();
      await enrichAbnormalExitFromJournal(database, previous, { queryJournal: async () => { if (entries instanceof Error) throw entries; return entries; } });
      expect(readAbnormalExit(database)).toMatchObject({ runId: previous.runId, source: 'lifecycle', error: expect.stringContaining('pending journal enrichment') });
      expect(readAbnormalExit(database)?.signal).toBeUndefined();
    }
  });

  it('does not enrich a generation after its late clean marker arrives', async () => {
    const { database, previous } = interrupted();
    recordCleanExit(database, previous, { reason: 'stopped' });
    await enrichAbnormalExitFromJournal(database, previous, { queryJournal: async () => [exitEntry(previous)] });
    expect(readAbnormalExit(database)).toMatchObject({ runId: previous.runId, source: 'lifecycle' });
    expect(readAbnormalExit(database)?.signal).toBeUndefined();
  });

  it('scopes journal enrichment to the canonical database even when two records share runId', async () => {
    const root = scratch(), a = join(root, 'a.db'), b = join(root, 'b.db');
    writeFileSync(a, ''); writeFileSync(b, '');
    const runA = lifecycle('shared-run', { database: a, pid: 1001 });
    const runB = lifecycle('shared-run', { database: b, pid: 1002 });
    const record = (database: string, run: ServeRunLifecycle, error: string): AbnormalExitRecord => ({
      at: run.startedAt, kind: 'fatal', exitCode: 1, error, version: '1', database,
      runId: run.runId, pid: run.pid, startedAt: run.startedAt, unit: run.unit, boot: run.boot, phase: run.phase
    });
    const recordA = record(a, runA, 'A pending'), recordB = record(b, runB, 'B pending');
    writeFileSync(join(root, abnormalExitFileName), JSON.stringify({ ...recordB, history: [recordA, recordB], lifecycle: runB, lifecycleRuns: [runA, runB] }));
    let wrongDatabaseQueries = 0;
    await enrichAbnormalExitFromJournal(b, runA, { queryJournal: async () => { wrongDatabaseQueries++; return []; } });
    await enrichAbnormalExitFromJournal(a, runA, { queryJournal: async () => [exitEntry(runA)] });
    const document = documentIn(a);
    expect(document.history.find((entry: any) => entry.database === a)).toMatchObject({ signal: 'SIGKILL', source: 'systemd-journal' });
    expect(document.history.find((entry: any) => entry.database === b)).toMatchObject({ error: 'B pending' });
    expect(document.history.find((entry: any) => entry.database === b).signal).toBeUndefined();
    expect(document).toMatchObject({ database: b, error: 'B pending' });
    expect(document.signal).toBeUndefined();
    expect(wrongDatabaseQueries).toBe(0);
  });

  it('does not expand a dead generation journal window when a later generation reuses its PID', async () => {
    const root = scratch(), database = databaseIn(root);
    const started = beginServeRun(database, lifecycle('run-a', { pid: 1001, startedAt: '2026-11-13T00:00:00.000Z' }));
    const a = markServeRunning(database, started.lifecycle).lifecycle;
    recordAbnormalExit(database, { kind: 'fatal', exitCode: 1, error: 'A original error', version: '1', lifecycle: a, now: new Date('2026-11-13T00:00:30.000Z') });
    const discovered = beginServeRun(database, {
      ...lifecycle('run-b', { pid: 1002, startedAt: '2026-11-13T00:01:00.000Z' }), now: new Date('2026-11-13T00:01:00.000Z')
    }, { isProcessAlive: () => false });
    const firstA = discovered.previousRuns?.find(run => run.runId === 'run-a')!;
    expect(firstA.journalUntil).toBe('2026-11-13T00:01:00.000Z');
    const c = lifecycle('run-c', { pid: 1001, startedAt: '2026-11-13T02:00:00.000Z' });
    const cExit = exitEntry(c, { __REALTIME_TIMESTAMP: String(Date.parse('2026-11-13T02:01:00.000Z') * 1_000) });
    const upperBounds: string[] = [];
    await enrichAbnormalExitFromJournal(database, firstA, {
      now: new Date('2026-11-13T02:02:00.000Z'),
      queryJournal: async request => { upperBounds.push(request.until); return [cExit]; }
    });
    const rediscovered = beginServeRun(database, {
      ...lifecycle('run-d', { pid: 1003, startedAt: '2026-11-13T02:03:00.000Z' }), now: new Date('2026-11-13T02:03:00.000Z')
    }, { isProcessAlive: pid => pid === 1002 });
    const secondA = rediscovered.previousRuns?.find(run => run.runId === 'run-a')!;
    expect(secondA.journalUntil).toBe('2026-11-13T00:01:00.000Z');
    await enrichAbnormalExitFromJournal(database, secondA, {
      now: new Date('2026-11-13T03:02:00.000Z'),
      queryJournal: async request => { upperBounds.push(request.until); return [cExit]; }
    });
    expect(readAbnormalExit(database)).toMatchObject({ runId: 'run-a', at: '2026-11-13T00:00:30.000Z', error: 'A original error' });
    expect(readAbnormalExit(database)?.signal).toBeUndefined();
    expect(upperBounds).toEqual(['2026-11-13T00:01:00.000Z', '2026-11-13T00:01:00.000Z']);
    expect(firstA.journalUntil).toBe('2026-11-13T00:01:00.000Z');
    expect(secondA.journalUntil).toBe('2026-11-13T00:01:00.000Z');
  });

  it('fixes a legacy lifecycle bound on first enrichment and still accepts SIGKILL inside that window', async () => {
    const root = scratch(), database = databaseIn(root);
    const previous = lifecycle('legacy-run', { database, startedAt: '2026-11-13T00:00:00.000Z' });
    recordAbnormalExit(database, { kind: 'fatal', exitCode: 1, error: 'legacy pending', version: '1', lifecycle: previous, now: new Date('2026-11-13T00:00:30.000Z') });
    const legacyDocument = documentIn(database);
    legacyDocument.lifecycle = previous;
    legacyDocument.lifecycleRuns = [previous];
    writeFileSync(join(root, abnormalExitFileName), JSON.stringify(legacyDocument));
    const upperBounds: string[] = [];
    await enrichAbnormalExitFromJournal(database, previous, {
      now: new Date('2026-11-13T00:01:00.000Z'),
      queryJournal: async request => { upperBounds.push(request.until); return [exitEntry(previous, { __REALTIME_TIMESTAMP: String(Date.parse('2026-11-13T00:00:45.000Z') * 1_000) })]; }
    });
    expect(readAbnormalExit(database)).toMatchObject({ runId: 'legacy-run', at: '2026-11-13T00:00:45.000Z', signal: 'SIGKILL', source: 'systemd-journal' });
    expect(upperBounds).toEqual(['2026-11-13T00:01:00.000Z']);
    expect(documentIn(database).lifecycleRuns.find((run: any) => run.runId === 'legacy-run').journalUntil).toBe('2026-11-13T00:01:00.000Z');
    await enrichAbnormalExitFromJournal(database, previous, {
      now: new Date('2026-11-13T02:02:00.000Z'),
      queryJournal: async request => { upperBounds.push(request.until); return []; }
    });
    expect(upperBounds).toEqual(['2026-11-13T00:01:00.000Z', '2026-11-13T00:01:00.000Z']);
  });

  it('a late result enriches its own history entry without replacing a newer top-level abnormal', async () => {
    const { database, previous } = interrupted();
    let release!: (entries: Array<Record<string, unknown>>) => void;
    const query = new Promise<Array<Record<string, unknown>>>(resolve => { release = resolve; });
    const pending = enrichAbnormalExitFromJournal(database, previous, { queryJournal: () => query });
    recordAbnormalExit(database, { kind: 'startup', exitCode: 1, error: 'newer failure', version: '2', lifecycle: lifecycle('newer-run') });
    release([exitEntry(previous)]);
    await pending;
    const document = documentIn(database);
    expect(document).toMatchObject({ runId: 'newer-run', error: 'newer failure', kind: 'startup' });
    expect(document.signal).toBeUndefined();
    expect(document.history.find((entry: any) => entry.runId === previous.runId)).toMatchObject({ signal: 'SIGKILL', source: 'systemd-journal' });
  });
});

describe('abnormalExitNote', () => {
  const now = new Date('2026-11-08T12:00:00.000Z');
  const record = { at: '2026-11-08T09:00:00.000Z', kind: 'startup' as const, exitCode: 1, error: 'DUTYDECK_AGENTS_JSON is invalid', version: '1', database: '/srv/.dutydeck/dutydeck.db' };
  it('says recovered only when the running instance is ready and started after the exit', () => {
    expect(abnormalExitNote(record, { running: true, ready: true, startedAt: '2026-11-08T09:00:05.000Z' }, now)).toBe('3 小时前异常退出（启动失败：DUTYDECK_AGENTS_JSON is invalid），已自动恢复');
    for (const daemon of [{ running: true, ready: false, startedAt: '2026-11-08T09:00:05.000Z' }, { running: true, ready: true, startedAt: '2026-11-08T08:00:00.000Z' }, { running: true, ready: true }, { running: false }]) {
      expect(abnormalExitNote(record, daemon, now)).toBe('3 小时前异常退出（启动失败：DUTYDECK_AGENTS_JSON is invalid），详情看 journalctl');
    }
    expect(abnormalExitNote({ ...record, kind: 'fatal', at: '2026-11-08T11:30:00.000Z' }, { running: false }, now)).toBe('30 分钟前异常退出（运行中崩溃：DUTYDECK_AGENTS_JSON is invalid），详情看 journalctl');
  });
  it('says nothing for missing, future or older-than-7-day records', () => {
    expect(abnormalExitNote(undefined, { running: true }, now)).toBeUndefined();
    expect(abnormalExitNote({ ...record, at: '2026-11-01T11:59:00.000Z' }, { running: true }, now)).toBeUndefined();
    expect(abnormalExitNote({ ...record, at: '2026-11-08T12:30:00.000Z' }, { running: true }, now)).toBeUndefined();
  });
});
