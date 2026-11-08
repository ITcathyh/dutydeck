import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abnormalExitFileName, abnormalExitNote, readAbnormalExit, recordAbnormalExit } from './abnormal-exit.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = () => { const root = mkdtempSync(join(tmpdir(), 'dutydeck-abnormal-exit-')); roots.push(root); return root; };

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
