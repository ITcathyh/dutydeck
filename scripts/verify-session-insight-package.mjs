#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  analyzeFilesResultSchema,
  engineVersionInfoSchema
} from '@dutydeck/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workspaceRoot = resolve(__dirname, '..');
const serverDir = resolve(workspaceRoot, 'apps/server');
const lockPath = resolve(workspaceRoot, 'tools/session-insight-engine/engine.lock.json');
const noticesPath = resolve(workspaceRoot, 'THIRD_PARTY_NOTICES.md');

const REQUIRED_TARGETS = ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'];
const SHA40_REGEX = /^[a-f0-9]{40}$/i;
const SHA256_REGEX = /^[a-f0-9]{64}$/i;

// Minimal synthetic but structurally real Codex JSONL session log (deterministic, no private data).
// Real Go gate runs the packaged binary against this non-empty input; mock gate still runs full Zod validation.
const SYNTHETIC_CODEX_LOG = [
  JSON.stringify({
    timestamp: '2026-10-03T10:00:00Z',
    type: 'session_meta',
    payload: { id: 'sess_packverify_1', type: 'session_meta', cwd: '/work/pack-verify' }
  }),
  JSON.stringify({
    timestamp: '2026-10-03T10:00:01Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: 'pack verify minimal prompt' }
  }),
  JSON.stringify({
    timestamp: '2026-10-03T10:00:02Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      }
    }
  }),
  ''
].join('\n');

function printUsageAndExit(code = 1) {
  console.log(`
Usage:
  node scripts/verify-session-insight-package.mjs [options]

Options:
  --tarball <path>                      Path to pre-built @byted/dutydeck npm tarball (optional)
  --unpacked-dir <path>                 Path to pre-unpacked directory (for testing)
  --fixture <path>                      Use specified sanitized JSONL fixture for analyze execution (optional)
  --allow-unlicensed-for-local-debug    License exception ONLY (LOCAL DEBUG ONLY); never bypasses version/hash checks
  --is-mock-binary                      Mark verification as mock shell-binary plumbing (not real Go runtime)
  --skip-pack                           Use apps/server/dist directly instead of tarball packing (testing only)
  --help, -h                            Show help
`);
  process.exit(code);
}

export function parseArgs(args) {
  const options = {
    tarball: null,
    unpackedDir: null,
    fixture: null,
    allowUnlicensedForLocalDebug: false,
    isMockBinary: false,
    skipPack: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printUsageAndExit(0);
    } else if (arg === '--tarball') {
      options.tarball = resolve(args[++i]);
    } else if (arg.startsWith('--tarball=')) {
      options.tarball = resolve(arg.slice('--tarball='.length));
    } else if (arg === '--unpacked-dir') {
      options.unpackedDir = resolve(args[++i]);
    } else if (arg.startsWith('--unpacked-dir=')) {
      options.unpackedDir = resolve(arg.slice('--unpacked-dir='.length));
    } else if (arg === '--fixture') {
      options.fixture = resolve(args[++i]);
    } else if (arg.startsWith('--fixture=')) {
      options.fixture = resolve(arg.slice('--fixture='.length));
    } else if (arg === '--allow-unlicensed-for-local-debug') {
      options.allowUnlicensedForLocalDebug = true;
    } else if (arg === '--is-mock-binary') {
      options.isMockBinary = true;
    } else if (arg === '--skip-pack') {
      options.skipPack = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsageAndExit(1);
    }
  }

  return options;
}

