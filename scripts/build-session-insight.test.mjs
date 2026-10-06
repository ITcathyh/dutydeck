import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  parseArgs,
  readEngineLock,
  validateLockStructure,
  validateOutDirSafety,
  verifyCompilerToolchain,
  verifyUpstreamGit
} from './build-session-insight.mjs';

const SHA40 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

function baseLock(overrides = {}) {
  return {
    name: 'session-insight-engine',
    upstreamCommit: SHA40,
    engineCommit: SHA40,
    versions: {
      schemaVersion: 1,
      engineVersion: SHA40,
      parserVersion: 'v1',
      metricVersion: 'v1',
      redactionVersion: 'v1'
    },
    build: {
      goToolchain: 'go1.26.1',
      cgoEnabled: 0,
      flags: ['-trimpath', '-buildvcs=false'],
      ldflagsSymbols: {
        'main.EngineVersion': 'engineCommit',
        'main.ParserVersion': 'versions.parserVersion',
        'main.MetricVersion': 'versions.metricVersion'
      }
    },
    platforms: {
      'linux-amd64': { sha256: SHA256 },
      'linux-arm64': { sha256: SHA256 },
      'darwin-amd64': { sha256: SHA256 },
      'darwin-arm64': { sha256: SHA256 }
    },
    redistributionLicensed: false,
    ...overrides
  };
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  writeFileSync(join(dir, 'file.txt'), 'clean');
  execFileSync('git', ['add', 'file.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'clean commit'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

/**
 * Creates a fake `go` on PATH that reports a chosen version string,
 * so toolchain rejection can be tested without downloading real toolchains.
 */
function installFakeGo(binDir, goVersion) {
  mkdirSync(binDir, { recursive: true });
  const fakeGo = join(binDir, 'go');
  writeFileSync(
    fakeGo,
    `#!/bin/sh
if [ "$1" = "version" ]; then echo "go version ${goVersion} linux/amd64"; exit 0; fi
if [ "$1" = "env" ] && [ "$2" = "GOVERSION" ]; then echo "${goVersion}"; exit 0; fi
exit 1
`
  );
  chmodSync(fakeGo, 0o755);
}

test('build-session-insight test suite', async (t) => {
  const testRoot = join(tmpdir(), `test-build-insight-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });
  const originalPath = process.env.PATH;

  t.after(() => {
    rmSync(testRoot, { recursive: true, force: true });
    process.env.PATH = originalPath;
  });

  await t.test('parseArgs parses source, platforms and recordHashes; no dirty/out-dir bypasses exist', () => {
    const opts = parseArgs([
      '--source', '/path/to/upstream',
      '--platform', 'linux-amd64',
      '--platform', 'darwin-arm64',
      '--record-hashes'
    ]);
    assert.strictEqual(opts.source, '/path/to/upstream');
    assert.deepStrictEqual(opts.platforms, ['linux-amd64', 'darwin-arm64']);
    assert.strictEqual(opts.recordHashes, true);
    assert.throws(() => parseArgs(['--source', '/x', '--allow-dirty']), /Unknown argument/);
    assert.throws(() => parseArgs(['--source', '/x', '--skip-git-check']), /Unknown argument/);
    assert.throws(() => parseArgs(['--source', '/x', '--out-dir', '/tmp/y']), /Unknown argument/);
  });

  await t.test('parseArgs defaults to all 4 platforms when none specified', () => {
    assert.deepStrictEqual(parseArgs(['--source', '/foo']).platforms, [
      'linux-amd64',
      'linux-arm64',
      'darwin-amd64',
      'darwin-arm64'
    ]);
  });

  await t.test('readEngineLock rejects missing file and corrupt JSON', () => {
    assert.throws(() => readEngineLock(join(testRoot, 'missing-lock.json')), /not found/);
    const corrupt = join(testRoot, 'corrupt-lock.json');
    writeFileSync(corrupt, '{ not valid json');
    assert.throws(() => readEngineLock(corrupt), /corrupt or invalid JSON/);
  });

  await t.test('validateLockStructure rejects invalid upstream/engine commit, versions and build constraints', () => {
    assert.throws(() => validateLockStructure(baseLock({ upstreamCommit: 'deadbeef' })), /invalid upstreamCommit/);
    assert.throws(() => validateLockStructure(baseLock({ engineCommit: 'PENDING_CONTROLLER_PIN' })), /unpinned or invalid engineCommit/);
    assert.throws(() => validateLockStructure(baseLock({ engineCommit: 'abc' })), /unpinned or invalid engineCommit/);
    assert.throws(
      () => validateLockStructure(baseLock({ versions: { ...baseLock().versions, schemaVersion: 2 } })),
      /schemaVersion must be 1/
    );
    assert.throws(
      () => validateLockStructure(baseLock({ build: { ...baseLock().build, cgoEnabled: 1 } })),
      /cgoEnabled: 0/
    );
    assert.throws(
      () => validateLockStructure(baseLock({ build: { ...baseLock().build, goToolchain: 'go1.25.0' } })),
      /goToolchain: "go1.26.1"/
    );
    assert.throws(
      () => validateLockStructure(baseLock({ build: { ...baseLock().build, flags: ['-trimpath'] } })),
      /build.flags must include/
    );
    // ldflagsSymbols strict validation: all 3 symbols must be declared with exact value sources
    assert.throws(
      () =>
        validateLockStructure(
          baseLock({
            build: {
              ...baseLock().build,
              ldflagsSymbols: {
                'main.EngineVersion': 'engineCommit',
                'main.MetricVersion': 'versions.metricVersion'
              }
            }
          })
        ),
      /build.ldflagsSymbols must declare "main.ParserVersion"/
    );
    assert.throws(
      () =>
        validateLockStructure(
          baseLock({
            build: {
              ...baseLock().build,
              ldflagsSymbols: {
                'main.EngineVersion': 'engineCommit',
                'main.ParserVersion': 'versions.parserVersion',
                'main.MetricVersion': 'wrongValueSource'
              }
            }
          })
        ),
      /value source mismatch: expected "versions.metricVersion"/
    );
    assert.throws(
      () =>
        validateLockStructure(
          baseLock({
            build: {
              ...baseLock().build,
              ldflagsSymbols: {
                ...baseLock().build.ldflagsSymbols,
                'main.commit': 'engineCommit'
              }
            }
          })
        ),
      /declares unsupported symbol "main.commit"/
    );
  });

  await t.test('validateLockStructure rejects missing/invalid platform sha256 on normal build', () => {
    const lock = baseLock();
    lock.platforms['linux-amd64'] = { sha256: 'PENDING_BUILD_HASH' };
    assert.throws(
      () => validateLockStructure(lock),
      /has unpinned or invalid sha256/
    );

    const lock2 = baseLock();
    delete lock2.platforms['darwin-arm64'];
    assert.throws(() => validateLockStructure(lock2), /unpinned or invalid sha256/);

    // record-hashes bootstrap may proceed without pre-existing hashes ...
    assert.doesNotThrow(() => validateLockStructure(lock2, { recordHashes: true }));
    // ... but still requires a pinned engine commit
    assert.throws(
      () => validateLockStructure(baseLock({ engineCommit: 'PENDING_CONTROLLER_PIN' }), { recordHashes: true }),
      /unpinned or invalid engineCommit/
    );
  });

  await t.test('validateLockStructure only checks the platforms actually being built', () => {
    const lock = baseLock();
    delete lock.platforms['darwin-arm64'];
    assert.doesNotThrow(() => validateLockStructure(lock, { platforms: ['linux-amd64'] }));
    assert.throws(
      () => validateLockStructure(lock, { platforms: ['darwin-arm64'] }),
      /darwin-arm64/
    );
  });

  await t.test('verifyUpstreamGit rejects non-existent directory and non-git directory', () => {
    assert.throws(() => verifyUpstreamGit('/non/existent/dir', baseLock()), /does not exist/);
    const nonGit = join(testRoot, 'non-git');
    mkdirSync(nonGit, { recursive: true });
    assert.throws(() => verifyUpstreamGit(nonGit, baseLock()), /Failed to verify git repository/);
  });

  await t.test('verifyUpstreamGit rejects dirty worktree (modified tracked + untracked files)', () => {
    const gitDir = join(testRoot, 'dirty-repo');
    initRepo(gitDir);
    writeFileSync(join(gitDir, 'untracked.txt'), 'dirty');
    assert.throws(() => verifyUpstreamGit(gitDir, baseLock()), /is not clean/);
    rmSync(join(gitDir, 'untracked.txt'));
    writeFileSync(join(gitDir, 'file.txt'), 'modified content');
    assert.throws(() => verifyUpstreamGit(gitDir, baseLock()), /is not clean/);
  });

  await t.test('verifyUpstreamGit rejects PENDING/invalid engineCommit even on a clean repo', () => {
    const gitDir = join(testRoot, 'pending-repo');
    initRepo(gitDir);
    assert.throws(
      () => verifyUpstreamGit(gitDir, baseLock({ engineCommit: 'PENDING_CONTROLLER_PIN' })),
      /unpinned or invalid engineCommit/
    );
    assert.throws(
      () => verifyUpstreamGit(gitDir, baseLock({ engineCommit: 'deadbeef' })),
      /unpinned or invalid engineCommit/
    );
  });

  await t.test('verifyUpstreamGit rejects HEAD mismatch and accepts exact pinned commit', () => {
    const gitDir = join(testRoot, 'match-repo');
    const head = initRepo(gitDir);
    assert.throws(
      () => verifyUpstreamGit(gitDir, baseLock({ engineCommit: '0'.repeat(40) })),
      /does not match locked engineCommit/
    );
    assert.strictEqual(verifyUpstreamGit(gitDir, baseLock({ engineCommit: head })), head);
  });

  await t.test('verifyCompilerToolchain rejects cgo/toolchain lock violations', () => {
    assert.throws(
      () => verifyCompilerToolchain({ build: { cgoEnabled: 1, goToolchain: 'go1.26.1' } }),
      /cgoEnabled: 0/
    );
    assert.throws(
      () => verifyCompilerToolchain({ build: { cgoEnabled: 0, goToolchain: 'go1.26.2' } }),
      /goToolchain: "go1.26.1"/
    );
  });

  await t.test('verifyCompilerToolchain rejects fake go1.26.99 and go1.24.0 (no prefix matching)', () => {
    for (const fakeVersion of ['go1.26.99', 'go1.24.0']) {
      const binDir = join(testRoot, `fake-go-${fakeVersion.replace(/\./g, '-')}`);
      installFakeGo(binDir, fakeVersion);
      process.env.PATH = `${binDir}:${originalPath}`;
      assert.throws(
        () => verifyCompilerToolchain(baseLock()),
        new RegExp(`does not match exact "go1.26.1".*${fakeVersion.replace(/\./g, '\\.')}`)
      );
    }
    process.env.PATH = originalPath;
  });

  await t.test('verifyCompilerToolchain accepts exact go1.26.1 via fixed GOTOOLCHAIN env', () => {
    // Host runs go1.26.6; GOTOOLCHAIN=go1.26.1 must resolve the exact pinned compiler.
    assert.doesNotThrow(() => verifyCompilerToolchain(baseLock()));
  });

  await t.test('validateOutDirSafety pure-function negative assertions (protects root, source, and tmpdir)', () => {
    const sourceDir = join(testRoot, 'upstream');
    mkdirSync(sourceDir, { recursive: true });

    // 1. Filesystem root
    assert.throws(
      () => validateOutDirSafety('/', sourceDir),
      /cannot be the filesystem root/
    );

    // 2. Tmpdir root itself
    assert.throws(
      () => validateOutDirSafety(tmpdir(), sourceDir),
      /cannot be the temporary directory root/
    );

    // 3. Workspace root and its ancestor
    assert.throws(
      () => validateOutDirSafety(process.cwd(), sourceDir),
      /cannot be the workspace root/
    );
    assert.throws(
      () => validateOutDirSafety(dirname(process.cwd()), sourceDir),
      /is an ancestor of workspace root/
    );

    // 4. Source directory and its ancestor
    assert.throws(
      () => validateOutDirSafety(sourceDir, sourceDir),
      /cannot be the source directory/
    );
    assert.throws(
      () => validateOutDirSafety(dirname(sourceDir), sourceDir),
      /is an ancestor of source directory/
    );

    // 5. Arbitrary path outside tmpdir (even if ending in .engine-build)
    assert.throws(
      () => validateOutDirSafety(join(process.env.HOME, 'fake.engine-build'), sourceDir),
      /must be default apps\/server\/\.engine-build or a managed sub-directory inside tmpdir/
    );
    assert.throws(
      () => validateOutDirSafety(join(process.cwd(), 'packages/shared'), sourceDir),
      /must be default apps\/server\/\.engine-build or a managed sub-directory inside tmpdir/
    );

    // 6. Safe allowed locations: default staging dir and managed sub-directory in tmpdir
    assert.doesNotThrow(() => validateOutDirSafety(resolve(process.cwd(), 'apps/server/.engine-build'), sourceDir));
    assert.doesNotThrow(() => validateOutDirSafety(join(tmpdir(), 'dutydeck-test-safe-sub'), sourceDir));
  });
});
