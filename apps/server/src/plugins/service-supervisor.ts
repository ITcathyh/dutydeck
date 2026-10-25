import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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

/**
 * Owns plugin service children without sharing the daemon's provider process.
 * The caller must pass paths from the active artifact; the supervisor never
 * re-resolves a candidate path while a child is running.
 */
export class PluginServiceSupervisor {
  private readonly records = new Map<string, RecordState>();

  constructor(private readonly log?: Log, private readonly stopTimeoutMs = 5_000) {}

  register(spec: PluginServiceSpec): void {
    const existing = this.records.get(spec.plugin);
    if (existing?.child && existing.status !== 'stopped') throw new Error(`PLUGIN_SERVICE_RUNNING: ${spec.plugin}`);
    if (existing) clearAutoRestart(existing);
    this.records.set(spec.plugin, { spec: freezeSpec(spec), status: 'stopped', restarts: existing?.restarts ?? 0 });
  }

  async start(plugin: string): Promise<PluginServiceSnapshot> {
    return this.startInternal(plugin, false);
  }

  private async startInternal(plugin: string, automatic: boolean): Promise<PluginServiceSnapshot> {
    const record = this.records.get(plugin);
    if (!record) throw new Error(`PLUGIN_SERVICE_NOT_FOUND: ${plugin}`);
    if (record.child && (record.status === 'starting' || record.status === 'running')) return snapshot(record);
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
    record.status = 'running';
    child.stdout?.resume();
    child.stderr?.on('data', chunk => this.log?.warn({ plugin, stderr: String(chunk).slice(0, 8_192) }, '插件服务输出错误流'));
    child.once('error', error => {
      if (record.child !== child) return;
      this.crash(record, child, error.message, undefined);
      this.log?.warn({ plugin, error: error.message }, '插件服务启动失败');
    });
    child.once('exit', (code, signal) => {
      if (record.child !== child) return;
      if (record.status === 'stopping') {
        record.child = undefined;
        record.lastExitCode = code;
        record.status = 'stopped';
        return;
      }
      this.crash(record, child, signal ? `signal:${signal}` : undefined, code);
      this.log?.warn({ plugin, code, signal }, '插件服务异常退出');
    });
    return snapshot(record);
  }

  private crash(record: RecordState, child: ChildProcess, error: string | undefined, code: number | null | undefined): void {
    if (record.child !== child) return;
    record.child = undefined;
    record.status = 'crashed';
    record.lastError = error;
    record.lastExitCode = code ?? child.exitCode;
    record.restarts += 1;
    if (record.spec.mode !== 'auto' || (record.autoRestartCount ?? 0) >= AUTO_RESTART_LIMIT) return;
    const attempt = (record.autoRestartCount ?? 0) + 1;
    record.autoRestartCount = attempt;
    record.autoRestartTimer = setTimeout(() => {
      record.autoRestartTimer = undefined;
      if (record.status !== 'crashed' || record.child) return;
      void this.startInternal(record.spec.plugin, true).catch(startError => {
        record.status = 'crashed';
        record.lastError = startError instanceof Error ? startError.message : String(startError);
      });
    }, AUTO_RESTART_BASE_DELAY_MS * 2 ** (attempt - 1));
  }

  async stop(plugin: string): Promise<PluginServiceSnapshot> {
    const record = this.records.get(plugin);
    if (!record) throw new Error(`PLUGIN_SERVICE_NOT_FOUND: ${plugin}`);
    const child = record.child;
    if (!child) { clearAutoRestart(record); record.status = 'stopped'; return snapshot(record); }
    record.status = 'stopping';
    kill(child, 'SIGTERM');
    await waitForExit(child, this.stopTimeoutMs).catch(async () => {
      kill(child, 'SIGKILL');
      await waitForExit(child, this.stopTimeoutMs).catch(() => undefined);
    });
    clearAutoRestart(record);
    if (record.child === child) record.child = undefined;
    record.status = 'stopped';
    return snapshot(record);
  }

  async restart(plugin: string): Promise<PluginServiceSnapshot> {
    await this.stop(plugin);
    return this.start(plugin);
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
    await Promise.all([...this.records.keys()].map(plugin => this.stop(plugin).catch(error => this.log?.warn({ plugin, error: String(error) }, '插件服务停止失败'))));
  }
}

interface RecordState {
  spec: PluginServiceSpec;
  status: PluginServiceStatus;
  child?: ChildProcess;
  restarts: number;
  lastExitCode?: number | null;
  lastError?: string;
  autoRestartCount?: number;
  autoRestartTimer?: ReturnType<typeof setTimeout>;
}

const AUTO_RESTART_LIMIT = 3;
const AUTO_RESTART_BASE_DELAY_MS = 50;

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
    ...(record.child?.pid ? { pid: record.child.pid } : {}),
    restarts: record.restarts,
    ...(record.lastExitCode !== undefined ? { lastExitCode: record.lastExitCode } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {})
  };
}

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { child.kill(signal); }
}

async function waitForExit(child: ChildProcess, timeout: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, 'exit').then(() => undefined),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('PLUGIN_SERVICE_STOP_TIMEOUT')), timeout))
  ]);
}
