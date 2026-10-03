import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveAssetDirectory,
  resolvePlatformArch,
  resolveSessionInsightEngine,
  type EngineVersionInfo
} from './session-insight-engine.js';

describe('session-insight-engine locator', () => {
  let tempDir: string;
  const valid40Commit = 'a1b2c3d4e5f678901234567890abcdef12345678';

  beforeEach(() => {
    tempDir = join(tmpdir(), `test-engine-locator-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function sha256(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex');
  }

  function makeValidManifest(options: {
    engineCommit?: string;
    engineVersion?: string;
    parserVersion?: string;
    metricVersion?: string;
    targets?: Record<string, { path: string; sha256: string }>;
  } = {}) {
    const commit = options.engineCommit ?? valid40Commit;
    return {
      schemaVersion: 1,
      name: 'session-insight-engine',
      engineCommit: commit,
      versions: {
        schemaVersion: 1,
        engineVersion: options.engineVersion ?? commit,
        parserVersion: options.parserVersion ?? '0.1.0',
        metricVersion: options.metricVersion ?? 'v1'
      },
      targets: options.targets ?? {}
    };
  }

  describe('resolvePlatformArch & resolveAssetDirectory', () => {
    it('maps node platforms and architectures to engine platform-arch keys', () => {
      expect(resolvePlatformArch('linux', 'x64')).toBe('linux-amd64');
      expect(resolvePlatformArch('linux', 'arm64')).toBe('linux-arm64');
      expect(resolvePlatformArch('darwin', 'x64')).toBe('darwin-amd64');
      expect(resolvePlatformArch('darwin', 'arm64')).toBe('darwin-arm64');
      expect(resolvePlatformArch('win32', 'x64')).toBeNull();
    });

    it('resolves explicit assetsDir if provided, or default module-relative assets without fallback guessing', () => {
      const explicit = resolveAssetDirectory(tempDir);
      expect(explicit).toBe(tempDir);

      const defaultDir = resolveAssetDirectory();
      expect(defaultDir).toContain('assets/session-insight');
    });
  });

  describe('strict manifest schema validation', () => {
    it('rejects manifest without 40-character hex engineCommit', async () => {
      const manifest = {
        schemaVersion: 1,
        engineCommit: 'PENDING_CONTROLLER_PIN', // Not 40-hex!
        versions: {
          schemaVersion: 1,
          engineVersion: 'PENDING_CONTROLLER_PIN',
          parserVersion: '0.1.0',
          metricVersion: 'v1'
        },
        targets: {}
      };
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest));

      const res = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: tempDir
      });

      expect(res.status).toBe('unavailable');
      expect(res.code).toBe('MANIFEST_CORRUPT');
    });

    it('rejects manifest where engineVersion does not match engineCommit', async () => {
      const manifest = makeValidManifest({
        engineCommit: valid40Commit,
        engineVersion: '0.1.0' // Mismatched!
      });
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest));

      const res = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: tempDir
      });

      expect(res.status).toBe('unavailable');
      expect(res.code).toBe('MANIFEST_CORRUPT');
    });
  });

  describe('safe error handling & security checks (no path/stderr leakage)', () => {
    it('returns safe unavailable on missing asset directory', async () => {
      const res = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: join(tempDir, 'missing-assets')
      });
      expect(res.status).toBe('unavailable');
      expect(res.code).toBe('ENGINE_NOT_FOUND');
      expect(res.reason).not.toContain(tempDir);
    });

    it('returns safe unavailable on missing manifest', async () => {
      const res = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: tempDir
      });
      expect(res.status).toBe('unavailable');
      expect(res.code).toBe('MANIFEST_NOT_FOUND');
    });

    it('rejects target path with lexical directory traversal', async () => {
      const manifest = makeValidManifest({
        targets: {
          'linux-amd64': { path: '../escape/session-insight', sha256: 'a'.repeat(64) }
        }
      });
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest));

      const res = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: tempDir
      });

      expect(res.status).toBe('unavailable');
      expect(res.code).toBe('MANIFEST_CORRUPT');
      expect(res.reason).not.toContain('escape');
    });

    it('rejects symlink escaping asset root directory via realpath verification', async () => {
      // Create external directory and file outside tempDir
      const outsideDir = join(tmpdir(), `test-outside-${Date.now()}`);
      mkdirSync(outsideDir, { recursive: true });
      const outsideBin = join(outsideDir, 'secret-bin');
      writeFileSync(outsideBin, '#!/bin/sh\nexit 0\n');
      chmodSync(outsideBin, 0o755);

      try {
        const binDir = join(tempDir, 'linux-amd64');
        mkdirSync(binDir, { recursive: true });
        const symlinkPath = join(binDir, 'session-insight');
        // Point symlink outside asset directory
        symlinkSync(outsideBin, symlinkPath);

        const manifest = makeValidManifest({
          targets: {
            'linux-amd64': { path: 'linux-amd64/session-insight', sha256: sha256('#!/bin/sh\nexit 0\n') }
          }
        });
        writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest));

        const res = await resolveSessionInsightEngine({
          platform: 'linux',
          arch: 'x64',
          assetsDir: tempDir
        });

        expect(res.status).toBe('unavailable');
        expect(res.code).toBe('MANIFEST_CORRUPT');
        expect(res.reason).not.toContain(outsideDir);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('rejects directory target and non-executable permissions', async () => {
      const binDir = join(tempDir, 'linux-amd64/session-insight');
      mkdirSync(binDir, { recursive: true });

      const manifest = makeValidManifest({
        targets: {
          'linux-amd64': { path: 'linux-amd64/session-insight', sha256: 'a'.repeat(64) }
        }
      });
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest));

      const resDir = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: tempDir
      });
      expect(resDir.status).toBe('unavailable');
      expect(resDir.code).toBe('ENGINE_NOT_FOUND');

      // Now test file with 0644 mode
      rmSync(binDir, { recursive: true, force: true });
      writeFileSync(binDir, '#!/bin/sh\nexit 0\n');
      chmodSync(binDir, 0o644);

      const resExec = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: tempDir
      });
      expect(resExec.status).toBe('unavailable');
      expect(resExec.code).toBe('NOT_EXECUTABLE');
    });

    it('rejects checksum mismatch without leaking path', async () => {
      const binDir = join(tempDir, 'linux-amd64');
      mkdirSync(binDir, { recursive: true });
      const binPath = join(binDir, 'session-insight');
      writeFileSync(binPath, '#!/bin/sh\nexit 0\n');
      chmodSync(binPath, 0o755);

      const manifest = makeValidManifest({
        targets: {
          'linux-amd64': { path: 'linux-amd64/session-insight', sha256: '0'.repeat(64) }
        }
      });
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest));

      const res = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: tempDir
      });
      expect(res.status).toBe('unavailable');
      expect(res.code).toBe('HASH_MISMATCH');
      expect(res.reason).not.toContain(binPath);
    });

    it('does not leak stderr when handshake process crashes with sensitive token', async () => {
      const binDir = join(tempDir, 'linux-amd64');
      mkdirSync(binDir, { recursive: true });
      const binPath = join(binDir, 'session-insight');
      const content = '#!/bin/sh\necho "CRITICAL_SECRET_TOKEN_DO_NOT_LEAK" >&2\nexit 1\n';
      writeFileSync(binPath, content);
      chmodSync(binPath, 0o755);

      const manifest = makeValidManifest({
        targets: {
          'linux-amd64': { path: 'linux-amd64/session-insight', sha256: sha256(content) }
        }
      });
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest));

      const res = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: tempDir
      });
      expect(res.status).toBe('unavailable');
      expect(res.code).toBe('HANDSHAKE_FAILED');
      expect(res.reason).not.toContain('CRITICAL_SECRET_TOKEN_DO_NOT_LEAK');
    });
  });

  describe('SIGKILL termination of hung version process (Finding 2)', () => {
    it('kills hanging process ignoring SIGTERM with bounded duration and verifies PID is dead', async () => {
      const binDir = join(tempDir, 'linux-amd64');
      mkdirSync(binDir, { recursive: true });
      const binPath = join(binDir, 'session-insight');
      const pidFilePath = join(tempDir, 'hung-child.pid');

      // Shell script using ONLY shell builtins: no external commands like sleep
      // Trap ignores SIGTERM, writes own PID using builtin echo, then enters infinite builtin loop
      const content = `#!/bin/sh
trap '' TERM
echo $$ > "${pidFilePath}"
while :; do
  :
done
`;
      writeFileSync(binPath, content);
      chmodSync(binPath, 0o755);

      const manifest = makeValidManifest({
        targets: {
          'linux-amd64': { path: 'linux-amd64/session-insight', sha256: sha256(content) }
        }
      });
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest));

      const startTime = Date.now();
      // Set short handshake timeout (150ms)
      const timeoutMs = 150;
      const res = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: tempDir,
        handshakeTimeoutMs: timeoutMs
      });
      const elapsed = Date.now() - startTime;

      expect(res.status).toBe('unavailable');
      expect(res.code).toBe('HANDSHAKE_FAILED');

      // Assert elapsed is at least close to timeoutMs (proving it did not exit prematurely from buffer overflow)
      // and upper-bounded (terminated by SIGKILL on timeout)
      expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 30);
      expect(elapsed).toBeLessThan(1500);

      // Verify that PID file was written and child process is dead (ESRCH)
      expect(existsSync(pidFilePath)).toBe(true);
      const pidStr = readFileSync(pidFilePath, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      expect(Number.isInteger(pid)).toBe(true);

      let isAlive = true;
      try {
        process.kill(pid, 0);
      } catch (err: any) {
        if (err.code === 'ESRCH') {
          isAlive = false;
        }
      }
      expect(isAlive).toBe(false);
    });
  });

  describe('manifest vs handshake version parity', () => {
    it('rejects when handshake version mismatches manifest versions', async () => {
      const binDir = join(tempDir, 'linux-amd64');
      mkdirSync(binDir, { recursive: true });
      const binPath = join(binDir, 'session-insight');

      const returnedVersions: EngineVersionInfo = {
        schemaVersion: 1,
        engineVersion: 'different-commit-000000000000000000000000000',
        parserVersion: '0.1.0',
        metricVersion: 'v1'
      };
      const content = `#!/bin/sh\nif [ "$1" = "version" ]; then echo '${JSON.stringify(returnedVersions)}'; exit 0; fi\n`;
      writeFileSync(binPath, content);
      chmodSync(binPath, 0o755);

      const manifest = makeValidManifest({
        engineCommit: valid40Commit,
        engineVersion: valid40Commit,
        targets: {
          'linux-amd64': { path: 'linux-amd64/session-insight', sha256: sha256(content) }
        }
      });
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest));

      const res = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: tempDir
      });

      expect(res.status).toBe('unavailable');
      expect(res.code).toBe('VERSION_MISMATCH');
    });

    it('returns available when manifest, checksum, and handshake versions strictly match', async () => {
      const binDir = join(tempDir, 'linux-amd64');
      mkdirSync(binDir, { recursive: true });
      const binPath = join(binDir, 'session-insight');

      const expectedVersions: EngineVersionInfo = {
        schemaVersion: 1,
        engineVersion: valid40Commit,
        parserVersion: '0.1.0',
        metricVersion: 'v1'
      };
      const content = `#!/bin/sh\nif [ "$1" = "version" ] && [ "$2" = "--json" ]; then\n  echo '${JSON.stringify(expectedVersions)}'\n  exit 0\nfi\nexit 2\n`;
      writeFileSync(binPath, content);
      chmodSync(binPath, 0o755);

      const contentHash = sha256(content);
      const manifest = makeValidManifest({
        engineCommit: valid40Commit,
        engineVersion: valid40Commit,
        targets: {
          'linux-amd64': { path: 'linux-amd64/session-insight', sha256: contentHash }
        }
      });
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest));

      const res = await resolveSessionInsightEngine({
        platform: 'linux',
        arch: 'x64',
        assetsDir: tempDir
      });

      expect(res.status).toBe('available');
      if (res.status === 'available') {
        expect(res.platformArch).toBe('linux-amd64');
        expect(res.binaryPath).toBe(binPath);
        expect(res.sha256).toBe(contentHash);
        expect(res.versions).toEqual(expectedVersions);
      }
    });
  });
});
