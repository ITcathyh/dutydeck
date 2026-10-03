import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { engineVersionInfoSchema, type EngineVersionInfo } from '@dutydeck/shared';

// Re-export EngineVersionInfo from shared contract
export type { EngineVersionInfo };

export type EngineResolveStatus = 'available' | 'unavailable';

export type EngineUnavailableCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'ENGINE_NOT_FOUND'
  | 'NOT_EXECUTABLE'
  | 'MANIFEST_NOT_FOUND'
  | 'MANIFEST_CORRUPT'
  | 'HASH_MISMATCH'
  | 'HANDSHAKE_FAILED'
  | 'VERSION_MISMATCH';

export interface AvailableEngine {
  status: 'available';
  binaryPath: string;
  platformArch: string;
  sha256: string;
  manifestPath: string;
  versions: EngineVersionInfo;
}

export interface UnavailableEngine {
  status: 'unavailable';
  code: EngineUnavailableCode;
  reason: string;
  platformArch?: string;
}

export type ResolvedEngine = AvailableEngine | UnavailableEngine;

export interface ResolveEngineOptions {
  assetsDir?: string;
  platform?: string;
  arch?: string;
  handshakeTimeoutMs?: number;
}

const SHA40_HEX_REGEX = /^[a-f0-9]{40}$/i;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;

const manifestTargetSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX_REGEX),
  bytes: z.number().int().nonnegative().optional()
});

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().optional(),
    upstreamCommit: z.string().optional(),
    engineCommit: z.string().regex(SHA40_HEX_REGEX, 'engineCommit must be a 40-character hexadecimal git commit'),
    versions: z.object({
      schemaVersion: z.literal(1),
      engineVersion: z.string().min(1),
      parserVersion: z.string().min(1),
      metricVersion: z.string().min(1),
      redactionVersion: z.string().optional()
    }),
    targets: z.record(manifestTargetSchema)
  })
  .refine(
    data => data.versions.engineVersion === data.engineCommit,
    { message: 'engineVersion must strictly match engineCommit' }
  );

/**
 * Maps Node.js process.platform and process.arch to supported engine platform identifiers.
 * Follows Design Section 8:
 * - Node x64 -> Go amd64
 * - arm64 -> arm64
 * - linux, darwin
 */
export function resolvePlatformArch(
  platform: string = process.platform,
  arch: string = process.arch
): string | null {
  let goos: string | null = null;
  if (platform === 'linux') goos = 'linux';
  else if (platform === 'darwin') goos = 'darwin';
  else return null;

  let goarch: string | null = null;
  if (arch === 'x64') goarch = 'amd64';
  else if (arch === 'arm64') goarch = 'arm64';
  else return null;

  return `${goos}-${goarch}`;
}

export function computeSha256(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolves the assets directory strictly relative to installed module location.
 * No cwd guessing, no environment variable scanning.
 * options.assetsDir is only for explicit injection in tests and local staging.
 */
export function resolveAssetDirectory(explicitAssetsDir?: string): string {
  if (explicitAssetsDir) {
    return resolve(explicitAssetsDir);
  }
  const currentModuleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentModuleDir, 'assets/session-insight');
}

/**
 * Asynchronously executes `session-insight version --json` handshake against the binary.
 * Bounded with small buffer (64 KiB), explicit killSignal: 'SIGKILL' on timeout, and awaits close.
 * Strips environment variables (no credentials passed, no shell).
 */
export function executeEngineHandshake(
  binaryPath: string,
  timeoutMs: number = 3000
): Promise<EngineVersionInfo> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      binaryPath,
      ['version', '--json'],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        env: { PATH: '' },
        encoding: 'utf-8',
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        try {
          const parsed = JSON.parse((stdout || '').trim());
          const versionInfo = engineVersionInfoSchema.parse(parsed);
          resolvePromise(versionInfo);
        } catch (err) {
          rejectPromise(err);
        }
      }
    );
  });
}

/**
 * Fixed locator API for T4 and host services:
 * async resolveSessionInsightEngine(options?: { assetsDir?: string; platform?: string; arch?: string }): Promise<ResolvedEngine>
 *
 * Deterministic, non-blocking, privacy-preserving.
 * Always validates manifest, binary SHA256, and version handshake.
 * Never leaks local paths or raw execution stderr in unavailable responses.
 */