export function computeSha256(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export function computeBufferSha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolves current host's platform-arch key.
 */
export function getHostPlatformArch() {
  const os = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : null;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  return os && arch ? `${os}-${arch}` : null;
}

export function readRepoLock(explicitLockPath = lockPath) {
  let raw;
  try {
    raw = readFileSync(explicitLockPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read engine.lock.json: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Corrupt lock must never be ignored
    throw new Error(`engine.lock.json is corrupt or invalid JSON: ${err.message}`);
  }
}

/**
 * Verifies redistribution license metadata from repository, packaged manifest and packaged notices.
 * The local debug flag is a license exception ONLY; it cannot bypass any version/hash check,
 * and the output is always marked local/unreleased.
 */
export function verifyRedistributionLicense(repoLock, packagedManifest, packagedNotices, options = {}) {
  const noticesFilePath = options.paths?.noticesPath || noticesPath;
  const isExplicitlyLicensed = repoLock.redistributionLicensed === true;

  if (!isExplicitlyLicensed && !options.allowUnlicensedForLocalDebug) {
    throw new Error(
      `[PREFLIGHT REJECTED] Upstream session-insight is not licensed for redistribution ` +
      `("Private project. Not licensed for redistribution."). Redistribution requires an express license grant; ` +
      `no grant has been recorded. (--allow-unlicensed-for-local-debug is a local-debug license exception only.)`
    );
  }

  // Authorization metadata must be present inside the packaged manifest, and must agree with the repo lock.
  if (packagedManifest.redistributionLicensed !== isExplicitlyLicensed) {
    throw new Error(
      `[PREFLIGHT REJECTED] Packaged manifest redistributionLicensed (${packagedManifest.redistributionLicensed}) ` +
      `does not match repo lock (${isExplicitlyLicensed}).`
    );
  }

  if (!existsSync(noticesFilePath)) {
    throw new Error(`Missing THIRD_PARTY_NOTICES.md at workspace root`);
  }
  const repoNotices = readFileSync(noticesFilePath, 'utf-8');
  if (!repoNotices.includes('Session Insight')) {
    throw new Error(`THIRD_PARTY_NOTICES.md must contain Session Insight attribution section.`);
  }

  // Notices must be copied inside the unpacked package and carry the section.
  if (typeof packagedNotices !== 'string' || !packagedNotices.includes('Session Insight')) {
    throw new Error(
      `[PREFLIGHT REJECTED] Packaged THIRD_PARTY_NOTICES.md is missing or lacks the Session Insight section.`
    );
  }

  if (!isExplicitlyLicensed) {
    console.warn(
      `[WARNING: LOCAL DEBUG ONLY] License exception via --allow-unlicensed-for-local-debug. ` +
      `This package is UNLICENSED and MUST NOT be released or distributed externally; ` +
      `version/hash verification is still fully enforced.`
    );
  }

  return { isExplicitlyLicensed };
}

/**
 * Packs apps/server using npm pack into a temporary directory and extracts it.
 */
export function packAndExtract(tarballPath) {
  const tempExtractDir = mkdtempSync(join(tmpdir(), 'dutydeck-pack-verify-'));

  let finalTarball = tarballPath;
  let generatedTarball = false;
  if (!finalTarball) {
    console.log(`[verify-package] Packing @byted/dutydeck in ${serverDir}...`);
    const packOutput = execFileSync('npm', ['pack'], {
      cwd: serverDir,
      encoding: 'utf-8'
    }).trim();
    const lines = packOutput.split('\n').map(l => l.trim()).filter(Boolean);
    const tarballFileName = lines[lines.length - 1];
    if (!tarballFileName || !tarballFileName.endsWith('.tgz')) {
      throw new Error(`npm pack failed to report tarball filename. Output: ${packOutput}`);
    }
    finalTarball = join(serverDir, tarballFileName);
    generatedTarball = true;
  }

  console.log(`[verify-package] Extracting tarball ${finalTarball} to ${tempExtractDir}...`);
  execFileSync('tar', ['-xzf', finalTarball, '-C', tempExtractDir]);

  return {
    tempExtractDir,
    packageDir: join(tempExtractDir, 'package'),
    tarballPath: finalTarball,
    generatedTarball
  };
}

/**
 * Recursively list all files in directory.
 */
export function listDirectoryFiles(dir, baseDir = dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listDirectoryFiles(fullPath, baseDir));
    } else {
      const stat = statSync(fullPath);
      results.push({
        path: relative(baseDir, fullPath),
        size: stat.size,
        mode: (stat.mode & 0o777).toString(8)
      });
    }
  }
  return results;
}

/**
 * Lexically and physically resolves a target-relative path, guaranteeing it stays inside engineDir.
 */
