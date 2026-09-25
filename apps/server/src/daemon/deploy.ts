import { checkSqliteDriver, describeSqliteDriverFailure } from '@dutydeck/storage';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AUTOSTART_LINUX_UNIT } from '../autostart/autostart.js';
import type { DeployCliOptions } from '../cli-program.js';
import { drainRuntime, systemdServiceControl, unitRuntime, waitForServiceHealth, type DaemonCommandDeps, type DrainResult, type RuntimeEndpoint, type ServiceControl, type UnitRuntime } from './command.js';

/**
 * `dutydeck deploy`：把一个已构建好的检出目录做成不可变的发布目录，排空后切换 `current` 并重启，
 * 健康检查不过就切回上一版再重启。unit 的 ExecStart 须运行 `<releases>/current/dist/cli.js`，
 * `--print-unit` 按现有 unit 生成这样一份。
 *
 *   <releases>/<时间>-<sha>/                  dist、public、package.json 与生产依赖
 *   <releases>/current                        指向当前版本的相对符号链接
 *   <releases>/../deployments/<时间>-<sha>/   manifest.json 与重启前的数据库备份
 */

export interface DeployDeps extends DaemonCommandDeps {
  /** 控制目标服务；默认按 unit 走 systemctl。测试与演练换成直接起进程。 */
  service?: ServiceControl;
  /** 健康检查最长等待（毫秒），默认 90 秒。 */
  healthTimeoutMs?: number;
  /** DUTYDECK_DEPLOY_WINDOW 的来源，默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 重启前备份数据库，默认 SQLite 在线备份。 */
  backupDatabase?: (source: string, target: string) => Promise<void>;
  /** 运行中进程的 cwd、命令行、环境变量与已映射文件路径，清理旧发布目录前用来判断还有没有进程在用；默认读 /proc。 */
  processPaths?: () => string[] | undefined;
}

export type DeployStatus = 'deployed' | 'staged' | 'rolled_back' | 'rollback_failed' | 'failed' | 'refused' | 'unit';

export interface DeployResult {
  ok: boolean;
  status: DeployStatus;
  commit?: string;
  release?: string;
  previousRelease?: string;
  manifest?: string;
  pid?: number;
  error?: string;
  /** --print-unit：改写后的 unit 文件内容与它原来的路径。 */
  unitFile?: string;
  unitPath?: string;
  /** 部署成功后清理旧发布目录的结果。 */
  pruned?: PruneResult;
  /** 部署成功后清理 deploy 自己写的旧部署记录（含数据库备份）的结果。 */
  prunedRecords?: { removed: string[]; freedBytes: number };
}

export interface PruneResult { removed: string[]; inUse: string[]; freedBytes: number }

const defaultInfo = (message: string) => { process.stderr.write(`${message}\n`); };
const defaultWarn = (message: string) => { process.stderr.write(`警告：${message}\n`); };
const refused = (error: string): DeployResult => ({ ok: false, status: 'refused', error });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// ─── 部署窗口 ────────────────────────────────────────────────────────────────

/** 解析部署窗口，例如 `10:00-11:00,16:00-17:00`；结束早于开始表示跨过零点。格式不对返回 undefined。 */
export function parseDeployWindows(spec: string): Array<{ start: number; end: number }> | undefined {
  const windows: Array<{ start: number; end: number }> = [];
  for (const part of spec.split(',').map(item => item.trim()).filter(Boolean)) {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(part);
    if (!match) return undefined;
    const [startHour, startMinute, endHour, endMinute] = match.slice(1).map(Number) as [number, number, number, number];
    if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return undefined;
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    if (start === end) return undefined;
    windows.push({ start, end });
  }
  return windows.length > 0 ? windows : undefined;
}

/** Asia/Shanghai 当天的第几分钟。该时区自 1991 年起没有夏令时，固定 UTC+8。 */
export function shanghaiMinuteOfDay(at: Date): number {
  return (at.getUTCHours() * 60 + at.getUTCMinutes() + 8 * 60) % (24 * 60);
}

