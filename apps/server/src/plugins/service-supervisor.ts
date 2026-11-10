import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { parseProcStat, procStatExited } from '@dutydeck/shared';
import { childEnvironment } from '@dutydeck/shared/child-environment';

export type PluginServiceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

export interface PluginServiceSpec {
  plugin: string;
  root: string;
  entry: string;
  dataDir: string;
  mode?: 'manual' | 'auto';
  args?: readonly string[];
  /** Only non-sensitive user configuration is allowed here. */
  config?: Readonly<Record<string, string>>;
}

export interface PluginServiceSnapshot {
  plugin: string;
  status: PluginServiceStatus;
  root: string;
  entry: string;
  pid?: number;
  restarts: number;
  lastExitCode?: number | null;
  lastError?: string;
}

type Log = { warn(data: Record<string, unknown>, message: string): void } | undefined;

/** 自动重启与错误流日志的节奏；测试可以调小。 */
export interface PluginServiceTiming {
  /** 第 n 次自动重启前等 base × 2^(n-1)。 */
  restartBaseDelayMs: number;
  /** 子进程连续运行这么久后崩溃，按新一轮故障重新计数。 */
  stableRunMs: number;
  /** 每个插件每个窗口最多记这么多条错误流日志，其余只计数。 */
  stderrLogLimit: number;
  stderrWindowMs: number;
  now(): number;
}
const DEFAULT_TIMING: PluginServiceTiming = { restartBaseDelayMs: 1_000, stableRunMs: 60_000, stderrLogLimit: 20, stderrWindowMs: 60_000, now: Date.now };

/**
 * Owns plugin service children without sharing the daemon's provider process.
 * The caller must pass paths from the active artifact; the supervisor never
 * re-resolves a candidate path while a child is running.
 */
export class PluginServiceSupervisor {
  private readonly records = new Map<string, RecordState>();

  private readonly timing: PluginServiceTiming;
  constructor(private readonly log?: Log, private readonly stopTimeoutMs = 5_000, timing: Partial<PluginServiceTiming> = {}) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  register(spec: PluginServiceSpec): void {
    const existing = this.records.get(spec.plugin);
    if (existing?.child || existing?.operation) throw new Error(`PLUGIN_SERVICE_RUNNING: ${spec.plugin}`);
    if (existing) clearAutoRestart(existing);
    this.records.set(spec.plugin, { spec: freezeSpec(spec), status: 'stopped', restarts: existing?.restarts ?? 0 });
  }

  async start(plugin: string): Promise<PluginServiceSnapshot> {
    return this.enqueue(plugin, record => this.startInternal(record, false));
  }