function resolveConfinedTargetPath(engineDir, binRelativePath, target) {
  if (!binRelativePath || typeof binRelativePath !== 'string' || isAbsolute(binRelativePath)) {
    throw new Error(`[PREFLIGHT REJECTED] Target path for ${target} must be a non-empty relative path: ${binRelativePath}`);
  }
  // Normalize and reject any ".." segment outright
  const segments = binRelativePath.split('/');
  if (segments.some(seg => seg === '..')) {
    throw new Error(`[PREFLIGHT REJECTED] Target path for ${target} escapes engine assets directory: ${binRelativePath}`);
  }

  const realEngineDir = realpathSync(engineDir);
  const binAbsolutePath = resolve(engineDir, binRelativePath);
  const realBinPath = realpathSync(binAbsolutePath);
  const rel = relative(realEngineDir, realBinPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`[PREFLIGHT REJECTED] Target path for ${target} resolves outside engine assets directory: ${binRelativePath}`);
  }
  return { binAbsolutePath, realBinPath };
}

/**
 * Strictly compares the packaged manifest against the repository lock.
 * Covers commit pin, versions and every target hash — replacing manifest+binary together must not pass.
 */
export function assertManifestMatchesLock(manifest, repoLock) {
  if (manifest.schemaVersion !== 1) {
    throw new Error(`[PREFLIGHT REJECTED] Packaged manifest schemaVersion must be 1 (got: ${manifest.schemaVersion})`);
  }
  if (!SHA40_REGEX.test(manifest.engineCommit || '')) {
    throw new Error(`[PREFLIGHT REJECTED] Packaged manifest engineCommit must be a 40-hex commit (got: "${manifest.engineCommit}")`);
  }
  if (manifest.engineCommit !== repoLock.engineCommit) {
    throw new Error(
      `[PREFLIGHT REJECTED] Packaged manifest engineCommit (${manifest.engineCommit}) does not match repo lock (${repoLock.engineCommit}).`
    );
  }
  if (manifest.upstreamCommit !== repoLock.upstreamCommit) {
    throw new Error(
      `[PREFLIGHT REJECTED] Packaged manifest upstreamCommit (${manifest.upstreamCommit}) does not match repo lock (${repoLock.upstreamCommit}).`
    );
  }
  if (manifest.versions?.engineVersion !== manifest.engineCommit) {
    throw new Error(
      `[PREFLIGHT REJECTED] Packaged manifest versions.engineVersion (${manifest.versions?.engineVersion}) must equal engineCommit (${manifest.engineCommit}).`
    );
  }
  for (const key of ['schemaVersion', 'parserVersion', 'metricVersion', 'redactionVersion']) {
    if (manifest.versions?.[key] !== repoLock.versions?.[key]) {
      throw new Error(
        `[PREFLIGHT REJECTED] Packaged manifest versions.${key} (${manifest.versions?.[key]}) does not match repo lock (${repoLock.versions?.[key]}).`
      );
    }
  }
  for (const target of REQUIRED_TARGETS) {
    const manifestHash = manifest.targets?.[target]?.sha256;
    const lockHash = repoLock.platforms?.[target]?.sha256;
    if (!SHA256_REGEX.test(manifestHash || '')) {
      throw new Error(`[PREFLIGHT REJECTED] Packaged manifest has invalid sha256 for ${target}: "${manifestHash}"`);
    }
    if (manifestHash !== lockHash) {
      throw new Error(
        `[PREFLIGHT REJECTED] Packaged manifest sha256 for ${target} (${manifestHash}) does not match repo lock (${lockHash}).`
      );
    }
  }
}

/**
 * Runs the host target binary under PATH='' with isolated HOME/TMPDIR/private cwd.
 * Full frozen-Zod validation of version handshake and a real non-empty analyze round-trip.
 */
