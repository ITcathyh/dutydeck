#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workspaceRoot = resolve(__dirname, '..');
const lockFilePath = resolve(workspaceRoot, 'tools/session-insight-engine/engine.lock.json');
const defaultOutDir = resolve(workspaceRoot, 'apps/server/.engine-build');

const ALL_PLATFORMS = ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'];
const SHA40_REGEX = /^[a-f0-9]{40}$/i;
const SHA256_REGEX = /^[a-f0-9]{64}$/i;

function printUsageAndExit(code = 1) {
  console.log(`
Usage:
  node scripts/build-session-insight.mjs --source <upstream-path> [options]

Required:
  --source <path>         Path to upstream session-insight repository/worktree

Options:
  --platform <platform>   Target platform (linux-amd64, linux-arm64, darwin-amd64, darwin-arm64)
                          Can be specified multiple times. Defaults to all 4 platforms.
  --record-hashes         Record newly compiled binary hashes into engine.lock.json (controller only, requires clean pinned commit)
  --help, -h              Show this help message
`);
  process.exit(code);
}

export function parseArgs(args) {
  const options = {
    source: null,
    platforms: [],
    outDir: defaultOutDir,
    recordHashes: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printUsageAndExit(0);
    } else if (arg === '--source') {
      options.source = args[++i];
    } else if (arg.startsWith('--source=')) {
      options.source = arg.slice('--source='.length);
    } else if (arg === '--platform') {
      options.platforms.push(args[++i]);
    } else if (arg.startsWith('--platform=')) {
      options.platforms.push(arg.slice('--platform='.length));
    } else if (arg === '--record-hashes') {
      options.recordHashes = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.platforms.length === 0) {
    options.platforms = [...ALL_PLATFORMS];
  }

  return options;
}

export function computeFileSha256(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export function readEngineLock(lockPath = lockFilePath) {
  if (!existsSync(lockPath)) {
    throw new Error(`engine.lock.json not found at: ${lockPath}`);
  }
  const content = readFileSync(lockPath, 'utf-8');
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`engine.lock.json is corrupt or invalid JSON: ${err.message}`);
  }
}

export function writeEngineLock(lockData, lockPath = lockFilePath) {
  writeFileSync(lockPath, JSON.stringify(lockData, null, 2) + '\n', 'utf-8');
}

/**
 * Validates lock structure and constraints before any build or clean action.
 */