  private async startInternal(record: RecordState, automatic: boolean): Promise<PluginServiceSnapshot> {
    const plugin = record.spec.plugin;
    if (record.child && (record.status === 'starting' || record.status === 'running')) return snapshot(record);
    if (record.child) await this.stopInternal(record);
    if (!automatic) {
      clearAutoRestart(record);
      record.autoRestartCount = 0;
    }
    record.status = 'starting';
    record.lastError = undefined;
    const safeConfig = Object.fromEntries(Object.entries(record.spec.config ?? {}).filter(([key]) => !/(?:token|secret|password|credential|auth|key)/i.test(key)));
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'NODE_PATH'].includes(key) || key.startsWith('LC_')));
    const env = childEnvironment(inherited, {
      DUTYDECK_PLUGIN_NAME: record.spec.plugin,
      DUTYDECK_PLUGIN_ROOT: record.spec.root,
      DUTYDECK_PLUGIN_DATA: record.spec.dataDir,
      DUTYDECK_PLUGIN_SERVICE: '1',
      ...Object.fromEntries(Object.entries(safeConfig).map(([key, value]) => [`DUTYDECK_PLUGIN_CONFIG_${key.toUpperCase()}`, value]))
    });
    const child = spawn(process.execPath, [record.spec.entry, ...(record.spec.args ?? [])], {
      cwd: record.spec.root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    record.child = child;
    record.processGroup = child.pid && process.platform !== 'win32' ? { pid: child.pid, start: linuxStart(child.pid), exited: false } : undefined;
    record.status = 'running';
    record.startedAt = this.timing.now();
    child.stdout?.resume();
    child.stderr?.on('data', chunk => this.logStderr(record, String(chunk)));
    child.once('error', error => {
      if (record.child !== child || record.status === 'stopping') return;
      this.crash(record, child, error.message, undefined);
      this.log?.warn({ plugin, error: error.message }, '插件服务启动失败');
    });
    child.once('exit', (code, signal) => {
      if (record.child !== child) return;
      if (record.status === 'stopping') {
        record.lastExitCode = code;
        return;
      }
      this.crash(record, child, signal ? `signal:${signal}` : undefined, code);
      this.log?.warn({ plugin, code, signal }, '插件服务异常退出');
    });
    return snapshot(record);
  }

  private crash(record: RecordState, child: ChildProcess, error: string | undefined, code: number | null | undefined): void {
    if (record.child !== child || record.status === 'crashed') return;
    // 保留进程组所有权：主进程退出后，下一次启停仍需清退同组 worker。
    record.status = 'crashed';
    record.lastError = error;
    record.lastExitCode = code ?? child.exitCode;
    record.restarts += 1;
    if (record.spec.mode !== 'auto') return;
    // 稳定运行过一段时间再崩溃，是新的一次故障，不累计到之前的重试次数上。
    if (record.startedAt !== undefined && this.timing.now() - record.startedAt >= this.timing.stableRunMs) record.autoRestartCount = 0;
    if ((record.autoRestartCount ?? 0) >= AUTO_RESTART_LIMIT) {
      this.log?.warn({ plugin: record.spec.plugin, restarts: record.restarts, lastExitCode: record.lastExitCode, lastError: record.lastError }, `插件服务连续崩溃 ${AUTO_RESTART_LIMIT + 1} 次，已停止自动重启；修复后手动启动`);
      return;
    }
    const attempt = (record.autoRestartCount ?? 0) + 1;
    record.autoRestartCount = attempt;
    record.autoRestartTimer = setTimeout(() => {
      record.autoRestartTimer = undefined;
      void this.enqueue(record.spec.plugin, async current => {
        if (current !== record || record.status !== 'crashed') return snapshot(current);
        return this.startInternal(record, true);
      }).catch(startError => {
        record.status = 'crashed';
        record.lastError = startError instanceof Error ? startError.message : String(startError);
      });
    }, this.timing.restartBaseDelayMs * 2 ** (attempt - 1));
  }

  /** 错误流按插件限流：每个窗口记前若干条，之后只计数，下个窗口开头报一次省略了多少。 */
  private logStderr(record: RecordState, text: string): void {
    const plugin = record.spec.plugin, now = this.timing.now();
    let window = record.stderrWindow;
    if (!window || now - window.start >= this.timing.stderrWindowMs) {
      if (window?.suppressed) this.log?.warn({ plugin, suppressed: window.suppressed }, '插件服务错误流输出过多，上一时段省略了部分日志');
      window = record.stderrWindow = { start: now, logged: 0, suppressed: 0 };
    }
    if (window.logged >= this.timing.stderrLogLimit) { window.suppressed += 1; return; }
    window.logged += 1;
    this.log?.warn({ plugin, stderr: text.slice(0, 8_192), ...(window.logged === this.timing.stderrLogLimit ? { throttled: true } : {}) }, window.logged === this.timing.stderrLogLimit ? '插件服务输出错误流（本时段已达上限，后续只计数）' : '插件服务输出错误流');
  }

  async stop(plugin: string): Promise<PluginServiceSnapshot> {
    return this.enqueue(plugin, record => this.stopInternal(record));
  }

  private async stopInternal(record: RecordState): Promise<PluginServiceSnapshot> {
    clearAutoRestart(record);
    const child = record.child;
    if (!child) { record.status = 'stopped'; return snapshot(record); }
    record.status = 'stopping';
    await signal(record, 'SIGTERM');
    if (!await waitForExit(record, this.stopTimeoutMs)) {
      await signal(record, 'SIGKILL');
      if (!await waitForExit(record, this.stopTimeoutMs)) throw new Error('PLUGIN_SERVICE_STOP_TIMEOUT');
    }
    record.child = undefined;
    record.processGroup = undefined;
    record.status = 'stopped';
    return snapshot(record);
  }

  async restart(plugin: string): Promise<PluginServiceSnapshot> {
    return this.enqueue(plugin, async record => {
      await this.stopInternal(record);
      return this.startInternal(record, false);
    });
  }

  private enqueue(plugin: string, action: (record: RecordState) => Promise<PluginServiceSnapshot>): Promise<PluginServiceSnapshot> {
    const record = this.records.get(plugin);
    if (!record) return Promise.reject(new Error(`PLUGIN_SERVICE_NOT_FOUND: ${plugin}`));
    const operation = (record.operation ?? Promise.resolve()).then(() => action(record));
    const tail = operation.then(() => undefined, () => undefined);
    record.operation = tail;
    void tail.then(() => { if (record.operation === tail) record.operation = undefined; });
    return operation;
  }

  status(plugin?: string): PluginServiceSnapshot | PluginServiceSnapshot[] {
    if (plugin) {
      const record = this.records.get(plugin);
      if (!record) throw new Error(`PLUGIN_SERVICE_NOT_FOUND: ${plugin}`);
      return snapshot(record);
    }
    return [...this.records.values()].map(snapshot);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.records.keys()].map(plugin => this.stop(plugin).catch(error => this.log?.warn({ plugin, error }, '插件服务停止失败'))));
  }
}

