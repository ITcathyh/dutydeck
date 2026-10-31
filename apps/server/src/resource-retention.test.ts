import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneLarkResourceDirectories, rotateLogFileSync } from './resource-retention.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('resource retention', () => {
  it('rotates oversized append logs and keeps bounded backups', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-log-retention-')); roots.push(root);
    const path = join(root, 'autostart-out.log');
    await writeFile(path, 'current');
    expect(rotateLogFileSync(path, 1, 2)).toBe(true);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('current');
    expect(() => statSync(path)).toThrow();
    expect(rotateLogFileSync(path, 1, 2)).toBe(false);
  });

  it('drops the oldest backup instead of growing an unbounded suffix chain', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-log-retention-chain-')); roots.push(root);
    const path = join(root, 'autostart-out.log');
    for (const value of ['one', 'two', 'three', 'four']) {
      await writeFile(path, value);
      expect(rotateLogFileSync(path, 1, 2)).toBe(true);
    }
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('four');
    expect(readFileSync(`${path}.2`, 'utf8')).toBe('three');
    expect(existsSync(`${path}.3`)).toBe(false);
  });

  it('removes expired attachment directories but preserves recent downloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-resource-retention-')); roots.push(root);
    const old = join(root, 'old-message');
    const recent = join(root, 'recent-message');
    await mkdir(old); await mkdir(recent);
    await writeFile(join(old, 'attachment.txt'), 'old');
    await writeFile(join(recent, 'attachment.txt'), 'recent');
    const now = Date.now();
    await utimes(old, new Date(now - 10_000), new Date(now - 10_000));
    await utimes(recent, new Date(now), new Date(now));
    expect(await pruneLarkResourceDirectories(root, { now, ttlMs: 1_000, readProtectedDirectories: async () => new Set() })).toBe(1);
    expect(() => statSync(join(old, 'attachment.txt'))).toThrow();
    expect(readFileSync(join(recent, 'attachment.txt'), 'utf8')).toBe('recent');
  });
});
