import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginLockEntry } from './store.js';
import Database from 'better-sqlite3';
import { observeProcess, type ProcessIdentity } from '@dutydeck/storage';
import { z } from 'zod';

const hostStateSchema = z.object({
  identity: z.object({ host: z.string(), boot: z.string(), namespace: z.string(), pid: z.number().int().positive(), start: z.string() }),
  database: z.string().optional(), stopped: z.boolean(),
  plugins: z.record(z.string(), z.string()),
  loaded: z.array(z.string()).optional(),
  diagnostics: z.array(z.object({ plugin: z.string(), message: z.string() })).optional()
});
export type PluginHostState = z.infer<typeof hostStateSchema>;
export interface PluginActivationBlocker { kind: 'host' | 'task' | 'action' | 'result' | 'unverified'; id: string; detail: string }

export async function pluginHostStates(pluginsDir: string): Promise<Array<PluginHostState & { observation: 'alive' | 'dead' | 'unknown' }>> {
  const directory = join(pluginsDir, '.hosts');
  if (!existsSync(directory)) return [];
  return Promise.all((await readdir(directory)).filter(file => file.endsWith('.json')).sort().map(async file => {
    const state = hostStateSchema.parse(JSON.parse(await readFile(join(directory, file), 'utf8')));
    return { ...state, observation: state.stopped ? 'dead' : observeProcess(state.identity) };
  }));
}

/** Read-only: no migration, runtime attachment, or guessing that a dead daemon ended its tmux tasks. */
export async function pluginActivationBlockers(pluginsDir: string, plugin: string, database?: string): Promise<PluginActivationBlocker[]> {
  const blockers: PluginActivationBlocker[] = [];
  let hosts: Awaited<ReturnType<typeof pluginHostStates>>;
  try { hosts = await pluginHostStates(pluginsDir); }
  catch { return [{ kind: 'unverified', id: 'host-state', detail: 'Host 租约无法验证；先修复 plugins/.hosts 中的记录。' }]; }
  for (const host of hosts) if (plugin in host.plugins && host.observation !== 'dead') {
    blockers.push({ kind: 'host', id: String(host.identity.pid), detail: `PID ${host.identity.pid} 的插件 Host ${host.observation === 'alive' ? '仍在运行' : '存活状态无法验证'}。` });
  }
  const databases = new Set([database, ...hosts.filter(host => plugin in host.plugins).map(host => host.database)].filter((value): value is string => Boolean(value) && value !== ':memory:').map(value => resolve(value)));
  for (const filename of databases) {
    if (!existsSync(filename)) continue;
    let db: Database.Database | undefined;
    try {
      db = new Database(filename, { readonly: true, fileMustExist: true });
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
      // Also catches runtimes started by the legacy build, before Host leases existed.
      if (tables.has('dutydeck_control') && tables.has('dutydeck_access')) {
        const row = db.prepare('SELECT a.identity FROM dutydeck_control c JOIN dutydeck_access a ON a.id=c.runtime WHERE c.id=1').get() as { identity: string } | undefined;
        if (row && observeProcess(JSON.parse(row.identity) as ProcessIdentity) !== 'dead') blockers.push({ kind: 'host', id: filename, detail: '此数据库仍有活动运行时；须停止共用插件目录的所有实例。' });
      }
      if (tables.has('tasks')) {
        for (const task of db.prepare("SELECT id,status FROM tasks WHERE status NOT IN ('completed','failed','interrupted','cancelled')").all() as Array<{ id: string; status: string }>) {
          blockers.push({ kind: 'task', id: task.id, detail: `${task.status} 任务未记录可验证的插件依赖；须先恢复并完成或取消，不能把存活 tmux 当作已排空。` });
        }
      }
      if (tables.has('configs')) {
        for (const row of db.prepare("SELECT key,value FROM configs WHERE key LIKE 'plugin.tools.action.%'").all() as Array<{ key: string; value: string }>) {
          const action = JSON.parse(row.value) as { plugin?: string; status?: string };
          if (!action || typeof action.plugin !== 'string' || typeof action.status !== 'string') throw new Error('Invalid action');
          if (action.plugin === plugin && !['succeeded', 'failed', 'suppressed'].includes(action.status)) blockers.push({ kind: 'action', id: row.key, detail: `${plugin} 有 ${action.status} 动作；须由当前兼容 handler 核对后再切换。` });
        }
      }
      if (tables.has('plugin_result_deliveries')) {
        for (const row of db.prepare("SELECT id,status FROM plugin_result_deliveries WHERE plugin=? AND status IN ('executing','execution_unknown','ready','sending','delivery_unknown')").all(plugin) as Array<{ id: string; status: string }>) {
          blockers.push({ kind: 'result', id: row.id, detail: `${plugin} 有 ${row.status} 文件结果；须先完成或核对交付。` });
        }
      }
    } catch { blockers.push({ kind: 'unverified', id: filename, detail: '数据库或动作记录无法只读验证；未切换插件。' }); }
    finally { db?.close(); }
  }
  return blockers;
}

// This worker uses the actual Host registries; the packaged entry is bundled with the CLI.
export function validateProviderRegistration(input: { root: string; dataDir: string; entry: PluginLockEntry; config: Record<string, string> }, timeout = 15_000): Promise<void> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const source = join(directory, 'activation-worker.ts');
  const args = existsSync(source)
    ? ['--conditions=development', '--import', createRequire(import.meta.url).resolve('tsx'), source]
    : [join(directory, 'assets/plugin-validation/cli.js')];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd: input.root, env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'ignore', 'ignore'], detached: process.platform !== 'win32' });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return; settled = true; clearTimeout(timer);
      // Registration may spawn children: clean up the validation process group even on success.
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
      ok ? resolvePromise() : reject(new Error('Provider 隔离加载/注册验证失败或超时；活动版本未改变。'));
    };
    const timer = setTimeout(() => finish(false), timeout);
    child.on('error', () => finish(false)); child.on('exit', code => finish(code === 0));
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
  });
}