interface RecordState {
  spec: PluginServiceSpec;
  status: PluginServiceStatus;
  child?: ChildProcess;
  processGroup?: { pid: number; start?: string; exited: boolean };
  operation?: Promise<void>;
  restarts: number;
  lastExitCode?: number | null;
  lastError?: string;
  autoRestartCount?: number;
  autoRestartTimer?: ReturnType<typeof setTimeout>;
  startedAt?: number;
  stderrWindow?: { start: number; logged: number; suppressed: number };
}

const AUTO_RESTART_LIMIT = 3;

function clearAutoRestart(record: RecordState): void {
  if (record.autoRestartTimer) clearTimeout(record.autoRestartTimer);
  record.autoRestartTimer = undefined;
}

function freezeSpec(spec: PluginServiceSpec): PluginServiceSpec {
  return Object.freeze({ ...spec, args: Object.freeze([...(spec.args ?? [])]), config: Object.freeze({ ...(spec.config ?? {}) }) });
}

function snapshot(record: RecordState): PluginServiceSnapshot {
  return {
    plugin: record.spec.plugin,
    status: record.status,
    root: record.spec.root,
    entry: record.spec.entry,
    ...(record.child?.pid && record.status !== 'crashed' ? { pid: record.child.pid } : {}),
    restarts: record.restarts,
    ...(record.lastExitCode !== undefined ? { lastExitCode: record.lastExitCode } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {})
  };
}

function linuxStart(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try { return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8')).start; }
  catch (error) { if (!gone(error)) throw error; return undefined; }
}

function gone(error: unknown): boolean {
  return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
}

async function alive(record: RecordState): Promise<boolean> {
  const group = record.processGroup;
  if (!group) return !!record.child?.pid && record.child.exitCode === null && record.child.signalCode === null;
  if (group.exited) return false;
  let live: boolean;
  if (process.platform === 'linux') {
    // PID + 启动时间阻止把复用的组长当成旧服务；孤儿僵尸不再执行，不阻塞停止。
    const start = linuxStart(group.pid);
    if (group.start && start && group.start !== start) { group.exited = true; return false; }
    const members = await Promise.all((await readdir('/proc')).filter(pid => /^\d+$/.test(pid)).map(async pid => {
      try {
        const stat = parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
        return stat.pgid === group.pid && !procStatExited(stat);
      } catch (error) { if (gone(error)) return false; throw error; }
    }));
    live = members.some(Boolean);
  } else {
    const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,pgid=,stat=']);
    live = stdout.split('\n').some(line => {
      const [, pgid, state] = line.trim().split(/\s+/);
      return Number(pgid) === group.pid && !/^[ZX]/.test(state ?? '');
    });
  }
  if (!live) group.exited = true;
  return live;
}

async function signal(record: RecordState, name: NodeJS.Signals): Promise<void> {
  if (!await alive(record)) return;
  try {
    if (record.processGroup) {
      const group = record.processGroup, start = linuxStart(group.pid);
      // alive() 会异步扫描进程表，发送信号前再次核对组长身份。
      if (group.start && start && group.start !== start) { group.exited = true; return; }
      process.kill(-group.pid, name);
    } else record.child?.kill(name);
  } catch (error) { if (!gone(error)) throw error; }
}

async function waitForExit(record: RecordState, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (await alive(record)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}
