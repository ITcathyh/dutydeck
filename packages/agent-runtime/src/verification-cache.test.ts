import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigRepository, VerificationRecord } from '@dutydeck/shared';

// Count content reads so tests can tell a full fingerprint from a cache hit.
// A gate holds the next content read after it has read the file.
const reads = vi.hoisted(() => ({ paths: [] as string[], gate: undefined as Promise<void> | undefined, held: false }));
// Count stat calls and how many are in flight; a frozen path keeps returning one
// stat, as a filesystem whose timestamps are too coarse to see a same-size rewrite.
const stats = vi.hoisted(() => ({ paths: [] as string[], inFlight: 0, maxInFlight: 0, frozen: new Map<string, unknown>() }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      reads.paths.push(String(args[0]));
      const content = await actual.readFile(...args);
      const gate = reads.gate;
      if (gate) { reads.gate = undefined; reads.held = true; await gate; }
      return content;
    }) as typeof actual.readFile,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0]);
      stats.paths.push(path);
      if (stats.frozen.has(path) && (args[1] as { bigint?: boolean } | undefined)?.bigint) return stats.frozen.get(path);
      stats.maxInFlight = Math.max(stats.maxInFlight, ++stats.inFlight);
      try { return await actual.lstat(...args); }
      finally { stats.inFlight -= 1; }
    }) as typeof actual.lstat
  };
});

const { cachedRepositoryFingerprint, fingerprintCacheSizeForTest, repositoryFingerprint, setRacyWindowForTest, VerificationManager } = await import('./verification.js');

const cleanup: string[] = [];
beforeEach(() => setRacyWindowForTest(racyWindowMs));
afterEach(() => {
  setRacyWindowForTest();
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
  reads.paths.length = 0;
  reads.gate = undefined;
  reads.held = false;
  stats.paths.length = 0;
  stats.maxInFlight = 0;
  stats.frozen.clear();
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
const statsOf = (path: string) => stats.paths.filter(item => item === path).length;
// Freshly written files are racily recent and never cached; let them age out of a shortened window.
const racyWindowMs = 250;
const ageFiles = (windowMs = racyWindowMs) => new Promise(resolve => setTimeout(resolve, windowMs + 50));

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

  it('forgets a cached directory once it can no longer be scanned', async () => {
    const root = repository();
    await ageFiles();
    const before = fingerprintCacheSizeForTest();
    await cachedRepositoryFingerprint(root);
    expect(fingerprintCacheSizeForTest()).toBe(before + 1);
    rmSync(root, { recursive: true, force: true });
    await expect(cachedRepositoryFingerprint(root)).rejects.toThrow();
    expect(fingerprintCacheSizeForTest()).toBe(before);
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

  it('stats each entry once per call when the cache misses, racy or not', async () => {
    // Long enough that two sequential scans of the rewritten file both stay inside it under load.
    const windowMs = 1_000;
    setRacyWindowForTest(windowMs);
    const root = repository();
    const tracked = join(realpathSync(root), 'tracked.txt');
    await ageFiles(windowMs);
    await cachedRepositoryFingerprint(root);

    // Turn end: the agent has just written a file, so the stat is racily recent.
    writeFileSync(tracked, 'Baseline\n');
    stats.paths.length = 0;
    reads.paths.length = 0;
    const first = await cachedRepositoryFingerprint(root);
    const second = await cachedRepositoryFingerprint(root);
    expect(statsOf(tracked)).toBe(2);
    expect(contentReads(root)).toBe(2);
    expect(first).toBe(second);

    // Settled change: one walk produces both the cache key and the content.
    await ageFiles(windowMs);
    writeFileSync(tracked, 'BASELINE\n');
    await ageFiles(windowMs);
    stats.paths.length = 0;
    const settled = await cachedRepositoryFingerprint(root);
    expect(statsOf(tracked)).toBe(1);
    expect(settled).toBe(await repositoryFingerprint(root));
    expect(settled).not.toBe(first);
  }, 20_000);

  it('stats a large tree with bounded concurrency', async () => {
    const root = repository();
    for (let index = 0; index < 300; index += 1) writeFileSync(join(root, `file-${index}.txt`), `${index}\n`);
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'many');
    await cachedRepositoryFingerprint(root);
    expect(stats.maxInFlight).toBeGreaterThan(1);
    expect(stats.maxInFlight).toBeLessThanOrEqual(16);
  }, 20_000);

  it('does not hand a later caller a racy computation that read content before it started', async () => {
    const root = repository();
    const tracked = join(realpathSync(root), 'tracked.txt');
    writeFileSync(tracked, 'first-one\n');
    stats.frozen.set(tracked, lstatSync(tracked, { bigint: true }));
    let release!: () => void;
    reads.gate = new Promise<void>(resolve => { release = resolve; });
    const earlier = cachedRepositoryFingerprint(root);
    await vi.waitFor(() => expect(reads.held).toBe(true), { interval: 1 });

    // Same size, and the frozen stat makes the rewrite invisible to the stamp.
    writeFileSync(tracked, 'other-one\n');
    const later = cachedRepositoryFingerprint(root);
    await new Promise(resolve => setTimeout(resolve, 200));
    release();
    const [before, after] = await Promise.all([earlier, later]);
    const current = await repositoryFingerprint(root);
    expect(after).toBe(current);
    expect(before).not.toBe(current);
  }, 20_000);
});
