/**
 * doctor 的默认外部探针。
 *
 * 这里是整个体检模块唯一碰真实系统的地方，全部经 DoctorDependencies 注入，
 * 测试不会走到本文件。每个探针的副作用（有则必须写明）都记在各自注释里。
 */
import Database from 'better-sqlite3';
import { createServer } from 'node:net';
import type { DatabaseProbe, DatabaseProbeResult, PortProbe, PortProbeOutcome } from './types.js';
import { existsSync } from 'node:fs';

/** configs 表的形状：{ key TEXT PRIMARY KEY, value TEXT NOT NULL }。 */
interface ConfigRow { value: string }
interface KeyedConfigRow { key: string; value: string }
interface VersionRow { version: number | null }

/**
 * 只读打开数据库，一次读完需要的键后立刻关闭。
 *
 * 为什么不用 createRepositories：它会 mkdir、创建库文件、打开 WAL、可能
 * VACUUM INTO 出一份备份、并跑完所有 migration —— 体检做这些等于把「诊断」
 * 变成「改动」，一个只想看看哪里坏了的用户会被顺手改掉磁盘状态。
 *
 * ⚠️ 已知副作用（无法避免）：对 journal_mode=WAL 的库，即便 readonly 打开，
 * SQLite 也会创建 `-wal` / `-shm` 边车文件（实测确认）。这是 SQLite 自身行为，
 * `immutable=1` 虽能免除但会在正常库上直接 SQLITE_CANTOPEN，代价更大。
 * 这两个边车文件不改变库内数据，是本模块唯一容许的写入。
 */
export const defaultDatabaseProbe: DatabaseProbe = (path, keys, prefixes = []) => {
  // fileMustExist 之外再显式判存：体检绝不因为「检查了一下」而把库建出来。
  if (!existsSync(path)) return { exists: false };
  const result: DatabaseProbeResult = { exists: true };
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as VersionRow | undefined;
      if (row && row.version !== null) result.appliedVersion = row.version;
    } catch {
      // 表不存在（库尚未迁移过）不是错误，交由上层按 appliedVersion 缺失处理。
    }
    if (keys.length > 0 || prefixes.length > 0) {
      const values: Record<string, string | undefined> = {};
      // prepare 本身会在 configs 表不存在时抛错（半初始化的库就是这样）。
      // 那不代表整个库读不了，所以单独兜住：键值一律 undefined，库仍算可读。
      let statement: Database.Statement | undefined;
      try {
        statement = db.prepare('SELECT value FROM configs WHERE key = ?');
      } catch {
        statement = undefined;
      }
      for (const key of keys) {
        try {
          values[key] = statement ? (statement.get(key) as ConfigRow | undefined)?.value : undefined;
        } catch {
          values[key] = undefined;
        }
      }
      // 前缀查询同样单独兜住：configs 表缺失时这些键一律不出现，库仍算可读。
      let prefixed: Database.Statement | undefined;
      try {
        prefixed = prefixes.length > 0 ? db.prepare('SELECT key, value FROM configs WHERE substr(key, 1, length(?)) = ?') : undefined;
      } catch {
        prefixed = undefined;
      }
      for (const prefix of prefixes) {
        try {
          for (const row of (prefixed?.all(prefix, prefix) ?? []) as KeyedConfigRow[]) values[row.key] = row.value;
        } catch {
          // 读不出来就当没有这些键。
        }
      }
      result.values = values;
    }
    return result;
  } catch (error) {
    return { exists: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    // 无论成功失败都必须关掉：体检进程随后就退出，泄漏的句柄会让 WAL 边车滞留。
    try { db?.close(); } catch { /* 已经关了 */ }
  }
};

/**
 * 端口占用探测：尝试 bind，EADDRINUSE 即占用。
 *
 * 三条硬约束：
 *   1. 一定关掉 socket —— 探针自己把端口占住的话，紧随其后的 `dutydeck start` 会失败。
 *   2. 超时兜底，绝不挂住整个体检。
 *   3. 探不出来就返回 'unknown'，不冒充 'free'。低端口 EACCES 属于这一类：
 *      绑不上不代表没人在听。
 */
export const defaultPortProbe: PortProbe = (host, port, timeoutMs) => new Promise<PortProbeOutcome>(resolve => {
  const server = createServer();
  let settled = false;
  const finish = (outcome: PortProbeOutcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // close() 对未 listen 的 server 会回调 ERR_SERVER_NOT_RUNNING，忽略即可。
    try { server.close(() => resolve(outcome)); } catch { resolve(outcome); }
    // close 的回调在某些错误路径下不会触发，这里兜一层。
    setTimeout(() => resolve(outcome), 0);
  };
  const timer = setTimeout(() => finish('unknown'), timeoutMs);
  // 事件循环不该被这个探针拖住（体检可能在 CI 里跑）。
  timer.unref?.();
  server.once('error', (error: NodeJS.ErrnoException) => {
    finish(error.code === 'EADDRINUSE' ? 'occupied' : 'unknown');
  });
  server.once('listening', () => finish('free'));
  try {
    // 0.0.0.0 与 :: 语义上是「全部接口」，交给 node 自己选族，不要写死。
    server.listen(host === '0.0.0.0' || host === '::' ? { port } : { host, port });
  } catch {
    finish('unknown');
  }
});
