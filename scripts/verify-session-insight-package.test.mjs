import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  getHostPlatformArch,
  verifyPackageDirectory,
  verifyRedistributionLicense
} from './verify-session-insight-package.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workspaceRoot = join(__dirname, '..');
const serverDir = join(workspaceRoot, 'apps/server');

const TARGETS = ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'];
const ENGINE_COMMIT = 'c'.repeat(40);
const UPSTREAM_COMMIT = '0bf5f1c95e89384f6379357aa515d385b2bf4e1e';
const VERSIONS = {
  schemaVersion: 1,
  engineVersion: ENGINE_COMMIT,
  parserVersion: 'parser-v1',
  metricVersion: 'metric-v1',
  redactionVersion: 'redaction-v1'
};
const NOTICES = '# Notices\n\n## Session Insight\npending license, local only\n';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Pure-/bin/sh mock of the Go engine that works under PATH=''.
 * version --json prints the pinned versions; analyze reads requestId/sha256/native id
 * from stdin with shell parameter expansion and echoes a frozen-schema-valid result.
 * Overrides allow targeted negative cases (badRequestId, nativeId, empty files, exit code).
 */
function createMockEngineScript(versions, overrides = {}) {
  // version handshake carries exactly the four strict fields of engineVersionInfoSchema
  const vJSON = JSON.stringify({
    schemaVersion: 1,
    engineVersion: versions.engineVersion,
    parserVersion: versions.parserVersion,
    metricVersion: versions.metricVersion
  });
  if (overrides.exitTwo) {
    return `#!/bin/sh
exit 2
`;
  }
  if (overrides.emptyFilesObject) {
    // Fabricated pseudo-result: files:[{}] — must be rejected by frozen Zod gate
    return `#!/bin/sh
if [ "$1" = "version" ] && [ "$2" = "--json" ]; then echo '${vJSON}'; exit 0; fi
if [ "$1" = "analyze" ]; then echo '{"schemaVersion":1,"requestId":"x","engineVersion":"${versions.engineVersion}","parserVersion":"${versions.parserVersion}","metricVersion":"${versions.metricVersion}","files":[{}],"warnings":[]}'; exit 0; fi
exit 2
`;
  }
  if (overrides.wrongRequestId) {
    // Schema-valid UUID/sha so it passes Zod and reaches the exact-echo mismatch assertion
    const wrongJson = JSON.stringify(buildValidAnalyzeJson(versions, {
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      sha256: '0'.repeat(64),
      nativeSessionId: 'sess_packverify_1'
    }));
    return `#!/bin/sh
if [ "$1" = "version" ] && [ "$2" = "--json" ]; then echo '${vJSON}'; exit 0; fi
if [ "$1" = "analyze" ]; then echo '${wrongJson}'; exit 0; fi
exit 2
`;
  }
  if (overrides.zeroCoverage) {
    // Schema-valid but claims zero lines were processed — must be rejected as not a real analysis
    const zeroJson = JSON.stringify(
      buildValidAnalyzeJson(versions, {
        requestId: '__REQ__',
        sha256: '__SHA__',
        nativeSessionId: '__NID__',
        rawLines: 0,
        parsedLines: 0
      })
    )
      .replace('__REQ__', `'"$req"'`)
      .replace('__SHA__', `'"$sha"'`)
      .replace('__NID__', `'"$nid"'`);
    return `#!/bin/sh
if [ "$1" = "version" ] && [ "$2" = "--json" ]; then echo '${vJSON}'; exit 0; fi
if [ "$1" = "analyze" ]; then
  IFS= read -r body
  req="\${body#*\\"requestId\\":\\"}"; req="\${req%%\\"*}"
  sha="\${body#*\\"sha256\\":\\"}"; sha="\${sha%%\\"*}"
  nid="\${body#*\\"expectedNativeSessionId\\":\\"}"; nid="\${nid%%\\"*}"
  printf '%s\\n' '${zeroJson}'
  exit 0
fi
exit 2
`;
  }
  if (overrides.twoFiles) {
    // Schema allows up to 32 files, but this request sent exactly 1 — a two-file answer must be rejected.
    // The second file carries self-contained valid constants so Zod passes and the length gate is reached.
    const two = buildValidAnalyzeJson(versions, {
      requestId: '__REQ__',
      sha256: '__SHA__',
      nativeSessionId: '__NID__'
    });
    two.files.push({
      ...two.files[0],
      sourceKey: 'packverify-secondary',
      sha256: '0'.repeat(64),
      nativeSessionId: 'sess_packverify_2'
    });
    const twoJson = JSON.stringify(two)
      .replace('__REQ__', `'"$req"'`)
      .replace('__SHA__', `'"$sha"'`)
      .replace('__NID__', `'"$nid"'`);
    return `#!/bin/sh
if [ "$1" = "version" ] && [ "$2" = "--json" ]; then echo '${vJSON}'; exit 0; fi
if [ "$1" = "analyze" ]; then
  IFS= read -r body
  req="\${body#*\\"requestId\\":\\"}"; req="\${req%%\\"*}"
  sha="\${body#*\\"sha256\\":\\"}"; sha="\${sha%%\\"*}"
  nid="\${body#*\\"expectedNativeSessionId\\":\\"}"; nid="\${nid%%\\"*}"
  printf '%s\\n' '${twoJson}'
  exit 0
fi
exit 2
`;
  }

  // POSIX /bin/sh only (works under PATH=''): extract fields with parameter expansion.
  // Only the bare placeholder is replaced, by the shell sequence  '"$var"'  that closes the
  // outer single quote, interpolates the double-quoted variable, then reopens the quote.
  // printf is a shell builtin — no cat/heredoc/external commands are invoked.
  const literal = JSON.stringify(
    buildValidAnalyzeJson(versions, { requestId: '__REQ__', sha256: '__SHA__', nativeSessionId: '__NID__' })
  )
    .replace('__REQ__', `'"$req"'`)
    .replace('__SHA__', `'"$sha"'`)
    .replace('__NID__', `'"$nid"'`);
  return `#!/bin/sh
if [ "$1" = "version" ] && [ "$2" = "--json" ]; then echo '${vJSON}'; exit 0; fi
if [ "$1" = "analyze" ] && [ "$2" = "--format" ] && [ "$3" = "json" ]; then
  IFS= read -r body
  req="\${body#*\\"requestId\\":\\"}"; req="\${req%%\\"*}"
  sha="\${body#*\\"sha256\\":\\"}"; sha="\${sha%%\\"*}"
  nid="\${body#*\\"expectedNativeSessionId\\":\\"}"; nid="\${nid%%\\"*}"
  printf '%s\\n' '${literal}'
  exit 0
fi
exit 2
`;
}