export function validateLockStructure(lock, options = {}) {
  if (!lock || typeof lock !== 'object') {
    throw new Error('engine.lock.json root must be an object');
  }

  const upstreamCommit = lock.upstreamCommit?.trim();
  if (!upstreamCommit || !SHA40_REGEX.test(upstreamCommit)) {
    throw new Error(`engine.lock.json specifies invalid upstreamCommit ("${upstreamCommit}"). Expected 40-hex commit.`);
  }

  const engineCommit = lock.engineCommit?.trim();
  if (!engineCommit || !SHA40_REGEX.test(engineCommit)) {
    throw new Error(
      `engine.lock.json specifies unpinned or invalid engineCommit ("${engineCommit}"). ` +
      `Strict reproducible build requires a 40-character hexadecimal git commit pin.`
    );
  }

  if (!lock.versions || typeof lock.versions !== 'object') {
    throw new Error('engine.lock.json must contain versions object');
  }
  if (lock.versions.schemaVersion !== 1) {
    throw new Error(`engine.lock.json versions.schemaVersion must be 1 (got: ${lock.versions.schemaVersion})`);
  }
  // engineVersion is the pinned commit; a separate placeholder must never reach a build.
  if (lock.versions.engineVersion !== engineCommit) {
    throw new Error(
      `engine.lock.json versions.engineVersion ("${lock.versions.engineVersion}") must equal engineCommit ("${engineCommit}")`
    );
  }
  // versions.engineVersion is derived from the pinned engineCommit; a separate field must not diverge.
  for (const key of ['parserVersion', 'metricVersion', 'redactionVersion']) {
    const value = lock.versions[key];
    if (!value || typeof value !== 'string' || value.startsWith('PENDING_')) {
      throw new Error(`engine.lock.json versions.${key} must be a concrete pinned value (got: "${value}")`);
    }
  }

  if (!lock.build || typeof lock.build !== 'object') {
    throw new Error('engine.lock.json must contain build object');
  }
  if (lock.build.cgoEnabled !== 0) {
    throw new Error(`engine.lock.json must specify build.cgoEnabled: 0 (got: ${lock.build.cgoEnabled})`);
  }
  if (lock.build.goToolchain !== 'go1.26.1') {
    throw new Error(`engine.lock.json must specify build.goToolchain: "go1.26.1" (got: "${lock.build.goToolchain}")`);
  }
  if (!Array.isArray(lock.build.flags) || lock.build.flags.length === 0) {
    throw new Error('engine.lock.json must specify build.flags array');
  }
  if (!lock.build.flags.includes('-trimpath') || !lock.build.flags.includes('-buildvcs=false')) {
    throw new Error('engine.lock.json build.flags must include -trimpath and -buildvcs=false');
  }
  // ldflags symbols declared in the lock are the single source of truth for what gets injected.
  // All three symbols (EngineVersion, ParserVersion, MetricVersion) must be declared with exact value sources.
  if (!lock.build.ldflagsSymbols || typeof lock.build.ldflagsSymbols !== 'object') {
    throw new Error('engine.lock.json must specify build.ldflagsSymbols object');
  }
  const REQUIRED_LDFLAGS_SYMBOLS = {
    'main.EngineVersion': 'engineCommit',
    'main.ParserVersion': 'versions.parserVersion',
    'main.MetricVersion': 'versions.metricVersion'
  };
  const lockSymbols = Object.keys(lock.build.ldflagsSymbols);
  const requiredSymbols = Object.keys(REQUIRED_LDFLAGS_SYMBOLS);

  for (const sym of requiredSymbols) {
    if (!(sym in lock.build.ldflagsSymbols)) {
      throw new Error(`engine.lock.json build.ldflagsSymbols must declare "${sym}"`);
    }
    const expectedSource = REQUIRED_LDFLAGS_SYMBOLS[sym];
    const actualSource = lock.build.ldflagsSymbols[sym];
    if (actualSource !== expectedSource) {
      throw new Error(
        `engine.lock.json build.ldflagsSymbols["${sym}"] value source mismatch: expected "${expectedSource}", got "${actualSource}"`
      );
    }
  }
  for (const sym of lockSymbols) {
    if (!(sym in REQUIRED_LDFLAGS_SYMBOLS)) {
      throw new Error(
        `engine.lock.json build.ldflagsSymbols declares unsupported symbol "${sym}". Allowed: ${requiredSymbols.join(', ')}`
      );
    }
  }

  if (!lock.platforms || typeof lock.platforms !== 'object') {
    throw new Error('engine.lock.json must contain platforms object');
  }

  // When not in recordHashes bootstrap mode, every target being built must have a valid pinned 64-hex SHA256
  if (!options.recordHashes) {
    const platformsToCheck = options.platforms || ALL_PLATFORMS;
    for (const p of platformsToCheck) {
      const pHash = lock.platforms[p]?.sha256?.trim();
      if (!pHash || !SHA256_REGEX.test(pHash)) {
        throw new Error(
          `Platform "${p}" has unpinned or invalid sha256 in engine.lock.json ("${pHash}"). ` +
          `Normal build strictly requires a pinned 64-character sha256 hash. ` +
          `Use explicit --record-hashes on a clean pinned commit to bootstrap hashes.`
        );
      }
    }
  }
}

/**
 * Strictly verifies upstream git worktree state and commit pin.
 * No bypass flags allowed.
 */
