import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigRepository, VerificationRecord } from '@dutydeck/shared';

// Count content reads so tests can tell a full fingerprint from a cache hit.
const reads = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (async (...args: Parameters<typeof actual.readFile>) => {
    reads.paths.push(String(args[0]));
    return actual.readFile(...args);
  }) as typeof actual.readFile };
});

const { cachedRepositoryFingerprint, repositoryFingerprint, VerificationManager } = await import('./verification.js');

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
  reads.paths.length = 0;
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-fp-cache-'));
  cleanup.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Dutydeck Test');
  writeFileSync(join(root, 'tracked.txt'), 'baseline\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  return root;
}

function memoryConfig(entries: Record<string, string> = {}): ConfigRepository {
  const values = new Map(Object.entries(entries));
  return {
    get: async key => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }))
  } as ConfigRepository;
}

const contentReads = (root: string) => reads.paths.filter(path => path.startsWith(root)).length;
// Freshly written files are racily recent and never cached; let them age out.
const ageFiles = () => new Promise(resolve => setTimeout(resolve, 2_100));

describe('verification list fingerprint cost', () => {
  it('returns an empty list without fingerprinting the repository', async () => {
    const root = repository();
    const manager = new VerificationManager(memoryConfig());
    expect(await manager.list('ses_empty', root)).toEqual([]);
    expect(contentReads(root)).toBe(0);
  });

  it('shares one computation across concurrent lists and reuses it until the repository changes', async () => {
    const root = repository();
    await ageFiles();
    const fingerprint = await repositoryFingerprint(root);
    const record: VerificationRecord = {
      schemaVersion: 1, revision: 2, id: 'verification_1', sessionId: 'ses_1', command: 'true', cwd: root, status: 'passed',
      startedAt: '2026-11-06T00:00:00.000Z', completedAt: '2026-11-06T00:00:01.000Z', output: '', outputTruncated: false,
      exitCode: 0, beforeFingerprint: fingerprint, afterFingerprint: fingerprint
    };
    const manager = new VerificationManager(memoryConfig({ 'runtime_verification:ses_1:verification_1': JSON.stringify(record) }));
    reads.paths.length = 0;

    const [first, second] = await Promise.all([manager.list('ses_1', root), manager.list('ses_1', root)]);
    expect(first[0]).toMatchObject({ stale: false });
    expect(second[0]).toMatchObject({ stale: false });
    expect(contentReads(root)).toBe(1);

    expect((await manager.list('ses_1', root))[0]).toMatchObject({ stale: false });
    expect(contentReads(root)).toBe(1);

    // Same size, same path list, same porcelain status class: only stat/content differ.
    writeFileSync(join(root, 'tracked.txt'), 'Baseline\n');
    expect((await manager.list('ses_1', root))[0]).toMatchObject({ stale: true, staleReason: 'code_changed' });
    const dirty = await cachedRepositoryFingerprint(root);
    writeFileSync(join(root, 'tracked.txt'), 'BASELINE\n');
    expect(await cachedRepositoryFingerprint(root)).not.toBe(dirty);
    writeFileSync(join(root, 'tracked.txt'), 'baseline\n');
    expect(await cachedRepositoryFingerprint(root)).toBe(fingerprint);

    writeFileSync(join(root, 'untracked.txt'), 'new\n');
    expect((await manager.list('ses_1', root))[0]).toMatchObject({ stale: true, staleReason: 'code_changed' });
    rmSync(join(root, 'untracked.txt'));
    expect(await cachedRepositoryFingerprint(root)).toBe(fingerprint);

    writeFileSync(join(root, 'tracked.txt'), 'committed\n');
    git(root, 'commit', '-qam', 'next');
    expect(await cachedRepositoryFingerprint(root)).toBe(await repositoryFingerprint(root));
    expect(await cachedRepositoryFingerprint(root)).not.toBe(fingerprint);
  }, 20_000);

  it('does not cache a result whose files changed while it was being read', async () => {
    const root = repository();
    await ageFiles();
    const original = await repositoryFingerprint(root);
    reads.paths.length = 0;
    const pending = cachedRepositoryFingerprint(root);
    // Rewrite as soon as the content read starts.
    await vi.waitFor(() => expect(contentReads(root)).toBe(1), { interval: 1 });
    writeFileSync(join(root, 'tracked.txt'), 'Baseline\n');
    await pending;
    const changed = await repositoryFingerprint(root);
    expect(changed).not.toBe(original);
    expect(await cachedRepositoryFingerprint(root)).toBe(changed);
  }, 20_000);
});
