import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_PACKAGE_NAME = 'dutydeck';

export interface DutydeckUpdateOptions {
  distTag?: string;
  force?: boolean;
  drainTimeout?: string;
}

export interface DutydeckUpdateResult {
  action: 'update';
  packageName: string;
  distTag: string;
  previousVersion: string;
  version: string;
  updated: boolean;
  restarted: true;
}

export interface DutydeckUpdateDependencies {
  runNpm(args: string[]): Promise<string>;
  restart(installedEntrypoint: string, options?: { force?: boolean; drainTimeout?: string }): Promise<void>;
  packageName?: string;
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const defaultRunNpm = async (args: string[]) => {
  const { stdout } = await execFileAsync(npmCommand, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return stdout;
};

export function normalizeDistTag(value?: string): string {
  const tag = value?.trim() || 'latest';
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(tag)) {
    throw new Error(`Invalid npm dist-tag: ${JSON.stringify(tag)}. Use a name such as latest, fix, beta, or next.`);
  }
  return tag;
}

const json = (raw: string, label: string): any => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`npm returned invalid JSON while reading ${label}.`);
  }
};

const publishedVersion = (raw: string): string => {
  const value = json(raw, 'the dist-tag version');
  if (typeof value !== 'string' || !value.trim()) throw new Error('The selected npm dist-tag did not resolve to a version.');
  return value.trim();
};

const installedVersion = (raw: string, packageName: string): string => {
  const value = json(raw, 'the installed package version')?.dependencies?.[packageName]?.version;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`npm did not report an installed version for ${packageName}.`);
  return value.trim();
};

export async function updateDutydeck(
  currentVersion: string,
  options: DutydeckUpdateOptions,
  dependencies: DutydeckUpdateDependencies
): Promise<DutydeckUpdateResult> {
  const packageName = dependencies.packageName ?? DEFAULT_PACKAGE_NAME;
  const distTag = normalizeDistTag(options.distTag);
  const targetVersion = publishedVersion(await dependencies.runNpm(['view', `${packageName}@${distTag}`, 'version', '--json']));
  await dependencies.runNpm(['install', '--global', `${packageName}@${distTag}`]);
  const version = installedVersion(await dependencies.runNpm(['list', '--global', packageName, '--depth=0', '--json']), packageName);
  if (version !== targetVersion) {
    throw new Error(`Dutydeck update verification failed: ${distTag} resolved to ${targetVersion}, but npm installed ${version}. The service was not restarted.`);
  }
  const globalRoot = (await dependencies.runNpm(['root', '--global'])).trim();
  if (!globalRoot) throw new Error('npm did not report its global package directory. The service was not restarted.');
  await dependencies.restart(resolve(globalRoot, packageName, 'dist/cli.js'), {
    force: options.force,
    drainTimeout: options.drainTimeout
  });
  return {
    action: 'update', packageName, distTag, previousVersion: currentVersion,
    version, updated: version !== currentVersion, restarted: true
  };
}

export const runNpmForDutydeckUpdate = defaultRunNpm;
