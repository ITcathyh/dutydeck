import { backupSqlite } from '@dutydeck/storage';
import { checkSqliteDriver, childProcessIdentity, describeSqliteDriverFailure, observeProcess, type ProcessIdentity } from '@dutydeck/storage';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AUTOSTART_LINUX_UNIT } from '../autostart/autostart.js';
import type { DeployCliOptions, DeployPruneCliOptions } from '../cli-program.js';
import { pidAlive } from './daemon.js';
import { DRAIN_INTERVAL_MS, drainRuntime, systemdServiceControl, unitRuntime, waitForServiceHealth, type DaemonCommandDeps, type DrainResult, type RuntimeEndpoint, type ServiceControl, type UnitRuntime } from './command.js';

/**
 * `dutydeck deploy`：把一个已构建好的检出目录做成不可变的发布目录，排空后切换 `current` 并重启，
 * 健康检查不过时，停服务并确认数据库 schema 未变才切回上一版；始终保留当前数据库。
 * unit 的 ExecStart 须运行 `<releases>/current/dist/cli.js`，
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
  /** 目标 PID 实际加载的不可变 release；默认读取 /proc，不能解析 current 来代替运行版本。 */
  processRelease?: (pid: number, releases: string) => string | undefined;
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

/** 同一真实 releases 根共用锁；连接关闭或进程退出时释放，不能删除持久锁文件。 */
function acquireDeployLock(releases: string): Database.Database | { error: string } {
  mkdirSync(releases, { recursive: true });
  const lock = new Database(join(realpathSync(releases), '.deploy-lock.sqlite'), { timeout: 0 });
  try {
    lock.exec('BEGIN IMMEDIATE');
    return lock;
  } catch (error) {
    lock.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') return { error: `发布目录 ${releases} 正在被另一个部署或清理操作使用，请稍后重试。` };
    throw error;
  }
}

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

interface UnitRelease { unit: string; release: string; process_identity?: ProcessIdentity; schema_fingerprint?: string }

function unitReleaseFile(deployments: string, unit: string): string {
  return join(deployments, 'units', `${createHash('sha256').update(unit).digest('hex')}.json`);
}

function readUnitRelease(deployments: string, unit: string, releases: string): UnitRelease | undefined {
  try {
    const record = JSON.parse(readFileSync(unitReleaseFile(deployments, unit), 'utf8')) as UnitRelease;
    return record.unit === unit && typeof record.release === 'string' && realpathSync(dirname(record.release)) === realpathSync(releases) && existsSync(join(record.release, 'dist/cli.js')) ? record : undefined;
  } catch { return undefined; }
}

