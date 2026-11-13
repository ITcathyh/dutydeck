import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
    recordCleanExit(database, first, { reason: 'stopped' });
    expect(documentIn(database)['clean-exit']).toBeUndefined();
    const third = beginServeRun(database, lifecycle('run-3'), { isProcessAlive: () => false });
    expect(third.previousRun?.runId).toBe('run-2');
    expect(readAbnormalExit(database)).toMatchObject({ runId: 'run-2', kind: 'startup', phase: 'starting' });
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

describe('bounded systemd journal enrichment', () => {
  const exitEntry = (run: ServeRunLifecycle, override: Record<string, unknown> = {}) => ({
    _SYSTEMD_UNIT: run.unit, _BOOT_ID: run.boot, MAIN_PID: String(run.pid), EXIT_CODE: 'killed', EXIT_STATUS: '9',
    __REALTIME_TIMESTAMP: String((Date.parse(run.startedAt) + 5_000) * 1_000), ...override
  });
  function interrupted() {
    const root = scratch(), database = databaseIn(root), previous = lifecycle('killed-run');
    beginServeRun(database, previous);
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