export async function resolveSessionInsightEngine(
  options: ResolveEngineOptions = {}
): Promise<ResolvedEngine> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const platformArch = resolvePlatformArch(platform, arch);

  if (!platformArch) {
    return {
      status: 'unavailable',
      code: 'UNSUPPORTED_PLATFORM',
      reason: 'Current platform and architecture is not supported by session-insight engine.',
      platformArch: `${platform}-${arch}`
    };
  }

  const assetDir = resolveAssetDirectory(options.assetsDir);
  if (!existsSync(assetDir)) {
    return {
      status: 'unavailable',
      code: 'ENGINE_NOT_FOUND',
      reason: 'Session-insight engine distribution assets could not be located.',
      platformArch
    };
  }

  const manifestPath = resolve(assetDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      status: 'unavailable',
      code: 'MANIFEST_NOT_FOUND',
      reason: 'Session-insight engine manifest file is missing.',
      platformArch
    };
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return {
      status: 'unavailable',
      code: 'MANIFEST_CORRUPT',
      reason: 'Session-insight engine manifest is invalid or corrupt.',
      platformArch
    };
  }

  const parsedManifest = manifestSchema.safeParse(manifestRaw);
  if (!parsedManifest.success) {
    return {
      status: 'unavailable',
      code: 'MANIFEST_CORRUPT',
      reason: 'Session-insight engine manifest schema validation failed.',
      platformArch
    };
  }

  const target = parsedManifest.data.targets[platformArch];
  if (!target) {
    return {
      status: 'unavailable',
      code: 'ENGINE_NOT_FOUND',
      reason: 'Target architecture binary is not declared in engine manifest.',
      platformArch
    };
  }

  // 1. Lexical inside check
  if (isAbsolute(target.path)) {
    return {
      status: 'unavailable',
      code: 'MANIFEST_CORRUPT',
      reason: 'Manifest target path must be relative to assets directory.',
      platformArch
    };
  }

  const binaryPath = resolve(assetDir, target.path);
  const relToRoot = relative(assetDir, binaryPath);
  if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
    return {
      status: 'unavailable',
      code: 'MANIFEST_CORRUPT',
      reason: 'Manifest target path resolves outside asset root directory.',
      platformArch
    };
  }

  if (!existsSync(binaryPath)) {
    return {
      status: 'unavailable',
      code: 'ENGINE_NOT_FOUND',
      reason: 'Engine binary executable does not exist.',
      platformArch
    };
  }

  // 2. Realpath check (ensure symlinks do not escape asset directory)
  let realAssetDir: string;
  let realBinPath: string;
  try {
    realAssetDir = realpathSync(assetDir);
    realBinPath = realpathSync(binaryPath);
  } catch {
    return {
      status: 'unavailable',
      code: 'ENGINE_NOT_FOUND',
      reason: 'Failed to resolve canonical path for engine binary.',
      platformArch
    };
  }

  const relReal = relative(realAssetDir, realBinPath);
  if (relReal.startsWith('..') || isAbsolute(relReal)) {
    return {
      status: 'unavailable',
      code: 'MANIFEST_CORRUPT',
      reason: 'Engine binary target resolves outside asset root directory.',
      platformArch
    };
  }

  // 3. Regular file and permission checks
  let stat;
  try {
    stat = statSync(binaryPath);
  } catch {
    return {
      status: 'unavailable',
      code: 'ENGINE_NOT_FOUND',
      reason: 'Failed to access engine binary file attributes.',
      platformArch
    };
  }

  if (!stat.isFile()) {
    return {
      status: 'unavailable',
      code: 'ENGINE_NOT_FOUND',
      reason: 'Engine binary target is not a regular file.',
      platformArch
    };
  }

  // Verify execute permission (0755 / X_OK)
  try {
    accessSync(binaryPath, constants.X_OK);
    if ((stat.mode & 0o111) === 0) {
      throw new Error('missing execution bit');
    }
  } catch {
    return {
      status: 'unavailable',
      code: 'NOT_EXECUTABLE',
      reason: 'Engine binary is not executable (missing execution permissions).',
      platformArch
    };
  }

  // 4. SHA256 checksum verification
  let actualSha256: string;
  try {
    actualSha256 = computeSha256(binaryPath);
  } catch {
    return {
      status: 'unavailable',
      code: 'HASH_MISMATCH',
      reason: 'Failed to compute engine binary checksum.',
      platformArch
    };
  }

  if (actualSha256.toLowerCase() !== target.sha256.toLowerCase()) {
    return {
      status: 'unavailable',
      code: 'HASH_MISMATCH',
      reason: 'Engine binary checksum verification failed.',
      platformArch
    };
  }

  // 5. Version handshake execution
  let versions: EngineVersionInfo;
  try {
    versions = await executeEngineHandshake(binaryPath, options.handshakeTimeoutMs ?? 3000);
  } catch {
    return {
      status: 'unavailable',
      code: 'HANDSHAKE_FAILED',
      reason: 'Engine version handshake execution failed.',
      platformArch
    };
  }

  // 6. Manifest vs Handshake version comparison
  const expectedVersions = parsedManifest.data.versions;
  if (
    versions.schemaVersion !== expectedVersions.schemaVersion ||
    versions.engineVersion !== expectedVersions.engineVersion ||
    versions.parserVersion !== expectedVersions.parserVersion ||
    versions.metricVersion !== expectedVersions.metricVersion
  ) {
    return {
      status: 'unavailable',
      code: 'VERSION_MISMATCH',
      reason: 'Engine version handshake returned versions mismatched with manifest.',
      platformArch
    };
  }

  return {
    status: 'available',
    binaryPath,
    platformArch,
    sha256: actualSha256,
    manifestPath,
    versions
  };
}
