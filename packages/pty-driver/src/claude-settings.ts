import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { shellQuote as quote } from '@dutydeck/shared';
import { secretGuardToolMatcher } from '@dutydeck/shared/secret-guard';
import { claudePlanGuardMatcher } from '@dutydeck/cli-adapters';
import { planGuardScript } from './plan-guard.js';

/** Claude 家族终端适配器：生成 --settings 的是这一组，driver.ts 的子进程默认环境也用这一组。 */
export const claudeAdapters: ReadonlySet<string> = new Set(['claude-code', 'seed', 'relay', 'genius']);
const planGuardFile = 'plan-guard.mjs';
const planGuardActiveFile = 'plan-guard-active';
const launchGuardFile = 'launch-guard.json';

interface LaunchGuardWiring {
  id: string;
  failureBlock: boolean;
  planGuard: boolean;
  secretGuard: boolean;
}

function settingsArgs(args: string[]): { rest: string[]; value?: string } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { rest.push(...args.slice(i)); break; }
    if (arg === '--settings') value = args[++i] ?? '';
    else if (arg.startsWith('--settings=')) value = arg.slice('--settings='.length);
    else rest.push(arg);
  }
  return { rest, value };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEnvRecord(value: unknown): value is Record<string, string> {
  if (!object(value)) return false;
  return Object.values(value).every(v => typeof v === 'string');
}

function readSettings(value: string, cwd: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value.trimStart().startsWith('{') ? value : readFileSync(resolve(cwd, value), 'utf8'));
    if (!object(parsed) || (parsed.permissions !== undefined && !object(parsed.permissions)) || (parsed.env !== undefined && !isEnvRecord(parsed.env))) {
      throw new Error();
    }
    return parsed;
  } catch {
    // JSON parser errors can include the settings contents, including credentials.
    throw new Error('Invalid Claude --settings: expected a readable JSON object with object permissions and string env');
  }
}

function hasGuardHook(settings: Record<string, unknown>, expectedMatcher: string, commandMarkers: string[], failureBlockRequired: boolean): boolean {
  if (!object(settings.hooks) || !Array.isArray(settings.hooks.PreToolUse)) return false;
  return settings.hooks.PreToolUse.some(group => object(group) && group.matcher === expectedMatcher && Array.isArray(group.hooks) && group.hooks.some(hook => {
    if (!object(hook) || hook.type !== 'command' || typeof hook.command !== 'string') return false;
    const command = hook.command;
    return commandMarkers.every(marker => command.includes(marker)) && (!failureBlockRequired || hook.onFailure === 'block');
  }));
}

/** The session directory survives daemon detach so an adopted pane keeps its settings. */
export class ClaudeSettings {
  private readonly directory: string;
  private readonly files = new Set<string>();
  private launchGuard?: LaunchGuardWiring;

