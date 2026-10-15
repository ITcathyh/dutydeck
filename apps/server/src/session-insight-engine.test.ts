import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('resolves module-relative assets independently of the current directory', () => {
    expect(resolveAssetDirectory(tempDir)).toBe(tempDir);
    expect(resolveAssetDirectory()).toContain('assets/session-insight');
  });

  it('executes the actual development entrypoint with an explicit tsx loader', async () => {
    const result = await resolveSessionInsightEngine();
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.entrypoint).toMatch(/session-insight-cli\.ts$/);
      expect(result.execArgv[0]).toBe('--conditions=development');
      expect(result.execArgv[1]).toBe('--import');
      expect(result.execArgv[2]).toMatch(/^file:/);
      expect(result.versions).toEqual(SESSION_INSIGHT_ENGINE_VERSIONS);
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
});