function buildValidAnalyzeJson(versions, vals) {
  const metric = (value) => ({
    value,
    quality: 'exact',
    status: 'available',
    evidenceCount: 1,
    missingCount: 0,
    reasonCodes: []
  });
  const contMetric = (value) => ({ ...metric(value) });
  return {
    schemaVersion: 1,
    requestId: vals.requestId,
    engineVersion: versions.engineVersion,
    parserVersion: versions.parserVersion,
    metricVersion: versions.metricVersion,
    files: [
      {
        sourceKey: 'packverify-primary',
        client: 'codex',
        sha256: vals.sha256,
        nativeSessionId: vals.nativeSessionId,
        streamIdentity: { kind: 'main', nativeAgentId: null },
        status: 'ok',
        models: ['gpt-test'],
        metrics: {
          inputUncached: metric(10),
          cacheRead: metric(0),
          cacheWrite: metric(0),
          output: metric(5),
          reasoningOutput: metric(0),
          totalTracked: metric(15),
          rawInput: metric(10),
          rawOutput: metric(5),
          rawTotal: metric(15),
          peakContext: metric(15),
          contextWindow: metric(1000),
          elapsedDurationMs: contMetric(0),
          activeDurationMs: contMetric(0),
          idleDurationMs: contMetric(0),
          pairedToolDurationMs: contMetric(0),
          userTurns: metric(1),
          assistantTurns: metric(0),
          toolCalls: metric(0),
          toolFailures: metric(0),
          toolSuccesses: metric(0),
          toolUnknowns: metric(0),
          toolFailureRate: contMetric(0),
          compactionCount: metric(0),
          subagentCount: metric(0)
        },
        trace: [],
        pulseBuckets: [],
        coverage: {
          rawLines: vals.rawLines ?? 3,
          parsedLines: vals.parsedLines ?? 3,
          ignoredLines: 0,
          errorLines: 0,
          timeRange: { start: '2026-10-03T10:00:00Z', end: '2026-10-03T10:00:02Z' },
          missingTimestampCount: 0,
          disorderedTimestampCount: 0,
          retainedTraceCount: 0,
          omittedTraceCount: 0,
          omittedTraceByCategory: {},
          tokenSamplesAvailable: 1,
          tokenSamplesMissing: 0,
          subagentDiscovery: 'none',
          inheritedHistory: 'none'
        },
        relationship: { kind: 'none', parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] },
        aggregation: { eligibility: 'eligible', reasonCodes: [] }
      }
    ],
    warnings: []
  };
}