function writeUnitRelease(deployments: string, unit: string, release: string, pid: number | undefined, schema: string | undefined): void {
  let identity: ProcessIdentity | undefined;
  try { if (pid !== undefined) identity = childProcessIdentity(pid); } catch { /* 已退出的成功版本仍可供停服后的恢复使用 */ }
  const file = unitReleaseFile(deployments, unit), temp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(temp, `${JSON.stringify({ unit, release, process_identity: identity, schema_fingerprint: schema })}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/** 旧版没有自报 release：本 PID 映射的原生依赖路径仍指向启动时的真实 release，不受 current 切换影响。 */
function readProcessRelease(pid: number, releases: string): string | undefined {
  try {
    const identity = childProcessIdentity(pid);
    const root = realpathSync(releases);
    const paths = readFileSync(`/proc/${pid}/maps`, 'utf8').split('\n').flatMap(line => {
      const at = line.indexOf(' /');
      const path = at < 0 ? '' : line.slice(at + 1).replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      return path.endsWith('.node') ? [path] : [];
    });
    // 显式使用不可变 cli.js 的进程也可核实；current 参数只能表示启动入口，不能表示加载版本。
    const cli = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[1];
    try { if (cli?.endsWith('/dist/cli.js') && realpathSync(cli) === cli) paths.push(cli); } catch { /* 入口已被移除，仍可从映射核实 */ }
    const found = new Set(paths.flatMap(path => {
      const local = relative(root, path), name = local.split(sep)[0];
      if (!name || !RELEASE_NAME.test(name) || local.startsWith('..') || isAbsolute(local)) return [];
      const release = join(root, name);
      return existsSync(join(release, 'dist/cli.js')) ? [release] : [];
    }));
    return found.size === 1 && observeProcess(identity) === 'alive' ? [...found][0] : undefined;
  } catch { return undefined; }
}

function recordedReleases(deployments: string): string[] {
  try {
    return readdirSync(join(deployments, 'units')).flatMap(name => {
      try {
        const record = JSON.parse(readFileSync(join(deployments, 'units', name), 'utf8')) as UnitRelease;
        return typeof record.release === 'string' ? [resolve(record.release)] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

/** 新链接先建在临时名下，再 rename 覆盖 `current`：切换是原子的。 */
function pointCurrent(releases: string, release: string): void {
  const temp = join(releases, `.current.${process.pid}.tmp`);
  rmSync(temp, { force: true });
  symlinkSync(relative(releases, release), temp);
  renameSync(temp, join(releases, 'current'));
}


const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 比较持久 schema 和迁移集合，不比较任务、配置等运行数据；打不开或迁移记录非法时拒绝自动回滚。 */
function databaseSchema(file: string): { version: number; fingerprint: string } | undefined {
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return db.transaction(() => {
        const schema = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
        const versions = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
          ? (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map(row => row.version)
          : [];
        if (versions.some(version => !Number.isSafeInteger(version) || version < 0)) return undefined;
        const userVersion = db.pragma('user_version', { simple: true });
        return {
          version: versions.at(-1) ?? 0,
          fingerprint: createHash('sha256').update(JSON.stringify({ schema, versions, userVersion })).digest('hex')
        };
      })();
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** 部署成功后按版本名保留最新的几个发布目录和部署记录；current、上一版和仍被运行中进程引用的另外保留。 */
export const RELEASES_TO_KEEP = 5;
/** 写进 manifest.json 的来源标记：只有带它的部署记录才会被自动清理，手工部署留下的记录不动。 */
export const DEPLOY_RECORD_CREATOR = 'dutydeck deploy';
const RELEASE_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{7}(-dirty)?(-[A-Za-z0-9]{6})?$/;
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

export interface PruneItem { kind: 'release' | 'partial' | 'record'; name: string; bytes: number }

/** 手工清理（`deploy prune`）才用的选项；部署成功后的自动清理不传。 */
interface PruneOptions {
  /** 保留最新几个，默认 RELEASES_TO_KEEP。 */
  keep?: number;
  /** 只统计，不删除。 */
  dryRun?: boolean;
  /** 部署记录里也算上手工部署留下的（没有 deploy 的 created_by 标记），这些只在确认没有进程引用时才删。 */
  includeUnmarked?: boolean;
  /** 设了就保护这么久以内改过的 `.partial` 和没有 manifest 的部署记录：它们可能是另一次正在进行的部署。 */
  protectRecentMs?: number;
  now?: number;
  /** 收集逐项明细、跳过的项和删除失败；设了之后单项删除失败不抛出，继续清理其余的。 */
  report?: { items: PruneItem[]; skipped: string[]; errors: string[] };
}

const RECORD_NAME = /^\d{8}[T-]/;

function removeEntry(path: string, name: string, kind: PruneItem['kind'], result: { removed: string[]; freedBytes: number }, opts: PruneOptions): void {
  const bytes = diskUsage(path);
  if (!opts.dryRun) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      if (!opts.report) throw error;
      opts.report.errors.push(`${name}：${message(error)}`);
      return;
    }
  }
  result.freedBytes += bytes;
  result.removed.push(name);
  opts.report?.items.push({ kind, name, bytes });
}

const recentlyModified = (path: string, opts: PruneOptions): boolean =>
  opts.protectRecentMs !== undefined && (opts.now ?? Date.now()) - statSync(path).mtimeMs < opts.protectRecentMs;

function referencedBy(paths: string[], dirs: string[]): boolean {
  return dirs.some(dir => {
    const pattern = new RegExp(`${escapeRegExp(dir)}(?![\\w.-])`);
    return paths.some(path => pattern.test(path));
  });
}

/**
 * 删掉更早的发布目录和复制中断留下的 `.<id>.partial`。服务重启后，tmux 里保留下来的 Agent 进程环境变量中
 * 仍是旧版本 cli.js 的路径（dutydeck_relay_command），所以任何运行中进程的 cwd、命令行、环境变量或已映射
 * 文件还引用着的目录都不删；看不了进程就只清 `.partial`。
 */
function pruneReleases(releases: string, previous: string | undefined, processPaths: () => string[] | undefined, warn: (message: string) => void, opts: PruneOptions = {}): PruneResult {
  const result: PruneResult = { removed: [], inUse: [], freedBytes: 0 };
  const names = readdirSync(releases, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const name of names.filter(name => PARTIAL_NAME.test(name))) {
    if (recentlyModified(join(releases, name), opts)) opts.report?.skipped.push(name);
    else removeEntry(join(releases, name), name, 'partial', result, opts);
  }
  const real = realpathSync(releases);
  const keep = new Set([currentRelease(releases), previous, ...recordedReleases(join(dirname(releases), 'deployments'))].flatMap(path => {
    try { return path ? [realpathSync(path)] : []; } catch { return []; }
  }));
  const candidates = names.filter(name => RELEASE_NAME.test(name)).sort().reverse().slice(opts.keep ?? RELEASES_TO_KEEP).filter(name => !keep.has(join(real, name)));
  if (candidates.length === 0) return result;
  const paths = processPaths();
  if (!paths) {
    warn(`读不到 /proc，确认不了 ${candidates.length} 个旧发布目录是否仍被运行中的进程引用，这次不删。`);
    return result;
  }
  for (const name of candidates) {
    if (referencedBy(paths, [join(releases, name), join(real, name)])) result.inUse.push(name);
    else removeEntry(join(releases, name), name, 'release', result, opts);
  }
  return result;
}

/**
 * 删掉更早的部署记录（manifest 与数据库备份）。默认只算 manifest.json 里 created_by 是 DEPLOY_RECORD_CREATOR 的，
 * 按名字保留最新 RELEASES_TO_KEEP 个；本次的记录还没写 manifest，直接算进去，它和上一版的记录总是保留。
 * `includeUnmarked` 时手工部署留下的记录（名字以日期开头）也参与排序，但只在确认没有进程引用、也不是刚改过时才删。
 */
function pruneRecords(deployments: string, current: string, previous: string | undefined, opts: PruneOptions = {}, processPaths?: () => string[] | undefined): { removed: string[]; freedBytes: number } {
  const result = { removed: [] as string[], freedBytes: 0 };
  const marked = (name: string) => {
    try { return JSON.parse(readFileSync(join(deployments, name, 'manifest.json'), 'utf8')).created_by === DEPLOY_RECORD_CREATOR; } catch { return false; }
  };
  const eligible = readdirSync(deployments, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    .filter(name => name === current || marked(name) || (opts.includeUnmarked === true && RECORD_NAME.test(name)));
  let paths: string[] | undefined;
  let pathsRead = false;
  for (const name of eligible.sort().reverse().slice(opts.keep ?? RELEASES_TO_KEEP)) {
    if (name === current || name === previous) continue;
    const path = join(deployments, name);
    if (!marked(name)) {
      // 没有 deploy 的标记：内容不明。没有 manifest 又刚改过的可能是正在进行的部署；还被进程引用的也不动。
      if (!existsSync(join(path, 'manifest.json')) && recentlyModified(path, opts)) { opts.report?.skipped.push(name); continue; }
      if (!pathsRead) { paths = processPaths?.(); pathsRead = true; }
      if (!paths || referencedBy(paths, [path, join(realpathSync(deployments), name)])) { opts.report?.skipped.push(name); continue; }
    }
    removeEntry(path, name, 'record', result, opts);
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

/**
 * 排空成功后每 DRAIN_INTERVAL_MS 续一次租约，直到旧进程退出或调用返回的 stop：备份（Tag 库备份可能超过
 * 60 秒的租约）、切换、重启期间旧进程都不会开始执行排队的任务。旧进程一退出就不再续，免得续到新进程上。
 */
function keepDraining(drain: DrainResult, pid: number | undefined): () => Promise<void> {
  const renew = drain.ok ? drain.renew : undefined;
  if (!renew || pid === undefined) return async () => {};
  let renewal: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pidAlive(pid)) renewal = renew();
    else clearInterval(timer);
  }, DRAIN_INTERVAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await renewal;
  };
}

/** 已确认停服后才调用；部署前快照只用于兼容检查和人工恢复，绝不覆盖当前数据库。 */
async function checkDatabaseForRollback(
  database: string, record: string, manifest: Record<string, unknown>, deps: DeployDeps
): Promise<string | undefined> {
  const current = databaseSchema(database);
  manifest.schema_version_at_rollback = current?.version ?? null;
  manifest.schema_fingerprint_at_rollback = current?.fingerprint ?? null;
  const backup = typeof manifest.database_backup === 'string' ? manifest.database_backup : undefined;
  const before = backup ? databaseSchema(backup) : undefined;
  let reason: string | undefined;
  if (!before || before.fingerprint !== manifest.schema_fingerprint_before) reason = `部署前的数据库 schema 无法核实（备份：${backup ?? '缺失'}）。`;
  else if (!current) reason = `读不出当前数据库 ${database} 的 schema。`;
  else if (current.fingerprint !== before.fingerprint) reason = `数据库 schema 已变化（迁移版本 ${before.version} → ${current.version}）。`;
  if (!reason) return undefined;

  // 另存供排障使用；失败也绝不恢复旧快照或启动旧版。
  const beforeRollback = join(record, `${basename(database)}.before-rollback`);
  try {
    await (deps.backupDatabase ?? backupSqlite)(database, beforeRollback);
    manifest.database_before_rollback = beforeRollback;
  } catch (error) {
    manifest.database_preservation_error = message(error);
    reason += `另存当前数据库失败：${message(error)}。`;
  }
  return reason;
}

async function restartAndCheck(service: ServiceControl, previousPid: number | undefined, address: string | undefined, deps: DeployDeps) {
  const error = await service.restart();
  if (error) return { ok: false as const, error };
  return await waitForServiceHealth(service, previousPid, address, deps, deps.healthTimeoutMs);
}

export async function runDeploy(options: DeployCliOptions, deps: DeployDeps = {}): Promise<DeployResult> {
  const now = () => new Date((deps.now ?? Date.now)());

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
  const lock = acquireDeployLock(target.releases);
  if ('error' in lock) return refused(lock.error);
  try { return await deployLocked(options, deps, target); }
  finally { lock.close(); }
}

async function deployLocked(options: DeployCliOptions, deps: DeployDeps, target: DeployTarget): Promise<DeployResult> {
  const info = deps.info ?? defaultInfo;
  const warn = deps.warn ?? defaultWarn;
  const now = () => new Date((deps.now ?? Date.now)());
  const restart = options.restart !== false;
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

  const service = deps.service ?? systemdServiceControl(target.unit, deps);
  const previousPid = restart ? await service.mainPid() : undefined;
  const recorded = readUnitRelease(target.deployments, target.unit, target.releases);
  const recordedRunning = previousPid !== undefined && recorded?.process_identity?.pid === previousPid && observeProcess(recorded.process_identity) === 'alive';
  // 停服可能是上一次迁移失败所致；历史成功版本必须仍认识当前 schema，才能代替 current。
  const recordedStopped = restart && previousPid === undefined && recorded?.schema_fingerprint && target.endpoint.database &&
    recorded.schema_fingerprint === databaseSchema(target.endpoint.database)?.fingerprint;
  const previousRelease = !restart ? currentRelease(target.releases)
    : previousPid !== undefined
      ? recordedRunning ? recorded!.release : (deps.processRelease ?? readProcessRelease)(previousPid, target.releases)
      : recordedStopped ? recorded!.release : currentRelease(target.releases);
  if (restart && previousPid !== undefined && (!previousRelease || await service.mainPid() !== previousPid)) {
    return refused(`无法核实 unit ${target.unit} 主进程 ${previousPid} 实际运行的发布版本，已拒绝切换 current。确认该进程的不可变 release 路径及读取 /proc 的权限后重试。`);
  }

  const startedAt = now();
  const prefix = `${startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${build.commit.slice(0, 7)}${build.dirty ? '-dirty' : ''}`;
  mkdirSync(target.deployments, { recursive: true, mode: 0o700 });
  const record = mkdtempSync(join(target.deployments, `${prefix}-`));
  const id = basename(record);
  const release = join(target.releases, id);
  const manifestPath = join(record, 'manifest.json');
  const manifest: Record<string, unknown> = {
    created_by: DEPLOY_RECORD_CREATOR, commit: build.commit, dirty: build.dirty, source, unit: target.unit, release, previous_release: previousRelease ?? null,
    backup: record, status: 'preparing', started_at: startedAt.toISOString()
  };
  let pruned: PruneResult | undefined;
  let prunedRecords: DeployResult['prunedRecords'];
  const remember = (path: string, pid: number | undefined) => {
    try { writeUnitRelease(target.deployments, target.unit, path, pid, target.endpoint.database ? databaseSchema(target.endpoint.database)?.fingerprint : undefined); }
    catch (error) { warn(`记录 ${target.unit} 的成功运行版本失败：${message(error)}`); }
  };
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

  if (await service.mainPid() !== previousPid) return finish('failed', { error: '准备发布目录期间目标主进程已变化，没有切换版本；重新执行部署以核实它的运行版本。' });
  manifest.previous_pid = previousPid ?? null;
  let drain: DrainResult = { ok: true };
  if (previousPid !== undefined) {
    info('排空：新消息照常入队，等正在执行的任务结束…');
    drain = await drainRuntime(target.endpoint, options, deps);
    if (!drain.ok) return finish('failed', { error: drain.error });
  }
  const stopRenewing = keepDraining(drain, previousPid);
  const database = target.endpoint.database;
  if (database && existsSync(database)) {
    const backup = join(record, basename(database));
    info(`备份数据库：${backup}`);
    try {
      await (deps.backupDatabase ?? backupSqlite)(database, backup);
      manifest.database_backup = backup;
      const schema = databaseSchema(backup);
      manifest.schema_version_before = schema?.version ?? null;
      manifest.schema_fingerprint_before = schema?.fingerprint ?? null;
    } catch (error) {
      await stopRenewing();
      await drain.release?.();
      return finish('failed', { error: `备份数据库失败，没有切换版本：${message(error)}` });
    }
  }

  if (await service.mainPid() !== previousPid) {
    await stopRenewing();
    await drain.release?.();
    return finish('failed', { error: '排空或备份期间目标主进程已变化，没有切换版本；重新执行部署以核实它的运行版本。' });
  }
  if (previousPid !== undefined && previousRelease) remember(previousRelease, previousPid);

  info(`切换 current → ${id}，重启 ${target.unit}`);
  pointCurrent(target.releases, release);
  const started = await restartAndCheck(service, previousPid, target.endpoint.address, deps);
  await stopRenewing();
  if (started.ok) {
    info(`健康检查通过（pid ${started.pid}）`);
    updateDeploymentFile(target, release, build.commit, manifestPath, now());
    remember(release, started.pid);
    prune();
    return finish('deployed', { new_pid: started.pid });
  }
  manifest.database_restored = false;
  manifest.rollback_service_stopped = false;
  const blocked = (reason: string) => finish('rollback_failed', {
    rollback_blocked_reason: reason,
    error: `新版本没有通过健康检查：${started.error}自动回滚已停止：${reason}未切回上一版，数据库未恢复旧快照。需要人工恢复；数据库路径：${database ?? '未知'}，部署前备份：${manifest.database_backup ?? '无'}，部署记录：${manifestPath}。`
  });
  warn(`新版本没有通过健康检查，先停服务并检查回滚兼容性。原因：${started.error}`);
  try {
    const stopped = await service.stop();
    if (stopped) return blocked(`停服务失败：${stopped}。`);
    const remainingPid = await service.mainPid();
    if (remainingPid !== undefined) return blocked(`停服务后仍有主进程 ${remainingPid}。`);
  } catch (error) {
    return blocked(`无法确认服务已停止：${message(error)}。`);
  }
  manifest.rollback_service_stopped = true;
  if (!previousRelease) return finish('failed', { error: `新版本没有通过健康检查，服务已停止，也没有上一版可以切回。保留当前数据库，需要人工恢复。原因：${started.error}` });

  const databaseError = database && database !== ':memory:'
    ? await checkDatabaseForRollback(database, record, manifest, deps)
    : '无法验证目标数据库路径及其 schema，不能据此认定没有持久数据库。';
  if (databaseError) return blocked(databaseError);

  info(`服务已停止，数据库 schema 兼容；切回 ${basename(previousRelease)}，使用当前数据库重启。`);
  pointCurrent(target.releases, previousRelease);
  await service.resetFailed?.();
  const back = await restartAndCheck(service, undefined, target.endpoint.address, deps);
  if (back.ok) remember(previousRelease, back.pid);
  return back.ok
    ? finish('rolled_back', { new_pid: back.pid, error: `新版本 ${id} 没有通过健康检查，已切回 ${basename(previousRelease)}，保留当前数据库。原因：${started.error}` })
    : finish('rollback_failed', { error: `新版本没有通过健康检查，切回 ${basename(previousRelease)} 后仍不健康，数据库未恢复旧快照。新版本：${started.error}上一版：${back.error}` });
}

// ─── 手工清理 ────────────────────────────────────────────────────────────────

export interface DeployPruneResult {
  ok: boolean;
  dryRun: boolean;
  keep: number;
  releases?: string;
  deployments?: string;
  /** 已删除（dry-run 时是将删除）的项和各自占用的磁盘字节数。 */
  items: PruneItem[];
  freedBytes: number;
  /** 仍被运行中的进程引用而保留的发布目录。 */
  inUse: string[];
  /** 可能是正在进行的部署，或内容不明又确认不了有没有进程在用，这次没动。 */
  skipped: string[];
  error?: string;
}

/** 最近改过的 `.partial` 和没有 manifest 的部署记录视为正在进行的部署，手工清理不碰。 */
const IN_PROGRESS_WINDOW_MS = 60 * 60 * 1000;

/** current 指向的版本的上一版：优先取它的部署记录里写的 previous_release，没有就取名字上紧邻的更早一个。 */
function rollbackTarget(releases: string, deployments: string): string | undefined {
  const current = currentRelease(releases);
  if (!current) return undefined;
  try {
    for (const entry of readdirSync(deployments, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      try {
        const manifest = JSON.parse(readFileSync(join(deployments, entry.name, 'manifest.json'), 'utf8')) as Record<string, unknown>;
        if (typeof manifest.release === 'string' && typeof manifest.previous_release === 'string' && resolve(manifest.release) === current) return manifest.previous_release;
      } catch { /* 手工部署的记录，没有可读的 manifest */ }
    }
  } catch { /* 没有部署记录目录 */ }
  return readdirSync(releases, { withFileTypes: true }).filter(entry => entry.isDirectory() && RELEASE_NAME.test(entry.name))
    .map(entry => join(releases, entry.name)).sort().reverse().find(path => path < current);
}

/**
 * `dutydeck deploy prune`：对指定目标做一次和部署成功后相同的清理，可指定保留个数，可以只预览。
 * 永远不删 current、它的上一版和仍被进程引用的版本；不碰 current 以外也不在 releases/deployments 下的任何东西。
 */
export async function runDeployPrune(options: DeployPruneCliOptions, deps: DeployDeps = {}): Promise<DeployPruneResult> {
  const warn = deps.warn ?? defaultWarn;
  const dryRun = options.dryRun === true;
  const base: DeployPruneResult = { ok: false, dryRun, keep: RELEASES_TO_KEEP, items: [], freedBytes: 0, inUse: [], skipped: [] };
  if (options.keep !== undefined) {
    if (!/^\d+$/.test(options.keep) || Number(options.keep) < 1) return { ...base, error: `--keep 只接受正整数（收到 ${JSON.stringify(options.keep)}）。` };
    base.keep = Number(options.keep);
  }
  let releases: string;
  if (options.releases) {
    releases = resolve(options.releases);
  } else {
    const target = await resolveTarget({ unit: options.unit, runtime: options.runtime, restart: false }, deps);
    if ('error' in target) return { ...base, error: target.error };
    releases = target.releases;
  }
  const deployments = join(dirname(releases), 'deployments');
  if (!existsSync(releases)) return { ...base, releases, deployments, error: `发布目录 ${releases} 不存在。` };

  const lock = acquireDeployLock(releases);
  if ('error' in lock) return { ...base, releases, deployments, error: lock.error };
  try {
    const report: NonNullable<PruneOptions['report']> = { items: [], skipped: [], errors: [] };
    const opts: PruneOptions = {
      keep: base.keep, dryRun, includeUnmarked: options.includeUnmarked === true,
      protectRecentMs: IN_PROGRESS_WINDOW_MS, now: (deps.now ?? Date.now)(), report
    };
    const processPaths = deps.processPaths ?? readProcessPaths;
    const previous = rollbackTarget(releases, deployments);
    const current = currentRelease(releases);
    let inUse: string[] = [];
    try {
      inUse = pruneReleases(releases, previous, processPaths, warn, opts).inUse;
      if (existsSync(deployments)) pruneRecords(deployments, current ? basename(current) : '', previous && basename(previous), opts, processPaths);
    } catch (error) {
      report.errors.push(message(error));
    }
    return {
      ...base, ok: report.errors.length === 0, releases, deployments, items: report.items, inUse, skipped: report.skipped,
      freedBytes: report.items.reduce((total, item) => total + item.bytes, 0),
      ...(report.errors.length > 0 ? { error: `有 ${report.errors.length} 项没清理成功：${report.errors.join('；')}` } : {})
    };
  } finally { lock.close(); }
}