export function withinDeployWindow(windows: Array<{ start: number; end: number }>, at: Date): boolean {
  const minute = shanghaiMinuteOfDay(at);
  return windows.some(({ start, end }) => start < end ? minute >= start && minute < end : minute >= start || minute < end);
}

// ─── 构建产物与发布目录 ──────────────────────────────────────────────────────

const BUILD_OUTPUTS = ['dist/cli.js', 'dist/agents/claude-acp.mjs', 'dist/agents/env-launcher.mjs', 'public/index.html'];

interface BuiltCheckout { source: string; server: string; version: string; commit: string; dirty: boolean }

function findCheckout(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'apps', 'server', 'package.json'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

function git(source: string, args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function checkBuild(source: string): BuiltCheckout | { error: string } {
  const server = join(source, 'apps', 'server');
  let pkg: { name?: string; version?: string };
  try {
    pkg = JSON.parse(readFileSync(join(server, 'package.json'), 'utf8'));
  } catch {
    return { error: `${source} 不是 Dutydeck 检出目录：读不到 apps/server/package.json。` };
  }
  if (pkg.name !== '@byted/dutydeck' || !pkg.version) return { error: `${server}/package.json 不是 Dutydeck 服务包（name=${pkg.name ?? '未知'}）。` };
  const missing = BUILD_OUTPUTS.filter(file => !existsSync(join(server, file)));
  if (missing.length > 0) return { error: `${server} 缺少构建产物 ${missing.join('、')}。先在 ${source} 里执行 pnpm install --frozen-lockfile && pnpm build。` };
  if (!existsSync(join(source, 'node_modules', '.pnpm'))) return { error: `${source} 没有安装依赖（缺 node_modules/.pnpm）。先执行 pnpm install --frozen-lockfile。` };
  const commit = git(source, ['rev-parse', 'HEAD']);
  if (!commit) return { error: `读不到 ${source} 的 git 提交，无法给发布目录定版本。` };
  const committedAt = Number(git(source, ['log', '-1', '--format=%ct'])) * 1000;
  if (statSync(join(server, 'dist', 'cli.js')).mtimeMs < committedAt) {
    return { error: `${server}/dist/cli.js 早于最新提交 ${commit.slice(0, 7)}，构建产物可能是旧的。先在 ${source} 里重新 pnpm build。` };
  }
  const dirty = (git(source, ['status', '--porcelain', '--untracked-files=no']) ?? '') !== '';
  return { source, server, version: pkg.version, commit, dirty };
}

/** node_modules 目录下的符号链接名（含 `@scope/name`）；实体目录（包自身）和 `.bin` 之类跳过。 */
function linkedNames(modules: string): string[] {
  if (!existsSync(modules)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of readdirSync(join(modules, entry.name), { withFileTypes: true })) {
        if (child.isSymbolicLink()) names.push(`${entry.name}/${child.name}`);
      }
    } else if (entry.isSymbolicLink()) names.push(entry.name);
  }
  return names;
}

/**
 * 按 pnpm 的隔离布局复制服务的生产依赖闭包：`.pnpm/<id>` 整目录照搬（里面的相对符号链接原样保留），
 * 顶层 `node_modules/<name>` 与提升的 `.pnpm/node_modules/<name>` 只重建闭包内的链接。工作区包已经
 * 打进 dist/cli.js，devDependencies 不带。
 * 不用 `pnpm deploy --prod`：它会把源检出的安装状态改成 production，之后在那里跑任何 pnpm 命令都会删 devDependencies。
 */