function runHostRuntimeChecks({ binAbsolutePath, manifest, fixturePath = null }) {
  const isolatedTmp = mkdtempSync(join(tmpdir(), 'dutydeck-engine-run-'));
  try {
    const testEnv = {
      PATH: '',
      TMPDIR: isolatedTmp,
      HOME: isolatedTmp
    };
    const spawnOptions = {
      cwd: isolatedTmp,
      env: testEnv,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      maxBuffer: 64 * 1024,
      killSignal: 'SIGKILL'
    };

    // A. version --json handshake, exit code must be 0, output must pass frozen engineVersionInfoSchema
    let versionInfo;
    try {
      const versionOut = execFileSync(binAbsolutePath, ['version', '--json'], spawnOptions);
      versionInfo = engineVersionInfoSchema.parse(JSON.parse(versionOut.trim()));
    } catch (err) {
      throw new Error(`Host binary failed version --json (exit 0 required) under PATH='': ${err.message}`);
    }

    if (
      versionInfo.engineVersion !== manifest.versions.engineVersion ||
      versionInfo.parserVersion !== manifest.versions.parserVersion ||
      versionInfo.metricVersion !== manifest.versions.metricVersion
    ) {
      throw new Error(
        `Handshake versions do not match packaged manifest: got ${JSON.stringify(versionInfo)} vs manifest ${JSON.stringify(manifest.versions)}`
      );
    }

    // B. analyze --format json against a non-empty sample (supports synthetic log or external sanitized fixture)
    let sampleContent = SYNTHETIC_CODEX_LOG;
    let expectedNativeSessionId = 'sess_packverify_1';

    if (fixturePath) {
      if (!existsSync(fixturePath)) {
        throw new Error(`Specified fixture file not found: ${fixturePath}`);
      }
      sampleContent = readFileSync(fixturePath, 'utf-8');
      if (!sampleContent.trim()) {
        throw new Error(`Specified fixture file is empty: ${fixturePath}`);
      }
      // Infer expected native session ID from the first JSON line
      try {
        const firstLine = sampleContent.trim().split('\n')[0];
        const parsedMeta = JSON.parse(firstLine);
        if (parsedMeta.payload?.id) {
          expectedNativeSessionId = parsedMeta.payload.id;
        } else if (parsedMeta.sessionId) {
          expectedNativeSessionId = parsedMeta.sessionId;
        } else if (parsedMeta.id) {
          expectedNativeSessionId = parsedMeta.id;
        }
      } catch {
        // Fallback to default
      }
    }

    const sampleSnapshotPath = join(isolatedTmp, 'sample_session.jsonl');
    writeFileSync(sampleSnapshotPath, sampleContent, 'utf-8');
    const sampleBytes = Buffer.byteLength(sampleContent);
    const sampleSha = computeBufferSha256(Buffer.from(sampleContent));

    if (sampleBytes <= 0) {
      throw new Error('Sample fixture bytes must be positive');
    }

    const requestId = randomUUID();
    const analyzeRequest = {
      schemaVersion: 1,
      requestId,
      files: [
        {
          sourceKey: 'packverify-primary',
          client: 'codex',
          path: sampleSnapshotPath,
          sha256: sampleSha,
          bytes: sampleBytes,
          expectedNativeSessionId,
          expectedStream: { kind: 'main', nativeAgentId: null }
        }
      ],
      limits: { maxLineBytes: 4194304, maxTraceEvents: 20000 }
    };

    let analyzeResult;
    try {
      const analyzeOut = execFileSync(binAbsolutePath, ['analyze', '--format', 'json'], {
        ...spawnOptions,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
        input: JSON.stringify(analyzeRequest)
      });
      analyzeResult = analyzeFilesResultSchema.parse(JSON.parse(analyzeOut.trim()));
    } catch (err) {
      throw new Error(
        `Host binary analyze --format json failed or returned output violating the frozen schema ` +
        `(exit 0 + valid non-empty result required): ${err.message}`
      );
    }

    // Exact requestId echo — an engine that ignores the request must not pass
    if (analyzeResult.requestId !== requestId) {
      throw new Error(`Analyze result requestId mismatch: expected ${requestId}, got ${analyzeResult.requestId}`);
    }
    // Versions must match handshake/manifest exactly
    if (
      analyzeResult.engineVersion !== versionInfo.engineVersion ||
      analyzeResult.parserVersion !== versionInfo.parserVersion ||
      analyzeResult.metricVersion !== versionInfo.metricVersion
    ) {
      throw new Error(
        `Analyze result versions do not match handshake: ${JSON.stringify({
          result: [analyzeResult.engineVersion, analyzeResult.parserVersion, analyzeResult.metricVersion],
          handshake: [versionInfo.engineVersion, versionInfo.parserVersion, versionInfo.metricVersion]
        })}`
      );
    }

    // Request had exactly 1 file: result files array must contain exactly 1 entry
    if (!Array.isArray(analyzeResult.files) || analyzeResult.files.length !== 1) {
      throw new Error(`Analyze result files array must contain exactly 1 file (got: ${analyzeResult.files?.length})`);
    }

    const file = analyzeResult.files[0];
    // Every file must be ok/partial with a real native id — error files or fabricated empty results are rejected
    if (file.status === 'error') {
      throw new Error(`Analyze file status is "error" (errorCode=${file.errorCode}); successful verification requires ok/partial`);
    }
    if (!file.nativeSessionId) {
      throw new Error('Analyze file result lacks non-empty nativeSessionId');
    }
    if (file.nativeSessionId !== expectedNativeSessionId) {
      throw new Error(
        `nativeSessionId mismatch: expected ${expectedNativeSessionId}, got ${file.nativeSessionId}`
      );
    }
    // Exact source/hash/stream binding — {files:[{}]} style fabricated results cannot pass
    if (file.sourceKey !== 'packverify-primary') {
      throw new Error(`sourceKey mismatch: got ${file.sourceKey}`);
    }
    if (file.client !== 'codex') {
      throw new Error(`client mismatch: got ${file.client}`);
    }
    if (file.sha256 !== sampleSha) {
      throw new Error(`file sha256 mismatch: expected ${sampleSha}, got ${file.sha256}`);
    }
    if (file.streamIdentity.kind !== 'main' || file.streamIdentity.nativeAgentId !== null) {
      throw new Error(`streamIdentity mismatch: ${JSON.stringify(file.streamIdentity)}`);
    }

    // Non-empty sample coverage verification: must demonstrate positive lines processed
    if (!file.coverage || typeof file.coverage !== 'object') {
      throw new Error('Analyze file result lacks valid coverage object');
    }
    if (typeof file.coverage.rawLines !== 'number' || file.coverage.rawLines <= 0) {
      throw new Error(`Analyze file coverage.rawLines must be a positive integer (got: ${file.coverage.rawLines})`);
    }
    if (typeof file.coverage.parsedLines !== 'number' || file.coverage.parsedLines <= 0) {
      throw new Error(`Analyze file coverage.parsedLines must be a positive integer (got: ${file.coverage.parsedLines})`);
    }
  } finally {
    rmSync(isolatedTmp, { recursive: true, force: true });
  }
}

