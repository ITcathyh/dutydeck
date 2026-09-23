import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** SQLite 驱动预检的结果；失败时带上足以定位问题的解释器信息。 */
export interface SqliteDriverCheck {
  ok: boolean;
  /** 被检查的解释器。 */
  execPath: string;
  /** 该解释器的 `process.version`；解释器根本跑不起来时缺省。 */
  nodeVersion?: string;
  /** 该解释器的 `process.versions.modules`，即原生模块 ABI（NODE_MODULE_VERSION）。 */
  modules?: string;
  /** 底层错误原文（已压成一行）。 */
  error?: string;
}

export interface SqliteDriverCheckOptions {
  /** 要检查的解释器；缺省时在当前进程内检查。 */
  execPath?: string;
  /** 从哪个文件出发解析 better-sqlite3，应传实际会运行的入口脚本；缺省为本模块自身。 */
  resolveFrom?: string;
}

const CHILD_TIMEOUT_MS = 15_000;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function errorText(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error));
}

/**
 * SQLite 驱动预检：用存储层同一个 better-sqlite3 打开 `:memory:` 再关闭。
 *
 * better-sqlite3 是原生模块，import 成功不代表能用：`.node` 要到第一次 `new Database()`
 * 才加载，ABI（NODE_MODULE_VERSION）不匹配就在那时抛错。实测用 node v26 执行 restart：
 * 旧 daemon 先被停掉，新 daemon 打开数据库时才崩溃。所以必须在停旧进程之前，用「实际会
 * 运行新 daemon 的那个解释器」真的打开一次。
 *
 * 不传 `execPath` 时在当前进程内检查（新 daemon 由当前解释器派生时用）；传了就起子进程，
 * 让目标解释器自己加载一次，只有它自己加载才能证明 ABI 匹配。
 */
export function checkSqliteDriver(options: SqliteDriverCheckOptions = {}): SqliteDriverCheck {
  if (options.execPath === undefined) {
    const self = { execPath: process.execPath, nodeVersion: process.version, modules: process.versions.modules };
    try {
      new Database(':memory:').close();
      return { ok: true, ...self };
    } catch (error) {
      return { ok: false, ...self, error: errorText(error) };
    }
  }

  const execPath = options.execPath;
  const resolveFrom = options.resolveFrom ?? fileURLToPath(import.meta.url);
  // 子进程只输出一行 JSON；版本信息在加载驱动之前取，驱动失败也能如实报告 ABI。
  const script = [
    'const out = { nodeVersion: process.version, modules: process.versions.modules };',
    'try {',
    `  const Database = require('node:module').createRequire(${JSON.stringify(resolveFrom)})('better-sqlite3');`,
    "  new Database(':memory:').close();",
    '  out.ok = true;',
    '} catch (error) {',
    '  out.ok = false;',
    '  out.error = String(error && error.message || error);',
    '}',
    'process.stdout.write(JSON.stringify(out));'
  ].join('\n');
  // daemon 用 ESM import 加载驱动，ESM 不认 NODE_PATH；子进程的 createRequire 却认。去掉它，
  // 免得靠 NODE_PATH（比如 pnpm 的 .bin 脚本注入的）找到 daemon 实际加载不到的那份驱动。
  const env = { ...process.env };
  delete env.NODE_PATH;
  const probe = spawnSync(execPath, ['-e', script], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, env });
  if (probe.error) return { ok: false, execPath, error: errorText(probe.error) };
  try {
    const parsed = JSON.parse(probe.stdout.trim()) as { ok?: unknown; nodeVersion?: unknown; modules?: unknown; error?: unknown };
    return {
      ok: parsed.ok === true,
      execPath,
      ...(typeof parsed.nodeVersion === 'string' ? { nodeVersion: parsed.nodeVersion } : {}),
      ...(typeof parsed.modules === 'string' ? { modules: parsed.modules } : {}),
      ...(parsed.ok === true ? {} : { error: oneLine(String(parsed.error ?? '未知错误')) })
    };
  } catch {
    const detail = oneLine(probe.stderr ?? '') || `退出码 ${probe.status ?? '未知'}${probe.signal ? `，信号 ${probe.signal}` : ''}`;
    return { ok: false, execPath, error: `预检子进程没有返回结果：${detail}` };
  }
}

/** 预检失败的统一描述：解释器路径、node 版本、ABI 与底层错误一个不少。 */
export function describeSqliteDriverFailure(check: SqliteDriverCheck): string {
  return `解释器 ${check.execPath}（node ${check.nodeVersion ?? '未知'}，process.versions.modules=${check.modules ?? '未知'}）无法加载 SQLite 驱动 better-sqlite3：${check.error ?? '未知错误'}`;
}