function copyProductionModules(build: BuiltCheckout, target: string): void {
  const store = realpathSync(join(build.source, 'node_modules', '.pnpm'));
  const entryOf = (modules: string, name: string): string => {
    const link = join(modules, name);
    const text = readlinkSync(link);
    if (isAbsolute(text)) throw new Error(`${link} 是绝对路径链接（${text}），复制后会指回源检出。`);
    const path = relative(store, realpathSync(link));
    if (path.startsWith('..') || isAbsolute(path)) throw new Error(`依赖 ${name} 不在 ${store} 里，无法复制。`);
    return path.split(sep)[0]!;
  };
  const entries = new Set<string>();
  const visit = (id: string) => {
    if (entries.has(id)) return;
    entries.add(id);
    const modules = join(store, id, 'node_modules');
    for (const name of linkedNames(modules)) visit(entryOf(modules, name));
  };
  const pkg = JSON.parse(readFileSync(join(build.server, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const serverModules = join(build.server, 'node_modules');
  const roots = Object.keys(pkg.dependencies ?? {}).map(name => [name, entryOf(serverModules, name)] as const);
  for (const [, id] of roots) visit(id);

  const targetStore = join(target, 'node_modules', '.pnpm');
  mkdirSync(targetStore, { recursive: true });
  for (const id of entries) cpSync(join(store, id), join(targetStore, id), { recursive: true, verbatimSymlinks: true });
  const link = (path: string, destination: string) => {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(relative(dirname(path), destination), path);
  };
  for (const [name, id] of roots) link(join(target, 'node_modules', name), join(targetStore, id, 'node_modules', name));
  const hoisted = join(store, 'node_modules');
  for (const name of linkedNames(hoisted)) {
    let id: string;
    try { id = entryOf(hoisted, name); } catch { continue; }
    if (entries.has(id)) link(join(targetStore, 'node_modules', name), join(targetStore, id, 'node_modules', name));
  }
}

/** 先写到同级的 `.<id>.partial`，完整后再改名，半成品不会以正式版本名出现。 */
function copyRelease(build: BuiltCheckout, release: string): void {
  if (existsSync(release)) throw new Error(`发布目录 ${release} 已存在。`);
  const partial = join(dirname(release), `.${basename(release)}.partial`);
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  try {
    for (const entry of ['dist', 'public', 'package.json']) cpSync(join(build.server, entry), join(partial, entry), { recursive: true });
    copyProductionModules(build, partial);
    renameSync(partial, release);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

/** 用目标 node 在发布目录里跑一次 `--version`（加载全部外部依赖），再真的打开一次 SQLite。 */
function trialLoad(execPath: string, release: string, version: string, deps: DeployDeps): string | undefined {
  const cli = join(release, 'dist', 'cli.js');
  const probe = spawnSync(execPath, [cli, '--version'], { cwd: release, encoding: 'utf8', timeout: 60_000 });
  if (probe.status !== 0 || probe.stdout.trim() !== version) {
    const detail = (probe.stderr || probe.stdout || '').trim().split('\n').at(-1) || probe.error?.message || `退出码 ${probe.status ?? '未知'}`;
    return `用 ${execPath} 试加载 ${cli} 失败：${detail}`;
  }
  const sqlite = (deps.checkSqlite ?? checkSqliteDriver)({ execPath, resolveFrom: cli });
  return sqlite.ok ? undefined : `SQLite 预检失败：${describeSqliteDriverFailure(sqlite)}`;
}

function currentRelease(releases: string): string | undefined {
  try { return resolve(releases, readlinkSync(join(releases, 'current'))); } catch { return undefined; }
}

/** 新链接先建在临时名下，再 rename 覆盖 `current`：切换是原子的。 */
function pointCurrent(releases: string, release: string): void {
  const temp = join(releases, `.current.${process.pid}.tmp`);
  rmSync(temp, { force: true });
  symlinkSync(relative(releases, release), temp);
  renameSync(temp, join(releases, 'current'));
}

async function backupSqlite(source: string, target: string): Promise<void> {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try { await db.backup(target); } finally { db.close(); }
  chmodSync(target, 0o600);
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 部署成功后按版本名保留最新的几个发布目录和部署记录；current、上一版和仍被运行中进程引用的另外保留。 */
export const RELEASES_TO_KEEP = 5;
/** 写进 manifest.json 的来源标记：只有带它的部署记录才会被自动清理，手工部署留下的记录不动。 */
export const DEPLOY_RECORD_CREATOR = 'dutydeck deploy';
const RELEASE_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{7}(-dirty)?$/;
const PARTIAL_NAME = /^\..+\.partial$/;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function diskUsage(path: string): number {
  const stat = lstatSync(path);
  const own = stat.blocks * 512;
  return stat.isDirectory() ? readdirSync(path).reduce((total, name) => total + diskUsage(join(path, name)), own) : own;
}

/** 所有读得到的进程的 cwd、命令行参数、环境变量和已映射文件路径。读不了 /proc（非 Linux）返回 undefined。 */
function readProcessPaths(): string[] | undefined {
  let pids: string[];
  try { pids = readdirSync('/proc').filter(name => /^\d+$/.test(name)); } catch { return undefined; }
  const paths = new Set<string>();
  const collect = (read: () => string[]) => {
    try { for (const path of read()) if (path) paths.add(path); } catch { /* 进程已退出，或属于别的用户 */ }
  };
  for (const pid of pids) {
    collect(() => [readlinkSync(`/proc/${pid}/cwd`)]);
    collect(() => readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'));
    collect(() => readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'));
    collect(() => readFileSync(`/proc/${pid}/maps`, 'utf8').split('\n').map(line => line.includes(' /') ? line.slice(line.indexOf(' /') + 1) : ''));
  }
  return [...paths];
}

/**
 * 删掉更早的发布目录和复制中断留下的 `.<id>.partial`。服务重启后，tmux 里保留下来的 Agent 进程环境变量中
 * 仍是旧版本 cli.js 的路径（dutydeck_relay_command），所以任何运行中进程的 cwd、命令行、环境变量或已映射
 * 文件还引用着的目录都不删；看不了进程就只清 `.partial`。
 */
function pruneReleases(releases: string, previous: string | undefined, processPaths: () => string[] | undefined, warn: (message: string) => void): PruneResult {
  const result: PruneResult = { removed: [], inUse: [], freedBytes: 0 };
  const remove = (name: string) => {
    const path = join(releases, name);
    result.freedBytes += diskUsage(path);
    rmSync(path, { recursive: true, force: true });
    result.removed.push(name);
  };
  const names = readdirSync(releases, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const name of names.filter(name => PARTIAL_NAME.test(name))) remove(name);
  const keep = new Set([currentRelease(releases), previous]);
  const candidates = names.filter(name => RELEASE_NAME.test(name)).sort().reverse().slice(RELEASES_TO_KEEP).filter(name => !keep.has(join(releases, name)));
  if (candidates.length === 0) return result;
  const paths = processPaths();
  if (!paths) {
    warn(`读不到 /proc，确认不了 ${candidates.length} 个旧发布目录是否仍被运行中的进程引用，这次不删。`);
    return result;
  }
  const real = realpathSync(releases);
  for (const name of candidates) {
    const referenced = [join(releases, name), join(real, name)].some(dir => {
      const pattern = new RegExp(`${escapeRegExp(dir)}(?![\\w.-])`);
      return paths.some(path => pattern.test(path));
    });
    if (referenced) result.inUse.push(name);
    else remove(name);
  }
  return result;
}

/**
 * 删掉更早的部署记录（manifest 与数据库备份）。只算 manifest.json 里 created_by 是 DEPLOY_RECORD_CREATOR 的，
 * 按名字保留最新 RELEASES_TO_KEEP 个；本次的记录还没写 manifest，直接算进去，它和上一版的记录总是保留。
 */
function pruneRecords(deployments: string, current: string, previous: string | undefined): { removed: string[]; freedBytes: number } {
  const result = { removed: [] as string[], freedBytes: 0 };
  const own = readdirSync(deployments, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== current).map(entry => entry.name).filter(name => {
    try { return JSON.parse(readFileSync(join(deployments, name, 'manifest.json'), 'utf8')).created_by === DEPLOY_RECORD_CREATOR; } catch { return false; }
  });
  for (const name of [...own, current].sort().reverse().slice(RELEASES_TO_KEEP)) {
    if (name === current || name === previous) continue;
    const path = join(deployments, name);
    result.freedBytes += diskUsage(path);
    rmSync(path, { recursive: true, force: true });
    result.removed.push(name);
  }
  return result;
}

// ─── 目标 ────────────────────────────────────────────────────────────────────

interface DeployTarget {
  unit: string;
  releases: string;
  deployments: string;
  endpoint: RuntimeEndpoint;
  execPath: string;
  /** bot 运行时目录：部署成功后更新其中的 deployment.json。 */
  runtime?: string;
  service?: UnitRuntime;
}

/**
 * 目标服务的信息按「命令行 > deployment.json > unit」取：unit 的 ExecStart 给出解释器和入口脚本，
 * 入口脚本是 `<X>/current/dist/cli.js` 时 X 就是发布目录；否则默认 `<运行时根目录>/.dutydeck/releases`，
 * 根目录是 --runtime，没给就是 unit 的 WorkingDirectory。
 */
async function resolveTarget(options: DeployCliOptions, deps: DeployDeps): Promise<DeployTarget | { error: string }> {
  let deployment: Record<string, unknown> | undefined;
  if (options.runtime) {
    try {
      deployment = JSON.parse(readFileSync(join(options.runtime, 'deployment.json'), 'utf8'));
    } catch {
      return { error: `读不到 ${join(options.runtime, 'deployment.json')}。` };
    }
  }
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
  const unit = options.unit ?? text(deployment?.unit) ?? AUTOSTART_LINUX_UNIT;
  const found = deps.service ? undefined : await unitRuntime(unit, deps);
  if (found && 'error' in found && (options.restart !== false || options.printUnit)) return { error: found.error };
  const service = found && !('error' in found) ? found : undefined;
  const script = service?.script;
  const fromUnit = script && script.endsWith(join(sep, 'current', 'dist', 'cli.js')) ? resolve(script, '../../..') : undefined;
  const root = options.runtime ?? service?.root;
  const releases = options.releases ?? fromUnit ?? (root ? join(root, '.dutydeck', 'releases') : undefined);
  if (!releases) return { error: '确定不了发布目录，用 --releases 指定。' };
  const endpoint: RuntimeEndpoint = deployment
    ? { address: text(deployment.address), database: text(deployment.databasePath), authEnabled: service?.endpoint.authEnabled }
    : { ...service?.endpoint };
  if (options.port !== undefined) {
    const port = Number(options.port);
    if (!/^\d+$/.test(options.port) || port < 1 || port > 65535) return { error: `--port 只接受 1 到 65535 的端口号（收到 ${JSON.stringify(options.port)}）。` };
    const url = new URL(endpoint.address ?? 'http://127.0.0.1');
    url.port = String(port);
    endpoint.address = url.origin;
  }
  return {
    unit,
    releases: resolve(releases),
    deployments: join(dirname(resolve(releases)), 'deployments'),
    endpoint,
    execPath: options.node ?? service?.execPath ?? process.execPath,
    ...(options.runtime ? { runtime: resolve(options.runtime) } : {}),
    ...(service ? { service } : {})
  };
}

/** 按现有 unit 文件生成一份 ExecStart 改跑 `<releases>/current/dist/cli.js` 的版本，其余行原样保留。 */
function printUnit(target: DeployTarget): DeployResult {
  const path = target.service?.fragmentPath;
  if (!path) return refused(`读不到 unit ${target.unit} 的文件路径（FragmentPath）。`);
  const script = join(target.releases, 'current', 'dist', 'cli.js');
  let original: string;
  try { original = readFileSync(path, 'utf8'); } catch (error) { return refused(`读不到 unit 文件 ${path}：${message(error)}`); }
  let replaced = 0;
  const unitFile = original.split('\n').map(line => {
    const match = /^(ExecStart=\S+\s+)(\S+)(.*)$/.exec(line);
    if (!match) return line;
    replaced++;
    return `${match[1]}${script}${match[3]}`;
  }).join('\n');
  if (replaced !== 1) return refused(`${path} 里应当正好有一行 ExecStart=<node> <cli.js> ...（找到 ${replaced} 行），没法自动改写。`);
  return { ok: true, status: 'unit', unitFile, unitPath: path };
}

function updateDeploymentFile(target: DeployTarget, release: string, commit: string, manifest: string, at: Date): void {
  if (!target.runtime) return;
  const file = join(target.runtime, 'deployment.json');
  let previous: Record<string, unknown> = {};
  try { previous = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 首次部署 */ }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({
    ...previous, commit, deployedAt: at.toISOString(), runtimePath: join(target.releases, 'current'), release,
    databasePath: target.endpoint.database, address: target.endpoint.address, deploymentRecord: manifest, unit: target.unit
  }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

// ─── 部署 ────────────────────────────────────────────────────────────────────

async function restartAndCheck(service: ServiceControl, previousPid: number | undefined, address: string | undefined, deps: DeployDeps) {
  const error = await service.restart();
  if (error) return { ok: false as const, error };
  return await waitForServiceHealth(service, previousPid, address, deps, deps.healthTimeoutMs);
}

export async function runDeploy(options: DeployCliOptions, deps: DeployDeps = {}): Promise<DeployResult> {
  const info = deps.info ?? defaultInfo;
  const warn = deps.warn ?? defaultWarn;
  const now = () => new Date((deps.now ?? Date.now)());
  const restart = options.restart !== false;

  if (options.printUnit) {
    const target = await resolveTarget(options, deps);
    return 'error' in target ? refused(target.error) : printUnit(target);
  }

  const window = (deps.env ?? process.env).DUTYDECK_DEPLOY_WINDOW?.trim();
  if (window && !options.now) {
    const windows = parseDeployWindows(window);
    if (!windows) return refused(`DUTYDECK_DEPLOY_WINDOW 格式不对（${window}），应形如 10:00-11:00,16:00-17:00。`);
    const minute = shanghaiMinuteOfDay(now());
    const clock = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    if (!withinDeployWindow(windows, now())) return refused(`现在（Asia/Shanghai ${clock}）不在部署窗口 ${window} 内，已拒绝部署。确需立即部署，加 --now。`);
  }

  const target = await resolveTarget(options, deps);
  if ('error' in target) return refused(target.error);
  const script = join(target.releases, 'current', 'dist', 'cli.js');
  if (restart && !deps.service && (!target.service?.script || resolve(target.service.script) !== script)) {
    return refused(`unit ${target.unit} 的 ExecStart 运行的是 ${target.service?.script ?? '（读不到）'}，不是 ${script}，切换 current 不会生效。首次切换：先 dutydeck deploy --no-restart 准备发布目录，再按 dutydeck deploy --print-unit 的输出改写 unit，daemon-reload 后 dutydeck restart --unit ${target.unit}。`);
  }

  const source = options.source ? resolve(options.source) : findCheckout(process.cwd());
  if (!source) return refused('当前目录不在 Dutydeck 仓库里，用 --source 指定已构建好的检出目录。');
  info(`校验构建产物：${source}`);
  const build = checkBuild(source);
  if ('error' in build) return refused(build.error);
  if (build.dirty) warn(`${source} 有未提交的改动；发布目录按提交 ${build.commit.slice(0, 7)} 命名，内容包含这些改动。`);

  const startedAt = now();
  const id = `${startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${build.commit.slice(0, 7)}${build.dirty ? '-dirty' : ''}`;
  const release = join(target.releases, id);
  const record = join(target.deployments, id);
  const manifestPath = join(record, 'manifest.json');
  const previousRelease = currentRelease(target.releases);
  mkdirSync(record, { recursive: true, mode: 0o700 });
  const manifest: Record<string, unknown> = {
    created_by: DEPLOY_RECORD_CREATOR, commit: build.commit, dirty: build.dirty, source, unit: target.unit, release, previous_release: previousRelease ?? null,
    backup: record, status: 'preparing', started_at: startedAt.toISOString()
  };
  let pruned: PruneResult | undefined;
  let prunedRecords: DeployResult['prunedRecords'];
  const finish = (status: DeployStatus, extra: Record<string, unknown> = {}): DeployResult => {
    Object.assign(manifest, { status, completed_at: now().toISOString() }, extra);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const pid = typeof manifest.new_pid === 'number' ? manifest.new_pid : undefined;
    return {
      ok: status === 'deployed' || status === 'staged', status, commit: build.commit, release,
      ...(previousRelease ? { previousRelease } : {}), manifest: manifestPath,
      ...(pid !== undefined ? { pid } : {}), ...(typeof extra.error === 'string' ? { error: extra.error } : {}), ...(pruned ? { pruned } : {}),
      ...(prunedRecords ? { prunedRecords } : {})
    };
  };
  const prune = () => {
    try {
      pruned = pruneReleases(target.releases, previousRelease, deps.processPaths ?? readProcessPaths, warn);
      Object.assign(manifest, { pruned_releases: pruned.removed, releases_in_use: pruned.inUse, freed_bytes: pruned.freedBytes });
    } catch (error) {
      warn(`清理旧发布目录失败：${message(error)}`);
    }
    try {
      prunedRecords = pruneRecords(target.deployments, id, previousRelease && basename(previousRelease));
      Object.assign(manifest, { pruned_records: prunedRecords.removed, records_freed_bytes: prunedRecords.freedBytes });
    } catch (error) {
      warn(`清理旧部署记录失败：${message(error)}`);
    }
  };

  info(`复制到发布目录：${release}`);
  try {
    mkdirSync(target.releases, { recursive: true });
    copyRelease(build, release);
  } catch (error) {
    return finish('failed', { error: `复制发布目录失败：${message(error)}` });
  }
  manifest.new_cli_sha256 = sha256(join(release, 'dist', 'cli.js'));
  if (previousRelease && existsSync(join(previousRelease, 'dist', 'cli.js'))) manifest.previous_cli_sha256 = sha256(join(previousRelease, 'dist', 'cli.js'));

  info(`试加载：${target.execPath} ${join(release, 'dist', 'cli.js')} --version`);
  const trial = trialLoad(target.execPath, release, build.version, deps);
  if (trial) {
    rmSync(release, { recursive: true, force: true });
    return finish('failed', { error: trial });
  }

  if (!restart) {
    pointCurrent(target.releases, release);
    info(`已切换 current → ${id}（未重启）`);
    prune();
    return finish('staged');
  }

  const service = deps.service ?? systemdServiceControl(target.unit, deps);
  const previousPid = await service.mainPid();
  manifest.previous_pid = previousPid ?? null;
  let drain: DrainResult = { ok: true };
  if (previousPid !== undefined) {
    info('排空：新消息照常入队，等正在执行的任务结束…');
    drain = await drainRuntime(target.endpoint, options, deps);
    if (!drain.ok) return finish('failed', { error: drain.error });
  }
  const database = target.endpoint.database;
  if (database && existsSync(database)) {
    const backup = join(record, basename(database));
    info(`备份数据库：${backup}`);
    try {
      await (deps.backupDatabase ?? backupSqlite)(database, backup);
      manifest.database_backup = backup;
    } catch (error) {
      await drain.release?.();
      return finish('failed', { error: `备份数据库失败，没有切换版本：${message(error)}` });
    }
  }

  info(`切换 current → ${id}，重启 ${target.unit}`);
  pointCurrent(target.releases, release);
  const started = await restartAndCheck(service, previousPid, target.endpoint.address, deps);
  if (started.ok) {
    info(`健康检查通过（pid ${started.pid}）`);
    updateDeploymentFile(target, release, build.commit, manifestPath, now());
    prune();
    return finish('deployed', { new_pid: started.pid });
  }
  if (!previousRelease) return finish('failed', { error: `新版本没有通过健康检查，也没有上一版可以切回。原因：${started.error}` });

  warn(`新版本没有通过健康检查，切回 ${basename(previousRelease)} 并重启。原因：${started.error}`);
  pointCurrent(target.releases, previousRelease);
  await service.resetFailed?.();
  const back = await restartAndCheck(service, await service.mainPid(), target.endpoint.address, deps);
  return back.ok
    ? finish('rolled_back', { new_pid: back.pid, error: `新版本 ${id} 没有通过健康检查，已切回 ${basename(previousRelease)}。原因：${started.error}` })
    : finish('rollback_failed', { error: `新版本没有通过健康检查，切回 ${basename(previousRelease)} 后仍不健康。新版本：${started.error}上一版：${back.error}` });
}