export function verifyPackageDirectory(packageRoot, options = {}) {
  console.log(`[verify-package] Verifying package root: ${packageRoot}`);

  const effectiveLockPath = options.paths?.lockPath || lockPath;
  const repoLock = readRepoLock(effectiveLockPath);

  // Locate session-insight assets inside unpacked package
  const engineDir = join(packageRoot, 'dist/assets/session-insight');
  if (!existsSync(engineDir)) {
    throw new Error(`Engine assets directory missing in package: ${engineDir}`);
  }

  const packagedNoticesPath = join(engineDir, 'THIRD_PARTY_NOTICES.md');
  const manifestPath = join(engineDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json missing in package assets: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new Error(`manifest.json in package is corrupt: ${err.message}`);
  }

  // All 4 targets must be declared before they are compared against the repo lock
  for (const target of REQUIRED_TARGETS) {
    if (!manifest.targets?.[target]) {
      throw new Error(`[PREFLIGHT REJECTED] manifest.json is missing required target architecture: ${target}`);
    }
  }

  // Manifest must fully agree with repo lock (commit, versions, all four hashes) before anything runs
  assertManifestMatchesLock(manifest, repoLock);

  // License metadata must be in packaged manifest + packaged notices; local flag is license exception only
  const packagedNotices = existsSync(packagedNoticesPath)
    ? readFileSync(packagedNoticesPath, 'utf-8')
    : null;
  const licenseCheck = verifyRedistributionLicense(repoLock, manifest, packagedNotices, options);

  const targetReport = {};
  const hostPlatformArch = getHostPlatformArch();

  for (const target of REQUIRED_TARGETS) {
    const targetEntry = manifest.targets[target];
    const { binAbsolutePath } = resolveConfinedTargetPath(engineDir, targetEntry.path, target);

    if (!existsSync(binAbsolutePath)) {
      throw new Error(`[PREFLIGHT REJECTED] Target binary for ${target} missing at: ${binAbsolutePath}`);
    }

    const stat = statSync(binAbsolutePath);
    if (!stat.isFile()) {
      throw new Error(`[PREFLIGHT REJECTED] Target binary for ${target} is not a regular file: ${binAbsolutePath}`);
    }

    // Exact stat mode verification: must be 0755
    const exactMode = stat.mode & 0o777;
    if (exactMode !== 0o755) {
      throw new Error(
        `[PREFLIGHT REJECTED] Binary for ${target} mode is 0${exactMode.toString(8)}, expected 0755.`
      );
    }

    try {
      accessSync(binAbsolutePath, constants.X_OK);
    } catch {
      throw new Error(`[PREFLIGHT REJECTED] Binary for ${target} lacks executable permission (X_OK).`);
    }

    // Verify SHA256 against packaged manifest (already proven equal to repo lock)
    const actualSha = computeSha256(binAbsolutePath);
    if (actualSha.toLowerCase() !== targetEntry.sha256.toLowerCase()) {
      throw new Error(
        `[PREFLIGHT REJECTED] SHA256 mismatch for ${target}: expected ${targetEntry.sha256}, got ${actualSha}`
      );
    }

    if (target === hostPlatformArch) {
      console.log(`[verify-package] Running host execution check for ${target} with PATH='' (no Go)...`);
      runHostRuntimeChecks({
        binAbsolutePath,
        manifest,
        fixturePath: options.fixture || null
      });
      targetReport[target] = {
        status: options.isMockBinary
          ? 'mock plumbing verified (shell script packaging; NOT real Go runtime)'
          : 'runtime verified (real Go binary: version + non-empty analyze under PATH=\'\')',
        path: targetEntry.path,
        size: stat.size,
        mode: `0${exactMode.toString(8)}`,
        sha256: actualSha
      };
    } else {
      targetReport[target] = {
        status: `runtime unverified (cross-architecture, host is ${hostPlatformArch || 'unknown'})`,
        path: targetEntry.path,
        size: stat.size,
        mode: `0${exactMode.toString(8)}`,
        sha256: actualSha
      };
    }
  }

  const fileManifest = listDirectoryFiles(packageRoot);

  return {
    licenseCheck,
    targets: targetReport,
    manifest,
    fileManifest
  };
}

