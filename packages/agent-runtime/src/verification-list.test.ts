import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { repositoryFingerprint, VerificationManager } from './verification.js';

const calls = vi.hoisted(() => ({ execFile: 0 }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const symbol = Symbol.for('nodejs.util.promisify.custom');
  const custom = (original.execFile as unknown as Record<symbol, (...args: unknown[]) => unknown>)[symbol];
  const execFile = Object.assign((...args: Parameters<typeof original.execFile>) => { calls.execFile++; return original.execFile(...args); }, {
    [symbol]: (...args: unknown[]) => { calls.execFile++; return custom(...args); }
  });
  return { ...original, execFile };
});

it('lists no verifications without fingerprinting the repository, and still fingerprints when records exist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-verification-list-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
    writeFileSync(join(root, 'file'), 'baseline'); git('add', '.'); git('commit', '-qm', 'baseline');
    const repos = createRepositories(':memory:');
    const manager = new VerificationManager(repos.config);

    calls.execFile = 0;
    expect(await manager.list('ses_empty', root)).toEqual([]);
    expect(calls.execFile).toBe(0);

    const fingerprint = await repositoryFingerprint(root);
    const base = { schemaVersion: 1, revision: 1, sessionId: 'ses_full', command: 'true', cwd: root, output: '', outputTruncated: false, exitCode: 0 };
    await repos.config.set('runtime_verification:ses_full:ver_current', JSON.stringify({ ...base, id: 'ver_current', status: 'passed', startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:02.000Z', beforeFingerprint: fingerprint, afterFingerprint: fingerprint }));
    await repos.config.set('runtime_verification:ses_full:ver_old', JSON.stringify({ ...base, id: 'ver_old', status: 'passed', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:00.500Z', beforeFingerprint: 'other', afterFingerprint: 'other' }));
    calls.execFile = 0;
    const listed = await manager.list('ses_full', root);
    expect(calls.execFile).toBeGreaterThan(0);
    expect(listed.map(item => [item.id, item.stale, item.staleReason])).toEqual([['ver_current', false, undefined], ['ver_old', true, 'code_changed']]);
    repos.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