/**
 * Builds an isolated, fully-valid fixture: temp lock, notices, packaged engine assets.
 */
function buildFixture(testRoot, name, opts = {}) {
  const dir = join(testRoot, name);
  const engineDir = join(dir, 'dist/assets/session-insight');
  mkdirSync(engineDir, { recursive: true });

  const versions = opts.versions || VERSIONS;
  const mockContent = opts.mockContent || createMockEngineScript(versions, opts.mockOverrides);
  const targets = {};
  for (const target of TARGETS) {
    const targetDir = join(engineDir, target);
    mkdirSync(targetDir, { recursive: true });
    const binPath = join(targetDir, 'session-insight');
    writeFileSync(binPath, mockContent);
    if (opts.noExec) {
      chmodSync(binPath, 0o644);
    } else {
      chmodSync(binPath, 0o755);
    }
    targets[target] = { path: `${target}/session-insight`, sha256: sha256(mockContent) };
  }

  if (opts.tamperHash) {
    targets['linux-amd64'].sha256 = 'f'.repeat(64);
  }

  const manifest = {
    schemaVersion: 1,
    name: 'session-insight-engine',
    upstreamCommit: opts.upstreamCommit || UPSTREAM_COMMIT,
    engineCommit: opts.engineCommit || ENGINE_COMMIT,
    versions,
    redistributionLicensed: false,
    targets: opts.targetsOverride || targets
  };
  writeFileSync(join(engineDir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(engineDir, 'THIRD_PARTY_NOTICES.md'), NOTICES);

  const lock = {
    name: 'session-insight-engine',
    upstreamCommit: opts.lockUpstreamCommit || UPSTREAM_COMMIT,
    engineCommit: opts.lockEngineCommit || ENGINE_COMMIT,
    versions: opts.lockVersionsOverride || {
      schemaVersion: 1,
      engineVersion: ENGINE_COMMIT,
      parserVersion: versions.parserVersion,
      metricVersion: versions.metricVersion,
      redactionVersion: versions.redactionVersion
    },
    build: { goToolchain: 'go1.26.1', cgoEnabled: 0, flags: ['-trimpath', '-buildvcs=false'] },
    platforms: Object.fromEntries(TARGETS.map(t => [t, { sha256: targets[t].sha256 }])),
    redistributionLicensed: false
  };
  const lockPath = join(dir, 'engine.lock.json');
  writeFileSync(lockPath, JSON.stringify(lock));
  const noticesPath = join(dir, 'THIRD_PARTY_NOTICES.md');
  writeFileSync(noticesPath, NOTICES);

  return { dir, engineDir, lockPath, noticesPath, manifest, lock, targets, mockContent };
}

function verify(fx, extraOpts = {}) {
  return verifyPackageDirectory(fx.dir, {
    allowUnlicensedForLocalDebug: true,
    isMockBinary: true,
    paths: { lockPath: fx.lockPath, noticesPath: fx.noticesPath },
    ...extraOpts
  });
}

test('verify-session-insight-package test suite', async (t) => {
  const testRoot = join(tmpdir(), `test-verify-pkg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });

  t.after(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  await t.test('rejects redistribution without license; local flag is a license exception only', () => {
    const fx = buildFixture(testRoot, 'license');
    assert.throws(
      () => verify(fx, { allowUnlicensedForLocalDebug: false }),
      /not licensed for redistribution/
    );
    // Local flag passes the license gate while all other gates stay enforced
    assert.doesNotThrow(() => verify(fx));
  });

  await t.test('rejects corrupt repo lock JSON instead of ignoring it', () => {
    const fx = buildFixture(testRoot, 'corrupt-lock');
    writeFileSync(fx.lockPath, '{ broken json');
    assert.throws(() => verify(fx), /engine.lock.json is corrupt or invalid JSON/);
  });

  await t.test('rejects packaged manifest whose engineCommit/versions differ from repo lock', () => {
    const fx1 = buildFixture(testRoot, 'wrong-commit', { engineCommit: 'd'.repeat(40) });
    assert.throws(() => verify(fx1), /does not match repo lock/);

    const fx2 = buildFixture(testRoot, 'wrong-parser', {
      versions: { ...VERSIONS, parserVersion: 'parser-OTHER' },
      lockVersionsOverride: VERSIONS
    });
    assert.throws(() => verify(fx2), /versions.parserVersion/);
  });

  await t.test('rejects when manifest and binary are swapped together but hash disagrees with lock', () => {
    // Manifest hash matches the (new) binary, yet repo lock still pins the old hash
    const fx = buildFixture(testRoot, 'swapped-binary');
    const binPath = join(fx.engineDir, 'linux-amd64', 'session-insight');
    const swappedContent = createMockEngineScript(VERSIONS, { wrongRequestId: true });
    writeFileSync(binPath, swappedContent);
    chmodSync(binPath, 0o755);
    const newHash = sha256(swappedContent);
    // Tamper packaged manifest to endorse the swapped binary; lock is untouched
    const manifest = JSON.parse(readJson(join(fx.engineDir, 'manifest.json')));
    manifest.targets['linux-amd64'].sha256 = newHash;
    writeFileSync(join(fx.engineDir, 'manifest.json'), JSON.stringify(manifest));
    assert.throws(() => verify(fx), /does not match repo lock/);
  });

  await t.test('rejects missing target architecture', () => {
    const fx = buildFixture(testRoot, 'missing-target');
    delete fx.targets['darwin-arm64'];
    writeFileSync(join(fx.engineDir, 'manifest.json'), JSON.stringify({ ...fx.manifest, targets: fx.targets }));
    assert.throws(() => verify(fx), /missing required target architecture: darwin-arm64/);
  });

  await t.test('rejects non-0755 mode and non-regular files', () => {
    const fx = buildFixture(testRoot, 'bad-mode', { noExec: true });
    assert.throws(() => verify(fx), /expected 0755/);

    const fx2 = buildFixture(testRoot, 'directory-target');
    const binPath = join(fx2.engineDir, 'linux-amd64', 'session-insight');
    rmSync(binPath);
    mkdirSync(binPath, { recursive: true });
    assert.throws(() => verify(fx2), /not a regular file/);
  });

  await t.test('rejects binary SHA256 mismatch against packaged manifest', () => {
    const fx = buildFixture(testRoot, 'hash-mismatch', { tamperHash: true });
    assert.throws(() => verify(fx), /SHA256 mismatch for linux-amd64/);
  });

  await t.test('rejects target paths that escape the engine assets directory via symlink', () => {
    const fx = buildFixture(testRoot, 'symlink-escape');
    const outside = join(testRoot, 'outside-engine');
    writeFileSync(outside, createMockEngineScript(VERSIONS));
    chmodSync(outside, 0o755);
    const binPath = join(fx.engineDir, 'linux-amd64', 'session-insight');
    rmSync(binPath);
    symlinkSync(outside, binPath);
    assert.throws(() => verify(fx), /resolves outside engine assets directory/);
  });

  await t.test('rejects non-zero exit / fabricated files:[{}] / wrong requestId from the engine', () => {
    const fx1 = buildFixture(testRoot, 'exit-two', { mockOverrides: { exitTwo: true } });
    assert.throws(() => verify(fx1), /version --json/);

    const fx2 = buildFixture(testRoot, 'empty-files', { mockOverrides: { emptyFilesObject: true } });
    assert.throws(() => verify(fx2), /frozen schema|version --json|analyze/);

    const fx3 = buildFixture(testRoot, 'wrong-req', { mockOverrides: { wrongRequestId: true } });
    assert.throws(() => verify(fx3), /requestId mismatch/);

    // Zero processed lines is not a real analysis even if every field is schema-valid
    const fx4 = buildFixture(testRoot, 'zero-coverage', { mockOverrides: { zeroCoverage: true } });
    assert.throws(() => verify(fx4), /coverage\.(rawLines|parsedLines) must be a positive integer/);

    // Request had exactly one file; an engine returning two files must be rejected
    const fx5 = buildFixture(testRoot, 'two-files', { mockOverrides: { twoFiles: true } });
    assert.throws(() => verify(fx5), /files array must contain exactly 1 file/);
  });

  await t.test('analyze gate supports the real sanitized fixture path (mock plumbing, not real Go)', () => {
    // Wire the same gate against an existing sanitized native JSONL; the mock echoes the bound
    // request fields so this validates the fixture plumbing/non-empty gate, not Go runtime behavior.
    const fx = buildFixture(testRoot, 'real-fixture');
    const realFixture = join(
      workspaceRoot,
      'tests/fixtures/session-insight/upstream-sanitized/codex-modern.jsonl'
    );
    const report = verify(fx, { fixture: realFixture });
    const host = getHostPlatformArch();
    assert.match(report.targets[host].status, /mock plumbing verified/);
  });

  await t.test('rejects a --fixture path that is missing or empty', () => {
    const fx = buildFixture(testRoot, 'missing-fixture');
    assert.throws(
      () => verify(fx, { fixture: join(testRoot, 'does-not-exist.jsonl') }),
      /fixture file not found/
    );
    const emptyFix = join(testRoot, 'empty.jsonl');
    writeFileSync(emptyFix, '');
    assert.throws(() => verify(fx, { fixture: emptyFix }), /fixture file is empty/);
  });

  await t.test('accepts full valid mock plumbing: host target runtime-checked, cross-arch unverified', () => {
    const fx = buildFixture(testRoot, 'valid');
    const report = verify(fx);
    const host = getHostPlatformArch();
    assert.strictEqual(
      report.targets[host].status,
      'mock plumbing verified (shell script packaging; NOT real Go runtime)'
    );
    for (const target of TARGETS) {
      if (target !== host) {
        assert.match(report.targets[target].status, /runtime unverified \(cross-architecture/);
      }
      assert.strictEqual(report.targets[target].mode, '0755');
    }
  });

  await t.test('license exception flag does not bypass version/hash enforcement', () => {
    // Even with the flag, a tampered hash is still rejected
    const fx = buildFixture(testRoot, 'flag-no-bypass', { tamperHash: true });
    assert.throws(() => verify(fx), /SHA256 mismatch for linux-amd64/);
  });

  await t.test('end-to-end npm pack tarball: unpack and run host version+analyze with PATH empty', async () => {
    const staging = join(serverDir, '.engine-build');
    const distDir = join(serverDir, 'dist');
    const publicDir = join(serverDir, 'public');

    // 1. 同文件系统独有临时备份目录安全移走已有真实产物，避免测试过程修改/删除/覆盖
    const backupDir = join(serverDir, `.backup-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(backupDir, { recursive: true });

    let backupStaging = false;
    let backupDist = false;
    let backupPublic = false;
    const backupTgzs = [];
    let e2eDir = null;
    // True only after ALL originals have been moved aside successfully.
    // Until then, staging/dist/public at their live paths may still be real originals and must never be deleted.
    let moved = false;

    try {
      // Move originals aside (same-filesystem atomic rename preserves bytes and mode)
      if (existsSync(staging)) {
        renameSync(staging, join(backupDir, '.engine-build'));
        backupStaging = true;
      }
      if (existsSync(distDir)) {
        renameSync(distDir, join(backupDir, 'dist'));
        backupDist = true;
      }
      if (existsSync(publicDir)) {
        renameSync(publicDir, join(backupDir, 'public'));
        backupPublic = true;
      }
      for (const f of readdirSync(serverDir)) {
        if (f.endsWith('.tgz')) {
          const originalTgzPath = join(serverDir, f);
          renameSync(originalTgzPath, join(backupDir, f));
          backupTgzs.push({ original: originalTgzPath, backup: join(backupDir, f) });
        }
      }
      moved = true;

      mkdirSync(staging, { recursive: true });
      const targets = {};
      const mockContent = createMockEngineScript(VERSIONS);
      for (const target of TARGETS) {
        const targetDir = join(staging, target);
        mkdirSync(targetDir, { recursive: true });
        const binPath = join(targetDir, 'session-insight');
        writeFileSync(binPath, mockContent);
        chmodSync(binPath, 0o755);
        targets[target] = { path: `${target}/session-insight`, sha256: sha256(mockContent) };
      }
      writeFileSync(
        join(staging, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 1,
          name: 'session-insight-engine',
          upstreamCommit: UPSTREAM_COMMIT,
          engineCommit: ENGINE_COMMIT,
          versions: VERSIONS,
          redistributionLicensed: false,
          targets
        })
      );

      // Build dist (copies staging into dist/assets/session-insight + notices)
      execFileSync('node', ['scripts/build.mjs'], { cwd: serverDir });

      // Use an isolated lock matching the staged manifest
      e2eDir = mkdtempSync(join(tmpdir(), 'verify-e2e-lock-'));
      const lockPath = join(e2eDir, 'engine.lock.json');
      writeFileSync(
        lockPath,
        JSON.stringify({
          name: 'session-insight-engine',
          upstreamCommit: UPSTREAM_COMMIT,
          engineCommit: ENGINE_COMMIT,
          versions: VERSIONS,
          build: { goToolchain: 'go1.26.1', cgoEnabled: 0, flags: ['-trimpath', '-buildvcs=false'] },
          platforms: Object.fromEntries(TARGETS.map(t => [t, { sha256: targets[t].sha256 }])),
          redistributionLicensed: false
        })
      );

      const { runVerify } = await import('./verify-session-insight-package.mjs');
      const report = await runVerify({
        allowUnlicensedForLocalDebug: true,
        isMockBinary: true,
        paths: { lockPath }
      });
      assert.strictEqual(Object.keys(report.targets).length, 4);
      const insightFiles = report.fileManifest.filter(f => f.path.includes('session-insight'));
      assert.ok(insightFiles.length >= 6, 'must contain 4 binaries + manifest + notices');
    } finally {
      // 1. 清理临时 lock 目录
      if (e2eDir && existsSync(e2eDir)) {
        rmSync(e2eDir, { recursive: true, force: true });
      }

      // 2. 仅当所有原始产物都已成功移走（moved=true），原位路径上的内容才是本测试生成的，
      //    才可安全删除；若移动阶段中途失败（moved=false），原位可能仍是真实产物，绝不删除。
      if (moved) {
        rmSync(staging, { recursive: true, force: true });
        rmSync(distDir, { recursive: true, force: true });
        rmSync(publicDir, { recursive: true, force: true });
        try {
          for (const f of readdirSync(serverDir)) {
            if (f.endsWith('.tgz')) {
              rmSync(join(serverDir, f), { force: true });
            }
          }
        } catch {
          // ignore
        }
      }

      // 3. 逐字、原 mode 恢复之前备份的真实已有产物（同文件系统 rename 保留 bytes/mode），
      //    绝不以重跑 build 假恢复替代。移动失败时此步同样把已移走的部分还原。
      if (backupStaging && existsSync(join(backupDir, '.engine-build'))) {
        renameSync(join(backupDir, '.engine-build'), staging);
      }
      if (backupDist && existsSync(join(backupDir, 'dist'))) {
        renameSync(join(backupDir, 'dist'), distDir);
      }
      if (backupPublic && existsSync(join(backupDir, 'public'))) {
        renameSync(join(backupDir, 'public'), publicDir);
      }
      for (const item of backupTgzs) {
        if (existsSync(item.backup)) {
          renameSync(item.backup, item.original);
        }
      }

      // 4. 清理备份目录（此时应为空）
      rmSync(backupDir, { recursive: true, force: true });
    }
  });
});

// Avoid an extra fs import in the fixture helper:
function readJson(p) {
  return readFileSync(p, 'utf-8');
}

// Direct unit check for the license metadata helper signatures
test('verifyRedistributionLicense compares packaged manifest flag to repo lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-license-'));
  try {
    const noticesPath = join(dir, 'NOTICES.md');
    writeFileSync(noticesPath, NOTICES);
    const lock = { redistributionLicensed: false };
    const baseOpts = { paths: { noticesPath } };
    // No license + no local flag -> rejected
    assert.throws(
      () => verifyRedistributionLicense(lock, { redistributionLicensed: false }, NOTICES, baseOpts),
      /not licensed for redistribution/
    );
    // Packaged manifest claiming licensed while repo lock says false -> rejected
    assert.throws(
      () => verifyRedistributionLicense(lock, { redistributionLicensed: true }, NOTICES, {
        ...baseOpts,
        allowUnlicensedForLocalDebug: true
      }),
      /does not match repo lock/
    );
    // Consistent metadata + local license exception -> accepted
    assert.doesNotThrow(() =>
      verifyRedistributionLicense(lock, { redistributionLicensed: false }, NOTICES, {
        ...baseOpts,
        allowUnlicensedForLocalDebug: true
      })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
