import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAssetDirectory, resolveSessionInsightEngine } from './session-insight-engine.js';
import { SESSION_INSIGHT_ENGINE_VERSIONS } from './session-insight-analyzer.js';

describe('session insight Node locator', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'insight-locator-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  function writeEngine(source: string) {
    // A JS entrypoint needs read permission, never an executable bit or shebang.
    writeFileSync(join(tempDir, 'cli.js'), source, { mode: 0o600 });
  }

  const counterPath = () => join(tempDir, 'handshake-count');
  const counted = (source: string) => `require('node:fs').appendFileSync(${JSON.stringify(counterPath())}, '1\\n');\n${source}`;
  const validEngineSource = (versions = SESSION_INSIGHT_ENGINE_VERSIONS) => counted(`process.stdout.write(${JSON.stringify(JSON.stringify(versions))});`);
  const handshakeCount = () => existsSync(counterPath()) ? readFileSync(counterPath(), 'utf8').trim().split('\n').filter(Boolean).length : 0;

  it('resolves module-relative assets independently of the current directory', () => {
    expect(resolveAssetDirectory(tempDir)).toBe(tempDir);
    expect(resolveAssetDirectory()).toContain('assets/session-insight');
  });

  it('executes the actual development entrypoint with an explicit tsx loader on every call', async () => {
    for (let index = 0; index < 2; index++) {
      const result = await resolveSessionInsightEngine();
      expect(result.status).toBe('available');
      if (result.status === 'available') {
        expect(result.entrypoint).toMatch(/session-insight-cli\.ts$/);
        expect(result.execArgv[0]).toBe('--conditions=development');
        expect(result.execArgv[1]).toBe('--import');
        expect(result.execArgv[2]).toMatch(/^file:/);
        expect(result.versions).toEqual(SESSION_INSIGHT_ENGINE_VERSIONS);
      }
    }
  });

  it('returns a safe error for missing or directory entrypoints without source fallback', async () => {
    const missing = await resolveSessionInsightEngine({ assetsDir: tempDir });
    expect(missing).toMatchObject({ status: 'unavailable', code: 'ENGINE_NOT_FOUND' });
    expect(JSON.stringify(missing)).not.toContain(tempDir);
    mkdirSync(join(tempDir, 'cli.js'));
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir }))
      .toMatchObject({ status: 'unavailable', code: 'ENGINE_NOT_FOUND' });
  });

  it('uses the current Node runtime with empty PATH and excludes credentials and NODE_OPTIONS', async () => {
    const oldToken = process.env.INSIGHT_SECRET_CANARY;
    const oldOptions = process.env.NODE_OPTIONS;
    process.env.INSIGHT_SECRET_CANARY = 'PRIVATE';
    process.env.NODE_OPTIONS = '--require=/PRIVATE_CANARY';
    writeEngine(`if (process.env.PATH || process.env.INSIGHT_SECRET_CANARY || process.env.NODE_OPTIONS) process.exit(1);
process.stdout.write(${JSON.stringify(JSON.stringify(SESSION_INSIGHT_ENGINE_VERSIONS))});`);
    try {
      expect(await resolveSessionInsightEngine({ assetsDir: tempDir }))
        .toMatchObject({ status: 'available', entrypoint: join(tempDir, 'cli.js'), execArgv: [] });
    } finally {
      if (oldToken === undefined) delete process.env.INSIGHT_SECRET_CANARY;
      else process.env.INSIGHT_SECRET_CANARY = oldToken;
      if (oldOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = oldOptions;
    }
  });

  it('rejects corrupt, oversized and mismatched handshakes without leaking stderr', async () => {
    for (const source of [
      "process.stderr.write('SECRET_CANARY'); process.exit(1)",
      "process.stdout.write('not json')",
      "process.stdout.write('x'.repeat(70 * 1024))"
    ]) {
      writeEngine(source);
      const result = await resolveSessionInsightEngine({ assetsDir: tempDir });
      expect(result).toMatchObject({ status: 'unavailable', code: 'HANDSHAKE_FAILED' });
      expect(JSON.stringify(result)).not.toContain('SECRET_CANARY');
    }
    writeEngine(`process.stdout.write(${JSON.stringify(JSON.stringify({ ...SESSION_INSIGHT_ENGINE_VERSIONS, engineVersion: 'other' }))});`);
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir }))
      .toMatchObject({ status: 'unavailable', code: 'VERSION_MISMATCH' });
  });

  it('kills hung version processes even when they ignore SIGTERM, then waits for close', async () => {
    const pidPath = join(tempDir, 'child.pid');
    writeEngine(`require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on('SIGTERM', () => {}); setInterval(() => {}, 10000);`);
    const started = Date.now();
    const result = await resolveSessionInsightEngine({ assetsDir: tempDir, handshakeTimeoutMs: 200 });
    expect(result).toMatchObject({ status: 'unavailable', code: 'HANDSHAKE_FAILED' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(170);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(existsSync(pidPath)).toBe(true);
    const pid = Number(readFileSync(pidPath, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reuses one available handshake serially and keeps a single independent cache slot', async () => {
    writeEngine(validEngineSource());
    for (let index = 0; index < 6; index++) {
      expect(await resolveSessionInsightEngine({ assetsDir: tempDir })).toMatchObject({ status: 'available' });
    }
    expect(handshakeCount()).toBe(1);

    const other = join(tempDir, 'other');
    mkdirSync(other);
    copyFileSync(join(tempDir, 'cli.js'), join(other, 'cli.js'));
    await resolveSessionInsightEngine({ assetsDir: other });
    await resolveSessionInsightEngine({ assetsDir: other });
    expect(handshakeCount()).toBe(2);
    // A separate absolute entrypoint owns the slot; returning to the first scope relocates it.
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir })).toMatchObject({ status: 'available' });
    expect(handshakeCount()).toBe(3);
  });

  it('single-flights concurrent cold lookups and reuses their available result', async () => {
    writeEngine(counted(`setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(SESSION_INSIGHT_ENGINE_VERSIONS))}), 75);`));
    const results = await Promise.all(Array.from({ length: 12 }, () => resolveSessionInsightEngine({ assetsDir: tempDir })));
    expect(results.every(result => result.status === 'available')).toBe(true);
    expect(handshakeCount()).toBe(1);
    await Promise.all(Array.from({ length: 12 }, () => resolveSessionInsightEngine({ assetsDir: tempDir })));
    expect(handshakeCount()).toBe(1);
  });

  it('separates pending handshakes by timeout while sharing the available cache across timeouts', async () => {
    writeEngine(counted(`setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(SESSION_INSIGHT_ENGINE_VERSIONS))}), 200);`));
    const first = resolveSessionInsightEngine({ assetsDir: tempDir, handshakeTimeoutMs: 1000 });
    await vi.waitFor(() => expect(handshakeCount()).toBe(1));
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir, handshakeTimeoutMs: 30 }))
      .toMatchObject({ status: 'unavailable', code: 'HANDSHAKE_FAILED' });
    expect(await first).toMatchObject({ status: 'available' });
    const completedHandshakes = handshakeCount();
    // A successful entry is independent of timeout; only concurrent cold work needs separate timeout ownership.
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir, handshakeTimeoutMs: 10 }))
      .toMatchObject({ status: 'available' });
    expect(handshakeCount()).toBe(completedHandshakes);
  });

  it.each([
    { kind: 'missing', code: 'ENGINE_NOT_FOUND' },
    { kind: 'nonJSON', code: 'HANDSHAKE_FAILED' },
    { kind: 'timeout', code: 'HANDSHAKE_FAILED' },
    { kind: 'mismatch', code: 'VERSION_MISMATCH' }
  ] as const)('retries $kind after repair without caching the failure', async ({ kind, code }) => {
    if (kind !== 'missing') {
      if (kind === 'nonJSON') writeEngine(counted("process.stdout.write('not json');"));
      if (kind === 'timeout') writeEngine(counted('setInterval(() => {}, 10000);'));
      if (kind === 'mismatch') writeEngine(validEngineSource({ ...SESSION_INSIGHT_ENGINE_VERSIONS, engineVersion: 'other' }));
      expect(await resolveSessionInsightEngine({ assetsDir: tempDir, handshakeTimeoutMs: kind === 'timeout' ? 150 : 3000 }))
        .toMatchObject({ status: 'unavailable', code });
    } else {
      expect(await resolveSessionInsightEngine({ assetsDir: tempDir })).toMatchObject({ status: 'unavailable', code });
    }
    const beforeRepair = handshakeCount();
    writeEngine(validEngineSource());
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir })).toMatchObject({ status: 'available' });
    expect(handshakeCount()).toBe(beforeRepair + 1);
    await resolveSessionInsightEngine({ assetsDir: tempDir });
    expect(handshakeCount()).toBe(beforeRepair + 1);
  });

  it.each(['rewrite', 'delete', 'rename', 'symlink'] as const)('relocates after %s instead of returning stale available state', async change => {
    const entrypoint = join(tempDir, 'cli.js');
    const firstTarget = join(tempDir, 'first.js');
    if (change === 'symlink') {
      writeFileSync(firstTarget, validEngineSource());
      symlinkSync(firstTarget, entrypoint);
    } else writeEngine(validEngineSource());
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir })).toMatchObject({ status: 'available' });
    expect(handshakeCount()).toBe(1);

    const renamed = join(tempDir, 'renamed.js');
    const secondTarget = join(tempDir, 'second.js');
    if (change === 'rewrite') writeEngine(counted("process.stdout.write('not json');"));
    if (change === 'delete') rmSync(entrypoint);
    if (change === 'rename') renameSync(entrypoint, renamed);
    if (change === 'symlink') {
      writeFileSync(secondTarget, counted("process.stdout.write('not json');"));
      rmSync(entrypoint);
      symlinkSync(secondTarget, entrypoint);
    }
    const missing = change === 'delete' || change === 'rename';
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir })).toMatchObject({
      status: 'unavailable', code: missing ? 'ENGINE_NOT_FOUND' : 'HANDSHAKE_FAILED'
    });
    expect(handshakeCount()).toBe(missing ? 1 : 2);

    if (change === 'rename') renameSync(renamed, entrypoint);
    else if (change === 'symlink') writeFileSync(secondTarget, validEngineSource());
    else writeEngine(validEngineSource());
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir })).toMatchObject({ status: 'available' });
    expect(handshakeCount()).toBe(missing ? 2 : 3);
    await resolveSessionInsightEngine({ assetsDir: tempDir });
    expect(handshakeCount()).toBe(missing ? 2 : 3);
  });

  it('invalidates a symlink retarget even when the new target has identical content', async () => {
    const entrypoint = join(tempDir, 'cli.js');
    const first = join(tempDir, 'first.js'), second = join(tempDir, 'second.js');
    writeFileSync(first, validEngineSource());
    writeFileSync(second, validEngineSource());
    symlinkSync(first, entrypoint);
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir })).toMatchObject({ status: 'available' });
    expect(handshakeCount()).toBe(1);
    rmSync(entrypoint);
    symlinkSync(second, entrypoint);
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir })).toMatchObject({ status: 'available' });
    expect(handshakeCount()).toBe(2);
    await resolveSessionInsightEngine({ assetsDir: tempDir });
    expect(handshakeCount()).toBe(2);
  });

  it('does not cache an available handshake whose entrypoint changed while the child was running', async () => {
    writeEngine(counted(`setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(SESSION_INSIGHT_ENGINE_VERSIONS))}), 150);`));
    const pending = resolveSessionInsightEngine({ assetsDir: tempDir });
    await vi.waitFor(() => expect(handshakeCount()).toBe(1));
    writeEngine(counted("process.stdout.write('not json');"));
    expect(await pending).toMatchObject({ status: 'available' });
    expect(await resolveSessionInsightEngine({ assetsDir: tempDir })).toMatchObject({ status: 'unavailable', code: 'HANDSHAKE_FAILED' });
    expect(handshakeCount()).toBe(2);
  });
});
