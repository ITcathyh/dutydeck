import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { errorMessage } from '@dutydeck/shared';

const execFileAsync = promisify(execFile);
const DEFAULT_PACKAGE_NAME = 'dutydeck';

export interface DutydeckUpdateOptions {
  version?: string;
  distTag?: string;
  force?: boolean;
  drainTimeout?: string;
}

export interface DutydeckUpdateResult {
  action: 'update';
  packageName: string;
  distTag?: string;
  previousVersion: string;
  version: string;
  updated: boolean;
  restarted: true;
}

export interface DutydeckUpdateDependencies {
  runNpm(args: string[]): Promise<string>;
  /**
   * 安装前先等待正在执行的任务结束；超时/失败时应 reject，由调用方放弃本次 update。
   * 只在未传 --force 时调用。返回 Promise 即代表可以安全停服。
   */
  drain?(options: { drainTimeout?: string }): Promise<void>;
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

const numericIdentifier = '(?:0|[1-9]\\d*)';
const prereleaseIdentifier = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
const buildIdentifier = '[0-9a-zA-Z-]+';
const exactSemverPattern = new RegExp(`^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+${buildIdentifier}(?:\\.${buildIdentifier})*)?$`);

function normalizeExactVersion(value: string): string {
  const version = value.trim();
  if (!exactSemverPattern.test(version)) {
    throw new Error(`Invalid exact Dutydeck version: ${JSON.stringify(version)}. Use an exact semver such as 1.2.3 or 1.2.3-beta.1.`);
  }
  return version;
}

const rollbackGuidance = (packageName: string, previousVersion: unknown): string => {
  if (typeof previousVersion === 'string') {
    try { return `To roll back, run: npm install --global ${packageName}@${normalizeExactVersion(previousVersion)} && dutydeck restart`; }
    catch { /* 缺失或不安全的旧版本不能拼成命令。 */ }
  }
  return 'No safe rollback command can be generated because the previous version is missing or is not an exact semver. Reinstall a known exact previous version and restart the service.';
};

const withRollbackGuidance = (error: unknown, packageName: string, previousVersion: unknown): Error => {
  const message = errorMessage(error);
  const wrapped = new Error(`${message}\n${rollbackGuidance(packageName, previousVersion)}`, { cause: error });
  if (error instanceof Error) {
    wrapped.name = error.name;
    Object.assign(wrapped, error);
    // Object.assign 可能带来旧的 cause；当前包装错误的直接原因必须是被捕获的这一份。
    wrapped.cause = error;
  }
  return wrapped;
};

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
  if (options.version !== undefined && options.distTag !== undefined) throw new Error('The exact update version and --dist-tag are mutually exclusive.');
  const exactVersion = options.version === undefined ? undefined : normalizeExactVersion(options.version);
  const distTag = exactVersion === undefined ? normalizeDistTag(options.distTag) : undefined;
  const selector = exactVersion ?? distTag!;
  const targetVersion = exactVersion ?? publishedVersion(await dependencies.runNpm(['view', `${packageName}@${distTag}`, 'version', '--json']));
  // 安装前先等正在执行的任务结束：一旦 npm install -g 落盘，磁盘上就是新版文件，
  // 此时再因超时放弃会留下「包是新的、服务还是旧的」。drain 失败/超时直接抛出，不安装、不重启。
  // --force 两处等待（这里与 restart 内部）都跳过。
  if (!options.force) {
    await dependencies.drain?.({ drainTimeout: options.drainTimeout });
  }
  let version: string;
  try {
    await dependencies.runNpm(['install', '--global', `${packageName}@${selector}`]);
    version = installedVersion(await dependencies.runNpm(['list', '--global', packageName, '--depth=0', '--json']), packageName);
    if (version !== targetVersion) {
      throw new Error(`Dutydeck update verification failed: ${selector} resolved to ${targetVersion}, but npm installed ${version}. The service was not restarted.`);
    }
    const globalRoot = (await dependencies.runNpm(['root', '--global'])).trim();
    if (!globalRoot) throw new Error('npm did not report its global package directory. The service was not restarted.');
    await dependencies.restart(resolve(globalRoot, packageName, 'dist/cli.js'), {
      force: options.force,
      drainTimeout: options.drainTimeout
    });
  } catch (error) {
    throw withRollbackGuidance(error, packageName, currentVersion);
  }
  return {
    action: 'update', packageName, ...(distTag ? { distTag } : {}), previousVersion: currentVersion,
    version, updated: version !== currentVersion, restarted: true
  };
}

export const runNpmForDutydeckUpdate = defaultRunNpm;