  constructor(private readonly adapterId: string, sessionId: string) {
    const key = createHash('sha256').update(sessionId).digest('hex');
    this.directory = join(tmpdir(), `dutydeck-claude-settings-${process.getuid?.() ?? 'user'}-${key}`);
    if (claudeAdapters.has(adapterId)) {
      try {
        this.assertPrivateDirectory();
        for (const file of readdirSync(this.directory)) {
          if (file !== launchGuardFile) this.files.add(join(this.directory, file));
        }
        this.launchGuard = this.readLaunchGuard();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  args(userArgs: string[], generatedArgs: string[], cwd: string, explicitEnv?: Record<string, string>): string[] {
    if (!claudeAdapters.has(this.adapterId)) return [...userArgs, ...generatedArgs];
    const user = settingsArgs(userArgs);
    const generated = settingsArgs(generatedArgs);
    const hasExplicitEnv = explicitEnv !== undefined && Object.keys(explicitEnv).length > 0;
    const hasMergeRequirement = user.value !== undefined && generated.value !== undefined;
    if (!hasMergeRequirement && !hasExplicitEnv) return [...userArgs, ...generatedArgs];

    const original = user.value !== undefined ? readSettings(user.value, cwd) : {};
    const overrides = generated.value !== undefined ? readSettings(generated.value, cwd) : {};
    const userEnv = object(original.env) ? original.env : undefined;
    const generatedEnv = object(overrides.env) ? overrides.env : undefined;
    const hasEnv = userEnv !== undefined || generatedEnv !== undefined || hasExplicitEnv;

    const merged: Record<string, unknown> = {
      ...original,
      ...overrides,
      ...((original.permissions || overrides.permissions) ? { permissions: {
        ...(object(original.permissions) ? original.permissions : {}),
        ...(object(overrides.permissions) ? overrides.permissions : {}),
      } } : {}),
      ...(object(overrides.hooks) ? { hooks: {
        ...original.hooks as object,
        ...Object.fromEntries(Object.entries(overrides.hooks).map(([event, hooks]) => {
          const existing = object(original.hooks) ? original.hooks[event] : undefined;
          return [event, [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(hooks) ? hooks : [])]];
        })),
      } } : {}),
      ...(hasEnv ? { env: {
        ...userEnv,
        ...generatedEnv,
        ...(hasExplicitEnv ? explicitEnv : {}),
      } } : {}),
    };
    try { mkdirSync(this.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    this.assertPrivateDirectory();
    const path = join(this.directory, `${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(merged), { mode: 0o600, flag: 'wx' });
    this.files.add(path);
    return [...user.rest, ...generated.rest, '--settings', path];
  }

  /**
   * 计划阶段守卫脚本和 active 元数据的位置。无 active 元数据时放行；
   * active 已启用但脚本缺失或跑不起来都退出 2，不把启用状态与脚本是否存在混为一谈。
   */
  planGuardCommand(nodePath = process.execPath): string {
    const script = quote(join(this.directory, planGuardFile));
    const active = quote(join(this.directory, planGuardActiveFile));
    return `test ! -e ${active} && exit 0; test -f ${script} || exit 2; ${quote(nodePath)} ${script} || exit 2`;
  }

  /** 打开或关掉计划阶段守卫：写入或删除会话私有目录里的 active 元数据与守卫脚本。 */
  setPlanGuard(active: boolean): void {
    const path = join(this.directory, planGuardFile);
    const activePath = join(this.directory, planGuardActiveFile);
    if (!active) {
      // Remove the script first: an interrupted deactivation stays fail-closed.
      rmSync(path, { force: true });
      rmSync(activePath, { force: true });
      this.files.delete(path);
      this.files.delete(activePath);
      return;
    }
    try { mkdirSync(this.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    this.assertPrivateDirectory();
    writeFileSync(path, planGuardScript(), { mode: 0o600 });
    writeFileSync(activePath, '1', { mode: 0o600 });
    this.files.add(path);
    this.files.add(activePath);
  }

  /** 真实 spawn/respawn 后记录本次进程实际加载的设置与启动探测结果；之后的轮次不再探测磁盘 CLI。 */
  recordLaunch(launchArgs: string[], cwd: string, failureBlock: boolean): void {
    if (!claudeAdapters.has(this.adapterId)) return;
    const { value } = settingsArgs(launchArgs);
    const settings = value === undefined ? undefined : readSettings(value, cwd);
    const wired = (matcher: string, markers: string[]) => settings !== undefined && hasGuardHook(settings, matcher, markers, failureBlock);
    this.launchGuard = {
      id: randomUUID(),
      failureBlock,
      planGuard: wired(claudePlanGuardMatcher, [join(this.directory, planGuardFile)]),
      secretGuard: wired(secretGuardToolMatcher, ['secret-guard.mjs', 'DUTYDECK_POLICY_ROOT=', quote(cwd)]),
    };
    try { mkdirSync(this.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    this.assertPrivateDirectory();
    writeFileSync(join(this.directory, launchGuardFile), JSON.stringify(this.launchGuard), { mode: 0o600 });
  }

  /** 接管时只认上次真实启动留下的记录；没有记录或记录损坏都不能证明旧进程的配置。 */
  launchGuardWiring(): Readonly<LaunchGuardWiring> | undefined {
    return this.launchGuard;
  }

  /**
   * 正在跑的 CLI 有没有守卫 hook：核对本次启动参数里的设置。
   * marker、精确 matcher 和 command type 始终核对；确认支持 onFailure:block 的官方新版还必须带这个字段。
   */
  planGuardWired(launchArgs: string[], cwd: string, failureBlockRequired = false): boolean {
    return this.guardWired(launchArgs, cwd, claudePlanGuardMatcher, [join(this.directory, planGuardFile)], failureBlockRequired);
  }

  /** 新版恢复或接管时，凭据守卫还必须带策略 marker 和 onFailure:block。 */
  secretGuardWired(launchArgs: string[], cwd: string, failureBlockRequired = false): boolean {
    return this.guardWired(launchArgs, cwd, secretGuardToolMatcher, ['secret-guard.mjs', 'DUTYDECK_POLICY_ROOT=', quote(cwd)], failureBlockRequired);
  }

  private guardWired(launchArgs: string[], cwd: string, expectedMatcher: string, commandMarkers: string[], failureBlockRequired: boolean): boolean {
    if (!launchArgs.length) return false;
    const { value } = settingsArgs(launchArgs);
    if (value === undefined) return false;
    try { return hasGuardHook(readSettings(value, cwd), expectedMatcher, commandMarkers, failureBlockRequired); }
    catch { return false; }
  }

  cleanup(): void {
    if (!claudeAdapters.has(this.adapterId)) return;
    // An old process can exit after a replacement has spawned. Only remove
    // files this driver created or adopted, never the replacement's settings.
    for (const path of this.files) rmSync(path, { force: true });
    this.files.clear();
    if (this.launchGuard && this.readLaunchGuard()?.id === this.launchGuard.id) {
      rmSync(join(this.directory, launchGuardFile), { force: true });
    }
    this.launchGuard = undefined;
    try { rmdirSync(this.directory); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }

  private readLaunchGuard(): LaunchGuardWiring | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.directory, launchGuardFile), 'utf8'));
      if (!object(parsed) || typeof parsed.id !== 'string' || !parsed.id
        || typeof parsed.failureBlock !== 'boolean' || typeof parsed.planGuard !== 'boolean' || typeof parsed.secretGuard !== 'boolean') return undefined;
      return { id: parsed.id, failureBlock: parsed.failureBlock, planGuard: parsed.planGuard, secretGuard: parsed.secretGuard };
    } catch { return undefined; }
  }

  private assertPrivateDirectory(): void {
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700 || (process.getuid && directory.uid !== process.getuid())) {
      throw new Error('Claude settings directory must be private and owned by the current user');
    }
  }
}