export async function runVerify(options) {
  let extractInfo = null;
  try {
    let packageDir;
    if (options.unpackedDir) {
      packageDir = options.unpackedDir;
    } else if (options.skipPack) {
      packageDir = serverDir;
    } else {
      extractInfo = packAndExtract(options.tarball);
      packageDir = extractInfo.packageDir;
    }

    const report = verifyPackageDirectory(packageDir, options);

    console.log('\n======================================================');
    console.log(' SESSION INSIGHT PACKAGE PREFLIGHT VERIFICATION REPORT');
    console.log('======================================================');
    console.log(`Distribution License Status: ${report.licenseCheck.isExplicitlyLicensed ? 'LICENSED FOR REDISTRIBUTION' : 'UNLICENSED (LOCAL DEBUG ONLY — NOT RELEASABLE)'}`);
    console.log('\nTarget Platforms & Runtime Verification Status:');
    for (const [platform, info] of Object.entries(report.targets)) {
      console.log(`  - [${platform}]: ${info.status}`);
      console.log(`      path: ${info.path}, size: ${info.size}B, mode: ${info.mode}`);
      console.log(`      sha256: ${info.sha256}`);
    }

    console.log('\nSession-Insight Package Assets List:');
    const assetFiles = report.fileManifest.filter(f => f.path.includes('session-insight'));
    for (const f of assetFiles) {
      console.log(`  - ${f.path} (${f.mode}, ${f.size}B)`);
    }
    console.log('======================================================\n');
    console.log('Preflight verification passed.');

    return report;
  } finally {
    if (extractInfo?.tempExtractDir) {
      rmSync(extractInfo.tempExtractDir, { recursive: true, force: true });
    }
    if (extractInfo?.generatedTarball && existsSync(extractInfo.tarballPath)) {
      rmSync(extractInfo.tarballPath, { force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const options = parseArgs(process.argv.slice(2));
  try {
    await runVerify(options);
  } catch (err) {
    console.error(`\n[PREFLIGHT FAILED] ${err.message}\n`);
    process.exit(1);
  }
}
