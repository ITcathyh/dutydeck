import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engineVersionInfoSchema, type EngineVersionInfo } from '@dutydeck/shared';
import { SESSION_INSIGHT_ENGINE_VERSIONS } from './session-insight-analyzer.js';

export type { EngineVersionInfo };

export interface AvailableEngine {
  status: 'available';
  entrypoint: string;
  execArgv: string[];
  versions: EngineVersionInfo;
}

export interface UnavailableEngine {
  status: 'unavailable';
  code: 'ENGINE_NOT_FOUND' | 'HANDSHAKE_FAILED' | 'VERSION_MISMATCH';
  reason: string;
}

export type ResolvedEngine = AvailableEngine | UnavailableEngine;

export interface ResolveEngineOptions {
  assetsDir?: string;
  handshakeTimeoutMs?: number;
}

export function resolveAssetDirectory(explicitAssetsDir?: string): string {
  return resolve(explicitAssetsDir ?? resolve(dirname(fileURLToPath(import.meta.url)), 'assets/session-insight'));
}

/** Run the bundled script with this runtime, without PATH lookup or inherited Node options. */
export function executeEngineHandshake(
  entrypoint: string,
  execArgv: string[] = [],
  timeoutMs: number = 3000
): Promise<EngineVersionInfo> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(process.execPath, [...execArgv, entrypoint, 'version', '--json'], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      env: { PATH: '' },
      encoding: 'utf-8',
      windowsHide: true
    }, (error, stdout) => {
      if (error) return rejectPromise(error);
      try {
        resolvePromise(engineVersionInfoSchema.parse(JSON.parse(stdout.trim())));
      } catch (err) {
        rejectPromise(err);
      }
    });
  });
}

async function handshakeEngine(
  entrypoint: string,
  execArgv: string[],
  timeoutMs: number
): Promise<ResolvedEngine> {
  let versions: EngineVersionInfo;
  try {
    versions = await executeEngineHandshake(entrypoint, execArgv, timeoutMs);
  } catch {
    return {
      status: 'unavailable', code: 'HANDSHAKE_FAILED',
      reason: 'Session insight analyzer version handshake failed.'
    };
  }

  if (versions.schemaVersion !== SESSION_INSIGHT_ENGINE_VERSIONS.schemaVersion ||
      versions.engineVersion !== SESSION_INSIGHT_ENGINE_VERSIONS.engineVersion ||
      versions.parserVersion !== SESSION_INSIGHT_ENGINE_VERSIONS.parserVersion ||
      versions.metricVersion !== SESSION_INSIGHT_ENGINE_VERSIONS.metricVersion) {
    return {
      status: 'unavailable', code: 'VERSION_MISMATCH',
      reason: 'Session insight analyzer version does not match this installation.'
    };
  }
  return { status: 'available', entrypoint, execArgv, versions };
}

let availableEngineCache: { entrypoint: string; key: string; value: AvailableEngine } | undefined;
const pendingEngineHandshakes = new Map<string, Promise<ResolvedEngine>>();

function engineFingerprint(entrypoint: string): { identity: string; digest: string } {
  return {
    identity: realpathSync(entrypoint),
    digest: createHash('sha256').update(readFileSync(entrypoint)).digest('hex')
  };
}

export async function resolveSessionInsightEngine(
  options: ResolveEngineOptions = {}
): Promise<ResolvedEngine> {
  const modulePath = fileURLToPath(import.meta.url);
  // Only source execution uses tsx. Installed builds resolve exclusively inside dist.
  const development = !options.assetsDir && modulePath.endsWith('.ts');
  const entrypoint = development
    ? resolve(dirname(modulePath), 'session-insight-cli.ts')
    : resolve(resolveAssetDirectory(options.assetsDir), 'cli.js');
  const execArgv = development
    ? ['--conditions=development', '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href]
    : [];
  const cacheable = !development;
  const timeoutMs = options.handshakeTimeoutMs ?? 3000;
  if (cacheable && availableEngineCache && availableEngineCache.entrypoint !== entrypoint) availableEngineCache = undefined;

  const unavailable = (code: UnavailableEngine['code'], reason: string): UnavailableEngine => {
    if (cacheable && availableEngineCache?.entrypoint === entrypoint) availableEngineCache = undefined;
    return { status: 'unavailable', code, reason };
  };
  try {
    if (!existsSync(entrypoint) || !statSync(entrypoint).isFile()) {
      return unavailable('ENGINE_NOT_FOUND', 'Session insight analyzer entrypoint is missing.');
    }
  } catch {
    return unavailable('ENGINE_NOT_FOUND', 'Session insight analyzer entrypoint is missing.');
  }

  let fingerprint: { identity: string; digest: string };
  try {
    fingerprint = engineFingerprint(entrypoint);
  } catch {
    return unavailable('HANDSHAKE_FAILED', 'Session insight analyzer version handshake failed.');
  }
  // Imported TypeScript sources can change without changing their loader or path.
  if (!cacheable) return handshakeEngine(entrypoint, execArgv, timeoutMs);

  const cacheKey = JSON.stringify([entrypoint, fingerprint.identity, execArgv, fingerprint.digest]);
  if (availableEngineCache?.key === cacheKey) return availableEngineCache.value;
  availableEngineCache = undefined;
  const pendingKey = JSON.stringify([cacheKey, timeoutMs]);
  const pending = pendingEngineHandshakes.get(pendingKey);
  if (pending) return pending;

  const handshake = (async () => {
    const resolved = await handshakeEngine(entrypoint, execArgv, timeoutMs);
    if (resolved.status === 'available') {
      try {
        const current = engineFingerprint(entrypoint);
        if (statSync(entrypoint).isFile() && current.identity === fingerprint.identity && current.digest === fingerprint.digest) {
          availableEngineCache = { entrypoint, key: cacheKey, value: resolved };
        }
      } catch { /* A changed or missing entrypoint is retried by the next locator call. */ }
    }
    return resolved;
  })();
  pendingEngineHandshakes.set(pendingKey, handshake);
  try {
    return await handshake;
  } finally {
    pendingEngineHandshakes.delete(pendingKey);
  }
}
