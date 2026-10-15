import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
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

  if (!existsSync(entrypoint) || !statSync(entrypoint).isFile()) {
    return {
      status: 'unavailable', code: 'ENGINE_NOT_FOUND',
      reason: 'Session insight analyzer entrypoint is missing.'
    };
  }

  let versions: EngineVersionInfo;
  try {
    versions = await executeEngineHandshake(entrypoint, execArgv, options.handshakeTimeoutMs ?? 3000);
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