export function verifyUpstreamGit(sourceDir, lock) {
  if (!sourceDir || !existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  // 1. Verify it's inside a git worktree
  try {
    const isGit = execFileSync('git', ['-C', sourceDir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (isGit !== 'true') {
      throw new Error(`Not inside a git worktree: ${sourceDir}`);
    }
  } catch (err) {
    throw new Error(`Failed to verify git repository at ${sourceDir}: ${err.message}`);
  }

  // 2. Strict clean check: no untracked, no unstaged, no staged changes
  const statusOutput = execFileSync('git', ['-C', sourceDir, 'status', '--porcelain'], {
    encoding: 'utf-8'
  }).trim();
  if (statusOutput.length > 0) {
    throw new Error(
      `Upstream repository is not clean. Reproducible build strictly requires a clean git worktree.\n` +
      `Pending changes:\n${statusOutput}`
    );
  }

  // 3. Strict commit pin check (40-hex sha required, PENDING_CONTROLLER_PIN rejected)
  const lockedCommit = lock.engineCommit?.trim();
  if (!lockedCommit || !SHA40_REGEX.test(lockedCommit)) {
    throw new Error(
      `engine.lock.json specifies unpinned or invalid engineCommit ("${lockedCommit}"). ` +
      `Strict reproducible build requires a 40-character hexadecimal git commit pin.`
    );
  }

  const headCommit = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8'
  }).trim();

  if (lockedCommit.toLowerCase() !== headCommit.toLowerCase()) {
    throw new Error(
      `Source HEAD (${headCommit}) does not match locked engineCommit (${lockedCommit}).`
    );
  }

  return headCommit;
}

/**
 * Validates compiler toolchain constraints (exact go1.26.1, CGO_ENABLED=0, GOWORK=off, GOFLAGS cleared).
 */
export function verifyCompilerToolchain(lock) {
  if (lock.build?.cgoEnabled !== 0) {
    throw new Error(`engine.lock.json must specify build.cgoEnabled: 0 (got: ${lock.build?.cgoEnabled})`);
  }
  const requiredToolchain = lock.build?.goToolchain || 'go1.26.1';
  if (requiredToolchain !== 'go1.26.1') {
    throw new Error(`engine.lock.json must specify build.goToolchain: "go1.26.1" (got: "${requiredToolchain}")`);
  }

  const env = { ...process.env };
  delete env.GOFLAGS;
  env.GOWORK = 'off';
  env.CGO_ENABLED = '0';
  env.GOTOOLCHAIN = 'go1.26.1';

  try {
    const versionOut = execFileSync('go', ['version'], {
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    // Output format: "go version go1.26.1 linux/amd64"
    const parts = versionOut.split(/\s+/);
    const goVer = parts[2];
    if (goVer !== 'go1.26.1') {
      throw new Error(`Host go compiler does not match exact "go1.26.1" (got: "${goVer}", full: "${versionOut}")`);
    }

    const goEnvOut = execFileSync('go', ['env', 'GOVERSION'], {
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (goEnvOut !== 'go1.26.1') {
      throw new Error(`go env GOVERSION is "${goEnvOut}", but exact "go1.26.1" is required.`);
    }
  } catch (err) {
    throw new Error(`Failed to verify Go toolchain: ${err.message}`);
  }
}

/**
 * Validates outDir safety to ensure accidental deletion of root or source code is impossible.
 */
export function validateOutDirSafety(outDir, sourceDir) {
  const resolvedOut = resolve(outDir);
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedTmp = resolve(tmpdir());

  // 1. Filesystem root check
  if (resolvedOut === resolve('/')) {
    throw new Error(`Unsafe outDir: outDir cannot be the filesystem root: ${resolvedOut}`);
  }

  // 2. Reject tmpdir root itself (deleting it deletes the entire /tmp directory)
  if (resolvedOut === resolvedTmp) {
    throw new Error(`Unsafe outDir: outDir cannot be the temporary directory root: ${resolvedOut}`);
  }

  // 3. Workspace root check and workspace root ancestor check
  if (resolvedOut === resolvedRoot) {
    throw new Error(`Unsafe outDir: outDir cannot be the workspace root: ${resolvedOut}`);
  }
  const relToRoot = relative(resolvedOut, resolvedRoot);
  if (relToRoot !== '' && !relToRoot.startsWith('..') && !isAbsolute(relToRoot)) {
    throw new Error(`Unsafe outDir: outDir is an ancestor of workspace root: ${resolvedOut}`);
  }

  // 4. Source dir check and source dir ancestor check
  if (sourceDir) {
    const resolvedSource = resolve(sourceDir);
    if (resolvedOut === resolvedSource) {
      throw new Error(`Unsafe outDir: outDir cannot be the source directory: ${resolvedOut}`);
    }
    const relToSource = relative(resolvedOut, resolvedSource);
    if (relToSource !== '' && !relToSource.startsWith('..') && !isAbsolute(relToSource)) {
      throw new Error(`Unsafe outDir: outDir is an ancestor of source directory: ${resolvedOut}`);
    }
  }

  // 5. Staging path restriction: strictly allow ONLY defaultOutDir or a managed sub-directory inside tmpdir
  const isDefault = resolvedOut === defaultOutDir;
  const relToTmp = relative(resolvedTmp, resolvedOut);
  const isSubDirOfTmp = relToTmp !== '' && !relToTmp.startsWith('..') && !isAbsolute(relToTmp);

  if (!isDefault && !isSubDirOfTmp) {
    throw new Error(
      `Unsafe outDir: outDir must be default apps/server/.engine-build or a managed sub-directory inside tmpdir: ${resolvedOut}`
    );
  }

  // 6. Realpath verification if directory currently exists (ensures symlinks don't escape)
  if (existsSync(resolvedOut)) {
    try {
      const realOut = realpathSync(resolvedOut);
      if (realOut === resolvedRoot) {
        throw new Error(`Unsafe outDir: outDir realpath resolves to workspace root: ${realOut}`);
      }
      if (realOut === resolvedTmp) {
        throw new Error(`Unsafe outDir: outDir realpath resolves to temporary directory root: ${realOut}`);
      }
      if (sourceDir && realOut === resolve(sourceDir)) {
        throw new Error(`Unsafe outDir: outDir realpath resolves to source directory: ${realOut}`);
      }
    } catch {
      // Ignore if realpath cannot be resolved before directory creation
    }
  }
}

export function buildTargetBinary({
  sourceDir,
  platform,
  outPath,
  lock,
  headCommit
}) {
  const [goos, goarch] = platform.split('-');
  if (!goos || !goarch) {
    throw new Error(`Invalid platform: ${platform}`);
  }

  const goWorkDir = existsSync(join(sourceDir, 'server/go.mod'))
    ? join(sourceDir, 'server')
    : sourceDir;

  // Resolve each declared ldflags symbol from its fixed value source.
  // main.commit is intentionally absent and must never be added back.
  const ldflagsValueSources = {
    engineCommit: headCommit,
    'versions.parserVersion': lock.versions.parserVersion,
    'versions.metricVersion': lock.versions.metricVersion
  };
  const ldflagsParts = ['-s', '-w'];
  for (const [symbol, source] of Object.entries(lock.build.ldflagsSymbols)) {
    if (!(source in ldflagsValueSources)) {
      throw new Error(`Unsupported ldflags value source for ${symbol}: "${source}"`);
    }
    ldflagsParts.push(`-X ${symbol}=${ldflagsValueSources[source]}`);
  }
  const ldflags = ldflagsParts.join(' ');

  // Sanitize environment: fixed toolchain, CGO_ENABLED=0, GOWORK=off, strip GOFLAGS
  const env = { ...process.env };
  delete env.GOFLAGS;
  env.GOWORK = 'off';
  env.GOOS = goos;
  env.GOARCH = goarch;
  env.CGO_ENABLED = '0';
  env.GOTOOLCHAIN = 'go1.26.1';

  mkdirSync(dirname(outPath), { recursive: true });

  // Use lock.build.flags as single source of truth for build flags
  const buildFlags = Array.isArray(lock.build?.flags) ? lock.build.flags : ['-trimpath', '-buildvcs=false'];

  const buildArgs = [
    'build',
    ...buildFlags,
    '-ldflags',
    ldflags,
    '-o',
    outPath,
    './cmd/session-insight'
  ];

  execFileSync('go', buildArgs, {
    cwd: goWorkDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Ensure executable permissions 0755; fail if cannot set
  chmodSync(outPath, 0o755);
  const st = statSync(outPath);
  if ((st.mode & 0o777) !== 0o755) {
    throw new Error(`Failed to set exact mode 0755 on ${outPath} (got 0${(st.mode & 0o777).toString(8)})`);
  }

  const sha256 = computeFileSha256(outPath);
  const bytes = st.size;

  return {
    path: `${platform}/session-insight`,
    sha256,
    bytes
  };
}

export async function runBuild(options) {
  if (!options.source) {
    throw new Error('--source <upstream-path> is required.');
  }

  const outDir = options.outDir || defaultOutDir;
  validateOutDirSafety(outDir, options.source);

  const lock = readEngineLock();
  console.log(`[build-session-insight] Reading engine.lock.json...`);
  console.log(`[build-session-insight] Target platforms: ${options.platforms.join(', ')}`);

  // 1. Strict validation of lock, git worktree, and compiler toolchain
  // This runs BEFORE clearing outDir, protecting existing assets from dirty/invalid builds
  validateLockStructure(lock, options);
  const headCommit = verifyUpstreamGit(options.source, lock);
  verifyCompilerToolchain(lock);
  console.log(`[build-session-insight] Upstream commit verified: ${headCommit}`);

  // 2. Clean and create staging outDir only after all parameter and pin checks pass
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const manifestTargets = {};
  const updatedPlatforms = { ...lock.platforms };

  for (const platform of options.platforms) {
    if (!ALL_PLATFORMS.includes(platform)) {
      throw new Error(`Unsupported platform: ${platform}. Allowed: ${ALL_PLATFORMS.join(', ')}`);
    }

    const binaryOutPath = join(outDir, platform, 'session-insight');
    console.log(`[build-session-insight] Compiling ${platform} -> ${binaryOutPath}...`);

    const targetInfo = buildTargetBinary({
      sourceDir: options.source,
      platform,
      outPath: binaryOutPath,
      lock,
      headCommit
    });

    // Hash check: if not in recordHashes mode, strictly compare with lock
    const expectedHash = lock.platforms?.[platform]?.sha256;
    if (!options.recordHashes) {
      if (expectedHash.toLowerCase() !== targetInfo.sha256.toLowerCase()) {
        throw new Error(
          `Compiled binary hash mismatch for ${platform}! Expected: ${expectedHash}, Got: ${targetInfo.sha256}`
        );
      }
    } else {
      updatedPlatforms[platform] = { sha256: targetInfo.sha256 };
    }

    manifestTargets[platform] = targetInfo;
    console.log(`[build-session-insight] Built ${platform}: sha256=${targetInfo.sha256} size=${targetInfo.bytes}B`);
  }

  // If recordHashes is set by controller on clean pinned commit, update engine.lock.json
  if (options.recordHashes) {
    lock.platforms = updatedPlatforms;
    writeEngineLock(lock);
    console.log(`[build-session-insight] Recorded compiled platform hashes to engine.lock.json.`);
  }

  // Deterministic manifest without build timestamps or host-specific paths
  const manifest = {
    schemaVersion: 1,
    name: lock.name || 'session-insight-engine',
    upstreamCommit: lock.upstreamCommit,
    engineCommit: headCommit,
    versions: {
      schemaVersion: lock.versions.schemaVersion,
      engineVersion: headCommit,
      parserVersion: lock.versions.parserVersion,
      metricVersion: lock.versions.metricVersion,
      redactionVersion: lock.versions.redactionVersion
    },
    redistributionLicensed: lock.redistributionLicensed === true,
    licenseNotice: 'THIRD_PARTY_NOTICES.md#3-session-insight',
    targets: manifestTargets
  };

  const manifestPath = join(outDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`[build-session-insight] Manifest written to: ${manifestPath}`);

  return manifest;
}

// When executed directly from CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    await runBuild(options);
    console.log('[build-session-insight] Done.');
  } catch (err) {
    console.error(`[build-session-insight] Build failed: ${err.message}`);
    process.exit(1);
  }
}
